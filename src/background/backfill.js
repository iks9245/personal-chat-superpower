(function (root) {
  'use strict';
  const SPC = (root.SPC = root.SPC || {});
  const ALARM = 'spc-summary-backfill', LEASE_MS = 5 * 60000, HEARTBEAT_MS = 10000;
  function create({ chrome, store = SPC.store, db = SPC.db, llm = SPC.llm, now = Date.now,
    schedule = setTimeout, cancel = clearTimeout, token = () => crypto.randomUUID() } = {}) {
    let running = false;
    async function tick() {
      if (running) return;
      running = true;
      let owner, timer, heartbeatFlight, stopped = false, candidate, sitePhase = false;
      const controller = new AbortController();
      const check = () => { if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError'); };
      const save = async patch => store.updateBackfill(current => {
        const next = { ...patch, lastRunAt: now() };
        // Local digest probes/busy states must never erase the reason for a site-imposed pause.
        if (current.pausedUntil > now() && ['rateLimited', 'authRequired'].includes(current.lastStatus)) {
          delete next.lastStatus; delete next.lastRunAt;
        }
        return next;
      });
      try {
        const session = await chrome.storage.session.get('backfillLease');
        if (session.backfillLease?.until > now()) return;
        owner = token();
        await chrome.storage.session.set({ backfillLease: { owner, until: now() + LEASE_MS } });
        let lastHeartbeat = now();
        const heartbeat = async () => {
          if (stopped || now() - lastHeartbeat < HEARTBEAT_MS) return;
          lastHeartbeat = now();
          const current = await chrome.storage.session.get('backfillLease');
          if (current.backfillLease?.owner !== owner) { controller.abort(); return; }
          if (stopped) return;
          await chrome.storage.session.set({ backfillLease: { owner, until: now() + LEASE_MS }, backfillProgress: { at: now() } });
        };
        const pulse = () => {
          heartbeatFlight = heartbeat().catch(() => controller.abort()).finally(() => { if (!stopped) timer = schedule(pulse, HEARTBEAT_MS); });
        };
        timer = schedule(pulse, HEARTBEAT_MS);
        let state = SPC.backfill.rollover(await store.get('backfill'), now());
        await store.updateBackfill({ day: state.day, doneToday: state.doneToday });
        const busy = async () => (await chrome.storage.session.get('panelBusy')).panelBusy?.until > now();
        if (await busy()) { await save({ lastStatus: 'skippedBusy' }); return; }
        const probe = async () => {
          try {
            const settings = await store.get('settings', store.defaults), config = settings.llm;
            if (!config.baseUrl || !config.chatModel || !(await llm.listModels(config)).includes(config.chatModel)) throw new Error('unavailable');
            return settings;
          } catch (_) { await save({ lastStatus: 'llmUnavailable' }); return null; }
        };
        const automatic = async () => {
          const week = SPC.digest.dueWeek(now());
          if (!week || (await store.get('settings', store.defaults)).digest.autoWeekly === false || await db.digests.get(week)) return;
          const key = 'digest-attempt:' + week, attempt = await db.keyval.get(key) || {};
          if (attempt.done || attempt.count >= 3 || attempt.day === SPC.backfill.localDay(now())) return;
          const settings = await probe(); if (!settings) return;
          check();
          if (await busy() || (await store.get('settings', store.defaults)).digest.autoWeekly === false || await db.digests.get(week)) return;
          const reserved = { count: (attempt.count || 0) + 1, day: SPC.backfill.localDay(now()) };
          await db.keyval.set(key, reserved);
          try {
            await SPC.digest.generate({ week, db, store, llm, config: settings.llm, lang: settings.lang, signal: controller.signal, now });
            await db.keyval.set(key, { ...reserved, done: true });
            await store.set('digestUpdatedAt', now());
          } catch (error) {
            await db.keyval.set(key, { ...reserved, failed: true });
            if (controller.signal.aborted) throw error;
          }
        };
        const idle = async status => { if (status) await save({ lastStatus: status }); await automatic(); };
        // Local reviews may run while site work is disabled, paused, capped or has no eligible tab.
        if (state.pausedUntil > now()) { await idle(); return; }
        if (!state.enabled) { await idle('disabled'); return; }
        if (state.doneToday >= state.dailyLimit) { await idle('capReached'); return; }
        const [records, meta, folders] = await Promise.all([db.getAll(), store.get('convMeta', {}), store.get('folders', [])]);
        const tabs = new Map();
        for (const [platform, value] of Object.entries(SPC.platforms)) tabs.set(platform, await chrome.tabs.query({ url: value.origin + '/*' }));
        const open = new Set([...tabs].filter(([, list]) => list.length).map(([platform]) => platform));
        const listPlatform = [...open].find(platform => state.lastListDay[platform] !== state.day);
        candidate = SPC.backfill.candidates(records, meta, folders, state.failures, open)[0];
        if (!listPlatform && !candidate) {
          await idle(SPC.backfill.candidates(records, meta, folders, state.failures).length ? 'noTab' : 'noCandidates'); return;
        }
        const platform = listPlatform || candidate.platform || SPC.platformOfKey(candidate.key), tab = tabs.get(platform)[0];
        if (listPlatform) candidate = undefined;
        const settings = await probe(); if (!settings) return;
        const { llm: config, lang } = settings;
        check();
        // Recheck controls after the potentially slow model probe, immediately before dispatch.
        state = SPC.backfill.rollover(await store.get('backfill'), now());
        if (state.pausedUntil > now()) return;
        if (!state.enabled) { await save({ lastStatus: 'disabled' }); return; }
        if (state.doneToday >= state.dailyLimit) { await save({ lastStatus: 'capReached' }); return; }
        if (await busy()) { await save({ lastStatus: 'skippedBusy' }); return; }
        const activity = await chrome.tabs.sendMessage(tab.id, { type: 'spc:activity' });
        if (!activity?.ok || !Number.isFinite(activity.lastInteractionAt)) throw new Error('activity unavailable');
        if (activity.lastInteractionAt > 0 && now() - activity.lastInteractionAt < 60000) { await idle('skippedActive'); return; }
        // The adapter enforces the same single-fetch budget for credentials, lists and bodies.
        const current = candidate && await db.get(candidate.key), latestMeta = await store.get('convMeta', {}), latestFolders = await store.get('folders', []);
        if (!listPlatform && (!current || !SPC.backfill.candidates([current], latestMeta, latestFolders, state.failures).length)) { await save({ lastStatus: 'noCandidates' }); return; }
        if (await busy()) { await save({ lastStatus: 'skippedBusy' }); return; }
        check();
        // Reserve the daily request budget durably BEFORE dispatch, even if generation later fails or the worker dies.
        let reserved = false;
        await store.updateBackfill(current => {
          const latest = SPC.backfill.rollover(current, now()), patch = { day: latest.day, doneToday: latest.doneToday, lastRunAt: now() };
          if (latest.pausedUntil > now()) return {};
          if (!latest.enabled) return { ...patch, lastStatus: 'disabled' };
          if (latest.doneToday >= latest.dailyLimit) return { ...patch, lastStatus: 'capReached' };
          if (listPlatform && latest.lastListDay[platform] === latest.day) return {};
          reserved = true;
          return { ...patch, doneToday: latest.doneToday + 1, lastKey: candidate?.key || '', ...(listPlatform ? { lastListDay: { ...latest.lastListDay, [platform]: latest.day } } : {}) };
        });
        if (!reserved) return;
        sitePhase = true;
        const response = await chrome.tabs.sendMessage(tab.id, { type: listPlatform ? 'spc:list' : 'spc:get', payload: { ...(listPlatform ? { offset: 0, limit: 100 } : { id: candidate.id }), platform, backfill: true } });
        if (!response?.ok) { const error = new Error('site request failed'); error.status = response?.status; throw error; }
        sitePhase = false; check();
        if (listPlatform) {
          if (!Array.isArray(response.items)) throw new Error('invalid list');
          for (const item of new Map(response.items.map(item => [item.id, item])).values()) {
            if (typeof item.id !== 'string' || !item.id) throw new Error('invalid list');
            const key = `${platform}:${item.id}`, old = await db.get(key);
            await db.put(old ? { ...old, platform, title: item.title, createTime: item.createTime ?? old.createTime, updateTime: item.updateTime } :
              { key, platform, id: item.id, title: item.title, createTime: item.createTime ?? 0, updateTime: item.updateTime, messages: [], fetchedAt: 0 });
          }
          await save({ lastStatus: 'listed' }); return;
        }
        const value = response.conversation;
        if (value?.key !== candidate.key || (value.platform || SPC.platformOfKey(value.key)) !== platform || !Array.isArray(value.messages)) throw new Error('invalid conversation');
        let record = { ...current, ...value, platform, fetchedAt: now() };
        await db.put(record);
        const sourceHash = SPC.search.hash(SPC.summary.content(record));
        if (SPC.backfill.isStale(current) && current.summary.sourceHash === sourceHash) {
          await db.put({ ...record, summary: { ...current.summary, createdAt: now() } });
          await save({ lastStatus: 'refreshedUnchanged' }); return;
        }
        const text = llm.stripThinking(await llm.chat(config, { stream: true, signal: controller.signal, messages: SPC.summary.messages(record, { lang }) }));
        check(); if (!text.trim()) throw new Error('empty summary');
        // Do not resurrect a record deleted by the user during generation.
        const latest = await db.get(candidate.key); if (!latest) return;
        record = { ...latest, summary: { text, model: config.chatModel, createdAt: now(), sourceHash } };
        await db.put(record);
        if (config.embeddingModel) {
          const indexMeta = await store.get('convMeta', {}), document = SPC.search.documentText(record, indexMeta[record.key]);
          const hash = SPC.search.hash(document), existing = await db.vectors.get(record.key);
          if (existing?.model !== config.embeddingModel || existing?.hash !== hash) {
            const [vector] = await llm.embed(config, [document], { signal: controller.signal }); check();
            await db.vectors.putMany([{ key: record.key, model: config.embeddingModel, hash, vector: SPC.search.normalizeVector(vector), updatedAt: now() }]);
          }
          await SPC.rag.maintainChunks({ conversations: [record], meta: indexMeta, config, db, llm, signal: controller.signal, partial: true });
        }
        check();
        const latestState = await store.get('backfill');
        await save({ doneTotal: latestState.doneTotal + 1, lastStatus: 'done' });
      } catch (error) {
        if (!owner || controller.signal.aborted) return;
        const state = await store.get('backfill');
        if (sitePhase && [429, 401, 403].includes(error.status)) {
          await save({ pausedUntil: SPC.backfill.nextMidnight(now()), lastStatus: error.status === 429 ? 'rateLimited' : 'authRequired' });
        } else {
          const failures = { ...state.failures };
          if (candidate) failures[candidate.key] = (failures[candidate.key] || 0) + 1;
          await save({ failures, lastStatus: 'error' });
        }
      } finally {
        stopped = true; if (timer !== undefined) cancel(timer);
        await heartbeatFlight;
        try {
          if (owner && (await chrome.storage.session.get('backfillLease')).backfillLease?.owner === owner) await chrome.storage.session.remove('backfillLease');
        } finally { running = false; }
      }
    }
    function preferences(patch) {
      return store.updateBackfill(state => {
        const safe = {}, siteStop = state.pausedUntil > now() && ['rateLimited', 'authRequired'].includes(state.lastStatus);
        if (typeof patch.enabled === 'boolean') safe.enabled = patch.enabled;
        if (Number.isInteger(patch.dailyLimit) && patch.dailyLimit >= 1 && patch.dailyLimit <= 100) safe.dailyLimit = patch.dailyLimit;
        if (patch.pause === true) {
          safe.pausedUntil = SPC.backfill.nextMidnight(now());
          // A manual pause after missing credentials must remain resumable.
          if (!siteStop) { safe.lastStatus = 'disabled'; safe.lastRunAt = now(); }
        }
        // An explicit resume never bypasses a site-imposed stop within the same local day.
        if (patch.resume === true && !siteStop) safe.pausedUntil = 0;
        return safe;
      });
    }
    return { tick, preferences };
  }
  SPC.backfillWorker = { create, ALARM, LEASE_MS, HEARTBEAT_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = SPC.backfillWorker;
})(globalThis);
