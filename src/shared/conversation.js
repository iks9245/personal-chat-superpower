(function (root) {
  'use strict';
  const SPC = (root.SPC = root.SPC || {});
  // Site titles sometimes start with Markdown residue ("*React…") or end with stray letters from an unrelated
  // script ("整理旅行行程 പദ്ധ"). Only a TRAILING run in a script other than the title's main ones is dropped, and only
  // when something in a kept script remains, so a title written entirely in any one language is left alone.
  const keptScript = /[\p{Script=Han}\p{Script=Latin}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u;
  const otherLetter = /[\p{L}\p{M}]/u;
  function cleanTitle(text) {
    let title = String(text || '').replace(/\s+/g, ' ').trim().replace(/^[*#>\s]+/, '').replace(/[*\s]+$/, '');
    const chars = [...title];
    let end = chars.length;
    while (end > 0 && (/\s/.test(chars[end - 1]) || (otherLetter.test(chars[end - 1]) && !keptScript.test(chars[end - 1])))) end--;
    if (end < chars.length && chars.slice(0, end).some(char => keptScript.test(char))) title = chars.slice(0, end).join('').trim();
    return title;
  }
  function displayTitle(conv, meta) { return cleanTitle(meta?.customTitle || conv.title); }
  function validTitle(title) { return typeof title === 'string' && title === title.trim() && title.length > 0 && title.length <= 200 && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(title); }
  function toMilliseconds(value) {
    if (value == null || value === '') return null;
    const ms = typeof value === 'number' ? value * 1000 : Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  function fromChatGPTSearch(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.items) ||
        (body.cursor != null && (typeof body.cursor !== 'string' || !/^\d*$/.test(body.cursor)))) throw new Error('invalid');
    const items = body.items.flatMap(item => {
      if (!item || typeof item.conversation_id !== 'string') return [];
      if ((item.title != null && typeof item.title !== 'string') ||
          (item.update_time != null && (typeof item.update_time !== 'number' || !Number.isFinite(item.update_time * 1000))) ||
          (item.is_archived != null && typeof item.is_archived !== 'boolean') ||
          (item.payload != null && (typeof item.payload !== 'object' || Array.isArray(item.payload))) ||
          (item.payload?.snippet != null && typeof item.payload.snippet !== 'string')) throw new Error('invalid');
      return [{ id: item.conversation_id, title: item.title || '', updateTime: toMilliseconds(item.update_time) ?? 0,
        snippet: item.payload?.snippet || '', archived: item.is_archived === true }];
    });
    return { items, cursor: body.items.length ? body.cursor || null : null };
  }
  function codeBlock(text, language) {
    const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), m => m[0].length));
    const fence = '`'.repeat(longest + 1);
    return `${fence}${String(language || '').replace(/[^\w+-]/g, '')}\n${text}\n${fence}`;
  }
  function linearizeChatGPT(mapping, currentNode) {
    const branch = [], seen = new Set();
    let id = currentNode;
    while (id && mapping && Object.prototype.hasOwnProperty.call(mapping, id) && !seen.has(id)) {
      seen.add(id);
      const node = mapping[id];
      if (!node || typeof node !== 'object') break;
      branch.push(node.message);
      id = node.parent;
    }
    return branch.reverse().flatMap(message => {
      if (!message || !['user', 'assistant'].includes(message.author?.role) ||
          message.metadata?.is_visually_hidden_from_conversation === true) return [];
      const content = message.content || {};
      let text;
      if (content.content_type === 'code') {
        const source = typeof content.text === 'string' ? content.text : '';
        text = source.trim() ? codeBlock(source, content.language) : '';
      } else {
        text = (Array.isArray(content.parts) ? content.parts : [])
          .map(part => typeof part === 'string' ? part : '[attachment]').join('\n');
      }
      return text.trim() ? [{ role: message.author.role, text, time: toMilliseconds(message.create_time) }] : [];
    });
  }
  function linearizeClaude(messages, leafUuid) {
    const list = (Array.isArray(messages) ? messages : []).filter(message => message && typeof message.uuid === 'string');
    const byId = new Map(list.map(message => [message.uuid, message])), seen = new Set();
    let branch = [], id = leafUuid;
    if (!byId.has(id)) branch = list.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    else {
      while (byId.has(id) && !seen.has(id)) {
        seen.add(id); const message = byId.get(id); branch.push(message); id = message.parent_message_uuid;
      }
      branch.reverse();
    }
    return branch.flatMap(message => {
      const role = message.sender === 'human' ? 'user' : message.sender === 'assistant' ? 'assistant' : null;
      if (!role) return [];
      const parts = (Array.isArray(message.content) ? message.content : []).filter(item => item?.type === 'text');
      let text = parts.length ? parts.map(item => typeof item.text === 'string' ? item.text : '').join('\n\n') : typeof message.text === 'string' ? message.text : '';
      const attachments = [message.files, message.attachments].flatMap(items => Array.isArray(items) ? items : []);
      if (attachments.length) text = [text, ...attachments.map(() => '[attachment]')].filter(Boolean).join('\n');
      return text.trim() ? [{ role, text, time: toMilliseconds(message.created_at) }] : [];
    });
  }
  function fromClaudeSearch(body) {
    if (!Array.isArray(body?.data)) throw new Error('invalid');
    const items = body.data.flatMap(item => {
      const conv = item?.conversation;
      if (typeof conv?.uuid !== 'string') return [];
      return [{ id: conv.uuid, title: typeof conv.name === 'string' ? conv.name : '', updateTime: toMilliseconds(conv.updated_at) ?? 0,
        snippet: typeof item.matched_snippet?.text === 'string' ? item.matched_snippet.text : '', archived: conv.is_archived === true }];
    });
    return { items, cursor: null };
  }
  function toMarkdown(conv, meta) {
    const title = displayTitle(conv, meta) || conv.id || '';
    const messages = (conv.messages || []).map(message => `## ${message.role}\n\n${message.text}`);
    const source = conv.platform ? `> ${SPC.platforms?.[conv.platform]?.label || conv.platform}\n\n` : '';
    return `# ${title}\n\n${source}${messages.join('\n\n---\n\n')}\n`;
  }
  function toJSON(conv) { return JSON.stringify(conv, null, 2); }
  SPC.conversation = { cleanTitle, displayTitle, validTitle, linearizeChatGPT, linearizeClaude, fromChatGPTSearch, fromClaudeSearch, toMarkdown, toJSON, toMilliseconds };
  if (typeof module !== 'undefined' && module.exports) module.exports = SPC.conversation;
})(globalThis);
