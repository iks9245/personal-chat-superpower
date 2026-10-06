(function () {
  'use strict';
  const { state } = SPC.panel;
  const sections = ['general', 'llm', 'backfill', 'vault', 'diagnostics', 'data'];
  const { $, t } = SPC.panel;
  let opened = null;
  function renderSettingsSection() {
    for (const name of sections) {
      $('#settings-' + name + '-toggle').setAttribute('aria-expanded', String(opened === name));
      $('#settings-' + name + '-body').hidden = opened !== name;
    }
  }
  async function setSettingsSection(name) {
    opened = sections.includes(name) ? name : null;
    renderSettingsSection();
    await SPC.store.set('ui.settingsSection', opened);
  }
  function openSettingsSection(name) {
    SPC.panel.switchTab('settings');
    const saving = setSettingsSection(name);
    $('#settings-' + name + '-toggle').focus();
    return saving;
  }
  function renderSettingsStatus() {
    const llm = state.llmStatus, config = state.settings.llm;
    const llmKey = llm ? (llm.ok ? 'llmStatusOK' : 'llmStatusFailed') : config.chatModel ? 'llmStatusUnknown' : 'llmStatusUnset';
    const llmText = t(llmKey, { model: llm?.chatModel || config.chatModel || '—' });
    const backfill = state.backfillStatus && SPC.backfill.rollover(state.backfillStatus);
    const vars = { n: backfill?.doneToday || 0, limit: backfill?.dailyLimit || 20 };
    const vault = state.vaultLastExport, diagnostics = state.diagnosticsLast;
    const summaries = {
      general: t(SPC.i18n.getLang() === 'en' ? 'en' : 'zhTW') + ' · ' + state.settings.syncDelayMs + ' ms',
      llm: llmText,
      backfill: t(backfill?.enabled ? 'backfillSummary' : 'backfillDisabledShort', vars),
      vault: state.vaultName ? t('vaultSummary', { name: state.vaultName, date: vault ? SPC.panel.relativeDate(vault.at) : t('never') }) : t('vaultNotChosen'),
      diagnostics: diagnostics ? t('diagnosticsSummary', { result: diagnostics.failed ? t('diagnosticsFailedCount', { k: diagnostics.failed }) : t('diagnosticsPassed'), date: SPC.panel.relativeDate(diagnostics.at) }) : t('diagnosticsNever'),
      data: t('dataSummary', { conversations: state.conversations.length, bodies: state.conversations.filter(conv => conv.fetchedAt > 0).length })
    };
    for (const name of sections) {
      const node = $('#settings-' + name + '-status'); node.textContent = summaries[name]; node.title = summaries[name];
    }
    // The LLM summary starts with a status glyph; plain text inherited the grey muted colour while the header dot was
    // green, so render it as the same coloured .health-dot.
    const llmNode = $('#settings-llm-status'), glyph = llmText.match(/^[●○]\s*/);
    if (glyph) llmNode.replaceChildren(SPC.panel.el('span', glyph[0].trim(), 'health-dot'), document.createTextNode(' ' + llmText.slice(glyph[0].length)));
    const llmHealth = llm ? (llm.ok ? 'health-ok' : 'health-failed') : 'health-unknown';
    for (const name of ['health-ok', 'health-failed', 'health-unknown']) llmNode.classList.toggle(name, name === llmHealth);
    const health = $('#health-llm');
    health.replaceChildren(SPC.panel.el('span', '●', 'health-dot'), document.createTextNode(' oMLX'));
    health.querySelector('span').setAttribute('aria-hidden', 'true');
    health.className = llm ? (llm.ok ? 'health-ok' : 'health-failed') : 'health-unknown';
    health.setAttribute('aria-label', 'oMLX · ' + llmText); health.title = llmText;
    $('#health-backfill').hidden = !backfill?.enabled;
    $('#health-backfill').textContent = t('backfillQuick', vars);
  }
  async function bindSettingsStatus() {
    const [local, session] = await Promise.all([
      chrome.storage.local.get(['ui.settingsSection', 'vaultLastExport', 'diagnosticsLast']),
      chrome.storage.session.get('llmStatus')
    ]);
    opened = sections.includes(local['ui.settingsSection']) ? local['ui.settingsSection'] : null;
    state.llmStatus = session.llmStatus;
    state.vaultLastExport = local.vaultLastExport; state.diagnosticsLast = local.diagnosticsLast;
    renderSettingsSection(); renderSettingsStatus();
    chrome.storage.onChanged.addListener((changes, area) => {
      for (const key of area === 'session' ? ['llmStatus'] : area === 'local' ? ['vaultLastExport', 'diagnosticsLast'] : []) {
        if (changes[key]) state[key] = changes[key].newValue;
      }
      if (area === 'local' && changes['ui.settingsSection']) {
        const next = changes['ui.settingsSection'].newValue;
        opened = sections.includes(next) ? next : null; renderSettingsSection();
      }
      renderSettingsStatus();
    });
    for (const name of sections) $('#settings-' + name + '-toggle').addEventListener('click', SPC.panel.handle(() => setSettingsSection(opened === name ? null : name)));
    $('#health-llm').addEventListener('click', SPC.panel.handle(() => openSettingsSection('llm')));
    $('#health-backfill').addEventListener('click', SPC.panel.handle(() => openSettingsSection('backfill')));
  }
  function renderStats() {
    renderSettingsStatus();
    SPC.panel.renderLLMSettings();
    const stats = SPC.panel.$('#platform-stats'); stats.replaceChildren();
    for (const platform of Object.keys(SPC.platforms)) {
      const records = state.conversations.filter(conv => SPC.panel.platformOf(conv) === platform), lastSyncAt = state.settings.sync[platform].lastSyncAt;
      stats.append(SPC.panel.el('p', SPC.panel.t('platformStats', { platform: SPC.panel.platformLabel(platform), count: records.length,
        bodies: records.filter(conv => conv.fetchedAt > 0).length, date: lastSyncAt ? SPC.panel.formatDate(lastSyncAt, true) : SPC.panel.t('never') })));
    }
  }
  function bindSettings() {
    SPC.panel.$('#language').addEventListener('change', SPC.panel.handle(async () => { await SPC.i18n.setLang(SPC.panel.$('#language').value); await SPC.panel.refreshLocal(); }));
    SPC.panel.$('#delay-form').addEventListener('submit', SPC.panel.handle(async event => {
      event.preventDefault(); const delay = Number(SPC.panel.$('#sync-delay').value);
      if (!Number.isSafeInteger(delay) || delay < SPC.panel.MIN_SYNC_DELAY_MS) throw new Error(SPC.panel.t('invalidDelay'));
      await SPC.store.updateSettings({ syncDelayMs: delay }); await SPC.panel.refreshLocal(); SPC.panel.status('saved');
    }));
    SPC.panel.$('#backup').addEventListener('click', SPC.panel.handle(async () => SPC.panel.download(JSON.stringify(await SPC.store.exportBackup(), null, 2), 'SPC_backup', 'json')));
    SPC.panel.$('#import-backup').addEventListener('click', SPC.panel.handle(async () => {
      const file = SPC.panel.$('#backup-file').files[0]; if (!file) throw new Error(SPC.panel.t('chooseFile'));
      let data; try { data = SPC.store.validateBackup(JSON.parse(await file.text())); } catch (_) { throw new Error(SPC.panel.t('invalidBackup')); }
      const mode = SPC.panel.$('#import-mode').value;
      SPC.panel.confirmAction('importConfirm', { mode: SPC.panel.t(mode) }, async () => {
        await SPC.store.importBackup(data, mode); SPC.panel.$('#backup-file').value = ''; await SPC.panel.refreshLocal(); SPC.panel.status('importDone');
      });
    }));
    SPC.panel.$('#clear-cache').addEventListener('click', SPC.panel.handle(async () => {
      SPC.panel.confirmAction('clearConfirm', {}, async () => {
        clearTimeout(state.search.timer); state.search.generation++; state.search.controller?.abort();
        state.search.items = []; state.search.semantic = []; state.search.cursor = null; state.search.source = null; state.search.pending = false;
        await SPC.panel.writeCache(() => SPC.db.clear()); await SPC.store.updateSettings({ sync: SPC.store.defaults.sync }); state.selected.clear(); await SPC.panel.refreshCache(); await SPC.panel.refreshLocal(); SPC.panel.status('cacheCleared');
      });
    }));
  }
  Object.assign(SPC.panel, {
    renderStats, bindSettings, bindSettingsStatus, renderSettingsStatus, openSettingsSection
  });
})();
