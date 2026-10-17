// A new agent: a role to start from, a name, a colour for its Figbot, a model, the projects it
// works on when it uses the tracker, a brief and how it talks. The brief and the examples fill
// in from the role until you change them.

import { runtime } from '../runtime/index.js';
import { ROLES, roleOf, costHint, modelIn, startingModel, movedForTeam } from '../runtime/roles.js';
import { connectToTracker, linkable } from '../runtime/tracker-link.js';
import { store } from '../store.js';
import { h, MOD, onModEnter, toast, topbar } from '../ui.js';
import { check } from '../cards.js';
import { figbot, COLOURS } from '../figbot.js';
import { modelPicker as picker, searchState } from '../model-picker.js';

let form = blank();
let catalog = []; // runtime.models(), loaded with the screen
let search = searchState(); // the model picker's search of OpenRouter

function blank() {
  return { role: null, name: '', colour: 'white', provider: 'openrouter', model: null, projects: null, brief: '', briefEdited: false, examples: '', examplesEdited: false };
}

export const view = {
  title: () => 'New figbot',

  async load() {
    catalog = await runtime.models();
    return { taken: store.runtimeAgents.map((a) => [a.name, a.colour]) };
  },

  leave() {
    form = blank();
    search = searchState();
  },

  render(_data, ctx) {
    const role = form.role ? roleOf(form.role) : null;
    const name = form.name.trim() || 'it';
    return h('div', { class: 'page' },
      topbar([
        h('a', { class: 'back phone-only', href: '#/agents', 'aria-label': 'All agents' }, '‹'),
        h('span', { class: 'title' }, 'New figbot'),
      ]),
      h('div', { class: 'profile new-agent' },
        h('h1', { class: 'h1 wide-only' }, 'New figbot'),
        h('p', { class: 'lead' }, 'Pick a role to start from. You can change everything later.'),
        h('section', { class: 'profile-section' },
          h('h2', { class: 'section-title' }, 'Role'),
          h('div', { class: 'role-grid' }, ROLES.map((r, i) => roleCard(r, i, ctx)))),
        h('section', { class: 'profile-section' },
          h('h2', { class: 'section-title' }, 'Name'),
          onModEnter(h('input', {
            class: 'input name-input',
            value: form.name,
            placeholder: 'pip',
            autocomplete: 'off',
            spellcheck: false,
            'aria-label': 'Name',
            dataset: { keep: 'new-agent:name' },
            oninput: (e) => {
              form.name = e.target.value;
              fillFromRole();
              ctx.rerender();
            },
          }), () => create(ctx))),
        h('section', { class: 'profile-section' },
          h('h2', { class: 'section-title' }, 'Colour'),
          h('p', { class: 'hint section-lead-hint' }, `How you'll tell ${name} apart. Names under a colour are figbots already using it.`),
          h('div', { class: 'colour-grid' }, Object.keys(COLOURS).map((c) => colourCard(c, ctx)))),
        role?.abilities.tracker && store.projects.length ? projectPicker(name, ctx) : null,
        h('section', { class: 'profile-section' },
          h('h2', { class: 'section-title' }, 'Model'),
          picker({
            catalog,
            ...chosen(),
            state: search,
            keep: 'new-agent:model',
            rerender: ctx.rerender,
            onPick: (provider, model, next) => {
              if (next) catalog = next;
              Object.assign(form, { provider, model });
              ctx.rerender();
            },
          }),
          h('p', { class: 'hint' }, modelHint(role))),
        h('section', { class: 'profile-section' },
          h('h2', { class: 'section-title' }, 'Brief'),
          h('p', { class: 'hint section-lead-hint' }, role ? 'Filled in from the role. Make it yours.' : 'Pick a role and this fills in.'),
          onModEnter(h('textarea', {
            class: 'textarea brief-box',
            value: form.brief,
            'aria-label': 'Brief',
            dataset: { keep: 'new-agent:brief' },
            oninput: (e) => {
              form.brief = e.target.value;
              form.briefEdited = true;
            },
          }), () => create(ctx))),
        h('section', { class: 'profile-section' },
          h('h2', { class: 'section-title' }, 'How it talks'),
          h('p', { class: 'hint section-lead-hint' }, role ? `A few made-up exchanges that show how ${name} sounds. "You:" is you.` : 'Pick a role and this fills in.'),
          onModEnter(h('textarea', {
            class: 'textarea brief-box',
            value: form.examples,
            'aria-label': 'How it talks',
            dataset: { keep: 'new-agent:examples' },
            oninput: (e) => {
              form.examples = e.target.value;
              form.examplesEdited = true;
            },
          }), () => create(ctx))),
        h('div', { class: 'create-row' },
          h('button', { type: 'button', class: 'btn primary', disabled: !form.role || !form.name.trim(), onclick: () => create(ctx) },
            `Create ${form.name.trim() || 'figbot'}`, h('span', { class: 'key' }, `${MOD}↵`)),
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

// What the model line says: why it starts where it does, or what it costs.
function modelHint(role) {
  const cost = costHint(catalog, chosen().provider, chosen().model);
  if (!role) return cost;
  if (!form.model && movedForTeam(catalog, role, store.runtimeAgents)) return `On another maker's model than your other figbots', so it sounds less like them. ${cost}`;
  return chosen().model === role.model || (role.apart && !form.model && chosen().provider !== 'standin') ? role.hint : cost;
}

// The model the agent gets: the one picked, or the one its role starts on, or the first on offer.
const chosen = () => {
  if (form.model) return modelIn(catalog, form.provider, form.model);
  return form.role ? startingModel(catalog, roleOf(form.role), store.runtimeAgents) : modelIn(catalog, form.provider, null);
};

// The brief and the examples from the role, for the name so far, until you change them.
function fillFromRole() {
  if (!form.role) return;
  const role = roleOf(form.role);
  const name = form.name.trim().toLowerCase() || 'it'; // as the runtime keeps it
  if (!form.briefEdited) form.brief = role.brief(name);
  if (!form.examplesEdited) form.examples = role.examples(name);
}

function pickRole(id, ctx) {
  form.role = id;
  form.model = null;
  form.provider = 'openrouter';
  fillFromRole();
  ctx.rerender();
}

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

// The tracker's projects; with just one, it's picked already.
const chosenProjects = () => form.projects || (store.projects.length === 1 ? [store.projects[0].key] : []);

function projectPicker(name, ctx) {
  const chosen = chosenProjects();
  return h('section', { class: 'profile-section' },
    h('h2', { class: 'section-title' }, 'Projects'),
    h('p', { class: 'hint section-lead-hint' }, `Where ${name} takes ${form.role === 'reviewer' ? 'work to review' : 'issues'} in the tracker.${linkable() ? ' It gets a token of its own there.' : ''}`),
    h('div', { class: 'project-picks' }, store.projects.map((project) => {
      const on = chosen.includes(project.key);
      return h('button', {
        type: 'button',
        class: ['chip', on ? 'on' : 'quiet'],
        'aria-pressed': String(on),
        title: project.name,
        onclick: () => {
          form.projects = on ? chosen.filter((k) => k !== project.key) : [...chosen, project.key];
          ctx.rerender();
        },
      }, project.key);
    })));
}

async function create(ctx) {
  if (!form.role) return toast('Pick a role first.', { error: true });
  try {
    const agent = await runtime.createAgent({
      name: form.name,
      role: form.role,
      colour: form.colour,
      ...chosen(),
      brief: form.brief.trim() || roleOf(form.role).brief(form.name.trim()),
      examples: form.examplesEdited ? form.examples.trim() : roleOf(form.role).examples(form.name.trim().toLowerCase()),
    });
    if (agent.tracker) await joinTracker(agent.name, chosenProjects());
    form = blank();
    location.hash = `#/agents/${encodeURIComponent(agent.name)}`;
  } catch (err) {
    toast(err.message, { error: true });
    ctx.rerender();
  }
}

// The agent exists either way; if the tracker part fails, its profile can try again.
async function joinTracker(name, projects) {
  try {
    if (!linkable()) await runtime.updateAgent(name, { tracker: { projects } });
    else if (!await connectToTracker(name, projects)) toast(`${name} isn't in the tracker yet. Connect it from its profile.`);
  } catch (err) {
    toast(`${name} isn't in the tracker yet: ${err.message}`, { error: true });
  }
}
