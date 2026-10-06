'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function composer() {
  class Textarea {
    constructor() { this.value = '/'; this.selectionStart = this.selectionEnd = 1; this.events = []; }
    set value(value) { this.text = value; } get value() { return this.text; }
    focus() {} getClientRects() { return this.hidden ? [] : [{}]; }
    contains(node) { return this === node; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    dispatchEvent(event) { this.events.push(event.type); }
  }
  const hidden = new Textarea(), visible = new Textarea(), commands = []; hidden.hidden = true;
  let commandResult = true;
  const context = vm.createContext({ HTMLTextAreaElement: Textarea, Event,
    document: { querySelectorAll: selector => selector === 'hidden' ? [hidden] : [visible], execCommand: (...args) => { commands.push(args); return commandResult; } } });
  vm.runInContext(fs.readFileSync(require.resolve('../src/content/composer.js'), 'utf8'), context);
  return { api: context.SPC.composer.create(['hidden', 'visible']), visible, hidden, commands, fallback: () => { commandResult = false; } };
}
test('shared composer prefers visible candidates and tries execCommand before textarea setter fallback', () => {
  const h = composer(); assert.equal(h.api.getComposer(), h.visible);
  assert.equal(h.api.insertIntoComposer('text'), true); assert.deepEqual(h.commands[0], ['insertText', false, 'text']);
  assert.equal(h.visible.value, '/'); assert.equal(h.visible.events.length, 0);
  h.fallback(); assert.equal(h.api.insertIntoComposer('text'), true);
  assert.equal(h.visible.value, '/text'); assert.equal(h.visible.selectionStart, 5); assert.deepEqual(h.visible.events, ['input']);
});
test('shared composer preserves keydown slash detection, clear and prefix consumption', () => {
  const h = composer(), event = { target: h.visible, key: '/' };
  assert.equal(h.api.isPaletteTrigger(event), true);
  assert.equal(h.api.isPaletteTrigger({ ...event, isComposing: true }), false);
  assert.equal(h.api.isPaletteTrigger({ ...event, ctrlKey: true }), false);
  h.api.clearComposer(); assert.equal(h.visible.value, '');
  h.visible.value = '//suffix'; h.visible.selectionStart = h.visible.selectionEnd = 2;
  assert.equal(h.api.consumePaletteTrigger(event), true); assert.equal(h.visible.value, 'suffix'); assert.equal(h.visible.selectionStart, 0);
});

test('composer diagnostics report textarea, contenteditable, hidden and missing candidates without editing', () => {
  const h = composer();
  assert.deepEqual(JSON.parse(JSON.stringify(h.api.diagnoseComposer())), { found: true, selectorIndex: 1, selector: 'visible', visible: true, kind: 'textarea' });
  h.visible.hidden = true;
  assert.equal(h.api.diagnoseComposer().visible, false); assert.equal(h.api.diagnoseComposer().selectorIndex, 0); assert.equal(h.commands.length, 0);
  class Textarea {}
  let found = true;
  const node = { isContentEditable: true, getClientRects: () => [{}] }, context = vm.createContext({ HTMLTextAreaElement: Textarea, document: { querySelectorAll: () => found ? [node] : [] } });
  vm.runInContext(fs.readFileSync(require.resolve('../src/content/composer.js'), 'utf8'), context);
  const api = context.SPC.composer.create(['editable']);
  assert.deepEqual(JSON.parse(JSON.stringify(api.diagnoseComposer())), { found: true, selectorIndex: 0, selector: 'editable', visible: true, kind: 'contenteditable' });
  found = false;
  assert.deepEqual(JSON.parse(JSON.stringify(api.diagnoseComposer())), { found: false, selectorIndex: -1, selector: null, visible: false, kind: null });
});
