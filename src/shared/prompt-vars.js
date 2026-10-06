(function (root) {
  'use strict';
  const SPC = (root.SPC = root.SPC || {});
  const pattern = /\{\{\s*([^{}]+?)\s*\}\}/g;
  function extractVars(text) {
    return [...new Set(Array.from(String(text).matchAll(pattern), m => m[1].trim()).filter(Boolean))];
  }
  function fillVars(text, values) {
    return String(text).replace(pattern, (original, name) =>
      Object.prototype.hasOwnProperty.call(values || {}, name.trim()) ? String(values[name.trim()] ?? '') : original);
  }
  SPC.promptVars = { extractVars, fillVars };
  if (typeof module !== 'undefined' && module.exports) module.exports = SPC.promptVars;
})(globalThis);
