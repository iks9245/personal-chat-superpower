(function (root) {
  'use strict';
  const SPC = (root.SPC = root.SPC || {});
  const llmDefaults = { baseUrl: 'http://127.0.0.1:11123/v1', apiKey: '', chatModel: '', embeddingModel: '', disableThinking: true };
  function normalizeBaseUrl(value) {
    const fail = () => { throw new Error(SPC.i18n?.t('llmLocalOnly') || '本地 LLM URL 只允許 http/https 的 127.0.0.1、localhost 或 [::1]'); };
    if (typeof value !== 'string') return fail();
    const text = value.trim(), match = text.match(/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/[^?#\\]*)?$/i);
    if (!match) return fail();
    let url; try { url = new URL(text); } catch (_) { return fail(); }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) return fail();
    return url.href.replace(/\/+$/, '');
  }
  function normalizeLLM(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(SPC.i18n?.t('invalidMessage') || 'Invalid LLM settings');
    const result = {};
    for (const key of ['baseUrl', 'apiKey', 'chatModel', 'embeddingModel']) {
      if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error(SPC.i18n?.t('invalidMessage') || 'Invalid LLM settings');
      result[key] = (value[key] ?? llmDefaults[key]).trim();
    }
    result.baseUrl = normalizeBaseUrl(result.baseUrl);
    if (value.disableThinking !== undefined && typeof value.disableThinking !== 'boolean') throw new Error(SPC.i18n?.t('invalidMessage') || 'Invalid LLM settings');
    result.disableThinking = value.disableThinking ?? true; return result;
  }
  const defaults = { digest: { autoWeekly: true }, llm: llmDefaults, lang: 'zh-TW', syncDelayMs: 1500, sync: {
    chatgpt: { lastSyncAt: 0, titlesComplete: false }, claude: { lastSyncAt: 0, titlesComplete: false }
  } };
  function normalizeSettings(settings = {}) {
    const { lastSyncAt, titlesComplete, ...value } = settings;
    const sync = {};
    for (const platform of ['chatgpt', 'claude']) sync[platform] = { ...defaults.sync[platform],
      ...(platform === 'chatgpt' ? { lastSyncAt: lastSyncAt ?? 0, titlesComplete: titlesComplete === true } : {}), ...settings.sync?.[platform] };
    return { ...defaults, ...value, sync, digest: { autoWeekly: settings.digest?.autoWeekly !== false }, llm: normalizeLLM(settings.llm) };
  }
  const backfillStatuses = ['listed', 'refreshedUnchanged', 'done', 'skippedActive', 'skippedBusy', 'noTab', 'noCandidates', 'llmUnavailable', 'rateLimited', 'authRequired', 'error', 'capReached', 'disabled'];
  function normalizeBackfill(input = {}) {
    const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const count = n => Number.isSafeInteger(n) && n >= 0 ? n : 0;
    const failures = {};
    for (const [key, n] of Object.entries(value.failures && typeof value.failures === 'object' ? value.failures : {})) {
      if (/^[a-z][\w-]*:.+$/.test(key) && count(n)) failures[key] = count(n);
    }
    return { enabled: value.enabled === true, dailyLimit: Number.isInteger(value.dailyLimit) && value.dailyLimit >= 1 && value.dailyLimit <= 100 ? value.dailyLimit : 20,
      day: typeof value.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.day) ? value.day : '',
      doneToday: count(value.doneToday), doneTotal: count(value.doneTotal), pausedUntil: count(value.pausedUntil), lastRunAt: count(value.lastRunAt),
      lastStatus: backfillStatuses.includes(value.lastStatus) ? value.lastStatus : 'disabled',
      lastListDay: Object.fromEntries(['chatgpt', 'claude'].filter(platform => /^\d{4}-\d{2}-\d{2}$/.test(value.lastListDay?.[platform])).map(platform => [platform, value.lastListDay[platform]])),
      lastKey: typeof value.lastKey === 'string' ? value.lastKey : '', failures };
  }
  function updateBackfill(patch) {
    return serialized(async () => {
      const current = await get('backfill');
      const value = normalizeBackfill({ ...current, ...(typeof patch === 'function' ? patch(current) : patch) });
      await set('backfill', value); return value;
    });
  }
  function backfillPreferences(value) { const { enabled, dailyLimit } = normalizeBackfill(value); return { enabled, dailyLimit }; }
  const keys = ['settings', 'prompts', 'folders', 'convMeta'];
  let queue = Promise.resolve();
  function serialized(task) {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  }
  async function get(key, fallback) {
    const data = await chrome.storage.local.get(key);
    const value = data[key] === undefined ? fallback : data[key];
    return key === 'settings' ? normalizeSettings(value) : key === 'backfill' ? normalizeBackfill(value) : value;
  }
  async function set(key, value) { await chrome.storage.local.set({ [key]: key === 'backfill' ? normalizeBackfill(value) : value }); }
  function saveQA(entry, replaceCreatedAt) {
    return serialized(async () => {
      const history = await get('qaHistory', []);
      const createdAt = replaceCreatedAt ?? Math.max(Date.now(), ...history.map(item => item.createdAt + 1));
      const value = { question: entry.question, answer: entry.answer, sources: entry.sources.map(({ key, title, platform }) => ({ key, title, platform })), model: entry.model, createdAt };
      const next = [value, ...history.filter(item => item.createdAt !== createdAt)].slice(0, 20);
      await set('qaHistory', next); return next;
    });
  }
  function clearQA() { return serialized(() => set('qaHistory', [])); }
  function onChange(key, callback) {
    const listener = (changes, area) => {
      if (area === 'local' && Object.prototype.hasOwnProperty.call(changes, key)) callback(changes[key].newValue, changes[key].oldValue);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }
  function updateSettings(patch) {
    return serialized(async () => {
      const old = await get('settings', defaults);
      const value = normalizeSettings({ ...old, ...patch, sync: { ...old.sync, ...patch.sync }, llm: { ...old.llm, ...patch.llm } });
      await set('settings', value);
      return value;
    });
  }
  function savePrompt(input) {
    return serialized(async () => {
      const prompts = await get('prompts', []), now = Date.now();
      const old = prompts.find(item => item.id === input.id);
      const value = { id: old?.id || crypto.randomUUID(), title: input.title.trim(), content: input.content,
        tags: cleanTags(input.tags), createdAt: old?.createdAt ?? now, updatedAt: now, useCount: old?.useCount || 0 };
      await set('prompts', old ? prompts.map(item => item.id === old.id ? value : item) : [...prompts, value]);
      return value;
    });
  }
  function deletePrompt(id) {
    return serialized(async () => set('prompts', (await get('prompts', [])).filter(item => item.id !== id)));
  }
  function incrementPromptUse(id) {
    return serialized(async () => {
      const prompts = await get('prompts', []);
      await set('prompts', prompts.map(item => item.id === id ? { ...item, useCount: item.useCount + 1 } : item));
    });
  }
  function saveFolder(input) {
    return serialized(async () => {
      const folders = await get('folders', []), old = folders.find(item => item.id === input.id);
      const value = { id: old?.id || crypto.randomUUID(), name: input.name.trim(), color: input.color,
        order: old?.order ?? Math.max(-1, ...folders.map(item => item.order)) + 1 };
      await set('folders', old ? folders.map(item => item.id === old.id ? value : item) : [...folders, value]);
      return value;
    });
  }
  function deleteFolder(id) {
    return serialized(async () => {
      const folders = (await get('folders', [])).filter(item => item.id !== id);
      const convMeta = await get('convMeta', {});
      for (const key of Object.keys(convMeta)) if (convMeta[key].folderId === id) convMeta[key] = { ...convMeta[key], folderId: null };
      await chrome.storage.local.set({ folders, convMeta });
    });
  }
  const metaDefaults = { folderId: null, tags: [], pinned: false, customTitle: null, originalTitle: null };
  const validMetaTitle = value => value === null || (typeof value === 'string' && value.length <= 200);
  function updateConvMeta(conversationKeys, patch) {
    return serialized(async () => {
      for (const field of ['customTitle', 'originalTitle']) if (patch[field] !== undefined && !validMetaTitle(patch[field])) throw new Error(SPC.i18n.t('invalidMessage'));
      const convMeta = await get('convMeta', {});
      for (const key of Array.isArray(conversationKeys) ? conversationKeys : [conversationKeys]) {
        if (!/^[a-z][\w-]*:.+$/.test(key)) throw new Error(SPC.i18n.t('invalidMessage'));
        convMeta[key] = { ...metaDefaults, tags: [], ...convMeta[key], ...patch };
      }
      await set('convMeta', convMeta);
    });
  }
  function deleteConvMeta(key) {
    return serialized(async () => { const meta = await get('convMeta', {}); delete meta[key]; await set('convMeta', meta); });
  }
  function cleanTags(tags) { return [...new Set((Array.isArray(tags) ? tags : []).map(tag => String(tag).trim()).filter(Boolean))]; }
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const isText = value => typeof value === 'string';
  const isNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const validTags = value => Array.isArray(value) && value.every(isText);
  // Copy only the documented fields: no imported prototypes or arbitrary settings are retained.
  function validateBackup(data) {
    const fail = () => { throw new Error(SPC.i18n ? SPC.i18n.t('invalidBackup') : 'Invalid backup'); };
    if (!isRecord(data) || !keys.every(key => Object.prototype.hasOwnProperty.call(data, key))) return fail();
    const s = data.settings;
    if (!isRecord(s) || !['zh-TW', 'en'].includes(s.lang) || !Number.isSafeInteger(s.syncDelayMs) || s.syncDelayMs < 0 ||
        (s.lastSyncAt !== undefined && !isNumber(s.lastSyncAt)) ||
        (s.titlesComplete !== undefined && typeof s.titlesComplete !== 'boolean')) return fail();
    const settings = { lang: s.lang, syncDelayMs: s.syncDelayMs };
    if (s.lastSyncAt !== undefined) settings.lastSyncAt = s.lastSyncAt;
    if (s.titlesComplete !== undefined) settings.titlesComplete = s.titlesComplete;
    if (s.sync !== undefined) {
      if (!isRecord(s.sync)) return fail();
      settings.sync = {};
      for (const platform of ['chatgpt', 'claude']) {
        if (!Object.prototype.hasOwnProperty.call(s.sync, platform)) continue;
        const value = s.sync[platform];
        if (!isRecord(value) || !isNumber(value.lastSyncAt) || typeof value.titlesComplete !== 'boolean') return fail();
        settings.sync[platform] = { lastSyncAt: value.lastSyncAt, titlesComplete: value.titlesComplete };
      }
    }
    if (s.digest !== undefined) {
      if (!isRecord(s.digest) || typeof s.digest.autoWeekly !== 'boolean') return fail();
      settings.digest = { autoWeekly: s.digest.autoWeekly };
    }
    if (s.llm !== undefined) {
      try { settings.llm = normalizeLLM(s.llm); delete settings.llm.apiKey; } catch (_) { return fail(); }
    }
    const ids = new Set();
    if (!Array.isArray(data.prompts) || !Array.isArray(data.folders) || !isRecord(data.convMeta)) return fail();
    const prompts = data.prompts.map(p => {
      if (!isRecord(p) || !isText(p.id) || !p.id || ids.has(p.id) || !isText(p.title) || !p.title.trim() || !isText(p.content) ||
          !validTags(p.tags) || !isNumber(p.createdAt) || !isNumber(p.updatedAt) || !Number.isInteger(p.useCount) || p.useCount < 0) return fail();
      ids.add(p.id);
      return { id: p.id, title: p.title, content: p.content, tags: cleanTags(p.tags), createdAt: p.createdAt, updatedAt: p.updatedAt, useCount: p.useCount };
    });
    ids.clear();
    const folders = data.folders.map(f => {
      if (!isRecord(f) || !isText(f.id) || !f.id || ids.has(f.id) || !isText(f.name) || !f.name.trim() || !/^#[0-9a-f]{6}$/i.test(f.color) || !isNumber(f.order)) return fail();
      ids.add(f.id);
      return { id: f.id, name: f.name, color: f.color, order: f.order };
    });
    const convMeta = {};
    for (const [key, m] of Object.entries(data.convMeta)) {
      if (!/^[a-z][\w-]*:.+$/.test(key) || !isRecord(m) || !(m.folderId === null || ids.has(m.folderId)) || !validTags(m.tags) || typeof m.pinned !== 'boolean') return fail();
      convMeta[key] = { folderId: m.folderId, tags: cleanTags(m.tags), pinned: m.pinned };
      for (const field of ['customTitle', 'originalTitle']) if (m[field] !== undefined) {
        if (!validMetaTitle(m[field])) return fail();
        convMeta[key][field] = m[field];
      }
    }
    const result = { settings, prompts, folders, convMeta };
    if (data.backfill !== undefined) {
      if (!isRecord(data.backfill) || typeof data.backfill.enabled !== 'boolean' || !Number.isInteger(data.backfill.dailyLimit) || data.backfill.dailyLimit < 1 || data.backfill.dailyLimit > 100) return fail();
      result.backfill = backfillPreferences(data.backfill);
    }
    return result;
  }
  function mergeBackups(existing, incoming) {
    const merge = (a, b) => [...new Map([...a, ...b].map(item => [item.id, item])).values()];
    const settings = { ...existing.settings, ...incoming.settings };
    if (existing.settings.sync || incoming.settings.sync) settings.sync = { ...normalizeSettings(existing.settings).sync,
      ...(incoming.settings.lastSyncAt !== undefined || incoming.settings.titlesComplete !== undefined ? { chatgpt: normalizeSettings(incoming.settings).sync.chatgpt } : {}), ...incoming.settings.sync };
    const convMeta = { ...existing.convMeta };
    for (const [key, meta] of Object.entries(incoming.convMeta)) convMeta[key] = { ...convMeta[key], ...meta };
    return { settings, prompts: merge(existing.prompts, incoming.prompts),
      folders: merge(existing.folders, incoming.folders), convMeta, ...(incoming.backfill || existing.backfill ? { backfill: incoming.backfill || existing.backfill } : {}) };
  }
  async function exportBackup() {
    const data = await chrome.storage.local.get([...keys, 'backfill']);
    const settings = normalizeSettings(data.settings); delete settings.llm.apiKey;
    return { settings, prompts: data.prompts || [], folders: data.folders || [], convMeta: data.convMeta || {}, backfill: backfillPreferences(data.backfill) };
  }
  function importBackup(data, mode) {
    const incoming = validateBackup(data);
    if (!['merge', 'overwrite'].includes(mode)) throw new Error(SPC.i18n.t('invalidBackup'));
    return serialized(async () => {
      const existing = await get('settings', defaults), result = mode === 'merge' ? mergeBackups(await exportBackup(), incoming) : incoming;
      result.settings = normalizeSettings({ ...result.settings, llm: { ...(mode === 'merge' ? existing.llm : llmDefaults), ...incoming.settings.llm, apiKey: existing.llm.apiKey } });
      // Restoring preferences must not erase today's safety cap or a site-imposed pause.
      result.backfill = normalizeBackfill({ ...await get('backfill'), ...(result.backfill || { enabled: false, dailyLimit: 20 }) });
      await chrome.storage.local.set(result);
    });
  }
  SPC.store = { normalizeBackfill, updateBackfill, backfillPreferences, defaults, metaDefaults, normalizeBaseUrl, normalizeLLM, normalizeSettings, get, set, saveQA, clearQA, onChange, updateSettings, savePrompt, deletePrompt, incrementPromptUse,
    saveFolder, deleteFolder, updateConvMeta, deleteConvMeta, cleanTags, validateBackup, mergeBackups, exportBackup, importBackup };
  if (typeof module !== 'undefined' && module.exports) module.exports = SPC.store;
})(globalThis);
