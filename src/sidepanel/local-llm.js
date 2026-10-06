(function () {
  'use strict';
  const { state } = SPC.panel;
  function summaryButton(conv) { const node = SPC.panel.button(conv.summary ? 'resummarize' : 'localSummary', () => summarize(conv)); node.disabled = Boolean(state.operationController); return node; }
  function llmConfig() { return { ...state.settings.llm }; }
  function requireChat() {
    const config = llmConfig(); SPC.llm.normalizeBaseUrl(config.baseUrl);
    if (!config.chatModel) throw new Error(SPC.panel.t('llmChatRequired')); return config;
  }
  function renderLLMSettings() {
    if (!state.llmDirty) {
      const config = state.settings.llm;
      SPC.panel.$('#llm-base-url').value = config.baseUrl; SPC.panel.$('#llm-api-key').value = config.apiKey;
      SPC.panel.$('#llm-disable-thinking').checked = config.disableThinking;
      fillModels('#llm-chat-model', config.chatModel); fillModels('#llm-embedding-model', config.embeddingModel);
    }
    const model = state.settings.llm.embeddingModel, cache = new Map(state.conversations.map(conv => [conv.key, conv]));
    const indexed = state.vectors.filter(v => v.model === model && cache.has(v.key) && v.hash === SPC.search.hash(SPC.search.documentText(cache.get(v.key), state.meta[v.key]))).length;
    SPC.panel.$('#vector-stats').textContent = SPC.panel.t('vectorStats', { indexed, total: cache.size, model: model || '—' }) + ' · ' + SPC.panel.t('chunkStats', { chunks: state.chunks.filter(chunk => chunk.model === model && cache.has(chunk.convKey)).length });
  }
  function fillModels(selector, selected) {
    const select = SPC.panel.$(selector); select.replaceChildren(); const empty = SPC.panel.el('option', SPC.panel.t('chooseModel')); empty.value = ''; select.append(empty);
    for (const name of new Set([...state.models, ...(selected ? [selected] : [])])) { const option = SPC.panel.el('option', name); option.value = name; select.append(option); }
    select.value = selected;
  }
  function readLLMSettings() {
    return SPC.store.normalizeLLM({ baseUrl: SPC.panel.$('#llm-base-url').value, apiKey: SPC.panel.$('#llm-api-key').value,
      chatModel: SPC.panel.$('#llm-chat-model').value, embeddingModel: SPC.panel.$('#llm-embedding-model').value, disableThinking: SPC.panel.$('#llm-disable-thinking').checked });
  }
  async function testLLM() {
    SPC.panel.$('#llm-test').disabled = true; SPC.panel.$('#llm-status').textContent = SPC.panel.t('busy');
    try {
      const config = readLLMSettings(), models = await SPC.llm.listModels(config); state.models = models; state.llmDirty = true;
      fillModels('#llm-chat-model', models.includes(config.chatModel) ? config.chatModel : models.find(name => !/embed/i.test(name)) || '');
      fillModels('#llm-embedding-model', models.includes(config.embeddingModel) ? config.embeddingModel : models.find(name => /embed/i.test(name)) || '');
      SPC.panel.$('#llm-status').textContent = SPC.panel.t('llmConnected', { count: models.length });
    } catch (error) { SPC.panel.$('#llm-status').textContent = error.message; }
    finally { SPC.panel.$('#llm-test').disabled = false; }
  }
  const summaryContent = conv => SPC.summary.content(conv);
  async function summarize(conv) {
    const config = requireChat();
    return SPC.panel.localOperation(async signal => {
      SPC.panel.setProgress('localSummary');
      let record = await SPC.db.get(conv.key); SPC.panel.checkCancelled(signal);
      if (!(record?.fetchedAt > 0)) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }), platform = SPC.panel.platformOf(conv);
        if (SPC.panel.tabPlatform(tab) !== platform) throw new Error(SPC.panel.t('summaryNeedsTab', { platform: SPC.panel.platformLabel(platform) }));
        const response = await SPC.panel.pacedRequest(tab.id, 'spc:get', { id: conv.id }, signal, true, platform); SPC.panel.checkCancelled(signal);
        if (response.conversation?.key !== conv.key || SPC.panel.platformOf(response.conversation) !== platform) throw new Error(SPC.panel.t('invalidResponse'));
        record = { ...record, ...response.conversation, platform, fetchedAt: Date.now() };
        await SPC.panel.writeCache(async () => { SPC.panel.checkCancelled(signal); await SPC.db.put(record); }); await SPC.panel.refreshCache();
      }
      state.summaryDrafts.set(conv.key, ''); SPC.panel.renderConversations();
      let frame = null;
      try {
        const text = await SPC.llm.chat(config, { stream: true, signal, messages: SPC.summary.messages(record), onText: text => {
          if (signal.aborted) return; state.summaryDrafts.set(conv.key, text);
          if (frame !== null) return;
          frame = requestAnimationFrame(() => {
            frame = null;
            if (signal.aborted || !state.summaryDrafts.has(conv.key)) return;
            const node = state.summaryNodes.get(conv.key);
            if (node) renderSummaryText(node, state.summaryDrafts.get(conv.key), true);
          });
        } });
        SPC.panel.checkCancelled(signal);
        await SPC.panel.writeCache(async () => {
          const latest = await SPC.db.get(conv.key); SPC.panel.checkCancelled(signal);
          if (latest) await SPC.db.put({ ...latest, summary: { text: SPC.llm.stripThinking(text), model: config.chatModel, createdAt: Date.now(), sourceHash: SPC.search.hash(SPC.summary.content(record)) } });
        }); SPC.panel.status('summaryDone');
      } finally { if (frame !== null) cancelAnimationFrame(frame); state.summaryDrafts.delete(conv.key); }
    });
  }
  function renderSummaryText(node, text, draft) {
    if (draft && !text) node.textContent = SPC.panel.t('llmThinking');
    else node.replaceChildren(SPC.markdown.render(text));
  }
  function renderSummary(card, conv) {
    const draft = state.summaryDrafts.has(conv.key), summary = conv.summary;
    if (!draft && !summary) return;
    const box = SPC.panel.el('details'), text = SPC.panel.el('div', null, 'summary-text');
    renderSummaryText(text, draft ? state.summaryDrafts.get(conv.key) : summary.text, draft);
    box.open = draft;
    const label = SPC.panel.el('summary', SPC.panel.t('cardSummary') + (draft ? '' : ' · ' + SPC.panel.relativeDate(summary.createdAt)));
    if (!draft) label.title = SPC.panel.t('summaryInfo', { model: summary.model, date: SPC.panel.formatDate(summary.createdAt, true) });
    box.append(label, text);
    state.summaryNodes.set(conv.key, text); card.append(box);
  }
  function maintainChunks(records, config, signal, partial = false) {
    return SPC.rag.maintainChunks({ conversations: records, meta: state.meta, config, db: SPC.db, llm: SPC.llm, signal, partial,
      onProgress: (done, total) => SPC.panel.setProgress('chunkProgress', { done, total }) });
  }
  async function buildIndex() {
    const config = llmConfig(); if (!config.embeddingModel) throw new Error(SPC.panel.t('llmEmbeddingRequired'));
    await SPC.panel.localOperation(async signal => {
      const records = await SPC.db.getAll(), keys = new Set(records.map(conv => conv.key)), vectors = await SPC.db.vectors.getAll(); SPC.panel.checkCancelled(signal);
      for (const vector of vectors) { SPC.panel.checkCancelled(signal); if (!keys.has(vector.key)) await SPC.db.vectors.delete(vector.key); }
      const existing = new Map(vectors.map(vector => [vector.key, vector]));
      const pending = records.map(conv => ({ conv, text: SPC.search.documentText(conv, state.meta[conv.key]) })).map(item => ({ ...item, hash: SPC.search.hash(item.text) }))
        .filter(item => existing.get(item.conv.key)?.model !== config.embeddingModel || existing.get(item.conv.key)?.hash !== item.hash);
      for (let offset = 0; offset < pending.length; offset += 32) {
        SPC.panel.setProgress('indexProgress', { done: records.length - pending.length + offset, total: records.length });
        const batch = pending.slice(offset, offset + 32), embedded = await SPC.llm.embed(config, batch.map(item => item.text), { signal }); SPC.panel.checkCancelled(signal);
        await SPC.db.vectors.putMany(batch.map((item, index) => ({ key: item.conv.key, model: config.embeddingModel, hash: item.hash,
          vector: SPC.search.normalizeVector(embedded[index]), updatedAt: Date.now() })));
      }
      SPC.panel.checkCancelled(signal); SPC.panel.setProgress('indexProgress', { done: records.length, total: records.length });
      await maintainChunks(records, config, signal); SPC.panel.status('indexDone');
    });
    if (state.searchMode === 'semantic') SPC.panel.scheduleSearch();
  }
  async function optimizeEditor() {
    const editor = state.editor; if (!editor || editor.optimizing) return;
    SPC.panel.readEditor(); const field = editor.fields.find(field => field.name === 'content');
    if (!field.value.trim()) return;
    editor.original ??= field.value; editor.controller = new AbortController(); editor.optimizing = true; SPC.panel.renderEditor(); SPC.panel.$('#editor-error').textContent = '';
    try {
      const text = await SPC.llm.optimize(requireChat(), field.value, { signal: editor.controller.signal });
      if (state.editor === editor && !editor.controller.signal.aborted) field.value = text;
    } catch (error) { if (state.editor === editor && error.name !== 'AbortError') SPC.panel.$('#editor-error').textContent = error.message; }
    finally { editor.optimizing = false; if (state.editor === editor) SPC.panel.renderEditor(); }
  }
  function bindLLMSettings() {
    SPC.panel.$('#llm-form').addEventListener('input', () => { state.llmDirty = true; });
    SPC.panel.$('#llm-test').addEventListener('click', testLLM);
    SPC.panel.$('#llm-form').addEventListener('submit', SPC.panel.handle(async event => {
      event.preventDefault(); await SPC.store.updateSettings({ llm: readLLMSettings() }); state.llmDirty = false; await SPC.panel.refreshLocal(); SPC.panel.status('saved');
    }));
  }
  function bindIndex() {
    SPC.panel.$('#build-index').addEventListener('click', SPC.panel.handle(buildIndex));
    SPC.panel.$('#clear-index').addEventListener('click', SPC.panel.handle(async () => {
      if (state.operationController) return;
      await SPC.panel.localOperation(async () => {
        state.search.controller?.abort(); state.search.generation++; await SPC.db.vectors.clear(); await SPC.db.chunks.clear(); SPC.panel.status('indexCleared');
      });
      if (state.searchMode === 'semantic') SPC.panel.scheduleSearch();
    }));
  }
  Object.assign(SPC.panel, {
    summaryButton, llmConfig, requireChat, renderLLMSettings, fillModels, readLLMSettings, testLLM, summaryContent, summarize, renderSummaryText,
    renderSummary, maintainChunks, buildIndex, optimizeEditor, bindLLMSettings, bindIndex
  });
})();
