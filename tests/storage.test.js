'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBackup, mergeBackups, cleanTags } = require('../src/shared/storage.js');
function backup() {
  return { settings: { lang: 'zh-TW', syncDelayMs: 600 },
    prompts: [{ id: 'p', title: 'Prompt', content: '{{subject}}', tags: ['work'], createdAt: 1, updatedAt: 2, useCount: 3 }],
    folders: [{ id: 'f', name: 'Work', color: '#abcdef', order: 0 }],
    convMeta: { 'chatgpt:c': { folderId: 'f', tags: [], pinned: true } } };
}
test('backup validation returns a detached, whitelisted data model', () => {
  const input = backup(); input.settings.extra = 'ignored'; input.prompts[0].extra = 'ignored'; input.extra = true;
  const value = validateBackup(input); assert.deepEqual(value, backup());
  value.prompts[0].tags.push('new'); assert.deepEqual(input.prompts[0].tags, ['work']);
});
test('rejects malformed backup types, duplicate IDs, dangling folders and dangerous keys', () => {
  const mutations = [
    data => { data.settings.lang = 'bad'; }, data => { data.settings.syncDelayMs = -1; },
    data => { data.prompts[0].useCount = '2'; }, data => { data.prompts.push(data.prompts[0]); },
    data => { data.folders[0].color = 'url(https://example.com)'; }, data => { data.convMeta['chatgpt:c'].folderId = 'missing'; },
    data => { data.convMeta = JSON.parse('{"__proto__":{"folderId":null,"tags":[],"pinned":false}}'); },
    data => { data.prompts[0].tags = [null]; }, data => { data.settings.lastSyncAt = NaN; }
  ];
  for (const mutate of mutations) { const data = backup(); mutate(data); assert.throws(() => validateBackup(data)); }
  for (const data of [null, [], {}, { settings: {} }]) assert.throws(() => validateBackup(data));
});
test('merge keeps existing data and imported IDs take precedence without mutation', () => {
  const old = backup(), incoming = backup(); incoming.prompts[0].title = 'Updated';
  incoming.prompts.push({ ...incoming.prompts[0], id: 'p2' }); incoming.folders = []; incoming.convMeta = {};
  const merged = mergeBackups(old, incoming);
  assert.equal(merged.prompts.length, 2); assert.equal(merged.prompts[0].title, 'Updated');
  assert.equal(merged.folders.length, 1); assert.ok(merged.convMeta['chatgpt:c']); assert.equal(old.prompts[0].title, 'Prompt');
});
test('tags are trimmed and deduplicated', () => { assert.deepEqual(cleanTags([' work ', '', 'work', '中文']), ['work', '中文']); });
test('settings migration isolates legacy ChatGPT sync and respects newer platform values', () => {
  const { normalizeSettings } = require('../src/shared/storage.js');
  const migrated = normalizeSettings({ lang: 'en', syncDelayMs: 1500, lastSyncAt: 123, titlesComplete: true });
  assert.deepEqual(migrated.sync, { chatgpt: { lastSyncAt: 123, titlesComplete: true }, claude: { lastSyncAt: 0, titlesComplete: false } });
  assert.equal(migrated.lastSyncAt, undefined); assert.equal(migrated.titlesComplete, undefined);
  assert.deepEqual(normalizeSettings({ lastSyncAt: 123, titlesComplete: true, sync: { chatgpt: { lastSyncAt: 456, titlesComplete: false } } }).sync.chatgpt,
    { lastSyncAt: 456, titlesComplete: false });
});
test('backup copies only valid known per-platform sync fields, detached from input', () => {
  const data = backup(); data.settings.sync = { claude: { lastSyncAt: 456, titlesComplete: true, extra: 'ignored' }, unknown: 'ignored' };
  const valid = validateBackup(data); assert.deepEqual(valid.settings.sync, { claude: { lastSyncAt: 456, titlesComplete: true } });
  valid.settings.sync.claude.lastSyncAt = 0; assert.equal(data.settings.sync.claude.lastSyncAt, 456);
  for (const sync of [null, [], { chatgpt: null }, { claude: { lastSyncAt: -1, titlesComplete: false } },
    { claude: { lastSyncAt: 0, titlesComplete: 1 } }, { claude: { lastSyncAt: 0 } }]) {
    const bad = backup(); bad.settings.sync = sync; assert.throws(() => validateBackup(bad));
  }
});
test('backup merging preserves the other platform sync and supports legacy incoming settings', () => {
  const old = backup(), incoming = backup();
  old.settings.sync = { chatgpt: { lastSyncAt: 100, titlesComplete: true }, claude: { lastSyncAt: 200, titlesComplete: true } };
  incoming.settings.sync = { claude: { lastSyncAt: 300, titlesComplete: false } };
  assert.deepEqual(mergeBackups(old, incoming).settings.sync, { chatgpt: old.settings.sync.chatgpt, claude: incoming.settings.sync.claude });
  delete incoming.settings.sync; incoming.settings.lastSyncAt = 400; incoming.settings.titlesComplete = true;
  assert.deepEqual(mergeBackups(old, incoming).settings.sync, { chatgpt: { lastSyncAt: 400, titlesComplete: true }, claude: old.settings.sync.claude });
});
test('settings reads and backup exports migrate legacy values without mutating stored data', async () => {
  const fs = require('node:fs'), vm = require('node:vm'), settings = { lang: 'en', syncDelayMs: 1500, lastSyncAt: 123, titlesComplete: true };
  const context = vm.createContext({ URL, chrome: { storage: { local: { get: async () => ({ settings }) } } } });
  vm.runInContext(fs.readFileSync(require.resolve('../src/shared/storage.js'), 'utf8'), context);
  const store = context.SPC.store, read = await store.get('settings', store.defaults), exported = await store.exportBackup();
  const safe = structuredClone(read); delete safe.llm.apiKey;
  assert.deepEqual(JSON.parse(JSON.stringify(safe)), JSON.parse(JSON.stringify(exported.settings)));
  assert.equal(read.sync.chatgpt.lastSyncAt, 123); assert.equal(read.sync.chatgpt.titlesComplete, true);
  assert.equal(read.sync.claude.titlesComplete, false); assert.equal(settings.sync, undefined);
});
test('LLM settings normalize strings, validate literal loopback URLs and preserve defaults', () => {
  const { normalizeSettings } = require('../src/shared/storage.js');
  const llm = normalizeSettings({ llm: { baseUrl: ' http://localhost:123/v1/// ', apiKey: ' secret ', chatModel: ' Qwen ', embeddingModel: ' embed ' } }).llm;
  assert.deepEqual(llm, { baseUrl: 'http://localhost:123/v1', apiKey: 'secret', chatModel: 'Qwen', embeddingModel: 'embed', disableThinking: true });
  for (const llm of [{ baseUrl: 'https://example.com' }, { chatModel: 42 }, { disableThinking: 'false' }, null]) assert.throws(() => normalizeSettings({ llm }));
});
test('backups omit API keys and both merge and overwrite keep the existing secret', async () => {
  const fs = require('node:fs'), vm = require('node:vm'); let data = { ...backup(), settings: { ...backup().settings, llm: { apiKey: 'local-secret', chatModel: 'old' } } };
  const context = vm.createContext({ URL, chrome: { storage: { local: { get: async () => structuredClone(data), set: async patch => { data = { ...data, ...structuredClone(patch) }; } } } } });
  vm.runInContext(fs.readFileSync(require.resolve('../src/shared/storage.js'), 'utf8'), context); const store = context.SPC.store;
  assert.equal((await store.exportBackup()).settings.llm.apiKey, undefined); assert.ok(!JSON.stringify(await store.exportBackup()).includes('local-secret'));
  for (const mode of ['merge', 'overwrite']) {
    const incoming = backup(); incoming.settings.llm = { baseUrl: 'http://localhost:999/v1', apiKey: 'injected', chatModel: ' new ' };
    assert.equal(store.validateBackup(incoming).settings.llm.apiKey, undefined);
    await store.importBackup(incoming, mode); assert.equal(data.settings.llm.apiKey, 'local-secret'); assert.equal(data.settings.llm.chatModel, 'new');
    await store.importBackup(backup(), mode); assert.equal(data.settings.llm.apiKey, 'local-secret');
  }
});
test('backup title metadata accepts bounded strings/null and merge preserves omitted optional fields', () => {
  const old = backup(); Object.assign(old.convMeta['chatgpt:c'], { customTitle: 'Local', originalTitle: 'Original' });
  assert.deepEqual(validateBackup(old), old);
  for (const field of ['customTitle', 'originalTitle']) {
    for (const value of [null, '', 'x'.repeat(200)]) { const data = backup(); data.convMeta['chatgpt:c'][field] = value; assert.equal(validateBackup(data).convMeta['chatgpt:c'][field], value); }
    for (const value of [1, {}, [], 'x'.repeat(201)]) { const data = backup(); data.convMeta['chatgpt:c'][field] = value; assert.throws(() => validateBackup(data)); }
  }
  const incoming = backup(); incoming.convMeta['chatgpt:c'].customTitle = null;
  const merged = mergeBackups(old, validateBackup(incoming)); assert.equal(merged.convMeta['chatgpt:c'].customTitle, null); assert.equal(merged.convMeta['chatgpt:c'].originalTitle, 'Original'); assert.equal(old.convMeta['chatgpt:c'].customTitle, 'Local');
});
test('updateConvMeta defaults title fields, preserves them through other changes and rejects invalid values', async () => {
  const fs = require('node:fs'), vm = require('node:vm'); let data = {};
  const context = vm.createContext({ URL, SPC: { i18n: { t: key => key } }, chrome: { storage: { local: {
    get: async () => structuredClone(data), set: async patch => { data = { ...data, ...structuredClone(patch) }; }
  } } } }); vm.runInContext(fs.readFileSync(require.resolve('../src/shared/storage.js'), 'utf8'), context);
  const api = context.SPC.store; await api.updateConvMeta('chatgpt:a', { pinned: true });
  assert.equal(data.convMeta['chatgpt:a'].customTitle, null); assert.equal(data.convMeta['chatgpt:a'].originalTitle, null);
  await api.updateConvMeta('chatgpt:a', { customTitle: 'Local', originalTitle: 'Original' }); await api.updateConvMeta('chatgpt:a', { tags: ['tag'] });
  assert.equal(data.convMeta['chatgpt:a'].customTitle, 'Local'); assert.equal(data.convMeta['chatgpt:a'].originalTitle, 'Original');
  for (const patch of [{ customTitle: 4 }, { originalTitle: 'x'.repeat(201) }]) await assert.rejects(api.updateConvMeta('chatgpt:a', patch));
  await api.updateConvMeta('chatgpt:a', { customTitle: null }); assert.equal(data.convMeta['chatgpt:a'].customTitle, null);
});

test('Q&A history persists last 20, replaces answers, excludes extras and never enters backups/imports', async () => {
  const fs = require('node:fs'), vm = require('node:vm'); let data = backup();
  const context = vm.createContext({ URL, Date, chrome: { storage: { local: { get: async () => structuredClone(data), set: async patch => { data = { ...data, ...structuredClone(patch) }; } } } } });
  vm.runInContext(fs.readFileSync(require.resolve('../src/shared/storage.js'), 'utf8'), context); const api = context.SPC.store;
  for (let i = 0; i < 25; i++) await api.saveQA({ question: 'Q' + i, answer: 'A' + i, sources: [{ key: 'claude:a', title: 'Title', platform: 'claude', text: 'excluded' }], model: 'local', extra: 'excluded' });
  assert.equal(data.qaHistory.length, 20); assert.equal(data.qaHistory[0].question, 'Q24'); assert.equal(data.qaHistory.at(-1).question, 'Q5');
  assert.deepEqual(Object.keys(data.qaHistory[0]).sort(), ['answer', 'createdAt', 'model', 'question', 'sources']);
  assert.deepEqual(data.qaHistory[0].sources, [{ key: 'claude:a', title: 'Title', platform: 'claude' }]);
  const createdAt = data.qaHistory[0].createdAt; await api.saveQA({ ...data.qaHistory[0], answer: 'Reanswered' }, createdAt);
  assert.equal(data.qaHistory.length, 20); assert.equal(data.qaHistory[0].answer, 'Reanswered'); assert.equal(data.qaHistory[0].createdAt, createdAt);
  assert.equal((await api.exportBackup()).qaHistory, undefined);
  const incoming = { ...backup(), qaHistory: [{ question: 'injected' }] }; assert.equal(api.validateBackup(incoming).qaHistory, undefined);
  for (const mode of ['merge', 'overwrite']) { await api.importBackup(incoming, mode); assert.equal(data.qaHistory[0].answer, 'Reanswered'); }
  await api.clearQA(); assert.equal(data.qaHistory.length, 0);
});

test('vault manifest and handle are excluded from backup export/import', async () => {
  const vm = require('node:vm'), fs = require('node:fs');
  const local = { ...backup(), vaultIndex: { 'chatgpt:c': { path: 'private/path', hash: 'abc' } }, vaultHandle: { name: 'private vault' } };
  const original = structuredClone(local);
  const context = vm.createContext({ URL, crypto: globalThis.crypto, chrome: { storage: { local: {
    get: async () => structuredClone(local), set: async patch => Object.assign(local, structuredClone(patch))
  } } } });
  vm.runInContext(fs.readFileSync(require.resolve('../src/shared/storage.js'), 'utf8'), context);
  const store = context.SPC.store, exported = await store.exportBackup();
  assert.equal(exported.vaultIndex, undefined); assert.equal(exported.vaultHandle, undefined); assert.doesNotMatch(JSON.stringify(exported), /private/);
  const incoming = { ...backup(), vaultIndex: { evil: true }, vaultHandle: { name: 'incoming' } };
  for (const mode of ['merge', 'overwrite']) {
    await store.importBackup(incoming, mode);
    assert.deepEqual(local.vaultIndex, original.vaultIndex); assert.deepEqual(local.vaultHandle, original.vaultHandle);
  }
});

test('weekly preference defaults true, validates both languages-independent booleans and excludes digest content/runtime from backups', () => {
  const store = require('../src/shared/storage.js');
  assert.equal(store.normalizeSettings().digest.autoWeekly, true);
  assert.equal(store.normalizeSettings({ digest: { autoWeekly: false } }).digest.autoWeekly, false);
  const value = backup(); value.settings.digest = { autoWeekly: false, text: 'private' };
  value.digests = [{ week: '2026-W41', text: 'private' }]; value.digestAttempts = { count: 3 };
  const checked = store.validateBackup(value);
  assert.deepEqual(checked.settings.digest, { autoWeekly: false }); assert.equal(checked.digests, undefined); assert.equal(checked.digestAttempts, undefined);
  value.settings.digest.autoWeekly = 'true'; assert.throws(() => store.validateBackup(value));
});
