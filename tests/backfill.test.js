'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const helper = require('../src/shared/backfill.js'), summary = require('../src/shared/summary.js');
const plain = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const record = (id, platform = 'chatgpt', updateTime = 1) => ({ key: platform + ':' + id, id, platform, title: id, updateTime, messages: [], fetchedAt: 0 });
function harness() {
  let time = new Date(2026, 9, 7, 12).getTime(), sequence = 0;
  const calls = [], events = [], sessionWrites = [], timers = new Map(), records = new Map(), vectors = new Map(), chunks = new Map();
  const data = { backfill: { enabled: true, lastListDay: { chatgpt: helper.localDay(time), claude: helper.localDay(time) } }, convMeta: {}, folders: [], settings: { digest: { autoWeekly: false }, llm: { chatModel: 'chat', embeddingModel: '' } } }, session = {};
  const rows = [record('a'), record('b')]; rows.forEach(row => { records.set(row.key, row); data.convMeta[row.key] = { pinned: true }; });
  const context = vm.createContext({ URL, AbortController, DOMException, Date: class extends Date { constructor(...args) { super(...(args.length ? args : [time])); } static now() { return time; } },
    setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, at: time + delay }); return id; }, clearTimeout: id => timers.delete(id),
    chrome: { storage: { local: { get: async key => typeof key === 'string' ? { [key]: structuredClone(data[key]) } : structuredClone(data), set: async patch => Object.assign(data, structuredClone(patch)) },
      session: { get: async () => structuredClone(session), set: async patch => { sessionWrites.push({ at: time, patch: plain(patch) }); Object.assign(session, structuredClone(patch)); }, remove: async key => { delete session[key]; } } },
      tabs: { query: async query => { calls.push({ query }); return [{ id: query.url.includes('claude') ? 2 : 1 }]; }, sendMessage: async (tab, message) => {
        calls.push({ tab, ...plain(message) }); events.push(message.type);
        if (message.type === 'spc:activity') return { ok: true, lastInteractionAt: 0 };
        if (message.type === 'spc:list') return { ok: true, items: [], total: 0 };
        return { ok: true, conversation: { ...records.get('chatgpt:' + message.payload.id), messages: [{ role: 'user', text: 'Body' }] } };
      } } } });
  for (const file of ['shared/storage', 'shared/platforms', 'shared/conversation', 'shared/search', 'shared/rag', 'shared/summary', 'shared/digest', 'shared/backfill', 'background/backfill']) vm.runInContext(fs.readFileSync(require.resolve('../src/' + file + '.js'), 'utf8'), context);
  const table = map => ({ get: async key => map.get(key), getAll: async () => [...map.values()], put: async row => map.set(row.key, plain(row)),
    putMany: async rows => rows.forEach(row => map.set(row.key, plain(row))), delete: async keys => (Array.isArray(keys) ? keys : [keys]).forEach(key => map.delete(key)) });
  const digests = new Map(), keyval = new Map();
  const db = { digests: { get: async week => digests.get(week), getAll: async () => [...digests.values()], put: async value => digests.set(value.week, plain(value)) }, keyval: { get: async key => keyval.get(key), set: async (key, value) => keyval.set(key, plain(value)) }, ...table(records), vectors: table(vectors), chunks: table(chunks) }, llm = {
    listModels: async () => { events.push('models'); return ['chat']; },
    chat: async (_, options) => { events.push('chat'); calls.push({ messages: plain(options.messages) }); return 'Summary'; },
    stripThinking: text => text, embed: async (_, inputs) => { events.push('embed'); calls.push({ inputs: plain(inputs) }); return inputs.map(() => [3, 4]); }
  };
  let owner = 0;
  const create = () => context.SPC.backfillWorker.create({ chrome: context.chrome, store: context.SPC.store, db, llm, token: () => String(++owner) });
  const worker = create();
  async function advance(ms) {
    const end = time + ms; await flush();
    while (true) {
      const next = [...timers].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      time = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
    }
    time = end; await flush();
  }
  return { context, data, session, records, digests, keyval, db, vectors, chunks, llm, calls, events, sessionWrites, worker, create, advance, now: () => time,
    gets: () => calls.filter(call => call.type === 'spc:get'), state: () => context.SPC.store.get('backfill') };
}
test('candidate scope, pinned-first, recency, saved summaries, failures and open platforms', () => {
  const rows = [record('loose'), record('orphan'), record('filed', 'claude', 500), record('old', 'chatgpt', 1), record('new', 'chatgpt', 10), record('failed'), { ...record('done'), summary: { text: 'saved' } }];
  const meta = { 'chatgpt:orphan': { folderId: 'missing' }, 'claude:filed': { folderId: 'f' }, 'chatgpt:old': { pinned: true }, 'chatgpt:new': { pinned: true }, 'chatgpt:failed': { pinned: true }, 'chatgpt:done': { pinned: true } };
  const folders = [{ id: 'f' }], failures = { 'chatgpt:failed': 3 };
  assert.deepEqual(helper.candidates(rows, meta, folders, failures).map(c => c.id), ['new', 'old', 'filed']);
  assert.deepEqual(helper.candidates(rows, meta, folders, failures, new Set(['claude'])).map(c => c.id), ['filed']);
  assert.deepEqual(helper.stats(rows, meta, folders), { total: 5, done: 1, remaining: 4, stale: 0 });
});
test('disabled, cap, busy, no candidate and no tab do not touch the site or probe the LLM', async () => {
  for (const status of ['disabled', 'capReached', 'skippedBusy', 'noCandidates', 'noTab']) {
    const h = harness();
    if (status === 'disabled') h.data.backfill.enabled = false;
    if (status === 'capReached') Object.assign(h.data.backfill, { day: helper.localDay(h.now()), doneToday: 20 });
    if (status === 'skippedBusy') h.session.panelBusy = { until: h.now() + 1 };
    if (status === 'noCandidates') h.data.convMeta = {};
    if (status === 'noTab') h.context.chrome.tabs.query = async () => [];
    await h.worker.tick(); assert.equal((await h.state()).lastStatus, status); assert.equal(h.events.length, 0); assert.equal(h.gets().length, 0);
  }
});
test('new local day resets daily count while retaining total and failures', async () => {
  const h = harness(); Object.assign(h.data.backfill, { day: '2026-10-06', doneToday: 100, doneTotal: 4, failures: { 'chatgpt:b': 2 }, dailyLimit: 1 });
  await h.worker.tick(); assert.equal((await h.state()).doneToday, 1); assert.equal((await h.state()).doneTotal, 5);
  await h.worker.tick(); assert.equal(h.gets().length, 1); assert.equal((await h.state()).lastStatus, 'capReached');
  assert.equal((await h.state()).failures['chatgpt:b'], 2);
  await h.advance(helper.nextMidnight(h.now()) - h.now()); h.data.backfill.lastListDay = { chatgpt: helper.localDay(h.now()), claude: helper.localDay(h.now()) }; await h.worker.tick(); assert.equal(h.gets().length, 2);
});
test('LLM probe precedes site get; missing config, absent model and failed probes never fetch', async () => {
  for (const mode of ['missing', 'absent', 'offline', 'invalidURL']) {
    const h = harness();
    if (mode === 'missing') h.data.settings.llm.chatModel = '';
    if (mode === 'invalidURL') h.data.settings.llm.baseUrl = 'https://remote.test';
    h.llm.listModels = async () => { if (mode === 'offline') throw new Error('offline'); return []; };
    await h.worker.tick(); assert.equal(h.gets().length, 0); assert.equal((await h.state()).lastStatus, 'llmUnavailable');
    assert.equal((await h.state()).doneToday, 0); assert.deepEqual(plain((await h.state()).failures), {});
  }
  const h = harness(); await h.worker.tick(); assert.ok(h.events.indexOf('models') < h.events.indexOf('spc:get'));
});
for (const status of [429, 401, 403]) test(`site ${status} pauses until local midnight, including restart, disable/re-enable and resume attempts`, async () => {
  const h = harness(), original = h.context.chrome.tabs.sendMessage;
  h.context.chrome.tabs.sendMessage = async (tab, message) => message.type === 'spc:get' ? (await original(tab, message), { ok: false, status }) : original(tab, message);
  await h.worker.tick(); assert.equal((await h.state()).pausedUntil, helper.nextMidnight(h.now()));
  assert.equal((await h.state()).lastStatus, status === 429 ? 'rateLimited' : 'authRequired');
  await h.worker.preferences({ enabled: false }); await h.worker.tick(); await h.worker.preferences({ enabled: true, resume: true });
  await h.create().tick(); await h.advance(60000); await h.worker.tick(); assert.equal(h.gets().length, 1);
  assert.deepEqual(plain((await h.state()).failures), {});
  await h.advance(helper.nextMidnight(h.now()) - h.now()); h.data.backfill.lastListDay = { chatgpt: helper.localDay(h.now()), claude: helper.localDay(h.now()) }; await h.worker.tick(); assert.equal(h.gets().length, 2);
});
test('recent page interaction skips; exactly 60 seconds allows one get; panel becoming busy during probe skips', async () => {
  const h = harness(), original = h.context.chrome.tabs.sendMessage;
  let last = h.now() - 59999;
  h.context.chrome.tabs.sendMessage = async (tab, message) => message.type === 'spc:activity' ? { ok: true, lastInteractionAt: last } : original(tab, message);
  await h.worker.tick(); assert.equal((await h.state()).lastStatus, 'skippedActive'); assert.equal(h.gets().length, 0);
  await h.advance(1); await h.worker.tick(); assert.equal(h.gets().length, 1);
  const busy = harness(); busy.llm.listModels = async () => { busy.session.panelBusy = { until: busy.now() + 120000 }; return ['chat']; };
  await busy.worker.tick(); assert.equal((await busy.state()).lastStatus, 'skippedBusy'); assert.equal(busy.gets().length, 0);
});
test('one get saves full export-shaped record and shared summary; embedding affects only that conversation', async () => {
  for (const embedding of ['', 'embed']) {
    const h = harness(); h.data.settings.llm.embeddingModel = embedding;
    h.vectors.set('other', { key: 'other' }); h.chunks.set('other#0', { key: 'other#0', convKey: 'other', text: 'keep' });
    h.chunks.set('chatgpt:a#99', { key: 'chatgpt:a#99', convKey: 'chatgpt:a', text: 'stale' });
    await h.worker.tick(); assert.equal(h.gets().length, 1); assert.equal(h.gets()[0].payload.backfill, true);
    const saved = h.records.get('chatgpt:a'); assert.equal(saved.fetchedAt, h.now()); assert.deepEqual(saved.summary, { text: 'Summary', model: 'chat', createdAt: h.now(), sourceHash: h.context.SPC.search.hash(summary.content(saved)) });
    assert.deepEqual(h.calls.find(call => call.messages).messages, summary.messages(saved));
    assert.equal((await h.state()).lastStatus, 'done'); assert.equal((await h.state()).doneToday, 1);
    assert.deepEqual(h.vectors.get('other'), { key: 'other' }); assert.equal(h.chunks.get('other#0').text, 'keep');
    assert.equal(h.vectors.has('chatgpt:a'), Boolean(embedding)); assert.equal(h.vectors.has('chatgpt:b'), false);
    assert.equal(h.chunks.has('chatgpt:a#1'), Boolean(embedding)); assert.equal(h.chunks.has('chatgpt:b#0'), false);
    assert.equal(h.chunks.has('chatgpt:a#99'), !embedding);
    assert.equal(h.events.includes('embed'), Boolean(embedding));
  }
});
test('caught failures consume budget, increment failures and skip after three; LLM HTTP errors do not impose site pause', async () => {
  const h = harness(); h.llm.chat = async () => { throw Object.assign(new Error('local unauthorized'), { status: 401 }); };
  for (let i = 0; i < 4; i++) await h.worker.tick();
  assert.deepEqual(h.gets().map(call => call.payload.id), ['a', 'a', 'a', 'b']);
  assert.equal((await h.state()).failures['chatgpt:a'], 3); assert.equal((await h.state()).pausedUntil, 0); assert.equal((await h.state()).doneToday, 4);
});
test('in-memory and session leases exclude overlapping ticks; heartbeat is throttled and renews long generations', async () => {
  const h = harness(); let finish;
  h.llm.chat = () => new Promise(resolve => { finish = resolve; });
  const running = h.worker.tick(); await flush(); assert.equal(h.gets().length, 1);
  await h.worker.tick(); await h.create().tick(); assert.equal(h.gets().length, 1);
  await h.advance(9999); assert.equal(h.sessionWrites.filter(item => item.patch.backfillProgress).length, 0);
  await h.advance(1); assert.equal(h.sessionWrites.filter(item => item.patch.backfillProgress).length, 1);
  await h.advance(6 * 60000); await h.create().tick(); assert.equal(h.gets().length, 1);
  const beats = h.sessionWrites.filter(item => item.patch.backfillProgress); beats.slice(1).forEach((item, i) => assert.ok(item.at - beats[i].at >= 10000));
  assert.ok(h.session.backfillLease.until > h.now()); finish('Done'); await running;
  assert.equal(h.session.backfillLease, undefined); const count = h.sessionWrites.length; await h.advance(60000); assert.equal(h.sessionWrites.length, count);
});
test('dead worker lease expires and retries without recording a failure', async () => {
  const h = harness(); h.session.backfillLease = { owner: 'dead', until: h.now() + 300000 };
  await h.worker.tick(); assert.equal(h.gets().length, 0);
  await h.advance(300000); await h.worker.tick(); assert.equal(h.gets().length, 1); assert.deepEqual(plain((await h.state()).failures), {});
});
// Credentials live only in the content script's memory, so the worker must not skip a freshly reloaded tab:
// the adapter reads them on demand (see backfill-adapters.test.js) and the tick proceeds to one spc:get.
test('a tab without cached credentials is not skipped: the tick sends exactly one spc:get', async () => {
  const h = harness(); h.context.chrome.tabs.sendMessage = async (tab, message) => {
    h.calls.push({ tab, ...plain(message) });
    if (message.type === 'spc:activity') return { ok: true, lastInteractionAt: 0 };
        if (message.type === 'spc:list') return { ok: true, items: [], total: 0 };
    return { ok: true, conversation: { ...h.records.get('chatgpt:' + message.payload.id), messages: [{ role: 'user', text: 'Body' }] } };
  };
  await h.worker.tick(); assert.equal(h.gets().length, 1); assert.equal((await h.state()).lastStatus, 'done'); assert.equal((await h.state()).doneToday, 1);
});
test('backup exports/imports only validated backfill preferences and preserves live safety counters on import', async () => {
  const h = harness(), store = h.context.SPC.store;
  await store.updateBackfill({ enabled: true, dailyLimit: 25, day: '2026-10-07', doneToday: 9, failures: { 'chatgpt:a': 2 }, lastStatus: 'rateLimited', pausedUntil: helper.nextMidnight(h.now()) });
  const backup = await store.exportBackup(); assert.deepEqual(plain(backup.backfill), { enabled: true, dailyLimit: 25 });
  backup.convMeta = {}; backup.backfill.failures = { 'chatgpt:a': 100 }; backup.backfill.doneToday = 0;
  assert.deepEqual(plain(store.validateBackup(backup).backfill), { enabled: true, dailyLimit: 25 });
  await store.importBackup(backup, 'overwrite'); assert.equal((await h.state()).doneToday, 9); assert.equal((await h.state()).failures['chatgpt:a'], 2);
  assert.equal((await h.state()).pausedUntil, helper.nextMidnight(h.now()));
  for (const dailyLimit of [0, 101, 1.5, '20']) assert.throws(() => store.validateBackup({ ...backup, backfill: { enabled: true, dailyLimit } }));
  assert.equal(store.normalizeBackfill({ enabled: 'true', dailyLimit: 999, lastStatus: 'bogus' }).enabled, false);
  assert.equal(store.normalizeBackfill({ dailyLimit: 999 }).dailyLimit, 20);
});
test('shared summary budget keeps both ends and generates identical messages for panel and worker', () => {
  const conv = { messages: [{ role: 'user', text: 'FIRST' + 'x'.repeat(25000) + 'LAST' }] };
  const text = summary.content(conv); assert.ok(text.length <= 24000); assert.ok(text.startsWith('user: FIRST')); assert.ok(text.endsWith('LAST'));
  assert.match(text, /中間省略/);
  const context = vm.createContext({ SPC: { summary, panel: { state: {} } } });
  vm.runInContext(fs.readFileSync(require.resolve('../src/sidepanel/local-llm.js'), 'utf8'), context);
  assert.equal(context.SPC.panel.summaryContent(conv), summary.messages(conv)[1].content);
});

test('manual pause after missing credentials can resume, while real site stops cannot', async () => {
  const h = harness(); await h.context.SPC.store.updateBackfill({ lastStatus: 'authRequired', pausedUntil: 0 });
  await h.worker.preferences({ pause: true }); assert.equal((await h.state()).lastStatus, 'disabled');
  await h.worker.preferences({ resume: true }); assert.equal((await h.state()).pausedUntil, 0);
});
test('worker picks a filed Claude candidate when the pinned ChatGPT platform has no tab', async () => {
  const h = harness(), row = record('claude-only', 'claude', 100); h.records.set(row.key, row); h.data.folders = [{ id: 'f' }]; h.data.convMeta[row.key] = { folderId: 'f' };
  const query = h.context.chrome.tabs.query, send = h.context.chrome.tabs.sendMessage;
  h.context.chrome.tabs.query = async value => value.url === 'https://chatgpt.com/*' ? [] : query(value);
  h.context.chrome.tabs.sendMessage = async (tab, message) => {
    const result = await send(tab, message);
    return message.type === 'spc:get' ? { ok: true, conversation: { ...row, messages: [{ role: 'user', text: 'Claude body' }] } } : result;
  };
  await h.worker.tick(); assert.equal(h.gets().length, 1); assert.equal(h.gets()[0].tab, 2); assert.equal(h.gets()[0].payload.id, 'claude-only');
  assert.ok(h.records.get(row.key).summary);
});
test('pre-dispatch reservation rechecks disable and pause after slow DB reads', async () => {
  for (const patch of [{ enabled: false }, { pause: true }]) {
    const h = harness(), get = h.context.SPC.store.get;
    h.context.SPC.store.get = async (key, fallback) => {
      const value = await get(key, fallback);
      if (key === 'folders' && h.events.includes('spc:activity')) await h.worker.preferences(patch);
      return value;
    };
    await h.worker.tick(); assert.equal(h.gets().length, 0); assert.equal((await h.state()).doneToday, 0);
  }
});

test('staleness uses strict ten-minute grace; missing first, then pinned/recent stale records', () => {
  const rows = ['missing', 'stale-filed', 'stale-pin-old', 'stale-pin-new', 'grace', 'fresh'].map((id, i) => ({ ...record(id, 'chatgpt', 600001 + i), ...(i ? { summary: { text: 'Saved', createdAt: i >= 4 ? i + 1 : 0 } } : {}) }));
  const meta = Object.fromEntries(rows.map(row => [row.key, { folderId: 'f', pinned: row.id.startsWith('stale-pin') }]));
  assert.deepEqual(helper.candidates(rows, meta, [{ id: 'f' }]).map(row => row.id), ['missing', 'stale-pin-new', 'stale-pin-old', 'stale-filed']);
  assert.equal(helper.isStale({ updateTime: 600100, summary: { text: 'a', createdAt: 100 } }), false);
  assert.equal(helper.isStale({ updateTime: 600101, summary: { text: 'a', createdAt: 100 } }), true);
  assert.deepEqual(helper.stats(rows, meta, [{ id: 'f' }]), { total: 6, done: 5, remaining: 1, stale: 3 });
});
test('first daily tick lists one open platform at a time, reserves daily cap, preserves bodies and summaries', async () => {
  const h = harness(); h.data.backfill.lastListDay = {};
  const old = { ...h.records.get('chatgpt:a'), messages: [{ role: 'user', text: 'keep' }], fetchedAt: 12, summary: { text: 'keep summary', createdAt: 13 } };
  h.records.set(old.key, old);
  const send = h.context.chrome.tabs.sendMessage;
  h.context.chrome.tabs.sendMessage = async (tab, message) => {
    if (message.type !== 'spc:list') return send(tab, message);
    h.calls.push({ tab, ...plain(message) }); assert.equal((await h.state()).doneToday, h.calls.filter(call => call.type === 'spc:list').length);
    return { ok: true, items: [{ id: 'a', title: 'Changed', updateTime: 999999 }, { id: 'new', title: 'New', updateTime: 123 }], total: 2 };
  };
  await h.worker.tick(); assert.equal((await h.state()).lastStatus, 'listed'); assert.equal(h.gets().length, 0); assert.ok(!h.events.includes('chat'));
  assert.deepEqual(h.records.get(old.key), { ...old, title: 'Changed', updateTime: 999999 });
  assert.equal(h.records.get('chatgpt:new').fetchedAt, 0);
  await h.worker.tick(); assert.equal(h.calls.filter(call => call.type === 'spc:list').length, 2); assert.equal(h.gets().length, 0);
  assert.deepEqual(plain((await h.state()).lastListDay), { chatgpt: helper.localDay(h.now()), claude: helper.localDay(h.now()) });
  h.data.backfill.dailyLimit = 2; await h.worker.tick(); assert.equal((await h.state()).lastStatus, 'capReached');
  await h.advance(helper.nextMidnight(h.now()) - h.now()); await h.worker.tick(); assert.equal(h.calls.filter(call => call.type === 'spc:list').length, 3); assert.equal((await h.state()).doneToday, 1);
});
for (const status of [429, 401, 403]) test(`list ${status} consumes the tick budget and pauses until next local day`, async () => {
  const h = harness(); h.data.backfill.lastListDay = {};
  const send = h.context.chrome.tabs.sendMessage;
  h.context.chrome.tabs.sendMessage = async (tab, message) => message.type === 'spc:list' ? (h.calls.push(message), { ok: false, status }) : send(tab, message);
  await h.worker.tick(); await h.worker.tick();
  assert.equal(h.calls.filter(call => call.type === 'spc:list').length, 1); assert.equal((await h.state()).doneToday, 1);
  assert.equal((await h.state()).pausedUntil, helper.nextMidnight(h.now())); assert.equal(h.gets().length, 0);
});
for (const same of [true, false, undefined]) test(`stale body refresh ${same === true ? 'skips unchanged hash' : same === false ? 'regenerates changed hash' : 'regenerates legacy summary'}`, async () => {
  const h = harness(); h.records.delete('chatgpt:b');
  const body = { messages: [{ role: 'user', text: 'Body' }] }, sourceHash = h.context.SPC.search.hash(summary.content(body));
  h.records.set('chatgpt:a', { ...h.records.get('chatgpt:a'), updateTime: h.now(), summary: { text: 'Old', model: 'old', createdAt: 1, ...(same !== undefined ? { sourceHash: same ? sourceHash : 'changed' } : {}) } });
  await h.worker.tick(); const saved = h.records.get('chatgpt:a');
  assert.equal(saved.fetchedAt, h.now()); assert.deepEqual(saved.messages, body.messages); assert.equal(saved.summary.createdAt, h.now());
  assert.equal(saved.summary.sourceHash, sourceHash); assert.equal(h.events.includes('chat'), same !== true);
  assert.equal((await h.state()).lastStatus, same ? 'refreshedUnchanged' : 'done'); assert.equal((await h.state()).doneToday, 1);
});
test('auto weekly waits for Monday 06:00, runs while backfill disabled once, holds lease, never sends site requests', async () => {
  const h = harness(); h.data.settings.digest.autoWeekly = true; h.data.backfill.enabled = false;
  await h.advance(new Date(2026, 9, 12, 5, 59).getTime() - h.now()); await h.worker.tick(); assert.equal(h.events.length, 0);
  await h.advance(60000); let finish; h.llm.chat = () => new Promise(resolve => { finish = resolve; });
  const pending = h.worker.tick(); await flush(); assert.ok(h.session.backfillLease);
  await h.create().tick(); await h.worker.tick(); assert.equal(h.calls.filter(call => call.type).length, 0);
  finish('Weekly review [1]'); await pending;
  assert.equal(h.digests.size, 1); assert.equal(h.digests.get('2026-W41').partial, false); assert.equal(h.session.backfillLease, undefined);
  h.llm.chat = () => assert.fail('must not regenerate'); await h.worker.tick();
  assert.equal(h.calls.filter(call => call.type).length, 0);
});
test('auto weekly requires available local model, no busy panel and no site work, failures retry on later days at most three times', async () => {
  const h = harness(); h.data.settings.digest.autoWeekly = true; h.data.backfill.enabled = false;
  h.llm.listModels = async () => []; await h.worker.tick(); assert.equal(h.keyval.size, 0);
  h.llm.listModels = async () => ['chat']; h.session.panelBusy = { until: h.now() + 1 }; await h.worker.tick(); assert.equal(h.keyval.size, 0); delete h.session.panelBusy;
  let attempts = 0; h.llm.chat = async () => { attempts++; throw new Error('failed'); };
  await h.worker.tick(); await h.worker.tick(); assert.equal(attempts, 1);
  for (let i = 0; i < 3; i++) { await h.advance(86400000); await h.worker.tick(); await h.worker.tick(); }
  assert.equal(attempts, 3); assert.equal(h.keyval.get('digest-attempt:2026-W40').count, 3); assert.equal(h.calls.filter(call => call.type).length, 0);
  const active = harness(); active.data.settings.digest.autoWeekly = true; active.data.backfill.lastListDay = {};
  await active.worker.tick(); assert.equal((await active.state()).lastStatus, 'listed'); assert.equal(active.digests.size, 0);
});

test('automatic LLM failure and busy panel cannot erase a site-imposed pause or allow early resume', async () => {
  for (const status of ['rateLimited', 'authRequired']) {
    const h = harness(); h.data.settings.digest.autoWeekly = true;
    Object.assign(h.data.backfill, { pausedUntil: helper.nextMidnight(h.now()), lastStatus: status, lastRunAt: 123 });
    h.llm.listModels = async () => { throw new Error('offline'); };
    await h.worker.tick(); assert.equal((await h.state()).lastStatus, status); assert.equal((await h.state()).lastRunAt, 123);
    h.session.panelBusy = { until: h.now() + 1000 }; await h.worker.tick(); await h.worker.preferences({ resume: true });
    assert.equal((await h.state()).pausedUntil, helper.nextMidnight(h.now())); assert.equal((await h.state()).lastStatus, status);
  }
});

test('background preflight, summaries, embeddings and automatic digests record existing LLM calls without extra fetches', async () => {
  const h = harness(), fetches = [];
  h.context.TextDecoder = TextDecoder;
  vm.runInContext(fs.readFileSync(require.resolve('../src/shared/llm.js'), 'utf8'), h.context);
  let offline = false;
  const api = h.context.SPC.llm.create(async (url, options) => {
    fetches.push(url); if (offline) throw new Error('offline');
    if (url.endsWith('/models')) return { ok: true, json: async () => ({ data: [{ id: 'chat' }] }) };
    if (url.endsWith('/embeddings')) return { ok: true, json: async () => ({ data: JSON.parse(options.body).input.map((_, index) => ({ index, embedding: [1, 0] })) }) };
    return { ok: true, body: new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Summary"}}]}\n\ndata: [DONE]\n\n')); controller.close();
    } }) };
  });
  Object.assign(h.llm, api);
  h.data.backfill.enabled = false; await h.worker.tick(); assert.equal(fetches.length, 0); assert.equal(h.session.llmStatus, undefined);
  h.data.backfill.enabled = true; h.data.settings.llm.embeddingModel = 'embed'; await h.worker.tick();
  assert.deepEqual(fetches.map(url => url.split('/').at(-1)), ['models', 'completions', 'embeddings', 'embeddings']);
  assert.equal(h.gets().length, 1); assert.equal(h.session.llmStatus.ok, true); assert.equal(h.session.llmStatus.chatModel, 'chat');
  assert.equal(h.sessionWrites.filter(write => write.patch.llmStatus).length, 4);
  offline = true; await h.worker.tick(); assert.equal(fetches.length, 5); assert.equal(h.gets().length, 1); assert.equal(h.session.llmStatus.ok, false);
  offline = false; h.data.backfill.enabled = false; h.data.settings.digest.autoWeekly = true;
  await h.worker.tick(); assert.equal(h.digests.size, 1); assert.equal(fetches.length, 7); assert.equal(h.gets().length, 1);
  assert.equal(h.session.llmStatus.ok, true); assert.equal(h.sessionWrites.filter(write => write.patch.llmStatus).length, 7);
  await h.worker.tick(); assert.equal(fetches.length, 7);
});
