(function () {
  'use strict';
  const { state } = SPC.panel;
  const displayTitle = conv => SPC.conversation.displayTitle(conv, state.meta[conv.key]) || SPC.panel.t('untitled');
  function folderMatches(id, conv) {
    const meta = state.meta[conv.key] || {}, folderId = state.folders.some(folder => folder.id === meta.folderId) ? meta.folderId : null;
    return id === 'all' || (id === 'unfiled' && !folderId) || (id === 'pinned' && meta.pinned) || id === `folder:${folderId}`;
  }
  function renderFolders() {
    const list = SPC.panel.$('#folder-list'), focused = list.contains(document.activeElement), scrollLeft = list.scrollLeft; list.replaceChildren();
    const records = state.conversations.filter(conv => !state.platformFilter || SPC.panel.platformOf(conv) === state.platformFilter);
    const entries = [{ id: 'all', key: 'all' }, { id: 'pinned', key: 'pinned' }, { id: 'unfiled', key: 'unfiled' },
      ...state.folders.slice().sort((a, b) => a.order - b.order).map(folder => ({ id: `folder:${folder.id}`, folder }))];
    entries.forEach(entry => {
      const filter = SPC.panel.button(entry.key || 'folders', () => {
        state.folder = entry.id; SPC.panel.renderConversations();
        const active = list.querySelector('[aria-pressed="true"]'); active?.focus(); active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }, 'folder-filter');
      filter.setAttribute('aria-pressed', String(state.folder === entry.id)); filter.tabIndex = state.folder === entry.id ? 0 : -1;
      filter.replaceChildren();
      if (entry.folder) {
        const swatch = SPC.panel.el('span', null, 'swatch');
        if (/^#[a-f0-9]{6}$/i.test(entry.folder.color)) swatch.style.backgroundColor = entry.folder.color;
        filter.append(swatch);
      }
      filter.append(document.createTextNode(`${entry.folder ? entry.folder.name : SPC.panel.t(entry.key)} ${records.filter(conv => folderMatches(entry.id, conv)).length}`));
      filter.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const chips = [...list.children], index = chips.indexOf(filter);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? chips.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + chips.length) % chips.length;
        chips[next].click();
      });
      list.append(filter);
    });
    list.scrollLeft = scrollLeft;
    if (focused) list.querySelector('[aria-pressed="true"]')?.focus();
    if (SPC.panel.$('#folder-manager').open) renderFolderManager();
  }
  function renderFolderManager() {
    const list = SPC.panel.$('#folder-manager-list'); list.replaceChildren();
    const folders = state.folders.slice().sort((a, b) => a.order - b.order);
    folders.forEach((folder, index) => {
      const row = SPC.panel.el('div', null, 'folder-manager-row');
      const edit = SPC.panel.button('editFolder', () => editFolder(folder), 'folder-name'); edit.textContent = folder.name;
      edit.title = SPC.panel.t('editFolder');
      const color = SPC.panel.button('color', () => editFolder(folder), 'folder-color'), swatch = SPC.panel.el('span', null, 'swatch');
      color.setAttribute('aria-label', SPC.panel.t('color')); color.title = folder.color;
      if (/^#[a-f0-9]{6}$/i.test(folder.color)) swatch.style.backgroundColor = folder.color;
      color.replaceChildren(swatch);
      const reorder = direction => async () => {
        const current = (await SPC.store.get('folders', [])).slice().sort((a, b) => a.order - b.order), from = current.findIndex(item => item.id === folder.id), to = from + direction;
        if (from < 0 || to < 0 || to >= current.length) return;
        [current[from], current[to]] = [current[to], current[from]];
        await SPC.store.set('folders', current.map((item, order) => ({ ...item, order }))); await SPC.panel.refreshLocal();
        const row = SPC.panel.$('#folder-manager-list').children[to], arrow = row?.querySelector(direction < 0 ? '.folder-up' : '.folder-down');
        (arrow?.disabled ? row.querySelector('.folder-name') : arrow)?.focus();
      };
      const up = SPC.panel.button('moveFolderUp', reorder(-1), 'folder-up'), down = SPC.panel.button('moveFolderDown', reorder(1), 'folder-down');
      up.setAttribute('aria-label', SPC.panel.t('moveFolderUp')); down.setAttribute('aria-label', SPC.panel.t('moveFolderDown'));
      up.textContent = '↑'; down.textContent = '↓'; up.disabled = index === 0; down.disabled = index === folders.length - 1;
      row.append(edit, color, up, down, SPC.panel.button('delete', () => {
        SPC.panel.confirmAction('deleteFolderConfirm', { name: folder.name }, async () => { await SPC.store.deleteFolder(folder.id); await SPC.panel.refreshLocal(); });
      }, 'danger')); list.append(row);
    });
  }
  function summaryPreview(text) {
    const lines = String(text || '').split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim();
      if (!line || /^(?:=+|-+)\s*$/.test(line) || /^#{1,6}(?:\s|$)/.test(line) || /^(?:=+|-+)\s*$/.test(lines[index + 1]?.trim() || '')) continue;
      const node = SPC.panel.el('div'); node.append(SPC.markdown.render(line));
      const plain = node.textContent.trim(); if (plain) return plain;
    }
    return '';
  }
  function filteredConversations() {
    const query = SPC.panel.$('#conversation-search').value.trim(), cached = new Map(state.conversations.map(conv => [conv.key, conv]));
    const local = SPC.search.search(state.conversations, state.searchMode === 'semantic' ? '' : query, state.meta).sort((a, b) => b.score - a.score ||
      Number(Boolean(state.meta[b.key]?.pinned)) - Number(Boolean(state.meta[a.key]?.pinned)) || cached.get(b.key).updateTime - cached.get(a.key).updateTime);
    const platform = state.platform, remote = query === state.search.query ? state.search.items : [];
    const records = new Map();
    for (const item of remote) {
      const key = `${platform}:${item.id}`;
      if (!records.has(key)) records.set(key, { ...(cached.get(key) || titleRecord(item, platform)), title: item.title, updateTime: item.updateTime });
    }
    const results = state.searchMode === 'semantic' && query ? (query === state.search.query ? state.search.semantic || [] : []) : SPC.search.mergeResults(local, state.searchMode === 'semantic' ? [] : remote, platform);
    const filtered = results.filter(result => {
      if (state.platformFilter && SPC.platformOfKey(result.key) !== state.platformFilter) return false;
      const meta = state.meta[result.key] || {};
      const folderId = state.folders.some(folder => folder.id === meta.folderId) ? meta.folderId : null;
      return state.folder === 'all' || (state.folder === 'unfiled' && !folderId) ||
        (state.folder === 'pinned' && meta.pinned) || state.folder === `folder:${folderId}`;
    }).map(result => ({ conv: (state.searchMode === 'semantic' ? null : records.get(result.key)) || cached.get(result.key), result }));
    return state.searchMode === 'semantic' && query ? filtered.slice(0, 30) : filtered;
  }
  function renderSearchSource() {
    const source = state.search.source, node = SPC.panel.$('#search-source');
    node.textContent = source ? SPC.panel.t(source.key, source.vars) : ''; node.hidden = !source;
    if (source?.key === 'semanticHint') node.append(document.createTextNode(' '), SPC.panel.button('settings', () => SPC.panel.switchTab('settings')));
  }
  function scheduleSearch() {
    const search = state.search; search.generation++; clearTimeout(search.timer); search.controller?.abort();
    search.query = SPC.panel.$('#conversation-search').value.trim(); search.items = []; search.cursor = null; search.source = null; search.pending = false; search.semantic = [];
    SPC.panel.renderSearchSource();
    if (state.exportingVault || state.diagnosing || state.qa.busy || state.pane === 'qa') return;
    if (state.searchMode === 'semantic') { search.timer = setTimeout(semanticSearch, 500); SPC.panel.renderConversations(); return; }
    search.timer = setTimeout(() => {
      SPC.panel.renderConversations();
      if (search.query.length < 2) return;
      if (search.query.length > 200 || !state.tab) {
        search.source = { key: 'searchUnavailable', vars: { message: SPC.panel.t(search.query.length > 200 ? 'invalidMessage' : 'useSupported') } };
        SPC.panel.renderSearchSource(); return;
      }
      search.timer = setTimeout(() => { search.pending = true; runSearch(); }, 500);
    }, 200);
  }
  async function runSearch(more = false) {
    const search = state.search;
    if (state.exportingVault || state.diagnosing || state.searchMode === 'semantic' || state.generating || state.qa.busy || state.pane === 'qa') return;
    if (search.flight || (more ? !search.cursor || state.operationController : !search.pending)) return;
    search.pending = false;
    const generation = search.generation, query = search.query, tabId = state.tab?.id, platform = state.platform;
    if (!tabId) return;
    const controller = new AbortController(), signal = controller.signal; search.controller = controller;
    if (more) state.operationController = controller;
    search.source = { key: 'searchingServer', vars: { platform: SPC.panel.platformLabel(platform) } }; SPC.panel.renderSearchSource();
    // First-page searches bypass pacing. Keep the flight occupied until the actual request settles, even after cancellation.
    const flight = more ? SPC.panel.pacedRequest(tabId, 'spc:search', { query, cursor: search.cursor }, signal, false, platform) : SPC.panel.send(tabId, 'spc:search', { query });
    search.flight = flight; SPC.panel.renderAvailability(); SPC.panel.renderConversations();
    const current = () => generation === search.generation && !signal.aborted && state.tab?.id === tabId && state.platform === platform;
    try {
      const page = await SPC.panel.withCancellation(flight, signal);
      if (!current()) return;
      search.items = more ? [...search.items, ...page.items] : page.items; search.cursor = page.cursor;
      search.source = { key: 'searchServerResults', vars: { platform: SPC.panel.platformLabel(platform) } }; SPC.panel.renderConversations();
      await upsertTitles(page.items, true, signal, platform);
    } catch (error) {
      if (current()) {
        search.items = []; search.cursor = null; search.source = { key: 'searchUnavailable', vars: { message: error.message } };
      } else if (generation === search.generation && signal.aborted) {
        search.source = search.items.length ? { key: 'searchServerResults', vars: { platform: SPC.panel.platformLabel(platform) } } : null;
      }
    } finally {
      if (search.controller === controller) search.controller = null;
      if (state.operationController === controller) { state.operationController = null; state.progress = null; SPC.panel.renderStatus(); }
      SPC.panel.renderSearchSource(); SPC.panel.renderConversations(); SPC.panel.renderAvailability();
      const release = () => {
        if (search.flight === flight) search.flight = null;
        SPC.panel.renderAvailability();
        if (search.pending) runSearch();
      };
      flight.then(release, release);
    }
  }
  function renderSelection() {
    SPC.panel.$('#batch-toolbar').hidden = !SPC.panel.$('#multi-select').checked;
    SPC.panel.$('#toggle-multi-select').textContent = (SPC.panel.$('#multi-select').checked ? '✓ ' : '') + SPC.panel.t('multiSelect');
    SPC.panel.$('#conversations').classList.toggle('selecting', SPC.panel.$('#multi-select').checked);
    SPC.panel.$('#selected-count').textContent = SPC.panel.$('#multi-select').checked ? SPC.panel.t('selected', { count: state.selected.size }) : '';
    SPC.panel.$('#batch-move').disabled = state.selected.size === 0;
    SPC.panel.$('#batch-export').disabled = state.selected.size === 0 || Boolean(state.operationController);
  }
  function renderConversations() {
    SPC.panel.closeCardMenu(); renderFolders();
    const list = SPC.panel.$('#conversation-list'); list.replaceChildren(); state.summaryNodes.clear(); renderSelection(); SPC.panel.renderSearchSource();
    const results = filteredConversations(), query = SPC.panel.$('#conversation-search').value.trim();
    SPC.panel.$('#conversation-count').textContent = SPC.panel.t(query ? 'resultCount' : 'conversationCount', { count: results.length });
    if (!results.length) list.append(SPC.panel.el('p', SPC.panel.t('noConversations'), 'empty'));
    for (const { conv, result } of results) {
      const meta = state.meta[conv.key] || { tags: [], pinned: false }, title = displayTitle(conv);
      const card = SPC.panel.el('article', null, 'card'), heading = SPC.panel.el('div', null, 'card-heading');
      if (SPC.panel.$('#multi-select').checked) {
        const checkbox = SPC.panel.el('input'); checkbox.type = 'checkbox'; checkbox.checked = state.selected.has(conv.key);
        checkbox.setAttribute('aria-label', SPC.panel.t('selectConversation', { title }));
        checkbox.addEventListener('change', () => { if (checkbox.checked) state.selected.add(conv.key); else state.selected.delete(conv.key); renderSelection(); });
        heading.append(checkbox);
      }
      const open = SPC.panel.button('untitled', async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) await chrome.tabs.update(tab.id, { url: SPC.platforms[SPC.panel.platformOf(conv)].conversationUrl(conv.id) });
      }, 'title-button');
      open.textContent = title; heading.append(open, SPC.panel.el('span', SPC.panel.platformLabel(SPC.panel.platformOf(conv)), 'chip platform-chip'));
      if (state.searchMode === 'semantic' && SPC.panel.$('#conversation-search').value.trim()) heading.append(SPC.panel.el('span', SPC.panel.t('similarity', { percent: Math.round(result.score * 100) }), 'chip'));
      if (meta.pinned) heading.append(SPC.panel.el('span', SPC.panel.t('pinned'), 'chip'));
      const date = SPC.panel.el('div', SPC.panel.relativeDate(conv.updateTime), 'date'); date.title = SPC.panel.formatDate(conv.updateTime, true);
      card.append(heading, date, SPC.panel.tagsNode(meta.tags || []));
      if (meta.customTitle) card.append(SPC.panel.el('small', SPC.panel.t('originalTitle', { title: SPC.conversation.displayTitle({ title: meta.originalTitle ?? conv.title }) || SPC.panel.t('untitled') }), 'muted'));
      if (query && result.snippet) {
        // Snippets are Markdown fragments: render them safely (DOM nodes only), then mark the query terms in place.
        const excerpt = SPC.panel.el('div', null, 'snippet');
        excerpt.append(SPC.markdown.render(result.snippet));
        SPC.search.highlightNodes(excerpt, SPC.panel.$('#conversation-search').value);
        card.append(excerpt);
      }
      if (!query) {
        const preview = summaryPreview(conv.summary?.text); if (preview) card.append(SPC.panel.el('p', preview, 'summary-preview muted'));
      }
      const actions = SPC.panel.el('div', null, 'card-actions');
      const edit = SPC.panel.button('editTitle', () => editTitle(conv)); edit.disabled = Boolean(state.operationController); edit.setAttribute('data-operation-lock', '');
      const menuItems = [edit];
      if (meta.customTitle || meta.originalTitle != null) {
        const revert = SPC.panel.button('revertTitle', () => revertTitle(conv)); revert.disabled = Boolean(state.operationController); revert.setAttribute('data-operation-lock', ''); menuItems.push(revert);
      }
      menuItems.push(exportButton('exportMarkdown', conv, 'md'), exportButton('exportJSON', conv, 'json'));
      const summary = SPC.panel.summaryButton(conv); summary.textContent = SPC.panel.t('cardSummary'); summary.setAttribute('data-operation-lock', '');
      actions.append(SPC.panel.button(meta.pinned ? 'unpin' : 'pin', async () => { await SPC.store.updateConvMeta(conv.key, { pinned: !meta.pinned }); await SPC.panel.refreshLocal(); }),
        SPC.panel.button('cardMove', () => moveConversations([conv.key])), SPC.panel.button('cardTags', () => editTags(conv.key)), summary, SPC.panel.actionMenu(menuItems));
      card.append(actions); SPC.panel.renderSummary(card, conv); list.append(card);
    }
    if (state.search.cursor && state.search.query === SPC.panel.$('#conversation-search').value.trim()) {
      const more = SPC.panel.button('loadMore', () => runSearch(true)); more.id = 'search-more';
      more.disabled = Boolean(state.search.flight || state.operationController); list.append(more);
    }
  }
  function exportButton(key, conv, format) {
    const node = SPC.panel.button(key, () => exportConversations([conv], format)); node.setAttribute('data-operation-lock', ''); node.disabled = Boolean(state.operationController); return node;
  }
  function folderOptions() { return [{ value: '', key: 'unfiled' }, ...state.folders.map(folder => ({ value: folder.id, text: folder.name }))]; }
  function editFolder(folder) {
    SPC.panel.openEditor(folder ? 'editFolder' : 'addFolder', [
      { name: 'name', key: 'folderName', value: folder?.name || '', required: true },
      { name: 'color', key: 'color', type: 'color', value: folder?.color || '#258c7c' }
    ], async values => { await SPC.store.saveFolder({ id: folder?.id, ...values }); await SPC.panel.refreshLocal(); });
  }
  function moveConversations(keys) {
    SPC.panel.openEditor(keys.length > 1 ? 'batchMove' : 'move', [{ name: 'folderId', key: 'folders', type: 'select', options: folderOptions(), value: state.meta[keys[0]]?.folderId || '' }],
      async values => { await SPC.store.updateConvMeta(keys, { folderId: values.folderId || null }); await SPC.panel.refreshLocal(); });
  }
  function editTags(key) {
    SPC.panel.openEditor('editTags', [{ name: 'tags', key: 'tags', value: (state.meta[key]?.tags || []).join(', ') }],
      async values => { await SPC.store.updateConvMeta(key, { tags: SPC.panel.parseTags(values.tags) }); await SPC.panel.refreshLocal(); });
  }
  async function exportConversations(conversations, format, batch = false, confirmed = false, sourceTab = null) {
    if (state.operationController) return;
    const valid = conversations.filter(Boolean); if (!valid.length) return;
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = sourceTab || active, platform = SPC.panel.tabPlatform(tab);
    const downloads = valid.filter(conv => platform && SPC.panel.platformOf(conv) === platform);
    if (state.operationController) return;
    if (batch && downloads.length > 20 && !confirmed) {
      SPC.panel.confirmAction('exportConfirm', { platform: SPC.panel.platformLabel(platform), count: downloads.length, minutes: Math.ceil(downloads.length * SPC.panel.requestDelay() / 60000) },
        () => exportConversations(valid, format, batch, true, tab)); return;
    }
    // Close format/confirmation dialogs so the existing cancel button remains reachable during downloads.
    if (state.editor) { SPC.panel.$('#editor').close(); state.editor = null; }
    const controller = new AbortController(), signal = controller.signal; state.operationController = controller;
    SPC.panel.renderAvailability(); SPC.panel.renderConversations(); SPC.panel.setProgress('exporting', { done: 0, total: valid.length });
    try {
      const exported = [], cached = await SPC.db.getMany(valid.map(conv => conv.key)); SPC.panel.checkCancelled(signal);
      const missing = [...new Set(valid.filter((conv, index) => SPC.panel.platformOf(conv) !== platform && !(cached[index]?.fetchedAt > 0)).map(SPC.panel.platformOf))];
      if (missing.length) throw new Error(SPC.panel.t('exportNeedsBodies', { platforms: missing.map(SPC.panel.platformLabel).join(', ') }));
      for (const [index, conv] of valid.entries()) {
        SPC.panel.setProgress('exporting', { done: exported.length, total: valid.length });
        if (platform && SPC.panel.platformOf(conv) === platform) {
          const { conversation } = await SPC.panel.pacedRequest(tab.id, 'spc:get', { id: conv.id }, signal, true, platform); SPC.panel.checkCancelled(signal);
          if (conversation?.key !== conv.key || SPC.panel.platformOf(conversation) !== platform) throw new Error(SPC.panel.t('invalidResponse'));
          const record = { ...cached[index], ...conversation, platform, fetchedAt: Date.now() };
          await SPC.panel.writeCache(async () => { SPC.panel.checkCancelled(signal); await SPC.db.put(record); });
          exported.push(record); await SPC.panel.refreshCache();
        } else exported.push({ ...cached[index], platform: SPC.panel.platformOf(conv) });
        SPC.panel.checkCancelled(signal); SPC.panel.setProgress('exporting', { done: exported.length, total: valid.length });
      }
      SPC.panel.checkCancelled(signal);
      const titled = exported.map(conv => ({ ...conv, title: displayTitle(conv) }));
      const title = !batch && titled.length === 1 ? titled[0].title : SPC.panel.t('batchTitle');
      const data = format === 'md' ? titled.map(conv => SPC.conversation.toMarkdown(conv)).join('\n---\n\n') : SPC.conversation.toJSON(batch ? titled : titled[0]);
      SPC.panel.download(data, title, format); SPC.panel.status('exportDone', { count: exported.length });
    } catch (error) {
      if (error.name === 'AbortError') SPC.panel.status('cancelled'); else SPC.panel.report(error);
    } finally {
      state.operationController = null; state.progress = null; SPC.panel.renderStatus(); SPC.panel.renderAvailability(); await SPC.panel.refreshCache();
    }
  }
  const formatField = () => ({ name: 'format', key: 'format', type: 'select', value: 'md', options: [{ value: 'md', key: 'exportMarkdown' }, { value: 'json', key: 'exportJSON' }] });
  function exportCurrent() {
    SPC.panel.openEditor('exportCurrent', [formatField()], async values => {
      const tab = await SPC.panel.activeTab(), ping = await SPC.panel.send(tab.id, 'spc:ping');
      if (!ping.currentId) throw new Error(SPC.panel.t('noCurrent'));
      const platform = SPC.panel.tabPlatform(tab);
      await exportConversations([{ key: `${platform}:${ping.currentId}`, platform, id: ping.currentId }], values.format, false, false, tab);
    });
  }
  function titleRecord(item, platform) {
    return { key: `${platform}:${item.id}`, platform, id: item.id, title: item.title, createTime: item.createTime ?? 0,
      updateTime: item.updateTime, messages: [], fetchedAt: 0 };
  }
  async function upsertTitles(items, onlyNew, signal, platform) {
    await SPC.panel.writeCache(async () => {
      SPC.panel.checkCancelled(signal);
      const unique = [...new Map(items.map(item => [item.id, item])).values()];
      const existing = await SPC.db.getMany(unique.map(item => `${platform}:${item.id}`)); SPC.panel.checkCancelled(signal);
      const records = unique.flatMap((item, index) => {
        const old = existing[index];
        if (onlyNew && old) return [];
        return [old ? { ...old, platform, title: item.title, createTime: item.createTime ?? old.createTime, updateTime: item.updateTime } : titleRecord(item, platform)];
      });
      if (records.length) await SPC.db.putMany(records);
    });
    await SPC.panel.refreshCache();
  }
  async function synchronize() {
    if (state.operationController) return;
    const tab = await SPC.panel.activeTab(), platform = SPC.panel.tabPlatform(tab); if (state.operationController) return;
    const controller = new AbortController(); state.operationController = controller;
    const signal = controller.signal; SPC.panel.renderAvailability(); SPC.panel.renderConversations(); SPC.panel.setProgress('listingCount', { count: 0 });
    try {
      // Stopping at an unchanged page is only safe when the previous run listed everything; a cancelled or failed run
      // leaves titlesComplete false. Claude is never ordered strictly by update time, so it always lists every page.
      const sync = SPC.store.normalizeSettings(state.settings).sync[platform];
      const canStopEarly = SPC.platforms[platform].listOrderedByUpdate && sync.titlesComplete;
      await SPC.store.updateSettings({ sync: { [platform]: { ...sync, titlesComplete: false } } });
      const cache = new Map((await SPC.db.getAll()).map(conv => [conv.key, conv]));
      const entries = new Set(); let offset = 0;
      while (true) {
        const page = await SPC.panel.pacedRequest(tab.id, 'spc:list', { offset, limit: 100 }, signal, true, platform); SPC.panel.checkCancelled(signal);
        if (!page.items.length) break;
        const upToDate = page.items.every(item => { const old = cache.get(`${platform}:${item.id}`); return old && old.updateTime === item.updateTime; });
        page.items.forEach(item => entries.add(item.id)); offset += page.items.length;
        await upsertTitles(page.items, false, signal, platform); SPC.panel.checkCancelled(signal);
        SPC.panel.setProgress('listingCount', { count: entries.size });
        // total is only a page-size hint. Stop on a short page or the first entirely unchanged page.
        if (page.items.length < 100 || (canStopEarly && upToDate)) break;
      }
      SPC.panel.checkCancelled(signal); await SPC.store.updateSettings({ sync: { [platform]: { lastSyncAt: Date.now(), titlesComplete: true } } });
      SPC.panel.status('syncDone', { count: (await SPC.db.getAll()).filter(conv => SPC.panel.platformOf(conv) === platform).length });
    } catch (error) {
      if (error.name === 'AbortError') SPC.panel.status('cancelled'); else SPC.panel.report(error);
    } finally {
      state.operationController = null; state.progress = null; SPC.panel.renderStatus(); SPC.panel.renderAvailability();
      await SPC.panel.refreshCache(); await SPC.panel.refreshLocal();
    }
  }
  function editTitle(conv) {
    SPC.panel.openEditor('editTitle', [{ name: 'title', key: 'title', value: displayTitle(conv), maxLength: 200, hint: 'localTitleHint' }], async values => {
      const title = values.title.trim(); if (title && !SPC.conversation.validTitle(title)) throw new Error(SPC.panel.t('invalidTitle'));
      await SPC.store.updateConvMeta(conv.key, { customTitle: title || null }); await SPC.panel.refreshLocal();
    });
  }
  async function revertTitle(conv) {
    const meta = (await SPC.store.get('convMeta', {}))[conv.key] || {}, original = meta.originalTitle, platform = SPC.panel.platformOf(conv);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const fields = original != null ? [{ name: 'sync', label: SPC.panel.t('revertSync', { platform: SPC.panel.platformLabel(platform) }), type: 'checkbox', value: false,
      disabled: SPC.panel.tabPlatform(tab) !== platform || !SPC.conversation.validTitle(original) }] : [];
    SPC.panel.openEditor('revertTitle', fields, async values => {
      await SPC.store.updateConvMeta(conv.key, { customTitle: null }); await SPC.panel.refreshLocal();
      if (values.sync && original != null) await SPC.panel.confirmTitleSync([{ key: conv.key, title: original, revert: true }]);
    }, 'applySelected', { key: original != null ? 'revertSiteHint' : 'revertLocalHint', vars: { platform: SPC.panel.platformLabel(platform) } });
  }
  async function semanticSearch() {
    const search = state.search, generation = search.generation, query = search.query, config = SPC.panel.llmConfig();
    const controller = new AbortController(); search.controller = controller;
    const current = () => !controller.signal.aborted && generation === search.generation && state.searchMode === 'semantic';
    try {
      const cached = new Map(state.conversations.map(conv => [conv.key, conv]));
      const vectors = (await SPC.db.vectors.getAll()).filter(vector => vector.model === config.embeddingModel && cached.has(vector.key)); if (!current()) return;
      if (!config.embeddingModel || !vectors.length) { search.source = { key: 'semanticHint' }; return; }
      if (!query) return;
      search.source = { key: 'semanticSearching' }; SPC.panel.renderSearchSource();
      const [vector] = await SPC.llm.embed(config, [SPC.search.queryText(query, config.embeddingModel)], { signal: controller.signal }); if (!current()) return;
      search.semantic = vectors.filter(item => cached.has(item.key)).map(item => ({ key: item.key, title: displayTitle(cached.get(item.key)),
        score: SPC.search.cosine(vector, item.vector), snippet: cached.get(item.key).summary?.text || '' })).sort((a, b) => b.score - a.score);
      search.source = { key: 'semanticResults' };
    } catch (error) { if (current()) search.source = { key: 'error', vars: { message: error.message } }; }
    finally { if (search.controller === controller) search.controller = null; if (current()) { SPC.panel.renderSearchSource(); SPC.panel.renderConversations(); } }
  }
  function bindSearchMode() {
    SPC.panel.$('#search-mode').addEventListener('change', () => { state.searchMode = SPC.panel.$('#search-mode').value; scheduleSearch(); SPC.panel.renderConversations(); });
  }
  function bindConversationFilters() {
    SPC.panel.$('#conversation-search').addEventListener('input', scheduleSearch);
    SPC.panel.$('#platform-filter').addEventListener('change', () => { state.platformFilter = SPC.panel.$('#platform-filter').value; SPC.panel.renderConversations(); });
  }
  function bindSync() {
    SPC.panel.$('#sync').addEventListener('click', SPC.panel.handle(synchronize));
  }
  function bindConversationActions() {
    SPC.panel.bindMenu(SPC.panel.$('#conversation-menu-button'), SPC.panel.$('#conversation-menu'));
    SPC.panel.$('#manage-folders').addEventListener('click', () => { renderFolderManager(); SPC.panel.$('#folder-manager').showModal(); });
    SPC.panel.$('#folder-manager-close').addEventListener('click', () => SPC.panel.$('#folder-manager').close());
    SPC.panel.$('#export-current').addEventListener('click', exportCurrent);
    SPC.panel.$('#add-folder').addEventListener('click', () => editFolder());
  }
  function bindSelection() {
    const toggle = enabled => { SPC.panel.$('#multi-select').checked = enabled; state.selected.clear(); SPC.panel.renderConversations(); };
    SPC.panel.$('#toggle-multi-select').addEventListener('click', () => toggle(!SPC.panel.$('#multi-select').checked));
    SPC.panel.$('#exit-multi-select').addEventListener('click', () => { toggle(false); SPC.panel.$('#conversation-menu-button').focus(); });
    SPC.panel.$('#multi-select').addEventListener('change', () => { state.selected.clear(); SPC.panel.renderConversations(); });
    SPC.panel.$('#select-all').addEventListener('click', () => { filteredConversations().forEach(({ conv }) => state.selected.add(conv.key)); SPC.panel.renderConversations(); });
    SPC.panel.$('#batch-move').addEventListener('click', () => moveConversations([...state.selected]));
    SPC.panel.$('#batch-export').addEventListener('click', () => {
      const keys = [...state.selected]; SPC.panel.openEditor('batchExport', [formatField()], async values => {
        await SPC.panel.cacheQueue; await exportConversations(await SPC.db.getMany(keys), values.format, true);
      });
    });
  }
  Object.assign(SPC.panel, {
    displayTitle, renderFolders, renderFolderManager, summaryPreview, filteredConversations, renderSearchSource, scheduleSearch, runSearch, renderSelection, renderConversations,
    exportButton, folderOptions, editFolder, moveConversations, editTags, exportConversations, formatField, exportCurrent, titleRecord, upsertTitles,
    synchronize, editTitle, revertTitle, semanticSearch, bindSearchMode, bindConversationFilters, bindSync, bindConversationActions, bindSelection
  });
})();
