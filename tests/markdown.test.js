'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { render } = require('../src/shared/markdown.js');
function documentFixture() {
  const created = [];
  class Node {
    constructor(tag, text = '') { this.tag = tag; this.children = []; this.attrs = {}; this._text = text; }
    appendChild(node) {
      if (node.tag === '#fragment') { this.append(...node.children); node.children = []; }
      else this.children.push(node);
      return node;
    }
    append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    set textContent(text) { this._text = String(text); this.children = []; }
    get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  }
  return { created, createElement: tag => { created.push(tag); return new Node(tag); },
    createTextNode: text => new Node('#text', String(text)), createDocumentFragment: () => new Node('#fragment') };
}
const all = (node, tag) => node.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...all(child, tag)]);
const parse = text => render(text, documentFixture());
test('exports through both SPC and CommonJS; default document returns a fragment', () => {
  const document = documentFixture(), context = vm.createContext({ document, URL });
  vm.runInContext(fs.readFileSync(require.resolve('../src/shared/markdown.js'), 'utf8'), context);
  assert.equal(context.SPC.markdown.render('# title').tag, '#fragment');
  assert.equal(globalThis.SPC.markdown.render, render);
});
test('headings stay compact; paragraphs preserve single line breaks', () => {
  const tree = parse('# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six\n\nfirst\nsecond\n\nlast');
  assert.deepEqual(tree.children.map(node => node.tag), ['h4', 'h4', 'h4', 'h5', 'h5', 'h6', 'p', 'p']);
  assert.equal(tree.children[0].textContent, 'One'); assert.equal(all(tree, 'br').length, 1);
  assert.equal(parse('####### literal').children[0].tag, 'p');
  assert.equal(parse('## Title ##').textContent, 'Title');
});
test('unordered and ordered lists nest one level by indentation', () => {
  const tree = parse('- Parent\n  * Child\n  + Other child\n- Sibling\n\n1. First\n   1) Nested\n   2) Next\n2. Last');
  assert.deepEqual(tree.children.map(node => node.tag), ['ul', 'ol']);
  assert.equal(tree.children[0].children.length, 2);
  assert.equal(tree.children[0].children[0].children[1].tag, 'ul');
  assert.deepEqual(all(tree.children[0].children[0], 'li').map(node => node.textContent), ['Child', 'Other child']);
  assert.equal(all(tree, 'ol').length, 2); assert.equal(all(tree, 'li').length, 8);
  assert.equal(parse('3) Third').children[0].attrs.start, '3');
  assert.equal(all(parse('- a\n  - b\n    - c'), 'ul').length, 2);
});
test('fences keep code literal, accept tilde fences and tolerate missing closing fences', () => {
  for (const fence of ['```', '~~~']) {
    const tree = parse(`${fence}js\n<script>**literal** & \\*\nconst a = 1;\n${fence}\nAfter`);
    const code = all(tree, 'code')[0];
    assert.equal(code.attrs['data-lang'], 'js'); assert.equal(code.textContent, '<script>**literal** & \\*\nconst a = 1;');
    assert.equal(all(tree, 'strong').length, 0); assert.equal(tree.children[1].textContent, 'After');
    assert.equal(all(parse(`${fence}python\nfirst\nsecond`), 'code')[0].textContent, 'first\nsecond');
    assert.equal(all(parse(fence), 'pre').length, 1);
  }
  assert.equal(all(parse('````\n```\nstill code\n````'), 'code')[0].textContent, '```\nstill code');
});
test('tables split only unescaped pipes, ignore alignment and use a scroll wrapper', () => {
  const tree = parse('| Name | Value |\n| :--- | ---: |\n| **A** | x\\|y |\n| B | 2 |');
  assert.equal(tree.children[0].tag, 'div'); assert.equal(tree.children[0].attrs.class, 'markdown-table');
  assert.deepEqual(all(tree, 'th').map(node => node.textContent), ['Name', 'Value']);
  assert.deepEqual(all(tree, 'td').map(node => node.textContent), ['A', 'x|y', 'B', '2']);
  assert.equal(all(tree, 'strong').length, 1);
  assert.equal(all(parse('A | B\n--- | ---\none | two'), 'table').length, 1);
  assert.equal(all(parse('A | B\n--- | invalid'), 'table').length, 0);
});
test('inline emphasis, strike, code, punctuation escapes and unfinished delimiters', () => {
  const tree = parse('**bold** __also bold__ *italic* _also italic_ ~~gone~~ `**literal** <img>`');
  assert.deepEqual(all(tree, 'strong').map(node => node.textContent), ['bold', 'also bold']);
  assert.deepEqual(all(tree, 'em').map(node => node.textContent), ['italic', 'also italic']);
  assert.equal(all(tree, 'del')[0].textContent, 'gone'); assert.equal(all(tree, 'code')[0].textContent, '**literal** <img>');
  assert.equal(all(parse('snake_case_word 中文_文字_內 a*b*c a_italic_ _italic_b a*italic* *italic*b'), 'em').length, 0);
  assert.equal(parse('open **bold').textContent, 'open **bold');
  assert.equal(parse('\\*literal\\* \\_word\\_ \\[link\\] \\`code\\` \\| \\\\').textContent, '*literal* _word_ [link] `code` | \\');
  assert.equal(all(parse('**bold *and italic***'), 'em')[0].textContent, 'and italic');
});
test('links allow only absolute HTTP(S), protect the new tab and preserve rejected syntax as text', () => {
  const tree = parse('[**safe**](https://example.com/a_(b)) http://example.org/path. https://example.net/x?q=1&y=2');
  const links = all(tree, 'a'); assert.equal(links.length, 3);
  assert.equal(links[0].attrs.href, 'https://example.com/a_(b)'); assert.equal(links[1].textContent, 'http://example.org/path');
  assert.equal(all(links[0], 'strong').length, 1);
  for (const link of links) { assert.equal(link.attrs.target, '_blank'); assert.equal(link.attrs.rel, 'noopener noreferrer'); }
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', '/relative', '../relative', '//example.com', '#fragment', 'mailto:x@example.com', 'https://']) {
    const source = `[label](${url})`, result = parse(source);
    assert.equal(all(result, 'a').length, 0, url); assert.equal(result.textContent, source);
  }
  assert.equal(all(parse('[outer [inner](https://example.com)](https://example.org)'), 'a').length, 1);
});
test('raw HTML stays text and cannot create attacker-controlled elements or attributes', () => {
  const doc = documentFixture(), source = '<script>alert(1)</script> <img src=x onerror="bad()"> <b>plain</b>';
  assert.equal(render(source, doc).textContent, source);
  assert.deepEqual(doc.created, ['p']);
  const code = all(render('```x" onmouseover="bad\n<img onerror=x>\n```', doc), 'code')[0];
  assert.deepEqual(code.attrs, { 'data-lang': 'x"' });
});
test('blockquotes, rules and block boundaries render without paragraph wrappers', () => {
  const tree = parse('> Quote **bold**\n> second line\n>\n> - item\n\n---\n***');
  assert.equal(tree.children[0].tag, 'blockquote'); assert.equal(all(tree, 'strong')[0].textContent, 'bold');
  assert.equal(all(tree, 'br').length, 1); assert.equal(all(tree, 'ul').length, 1); assert.equal(all(tree, 'hr').length, 2);
});
test('every prefix of a streamed summary renders without throwing', () => {
  const sample = '# Summary\n\n**bold** and _italic_ ~~strike~~ `code` \\*escaped\\*\nhttps://example.com/a_(b).\n[link](https://example.org) [bad](javascript:alert(1))\n\n- Parent\n  1) Child\n\n> Quote\n\n| A | B |\n| --- | ---: |\n| x\\|y | z |\n\n***\n~~~js\n<img onerror=x>\n~~~\n\n```\nopen fence';
  for (let i = 0; i <= sample.length; i++) assert.doesNotThrow(() => parse(sample.slice(0, i)), `prefix ${i}`);
  for (const text of ['', null, undefined, '**', '__', 'https://', '> '.repeat(10000), '*'.repeat(10000)]) assert.doesNotThrow(() => parse(text));
});
