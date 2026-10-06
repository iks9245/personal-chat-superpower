(function () {
  'use strict';
  const { state, $, t } = SPC.panel;
  let saved = [], selected = null, draft = null;
  function renderDigests() {
    const busy = Boolean(state.operationController), list = $('#digest-list'); list.replaceChildren();
    $('#digest-auto').checked = state.settings.digest.autoWeekly;
    for (const entry of saved) {
      const button = SPC.panel.button('digestTitle', () => { if (!state.operationController) { selected = entry; renderDigests(); } }, 'digest-row');
      button.textContent = '';
      button.setAttribute('aria-pressed', String(selected?.week === entry.week));
      const label = SPC.panel.el('span', entry.week, 'digest-week');
      if (entry.partial) label.append(SPC.panel.el('span', t('digestCurrent'), 'chip'));
      button.append(label, SPC.panel.el('span', SPC.panel.formatDate(entry.start) + ' – ' + SPC.panel.formatDate(entry.end - 1), 'muted'));
      button.disabled = busy; list.append(button);
    }
    $('#digest-empty').hidden = Boolean(saved.length || draft);
    $('#digest-actions').hidden = !selected;
    for (const id of ['digest-regenerate', 'digest-delete']) $('#' + id).hidden = !selected;
    for (const id of ['digest-last', 'digest-current', 'digest-auto']) $('#' + id).disabled = busy;
    for (const id of ['digest-regenerate', 'digest-delete']) $('#' + id).disabled = busy || !selected;
    const view = draft || selected;
    $('#digest-info').textContent = view ? [view.week, view.partial ? t('digestPartial') : '', view.model].filter(Boolean).join(' · ') : '';
    const answer = $('#digest-answer'); answer.replaceChildren();
    if (draft && !draft.text) answer.textContent = t('llmThinking');
    else if (view) {
      answer.append(SPC.markdown.render(view.text));
      SPC.rag.citationButtons(answer, view.sources.length, index => { SPC.panel.openQASource(view.sources[index]).catch(SPC.panel.report); });
    }
  }
  async function refreshDigests() {
    saved = (await SPC.db.digests.getAll()).sort((a, b) => b.week.localeCompare(a.week));
    if (selected) selected = saved.find(entry => entry.week === selected.week) || null;
    renderDigests();
  }
  async function generateDigest(week, partial = false) {
    if (state.operationController) return;
    const config = SPC.panel.requireChat(); SPC.panel.stopQASearch();
    await SPC.panel.localOperation(async signal => {
      if ((await chrome.storage.session.get('backfillLease')).backfillLease?.until > Date.now()) throw new Error(t('digestBackgroundBusy'));
      draft = { week, partial, text: '', model: config.chatModel, sources: [] }; renderDigests(); SPC.panel.setProgress('digestGenerating');
      let frame = null;
      try {
        selected = await SPC.digest.generate({ week, partial, config, db: SPC.db, store: SPC.store, llm: SPC.llm, signal, onText: text => {
          if (signal.aborted) return; draft.text = text;
          if (frame !== null) return;
          frame = requestAnimationFrame(() => { frame = null; if (!signal.aborted && draft) renderDigests(); });
        } });
        await SPC.store.set('digestUpdatedAt', Date.now()); SPC.panel.status('digestDone');
      } finally { if (frame !== null) cancelAnimationFrame(frame); draft = null; await refreshDigests(); }
    });
  }
  async function deleteDigest() {
    if (state.operationController || !selected) return;
    const week = selected.week;
    await SPC.panel.localOperation(async () => {
      if ((await chrome.storage.session.get('backfillLease')).backfillLease?.until > Date.now()) throw new Error(t('digestBackgroundBusy'));
      // A deleted review stays deleted until the user explicitly generates it again.
      await SPC.db.keyval.set('digest-attempt:' + week, { done: true });
      await SPC.db.digests.delete(week); selected = null; await SPC.store.set('digestUpdatedAt', Date.now()); await refreshDigests();
    });
  }
  async function bindDigests() {
    $('#digest-last').addEventListener('click', SPC.panel.handle(() => generateDigest(SPC.digest.previousWeek(SPC.digest.weekOf()))));
    $('#digest-current').addEventListener('click', SPC.panel.handle(() => generateDigest(SPC.digest.weekOf(), true)));
    $('#digest-regenerate').addEventListener('click', SPC.panel.handle(() => selected && generateDigest(selected.week, selected.partial && selected.week === SPC.digest.weekOf())));
    $('#digest-delete').addEventListener('click', SPC.panel.handle(deleteDigest));
    $('#digest-auto').addEventListener('change', SPC.panel.handle(async () => {
      await SPC.store.updateSettings({ digest: { autoWeekly: $('#digest-auto').checked } }); await SPC.panel.refreshLocal();
    }));
    SPC.store.onChange('digestUpdatedAt', () => { refreshDigests().catch(SPC.panel.report); });
    await refreshDigests();
  }
  Object.assign(SPC.panel, { bindDigests, renderDigests, refreshDigests, generateDigest, deleteDigest });
})();
