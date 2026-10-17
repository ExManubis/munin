// The Meetings part: figbots talking with each other in turns, with you in the room (the runtime's
// meetings, docs/runtime-api.md). Its sidebar lists the meetings, open ones first; #/meetings opens
// the newest on a wide screen and lists them on a phone; #/meetings/new makes one; and a room shows
// the transcript live, who's speaking, and whether the figbots wait for you.

import { runtime } from '../runtime/index.js';
import { store } from '../store.js';
import { h, topbar, avatar, bindDraft, drafts, toast, onEnterSend, onModEnter, kbd, MOD, SEND_KEY, toggle } from '../ui.js';
import { markdown } from '../markdown.js';
import { figbot } from '../figbot.js';
import { agentFace, clock, hhmm } from './agents.js';

const wide = () => matchMedia('(min-width: 721px)').matches;
const human = () => store.human || (store.me.name && store.me.name !== 'me' ? store.me.name : 'You');
const roomHref = (meeting) => `#/meetings/${encodeURIComponent(meeting.id)}`;
const figbotOf = (name) => store.runtimeAgents.find((a) => a.name === name) || { name, colour: 'white' };
const face = (name, size = 18, state = 'idle') => agentFace(figbotOf(name), size, { animate: state !== 'idle', state });
const figbotsIn = (meeting) => meeting.participants.filter((p) => p.name).map((p) => p.name);
const youreIn = (meeting) => meeting.participants.some((p) => p.human);

// Open first, then by last word.
export function sortedMeetings() {
  const at = (m) => m.last?.at || m.createdAt;
  return [...store.meetings].sort((a, b) => (a.status === 'closed') - (b.status === 'closed') || at(b).localeCompare(at(a)));
}

// What the room is doing, in a few words.
function stateWords(meeting) {
  if (meeting.status === 'closed') return 'Closed';
  if (meeting.needsYou) return `${meeting.needsYou.from} calls you in`;
  if (meeting.state === 'talking') return meeting.speaking ? `${meeting.speaking} is speaking…` : 'Talking…';
  return youreIn(meeting) ? 'Waiting for you' : 'Quiet';
}

function faces(meeting, size = 18) {
  const names = figbotsIn(meeting);
  return h('span', { class: 'meeting-faces' }, names.slice(0, 3).map((name) => face(name, size)),
    names.length > 3 ? h('span', { class: 'mono muted' }, `+${names.length - 3}`) : null);
}

function meetingRow(meeting, { selected = false } = {}) {
  const last = meeting.last;
  const who = last && (last.from === null ? 'You' : last.from);
  const line = meeting.state === 'talking' || meeting.needsYou || !last ? stateWords(meeting) : last.pass ? `${who} passed` : `${who}: ${last.text || ''}`;
  return h('a', {
    class: ['agent-item', 'meeting-item', selected && 'selected', meeting.status === 'closed' && 'paused'],
    href: roomHref(meeting),
    'aria-current': selected ? 'page' : null,
  },
  faces(meeting),
  h('span', { class: 'agent-item-main' },
    h('span', { class: 'agent-item-head' },
      h('span', { class: 'agent-item-name meeting-title' }, meeting.title),
      h('span', { class: 'grow' }),
      h('span', { class: 'agent-item-time' }, meeting.state === 'talking' ? 'now' : clock(last?.at || meeting.createdAt))),
    h('span', { class: 'agent-item-line' },
      h('span', { class: ['agent-item-preview', meeting.state === 'talking' && 'typing'] }, line),
      meeting.needsYou ? h('span', { class: 'chip row-chip' }, 'Calls you') : null)));
}

export function meetingsSidebar(route) {
  const meetings = sortedMeetings();
  return [
    h('div', { class: 'agents-head' }, h('span', { class: 'label' }, 'Meetings'), h('span', { class: 'mono muted' }, meetings.length)),
    h('nav', { class: 'agent-list', 'aria-label': 'Meetings' },
      meetings.map((m) => meetingRow(m, { selected: route.params.id === m.id }))),
    h('div', { class: 'grow' }),
    h('a', { class: ['btn', 'new-agent', route.path === '/meetings/new' && 'pressed'], href: '#/meetings/new' },
      'New meeting', h('span', { class: 'key' }, 'N')),
  ];
}

export const indexView = {
  title: () => 'Meetings',

  async load() {
    const meetings = sortedMeetings();
    if (wide() && meetings.length) location.replace(roomHref(meetings[0]));
    return { meetings: meetings.map((m) => m.id + m.state + (m.last?.at || '')) };
  },

  render() {
    const meetings = sortedMeetings();
    return h('div', { class: 'page agents-index' },
      topbar([h('span', { class: 'title' }, 'Meetings')]),
      meetings.length
        ? h('nav', { class: 'agent-list phone-list', 'aria-label': 'Meetings' }, meetings.map((m) => meetingRow(m)))
        : h('div', { class: 'empty-state' },
          h('span', { class: 'meeting-faces big' }, ['white', 'ember', 'sky'].map((colour, i) => figbot({ colour, size: 48, state: i === 1 ? 'curious' : 'idle', seed: colour }))),
          h('h2', {}, 'No meetings yet'),
          h('p', {}, store.runtimeAgents.length > 1
            ? 'Put a few figbots in a room with a question. They take turns, pass when they have nothing to add, and call you in when it needs your say.'
            : 'A meeting needs figbots to talk. Make one or two first, then put them in a room.'),
          h('a', { class: 'btn primary', href: store.runtimeAgents.length ? '#/meetings/new' : '#/agents/new' },
            store.runtimeAgents.length ? 'New meeting' : 'New figbot', h('span', { class: 'key' }, 'N'))));
  },
};

// New meeting ------------------------------------------------------------------------------

const form = { title: '', picked: new Set(), you: true, first: '' };

export const newView = {
  title: () => 'New meeting',
  scope: () => '/meetings/new',

  async load() {
    return { figbots: store.runtimeAgents.map((a) => a.name) };
  },

  render(_data, ctx) {
    const figbots = store.runtimeAgents;
    const ready = form.title.trim() && form.picked.size;
    const pick = (name) => () => {
      if (form.picked.has(name)) form.picked.delete(name);
      else form.picked.add(name);
      ctx.rerender();
    };
    return h('div', { class: 'page' },
      topbar([
        h('a', { class: 'back phone-only', href: '#/meetings', 'aria-label': 'All meetings' }, '‹'),
        h('span', { class: 'title' }, 'New meeting'),
      ]),
      h('div', { class: 'profile new-agent new-meeting' },
        h('h1', { class: 'h1 wide-only' }, 'New meeting'),
        h('p', { class: 'lead' }, 'Figbots take turns, pass when they have nothing to add, and settle when nobody does. Your word starts them again.'),
        h('section', { class: 'profile-section' },
          h('h2', { class: 'section-title' }, 'What about'),
          onModEnter(h('input', {
            class: 'input name-input', value: form.title, placeholder: 'Plan the offsite', autocomplete: 'off', 'aria-label': 'Title',
            dataset: { keep: 'new-meeting:title' },
            oninput: (e) => {
              form.title = e.target.value;
              ctx.rerender();
            },
          }), () => create(ctx))),
        h('section', { class: 'profile-section' },
          h('h2', { class: 'section-title' }, 'Who'),
          figbots.length
            ? h('div', { class: 'meeting-pick' }, figbots.map((a) => h('button', {
              type: 'button', class: ['pick-figbot', form.picked.has(a.name) && 'on'], 'aria-pressed': String(form.picked.has(a.name)), onclick: pick(a.name),
            }, agentFace(a, 24, { animate: false, state: form.picked.has(a.name) ? 'finished' : 'idle' }), h('span', {}, a.name), h('span', { class: 'role-tag' }, a.roleName || a.role))))
            : h('p', { class: 'hint' }, 'No figbots yet. ', h('a', { class: 'link', href: '#/agents/new' }, 'Make one')),
          h('div', { class: 'setting' },
            h('div', { class: 'setting-main' }, h('div', {}, `${human() === 'You' ? 'You' : human()} too`), h('div', { class: 'hint' }, 'In the room, so figbots can call you in. Without you, they talk among themselves.')),
            toggle(form.you, 'You in the meeting', () => {
              form.you = !form.you;
              ctx.rerender();
            }))),
        h('section', { class: 'profile-section' },
          h('h2', { class: 'section-title' }, 'Open with'),
          h('p', { class: 'hint section-lead-hint' }, 'Optional. Name a figbot with @ to ask it first; without, everyone gets a turn.'),
          onModEnter(h('textarea', {
            class: 'textarea brief-box meeting-first', value: form.first, placeholder: 'What should we do for the offsite? @hugin, you know the budget.', 'aria-label': 'First message',
            dataset: { keep: 'new-meeting:first' },
            oninput: (e) => { form.first = e.target.value; },
          }), () => create(ctx))),
        h('div', { class: 'create-row' },
          h('button', { type: 'button', class: 'btn primary', disabled: !ready, onclick: () => create(ctx) },
            'Start the meeting', h('span', { class: 'key' }, `${MOD}↵`)),
          h('span', { class: 'hint' }, ready ? `${form.picked.size} figbot${form.picked.size === 1 ? '' : 's'}${form.you ? ' and you' : ''}.` : 'A title and at least one figbot.'))));
  },
};

async function create() {
  if (!form.title.trim() || !form.picked.size) return;
  try {
    const meeting = await runtime.createMeeting({
      title: form.title.trim(),
      participants: [...form.picked, ...(form.you ? [null] : [])],
      first: form.first.trim() || undefined,
    });
    Object.assign(form, { title: '', picked: new Set(), you: true, first: '' });
    location.hash = roomHref(meeting);
  } catch (err) {
    toast(err.message, { error: true });
  }
}

// The room ---------------------------------------------------------------------------------

export const roomView = {
  title: (data) => data.meeting.title,
  scope: (params) => `/meetings/${params.id}`,

  async load({ id }) {
    return { meeting: await runtime.meeting(id) };
  },

  render({ meeting }, ctx) {
    return h('div', { class: 'convo-wrap' },
      h('section', { class: 'convo meeting-room' },
        topbar([
          h('a', { class: 'back phone-only', href: '#/meetings', 'aria-label': 'All meetings' }, '‹'),
          h('span', { class: 'title' }, meeting.title),
          h('span', { class: ['mono', 'muted', 'meeting-state', meeting.state === 'talking' && 'live'] }, stateWords(meeting)),
        ], [
          faces(meeting),
          meeting.status === 'open' ? h('button', { type: 'button', class: 'link', onclick: () => close(meeting, ctx) }, 'Close') : null,
        ], 'convo-head'),
        meeting.needsYou && meeting.status === 'open' ? h('div', { class: 'calls-you' },
          face(meeting.needsYou.from, 18, 'asks'),
          h('span', {}, h('strong', {}, `${meeting.needsYou.from} calls you in`), ' · your word starts the room again.')) : null,
        h('div', { class: 'thread-scroll', dataset: { scroll: `meeting-${meeting.id}`, stick: '' } },
          h('div', { class: 'thread-items' },
            transcript(meeting),
            meeting.state === 'talking' && meeting.speaking
              ? h('div', { class: 'writing' }, face(meeting.speaking, 18, 'working'), h('span', {}, `${meeting.speaking} is thinking…`))
              : null,
            meeting.status === 'open' && meeting.state !== 'talking' && meeting.speeches.length
              ? h('div', { class: 'action-line meeting-settled' }, h('span', { class: 'action-text' }, settledWords(meeting)))
              : null)),
        composer(meeting, ctx)));
  },
};

function settledWords(meeting) {
  if (meeting.state === 'bounded') return youreIn(meeting) ? 'They went round three times. Over to you.' : 'They went round three times.';
  return youreIn(meeting) ? 'Nobody has more to say. Over to you.' : 'Nobody has more to say.';
}

function transcript(meeting) {
  if (!meeting.speeches.length) return h('p', { class: 'hint pad' }, meeting.status === 'open' ? 'Nobody has said anything yet.' : 'Nothing was said.');
  return meeting.speeches.map((s, i) => {
    const prev = meeting.speeches[i - 1];
    if (s.pass) return h('div', { class: 'action-line' }, h('span', { class: 'action-text' }, `${s.from} passed`));
    const mine = s.from === null;
    const sameAuthor = prev && !prev.pass && prev.from === s.from && new Date(s.at) - new Date(prev.at) < 5 * 60 * 1000;
    return h('div', { class: ['msg', sameAuthor && 'cont', mentions(s.text) && 'mentions-you'] },
      sameAuthor ? null : h('div', { class: 'msg-head' },
        mine ? avatar(human(), { kind: 'human' }) : face(s.from),
        h('span', { class: 'author' }, mine ? human() : s.from),
        h('span', { class: 'mono muted' }, hhmm(s.at))),
      markdown(s.text, 'msg-body'));
  });
}

// Whether a figbot's speech calls you in.
const mentions = (text) => /(^|[^\w@])@(you|user)\b/i.test(text || '') || (store.human && new RegExp(`(^|[^\\w@])@${store.human.split(/\s+/)[0]}\\b`, 'i').test(text || ''));

function composer(meeting, ctx) {
  if (meeting.status !== 'open') {
    return h('footer', { class: 'composer' }, h('div', { class: 'composer-box disabled' }, h('span', { class: 'muted' }, 'This meeting is closed. Its transcript stays here.')));
  }
  if (!youreIn(meeting)) {
    return h('footer', { class: 'composer' }, h('div', { class: 'composer-box disabled' }, h('span', { class: 'muted' }, "You're not in this meeting: the figbots talk among themselves.")));
  }
  const key = `meeting:${meeting.id}`;
  const box = bindDraft(h('textarea', { class: 'composer-input', rows: 1, placeholder: 'Say something to the room…', 'aria-label': 'Say something to the room' }), key);
  const send = async () => {
    const text = box.value.trim();
    if (!text) return box.focus();
    try {
      await runtime.speakInMeeting(meeting.id, text);
      drafts.delete(key);
      box.value = '';
    } catch (err) {
      toast(err.message, { error: true });
    }
    ctx.reload();
  };
  onEnterSend(box, send);
  // @name chips: ask one figbot first. Without one, everyone gets a turn.
  const mention = (name) => () => {
    const at = `@${name} `;
    if (!box.value.includes(`@${name}`)) box.value = box.value ? `${box.value.replace(/\s*$/, ' ')}${at}` : at;
    drafts.set(key, box.value);
    box.focus();
  };
  return h('footer', { class: 'composer' },
    h('div', { class: 'composer-box' },
      box,
      h('button', { type: 'button', class: 'send', onclick: send, 'aria-label': 'Send' }, h('span', { class: 'wide-only' }, kbd(SEND_KEY)), h('span', { class: 'phone-only send-up' }, '↑'))),
    h('p', { class: 'hint mention-row' },
      figbotsIn(meeting).map((name) => h('button', { type: 'button', class: 'chip mention-chip', onclick: mention(name), title: `Ask ${name} first` }, `@${name}`)),
      h('span', {}, meeting.state === 'talking' ? 'Your word starts a new round from what you say.' : '@ someone to ask them first; otherwise everyone gets a turn.')));
}

async function close(meeting, ctx) {
  if (!confirm(`Close "${meeting.title}"? The figbots stop, and the transcript stays.`)) return;
  try {
    await runtime.closeMeeting(meeting.id);
  } catch (err) {
    toast(err.message, { error: true });
  }
  ctx.reload();
}
