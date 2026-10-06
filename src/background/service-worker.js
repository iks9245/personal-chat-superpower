'use strict';
importScripts('/src/shared/ns.js', '/src/shared/platforms.js', '/src/shared/i18n.js', '/src/shared/storage.js', '/src/shared/llm.js',
  '/src/shared/conversation.js', '/src/shared/search.js', '/src/shared/db.js', '/src/shared/rag.js',
  '/src/shared/summary.js', '/src/shared/digest.js', '/src/shared/backfill.js', '/src/background/backfill.js');
const backfill = SPC.backfillWorker.create({ chrome });
async function ensureBackfillAlarm() {
  const alarm = await chrome.alarms.get(SPC.backfillWorker.ALARM);
  if (!alarm || alarm.periodInMinutes !== 1) await chrome.alarms.create(SPC.backfillWorker.ALARM, { periodInMinutes: 1 });
}
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === SPC.backfillWorker.ALARM) backfill.tick().catch(() => {}); });
const panelPath = 'src/sidepanel/index.html';
async function updateTab(tab) {
  if (tab.id == null) return;
  await chrome.sidePanel.setOptions({ tabId: tab.id, path: panelPath, enabled: Boolean(SPC.platformForUrl(tab.url)) }).catch(() => {});
}
async function configure() {
  await ensureBackfillAlarm();
  await chrome.sidePanel.setOptions({ path: panelPath, enabled: false });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await Promise.all((await chrome.tabs.query({})).map(updateTab));
}
chrome.runtime.onInstalled.addListener(() => { configure().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { configure().catch(() => {}); });
chrome.tabs.onUpdated.addListener((_id, _info, tab) => { updateTab(tab); });
chrome.tabs.onActivated.addListener(({ tabId }) => { chrome.tabs.get(tabId).then(updateTab).catch(() => {}); });
// Also covers service worker restarts and already open supported tabs after reloading the extension.
configure().catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type === 'spc:backfill-settings') {
    // Only extension pages may change background preferences.
    if (sender.tab || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
    backfill.preferences(message.payload || {}).then(value => sendResponse({ ok: true, value }), () => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type !== 'spc:llm-optimize') return false;
  (async () => {
    await SPC.i18n.init();
    if (typeof message.payload?.text !== 'string' || !message.payload.text.trim()) throw new Error(SPC.i18n.t('invalidMessage'));
    const settings = await SPC.store.get('settings', SPC.store.defaults);
    return { ok: true, text: await SPC.llm.optimize(settings.llm, message.payload.text) };
  })().then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
  return true;
});
