(function (root) {
  'use strict';
  const SPC = (root.SPC = root.SPC || {});
  let accessToken = null, tokenRequest = null;
  const t = (key, vars) => SPC.i18n.t(key, vars);
  async function fetchJSON(path, headers = {}, options = {}, diagnostic) {
    await diagnostic?.beforeRequest();
    let response;
    try {
      // Reject redirects rather than following one to any other origin.
      response = await fetch(new URL(path, 'https://chatgpt.com').href, {
        ...options, credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers,
        signal: AbortSignal.timeout(45000)
      });
    } catch (_) { throw new Error(t('networkError')); }
    if (!response.ok) {
      const error = new Error(t('requestFailed', { status: response.status }));
      error.status = response.status;
      const header = response.headers.get('retry-after'), seconds = Number(header);
      const retryAfter = Number.isFinite(seconds) ? seconds : (Date.parse(header) - Date.now()) / 1000;
      if (retryAfter > 0) error.retryAfter = retryAfter;
      throw error;
    }
    try { return await response.json(); } catch (_) { throw new Error(t('invalidResponse')); }
  }
  async function getAccessToken(diagnostic) {
    if (diagnostic?.backfill) {
      // /api/auth/session is ChatGPT's own session poll, not the rate-limited conversation API. It is read at most once
      // per page load (then cached) OUTSIDE the one-request budget. Counting it made the first tick after every page
      // reload fail, which also incremented that conversation's failure count (3 reloads = skipped forever) and burned
      // the day's title-list refresh.
      if (accessToken) return accessToken;
      const session = await fetchJSON('/api/auth/session');
      if (typeof session?.accessToken !== 'string' || !session.accessToken) throw new Error(t('authRequired'));
      return (accessToken = session.accessToken);
    }
    if (diagnostic) {
      if (diagnostic.token) return diagnostic.token;
      const session = await fetchJSON('/api/auth/session', {}, {}, diagnostic);
      if (typeof session?.accessToken !== 'string' || !session.accessToken) throw new Error(t('authRequired'));
      diagnostic.token = session.accessToken; return diagnostic.token;
    }
    if (accessToken) return accessToken;
    if (!tokenRequest) tokenRequest = (async () => {
      let session;
      try { session = await fetchJSON('/api/auth/session'); }
      catch (error) { if (error.status !== 401) throw error; session = await fetchJSON('/api/auth/session'); }
      if (typeof session?.accessToken !== 'string' || !session.accessToken) throw new Error(t('authRequired'));
      accessToken = session.accessToken;
      return accessToken;
    })().finally(() => { tokenRequest = null; });
    return tokenRequest;
  }
  async function request(path, options = {}, diagnostic) {
    if (diagnostic) {
      const token = await getAccessToken(diagnostic);
      try { return await fetchJSON(path, { ...options.headers, Authorization: `Bearer ${token}` }, options, diagnostic); }
      catch (error) { if (diagnostic.backfill && error.status === 401 && accessToken === token) accessToken = null; throw error; }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await getAccessToken();
      try { return await fetchJSON(path, { ...options.headers, Authorization: `Bearer ${token}` }, options); }
      catch (error) {
        if (error.status !== 401) throw error;
        if (accessToken === token) accessToken = null;
        if (attempt === 1) throw new Error(t('authRequired'));
      }
    }
  }
  const time = value => SPC.conversation.toMilliseconds(value) ?? 0;
  async function listConversations({ offset = 0, limit = 100 } = {}, diagnostic) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error(t('invalidMessage'));
    const data = await request(`/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`, {}, diagnostic);
    if (!Array.isArray(data?.items) || !Number.isInteger(data.total) || data.total < 0 || data.items.some(item => !item || typeof item.id !== 'string')) throw new Error(t('invalidResponse'));
    return { items: data.items.map(item => ({ id: item.id, title: String(item.title || ''), createTime: time(item.create_time), updateTime: time(item.update_time) })), total: data.total };
  }
  async function getConversation(id, diagnostic) {
    if (typeof id !== 'string' || !id || /[/?#]/.test(id)) throw new Error(t('invalidMessage'));
    const data = await request(`/backend-api/conversation/${encodeURIComponent(id)}`, {}, diagnostic);
    if (!data?.mapping || typeof data.mapping !== 'object' || typeof data.current_node !== 'string') throw new Error(t('invalidResponse'));
    return { key: `chatgpt:${id}`, platform: 'chatgpt', id, title: String(data.title || ''), createTime: time(data.create_time),
      updateTime: time(data.update_time), messages: SPC.conversation.linearizeChatGPT(data.mapping, data.current_node), fetchedAt: Date.now() };
  }
  async function renameConversation(id, title) {
    if (typeof id !== 'string' || !id || /[/?#]/.test(id) || !SPC.conversation.validTitle(title)) throw new Error(t('invalidMessage'));
    const data = await request(`/backend-api/conversation/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title })
    });
    if (data?.success !== true) throw new Error(t('invalidResponse'));
  }
  async function searchConversations({ query, cursor } = {}, diagnostic) {
    if (typeof query !== 'string' || !query.trim() || query !== query.trim() || query.length > 200 ||
        (cursor != null && (typeof cursor !== 'string' || !/^\d+$/.test(cursor)))) throw new Error(t('invalidMessage'));
    const data = await request(`/backend-api/conversations/search?query=${encodeURIComponent(query)}&cursor=${cursor ?? ''}`, {}, diagnostic);
    try { return SPC.conversation.fromChatGPTSearch(data); } catch (_) { throw new Error(t('invalidResponse')); }
  }
  function getCurrentConversationId() {
    return location.pathname.match(/^\/(?:g\/[^/]+\/)?c\/([^/]+)\/?$/)?.[1] || null;
  }
  // ChatGPT has shipped several composers (ProseMirror #prompt-textarea, later <textarea name="prompt">), so try them in order
  // and prefer one that is actually rendered.
  const composerSelectors = ['#prompt-textarea', 'textarea[name="prompt"]', '#mobile-composer-prompt',
    'form .ProseMirror[contenteditable="true"]', 'form [contenteditable="true"]', 'form textarea'];
  const composer = SPC.composer.create(composerSelectors);
  async function diagnose({ wait = ms => new Promise(resolve => setTimeout(resolve, ms)), signal } = {}) {
    const checks = []; let requests = 0;
    const checkCancelled = () => { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); };
    // Per-run credentials avoid normal authentication retries and stale cached discovery.
    const diagnostic = { beforeRequest: async () => {
      checkCancelled();
      if (requests >= 4) throw new Error(t('diagnosticRequestLimit'));
      if (requests) await wait(1000);
      checkCancelled(); requests++;
    } };
    async function check(id, fix, action, skip = false) {
      checkCancelled();
      const started = Date.now(), row = { id, ok: skip ? null : true, ms: 0, fix: 'src/content/adapters/chatgpt.js → ' + fix };
      let value;
      if (skip) { row.category = 'dependency'; row.error = t('diagnosticDependency'); }
      else try { value = await action(); }
      catch (error) {
        if (error.name === 'AbortError') throw error;
        row.ok = false;
        if (Number.isInteger(error.status)) row.status = error.status;
        row.category = error.status ? ([401, 403].includes(error.status) ? 'authRequired' : 'requestFailed') :
          error.message === t('authRequired') ? 'authRequired' : error.message === t('invalidResponse') ? 'invalidResponse' :
          error.message === t('networkError') ? 'networkError' : 'checkFailed';
        row.error = t('diagnosticError_' + row.category);
      }
      row.ms = Date.now() - started; checks.push(row); return value;
    }
    const ready = await check('session', 'getAccessToken', () => getAccessToken(diagnostic));
    const list = await check('list', 'listConversations', () => listConversations({ offset: 0, limit: 1 }, diagnostic), !ready);
    await check('search', 'searchConversations', () => searchConversations({ query: 'a' }, diagnostic), !ready);
    await check('conversation', 'getConversation', () => getConversation(list.items[0].id, diagnostic), !list?.items.length);
    await check('composer', 'composerSelectors', () => {
      const result = composer.diagnoseComposer();
      if (!result.found || !result.visible) throw new Error(t('composerMissing'));
    });
    const last = checks[checks.length - 1];
    if (!last.ok) { last.category = 'composerMissing'; last.error = t('composerMissing'); }
    return checks;
  }
  SPC.adapter = { platform: 'chatgpt', diagnose, ...composer, getAccessToken, listConversations, searchConversations, getConversation, renameConversation, getCurrentConversationId,
    conversationUrl: SPC.platforms.chatgpt.conversationUrl };
})(globalThis);
