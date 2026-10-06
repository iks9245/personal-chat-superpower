(function () {
  'use strict';
  let diagnosticController = null, lastInteractionAt = 0;
  for (const type of ['keydown', 'pointerdown', 'input']) document.addEventListener(type, () => { lastInteractionAt = Date.now(); }, { passive: true, capture: true });
  const ready = SPC.i18n.init();
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !['spc:activity', 'spc:ping', 'spc:list', 'spc:search', 'spc:get', 'spc:rename', 'spc:insert', 'spc:diagnose', 'spc:cancelDiagnose'].includes(message?.type)) return false;
    (async () => {
      await ready;
      const payload = message.payload || {};
      if (payload.backfill === true && payload.platform !== SPC.adapter.platform) throw new Error(SPC.i18n.t('invalidMessage'));
      let requests = 0;
      const budget = payload.backfill === true ? { backfill: true, beforeRequest: async () => {
        if (++requests > 1) throw new Error(SPC.i18n.t('backfillRequestLimit'));
      } } : undefined;
      switch (message.type) {
        case 'spc:cancelDiagnose': diagnosticController?.abort(); return { ok: true };
        case 'spc:diagnose': {
          if (diagnosticController) throw new Error(SPC.i18n.t('busy'));
          diagnosticController = new AbortController();
          try {
            const checks = await SPC.adapter.diagnose({ signal: diagnosticController.signal });
            return { ok: true, platform: SPC.adapter.platform, version: chrome.runtime.getManifest().version, checks };
          } finally { diagnosticController = null; }
        }
        case 'spc:activity': return { ok: true, lastInteractionAt };
        case 'spc:ping': return { ok: true, platform: SPC.adapter.platform, currentId: SPC.adapter.getCurrentConversationId() };
        case 'spc:list': return { ok: true, ...await SPC.adapter.listConversations(payload, budget) };
        case 'spc:search': return { ok: true, ...await SPC.adapter.searchConversations(payload) };
        case 'spc:get': {
          return { ok: true, conversation: await SPC.adapter.getConversation(payload.id, budget) };
        }
        case 'spc:rename': await SPC.adapter.renameConversation(payload.id, payload.title); return { ok: true };
        case 'spc:insert':
          if (typeof payload.text !== 'string') throw new Error(SPC.i18n.t('invalidMessage'));
          if (!SPC.adapter.insertIntoComposer(payload.text)) throw new Error(SPC.i18n.t('composerMissing'));
          return { ok: true };
      }
    })().then(sendResponse, error => sendResponse({ ok: false, error: error.message || SPC.i18n.t('networkError'), status: error.status, retryAfter: error.retryAfter }));
    return true;
  });
  ready.then(() => SPC.palette.init()).catch(() => {});
})();
