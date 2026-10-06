(function () {
  'use strict';
  const { state } = SPC.panel;
  function renderPromptTags() {
    const select = SPC.panel.$('#prompt-tag'), previous = select.value; select.replaceChildren();
    const all = SPC.panel.el('option', SPC.panel.t('allTags')); all.value = ''; select.append(all);
    [...new Set(state.prompts.flatMap(prompt => prompt.tags))].sort().forEach(tag => { const option = SPC.panel.el('option', tag); option.value = tag; select.append(option); });
    select.value = [...select.options].some(option => option.value === previous) ? previous : '';
  }
  function renderPrompts() {
    const platform = globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || '';
    SPC.panel.$('#prompt-menu-hint').textContent = SPC.panel.t('promptMenuHint', { shortcut: /mac/i.test(platform) ? '⌘⇧P' : 'Ctrl+Shift+P' });
    const words = SPC.search.terms(SPC.panel.$('#prompt-search').value), tag = SPC.panel.$('#prompt-tag').value;
    const prompts = state.prompts.filter(prompt => (!tag || prompt.tags.includes(tag)) && words.every(word => `${prompt.title}\n${prompt.content}\n${prompt.tags.join(' ')}`.toLowerCase().includes(word)))
      .sort((a, b) => b.useCount - a.useCount || b.updatedAt - a.updatedAt);
    const list = SPC.panel.$('#prompt-list'); list.replaceChildren();
    if (!prompts.length) list.append(SPC.panel.el('p', SPC.panel.t(state.prompts.length ? 'noPrompts' : 'promptsEmpty'), 'empty'));
    for (const prompt of prompts) {
      const card = SPC.panel.el('article', null, 'card'), actions = SPC.panel.el('div', null, 'toolbar');
      const insert = SPC.panel.button('insert', () => insertPrompt(prompt)); insert.disabled = !state.tab;
      actions.append(insert, SPC.panel.button('edit', () => editPrompt(prompt)), SPC.panel.button('delete', async () => {
        SPC.panel.confirmAction('deletePromptConfirm', { title: prompt.title }, async () => { await SPC.store.deletePrompt(prompt.id); await SPC.panel.refreshLocal(); });
      }, 'danger'));
      card.append(SPC.panel.el('strong', prompt.title), SPC.panel.tagsNode(prompt.tags), SPC.panel.el('p', prompt.content.slice(0, 240), 'preview'),
        SPC.panel.el('p', SPC.panel.t('promptUses', { count: prompt.useCount }), 'muted'), actions); list.append(card);
    }
  }
  function editPrompt(prompt) {
    SPC.panel.openEditor(prompt ? 'editPrompt' : 'addPrompt', [
      { name: 'title', key: 'title', value: prompt?.title || '', required: true },
      { name: 'content', key: 'content', type: 'textarea', value: prompt?.content || '', required: true, hint: 'variableHint' },
      { name: 'tags', key: 'tags', value: (prompt?.tags || []).join(', ') }
    ], async values => { await SPC.store.savePrompt({ id: prompt?.id, ...values, tags: SPC.panel.parseTags(values.tags) }); await SPC.panel.refreshLocal(); });
  }
  async function insertPrompt(prompt) {
    const names = SPC.promptVars.extractVars(prompt.content);
    const insert = async values => {
      const tab = await SPC.panel.activeTab(); await SPC.panel.send(tab.id, 'spc:insert', { text: SPC.promptVars.fillVars(prompt.content, values) });
      await SPC.store.incrementPromptUse(prompt.id); await SPC.panel.refreshLocal(); SPC.panel.status('inserted');
    };
    if (names.length) SPC.panel.openEditor('variables', names.map((name, index) => ({ name: `var${index}`, label: name, value: '' })),
      values => insert(Object.fromEntries(names.map((name, index) => [name, values[`var${index}`]]))), 'insert');
    else await insert({});
  }
  function bindPromptFilters() {
    SPC.panel.$('#prompt-search').addEventListener('input', SPC.panel.renderPrompts);
    SPC.panel.$('#prompt-tag').addEventListener('change', SPC.panel.renderPrompts);
  }
  function bindPromptEditor() {
    SPC.panel.$('#add-prompt').addEventListener('click', () => editPrompt());
  }
  Object.assign(SPC.panel, {
    renderPromptTags, renderPrompts, editPrompt, insertPrompt, bindPromptFilters, bindPromptEditor
  });
})();
