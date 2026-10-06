'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
test('service worker rejects foreign senders and optimizes only the supplied text using stored local config', async () => {
  let listener; const calls = [], event = { addListener() {} }, config = { baseUrl: 'http://localhost:11123/v1', apiKey: 'secret' };
  const context = vm.createContext({ importScripts() {}, SPC: { backfillWorker: { ALARM: 'spc-summary-backfill', create: () => ({ tick: async () => {} }) }, platformForUrl: () => null, i18n: { init: async () => {}, t: key => key },
    store: { get: async () => ({ llm: config }) }, llm: { optimize: async (...args) => { calls.push(args); return 'optimized'; } } },
    chrome: { alarms: { get: async () => ({ periodInMinutes: 1 }), onAlarm: event }, sidePanel: { setOptions: async () => {}, setPanelBehavior: async () => {} }, tabs: { query: async () => [], onUpdated: event, onActivated: event },
      runtime: { id: 'ours', onInstalled: event, onStartup: event, onMessage: { addListener: fn => { listener = fn; } } } } });
  vm.runInContext(fs.readFileSync(require.resolve('../src/background/service-worker.js'), 'utf8'), context);
  assert.equal(listener({ type: 'spc:llm-optimize', payload: { text: 'private' } }, { id: 'foreign' }, () => assert.fail()), false); assert.equal(calls.length, 0);
  const send = payload => new Promise(resolve => assert.equal(listener({ type: 'spc:llm-optimize', payload }, { id: 'ours' }, resolve), true));
  assert.equal((await send({ text: 'private', baseUrl: 'https://evil.test' })).text, 'optimized'); assert.equal(calls[0][0], config); assert.equal(calls[0][1], 'private');
  assert.equal((await send({ text: 123 })).ok, false); assert.equal(calls.length, 1);
});

test('worker installs a one-minute alarm, dispatches only its ticks and authenticates preference changes', async () => {
  const listeners = {}, alarms = [], event = name => ({ addListener: fn => { listeners[name] = fn; } }); let ticks = 0, changes = 0;
  const context = vm.createContext({ importScripts() {}, SPC: { backfillWorker: { ALARM: 'spc-summary-backfill', create: () => ({ tick: async () => { ticks++; }, preferences: async patch => { changes++; return patch; } }) }, platformForUrl: () => null },
    chrome: { alarms: { get: async () => null, create: async (...args) => alarms.push(args), onAlarm: event('alarm') },
      sidePanel: { setOptions: async () => {}, setPanelBehavior: async () => {} }, tabs: { query: async () => [], onUpdated: event('updated'), onActivated: event('activated') },
      runtime: { id: 'ours', getURL: () => 'chrome-extension://ours/', onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message') } } });
  vm.runInContext(fs.readFileSync(require.resolve('../src/background/service-worker.js'), 'utf8'), context); await new Promise(resolve => setImmediate(resolve));
  assert.ok(alarms.length); alarms.forEach(([name, value]) => { assert.equal(name, 'spc-summary-backfill'); assert.equal(value.periodInMinutes, 1); });
  listeners.alarm({ name: 'unrelated' }); assert.equal(ticks, 0); listeners.alarm({ name: 'spc-summary-backfill' }); assert.equal(ticks, 1);
  const message = { type: 'spc:backfill-settings', payload: { enabled: true } };
  for (const sender of [{ id: 'foreign' }, { id: 'ours', tab: { id: 1 }, url: 'https://chatgpt.com/' }]) assert.equal(listeners.message(message, sender, () => assert.fail()), false);
  const result = await new Promise(resolve => listeners.message(message, { id: 'ours', url: 'chrome-extension://ours/src/sidepanel/index.html' }, resolve));
  assert.equal(result.ok, true); assert.equal(changes, 1);
});
