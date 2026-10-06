(function (root) {
  'use strict';
  const SPC = (root.SPC = root.SPC || {});
  const store = SPC.store || (typeof require === 'function' ? require('./storage.js') : null);
  const normalizeBaseUrl = url => store.normalizeBaseUrl(url);
  const t = (key, vars) => SPC.i18n?.t(key, vars) || ({ llmOffline: `無法連線到本地 LLM，請確認 oMLX 已啟動（${vars?.baseUrl}）`,
    llmAuth: '本地 LLM 拒絕存取，請檢查 API key', llmHTTP: `本地 LLM 請求失敗（${vars?.status}）`,
    llmInvalid: '本地 LLM 回應格式不正確', llmChatRequired: '請在設定選擇對話模型', llmEmbeddingRequired: '請在設定選擇 Embedding 模型',
    llmPlaceholders: '優化結果改動了變數，請重試', llmEmpty: '本地 LLM 未回傳可見文字' })[key];
  function stripThinking(text) {
    return String(text || '').replace(/<think\b[^>]*>[\s\S]*?(?:<\/think\s*>|$)/gi, '')
      .replace(/<think\b[^>]*$/gi, '').replace(/<(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?$/i, '').trim();
  }
  function parseJSONLoose(text) {
    const source = stripThinking(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    for (let start = 0; start < source.length; start++) {
      if (!'{['.includes(source[start])) continue;
      const stack = []; let quoted = false, escaped = false;
      for (let i = start; i < source.length; i++) {
        const char = source[i];
        if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
        if (char === '"') quoted = true;
        else if ('{['.includes(char)) stack.push(char);
        else if ('}]'.includes(char)) {
          if (stack.pop() !== (char === '}' ? '{' : '[')) break;
          if (!stack.length) { try { return JSON.parse(source.slice(start, i + 1)); } catch (_) { break; } }
        }
      }
    }
    throw new Error(t('llmInvalid'));
  }
  function abortError() { return new DOMException('Cancelled', 'AbortError'); }
  function create(fetcher = (...args) => root.fetch(...args)) {
    const unsupportedThinking = new Set(), attempted = Symbol('attempted');
    // Observe existing calls at the shared boundary, including worker preflights,
    // digests and RAG embeddings. Validation/empty batches never publish a status.
    function observed(action) {
      return async (config, ...args) => {
        let happened = false, ok = false;
        const tracked = { ...config, [attempted]: () => { happened = true; } };
        try { const value = await action(tracked, ...args); ok = true; return value; }
        // A user cancel says nothing about the server; recording it as a failure showed 「無法連線」 for a healthy oMLX.
        catch (error) { if (error?.name === 'AbortError') happened = false; throw error; }
        finally {
          if (happened && root.chrome?.storage?.session) {
            // Recording status must never change a call's result or error.
            try { await root.chrome.storage.session.set({ llmStatus: { ok, at: Date.now(), chatModel: config.chatModel || '' } }); } catch (_) {}
          }
        }
      };
    }
    async function request(config, path, body, timeout, signal, consume) {
      const baseUrl = normalizeBaseUrl(config.baseUrl), controller = new AbortController();
      const abort = () => controller.abort(), timer = setTimeout(abort, timeout);
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
      let rejectAbort;
      const cancelled = new Promise((_, reject) => { rejectAbort = () => reject(abortError()); controller.signal.addEventListener('abort', rejectAbort, { once: true }); });
      try {
        if (controller.signal.aborted) throw abortError();
        return await Promise.race([cancelled, (async () => {
          config[attempted]?.();
          const response = await fetcher(baseUrl + path, { method: body ? 'POST' : 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
            headers: { Authorization: `Bearer ${(config.apiKey || '').trim()}`, 'Content-Type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal });
          if (!response.ok) {
            const error = new Error(t([401, 403].includes(response.status) ? 'llmAuth' : 'llmHTTP', { status: response.status }));
            error.status = response.status; throw error;
          }
          if (consume) return await consume(response, controller.signal);
          try { return await response.json(); } catch (error) { if (controller.signal.aborted) throw error; throw new Error(t('llmInvalid')); }
        })()]);
      } catch (error) {
        if (signal?.aborted) throw abortError();
        if (error.status || error.message === t('llmInvalid')) throw error;
        throw new Error(t('llmOffline', { baseUrl }));
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', rejectAbort); }
    }
    async function listModels(config) {
      const data = await request(config, '/models', null, 120000);
      if (!Array.isArray(data?.data)) throw new Error(t('llmInvalid'));
      return data.data.filter(item => typeof item?.id === 'string').map(item => item.id);
    }
    async function chat(config, { messages, maxTokens = 4096, temperature = 0.3, stream = false, onText, signal } = {}) {
      if (signal?.aborted) throw abortError();
      if (!config.chatModel) throw new Error(t('llmChatRequired'));
      const key = normalizeBaseUrl(config.baseUrl) + '\n' + config.chatModel;
      const body = { model: config.chatModel, messages, max_tokens: maxTokens, temperature, stream };
      if (config.disableThinking && !unsupportedThinking.has(key)) body.chat_template_kwargs = { enable_thinking: false };
      const consume = async (response, requestSignal) => {
        if (!stream) {
          let data; try { data = await response.json(); } catch (error) { if (requestSignal.aborted) throw error; throw new Error(t('llmInvalid')); }
          const content = data?.choices?.[0]?.message?.content;
          if (content != null && typeof content !== 'string') throw new Error(t('llmInvalid'));
          return stripThinking(content);
        }
        if (!response.body?.getReader) throw new Error(t('llmInvalid'));
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let buffer = '', data = [], raw = '', done = false;
        const dispatch = () => {
          if (!data.length) return;
          const event = data.join('\n'); data = [];
          if (event.trim() === '[DONE]') { done = true; return; }
          let value; try { value = JSON.parse(event); } catch (_) { throw new Error(t('llmInvalid')); }
          const content = value?.choices?.[0]?.delta?.content;
          if (typeof content === 'string') raw += content;
          if (!requestSignal.aborted) onText?.(stripThinking(raw));
        };
        const lines = final => {
          let match;
          while (!done && (match = buffer.match(/\r\n|\r|\n/))) {
            if (!final && match[0] === '\r' && match.index === buffer.length - 1) break;
            const line = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
            if (!line) dispatch(); else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          }
        };
        try {
          while (!done) {
            const chunk = await reader.read();
            if (requestSignal.aborted) throw abortError();
            buffer += decoder.decode(chunk.value, { stream: !chunk.done }); lines(chunk.done);
            if (chunk.done) { if (buffer.startsWith('data:')) data.push(buffer.slice(5).trimStart()); dispatch(); break; }
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        return stripThinking(raw);
      };
      let text;
      try { text = await request(config, '/chat/completions', body, 600000, signal, consume); }
      catch (error) {
        if (!body.chat_template_kwargs || ![400, 422].includes(error.status)) throw error;
        unsupportedThinking.add(key); delete body.chat_template_kwargs;
        text = await request(config, '/chat/completions', body, 600000, signal, consume);
      }
      if (!text) throw new Error(t('llmEmpty')); return text;
    }
    async function embed(config, inputs, { signal } = {}) {
      if (signal?.aborted) throw abortError();
      if (!config.embeddingModel) throw new Error(t('llmEmbeddingRequired'));
      if (!Array.isArray(inputs) || inputs.some(input => typeof input !== 'string')) throw new Error(t('llmInvalid'));
      const vectors = []; let dimensions;
      for (let offset = 0; offset < inputs.length; offset += 32) {
        const input = inputs.slice(offset, offset + 32), data = await request(config, '/embeddings', { model: config.embeddingModel, input, encoding_format: 'float' }, 120000, signal);
        if (!Array.isArray(data?.data) || data.data.length !== input.length) throw new Error(t('llmInvalid'));
        const items = data.data.slice().sort((a, b) => a.index - b.index);
        for (const [index, item] of items.entries()) {
          const vector = item.embedding;
          if (item.index !== index || !Array.isArray(vector) || !vector.length || vector.some(n => !Number.isFinite(n)) || (dimensions && dimensions !== vector.length)) throw new Error(t('llmInvalid'));
          dimensions = vector.length; vectors.push(vector);
        }
      }
      return vectors;
    }
    async function optimize(config, text, { signal } = {}) {
      const result = await chat(config, { signal, messages: [
        { role: 'system', content: 'Improve this prompt for clarity and structure. Keep the original language. KEEP every {{variable}} placeholder exactly, including whitespace and repetitions. Output only the improved prompt, without commentary or fences.' },
        { role: 'user', content: text }
      ] });
      const placeholders = value => JSON.stringify((value.match(/\{\{[^{}]*\}\}/g) || []).sort());
      if (placeholders(text) !== placeholders(result)) throw new Error(t('llmPlaceholders'));
      return result;
    }
    return { normalizeBaseUrl, listModels: observed(listModels), chat: observed(chat), embed: observed(embed), stripThinking, parseJSONLoose, optimize: observed(optimize) };
  }
  SPC.llm = { ...create(), create };
  if (typeof module !== 'undefined' && module.exports) module.exports = SPC.llm;
})(globalThis);
