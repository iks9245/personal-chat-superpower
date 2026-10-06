'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const v = require('../src/shared/vault.js');
const { writeVault } = require('../src/sidepanel/vault.js');
const tree = require('./helpers/vault-tree.js');
// Rendered strings captured from the pre-localization exporter, using only neutral fixtures.
const { input, expected } = require('./fixtures/vault-zh-TW.json');
const relative = entries => entries.map(entry => ({ ...entry, path: entry.path.slice(v.DEFAULT_ROOT.length + 1) }));
function files(options = {}) {
  const p = v.planExport({ ...input, ...options });
  return [...p.entries.map(({ path, content }) => ({ path, content })), {
    path: `${v.DEFAULT_ROOT}/${v.labels(options.lang).index}`, content: v.renderIndex(relative(p.entries), options)
  }];
}
async function exportTree(t, vaultIndex = {}, options = {}) {
  return writeVault({ directory: t.directory, rootFolder: v.DEFAULT_ROOT, vaultIndex,
    plan: v.planExport({ ...input, vaultIndex, ...options }), ...options });
}

test('default, explicit zh-TW and unknown languages match the original paths and UTF-8 snapshots', async () => {
  assert.equal(v.INDEX, '索引.md');
  for (const lang of [undefined, 'zh-TW', 'unknown', 'toString', null]) {
    const actual = files({ lang });
    assert.deepEqual(actual, expected);
    for (let i = 0; i < actual.length; i++) assert.deepEqual(Buffer.from(actual[i].content), Buffer.from(expected[i].content));
    const t = tree();
    let result = await exportTree(t, {}, { lang });
    assert.deepEqual([...t.files].map(([path]) => ({ path, content: t.text(path) })), expected);
    const writes = t.events.filter(([action]) => action === 'write').length;
    result = await exportTree(t, result.vaultIndex, { lang: 'zh-TW' });
    assert.equal(result.unchanged, input.conversations.length + input.digests.length);
    assert.equal(t.events.filter(([action]) => action === 'write').length, writes);
  }
});

test('English renders every fixed label and path while preserving supplied content and platform labels', () => {
  const entries = files({ lang: 'en' }), byPath = new Map(entries.map(e => [e.path, e.content]));
  const note = byPath.get('AI 對話/Work/Example note.md');
  for (const text of ['## Summary\n', '## Conversation\n', '### 🧑 You\n', '### 🤖 ChatGPT\n', '### Topic\n', '#### Question\n']) assert.ok(note.includes(text), text);
  assert.ok(v.renderNote(input.conversations[0], {}, { lang: 'en', platformLabel: 'Example platform' }).includes('### 🤖 Example platform'));
  assert.ok(byPath.get('AI 對話/Unfiled/Example.md').includes('(Body not downloaded yet. Export it from the extension or enable background summaries.)'));
  assert.ok(byPath.has('AI 對話/Unfiled/Example (chatgpt sample).md'));
  assert.ok(byPath.has('AI 對話/Unfiled/Untitled.md'));
  assert.equal(v.notePath(input.conversations[1], {}, [], undefined, undefined, { lang: 'en' }), 'AI 對話/Unfiled/Example.md');
  assert.equal(v.safeSegment('///', { lang: 'en' }), 'Untitled');
  assert.equal(v.collisionPath('Unfiled/Untitled.md', { platform: '///', id: '' }, 1, { lang: 'en' }), 'Unfiled/Untitled (Untitled Untitled).md');
  const review = byPath.get('AI 對話/Weekly/2026-W41.md');
  for (const text of ['title: "Weekly review 2026-W41"', '## Review', '## Conversations this week', '1. [[Unfiled/Example|Example]]', '2. Other example (Claude)']) assert.ok(review.includes(text), text);
  const index = byPath.get('AI 對話/Index.md');
  for (const text of ['## Work', '## Unfiled', '## Weekly reviews', '[[Unfiled/Example|Example]]', '[[Weekly/2026-W41|Weekly review 2026-W41]]']) assert.ok(index.includes(text), text);
  assert.ok(index.indexOf('## Work') < index.indexOf('## Unfiled'));
  assert.ok(v.renderIndex([{ path: 'Unfiled/Example.md', title: 'Example' }], { lang: 'en' }).includes('## Unfiled'));
  for (const { content } of entries) assert.doesNotMatch(content, /[\u3400-\u9fff]/u);
  const custom = v.planExport({ ...input, lang: 'en', folders: [{ id: 'work', name: '範例' }] });
  assert.equal(custom.entries[0].path, 'AI 對話/範例/Example note.md');
});

test('language switching moves unedited notes, digest and index, rewrites filed notes, and protects an edited note', async () => {
  const t = tree(), first = await exportTree(t), editedKey = 'chatgpt:sample3';
  const edited = first.vaultIndex[editedKey];
  t.put(edited.path, 'User edited example.');
  const result = await exportTree(t, first.vaultIndex, { lang: 'en' });
  assert.deepEqual(result.skippedPaths, [edited.path]);
  assert.equal(result.skipped, 1); assert.equal(result.moved, 3); assert.equal(result.updated, 1);
  assert.equal(t.text(edited.path), 'User edited example.');
  assert.deepEqual(result.vaultIndex[editedKey], edited);
  assert.equal(t.files.has('AI 對話/Unfiled/Example (chatgpt sample).md'), false);
  for (const [key, old] of Object.entries(first.vaultIndex)) {
    if (key === editedKey) continue;
    const current = result.vaultIndex[key];
    assert.equal(v.hashContent(t.text(current.path)), current.hash);
    if (old.path !== current.path) assert.equal(t.files.has(old.path), false, old.path);
  }
  assert.equal(result.vaultIndex['@index:AI 對話'].path, 'AI 對話/Index.md');
  assert.equal(t.files.has('AI 對話/索引.md'), false);
  assert.equal(t.files.size, expected.length);
  assert.ok(t.text('AI 對話/Index.md').includes(edited.path.slice(v.DEFAULT_ROOT.length + 1, -3)));
  assert.ok(t.text('AI 對話/Weekly/2026-W41.md').includes('[[Unfiled/Example|Example]]'));
  const again = await exportTree(t, result.vaultIndex, { lang: 'en' });
  assert.equal(again.created, 0); assert.equal(again.updated, 0); assert.equal(again.moved, 0);
  assert.deepEqual(again.vaultIndex, result.vaultIndex);
});

test('edited digest and edited index are skipped on a language switch without duplicate files', async () => {
  const t = tree(), first = await exportTree(t);
  const keys = ['digest:2026-W41', '@index:AI 對話'];
  for (const key of keys) t.put(first.vaultIndex[key].path, 'User edited example.');
  const result = await exportTree(t, first.vaultIndex, { lang: 'en' });
  assert.equal(result.skipped, 2);
  for (const key of keys) {
    const old = first.vaultIndex[key];
    assert.deepEqual(result.vaultIndex[key], old);
    assert.ok(result.skippedPaths.includes(old.path));
    assert.equal(t.text(old.path), 'User edited example.');
  }
  assert.equal(t.files.has('AI 對話/Weekly/2026-W41.md'), false);
  assert.equal(t.files.has('AI 對話/Index.md'), false);
});

test('index language moves preserve foreign files and stable collision suffixes in either direction', async () => {
  const t = tree();
  t.put('AI 對話/索引.md', 'Foreign Chinese index.');
  t.put('AI 對話/Index.md', 'Foreign English index.');
  let result = await exportTree(t);
  for (const lang of ['en', 'zh-TW']) {
    const old = result.vaultIndex['@index:AI 對話'].path;
    result = await exportTree(t, result.vaultIndex, { lang });
    const path = result.vaultIndex['@index:AI 對話'].path;
    assert.equal(path, `AI 對話/${lang === 'en' ? 'Index' : '索引'} (pcs index).md`);
    assert.equal(t.files.has(old), false);
    assert.equal(t.text('AI 對話/索引.md'), 'Foreign Chinese index.');
    assert.equal(t.text('AI 對話/Index.md'), 'Foreign English index.');
    const writes = t.events.filter(([action]) => action === 'write').length;
    result = await exportTree(t, result.vaultIndex, { lang });
    assert.equal(result.vaultIndex['@index:AI 對話'].path, path);
    assert.equal(t.events.filter(([action]) => action === 'write').length, writes);
  }
});

test('index moves recheck edits after writing and never delete before manifest persistence', async () => {
  for (const failure of ['edit', 'save']) {
    const t = tree(), first = await exportTree(t), old = first.vaultIndex['@index:AI 對話'].path;
    if (failure === 'edit') {
      t.afterWrite(path => { if (path === 'AI 對話/Index.md') t.put(old, 'Edited during move.'); });
      const result = await exportTree(t, first.vaultIndex, { lang: 'en' });
      assert.ok(result.skippedPaths.includes(old));
      assert.equal(t.text(old), 'Edited during move.');
    } else {
      await assert.rejects(exportTree(t, first.vaultIndex, { lang: 'en', saveIndex: async index => {
        if (index['@index:AI 對話'].path === 'AI 對話/Index.md') throw new Error('Example storage failure');
      } }), /Example storage failure/);
      assert.equal(t.text(old), expected.at(-1).content);
    }
    assert.equal(t.events.some(([action, path]) => action === 'delete' && path === old), false);
  }
});

function panelHarness(lang) {
  const t = tree(), nodes = new Map(), downloads = [];
  let saved = { handle: { ...t.directory, queryPermission: async () => 'granted' }, rootFolder: v.DEFAULT_ROOT, scope: 'all' };
  const panel = {
    state: { settings: { lang } },
    $: selector => {
      if (!nodes.has(selector)) nodes.set(selector, { value: '', addEventListener() {}, append() {}, replaceChildren() {} });
      return nodes.get(selector);
    },
    t: key => key, el: () => ({}), handle: fn => fn, renderSettingsStatus() {}, stopQASearch() {},
    setProgress() {}, checkCancelled() {}, status() {}, localOperation: fn => fn(new AbortController().signal),
    download: (bytes, name, type) => downloads.push({ bytes, name, type })
  };
  const context = vm.createContext({ TextEncoder, SPC: { panel, vault: v,
    db: { getAll: async () => input.conversations, digests: { getAll: async () => input.digests },
      keyval: { get: async () => saved, set: async (_key, value) => { saved = value; } } },
    store: { get: async key => ({ convMeta: input.meta, folders: input.folders })[key], set: async () => {} }
  } });
  vm.runInContext(fs.readFileSync(require.resolve('../src/sidepanel/vault.js'), 'utf8'), context);
  return { panel, t, downloads };
}
function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), decoder = new TextDecoder(), entries = [];
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true);
    const start = offset + 30 + nameLength + view.getUint16(offset + 28, true);
    entries.push({ path: decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength)), content: decoder.decode(bytes.subarray(start, start + size)) });
    offset = start + size;
  }
  return entries;
}
test('sidepanel directory export and ZIP fallback use the current UI language', async () => {
  const { panel, t, downloads } = panelHarness('zh-TW');
  await panel.bindVault();
  for (const lang of ['zh-TW', 'en']) {
    panel.state.settings.lang = lang;
    await panel.exportVault(true);
    const download = downloads.at(-1);
    assert.equal(download.name, 'AI 對話'); assert.equal(download.type, 'zip');
    assert.deepEqual(unzip(download.bytes), files({ lang }));
    await panel.exportVault();
    assert.deepEqual([...t.files].map(([path]) => ({ path, content: t.text(path) })).sort((a, b) => a.path.localeCompare(b.path)), files({ lang }).sort((a, b) => a.path.localeCompare(b.path)));
  }
});
