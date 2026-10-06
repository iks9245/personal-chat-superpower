'use strict';
const assert = require('node:assert/strict');
function tree() {
  const files = new Map(), dirs = new Set(['']), events = []; let beforeDelete, afterWrite;
  const error = name => Object.assign(new Error(name), { name });
  function directory(path = '') {
    const child = name => path ? path + '/' + name : name;
    return { name: path || 'Vault',
      async getDirectoryHandle(name, { create = false } = {}) {
        assert.ok(name && !/[\/\\]/.test(name) && !['.', '..'].includes(name));
        const next = child(name); if (files.has(next)) throw error('TypeMismatchError');
        if (!dirs.has(next)) { if (!create) throw error('NotFoundError'); dirs.add(next); events.push(['mkdir', next]); }
        return directory(next);
      },
      async getFileHandle(name, { create = false } = {}) {
        const next = child(name); if (dirs.has(next)) throw error('TypeMismatchError');
        if (!files.has(next)) { if (!create) throw error('NotFoundError'); files.set(next, new Uint8Array()); }
        return { async getFile() { events.push(['read', next]); const data = files.get(next); return { arrayBuffer: async () => data.slice().buffer }; },
          async createWritable() { let data; return { write: async value => { data = typeof value === 'string' ? new TextEncoder().encode(value) : value; }, close: async () => { files.set(next, data); events.push(['write', next]); await afterWrite?.(next); }, abort: async () => {} }; } };
      },
      async removeEntry(name) { const next = child(name); await beforeDelete?.(next); events.push(['delete', next]); files.delete(next); }
    };
  }
  function put(path, text) { const segments = path.split('/'); segments.pop(); while (segments.length) { dirs.add(segments.join('/')); segments.pop(); } files.set(path, new TextEncoder().encode(text)); }
  return { directory: directory(), files, dirs, events, put, text: path => new TextDecoder().decode(files.get(path)), afterWrite: fn => { afterWrite = fn; } };
}
module.exports = tree;
