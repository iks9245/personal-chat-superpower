(function (root) {
  'use strict';
  const SPC = (root.SPC = root.SPC || {});
  let opening;
  function open() {
    if (!opening) opening = new Promise((resolve, reject) => {
      const request = indexedDB.open('spc', 5);
      request.onupgradeneeded = () => {
        upgrade(request.result);
      };
      request.onerror = () => { opening = undefined; reject(request.error); };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); opening = undefined; };
        resolve(db);
      };
    });
    return opening;
  }
  function upgrade(db) {
    for (const name of ['conversations', 'vectors', 'keyval']) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'key' });
    if (!db.objectStoreNames.contains('digests')) db.createObjectStore('digests', { keyPath: 'week' });
    if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: 'key' }).createIndex('convKey', 'convKey', { unique: false });
  }
  async function clear() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['conversations', 'vectors', 'chunks'], 'readwrite');
      tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error);
      tx.objectStore('conversations').clear(); tx.objectStore('vectors').clear(); tx.objectStore('chunks').clear();
    });
  }
  async function transact(mode, callback, name = 'conversations') {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, mode);
      let requests;
      tx.oncomplete = () => resolve(Array.isArray(requests) ? requests.map(request => request.result) : requests.result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error(SPC.i18n.t('databaseError')));
      try { requests = callback(tx.objectStore(name)); } catch (error) { tx.abort(); reject(error); }
    });
  }
  SPC.db = {
    open, upgrade, put: conv => transact('readwrite', store => store.put(conv)),
    putMany: convs => transact('readwrite', store => convs.map(conv => store.put(conv))),
    get: key => transact('readonly', store => store.get(key)),
    getAll: () => transact('readonly', store => store.getAll()),
    getMany: keys => transact('readonly', store => keys.map(key => store.get(key))),
    clear,
    count: () => transact('readonly', store => store.count())
  };
  SPC.db.digests = {
    get: week => transact('readonly', store => store.get(week), 'digests'),
    getAll: () => transact('readonly', store => store.getAll(), 'digests'),
    put: value => transact('readwrite', store => store.put(value), 'digests'),
    delete: week => transact('readwrite', store => store.delete(week), 'digests')
  };
  SPC.db.keyval = {
    get: async key => (await transact('readonly', store => store.get(key), 'keyval'))?.value,
    set: (key, value) => transact('readwrite', store => store.put({ key, value }), 'keyval'),
    delete: key => transact('readwrite', store => store.delete(key), 'keyval')
  };
  SPC.db.vectors = {
    get: key => transact('readonly', store => store.get(key), 'vectors'),
    put: value => transact('readwrite', store => store.put(value), 'vectors'),
    putMany: values => transact('readwrite', store => values.map(value => store.put(value)), 'vectors'),
    getAll: () => transact('readonly', store => store.getAll(), 'vectors'),
    clear: () => transact('readwrite', store => store.clear(), 'vectors'),
    count: () => transact('readonly', store => store.count(), 'vectors'),
    delete: key => transact('readwrite', store => store.delete(key), 'vectors')
  };
  SPC.db.chunks = {
    putMany: values => transact('readwrite', store => values.map(value => store.put(value)), 'chunks'),
    getAll: () => transact('readonly', store => store.getAll(), 'chunks'),
    clear: () => transact('readwrite', store => store.clear(), 'chunks'),
    count: () => transact('readonly', store => store.count(), 'chunks'),
    delete: keys => transact('readwrite', store => (Array.isArray(keys) ? keys : [keys]).map(key => store.delete(key)), 'chunks'),
    deleteByConv: convKey => transact('readwrite', store => {
      const request = store.index('convKey').openCursor(convKey);
      request.onsuccess = () => { const cursor = request.result; if (cursor) { cursor.delete(); cursor.continue(); } };
      return request;
    }, 'chunks')
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = SPC.db;
})(globalThis);
