// munin's setup: the first time munin opens, and again from Settings. A full-screen layer over
// the app, after the intro: the steps down the left, the step in the middle and how it'll look on
// the right. It asks what agents should call you, gets OpenRouter a key and picks favourite
// models, makes your first agent, and gives outside agents a token for the tracker's MCP. It
// ends on your agent, awake and waiting for its first message. The runtime remembers where
// setup is (runtime.me().setup), so a reload carries on.

import { api } from './api.js';
import { runtime } from './runtime/index.js';
import { ROLES, roleOf, price } from './runtime/roles.js';
import { connectToTracker, linkable } from './runtime/tracker-link.js';
import { store, remember } from './store.js';
import { h, svg, toast, copyButton, toggle, MOD } from './ui.js';
import { figbot, COLOURS } from './figbot.js';
import { claudeMark, isClaude } from './claude-mark.js';
import { notificationsSupported, notificationsOn, setNotifications } from './notify.js';
import { modelPicker, searchState } from './model-picker.js';
import { playIntro } from './intro.js';

const STEPS = ['welcome', 'you', 'models', 'agent', 'mcp', 'ready'];
const RAIL = [['you', 'You'], ['models', 'Models'], ['agent', 'First agent']];
const STEP = 'munin:setup-step';
const MADE = 'munin:setup-agent'; // the agent setup woke up, so a reload still knows it
// The first agent's name, unless it's taken already (setup run again): the first free one of these.
const NAMES = ['tosk', 'ravn', 'skuld', 'idun', 'frigg', 'sif'];
const TIERS = [['cheap', 'Cheap', 'Chores, chat and quick answers'], ['frontier', 'Frontier', 'Hard problems and long tasks']];

let S = null; // the setup, while it's open
let layer = null;
let parts = null; // { rail, main, aside }
let keyTimer = 0;
let poll = 0;

export const setupOpen = () => Boolean(layer);

// Pixel marks -----------------------------------------------------------------------------

const box = (stroke, extra = {}) => ['rect', { x: 0.5, y: 0.5, width: 11, height: 11, fill: 'none', stroke, ...extra }];
const CHECK = () => svg(12, '0 0 12 12', [['rect', { width: 12, height: 12, fill: '#EDEDED' }], ['path', { fill: '#0A0A0A', d: 'M3 6h1v1H3zM4 7h1v1H4zM5 8h1v1H5zM6 7h1v1H6zM7 6h1v1H7zM8 5h1v1H8zM9 4h1v1H9z' }]]);
const NOW = () => svg(12, '0 0 12 12', [box('#EDEDED'), ['rect', { x: 3, y: 3, width: 6, height: 6, fill: '#EDEDED' }]]);
const TODO = () => svg(12, '0 0 12 12', [box('#4E4E4E', { 'stroke-dasharray': '1 1' })]);
const LOCK = () => svg(12, '0 0 12 12', [['path', { fill: '#7A7A7A', 'fill-rule': 'evenodd', d: 'M3 5V3h1V2h4v1h1v2h1v6H2V5h1zm1 0h4V3H4v2z' }]]);
const FAV = () => svg(10, '0 0 10 10', [['rect', { x: 0.5, y: 0.5, width: 9, height: 9 }]], { cls: 'su-fav' });
const dot = (off) => h('i', { class: ['su-dot', off && 'off'] });
const LOGO = () => h('img', { class: 'su-logo', src: 'munin-lockup-dither-on-dark.svg', alt: 'munin', width: 122, height: 26 });

// Opening and closing ---------------------------------------------------------------------

const agentName = () => S.agent.trim().toLowerCase() || 'your agent';
const openrouter = () => S.providers.find((p) => p.id === 'openrouter');
const keyed = () => Boolean(openrouter()?.connected);
const favourites = () => S.catalog.find((p) => p.id === 'openrouter')?.models.filter((m) => m.favourite).map((m) => m.id) || [];
const modelOf = (provider, id) => S.catalog.find((p) => p.id === provider)?.models.find((m) => m.id === id);
const machine = () => {
  const url = new URL(store.me.mcp_url || location.href);
  return url.protocol === 'https:' ? url.hostname.split('.')[0] : location.hostname;
};

export async function openSetup({ intro = false } = {}) {
  if (layer) return;
  document.body.classList.add('setup-pending'); // the app stays out of sight while setup gets ready
  let about;
  try {
    const [me, catalog, providers, agents] = await Promise.all([runtime.me(), runtime.models(), runtime.providers(), runtime.agents()]);
    about = me;
    S = { about, catalog, providers, agents };
  } catch (err) {
    document.body.classList.remove('setup-pending');
    toast(`Setup can't start: ${err.message}`, { error: true });
    return;
  }
  const resuming = about.setup === 'started';
  const saved = remember(STEP);
  const made = resuming ? S.agents.find((a) => a.name === remember(MADE)) : null;
  Object.assign(S, {
    step: resuming && STEPS.includes(saved) ? saved : 'welcome',
    name: (about.name !== 'me' && about.name) || store.me.you?.name || '',
    notify: notificationsOn(),
    key: '', keyState: 'empty', keyError: '', changingKey: false,
    recommended: null,
    role: made?.role || 'assistant', colour: made?.colour || 'white', created: made?.name || null,
    agent: made?.name || NAMES.find((n) => !S.agents.some((a) => a.name === n)) || '',
    provider: made?.provider || null, model: made?.model || null, search: searchState(),
    outside: 'claude-code', token: null, connected: false, tab: 'claude',
  });
  pickDefaultModel();
  if (about.setup !== 'started') runtime.updateMe({ setup: 'started' }).catch(() => {});

  parts = { rail: h('nav', { class: 'su-rail', 'aria-label': 'Setup steps' }), main: h('main', { class: 'su-main' }), aside: h('aside', { class: 'su-aside' }) };
  layer = h('div', { class: ['setup', intro && 'hold'], role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Set up munin' },
    h('div', { class: 'su-shell' }, parts.rail, parts.main, parts.aside));
  layer.addEventListener('keydown', onKey);
  document.body.append(layer);
  document.body.classList.replace('setup-pending', 'in-setup');
  for (const id of ['appbar', 'app']) document.getElementById(id).inert = true; // the app waits underneath
  go(S.step, { quiet: true });
  if (intro) {
    await playIntro();
    layer.classList.remove('hold');
    layer.classList.add('reveal');
    setTimeout(() => layer?.classList.remove('reveal'), 1200);
  }
}

function close(hash) {
  clearInterval(poll);
  clearTimeout(keyTimer);
  layer.remove();
  layer = null;
  S = null;
  parts = null;
  remember(STEP, '');
  remember(MADE, '');
  document.body.classList.remove('in-setup');
  for (const id of ['appbar', 'app']) document.getElementById(id).inert = false;
  if (hash && location.hash !== hash) location.hash = hash;
  else dispatchEvent(new Event('munin:setup-closed'));
}

async function finishSetup() {
  try {
    await runtime.updateMe({ setup: 'done' });
  } catch (err) {
    toast(err.message, { error: true });
  }
}

// Skipping ends setup for good; it's in Settings when you want it.
async function skip() {
  await finishSetup();
  close();
  toast('Setup is in Settings whenever you want it.');
}

// The first favourite, or what's there when OpenRouter has no key.
function pickDefaultModel() {
  if (S.model && modelOf(S.provider, S.model)) return;
  const first = S.catalog.find((p) => p.id === 'openrouter' && p.models.length) || S.catalog.find((p) => p.models.length);
  S.provider = first?.id || 'standin';
  S.model = first?.models[0]?.id || 'stand-in';
}

// Drawing ---------------------------------------------------------------------------------

function go(step, { quiet = false } = {}) {
  if (!STEPS.includes(step)) return;
  S.step = step;
  remember(STEP, step);
  clearInterval(poll);
  render(true);
  if (step === 'models' && keyed() && !S.recommended) loadRecommended();
  if (step === 'mcp' && S.token && !S.connected) watchConnection();
  if (step === 'ready') finishSetup();
  if (!quiet && innerWidth > 760) layer.querySelector('.su-main [data-autofocus], .su-main [data-primary]')?.focus({ preventScroll: true });
}

// Redraw, keeping focus and the caret on whatever has a data-keep.
function render(fresh = false) {
  if (!layer) return;
  const active = document.activeElement;
  const keep = active && layer.contains(active) ? active.dataset.keep : null;
  const caret = keep && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  const top = parts.main.scrollTop;

  const page = PAGES[S.step]();
  layer.classList.toggle('solo', S.step === 'welcome' || S.step === 'ready');
  parts.rail.replaceChildren(...rail().flat(Infinity).filter(Boolean));
  parts.main.replaceChildren(page.main);
  parts.aside.replaceChildren(...(page.aside || []).flat(Infinity).filter(Boolean));
  parts.main.scrollTop = fresh ? 0 : top;
  page.after?.();

  if (keep) {
    const el = layer.querySelector(`[data-keep="${CSS.escape(keep)}"]`);
    el?.focus({ preventScroll: true });
    if (el && caret && typeof el.setSelectionRange === 'function') el.setSelectionRange(...caret);
  }
}

// What's typed shows up elsewhere on the page as it's typed, without a redraw.
function sync() {
  const values = { name: S.name.trim() || 'you', initial: (S.name.trim()[0] || '?').toUpperCase(), agent: agentName(), brief: roleOf(S.role).brief(agentName(), S.name.trim() || null) };
  for (const el of layer.querySelectorAll('[data-bind]')) {
    const v = values[el.dataset.bind];
    if (v !== undefined && el.textContent !== v) el.textContent = v;
  }
}
const bound = (key, text) => h('span', { dataset: { bind: key } }, text);

function rail() {
  const at = STEPS.indexOf(S.step);
  const done = (id) => STEPS.indexOf(id) < at;
  const value = { you: () => S.name.trim(), models: () => (keyed() ? 'OpenRouter' : ''), agent: () => S.created || '' };
  const link = (id, label, n, isDone) => h('button', { type: 'button', class: ['su-step', S.step === id && 'now', isDone && 'done'], 'aria-current': S.step === id ? 'step' : null, onclick: () => go(id) },
    S.step === id ? NOW() : isDone ? CHECK() : TODO(),
    h('span', { class: 'su-n' }, n),
    h('span', {}, label),
    isDone && value[id]?.() ? h('span', { class: 'su-v' }, value[id]()) : null);
  return [
    LOGO(),
    h('div', { class: 'label su-rail-head' }, 'Set up munin'),
    RAIL.map(([id, label], i) => link(id, label, `0${i + 1}`, done(id))),
    h('div', { class: 'label su-group' }, 'Optional'),
    link('mcp', 'Set-up MCP', '04', Boolean(S.token)),
    h('p', { class: 'hint su-saved' }, "Saved as you go. Close the tab and you'll pick up here."),
    h('button', { type: 'button', class: 'label su-skip', onclick: skip }, 'Skip setup'),
  ];
}

function head(eyebrow, title, lead) {
  return [
    h('div', { class: 'su-eyebrow' }, h('span', { class: 'label' }, eyebrow), h('button', { type: 'button', class: 'label su-skip-inline', onclick: skip }, 'Skip setup')),
    h('h1', { class: 'su-title' }, title),
    lead ? h('p', { class: 'su-lead' }, lead) : null,
  ];
}

// Back, and the step's one primary action; `next` is a step, or a function that does the step's work.
function foot(prev, next, label, ...extra) {
  const primary = h('button', { type: 'button', class: 'su-go', dataset: { primary: '' } }, label, h('kbd', {}, '↵'));
  primary.addEventListener('click', async () => {
    if (typeof next === 'string') return go(next);
    primary.disabled = true;
    try {
      await next();
    } finally {
      primary.disabled = false;
    }
  });
  return h('div', { class: 'su-foot' },
    prev ? h('button', { type: 'button', class: 'su-back', onclick: () => go(prev) }, '← Back') : h('span'),
    h('div', { class: 'su-right' }, extra, primary));
}

function field({ keep, autofocus, ...props }) {
  return h('input', { class: 'su-field', autocomplete: 'off', spellcheck: false, dataset: { keep, ...(autofocus ? { autofocus: '' } : {}) }, ...props });
}

// Pages -----------------------------------------------------------------------------------

const PAGES = {
  welcome() {
    const edge = new URL(store.me.mcp_url || location.href);
    const provider = openrouter();
    const checks = [
      ['tracker', `munin ${store.me.version || ''}`.trim(), 'up'],
      runtime.kind === 'runtime' ? ['runtime', 'agents run here', 'up'] : ['runtime', 'not running: a stand-in plays it', 'off', true],
      edge.protocol === 'https:' ? ['edge', edge.hostname, 'https'] : ['edge', 'this machine only', 'local'],
      store.me.you ? ['people', store.me.you.login, 'you'] : null,
      S.about.sandbox ? ['coders', 'a container each', 'docker'] : ['coders', 'on this machine', 'no sandbox'],
      keyed() ? ['models', `OpenRouter${provider.key?.hint ? ` …${provider.key.hint}` : ''}`, 'ready'] : ['models', 'none yet', 'step 2', true],
    ].filter(Boolean);
    const sleepers = h('div', { class: 'su-sleepers', 'aria-hidden': 'true' },
      h('div', { class: 'su-sleepers-row' }, ['ember', 'coral', 'rose', 'iris', 'white', 'sky', 'teal', 'moss', 'straw'].map((c, i) => h('div', { class: ['su-sleeper', c === 'white' && 'peek'] },
        figbot({ colour: c, state: c === 'white' ? 'asks' : 'paused', size: 36, seed: c }),
        c !== 'white' && i % 2 === 0 ? h('span', { class: 'su-z', style: `animation-delay: ${(i * 0.7) % 3}s` }, 'z') : null))),
      h('div', { class: 'su-ground' }),
      h('div', { class: 'label' }, 'Meet your team'));
    return {
      main: h('div', { class: 'su-screen su-welcome-wrap' },
        h('div', { class: 'su-welcome' },
          h('section', { class: 'su-hello-side' },
            LOGO(),
            h('h1', { class: 'su-hello' }, S.name.trim() ? `Hello, ${S.name.trim()}.` : 'Hello.'),
            h('p', { class: 'su-lead' }, `munin is up on ${machine()}${store.me.you ? ', and only the people you let in can reach it' : ''}. `
              + "Three short steps and you'll have an agent at work."),
            h('div', { class: 'su-cta' },
              h('button', { type: 'button', class: 'su-go', dataset: { primary: '' }, onclick: () => go('you') }, 'Set up munin', h('kbd', {}, '↵')),
              h('button', { type: 'button', class: 'su-ghost', onclick: skip }, 'Look around first')),
            h('p', { class: 'hint' }, 'Nothing here is final. Everything you set up now lives in Settings afterwards.')),
          h('section', { class: 'su-checks', 'aria-label': 'This machine' },
            h('div', { class: 'su-checks-head' }, h('span', { class: 'label' }, 'Checking this machine'), h('span', { class: 'mono muted' }, machine())),
            h('div', { class: 'su-checks-body' }, checks.map(([k, v, s, pending], i) => h('div', { class: ['su-check', pending && 'pending'], style: `--i: ${i}` },
              h('span', { class: 'su-k' }, k), h('span', { class: 'su-cv' }, v), h('span', { class: 's' }, dot(pending), s)))))),
        sleepers),
    };
  },

  you() {
    const fromTailscale = store.me.you && S.name.trim() === store.me.you.name;
    return {
      main: h('div', { class: 'su-body su-screen' },
        head('Step 1 of 3 · You', 'What should agents call you?', `It's how they talk to you, and the name they ask for when they need you.${store.me.you ? ` Tailscale knows you as ${store.me.you.login}.` : ''}`),
        h('div', { class: 'su-fieldset' },
          h('label', { class: 'su-lab', for: 'su-name' }, 'Your name'),
          field({ id: 'su-name', keep: 'su:name', autofocus: true, value: S.name, placeholder: 'Your name', style: 'max-width: 380px',
            oninput: (e) => {
              S.name = e.target.value;
              sync();
            } }),
          h('span', { class: 'hint' }, fromTailscale ? 'From Tailscale. Change it if you go by something else.' : 'A first name is plenty.')),
        notificationsSupported ? h('div', { class: 'su-setting' },
          h('div', {}, h('span', {}, 'Tell me when an agent asks something'),
            h('span', { class: 'hint' }, 'A notification for each question, and when work moves to review. Your browser asks you first.')),
          toggle(S.notify, 'Tell me when an agent asks something', async () => {
            S.notify = (await setNotifications(!S.notify)) === 'granted';
            render();
          })) : null,
        foot('welcome', saveName, 'Continue')),
      aside: [
        h('div', { class: 'label' }, "How it'll read"),
        h('div', { class: 'su-msg' }, h('span', { class: 'su-bot-frame' }, figbot({ colour: S.colour, size: 24, state: 'idle', seed: S.agent })),
          h('div', { class: 'su-msg-main' }, h('div', { class: 'su-who' }, h('span', {}, agentName()), h('span', { class: 'su-t' }, '07:30')),
            h('div', { class: 'su-said' }, 'Morning, ', h('span', { class: 'su-mark' }, bound('name', S.name.trim() || 'you')), ". I sorted the inbox, and I have one question before anything goes out."))),
        h('div', { class: 'su-msg' }, h('span', { class: 'su-square' }, bound('initial', (S.name.trim()[0] || '?').toUpperCase())),
          h('div', { class: 'su-msg-main' }, h('div', { class: 'su-who' }, h('span', { class: 'su-mark' }, bound('name', S.name.trim() || 'you')), h('span', { class: 'su-t' }, '07:42')),
            h('div', { class: 'su-said' }, 'Go ahead.'))),
        h('div', { class: 'label su-aside-gap' }, 'A notification'),
        h('div', { class: 'su-note' }, h('img', { src: 'munin-mark-dither-on-dark.svg', alt: '', width: 24, height: 24 }),
          h('div', { class: 'su-msg-main' }, h('span', {}, `${agentName()} asks you, `, bound('name', S.name.trim() || 'you')), h('span', { class: 'hint' }, 'Send the reply now, or after lunch?'))),
      ],
    };
  },

  models() {
    const provider = openrouter();
    const showKey = !keyed() || S.changingKey;
    return {
      main: h('div', { class: 'su-body su-screen' },
        head('Step 2 of 3 · Models', 'Give them something to think with',
          'Agents think through OpenRouter: hundreds of models behind one key, and you pay OpenRouter for what they use. Each agent picks its own model later.'),
        showKey
          ? h('div', { class: 'su-fieldset' },
            h('label', { class: 'su-lab', for: 'su-key' }, 'OpenRouter key'),
            field({ id: 'su-key', type: 'password', keep: 'su:key', autofocus: true, value: S.key, placeholder: 'sk-or-v1-…', class: 'su-field mono',
              oninput: (e) => {
                S.key = e.target.value;
                clearTimeout(keyTimer);
                keyTimer = setTimeout(checkKey, 700);
              },
              onkeydown: (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                e.stopPropagation();
                clearTimeout(keyTimer);
                checkKey();
              } }),
            h('div', { class: 'su-status', id: 'su-key-status', role: 'status' }, keyStatus()),
            h('span', { class: 'hint' }, 'No key yet? Make one at ',
              h('a', { class: 'su-inline', href: 'https://openrouter.ai/settings/keys', target: '_blank', rel: 'noopener noreferrer' }, 'openrouter.ai/settings/keys'),
              '. You can also add it later, in Settings.'))
          : h('div', { class: 'su-connected' }, dot(false),
            h('span', {}, 'OpenRouter is connected'), h('span', { class: 'mono muted' }, provider.detail),
            h('button', { type: 'button', class: 'su-inline', onclick: () => { S.changingKey = true; render(); layer.querySelector('#su-key')?.focus(); } }, 'Change key')),
        keyed() ? recommendations() : null,
        h('div', { class: 'hint su-lock' }, LOCK(), h('span', {}, `Keys stay on ${machine()}. munin never shows one again, and agents never see it.`)),
        foot('you', 'agent', 'Continue')),
      aside: [
        h('div', { class: 'label' }, 'Where your key goes'),
        h('div', { class: 'su-flow' },
          h('div', {}, h('span', { class: 'k' }, 'Agents'), h('span', { class: 'v' }, 'ask munin for a model, and never see the key')),
          h('div', {}, h('span', { class: 'k' }, machine()), h('span', { class: 'v' }, 'keeps the key and makes the call')),
          h('div', {}, h('span', { class: 'k' }, 'OpenRouter'), h('span', { class: 'v' }, 'runs the model and bills you for what it used'))),
        h('p', { class: 'hint' }, 'A day of steady work costs cents on a cheap model and a few dollars on a frontier one. Each agent gets a budget on its profile.'),
      ],
    };
  },

  agent() {
    const role = roleOf(S.role);
    const chosen = modelOf(S.provider, S.model);
    const can = Object.keys(role.abilities).join(' · ') || 'just talk';
    const runsIn = role.abilities.code ? (S.about.sandbox ? 'a container of its own' : `its own folder on ${machine()}`) : 'the runtime';
    const facts = [['Model', chosen && S.provider !== 'standin' ? chosen.name : 'the stand-in'], ['Can', can], ['Runs in', runsIn]];
    const name = agentName();
    return {
      main: h('div', { class: 'su-body su-screen' },
        head('Step 3 of 3 · First agent', 'Meet your first agent', 'Pick a role to start from. You can change everything later.'),
        h('div', { class: 'su-mini' }, figbot({ colour: S.colour, state: 'idle', size: 72, seed: S.agent }),
          h('div', { class: 'su-mini-main' }, h('span', { class: 'su-mini-name' }, bound('agent', name)), h('span', { class: 'label' }, `${role.name} · ${facts[0][1]}`))),
        h('div', { class: 'su-roles', role: 'radiogroup', 'aria-label': 'Role' }, ROLES.map((r) => h('button', {
          type: 'button', class: ['su-role', S.role === r.id && 'on'], role: 'radio', 'aria-checked': String(S.role === r.id),
          dataset: { keep: `su:role:${r.id}` },
          onclick: () => {
            S.role = r.id;
            render();
          },
        }, h('span', { class: 'su-role-top' }, h('span', { class: 'su-rn' }, r.name), S.role === r.id ? CHECK() : null), h('span', { class: 'su-rw' }, r.line)))),
        h('div', { class: 'su-agent-row' },
          h('div', { class: 'su-fieldset' },
            h('label', { class: 'su-lab', for: 'su-agent' }, 'Name'),
            field({ id: 'su-agent', keep: 'su:agent', value: S.agent, placeholder: NAMES[0], readOnly: Boolean(S.created),
              oninput: (e) => {
                S.agent = e.target.value;
                sync();
              } }),
            S.created ? h('span', { class: 'hint' }, `${S.created} is awake, so it keeps its name.`) : null),
          h('div', { class: 'su-fieldset' },
            h('span', { class: 'su-lab', id: 'su-colour' }, 'Colour'),
            h('div', { class: 'su-colours', role: 'radiogroup', 'aria-labelledby': 'su-colour' }, Object.keys(COLOURS).map((c) => h('button', {
              type: 'button', class: ['su-colour', S.colour === c && 'on'], role: 'radio', 'aria-checked': String(S.colour === c), 'aria-label': c,
              dataset: { keep: `su:colour:${c}` },
              onclick: () => {
                S.colour = c;
                render();
              },
            }, figbot({ colour: c, size: 30, state: 'idle', animate: false })))))),
        h('div', { class: 'su-fieldset' },
          h('span', { class: 'su-lab' }, 'Model'),
          keyed() ? null : h('div', { class: 'su-nokey' }, h('span', {}, 'No OpenRouter key yet, so only the stand-in, which doesn’t think.'),
            h('button', { type: 'button', class: 'su-inline', onclick: () => go('models') }, 'Add one in step 2')),
          modelPicker({
            catalog: S.catalog, provider: S.provider, model: S.model, state: S.search, keep: 'su:model', rerender: () => render(), standin: !keyed(),
            onPick: (provider, model, next) => {
              if (next) S.catalog = next;
              Object.assign(S, { provider, model });
              render();
            },
          }),
          keyed() ? h('span', { class: 'hint' }, 'Your favourites, from step 2. Pick one from the search and it becomes a favourite too. Prices are dollars per million tokens, in / out.') : null),
        foot('models', wakeAgent, S.created ? `Save ${S.created}` : ['Wake ', bound('agent', name), ' up'])),
      aside: [
        h('div', { class: 'label' }, 'Your agent'),
        h('div', { class: 'su-portrait' },
          h('div', { class: 'su-bob', id: 'su-big-bot' }), h('span', { class: 'su-shadow', 'aria-hidden': 'true' }),
          h('div', { class: 'su-portrait-name' }, h('span', { class: 'su-big' }, bound('agent', name)), h('span', { class: 'label' }, role.name))),
        h('div', { class: 'su-facts' }, facts.map(([k, v]) => h('div', {}, h('span', { class: 'label' }, k), h('span', {}, v)))),
        h('p', { class: 'su-brief' }, bound('brief', role.brief(name, S.name.trim() || null))),
        h('p', { class: 'hint' }, `Abilities, routines and a budget are on `, bound('agent', name), "'s profile."),
      ],
      after() {
        layer.querySelector('#su-big-bot')?.append(figbot({ colour: S.colour, state: 'idle', size: 144, seed: S.agent, label: `${name}, in ${S.colour}` }));
      },
    };
  },

  mcp() {
    const mcp = store.me.mcp_url;
    const token = S.token || 'mun_…';
    const command = `claude mcp add --transport http munin \\\n    ${mcp} \\\n    --header "Authorization: Bearer ${token}"`;
    const json = JSON.stringify({ mcpServers: { munin: { type: 'http', url: mcp, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
    const snippet = S.tab === 'json' ? json : command;
    const own = S.created ? runtimeAgent(S.created) : null;
    const tab = (id, label) => h('button', { type: 'button', class: 'su-tab', role: 'tab', 'aria-selected': String(S.tab === id), onclick: () => { S.tab = id; render(); } }, label);
    return {
      main: h('div', { class: 'su-body su-screen' },
        head('Optional · Set-up MCP', 'Already have agents?',
          `Claude Code, Codex or any MCP client can work in the tracker${S.created ? ` next to ${S.created}` : ''}. Each gets a token of its own, so you can revoke one without touching the rest.`),
        h('div', { class: 'su-fieldset' },
          h('label', { class: 'su-lab', for: 'su-outside' }, 'Name it after the client'),
          h('div', { class: 'su-token-row' },
            field({ id: 'su-outside', keep: 'su:outside', value: S.outside, readOnly: Boolean(S.token), style: 'max-width: 300px', oninput: (e) => { S.outside = e.target.value; } }),
            h('button', { type: 'button', class: 'su-ghost', disabled: Boolean(S.token), onclick: makeToken }, S.token ? 'Token made' : 'Make a token'))),
        h('div', { class: 'su-terminal' },
          h('div', { class: 'su-terminal-head', role: 'tablist', 'aria-label': 'Where it runs' },
            tab('claude', 'Claude Code'), tab('json', 'Any MCP client'), h('span', { class: 'grow' }),
            S.token ? copyButton(() => snippet) : null),
          h('pre', {}, snippet),
          h('div', { class: 'hint su-say' }, S.token ? 'The token is in the command, and shown this once: munin keeps only a hash.' : 'Make a token and it fills into the command.')),
        foot('agent', 'ready', 'Finish', h('button', { type: 'button', class: 'su-ghost', onclick: () => go('ready') }, 'Not now'))),
      aside: [
        h('div', { class: 'label' }, 'Who works here'),
        h('div', { class: 'su-who-list' },
          own ? h('div', { class: 'su-who-row' }, figbot({ colour: own.colour, size: 24, state: 'idle', seed: own.name }), h('span', {}, own.name), h('span', { class: 'role-tag own-tag' }, 'Own'), h('span', { class: 'su-st' }, 'idle')) : null,
          S.token ? h('div', { class: 'su-who-row' },
            isClaude(S.outside) ? claudeMark({ size: 24 }) : figbot({ colour: 'white', size: 24, state: S.connected ? 'idle' : 'paused', seed: S.outside }), h('span', {}, S.outside),
            h('span', { class: 'su-st' }, S.connected ? 'connected · just now' : [h('span', { class: 'su-pulse' }), 'waiting for it to connect'])) : null),
        h('p', { class: 'hint' }, S.token ? `This ticks over by itself once ${S.outside} first calls munin. Outside agents are white Figbots, and Claude gets its spark.` : 'Outside agents show up here once they have a token.'),
        h('div', { class: 'label su-aside-gap' }, 'Then, in Claude Code'),
        h('div', { class: 'su-cmd' }, '/mcp__munin__continue ', h('span', { class: 'muted' }, '<project key>')),
        h('p', { class: 'hint' }, 'Point it at a project, and it reads the brief and takes the top of the pile.'),
      ],
    };
  },

  ready() {
    const agent = S.created ? runtimeAgent(S.created) : null;
    const chosen = agent && modelOf(agent.provider, agent.model);
    const provider = openrouter();
    const items = [
      ['You', S.name.trim() || '—', Boolean(S.name.trim())],
      ['Models', keyed() ? ['OpenRouter', provider.key?.hint ? h('span', { class: 'mono muted' }, ` …${provider.key.hint}`) : null] : 'Stand-in for now', keyed()],
      ['Agent', agent ? [figbot({ colour: agent.colour, size: 18, state: 'idle', seed: agent.name }), `${agent.name}, ${roleOf(agent.role).name.toLowerCase()}`] : 'Later, under Agents', Boolean(agent)],
      ['MCP', S.token ? `${S.outside}, ${S.connected ? 'connected' : 'connecting'}` : 'Later, in Settings', Boolean(S.token)],
    ];
    const first = h('textarea', { rows: 2, placeholder: agent ? `Message ${agent.name}…` : '', dataset: { keep: 'su:first' }, 'aria-label': agent ? `Message ${agent.name}` : null }, 'Hello! What can you do?');
    const send = async () => {
      const text = first.value.trim();
      if (!text) return first.focus();
      try {
        await runtime.send(agent.name, text);
        close(`#/agents/${encodeURIComponent(agent.name)}`);
      } catch (err) {
        toast(err.message, { error: true });
      }
    };
    first.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        send();
      }
    });
    const twinkles = [['left:22px;top:44px', '.1s'], ['left:48px;top:8px', '.9s', 's'], ['right:30px;top:22px', '.5s'], ['right:8px;top:92px', '1.4s', 's'], ['left:6px;top:118px', '1.9s', 's'], ['right:54px;top:0', '1.2s', 's']];
    return {
      main: h('div', { class: 'su-ready su-screen' },
        agent
          ? [
            h('div', { class: 'su-hero', 'aria-hidden': 'true' },
              twinkles.map(([at, delay, small]) => h('span', { class: ['su-tw', small && 's'], style: `${at};animation-delay:${delay}` })),
              h('span', { class: 'su-hop', id: 'su-happy' })),
            h('h1', { class: 'su-awake' }, `${agent.name} is awake.`),
            h('p', { class: 'su-lead' }, `${chosen && agent.provider !== 'standin' ? `It runs on ${chosen.name}` : "It's on the stand-in until there's a model"}${roleOf(agent.role).abilities.code && S.about.sandbox ? ', in a container of its own' : ''}. Give it something to do.`),
            h('div', { class: 'su-composer' },
              first,
              h('div', { class: 'su-bar' },
                h('button', { type: 'button', class: 'su-chip', onclick: () => { first.value = `Hi ${agent.name}! Tell me about yourself.`; first.focus(); } }, 'Say hi'),
                h('button', { type: 'button', class: 'su-go', dataset: { primary: '' }, onclick: send }, `Send to ${agent.name}`, h('kbd', {}, `${MOD}↵`)))),
          ]
          : [h('h1', { class: 'su-awake' }, 'munin is set up.'), h('p', { class: 'su-lead' }, 'Make an agent whenever you like, under Agents.')],
        h('div', { class: 'su-after' },
          agent
            ? h('button', { type: 'button', class: 'label', onclick: () => close(`#/agents/${encodeURIComponent(agent.name)}`) }, `Go to ${agent.name}`)
            : h('button', { type: 'button', class: 'label', dataset: { primary: '' }, onclick: () => close('#/agents') }, 'Go to Agents'),
          h('button', { type: 'button', class: 'label', onclick: () => close('#/inbox') }, 'Open the tracker')),
        h('div', { class: 'su-summary' }, items.map(([k, v, ok]) => h('div', {}, h('span', { class: 'label' }, dot(!ok), k), h('span', { class: 'su-val' }, v))))),
      after() {
        if (agent) layer.querySelector('#su-happy')?.append(figbot({ colour: agent.colour, state: 'finished', size: 160, seed: agent.name, label: `${agent.name}, happy` }));
      },
    };
  },
};

const runtimeAgent = (name) => S.agents.find((a) => a.name === name) || { name, colour: S.colour, role: S.role, provider: S.provider, model: S.model };

// Steps' work -----------------------------------------------------------------------------

async function saveName() {
  const name = S.name.trim();
  if (name !== (S.about.name === 'me' ? '' : S.about.name)) {
    try {
      S.about = await runtime.updateMe({ name });
      store.human = S.about.name !== 'me' ? S.about.name : null;
    } catch (err) {
      return toast(err.message, { error: true });
    }
  }
  go('models');
}

function keyStatus() {
  return {
    empty: [],
    checking: [h('span', { class: 'su-spin' }), h('span', {}, 'Asking OpenRouter…')],
    bad: [dot(true), h('span', {}, S.keyError)],
  }[S.keyState] || [];
}

// The runtime asks OpenRouter whether it takes the key, and keeps it if it does.
async function checkKey() {
  const key = S.key.trim();
  if (!key) {
    S.keyState = 'empty';
    return layer.querySelector('#su-key-status')?.replaceChildren(...keyStatus());
  }
  S.keyState = 'checking';
  layer.querySelector('#su-key-status')?.replaceChildren(...keyStatus());
  try {
    await runtime.setKey('openrouter', key);
    if (S?.key.trim() !== key) return;
    const [providers, catalog] = await Promise.all([runtime.providers(), runtime.models()]);
    Object.assign(S, { providers, catalog, key: '', keyState: 'empty', changingKey: false });
    S.model = null;
    pickDefaultModel();
    render();
    loadRecommended();
  } catch (err) {
    if (S?.key.trim() !== key) return;
    Object.assign(S, { keyState: 'bad', keyError: err.message });
    layer.querySelector('#su-key-status')?.replaceChildren(...keyStatus());
  }
}

async function loadRecommended() {
  try {
    S.recommended = await runtime.recommendedModels();
    if (S.step === 'models') render();
  } catch {
    // the key works; the list can wait for the next visit
  }
}

// What setup suggests, a few cheap and a few frontier; clicking one makes it a favourite, or not.
function recommendations() {
  if (!S.recommended) return h('div', { class: 'su-status' }, h('span', { class: 'su-spin' }), h('span', {}, 'Finding models…'));
  let i = 0;
  return h('section', { class: 'su-recs', 'aria-label': 'Recommended models' },
    h('div', { class: 'su-recs-top' }, h('span', { class: 'label' }, 'Recommended'), h('span', { class: 'hint' }, 'Dollars per million tokens, in / out')),
    h('div', { class: 'su-rec-groups' }, TIERS.map(([tier, title, what]) => h('div', { class: 'su-rec-group' },
      h('div', { class: 'su-rec-head' }, h('span', { class: 'label' }, title), h('span', { class: 'hint' }, what)),
      (S.recommended[tier] || []).map((m) => {
        const on = favourites().includes(m.id);
        return h('button', {
          type: 'button', class: ['su-rec', on && 'on'], 'aria-pressed': String(on), 'aria-label': `Favourite ${m.name}, ${price(m)}`,
          style: `--i: ${i++}`, dataset: { keep: `su:fav:${m.id}` }, onclick: (e) => toggleFavourite(m.id, e.currentTarget),
        }, h('span', { class: 'su-rec-name' }, h('b', {}, m.name), h('span', { class: 'su-two' }, h('span', {}, m.maker), h('span', { class: 'su-pr' }, price(m)))), FAV());
      })))),
    h('p', { class: 'hint' }, 'Click a model to make it a favourite. Agents pick from your favourites, and everything else on OpenRouter is a search away.'));
}

async function toggleFavourite(id, button) {
  const before = favourites();
  const next = before.includes(id) ? before.filter((x) => x !== id) : [...before, id];
  button.classList.toggle('on', next.includes(id));
  button.setAttribute('aria-pressed', String(next.includes(id)));
  try {
    S.catalog = await runtime.setFavourites(next);
    pickDefaultModel();
  } catch (err) {
    button.classList.toggle('on', before.includes(id));
    button.setAttribute('aria-pressed', String(before.includes(id)));
    toast(err.message, { error: true });
  }
}

// Wakes the agent up, the first time; after that, changes to it are saved.
async function wakeAgent() {
  const role = roleOf(S.role);
  const fields = { role: S.role, colour: S.colour, provider: S.provider, model: S.model, brief: role.brief(agentName(), S.name.trim() || null) };
  try {
    if (S.created) {
      await runtime.updateAgent(S.created, fields);
    } else {
      const agent = await runtime.createAgent({ name: S.agent.trim().toLowerCase(), ...fields });
      S.created = agent.name;
      S.agent = agent.name;
      remember(MADE, agent.name);
      // A coder or reviewer gets a tracker token of its own; the agent exists either way.
      if (role.abilities.tracker && linkable()) await connectToTracker(agent.name, []).catch((err) => toast(`${agent.name} isn't in the tracker yet: ${err.message}`, { error: true }));
    }
    S.agents = await runtime.agents();
  } catch (err) {
    return toast(err.message, { error: true });
  }
  go('mcp');
}

async function makeToken() {
  const name = S.outside.trim();
  if (!name) return layer.querySelector('#su-outside')?.focus();
  try {
    const existing = (await api.agents()).find((a) => a.name === name && !a.revoked);
    if (existing && !confirm(`${name} already has a token. Replace it? The old one stops working.`)) return;
    S.token = (await api.addAgent(name)).token;
    S.connected = false;
    render();
    watchConnection();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

// The tracker doesn't announce an agent's first call, so look every few seconds while this waits.
function watchConnection() {
  clearInterval(poll);
  poll = setInterval(async () => {
    if (!S || S.step !== 'mcp') return clearInterval(poll);
    const agent = (await api.agents().catch(() => [])).find((a) => a.name === S.outside.trim() && !a.revoked);
    if (agent?.last_seen_at) {
      S.connected = true;
      clearInterval(poll);
      render();
    }
  }, 3000);
}

// Enter does the step's primary action, except where Enter means something already.
function onKey(e) {
  if (e.key !== 'Enter' || e.isComposing || e.defaultPrevented) return;
  const t = e.target;
  if (t.tagName === 'TEXTAREA' || t.closest('.mp') || (t.tagName === 'BUTTON' && t.dataset.primary === undefined) || t.tagName === 'A') return;
  const primary = layer.querySelector('.su-main [data-primary]');
  if (primary) {
    e.preventDefault();
    primary.click();
  }
}

