(function (root) {
  'use strict';
  const SPC = (root.SPC = root.SPC || {});
  function localDay(now = Date.now()) {
    const date = new Date(now);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function nextMidnight(now = Date.now()) { const date = new Date(now); date.setHours(24, 0, 0, 0); return date.getTime(); }
  function rollover(value, now = Date.now()) { return value.day === localDay(now) ? value : { ...value, day: localDay(now), doneToday: 0 }; }
  function scoped(records, meta, folders) {
    const ids = new Set(folders.map(folder => folder.id));
    return records.filter(conv => meta[conv.key]?.pinned === true || ids.has(meta[conv.key]?.folderId));
  }
  const hasSummary = conv => typeof conv.summary?.text === 'string' && Boolean(conv.summary.text.trim());
  const isStale = conv => hasSummary(conv) && conv.updateTime > (conv.summary.createdAt || 0) + 10 * 60000;
  function candidates(records, meta, folders, failures = {}, platforms) {
    return scoped(records, meta, folders).filter(conv => (!hasSummary(conv) || isStale(conv)) && !(failures[conv.key] >= 3) &&
      (!platforms || platforms.has(conv.platform || conv.key.split(':')[0])))
      .sort((a, b) => Number(hasSummary(a)) - Number(hasSummary(b)) || Number(meta[b.key]?.pinned === true) - Number(meta[a.key]?.pinned === true) || (b.updateTime || 0) - (a.updateTime || 0) || a.key.localeCompare(b.key));
  }
  function stats(records, meta, folders) {
    const scope = scoped(records, meta, folders), done = scope.filter(hasSummary).length;
    return { total: scope.length, done, remaining: scope.length - done, stale: scope.filter(isStale).length };
  }
  SPC.backfill = { localDay, nextMidnight, rollover, scoped, hasSummary, isStale, candidates, stats };
  if (typeof module !== 'undefined' && module.exports) module.exports = SPC.backfill;
})(globalThis);
