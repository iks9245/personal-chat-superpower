'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { search, mergeResults, matchRanges, highlightNodes } = require('../src/shared/search.js');
const conversations = [
  { key: 'chatgpt:1', title: 'JavaScript Tips', messages: [{ text: 'A browser Extension for 中文搜尋。' }] },
  { key: 'chatgpt:2', title: '中文筆記', messages: [{ text: 'JavaScript is useful.' }, { text: 'Build an extension.' }] },
  { key: 'chatgpt:3', title: 'Cooking', messages: [{ text: 'Soup and bread' }] }
];
test('search is case insensitive and title matches score higher', () => {
  const result = search(conversations, 'JAVASCRIPT');
  assert.deepEqual(result.map(row => row.key), ['chatgpt:1', 'chatgpt:2']);
  assert.ok(result[0].score > result[1].score);
  assert.deepEqual(Object.keys(result[0]), ['key', 'title', 'score', 'snippet']);
});
test('Chinese search needs no word boundaries', () => {
  assert.deepEqual(search(conversations, '中文').map(row => row.key), ['chatgpt:2', 'chatgpt:1']);
  assert.equal(search(conversations, '文搜')[0].key, 'chatgpt:1');
});
test('multi-keyword AND spans titles and different messages', () => {
  assert.equal(search(conversations, 'javascript EXTENSION').length, 2);
  assert.equal(search(conversations, 'javascript soup').length, 0);
  assert.deepEqual(search(conversations, ' javascript   javascript '), search(conversations, 'javascript'));
});
test('empty query includes all cached conversations, including empty messages', () => {
  assert.equal(search(conversations, '   ').length, 3);
  assert.deepEqual(search([{ key: 'chatgpt:e', title: '', messages: [] }], ''), [{ key: 'chatgpt:e', title: '', score: 0, snippet: '' }]);
});
test('snippet is bounded and centered around an actual hit far into the body', () => {
  const result = search([{ key: 'chatgpt:long', title: 'Long', messages: [{ text: '前'.repeat(500) + 'TARGET' + '後'.repeat(500) }] }], 'target')[0];
  assert.ok(result.snippet.includes('TARGET'));
  assert.ok(result.snippet.startsWith('…') && result.snippet.endsWith('…'));
  assert.ok(result.snippet.length <= 182);
});
test('snippet does not add ellipses to a short complete body', () => {
  assert.equal(search(conversations, 'soup')[0].snippet, 'Soup and bread');
});
test('matchRanges finds literal, case-insensitive, merged ranges', () => {
  assert.deepEqual(matchRanges('JavaScript JAVASCRIPT', 'java javascript'), [[0, 10], [11, 21]]);
  assert.deepEqual(matchRanges('a+b [x]', 'a+b [x]'), [[0, 3], [4, 7]]);
  assert.deepEqual(matchRanges('anything', ''), []);
});
// Minimal DOM: enough for highlightNodes (childNodes, nodeType, insertBefore, removeChild, ownerDocument).
function fakeDocument() {
  const doc = {
    createTextNode: value => node(3, { nodeValue: value }),
    createElement: tag => node(1, { tagName: tag.toUpperCase() })
  };
  function node(nodeType, props) {
    const n = { nodeType, childNodes: [], ownerDocument: doc, ...props,
      appendChild(child) { n.childNodes.push(child); return child; },
      insertBefore(child, ref) { n.childNodes.splice(n.childNodes.indexOf(ref), 0, child); return child; },
      removeChild(child) { n.childNodes.splice(n.childNodes.indexOf(child), 1); return child; },
      get textContent() { return nodeType === 3 ? n.nodeValue : n.childNodes.map(c => c.textContent).join(''); },
      set textContent(value) { n.childNodes = [doc.createTextNode(String(value))]; } };
    return n;
  }
  return doc;
}
test('highlightNodes marks terms inside rendered nodes and keeps markup-looking text as text', () => {
  const doc = fakeDocument(), root = doc.createElement('div'), strong = doc.createElement('strong');
  root.appendChild(doc.createTextNode('<img src=x onerror=alert(1)> Agent '));
  strong.appendChild(doc.createTextNode('agent OS')); root.appendChild(strong);
  highlightNodes(root, 'agent');
  const marks = []; const walk = n => { if (n.tagName === 'MARK') marks.push(n.textContent); n.childNodes.forEach(walk); }; walk(root);
  assert.deepEqual(marks, ['Agent', 'agent']);
  assert.equal(root.textContent, '<img src=x onerror=alert(1)> Agent agent OS');
  const elements = []; const collect = n => { if (n.nodeType === 1) elements.push(n.tagName); n.childNodes.forEach(collect); }; collect(root);
  assert.deepEqual(elements, ['DIV', 'MARK', 'STRONG', 'MARK']);
});
test('merged results retain server order and remote snippets, then local score order', () => {
  const local = [{ key: 'chatgpt:a', title: 'A local', score: 10, snippet: 'local snippet' },
    { key: 'chatgpt:b', title: 'B', score: 2, snippet: 'B text' }, { key: 'chatgpt:c', title: 'C', score: 6, snippet: 'C text' }];
  const remote = [{ id: 'd', title: 'D', snippet: '**server**' }, { id: 'a', title: 'A remote', snippet: '' },
    { id: 'd', title: 'Duplicate', snippet: 'duplicate' }];
  assert.deepEqual(mergeResults(local, remote), [
    { key: 'chatgpt:d', title: 'D', snippet: '**server**', remote: true, score: 0 },
    { key: 'chatgpt:a', title: 'A remote', snippet: '', remote: true, score: 10 },
    { key: 'chatgpt:c', title: 'C', snippet: 'C text', remote: false, score: 6 },
    { key: 'chatgpt:b', title: 'B', snippet: 'B text', remote: false, score: 2 }
  ]);
  assert.equal(local[1].key, 'chatgpt:b'); assert.equal(remote.length, 3);
});
test('merging supports local-only, remote-only and empty results', () => {
  assert.deepEqual(mergeResults([], []), []);
  assert.equal(mergeResults(search(conversations, 'soup'), [])[0].remote, false);
  assert.equal(mergeResults([], [{ id: '1', title: 'Title', snippet: 'snippet' }])[0].remote, true);
});
test('remote platform keys deduplicate only that platform and retain other local platforms', () => {
  const local = [{ key: 'chatgpt:a', title: 'GPT', snippet: 'local', score: 5 }, { key: 'claude:a', title: 'Claude', snippet: 'cached', score: 2 }];
  const merged = mergeResults(local, [{ id: 'a', title: 'Remote', snippet: 'remote' }], 'claude');
  assert.deepEqual(merged.map(row => row.key), ['claude:a', 'chatgpt:a']); assert.equal(merged[0].snippet, 'remote'); assert.equal(merged[0].score, 2);
});
test('local search matches display, current site and first original titles; embedding uses display title', () => {
  const conv = { key: 'chatgpt:a', title: 'Current site', summary: { text: 'Summary' }, messages: [] }, meta = { 'chatgpt:a': { customTitle: ' Local\n title ', originalTitle: 'First original' } };
  for (const query of ['local', 'site', 'original', 'local original']) assert.equal(search([conv], query, meta)[0].title, 'Local title');
  assert.equal(require('../src/shared/search.js').documentText(conv, meta[conv.key]), 'Local title\nSummary\n');
});
