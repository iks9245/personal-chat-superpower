'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const id = '22222222-2222-4222-8222-222222222222', org = '11111111-1111-4111-8111-111111111111';
function harness(platform, cookie = '') {
  let listener, now = 1000000, status = 200;
  const requests = [], interactions = {};
  const context = vm.createContext({ URL, AbortSignal, AbortController, Date: class extends Date { static now() { return now; } },
    document: { cookie, addEventListener: (type, fn, options) => { assert.equal(options.passive, true); interactions[type] = fn; } },
    SPC: { ...require('../src/shared/platforms.js'), conversation: require('../src/shared/conversation.js'), composer: { create: () => ({}) },
      i18n: { init: async () => {}, t: key => key }, palette: { init() {} } },
    chrome: { runtime: { id: 'ours', onMessage: { addListener: fn => { listener = fn; } } } },
    fetch: async url => {
      requests.push(url);
      const body = url.endsWith('/session') ? { accessToken: 'token' } : url.endsWith('/organizations') ? [{ uuid: org, capabilities: ['chat'] }] :
        url.includes('limit=') ? (platform === 'chatgpt' ? { items: [], total: 0 } : []) :
        platform === 'chatgpt' ? { mapping: {}, current_node: 'root' } : { chat_messages: [] };
      return { ok: status === 200, status, json: async () => body, headers: { get: () => null } };
    } });
  for (const file of ['adapters/' + platform, 'main']) vm.runInContext(fs.readFileSync(require.resolve('../src/content/' + file + '.js'), 'utf8'), context);
  const send = (type, payload) => new Promise(resolve => listener({ type, payload }, { id: 'ours' }, resolve));
  return { api: context.SPC.adapter, context, requests, interactions, send, listener: () => listener, time: value => { now = value; }, status: value => { status = value; } };
}
for (const platform of ['chatgpt', 'claude']) {
  test(`${platform} backfill reads credentials once outside the budget, then one conversation request; activity is network-free`, async () => {
    const h = harness(platform);
    assert.equal((await h.send('spc:activity')).ok, true); assert.equal(h.requests.length, 0);
    const credentials = platform === 'chatgpt' ? '/api/auth/session' : '/api/organizations';
    const first = await h.send('spc:get', { id, platform, backfill: true }); assert.equal(first.ok, true);
    assert.equal(h.requests.length, 2); assert.ok(h.requests[0].endsWith(credentials)); assert.ok(h.requests[1].includes(id));
    const second = await h.send('spc:get', { id, platform, backfill: true }); assert.equal(second.ok, true);
    assert.equal(h.requests.length, 3, 'credentials are cached: the second run makes only the conversation request'); assert.ok(h.requests[2].includes(id));
    h.requests.length = 0;
    assert.deepEqual(Object.keys(h.interactions).sort(), ['input', 'keydown', 'pointerdown']);
    for (const [index, type] of ['input', 'keydown', 'pointerdown'].entries()) {
      h.time(1000000 + index); h.interactions[type](); assert.equal((await h.send('spc:activity')).lastInteractionAt, 1000000 + index);
    }
    assert.equal(h.requests.length, 0);
    assert.equal(h.listener()({ type: 'spc:activity' }, { id: 'foreign' }, () => assert.fail()), false);
  });
  for (const status of [200, 401, 403, 429]) test(`${platform} strict spc:get makes exactly one fetch with prepared auth and preserves ${status} without retries`, async () => {
    const h = harness(platform, platform === 'claude' ? 'lastActiveOrg=' + org : '');
    if (platform === 'chatgpt') await h.api.getAccessToken();
    const before = h.requests.length; assert.equal((await h.send('spc:activity')).ok, true); h.status(status);
    const result = await h.send('spc:get', { id, platform, backfill: true }); assert.equal(h.requests.length, before + 1);
    if (status === 200) { assert.equal(result.ok, true); assert.equal(result.conversation.key, platform + ':' + id); }
    else { assert.equal(result.ok, false); assert.equal(result.status, status); }
    const wrong = await h.send('spc:get', { id, platform: 'other', backfill: true }); assert.equal(wrong.ok, false); assert.equal(h.requests.length, before + 1);
  });
}

for (const platform of ['chatgpt', 'claude']) {
  for (const status of [200, 401, 403, 429]) test(`${platform} daily list enforces one actual fetch, platform validation and HTTP ${status} propagation`, async () => {
    const h = harness(platform, platform === 'claude' ? 'lastActiveOrg=' + org : '');
    if (platform === 'chatgpt') await h.api.getAccessToken();
    const before = h.requests.length; h.status(status);
    const result = await h.send('spc:list', { offset: 0, limit: 100, platform, backfill: true });
    assert.equal(h.requests.length, before + 1);
    if (status === 200) { assert.equal(result.ok, true); assert.equal(result.items.length, 0); }
    else { assert.equal(result.ok, false); assert.equal(result.status, status); }
    assert.equal((await h.send('spc:list', { offset: 0, limit: 100, platform: 'other', backfill: true })).ok, false);
    assert.equal(h.requests.length, before + 1);
  });
}

// Regression: a credential read right after a page reload must not use up the daily title-list refresh.
for (const platform of ['chatgpt', 'claude']) test(`${platform} daily list right after a page reload still succeeds with one list request`, async () => {
  const h = harness(platform);
  const result = await h.send('spc:list', { offset: 0, limit: 100, platform, backfill: true }); assert.equal(result.ok, true);
  assert.equal(h.requests.filter(url => url.includes('limit=')).length, 1, 'exactly one list request');
});
