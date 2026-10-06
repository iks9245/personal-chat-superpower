(function () {
  'use strict';
  SPC.panel = {};
  const $ = selector => document.querySelector(selector);
  const t = (key, vars) => SPC.i18n.t(key, vars);
  const state = {
    conversations: [], prompts: [], folders: [], meta: {}, settings: { ...SPC.store.defaults },
    folder: 'all', platformFilter: '', platform: null, selected: new Set(), tab: null, operationController: null, editor: null,
    pane: 'conversations', chunks: [], qa: { turns: [], history: [], view: null, draft: null, hint: null, busy: false },
    status: null, progress: null, refresh: 0, searchMode: 'keyword', vectors: [], models: [], llmDirty: false, suggestions: [], generating: false, reviewSaving: false, summaryDrafts: new Map(), summaryNodes: new Map(),
    search: { generation: 0, query: '', items: [], cursor: null, source: null, flight: null, pending: false, timer: null, controller: null }
  };
  // One setter covers sync, export, search pagination and every localOperation caller.
  let operationController = null, busyTimer, busyWrites = Promise.resolve();
  function publishBusy(value) {
    busyWrites = busyWrites.catch(() => {}).then(() => value ? chrome.storage.session.set({ panelBusy: value }) : chrome.storage.session.remove('panelBusy'));
    busyWrites.catch(report);
  }
  Object.defineProperty(state, 'operationController', {
    get: () => operationController,
    set: value => {
      operationController = value; clearTimeout(busyTimer);
      const refresh = () => {
        if (!operationController) return;
        publishBusy({ until: Date.now() + 120000 }); busyTimer = setTimeout(refresh, 30000);
      };
      if (value) refresh(); else publishBusy(null);
    }
  });
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function handle(action) {
    return async event => {
      try { await action(event); } catch (error) { report(error); }
    };
  }
  function button(key, action, className) {
    const node = el('button', t(key), className); node.type = 'button'; node.addEventListener('click', handle(action)); return node;
  }
  function report(error) {
    state.status = { key: 'error', vars: { message: error.message || String(error) }, error: true }; SPC.panel.renderStatus();
  }
  function status(key, vars) { state.status = { key, vars }; SPC.panel.renderStatus(); }
  function renderStatus() {
    const node = $('#status'); node.hidden = !state.status;
    node.textContent = state.status ? t(state.status.key, state.status.vars) : '';
    node.classList.toggle('error', Boolean(state.status?.error));
    const progress = $('#sync-progress'); progress.hidden = !state.progress;
    progress.textContent = state.progress ? t(state.progress.key, state.progress.vars) : '';
  }
  function setProgress(key, vars) { state.progress = { key, vars }; SPC.panel.renderStatus(); }
  function formatDate(time, withTime = false) {
    if (!Number.isFinite(time) || time <= 0) return t('dateUnknown');
    return new Intl.DateTimeFormat(SPC.i18n.getLang(), withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(time);
  }
  // Explicit time/language inputs make boundary behavior deterministic in tests.
  function relativeDate(time, now = Date.now(), lang = SPC.i18n.getLang()) {
    const strings = SPC.i18n.dictionaries[lang];
    if (!Number.isFinite(time) || time <= 0) return strings.dateUnknown;
    const seconds = Math.max(0, (now - time) / 1000), date = new Date(time), today = new Date(now);
    const relative = new Intl.RelativeTimeFormat(lang, { numeric: 'always' });
    if (seconds < 60) return strings.justNow;
    if (seconds < 3600) return relative.format(-Math.floor(seconds / 60), 'minute');
    if (seconds < 86400) return relative.format(-Math.floor(seconds / 3600), 'hour');
    // Calendar days, not elapsed 24-hour periods, so midnight and DST are respected.
    const day = value => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
    const days = Math.round((day(today) - day(date)) / 86400000);
    if (days === 1) return new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }).format(-1, 'day');
    if (days < 7) return relative.format(-days, 'day');
    return new Intl.DateTimeFormat(lang, date.getFullYear() === today.getFullYear() ? { month: 'short', day: 'numeric' } : { dateStyle: 'medium' }).format(time);
  }
  let activeMenu = null, menuEventsBound = false, menuId = 0;
  function closeMenu(restoreFocus = false) {
    if (!activeMenu) return;
    const { trigger, menu } = activeMenu;
    menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); activeMenu = null;
    if (restoreFocus) trigger.focus();
  }
  function bindMenu(trigger, menu) {
    if (!menu.id) menu.id = `action-menu-${++menuId}`;
    trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', menu.id);
    menu.setAttribute('role', 'menu'); menu.hidden = true;
    const items = () => [...menu.querySelectorAll('button')].filter(node => !node.disabled);
    menu.querySelectorAll('button').forEach(node => {
      node.setAttribute('role', 'menuitem'); node.tabIndex = -1;
      // Close before the action opens an editor or replaces a card.
      node.addEventListener('click', () => { if (!node.disabled) closeMenu(true); }, true);
    });
    const open = (last = false) => {
      closeMenu(); activeMenu = { trigger, menu }; menu.hidden = false; trigger.setAttribute('aria-expanded', 'true');
      const enabled = items(); (last ? enabled.at(-1) : enabled[0])?.focus();
    };
    trigger.addEventListener('click', () => { if (activeMenu?.trigger === trigger) closeMenu(); else open(); });
    trigger.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault(); open(event.key === 'ArrowUp');
    });
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); return; }
      if (event.key === 'Tab') { closeMenu(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const enabled = items(), current = enabled.indexOf(document.activeElement);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
      enabled[index]?.focus();
    });
    if (!menuEventsBound) {
      document.addEventListener('click', event => {
        if (activeMenu && !activeMenu.menu.contains(event.target) && !activeMenu.trigger.contains(event.target)) closeMenu();
      });
      document.addEventListener('keydown', event => { if (event.key === 'Escape' && activeMenu) { event.preventDefault(); closeMenu(true); } });
      menuEventsBound = true;
    }
  }
  function actionMenu(buttons) {
    const anchor = el('div', null, 'menu-anchor'), trigger = button('moreActions', () => {}, 'more-actions'), menu = el('div', null, 'action-menu');
    trigger.textContent = '⋯'; trigger.setAttribute('aria-label', t('moreActions')); menu.append(...buttons); anchor.append(trigger, menu); bindMenu(trigger, menu); return anchor;
  }
  function closeCardMenu() { if (activeMenu && $('#conversation-list').contains(activeMenu.trigger)) closeMenu(); }
  function localize() {
    document.documentElement.lang = SPC.i18n.getLang(); document.title = t('appName');
    document.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = t(node.dataset.i18n); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(node => { node.placeholder = t(node.dataset.i18nPlaceholder); });
    document.querySelectorAll('[data-i18n-aria]').forEach(node => { node.setAttribute('aria-label', t(node.dataset.i18nAria)); });
    $('#language').value = SPC.i18n.getLang();
    if (document.activeElement !== $('#sync-delay')) $('#sync-delay').value = state.settings.syncDelayMs;
    SPC.panel.renderStatus(); renderAll();
    SPC.panel.renderDiagnostics();
    SPC.panel.renderBackfill();
    SPC.panel.renderVault();
    if (state.editor) { readEditor(); renderEditor(); }
    if ($('#suggestion-review').open && !state.reviewSaving) SPC.panel.renderSuggestions();
  }
  async function refreshLocal() {
    const generation = ++state.refresh;
    const [data, settings] = await Promise.all([SPC.store.exportBackup(), SPC.store.get('settings', SPC.store.defaults)]);
    if (generation !== state.refresh) return;
    const oldLLM = state.settings.llm; state.settings = SPC.store.normalizeSettings(settings);
    if (state.searchMode === 'semantic' && JSON.stringify(oldLLM) !== JSON.stringify(state.settings.llm)) SPC.panel.scheduleSearch();
    state.prompts = data.prompts; state.folders = data.folders; state.meta = data.convMeta;
    if (state.folder.startsWith('folder:') && !state.folders.some(folder => `folder:${folder.id}` === state.folder)) state.folder = 'all';
    localize();
  }
  async function refreshCache() { state.vectors = await SPC.db.vectors.getAll(); state.chunks = await SPC.db.chunks.getAll(); state.conversations = (await SPC.db.getAll()).map(conv => ({ ...conv, platform: platformOf(conv) })); SPC.panel.renderConversations(); SPC.panel.renderStats(); SPC.panel.renderBackfill(); SPC.panel.renderQA(); }
  const platformOf = conv => conv.platform || SPC.platformOfKey(conv.key);
  const tabPlatform = tab => SPC.platformForUrl(tab?.url);
  const platformLabel = platform => SPC.platforms[platform]?.label || platform;
  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabPlatform(tab)) throw new Error(t('useSupported'));
    return tab;
  }
  async function refreshTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const previous = state.tab?.id, platform = state.platform; state.platform = tabPlatform(tab); state.tab = state.platform ? tab : null;
    if (previous !== state.tab?.id || platform !== state.platform) { SPC.panel.scheduleSearch(); SPC.panel.renderConversations(); if ($('#suggestion-review').open && !state.reviewSaving) SPC.panel.renderSuggestions(); }
    $('#tab-notice').hidden = Boolean(state.tab); SPC.panel.renderAvailability(); SPC.panel.renderPrompts(); SPC.panel.renderQA();
  }
  async function send(tabId, type, payload = {}) {
    let response;
    try { response = await chrome.tabs.sendMessage(tabId, { type, payload }); }
    catch (_) { throw new Error(t('reloadTab')); }
    if (!response || !response.ok) {
      const error = new Error(response?.error || t('invalidResponse'));
      error.status = response?.status; error.retryAfter = response?.retryAfter;
      throw error;
    }
    return response;
  }
  function renderAvailability() {
    SPC.panel.renderDigests?.();
    const syncing = Boolean(state.operationController);
    SPC.panel.renderVault();
    $('#diagnostic-run').disabled = syncing;
    $('#sync').disabled = syncing || !state.tab;
    $('#sync').textContent = state.platform ? t('syncPlatform', { platform: platformLabel(state.platform) }) : t('sync');
    $('#cancel-sync').hidden = !syncing;
    $('#export-current').disabled = !state.tab || syncing;
    $('#clear-cache').disabled = syncing;
    $('#import-backup').disabled = syncing;
    $('#backup').disabled = syncing;
    for (const id of ['suggest', 'build-index', 'clear-index']) $('#' + id).disabled = syncing;
    for (const id of ['qa-ask', 'qa-question', 'qa-scope']) $('#' + id).disabled = syncing || Boolean(state.qa.view?.readOnly);
    for (const id of ['qa-new', 'qa-download', 'qa-clear']) $('#' + id).disabled = syncing;
    SPC.panel.renderSelection();
    document.querySelectorAll('[data-operation-lock]').forEach(node => { node.disabled = syncing; });
    const more = $('#search-more'); if (more) more.disabled = syncing || Boolean(state.search.flight);
  }
  function renderAll() { SPC.panel.renderFolders(); SPC.panel.renderConversations(); SPC.panel.renderPromptTags(); SPC.panel.renderPrompts(); SPC.panel.renderStats(); SPC.panel.renderQA(); SPC.panel.renderAvailability(); }
  function tagsNode(tags) {
    const box = el('div', null, 'chips'); tags.forEach(tag => box.append(el('span', tag, 'chip'))); return box;
  }
  function parseTags(value) { return SPC.store.cleanTags(value.split(/[,，]/)); }
  function readEditor() {
    if (!state.editor) return;
    for (const field of state.editor.fields) {
      const input = $('#editor-form').elements.namedItem(field.name); if (input) field.value = field.type === 'checkbox' ? input.checked : input.value;
    }
  }
  function renderEditor() {
    const editor = state.editor; if (!editor) return;
    $('#editor-title').textContent = t(editor.title);
    $('#editor-message').hidden = !editor.message;
    $('#editor-message').textContent = editor.message ? t(editor.message.key, editor.message.vars) : '';
    $('#editor-save').textContent = t(editor.saveKey);
    $('#editor-fields').replaceChildren();
    for (const field of editor.fields) {
      const label = el('label', null, field.type === 'checkbox' ? 'check' : 'field'); label.append(el('span', field.key ? t(field.key) : field.label));
      const input = el(field.type === 'textarea' ? 'textarea' : field.type === 'select' ? 'select' : 'input');
      if (input.tagName === 'INPUT') input.type = field.type || 'text';
      input.name = field.name; input.required = Boolean(field.required);
      if (field.options) for (const option of field.options) { const node = el('option', option.key ? t(option.key) : option.text); node.value = option.value; input.append(node); }
      input.value = field.value ?? ''; if (field.type === 'checkbox') input.checked = Boolean(field.value);
      if (field.maxLength) input.maxLength = field.maxLength; label.append(input);
      if (field.hint) label.append(el('span', t(field.hint), 'muted'));
      $('#editor-fields').append(label);
    }
    if (['editPrompt', 'addPrompt'].includes(editor.title)) {
      const actions = el('div', null, 'toolbar'); actions.append(button(editor.optimizing ? 'optimizing' : 'optimize', SPC.panel.optimizeEditor));
      if (editor.original !== undefined) actions.append(button('restore', () => { readEditor(); editor.fields.find(field => field.name === 'content').value = editor.original; renderEditor(); }));
      $('#editor-fields').append(actions);
    }
    $('#editor-form').querySelectorAll('input,textarea,select,button').forEach(node => { node.disabled = editor.saving || editor.fields.find(field => field.name === node.name)?.disabled || (editor.optimizing && node.id !== 'editor-cancel'); });
  }
  function openEditor(title, fields, save, saveKey = 'save', message = null) {
    state.editor = { title, fields, save, saveKey, saving: false, message };
    $('#editor-error').textContent = ''; renderEditor();
    if (!$('#editor').open) $('#editor').showModal();
    $('#editor-fields').querySelector('input,textarea,select')?.focus();
  }
  // Native confirm() is unreliable inside Chrome's side panel, so confirmations reuse the editor dialog.
  function confirmAction(key, vars, action) { SPC.panel.openEditor('confirmTitle', [], action, 'confirm', { key, vars }); }
  function closeEditor() { if (!state.editor?.saving) { state.editor?.controller?.abort(); $('#editor').close(); state.editor = null; } }
  function filename(title, extension) {
    const safe = String(title).replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100).trim() || 'SPC';
    const date = new Date(), day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return `${safe}_${day}.${extension}`;
  }
  function download(data, title, extension) {
    const blob = new Blob([data], { type: extension === 'zip' ? 'application/zip' : extension === 'json' ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob), link = el('a'); link.href = url; link.download = filename(title, extension);
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  function checkCancelled(signal) { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); }
  function withCancellation(promise, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  function wait(ms, signal) {
    checkCancelled(signal);
    return new Promise((resolve, reject) => {
      let timer, remaining = ms;
      const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
      const schedule = () => {
        // Browser timers use a signed 32-bit delay. Split larger user settings without overflowing.
        const chunk = Math.min(remaining, 2147483647); remaining -= chunk;
        timer = setTimeout(() => {
          if (remaining > 0) schedule();
          else { signal.removeEventListener('abort', abort); resolve(); }
        }, chunk);
      };
      signal.addEventListener('abort', abort, { once: true });
      schedule();
    });
  }
  // All paced requests share one serial schedule, including across cancellation and operation boundaries.
  const MIN_SYNC_DELAY_MS = 1000, MAX_RETRIES = 4;
  let requestQueue = Promise.resolve(), nextSlot = 0, slowdown = 1, cacheQueue = Promise.resolve();
  function requestDelay() { return Math.max(MIN_SYNC_DELAY_MS, state.settings.syncDelayMs); }
  function writeCache(action) { const result = cacheQueue.then(action); cacheQueue = result.catch(() => {}); return result; }
  function pacedRequest(tabId, type, payload, signal, cancellable = true, platform = state.platform, requireActive = false) {
    const pending = requestQueue.then(async () => {
      await busyWrites;
      for (let retry = 0; ; retry++) {
        checkCancelled(signal);
        await wait(Math.max(0, nextSlot - Date.now()), signal);
        const source = await chrome.tabs.get(tabId);
        if (!tabPlatform(source) || tabPlatform(source) !== platform) throw new Error(t('useSupported'));
        if (type === 'spc:rename' || requireActive) {
          const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tabPlatform(active) !== platform) throw new Error(t('syncNeedsTab', { platform: platformLabel(platform) }));
        }
        checkCancelled(signal); nextSlot = Date.now() + requestDelay() * slowdown;
        try {
          // Do not release the queue while a cancelled content-script request is still running.
          const response = await send(tabId, type, payload); checkCancelled(signal); return response;
        } catch (error) {
          if (error.status === 429) {
            const backoff = error.retryAfter > 0 ? error.retryAfter * 1000 : 30000 * 2 ** retry;
            slowdown = Math.min(slowdown * 2, 8); nextSlot = Math.max(nextSlot, Date.now() + backoff);
            checkCancelled(signal);
            if (retry >= MAX_RETRIES) throw error;
            SPC.panel.setProgress('retrying', { seconds: Math.ceil(backoff / 1000), count: retry + 1, max: MAX_RETRIES });
          } else { checkCancelled(signal); throw error; }
        }
      }
    });
    requestQueue = pending.catch(() => {});
    return cancellable ? withCancellation(pending, signal) : pending;
  }
  async function siteRequestsIdle() {
    await requestQueue;
    await state.search.flight?.catch(() => {});
  }
  async function localOperation(task) {
    if (state.operationController) return;
    const controller = new AbortController(); state.operationController = controller; SPC.panel.renderAvailability(); SPC.panel.renderConversations();
    try { await busyWrites; return await task(controller.signal); }
    catch (error) { if (error.name === 'AbortError') status('cancelled'); else report(error); }
    finally { state.operationController = null; state.progress = null; SPC.panel.renderStatus(); await refreshCache(); SPC.panel.renderAvailability(); }
  }
  function switchTab(name) {
    state.pane = name;
    if (name === 'qa') SPC.panel.stopQASearch();
    document.querySelectorAll('[data-tab]').forEach(button => {
      const active = button.dataset.tab === name; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
      document.getElementById(button.dataset.tab).hidden = !active;
    });
  }
  function bindTabs() {
    document.querySelectorAll('[data-tab]').forEach(button => {
      button.addEventListener('click', () => switchTab(button.dataset.tab));
      button.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const tabs = [...document.querySelectorAll('[data-tab]')];
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(button) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        switchTab(tabs[index].dataset.tab); tabs[index].focus();
      });
    });
  }
  function bindCancellation() {
    $('#cancel-sync').addEventListener('click', () => { state.operationController?.abort(); });
  }
  function bindEditor() {
    $('#editor-cancel').addEventListener('click', closeEditor);
    $('#editor').addEventListener('cancel', event => { if (state.editor?.saving) event.preventDefault(); else { state.editor?.controller?.abort(); state.editor = null; } });
    $('#editor-form').addEventListener('keydown', event => {
      if (state.editor?.title !== 'variables' || event.key !== 'Enter' || event.isComposing || event.target.tagName !== 'INPUT') return;
      const inputs = [...$('#editor-fields').querySelectorAll('input')], next = inputs[inputs.indexOf(event.target) + 1];
      if (next) { event.preventDefault(); next.focus(); }
    });
    $('#editor-form').addEventListener('submit', async event => {
      event.preventDefault(); const editor = state.editor; if (!editor || editor.saving || editor.optimizing) return;
      if ([...$('#editor-fields').querySelectorAll('[required]')].some(input => !input.value.trim())) return;
      readEditor(); const values = Object.fromEntries(editor.fields.map(field => [field.name, field.value]));
      editor.saving = true; renderEditor(); $('#editor-error').textContent = '';
      try { await editor.save(values); if (state.editor === editor) { editor.saving = false; closeEditor(); } }
      catch (error) {
        if (state.editor === editor) { editor.saving = false; renderEditor(); $('#editor-error').textContent = t('error', { message: error.message }); }
        else report(error);
      }
    });
  }
  function bindRefresh() {
    ['settings', 'prompts', 'folders', 'convMeta'].forEach(key => SPC.store.onChange(key, () => { SPC.panel.refreshLocal().catch(report); }));
    chrome.tabs.onActivated.addListener(() => { refreshTab().catch(report); });
    chrome.tabs.onUpdated.addListener(() => { refreshTab().catch(report); });
    chrome.windows.onFocusChanged.addListener(() => { refreshTab().catch(report); });
  }
  Object.assign(SPC.panel, {
    $, t, state, el, handle, button, report, status, renderStatus, setProgress, formatDate, relativeDate, bindMenu, actionMenu, closeCardMenu, localize, refreshLocal, refreshCache, platformOf,
    tabPlatform, platformLabel, activeTab, refreshTab, send, renderAvailability, renderAll, tagsNode, parseTags, readEditor, renderEditor, openEditor,
    confirmAction, closeEditor, filename, download, checkCancelled, withCancellation, wait, MIN_SYNC_DELAY_MS, requestDelay, writeCache, pacedRequest,
    siteRequestsIdle, localOperation, switchTab, bindTabs, bindCancellation, bindEditor, bindRefresh
  });
  Object.defineProperty(SPC.panel, 'cacheQueue', { get: () => cacheQueue });
})();
