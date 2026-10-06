(function (root) {
  'use strict';
  const SPC = (root.SPC = root.SPC || {});
  const conversation = SPC.conversation || require('./conversation.js');
  const search = SPC.search || require('./search.js');
  const platforms = SPC.platforms || require('./platforms.js').platforms;
  const DEFAULT_ROOT = 'AI 對話';
  const LABELS = {
    'zh-TW': {
      index: '索引.md', weeklyFolder: '週報', weeklyTitle: '週報 ', unfiled: '未分類', unnamed: '未命名',
      summary: '## 摘要', conversation: '## 對話', user: '### 🧑 你',
      bodyMissing: '（內文尚未下載。可在擴充功能中匯出或使用背景補摘要。）',
      weeklyReviews: '## 週報', weeklyConversations: '## 本週對話', sourceOpen: '（', sourceClose: '）'
    },
    en: {
      index: 'Index.md', weeklyFolder: 'Weekly', weeklyTitle: 'Weekly review ', unfiled: 'Unfiled', unnamed: 'Untitled',
      summary: '## Summary', conversation: '## Conversation', user: '### 🧑 You',
      bodyMissing: '(Body not downloaded yet. Export it from the extension or enable background summaries.)',
      weeklyReviews: '## Weekly reviews', weeklyConversations: '## Conversations this week', sourceOpen: ' (', sourceClose: ')'
    }
  };
  const labels = (lang = 'zh-TW') => LABELS[lang === 'en' ? 'en' : 'zh-TW'];
  const INDEX = labels().index;
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  function safeSegment(text, { lang = 'zh-TW' } = {}) {
    let value = String(text ?? '').replace(/[/\\:*?"<>|#^\[\]\x00-\x1f\x7f-\x9f]/g, '').replace(/\s+/g, ' ').trim().replace(/^[. ]+/, '').slice(0, 80).replace(/[. ]+$/, '');
    // Windows device names are reserved even when followed by an extension.
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) value = '_' + value.slice(0, 79);
    return value || labels(lang).unnamed;
  }
  function validateRoot(value = DEFAULT_ROOT) {
    if (typeof value !== 'string' || !value || value !== safeSegment(value)) throw new Error('vaultInvalidRoot');
    return value;
  }
  const pathKey = path => path.normalize('NFD').toLowerCase();
  const platformOf = conv => conv.platform || conv.key.split(':')[0];
  const folderOf = (meta, folders) => folders.find(folder => folder.id === meta?.folderId);
  function collisionPath(path, conv, attempt = 1, { lang = 'zh-TW' } = {}) {
    if (!attempt) return path;
    const suffix = ` (${safeSegment(platformOf(conv), { lang })} ${safeSegment(String(conv.id).slice(0, 6), { lang })}${attempt > 1 ? ' ' + attempt : ''})`;
    const slash = path.lastIndexOf('/');
    return path.slice(0, slash + 1) + path.slice(slash + 1, -3).slice(0, Math.max(1, 80 - suffix.length)) + suffix + '.md';
  }
  // Optional occupied Map is shared by the planner; keys are canonical paths, values conversation keys.
  function notePath(conv, meta = {}, folders = [], rootFolder = DEFAULT_ROOT, occupied = new Map(), { lang = 'zh-TW' } = {}) {
    const base = `${validateRoot(rootFolder)}/${safeSegment(folderOf(meta, folders)?.name || labels(lang).unfiled, { lang })}/${safeSegment(conversation.displayTitle(conv, meta), { lang })}.md`;
    let path = base, attempt = 0;
    while (occupied.has(pathKey(path)) && occupied.get(pathKey(path)) !== conv.key) path = collisionPath(base, conv, ++attempt, { lang });
    return path;
  }
  function obsidianTag(tag) {
    const value = String(tag ?? '').trim().replace(/^#+/, '').replace(/\s+/g, '-').replace(/[^\p{L}\p{M}\p{N}_\-/]/gu, '').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
    return value && !/^\p{N}+$/u.test(value) ? value : '';
  }
  const quote = value => JSON.stringify(String(value ?? '')).replace(/[\x7f-\x9f\u2028\u2029]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
  function localDay(value) {
    if (!Number.isFinite(value)) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  // Embedded summaries and replies have their own "## …" headings; left as-is they sit at the same level as the note's
  // 「## 摘要」/「## 對話」 sections and scramble Obsidian's outline. Shift them so the shallowest one becomes minLevel
  // (capped at h6), leaving fenced code untouched.
  function nestHeadings(text, minLevel) {
    const lines = String(text).split('\n'); let fence = null, shallowest = 7;
    const scan = action => lines.map(line => {
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (marker) { if (!fence) fence = marker[1][0]; else if (marker[1][0] === fence) fence = null; return line; }
      const heading = !fence && line.match(/^(#{1,6})(\s.*)?$/);
      return heading ? action(line, heading) : line;
    });
    scan((line, heading) => { shallowest = Math.min(shallowest, heading[1].length); return line; });
    const shift = Math.max(0, minLevel - shallowest); fence = null;
    return shift ? scan((line, heading) => '#'.repeat(Math.min(6, heading[1].length + shift)) + (heading[2] || '')).join('\n') : String(text);
  }
  function renderNote(conv, meta = {}, { folders = [], platformLabel, lang = 'zh-TW' } = {}) {
    const l = labels(lang);
    const platform = platformOf(conv), folder = folderOf(meta, folders), title = conversation.displayTitle(conv, meta);
    const lines = ['---', `title: ${quote(title)}`];
    if (meta.customTitle) lines.push(`aliases: [${quote(meta.originalTitle ?? conv.title)}]`);
    lines.push(`platform: ${quote(platform)}`, `source: ${quote(platforms[platform]?.conversationUrl(conv.id) || '')}`,
      `created: ${quote(localDay(conv.createTime))}`, `updated: ${quote(localDay(conv.updateTime))}`);
    if (folder) lines.push(`folder: ${quote(folder.name)}`);
    lines.push(`tags: [${[...new Set((meta.tags || []).map(obsidianTag).filter(Boolean))].map(quote).join(', ')}]`, `pinned: ${meta.pinned === true}`);
    if (conv.summary?.text) lines.push(`summary_model: ${quote(conv.summary.model)}`);
    lines.push('exported_by: personal-chat-superpower', '---', '');
    if (conv.summary?.text) lines.push(l.summary, '', nestHeadings(conv.summary.text, 3), '');
    lines.push(l.conversation, '');
    const messages = (conv.messages || []).filter(message => ['user', 'assistant'].includes(message.role) && message.text);
    if (!messages.length) lines.push(l.bodyMissing, '');
    for (const message of messages) lines.push(message.role === 'user' ? l.user : `### 🤖 ${platformLabel || platforms[platform]?.label || platform}`, '', nestHeadings(message.text, 4), '');
    return lines.join('\n');
  }
  const linkLabel = text => String(text).replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/[|\[\]]/g, '');
  function renderDigest(digest, notes = [], { lang = 'zh-TW' } = {}) {
    const l = labels(lang);
    const lines = ['---', `title: ${quote(l.weeklyTitle + digest.week)}`, 'type: weekly-review', `week: ${quote(digest.week)}`,
      `start: ${quote(localDay(digest.start))}`, `end: ${quote(localDay(digest.end))}`, `model: ${quote(digest.model)}`,
      'exported_by: personal-chat-superpower', '---', '', nestHeadings(digest.text, 2), '', l.weeklyConversations, ''];
    digest.sources.forEach((source, index) => {
      const note = notes.find(entry => entry.key === source.key), title = linkLabel(source.title);
      lines.push(`${index + 1}. ` + (note ? `[[${note.path.replace(/\.md$/, '')}|${title}]]` : `${title}${l.sourceOpen}${linkLabel(platforms[source.platform]?.label || source.platform)}${l.sourceClose}`));
    });
    return lines.join('\n') + '\n';
  }
  function renderIndex(entries, { lang = 'zh-TW' } = {}) {
    const l = labels(lang);
    const groups = new Map(), lines = ['---', 'exported_by: personal-chat-superpower', '---', ''];
    for (const entry of entries.filter(entry => !entry.digest)) { const folder = entry.folder || l.unfiled; if (!groups.has(folder)) groups.set(folder, []); groups.get(folder).push(entry); }
    const label = text => String(text).replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/[|\[\]]/g, '');
    for (const folder of [...groups.keys()].sort((a, b) => a === b ? 0 : a === l.unfiled ? 1 : b === l.unfiled ? -1 : compare(a, b))) {
      lines.push(`## ${label(folder)}`, '');
      for (const entry of groups.get(folder).sort((a, b) => (b.updated || 0) - (a.updated || 0) || compare(a.path, b.path))) {
        lines.push(`- [[${entry.path.replace(/\.md$/, '')}|${label(entry.title)}]]`);
      }
      lines.push('');
    }
    const reviews = entries.filter(entry => entry.digest).sort((a, b) => compare(b.digest.week, a.digest.week));
    if (reviews.length) {
      lines.push(l.weeklyReviews, '');
      for (const entry of reviews) lines.push(`- [[${entry.path.replace(/\.md$/, '')}|${l.weeklyTitle}${entry.digest.week}]]`);
      lines.push('');
    }
    return lines.join('\n');
  }
  // Feed exact UTF-8 bytes to the existing string hash (one code unit per byte).
  function hashBytes(bytes) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return search.hash(text);
  }
  const hashContent = content => hashBytes(new TextEncoder().encode(content));
  function planExport({ conversations, digests = [], meta = {}, folders = [], rootFolder = DEFAULT_ROOT, vaultIndex = {}, scope = 'pinnedOrFiled', lang = 'zh-TW' }) {
    const l = labels(lang);
    validateRoot(rootFolder);
    if (!['pinnedOrFiled', 'all', 'withContent'].includes(scope)) throw new Error('vaultInvalidScope');
    const occupied = new Map(Object.entries(vaultIndex).map(([key, value]) => [pathKey(value.path), key]));
    const reviews = digests.filter(digest => !digest.partial && /^\d{4}-W\d{2}$/.test(digest.week)).sort((a, b) => compare(b.week, a.week));
    for (const digest of reviews) occupied.set(pathKey(`${rootFolder}/${l.weeklyFolder}/${digest.week}.md`), 'digest:' + digest.week);
    const writes = [], moves = [], entries = []; let unchanged = 0;
    for (const conv of [...conversations].sort((a, b) => compare(a.key, b.key))) {
      const m = meta[conv.key] || {};
      if (scope === 'pinnedOrFiled' && !m.pinned && !folderOf(m, folders)) continue;
      if (scope === 'withContent' && !conv.summary?.text?.trim() && !(conv.messages || []).some(message => ['user', 'assistant'].includes(message.role) && message.text?.trim())) continue;
      let path = notePath(conv, m, folders, rootFolder, occupied, { lang });
      const old = vaultIndex[conv.key], base = notePath(conv, m, folders, rootFolder, undefined, { lang });
      // Retain a previously allocated suffix even if its former competitor disappeared.
      if (old && pathKey(old.path) === pathKey(path)) path = old.path;
      else if (old) {
        const attempt = Number(old.path.match(/ (\d+)\)\.md$/)?.[1] || 1);
        if (old.path === collisionPath(base, conv, attempt, { lang })) path = old.path;
      }
      occupied.set(pathKey(path), conv.key);
      const content = renderNote(conv, m, { folders, lang }), hash = hashContent(content);
      const entry = { key: conv.key, path, basePath: base, content, hash, title: conversation.displayTitle(conv, m), folder: folderOf(m, folders)?.name || l.unfiled, updated: conv.updateTime, conv };
      entries.push(entry);
      if (old?.path === path && old.hash === hash) unchanged++; else writes.push({ key: conv.key, path, content, hash });
      if (old && old.path !== path) moves.push({ key: conv.key, from: old.path, to: path });
    }
    for (const digest of reviews) {
      const key = 'digest:' + digest.week, path = `${rootFolder}/${l.weeklyFolder}/${digest.week}.md`, old = vaultIndex[key];
      const content = renderDigest(digest, entries.map(entry => ({ ...entry, path: entry.path.slice(rootFolder.length + 1) })), { lang }), hash = hashContent(content);
      const entry = { key, path, content, hash, digest, conv: { platform: 'digest', id: digest.week }, title: l.weeklyTitle + digest.week };
      entries.push(entry);
      if (old?.path === path && old.hash === hash) unchanged++; else writes.push({ key, path, content, hash });
      if (old && old.path !== path) moves.push({ key, from: old.path, to: path });
    }
    return { writes, moves, unchanged, entries };
  }
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function buildZip(entries) {
    if (entries.length > 65535) throw new Error('vaultZipTooLarge');
    const encoder = new TextEncoder(), locals = [], central = []; let offset = 0, centralSize = 0;
    for (const entry of entries) {
      const name = encoder.encode(entry.path), data = encoder.encode(entry.content), crc = crc32(data);
      if (name.length > 65535 || data.length > 0xffffffff) throw new Error('vaultZipTooLarge');
      const local = new Uint8Array(30 + name.length + data.length), l = new DataView(local.buffer);
      l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x800, true); l.setUint16(12, 33, true);
      l.setUint32(14, crc, true); l.setUint32(18, data.length, true); l.setUint32(22, data.length, true); l.setUint16(26, name.length, true);
      local.set(name, 30); local.set(data, 30 + name.length);
      const record = new Uint8Array(46 + name.length), c = new DataView(record.buffer);
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true); c.setUint16(14, 33, true);
      c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true); record.set(name, 46);
      locals.push(local); central.push(record); offset += local.length; centralSize += record.length;
      if (offset + centralSize > 0xffffffff) throw new Error('vaultZipTooLarge');
    }
    const end = new Uint8Array(22), e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true); e.setUint32(12, centralSize, true); e.setUint32(16, offset, true);
    const zip = new Uint8Array(offset + centralSize + end.length); let position = 0;
    for (const part of [...locals, ...central, end]) { zip.set(part, position); position += part.length; }
    return zip;
  }
  SPC.vault = { DEFAULT_ROOT, INDEX, labels, safeSegment, validateRoot, pathKey, collisionPath, notePath, obsidianTag, nestHeadings, renderNote, renderDigest, renderIndex, hashBytes, hashContent, planExport, crc32, buildZip };
  if (typeof module !== 'undefined' && module.exports) module.exports = SPC.vault;
})(globalThis);
