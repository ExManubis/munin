// What every agent of munin's is told first: who it is, who it's talking with, what no munin
// agent sounds like, and its own brief and examples, then what it can do, who else is on the
// team, and what it knows about you. Hermes Agent taught two things here: a voice works when
// it's written as behaviour rather than a list of traits, and an agent that's told where its
// messages come from starts doubting them, so the person it talks with is a plain fact. Character
// cards taught a third: a few lines of how an agent talks show its voice better than any
// description, so each agent has examples of its own.

import { ROLES, roleName } from './roles.js';
import { remembered } from './memory.js';

// What every munin agent leaves out. How it does sound is its own: its brief and its examples.
// Kept short on purpose, since a long shared voice makes every agent sound the same.
export const VOICE = [
  "How you talk: like someone who knows the person you're talking with, not like a help desk.",
  'Match your reply to the message: a quick question gets a quick answer, and a real problem gets the room it needs.',
  'Skip filler ("Great question", "I\'d be happy to"), don\'t repeat the question back, and don\'t sum up what you just said.',
  "When you're unsure, say so once, plainly. The rest of how you sound is your own, below.",
].join(' ');

const capital = (text) => text[0].toUpperCase() + text.slice(1);
const list = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const article = (word) => `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;

// The section that opens the prompt. `name` is what the agent calls you, or null while munin
// has no name for you. What the agent can do comes after, in capabilities().
export function identity(agent, name) {
  // "Mikkel's assistant" read as a third person again ("I'm tosk, his assistant"), so the
  // person is who you work for and who you're talking with, and is talked to as "you".
  const role = article(roleName(agent.role).toLowerCase());
  return [
    name
      ? `You're ${agent.name}, ${role}, and you work for ${name}. You're talking with ${name} right now, in munin, the app ${name} uses to work with agents. munin is private, so only ${name} can write to you here. Talk to ${name} as "you".`
      : `You're ${agent.name}, ${role}, and you work for the person you're talking with, in munin, the app they use to work with agents. munin is private, so only they can write to you here. You don't know their name yet: ask once, when it fits, and then leave it.`,
    '',
    VOICE,
    '',
    agent.brief,
    ...examples(agent, name),
  ].join('\n');
}

// The agent's examples, made-up exchanges that show how it sounds. They're written from your
// side, "You:" for you and the agent's name for it; in the prompt "you" is the agent, so your
// lines get your name and its lines become "You:". Lines under its own name taught it to start
// replies with its name ("pike: Good, thanks.").
function examples(agent, name) {
  const text = String(agent.examples || '').trim();
  if (!text) return [];
  const them = name || 'Them';
  const own = `${agent.name.toLowerCase()}:`;
  const lines = text.split('\n').map((line) => {
    if (line.startsWith('You:')) return `${them}:${line.slice(4)}`;
    if (line.toLowerCase().startsWith(own)) return `You:${line.slice(own.length)}`;
    return line;
  });
  return [
    '',
    // Agents told only that the examples are made up brought their content up as if it had
    // happened ("like the expired session no test touches") and retold their facts.
    `How you sound, in a few made-up exchanges with ${name || 'the person you work for ("Them")'}. They're there for your voice: they didn't happen, so don't bring up what's in them.`,
    ...lines,
  ];
}

// The abilities an agent can have, as the profile names them, and what each is for.
const ABILITIES = {
  web: ['the Web ability', 'search the web and read pages'],
  apps: ['the Apps ability', 'use apps like Gmail and Google Calendar'],
  code: ['the Code ability', 'work in a folder of your own with a shell and git'],
  tracker: ['the Tracker ability', "take, review and file issues in munin's tracker"],
  images: ['the Images ability', 'make pictures'],
};

// What munin can't do for any agent yet, and what to offer instead.
const NOT_IN_MUNIN = [
  'Make pictures.',
];

// What the agent can do right now, from its real setup, so it can say so when it's asked and
// knows what it could do if something were switched on. `setup` is what the runtime knows:
//   search: whether its model can search the web (OpenRouter);
//   apps: { mine: [{ name, answering, detail, does }], others: [{ name, detail }] } (apps.js);
//   tracker: { reachable, projects }, repos: project keys with code, routines: how many it has,
//   watches: { mail, calendar }, whether its Gmail and Google Calendar can start routines;
//   devices: how many devices get munin's notifications.
export function capabilities(agent, name, { search = false, apps = { mine: [], others: [] }, tracker = null, repos = [], routines = 0, watches = {}, devices = 0 } = {}) {
  const you = name || 'the person you work for';
  const has = (ability) => Boolean(agent.abilities?.[ability]);
  const can = [];
  can.push(`Talk things through with ${you}. When you need a decision, use ask_human; they may be away for hours. When you learn something that will still be true next week, use remember: about ${you}, about how the work is done here, or about how you work best. Each kind has room for a few notes. They're yours to keep in order: when one kind is full, make room yourself, without asking, by saying two notes in one with change_note or dropping one that matters less with forget_note.`);
  // What reaches a phone (push.js): questions and approvals from everyone, and what agents
  // that don't code say.
  const reaches = has('code') ? 'your questions and approvals reach' : 'what you say reaches';
  can.push(devices
    ? `Reaching ${you}: ${reaches} their phone too, as notifications, even with munin closed${has('code') ? '; the rest of what you say waits in munin' : ''}.`
    : `Reaching ${you}: what you say waits in munin until they look. Once they turn on notifications in munin's Settings, ${reaches} their phone too.`);
  can.push(`Routines: work you do on your own. When you're asked to do something regularly, like a morning brief, set it up with add_routine (and change_routine, remove_routine, list_routines). munin understands "when" like "Weekdays 07:30", "Mondays at 9", "Every night 02:00" or "Every 30 minutes, 08–18"${has('tracker') ? ', for the tracker "When an issue moves to In review"' : ''}${watches.mail ? ', for mail (trigger mail) "When new mail arrives" or "When mail from ann@example.com arrives"' : ''}${watches.calendar ? ', for the calendar (trigger calendar) "Before each meeting", "15 minutes before each event" or "When an invitation arrives"' : ''}. You have ${routines === 0 ? 'none yet' : routines === 1 ? 'one' : routines}.`);
  if (has('web')) {
    can.push(search
      ? 'The web: search it with web_search and read a page with read_page. Say where what you found came from.'
      : `The web: read a page with read_page. Searching needs a model on OpenRouter, which you aren't on, so ask for links.`);
  }
  if (has('apps')) {
    for (const app of apps.mine.filter((a) => a.answering)) can.push(`${app.name}${app.detail ? ` (${app.detail.replace(/^As /, 'as ')})` : ''}: ${app.does}.`);
  }
  can.push('Skills: how you do things here, from experience, listed below. Read one with read_skill when it fits, and save one with save_skill when you learn something you\'ll do again.');
  if (has('code')) can.push(`Code: a folder of your own with a shell, files and git${repos.length ? `; munin keeps the code of ${list(repos)}, and taking one of their issues gives you a worktree on its own branch` : ''}.`);
  if (has('tracker')) {
    can.push(tracker?.reachable
      ? `munin's tracker: take, review and file issues${tracker.projects?.length ? `, in ${list(tracker.projects)}` : ''}.`
      : "munin's tracker: you have it, but it can't be reached right now.");
  }

  // "Gmail: sending mail" → "sending mail (Gmail)"; "Pushing to git" → "pushing to git".
  const asks = (agent.askFirst || []).filter((rule) => rule.on).map((rule) => {
    const [, app, what] = /^([^:]+): (.+)$/.exec(rule.label) || [];
    const label = rule.label.replace(/\bits own\b/, 'your own'); // "Saving its own skills", from your side
    return app ? `${what} (${app})` : label[0].toLowerCase() + label.slice(1);
  });
  const could = [];
  for (const [ability, [title, does]] of Object.entries(ABILITIES)) {
    if (!has(ability) && ability !== 'images') could.push(`${does} (${you} can turn on ${title} on your profile)`);
  }
  if (has('apps')) {
    for (const app of apps.mine.filter((a) => !a.answering)) could.push(`use ${app.name}, which you have but which isn't working: ${app.detail}`);
    for (const app of apps.others) could.push(`use ${app.name} (${you} can pick it under Apps on your profile)`);
    if (!apps.mine.length && !apps.others.length) could.push(`use Gmail and Google Calendar (${you} signs in with Google in Settings, then picks them on your profile)`);
  }

  return [
    `What you can do. When you're asked what you can do, or whether you can do something, answer from this, in your own words and briefly. Don't offer what isn't here.`,
    ...can.map((line) => `- ${line}`),
    asks.length ? `These ask ${you} first, and munin tells you the answer: ${list(asks)}. Everything else you just do, so say so before you start something that asks.` : `Nothing you do asks ${you} first.`,
    ...(could.length ? ['What you could do, if it were switched on:', ...could.map((line) => `- ${capital(line)}.`)] : []),
    "What munin can't do yet, for any agent:",
    ...NOT_IN_MUNIN.map((line) => `- ${line}`),
  ].filter(Boolean).join('\n');
}

// What the agent remembers, as plain statements in its three kinds (memory.js): about you, about
// how the work is done, and about how it works best, each with how full it is.
export function about(agent, name) {
  return remembered(agent.memory || [], name || 'the person you work for');
}

// Who else is on the team: munin's other agents, what each does, and what each is on, so the
// agent can say whose job something is. Only what changes now and then, since a section that
// changes every turn is sent again every turn: whether an agent is paused, and the issue a coder
// last took, but not whether it's busy this minute.
export function team(others) {
  if (!others.length) return undefined;
  const line = (other) => {
    const issue = other.abilities?.code && !other.work?.detached ? other.work?.issue : null;
    return [
      `- ${other.name}, ${article(roleName(other.role).toLowerCase())}: ${ROLES[other.role]?.does || 'one of the team'}.`,
      issue ? ` Last took ${issue.id}${issue.title ? ` · ${issue.title}` : ''}.` : '',
      other.paused ? ' Paused.' : '',
    ].join('');
  };
  return [
    "Your team: munin's other agents. You don't message them; coders and reviewers work together in the tracker. When something is another agent's job, say so, and whose.",
    ...others.map(line),
  ].join('\n');
}
