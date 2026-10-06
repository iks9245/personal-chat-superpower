'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractVars, fillVars } = require('../src/shared/prompt-vars.js');
test('extracts unique trimmed variables in first-appearance order, including Chinese', () => {
  assert.deepEqual(extractVars('{{name}} {{ 主題 }} {{name}} {{ tone-of-voice }}'), ['name', '主題', 'tone-of-voice']);
});
test('ignores empty and incomplete placeholders', () => {
  assert.deepEqual(extractVars('plain {{}} {{   }} {{unfinished'), []);
});
test('fills repeated variables, preserving literal dollar syntax and multiline values', () => {
  assert.equal(fillVars('{{a}}/{{ a }}/{{中文}}', { a: '$&$1', 中文: '一\n二' }), '$&$1/$&$1/一\n二');
});
test('missing values are preserved, explicit empty, zero and false values are supported', () => {
  assert.equal(fillVars('{{empty}} {{zero}} {{flag}} {{missing}}', { empty: '', zero: 0, flag: false }), ' 0 false {{missing}}');
});
test('does not substitute prototype properties or recursively expand values', () => {
  assert.equal(fillVars('{{toString}} {{name}}', { name: '{{other}}' }), '{{toString}} {{other}}');
  assert.equal(fillVars('{{__proto__}}', JSON.parse('{"__proto__":"safe"}')), 'safe');
});
