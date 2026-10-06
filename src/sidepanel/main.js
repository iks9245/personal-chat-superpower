(function () {
  'use strict';
  const { state, report } = SPC.panel;
  async function init() {
    await SPC.i18n.init();
    SPC.panel.bindTabs();
    SPC.panel.bindSearchMode();
    SPC.panel.bindLLMSettings();
    SPC.panel.bindSuggestionGeneration();
    SPC.panel.bindIndex();
    SPC.panel.bindSuggestionReview();
    SPC.panel.bindConversationFilters();
    SPC.panel.bindPromptFilters();
    SPC.panel.bindSync();
    SPC.panel.bindCancellation();
    SPC.panel.bindConversationActions();
    SPC.panel.bindPromptEditor();
    SPC.panel.bindSelection();
    SPC.panel.bindEditor();
    SPC.panel.bindSettings();
    await SPC.panel.bindSettingsStatus();
    await SPC.panel.bindVault();
    SPC.panel.bindDiagnostics();
    await SPC.panel.bindBackfill();
    SPC.panel.bindQA();
    await SPC.panel.bindDigests();
    state.qa.history = await SPC.store.get('qaHistory', []);
    SPC.panel.bindRefresh();
    await SPC.panel.refreshLocal();
    await SPC.panel.refreshCache();
    await SPC.panel.refreshTab();
  }
  init().catch(report);
})();
