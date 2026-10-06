'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { create, normalizeBaseUrl, stripThinking, parseJSONLoose } = require('../src/shared/llm.js');
const config = { baseUrl: 'http://127.0.0.1:11123/v1', apiKey: 'secret', chatModel: 'Qwen3', embeddingModel: 'Qwen3-Embedding-0.6B', disableThinking: true };
const json = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
test('local URL validation accepts only literal loopback hosts and rejects aliases, credentials, query and redirects', async () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) for (const protocol of ['http', 'https']) {
    assert.equal(normalizeBaseUrl(` ${protocol}://${host}:1234/v1/// `), `${protocol}://${host}:1234/v1`);
  }
  for (const url of ['https://example.com/v1', 'http://127.1/v1', 'http://2130706433/v1', 'http://0x7f000001/v1', 'http://127.0.0.2/v1',
    'http://localhost.evil.test', 'http://localhost@evil.test', 'http://key@localhost/v1', 'http://localhost./v1', 'ftp://localhost/v1',
    'http://[::ffff:127.0.0.1]', 'http://localhost/v1?key=secret', 'http://localhost/v1#fragment', 'http://localhost\\@evil.test', '', null]) assert.throws(() => normalizeBaseUrl(url));
  let called = false;
  await assert.rejects(create(() => { called = true; }).listModels({ ...config, baseUrl: 'https://chatgpt.com/v1' })); assert.equal(called, false);
});
test('models and chat send auth and never follow redirects or send cookies', async () => {
  const calls = [], api = create(async (url, options) => { calls.push({ url, options }); return json(url.endsWith('/models') ? { data: [{ id: 'Qwen3' }] } : { choices: [{ message: { content: '<think>private</think> Visible' } }] }); });
  assert.deepEqual(await api.listModels(config), ['Qwen3']); assert.equal(await api.chat(config, { messages: [] }), 'Visible');
  for (const call of calls) { assert.equal(call.options.headers.Authorization, 'Bearer secret'); assert.equal(call.options.redirect, 'error'); assert.equal(call.options.credentials, 'omit'); }
  assert.equal(JSON.parse(calls[1].options.body).chat_template_kwargs.enable_thinking, false);
});
test('thinking strips complete, repeated, unterminated and split opening blocks', () => {
  assert.equal(stripThinking('<think>secret</think> answer <think>more</think>!'), 'answer !');
  assert.equal(stripThinking('<think>secret'), ''); assert.equal(stripThinking('visible<think>secret'), 'visible');
  for (const suffix of ['<', '<t', '<th', '<thi', '<thin', '<think', '<think>unfinished']) assert.equal(stripThinking('visible' + suffix), 'visible');
});
test('SSE handles arbitrary byte boundaries, UTF-8, CRLF, keepalives, reasoning and DONE', async () => {
  const events = ': keepalive\r\n\r\ndata: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'secret' } }] }) + '\r\n\r\n' +
    ['<thi', 'nk>private', '</think>答', '案'].map(content => 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n').join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(events), visible = [];
  const api = create(async () => ({ ok: true, body: new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }) }));
  assert.equal(await api.chat(config, { stream: true, messages: [], onText: text => visible.push(text) }), '答案');
  assert.ok(visible.includes('')); assert.ok(visible.includes('答')); assert.ok(visible.every(text => !/secret|private|think/.test(text)));
});
test('400 and 422 retry once without thinking option and remember per endpoint/model', async () => {
  for (const status of [400, 422]) {
    const bodies = [], api = create(async (_, options) => { const body = JSON.parse(options.body); bodies.push(body); return bodies.length === 1 ? json({}, status) : json({ choices: [{ message: { content: 'OK' } }] }); });
    await api.chat(config, { messages: [] }); await api.chat(config, { messages: [] });
    assert.equal(bodies.length, 3); assert.ok(bodies[0].chat_template_kwargs); assert.ok(!bodies[1].chat_template_kwargs); assert.ok(!bodies[2].chat_template_kwargs);
  }
});
test('embedding requests are sequential batches of at most 32 and response order is restored', async () => {
  const sizes = []; let active = 0;
  const api = create(async (_, options) => {
    assert.equal(active++, 0); const body = JSON.parse(options.body); sizes.push(body.input.length);
    await new Promise(resolve => setImmediate(resolve)); active--;
    return json({ data: body.input.map((value, index) => ({ index, embedding: [Number(value), 1] })).reverse() });
  });
  const vectors = await api.embed(config, Array.from({ length: 65 }, (_, i) => String(i)));
  assert.deepEqual(sizes, [32, 32, 1]); assert.deepEqual(vectors[64], [64, 1]);
});
test('loose JSON strips reasoning, handles fences, arrays, prose and quoted brackets', () => {
  for (const text of ['{"items":[]}', '```json\n{"items":[]}\n```', '<think>{"wrong":true}</think> Here: {"items":[]} done']) assert.deepEqual(parseJSONLoose(text), { items: [] });
  assert.deepEqual(parseJSONLoose('Here: [{"text":"} \\\" ["}] trailing'), [{ text: '} " [' }]);
  assert.throws(() => parseJSONLoose('<think>{"items":[]}')); assert.throws(() => parseJSONLoose('no JSON'));
});
test('connection failures and auth/status errors are safe and cancellation wins', async () => {
  await assert.rejects(create(async () => { throw new TypeError('secret transport'); }).listModels(config), /無法連線到本地 LLM.*127\.0\.0\.1/);
  for (const status of [401, 403]) await assert.rejects(create(async () => json({}, status)).listModels(config), /本地 LLM 拒絕存取/);
  await assert.rejects(create(async () => json({}, 500)).listModels(config), /500/);
  const controller = new AbortController(), api = create(() => new Promise(() => {}));
  const pending = api.chat(config, { messages: [], signal: controller.signal }); controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(api.embed(config, ['a'], { signal: controller.signal }), { name: 'AbortError' });
});
test('prompt optimization rejects modified placeholders instead of inserting them', async () => {
  const api = create(async () => json({ choices: [{ message: { content: 'Improve {{name}}' } }] }));
  assert.equal(await api.optimize(config, 'Original {{name}}'), 'Improve {{name}}');
  await assert.rejects(api.optimize(config, 'Original {{ name }}'), /變數/);
});
test('timeouts cover pending fetches with ten/two minute budgets', async () => {
  const fs = require('node:fs'), vm = require('node:vm'), timers = new Map(); let timerId = 0;
  const context = vm.createContext({ URL, AbortController, DOMException, TextDecoder,
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id),
    SPC: { store: require('../src/shared/storage.js') } });
  vm.runInContext(fs.readFileSync(require.resolve('../src/shared/llm.js'), 'utf8'), context);
  const api = context.SPC.llm.create(() => new Promise(() => {}));
  for (const [run, timeout] of [[() => api.chat(config, { messages: [] }), 600000], [() => api.embed(config, ['text']), 120000]]) {
    const operation = run(), timer = [...timers.values()][0]; assert.equal(timer.delay, timeout); timer.fn();
    await assert.rejects(operation, /無法連線到本地 LLM/); assert.equal(timers.size, 0);
  }
});
test('stream cancellation aborts the reader and never returns or displays later text', async () => {
  const controller = new AbortController(), displayed = [];
  const api = create(async (_url, options) => ({ ok: true, body: new ReadableStream({ start(stream) {
    stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Visible"}}]}\n\n'));
    options.signal.addEventListener('abort', () => stream.error(new DOMException('Cancelled', 'AbortError')));
  } }) }));
  const pending = api.chat(config, { stream: true, messages: [], signal: controller.signal, onText: text => { displayed.push(text); controller.abort(); } });
  await assert.rejects(pending, { name: 'AbortError' }); assert.deepEqual(displayed, ['Visible']);
});
test('malformed embedding dimensions, values and response indices are rejected', async () => {
  for (const data of [[{ index: 0, embedding: [NaN] }], [{ index: 1, embedding: [1] }], [{ index: 0, embedding: [] }]]) {
    await assert.rejects(create(async () => json({ data })).embed(config, ['text']), /格式/);
  }
});

test('llmStatus records outcomes of real calls only, without adding fetches or changing errors', async () => {
  const fs = require('node:fs'), vm = require('node:vm'), writes = [], calls = [];
  const context = vm.createContext({ URL, AbortController, DOMException, TextDecoder, setTimeout, clearTimeout,
    chrome: { storage: { session: { set: async value => writes.push(JSON.parse(JSON.stringify(value))) } } }, SPC: { store: require('../src/shared/storage.js') } });
  vm.runInContext(fs.readFileSync(require.resolve('../src/shared/llm.js'), 'utf8'), context);
  let mode = 'ok';
  const api = context.SPC.llm.create(async (url, options) => {
    calls.push(url);
    if (mode === 'offline') throw new TypeError('offline');
    if (mode === 'invalid') return json({ data: 'bad' });
    if (mode === 'retry') { mode = 'ok'; return json({}, 400); }
    if (url.endsWith('/models')) return json({ data: [{ id: 'Qwen3' }] });
    if (url.endsWith('/embeddings')) return json({ data: JSON.parse(options.body).input.map((_, index) => ({ index, embedding: [1, 0] })) });
    return json({ choices: [{ message: { content: 'Visible {{name}}' } }] });
  });
  assert.equal(writes.length, 0); assert.equal(calls.length, 0);
  await assert.rejects(api.chat({ ...config, chatModel: '' }, { messages: [] }));
  await assert.rejects(api.listModels({ ...config, baseUrl: 'https://remote.test' }));
  await api.embed(config, []);
  const controller = new AbortController(); controller.abort(); await assert.rejects(api.chat(config, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(writes.length, 0); assert.equal(calls.length, 0);
  const check = ok => {
    const value = writes.at(-1).llmStatus;
    assert.deepEqual(Object.keys(value).sort(), ['at', 'chatModel', 'ok']); assert.equal(value.ok, ok); assert.equal(value.chatModel, config.chatModel); assert.ok(value.at > 0);
  };
  await api.listModels(config); check(true); assert.equal(calls.length, 1); assert.equal(writes.length, 1);
  await api.chat(config, { messages: [] }); check(true); assert.equal(calls.length, 2); assert.equal(writes.length, 2);
  await api.embed(config, Array(65).fill('input')); check(true); assert.equal(calls.length, 5); assert.equal(writes.length, 3);
  await api.optimize(config, 'Original {{name}}'); check(true); assert.equal(calls.length, 6); assert.equal(writes.length, 4);
  mode = 'offline'; await assert.rejects(api.listModels(config), /無法連線/); check(false); assert.equal(calls.length, 7); assert.equal(writes.length, 5);
  mode = 'invalid'; await assert.rejects(api.listModels(config), /格式/); check(false); assert.equal(calls.length, 8); assert.equal(writes.length, 6);
  mode = 'retry'; await api.chat(config, { messages: [] }); check(true); assert.equal(calls.length, 10); assert.equal(writes.length, 7);
  context.chrome.storage.session.set = async () => { throw new Error('storage unavailable'); };
  assert.equal(await api.chat(config, { messages: [] }), 'Visible {{name}}'); assert.equal(calls.length, 11);
  mode = 'offline'; await assert.rejects(api.listModels(config), /無法連線/); assert.equal(calls.length, 12);
});

test('a cancelled call does not record an LLM status', async () => {
  const writes = [], controller = new AbortController();
  globalThis.chrome = { storage: { session: { set: async value => { writes.push(value); } } } };
  try {
    const client = require('../src/shared/llm.js').create(async (_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')));
    }));
    const pending = client.chat({ baseUrl: 'http://127.0.0.1:11123/v1', chatModel: 'm' }, { messages: [], signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.deepEqual(writes, []);
  } finally { delete globalThis.chrome; }
});
