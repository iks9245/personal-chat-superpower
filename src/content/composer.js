(function (root) {
  'use strict';
  const SPC = (root.SPC = root.SPC || {});
  function create(selectors) {
    function getComposer() {
      const candidates = selectors.flatMap(selector => [...document.querySelectorAll(selector)]);
      return candidates.find(node => node.getClientRects().length > 0) || candidates[0] || null;
    }
    function diagnoseComposer() {
      const composer = getComposer();
      const selectorIndex = composer ? selectors.findIndex(selector => [...document.querySelectorAll(selector)].includes(composer)) : -1;
      return { found: Boolean(composer), selectorIndex, selector: selectors[selectorIndex] ?? null,
        visible: Boolean(composer && composer.getClientRects().length > 0),
        kind: composer instanceof HTMLTextAreaElement ? 'textarea' : composer?.isContentEditable ? 'contenteditable' : null };
    }
    function insertIntoComposer(text) {
      const composer = getComposer();
      if (!composer) return false;
      composer.focus();
      if (composer instanceof HTMLTextAreaElement) {
        if (composer.disabled || composer.readOnly) return false;
        // execCommand keeps the edit on the native undo stack; the setter is a fallback if it is ever removed.
        if (document.execCommand('insertText', false, text)) return true;
        const start = composer.selectionStart, end = composer.selectionEnd;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(composer, composer.value.slice(0, start) + text + composer.value.slice(end));
        composer.setSelectionRange(start + text.length, start + text.length);
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      if (!composer.isContentEditable) return false;
      const selection = window.getSelection();
      if (!selection.rangeCount || !composer.contains(selection.anchorNode) || !composer.contains(selection.focusNode)) {
        const range = document.createRange(); range.selectNodeContents(composer); range.collapse(false);
        selection.removeAllRanges(); selection.addRange(range);
      }
      return document.execCommand('insertText', false, text);
    }
    // Prefix editing includes nested ProseMirror text nodes.
    function consumePaletteTrigger(event) {
      const composer = getComposer();
      if (!composer || event.isComposing || !(event.target === composer || composer.contains(event.target))) return false;
      if (composer instanceof HTMLTextAreaElement) {
        if (!composer.value.startsWith('//')) return false;
        const start = composer.selectionStart, end = composer.selectionEnd;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(composer, composer.value.slice(2));
        composer.setSelectionRange(Math.max(0, start - 2), Math.max(0, end - 2));
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      if (!composer.isContentEditable || !composer.textContent.startsWith('//')) return false;
      const walker = document.createTreeWalker(composer, NodeFilter.SHOW_TEXT);
      const first = walker.nextNode();
      if (!first) return false;
      let last = first, remaining = 2;
      while (last && last.textContent.length < remaining) { remaining -= last.textContent.length; last = walker.nextNode(); }
      if (!last) return false;
      const range = document.createRange(); range.setStart(first, 0); range.setEnd(last, remaining);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      return document.execCommand('delete', false);
    }
    // ChatGPT's own "/" command menu swallows the input event of the second slash, so "//" is also detected on keydown
    // (capture phase, before the editor sees the key): the composer holds a single "/" and another "/" is pressed.
    function isPaletteTrigger(event) {
      const composer = getComposer();
      if (!composer || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return false;
      if (!(event.target === composer || composer.contains(event.target))) return false;
      const text = composer instanceof HTMLTextAreaElement ? composer.value : composer.textContent;
      return (event.key === '/' || (event.code === 'Slash' && !event.shiftKey)) && ['/', '／'].includes(text.trim());
    }
    function clearComposer() {
      const composer = getComposer();
      if (!composer) return false;
      composer.focus();
      if (composer instanceof HTMLTextAreaElement) {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(composer, '');
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      const range = document.createRange(); range.selectNodeContents(composer);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      return document.execCommand('delete', false);
    }
    return { getComposer, diagnoseComposer, insertIntoComposer, isPaletteTrigger, clearComposer, consumePaletteTrigger };
  }
  SPC.composer = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = SPC.composer;
})(globalThis);
