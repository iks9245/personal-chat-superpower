'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const d = require('../src/shared/digest.js');
const row = (key, updateTime, summary) => ({ key, title: key, updateTime, ...(summary ? { summary: { text: summary } } : {}) });
test('ISO weeks span year boundaries and validate nonexistent week IDs', () => {
  assert.equal(d.weekOf(new Date(2026, 11, 31)), '2026-W53');
  assert.equal(d.weekOf(new Date(2027, 0, 1)), '2026-W53');
  assert.equal(d.weekOf(new Date(2027, 0, 4)), '2027-W01');
  assert.deepEqual(d.weekRange('2026-W53'), { start: new Date(2026, 11, 28).getTime(), end: new Date(2027, 0, 4).getTime() });
  assert.equal(d.previousWeek('2027-W01'), '2026-W53');
  for (const value of ['2026-W00', '2027-W53', '../W41', '2026-W1']) assert.throws(() => d.weekRange(value));
});
test('week ranges are DST-safe local Monday midnights, with 167/169-hour weeks', () => {
  const old = process.env.TZ; process.env.TZ = 'America/New_York';
  try {
    for (const [week, hours] of [['2026-W10', 167], ['2026-W44', 169]]) {
      const range = d.weekRange(week);
      for (const time of [range.start, range.end]) { assert.equal(new Date(time).getDay(), 1); assert.equal(new Date(time).getHours(), 0); }
      assert.equal((range.end - range.start) / 3600000, hours);
      assert.equal(d.weekOf(range.start), week);
    }
  } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
});
test('selection includes all platforms and unfiled records, using [start, end) and display metadata', () => {
  const range = d.weekRange('2026-W41'), rows = [row('chatgpt:before', range.start - 1), row('chatgpt:start', range.start), row('claude:last', range.end - 1), row('claude:end', range.end)];
  const result = d.selectWeekConversations(rows, { 'chatgpt:start': { customTitle: 'Display', folderName: 'Folder', tags: ['tag'] } }, range);
  assert.deepEqual(result.map(item => item.key), ['claude:last', 'chatgpt:start']);
  assert.equal(result[0].folder, '未分類'); assert.equal(result[1].title, 'Display'); assert.equal(result[1].folder, 'Folder'); assert.deepEqual(result[1].tags, ['tag']);
});
test('digest messages number summary-first items, keep source order and include only the preceding four complete reviews', () => {
  const input = { week: '2027-W02', items: [{ ...row('claude:title', 10), platform: 'claude' }, { ...row('chatgpt:summary', 1, 'Summary'), title: 'Display', platform: 'chatgpt', folder: 'Folder', tags: ['tag'] }],
    previous: ['2027-W01', '2026-W53', '2026-W52', '2026-W51', '2026-W50', '2027-W02'].map(week => ({ week, text: week + 'x'.repeat(1600) })) };
  const result = d.prepare(input), messages = d.buildDigestMessages(input), text = messages[1].content;
  assert.deepEqual(result.messages, messages); assert.equal(messages[0].content, d.SYSTEM_PROMPT);
  assert.match(text, /\[1\] Display（ChatGPT，Folder，tag）\nSummary/); assert.match(text, /\[2\] claude:title（Claude，未分類，）\n（只有標題）/);
  assert.deepEqual(result.sources.map(source => source.key), ['chatgpt:summary', 'claude:title']);
  assert.ok(text.includes('2026-W51')); assert.ok(!text.includes('2026-W50')); assert.ok(!text.includes('x'.repeat(1500)));
  assert.ok(!d.buildDigestMessages({ ...input, previous: [{ week: '2027-W01', text: 'PARTIAL', partial: true }] })[1].content.includes('PARTIAL'));
});
test('20,000-character budget truncates summaries, reserves title-only items and drops oldest overflow deterministically', () => {
  const items = Array.from({ length: 600 }, (_, i) => ({ ...row('chatgpt:' + i, i, i < 300 ? 's'.repeat(1000) : undefined), platform: 'chatgpt', title: 'Title ' + i + 't'.repeat(50) }));
  const input = { week: '2026-W41', items, previous: [] }, result = d.prepare(input), text = result.messages[1].content;
  assert.ok(text.length <= 20000); assert.equal(result.sources[0].key, 'chatgpt:299'); assert.ok(result.sources.length < items.length);
  assert.ok(!result.sources.some(source => source.key === 'chatgpt:0'));
  const small = d.prepare({ ...input, items: [{ ...items[0], summary: { text: 'x'.repeat(50000) } }, items[599]] });
  assert.equal(small.sources.length, 2); assert.ok(small.messages[1].content.length <= 20000); assert.match(small.messages[1].content, /（只有標題）/);
  const titles = d.prepare({ ...input, items: items.map(item => ({ ...item, summary: undefined })) });
  assert.equal(titles.sources[0].key, 'chatgpt:599'); assert.ok(!titles.sources.some(source => source.key === 'chatgpt:0'));
});
test('automatic due time is Monday 06:00 local and refers only to last week', () => {
  assert.equal(d.dueWeek(new Date(2027, 0, 4, 5, 59).getTime()), null);
  assert.equal(d.dueWeek(new Date(2027, 0, 4, 6).getTime()), '2026-W53');
  assert.equal(d.dueWeek(new Date(2027, 0, 10, 23).getTime()), '2026-W53');
});

test('previous reviews lose their own [n] citations so [n] only refers to this week', () => {
  const D = require('../src/shared/digest.js');
  const messages = D.buildDigestMessages({ week: '2026-W41', items: [], previous: [{ week: '2026-W40', text: '- 資料層 [1][2]\n- 估值 [3]' }] });
  const content = messages.map(m => m.content).join('\n');
  assert.ok(content.includes('- 資料層\n- 估值')); assert.doesNotMatch(content.split('2026-W40')[1] || '', /\[\d+\]/);
});
