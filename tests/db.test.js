'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
test('IndexedDB v5 upgrade is safe for fresh, v1, v2, v3 and v4 databases without recreating conversations', () => {
  const db = require('../src/shared/db.js');
  for (const initial of [[], ['conversations'], ['conversations', 'vectors'], ['conversations', 'vectors', 'chunks'], ['conversations', 'vectors', 'keyval', 'chunks']]) {
    const stores = new Set(initial), created = [];
    db.upgrade({ objectStoreNames: { contains: name => stores.has(name) }, createObjectStore: (name, options) => { assert.equal(options.keyPath, name === 'digests' ? 'week' : 'key'); assert.ok(!stores.has(name)); stores.add(name); created.push(name); return { createIndex: (index, path, options) => { assert.equal(name, 'chunks'); assert.equal(index, 'convKey'); assert.equal(path, 'convKey'); assert.equal(options.unique, false); } }; } });
    assert.deepEqual([...stores], [...initial, ...['conversations', 'vectors', 'keyval', 'digests', 'chunks'].filter(name => !initial.includes(name))]); assert.deepEqual(created, ['conversations', 'vectors', 'keyval', 'digests', 'chunks'].filter(name => !initial.includes(name)));
  }
});
test('db opens version 5 and clears conversations, vectors and chunks in the same transaction', async () => {
  const cleared = [], stores = new Set(['conversations']); let request, transactionNames;
  const context = vm.createContext({ indexedDB: { open: (name, version) => {
    assert.equal(name, 'spc'); assert.equal(version, 5); request = { result: { objectStoreNames: { contains: name => stores.has(name) }, createObjectStore: name => { stores.add(name); return { createIndex() {} }; }, transaction: (names, mode) => {
      transactionNames = names; assert.equal(mode, 'readwrite');
      const tx = { objectStore: name => ({ clear: () => { cleared.push(name); } }) }; queueMicrotask(() => tx.oncomplete()); return tx;
    } } }; queueMicrotask(() => { request.onupgradeneeded(); request.onsuccess(); }); return request;
  } } });
  vm.runInContext(fs.readFileSync(require.resolve('../src/shared/db.js'), 'utf8'), context);
  await context.SPC.db.clear(); assert.deepEqual([...stores], ['conversations', 'vectors', 'keyval', 'digests', 'chunks']); assert.deepEqual(Array.from(transactionNames), ['conversations', 'vectors', 'chunks']); assert.deepEqual(cleared, ['conversations', 'vectors', 'chunks']);
});

test('chunk DB helpers preserve typed vectors, delete keys/by-conversation, count and clear', async () => {
  const values = new Map();
  const database = { transaction: (name, mode) => {
    assert.equal(name, 'chunks'); assert.ok(['readonly', 'readwrite'].includes(mode)); let pending = 0;
    const tx = { objectStore: () => store }, request = action => {
      const result = {}; pending++;
      queueMicrotask(() => { result.result = action(); result.onsuccess?.(); if (!--pending) queueMicrotask(() => tx.oncomplete()); }); return result;
    };
    const store = { put: value => request(() => values.set(value.key, structuredClone(value))), getAll: () => request(() => [...values.values()]),
      count: () => request(() => values.size), delete: key => request(() => values.delete(key)), clear: () => request(() => values.clear()),
      index: name => { assert.equal(name, 'convKey'); return { openCursor: key => {
        const matches = [...values.values()].filter(value => value.convKey === key), result = {}; let i = 0; pending++;
        const next = () => queueMicrotask(() => { const value = matches[i++]; result.result = value ? { delete: () => values.delete(value.key), continue: next } : null;
          result.onsuccess(); if (!value && !--pending) queueMicrotask(() => tx.oncomplete()); }); next(); return result;
      } }; }
    }; return tx;
  } };
  const context = vm.createContext({ indexedDB: { open: () => { const request = { result: database }; queueMicrotask(() => request.onsuccess()); return request; } } });
  vm.runInContext(fs.readFileSync(require.resolve('../src/shared/db.js'), 'utf8'), context); const chunks = context.SPC.db.chunks;
  await chunks.putMany([{ key: 'a#0', convKey: 'a', vector: new Float32Array([1, 0]) }, { key: 'a#1', convKey: 'a' }, { key: 'b#0', convKey: 'b' }]);
  assert.equal(await chunks.count(), 3); assert.ok((await chunks.getAll())[0].vector instanceof Float32Array);
  await chunks.deleteByConv('a'); assert.deepEqual((await chunks.getAll()).map(value => value.key), ['b#0']);
  await chunks.delete(['b#0']); assert.equal(await chunks.count(), 0);
  await chunks.putMany([{ key: 'c#0', convKey: 'c' }]); await chunks.clear(); assert.equal(await chunks.count(), 0);
});

test('keyval stores and restores vault handle/manifest without JSON serialization', async () => {
  const rows = new Map();
  const context = vm.createContext({ indexedDB: { open: () => {
    const request = { result: { transaction: (name, mode) => {
      assert.equal(name, 'keyval'); assert.ok(['readonly', 'readwrite'].includes(mode));
      const tx = { objectStore: () => ({ get: key => ({ result: rows.get(key) }), put: value => { rows.set(value.key, value); return {}; }, delete: key => { rows.delete(key); return {}; } }) };
      queueMicrotask(() => tx.oncomplete()); return tx;
    } } }; queueMicrotask(() => request.onsuccess()); return request;
  } } });
  vm.runInContext(fs.readFileSync(require.resolve('../src/shared/db.js'), 'utf8'), context);
  const handle = { name: 'Vault', getDirectoryHandle() {} }, value = { handle, vaultIndex: { 'chatgpt:c': { path: 'AI 對話/F/C.md', hash: '123' } } };
  await context.SPC.db.keyval.set('vault', value);
  assert.equal((await context.SPC.db.keyval.get('vault')).handle, handle);
  assert.deepEqual((await context.SPC.db.keyval.get('vault')).vaultIndex, value.vaultIndex);
  await context.SPC.db.keyval.delete('vault'); assert.equal(await context.SPC.db.keyval.get('vault'), undefined);
});

test('digests persist by week and are removed only by explicit digest delete', async () => {
  const rows = new Map();
  const context = vm.createContext({ indexedDB: { open: () => {
    const request = { result: { transaction: (name, mode) => {
      assert.equal(name, 'digests'); assert.ok(['readonly', 'readwrite'].includes(mode));
      const tx = { objectStore: () => ({ get: week => ({ result: rows.get(week) }), getAll: () => ({ result: [...rows.values()] }), put: value => { rows.set(value.week, structuredClone(value)); return {}; }, delete: week => { rows.delete(week); return {}; } }) };
      queueMicrotask(() => tx.oncomplete()); return tx;
    } } }; queueMicrotask(() => request.onsuccess()); return request;
  } } });
  vm.runInContext(fs.readFileSync(require.resolve('../src/shared/db.js'), 'utf8'), context);
  const api = context.SPC.db.digests, value = { week: '2026-W41', text: 'User content', sources: [], partial: false };
  await api.put(value); assert.deepEqual(await api.get(value.week), value); assert.equal((await api.getAll()).length, 1);
  await api.delete(value.week); assert.equal((await api.getAll()).length, 0);
});
