'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const rag = require('../src/shared/rag.js'), search = require('../src/shared/search.js');
const conv = extra => ({ key: 'chatgpt:a', title: 'Title', fetchedAt: 0, messages: [], ...extra });
test('chunks always contain title chunk, include summary/custom title and use stable keys', () => {
  assert.deepEqual(rag.chunkConversation(conv()), [{ key: 'chatgpt:a#0', convKey: 'chatgpt:a', n: 0, text: '標題：Title' }]);
  const value = conv({ summary: { text: 'Summary' }, messages: [{ role: 'user', text: 'not fetched' }] });
  assert.equal(rag.chunkConversation(value, { customTitle: 'Local' })[0].text, '標題：Local\nSummary');
  assert.deepEqual(rag.chunkConversation(value), rag.chunkConversation(value));
  assert.equal(rag.chunkConversation(conv({ title: '' })).length, 1);
});
test('long bodies hard split with exact 100-character overlap, prefer paragraphs and skip empty/other roles', () => {
  const value = conv({ fetchedAt: 1, messages: [{ role: 'user', text: 'a'.repeat(550) + '\n\n' + 'b'.repeat(2100) }, { role: 'assistant', text: 'Answer' }, { role: 'user', text: ' ' }, { role: 'system', text: 'secret' }] });
  const chunks = rag.chunkConversation(value).slice(1);
  assert.ok(chunks.length >= 4); assert.equal(chunks[0].text, 'user: ' + 'a'.repeat(550) + '\n\n');
  chunks.forEach((chunk, i) => { assert.ok(chunk.text.length <= 800); assert.equal(chunk.n, i + 1); assert.equal(chunk.key, `chatgpt:a#${i + 1}`); if (i) assert.equal(chunk.text.slice(0, 100), chunks[i - 1].text.slice(-100)); });
  const body = chunks[0].text + chunks.slice(1).map(chunk => chunk.text.slice(100)).join('');
  assert.equal(body, 'user: ' + 'a'.repeat(550) + '\n\n' + 'b'.repeat(2100) + '\n\nassistant: Answer');
});
test('retrieval applies scope/model, descending cosine, threshold, per-conversation and total caps', () => {
  const chunks = Array.from({ length: 5 }, (_, i) => ({ key: `a#${i}`, convKey: 'a', model: 'embed', vector: [1, i / 10] }));
  chunks.push({ key: 'b#0', convKey: 'b', model: 'embed', vector: [1, 1] }, { key: 'low', convKey: 'c', model: 'embed', vector: [0.1, 1] }, { key: 'old', convKey: 'd', model: 'old', vector: [1, 0] });
  const result = rag.retrieve([1, 0], chunks, { model: 'embed' });
  assert.deepEqual(result.map(row => row.key), ['a#0', 'a#1', 'a#2', 'b#0']);
  assert.ok(result.every((row, i) => !i || result[i - 1].score >= row.score));
  assert.deepEqual(rag.retrieve([1, 0], chunks, { model: 'embed', filter: key => key === 'b' }).map(row => row.key), ['b#0']);
  assert.equal(rag.retrieve([1, 0], chunks, { limit: 2, perConversation: 1 }).length, 2);
  // Absolute floor 0.3, and anything below 60% of the best score is dropped as unrelated.
  assert.equal(rag.retrieve([1, 0], [{ key: 'edge', convKey: 'e', vector: [0.2, Math.sqrt(0.96)] }]).length, 0);
  const relative = [{ key: 'best', convKey: 'x', vector: [0.9, Math.sqrt(0.19)] }, { key: 'weak', convKey: 'y', vector: [0.5, Math.sqrt(0.75)] }, { key: 'ok', convKey: 'z', vector: [0.6, 0.8] }];
  assert.deepEqual(rag.retrieve([1, 0], relative).map(row => row.key), ['best', 'ok']);
});
test('QA prompt numbers headers, prioritizes a 12000-character excerpt budget and places only last two pairs before question', () => {
  const excerpts = ['A', 'B', 'C'].map((title, i) => ({ title, platform: 'chatgpt', date: '2026-10-07', text: String(i).repeat(7000) }));
  const original = structuredClone(excerpts), kept = rag.prepareExcerpts(excerpts);
  assert.equal(kept.length, 2); assert.equal(kept[0].text.length, 7000); assert.ok(kept[1].text.length < 5000); assert.deepEqual(excerpts, original);
  const history = [1, 2, 3].map(n => ({ question: `Q${n}`, answer: `A${n}` }));
  const messages = rag.buildQAMessages({ question: 'New', excerpts, history });
  assert.equal(messages[0].content, rag.QA_SYSTEM_PROMPT);
  assert.deepEqual(messages.slice(1, -1), [{ role: 'user', content: 'Q2' }, { role: 'assistant', content: 'A2' }, { role: 'user', content: 'Q3' }, { role: 'assistant', content: 'A3' }]);
  const text = messages.at(-1).content, evidence = text.slice('編號摘錄：\n'.length, text.lastIndexOf('\n\n問題：'));
  assert.equal(evidence.length, 12000); assert.ok(evidence.startsWith('[1] A（ChatGPT，2026-10-07）\n')); assert.match(evidence, /\[2\] B（ChatGPT，2026-10-07）/); assert.ok(!evidence.includes('[3]'));
  assert.ok(text.endsWith('問題：New')); assert.deepEqual(rag.prepareExcerpts(kept), kept);
  assert.match(rag.buildQAMessages({ question: '?', excerpts: [] })[0].content, /摘錄不足以回答/);
});
test('chunk maintenance batches 32, skips unchanged, re-embeds changed hashes/model and removes stale chunks', async () => {
  const rows = new Map(), batches = [], config = { embeddingModel: 'm' }, controller = new AbortController();
  const db = { chunks: { getAll: async () => [...rows.values()], delete: async keys => keys.forEach(key => rows.delete(key)), putMany: async values => values.forEach(value => rows.set(value.key, value)) } };
  const llm = { embed: async (_, input) => { batches.push(input); return input.map(() => [3, 4]); } };
  const conversations = Array.from({ length: 34 }, (_, i) => conv({ key: `chatgpt:${i}` }));
  const run = extra => rag.maintainChunks({ conversations, config, db, llm, signal: controller.signal, ...extra });
  await run(); assert.deepEqual(batches.map(batch => batch.length), [32, 2]); assert.ok(rows.get('chatgpt:0#0').vector instanceof Float32Array);
  assert.ok(Math.abs(search.cosine(rows.get('chatgpt:0#0').vector, [3, 4]) - 1) < 1e-6);
  await run(); assert.equal(batches.length, 2);
  conversations[0].summary = { text: 'Changed' }; await run(); assert.equal(batches.at(-1).length, 1);
  conversations[0].fetchedAt = 1; conversations[0].messages = [{ role: 'assistant', text: 'long'.repeat(1000) }]; await run(); const before = rows.size;
  conversations[0].messages = [{ role: 'assistant', text: 'short' }]; await run({ conversations: [conversations[0]], partial: true });
  assert.ok(rows.size < before); assert.ok(rows.has('chatgpt:33#0')); assert.ok(!rows.has('chatgpt:0#2'));
  conversations.pop(); await run(); assert.ok(!rows.has('chatgpt:33#0'));
  const unchanged = batches.length; config.embeddingModel = 'next'; await run(); assert.ok(batches.length > unchanged); assert.ok([...rows.values()].every(row => row.model === 'next'));
  controller.abort(); await assert.rejects(run(), { name: 'AbortError' });
});
