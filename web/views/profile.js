// An agent's profile: its brief and how it talks, its model, what it can reach, what it asks
// first, its routines and whether it speaks up on its own, its skills, what it has done in the
// tracker, its journal, what it remembers, and what it costs.

import { api } from '../api.js';
import { runtime } from '../runtime/index.js';
import { ABILITIES, MEMORY_KINDS, THINKING, costHint, kindOf } from '../runtime/roles.js';
import { connectToTracker, disconnectFromTracker, revokeTrackerToken, linkable } from '../runtime/tracker-link.js';
import { store } from '../store.js';
import { h, ago, bindDraft, drafts, onModEnter, toast, toggle, topbar } from '../ui.js';
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
    // Its track record comes from the tracker, which knows the agent by name (record.py there).
    const [agent, models, apps, record] = await Promise.all([runtime.agent(name), runtime.models(), runtime.apps(), api.agentRecord(name).catch(() => null)]);
    return { agent, models, apps, record };
  },

  leave() {
    allNotes = false;
    allEntries = false;
    search = searchState();
  },

  render({ agent, models, apps, record }, ctx) {
    const set = (patch, message) => update(agent, patch, message, ctx);
    return h('div', { class: 'page' },
      topbar([
        h('a', { class: 'back phone-only', href: `#/agents/${encodeURIComponent(agent.name)}`, 'aria-label': 'Back to the conversation' }, '‹'),
        h('a', { class: 'crumbs', href: `#/agents/${encodeURIComponent(agent.name)}` }, h('span', {}, agent.name), h('span', {}, '/'), h('span', { class: 'here' }, 'Profile')),
      ]),
      h('div', { class: 'profile' },
        header(agent, ctx),
        brief(agent, set),
        examples(agent, set),
        model(agent, models, set, ctx),
        abilities(agent, apps, set, ctx),
        askFirst(agent, set),
        routines(agent, ctx),
        speakingUp(agent, set),
        skills(agent, ctx),
        trackRecord(agent, record),
        journal(agent, ctx),
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
  return section('Brief', `Who ${agent.name} is and how it works. It reads this before every conversation.`, box);
}

// A few made-up exchanges that show how the agent sounds; it reads them after its brief. Unlike
// the brief, they can be emptied.
function examples(agent, set) {
  const key = `examples:${agent.name}`;
  const box = bindDraft(h('textarea', { class: 'textarea brief-box', 'aria-label': 'How it talks', placeholder: `You: How's it going?\n${agent.name}: …` }), key, agent.examples || '');
  const save = () => {
    const value = box.value.trim();
    drafts.delete(key);
    if (value !== (agent.examples || '')) set({ examples: value }, value ? 'Saved how it talks.' : 'Cleared how it talks.');
  };
  box.addEventListener('blur', save);
  onModEnter(box, () => box.blur());
  return section('How it talks', `A few made-up exchanges that show how ${agent.name} sounds. "You:" is you; ${agent.name} knows they didn't happen.`, box);
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

// Whether the agent speaks up without being asked (runtime/src/rhythm.js): every couple of hours,
// in the day, munin checks in, and the agent says something only when it's worth it.
const PROACTIVITY = [
  ['off', 'Only when asked', 'It talks when you talk to it, and when its routines run.'],
  ['matters', 'When it matters', 'Every couple of hours, 08–21, it looks around and tells you what you need to know soon. Usually it says nothing.'],
  ['chatty', 'Chatty', 'Every couple of hours, 08–21, it shares something when it has something: a thought, a question, a find. It waits for your answer before it does again.'],
];

function speakingUp(agent, set) {
  const current = PROACTIVITY.find(([id]) => id === agent.proactivity) || PROACTIVITY[0];
  return section('Speaking up', `Whether ${agent.name} starts a conversation on its own. It counts towards its budget.`,
    h('div', { class: 'select-row' },
      select(PROACTIVITY.map(([id, label]) => [id, label]), current[0], 'Speaking up', (value) => set({ proactivity: value }, value === 'off' ? `${agent.name} only talks when asked.` : `${agent.name} speaks up ${value === 'chatty' ? 'when it has something' : 'when it matters'}.`))),
    h('p', { class: 'hint' }, current[2]));
}

// What the agent writes at the end of a day it worked: what it did, what it learned and what's
// still open (runtime/src/rhythm.js). Newest first.
let allEntries = false;
function journal(agent, ctx) {
  const entries = agent.journal || [];
  const day = (at) => new Date(at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return section('Journal', entries.length ? `What ${agent.name} writes at the end of a day it worked.` : null,
    entries.length
      ? h('div', { class: 'journal' }, (allEntries ? entries : entries.slice(0, 3)).map((e) => h('div', { class: 'journal-entry' },
        h('span', { class: 'mono muted journal-day' }, day(e.at)),
        h('p', {}, e.text))))
      : h('p', { class: 'hint' }, `Nothing yet. At the end of a day it worked, ${agent.name} writes what it did, what it learned and what's still open.`),
    entries.length > 3
      ? h('button', { type: 'button', class: 'link', onclick: () => { allEntries = !allEntries; ctx.rerender(); } }, allEntries ? 'Show fewer' : 'View all')
      : null);
}

// What the agent knows how to do here (runtime/src/skills.js): its own skills, which it saves as
// it learns and you approve, and the ones other agents share with it. You can write, change,
// share and delete its own; another agent's are changed on that agent's profile.
function skills(agent, ctx) {
  const asks = agent.askFirst.some((r) => r.id === 'skills' && r.on);
  const used = (s) => (s.stale ? 'Not used in a month' : s.uses ? `Used ${s.uses} time${s.uses === 1 ? '' : 's'} · ${ago(s.lastUsed)}` : 'Not used yet');
  const shared = (s) => (s.sharedWith.includes('*') ? 'shared with everyone' : s.sharedWith.length ? `shared with ${list(s.sharedWith)}` : null);
  return section('Skills', `How ${agent.name} does things here, learned from its work.${asks ? ' It asks you before it saves one.' : ''}`,
    agent.skills?.length
      ? h('div', { class: 'routine-list' }, agent.skills.map((s) => h('div', { class: ['routine', s.stale && 'stale'] },
        h('div', { class: 'routine-main' },
          h('div', { class: 'routine-name' }, h('span', { class: 'mono' }, s.name),
            s.mine ? (shared(s) ? h('span', { class: 'mono muted' }, shared(s)) : null) : h('span', { class: 'mono muted' }, `${s.owner}'s`)),
          h('div', { class: 'hint' }, s.description)),
        h('span', { class: 'mono muted routine-when' }, used(s)),
        s.mine ? h('button', { type: 'button', class: 'link', onclick: () => shareSkill(agent, s, ctx) }, 'Share') : null,
        h('button', { type: 'button', class: 'link', onclick: () => editSkill(agent, s, ctx) }, s.mine ? 'Edit' : 'Read'))))
      : h('p', { class: 'hint' }, `None yet. ${agent.name} saves one when it learns how to do something it'll do again, or write one yourself.`),
    h('button', { type: 'button', class: 'btn small', onclick: () => editSkill(agent, null, ctx) }, 'Write a skill'));
}

const SKILL_TEMPLATE = `---
name: 
description: 
---

## When to use

## Steps

## Pitfalls

## How to check
`;

// A skill as its SKILL.md, the format Claude Code reads too. Another agent's skill is read only.
function editSkill(agent, skill, ctx) {
  const mine = !skill || skill.mine;
  const text = h('textarea', { class: 'textarea skill-text', value: skill?.text || SKILL_TEMPLATE, 'aria-label': 'Skill', spellcheck: false, readOnly: !mine });
  const save = async (e) => {
    e.preventDefault();
    if (!mine) return closeDialog();
    try {
      await (skill ? runtime.updateSkill(agent.name, skill.id, { text: text.value }) : runtime.addSkill(agent.name, text.value));
      toast(skill ? 'Saved the skill.' : `${agent.name} has a new skill.`);
      closeDialog();
      ctx.reload();
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  const remove = async () => {
    if (!confirm(`Delete the skill ${skill.name}?${skill.sharedWith.length ? ' The agents it\'s shared with lose it too.' : ''}`)) return;
    await runtime.deleteSkill(agent.name, skill.id);
    closeDialog();
    ctx.reload();
  };
  openDialog(h('form', { class: 'sheet', onsubmit: save },
    h('header', { class: 'sheet-head' }, h('div', { class: 'sheet-title' }, h('span', { class: 'label' }, skill ? (mine ? 'Edit skill' : `${skill.owner}'s skill`) : `New skill for ${agent.name}`)),
      h('button', { type: 'button', class: 'close link', onclick: closeDialog }, 'Close')),
    h('div', { class: 'sheet-body' },
      h('p', { class: 'hint' }, mine ? 'A SKILL.md: its name and what it does up top, then when to use it, the steps, the pitfalls and how to check. Lessons, not logs: no issue ids or dates.' : `Shared with ${agent.name} by ${skill.owner}. Change it on ${skill.owner}'s profile.`),
      text),
    h('footer', { class: 'sheet-foot' },
      skill && mine ? h('button', { type: 'button', class: 'link', onclick: remove }, 'Delete') : h('span'),
      mine ? h('button', { type: 'submit', class: 'btn primary' }, skill ? 'Save' : 'Add skill') : h('button', { type: 'button', class: 'btn primary', onclick: closeDialog }, 'Done'))), text, 'small');
}

// Who else has one of the agent's skills: every agent, or the ones you pick.
function shareSkill(agent, skill, ctx) {
  const others = store.runtimeAgents.map((a) => a.name).filter((n) => n !== agent.name);
  let everyone = skill.sharedWith.includes('*');
  const chosen = new Set(skill.sharedWith.filter((n) => n !== '*'));
  const rows = others.map((name) => h('label', { class: 'app-pick' },
    h('input', { type: 'checkbox', checked: everyone || chosen.has(name), disabled: everyone, onchange: (e) => (e.target.checked ? chosen.add(name) : chosen.delete(name)) }),
    h('span', {}, name)));
  const all = h('label', { class: 'app-pick' },
    h('input', {
      type: 'checkbox',
      checked: everyone,
      onchange: (e) => {
        everyone = e.target.checked;
        for (const box of rows.map((r) => r.querySelector('input'))) Object.assign(box, { disabled: everyone, checked: everyone || chosen.has(box.nextSibling.textContent) });
      },
    }),
    h('span', {}, 'Every agent, now and later'));
  const save = async (e) => {
    e.preventDefault();
    await runtime.updateSkill(agent.name, skill.id, { sharedWith: everyone ? ['*'] : [...chosen] });
    closeDialog();
    ctx.reload();
  };
  openDialog(h('form', { class: 'sheet', onsubmit: save },
    h('header', { class: 'sheet-head' }, h('div', { class: 'sheet-title' }, h('span', { class: 'label' }, `Share ${skill.name}`)),
      h('button', { type: 'button', class: 'close link', onclick: closeDialog }, 'Close')),
    h('div', { class: 'sheet-body' },
      h('p', { class: 'hint' }, `Agents you share it with see it among their skills and read it when it fits. Only ${agent.name} changes it.`),
      h('div', { class: 'app-picks' }, all, rows)),
    h('footer', { class: 'sheet-foot' }, h('span'), h('button', { type: 'submit', class: 'btn primary' }, 'Save'))), null, 'small');
}

// What the agent has done in the tracker: what it shipped, how often its work came back from
// review, what it reviewed for others and where it works. For an agent that isn't in the
// tracker and has done nothing there, nothing.
function trackRecord(agent, record) {
  if (!record) return null;
  const did = record.shipped || record.sent_to_review || record.reviewed;
  if (!did) return agent.abilities.tracker ? section('Track record', `Nothing in the tracker yet. What ${agent.name} ships and reviews shows here.`) : null;
  const prop = (key, ...value) => h('div', { class: 'prop' }, h('span', { class: 'prop-key' }, key), h('span', { class: 'prop-value' }, value));
  const times = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const since = record.since ? new Date(record.since).toLocaleDateString(undefined, { day: 'numeric', month: 'long' }) : null;
  const last = record.last_shipped;
  return section('Track record', `What ${agent.name} has done in the tracker${since ? `, since ${since}` : ''}.`,
    h('div', { class: 'props-list' },
      prop('Shipped', times(record.shipped, 'issue')),
      record.sent_to_review ? prop('Sent back', `${record.sent_back} of the ${times(record.sent_to_review, 'time')} it sent work to review`) : null,
      record.reviewed ? prop('Reviewed', times(record.reviewed, 'time') + ' for others') : null,
      record.projects.length ? prop('Works in', record.projects.map((p) => `${p.key} · ${p.issues}`).join(', ')) : null,
      last ? prop('Last shipped', h('a', { class: 'mono issue-link', href: `#/issues/${encodeURIComponent(last.id)}` }, last.id), ` ${last.title} · ${ago(record.last_shipped_at, true)}`) : null));
}

// What the agent remembers, in its three kinds, each with how full it is. When a kind is full
// the agent makes room itself; you can change or forget any note here too.
function memory(agent, ctx) {
  const kinds = Object.entries(MEMORY_KINDS).map(([kind, { label, cap }]) => ({
    kind, label, notes: agent.memory.filter((n) => kindOf(n) === kind), room: agent.memoryRoom?.[kind] || { used: 0, cap },
  })).filter((k) => k.notes.length);
  const more = kinds.some((k) => k.notes.length > 3);
  return section('Memory', `What ${agent.name} remembers · ${agent.memoryCount} note${agent.memoryCount === 1 ? '' : 's'}. Each kind has room for so much; when one is full, ${agent.name} makes room itself.`,
    kinds.length
      ? kinds.map((k) => h('div', { class: 'note-kind' },
        h('div', { class: 'note-kind-head' },
          h('span', { class: 'label' }, k.label),
          h('span', { class: ['label', 'note-room', k.room.used >= k.room.cap && 'full'] }, `${k.room.used.toLocaleString('en')} / ${k.room.cap.toLocaleString('en')}`)),
        h('ul', { class: 'notes' }, (allNotes ? k.notes : k.notes.slice(0, 3)).map((note) => noteRow(agent, note, ctx)))))
      : h('p', { class: 'hint' }, 'Nothing yet. Tell it "remember that…" in the conversation.'),
    more
      ? h('button', { type: 'button', class: 'link', onclick: () => { allNotes = !allNotes; ctx.rerender(); } }, allNotes ? 'Show fewer' : 'View all')
      : null);
}

// A note, which turns into a field to change it: Return saves, Escape doesn't.
function noteRow(agent, note, ctx) {
  const text = h('span', { class: 'note-text' }, note.about ? [h('span', { class: 'mono muted' }, `${note.about} · `), note.text] : note.text);
  const row = h('li', { class: 'note' }, text,
    h('span', { class: 'note-actions' },
      h('button', {
        type: 'button',
        class: 'link forget',
        onclick: () => {
          const field = h('input', { class: 'input note-input', value: note.text, 'aria-label': 'Note' });
          let done = false;
          const save = async () => {
            if (done) return;
            done = true;
            const value = field.value.trim();
            if (!value || value === note.text) return ctx.rerender();
            try {
              await runtime.changeNote(agent.name, note.id, { text: value });
              toast('Changed the note.');
            } catch (err) {
              toast(err.message, { error: true });
            }
            ctx.reload();
          };
          field.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') field.blur();
            if (e.key === 'Escape') {
              done = true;
              ctx.rerender();
            }
            e.stopPropagation(); // the profile's own keys stay out of the field
          });
          field.addEventListener('blur', save);
          text.replaceWith(field);
          field.focus();
        },
      }, 'Edit'),
      h('button', {
        type: 'button',
        class: 'link forget',
        onclick: async () => {
          await runtime.forget(agent.name, note.id);
          toast(`${agent.name} forgot that.`);
          ctx.reload();
        },
      }, 'Forget')));
  return row;
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
