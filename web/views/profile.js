// An agent's profile: its brief, model, what it can reach, what it asks first, its routines,
// what it remembers about you, and what it costs.

import { runtime } from '../runtime/index.js';
import { ABILITIES, APPS, PROVIDERS, THINKING, costHint } from '../runtime/roles.js';
import { h, bindDraft, drafts, onModEnter, toast, toggle, topbar } from '../ui.js';
import { openDialog, closeDialog } from '../dialogs.js';
import { agentFace, roleTag, hhmm } from './agents.js';
import { lastRun } from './conversation.js';

let allNotes = false;

export const view = {
  title: (data) => `${data.agent.name} · profile`,
  scope: (params) => `/agents/${params.name}/profile`,

  async load({ name }) {
    return { agent: await runtime.agent(name) };
  },

  leave() {
    allNotes = false;
  },

  render({ agent }, ctx) {
    const set = (patch, message) => update(agent, patch, message, ctx);
    return h('div', { class: 'page' },
      topbar([
        h('a', { class: 'back phone-only', href: `#/agents/${encodeURIComponent(agent.name)}`, 'aria-label': 'Back to the conversation' }, '‹'),
        h('a', { class: 'crumbs', href: `#/agents/${encodeURIComponent(agent.name)}` }, h('span', {}, agent.name), h('span', {}, '/'), h('span', { class: 'here' }, 'Profile')),
      ]),
      h('div', { class: 'profile' },
        header(agent, ctx),
        brief(agent, set),
        model(agent, set),
        abilities(agent, set, ctx),
        askFirst(agent, set),
        routines(agent, ctx),
        memory(agent, ctx),
        usage(agent, set)));
  },

  onKey(e, { agent }) {
    if (e.key === 'c' || e.key === 'C') {
      location.hash = `#/agents/${encodeURIComponent(agent.name)}`;
      return true;
    }
    return false;
  },
};

async function update(agent, patch, message, ctx) {
  try {
    await runtime.updateAgent(agent.name, patch);
    if (message) toast(message);
  } catch (err) {
    toast(err.message, { error: true });
  }
  ctx.reload();
}

const STATE_WORDS = { working: 'Working', idle: 'Idle', asks: 'Asks you', paused: 'Paused', failed: 'Stuck' };

function header(agent, ctx) {
  const since = new Date(agent.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
  return h('header', { class: 'profile-head' },
    agentFace(agent, 72),
    h('div', { class: 'profile-who' },
      h('div', { class: 'profile-name' }, h('h1', { class: 'h1' }, agent.name), roleTag(agent)),
      h('p', { class: 'hint' }, `${STATE_WORDS[agent.state] || agent.state} · last active ${hhmm(agent.lastAt)} · since ${since}`)),
    h('div', { class: 'profile-actions' },
      h('a', { class: 'link', href: `#/agents/${encodeURIComponent(agent.name)}` }, 'Chat', h('span', { class: 'key-inline' }, 'C')),
      h('button', {
        type: 'button',
        class: 'link',
        onclick: async () => {
          await (agent.paused ? runtime.resume(agent.name) : runtime.pause(agent.name));
          ctx.reload();
        },
      }, agent.paused ? 'Resume' : 'Pause'),
      h('button', {
        type: 'button',
        class: 'link',
        onclick: async () => {
          if (!confirm(`Delete ${agent.name}? Its conversation, routines and memory go with it.`)) return;
          await runtime.deleteAgent(agent.name);
          toast(`Deleted ${agent.name}.`);
          location.hash = '#/agents';
        },
      }, 'Delete')));
}

function section(title, lead, ...body) {
  return h('section', { class: 'profile-section' },
    h('h2', { class: 'section-title' }, title),
    lead ? h('p', { class: 'hint section-lead-hint' }, lead) : null,
    body);
}

function brief(agent, set) {
  const key = `brief:${agent.name}`;
  const box = bindDraft(h('textarea', { class: 'textarea brief-box', 'aria-label': 'Brief' }), key, agent.brief);
  const save = () => {
    const value = box.value.trim();
    drafts.delete(key);
    if (value && value !== agent.brief) set({ brief: value }, 'Saved the brief.');
  };
  box.addEventListener('blur', save);
  onModEnter(box, () => box.blur());
  return section('Brief', `What ${agent.name} reads before every conversation.`, box);
}

function select(options, value, label, onchange) {
  return h('label', { class: 'select-box' },
    h('select', { 'aria-label': label, onchange: (e) => onchange(e.target.value) },
      options.map(([v, text]) => h('option', { value: v, selected: v === value }, text))));
}

function model(agent, set) {
  const provider = PROVIDERS.find((p) => p.id === agent.provider) || PROVIDERS[0];
  return section('Model', null,
    h('div', { class: 'select-row' },
      select(PROVIDERS.map((p) => [p.id, p.name]), agent.provider, 'Provider',
        (id) => set({ provider: id, model: PROVIDERS.find((p) => p.id === id).models[0].id })),
      select(provider.models.map((m) => [m.id, m.id]), agent.model, 'Model', (id) => set({ model: id })),
      select(THINKING.map((t) => [t, `Thinking: ${t}`]), agent.thinking, 'Thinking', (t) => set({ thinking: t }))),
    h('p', { class: 'hint' }, costHint(agent.provider, agent.model)));
}

function settingRow(title, detail, on, label, onchange, extra) {
  return h('div', { class: 'setting' },
    h('div', { class: 'setting-main' },
      h('div', {}, title),
      detail || extra ? h('div', { class: 'hint' }, detail, extra) : null),
    toggle(on, label, onchange));
}

function abilities(agent, set, ctx) {
  return section('Abilities', `What ${agent.name} can reach.`,
    ABILITIES.map(([id, title, detail]) => {
      const on = Boolean(agent.abilities[id]);
      let line = detail;
      let extra = null;
      if (id === 'apps') {
        line = agent.apps.length ? `${list(agent.apps)} ${agent.apps.length === 1 ? 'is' : 'are'} connected. ` : 'Nothing connected yet. ';
        extra = h('button', { type: 'button', class: 'link', onclick: () => connectApps(agent, ctx) }, 'Connect an app');
      }
      if (id === 'code' && on && agent.worksIn) line = `Works in ${agent.worksIn.folder}, on its own branch.`;
      return settingRow(title, line, on, title, () => set({ abilities: { [id]: !on } }), extra);
    }));
}

const list = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

function connectApps(agent, ctx) {
  const chosen = new Set(agent.apps);
  const rows = APPS.map((app) => h('label', { class: 'app-pick' },
    h('input', { type: 'checkbox', checked: chosen.has(app), onchange: (e) => (e.target.checked ? chosen.add(app) : chosen.delete(app)) }),
    h('span', {}, app)));
  const save = async (e) => {
    e.preventDefault();
    await runtime.updateAgent(agent.name, { apps: APPS.filter((a) => chosen.has(a)), abilities: { apps: chosen.size > 0 } });
    closeDialog();
    ctx.reload();
  };
  openDialog(h('form', { class: 'sheet', onsubmit: save },
    h('header', { class: 'sheet-head' }, h('div', { class: 'sheet-title' }, h('span', { class: 'label' }, `Apps for ${agent.name}`)),
      h('button', { type: 'button', class: 'close link', onclick: closeDialog }, 'Close')),
    h('div', { class: 'sheet-body' },
      h('p', { class: 'hint' }, 'Apps are MCP servers the agent can use. In the dummy, picking one just marks it connected.'),
      h('div', { class: 'app-picks' }, rows)),
    h('footer', { class: 'sheet-foot' }, h('span'), h('button', { type: 'submit', class: 'btn primary' }, 'Save'))), null, 'small');
}

function askFirst(agent, set) {
  if (!agent.askFirst.length) return null;
  return section('Ask me first', 'Anything switched on becomes an approval in your conversation. Always allow on that card switches it off here.',
    agent.askFirst.map((rule) => settingRow(rule.label, null, rule.on, rule.label, () => set({ askFirst: { [rule.id]: !rule.on } }))));
}

const TRIGGERS = [
  ['schedule', 'On a schedule', 'Weekdays 07:30'],
  ['mail', 'When mail arrives', 'When mail from Paul Eriksen arrives'],
  ['calendar', 'When the calendar changes', 'When an event is moved or about to start'],
  ['tracker', 'When an issue moves', 'When an issue moves to In review'],
];

function routines(agent, ctx) {
  return section('Routines', 'Work it does on its own: on a schedule, or when something happens.',
    agent.routines.length
      ? h('div', { class: 'routine-list' }, agent.routines.map((r) => h('div', { class: 'routine' },
        h('div', { class: 'routine-main' },
          h('div', { class: 'routine-name' }, h('span', {}, r.name), h('span', { class: 'mono muted' }, r.when)),
          r.does ? h('div', { class: 'hint' }, r.does) : null),
        h('span', { class: 'mono muted routine-when' }, r.next ? `next ${r.next}` : r.last ? `last ${lastRun(r.last)}` : ''),
        h('button', { type: 'button', class: 'link', onclick: () => editRoutine(agent, r, ctx) }, 'Edit'))))
      : h('p', { class: 'hint' }, 'No routines yet.'),
    h('button', { type: 'button', class: 'btn small', onclick: () => editRoutine(agent, null, ctx) }, 'New routine'));
}

function editRoutine(agent, routine, ctx) {
  const name = h('input', { class: 'input', value: routine?.name || '', placeholder: 'Morning briefing', 'aria-label': 'Name' });
  let trigger = routine?.trigger || 'schedule';
  const when = h('input', { class: 'input', value: routine?.when || '', 'aria-label': 'When' });
  const does = h('textarea', { class: 'textarea', value: routine?.does || '', placeholder: 'What it should do, in a sentence or two.', 'aria-label': 'What it does' });
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'What starts it' });
  const drawSeg = () => {
    const example = TRIGGERS.find(([id]) => id === trigger)[2];
    when.placeholder = example;
    seg.replaceChildren(...TRIGGERS.map(([id, label]) => h('button', {
      type: 'button',
      'aria-pressed': String(trigger === id),
      onclick: () => {
        trigger = id;
        drawSeg();
      },
    }, label)));
  };
  drawSeg();
  const save = async (e) => {
    e.preventDefault();
    const fields = { name: name.value.trim(), trigger, when: when.value.trim() || when.placeholder, does: does.value.trim() };
    try {
      if (routine) await runtime.updateRoutine(agent.name, routine.id, fields);
      else await runtime.addRoutine(agent.name, fields);
      closeDialog();
      ctx.reload();
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  const remove = async () => {
    if (!confirm(`Delete the routine "${routine.name}"?`)) return;
    await runtime.deleteRoutine(agent.name, routine.id);
    closeDialog();
    ctx.reload();
  };
  openDialog(h('form', { class: 'sheet', onsubmit: save },
    h('header', { class: 'sheet-head' }, h('div', { class: 'sheet-title' }, h('span', { class: 'label' }, routine ? 'Edit routine' : `New routine for ${agent.name}`)),
      h('button', { type: 'button', class: 'close link', onclick: closeDialog }, 'Close')),
    h('div', { class: 'sheet-body' },
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Name'), name),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'What starts it'), seg),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'When'), when),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'What it does'), does)),
    h('footer', { class: 'sheet-foot' },
      routine ? h('button', { type: 'button', class: 'link', onclick: remove }, 'Delete') : h('span'),
      h('button', { type: 'submit', class: 'btn primary' }, routine ? 'Save' : 'Add routine'))), name, 'small');
}

function memory(agent, ctx) {
  const notes = allNotes ? agent.memory : agent.memory.slice(0, 3);
  return section('Memory', `What ${agent.name} remembers about you · ${agent.memoryCount} note${agent.memoryCount === 1 ? '' : 's'}`,
    notes.length
      ? h('ul', { class: 'notes' }, notes.map((note) => h('li', { class: 'note' },
        h('span', {}, note.text),
        h('button', {
          type: 'button',
          class: 'link forget',
          onclick: async () => {
            await runtime.forget(agent.name, note.id);
            toast(`${agent.name} forgot that.`);
            ctx.reload();
          },
        }, 'Forget'))))
      : h('p', { class: 'hint' }, 'Nothing yet. Tell it "remember that…" in the conversation.'),
    agent.memory.length > 3
      ? h('button', { type: 'button', class: 'link', onclick: () => { allNotes = !allNotes; ctx.rerender(); } }, allNotes ? 'Show fewer' : 'View all')
      : null);
}

function usage(agent, set) {
  const budget = h('input', {
    class: 'input budget',
    inputmode: 'decimal',
    value: agent.budget ? `$${agent.budget}` : '',
    placeholder: 'no limit',
    'aria-label': 'Monthly budget',
    onchange: (e) => {
      const n = Number(String(e.target.value).replace(/[^0-9.]/g, ''));
      set({ budget: n > 0 ? n : null }, n > 0 ? `${agent.name} pauses at $${n} a month.` : `${agent.name} has no budget limit.`);
    },
  });
  const stat = (label, value) => h('div', { class: 'stat' }, h('span', { class: 'label' }, label), h('span', { class: 'stat-value' }, `$${value.toFixed(2)}`));
  return section('Usage', null,
    h('div', { class: 'stats' }, stat('Today', agent.usage.today), stat('This week', agent.usage.week), stat('This month', agent.usage.month)),
    h('label', { class: 'budget-row' }, `Pause ${agent.name} at`, budget, 'a month'));
}
