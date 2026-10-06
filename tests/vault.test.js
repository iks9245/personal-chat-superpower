'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const v = require('../src/shared/vault.js');
const { writeVault } = require('../src/sidepanel/vault.js');
const conv = (id = 'abcdef1', patch = {}) => ({ key: 'chatgpt:' + id, id, platform: 'chatgpt', title: 'Title', createTime: 1700000000000, updateTime: 1700000000000, messages: [], ...patch });
const folders = [{ id: 'f', name: 'Work' }];
const plan = (conversations, vaultIndex = {}, extra = {}) => v.planExport({ conversations, vaultIndex, scope: 'all', ...extra });
const tree = require('./helpers/vault-tree.js');

async function run(t, conversations, index = {}, extra = {}) {
  const p = plan(conversations, index, extra);
  return writeVault({ directory: t.directory, rootFolder: extra.rootFolder || v.DEFAULT_ROOT, plan: p, vaultIndex: index, ...extra });
}
test('safeSegment strips all forbidden characters, controls, dots, whitespace and caps length', () => {
  assert.equal(v.safeSegment('/\\:*?"<>|#^[]\x00\x1f\x7f\x9f'), '未命名');
  assert.equal(v.safeSegment('... a   b .  '), 'a b');
  assert.equal(v.safeSegment('...'), '未命名'); assert.equal(v.safeSegment(''), '未命名');
  assert.equal(v.safeSegment('x'.repeat(90)).length, 80); assert.equal(v.safeSegment('CON'), '_CON');
  for (const root of ['', '.', '..', '../escape', '/abs', 'a\\b', '.obsidian', 'a.', 'a ', 'x'.repeat(81)]) assert.throws(() => v.validateRoot(root));
});
test('Obsidian tags support Unicode/nesting and discard empty or numeric tags', () => {
  assert.equal(v.obsidianTag('##hello world: !?'), 'hello-world-');
  assert.equal(v.obsidianTag('中文/工作_1'), '中文/工作_1');
  for (const tag of ['#', '![]', '123', '１２３']) assert.equal(v.obsidianTag(tag), '');
});
test('note paths use displayTitle, folders/unfiled and deterministic collision suffixes', () => {
  const a = conv(), b = conv('abcdef2');
  assert.equal(v.notePath(a, {}, folders), 'AI 對話/未分類/Title.md');
  assert.equal(v.notePath(a, { folderId: 'f', customTitle: 'New: title' }, folders), 'AI 對話/Work/New title.md');
  const occupied = new Map([[v.pathKey(v.notePath(a)), a.key]]);
  assert.equal(v.notePath(b, {}, [], undefined, occupied), 'AI 對話/未分類/Title (chatgpt abcdef).md');
  assert.deepEqual(plan([a, b]).entries.map(e => e.path), plan([b, a]).entries.map(e => e.path));
  assert.equal(new Set(plan([a, b, conv('abcdef3')]).entries.map(e => e.path)).size, 3);
});
test('notes escape YAML, preserve Markdown and aliases, contain local dates, and are deterministic', () => {
  const c = conv('1', { title: 'Original "site":\nnext', summary: { text: '**Summary**', model: 'm"\n:' }, messages: [{ role: 'user', text: '# markdown' }, { role: 'assistant', text: 'Answer' }] });
  const m = { customTitle: 'Custom "title":\nnext', originalTitle: 'Original "site":\nnext', pinned: true, folderId: 'f', tags: ['#hi there', '123'] };
  const note = v.renderNote(c, m, { folders });
  assert.match(note, /title: "Custom \\"title\\": next"/); assert.ok(note.includes('aliases: [' + JSON.stringify(m.originalTitle) + ']'));
  assert.ok(note.includes('summary_model: "m\\"\\n:"')); assert.match(note, /tags: \["hi-there"\]/);
  assert.match(note, /source: "https:\/\/chatgpt.com\/c\/1"/); assert.match(note, /created: "\d{4}-\d\d-\d\d"/);
  assert.match(note, /## 摘要\n\n\*\*Summary\*\*/); assert.match(note, /### 🧑 你\n\n#### markdown/); // nested below the message heading assert.match(note, /### 🤖 ChatGPT/);
  assert.equal(note, v.renderNote(c, m, { folders })); assert.doesNotMatch(v.renderNote(c), /aliases:/);
  assert.match(v.renderNote(conv()), /（內文尚未下載。可在擴充功能中匯出或使用背景補摘要。）/);
  assert.equal(v.hashContent('中文'), v.hashBytes(new TextEncoder().encode('中文')));
});
test('index folders sort with unfiled last, notes by updated desc and links omit md', () => {
  const content = v.renderIndex([{ folder: '未分類', path: '未分類/Z.md', title: 'Z', updated: 9 }, { folder: 'B', path: 'B/B.md', title: 'B', updated: 1 }, { folder: 'A', path: 'A/old.md', title: 'old', updated: 1 }, { folder: 'A', path: 'A/new.md', title: 'new', updated: 2 }]);
  assert.ok(content.indexOf('## A') < content.indexOf('## B')); assert.ok(content.indexOf('## B') < content.indexOf('## 未分類'));
  assert.ok(content.indexOf('[[A/new|new]]') < content.indexOf('[[A/old|old]]')); assert.doesNotMatch(content, /\.md\|/);
});
test('planner scopes, hash unchanged and title/folder moves; exclusions never cause deletes', () => {
  const rows = [conv('a'), conv('b', { summary: { text: 'saved' } }), conv('c', { messages: [{ role: 'user', text: 'body' }] }), conv('d')];
  const meta = { [rows[0].key]: { pinned: true }, [rows[3].key]: { folderId: 'f' } };
  assert.equal(v.planExport({ conversations: rows, meta, folders }).entries.length, 2);
  assert.equal(plan(rows, {}, { scope: 'withContent' }).entries.length, 2);
  const initial = plan(rows), index = Object.fromEntries(initial.entries.map(e => [e.key, { path: e.path, hash: e.hash }]));
  assert.equal(plan(rows, index).unchanged, 4); assert.equal(plan(rows, index).writes.length, 0);
  const moved = plan(rows, index, { meta: { [rows[0].key]: { customTitle: 'Rename', folderId: 'f' } }, folders });
  assert.deepEqual(moved.moves[0], { key: rows[0].key, from: index[rows[0].key].path, to: 'AI 對話/Work/Rename.md' });
  assert.equal(plan([], index).moves.length, 0);
});
test('writer creates/updates/compares bytes, saves index, confines writes and counts notes', async () => {
  const t = tree(), rows = [conv('1'), conv('2')], saves = [];
  let r = await run(t, rows, {}, { saveIndex: async index => saves.push(index) });
  assert.equal(r.created, 2); assert.equal(saves.length, 3); assert.equal(t.files.size, 3);
  assert.ok(t.events.every(([, path]) => path === v.DEFAULT_ROOT || path.startsWith(v.DEFAULT_ROOT + '/')));
  const writes = t.events.filter(([action]) => action === 'write').length;
  r = await run(t, rows, r.vaultIndex); assert.equal(r.unchanged, 2); assert.equal(t.events.filter(([a]) => a === 'write').length, writes);
  rows[0].summary = { text: 'New' }; r = await run(t, rows, r.vaultIndex); assert.equal(r.updated, 1); assert.equal(r.unchanged, 1);
  assert.equal(r.vaultIndex[rows[0].key].hash, v.hashBytes(t.files.get(r.vaultIndex[rows[0].key].path)));
});
test('writer skips user-edited overwrite, unchanged, move, and index, retaining manifest hashes', async () => {
  const t = tree(), c = conv(); let r = await run(t, [c]); const initial = r.vaultIndex, path = initial[c.key].path, indexPath = initial['@index:AI 對話'].path;
  t.put(path, 'My edits'); t.put(indexPath, 'My index');
  r = await run(t, [c], initial); assert.equal(r.skipped, 2); assert.equal(r.unchanged, 0);
  c.summary = { text: 'New summary' }; r = await run(t, [c], initial); assert.equal(r.skipped, 2);
  r = await run(t, [c], initial, { meta: { [c.key]: { customTitle: 'Moved', folderId: 'f' } }, folders });
  assert.equal(r.skipped, 2); assert.equal(r.moved, 0); assert.equal(t.files.size, 2);
  assert.equal(t.text(path), 'My edits'); assert.equal(t.text(indexPath), 'My index'); assert.deepEqual(r.vaultIndex, initial);
  assert.equal(t.events.filter(([a]) => a === 'delete').length, 0);
});
test('foreign targets and index use suffixes; old files deleted only for matching moves', async () => {
  const t = tree(), c = conv(); t.put(v.notePath(c), 'foreign'); t.put('AI 對話/索引.md', 'foreign index');
  let r = await run(t, [c]); const firstPath = r.vaultIndex[c.key].path;
  assert.match(firstPath, /\(chatgpt abcdef\)\.md$/); assert.equal(t.text(v.notePath(c)), 'foreign'); assert.equal(t.text('AI 對話/索引.md'), 'foreign index');
  r = await run(t, [c], r.vaultIndex); assert.equal(r.unchanged, 1);
  r = await run(t, [c], r.vaultIndex, { meta: { [c.key]: { customTitle: 'Rename' } } });
  assert.equal(r.moved, 1); assert.equal(t.files.has(firstPath), false); assert.equal(t.text(v.notePath(c)), 'foreign');
  const lastPath = r.vaultIndex[c.key].path;
  await run(t, [], r.vaultIndex); assert.equal(t.files.has(lastPath), true);
});
test('rechecks old content immediately before deletion and preserves edits made during new write', async () => {
  const t = tree(), c = conv(); let r = await run(t, [c]); const old = r.vaultIndex[c.key].path;
  t.afterWrite(path => { if (path.includes('Rename')) t.put(old, 'changed during move'); });
  r = await run(t, [c], r.vaultIndex, { meta: { [c.key]: { customTitle: 'Rename' } } });
  assert.equal(r.skipped, 1); assert.equal(r.moved, 0); assert.equal(t.text(old), 'changed during move');
  assert.equal(t.events.filter(([a]) => a === 'delete').length, 0);
});
test('cancellation is between files, with completed manifest persisted and no partial index', async () => {
  const t = tree(), controller = new AbortController(), saves = [], progress = [];
  const r = await run(t, [conv('1'), conv('2')], {}, { signal: controller.signal, saveIndex: async i => saves.push(i), onProgress: p => { progress.push(p); if (p.done === 1) controller.abort(); } });
  assert.equal(r.cancelled, true); assert.equal(r.created, 1); assert.equal(t.files.size, 1); assert.equal(saves.length, 1); assert.equal(progress[0].total, 3);
});
test('root traversal is rejected before writes; changing root never reads/deletes the old root', async () => {
  const t = tree(), c = conv(); const r = await run(t, [c]); t.events.length = 0;
  await run(t, [c], r.vaultIndex, { rootFolder: 'Other' }); assert.ok(t.events.every(([, p]) => p === 'Other' || p.startsWith('Other/')));
  const p = plan([c]); p.entries[0].path = 'AI 對話/../outside.md'; const count = t.events.length;
  await assert.rejects(writeVault({ directory: t.directory, rootFolder: v.DEFAULT_ROOT, plan: p })); assert.equal(t.events.length, count);
});
test('ZIP STORE records, CRC32, counts, offsets, UTF-8 and tiny-reader round trip', () => {
  assert.equal(v.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const entries = [{ path: 'AI 對話/未分類/標題.md', content: '中文 🧑\n' }, { path: 'AI 對話/索引.md', content: 'Index' }];
  const zip = v.buildZip(entries), view = new DataView(zip.buffer), end = zip.length - 22, decoder = new TextDecoder();
  assert.equal(view.getUint32(end, true), 0x06054b50); assert.equal(view.getUint16(end + 10, true), entries.length);
  let at = view.getUint32(end + 16, true); const output = [];
  for (let i = 0; i < entries.length; i++) {
    assert.equal(view.getUint32(at, true), 0x02014b50); assert.equal(view.getUint16(at + 8, true), 0x800); assert.equal(view.getUint16(at + 10, true), 0);
    const size = view.getUint32(at + 24, true), len = view.getUint16(at + 28, true), local = view.getUint32(at + 42, true);
    assert.equal(view.getUint32(local, true), 0x04034b50); assert.equal(view.getUint16(local + 6, true), 0x800); assert.equal(view.getUint16(local + 8, true), 0);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + len)), dataStart = local + 30 + view.getUint16(local + 26, true), data = zip.subarray(dataStart, dataStart + size);
    assert.equal(view.getUint32(at + 16, true), v.crc32(data)); assert.equal(view.getUint32(local + 14, true), v.crc32(data));
    output.push({ path: name, content: decoder.decode(data) }); at += 46 + len;
  }
  assert.equal(at, end); assert.deepEqual(output, entries); assert.deepEqual(v.buildZip(entries), zip);
});

test('long collision paths remain stable and foreign collisions never stack platform suffixes', async () => {
  const t = tree(), a = conv('abcdef1', { title: 'x'.repeat(80) }), b = conv('abcdef2', { title: a.title });
  const p = plan([a, b]); t.put(p.entries[1].path, 'foreign');
  let r = await run(t, [a, b]); const second = r.vaultIndex[b.key].path;
  assert.equal(second.split('(chatgpt').length, 2); assert.match(second, /abcdef 2\)\.md$/);
  r = await run(t, [a, b], r.vaultIndex); assert.equal(r.unchanged, 2); assert.equal(r.vaultIndex[b.key].path, second);
});
test('folder changes move only hash-matching old files; missing owned files are recreated', async () => {
  const t = tree(), c = conv(); let r = await run(t, [c]); const old = r.vaultIndex[c.key].path;
  const extra = { meta: { [c.key]: { folderId: 'f' } }, folders };
  r = await run(t, [c], r.vaultIndex, extra); assert.equal(r.moved, 1); assert.equal(t.files.has(old), false);
  const path = r.vaultIndex[c.key].path; assert.match(path, /\/Work\//); t.files.delete(path);
  r = await run(t, [c], r.vaultIndex, extra); assert.equal(r.created, 1); assert.ok(t.files.has(path));
});
test('manifest persistence failure never deletes the old move source', async () => {
  const t = tree(), c = conv(), r = await run(t, [c]), old = r.vaultIndex[c.key].path;
  await assert.rejects(run(t, [c], r.vaultIndex, { meta: { [c.key]: { customTitle: 'Rename' } }, saveIndex: async () => { throw new Error('disk'); } }), /disk/);
  assert.ok(t.files.has(old)); assert.equal(t.events.filter(([a]) => a === 'delete').length, 0);
});
test('foreign directory at a note path gets a suffix; foreign file at folder path is not touched', async () => {
  const t = tree(), c = conv(); t.dirs.add(v.DEFAULT_ROOT); t.dirs.add(v.DEFAULT_ROOT + '/未分類'); t.dirs.add(v.notePath(c));
  const r = await run(t, [c]); assert.match(r.vaultIndex[c.key].path, /\(chatgpt abcdef\)/); assert.ok(t.dirs.has(v.notePath(c)));
  const blocked = tree(); blocked.put(v.DEFAULT_ROOT + '/未分類', 'foreign folder blocker');
  await assert.rejects(run(blocked, [c]), { name: 'TypeMismatchError' }); assert.equal(blocked.text(v.DEFAULT_ROOT + '/未分類'), 'foreign folder blocker');
});

test('embedded headings are nested below the note sections, code fences untouched', () => {
  const { nestHeadings } = require('../src/shared/vault.js');
  assert.equal(nestHeadings('## 重點\n- a\n### 細節', 3), '### 重點\n- a\n#### 細節');
  assert.equal(nestHeadings('# Top\n```python\n# comment\n## not a heading\n```\n## Sub', 4), '#### Top\n```python\n# comment\n## not a heading\n```\n##### Sub');
  assert.equal(nestHeadings('##### deep\n###### deeper', 4), '##### deep\n###### deeper');
  assert.equal(nestHeadings('## a\n#### b\n###### c', 4), '#### a\n###### b\n###### c');
  assert.equal(nestHeadings('no headings, #hashtag and C#', 3), 'no headings, #hashtag and C#');
});

const digest = (week = '2026-W41', sources = []) => ({ week, ...require('../src/shared/digest.js').weekRange(week), text: '# 本週主題\n\nReview [1]', model: 'local"model', sources, createdAt: 1, partial: false });
test('digest export has deterministic path/frontmatter, nested headings, numbered source links and newest-first index', () => {
  const c = conv(), review = digest('2026-W41', [{ key: c.key, title: 'Source title', platform: 'chatgpt' }, { key: 'claude:missing', title: 'Not exported', platform: 'claude' }]);
  const p = plan([c], {}, { digests: [review, digest('2026-W40'), { ...digest('2026-W42'), partial: true }] });
  const entry = p.entries.find(item => item.key === 'digest:2026-W41'); assert.equal(entry.path, 'AI 對話/週報/2026-W41.md');
  for (const expected of ['title: "週報 2026-W41"', 'type: weekly-review', 'week: "2026-W41"', 'start: "2026-10-05"', 'end: "2026-10-12"', 'model: "local\\"model"', 'exported_by: personal-chat-superpower', '## 本週主題', '## 本週對話', '1. [[未分類/Title|Source title]]', '2. Not exported（Claude）']) assert.ok(entry.content.includes(expected), expected);
  assert.equal(p.entries.length, 3); assert.equal(p.entries.some(item => item.key === 'digest:2026-W42'), false);
  const index = v.renderIndex(p.entries.map(item => ({ ...item, path: item.path.slice(v.DEFAULT_ROOT.length + 1) })));
  assert.match(index, /## 週報\n\n- \[\[週報\/2026-W41\|週報 2026-W41\]\]\n- \[\[週報\/2026-W40/);
  assert.equal(entry.content, plan([c], {}, { digests: [review] }).entries.at(-1).content);
});
test('digest writer protects user edits and resolves citations to actual exported paths including collisions and protected moves', async () => {
  const t = tree(), c = conv(), reviews = [digest('2026-W41', [{ key: c.key, title: c.title, platform: c.platform }])];
  t.put(v.notePath(c), 'foreign');
  let r = await run(t, [c], {}, { digests: reviews }), notePath = r.vaultIndex[c.key].path;
  const reviewPath = r.vaultIndex['digest:2026-W41'].path;
  assert.ok(t.text(reviewPath).includes(notePath.slice(v.DEFAULT_ROOT.length + 1, -3)));
  t.put(notePath, 'My note');
  r = await run(t, [c], r.vaultIndex, { digests: reviews, meta: { [c.key]: { customTitle: 'Renamed' } } });
  assert.ok(t.text(reviewPath).includes(notePath.slice(v.DEFAULT_ROOT.length + 1, -3))); assert.equal(t.text(notePath), 'My note');
  t.put(reviewPath, 'My review'); reviews[0].text = 'New review';
  const old = r.vaultIndex['digest:2026-W41']; r = await run(t, [c], r.vaultIndex, { digests: reviews });
  assert.equal(t.text(reviewPath), 'My review'); assert.deepEqual(r.vaultIndex['digest:2026-W41'], old); assert.ok(r.skippedPaths.includes(reviewPath));
  assert.match(t.text(r.vaultIndex['@index:AI 對話'].path), /## 週報/);
});
test('digest export outside note scope uses plain source labels and foreign digest files are preserved', async () => {
  const t = tree(), c = conv(), review = digest('2026-W41', [{ key: c.key, title: 'Unfiled', platform: 'chatgpt' }]);
  t.put('AI 對話/週報/2026-W41.md', 'foreign digest');
  const r = await run(t, [c], {}, { scope: 'pinnedOrFiled', digests: [review] });
  assert.equal(t.text('AI 對話/週報/2026-W41.md'), 'foreign digest');
  const path = r.vaultIndex['digest:2026-W41'].path; assert.notEqual(path, 'AI 對話/週報/2026-W41.md');
  assert.match(t.text(path), /1\. Unfiled（ChatGPT）/); assert.doesNotMatch(t.text(path), /\[\[/);
  assert.ok(t.text(r.vaultIndex['@index:AI 對話'].path).includes(path.slice(v.DEFAULT_ROOT.length + 1, -3)));
});
