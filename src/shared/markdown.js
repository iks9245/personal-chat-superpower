(function (root) {
  'use strict';
  const SPC = (root.SPC = root.SPC || {});
  const punctuation = /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/;
  const word = char => Boolean(char && /[\p{L}\p{N}_]/u.test(char));
  const unescape = text => text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1');
  function linkURL(text) {
    try { const url = new URL(text); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; }
    catch (_) { return null; }
  }
  function closing(text, start, open, close) {
    let depth = 1;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '\\' && punctuation.test(text[i + 1] || '')) { i++; continue; }
      if (text[i] === open) depth++;
      if (text[i] === close && --depth === 0) return i;
    }
    return -1;
  }
  function delimiterEnd(text, start, marker) {
    for (let i = start; i < text.length; i++) {
      if (text[i] === '\\' && punctuation.test(text[i + 1] || '')) { i++; continue; }
      if (text[i] === '`') {
        const end = text.indexOf('`', i + 1); if (end !== -1) { i = end; continue; }
      }
      if (!text.startsWith(marker, i)) continue;
      let end = i;
      while (text[end] === marker[0]) end++;
      // Keep a single closing star inside a surrounding strong span.
      const at = end - marker.length;
      if (at >= i && at >= start && !/\s/.test(text[at - 1]) && (!(marker[0] === '_' || marker.length === 1) || !word(text[end]))) return at;
      i = end - 1;
    }
    return -1;
  }
  function inline(parent, text, doc, depth = 0, links = true) {
    if (depth >= 32) { parent.append(doc.createTextNode(text)); return; }
    let plain = '';
    const flush = () => { if (plain) { parent.append(doc.createTextNode(plain)); plain = ''; } };
    for (let i = 0; i < text.length;) {
      const char = text[i];
      if (char === '\\' && punctuation.test(text[i + 1] || '')) { plain += text[i + 1]; i += 2; continue; }
      if (char === '\n') { flush(); parent.append(doc.createElement('br')); i++; continue; }
      if (char === '`') {
        const end = text.indexOf('`', i + 1);
        if (end !== -1) {
          flush(); const code = doc.createElement('code'); code.textContent = text.slice(i + 1, end); parent.append(code); i = end + 1; continue;
        }
      }
      // Tags stay visible as literal text, including any Markdown in attributes.
      if (char === '<') {
        const end = text.indexOf('>', i + 1);
        if (end !== -1) { plain += text.slice(i, end + 1); i = end + 1; continue; }
      }
      if (links && char === '[') {
        const labelEnd = closing(text, i + 1, '[', ']');
        const end = labelEnd !== -1 && text[labelEnd + 1] === '(' ? closing(text, labelEnd + 2, '(', ')') : -1;
        if (end !== -1) {
          const url = linkURL(unescape(text.slice(labelEnd + 2, end).trim()));
          if (url) {
            flush(); const a = doc.createElement('a');
            a.setAttribute('href', url); a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer');
            inline(a, text.slice(i + 1, labelEnd), doc, depth + 1, false); parent.append(a);
          } else plain += text.slice(i, end + 1);
          i = end + 1; continue;
        }
      }
      if (links && !word(text[i - 1]) && /^https?:\/\//i.test(text.slice(i, i + 8))) {
        let value = text.slice(i).match(/^https?:\/\/[^\s<>"'`*]*/i)[0].replace(/[.,;:!?]+$/, '');
        while (/[)\]}]$/.test(value)) {
          const close = value.at(-1), open = { ')': '(', ']': '[', '}': '{' }[close];
          if (value.split(close).length <= value.split(open).length) break;
          value = value.slice(0, -1).replace(/[.,;:!?]+$/, '');
        }
        const url = linkURL(value);
        if (url) {
          flush(); const a = doc.createElement('a'); a.textContent = value;
          a.setAttribute('href', url); a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer');
          parent.append(a); i += value.length; continue;
        }
      }
      if (char === '*' || char === '_' || text.startsWith('~~', i)) {
        const marker = text.startsWith(char + char, i) ? char + char : char;
        const start = i + marker.length;
        const end = !/\s/.test(text[start] || ' ') && (!(char === '_' || marker.length === 1) || !word(text[i - 1])) ? delimiterEnd(text, start, marker) : -1;
        if (end > start) {
          flush(); const node = doc.createElement(marker === '~~' ? 'del' : marker.length === 2 ? 'strong' : 'em');
          inline(node, text.slice(start, end), doc, depth + 1, links); parent.append(node); i = end + marker.length; continue;
        }
        plain += marker; i = start; continue;
      }
      plain += char; i++;
    }
    flush();
  }
  const fence = line => line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  const heading = line => line.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/);
  const rule = line => /^ {0,3}(?:-{3,}|\*{3,})\s*$/.test(line);
  const quote = line => /^ {0,3}> ?/.test(line);
  function listItem(line) {
    const match = line.match(/^(\s*)([-+*]|\d+[.)])[ \t]+(.*)$/);
    return match && { indent: match[1].replace(/\t/g, '    ').length, tag: /^\d/.test(match[2]) ? 'ol' : 'ul', text: match[3], start: parseInt(match[2], 10) };
  }
  function cells(line) {
    const parts = []; let part = '', pipes = 0;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\' && i + 1 < line.length) { part += line[i] + line[++i]; continue; }
      if (line[i] === '|') { parts.push(part.trim()); part = ''; pipes++; } else part += line[i];
    }
    parts.push(part.trim());
    if (line.trim().startsWith('|')) parts.shift();
    if (pipes && parts.at(-1) === '') parts.pop();
    return pipes ? parts : null;
  }
  function tableHeader(lines, index) {
    const header = cells(lines[index]), separator = cells(lines[index + 1] || '');
    return header?.length && separator?.length === header.length && separator.every(cell => /^:?-{3,}:?$/.test(cell)) ? header : null;
  }
  function blocks(parent, lines, doc, depth = 0) {
    const addInline = (tag, text, target = parent) => { const node = doc.createElement(tag); inline(node, text, doc); target.append(node); return node; };
    const startsBlock = i => fence(lines[i]) || heading(lines[i]) || rule(lines[i]) || quote(lines[i]) || listItem(lines[i]) || tableHeader(lines, i);
    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const codeFence = fence(line);
      if (codeFence) {
        const content = [], marker = codeFence[1], end = new RegExp('^ {0,3}' + marker[0] + '{' + marker.length + ',}\\s*$'); i++;
        while (i < lines.length && !end.test(lines[i])) content.push(lines[i++]);
        if (i < lines.length) i++;
        const pre = doc.createElement('pre'), code = doc.createElement('code'), language = codeFence[2].trim().split(/\s+/)[0];
        if (language) code.setAttribute('data-lang', language);
        code.textContent = content.join('\n'); pre.append(code); parent.append(pre); continue;
      }
      const title = heading(line);
      if (title) { addInline('h' + (title[1].length <= 3 ? 4 : title[1].length <= 5 ? 5 : 6), (title[2] || '').replace(/[ \t]+#+[ \t]*$/, '')); i++; continue; }
      if (rule(line)) { parent.append(doc.createElement('hr')); i++; continue; }
      if (quote(line) && depth < 32) {
        const content = []; while (i < lines.length && quote(lines[i])) content.push(lines[i++].replace(/^ {0,3}> ?/, ''));
        const node = doc.createElement('blockquote'); blocks(node, content, doc, depth + 1); parent.append(node); continue;
      }
      const header = tableHeader(lines, i);
      if (header) {
        const wrapper = doc.createElement('div'), table = doc.createElement('table'), head = doc.createElement('thead'), body = doc.createElement('tbody');
        wrapper.setAttribute('class', 'markdown-table');
        const row = (values, tag, target) => {
          const tr = doc.createElement('tr');
          for (let col = 0; col < header.length; col++) addInline(tag, values[col] || '', tr);
          target.append(tr);
        };
        row(header, 'th', head); i += 2;
        while (i < lines.length && lines[i].trim() && cells(lines[i])) row(cells(lines[i++]), 'td', body);
        table.append(head, body); wrapper.append(table); parent.append(wrapper); continue;
      }
      const first = listItem(line);
      if (first) {
        const stack = []; let last;
        while (i < lines.length) {
          const item = listItem(lines[i]);
          if (!item) {
            if (lines[i].trim() && /^\s+/.test(lines[i]) && lines[i].match(/^\s*/)[0].replace(/\t/g, '    ').length > first.indent) {
              last.append(doc.createElement('br')); inline(last, lines[i++].trim(), doc); continue;
            }
            if (!lines[i].trim() && listItem(lines[i + 1] || '')) { i++; continue; }
            break;
          }
          const level = item.indent > first.indent && stack.length ? 1 : 0;
          if (level === 0) stack.length = Math.min(stack.length, 1);
          if (!stack[level] || stack[level].tag !== item.tag) {
            const node = doc.createElement(item.tag);
            if (item.tag === 'ol' && Number.isSafeInteger(item.start) && item.start !== 1) node.setAttribute('start', String(item.start));
            (level ? stack[0].last : parent).append(node); stack[level] = { node, tag: item.tag };
          }
          last = addInline('li', item.text, stack[level].node); stack[level].last = last; i++;
        }
        continue;
      }
      const paragraph = [line]; i++;
      while (i < lines.length && lines[i].trim() && !startsBlock(i)) paragraph.push(lines[i++]);
      addInline('p', paragraph.join('\n'));
    }
  }
  function render(text, doc = document) {
    const fragment = doc.createDocumentFragment();
    blocks(fragment, String(text ?? '').replace(/\r\n?/g, '\n').split('\n'), doc);
    return fragment;
  }
  SPC.markdown = { render };
  if (typeof module !== 'undefined' && module.exports) module.exports = SPC.markdown;
})(globalThis);
