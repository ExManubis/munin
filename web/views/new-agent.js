// A new agent: a role to start from, a name, a colour for its Figbot, a model and a brief.
// The brief fills in from the role until you change it.

import { runtime } from '../runtime/index.js';
import { ROLES, PROVIDERS, roleOf, costHint } from '../runtime/roles.js';
import { store } from '../store.js';
import { h, MOD, svg, toast, topbar } from '../ui.js';
import { figbot, COLOURS } from '../figbot.js';

let form = blank();

function blank() {
  return { role: null, name: '', colour: 'white', provider: 'openrouter', model: null, brief: '', briefEdited: false };
}

export const view = {
  title: () => 'New agent',

  async load() {
    return { taken: store.runtimeAgents.map((a) => [a.name, a.colour]) };
  },

  leave() {
    form = blank();
  },

  render(_data, ctx) {
    const role = form.role ? roleOf(form.role) : null;
    const name = form.name.trim() || 'it';
    return h('div', { class: 'page' },
      topbar([
        h('a', { class: 'back phone-only', href: '#/agents', 'aria-label': 'All agents' }, '‹'),
        h('span', { class: 'title' }, 'New agent'),
      ]),
      h('div', { class: 'profile new-agent' },
        h('h1', { class: 'h1 wide-only' }, 'New agent'),
        h('p', { class: 'lead' }, 'Pick a role to start from. You can change everything later.'),
        h('section', { class: 'profile-section' },
          h('h2', { class: 'section-title' }, 'Role'),
          h('div', { class: 'role-grid' }, ROLES.map((r, i) => roleCard(r, i, ctx)))),
        h('section', { class: 'profile-section' },
          h('h2', { class: 'section-title' }, 'Name'),
          h('input', {
            class: 'input name-input',
            value: form.name,
            placeholder: 'pip',
            autocomplete: 'off',
            spellcheck: false,
            'aria-label': 'Name',
            dataset: { keep: 'new-agent:name' },
            oninput: (e) => {
              form.name = e.target.value;
              if (form.role && !form.briefEdited) form.brief = roleOf(form.role).brief(form.name.trim() || 'it');
              ctx.rerender();
            },
          })),
        h('section', { class: 'profile-section' },
          h('h2', { class: 'section-title' }, 'Colour'),
          h('p', { class: 'hint section-lead-hint' }, `How you'll tell ${name} apart. Names under a colour are agents already using it.`),
          h('div', { class: 'colour-grid' }, Object.keys(COLOURS).map((c) => colourCard(c, ctx)))),
        h('section', { class: 'profile-section' },
          h('h2', { class: 'section-title' }, 'Model'),
          modelPicker(ctx),
          h('p', { class: 'hint' }, role && form.model === role.model ? role.hint : costHint(form.provider, currentModel()))),
        h('section', { class: 'profile-section' },
          h('h2', { class: 'section-title' }, 'Brief'),
          h('p', { class: 'hint section-lead-hint' }, role ? 'Filled in from the role. Make it yours.' : 'Pick a role and this fills in.'),
          h('textarea', {
            class: 'textarea brief-box',
            value: form.brief,
            'aria-label': 'Brief',
            dataset: { keep: 'new-agent:brief' },
            oninput: (e) => {
              form.brief = e.target.value;
              form.briefEdited = true;
            },
          })),
        h('div', { class: 'create-row' },
          h('button', { type: 'button', class: 'btn primary', disabled: !form.role || !form.name.trim(), onclick: () => create(ctx) },
            `Create ${form.name.trim() || 'agent'}`, h('span', { class: 'key' }, `${MOD}↵`)),
          h('span', { class: 'hint' }, `Abilities, routines and a budget are in ${form.name.trim() || 'its'}${form.name.trim() ? "'s" : ''} profile.`))));
  },

  onKey(e, _data, ctx) {
    if (/^[1-6]$/.test(e.key)) {
      pickRole(ROLES[Number(e.key) - 1].id, ctx);
      return true;
    }
    return false;
  },

  onSubmit(_e, _data, ctx) {
    create(ctx);
    return true;
  },
};

const currentModel = () => form.model || (form.role ? roleOf(form.role).model : PROVIDERS[0].models[0].id);

function pickRole(id, ctx) {
  form.role = id;
  const role = roleOf(id);
  form.model = role.model;
  form.provider = 'openrouter';
  if (!form.briefEdited) form.brief = role.brief(form.name.trim() || 'it');
  ctx.rerender();
}

const check = () => svg(14, '0 0 14 14', [['rect', { x: 0, y: 0, width: 14, height: 14, fill: '#EDEDED' }],
  ['path', { d: 'M3.5 7.5 L6 10 L10.5 4.5', fill: 'none', stroke: '#0A0A0A', 'stroke-width': 1.6 }]], { cls: 'check' });

function roleCard(role, index, ctx) {
  const selected = form.role === role.id;
  const abilities = Object.keys(role.abilities);
  return h('button', { type: 'button', class: ['role-card', selected && 'selected'], 'aria-pressed': String(selected), onclick: () => pickRole(role.id, ctx) },
    h('span', { class: 'role-card-top' }, h('span', { class: 'key-square' }, index + 1), selected ? check() : null),
    h('span', { class: 'option-label' }, role.name),
    h('span', { class: 'option-detail' }, role.line),
    h('span', { class: 'label' }, abilities.length ? abilities.join(' · ') : 'Just talk'));
}

function colourCard(colour, ctx) {
  const selected = form.colour === colour;
  const users = store.runtimeAgents.filter((a) => a.colour === colour).map((a) => a.name);
  return h('button', {
    type: 'button',
    class: ['colour-card', selected && 'selected'],
    'aria-pressed': String(selected),
    'aria-label': colour,
    onclick: () => {
      form.colour = colour;
      ctx.rerender();
    },
  },
  selected ? check() : null,
  figbot({ colour, size: 36, state: 'idle', animate: false }),
  h('span', { class: 'label' }, colour),
  h('span', { class: 'colour-users' }, colour === 'white' && !users.length ? 'default' : users.join(', ')));
}

function modelPicker(ctx) {
  const provider = PROVIDERS.find((p) => p.id === form.provider) || PROVIDERS[0];
  const pick = (options, value, label, onchange) => h('label', { class: 'select-box' },
    h('select', { 'aria-label': label, onchange: (e) => { onchange(e.target.value); ctx.rerender(); } },
      options.map(([v, text]) => h('option', { value: v, selected: v === value }, text))));
  return h('div', { class: 'select-row' },
    pick(PROVIDERS.map((p) => [p.id, p.name]), form.provider, 'Provider', (id) => {
      form.provider = id;
      form.model = PROVIDERS.find((p) => p.id === id).models[0].id;
    }),
    pick(provider.models.map((m) => [m.id, m.id]), currentModel(), 'Model', (id) => {
      form.model = id;
    }));
}

async function create(ctx) {
  if (!form.role) return toast('Pick a role first.', { error: true });
  try {
    const agent = await runtime.createAgent({
      name: form.name,
      role: form.role,
      colour: form.colour,
      provider: form.provider,
      model: currentModel(),
      brief: form.brief.trim() || roleOf(form.role).brief(form.name.trim()),
    });
    form = blank();
    location.hash = `#/agents/${encodeURIComponent(agent.name)}`;
  } catch (err) {
    toast(err.message, { error: true });
    ctx.rerender();
  }
}
