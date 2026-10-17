// An agent's profile: its brief, model, what it can reach, what it asks first, its routines,
// what it remembers about you, and what it costs.

import { runtime } from '../runtime/index.js';
import { ABILITIES, THINKING, costHint } from '../runtime/roles.js';
import { connectToTracker, disconnectFromTracker, revokeTrackerToken, linkable } from '../runtime/tracker-link.js';
import { store } from '../store.js';
import { h, bindDraft, drafts, onModEnter, toast, toggle, topbar } from '../ui.js';
import { openDialog, closeDialog } from '../dialogs.js';
import { agentFace, roleTag, hhmm } from './agents.js';
import { modelPicker, searchState } from '../model-picker.js';
import { routineWhen } from './conversation.js';

let allNotes = false;
let search = searchState(); // the model picker's search of OpenRouter

export const view = {
  title: (data) => `${data.agent.name} · profile`,
  scope: (params) => `/agents/${params.name}/profile`,

  async load({ name }) {
    const [agent, models, apps] = await Promise.all([runtime.agent(name), runtime.models(), runtime.apps()]);
    return { agent, models, apps };
  },

  leave() {
    allNotes = false;
    search = searchState();
  },

  render({ agent, models, apps }, ctx) {
    const set = (patch, message) => update(agent, patch, message, ctx);
    return h('div', { class: 'page' },
      topbar([
        h('a', { class: 'back phone-only', href: `#/agents/${encodeURIComponent(agent.name)}`, 'aria-label': 'Back to the conversation' }, '‹'),
        h('a', { class: 'crumbs', href: `#/agents/${encodeURIComponent(agent.name)}` }, h('span', {}, agent.name), h('span', {}, '/'), h('span', { class: 'here' }, 'Profile')),
      ]),
      h('div', { class: 'profile' },
        header(agent, ctx),
        brief(agent, set),
        model(agent, models, set, ctx),
        abilities(agent, apps, set, ctx),
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
          try {
            await (agent.paused ? runtime.resume(agent.name) : runtime.pause(agent.name));
          } catch (err) {
            toast(err.message, { error: true }); // over its budget, say
          }
          ctx.reload();
        },
      }, agent.paused ? 'Resume' : 'Pause'),
      h('button', {
        type: 'button',
        class: 'link',
        onclick: async () => {
          const linked = linkable() && agent.tracker?.connected;
          if (!confirm(`Delete ${agent.name}? Its conversation, routines and memory go with it${linked ? ', and its tracker token stops working' : ''}.`)) return;
          await runtime.deleteAgent(agent.name);
          location.hash = '#/agents'; // before anything reloads a profile that's gone
          toast(`Deleted ${agent.name}.`);
          if (linked) await revokeTrackerToken(agent.name);
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

// Your favourite models and the other providers', with the agent's own always among them,
// and a search of all of OpenRouter's.
function model(agent, catalog, set, ctx) {
  return section('Model', 'Your favourites, and anything else on OpenRouter by searching. Prices are dollars per million tokens, in / out.',
    modelPicker({
      catalog,
      provider: agent.provider,
      model: agent.model,
      state: search,
      keep: `profile:${agent.name}:model`,
      rerender: ctx.rerender,
      onPick: (provider, model) => (provider !== agent.provider || model !== agent.model ? set({ provider, model }) : ctx.reload()),
    }),
    h('div', { class: 'select-row' },
      select(THINKING.map((t) => [t, `Thinking: ${t}`]), agent.thinking, 'Thinking', (t) => set({ thinking: t }))),
    h('p', { class: 'hint' }, costHint(catalog, agent.provider, agent.model)));
}

function settingRow(title, detail, on, label, onchange, extra) {
  return h('div', { class: 'setting' },
    h('div', { class: 'setting-main' },
      h('div', {}, title),
      detail || extra ? h('div', { class: 'hint' }, detail, extra) : null),
    toggle(on, label, onchange));
}

function abilities(agent, apps, set, ctx) {
  return section('Abilities', `What ${agent.name} can reach.`,
    ABILITIES.map(([id, title, detail]) => {
      const on = Boolean(agent.abilities[id]);
      let line = detail;
      let extra = null;
      if (id === 'apps') {
        // Its picks by name: they're app ids, or names from before apps were real.
        const names = agent.apps.map((pick) => apps.find((app) => app.id === pick || app.name.toLowerCase() === pick.toLowerCase())?.name || pick);
        line = names.length ? `${list(names)} ${names.length === 1 ? 'is' : 'are'} connected. ` : 'Nothing connected yet. ';
        extra = h('button', { type: 'button', class: 'link', onclick: () => connectApps(agent, ctx) }, 'Connect an app');
      }
      if (id === 'code' && on && agent.worksIn) {
        line = agent.worksIn.branch
          ? `Works in ${agent.worksIn.folder}, ${agent.worksIn.detached ? 'reviewing' : 'on'} ${agent.worksIn.branch}.`
          : `Works in ${agent.worksIn.folder}. An issue it takes gets a worktree on a branch of its own, for projects whose code is set up in Settings.`;
      }
      if (id === 'tracker') return trackerRow(agent, on, title, set, ctx);
      return settingRow(title, line, on, title, () => set({ abilities: { [id]: !on } }), extra);
    }));
}

// The tracker: whether the agent has a token there, and the projects it works on.
function trackerRow(agent, on, title, set, ctx) {
  const link = agent.tracker;
  let line = 'Take, review and file issues in munin';
  let extra = null;
  if (on && link?.connected === false) {
    line = 'Not connected to the tracker yet. ';
    extra = h('button', { type: 'button', class: 'link', onclick: () => connect(agent, ctx) }, 'Connect');
  } else if (on && link) {
    line = link.reachable === false
      ? "Can't reach the tracker right now. The runtime tries again every half minute."
      : `Has its own token, and takes ${link.takes} in the projects picked here.`;
    extra = store.projects.length
      ? h('div', { class: 'project-picks' }, store.projects.map((project) => {
        const picked = link.projects.includes(project.key);
        return h('button', {
          type: 'button',
          class: ['chip', picked ? 'on' : 'quiet'],
          'aria-pressed': String(picked),
          title: project.name,
          onclick: () => set({ tracker: { projects: picked ? link.projects.filter((k) => k !== project.key) : [...link.projects, project.key] } }),
        }, project.key);
      }))
      : null;
  }
  return settingRow(title, line, on, title, () => toggleTracker(agent, !on, ctx), extra);
}

async function connect(agent, ctx) {
  try {
    if (await connectToTracker(agent.name)) toast(`${agent.name} is in the tracker now.`);
  } catch (err) {
    toast(err.message, { error: true });
  }
  ctx.reload();
}

// Turning the Tracker ability on gets the agent a token; turning it off revokes it.
async function toggleTracker(agent, on, ctx) {
  try {
    if (!linkable()) await runtime.updateAgent(agent.name, { abilities: { tracker: on } });
    else if (on) {
      await runtime.updateAgent(agent.name, { abilities: { tracker: true } });
      if (!agent.tracker?.connected) await connectToTracker(agent.name);
    } else {
      if (!confirm(`Take ${agent.name} out of the tracker? Its token stops working; its issues and comments stay.`)) return;
      await disconnectFromTracker(agent.name);
      await runtime.updateAgent(agent.name, { abilities: { tracker: false } });
    }
  } catch (err) {
    toast(err.message, { error: true });
  }
  ctx.reload();
}

const list = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

// Picks from the apps added in Settings. An agent's picks are app ids; older ones were names.
async function connectApps(agent, ctx) {
  const apps = await runtime.apps();
  const mine = (app) => agent.apps.some((pick) => pick === app.id || pick.toLowerCase() === app.name.toLowerCase());
  const chosen = new Set(apps.filter(mine).map((app) => app.id));
  const rows = apps.map((app) => h('label', { class: 'app-pick' },
    h('input', { type: 'checkbox', checked: chosen.has(app.id), onchange: (e) => (e.target.checked ? chosen.add(app.id) : chosen.delete(app.id)) }),
    h('span', {}, app.name, app.connected ? null : h('span', { class: 'muted' }, ` · ${app.detail}`))));
  const save = async (e) => {
    e.preventDefault();
    await runtime.updateAgent(agent.name, { apps: apps.filter((a) => chosen.has(a.id)).map((a) => a.id), abilities: { apps: chosen.size > 0 } });
    closeDialog();
    ctx.reload();
  };
  openDialog(h('form', { class: 'sheet', onsubmit: save },
    h('header', { class: 'sheet-head' }, h('div', { class: 'sheet-title' }, h('span', { class: 'label' }, `Apps for ${agent.name}`)),
      h('button', { type: 'button', class: 'close link', onclick: closeDialog }, 'Close')),
    h('div', { class: 'sheet-body' },
      apps.length
        ? h('p', { class: 'hint' }, `Apps are MCP servers. ${agent.name} gets the tools of the ones you pick.`)
        : h('p', { class: 'hint' }, 'No apps yet. Add one under ', h('a', { class: 'link', href: '#/settings', onclick: closeDialog }, 'Apps in Settings'), ' first.'),
      h('div', { class: 'app-picks' }, rows)),
    h('footer', { class: 'sheet-foot' }, h('span'), h('button', { type: 'submit', class: 'btn primary' }, 'Save'))), null, 'small');
}

function askFirst(agent, set) {
  if (!agent.askFirst.length) return null;
  return section('Ask me first', 'Anything switched on becomes an approval in your conversation. Always allow on that card switches it off here.',
    agent.askFirst.map((rule) => settingRow(rule.label, null, rule.on, rule.label, () => set({ askFirst: { [rule.id]: !rule.on } }))));
}

// Each trigger: its label, an example for the When field, and what munin understands there.
const TRIGGERS = [
  ['schedule', 'On a schedule', 'Weekdays 07:30', "Like 'Weekdays 07:30', 'Mondays at 9', 'Every night 02:00' or 'Every 2 hours, 08–18', in the runtime's time zone."],
  ['mail', 'When mail arrives', 'When mail from Paul Eriksen arrives', "Like 'When new mail arrives', 'When mail from ann@example.com arrives', 'When mail about invoices arrives' or 'When mail matching is:important arrives'. Needs Gmail on this agent; munin looks about once a minute."],
  ['calendar', 'From the calendar', 'Before each meeting', "Like 'Before each meeting', '15 minutes before each event' or 'When an invitation arrives'. Needs Google Calendar on this agent; munin looks about once a minute."],
  ['tracker', 'When an issue moves', 'When an issue moves to In review', "Like 'When an issue moves to In review', 'When vera sends my work back' or 'When an issue in MUN is created'."],
];

function routines(agent, ctx) {
  return section('Routines', 'Work it does on its own: on a schedule, or when something happens.',
    agent.routines.length
      ? h('div', { class: 'routine-list' }, agent.routines.map((r) => h('div', { class: 'routine' },
        h('div', { class: 'routine-main' },
          h('div', { class: 'routine-name' }, h('span', {}, r.name), h('span', { class: 'mono muted' }, r.when)),
          r.does ? h('div', { class: 'hint' }, r.does) : null),
        h('span', { class: ['mono muted routine-when', r.note && 'routine-note'] }, routineWhen(r)),
        r.note || agent.paused ? null : h('button', { type: 'button', class: 'link', onclick: () => runNow(agent, r, ctx) }, 'Run now'),
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
  const understood = h('p', { class: 'hint' });
  const drawSeg = () => {
    const [, , example, hint] = TRIGGERS.find(([id]) => id === trigger);
    when.placeholder = example;
    understood.textContent = hint;
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
      const saved = routine ? await runtime.updateRoutine(agent.name, routine.id, fields) : await runtime.addRoutine(agent.name, fields);
      closeDialog();
      // The runtime says "when" in its own words, so you see what it understood.
      if (saved?.when && saved.when !== fields.when) toast(`Saved, as "${saved.when}".`);
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
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'When'), when, understood),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'What it does'), does)),
    h('footer', { class: 'sheet-foot' },
      routine ? h('button', { type: 'button', class: 'link', onclick: remove }, 'Delete') : h('span'),
      h('button', { type: 'submit', class: 'btn primary' }, routine ? 'Save' : 'Add routine'))), name, 'small');
}

async function runNow(agent, routine, ctx) {
  try {
    await runtime.runRoutine(agent.name, routine.id);
    toast(`${agent.name} is running "${routine.name}".`);
  } catch (err) {
    toast(err.message, { error: true });
  }
  ctx.reload();
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
