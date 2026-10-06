'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const org = '11111111-1111-4111-8111-111111111111', id = '22222222-2222-4222-8222-222222222222', apiOrg = '33333333-3333-4333-8333-333333333333';
const plain = value => JSON.parse(JSON.stringify(value));
function adapter(cookie, respond) {
  const calls = [], context = vm.createContext({ URL, AbortSignal, document: { cookie }, location: { pathname: `/chat/${id}` },
    SPC: { conversation: require('../src/shared/conversation.js'), ...require('../src/shared/platforms.js'),
      composer: require('../src/content/composer.js'), i18n: { t: key => key } },
    fetch: async (url, options) => { calls.push({ url, options }); const result = await respond(url, options);
      return result?.status ? { ok: result.status >= 200 && result.status < 300, json: async () => result, headers: { get: () => result.retryAfter ?? null }, ...result } : { ok: true, json: async () => result }; }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../src/content/adapters/claude.js'), 'utf8'), context);
  return { api: context.SPC.adapter, context, calls };
}
test('Claude cookie organization skips discovery and lists title metadata with the total contract', async () => {
  const h = adapter(`other=value; lastActiveOrg=${org}`, () => [{ uuid: id, name: 'Title', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-02-01T00:00:00Z' }]);
  const result = await h.api.listConversations({ offset: 10, limit: 1 });
  assert.equal(h.calls.length, 1); assert.equal(result.total, 12);
  assert.equal(h.calls[0].url, `https://claude.ai/api/organizations/${org}/chat_conversations?limit=1&offset=10`);
  assert.deepEqual(plain(result.items[0]), { id, title: 'Title', createTime: 1704067200000, updateTime: Date.parse('2024-02-01T00:00:00Z') });
  assert.equal(h.calls[0].options.credentials, 'same-origin'); assert.equal(h.calls[0].options.redirect, 'error');
  assert.equal(h.calls[0].options.headers?.Authorization, undefined); assert.ok(h.calls[0].options.signal);
  assert.equal((await h.api.listConversations({ offset: 10, limit: 2 })).total, 11);
  const empty = adapter(`lastActiveOrg=${org}`, () => []); assert.equal((await empty.api.listConversations({ offset: 20 })).total, 20);
});
test('Claude organization fallback picks chat rather than API capabilities and caches in memory', async () => {
  const h = adapter('lastActiveOrg=invalid', url => url.endsWith('/api/organizations') ?
    [{ uuid: apiOrg, capabilities: ['api'] }, { uuid: org, capabilities: ['claude_pro', 'chat'] }] : []);
  await h.api.listConversations(); await h.api.listConversations();
  assert.equal(h.calls.length, 3); assert.ok(h.calls[1].url.includes(`/organizations/${org}/`));
  assert.equal(h.calls.filter(call => call.url.endsWith('/api/organizations')).length, 1);
});
test('Claude search sends exactly one POST with verified body and never paginates', async () => {
  const h = adapter(`lastActiveOrg=${org}`, () => ({ data: [{ conversation: { uuid: id, name: 'Found' }, matched_snippet: { text: 'snippet' } }], next_page_token: 'not-supported' }));
  const result = await h.api.searchConversations({ query: '中文 &?#', cursor: null });
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url, `https://claude.ai/api/organizations/${org}/conversation/search/v2`);
  assert.equal(h.calls[0].options.method, 'POST'); assert.equal(h.calls[0].options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(h.calls[0].options.body), { query: '中文 &?#', n: 50, target_snippet_size: 200 });
  assert.equal(result.cursor, null); assert.equal(result.items[0].snippet, 'snippet');
});
test('Claude validates UUIDs and list/search input before any fetch', async () => {
  const h = adapter('', () => assert.fail('No fetch for invalid input'));
  for (const value of [null, '', 'not-uuid', id + '/x', 'g'.repeat(36)]) await assert.rejects(h.api.getConversation(value), { message: 'invalidMessage' });
  for (const payload of [{ offset: -1 }, { limit: 101 }, { limit: 0 }, { offset: '0' }]) await assert.rejects(h.api.listConversations(payload), { message: 'invalidMessage' });
  for (const payload of [undefined, {}, { query: 1 }, { query: '' }, { query: ' trimmed ' }, { query: 'x'.repeat(201) }, { query: 'valid', cursor: 'token' }]) await assert.rejects(h.api.searchConversations(payload), { message: 'invalidMessage' });
  assert.equal(h.calls.length, 0);
});
test('Claude 429 and authentication errors retain status/retryAfter without retries', async () => {
  for (const status of [429, 401, 403]) {
    const h = adapter(`lastActiveOrg=${org}`, () => ({ status, retryAfter: '7' }));
    await assert.rejects(h.api.listConversations(), { message: status === 429 ? 'requestFailedClaude' : 'authRequiredClaude', status, retryAfter: 7 });
    assert.equal(h.calls.length, 1);
  }
});
test('Claude conversation requests all branches and normalizes only the selected branch', async () => {
  const h = adapter(`lastActiveOrg=${org}`, () => ({ uuid: id, name: 'Title', current_leaf_message_uuid: 'leaf', chat_messages: [
    { uuid: 'leaf', sender: 'human', text: 'Hello', created_at: '2024-01-01T00:00:00Z' }, { uuid: 'other', sender: 'assistant', text: 'No' }
  ] }));
  const conv = await h.api.getConversation(id);
  assert.ok(h.calls[0].url.endsWith(`${id}?tree=True&rendering_mode=messages&render_all_tools=true`));
  assert.equal(conv.key, `claude:${id}`); assert.equal(conv.platform, 'claude'); assert.ok(conv.fetchedAt > 0);
  assert.equal(conv.messages.length, 1); assert.equal(conv.messages[0].text, 'Hello');
  assert.equal(h.api.getCurrentConversationId(), id); h.context.location.pathname = '/chat/not-a-uuid'; assert.equal(h.api.getCurrentConversationId(), null);
});
test('Claude localizes malformed response and network failures', async () => {
  const h = adapter(`lastActiveOrg=${org}`, () => ({}));
  await assert.rejects(h.api.searchConversations({ query: 'valid' }), { message: 'invalidResponseClaude' });
  await assert.rejects(h.api.listConversations(), { message: 'invalidResponseClaude' });
  const network = adapter(`lastActiveOrg=${org}`, () => { throw new Error('network'); });
  await assert.rejects(network.api.getConversation(id), { message: 'networkErrorClaude' }); assert.equal(network.calls.length, 1);
});
test('Claude rename sends only name in a hardened PUT and validates IDs/titles before discovery', async () => {
  const h = adapter(`lastActiveOrg=${org}`, () => ({ status: 202, uuid: id, name: 'New title' })); await h.api.renameConversation(id, 'New title');
  const call = h.calls[0]; assert.equal(call.url, `https://claude.ai/api/organizations/${org}/chat_conversations/${id}`);
  assert.equal(call.options.method, 'PUT'); assert.deepEqual(JSON.parse(call.options.body), { name: 'New title' });
  assert.deepEqual(plain(call.options.headers), { 'content-type': 'application/json' }); assert.equal(call.options.credentials, 'same-origin');
  assert.equal(call.options.redirect, 'error'); assert.equal(call.options.cache, 'no-store'); assert.ok(call.options.signal);
  const invalid = adapter('', () => assert.fail('invalid input must not fetch'));
  for (const title of [null, 1, '', ' ', ' padded ', 'a\nb', 'a\tb', 'a\u0000b', 'a\u007fb', 'a\u0085b', 'a\u2029b', 'x'.repeat(201)]) await assert.rejects(invalid.api.renameConversation(id, title), /invalidMessage/);
  for (const value of [null, '', 'not-uuid', id + '/x']) await assert.rejects(invalid.api.renameConversation(value, 'Title'), /invalidMessage/);
  assert.equal(invalid.calls.length, 0);
  await assert.rejects(adapter(`lastActiveOrg=${org}`, () => ({})).api.renameConversation(id, 'Title'), /invalidResponseClaude/);
});
test('Claude rename preserves 429 status and retryAfter with no retry', async () => {
  const h = adapter(`lastActiveOrg=${org}`, () => ({ status: 429, retryAfter: '9' }));
  await assert.rejects(h.api.renameConversation(id, 'Title'), { status: 429, retryAfter: 9 }); assert.equal(h.calls.length, 1);
});
