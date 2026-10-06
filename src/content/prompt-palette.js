(function (root) {
  'use strict';
  const SPC = (root.SPC = root.SPC || {});
  const t = (key, vars) => SPC.i18n.t(key, vars);
  let host, shadow, windowBox, prompts = [], query = '', index = 0, chosen = null, values = Object.create(null), busy = false;
  let optimizeGeneration = 0, optimizing = false;
  let previousFocus, consuming = false, initialized = false, notice = '';
  const style = `
    :host{all:initial;color-scheme:light dark;font:14px/1.5 system-ui,sans-serif;color:#1d2630}
    *{box-sizing:border-box} .overlay{position:fixed;inset:0;background:#0005;display:flex;justify-content:center;align-items:flex-start;padding:12vh 16px 24px;z-index:2147483647}
    .window{width:min(560px,100%);max-height:75vh;overflow:auto;border:1px solid #d4dce3;border-radius:14px;background:#fff;box-shadow:0 20px 70px #0005;padding:16px}
    header,.row{display:flex;align-items:center;justify-content:space-between;gap:8px} h2{font-size:17px;margin:0}button,input{font:inherit;color:inherit}
    button{cursor:pointer;border:1px solid #c7d0d9;background:#f2f5f7;border-radius:6px;padding:6px 10px}button:disabled{opacity:.5;cursor:wait}
    input{display:block;width:100%;padding:9px;border:1px solid #bdc8d2;background:#fff;border-radius:6px;margin:8px 0}
    button:focus-visible,input:focus-visible{outline:2px solid #167a70;outline-offset:2px} .item{display:block;text-align:left;width:100%;margin-top:6px;background:transparent}
    .item[aria-selected=true]{background:#e2f3ef;border-color:#238779} strong,small{display:block;overflow-wrap:anywhere}small,.help{color:#566573}.preview{white-space:pre-wrap}.help{font-size:12px;margin-top:12px}
    .notice{color:#a63229;white-space:pre-wrap}label{display:block;margin-top:12px}
    @media(prefers-color-scheme:dark){:host{color:#e5edf4}.window{background:#19232d;border-color:#46515d}input{background:#111b24;border-color:#50606e}button{background:#283440;border-color:#536270}.item[aria-selected=true]{background:#16473f;border-color:#51bba7}small,.help{color:#b0bdc8}.notice{color:#ffaaa0}}
  `;
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function button(label, action) {
    const node = el('button', label); node.type = 'button'; node.disabled = busy;
    node.addEventListener('click', action); return node;
  }
  function matches() {
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return prompts.filter(p => words.every(word => `${p.title}\n${p.content}\n${p.tags.join(' ')}`.toLowerCase().includes(word)))
      .sort((a, b) => b.useCount - a.useCount || b.updatedAt - a.updatedAt);
  }
  function close(restoreFocus = true) {
    if (busy && !optimizing) return;
    optimizeGeneration++; optimizing = false; busy = false;
    host?.remove(); host = null; chosen = null;
    if (restoreFocus && previousFocus?.isConnected) previousFocus.focus();
  }
  async function insert(prompt) {
    if (busy) return;
    busy = true; notice = ''; render();
    try {
      const text = SPC.promptVars.fillVars(prompt.content, values);
      if (!SPC.adapter.insertIntoComposer(text)) throw new Error(t('composerMissing'));
      await SPC.store.incrementPromptUse(prompt.id);
      busy = false; close(false);
    } catch (error) { busy = false; notice = error.message; render(); }
  }
  async function optimize(prompt) {
    if (!prompt || busy) return;
    const generation = ++optimizeGeneration; busy = optimizing = true; notice = t('optimizing'); render();
    try {
      const response = await chrome.runtime.sendMessage({ type: 'spc:llm-optimize', payload: { text: prompt.content } });
      if (generation !== optimizeGeneration || !host) return;
      if (!response?.ok || typeof response.text !== 'string') throw new Error(response?.error || t('llmInvalid'));
      busy = optimizing = false; notice = ''; choose({ ...prompt, content: response.text });
    } catch (error) {
      if (generation !== optimizeGeneration || !host) return;
      busy = optimizing = false; notice = error.message; render(); shadow.querySelector('input')?.focus();
    }
  }
  function choose(prompt) {
    if (!prompt || busy) return;
    if (SPC.promptVars.extractVars(prompt.content).length) {
      chosen = prompt; values = Object.create(null); notice = ''; render(); shadow.querySelector('input')?.focus();
    } else { values = Object.create(null); insert(prompt); }
  }
  function renderList() {
    const list = shadow.querySelector('.list');
    if (!list) return;
    list.replaceChildren();
    const items = matches(); index = Math.max(0, Math.min(index, items.length - 1));
    const input = shadow.querySelector('#palette-search');
    if (!items.length) { list.append(el('p', t('noPrompts'))); input.removeAttribute('aria-activedescendant'); }
    items.forEach((prompt, position) => {
      const item = button('', () => choose(prompt)); item.className = 'item'; item.id = `prompt-${position}`;
      item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(position === index));
      item.append(el('strong', prompt.title), el('small', prompt.tags.join(' · ')), el('small', prompt.content.slice(0, 80), 'preview'));
      item.addEventListener('keydown', event => { if (event.key === 'Enter' && event.shiftKey && !event.isComposing) { event.preventDefault(); optimize(prompt); } });
      const row = el('div', null, 'row'), improve = button('✨', () => optimize(prompt)); improve.title = t('optimize'); improve.setAttribute('aria-label', t('optimize'));
      row.append(item, improve); list.append(row);
    });
    if (items.length) input.setAttribute('aria-activedescendant', `prompt-${index}`);
    shadow.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' });
  }
  function render() {
    if (!host) return;
    windowBox.replaceChildren(); windowBox.lang = SPC.i18n.getLang();
    windowBox.setAttribute('aria-label', t(chosen ? 'variables' : 'prompts'));
    const header = el('header'); header.append(el('h2', t(chosen ? 'variables' : 'prompts')), button(t('close'), close)); if (optimizing) header.querySelector('button').disabled = false; windowBox.append(header);
    if (chosen) {
      windowBox.append(el('p', chosen.title));
      const form = el('form'), fields = [];
      for (const name of SPC.promptVars.extractVars(chosen.content)) {
        const label = el('label', name), input = el('input'); input.value = values[name] || ''; input.disabled = busy;
        input.addEventListener('input', () => { values[name] = input.value; });
        input.addEventListener('keydown', event => {
          if (event.key === 'Enter' && !event.isComposing) {
            event.preventDefault();
            const next = fields[fields.indexOf(input) + 1]; if (next) next.focus(); else insert(chosen);
          }
        });
        fields.push(input); label.append(input); form.append(label);
      }
      form.addEventListener('submit', event => { event.preventDefault(); insert(chosen); });
      const row = el('div', null, 'row');
      row.append(button(t('back'), () => { chosen = null; notice = ''; render(); shadow.querySelector('input')?.focus(); }), button(t(busy ? 'busy' : 'insert'), () => insert(chosen)));
      form.append(row); windowBox.append(form);
    } else {
      const input = el('input'); input.type = 'search'; input.id = 'palette-search'; input.placeholder = t('searchPrompts'); input.setAttribute('aria-label', t('searchPrompts'));
      input.setAttribute('role', 'combobox'); input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-controls', 'palette-list');
      input.value = query; input.disabled = busy;
      input.addEventListener('input', () => { query = input.value; index = 0; renderList(); });
      input.addEventListener('keydown', event => {
        if (event.isComposing) return;
        if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault(); const count = matches().length;
          if (count) index = (index + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
          renderList();
        } else if (event.key === 'Enter') { event.preventDefault(); if (event.shiftKey) optimize(matches()[index]); else choose(matches()[index]); }
      });
      const list = el('div', null, 'list'); list.id = 'palette-list'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', t('prompts'));
      windowBox.append(input, list, el('div', t('paletteHelp'), 'help')); renderList();
    }
    const status = el('p', notice, 'notice'); status.setAttribute('role', 'status'); windowBox.append(status);
    if (optimizing) header.querySelector('button').focus();
  }
  function show() {
    if (host) { shadow.querySelector('input')?.focus(); return; }
    previousFocus = document.activeElement; query = ''; index = 0; chosen = null; values = Object.create(null); notice = '';
    host = document.createElement('div'); host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'closed' }); const css = el('style', style), overlay = el('div', null, 'overlay');
    windowBox = el('section', null, 'window'); windowBox.setAttribute('role', 'dialog'); windowBox.setAttribute('aria-modal', 'true'); windowBox.setAttribute('aria-label', t('prompts'));
    overlay.append(windowBox); shadow.append(css, overlay); document.documentElement.append(host);
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    shadow.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const fields = [...shadow.querySelectorAll('input:not(:disabled),button:not(:disabled)')];
        const first = fields[0], last = fields[fields.length - 1];
        if (event.shiftKey && shadow.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && shadow.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    });
    render(); shadow.querySelector('input')?.focus();
  }
  async function init() {
    if (initialized) return; initialized = true;
    prompts = await SPC.store.get('prompts', []);
    SPC.store.onChange('prompts', value => { prompts = value || []; if (host && !chosen) renderList(); });
    SPC.store.onChange('settings', () => {
      if (host) { const focused = shadow.activeElement, fieldIndex = [...shadow.querySelectorAll('input')].indexOf(focused); render(); (shadow.querySelectorAll('input')[Math.max(0, fieldIndex)])?.focus(); }
    });
    document.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault(); event.stopPropagation(); show();
      } else if (!host && SPC.adapter.isPaletteTrigger(event)) {
        event.preventDefault(); event.stopImmediatePropagation(); SPC.adapter.clearComposer(); show();
      }
    }, true);
    document.addEventListener('input', event => {
      if (consuming || host) return;
      consuming = true;
      try { if (SPC.adapter.consumePaletteTrigger(event)) show(); } finally { consuming = false; }
    });
  }
  SPC.palette = { init, show, close };
})(globalThis);
