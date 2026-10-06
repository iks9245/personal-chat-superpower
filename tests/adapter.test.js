'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const conversation = require('../src/shared/conversation.js');
function adapter(body) {
  const calls = [], context = vm.createContext({ URL, AbortSignal,
    SPC: { conversation, ...require('../src/shared/platforms.js'), composer: require('../src/content/composer.js'), i18n: { t: key => key } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => url.endsWith('/api/auth/session') ? { accessToken: 'test-token' } : body };
    }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../src/content/adapters/chatgpt.js'), 'utf8'), context);
  return { api: context.SPC.adapter, calls };
}
test('adapter search sends encoded queries, empty/next cursors and Bearer authentication', async () => {
  const { api, calls } = adapter({ items: [{ conversation_id: 'a', update_time: 123.5 }], cursor: '30' });
  const result = await api.searchConversations({ query: '中文 &?#' });
  assert.equal(result.items[0].updateTime, 123500); assert.equal(result.cursor, '30');
  assert.equal(calls[1].url, 'https://chatgpt.com/backend-api/conversations/search?query=' + encodeURIComponent('中文 &?#') + '&cursor=');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-token');
  assert.equal(calls[1].options.redirect, 'error');
  await api.searchConversations({ query: 'second', cursor: '30' });
  assert.equal(calls.length, 3); assert.ok(calls[2].url.endsWith('query=second&cursor=30'));
});
test('adapter rejects invalid search payloads before fetching', async () => {
  const { api, calls } = adapter({ items: [] });
  for (const payload of [undefined, {}, { query: 1 }, { query: '' }, { query: '  ' }, { query: ' trimmed ' }, { query: 'a'.repeat(201) },
    ...['', 'next', '-1', '1.2', 30, {}].map(cursor => ({ query: 'valid', cursor }))]) {
    await assert.rejects(api.searchConversations(payload), { message: 'invalidMessage' });
  }
  assert.equal(calls.length, 0);
  await api.searchConversations({ query: 'a'.repeat(200), cursor: null }); assert.equal(calls.length, 2);
});
test('adapter translates invalid search response errors', async () => {
  await assert.rejects(adapter({ items: 'invalid' }).api.searchConversations({ query: 'test' }), { message: 'invalidResponse' });
});
test('content script allows authenticated spc:search messages and returns items/cursor', async () => {
  let listener, payload;
  const context = vm.createContext({ document: { addEventListener() {} }, SPC: { i18n: { init: async () => {}, t: key => key }, palette: { init() {} },
    adapter: { searchConversations: async value => { payload = value; return { items: [{ id: 'a' }], cursor: '30' }; } } },
    chrome: { runtime: { id: 'extension', onMessage: { addListener: fn => { listener = fn; } } } }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../src/content/main.js'), 'utf8'), context);
  assert.equal(listener({ type: 'spc:search' }, { id: 'other' }, () => assert.fail('foreign message')), false);
  const result = await new Promise(resolve => assert.equal(listener({ type: 'spc:search', payload: { query: 'test', cursor: '30' } }, { id: 'extension' }, resolve), true));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, items: [{ id: 'a' }], cursor: '30' });
  assert.deepEqual(payload, { query: 'test', cursor: '30' });
});
test('content ping reports the adapter platform and current ID', async () => {
  for (const platform of ['chatgpt', 'claude']) {
    let listener;
    const context = vm.createContext({ document: { addEventListener() {} }, SPC: { i18n: { init: async () => {} }, palette: { init() {} },
      adapter: { platform, getCurrentConversationId: () => 'current' } },
      chrome: { runtime: { id: 'extension', onMessage: { addListener: fn => { listener = fn; } } } } });
    vm.runInContext(fs.readFileSync(require.resolve('../src/content/main.js'), 'utf8'), context);
    const result = await new Promise(resolve => listener({ type: 'spc:ping' }, { id: 'extension' }, resolve));
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, platform, currentId: 'current' });
  }
});
test('ChatGPT rename uses a hardened PATCH with exactly title and validates before fetching', async () => {
  const h = adapter({ success: true }); await h.api.renameConversation('a b', 'New title');
  const call = h.calls[1]; assert.equal(call.url, 'https://chatgpt.com/backend-api/conversation/a%20b');
  assert.equal(call.options.method, 'PATCH'); assert.deepEqual(JSON.parse(call.options.body), { title: 'New title' });
  assert.equal(call.options.headers.Authorization, 'Bearer test-token'); assert.equal(call.options.headers['Content-Type'], 'application/json');
  assert.equal(call.options.credentials, 'same-origin'); assert.equal(call.options.redirect, 'error'); assert.equal(call.options.cache, 'no-store'); assert.ok(call.options.signal);
  const invalid = adapter({ success: true });
  for (const title of [null, 3, '', ' ', ' padded ', 'a\nb', '\tTitle', 'a\u0000b', 'a\u007fb', 'a\u0085b', 'a\u2028b', 'x'.repeat(201)]) await assert.rejects(invalid.api.renameConversation('a', title), /invalidMessage/);
  for (const id of [null, '', 'a/b', 'a?b', 'a#b']) await assert.rejects(invalid.api.renameConversation(id, 'Title'), /invalidMessage/);
  assert.equal(invalid.calls.length, 0); await invalid.api.renameConversation('a', 'x'.repeat(200));
  for (const body of [{}, { success: false }, { success: 'true' }, null]) await assert.rejects(adapter(body).api.renameConversation('a', 'Title'), /invalidResponse/);
});
test('ChatGPT rename propagates 429 without adapter retries, including HTTP date Retry-After', async () => {
  for (const header of ['7', new Date(Date.now() + 10000).toUTCString()]) {
    let count = 0;
    // Replace the VM fetch through a dedicated context to retain the real transport code.
    const context = vm.createContext({ URL, AbortSignal, SPC: { conversation, ...require('../src/shared/platforms.js'), composer: { create: () => ({}) }, i18n: { t: key => key } },
      fetch: async url => url.endsWith('/session') ? { ok: true, json: async () => ({ accessToken: 'token' }) } : (count++, { ok: false, status: 429, headers: { get: () => header } }) });
    vm.runInContext(fs.readFileSync(require.resolve('../src/content/adapters/chatgpt.js'), 'utf8'), context);
    await assert.rejects(context.SPC.adapter.renameConversation('a', 'Title'), error => error.status === 429 && error.retryAfter > 0); assert.equal(count, 1);
  }
});
test('content rename validates sender, forwards id/title and preserves errors', async () => {
  let listener; const calls = [], context = vm.createContext({ document: { addEventListener() {} }, SPC: { i18n: { init: async () => {}, t: key => key }, palette: { init() {} },
    adapter: { renameConversation: async (...args) => { calls.push(args); if (args[0] === 'fail') throw Object.assign(new Error('slow'), { status: 429, retryAfter: 7 }); } } },
    chrome: { runtime: { id: 'ours', onMessage: { addListener: fn => { listener = fn; } } } } });
  vm.runInContext(fs.readFileSync(require.resolve('../src/content/main.js'), 'utf8'), context);
  assert.equal(listener({ type: 'spc:rename' }, { id: 'foreign' }, () => assert.fail()), false);
  const send = id => new Promise(resolve => assert.equal(listener({ type: 'spc:rename', payload: { id, title: 'Title' } }, { id: 'ours' }, resolve), true));
  assert.deepEqual(JSON.parse(JSON.stringify(await send('a'))), { ok: true }); assert.deepEqual(calls[0], ['a', 'Title']);
  assert.deepEqual(JSON.parse(JSON.stringify(await send('fail'))), { ok: false, error: 'slow', status: 429, retryAfter: 7 });
});
