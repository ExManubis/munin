// Picking an agent's model: your favourite OpenRouter models and every other provider's in a
// list, and a search across all of OpenRouter's. Picking one from the search makes it a
// favourite too, so the list has it next time. Used by setup, New agent and the profile.

import { runtime } from './runtime/index.js';
import { price } from './runtime/roles.js';
import { h, svg } from './ui.js';

// A screen keeps one of these, so a search survives its redraws.
export const searchState = () => ({ q: '', found: null, timer: 0 });

const SUBLINE = { standin: 'Answers without a model, for trying munin out' };
const radio = (on) => svg(12, '0 0 12 12', on
  ? [['rect', { x: 0.5, y: 0.5, width: 11, height: 11, fill: 'none', stroke: '#EDEDED' }], ['rect', { x: 3, y: 3, width: 6, height: 6, fill: '#EDEDED' }]]
  : [['rect', { x: 0.5, y: 0.5, width: 11, height: 11, fill: 'none', stroke: '#4E4E4E' }]]);

// `onPick(provider, model, catalog)` gets the runtime's new catalog when the pick added a favourite.
export function modelPicker({ catalog, provider, model, state, keep, onPick, rerender, standin = true, label = 'Model' }) {
  const rows = catalog.filter((p) => standin || p.id !== 'standin')
    .flatMap((p) => p.models.map((m) => ({ provider: p.id, sub: p.id === 'openrouter' ? m.maker : SUBLINE[p.id] || p.name, m })));
  // The agent's own model, when the runtime no longer offers it.
  if (model && !rows.some((r) => r.provider === provider && r.m.id === model)) rows.unshift({ provider, sub: `${provider}, not set up`, m: { id: model, name: model } });

  const row = (r, inList) => {
    const on = r.provider === provider && r.m.id === model;
    return h('button', {
      type: 'button',
      class: ['mp-row', on && 'on'],
      role: inList ? 'radio' : null,
      'aria-checked': inList ? String(on) : null,
      dataset: { keep: `${keep}:${r.provider}/${r.m.id}` },
      onclick: () => (inList ? onPick(r.provider, r.m.id) : pickFound(r.m.id)),
    },
    radio(on),
    h('span', { class: 'mp-name' }, h('b', {}, r.m.name), r.sub ? h('span', {}, r.sub) : null),
    r.m.input !== undefined && r.provider !== 'standin' ? h('span', { class: 'mp-price' }, price(r.m)) : null);
  };

  const openrouter = catalog.find((p) => p.id === 'openrouter');
  const pickFound = async (id) => {
    const favourites = openrouter.models.filter((m) => m.favourite).map((m) => m.id);
    clearTimeout(state.timer);
    Object.assign(state, { q: '', found: null });
    const next = favourites.includes(id) ? null : await runtime.setFavourites([...favourites, id]).catch(() => null);
    onPick('openrouter', id, next);
  };

  const search = openrouter ? h('input', {
    type: 'search',
    value: state.q,
    placeholder: 'Search all of OpenRouter’s models',
    autocomplete: 'off',
    spellcheck: false,
    'aria-label': 'Search OpenRouter’s models',
    dataset: { keep: `${keep}:q` },
    oninput: (e) => {
      state.q = e.target.value;
      clearTimeout(state.timer);
      const q = state.q.trim();
      if (!q) {
        state.found = null;
        return rerender();
      }
      state.timer = setTimeout(async () => {
        const found = await runtime.searchModels(q).catch(() => ({ total: 0, models: [] }));
        if (state.q.trim() === q) {
          state.found = found;
          rerender();
        }
      }, 180);
    },
    onkeydown: (e) => {
      if (e.key === 'Enter' && state.found?.models.length) {
        e.preventDefault();
        pickFound(state.found.models[0].id);
      } else if (e.key === 'Escape' && state.q) {
        e.preventDefault();
        e.stopPropagation();
        Object.assign(state, { q: '', found: null });
        rerender();
      }
    },
  }) : null;

  const found = state.found;
  return h('div', { class: 'mp' },
    h('div', { role: 'radiogroup', 'aria-label': label }, rows.map((r) => row(r, true))),
    search ? h('label', { class: 'mp-search' }, svg(12, '0 0 12 12', [['path', { fill: '#7A7A7A', d: 'M2 0h4v1H2zM1 1h1v1H1zM6 1h1v1H6zM0 2h1v4H0zM7 2h1v4H7zM1 6h1v1H1zM6 6h1v1H6zM2 7h4v1H2zM7 7h1v1H7zM8 8h1v1H8zM9 9h1v1H9zM10 10h1v1h-1z' }]]), search) : null,
    found ? h('div', { class: 'mp-results' },
      found.models.length
        ? [found.models.map((m) => row({ provider: 'openrouter', sub: m.maker, m }, false)),
          found.total > found.models.length ? h('p', { class: 'hint mp-note' }, `${found.models.length} of ${found.total}. Keep typing to narrow it down.`) : null]
        : h('p', { class: 'hint mp-note' }, `Nothing on OpenRouter matches “${state.q.trim()}”. Try a maker, like google or meta.`)) : null);
}
