'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const panelDirectory = path.dirname(require.resolve('../src/sidepanel/index.html'));
const panelScripts = [...fs.readFileSync(path.join(panelDirectory, 'index.html'), 'utf8').matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)]
  .map(match => path.resolve(panelDirectory, match[1])).filter(file => path.dirname(file) === panelDirectory);
const conversation = require('../src/shared/conversation.js');
const search = require('../src/shared/search.js');
const platforms = require('../src/shared/platforms.js');
const store = require('../src/shared/storage.js');
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function harness(initial = []) {
  const chunks = new Map(), savedQA = [], session = {}, sessionWrites = [];
  const vectors = new Map(), metaWrites = [], folderWrites = [], frames = new Map();
  const records = new Map(initial.map(conv => [conv.key, structuredClone(conv)])), calls = [], downloads = [], writes = [], progress = [], settingsWrites = [], timers = new Map(), nodes = new Map();
  let now = 1000000, timerId = 0, active = { id: 1, url: 'https://chatgpt.com/c/current' }, respond = () => { throw new Error('Unexpected request'); };
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { value: '', close() {}, querySelectorAll: () => [], classList: { toggle() {} } });
    return nodes.get(selector);
  };
  const context = vm.createContext({ URL, AbortController, DOMException, console, Intl,
    requestAnimationFrame: fn => { const id = ++timerId; frames.set(id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id),
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; }, clearTimeout: id => timers.delete(id),
    document: { querySelector: node },
    chrome: { storage: { session: { set: async patch => { sessionWrites.push({ at: now, patch: plain(patch) }); Object.assign(session, plain(patch)); }, remove: async key => { delete session[key]; } } }, tabs: { query: async () => [active], get: async () => active,
      sendMessage: async (tab, message) => { calls.push({ tab, ...plain(message), at: now }); return respond(message); } } },
    SPC: { summary: require('../src/shared/summary.js'), backfill: require('../src/shared/backfill.js'), conversation, search, rag: require('../src/shared/rag.js'), llm: { ...require('../src/shared/llm.js'), chat: async () => 'Summary' }, ...platforms, i18n: { getLang: () => 'en', t: (key, vars) => key + (vars ? JSON.stringify(vars) : '') },
      store: { saveQA: async (entry, replaceCreatedAt) => { const value = { ...entry, createdAt: replaceCreatedAt ?? now + savedQA.length }; const next = [value, ...savedQA.filter(item => item.createdAt !== value.createdAt)].slice(0, 20); savedQA.splice(0, savedQA.length, ...next); return next; }, cleanTags: store.cleanTags, get: async (key, fallback) => ({ folders: context.panel.state.folders, convMeta: context.panel.state.meta }[key] || fallback),
        saveFolder: async input => { const folder = { ...input, id: 'folder-' + folderWrites.length }; folderWrites.push(folder); context.panel.state.folders.push(folder); return folder; },
        updateConvMeta: async (key, patch) => { metaWrites.push({ key, patch }); context.panel.state.meta[key] = { ...context.panel.state.meta[key], ...patch }; },
        defaults: store.defaults, normalizeSettings: store.normalizeSettings, updateSettings: async patch => {
        settingsWrites.push(plain(patch)); const old = context.panel.state.settings;
        context.panel.state.settings = store.normalizeSettings({ ...old, ...patch, sync: { ...old.sync, ...patch.sync } });
      } },
      db: { chunks: { getAll: async () => [...chunks.values()], putMany: async rows => rows.forEach(row => chunks.set(row.key, row)), delete: async keys => keys.forEach(key => chunks.delete(key)), clear: async () => chunks.clear() }, vectors: { getAll: async () => [...vectors.values()], putMany: async rows => rows.forEach(row => vectors.set(row.key, row)), delete: async key => vectors.delete(key), clear: async () => vectors.clear() },
        get: async key => records.get(key), getAll: async () => [...records.values()], getMany: async keys => keys.map(key => records.get(key)), count: async () => records.size,
        put: async conv => { records.set(conv.key, structuredClone(conv)); writes.push([conv.key]); },
        putMany: async convs => { writes.push(convs.map(conv => conv.key)); convs.forEach(conv => records.set(conv.key, structuredClone(conv))); } } },
    capture: { downloads, progress, confirmation: null, editor: null }
  });
  // Exercise the actual orchestration with deterministic Chrome/DB/timers; rendering is covered by the pure search/highlight tests.
  // Load the real entrypoint too, but leave startup pending in this orchestration-only fixture.
  context.SPC.i18n.init = () => new Promise(() => {});
  for (const file of panelScripts) vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const panel = context.panel = context.SPC.panel, capture = context.capture;
  for (const name of ['renderQA', 'renderQAHistory', 'renderQAAnswer', 'renderStatus', 'renderAvailability',
    'renderVault', 'renderConversations', 'renderStats', 'renderSearchSource', 'renderPrompts']) panel[name] = () => {};
  panel.refreshLocal = async () => {};
  panel.download = (...args) => capture.downloads.push(args);
  panel.confirmAction = (key, vars, action) => { capture.confirmation = { key, vars, action }; };
  panel.openEditor = (title, fields, save) => { capture.editor = { title, fields, save }; };
  const originalProgress = panel.setProgress;
  panel.setProgress = (key, vars) => { capture.progress.push({ key, vars }); originalProgress(key, vars); };
  panel.showSuggestions = rows => { panel.state.suggestions = rows; };
  panel.state.tab = active; panel.state.platform = 'chatgpt';
  async function tick(ms) {
    const end = now + ms; await flush();
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
    }
    now = end; await flush();
  }
  async function settle(promise) {
    let done = false, error; promise.then(() => { done = true; }, e => { done = true; error = e; });
    for (let i = 0; !done && i < 200; i++) { await flush(); if (!done && timers.size) await tick(Math.max(0, Math.min(...[...timers.values()].map(timer => timer.at)) - now)); }
    assert.ok(done, 'operation settled'); if (error) throw error;
  }
  return { ...context.panel, context, session, sessionWrites, records, vectors, chunks, savedQA, metaWrites, folderWrites, calls, downloads, writes, progress, settingsWrites, node, tick, settle, frames,
    paint: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); },
    respond: fn => { respond = fn; },
    activate: tab => { active = tab; context.panel.state.tab = platforms.platformForUrl(tab.url) ? tab : null; context.panel.state.platform = platforms.platformForUrl(tab.url); },
    navigate: tab => { active = tab; }, offline: () => { active = { id: 2, url: 'https://example.com' }; context.panel.state.tab = null; context.panel.state.platform = null; } };
}
const item = id => ({ id: String(id), title: `Title ${id}`, createTime: 10, updateTime: 20 });
const record = (id, fetchedAt = 0) => ({ ...item(id), key: `chatgpt:${id}`, platform: 'chatgpt', messages: fetchedAt ? [{ role: 'user', text: 'cached body' }] : [], fetchedAt });
test('index loads core first, main last and every panel script exactly once', () => {
  assert.equal(path.basename(panelScripts[0]), 'core.js');
  assert.equal(path.basename(panelScripts.at(-1)), 'main.js');
  assert.deepEqual(panelScripts.map(file => path.basename(file)).sort(), fs.readdirSync(panelDirectory).filter(file => file.endsWith('.js')).sort());
  assert.equal(new Set(panelScripts).size, panelScripts.length);
});
test('sync follows page length instead of total, writes each page, never fetches bodies and preserves cached bodies', async () => {
  const old = { ...record('0', 123), title: 'Old', updateTime: 1 }, h = harness([old]);
  h.respond(({ type, payload }) => {
    assert.equal(type, 'spc:list'); assert.equal(payload.limit, 100);
    if (payload.offset === 100) { assert.equal(h.records.size, 100); assert.equal(h.state.conversations.length, 100); }
    return { ok: true, total: 101, items: payload.offset < 200 ? Array.from({ length: 100 }, (_, n) => item(payload.offset + n)) : [] };
  });
  await h.settle(h.synchronize());
  assert.deepEqual(h.calls.map(call => call.payload.offset), [0, 100, 200]);
  assert.equal(h.records.size, 200); assert.equal(h.records.get('chatgpt:0').title, 'Title 0');
  assert.deepEqual(h.records.get('chatgpt:0').messages, old.messages); assert.equal(h.records.get('chatgpt:0').fetchedAt, 123);
  assert.equal(h.records.get('chatgpt:199').fetchedAt, 0); assert.equal(h.state.status.key, 'syncDone');
  assert.deepEqual(h.writes.map(keys => keys.length), [100, 100]);
});
test('sync stops on a fully current title-only page and also accepts short pages', async () => {
  const h = harness(Array.from({ length: 100 }, (_, n) => record(n))); h.state.settings = { syncDelayMs: 1500, titlesComplete: true };
  h.respond(() => ({ ok: true, total: 101, items: Array.from({ length: 100 }, (_, n) => item(n)) }));
  await h.settle(h.synchronize()); assert.equal(h.calls.length, 1);
  const short = harness(); short.respond(() => ({ ok: true, total: 999, items: [item('a')] }));
  await short.settle(short.synchronize()); assert.equal(short.calls.length, 1); assert.equal(short.state.status.key, 'syncDone');
});
test('after an incomplete run, sync lists every page even when the first page is unchanged', async () => {
  const h = harness(Array.from({ length: 100 }, (_, n) => record(n)));
  h.respond(({ payload }) => ({ ok: true, total: 101, items: payload.offset === 0 ? Array.from({ length: 100 }, (_, n) => item(n)) : [item('old')] }));
  await h.settle(h.synchronize()); assert.equal(h.calls.length, 2); assert.ok(h.records.has('chatgpt:old'));
});
test('exports fetch fresh bodies serially with a minimum delay and cache them before downloading', async () => {
  const h = harness([record('a', 1), record('b')]); h.state.settings.syncDelayMs = 0;
  h.respond(({ type, payload }) => { assert.equal(type, 'spc:get'); return { ok: true, conversation: { ...record(payload.id), messages: [{ role: 'assistant', text: 'fresh' }] } }; });
  await h.settle(h.exportConversations([...h.records.values()], 'json', true));
  assert.equal(h.calls.length, 2); assert.ok(h.calls[1].at - h.calls[0].at >= 1000);
  assert.equal(h.records.get('chatgpt:a').messages[0].text, 'fresh'); assert.ok(h.records.get('chatgpt:b').fetchedAt > 0);
  assert.equal(JSON.parse(h.downloads[0][0]).length, 2); assert.equal(h.state.status.key, 'exportDone');
});
test('offline exports require all cached bodies and never send requests', async () => {
  const h = harness([record('a', 10), record('b')]); h.offline();
  await h.exportConversations([...h.records.values()], 'json', true);
  assert.match(h.state.status.vars.message, /exportNeedsBodies/); assert.equal(h.downloads.length, 0);
  await h.exportConversations([record('a')], 'md'); assert.equal(h.downloads.length, 1); assert.equal(h.calls.length, 0);
});
test('large exports wait for concrete confirmation; export current shares the fresh-body path', async () => {
  const h = harness(); const records = Array.from({ length: 21 }, (_, n) => record(n));
  await h.exportConversations(records, 'json', true);
  assert.equal(h.calls.length, 0); assert.equal(h.context.capture.confirmation.key, 'exportConfirm');
  assert.deepEqual(plain(h.context.capture.confirmation.vars), { platform: 'ChatGPT', count: 21, minutes: 1 });
  h.respond(({ type, payload }) => type === 'spc:ping' ? { ok: true, currentId: 'current' } : { ok: true, conversation: record(payload.id) });
  h.exportCurrent(); await h.settle(h.context.capture.editor.save({ format: 'md' }));
  assert.deepEqual(h.calls.map(call => call.type), ['spc:ping', 'spc:get']); assert.ok(h.records.get('chatgpt:current').fetchedAt > 0);
});
test('cancelled requests do not release the serial queue or save late bodies', async () => {
  const h = harness(), pending = deferred(); h.respond(() => pending.promise);
  const exporting = h.exportConversations([record('a'), record('b')], 'json', true); await h.tick(0);
  assert.equal(h.calls.length, 1); h.state.operationController.abort(); await exporting;
  assert.equal(h.downloads.length, 0); assert.equal(h.records.size, 0);
  const controller = new AbortController(), next = h.pacedRequest(1, 'spc:list', {}, controller.signal);
  await h.tick(10000); assert.equal(h.calls.length, 1);
  h.respond(() => ({ ok: true, items: [], total: 0 })); pending.resolve({ ok: true, conversation: record('a') });
  await h.settle(next); assert.equal(h.calls.length, 2); assert.equal(h.records.size, 0);
});
test('429 honors retryAfter, doubles pacing and retries at most four times', async () => {
  const h = harness(); let attempts = 0;
  h.respond(() => ++attempts === 1 ? { ok: false, status: 429, retryAfter: 7, error: 'slow' } : { ok: true });
  await h.settle(h.pacedRequest(1, 'spc:list', {}, new AbortController().signal));
  assert.equal(h.calls[1].at - h.calls[0].at, 7000);
  await h.settle(h.pacedRequest(1, 'spc:list', {}, new AbortController().signal));
  assert.equal(h.calls[2].at - h.calls[1].at, 3000);
  const failure = harness(); failure.respond(() => ({ ok: false, status: 429, error: 'slow' }));
  await assert.rejects(failure.settle(failure.pacedRequest(1, 'spc:list', {}, new AbortController().signal)), /slow/);
  assert.equal(failure.calls.length, 5); assert.equal(failure.calls[1].at - failure.calls[0].at, 30000);
  assert.equal(failure.calls[2].at - failure.calls[1].at, 60000);
});
test('search debounces 200 + 500ms, drops stale replies and never has two searches in flight', async () => {
  const h = harness(), old = deferred(); h.respond(() => old.promise);
  h.node('#conversation-search').value = 'old'; h.scheduleSearch();
  await h.tick(699); assert.equal(h.calls.length, 0); await h.tick(1); assert.equal(h.calls.length, 1);
  h.node('#conversation-search').value = 'new'; h.scheduleSearch(); await h.tick(700); assert.equal(h.calls.length, 1);
  h.respond(() => ({ ok: true, items: [{ ...item('new'), snippet: 'server' }], cursor: '30' }));
  old.resolve({ ok: true, items: [{ ...item('old'), snippet: 'stale' }], cursor: null }); await flush(); await flush();
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].payload.query, 'new');
  assert.ok(!h.records.has('chatgpt:old')); assert.equal(h.records.get('chatgpt:new').fetchedAt, 0);
  assert.equal(h.state.search.source.key, 'searchServerResults');
});
test('search paging is explicit, merged hits respect metadata and existing bodies survive', async () => {
  const h = harness([record('a', 10)]); h.state.conversations = [...h.records.values()];
  h.node('#conversation-search').value = 'server'; h.scheduleSearch();
  h.respond(({ type, payload }) => {
    assert.equal(type, 'spc:search');
    return { ok: true, items: [{ ...item(payload.cursor ? 'b' : 'a'), snippet: '<b>server</b>' }], cursor: payload.cursor ? null : '30' };
  });
  await h.tick(700); assert.equal(h.calls.length, 1); assert.equal(h.state.search.items.length, 1);
  await h.tick(10000); assert.equal(h.calls.length, 1);
  await h.settle(h.runSearch(true)); assert.equal(h.calls.length, 2); assert.equal(h.state.search.items.length, 2);
  assert.equal(h.records.get('chatgpt:a').fetchedAt, 10); assert.equal(h.records.get('chatgpt:b').fetchedAt, 0);
  h.state.meta['chatgpt:b'] = { pinned: true }; h.state.folder = 'pinned';
  assert.deepEqual(plain(h.filteredConversations().map(row => row.result.key)), ['chatgpt:b']);
});
test('search paging cancellation is immediate and late results are ignored', async () => {
  const h = harness(), pending = deferred(); h.node('#conversation-search').value = 'server'; h.scheduleSearch();
  h.respond(() => ({ ok: true, items: [{ ...item('a'), snippet: 'server' }], cursor: '30' }));
  await h.tick(700); h.respond(() => pending.promise);
  const paging = h.runSearch(true); await h.tick(0); assert.equal(h.calls.length, 2);
  h.state.operationController.abort(); await paging;
  assert.equal(h.state.operationController, null); assert.ok(h.state.search.flight);
  pending.resolve({ ok: true, items: [{ ...item('b'), snippet: 'late' }], cursor: null }); await flush();
  assert.ok(!h.records.has('chatgpt:b')); assert.equal(h.state.search.items.length, 1); assert.equal(h.state.search.flight, null);
});
test('failed server search and empty queries fall back to local results without fetching bodies', async () => {
  const h = harness([record('a', 10)]); h.state.conversations = [...h.records.values()];
  h.node('#conversation-search').value = 'cached'; h.scheduleSearch();
  h.respond(() => ({ ok: false, error: 'unavailable' })); await h.tick(700);
  assert.equal(h.state.search.source.key, 'searchUnavailable'); assert.equal(h.filteredConversations().length, 1);
  h.node('#conversation-search').value = ''; h.scheduleSearch(); await h.tick(700);
  assert.equal(h.state.search.source, null); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].type, 'spc:search');
});
const claudeRecord = (id, fetchedAt = 0) => ({ ...record(id, fetchedAt), key: `claude:${id}`, platform: 'claude' });
test('Claude sync visits every page even with complete unchanged titles and preserves ChatGPT settings and records', async () => {
  const h = harness([...Array.from({ length: 200 }, (_, n) => claudeRecord(n)), record('0', 9)]);
  h.activate({ id: 1, url: 'https://claude.ai/chat/current' });
  h.state.settings = store.normalizeSettings({ sync: { chatgpt: { lastSyncAt: 123, titlesComplete: true }, claude: { lastSyncAt: 456, titlesComplete: true } } });
  h.respond(({ type, payload }) => {
    assert.equal(type, 'spc:list');
    return { ok: true, items: payload.offset < 200 ? Array.from({ length: 100 }, (_, n) => item(payload.offset + n)) : [item('last')], total: payload.offset + 101 };
  });
  await h.settle(h.synchronize());
  assert.deepEqual(h.calls.map(call => call.payload.offset), [0, 100, 200]); assert.ok(h.records.has('claude:last'));
  assert.equal(h.records.get('chatgpt:0').fetchedAt, 9); assert.equal(h.state.status.vars.count, 201);
  assert.deepEqual(plain(h.state.settings.sync.chatgpt), { lastSyncAt: 123, titlesComplete: true });
  assert.equal(h.state.settings.sync.claude.titlesComplete, true); assert.ok(h.state.settings.sync.claude.lastSyncAt > 456);
  assert.equal(h.settingsWrites[0].sync.claude.titlesComplete, false);
});
test('ChatGPT per-platform completion still permits unchanged-page early stop', async () => {
  const h = harness(Array.from({ length: 100 }, (_, n) => record(n)));
  h.state.settings = store.normalizeSettings({ sync: { chatgpt: { lastSyncAt: 123, titlesComplete: true } } });
  h.respond(() => ({ ok: true, items: Array.from({ length: 100 }, (_, n) => item(n)), total: 101 }));
  await h.settle(h.synchronize()); assert.equal(h.calls.length, 1); assert.equal(h.state.settings.sync.chatgpt.titlesComplete, true);
});
test('mixed export downloads only the active platform and uses cached legacy records for the other', async () => {
  const cached = claudeRecord('a', 99); delete cached.platform;
  const h = harness([record('a'), cached]);
  h.respond(({ type, payload }) => { assert.equal(type, 'spc:get'); return { ok: true, conversation: { ...record(payload.id), messages: [{ role: 'assistant', text: 'fresh GPT' }] } }; });
  await h.settle(h.exportConversations([...h.records.values()], 'json', true));
  assert.equal(h.calls.length, 1);
  const exported = JSON.parse(h.downloads[0][0]);
  assert.equal(exported[0].messages[0].text, 'fresh GPT'); assert.equal(exported[1].messages[0].text, 'cached body');
  assert.equal(exported[1].platform, 'claude'); assert.equal(exported[1].fetchedAt, 99);
});
test('missing mixed-platform bodies report platform labels before downloading any bodies', async () => {
  const h = harness([record('a'), claudeRecord('b')]);
  await h.exportConversations([...h.records.values()], 'json', true);
  assert.match(h.state.status.vars.message, /exportNeedsBodies.*Claude/); assert.equal(h.calls.length, 0); assert.equal(h.downloads.length, 0);
  h.offline(); await h.exportConversations([...h.records.values()], 'json', true);
  assert.match(h.state.status.vars.message, /ChatGPT, Claude/); assert.equal(h.calls.length, 0);
});
test('large-batch confirmation counts actual downloads only', async () => {
  const cached = Array.from({ length: 25 }, (_, n) => claudeRecord(n, 1)), h = harness([record('a'), ...cached]);
  h.respond(({ payload }) => ({ ok: true, conversation: record(payload.id) }));
  await h.settle(h.exportConversations([...h.records.values()], 'json', true));
  assert.equal(h.context.capture.confirmation, null); assert.equal(h.calls.length, 1); assert.equal(JSON.parse(h.downloads[0][0]).length, 26);
  await h.exportConversations([...Array.from({ length: 21 }, (_, n) => record(n)), ...cached], 'json', true);
  assert.deepEqual(plain(h.context.capture.confirmation.vars), { platform: 'ChatGPT', count: 21, minutes: 1 });
});
test('Claude current export uses the Claude key and the serial body queue', async () => {
  const h = harness(); h.activate({ id: 1, url: 'https://claude.ai/chat/current' });
  h.respond(({ type, payload }) => type === 'spc:ping' ? { ok: true, platform: 'claude', currentId: 'current' } : { ok: true, conversation: claudeRecord(payload.id) });
  h.exportCurrent(); await h.settle(h.context.capture.editor.save({ format: 'md' }));
  assert.deepEqual(h.calls.map(call => call.type), ['spc:ping', 'spc:get']); assert.ok(h.records.get('claude:current').fetchedAt > 0);
  assert.match(h.downloads[0][0], /> Claude/);
});
test('Claude search stays single-request with no load more and combines platform and folder filters', async () => {
  const h = harness([record('local', 10), claudeRecord('cached', 10)]); h.state.conversations = [...h.records.values()];
  h.activate({ id: 1, url: 'https://claude.ai' }); h.node('#conversation-search').value = 'cached';
  h.respond(({ type }) => { assert.equal(type, 'spc:search'); return { ok: true, items: [{ ...item('remote'), snippet: 'cached' }], cursor: null }; });
  h.scheduleSearch(); await h.tick(700); await h.tick(10000); await h.runSearch(true);
  assert.equal(h.calls.length, 1); assert.equal(h.state.search.cursor, null); assert.equal(h.records.get('claude:remote').fetchedAt, 0);
  assert.deepEqual(plain(h.filteredConversations().map(row => row.result.key)), ['claude:remote', 'claude:cached', 'chatgpt:local']);
  h.state.platformFilter = 'claude'; h.state.folder = 'pinned'; h.state.meta['claude:remote'] = { pinned: true };
  assert.deepEqual(plain(h.filteredConversations().map(row => row.result.key)), ['claude:remote']);
});
test('same-tab platform navigation discards stale search and blocks queued bodies on the wrong platform', async () => {
  const h = harness(), pending = deferred(); h.respond(() => pending.promise);
  h.node('#conversation-search').value = 'old'; h.scheduleSearch(); await h.tick(700);
  h.navigate({ id: 1, url: 'https://claude.ai' }); await h.refreshTab();
  pending.resolve({ ok: true, items: [{ ...item('stale'), snippet: 'old' }], cursor: null }); await flush(); await flush();
  assert.equal(h.records.size, 0); assert.equal(h.state.platform, 'claude');
  await assert.rejects(h.settle(h.pacedRequest(1, 'spc:get', { id: 'a' }, new AbortController().signal, true, 'chatgpt')), /useSupported/);
  assert.equal(h.calls.length, 1);
});
function enableLLM(h) { h.state.settings.llm = { ...store.defaults.llm, chatModel: 'Qwen3', embeddingModel: 'Qwen3-Embedding-0.6B' }; h.state.conversations = [...h.records.values()]; }
test('summary uses cached bodies without site requests; uncached summary fetches exactly one body and caches it', async () => {
  const h = harness([record('cached', 12), record('missing')]); enableLLM(h);
  const prompts = []; h.context.SPC.llm.chat = async (_config, options) => { prompts.push(options.messages); options.onText('Visible'); return '<think>hidden</think>Summary'; };
  await h.summarize(record('cached')); assert.equal(h.calls.length, 0); assert.equal(h.records.get('chatgpt:cached').summary.text, 'Summary');
  h.respond(({ type, payload }) => { assert.equal(type, 'spc:get'); return { ok: true, conversation: { ...record(payload.id), messages: [{ role: 'user', text: 'fresh body' }] } }; });
  await h.settle(h.summarize(record('missing'))); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].payload.id, 'missing');
  assert.ok(h.records.get('chatgpt:missing').fetchedAt > 0); assert.match(prompts[1][1].content, /fresh body/);
  assert.deepEqual(plain(prompts[1]), require('../src/shared/summary.js').messages(h.records.get('chatgpt:missing')));
  for (const id of ['cached', 'missing']) {
    const saved = h.records.get('chatgpt:' + id);
    if (saved?.summary) assert.equal(saved.summary.sourceHash, search.hash(require('../src/shared/summary.js').messages(saved)[1].content));
  }
  h.offline(); await h.summarize(claudeRecord('absent')); assert.match(h.state.status.vars.message, /summaryNeedsTab.*Claude/); assert.equal(h.calls.length, 1);
});
test('summary content budget keeps beginning and end; cancelling LLM does not store a summary', async () => {
  const h = harness([record('a', 10)]); enableLLM(h);
  const text = h.summaryContent({ messages: [{ role: 'user', text: 'BEGIN' + 'x'.repeat(30000) + 'END' }] });
  assert.ok(text.length <= 24000); assert.ok(text.startsWith('user: BEGIN')); assert.ok(text.endsWith('END')); assert.match(text, /中間省略/);
  const pending = deferred(); h.context.SPC.llm.chat = () => pending.promise;
  const operation = h.summarize(record('a')); await flush(); h.state.operationController.abort(); pending.resolve('late'); await operation;
  assert.equal(h.records.get('chatgpt:a').summary, undefined); assert.equal(h.calls.length, 0);
});
test('streamed summaries coalesce by frame, use current nodes and discard pending work on completion or cancellation', async () => {
  for (const cancel of [false, true]) {
    const h = harness([record('a', 10)]); enableLLM(h);
    const pending = deferred(), renders = [], writes = []; let onText;
    h.context.SPC.markdown = { render: text => { renders.push(text); return { text }; } };
    h.context.SPC.llm.chat = (_config, options) => { onText = options.onText; return pending.promise; };
    const operation = h.summarize(record('a')); await flush();
    h.state.summaryNodes.set('chatgpt:a', { replaceChildren: () => assert.fail('stale node rendered') });
    onText('**fir'); onText('**first**'); onText('**latest**');
    assert.equal(h.frames.size, 1); assert.equal(renders.length, 0);
    const current = { replaceChildren: fragment => writes.push(fragment.text) }; h.state.summaryNodes.set('chatgpt:a', current);
    h.paint(); assert.deepEqual(renders, ['**latest**']); assert.deepEqual(writes, ['**latest**']);
    onText(''); h.paint(); assert.equal(current.textContent, 'llmThinking'); assert.equal(renders.length, 1);
    onText('Next frame'); h.paint(); assert.deepEqual(writes, ['**latest**', 'Next frame']);
    onText('Pending at finish'); assert.equal(h.frames.size, 1);
    if (cancel) h.state.operationController.abort();
    pending.resolve('Final'); await operation;
    assert.equal(h.frames.size, 0); assert.equal(h.state.summaryDrafts.size, 0); h.paint();
    assert.equal(renders.length, 2); assert.equal(h.records.get('chatgpt:a').summary?.text, cancel ? undefined : 'Final');
  }
});
test('title suggestions write nothing until accepted and create each new folder only once, merging tags', async () => {
  const h = harness([record('a', 10), record('b', 10)]); enableLLM(h); h.state.meta['chatgpt:a'] = { tags: ['existing'] };
  h.context.SPC.llm.chat = async (_config, options) => {
    const input = JSON.parse(options.messages[1].content); assert.ok(input.items.every(item => item.source === 'body' && item.excerpt.includes('cached body')));
    return JSON.stringify({ items: [...input.items.map(item => ({ id: item.id, folder: '新資料夾', tags: ['new', 'new', 'two', 'three', 'four'] })), { id: 'unknown', folder: 'No', tags: [] }] });
  };
  await h.generateSuggestions(); assert.equal(h.calls.length, 0); assert.equal(h.metaWrites.length, 0); assert.equal(h.folderWrites.length, 0); assert.equal(h.state.suggestions.length, 2);
  await h.applySuggestions(); assert.equal(h.folderWrites.length, 1); assert.equal(h.metaWrites.length, 2);
  assert.equal(h.metaWrites[0].patch.folderId, h.metaWrites[1].patch.folderId); assert.deepEqual(plain(h.metaWrites[0].patch.tags), ['existing', 'new', 'two', 'three']);
});
test('suggestion scopes respect selected filed conversations, unchecked rows, 40-title batches and 300 cap', async () => {
  const h = harness(Array.from({ length: 305 }, (_, i) => record(i, 10))); enableLLM(h); h.node('#multi-select').checked = true;
  h.state.selected = new Set(h.state.conversations.map(conv => conv.key)); h.state.folders.push({ id: 'existing', name: 'Existing' });
  h.state.meta['chatgpt:0'] = { folderId: 'existing', tags: [] }; const sizes = [];
  h.context.SPC.llm.chat = async (_config, options) => { const input = JSON.parse(options.messages[1].content); sizes.push(input.items.length); return JSON.stringify({ items: input.items.map(item => ({ id: item.id, folder: 'Existing', tags: [] })) }); };
  await h.generateSuggestions({ titles: false, folders: true, tags: true }); assert.deepEqual(sizes, [40, 40, 40, 40, 40, 40, 40, 20]); assert.equal(h.state.status.key, 'suggestCapped');
  assert.equal(h.state.suggestions[0].id, 'chatgpt:0'); h.state.suggestions.forEach(row => { row.checked = false; });
  await h.applySuggestions(); assert.equal(h.metaWrites.length, 0); assert.equal(h.folderWrites.length, 0); assert.equal(h.calls.length, 0);
});
test('semantic index uses local records only, skips matching hashes, normalizes and deletes orphan vectors', async () => {
  const h = harness([record('body', 10), record('title')]); enableLLM(h);
  h.vectors.set('orphan', { key: 'orphan', model: 'old' }); const batches = [];
  h.context.SPC.llm.embed = async (_config, input) => { batches.push(input); return input.map(() => [3, 4]); };
  await h.buildIndex(); assert.equal(h.calls.length, 0); assert.equal(h.vectors.has('orphan'), false); assert.equal(h.vectors.size, 2);
  assert.ok(batches[0][0].includes('cached body')); assert.ok(!batches[0][0].startsWith('Instruct:'));
  assert.ok(h.vectors.get('chatgpt:body').vector instanceof Float32Array); assert.ok(Math.abs(h.vectors.get('chatgpt:body').vector[0] - 0.6) < 1e-6);
  await h.buildIndex(); assert.equal(batches.length, 2);
  h.records.get('chatgpt:body').summary = { text: 'New summary' }; await h.buildIndex(); assert.equal(batches[2].length, 1); assert.match(batches[2][0], /New summary/); assert.equal(batches[3].length, 1);
});
test('semantic search debounces 500ms, sends zero site requests and ranks by cosine after filters', async () => {
  const h = harness([record('low'), record('high'), claudeRecord('best')]); enableLLM(h);
  for (const [key, vector] of [['chatgpt:low', [1, 1]], ['chatgpt:high', [5, 0]], ['claude:best', [1, 0]]]) h.vectors.set(key, { key, vector, model: h.state.settings.llm.embeddingModel });
  const inputs = []; h.context.SPC.llm.embed = async (_config, input) => { inputs.push(input); return [[1, 0]]; };
  h.state.searchMode = 'semantic'; h.state.platformFilter = 'chatgpt'; h.node('#conversation-search').value = 'find'; h.scheduleSearch();
  await h.tick(499); assert.equal(inputs.length, 0); await h.tick(1); assert.equal(inputs.length, 1); await h.runSearch();
  assert.equal(inputs[0][0], 'Instruct: Given a search query, retrieve relevant chat conversations\nQuery: find');
  assert.deepEqual(plain(h.filteredConversations().map(row => row.conv.id)), ['high', 'low']); assert.equal(h.calls.length, 0);
  h.state.folder = 'pinned'; h.state.meta['chatgpt:low'] = { pinned: true }; assert.equal(h.filteredConversations()[0].conv.id, 'low');
  h.state.settings.llm.embeddingModel = 'changed'; h.scheduleSearch(); await h.tick(500); assert.equal(h.state.search.source.key, 'semanticHint'); assert.equal(inputs.length, 1);
});

test('keyword remote hits keep saved summaries and cached bodies on later card renders', () => {
  const conv = { ...record('a', 12), summary: { text: 'Saved summary', model: 'Qwen3', createdAt: 10 } }, h = harness([conv]);
  h.state.conversations = [...h.records.values()]; h.node('#conversation-search').value = h.state.search.query = 'server';
  h.state.search.items = [{ ...item('a'), title: 'Server title', snippet: 'server' }];
  const result = h.filteredConversations()[0]; assert.equal(result.conv.summary.text, 'Saved summary'); assert.equal(result.conv.fetchedAt, 12); assert.equal(result.conv.title, 'Server title');
});
test('title inputs use display title and summary > cached body > title; titles batch at 20 with no writes or site requests', async () => {
  const rows = Array.from({ length: 42 }, (_, i) => record(i));
  rows[0].summary = { text: 'saved summary'.repeat(100) }; rows[0].fetchedAt = 10; rows[0].messages = [{ role: 'user', text: 'body excluded' }];
  rows[1].fetchedAt = 10; rows[1].messages = [{ role: 'system', text: 'secret' }, { role: 'user', text: 'first'.repeat(300) }, { role: 'assistant', text: 'reply'.repeat(300) }, { role: 'user', text: 'second'.repeat(300) }, { role: 'assistant', text: 'later answer' }, { role: 'user', text: 'third' }];
  rows[2].messages = [{ role: 'user', text: 'unfetched body excluded' }];
  const h = harness(rows); enableLLM(h); h.state.meta[rows[0].key] = { customTitle: 'Local title' }; const batches = [];
  h.context.SPC.llm.chat = async (_config, options) => {
    const input = JSON.parse(options.messages[1].content); batches.push(input.items);
    assert.match(options.messages[0].content, /source 為 title/); assert.match(options.messages[0].content, /（分支）/); assert.match(options.messages[0].content, /React、PostgreSQL、Kubernetes/);
    assert.equal(h.metaWrites.length, 0); assert.equal(h.folderWrites.length, 0); assert.equal(h.writes.length, 0); assert.equal(h.calls.length, 0);
    return JSON.stringify({ items: input.items.map(item => ({ id: item.id, title: 'New ' + item.id, folder: '', tags: [] })) });
  };
  await h.generateSuggestions(); assert.deepEqual(batches.map(batch => batch.length), [20, 20, 2]);
  const [summary, body, title] = batches[0]; assert.equal(summary.title, 'Local title'); assert.equal(summary.source, 'summary'); assert.equal(summary.summary.length, 600); assert.equal(summary.excerpt, undefined);
  assert.equal(body.source, 'body'); assert.ok(body.excerpt.length <= 800); for (const text of ['first', 'reply', 'second']) assert.ok(body.excerpt.includes(text));
  assert.ok(!/secret|later answer|third/.test(body.excerpt)); assert.deepEqual(Object.keys(title).sort(), ['id', 'source', 'title']);
  assert.equal(h.state.suggestions[0].source, 'summary'); assert.equal(h.state.suggestions[0].sync, false); assert.equal(h.metaWrites.length, 0);
  h.state.suggestions[0].title = 'Edited title'; h.state.suggestions.slice(1).forEach(row => { row.checked = false; }); await h.applySuggestions();
  assert.equal(h.state.meta[rows[0].key].customTitle, 'Edited title'); assert.equal(h.calls.length, 0); assert.equal(h.context.capture.confirmation, null);
});
test('generation honors requested kinds, omits empty/identical suggestions and tolerates malformed batches', async () => {
  const h = harness(Array.from({ length: 21 }, (_, i) => record(i))); enableLLM(h); let calls = 0;
  h.context.SPC.llm.chat = async (_config, options) => {
    const input = JSON.parse(options.messages[1].content); if (++calls === 1) return 'malformed';
    return JSON.stringify({ items: [{ id: input.items[0].id, title: 'New title', folder: 'ignored', tags: ['ignored'] }] });
  };
  await h.generateSuggestions({ titles: true, folders: false, tags: false }); assert.equal(h.state.suggestions.length, 1); assert.equal(h.state.suggestions[0].folder, ''); assert.equal(h.state.suggestions[0].tags.length, 0);
  h.state.suggestions = []; h.context.SPC.llm.chat = async (_config, options) => JSON.stringify({ items: JSON.parse(options.messages[1].content).items.map(item => ({ id: item.id, title: item.title, folder: '', tags: [] })) });
  await h.generateSuggestions(); assert.equal(h.state.suggestions.length, 0); assert.equal(h.state.status.key, 'noSuggestions');
  h.context.SPC.llm.chat = async () => 'malformed'; await h.generateSuggestions(); assert.match(h.state.status.vars.message, /格式|llmInvalid/); assert.equal(h.calls.length, 0);
});
const suggestion = (conv, extra = {}) => ({ id: conv.key, oldTitle: conv.title, title: 'New ' + conv.id, source: 'title', folder: '', tags: [], checked: true, sync: true, ...extra });
test('review applies locally first, confirms only ticked matching titles, then uses one paced rename each', async () => {
  const rows = [record('a'), record('b'), record('local'), record('unchecked'), claudeRecord('other')], h = harness(rows); enableLLM(h); h.state.settings.syncDelayMs = 0;
  h.state.meta['chatgpt:a'] = { folderId: 'keep', tags: ['old'], pinned: true }; h.state.meta['chatgpt:b'] = { originalTitle: 'First title' };
  h.state.suggestions = rows.map(conv => suggestion(conv)); h.state.suggestions[0].title = 'Edited'; h.state.suggestions[2].sync = false; h.state.suggestions[3].checked = false;
  await h.applySuggestions(); assert.equal(h.calls.length, 0); assert.equal(h.records.get('chatgpt:a').title, 'Title a'); assert.equal(h.state.meta['chatgpt:a'].customTitle, 'Edited'); assert.equal(h.state.meta['chatgpt:a'].folderId, 'keep');
  const confirmation = h.context.capture.confirmation; assert.equal(confirmation.key, 'renameConfirm'); assert.deepEqual(plain(confirmation.vars), { platform: 'ChatGPT', count: 2, minutes: 1 });
  h.respond(({ type, payload }) => { assert.equal(type, 'spc:rename'); assert.deepEqual(Object.keys(payload).sort(), ['id', 'title']); return { ok: true }; });
  await h.settle(confirmation.action()); assert.deepEqual(h.calls.map(call => call.payload.id), ['a', 'b']); assert.equal(h.calls[0].payload.title, 'Edited'); assert.ok(h.calls[1].at - h.calls[0].at >= 1000);
  assert.equal(h.records.get('chatgpt:a').title, 'Edited'); assert.equal(h.state.meta['chatgpt:a'].originalTitle, 'Title a'); assert.equal(h.state.meta['chatgpt:a'].customTitle, null); assert.equal(h.state.meta['chatgpt:a'].pinned, true);
  assert.equal(h.state.meta['chatgpt:b'].originalTitle, 'First title'); assert.equal(h.state.meta['chatgpt:local'].customTitle, 'New local'); assert.equal(h.state.meta['chatgpt:unchecked'], undefined); assert.equal(h.state.meta['claude:other'].customTitle, 'New other');
  assert.equal(h.state.status.key, 'renameDone'); assert.equal(h.state.status.vars.done, 2); assert.ok(h.progress.some(p => p.key === 'renameProgress'));
});
test('rename failures keep customTitle and continue; changing active platform after confirmation blocks requests', async () => {
  const h = harness([record('a'), record('b')]); enableLLM(h); h.state.suggestions = [...h.records.values()].map(conv => suggestion(conv));
  await h.applySuggestions(); h.respond(({ payload }) => payload.id === 'a' ? { ok: false, status: 500, error: 'failed' } : { ok: true }); await h.settle(h.context.capture.confirmation.action());
  assert.equal(h.state.meta['chatgpt:a'].customTitle, 'New a'); assert.equal(h.state.meta['chatgpt:a'].originalTitle, undefined); assert.equal(h.records.get('chatgpt:a').title, 'Title a');
  assert.equal(h.state.meta['chatgpt:b'].customTitle, null); assert.equal(h.state.status.vars.failed, 1); assert.match(h.state.status.vars.details, /failed/);
  const switched = harness([record('a')]); enableLLM(switched); switched.state.suggestions = [suggestion(record('a'))]; await switched.applySuggestions(); switched.activate({ id: 2, url: 'https://claude.ai' });
  await switched.settle(switched.context.capture.confirmation.action()); assert.equal(switched.calls.length, 0); assert.equal(switched.state.meta['chatgpt:a'].customTitle, 'New a');
});
test('rename is cancellable during flight/429 backoff and keeps late responses out of cache', async () => {
  for (const backoff of [false, true]) {
    const h = harness([record('a'), record('b')]); enableLLM(h); h.state.suggestions = [...h.records.values()].map(conv => suggestion(conv)); await h.applySuggestions();
    const pending = deferred(); h.respond(() => backoff ? { ok: false, status: 429, retryAfter: 7, error: 'slow' } : pending.promise);
    const operation = h.context.capture.confirmation.action(); await h.tick(0); assert.equal(h.calls.length, 1); h.state.operationController.abort(); await operation;
    pending.resolve({ ok: true }); await h.tick(10000); assert.equal(h.calls.length, 1); assert.equal(h.state.meta['chatgpt:a'].customTitle, 'New a'); assert.equal(h.records.get('chatgpt:a').title, 'Title a'); assert.equal(h.state.status.vars.remaining, 2);
  }
});
test('rename 429 retry remains in the shared paced queue', async () => {
  const h = harness([record('a')]); enableLLM(h); h.state.suggestions = [suggestion(record('a'))]; await h.applySuggestions(); let attempt = 0;
  h.respond(() => ++attempt === 1 ? { ok: false, status: 429, retryAfter: 7, error: 'slow' } : { ok: true }); await h.settle(h.context.capture.confirmation.action());
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].at - h.calls[0].at, 7000); assert.equal(h.records.get('chatgpt:a').title, 'New a');
});
test('manual titles and local revert wait for apply; optional site revert requires separate confirmation', async () => {
  const h = harness([record('a')]); enableLLM(h); h.editTitle(record('a')); assert.equal(h.metaWrites.length, 0);
  await h.context.capture.editor.save({ title: 'Manual title' }); assert.equal(h.state.meta['chatgpt:a'].customTitle, 'Manual title'); assert.equal(h.calls.length, 0);
  h.editTitle(record('a')); await h.context.capture.editor.save({ title: '' }); assert.equal(h.state.meta['chatgpt:a'].customTitle, null);
  h.state.meta['chatgpt:a'] = { customTitle: 'Local', originalTitle: 'Original' }; await h.revertTitle(record('a')); assert.equal(h.state.meta['chatgpt:a'].customTitle, 'Local');
  assert.equal(h.context.capture.editor.fields[0].value, false); await h.context.capture.editor.save({ sync: false }); assert.equal(h.state.meta['chatgpt:a'].customTitle, null); assert.equal(h.state.meta['chatgpt:a'].originalTitle, 'Original'); assert.equal(h.context.capture.confirmation, null);
  await h.revertTitle(record('a')); await h.context.capture.editor.save({ sync: true }); assert.equal(h.calls.length, 0); assert.equal(h.context.capture.confirmation.key, 'renameConfirm');
  h.respond(() => ({ ok: true })); await h.settle(h.context.capture.confirmation.action()); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].payload.title, 'Original'); assert.equal(h.records.get('chatgpt:a').title, 'Original'); assert.equal(h.state.meta['chatgpt:a'].originalTitle, null);
});
test('failed site revert retains originalTitle; other-platform revert is disabled and never renamed', async () => {
  const h = harness([record('a'), claudeRecord('other')]); enableLLM(h); h.state.meta['chatgpt:a'] = { originalTitle: 'Original' };
  await h.revertTitle(record('a')); await h.context.capture.editor.save({ sync: true }); h.respond(() => ({ ok: false, status: 500, error: 'failed' })); await h.settle(h.context.capture.confirmation.action());
  assert.equal(h.state.meta['chatgpt:a'].originalTitle, 'Original'); assert.equal(h.records.get('chatgpt:a').title, 'Title a');
  h.state.meta['claude:other'] = { originalTitle: 'Original' }; await h.revertTitle(claudeRecord('other')); assert.equal(h.context.capture.editor.fields[0].disabled, true);
  h.context.capture.confirmation = null; await h.context.capture.editor.save({ sync: true }); assert.equal(h.context.capture.confirmation, null); assert.equal(h.calls.length, 1);
});
test('exports and embedding use customTitle without replacing the stored site title', async () => {
  const h = harness([record('a', 10)]); enableLLM(h); h.state.meta['chatgpt:a'] = { customTitle: ' Local\n title ' }; h.offline();
  await h.exportConversations([record('a')], 'md'); assert.equal(h.downloads[0][1], 'Local title'); assert.match(h.downloads[0][0], /^# Local title\n/); assert.equal(h.records.get('chatgpt:a').title, 'Title a');
  const inputs = []; h.context.SPC.llm.embed = async (_, texts) => { inputs.push(...texts); return texts.map(() => [1, 0]); }; await h.buildIndex(); assert.match(inputs[0], /^Local title\n/);
  h.state.meta['chatgpt:a'].customTitle = 'Updated'; await h.buildIndex(); assert.equal(inputs.length, 5);
});
test('generation suppresses pending and newly scheduled keyword site searches', async () => {
  const h = harness([record('a')]); enableLLM(h); const pending = deferred(); h.context.SPC.llm.chat = () => pending.promise;
  h.node('#conversation-search').value = 'Title'; h.scheduleSearch(); const operation = h.generateSuggestions(); await h.tick(700); assert.equal(h.calls.length, 0);
  h.scheduleSearch(); await h.tick(700); assert.equal(h.calls.length, 0); await h.runSearch(); assert.equal(h.calls.length, 0);
  pending.resolve('{"items":[]}'); await operation; assert.equal(h.calls.length, 0); assert.equal(h.metaWrites.length, 0); assert.equal(h.state.generating, false);
});
test('sync preserves an empty first site title and does not clear customTitle when cache persistence fails', async () => {
  const h = harness([{ ...record('a'), title: '' }]); enableLLM(h); h.state.suggestions = [suggestion({ ...record('a'), title: '' })]; await h.applySuggestions(); h.respond(() => ({ ok: true })); await h.settle(h.context.capture.confirmation.action());
  assert.equal(h.state.meta['chatgpt:a'].originalTitle, ''); h.state.suggestions = [suggestion(h.records.get('chatgpt:a'), { title: 'Second' })]; await h.applySuggestions(); await h.settle(h.context.capture.confirmation.action()); assert.equal(h.state.meta['chatgpt:a'].originalTitle, '');
  const failed = harness([record('a')]); enableLLM(failed); failed.state.suggestions = [suggestion(record('a'))]; await failed.applySuggestions(); failed.respond(() => ({ ok: true })); failed.context.SPC.db.put = async () => { throw new Error('disk failure'); };
  await failed.settle(failed.context.capture.confirmation.action()); assert.equal(failed.state.meta['chatgpt:a'].customTitle, 'New a'); assert.equal(failed.state.meta['chatgpt:a'].originalTitle, 'Title a'); assert.equal(failed.state.status.vars.failed, 1);
});

async function qaReady(h) {
  enableLLM(h); h.context.SPC.llm.embed = async (_, input) => input.map(() => [1, 0]);
  await h.buildIndex(); h.node('#qa-scope').value = 'all'; h.node('#qa-question').value = 'What did we discuss?';
}
test('ask uses exactly one local embedding and chat request, suppresses keyword requests and includes follow-up history', async () => {
  const h = harness([record('a', 1)]); await qaReady(h); const calls = [];
  h.context.SPC.llm = require('../src/shared/llm.js').create(async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body }); assert.ok(url.startsWith('http://127.0.0.1:11123/v1/'));
    if (url.endsWith('/embeddings')) return { ok: true, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }] }) };
    const text = 'Grounded answer [1].';
    return { ok: true, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: [DONE]\n\n')); controller.close(); } }) };
  });
  h.node('#conversation-search').value = 'Title'; h.scheduleSearch(); await h.askQuestion(); await h.tick(1000);
  assert.equal(h.calls.length, 0); assert.equal(calls.length, 2); assert.ok(calls[0].url.endsWith('/embeddings')); assert.ok(calls[1].url.endsWith('/chat/completions'));
  assert.deepEqual(calls[0].body.input, ['Instruct: Given a search query, retrieve relevant chat conversations\nQuery: What did we discuss?']);
  assert.match(calls[1].body.messages.at(-1).content, /cached body/); assert.equal(h.savedQA.length, 1);
  h.node('#qa-question').value = 'And then?'; await h.askQuestion(); assert.equal(calls.length, 4);
  assert.deepEqual(calls[3].body.messages.slice(1, 3), [{ role: 'user', content: 'What did we discuss?' }, { role: 'assistant', content: 'Grounded answer [1].' }]);
  assert.equal(h.state.qa.turns.length, 2); assert.equal(h.state.qa.view.question, 'And then?');
});
test('ask hints for missing models/index, honors all scope modes and rejects work while locked', async () => {
  const h = harness([record('a'), claudeRecord('b')]); h.node('#qa-question').value = 'Question';
  await h.askQuestion(); assert.equal(h.state.qa.hint, 'qaModelsRequired'); enableLLM(h); await h.askQuestion(); assert.equal(h.state.qa.hint, 'qaIndexRequired'); assert.equal(h.calls.length, 0);
  h.state.meta['chatgpt:a'] = { folderId: 'f', pinned: true }; h.state.folders = [{ id: 'f' }];
  assert.equal(h.qaFilter({ kind: 'platform', platform: 'claude' }, 'chatgpt:a'), false);
  assert.equal(h.qaFilter({ kind: 'pinned' }, 'chatgpt:a'), true); assert.equal(h.qaFilter({ kind: 'pinned' }, 'claude:b'), false);
  assert.equal(h.qaFilter({ kind: 'folder', folder: 'folder:f' }, 'chatgpt:a'), true); assert.equal(h.qaFilter({ kind: 'folder', folder: 'unfiled' }, 'chatgpt:a'), false);
  assert.equal(h.qaFilter({ kind: 'folder', folder: 'folder:f', platformFilter: 'claude' }, 'chatgpt:a'), false);
  await qaReady(h); h.state.operationController = new AbortController(); await h.askQuestion(); assert.equal(h.savedQA.length, 0);
  h.state.operationController = null; const pending = deferred(); h.context.SPC.llm.chat = () => pending.promise;
  const asking = h.askQuestion(); await flush(); assert.ok(h.state.operationController); await h.synchronize(); await h.exportConversations([record('a')], 'json'); await h.buildIndex();
  assert.equal(h.calls.length, 0); h.state.operationController.abort(); pending.resolve('late'); await asking;
  assert.equal(h.savedQA.length, 0); assert.equal(h.state.qa.turns.length, 0); assert.equal(h.state.qa.draft, null);
});
test('QA streams coalesce renders by animation frame and discard pending frame after cancellation', async () => {
  const h = harness([record('a')]); await qaReady(h); const pending = deferred(); let onText;
  h.context.SPC.llm.chat = (_, options) => { onText = options.onText; return pending.promise; };
  const operation = h.askQuestion(); await flush(); onText('first'); onText('latest'); assert.equal(h.frames.size, 1);
  assert.equal(h.state.qa.draft.answer, 'latest'); h.paint(); assert.equal(h.frames.size, 0);
  onText('pending'); h.state.operationController.abort(); pending.resolve('late'); await operation; assert.equal(h.frames.size, 0); assert.equal(h.savedQA.length, 0);
});
test('download and re-answer caps five matching conversations, confirms count/time, paces and replaces same question/answer', async () => {
  const h = harness([...Array.from({ length: 7 }, (_, i) => record(i)), claudeRecord('other')]); await qaReady(h); h.state.settings.syncDelayMs = 0;
  const questions = []; h.context.SPC.llm.chat = async (_, options) => { questions.push(options.messages); return 'Answer [1]'; };
  await h.askQuestion(); assert.equal(h.state.qa.view.coverage.titleOnly, 8); assert.equal(h.qaDownloads().length, 5);
  const firstCreated = h.savedQA[0].createdAt; h.node('#qa-question').value = 'Edited but not asked';
  await h.downloadQA(); assert.equal(h.calls.length, 0); const confirm = h.context.capture.confirmation;
  assert.equal(confirm.key, 'qaDownloadConfirm'); assert.deepEqual(plain(confirm.vars), { platform: 'ChatGPT', count: 5, seconds: 5 });
  h.respond(({ type, payload }) => { assert.equal(type, 'spc:get'); return { ok: true, conversation: { ...record(payload.id), messages: [{ role: 'assistant', text: 'Downloaded facts' }] } }; });
  await h.settle(confirm.action()); assert.equal(h.calls.length, 5); assert.ok(h.calls.every(call => ['0', '1', '2', '3', '4'].includes(call.payload.id)));
  h.calls.slice(1).forEach((call, i) => assert.ok(call.at - h.calls[i].at >= 1000)); assert.equal(h.records.get('claude:other').fetchedAt, 0);
  assert.equal(questions.length, 2); assert.ok(questions[1].at(-1).content.endsWith('問題：What did we discuss?')); assert.match(questions[1].at(-1).content, /Downloaded facts/);
  assert.equal(questions[1].length, 2, 're-answer excludes replaced pair from history'); assert.equal(h.state.qa.turns.length, 1); assert.equal(h.savedQA.length, 1); assert.equal(h.savedQA[0].createdAt, firstCreated);
  assert.ok(h.chunks.has('chatgpt:0#1')); assert.ok(h.chunks.has('claude:other#0')); assert.equal(h.state.operationController, null);
});
test('QA downloads require matching active platform at confirmation and during dispatch; one needs no confirmation', async () => {
  const h = harness([record('a'), record('b')]); await qaReady(h); await h.askQuestion(); await h.downloadQA();
  h.activate({ id: 2, url: 'https://claude.ai' }); await h.context.capture.confirmation.action(); assert.equal(h.calls.length, 0);
  const single = harness([record('a')]); await qaReady(single); await single.askQuestion();
  single.respond(({ payload }) => ({ ok: true, conversation: record(payload.id, 1) })); await single.settle(single.downloadQA()); assert.equal(single.context.capture.confirmation, null); assert.equal(single.calls.length, 1);
  const switched = harness([record('a')]); await qaReady(switched); await switched.askQuestion();
  const operation = switched.downloadQA(); switched.navigate({ id: 2, url: 'https://claude.ai' }); await switched.settle(operation); assert.equal(switched.calls.length, 0);
});
test('QA download 429 backoff and in-flight cancellation keep late bodies and re-answers out of cache', async () => {
  for (const backoff of [false, true]) {
    const h = harness([record('a')]); await qaReady(h); await h.askQuestion(); const pending = deferred();
    h.respond(() => backoff ? { ok: false, status: 429, retryAfter: 7, error: 'slow' } : pending.promise);
    const operation = h.downloadQA(); await h.tick(0); assert.equal(h.calls.length, 1); h.state.operationController.abort(); await operation;
    pending.resolve({ ok: true, conversation: record('a', 1) }); await h.tick(10000);
    assert.equal(h.calls.length, 1); assert.equal(h.records.get('chatgpt:a').fetchedAt, 0); assert.equal(h.savedQA.length, 1); assert.equal(h.state.qa.turns.length, 1);
  }
});

test('operation controller publishes, refreshes and clears the two-minute panel busy signal', async () => {
  const h = harness(); h.state.operationController = new AbortController(); await h.tick(0);
  assert.equal(h.session.panelBusy.until, 1120000);
  await h.tick(180000); assert.ok(h.session.panelBusy.until > 1180000);
  assert.ok(h.sessionWrites.length >= 6);
  h.state.operationController = null; await h.tick(0); assert.equal(h.session.panelBusy, undefined);
  const count = h.sessionWrites.length; await h.tick(60000); assert.equal(h.sessionWrites.length, count);
  await h.localOperation(async () => { assert.ok(h.session.panelBusy); throw new Error('test'); });
  await h.tick(0); assert.equal(h.session.panelBusy, undefined);
});

for (const lang of ['zh-TW', 'en']) test(`panel Q&A and suggestions pass settings.lang=${lang} to the real prompt builders`, async () => {
  const h = harness([record('rust', 1)]); await qaReady(h); h.state.settings.lang = lang;
  const calls = [], embeds = [];
  h.context.SPC.llm.embed = async (_, inputs) => { embeds.push(inputs); return inputs.map(() => [1, 0]); };
  h.context.SPC.llm.chat = async (_, options) => { calls.push(plain(options.messages)); return 'Answer [1]'; };
  await h.askQuestion();
  assert.equal(calls.length, 1); assert.equal(embeds.length, 1);
  assert.equal(calls[0][0].content, h.context.SPC.rag.buildQAMessages({ question: '', excerpts: [], lang })[0].content);
  assert.equal(calls[0][0].content.includes('in English'), lang === 'en');
  h.context.SPC.llm.chat = async (_, options) => { calls.push(plain(options.messages)); return '{"items":[]}'; };
  const options = { titles: true, folders: true, tags: true };
  await h.generateSuggestions(options);
  assert.equal(calls.length, 2); assert.equal(h.calls.length, 0);
  assert.equal(calls[1][0].content, h.suggestionPrompt(options, lang));
  assert.equal(calls[1][0].content.includes('in English'), lang === 'en');
});

for (const lang of ['zh-TW', 'en']) test(`panel manual weekly review passes settings.lang=${lang} through generate to chat`, async () => {
  const h = harness(); enableLLM(h); h.state.settings.lang = lang;
  const digest = require('../src/shared/digest.js'), week = '2026-W41', calls = [], saved = [];
  h.context.SPC.digest = digest;
  const conv = { ...record('rust', 1), updateTime: digest.weekRange(week).start, summary: { text: 'TODO: compare mutable references.' } };
  h.records.set(conv.key, conv);
  h.context.chrome.storage.session.get = async () => ({});
  h.context.SPC.db.digests = { getAll: async () => saved, put: async value => saved.push(value) };
  h.context.SPC.store.set = async () => {};
  h.context.SPC.llm.chat = async (_, options) => { calls.push(plain(options.messages)); return 'Weekly review'; };
  // Supply inert render nodes; the real panel generation and shared digest orchestration run unchanged.
  for (const id of ['digest-list', 'digest-answer']) h.node('#' + id).replaceChildren = () => {};
  h.node('#digest-answer').append = () => {};
  h.context.SPC.panel.button = () => ({ setAttribute() {}, append() {} });
  h.context.SPC.panel.el = () => ({ append() {} });
  h.context.SPC.markdown = { render: () => ({}) };
  h.context.SPC.rag = { ...h.context.SPC.rag, citationButtons: () => {} };
  await h.generateDigest(week);
  assert.equal(calls.length, 1); assert.equal(saved.length, 1); assert.equal(h.calls.length, 0);
  assert.equal(calls[0][0].content, digest.buildDigestMessages({ week, items: [], lang })[0].content);
  assert.equal(calls[0][0].content.includes('English Markdown'), lang === 'en');
  assert.ok(calls[0][1].content.includes('TODO: compare mutable references.'));
});
