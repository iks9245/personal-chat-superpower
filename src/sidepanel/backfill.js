(function () {
  'use strict';
  const { state, $, t } = SPC.panel;
  let value, generation = 0;
  function renderBackfill() {
    if (!value) return;
    state.backfillStatus = value; SPC.panel.renderSettingsStatus();
    const current = SPC.backfill.rollover(value), counts = SPC.backfill.stats(state.conversations, state.meta, state.folders);
    $('#backfill-enabled').checked = current.enabled;
    if (document.activeElement !== $('#backfill-limit')) $('#backfill-limit').value = current.dailyLimit;
    $('#backfill-stats').textContent = t('backfillStats', { ...counts, today: current.doneToday, limit: current.dailyLimit, days: Math.ceil((counts.remaining + counts.stale) / current.dailyLimit) });
    $('#backfill-last').textContent = t('backfillLast', { status: t('backfillStatus_' + current.lastStatus), time: SPC.panel.formatDate(current.lastRunAt, true) });
    const paused = current.pausedUntil > Date.now(), siteStop = paused && ['rateLimited', 'authRequired'].includes(current.lastStatus);
    $('#backfill-paused').textContent = paused ? t(siteStop ? 'backfillSitePaused' : 'backfillPaused', { time: SPC.panel.formatDate(current.pausedUntil, true) }) : '';
    $('#backfill-resume').disabled = !paused || siteStop;
  }
  async function refreshBackfill() {
    const request = ++generation, next = await SPC.store.get('backfill');
    if (request !== generation) return;
    value = next; renderBackfill();
  }
  async function changeBackfill(patch) {
    const response = await chrome.runtime.sendMessage({ type: 'spc:backfill-settings', payload: patch });
    if (!response?.ok) throw new Error(t('backfillSaveError'));
    await refreshBackfill();
  }
  async function bindBackfill() {
    $('#backfill-enabled').addEventListener('change', SPC.panel.handle(() => changeBackfill({ enabled: $('#backfill-enabled').checked })));
    $('#backfill-limit').addEventListener('change', SPC.panel.handle(async () => {
      const limit = Number($('#backfill-limit').value);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error(t('backfillInvalidLimit'));
      await changeBackfill({ dailyLimit: limit });
    }));
    $('#backfill-pause').addEventListener('click', SPC.panel.handle(() => changeBackfill({ pause: true })));
    $('#backfill-resume').addEventListener('click', SPC.panel.handle(() => changeBackfill({ resume: true })));
    SPC.store.onChange('backfill', () => { Promise.all([refreshBackfill(), SPC.panel.refreshCache()]).catch(SPC.panel.report); });
    await refreshBackfill();
  }
  Object.assign(SPC.panel, { renderBackfill, refreshBackfill, bindBackfill });
})();
