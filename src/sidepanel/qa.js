(function () {
  'use strict';
  const { state } = SPC.panel;
  function stopQASearch() {
    clearTimeout(state.search.timer); state.search.pending = false; state.search.controller?.abort(); state.search.generation++;
  }
  function qaScope() { return { kind: SPC.panel.$('#qa-scope').value || 'all', platform: state.platform, folder: state.folder, platformFilter: state.platformFilter }; }
  function qaFilter(scope, key) {
    const meta = state.meta[key] || {}, platform = SPC.platformOfKey(key);
    if (scope.kind === 'platform') return Boolean(scope.platform) && platform === scope.platform;
    if (scope.kind === 'pinned') return Boolean(meta.pinned);
    if (scope.kind !== 'folder') return true;
    if (scope.platformFilter && platform !== scope.platformFilter) return false;
    const folderId = state.folders.some(folder => folder.id === meta.folderId) ? meta.folderId : null;
    return scope.folder === 'all' || (scope.folder === 'unfiled' && !folderId) || (scope.folder === 'pinned' && meta.pinned) || scope.folder === `folder:${folderId}`;
  }
  const titleOnly = conv => !(conv.fetchedAt > 0) && !conv.summary?.text?.trim();
  function qaDownloads(view = state.qa.view, platform = state.platform) {
    if (!view || view.readOnly) return [];
    const keys = new Set(view.sources.map(source => source.key));
    return [...keys].map(key => state.conversations.find(conv => conv.key === key)).filter(conv => conv && titleOnly(conv) && SPC.panel.platformOf(conv) === platform).slice(0, 5);
  }
  async function openQASource(source) {
    const platform = SPC.platforms[source.platform]; if (!platform) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await chrome.tabs.update(tab.id, { url: platform.conversationUrl(source.key.slice(source.key.indexOf(':') + 1)) });
  }
  function renderQAAnswer(view, draft = false) {
    const node = SPC.panel.$('#qa-answer');
    if (draft && !view.answer) node.textContent = SPC.panel.t('llmThinking');
    else {
      node.replaceChildren(SPC.markdown.render(view.answer));
      SPC.rag.citationButtons(node, view.sources.length, index => { openQASource(view.sources[index]).catch(SPC.panel.report); });
    }
  }
  function renderQAHistory() {
    SPC.panel.$('#qa-history-toggle').hidden = !state.qa.history.length;
    const list = SPC.panel.$('#qa-history'); list.replaceChildren();
    for (const entry of state.qa.history) {
      const item = SPC.panel.button('qaQuestion', () => {
        if (state.operationController) return;
        state.qa.view = { ...entry, readOnly: true }; state.qa.hint = null; SPC.panel.renderQA(); SPC.panel.renderAvailability();
      }, 'title-button'); item.textContent = entry.question; list.append(item);
    }
  }
  function renderQA() {
    const qa = state.qa, view = qa.draft || qa.view, hint = SPC.panel.$('#qa-hint');
    const hasIndex = state.chunks.some(chunk => chunk.model === state.settings.llm.embeddingModel && state.conversations.some(conv => conv.key === chunk.convKey));
    const hintKey = qa.hint || (!hasIndex && !view ? 'qaIndexEmpty' : null);
    hint.hidden = !hintKey; hint.className = 'empty-state'; hint.replaceChildren();
    if (hintKey) hint.append(document.createTextNode(SPC.panel.t(hintKey) + ' '), SPC.panel.button('settingsLLM', () => SPC.panel.openSettingsSection('llm')));
    SPC.panel.$('#qa-view-question').textContent = view?.question || '';
    SPC.panel.$('#qa-info').textContent = view ? [view.readOnly ? SPC.panel.t('qaReadOnly') : '', view.model, view.createdAt ? SPC.panel.formatDate(view.createdAt, true) : ''].filter(Boolean).join(' · ') : '';
    if (view) SPC.panel.renderQAAnswer(view, Boolean(qa.draft)); else SPC.panel.$('#qa-answer').replaceChildren();
    const sources = SPC.panel.$('#qa-sources'); sources.replaceChildren();
    if (view?.sources.length) {
      sources.append(SPC.panel.el('h2', SPC.panel.t('qaSources'))); const list = SPC.panel.el('ul');
      view.sources.forEach((source, index) => {
        const row = SPC.panel.el('li'), open = SPC.panel.button('qaSources', () => openQASource(source), 'title-button');
        open.textContent = `[${index + 1}] ${source.title} · ${SPC.panel.platformLabel(source.platform)}${source.date ? ' · ' + source.date : ''}${Number.isFinite(source.score) ? ' · ' + SPC.panel.t('similarity', { percent: Math.round(source.score * 100) }) : ''}`;
        row.append(open); list.append(row);
      }); sources.append(list);
    }
    SPC.panel.$('#qa-coverage').hidden = !view?.coverage;
    SPC.panel.$('#qa-coverage').textContent = view?.coverage ? SPC.panel.t('qaCoverage', view.coverage) : '';
    const count = qaDownloads(view).length; SPC.panel.$('#qa-download').hidden = !count || Boolean(qa.draft);
    SPC.panel.$('#qa-download').textContent = SPC.panel.t('qaDownload', { count }); SPC.panel.renderQAHistory();
  }
  async function answerQuestion(question, scope, config, signal, replace = false) {
    const qa = state.qa, records = await SPC.db.getAll(), cache = new Map(records.map(conv => [conv.key, conv]));
    const chunks = (await SPC.db.chunks.getAll()).filter(chunk => chunk.model === config.embeddingModel && cache.has(chunk.convKey)); SPC.panel.checkCancelled(signal);
    if (!chunks.length) { qa.hint = 'qaIndexRequired'; SPC.panel.renderQA(); return; }
    SPC.panel.setProgress('qaRetrieving');
    const [vector] = await SPC.llm.embed(config, [SPC.search.queryText(question, config.embeddingModel)], { signal }); SPC.panel.checkCancelled(signal);
    const excerpts = SPC.rag.prepareExcerpts(SPC.rag.retrieve(vector, chunks, { model: config.embeddingModel, filter: key => qaFilter(scope, key) }).map(chunk => {
      const conv = cache.get(chunk.convKey);
      return { ...chunk, title: SPC.panel.displayTitle(conv), platform: SPC.panel.platformOf(conv), date: SPC.panel.formatDate(conv.updateTime) };
    }));
    const keys = new Set(excerpts.map(chunk => chunk.convKey));
    const turn = { question, answer: '', sources: excerpts.map(chunk => ({ key: chunk.convKey, title: chunk.title, platform: chunk.platform, date: chunk.date, score: chunk.score })),
      coverage: { chunks: excerpts.length, convs: keys.size, titleOnly: [...keys].filter(key => titleOnly(cache.get(key))).length }, model: config.chatModel, scope };
    const history = replace ? qa.turns.slice(0, -1) : qa.turns;
    qa.hint = null; qa.draft = turn; SPC.panel.renderQA(); SPC.panel.setProgress('qaAnswering'); let frame = null;
    try {
      const answer = await SPC.llm.chat(config, { stream: true, signal, messages: SPC.rag.buildQAMessages({ question, excerpts, history, lang: state.settings.lang }), onText: text => {
        if (signal.aborted) return; turn.answer = text;
        if (frame !== null) return;
        frame = requestAnimationFrame(() => { frame = null; if (!signal.aborted && qa.draft === turn) SPC.panel.renderQAAnswer(turn, true); });
      } }); SPC.panel.checkCancelled(signal);
      turn.answer = SPC.llm.stripThinking(answer);
      qa.history = await SPC.store.saveQA(turn, replace ? qa.turns.at(-1)?.createdAt : undefined);
      turn.createdAt = qa.history[0].createdAt;
      if (replace) qa.turns[qa.turns.length - 1] = turn; else qa.turns.push(turn);
      qa.view = turn; SPC.panel.status('qaDone');
    } finally { if (frame !== null) cancelAnimationFrame(frame); qa.draft = null; SPC.panel.renderQA(); }
  }
  function qaConfig() {
    const config = SPC.panel.llmConfig();
    if (!config.chatModel || !config.embeddingModel) { state.qa.hint = 'qaModelsRequired'; SPC.panel.renderQA(); return null; }
    SPC.llm.normalizeBaseUrl(config.baseUrl); return config;
  }
  async function askQuestion() {
    if (state.operationController || state.qa.view?.readOnly) return;
    const question = SPC.panel.$('#qa-question').value.trim(); if (!question) return;
    const config = qaConfig(); if (!config) return;
    const scope = qaScope(); stopQASearch(); state.qa.busy = true;
    try { await SPC.panel.localOperation(signal => answerQuestion(question, scope, config, signal)); }
    finally { state.qa.busy = false; SPC.panel.renderQA(); SPC.panel.renderAvailability(); }
  }
  async function downloadQA(confirmed = null) {
    if (state.operationController) return;
    const view = confirmed?.view || state.qa.view; if (!view || view.readOnly || view !== state.qa.turns.at(-1)) return;
    const config = qaConfig(); if (!config) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }), platform = SPC.panel.tabPlatform(tab);
    if (state.operationController || !platform) return;
    const records = qaDownloads(view, platform).filter(conv => !confirmed || confirmed.keys.includes(conv.key)); if (!records.length) return;
    if (!confirmed && records.length > 1) {
      SPC.panel.confirmAction('qaDownloadConfirm', { platform: SPC.panel.platformLabel(platform), count: records.length, seconds: Math.ceil(records.length * SPC.panel.requestDelay() / 1000) },
        () => downloadQA({ view, keys: records.map(conv => conv.key) })); return;
    }
    if (state.editor) { SPC.panel.$('#editor').close(); state.editor = null; }
    stopQASearch(); state.qa.busy = true;
    try {
      await SPC.panel.localOperation(async signal => {
        const fetched = [];
        for (const conv of records) {
          SPC.panel.setProgress('qaDownloading', { done: fetched.length, total: records.length });
          const response = await SPC.panel.pacedRequest(tab.id, 'spc:get', { id: conv.id }, signal, true, platform, true); SPC.panel.checkCancelled(signal);
          if (response.conversation?.key !== conv.key || SPC.panel.platformOf(response.conversation) !== platform) throw new Error(SPC.panel.t('invalidResponse'));
          await SPC.panel.writeCache(async () => {
            const old = await SPC.db.get(conv.key); SPC.panel.checkCancelled(signal);
            const record = { ...old, ...response.conversation, platform, fetchedAt: Date.now() }; await SPC.db.put(record); fetched.push(record);
          }); SPC.panel.checkCancelled(signal);
        }
        SPC.panel.setProgress('qaDownloading', { done: fetched.length, total: records.length });
        await SPC.panel.maintainChunks(fetched, config, signal, true); SPC.panel.checkCancelled(signal); await SPC.panel.refreshCache();
        await answerQuestion(view.question, view.scope, config, signal, true);
      });
    } finally { state.qa.busy = false; SPC.panel.renderQA(); SPC.panel.renderAvailability(); }
  }
  function bindQA() {
    SPC.panel.$('#qa-ask').addEventListener('click', SPC.panel.handle(() => askQuestion()));
    SPC.panel.$('#qa-question').addEventListener('keydown', SPC.panel.handle(event => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      event.preventDefault(); return askQuestion();
    }));
    SPC.panel.$('#qa-new').addEventListener('click', () => {
      if (state.operationController) return;
      state.qa.turns = []; state.qa.view = null; state.qa.hint = null; SPC.panel.$('#qa-question').value = ''; SPC.panel.renderQA(); SPC.panel.renderAvailability(); SPC.panel.$('#qa-question').focus();
    });
    SPC.panel.$('#qa-download').addEventListener('click', SPC.panel.handle(() => downloadQA()));
    SPC.panel.$('#qa-clear').addEventListener('click', SPC.panel.handle(async () => {
      if (state.operationController) return;
      await SPC.store.clearQA(); state.qa.history = []; if (state.qa.view?.readOnly) state.qa.view = null; SPC.panel.renderQA(); SPC.panel.renderAvailability();
    }));
    SPC.store.onChange('qaHistory', value => { state.qa.history = value || []; SPC.panel.renderQAHistory(); });
  }
  Object.assign(SPC.panel, {
    stopQASearch, qaScope, qaFilter, titleOnly, qaDownloads, openQASource, renderQAAnswer, renderQAHistory, renderQA, answerQuestion, qaConfig,
    askQuestion, downloadQA, bindQA
  });
})();
