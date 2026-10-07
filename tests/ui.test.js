'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));
// Small DOM fixture: real rendering/event code, no browser or package dependency.
function dom(html = '') {
  let document;
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.dataset = {}; this.style = {}; this.events = {}; this.value = ''; this.checked = false; this._text = ''; this.className = ''; this.classList = { toggle() {} }; }
    set textContent(text) { this._text = String(text); this.children = []; } get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    // The extension renders with DOM APIs only; any innerHTML write is a regression.
    set innerHTML(_) { throw new Error('innerHTML is not allowed'); }
    get childNodes() { return this.children; } get nodeType() { return this.tagName === 'TEXT' ? 3 : 1; } get nodeValue() { return this._text; } get ownerDocument() { return document; }
    insertBefore(node, ref) { node.parent = this; this.children.splice(this.children.indexOf(ref), 0, node); return node; }
    removeChild(node) { this.children = this.children.filter(child => child !== node); return node; }
    append(...nodes) { for (const node of nodes) { if (node.tagName === '#FRAGMENT') { this.append(...node.children); node.children = []; } else { node.parent = this; this.children.push(node); } } }
    replaceChildren(...nodes) { this._text = ''; this.children = []; this.append(...nodes); }
    setAttribute(name, value) { this.attrs[name] = String(value); if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value; else if (['id', 'name', 'value', 'class'].includes(name)) this[name === 'class' ? 'className' : name] = value; }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    click() { return this.emit('click'); }
    removeAttribute(name) { delete this.attrs[name]; }
    get options() { return this.children; } get elements() { return { namedItem: name => this.querySelectorAll('input,textarea,select').find(node => node.name === name) }; }
    matches(selector) {
      const enabled = selector.includes(':not(:disabled)'); selector = selector.replace(':not(:disabled)', ''); if (enabled && this.disabled) return false;
      const attr = selector.match(/\[([^=\]]+)(?:=([^\]]+))?\]/); if (attr) return Object.hasOwn(this.attrs, attr[1]) && (attr[2] === undefined || this.attrs[attr[1]] === attr[2].replace(/["']/g, ''));
      return selector[0] === '#' ? this.id === selector.slice(1) : selector[0] === '.' ? this.className.split(' ').includes(selector.slice(1)) : this.tagName === selector.toUpperCase();
    }
    querySelectorAll(selector) { const result = []; for (const child of this.children) { if (selector.split(',').some(s => child.matches(s.trim()))) result.push(child); result.push(...child.querySelectorAll(selector)); } return result; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, action, capture = false) { const events = this.events[type] ||= []; if (capture) events.unshift(action); else events.push(action); }
    async emit(type, props = {}) { const event = { target: this, preventDefault() {}, stopPropagation() {}, ...props }; for (const action of this.events[type] || []) await action(event); }
    focus() { document.activeElement = this; } scrollIntoView(options) { this.scrolled = options; } showModal() { this.open = true; } close() { this.open = false; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
    attachShadow() { this.shadow = new Element('shadow'); return this.shadow; }
  }
  const root = new Element('document'), stack = [root];
  for (const match of html.matchAll(/<(\/)?([\w-]+)([^>]*)>/g)) {
    if (match[1]) { if (stack.at(-1).tagName === match[2].toUpperCase()) stack.pop(); continue; }
    const node = new Element(match[2]); for (const attr of match[3].matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(attr[1], attr[2]);
    stack.at(-1).append(node); if (!['input', 'meta', 'link', 'hr', 'br'].includes(match[2])) stack.push(node);
  }
  document = { documentElement: root.querySelector('html') || root, body: root.querySelector('body') || root, activeElement: null,
    createElement: tag => new Element(tag), createTextNode: text => { const node = new Element('text'); node.textContent = text; return node; }, createDocumentFragment: () => new Element('#fragment'),
    querySelector: selector => root.querySelector(selector), querySelectorAll: selector => root.querySelectorAll(selector), getElementById: id => root.querySelector('#' + id), addEventListener: (...args) => root.addEventListener(...args), emit: (...args) => root.emit(...args) };
  return { document, root, Element };
}
function load(context, file) { vm.runInContext(fs.readFileSync(require.resolve('../src/' + file), 'utf8'), context); }
async function loadPanel(context) {
  const scripts = [...fs.readFileSync(require.resolve('../src/sidepanel/index.html'), 'utf8').matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)]
    .map(match => match[1]).filter(file => !file.includes('/'));
  let resolveReady, rejectReady, refreshTab, report;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  for (const file of scripts) {
    if (file === 'main.js') {
      const panel = context.panel = context.SPC.panel;
      refreshTab = panel.refreshTab; report = panel.report;
      // The final startup refresh marks readiness without changing the entrypoint source.
      panel.refreshTab = (...args) => {
        const result = refreshTab(...args); result.then(resolveReady, rejectReady); return result;
      };
      panel.report = error => { rejectReady(error); report(error); };
    }
    load(context, `sidepanel/${file}`);
  }
  await ready;
  Object.assign(context.SPC.panel, { refreshTab, report });
}
test('real side panel init renders settings, local model choices, draft optimization/restore and safe summary/review text', async () => {
  const ui = dom(fs.readFileSync(require.resolve('../src/sidepanel/index.html'), 'utf8')), events = { addListener() {}, removeListener() {} };
  const data = {}, rows = [{ key: 'chatgpt:1', id: '1', platform: 'chatgpt', title: '<script>title</script>', updateTime: 1, messages: [], summary: { text: '<img onerror=bad>Summary', model: 'Qwen3', createdAt: 1 } }];
  const context = vm.createContext({ TextEncoder, TextDecoder, URL, AbortController, DOMException, Intl, Date, setTimeout, clearTimeout, document: ui.document,
    chrome: { storage: { session: { get: async () => ({}), set: async () => {}, remove: async () => {} }, local: { get: async () => structuredClone(data), set: async patch => Object.assign(data, structuredClone(patch)) }, onChanged: events },
      tabs: { query: async () => [], onActivated: events, onUpdated: events }, windows: { onFocusChanged: events } } });
  for (const file of ['ns', 'i18n', 'storage', 'llm', 'platforms', 'conversation', 'prompt-vars', 'search', 'rag', 'markdown', 'summary', 'digest', 'backfill', 'vault']) load(context, `shared/${file}.js`);
  context.SPC.db = { digests: { getAll: async () => [] }, keyval: { get: async () => undefined, set: async () => {} }, chunks: { getAll: async () => [] }, getAll: async () => rows, vectors: { getAll: async () => [] } };
  await loadPanel(context);
  const node = selector => ui.document.querySelector(selector);
  assert.equal(node('#llm-base-url').value, 'http://127.0.0.1:11123/v1'); assert.equal(node('#llm-api-key').attrs.type, 'password'); assert.match(node('#conversation-list').textContent, /<img onerror=bad>Summary/);
  assert.equal(node('.summary-text').querySelector('img'), null);
  rows[0].summary.text = '# Saved\n\n**bold**'; context.panel.renderConversations();
  assert.equal(node('.summary-text').querySelector('h4').textContent, 'Saved'); assert.equal(node('.summary-text').querySelector('strong').textContent, 'bold');
  context.panel.state.summaryDrafts.set('chatgpt:1', ''); context.panel.renderConversations();
  assert.equal(node('.summary-text').textContent, '思考中…'); assert.equal(node('.summary-text').children.length, 0);
  context.panel.state.summaryDrafts.set('chatgpt:1', '*draft*'); context.panel.renderConversations();
  assert.equal(node('.summary-text').querySelector('em').textContent, 'draft'); context.panel.state.summaryDrafts.clear();
  assert.ok(!node('#conversations').querySelector('#cancel-sync'), 'cancel is accessible from Settings too');
  context.SPC.llm.listModels = async () => ['Qwen3', 'Qwen3-Embedding-0.6B']; await node('#llm-test').emit('click');
  assert.equal(node('#llm-chat-model').value, 'Qwen3'); assert.equal(node('#llm-embedding-model').value, 'Qwen3-Embedding-0.6B');
  await node('#llm-form').emit('submit'); assert.equal(data.settings.llm.chatModel, 'Qwen3');
  await node('#add-prompt').emit('click'); const content = node('#editor-form').elements.namedItem('content'); content.value = 'Original {{name}}';
  context.SPC.llm.optimize = async () => 'Improved {{name}}';
  await node('#editor-fields').querySelectorAll('button').find(button => button.textContent === '本地 LLM 優化').emit('click');
  assert.equal(node('#editor-form').elements.namedItem('content').value, 'Improved {{name}}'); assert.equal(data.prompts, undefined);
  await node('#editor-fields').querySelectorAll('button').find(button => button.textContent === '還原').emit('click');
  assert.equal(node('#editor-form').elements.namedItem('content').value, 'Original {{name}}');
  context.panel.showSuggestions([{ id: 'chatgpt:1', oldTitle: '<script>title</script>', title: 'New title', source: 'summary', folder: '<b>new</b>', tags: ['<img>'], checked: true }]);
  assert.equal(node('#suggestion-review').open, true); assert.match(node('#review-items').textContent, /<b>new<\/b> · 新/); assert.equal(data.convMeta, undefined);
});
test('palette optimizes via background, fills variables before insertion and ignores late replies after Escape', async () => {
  const ui = dom(), messages = [], inserted = [], uses = [];
  let reply, respond = () => new Promise(resolve => { reply = resolve; });
  const context = vm.createContext({ document: ui.document, chrome: { runtime: { sendMessage: message => { messages.push(message); return respond(); } } },
    SPC: { i18n: { t: key => key, getLang: () => 'en' }, promptVars: require('../src/shared/prompt-vars.js'),
      store: { get: async () => [{ id: 'p', title: 'Title', content: 'Original {{name}}', tags: [], useCount: 0, updatedAt: 1 }], onChange() {}, incrementPromptUse: async id => uses.push(id) },
      adapter: { insertIntoComposer: text => { inserted.push(text); return true; } } } });
  load(context, 'content/prompt-palette.js'); await context.SPC.palette.init(); context.SPC.palette.show();
  const shadow = () => ui.document.documentElement.children.at(-1).shadow;
  await shadow().querySelector('#palette-search').emit('keydown', { key: 'Enter', shiftKey: true });
  assert.equal(ui.document.activeElement.textContent, 'close', 'keep keyboard focus in the palette so Escape works while waiting');
  assert.match(shadow().textContent, /optimizing/); assert.equal(messages[0].type, 'spc:llm-optimize');
  await shadow().emit('keydown', { key: 'Escape' }); reply({ ok: true, text: 'Late {{name}}' }); await flush(); assert.equal(inserted.length, 0);
  context.SPC.palette.show(); respond = async () => ({ ok: true, text: 'Improved {{name}}' });
  await shadow().querySelectorAll('button').find(button => button.textContent === '✨').emit('click'); await flush();
  const input = shadow().querySelector('input'); input.value = 'Ada'; await input.emit('input'); await input.emit('keydown', { key: 'Enter' }); await flush();
  assert.deepEqual(inserted, ['Improved Ada']); assert.deepEqual(uses, ['p']);
});
test('title options and review use DOM events, preserve edits, gate sync and require confirmation after local apply', async () => {
  const ui = dom(fs.readFileSync(require.resolve('../src/sidepanel/index.html'), 'utf8')), events = { addListener() {}, removeListener() {} }, calls = [], writes = [];
  let active = { id: 1, url: 'https://chatgpt.com' };
  const data = { settings: { llm: { chatModel: 'Qwen3' } }, convMeta: { 'chatgpt:a': { customTitle: ' Local\n title ', tags: [], pinned: false, folderId: null } } };
  const rows = [{ key: 'chatgpt:a', id: 'a', platform: 'chatgpt', title: 'Site title', updateTime: 1, messages: [], fetchedAt: 0 },
    { key: 'claude:b', id: 'b', platform: 'claude', title: 'Claude title', updateTime: 1, messages: [], fetchedAt: 0 }];
  const context = vm.createContext({ TextEncoder, TextDecoder, URL, AbortController, DOMException, Intl, Date, setTimeout, clearTimeout, document: ui.document,
    chrome: { storage: { session: { get: async () => ({}), set: async () => {}, remove: async () => {} }, local: { get: async () => structuredClone(data), set: async patch => { writes.push(structuredClone(patch)); Object.assign(data, structuredClone(patch)); } }, onChanged: events },
      tabs: { query: async () => [active], get: async () => active, sendMessage: async (_tab, message) => { calls.push(message); return { ok: true }; }, onActivated: events, onUpdated: events }, windows: { onFocusChanged: events } } });
  for (const file of ['ns', 'i18n', 'storage', 'llm', 'platforms', 'conversation', 'prompt-vars', 'search', 'rag', 'markdown', 'summary', 'digest', 'backfill', 'vault']) load(context, `shared/${file}.js`);
  context.SPC.db = { digests: { getAll: async () => [] }, keyval: { get: async () => undefined, set: async () => {} }, chunks: { getAll: async () => [] }, getAll: async () => rows, get: async key => rows.find(row => row.key === key), put: async value => Object.assign(rows.find(row => row.key === value.key), value), vectors: { getAll: async () => [] } };
  let input;
  context.SPC.llm.chat = async (_config, options) => { input = JSON.parse(options.messages[1].content); return JSON.stringify({ items: input.items.map(item => ({ id: item.id, title: '<script>New title</script>', folder: '', tags: [] })) }); };
  await loadPanel(context); const node = selector => ui.document.querySelector(selector);
  assert.match(node('#conversation-list').textContent, /Local title/); assert.match(node('#conversation-list').textContent, /原標題：Site title/);
  await node('#suggest').emit('click'); const options = node('#editor-fields').querySelectorAll('input'); assert.equal(options.length, 3); assert.ok(options.every(option => option.checked));
  assert.equal(writes.length, 0); assert.equal(input, undefined); await node('#editor-form').emit('submit');
  assert.equal(input.items[0].title, 'Local title'); assert.equal(input.items[0].source, 'title'); assert.equal(writes.length, 0); assert.equal(calls.length, 0);
  assert.equal(node('#suggestion-review').open, true); let review = node('#review-items').children;
  const title = review[0].querySelectorAll('input')[1]; assert.equal(title.value, '<script>New title</script>'); assert.equal(review[0].querySelector('script'), null);
  assert.equal(review[0].querySelectorAll('input')[2].checked, false); assert.equal(review[1].querySelectorAll('input')[2].disabled, true); assert.match(review[1].textContent, /需在 Claude 分頁/);
  title.value = 'Edited title'; await title.emit('input'); await node('#review-none').emit('click'); await node('#review-all').emit('click');
  review = node('#review-items').children; assert.equal(review[0].querySelectorAll('input')[1].value, 'Edited title');
  node('#review-sync-all').checked = true; await node('#review-sync-all').emit('change'); review = node('#review-items').children;
  assert.equal(review[0].querySelectorAll('input')[2].checked, true); assert.equal(review[1].querySelectorAll('input')[2].checked, false);
  const edited = review[0].querySelectorAll('input')[1]; edited.value = ''; await edited.emit('input'); assert.equal(review[0].querySelectorAll('input')[2].disabled, true); assert.equal(review[0].querySelectorAll('input')[2].checked, false);
  edited.value = 'Edited title'; await edited.emit('input'); const sync = review[0].querySelectorAll('input')[2]; sync.checked = true; await sync.emit('change');
  await node('#review-apply').emit('click'); assert.equal(data.convMeta['chatgpt:a'].customTitle, 'Edited title'); assert.equal(data.convMeta['claude:b'].customTitle, '<script>New title</script>'); assert.equal(calls.length, 0);
  assert.equal(node('#suggestion-review').open, false); assert.equal(node('#review-sync-all').disabled, false); assert.equal(node('#editor').open, true); assert.match(node('#editor-message').textContent, /修改 1 個對話/); assert.match(node('#editor-message').textContent, /每筆 1 個請求/); assert.match(node('#editor-message').textContent, /最上方/);
  await node('#editor-form').emit('submit'); assert.equal(calls.length, 1); assert.equal(calls[0].type, 'spc:rename'); assert.equal(calls[0].payload.title, 'Edited title'); assert.equal(rows[0].title, 'Edited title');
  assert.equal(data.convMeta['chatgpt:a'].originalTitle, 'Site title'); assert.equal(data.convMeta['chatgpt:a'].customTitle, null);
  const restore = node('#conversation-list').querySelectorAll('button').find(button => button.textContent === '還原原標題'); await restore.emit('click');
  assert.match(node('#editor-message').textContent, /網站仍保留新標題/); assert.equal(node('#editor-fields').querySelector('input').checked, false);
  await node('#editor-cancel').emit('click'); assert.equal(data.convMeta['chatgpt:a'].originalTitle, 'Site title');
  active = { id: 2, url: 'https://claude.ai' }; await context.panel.refreshTab();
  const edit = node('#conversation-list').querySelectorAll('button').find(button => button.textContent === '編輯標題'); await edit.emit('click'); node('#editor-fields').querySelector('input').value = '';
  await node('#editor-form').emit('submit'); assert.equal(data.convMeta['chatgpt:a'].customTitle, null); assert.equal(calls.length, 1);
});
test('title confirmation translations warn about site ordering and request count in both languages', () => {
  const dictionaries = require('../src/shared/i18n.js').dictionaries;
  assert.match(dictionaries['zh-TW'].renameConfirm, /每筆 1 個請求.*最上方/); assert.match(dictionaries.en.renameConfirm, /1 request each.*top/);
});

test('DOM citation buttons replace only valid references outside code and open the corresponding source', async () => {
  const ui = dom(), node = ui.document.createElement('div'), clicks = [], rag = require('../src/shared/rag.js');
  node.append(require('../src/shared/markdown.js').render('Fact [1] and **[2]**. Invalid [0] [99] [01]. `code [1]`\n\n```\n[2]\n```', ui.document));
  rag.citationButtons(node, 2, index => clicks.push(index));
  assert.deepEqual(node.querySelectorAll('button').map(button => button.textContent), ['[1]', '[2]']);
  assert.ok(node.textContent.includes('[0] [99] [01]')); assert.equal(node.querySelectorAll('code').length, 2);
  for (const button of node.querySelectorAll('button')) await button.emit('click'); assert.deepEqual(clicks, [0, 1]);
  rag.citationButtons(node, 2, () => assert.fail('double wrapping')); assert.equal(node.querySelectorAll('button').length, 2);
});
test('Q&A UI supports IME-safe enter, citations, coverage, read-only history, reset, clear and index/cache clearing', async () => {
  const ui = dom(fs.readFileSync(require.resolve('../src/sidepanel/index.html'), 'utf8')), events = { addListener() {}, removeListener() {} }, site = [], opened = [], frames = new Map(); let frameId = 0;
  const data = { settings: { llm: { chatModel: 'Qwen3', embeddingModel: 'Qwen3-Embedding' } } };
  const rows = [{ key: 'chatgpt:a', id: 'a', title: '<b>Title</b>', platform: 'chatgpt', updateTime: 1, fetchedAt: 0, messages: [] }], chunks = [{ key: 'chatgpt:a#0', convKey: 'chatgpt:a', n: 0, model: 'Qwen3-Embedding', text: '標題：Title', vector: [1, 0] }];
  const context = vm.createContext({ TextEncoder, TextDecoder, URL, AbortController, DOMException, Intl, Date, setTimeout, clearTimeout, document: ui.document,
    requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame: id => frames.delete(id),
    chrome: { storage: { session: { get: async () => ({}), set: async () => {}, remove: async () => {} }, local: { get: async () => structuredClone(data), set: async patch => Object.assign(data, structuredClone(patch)) }, onChanged: events },
      tabs: { query: async () => [{ id: 1, url: 'https://chatgpt.com' }], update: async (id, value) => opened.push({ id, ...value }), sendMessage: async (...args) => site.push(args), onActivated: events, onUpdated: events }, windows: { onFocusChanged: events } } });
  for (const file of ['ns', 'i18n', 'storage', 'llm', 'platforms', 'conversation', 'prompt-vars', 'search', 'rag', 'markdown', 'summary', 'digest', 'backfill', 'vault']) load(context, `shared/${file}.js`);
  context.SPC.db = { digests: { getAll: async () => [] }, keyval: { get: async () => undefined, set: async () => {} }, getAll: async () => rows, chunks: { getAll: async () => chunks, clear: async () => { chunks.length = 0; } }, vectors: { getAll: async () => [], clear: async () => {} }, clear: async () => { chunks.length = 0; rows.length = 0; } };
  let embeds = 0, chats = 0, resolveChat;
  context.SPC.llm.embed = async () => { embeds++; return [[1, 0]]; };
  context.SPC.llm.chat = async (_, options) => { chats++; options.onText('Draft [1]'); return '**Answer** [1] [0] [99] `literal [1]`'; };
  await loadPanel(context); const node = selector => ui.document.querySelector(selector);
  await node('#tab-qa').emit('click'); assert.equal(node('#qa').hidden, false); assert.equal(node('#settings').hidden, true);
  node('#qa-question').value = 'Question'; await node('#qa-question').emit('keydown', { key: 'Enter', isComposing: true }); await node('#qa-question').emit('keydown', { key: 'Enter', shiftKey: true }); await node('#qa-question').emit('keydown', { key: 'Enter', keyCode: 229 }); assert.equal(chats, 0);
  await node('#qa-question').emit('keydown', { key: 'Enter' }); assert.equal(chats, 1); assert.equal(embeds, 1); assert.equal(site.length, 0); assert.equal(data.qaHistory.length, 1); assert.equal(frames.size, 0);
  assert.equal(node('#qa-answer').querySelector('strong').textContent, 'Answer'); assert.equal(node('#qa-answer').querySelectorAll('button').length, 1);
  assert.match(node('#qa-coverage').textContent, /使用 1 段內容（1 個對話）；其中 1 個相關對話只有標題/); assert.match(node('#qa-download').textContent, /（1 筆）/); assert.equal(node('#qa-download').hidden, false);
  assert.match(node('#vector-stats').textContent, /內容段落：1 段/); assert.equal(node('#qa-sources').querySelector('b'), null);
  await node('#qa-answer').querySelector('button').emit('click'); await flush(); assert.deepEqual(opened[0], { id: 1, url: 'https://chatgpt.com/c/a' });
  await node('#qa-history').querySelector('button').emit('click'); assert.equal(node('#qa-ask').disabled, true); assert.equal(node('#qa-question').disabled, true); assert.equal(node('#qa-download').hidden, true);
  assert.equal(node('#qa-answer').querySelectorAll('button').length, 1); await node('#qa-ask').emit('click'); assert.equal(chats, 1);
  await node('#qa-new').emit('click'); assert.equal(node('#qa-ask').disabled, false); assert.equal(node('#qa-question').value, ''); assert.equal(context.panel.state.qa.turns.length, 0);
  await node('#qa-clear').emit('click'); assert.equal(data.qaHistory.length, 0); assert.equal(node('#qa-history').children.length, 0);
  context.SPC.llm.chat = () => new Promise(resolve => { resolveChat = resolve; }); node('#qa-question').value = 'Again';
  const asking = node('#qa-ask').emit('click'); await flush();
  for (const id of ['#sync', '#build-index', '#export-current', '#qa-ask', '#qa-new', '#clear-cache']) assert.equal(node(id).disabled, true, id);
  await node('#cancel-sync').emit('click'); resolveChat('late'); await asking; assert.equal(data.qaHistory.length, 0); assert.equal(node('#qa-ask').disabled, false);
  await node('#clear-index').emit('click'); assert.equal(chunks.length, 0); await node('#qa-ask').emit('click'); assert.match(node('#qa-hint').textContent, /建立語意索引/); assert.ok(node('#qa-hint').querySelector('button'));
  chunks.push({ key: 'stale' }); await node('#clear-cache').emit('click'); await node('#editor-form').emit('submit'); assert.equal(chunks.length, 0); assert.equal(rows.length, 0);
});

async function diagnosticUI({ supported = true, missing = false } = {}) {
  const ui = dom(fs.readFileSync(require.resolve('../src/sidepanel/index.html'), 'utf8')), events = { addListener() {}, removeListener() {} };
  const secrets = ['SECRET_TITLE', 'SECRET_TEXT', 'SECRET_SNIPPET', 'SECRET_ID', 'SECRET_TOKEN', 'SECRET_API_KEY', 'SECRET_ORG', 'SECRET_COOKIE'];
  const data = { settings: { llm: { baseUrl: 'http://127.0.0.1:11123/v1', apiKey: secrets[5], chatModel: 'Qwen3', embeddingModel: 'Qwen3-Embedding' } },
    prompts: [{ id: secrets[3], title: secrets[0], content: secrets[1], tags: [] }], folders: [{ id: secrets[3], name: secrets[0] }] };
  const records = [{ key: 'chatgpt:' + secrets[3], platform: 'chatgpt', id: secrets[3], title: secrets[0], fetchedAt: 1, messages: [{ role: 'user', text: secrets[1] }] },
    { key: 'claude:' + secrets[3], platform: 'claude', id: secrets[3], title: secrets[0], fetchedAt: 0, messages: [] }];
  const site = [], llm = [], copied = [], writes = [], outcomeWrites = [];
  const context = vm.createContext({ TextEncoder, TextDecoder, URL, AbortController, DOMException, Intl, Date, setTimeout, clearTimeout, document: ui.document,
    navigator: { userAgent: 'Mozilla Chrome/130.0.0.0 SECRET_TOKEN', clipboard: { writeText: async text => copied.push(text) } },
    chrome: { runtime: { getManifest: () => JSON.parse(fs.readFileSync(require.resolve('../manifest.json'), 'utf8')) },
      storage: { session: { get: async () => ({}), set: async () => {}, remove: async () => {} }, local: { get: async () => structuredClone(data), set: async patch => { (Object.keys(patch).length === 1 && Object.hasOwn(patch, 'diagnosticsLast') ? outcomeWrites : writes).push(patch); Object.assign(data, structuredClone(patch)); } }, onChanged: events },
      tabs: { query: async () => [{ id: 1, url: supported ? 'https://chatgpt.com/c/SECRET_ID' : 'https://example.com' }], onActivated: events, onUpdated: events,
        sendMessage: async (_id, message) => {
          site.push(message); if (missing) throw new Error(secrets.join(' '));
          return { ok: true, platform: 'chatgpt', version: '0.3.0', token: secrets[4], checks: ['session', 'list', 'search', 'conversation', 'composer'].map(id => ({
            id, ok: id !== 'search', ms: 312, ...(id === 'search' ? { status: 404, category: 'requestFailed' } : {}),
            error: secrets.join(' '), fix: secrets.join(' '), title: secrets[0], token: secrets[4], org: secrets[6] })) };
        } }, windows: { onFocusChanged: events } } });
  for (const file of ['ns', 'i18n', 'storage', 'llm', 'platforms', 'conversation', 'prompt-vars', 'search', 'rag', 'markdown', 'summary', 'digest', 'backfill', 'vault']) load(context, `shared/${file}.js`);
  context.SPC.db = { digests: { getAll: async () => [] }, keyval: { get: async () => undefined, set: async () => {} }, getAll: async () => records, vectors: { getAll: async () => [{ key: secrets[3], model: 'Qwen3-Embedding' }, { key: secrets[3], model: 'old' }] },
    chunks: { getAll: async () => [{ key: secrets[3], text: secrets[1], model: 'Qwen3-Embedding' }] } };
  context.SPC.llm.listModels = async config => { llm.push(config); return ['Qwen3', 'Qwen3-Embedding']; };
  context.SPC.llm.chat = context.SPC.llm.embed = () => assert.fail('diagnostics must not generate');
  await loadPanel(context);
  context.panel.wait = async (_ms, signal) => context.panel.checkCancelled(signal);
  return { context, panel: context.panel, node: selector => ui.document.querySelector(selector), site, llm, copied, writes, outcomeWrites, secrets };
}
test('diagnostic UI renders rows/fixes, counts current model data, copies only allowlisted facts and localizes', async () => {
  const h = await diagnosticUI(); assert.equal(h.site.length, 0); assert.equal(h.llm.length, 0);
  await h.node('#diagnostic-run').emit('click');
  assert.deepEqual(h.site.map(row => row.type), ['spc:diagnose']); assert.equal(h.llm.length, 1); assert.equal(h.writes.length, 0);
  const text = h.node('#diagnostic-results').textContent;
  assert.match(text, /❌ ChatGPT · 對話搜尋 · 312ms · HTTP 404/);
  assert.match(text, /可能需要修改：src\/content\/adapters\/chatgpt.js → searchConversations/);
  assert.match(text, /目前 Embedding 模型的向量 · \d+ms · 數量：1/);
  assert.match(text, /本機資料夾 · \d+ms · 數量：1/); assert.match(h.node('#settings').textContent, /改名不測試，因為會寫入網站/);
  await h.node('#diagnostic-copy').emit('click'); assert.equal(h.copied.length, 1);
  const report = h.copied[0]; assert.match(report, new RegExp(`^Personal Chat Superpower ${require('../manifest.json').version.replace(/\./g, '\\.')} · Chrome 130 · \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}`));
  assert.match(report, /❌ chatgpt.search fail 404 \(requestFailed\) 312ms → src\/content\/adapters\/chatgpt.js → searchConversations/);
  assert.match(report, /data.backfill ok \d+ms enabled=0 today=0 remaining=0/);
  for (const secret of h.secrets) { assert.ok(!report.includes(secret), secret); assert.ok(!text.includes(secret), secret); }
  assert.ok(!report.includes('http://')); assert.equal(h.node('#diagnostic-run').disabled, false);
  await h.context.SPC.i18n.setLang('en'); h.panel.localize();
  assert.match(h.node('#diagnostic-results').textContent, /Possible fix:.*searchConversations/);
  assert.equal(h.node('#diagnostic-run').textContent, 'Run diagnostics');
});
test('diagnostics reports missing content script once and skips unsupported tabs without site messages', async () => {
  const missing = await diagnosticUI({ missing: true }); await missing.node('#diagnostic-run').emit('click');
  assert.equal(missing.site.length, 1); assert.match(missing.node('#diagnostic-results').textContent, /❌ 頁面腳本（content script）/);
  assert.match(missing.node('#diagnostic-results').textContent, /可能需要修改：重新整理分頁/);
  for (const secret of missing.secrets) assert.ok(!missing.panel.diagnosticReport().includes(secret));
  const unsupported = await diagnosticUI({ supported: false }); unsupported.panel.state.settings.llm.baseUrl = '';
  await unsupported.node('#diagnostic-run').emit('click');
  assert.equal(unsupported.site.length, 0); assert.equal(unsupported.llm.length, 0);
  assert.match(unsupported.node('#diagnostic-results').textContent, /⏭ 請在 ChatGPT 或 Claude 分頁執行以檢查網站/);
  assert.match(unsupported.panel.diagnosticReport(), /llm.models skip .*notConfigured/);
});
test('diagnostic local LLM failures/missing models are safe, with no generation or retry', async () => {
  const h = await diagnosticUI({ supported: false });
  h.context.SPC.llm.listModels = async () => ['Qwen3']; await h.panel.runDiagnostics();
  assert.match(h.panel.diagnosticReport(), /llm.embeddingModel fail \(modelMissing\)/);
  let count = 0; h.context.SPC.llm.listModels = async () => { count++; throw Object.assign(new Error(h.secrets.join(' ')), { status: 401 }); };
  await h.panel.runDiagnostics(); assert.equal(count, 1); assert.match(h.panel.diagnosticReport(), /llm.models fail 401 \(authRequired\)/);
  assert.match(h.panel.diagnosticReport(), /llm.chatModel skip \(dependency\)/);
  for (const secret of h.secrets) assert.ok(!h.panel.diagnosticReport().includes(secret));
});
test('diagnostic copy fallback uses a read-only selectable editor textarea', async () => {
  const h = await diagnosticUI({ supported: false }); await h.panel.runDiagnostics();
  h.context.navigator.clipboard.writeText = async () => { throw new Error('denied'); };
  const element = h.node('#diagnostic-run').constructor; element.prototype.select = function () { this.selected = true; };
  await h.node('#diagnostic-copy').emit('click');
  const textarea = h.node('#editor-fields').querySelector('textarea');
  assert.equal(h.node('#editor').open, true); assert.equal(textarea.value, h.panel.diagnosticReport()); assert.equal(textarea.readOnly, true); assert.equal(textarea.selected, true);
});
test('diagnostics shares the operation lock, forwards cancel and holds the lock until site work settles', async () => {
  const h = await diagnosticUI(); let resolve, running = false;
  h.context.chrome.tabs.sendMessage = async (_id, message) => {
    h.site.push(message);
    if (message.type === 'spc:cancelDiagnose') return { ok: true };
    running = true; return new Promise(done => { resolve = done; });
  };
  const run = h.node('#diagnostic-run').emit('click');
  while (!running) await flush();
  assert.equal(h.node('#diagnostic-run').disabled, true); assert.equal(h.node('#sync').disabled, true);
  await h.panel.runDiagnostics(); assert.equal(h.site.length, 1);
  await h.node('#cancel-sync').emit('click'); assert.equal(h.site[1].type, 'spc:cancelDiagnose');
  assert.ok(h.panel.state.operationController); assert.equal(h.llm.length, 0);
  resolve({ ok: false, error: 'Cancelled' }); await run;
  assert.equal(h.panel.state.operationController, null); assert.equal(h.node('#diagnostic-run').disabled, false);
  assert.equal(h.llm.length, 0); assert.match(h.panel.diagnosticReport(), /run.cancelled skip/);
  h.panel.state.operationController = new AbortController(); await h.panel.runDiagnostics(); assert.equal(h.site.length, 2);
  h.panel.state.operationController = null;
});

test('backfill settings render live scope counts, toggle preferences, validate limits and protect site pauses', async () => {
  const ui = dom(fs.readFileSync(require.resolve('../src/sidepanel/index.html'), 'utf8')), listeners = new Set();
  const events = { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) }, tabsEvent = { addListener() {} };
  const data = { folders: [{ id: 'f', name: 'Folder', color: '#abcdef', order: 0 }], convMeta: { 'chatgpt:a': { pinned: true }, 'claude:b': { folderId: 'f' }, 'chatgpt:c': { folderId: 'gone' } } };
  const rows = [{ key: 'chatgpt:a', id: 'a', title: 'A', messages: [] }, { key: 'claude:b', id: 'b', title: 'B', messages: [], summary: { text: 'Done' } }, { key: 'chatgpt:c', id: 'c', title: 'C', messages: [] }];
  const context = vm.createContext({ TextEncoder, TextDecoder, URL, AbortController, DOMException, Intl, Date, setTimeout, clearTimeout, document: ui.document,
    chrome: { storage: { session: { get: async () => ({}), set: async () => {}, remove: async () => {} }, local: {
      get: async () => structuredClone(data), set: async patch => {
        const changes = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, { oldValue: data[key], newValue: value }]));
        Object.assign(data, structuredClone(patch)); listeners.forEach(fn => fn(changes, 'local'));
      }
    }, onChanged: events }, tabs: { query: async () => [], onActivated: tabsEvent, onUpdated: tabsEvent }, windows: { onFocusChanged: tabsEvent }, runtime: {} } });
  for (const file of ['ns', 'i18n', 'storage', 'llm', 'platforms', 'conversation', 'prompt-vars', 'search', 'rag', 'markdown', 'summary', 'digest', 'backfill', 'vault']) load(context, `shared/${file}.js`);
  load(context, 'background/backfill.js');
  const worker = context.SPC.backfillWorker.create({ chrome: context.chrome });
  context.chrome.runtime.sendMessage = async message => ({ ok: true, value: await worker.preferences(message.payload) });
  context.SPC.db = { digests: { getAll: async () => [] }, keyval: { get: async () => undefined, set: async () => {} }, getAll: async () => rows, vectors: { getAll: async () => [] }, chunks: { getAll: async () => [] } };
  await loadPanel(context); const node = selector => ui.document.querySelector(selector);
  assert.equal(node('#backfill-enabled').checked, false);
  assert.match(node('#backfill-stats').textContent, /範圍內 2 筆 · 已有摘要 1 筆 · 尚缺 1 筆 · 需更新 0 筆 · 今日 0\/20 · 預計約 1 天完成/);
  node('#backfill-enabled').checked = true; await node('#backfill-enabled').emit('change'); assert.equal(data.backfill.enabled, true);
  node('#backfill-limit').value = '7'; await node('#backfill-limit').emit('change'); assert.equal(data.backfill.dailyLimit, 7);
  node('#backfill-limit').value = '101'; await node('#backfill-limit').emit('change'); assert.equal(data.backfill.dailyLimit, 7);
  await node('#backfill-pause').emit('click'); assert.ok(data.backfill.pausedUntil > Date.now()); assert.equal(node('#backfill-resume').disabled, false);
  await node('#backfill-resume').emit('click'); assert.equal(data.backfill.pausedUntil, 0);
  rows[0].summary = { text: 'New summary' };
  await context.SPC.store.updateBackfill({ day: context.SPC.backfill.localDay(), doneToday: 3, lastStatus: 'rateLimited', pausedUntil: context.SPC.backfill.nextMidnight(), lastRunAt: Date.now() }); await flush();
  assert.match(node('#backfill-stats').textContent, /已有摘要 2 筆 · 尚缺 0 筆 · 需更新 0 筆 · 今日 3\/7/);
  assert.match(node('#backfill-last').textContent, /網站限流/); assert.equal(node('#backfill-resume').disabled, true);
  await context.SPC.i18n.setLang('en'); await flush(); context.panel.localize();
  assert.equal(node('#backfill-heading').textContent, 'Background summary backfill'); assert.match(node('#backfill-stats').textContent, /In scope 2 · Summarized 2 · Missing 0/);
});

async function vaultUI(savedValue, picker) {
  const ui = dom(fs.readFileSync(require.resolve('../src/sidepanel/index.html'), 'utf8')), events = { addListener() {}, removeListener() {} };
  const data = {}, records = [{ key: 'chatgpt:abcdef', id: 'abcdef', platform: 'chatgpt', title: '<img>Title', messages: [] }], downloads = [], calls = [];
  let persisted = savedValue;
  const context = vm.createContext({ TextEncoder, TextDecoder, URL, AbortController, DOMException, Intl, Date, setTimeout, clearTimeout, document: ui.document,
    showDirectoryPicker: picker, fetch: () => { throw new Error('No network allowed'); },
    chrome: { storage: { session: { get: async () => ({}), set: async () => {}, remove: async () => {} }, local: { get: async () => data, set: async patch => Object.assign(data, patch) }, onChanged: events },
      tabs: { query: async () => [], sendMessage: () => { calls.push('site'); throw new Error('No site messages'); }, onActivated: events, onUpdated: events }, windows: { onFocusChanged: events } } });
  for (const file of ['ns', 'i18n', 'storage', 'llm', 'platforms', 'conversation', 'prompt-vars', 'search', 'rag', 'markdown', 'summary', 'digest', 'backfill', 'vault']) load(context, `shared/${file}.js`);
  context.SPC.db = { digests: { getAll: async () => [] }, keyval: { get: async () => persisted, set: async (key, value) => { assert.equal(key, 'vault'); persisted = value; } }, getAll: async () => records, vectors: { getAll: async () => [] }, chunks: { getAll: async () => [] } };
  await loadPanel(context);
  context.panel.download = (...args) => downloads.push(args);
  return { context, ui, data, records, downloads, calls, persisted: () => persisted, node: selector => ui.document.querySelector(selector) };
}
test('vault UI persists selection, requests permission, writes cached notes, reports edits, localizes and forgets without deleting', async () => {
  const tree = require('./helpers/vault-tree.js')(), permissions = [], picks = [];
  const handle = Object.assign(tree.directory, { queryPermission: async options => { permissions.push(['query', options.mode]); return 'prompt'; }, requestPermission: async options => { permissions.push(['request', options.mode]); return 'granted'; }, isSameEntry: async other => other === handle });
  const h = await vaultUI(undefined, async options => { picks.push(options); return handle; });
  await h.node('#vault-choose').emit('click'); assert.equal(h.node('#vault-name').textContent, 'Vault'); assert.equal(h.persisted().handle, handle);
  assert.deepEqual(JSON.parse(JSON.stringify(picks)), [{ mode: 'readwrite', id: 'pcs-vault' }]);
  h.node('#vault-scope').value = 'all'; await h.node('#vault-export').emit('click');
  assert.deepEqual(permissions, [['query', 'readwrite'], ['request', 'readwrite']]); assert.match(h.node('#vault-report').textContent, /新增 1/); assert.equal(h.calls.length, 0);
  const path = h.persisted().vaultIndex['chatgpt:abcdef'].path;
  tree.put(path, 'My text'); await h.node('#vault-export').emit('click');
  assert.match(h.node('#vault-report').textContent, /因已修改而略過 1/); assert.equal(h.node('#vault-skipped').hidden, false); assert.match(h.node('#vault-skipped').textContent, /已在 Obsidian 修改，略過/);
  assert.equal(h.node('#vault-skipped').querySelector('img'), null);
  h.node('#language').value = 'en'; await h.node('#language').emit('change'); assert.equal(h.node('#vault-choose').textContent, 'Choose vault folder'); assert.match(h.node('#vault-report').textContent, /Skipped edited 1/);
  const reopen = await vaultUI(h.persisted()); assert.equal(reopen.node('#vault-name').textContent, 'Vault'); assert.equal(reopen.node('#vault-scope').value, 'all');
  await reopen.node('#vault-export').emit('click'); assert.match(reopen.node('#vault-report').textContent, /因已修改而略過 1/);
  await h.node('#vault-choose').emit('click'); assert.ok(h.persisted().vaultIndex['chatgpt:abcdef'], 'same directory keeps manifest');
  await h.node('#vault-forget').emit('click'); assert.equal(h.persisted().handle, null); assert.equal(Object.keys(h.persisted().vaultIndex).length, 0); assert.equal(tree.text(path), 'My text');
  assert.equal(h.context.panel.state.operationController, null);
});
test('vault picker unavailable/restricted and denied saved permission offer ZIP with zero site requests', async () => {
  for (const name of [null, 'SecurityError', 'NotAllowedError', 'AbortError']) {
    const picker = name && (() => Promise.reject(Object.assign(new Error(name), { name })));
    const h = await vaultUI(undefined, picker);
    await h.node('#vault-choose').emit('click');
    assert.equal(h.node('#vault-zip').hidden, name === 'AbortError');
    if (name === 'AbortError') continue;
    h.node('#vault-scope').value = 'all'; await h.node('#vault-zip').emit('click');
    assert.equal(h.downloads.length, 1); assert.equal(h.downloads[0][2], 'zip'); assert.equal(new DataView(h.downloads[0][0].buffer).getUint32(0, true), 0x04034b50);
    assert.equal(h.calls.length, 0); assert.equal(Object.keys(h.persisted().vaultIndex).length, 0);
  }
  let requests = 0;
  const h = await vaultUI({ handle: { name: 'Saved', queryPermission: async () => 'prompt', requestPermission: async () => { requests++; return 'denied'; } } });
  await h.node('#vault-export').emit('click'); assert.equal(requests, 1); assert.equal(h.node('#vault-zip').hidden, false); assert.equal(h.calls.length, 0);
});
test('vault UI shares operation lock and cancels between files with completed-file report', async () => {
  const tree = require('./helpers/vault-tree.js')();
  const handle = Object.assign(tree.directory, { queryPermission: async () => 'granted' });
  const h = await vaultUI({ handle, vaultIndex: {}, rootFolder: 'AI 對話', scope: 'all' });
  h.records.push({ ...h.records[0], key: 'chatgpt:second', id: 'second' });
  tree.afterWrite(async () => {
    assert.ok(h.context.panel.state.operationController); assert.equal(h.node('#sync').disabled, true); assert.equal(h.node('#vault-export').disabled, true);
    const panel = h.context.panel;
    panel.state.tab = { id: 1 }; panel.state.platform = 'chatgpt'; panel.state.search.pending = true; panel.state.search.query = 'query';
    await panel.runSearch();
    h.node('#conversation-search').value = 'query'; panel.scheduleSearch();
    assert.equal(h.calls.length, 0);
    await h.node('#cancel-sync').emit('click');
  });
  await h.node('#vault-export').emit('click'); assert.equal(tree.files.size, 1); assert.equal(Object.keys(h.persisted().vaultIndex).length, 1);
  assert.match(h.node('#vault-report').textContent, /新增 1/); assert.equal(h.context.panel.state.operationController, null); assert.equal(h.calls.length, 0);
});

test('weekly review UI generates/streams locally, renders DOM citations, lists newest first, regenerates, cancels, toggles and deletes', async () => {
  const ui = dom(fs.readFileSync(require.resolve('../src/sidepanel/index.html'), 'utf8')), events = { addListener() {}, removeListener() {} };
  const data = { settings: { llm: { chatModel: 'local' } } }, session = {}, frames = new Map(), reviews = new Map(), keyval = new Map(), opened = [], requests = [];
  const now = Date.now(), week = require('../src/shared/digest.js').weekOf(now), range = require('../src/shared/digest.js').weekRange(week);
  const rows = [{ key: 'claude:a', id: 'a', platform: 'claude', title: '<img>Title', updateTime: range.start + 1, summary: { text: 'Summary' }, messages: [] }];
  const context = vm.createContext({ TextEncoder, TextDecoder, URL, AbortController, DOMException, Intl, Date, setTimeout, clearTimeout, document: ui.document,
    requestAnimationFrame: fn => { frames.set(1, fn); return 1; }, cancelAnimationFrame: id => frames.delete(id),
    chrome: { storage: { session: { get: async () => structuredClone(session), set: async patch => Object.assign(session, patch), remove: async key => { delete session[key]; } }, local: { get: async () => structuredClone(data), set: async patch => Object.assign(data, structuredClone(patch)) }, onChanged: events },
      tabs: { query: async () => [{ id: 1, url: 'https://chatgpt.com' }], update: async (id, value) => opened.push({ id, ...value }), sendMessage: async (...args) => requests.push(args), onActivated: events, onUpdated: events }, windows: { onFocusChanged: events } } });
  for (const file of ['ns', 'i18n', 'storage', 'llm', 'platforms', 'conversation', 'prompt-vars', 'search', 'rag', 'markdown', 'summary', 'digest', 'backfill', 'vault']) load(context, `shared/${file}.js`);
  context.SPC.db = { digests: { getAll: async () => [...reviews.values()], put: async value => reviews.set(value.week, structuredClone(value)), delete: async week => reviews.delete(week) },
    keyval: { get: async key => keyval.get(key), set: async (key, value) => keyval.set(key, value) }, getAll: async () => rows, vectors: { getAll: async () => [] }, chunks: { getAll: async () => [] }, clear: async () => { rows.length = 0; } };
  let chats = 0, finish;
  context.SPC.llm.chat = async (_, options) => { chats++; options.onText('*Draft* [1]'); return '# 本週主題\n\n**Review** [1] <img onerror=bad>'; };
  await loadPanel(context); const node = selector => ui.document.querySelector(selector);
  assert.equal(node('#digest-auto').checked, true); assert.equal(node('#digest-delete').disabled, true);
  await node('#digest-current').emit('click'); assert.equal(chats, 1); assert.equal(reviews.get(week).partial, true); assert.equal(reviews.get(week).sources[0].key, 'claude:a');
  assert.equal(node('#digest-answer').querySelector('strong').textContent, 'Review'); assert.equal(node('#digest-answer').querySelector('img'), null);
  await node('#digest-answer').querySelector('button').emit('click'); await flush(); assert.deepEqual(opened[0], { id: 1, url: 'https://claude.ai/chat/a' });
  await node('#digest-last').emit('click'); assert.equal(chats, 2); assert.equal(reviews.size, 2);
  assert.ok(node('#digest-list').children[0].textContent.startsWith(week)); await node('#digest-list').children[0].emit('click'); assert.match(node('#digest-info').textContent, /部分週次/);
  await node('#digest-regenerate').emit('click'); assert.equal(chats, 3); assert.equal(reviews.size, 2);
  node('#digest-auto').checked = false; await node('#digest-auto').emit('change'); assert.equal(data.settings.digest.autoWeekly, false);
  await context.SPC.i18n.setLang('en'); await context.panel.refreshLocal(); assert.equal(node('#digest-heading').textContent, 'Weekly review'); assert.equal(node('#digest-current').textContent, 'This week so far');
  session.backfillLease = { until: Date.now() + 60000 }; await node('#digest-current').emit('click'); assert.equal(chats, 3); assert.match(node('#status').textContent, /Background work/); delete session.backfillLease;
  context.SPC.llm.chat = (_, options) => { chats++; options.onText('Streaming'); return new Promise(resolve => { finish = resolve; }); };
  const pending = node('#digest-current').emit('click'); await flush();
  assert.equal(node('#digest-delete').disabled, true); assert.equal(node('#qa-ask').disabled, true); assert.ok(session.panelBusy);
  frames.get(1)(); frames.delete(1); assert.match(node('#digest-answer').textContent, /Streaming/);
  const original = reviews.get(week).text;
  await node('#cancel-sync').emit('click'); finish('Late replacement'); await pending;
  assert.equal(reviews.get(week).text, original); assert.equal(frames.size, 0); assert.equal(node('#digest-delete').disabled, false);
  await node('#clear-cache').emit('click'); await node('#editor-form').emit('submit'); assert.equal(rows.length, 0); assert.equal(reviews.size, 2);
  assert.equal((await context.SPC.store.exportBackup()).digests, undefined);
  await node('#digest-delete').emit('click'); assert.equal(reviews.has(week), false); assert.equal(keyval.get('digest-attempt:' + week).done, true); assert.equal(node('#digest-list').children.length, 1);
  assert.equal(requests.length, 0);
});

async function conversationUI({ local = {}, session = {}, reviews = [], fetch = () => { throw new Error('Unexpected fetch'); } } = {}) {
  const ui = dom(fs.readFileSync(require.resolve('../src/sidepanel/index.html'), 'utf8')), listeners = new Set(), events = { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) }, calls = [], downloads = [];
  let active = { id: 1, url: 'https://chatgpt.com/c/a' };
  const data = { settings: { llm: { chatModel: 'Qwen3' } }, folders: ['Work', 'Study', 'Ideas', 'Archive'].map((name, order) => ({ id: 'f' + order, name, order, color: '#258c7c' })),
    convMeta: { 'chatgpt:a': { folderId: 'f0', pinned: true, tags: ['one'] }, 'claude:b': { folderId: 'f1', tags: [] }, 'chatgpt:c': { folderId: 'deleted', tags: [] } } };
  Object.assign(data, local);
  const rows = [
    { key: 'chatgpt:a', platform: 'chatgpt', id: 'a', title: 'Alpha', summary: { text: '\n# Heading\n\n- **Useful** [link](https://example.com) and `code`\nLater line', model: 'Qwen3', createdAt: Date.now() - 600000 } },
    { key: 'claude:b', platform: 'claude', id: 'b', title: 'Beta' },
    { key: 'chatgpt:c', platform: 'chatgpt', id: 'c', title: 'Gamma' }
  ].map(row => ({ ...row, updateTime: Date.now() - 120000, messages: [{ role: 'user', text: 'Searchable body' }], fetchedAt: 1 }));
  const context = vm.createContext({ TextEncoder, TextDecoder, URL, AbortController, DOMException, Intl, Date, setTimeout, clearTimeout, document: ui.document,
    fetch,
    crypto: { randomUUID: () => 'new-folder' },
    chrome: { storage: { session: { get: async () => structuredClone(session), set: async patch => { Object.assign(session, structuredClone(patch)); listeners.forEach(fn => fn(Object.fromEntries(Object.entries(patch).map(([key, newValue]) => [key, { newValue }])), 'session')); }, remove: async key => { delete session[key]; } }, local: { get: async () => structuredClone(data), set: async patch => Object.assign(data, structuredClone(patch)) }, onChanged: events },
      tabs: { query: async () => active ? [active] : [], get: async () => active, update: async (...args) => calls.push(args),
        sendMessage: async (_tab, message) => { calls.push(message); return { ok: true, conversation: rows.find(row => row.id === message.payload.id) }; }, onActivated: events, onUpdated: events }, windows: { onFocusChanged: events } } });
  for (const file of ['ns', 'i18n', 'storage', 'llm', 'platforms', 'conversation', 'prompt-vars', 'search', 'rag', 'markdown', 'summary', 'digest', 'backfill', 'vault']) load(context, `shared/${file}.js`);
  context.SPC.db = { digests: { getAll: async () => reviews }, keyval: { get: async () => undefined, set: async () => {} }, chunks: { getAll: async () => [] }, vectors: { getAll: async () => [] },
    getAll: async () => rows, get: async key => rows.find(row => row.key === key), getMany: async keys => keys.map(key => rows.find(row => row.key === key)), put: async value => Object.assign(rows.find(row => row.key === value.key), value) };
  await loadPanel(context);
  const panel = context.SPC.panel, node = selector => ui.document.querySelector(selector);
  panel.download = (...args) => downloads.push(args);
  return { ...ui, node, panel, context, data, session, rows, calls, downloads, offline: () => { active = null; panel.state.tab = null; panel.state.platform = null; },
    button: (parent, text) => parent.querySelectorAll('button').find(button => button.textContent === text),
    dispose: () => { clearTimeout(panel.state.search.timer); panel.state.operationController = null; } };
}

test('folder chips count platform records independently of query, select filters, and support keyboard navigation', async t => {
  const h = await conversationUI(); t.after(h.dispose); const { node, panel } = h;
  const chips = () => node('#folder-list').children;
  assert.deepEqual(chips().map(chip => chip.textContent), ['全部 3', '已釘選 1', '未分類 1', 'Work 1', 'Study 1', 'Ideas 0', 'Archive 0']);
  assert.equal(chips()[0].attrs['aria-pressed'], 'true'); assert.equal(node('#conversation-count').textContent, '3 筆對話');
  await chips()[3].emit('click'); assert.equal(panel.state.folder, 'folder:f0'); assert.equal(chips()[3].attrs['aria-pressed'], 'true');
  assert.equal(node('#conversation-list').querySelectorAll('article').length, 1); assert.equal(node('.title-button').textContent, 'Alpha');
  assert.equal(chips()[3].scrolled.inline, 'nearest');
  await chips()[3].emit('keydown', { key: 'ArrowRight' }); await flush();
  assert.equal(panel.state.folder, 'folder:f1'); assert.equal(h.document.activeElement, chips()[4]); assert.equal(node('.title-button').textContent, 'Beta');
  await chips()[4].emit('keydown', { key: 'Home' }); await flush();
  node('#platform-filter').value = 'chatgpt'; await node('#platform-filter').emit('change');
  assert.deepEqual(chips().map(chip => chip.textContent), ['全部 2', '已釘選 1', '未分類 1', 'Work 1', 'Study 0', 'Ideas 0', 'Archive 0']);
  node('#conversation-search').value = 'Alpha'; panel.renderConversations();
  assert.equal(chips()[0].textContent, '全部 2'); assert.equal(node('#conversation-count').textContent, '1 筆結果');
  node('#conversation-search').value = ''; await chips()[1].emit('click'); assert.equal(node('.title-button').textContent, 'Alpha');
  await chips()[2].emit('click'); assert.equal(node('.title-button').textContent, 'Gamma'); assert.equal(chips()[2].attrs['aria-pressed'], 'true');
  assert.equal(node('#folder-list').querySelector('.danger'), null); assert.equal(node('#folder-list').querySelector('.folder-edit'), null);
});

test('header and card menus open, focus enabled items, close on Escape/outside/selection, and mirror operation availability', async t => {
  const h = await conversationUI(); t.after(h.dispose); const { node, panel, document } = h;
  const trigger = node('#conversation-menu-button'), menu = node('#conversation-menu');
  assert.equal(trigger.attrs['aria-haspopup'], 'menu'); assert.equal(menu.attrs.role, 'menu');
  assert.deepEqual(menu.children.filter(item => item.id !== 'quick-vault-export').map(item => item.attrs.role), Array(5).fill('menuitem'));
  await trigger.emit('click'); assert.equal(menu.hidden, false); assert.equal(trigger.attrs['aria-expanded'], 'true'); assert.equal(document.activeElement, node('#export-current'));
  await menu.emit('keydown', { key: 'ArrowDown' }); assert.equal(document.activeElement, node('#toggle-multi-select'));
  await menu.emit('keydown', { key: 'End' }); assert.equal(document.activeElement, node('#manage-folders'));
  await menu.emit('keydown', { key: 'Escape' }); assert.equal(menu.hidden, true); assert.equal(trigger.attrs['aria-expanded'], 'false'); assert.equal(document.activeElement, trigger);
  await trigger.emit('click'); await document.emit('click', { target: node('#conversation-search') }); assert.equal(menu.hidden, true);
  await trigger.emit('click'); await document.emit('click', { target: node('#suggest') }); assert.equal(menu.hidden, false, 'inside clicks are not outside clicks');
  await node('#add-folder').emit('click'); assert.equal(menu.hidden, true); assert.equal(panel.state.editor.title, 'addFolder'); await node('#editor-cancel').emit('click');
  panel.state.operationController = new AbortController(); panel.renderAvailability();
  assert.equal(node('#export-current').disabled, true); assert.equal(node('#suggest').disabled, true); assert.equal(node('#sync').disabled, true);
  for (const id of ['toggle-multi-select', 'add-folder', 'manage-folders']) assert.ok(!node('#' + id).disabled, id + ' preserves original local availability');
  await trigger.emit('keydown', { key: 'ArrowDown' }); assert.equal(document.activeElement, node('#toggle-multi-select'));
  await menu.emit('keydown', { key: 'ArrowDown' }); assert.equal(document.activeElement, node('#add-folder'), 'skip disabled suggestions');
  const cardMenu = node('#conversation-list').querySelector('.action-menu'), cardTrigger = node('.more-actions');
  assert.ok(cardMenu.children.every(item => item.disabled)); await cardTrigger.emit('click'); assert.equal(menu.hidden, true); assert.equal(cardMenu.hidden, false);
  await cardMenu.emit('keydown', { key: 'Escape' }); assert.equal(cardMenu.hidden, true); assert.equal(document.activeElement, cardTrigger);
  panel.state.operationController = null; h.offline(); panel.renderAvailability();
  assert.equal(node('#export-current').disabled, true); assert.equal(node('#suggest').disabled, false); assert.ok(cardMenu.children.every(item => !item.disabled));
});

test('folder manager uses the editor for rename/recolor, persists order and confirms deletion without losing conversations', async t => {
  const h = await conversationUI(); t.after(h.dispose); const { node, panel, data } = h;
  await node('#manage-folders').emit('click'); assert.equal(node('#folder-manager').open, true);
  const rows = () => node('#folder-manager-list').children;
  assert.equal(rows().length, 4); assert.equal(rows()[0].querySelector('.folder-up').disabled, true); assert.equal(rows()[3].querySelector('.folder-down').disabled, true);
  await rows()[0].querySelector('.folder-name').emit('click'); assert.equal(panel.state.editor.title, 'editFolder');
  node('#editor-form').elements.namedItem('name').value = 'Renamed'; node('#editor-form').elements.namedItem('color').value = '#112233'; await node('#editor-form').emit('submit');
  assert.equal(data.folders[0].name, 'Renamed'); assert.equal(data.folders[0].color, '#112233'); assert.equal(rows()[0].querySelector('.folder-name').textContent, 'Renamed');
  assert.equal(rows()[0].querySelector('.swatch').style.backgroundColor, '#112233');
  await rows()[0].querySelector('.folder-color').emit('click'); assert.equal(node('#editor-form').elements.namedItem('color').value, '#112233'); await node('#editor-cancel').emit('click');
  await rows()[0].querySelector('.folder-down').emit('click'); assert.deepEqual(data.folders.map(folder => [folder.id, folder.order]), [['f1', 0], ['f0', 1], ['f2', 2], ['f3', 3]]);
  assert.equal(node('#folder-list').children[3].textContent, 'Study 1');
  await rows()[1].querySelector('.folder-up').emit('click'); assert.equal(data.folders[0].id, 'f0');
  await rows()[0].querySelector('.danger').emit('click'); assert.equal(panel.state.editor.message.key, 'deleteFolderConfirm'); assert.equal(data.folders.length, 4);
  await node('#editor-cancel').emit('click'); assert.equal(data.folders.length, 4);
  await rows()[0].querySelector('.danger').emit('click'); await node('#editor-form').emit('submit');
  assert.equal(data.folders.length, 3); assert.equal(data.convMeta['chatgpt:a'].folderId, null); assert.equal(panel.state.conversations.length, 3);
  await node('#folder-manager-close').emit('click'); assert.equal(node('#folder-manager').open, false);
  await node('#add-folder').emit('click'); node('#editor-form').elements.namedItem('name').value = 'Added'; await node('#editor-form').emit('submit');
  assert.equal(data.folders.at(-1).name, 'Added'); assert.equal(data.folders.at(-1).order, 4);
});

test('multi-select menu check, bottom toolbar, select-all, move, export and exit preserve existing workflows', async t => {
  const h = await conversationUI(); t.after(h.dispose); const { node, panel, data } = h;
  await node('#toggle-multi-select').emit('click'); assert.equal(node('#multi-select').checked, true); assert.equal(node('#batch-toolbar').hidden, false);
  assert.match(node('#toggle-multi-select').textContent, /^✓ /); assert.equal(node('#batch-toolbar').children.includes(node('#selected-count')), true);
  assert.equal(node('#batch-move').disabled, true); await node('#select-all').emit('click'); assert.equal(panel.state.selected.size, 3);
  assert.equal(node('#selected-count').textContent, '已選 3 筆'); assert.equal(node('#batch-move').disabled, false);
  await node('#batch-move').emit('click'); node('#editor-form').elements.namedItem('folderId').value = 'f2'; await node('#editor-form').emit('submit');
  assert.ok(Object.values(data.convMeta).every(meta => meta.folderId === 'f2'));
  h.offline(); await node('#batch-export').emit('click'); assert.equal(panel.state.editor.title, 'batchExport');
  node('#editor-form').elements.namedItem('format').value = 'json'; await node('#editor-form').emit('submit'); assert.equal(JSON.parse(h.downloads[0][0]).length, 3);
  await node('#exit-multi-select').emit('click'); assert.equal(node('#multi-select').checked, false); assert.equal(node('#batch-toolbar').hidden, true);
  assert.equal(panel.state.selected.size, 0); assert.equal(node('#toggle-multi-select').textContent, '多選模式'); assert.equal(node('#conversation-list').querySelector('input'), null);
  assert.equal(h.document.activeElement, node('#conversation-menu-button'));
  const css = fs.readFileSync(require.resolve('../src/sidepanel/sidepanel.css'), 'utf8'); assert.match(css, /#batch-toolbar\{position:fixed;bottom:0/);
});

test('cards show safe summary preview only without query, safe highlighted snippets with keyword or semantic query, and relative summary metadata', async t => {
  const h = await conversationUI(); t.after(h.dispose); const { node, panel } = h;
  assert.equal(node('.snippet'), null); assert.equal(node('.summary-preview').textContent, 'Useful link and code');
  assert.equal(node('.summary-preview').children.length, 0); assert.equal(node('#conversation-list').querySelectorAll('.summary-preview').length, 1);
  assert.equal(panel.summaryPreview('Heading\n=======\n\n**First**\nSecond'), 'First'); assert.equal(panel.summaryPreview('# Only heading\n\n'), '');
  const summary = node('.summary-text').parent.querySelector('summary'); assert.match(summary.textContent, /^摘要 · /); assert.ok(!summary.textContent.includes('Qwen3')); assert.match(summary.title, /Qwen3/);
  assert.equal(node('.date').title, panel.formatDate(h.rows[0].updateTime, true));
  node('#conversation-search').value = 'Searchable'; panel.renderConversations();
  assert.equal(node('.summary-preview'), null); assert.equal(node('#conversation-list').querySelectorAll('.snippet').length, 3); assert.equal(node('.snippet').querySelector('mark').textContent, 'Searchable');
  panel.state.searchMode = 'semantic'; panel.state.search.query = 'Useful'; node('#conversation-search').value = 'Useful';
  panel.state.search.semantic = [{ key: 'chatgpt:a', score: 0.9, snippet: '**Useful** <img onerror=bad>' }]; panel.renderConversations();
  assert.equal(node('.snippet').querySelector('strong').textContent, 'Useful'); assert.equal(node('.snippet').querySelector('mark').textContent, 'Useful'); assert.equal(node('.snippet').querySelector('img'), null);
  node('#conversation-search').value = ''; panel.renderConversations(); assert.equal(node('.snippet'), null); assert.equal(node('.summary-preview').textContent, 'Useful link and code');
});

test('visible card actions retain pin, move, tags, local summary and menu title/revert/export behavior', async t => {
  const h = await conversationUI(); t.after(h.dispose); const { node, panel, data, button } = h;
  const actions = () => node('.card-actions'), action = text => button(actions(), text);
  assert.equal(actions().parent.tagName, 'ARTICLE'); assert.ok(action('取消釘選')); assert.ok(action('移動')); assert.ok(action('標籤')); assert.ok(action('摘要'));
  await action('取消釘選').emit('click'); assert.equal(data.convMeta['chatgpt:a'].pinned, false); await action('釘選').emit('click'); assert.equal(data.convMeta['chatgpt:a'].pinned, true);
  await action('移動').emit('click'); assert.equal(panel.state.editor.title, 'move'); node('#editor-form').elements.namedItem('folderId').value = 'f3'; await node('#editor-form').emit('submit'); assert.equal(data.convMeta['chatgpt:a'].folderId, 'f3');
  await action('標籤').emit('click'); node('#editor-form').elements.namedItem('tags').value = 'new, tags'; await node('#editor-form').emit('submit'); assert.deepEqual(data.convMeta['chatgpt:a'].tags, ['new', 'tags']);
  h.context.SPC.llm.chat = async () => 'New local summary'; panel.maintainChunks = async () => {}; await action('摘要').emit('click'); assert.equal(h.rows[0].summary.text, 'New local summary'); assert.equal(h.calls.length, 0);
  await node('.more-actions').emit('click'); await action('編輯標題').emit('click'); assert.equal(panel.state.editor.title, 'editTitle'); node('#editor-form').elements.namedItem('title').value = 'Local title'; await node('#editor-form').emit('submit'); assert.equal(data.convMeta['chatgpt:a'].customTitle, 'Local title');
  await node('.more-actions').emit('click'); await action('還原原標題').emit('click'); await node('#editor-form').emit('submit'); assert.equal(data.convMeta['chatgpt:a'].customTitle, null);
  h.offline(); await action('匯出 Markdown').emit('click'); assert.equal(h.downloads[0][2], 'md'); await action('匯出 JSON').emit('click'); assert.equal(h.downloads[1][2], 'json'); assert.equal(JSON.parse(h.downloads[1][0]).title, 'Alpha');
});

test('relative dates cover minute/hour/calendar/year boundaries in zh-TW and en', async t => {
  const h = await conversationUI(); t.after(h.dispose); const relative = h.panel.relativeDate, now = new Date(2026, 9, 7, 12).getTime();
  for (const [lang, expected] of [['zh-TW', ['剛剛', '59 分鐘前', '23 小時前', '昨天', '6 天前']], ['en', ['Just now', '59 minutes ago', '23 hours ago', 'yesterday', '6 days ago']]]) {
    assert.equal(relative(now - 59000, now, lang), expected[0]); assert.equal(relative(now - 59 * 60000, now, lang), expected[1]); assert.equal(relative(now - 23 * 3600000, now, lang), expected[2]);
    assert.equal(relative(new Date(2026, 9, 6, 0, 30).getTime(), new Date(2026, 9, 7, 1).getTime(), lang), expected[3]);
    assert.equal(relative(new Date(2026, 9, 1, 23, 59).getTime(), now, lang), expected[4]);
    const sameYear = new Date(2026, 8, 1).getTime(), previousYear = new Date(2025, 11, 31).getTime();
    assert.equal(relative(sameYear, now, lang), new Intl.DateTimeFormat(lang, { month: 'short', day: 'numeric' }).format(sameYear));
    assert.equal(relative(previousYear, now, lang), new Intl.DateTimeFormat(lang, { dateStyle: 'medium' }).format(previousYear));
    assert.equal(relative(now - 60000, now, lang), new Intl.RelativeTimeFormat(lang).format(-1, 'minute'));
    assert.equal(relative(now - 3600000, now, lang), new Intl.RelativeTimeFormat(lang).format(-1, 'hour'));
    const sevenDays = now - 7 * 86400000; assert.equal(relative(sevenDays, now, lang), new Intl.DateTimeFormat(lang, { month: 'short', day: 'numeric' }).format(sevenDays));
  }
});


test('new conversation controls and previews update to English without changing existing translations', async t => {
  const h = await conversationUI(); t.after(h.dispose); const { node, panel } = h;
  await h.context.SPC.i18n.setLang('en'); panel.localize();
  assert.equal(node('#manage-folders').textContent, 'Manage folders'); assert.equal(node('#conversation-menu-button').attrs['aria-label'], 'More actions');
  assert.equal(node('#exit-multi-select').attrs['aria-label'], 'Exit multi-select'); assert.equal(node('#conversation-count').textContent, '3 conversations');
  assert.ok(h.button(node('.card-actions'), 'Move')); assert.ok(h.button(node('.card-actions'), 'Tags')); assert.ok(h.button(node('.card-actions'), 'Summary'));
  await node('#manage-folders').emit('click'); assert.equal(node('#folder-manager-title').textContent, 'Manage folders');
  assert.equal(node('.folder-up').attrs['aria-label'], 'Move folder up'); assert.equal(node('.folder-down').attrs['aria-label'], 'Move folder down');
});

test('Settings accordion is single-open, accessible, remembers collapse/reopen and retains controls', async t => {
  const h = await conversationUI(); t.after(h.dispose);
  const sections = ['general', 'llm', 'backfill', 'vault', 'diagnostics', 'data'];
  const check = name => {
    for (const section of sections) {
      assert.equal(h.node('#settings-' + section + '-toggle').attrs['aria-expanded'], String(section === name));
      assert.equal(h.node('#settings-' + section + '-toggle').attrs['aria-controls'], 'settings-' + section + '-body');
      assert.equal(h.node('#settings-' + section + '-body').hidden, section !== name);
    }
  };
  check(null);
  for (const section of sections) { await h.node('#settings-' + section + '-toggle').emit('click'); check(section); assert.equal(h.data['ui.settingsSection'], section); }
  const reopened = await conversationUI({ local: h.data }); t.after(reopened.dispose);
  assert.equal(reopened.node('#settings-data-toggle').attrs['aria-expanded'], 'true');
  await h.node('#settings-data-toggle').emit('click'); check(null); assert.equal(h.data['ui.settingsSection'], null);
  await h.panel.openSettingsSection('general'); h.node('#sync-delay').value = '2100'; await h.node('#delay-form').emit('submit');
  await h.panel.openSettingsSection('llm'); await h.panel.openSettingsSection('general');
  assert.equal(h.node('#sync-delay').value, 2100); assert.equal(h.data.settings.syncDelayMs, 2100);
  h.node('#language').value = 'en'; await h.node('#language').emit('change'); assert.equal(h.node('#settings-general-status').textContent, 'English · 2100 ms');
  await h.panel.openSettingsSection('data'); await h.node('#backup').emit('click'); assert.equal(h.downloads[0][2], 'json');
  assert.ok(h.node('#settings-data-body').contains(h.node('#clear-index')));
  const original = fs.readFileSync(require.resolve('../src/sidepanel/index.html'), 'utf8');
  for (const id of ['llm-form', 'build-index', 'backfill-enabled', 'vault-export', 'diagnostic-run', 'backup', 'clear-cache', 'clear-index']) assert.equal([...original.matchAll(new RegExp('id="' + id + '"', 'g'))].length, 1, id);
  assert.equal(h.calls.length, 0);
});

test('Settings summaries and compact health use persisted state, update without requests and navigate', async t => {
  let fetches = 0;
  const h = await conversationUI({ local: { settings: {} }, fetch: () => { fetches++; throw new Error('Unexpected fetch'); } }); t.after(h.dispose);
  const { node, panel, context } = h;
  assert.equal(node('#settings-general-status').textContent, '繁體中文 · 1500 ms');
  assert.equal(node('#settings-llm-status').textContent, '○ 未設定'); assert.equal(node('#health-llm').className, 'health-unknown');
  assert.match(node('#health-llm').attrs['aria-label'], /未設定/); assert.equal(node('#health-backfill').hidden, true);
  assert.equal(node('#settings-backfill-status').textContent, '未啟用'); assert.equal(node('#settings-vault-status').textContent, '尚未選擇 Vault');
  assert.equal(node('#settings-diagnostics-status').textContent, '尚未執行'); assert.equal(node('#settings-data-status').textContent, '3 筆對話 · 3 筆內文');
  panel.state.settings.llm.chatModel = 'chat'; panel.renderSettingsStatus(); assert.equal(node('#settings-llm-status').textContent, '○ 尚未測試');
  await context.chrome.storage.session.set({ llmStatus: { ok: true, at: Date.now(), chatModel: 'Used model' } });
  assert.equal(node('#settings-llm-status').textContent, '● 已連線 · Used model'); assert.equal(node('#health-llm').className, 'health-ok');
  await node('#health-llm').emit('click'); assert.equal(panel.state.pane, 'settings'); assert.equal(node('#settings-llm-body').hidden, false);
  await context.chrome.storage.session.set({ llmStatus: { ok: false, at: Date.now(), chatModel: 'Used model' } });
  assert.equal(node('#settings-llm-status').textContent, '● 無法連線'); assert.equal(node('#health-llm').className, 'health-failed');
  panel.state.backfillStatus = { ...context.SPC.store.normalizeBackfill({}), enabled: true, day: context.SPC.backfill.localDay(), doneToday: 3, dailyLimit: 7 };
  panel.state.vaultName = 'Notes'; panel.state.vaultLastExport = { ok: true, at: Date.now() };
  panel.state.diagnosticsLast = { failed: 2, total: 10, at: Date.now() }; panel.renderSettingsStatus();
  assert.equal(node('#health-backfill').hidden, false); assert.equal(node('#health-backfill').textContent, '補摘要 3/7');
  assert.equal(node('#settings-backfill-status').textContent, '啟用 · 今日 3/7'); assert.equal(node('#settings-vault-status').textContent, 'Notes · 上次匯出 剛剛');
  assert.equal(node('#settings-diagnostics-status').textContent, '上次：2 項失敗 · 剛剛');
  await node('#health-backfill').emit('click'); assert.equal(node('#settings-backfill-body').hidden, false); assert.equal(node('#settings-llm-body').hidden, true);
  panel.state.diagnosticsLast.failed = 0; panel.state.backfillStatus.day = '2000-01-01'; panel.renderSettingsStatus();
  assert.equal(node('#health-backfill').textContent, '補摘要 0/7'); assert.equal(node('#settings-diagnostics-status').textContent, '上次：全部通過 · 剛剛');
  panel.state.backfillStatus.enabled = false; panel.renderSettingsStatus(); assert.equal(node('#health-backfill').hidden, true);
  assert.equal(fetches, 0); assert.equal(h.calls.length, 0);
  const restored = await conversationUI({ session: h.session, local: { diagnosticsLast: { failed: 1, total: 8, at: Date.now() } } }); t.after(restored.dispose);
  assert.equal(restored.node('#health-llm').className, 'health-failed'); assert.match(restored.node('#settings-diagnostics-status').textContent, /1 項失敗/);
});

test('real LLM test and summary update health only after the existing calls complete', async t => {
  const calls = []; let fail = false;
  const h = await conversationUI({ fetch: async (url) => {
    calls.push(url); if (fail) throw new Error('offline');
    return { ok: true, json: async () => ({ data: [{ id: 'Qwen3' }] }), body: new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Summary"}}]}\n\ndata: [DONE]\n\n')); controller.close();
    } }) };
  } }); t.after(h.dispose);
  assert.equal(calls.length, 0); assert.equal(h.session.llmStatus, undefined);
  await h.node('#llm-test').emit('click'); assert.equal(calls.length, 1); assert.equal(h.session.llmStatus.ok, true); assert.equal(h.node('#health-llm').className, 'health-ok');
  h.context.requestAnimationFrame = () => 1; h.context.cancelAnimationFrame = () => {};
  await h.panel.summarize(h.rows[0]); assert.equal(calls.length, 2); assert.equal(h.rows[0].summary.text, 'Summary'); assert.equal(h.session.llmStatus.chatModel, 'Qwen3');
  fail = true; await h.node('#llm-test').emit('click'); assert.equal(calls.length, 3); assert.equal(h.session.llmStatus.ok, false); assert.equal(h.node('#health-llm').className, 'health-failed');
  await h.node('#health-llm').emit('click'); h.panel.localize(); assert.equal(calls.length, 3); assert.equal(h.calls.length, 0);
});

test('quick vault menu reuses persisted handle and permission, or opens Vault settings without requests', async () => {
  const missing = await vaultUI(); await missing.node('#conversation-menu-button').emit('click'); await missing.node('#quick-vault-export').emit('click');
  assert.equal(missing.node('#conversation-menu').hidden, true); assert.equal(missing.context.panel.state.pane, 'settings');
  assert.equal(missing.node('#settings-vault-body').hidden, false); assert.match(missing.node('#status').textContent, /請先選擇 Vault/); assert.equal(missing.calls.length, 0);
  const tree = require('./helpers/vault-tree.js')(), permissions = [];
  const handle = Object.assign(tree.directory, { queryPermission: async () => { permissions.push('query'); return 'prompt'; }, requestPermission: async () => { permissions.push('request'); return 'granted'; } });
  const h = await vaultUI({ handle, vaultIndex: {}, rootFolder: 'Notes', scope: 'all' });
  assert.equal(h.node('#quick-vault-export').attrs.role, 'menuitem');
  await h.node('#conversation-menu-button').emit('click'); await h.node('#quick-vault-export').emit('click');
  assert.deepEqual(permissions, ['query', 'request']); assert.equal(h.node('#conversation-menu').hidden, true);
  assert.equal(h.data.vaultLastExport.ok, true); assert.equal(h.data.vaultLastExport.created, 1); assert.ok(h.data.vaultLastExport.at > 0);
  assert.equal(h.node('#settings-vault-status').textContent, 'Vault · 上次匯出 剛剛'); assert.ok(h.persisted().vaultIndex['chatgpt:abcdef']); assert.equal(h.calls.length, 0);
  h.context.panel.state.operationController = new AbortController(); h.context.panel.renderAvailability(); assert.equal(h.node('#quick-vault-export').disabled, true);
  await h.node('#quick-vault-export').emit('click'); assert.equal(permissions.length, 2); h.context.panel.state.operationController = null;
});

test('Q&A has separate sections, index/review empty states, and history appears only with entries', async t => {
  const h = await conversationUI(); t.after(h.dispose); const { node, panel } = h;
  assert.equal(node('#qa').querySelectorAll('.qa-section').length, 2); assert.equal(node('#qa-heading').textContent, '問答'); assert.equal(node('#digest-heading').textContent, '每週回顧');
  assert.match(node('#qa').textContent, /只用本機資料與本地 LLM，不會向 ChatGPT／Claude 發出請求/);
  assert.equal(node('#qa-history-toggle').hidden, true); assert.equal(node('#digest-empty').hidden, false); assert.match(node('#digest-empty').textContent, /每週一 06:00/);
  assert.equal(node('#digest-regenerate').hidden, true); assert.equal(node('#digest-delete').hidden, true); assert.equal(node('#digest-actions').hidden, true);
  assert.equal(node('#qa-hint').hidden, false); await node('#qa-hint').querySelector('button').emit('click'); assert.equal(node('#settings-llm-body').hidden, false); assert.equal(panel.state.pane, 'settings');
  panel.state.qa.history = [{ question: 'Saved', answer: 'Answer', sources: [] }]; panel.renderQAHistory(); assert.equal(node('#qa-history-toggle').hidden, false);
  panel.state.qa.history = []; panel.renderQAHistory(); assert.equal(node('#qa-history-toggle').hidden, true);
  panel.state.chunks = [{ model: panel.state.settings.llm.embeddingModel, convKey: 'chatgpt:a' }]; panel.renderQA(); assert.equal(node('#qa-hint').hidden, true);
  assert.equal(h.calls.length, 0);
});

test('review rows sort by week, show dates and partial badge, and expose actions for selection only', async t => {
  const old = { week: '2026-W40', start: new Date(2026, 8, 28).getTime(), end: new Date(2026, 9, 5).getTime(), text: 'Older', model: 'local', sources: [], partial: false };
  const recent = { ...old, week: '2026-W41', start: old.end, end: new Date(2026, 9, 12).getTime(), partial: true };
  const h = await conversationUI({ reviews: [old, recent] }); t.after(h.dispose); const { node, panel } = h;
  const rows = node('#digest-list').children;
  assert.equal(rows.length, 2); assert.ok(rows[0].textContent.startsWith('2026-W41')); assert.ok(rows[1].textContent.startsWith('2026-W40'));
  assert.equal(rows[0].querySelector('.chip').textContent, '本週至今'); assert.equal(rows[1].querySelector('.chip'), null);
  assert.equal(rows[0].querySelector('.muted').textContent, panel.formatDate(recent.start) + ' – ' + panel.formatDate(recent.end - 1));
  assert.equal(node('#digest-empty').hidden, true); assert.equal(node('#digest-delete').hidden, true);
  await rows[0].emit('click'); assert.equal(node('#digest-regenerate').hidden, false); assert.equal(node('#digest-delete').hidden, false); assert.equal(node('#digest-actions').hidden, false);
  assert.equal(node('#digest-list').children[0].attrs['aria-pressed'], 'true'); assert.equal(node('#digest-list').children[1].attrs['aria-pressed'], 'false');
  await node('#digest-list').children[1].emit('click'); assert.equal(node('#digest-list').children[1].attrs['aria-pressed'], 'true'); assert.match(node('#digest-info').textContent, /2026-W40/);
  assert.equal(h.calls.length, 0);
});

test('Prompt hint detects Mac and non-Mac, localizes and distinguishes empty library from empty search', async t => {
  const h = await conversationUI(); t.after(h.dispose); const { node, panel, context } = h;
  assert.match(node('#prompt-list').textContent, /還沒有 Prompt.*新增 Prompt.*\{\{變數\}\}/); assert.match(node('#prompt-menu-hint').textContent, /Ctrl\+Shift\+P/);
  for (const navigator of [{ platform: 'MacIntel' }, { userAgentData: { platform: 'macOS' }, platform: 'Win32' }]) {
    context.navigator = navigator; panel.renderPrompts(); assert.match(node('#prompt-menu-hint').textContent, /⌘⇧P/); assert.match(node('#prompt-menu-hint').textContent, /開頭輸入 \/\//);
  }
  context.navigator = { userAgentData: { platform: 'Windows' }, platform: 'MacIntel' }; panel.renderPrompts(); assert.match(node('#prompt-menu-hint').textContent, /Ctrl\+Shift\+P/);
  await context.SPC.i18n.setLang('en'); panel.localize(); assert.match(node('#prompt-list').textContent, /No prompts yet.*\{\{variables\}\}/); assert.match(node('#prompt-menu-hint').textContent, /start of a ChatGPT\/Claude input/);
  panel.state.prompts = [{ title: 'Saved', content: 'Text', tags: [] }]; node('#prompt-search').value = 'missing'; panel.renderPrompts(); assert.equal(node('#prompt-list').textContent, context.SPC.i18n.t('noPrompts'));
});

test('diagnostics persists only failed/total/time, leaving the existing no-data-write assertion intact', async () => {
  const h = await diagnosticUI(); await h.node('#diagnostic-run').emit('click');
  assert.equal(h.writes.length, 0); assert.equal(h.outcomeWrites.length, 1);
  const value = h.outcomeWrites[0].diagnosticsLast;
  assert.deepEqual(Object.keys(value).sort(), ['at', 'failed', 'total']); assert.equal(value.failed, 1); assert.equal(value.total, h.node('#diagnostic-results').children.length); assert.ok(value.at > 0);
  assert.match(h.node('#settings-diagnostics-status').textContent, /1 項失敗/);
});
