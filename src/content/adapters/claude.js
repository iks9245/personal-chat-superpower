(function (root) {
  'use strict';
  const SPC = (root.SPC = root.SPC || {});
  const t = (key, vars) => SPC.i18n.t(key, vars);
  const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  let organization = null, organizationRequest = null;
  async function fetchJSON(path, options = {}, diagnostic) {
    await diagnostic?.beforeRequest();
    let response;
    try {
      response = await fetch(new URL(path, SPC.platforms.claude.origin).href, {
        ...options, credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(45000)
      });
    } catch (_) { throw new Error(t('networkErrorClaude')); }
    if (!response.ok) {
      const error = new Error(t([401, 403].includes(response.status) ? 'authRequiredClaude' : 'requestFailedClaude', { status: response.status }));
      error.status = response.status;
      const header = response.headers.get('retry-after'), seconds = Number(header);
      const retryAfter = Number.isFinite(seconds) ? seconds : (Date.parse(header) - Date.now()) / 1000;
      if (retryAfter > 0) error.retryAfter = retryAfter;
      throw error;
    }
    try { return await response.json(); } catch (_) { throw new Error(t('invalidResponseClaude')); }
  }
  function organizationCookie() {
    return document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith('lastActiveOrg='))?.slice('lastActiveOrg='.length);
  }
  async function getOrganization(diagnostic) {
    const cookie = organizationCookie();
    if (diagnostic?.backfill) {
      if (isUuid(cookie)) return cookie;
      // Same reasoning as ChatGPT's session read: org discovery is a light account call, cached and done at most once
      // per page load, OUTSIDE the one-request budget for the conversation API.
      return getOrganization();
    }
    if (diagnostic) {
      if (diagnostic.organization) return diagnostic.organization;
      if (isUuid(cookie)) { diagnostic.organization = cookie; return cookie; }
      const orgs = await fetchJSON('/api/organizations', {}, diagnostic);
      if (!Array.isArray(orgs)) throw new Error(t('invalidResponseClaude'));
      const org = orgs.find(item => isUuid(item?.uuid) && Array.isArray(item.capabilities) && item.capabilities.includes('chat'));
      if (!org) throw new Error(t('authRequiredClaude'));
      diagnostic.organization = org.uuid; return org.uuid;
    }
    if (isUuid(cookie)) { organization = cookie; return organization; }
    if (organization) return organization;
    if (!organizationRequest) organizationRequest = (async () => {
      const orgs = await fetchJSON('/api/organizations');
      if (!Array.isArray(orgs)) throw new Error(t('invalidResponseClaude'));
      const org = orgs.find(item => isUuid(item?.uuid) && Array.isArray(item.capabilities) && item.capabilities.includes('chat'));
      if (!org) throw new Error(t('authRequiredClaude'));
      organization = org.uuid; return organization;
    })().finally(() => { organizationRequest = null; });
    return organizationRequest;
  }
  const time = value => SPC.conversation.toMilliseconds(value) ?? 0;
  async function listConversations({ offset = 0, limit = 100 } = {}, diagnostic) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error(t('invalidMessage'));
    const org = await getOrganization(diagnostic), data = await fetchJSON(`/api/organizations/${org}/chat_conversations?limit=${limit}&offset=${offset}`, {}, diagnostic);
    if (!Array.isArray(data) || data.some(item => !isUuid(item?.uuid))) throw new Error(t('invalidResponseClaude'));
    const items = data.map(item => ({ id: item.uuid, title: String(item.name || ''), createTime: time(item.created_at), updateTime: time(item.updated_at) }));
    return { items, total: offset + items.length + (items.length === limit ? 1 : 0) };
  }
  async function searchConversations({ query, cursor } = {}, diagnostic) {
    if (typeof query !== 'string' || !query.trim() || query !== query.trim() || query.length > 200 || cursor != null) throw new Error(t('invalidMessage'));
    const org = await getOrganization(diagnostic), data = await fetchJSON(`/api/organizations/${org}/conversation/search/v2`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, n: 50, target_snippet_size: 200 })
    }, diagnostic);
    try { return SPC.conversation.fromClaudeSearch(data); } catch (_) { throw new Error(t('invalidResponseClaude')); }
  }
  async function getConversation(id, diagnostic) {
    if (!isUuid(id)) throw new Error(t('invalidMessage'));
    const org = await getOrganization(diagnostic), data = await fetchJSON(`/api/organizations/${org}/chat_conversations/${id}?tree=True&rendering_mode=messages&render_all_tools=true`, {}, diagnostic);
    if (!Array.isArray(data?.chat_messages)) throw new Error(t('invalidResponseClaude'));
    return { key: `claude:${id}`, platform: 'claude', id, title: String(data.name || ''), createTime: time(data.created_at),
      updateTime: time(data.updated_at), messages: SPC.conversation.linearizeClaude(data.chat_messages, data.current_leaf_message_uuid), fetchedAt: Date.now() };
  }
  async function renameConversation(id, title) {
    if (!isUuid(id) || !SPC.conversation.validTitle(title)) throw new Error(t('invalidMessage'));
    const org = await getOrganization(), data = await fetchJSON(`/api/organizations/${org}/chat_conversations/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: title })
    });
    if (data?.uuid !== id || data.name !== title) throw new Error(t('invalidResponseClaude'));
  }
  function getCurrentConversationId() {
    const id = location.pathname.match(/^\/chat\/([0-9a-f-]{36})(?:\/|$)/i)?.[1]; return isUuid(id) ? id : null;
  }
  const composerSelectors = ['div.ProseMirror[data-testid="chat-input"]',
    '[data-testid="chat-input"][contenteditable="true"]', 'div.ProseMirror[contenteditable="true"]', 'textarea#static-composer-input'];
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
      const started = Date.now(), row = { id, ok: skip ? null : true, ms: 0, fix: 'src/content/adapters/claude.js → ' + fix };
      let value;
      if (skip) { row.category = 'dependency'; row.error = t('diagnosticDependency'); }
      else try { value = await action(); }
      catch (error) {
        if (error.name === 'AbortError') throw error;
        row.ok = false;
        if (Number.isInteger(error.status)) row.status = error.status;
        row.category = error.status ? ([401, 403].includes(error.status) ? 'authRequired' : 'requestFailed') :
          error.message === t('authRequiredClaude') ? 'authRequired' : error.message === t('invalidResponseClaude') ? 'invalidResponse' :
          error.message === t('networkErrorClaude') ? 'networkError' : 'checkFailed';
        row.error = t('diagnosticError_' + row.category);
      }
      row.ms = Date.now() - started; checks.push(row); return value;
    }
    const ready = await check('organization', 'getOrganization', () => getOrganization(diagnostic));
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
  SPC.adapter = { platform: 'claude', diagnose, getOrganization, listConversations, searchConversations, getConversation, renameConversation, getCurrentConversationId,
    conversationUrl: SPC.platforms.claude.conversationUrl, ...composer };
})(globalThis);
