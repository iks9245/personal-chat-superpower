'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const plain = value => JSON.parse(JSON.stringify(value));
const org = '11111111-1111-4111-8111-111111111111', id = '22222222-2222-4222-8222-222222222222';
function adapter(platform, { cookie = '', fail, empty = false, malformed = false } = {}) {
  let now = 0, renames = 0; const calls = [], events = [];
  const context = vm.createContext({ URL, AbortSignal, DOMException, Date: class extends Date { static now() { return now; } },
    document: { cookie }, setTimeout: callback => { now += 1000; queueMicrotask(callback); },
    SPC: { ...require('../src/shared/platforms.js'), conversation: require('../src/shared/conversation.js'), i18n: { t: key => key },
      composer: { create: () => ({ diagnoseComposer: () => ({ found: true, visible: true }) }) } },
    fetch: async (url, options) => {
      const name = url.endsWith('/session') ? 'session' : url.endsWith('/organizations') ? 'organization' :
        /search/.test(url) ? 'search' : /[?&]limit=1/.test(url) ? 'list' : 'conversation';
      calls.push({ name, url, options, at: now }); events.push(name); now += 17;
      assert.ok(!['PATCH', 'PUT', 'DELETE'].includes(options.method), 'diagnostics never write');
      if (fail?.name === name) {
        if (fail.status === 0) throw new Error('SECRET_FETCH_MESSAGE token=SECRET_TOKEN');
        return { ok: false, status: fail.status, headers: { get: () => '1' } };
      }
      const bodies = { session: { accessToken: 'SECRET_TOKEN' }, organization: [{ uuid: org, capabilities: ['chat'] }],
        list: platform === 'chatgpt' ? { items: empty ? [] : [{ id, title: 'SECRET_TITLE' }], total: 1 } : empty ? [] : [{ uuid: id, name: 'SECRET_TITLE' }],
        search: platform === 'chatgpt' ? { items: [{ conversation_id: id, snippet: 'SECRET_SNIPPET' }] } : { data: [{ conversation: { uuid: id }, matched_snippet: { text: 'SECRET_SNIPPET' } }] },
        conversation: platform === 'chatgpt' ? { title: 'SECRET_TITLE', current_node: 'node', mapping: { node: { message: { author: { role: 'user' }, content: { parts: ['SECRET_TEXT'] } } } } } : { name: 'SECRET_TITLE', chat_messages: [{ uuid: id, sender: 'human', text: 'SECRET_TEXT' }] } };
      return { ok: true, json: async () => malformed && name === 'list' ? {} : bodies[name] };
    }
  });
  vm.runInContext(fs.readFileSync(require.resolve(`../src/content/adapters/${platform}.js`), 'utf8'), context);
  context.SPC.adapter.renameConversation = () => { renames++; assert.fail('rename called'); };
  const wait = async ms => { events.push('wait'); assert.ok(ms >= 1000); now += ms; };
  return { api: context.SPC.adapter, calls, events, wait, renames: () => renames };
}
for (const platform of ['chatgpt', 'claude']) {
  test(`${platform} diagnose is ordered, paced, read-only, private and limited to four fetches`, async () => {
    const h = adapter(platform), checks = await h.api.diagnose({ wait: h.wait });
    assert.deepEqual(plain(checks.map(row => row.id)), [platform === 'chatgpt' ? 'session' : 'organization', 'list', 'search', 'conversation', 'composer']);
    assert.ok(checks.every(row => row.ok && row.ms >= 0)); assert.equal(h.calls.length, 4);
    assert.deepEqual(h.events, [h.calls[0].name, 'wait', 'list', 'wait', 'search', 'wait', 'conversation']);
    for (let n = 1; n < h.calls.length; n++) assert.ok(h.calls[n].at - h.calls[n - 1].at >= 1000);
    assert.equal(h.renames(), 0); assert.match(checks[4].fix, new RegExp(platform + '\\.js → composerSelectors'));
    for (const secret of ['SECRET_', id, org]) assert.ok(!JSON.stringify(checks).includes(secret));
  });
  test(`${platform} list failures retain HTTP status, skip conversation and never retry`, async () => {
    for (const status of [401, 403, 404, 429, 500, 0]) {
      const h = adapter(platform, { fail: { name: 'list', status } }), checks = await h.api.diagnose({ wait: h.wait });
      assert.equal(checks[1].ok, false); assert.equal(checks[1].status, status || undefined);
      assert.equal(checks[2].ok, true); assert.equal(checks[3].ok, null); assert.equal(checks[4].ok, true);
      assert.equal(h.calls.length, 3); assert.equal(h.calls.filter(call => call.name === 'list').length, 1);
      assert.equal(checks[1].category, status === 0 ? 'networkError' : [401, 403].includes(status) ? 'authRequired' : 'requestFailed');
    }
  });
  test(`${platform} failed discovery skips dependent checks; empty/malformed list skips conversation`, async () => {
    const h = adapter(platform, { fail: { name: platform === 'chatgpt' ? 'session' : 'organization', status: 401 } });
    const checks = await h.api.diagnose({ wait: h.wait });
    assert.equal(h.calls.length, 1); assert.equal(checks[0].status, 401); assert.deepEqual(plain(checks.map(row => row.ok)), [false, null, null, null, true]);
    for (const option of [{ empty: true }, { malformed: true }]) {
      const next = adapter(platform, option), rows = await next.api.diagnose({ wait: next.wait });
      assert.equal(rows[3].ok, null); assert.equal(next.calls.length, 3);
      if (option.malformed) assert.equal(rows[1].category, 'invalidResponse');
    }
  });
  test(`${platform} cancellation during wait prevents the next fetch`, async () => {
    const h = adapter(platform), controller = new AbortController();
    await assert.rejects(h.api.diagnose({ signal: controller.signal, wait: async () => { controller.abort(); } }), { name: 'AbortError' });
    assert.equal(h.calls.length, 1);
    const normal = adapter(platform); await normal.api.diagnose();
    assert.equal(normal.calls.length, 4); for (let n = 1; n < normal.calls.length; n++) assert.ok(normal.calls[n].at - normal.calls[n - 1].at >= 1000);
  });
}
test('Claude cookie-only organization uses no discovery request or leading wait', async () => {
  const h = adapter('claude', { cookie: `private=SECRET_COOKIE; lastActiveOrg=${org}` }), checks = await h.api.diagnose({ wait: h.wait });
  assert.equal(checks[0].ok, true); assert.equal(checks[0].ms, 0); assert.equal(h.calls.length, 3);
  assert.deepEqual(h.events, ['list', 'wait', 'search', 'wait', 'conversation']);
  assert.ok(!JSON.stringify(checks).includes(org));
});
test('content diagnose contract validates sender, exposes version, and supports cancellation without overlapping runs', async () => {
  let listener, signal, finish, calls = 0;
  const context = vm.createContext({ AbortController, document: { addEventListener() {} }, SPC: { i18n: { init: async () => {}, t: key => key }, palette: { init() {} },
    adapter: { platform: 'chatgpt', diagnose: async options => { calls++; signal = options.signal; return new Promise(resolve => { finish = resolve; }); } } },
    chrome: { runtime: { id: 'ours', getManifest: () => ({ version: '0.3.0' }), onMessage: { addListener: fn => { listener = fn; } } } } });
  vm.runInContext(fs.readFileSync(require.resolve('../src/content/main.js'), 'utf8'), context);
  const send = type => new Promise(resolve => assert.equal(listener({ type }, { id: 'ours' }, resolve), true));
  assert.equal(listener({ type: 'spc:diagnose' }, { id: 'foreign' }, () => assert.fail()), false);
  const run = send('spc:diagnose'); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await send('spc:diagnose')).ok, false); assert.equal(calls, 1);
  assert.equal(listener({ type: 'spc:cancelDiagnose' }, { id: 'foreign' }, () => assert.fail()), false); assert.equal(signal.aborted, false);
  await send('spc:cancelDiagnose'); assert.equal(signal.aborted, true);
  finish([{ id: 'session', ok: true, ms: 1, fix: 'src/content/adapters/chatgpt.js → getAccessToken' }]);
  assert.deepEqual(plain(await run), { ok: true, platform: 'chatgpt', version: '0.3.0', checks: [{ id: 'session', ok: true, ms: 1, fix: 'src/content/adapters/chatgpt.js → getAccessToken' }] });
});
