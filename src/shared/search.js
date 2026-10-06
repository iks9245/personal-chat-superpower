(function (root) {
  'use strict';
  const SPC = (root.SPC = root.SPC || {});
  const conversation = SPC.conversation || (typeof require === 'function' ? require('./conversation.js') : null);
  function terms(query) { return [...new Set(String(query || '').toLowerCase().trim().split(/\s+/).filter(Boolean))]; }
  function snippet(text, keywords, size = 180) {
    const lower = text.toLowerCase();
    const positions = keywords.map(word => lower.indexOf(word)).filter(index => index >= 0);
    const hit = positions.length ? Math.min(...positions) : 0;
    const start = Math.max(0, hit - 45);
    const end = Math.min(text.length, start + Math.max(size, (keywords.find(word => lower.indexOf(word) === hit) || '').length + 45));
    return (start ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
  }
  function search(conversations, query, meta = {}) {
    const keywords = terms(query);
    return conversations.flatMap(conv => {
      const title = conversation.displayTitle(conv, meta[conv.key]);
      const body = (conv.messages || []).map(message => message.text || '').join('\n');
      const lowerTitle = [title, conv.title || '', meta[conv.key]?.originalTitle || ''].join('\n').toLowerCase(), lowerBody = body.toLowerCase();
      if (!keywords.every(word => lowerTitle.includes(word) || lowerBody.includes(word))) return [];
      const score = keywords.reduce((total, word) => total + (lowerTitle.includes(word) ? 5 : 0) + (lowerBody.includes(word) ? 1 : 0), 0);
      return [{ key: conv.key, title, score, snippet: snippet(body || title, keywords) }];
    }).sort((a, b) => b.score - a.score);
  }
  function mergeResults(localResults, remoteItems, platform = 'chatgpt') {
    const local = new Map(localResults.map(result => [result.key, result])), seen = new Set(), results = [];
    for (const item of remoteItems) {
      const key = `${platform}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key); results.push({ key, title: item.title, snippet: item.snippet, remote: true, score: local.get(key)?.score ?? 0 });
    }
    for (const result of localResults.slice().sort((a, b) => b.score - a.score)) {
      if (seen.has(result.key)) continue;
      seen.add(result.key); results.push({ key: result.key, title: result.title, snippet: result.snippet, remote: false, score: result.score });
    }
    return results;
  }
  // Merged, sorted [start, end) ranges of every query term in text (case-insensitive, literal).
  function matchRanges(text, query) {
    const source = String(text), lower = source.toLowerCase(), ranges = [];
    for (const word of terms(query)) {
      let from = 0, index;
      while ((index = lower.indexOf(word, from)) !== -1) { ranges.push([index, index + word.length]); from = index + word.length; }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]); else merged.push(range.slice());
    }
    return merged;
  }
  // Wraps matches in <mark> inside already-rendered nodes (e.g. SPC.markdown output), so highlighting needs no HTML
  // strings at all. Matching is per text node: a term split across formatting boundaries is not marked.
  function highlightNodes(root, query) {
    const doc = root.ownerDocument;
    for (const node of [...root.childNodes]) {
      if (node.nodeType !== 3) { highlightNodes(node, query); continue; }
      const text = node.nodeValue, ranges = matchRanges(text, query);
      if (!ranges.length) continue;
      let from = 0;
      for (const [start, end] of ranges) {
        if (start > from) root.insertBefore(doc.createTextNode(text.slice(from, start)), node);
        const mark = doc.createElement('mark'); mark.textContent = text.slice(start, end); root.insertBefore(mark, node); from = end;
      }
      if (from < text.length) root.insertBefore(doc.createTextNode(text.slice(from)), node);
      root.removeChild(node);
    }
    return root;
  }
  function documentText(conv, meta) {
    return `${conversation.displayTitle(conv, meta)}\n${conv.summary?.text || ''}\n${(conv.messages || []).map(message => message.text || '').join('\n').slice(0, 1500)}`;
  }
  function hash(text) {
    let value = 2166136261;
    for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
    return (value >>> 0).toString(16);
  }
  function normalizeVector(vector) {
    const norm = Math.hypot(...vector);
    if (!norm || !Number.isFinite(norm)) throw new Error(SPC.i18n?.t('llmInvalid') || 'Invalid vector');
    return Float32Array.from(vector, value => value / norm);
  }
  function cosine(a, b) {
    if (a.length !== b.length || !a.length) return -1;
    let dot = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
    return aa && bb ? Math.max(-1, Math.min(1, dot / Math.sqrt(aa * bb))) : -1;
  }
  function queryText(query, model) {
    return /qwen3.*embed/i.test(model) ? `Instruct: Given a search query, retrieve relevant chat conversations\nQuery: ${query}` : query;
  }
  SPC.search = { documentText, hash, normalizeVector, cosine, queryText, search, mergeResults, terms, matchRanges, highlightNodes };
  if (typeof module !== 'undefined' && module.exports) module.exports = SPC.search;
})(globalThis);
