(function () {
  'use strict';
  const { state, $, t, el } = SPC.panel;
  // This registry is also the report allowlist. Never copy site-provided names, fixes or errors.
  const definitions = {
    'extension.version': ['diagnosticVersion', 'manifest.json'],
    'extension.chatgpt': ['diagnosticChatGPT', 'manifest.json'],
    'extension.claude': ['diagnosticClaude', 'manifest.json'],
    'site.unsupported': ['diagnosticUnsupported', ''],
    'site.contentScript': ['diagnosticContentScript', 'reloadTab'],
    'llm.models': ['diagnosticModels', 'src/shared/llm.js → listModels'],
    'llm.chatModel': ['diagnosticChatModel', 'src/sidepanel/local-llm.js → bindLLMSettings'],
    'llm.embeddingModel': ['diagnosticEmbeddingModel', 'src/sidepanel/local-llm.js → bindLLMSettings'],
    'data.chatgpt': ['diagnosticChatGPTRecords', 'src/shared/db.js → getAll'],
    'data.claude': ['diagnosticClaudeRecords', 'src/shared/db.js → getAll'],
    'data.bodies': ['diagnosticBodies', 'src/shared/db.js → getAll'],
    'data.vectors': ['diagnosticVectors', 'src/shared/db.js → vectors.getAll'],
    'data.chunks': ['diagnosticChunks', 'src/shared/db.js → chunks.getAll'],
    'data.prompts': ['diagnosticPrompts', 'src/shared/storage.js → get'],
    'data.backfill': ['diagnosticBackfill', 'src/sidepanel/backfill.js'],
    'data.folders': ['diagnosticFolders', 'src/shared/storage.js → get'],
    'run.cancelled': ['diagnosticCancelled', '']
  };
  for (const platform of ['chatgpt', 'claude']) {
    const functions = { [platform === 'chatgpt' ? 'session' : 'organization']: platform === 'chatgpt' ? 'getAccessToken' : 'getOrganization',
      list: 'listConversations', search: 'searchConversations', conversation: 'getConversation', composer: 'composerSelectors' };
    for (const [id, fn] of Object.entries(functions)) definitions[`${platform}.${id}`] = ['diagnosticCheck_' + id, `src/content/adapters/${platform}.js → ${fn}`];
  }
  const categories = new Set(['authRequired', 'requestFailed', 'invalidResponse', 'networkError', 'checkFailed', 'composerMissing',
    'dependency', 'notConfigured', 'modelMissing', 'databaseError', 'contentScriptMissing', 'cancelled']);
  const number = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const version = value => typeof value === 'string' && /^\d+(?:\.\d+){0,3}$/.test(value) ? value : '0';
  const icon = ok => ok === true ? '✅' : ok === false ? '❌' : '⏭';
  let results = [], runVersion = '0', runTime = null;
  function safeRow(row) {
    if (!Object.hasOwn(definitions, row.id)) return null;
    const safe = { id: row.id, ok: row.ok === true ? true : row.ok === false ? false : null, ms: number(row.ms) ?? 0 };
    if (number(row.status) >= 100 && row.status <= 599) safe.status = row.status;
    if (categories.has(row.category)) safe.category = row.category;
    else if (safe.ok === false) safe.category = 'checkFailed';
    if (number(row.count) !== undefined) safe.count = row.count;
    if (row.id === 'data.backfill') {
      safe.enabled = row.enabled === true; safe.today = number(row.today) ?? 0; safe.remaining = number(row.remaining) ?? 0;
    }
    if (row.id === 'extension.version') safe.version = version(row.version);
    return safe;
  }
  function add(row) { const safe = safeRow(row); if (safe) results.push(safe); renderDiagnostics(); }
  function renderDiagnostics() {
    const list = $('#diagnostic-results'); list.replaceChildren();
    for (const row of results) {
      const [label, fix] = definitions[row.id], node = el('li', null, 'card');
      const platform = row.id.startsWith('chatgpt.') ? 'ChatGPT · ' : row.id.startsWith('claude.') ? 'Claude · ' : '';
      node.append(el('div', `${icon(row.ok)} ${platform}${t(label)} · ${row.ms}ms${row.status ? ' · HTTP ' + row.status : ''}${row.version ? ' · ' + row.version : ''}${row.count !== undefined ? ' · ' + t('diagnosticCount', { count: row.count }) : ''}`));
      if (row.id === 'data.backfill') node.append(el('div', t('diagnosticBackfillCounts', { ...row, enabled: Number(row.enabled) }), 'muted'));
      if (row.category) node.append(el('div', t('diagnosticError_' + row.category), 'muted'));
      if (row.ok === false && fix) node.append(el('div', t('diagnosticFix', { fix: fix === 'reloadTab' ? t('diagnosticReload') : fix }), 'muted'));
      list.append(node);
    }
    $('#diagnostic-copy').disabled = !results.length || Boolean(state.diagnosing);
  }
  function diagnosticReport() {
    const chromeMajor = /(?:Chrome|Chromium)\/(\d+)/.exec(globalThis.navigator?.userAgent || '')?.[1] || '0';
    const date = runTime || new Date(), pad = n => String(n).padStart(2, '0');
    const timestamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const lines = [`Personal Chat Superpower ${runVersion} · Chrome ${chromeMajor} · ${timestamp}`];
    for (const value of results) {
      const row = safeRow(value); if (!row) continue;
      const fix = definitions[row.id][1];
      lines.push(`${icon(row.ok)} ${row.id} ${row.ok === true ? 'ok' : row.ok === false ? 'fail' : 'skip'}${row.status ? ' ' + row.status : ''}${row.category ? ' (' + row.category + ')' : ''} ${row.ms}ms${row.count !== undefined ? ' count=' + row.count : ''}${row.version ? ' version=' + row.version : ''}${row.id === 'data.backfill' ? ' enabled=' + Number(row.enabled) + ' today=' + row.today + ' remaining=' + row.remaining : ''}${row.ok === false && fix ? ' → ' + fix : ''}`);
    }
    return lines.join('\n');
  }
  async function copyDiagnosticReport() {
    const report = diagnosticReport();
    try { await navigator.clipboard.writeText(report); SPC.panel.status('diagnosticCopied'); }
    catch (_) {
      SPC.panel.openEditor('diagnosticReport', [{ name: 'report', key: 'diagnosticReport', type: 'textarea', value: report }], async () => {}, 'diagnosticClose', { key: 'diagnosticCopyHint' });
      const textarea = $('#editor-fields').querySelector('textarea'); textarea.readOnly = true; textarea.focus(); textarea.select();
    }
  }
  async function runDiagnostics() {
    if (state.operationController) return;
    state.diagnosing = true; results = []; runTime = new Date();
    SPC.panel.stopQASearch(); renderDiagnostics();
    try { await SPC.panel.localOperation(async signal => {
      const config = { ...state.settings.llm };
      const checkCancelled = () => SPC.panel.checkCancelled(signal);
      async function check(id, action, skip = false) {
        checkCancelled(); const started = Date.now();
        if (skip) { add({ id, ok: null, ms: 0, category: 'notConfigured' }); return; }
        try { const details = await action(); checkCancelled(); add({ id, ok: true, ms: Date.now() - started, ...details }); return details; }
        catch (error) {
          checkCancelled();
          add({ id, ok: false, ms: Date.now() - started, status: error.status, category: id.startsWith('data.') ? 'databaseError' :
            error.status ? ([401, 403].includes(error.status) ? 'authRequired' : 'requestFailed') : error.message === t('llmInvalid') ? 'invalidResponse' : 'networkError' });
        }
      }
      try {
        const manifest = chrome.runtime.getManifest(); runVersion = version(manifest.version);
        add({ id: 'extension.version', ok: true, ms: 0, version: runVersion });
        for (const platform of ['chatgpt', 'claude']) {
          const enabled = manifest.content_scripts?.some(script => script.matches?.includes(SPC.platforms[platform].origin + '/*'));
          add({ id: 'extension.' + platform, ok: Boolean(enabled), ms: 0 });
        }
        // Drain previous work before the first diagnostic request; suppress automatic search during the run.
        await SPC.panel.siteRequestsIdle(); checkCancelled();
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); checkCancelled();
        const platform = SPC.panel.tabPlatform(tab);
        if (!platform) add({ id: 'site.unsupported', ok: null, ms: 0 });
        else {
          await SPC.panel.wait(1000, signal);
          const started = Date.now();
          const cancel = () => { chrome.tabs.sendMessage(tab.id, { type: 'spc:cancelDiagnose' }).catch(() => {}); };
          signal.addEventListener('abort', cancel, { once: true });
          try {
            // Keep the operation lock until the content script has stopped; never retry this message.
            const response = await chrome.tabs.sendMessage(tab.id, { type: 'spc:diagnose' });
            checkCancelled();
            const ids = [platform === 'chatgpt' ? 'session' : 'organization', 'list', 'search', 'conversation', 'composer'];
            if (!response?.ok || response.platform !== platform || !Array.isArray(response.checks) ||
                response.checks.length !== ids.length || response.checks.some((row, index) => !row || row.id !== ids[index] || ![true, false, null].includes(row.ok))) {
              add({ id: 'site.contentScript', ok: false, ms: Date.now() - started, category: 'invalidResponse' });
            } else for (const row of response.checks) add({ ...row, id: platform + '.' + row.id });
          } catch (_) {
            checkCancelled(); add({ id: 'site.contentScript', ok: false, ms: Date.now() - started, category: 'contentScriptMissing' });
          } finally { signal.removeEventListener('abort', cancel); }
        }
        let models;
        await check('llm.models', async () => { models = await SPC.llm.listModels(config); return { count: models.length }; }, !config.baseUrl);
        for (const field of ['chatModel', 'embeddingModel']) {
          checkCancelled();
          add({ id: 'llm.' + field, ok: models ? models.includes(config[field]) : null, ms: 0,
            category: !config.baseUrl ? 'notConfigured' : !models ? 'dependency' : models.includes(config[field]) ? undefined : 'modelMissing' });
        }
        let records;
        await check('data.chatgpt', async () => { records = await SPC.db.getAll(); return { count: records.filter(row => SPC.panel.platformOf(row) === 'chatgpt').length }; });
        checkCancelled();
        for (const [id, predicate] of [['data.claude', row => SPC.panel.platformOf(row) === 'claude'], ['data.bodies', row => row.fetchedAt > 0]]) {
          add({ id, ok: records ? true : null, ms: 0, ...(records ? { count: records.filter(predicate).length } : { category: 'dependency' }) });
        }
        for (const name of ['vectors', 'chunks']) await check('data.' + name, async () => ({ count: (await SPC.db[name].getAll()).filter(row => row.model === config.embeddingModel).length }), !config.embeddingModel);
        await check('data.backfill', async () => {
          const [backfill, meta, folders] = await Promise.all([SPC.store.get('backfill'), SPC.store.get('convMeta', {}), SPC.store.get('folders', [])]);
          return { enabled: backfill.enabled, today: SPC.backfill.rollover(backfill).doneToday, remaining: SPC.backfill.stats(records || [], meta, folders).remaining };
        }, !records);
        for (const name of ['prompts', 'folders']) await check('data.' + name, async () => ({ count: (await SPC.store.get(name, [])).length }));
      } catch (error) {
        if (signal.aborted) add({ id: 'run.cancelled', ok: null, ms: 0, category: 'cancelled' });
        throw error;
      }
    }); } finally {
      state.diagnosing = false; renderDiagnostics(); SPC.panel.renderAvailability();
      if (results.length) {
        state.diagnosticsLast = { failed: results.filter(row => row.ok === false).length, total: results.length, at: Date.now() };
        await SPC.store.set('diagnosticsLast', state.diagnosticsLast); SPC.panel.renderSettingsStatus();
      }
    }
  }
  function bindDiagnostics() {
    $('#diagnostic-run').addEventListener('click', SPC.panel.handle(runDiagnostics));
    $('#diagnostic-copy').addEventListener('click', SPC.panel.handle(copyDiagnosticReport));
  }
  Object.assign(SPC.panel, { bindDiagnostics, renderDiagnostics, runDiagnostics, diagnosticReport, copyDiagnosticReport });
})();
