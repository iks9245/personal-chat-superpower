(function (root) {
  'use strict';
  const SPC = (root.SPC = root.SPC || {});
  const platforms = {
    chatgpt: { id: 'chatgpt', label: 'ChatGPT', origin: 'https://chatgpt.com',
      conversationUrl: id => `https://chatgpt.com/c/${encodeURIComponent(id)}`, listOrderedByUpdate: true },
    claude: { id: 'claude', label: 'Claude', origin: 'https://claude.ai',
      conversationUrl: id => `https://claude.ai/chat/${encodeURIComponent(id)}`, listOrderedByUpdate: false }
  };
  function platformForUrl(url) {
    try { return Object.values(platforms).find(platform => platform.origin === new URL(url).origin)?.id || null; }
    catch (_) { return null; }
  }
  function platformOfKey(key) { return typeof key === 'string' && key.includes(':') ? key.slice(0, key.indexOf(':')) : null; }
  SPC.platforms = platforms; SPC.platformForUrl = platformForUrl; SPC.platformOfKey = platformOfKey;
  if (typeof module !== 'undefined' && module.exports) module.exports = { platforms, platformForUrl, platformOfKey };
})(globalThis);
