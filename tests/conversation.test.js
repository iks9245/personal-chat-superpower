'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { linearizeChatGPT, fromChatGPTSearch, toMarkdown, toJSON, toMilliseconds } = require('../src/shared/conversation.js');
function node(parent, role, parts, extra = {}) {
  return { parent, message: { author: { role }, content: { parts }, create_time: 1700000000, ...extra } };
}
test('linearizeChatGPT follows only the current branch from root to leaf', () => {
  const mapping = { root: { parent: null }, user: node('root', 'user', ['Question']), first: node('user', 'assistant', ['Discarded']),
    second: node('user', 'assistant', ['Selected']), follow: node('second', 'user', ['Follow-up']) };
  assert.deepEqual(linearizeChatGPT(mapping, 'follow'), [
    { role: 'user', text: 'Question', time: 1700000000000 },
    { role: 'assistant', text: 'Selected', time: 1700000000000 },
    { role: 'user', text: 'Follow-up', time: 1700000000000 }
  ]);
});
test('filters hidden, system, tool, missing and empty messages', () => {
  const mapping = { a: node(null, 'system', ['Secret']), b: node('a', 'tool', ['Tool']),
    c: node('b', 'assistant', ['Hidden'], { metadata: { is_visually_hidden_from_conversation: true } }),
    d: node('c', 'user', ['   ']), e: node('d', 'assistant', ['Visible'], { create_time: null }) };
  assert.deepEqual(linearizeChatGPT(mapping, 'e'), [{ role: 'assistant', text: 'Visible', time: null }]);
  assert.deepEqual(linearizeChatGPT({}, null), []);
  assert.deepEqual(linearizeChatGPT(null, 'missing'), []);
});
test('non-string parts use neutral attachment placeholders', () => {
  const mapping = { a: node(null, 'user', ['Look', { content_type: 'image_asset_pointer' }, null, 42]) };
  assert.equal(linearizeChatGPT(mapping, 'a')[0].text, 'Look\n[attachment]\n[attachment]\n[attachment]');
});
test('code messages use safe fenced blocks and ignore empty code', () => {
  const mapping = { a: node(null, 'assistant', [], { content: { content_type: 'code', text: 'const x = 1;', language: 'javascript' } }),
    b: node('a', 'assistant', [], { content: { content_type: 'code', text: '```\nnested\n```', language: 'md' } }),
    c: node('b', 'assistant', [], { content: { content_type: 'code', text: '  ' } }) };
  const result = linearizeChatGPT(mapping, 'c'); assert.equal(result.length, 2);
  assert.equal(result[0].text, '```javascript\nconst x = 1;\n```');
  assert.equal(result[1].text, '````md\n```\nnested\n```\n````');
});
test('malformed parent cycles terminate without duplicate messages', () => {
  const mapping = { a: node('b', 'user', ['A']), b: node('a', 'assistant', ['B']) };
  assert.equal(linearizeChatGPT(mapping, 'a').length, 2);
  assert.equal(linearizeChatGPT({ a: node('missing', 'user', ['A']) }, 'a').length, 1);
});
test('timestamps accept ISO strings, seconds, zero, and invalid values', () => {
  assert.equal(toMilliseconds('2024-01-01T00:00:00Z'), 1704067200000);
  assert.equal(toMilliseconds(1704067200.25), 1704067200250);
  assert.equal(toMilliseconds(0), 0);
  for (const value of [undefined, null, '', 'invalid', Infinity]) assert.equal(toMilliseconds(value), null);
});
test('Markdown preserves message formatting and includes title and role headings', () => {
  const conv = { title: '測試\n標題', messages: [{ role: 'user', text: 'Hello **world**' }, { role: 'assistant', text: '```js\n1 + 1\n```' }] };
  assert.equal(toMarkdown(conv), '# 測試 標題\n\n## user\n\nHello **world**\n\n---\n\n## assistant\n\n```js\n1 + 1\n```\n');
  assert.equal(toMarkdown({ id: 'id', messages: [] }), '# id\n\n\n');
});
test('JSON export round-trips the entire normalized conversation', () => {
  const conv = { key: 'chatgpt:1', platform: 'chatgpt', id: '1', title: '中文', createTime: 1, updateTime: 2,
    messages: [{ role: 'user', text: '<script>"\\\n', time: null }], fetchedAt: 3 };
  assert.deepEqual(JSON.parse(toJSON(conv)), conv);
});
test('search responses normalize seconds, archive status and plain markdown snippets', () => {
  assert.deepEqual(fromChatGPTSearch({ items: [{ conversation_id: 'id', title: '中文', update_time: 1791270670.649999,
    is_archived: true, payload: { kind: 'message', snippet: '**Hello** <script>' } }], cursor: '30' }), {
    items: [{ id: 'id', title: '中文', updateTime: 1791270670.649999 * 1000, snippet: '**Hello** <script>', archived: true }], cursor: '30'
  });
});
test('search responses allow missing snippets and skip items without string IDs', () => {
  assert.deepEqual(fromChatGPTSearch({ items: [null, {}, { conversation_id: 3 }, { conversation_id: 'a' },
    { conversation_id: 'b', payload: { kind: 'title' }, update_time: 0 }] }).items, [
    { id: 'a', title: '', updateTime: 0, snippet: '', archived: false },
    { id: 'b', title: '', updateTime: 0, snippet: '', archived: false }
  ]);
});
test('search responses normalize end cursors, including an empty page with a cursor', () => {
  for (const cursor of [undefined, null, '']) assert.equal(fromChatGPTSearch({ items: [{ conversation_id: 'a' }], cursor }).cursor, null);
  assert.equal(fromChatGPTSearch({ items: [], cursor: '30' }).cursor, null);
});
test('search responses reject malformed envelopes, cursors and typed fields', () => {
  for (const body of [undefined, null, [], {}, { items: {} }, { items: [], cursor: 30 }, { items: [], cursor: 'next' }]) {
    assert.throws(() => fromChatGPTSearch(body), { message: 'invalid' });
  }
  for (const fields of [{ title: {} }, { update_time: 'today' }, { update_time: Infinity }, { is_archived: 1 },
    { payload: [] }, { payload: { snippet: 42 } }]) {
    assert.throws(() => fromChatGPTSearch({ items: [{ conversation_id: 'a', ...fields }] }), { message: 'invalid' });
  }
});
const { linearizeClaude, fromClaudeSearch } = require('../src/shared/conversation.js');
const claudeMessage = (uuid, parent, sender, text, index, extra = {}) => ({ uuid, parent_message_uuid: parent, sender, text, index, created_at: '2026-10-06T00:00:00Z', ...extra });
test('Claude follows the selected leaf branch, excludes thinking/tools, and adds each attachment', () => {
  const messages = [claudeMessage('a', '00000000-0000-4000-8000-000000000000', 'human', 'Question', 0),
    claudeMessage('old', 'a', 'assistant', 'Discarded', 1),
    claudeMessage('new', 'a', 'assistant', 'legacy ignored', 2, { content: [{ type: 'thinking', text: 'secret' },
      { type: 'text', text: 'Selected' }, { type: 'tool_use', text: 'tool' }, { type: 'text', text: 'Answer' }, { type: 'tool_result', text: 'result' }], files: [{}], attachments: [{}, {}] })];
  assert.deepEqual(linearizeClaude(messages, 'new'), [
    { role: 'user', text: 'Question', time: Date.parse(messages[0].created_at) },
    { role: 'assistant', text: 'Selected\n\nAnswer\n[attachment]\n[attachment]\n[attachment]', time: Date.parse(messages[0].created_at) }
  ]);
});
test('Claude missing leaves fall back to index order without mutating the input; empty and other senders are skipped', () => {
  const messages = [claudeMessage('b', 'a', 'assistant', 'Legacy', 2, { content: [{ type: 'thinking', text: 'secret' }] }),
    claudeMessage('a', null, 'human', '', 1, { attachments: [{}], created_at: 'invalid' }),
    claudeMessage('c', 'b', 'assistant', ' ', 3), claudeMessage('tool', null, 'tool', 'Skip', 0),
    claudeMessage('empty', null, 'assistant', 'Do not fallback', 4, { content: [{ type: 'text', text: '' }] })];
  const result = linearizeClaude(messages, 'missing');
  assert.deepEqual(result.map(m => m.text), ['[attachment]', 'Legacy']); assert.equal(result[0].time, null);
  assert.equal(messages[0].uuid, 'b'); assert.deepEqual(linearizeClaude(null, null), []);
});
test('Claude cycles terminate without duplicate messages', () => {
  const messages = [claudeMessage('a', 'b', 'human', 'A', 0), claudeMessage('b', 'a', 'assistant', 'B', 1)];
  assert.deepEqual(linearizeClaude(messages, 'b').map(m => m.text), ['A', 'B']);
});
test('Claude search normalizes ISO dates and snippets, skips absent IDs, and never returns pagination', () => {
  assert.deepEqual(fromClaudeSearch({ data: [null, {}, { conversation: { uuid: 1 } },
    { conversation: { uuid: 'a', name: 'Title', updated_at: '2024-01-01T00:00:00Z', is_archived: true }, matched_snippet: { text: '**raw** <b>' } },
    { conversation: { uuid: 'b' }, matched_snippet: { text: 123 } }], next_page_token: 'unverified' }), {
    items: [{ id: 'a', title: 'Title', updateTime: 1704067200000, archived: true, snippet: '**raw** <b>' },
      { id: 'b', title: '', updateTime: 0, archived: false, snippet: '' }], cursor: null
  });
  for (const body of [null, {}, [], { data: {} }]) assert.throws(() => fromClaudeSearch(body), { message: 'invalid' });
});
test('Markdown adds the platform source after its title, with raw ID fallback', () => {
  require('../src/shared/platforms.js');
  assert.equal(toMarkdown({ title: 'Title', platform: 'claude' }), '# Title\n\n> Claude\n\n\n');
  assert.match(toMarkdown({ title: 'Title', platform: 'future' }), /> future/);
});
test('displayTitle selects local or site titles, collapses whitespace and leaves UI fallback to the caller', () => {
  const { displayTitle } = require('../src/shared/conversation.js');
  assert.equal(displayTitle({ title: ' Site\n  title ' }, { customTitle: ' Local\t\n title ' }), 'Local title');
  for (const customTitle of ['', null, undefined]) assert.equal(displayTitle({ title: ' Site\n title ' }, { customTitle }), 'Site title');
  assert.equal(displayTitle({}), ''); assert.equal(displayTitle({ title: '\n\t ' }), '');
  assert.equal(toMarkdown({ title: 'Site' }, { customTitle: ' Local\n title ' }), '# Local title\n\n\n');
});

test('cleanTitle drops markdown residue and trailing letters from an unrelated script only', () => {
  const { cleanTitle } = require('../src/shared/conversation.js');
  assert.equal(cleanTitle('整理旅行行程 പദ്ധ\n'), '整理旅行行程');
  assert.equal(cleanTitle('*React 元件設計筆記 '), 'React 元件設計筆記');
  assert.equal(cleanTitle('## Rust  學習'), 'Rust 學習');
  assert.equal(cleanTitle('മലയാളം തലക്കെട്ട്'), 'മലയാളം തലക്കെട്ട്');
  assert.equal(cleanTitle('Привет мир'), 'Привет мир');
  assert.equal(cleanTitle('日本語のタイトル'), '日本語のタイトル');
  assert.equal(cleanTitle('C++ 與 C#'), 'C++ 與 C#');
  assert.equal(cleanTitle(''), '');
});
