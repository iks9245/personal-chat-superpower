(function (root) {
  'use strict';
  const SPC = (root.SPC = root.SPC || {});
  // No adapter, fetch, or tab messaging: only cached records and directory handles.
  async function writeVault({ directory, rootFolder, plan, vaultIndex = {}, saveIndex = async () => {}, signal, onProgress = () => {} }) {
    const v = SPC.vault;
    v.validateRoot(rootFolder);
    const manifest = { ...vaultIndex }, report = { created: 0, updated: 0, unchanged: 0, moved: 0, skipped: 0, skippedPaths: [], cancelled: false };
    function parts(path) {
      const names = path.split('/');
      if (names.length < 2 || names[0] !== rootFolder || names.some(name => !name || name === '.' || name === '..' || /^[.]/.test(name) || /[/\\:*?"<>|#^\[\]\x00-\x1f\x7f-\x9f]/.test(name) || /[. ]$/.test(name))) throw new Error('vaultInvalidRoot');
      return names;
    }
    for (const entry of plan.entries) parts(entry.path);
    async function parent(path, create = false) {
      const names = parts(path), name = names.pop(); let dir = directory;
      for (const segment of names) dir = await dir.getDirectoryHandle(segment, { create });
      return { dir, name };
    }
    async function read(path) {
      try {
        const { dir, name } = await parent(path);
        let handle;
        try { handle = await dir.getFileHandle(name); } catch (error) { if (error.name === 'TypeMismatchError') return { hash: null }; throw error; }
        return { hash: v.hashBytes(new Uint8Array(await (await handle.getFile()).arrayBuffer())) };
      } catch (error) {
        if (error.name === 'NotFoundError') return null;
        throw error;
      }
    }
    function skip(path) { if (!report.skippedPaths.includes(path)) { report.skippedPaths.push(path); report.skipped++; } }
    async function commit(key, path, hash) {
      manifest[key] = { path, hash };
      await saveIndex({ ...manifest });
    }
    async function write(entry, index = false) {
      const old = manifest[entry.key];
      // Changing root never grants access to the previous root.
      const owned = old && old.path.split('/')[0] === rootFolder ? old : null;
      if (owned) {
        parts(owned.path);
        const current = await read(owned.path);
        if (current && current.hash !== owned.hash) { skip(owned.path); return owned.path; }
      }
      const base = entry.basePath || entry.path; let path = entry.path, attempt = 0;
      while (true) {
        const other = Object.entries(manifest).some(([key, value]) => key !== entry.key && v.pathKey(value.path) === v.pathKey(path));
        const current = await read(path);
        if (owned?.path === path && current && current.hash !== owned.hash) { skip(path); return owned.path; }
        if (!other && (!current || (owned?.path === path && current.hash === owned.hash))) break;
        path = v.collisionPath(base, entry.conv || { platform: 'pcs', id: 'index' }, ++attempt);
      }
      const existing = await read(path);
      if (owned?.path === path && existing?.hash !== undefined && existing.hash !== owned.hash) { skip(path); return owned.path; }
      if (existing?.hash === entry.hash && owned?.path === path) { if (!index) report.unchanged++; return path; }
      const { dir, name } = await parent(path, true);
      // Recheck after directory creation, immediately before opening a writable.
      const before = await read(path);
      if (before && (owned?.path !== path || before.hash !== owned.hash)) { skip(path); return owned?.path; }
      if (owned && owned.path !== path) {
        const previous = await read(owned.path);
        if (previous && previous.hash !== owned.hash) { skip(owned.path); return owned.path; }
      }
      const handle = await dir.getFileHandle(name, { create: true }), stream = await handle.createWritable();
      try { await stream.write(new TextEncoder().encode(entry.content)); await stream.close(); }
      catch (error) { await stream.abort?.().catch(() => {}); throw error; }
      // Persist each completed file, including on cancellation or later I/O failure.
      await commit(entry.key, path, entry.hash);
      if (!index && owned && owned.path !== path) {
        const previous = await read(owned.path);
        if (previous && previous.hash === owned.hash) {
          const oldParent = await parent(owned.path);
          await oldParent.dir.removeEntry(oldParent.name);
          if (!index) report.moved++;
        } else if (previous) { skip(owned.path); report.created++; }
        else report.created++;
      } else if (!index) { if (existing) report.updated++; else report.created++; }
      return path;
    }
    const entries = [], total = plan.entries.length + 1; let done = 0;
    onProgress({ done, total });
    for (let entry of plan.entries) {
      if (signal?.aborted) { report.cancelled = true; break; }
      // Resolve citations against the actual paths, including protected edits and collision suffixes.
      if (entry.digest) {
        const content = v.renderDigest(entry.digest, entries.filter(item => !item.digest));
        entry = { ...entry, content, hash: v.hashContent(content) };
      }
      const path = await write(entry);
      if (path) entries.push({ ...entry, path: path.slice(rootFolder.length + 1) });
      onProgress({ done: ++done, total });
    }
    if (!signal?.aborted) {
      const key = '@index:' + rootFolder, content = v.renderIndex(entries);
      await write({ key, path: manifest[key]?.path || `${rootFolder}/${v.INDEX}`, content, hash: v.hashContent(content) }, true);
      onProgress({ done: ++done, total });
    } else report.cancelled = true;
    return { ...report, vaultIndex: manifest };
  }
  SPC.vaultWriter = { writeVault };
  if (typeof module !== 'undefined' && module.exports) module.exports = SPC.vaultWriter;
  if (!SPC.panel) return;
  const { state, $, t } = SPC.panel;
  let saved = { handle: null, vaultIndex: {}, rootFolder: 'AI 對話', scope: 'pinnedOrFiled' }, fallback = false, result;
  function renderVault() {
    state.vaultName = saved.handle?.name; SPC.panel.renderSettingsStatus();
    $('#quick-vault-export').disabled = Boolean(state.operationController);
    $('#vault-name').textContent = saved.handle?.name || t('vaultNone');
    $('#vault-zip').hidden = !fallback;
    $('#vault-fallback').hidden = !fallback;
    const busy = Boolean(state.operationController);
    for (const id of ['vault-choose', 'vault-forget', 'vault-root', 'vault-scope', 'vault-zip']) $('#' + id).disabled = busy;
    $('#vault-export').disabled = busy || !saved.handle;
    $('#vault-forget').disabled = busy || !saved.handle;
    $('#vault-report').textContent = result ? (result.cancelled ? t('cancelled') + ' ' : '') + t('vaultReport', result) : '';
    const details = $('#vault-skipped'); details.hidden = !result?.skippedPaths.length; details.replaceChildren();
    details.append(SPC.panel.el('summary', t('vaultEdited')));
    for (const path of result?.skippedPaths || []) details.append(SPC.panel.el('p', path));
  }
  async function persist() { await SPC.db.keyval.set('vault', saved); }
  function options() {
    const rootFolder = $('#vault-root').value, scope = $('#vault-scope').value;
    SPC.vault.validateRoot(rootFolder);
    if (!['pinnedOrFiled', 'all', 'withContent'].includes(scope)) throw new Error('vaultInvalidScope');
    return { rootFolder, scope };
  }
  const restricted = error => ['SecurityError', 'NotAllowedError'].includes(error.name);
  const vaultError = error => new Error(t(error.message?.startsWith('vault') ? error.message : 'vaultIOError'));
  async function chooseVault() {
    if (state.operationController) return;
    if (typeof root.showDirectoryPicker !== 'function') { fallback = true; renderVault(); return; }
    // Start picker synchronously from the click, before IDB/lock awaits consume activation.
    let picking;
    try { picking = root.showDirectoryPicker({ mode: 'readwrite', id: 'pcs-vault' }); }
    catch (error) { if (restricted(error)) { fallback = true; renderVault(); return; } throw error; }
    picking = Promise.resolve(picking).then(handle => ({ handle }), error => ({ error }));
    await SPC.panel.localOperation(async () => {
      try {
        const choice = await picking;
        if (choice.error) throw choice.error;
        const handle = choice.handle;
        const same = saved.handle && await handle.isSameEntry(saved.handle);
        saved = { ...saved, handle, vaultIndex: same ? saved.vaultIndex : {} };
        await persist(); fallback = false; result = undefined;
      } catch (error) { if (restricted(error)) fallback = true; else if (error.name !== 'AbortError') throw vaultError(error); }
      finally { renderVault(); }
    });
  }
  async function recordExport(ok, details = {}) {
    state.vaultLastExport = { ok, at: Date.now(), ...details };
    await SPC.store.set('vaultLastExport', state.vaultLastExport);
    SPC.panel.renderSettingsStatus();
  }
  async function quickExportVault() {
    if (state.operationController) return;
    if (!saved.handle) { await SPC.panel.openSettingsSection('vault'); SPC.panel.status('vaultChooseFirst'); return; }
    return exportVault();
  }
  async function exportVault(zip = false) {
    if (state.operationController) return;
    SPC.panel.stopQASearch();
    let settings;
    try { settings = options(); } catch (error) { throw vaultError(error); }
    if (!zip && !saved.handle) return;
    // Permission request stays in this click handler, before localOperation's storage awaits.
    const permission = zip ? Promise.resolve('granted') : (async () => {
      try {
        if (await saved.handle.queryPermission({ mode: 'readwrite' }) === 'granted') return 'granted';
        return await saved.handle.requestPermission({ mode: 'readwrite' });
      } catch (error) { if (restricted(error)) return 'denied'; throw error; }
    })();
    state.exportingVault = true;
    await SPC.panel.localOperation(async signal => {
      try {
        if (await permission !== 'granted') { fallback = true; await recordExport(false); await SPC.panel.openSettingsSection('vault'); return; }
        saved = { ...saved, ...settings }; await persist();
        const [conversations, meta, folders, digests] = await Promise.all([SPC.db.getAll(), SPC.store.get('convMeta', {}), SPC.store.get('folders', []), SPC.db.digests.getAll()]);
        const plan = SPC.vault.planExport({ conversations, digests, meta, folders, ...settings, vaultIndex: zip ? {} : saved.vaultIndex });
        if (zip) {
          SPC.panel.checkCancelled(signal);
          const entries = plan.entries.map(entry => ({ ...entry, path: entry.path.slice(settings.rootFolder.length + 1) }));
          const files = [...plan.entries, { path: `${settings.rootFolder}/${SPC.vault.INDEX}`, content: SPC.vault.renderIndex(entries) }];
          SPC.panel.download(SPC.vault.buildZip(files), settings.rootFolder, 'zip'); SPC.panel.status('vaultZipDone');
        } else {
          result = await writeVault({ directory: saved.handle, ...settings, plan, vaultIndex: saved.vaultIndex, signal,
            onProgress: vars => SPC.panel.setProgress('vaultProgress', vars),
            saveIndex: async vaultIndex => { saved = { ...saved, vaultIndex }; await persist(); } });
          await recordExport(!result.cancelled, { cancelled: result.cancelled, created: result.created, updated: result.updated, unchanged: result.unchanged, moved: result.moved, skipped: result.skipped });
        }
      } catch (error) { if (!zip) await recordExport(false); if (restricted(error)) fallback = true; else throw vaultError(error); }
      finally { state.exportingVault = false; renderVault(); }
    });
  }
  async function bindVault() {
    saved = { ...saved, ...await SPC.db.keyval.get('vault') };
    fallback = typeof root.showDirectoryPicker !== 'function';
    $('#vault-root').value = saved.rootFolder; $('#vault-scope').value = saved.scope;
    $('#vault-choose').addEventListener('click', SPC.panel.handle(chooseVault));
    $('#quick-vault-export').addEventListener('click', SPC.panel.handle(quickExportVault));
    $('#vault-export').addEventListener('click', SPC.panel.handle(() => exportVault()));
    $('#vault-zip').addEventListener('click', SPC.panel.handle(() => exportVault(true)));
    $('#vault-forget').addEventListener('click', SPC.panel.handle(() => SPC.panel.localOperation(async () => {
      saved = { ...saved, handle: null, vaultIndex: {} }; await persist(); result = undefined; renderVault();
    })));
    renderVault();
  }
  Object.assign(SPC.panel, { bindVault, renderVault, exportVault, chooseVault });
})(globalThis);
