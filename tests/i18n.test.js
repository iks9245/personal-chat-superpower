'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dictionaries, t, getLang } = require('../src/shared/i18n.js');
test('zh-TW is the default and dictionary keys and placeholders match', () => {
  assert.equal(getLang(), 'zh-TW');
  assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(dictionaries['zh-TW']).sort());
  for (const key of Object.keys(dictionaries.en)) {
    const vars = text => [...text.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)].map(match => match[1]).sort();
    assert.deepEqual(vars(dictionaries.en[key]), vars(dictionaries['zh-TW'][key]), key);
  }
});
test('translated variables preserve literal replacement characters', () => {
  assert.equal(t('exporting', { done: 12, total: 340 }), '匯出中 12 / 340…');
  assert.equal(t('error', { message: '$&<img>' }), '操作失敗：$&<img>');
});
