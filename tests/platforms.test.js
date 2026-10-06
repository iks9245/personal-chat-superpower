'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { platforms, platformForUrl, platformOfKey } = require('../src/shared/platforms.js');
test('platform URLs accept only exact supported HTTPS origins', () => {
  for (const [id, platform] of Object.entries(platforms)) {
    assert.equal(platform.id, id); assert.equal(platformForUrl(platform.origin + '/anything'), id);
    assert.equal(platformForUrl(platform.conversationUrl('a/b?')), id);
    assert.ok(platform.conversationUrl('a/b?').endsWith('a%2Fb%3F'));
  }
  for (const url of [undefined, null, '', '/chat/id', 'http://claude.ai', 'https://claude.ai.evil.com', 'https://evil.com/claude.ai', 'https://chatgpt.com:123']) assert.equal(platformForUrl(url), null);
  assert.equal(platforms.chatgpt.listOrderedByUpdate, true); assert.equal(platforms.claude.listOrderedByUpdate, false);
});
test('platformOfKey returns the prefix before the first colon', () => {
  assert.equal(platformOfKey('claude:a:b'), 'claude'); assert.equal(platformOfKey('chatgpt:a'), 'chatgpt');
  assert.equal(platformOfKey('future:a'), 'future'); assert.equal(platformOfKey('invalid'), null); assert.equal(platformOfKey(null), null);
});
test('manifest loads each platform adapter after shared dependencies and the panel loads no adapter', () => {
  const fs = require('node:fs'), path = require('node:path'), root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, '0.4.0'); assert.equal(manifest.content_scripts.length, 2);
  assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/*', 'https://claude.ai/*', 'http://127.0.0.1/*', 'http://localhost/*', 'https://127.0.0.1/*', 'https://localhost/*', 'http://[::1]/*', 'https://[::1]/*']);
  for (const entry of manifest.content_scripts) {
    const platform = platformForUrl(entry.matches[0]);
    assert.deepEqual(entry.js, ['src/shared/ns.js', 'src/shared/i18n.js', 'src/shared/storage.js', 'src/shared/prompt-vars.js',
      'src/shared/platforms.js', 'src/shared/conversation.js', 'src/content/composer.js', `src/content/adapters/${platform}.js`, 'src/content/prompt-palette.js', 'src/content/main.js']);
    for (const script of entry.js) assert.ok(fs.existsSync(path.join(root, script)));
  }
  const panel = fs.readFileSync(path.join(root, 'src/sidepanel/index.html'), 'utf8');
  assert.ok(panel.includes('../shared/platforms.js')); assert.ok(!panel.includes('/adapters/')); assert.ok(panel.includes('id="platform-filter"'));
});
test('background enables the side panel for both supported origins only', async () => {
  const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path'), calls = [], listener = { addListener() {} };
  const context = vm.createContext({ URL, setTimeout, clearTimeout, chrome: { alarms: { get: async () => ({ periodInMinutes: 1 }), onAlarm: listener }, sidePanel: { setOptions: async value => { calls.push(value); }, setPanelBehavior: async () => {} },
    tabs: { query: async () => [{ id: 1, url: 'https://chatgpt.com' }, { id: 2, url: 'https://claude.ai/chat/id' }, { id: 3, url: 'https://example.com' }], onUpdated: listener, onActivated: listener },
    runtime: { onMessage: listener, onInstalled: listener, onStartup: listener } } });
  context.importScripts = (...scripts) => scripts.forEach(script => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', script), 'utf8'), context));
  vm.runInContext(fs.readFileSync(require.resolve('../src/background/service-worker.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.filter(call => call.tabId).map(call => [call.tabId, call.enabled]), [[1, true], [2, true], [3, false]]);
});
