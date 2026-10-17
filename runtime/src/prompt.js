// What every agent of munin's is told first: who it is, who it's talking with, how it talks,
// and its own brief, then what it knows about you. Hermes Agent taught two things here: a voice
// works when it's written as behaviour rather than a list of traits, and an agent that's told
// where its messages come from starts doubting them, so the person it talks with is a plain fact.

import { roleName } from './roles.js';

// How every munin agent talks. A brief adds the agent's own character on top.
export const VOICE = [
  "How you talk: like someone who knows the person you're talking with and likes working with them, not like a help desk.",
  'Match your reply to the message: a quick question gets a quick answer, and a real problem gets the room it needs.',
  'Skip filler ("Great question", "I\'d be happy to"), don\'t repeat the question back, and don\'t sum up what you just said.',
  "Have opinions and say them. When you're unsure, say so once, plainly, and carry on.",
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
  ].join('\n');
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
  "Reach a phone. What you say waits in munin until it's read.",
  'Wake you when new mail arrives. A routine on a schedule, like "Every 30 minutes, 08–18", does instead.',
  'Make pictures.',
];

// What the agent can do right now, from its real setup, so it can say so when it's asked and
// knows what it could do if something were switched on. `setup` is what the runtime knows:
//   search: whether its model can search the web (OpenRouter);
//   apps: { mine: [{ name, answering, detail, does }], others: [{ name, detail }] } (apps.js);
//   tracker: { reachable, projects }, repos: project keys with code, routines: how many it has.
export function capabilities(agent, name, { search = false, apps = { mine: [], others: [] }, tracker = null, repos = [], routines = 0 } = {}) {
  const you = name || 'the person you work for';
  const has = (ability) => Boolean(agent.abilities?.[ability]);
  const can = [];
  can.push(`Talk things through with ${you}. When you need a decision, use ask_human; they may be away for hours. When you learn something about ${you} that will still be true next week, use remember.`);
  can.push(`Routines: work you do on your own. When you're asked to do something regularly, like a morning brief, set it up with add_routine (and change_routine, remove_routine, list_routines). munin understands "when" like "Weekdays 07:30", "Mondays at 9", "Every night 02:00" or "Every 30 minutes, 08–18"${has('tracker') ? ', and for the tracker "When an issue moves to In review"' : ''}. You have ${routines === 0 ? 'none yet' : routines === 1 ? 'one' : routines}.`);
  if (has('web')) {
    can.push(search
      ? 'The web: search it with web_search and read a page with read_page. Say where what you found came from.'
      : `The web: read a page with read_page. Searching needs a model on OpenRouter, which you aren't on, so ask for links.`);
  }
  if (has('apps')) {
    for (const app of apps.mine.filter((a) => a.answering)) can.push(`${app.name}${app.detail ? ` (${app.detail.replace(/^As /, 'as ')})` : ''}: ${app.does}.`);
  }
  if (has('code')) can.push(`Code: a folder of your own with a shell, files and git${repos.length ? `; munin keeps the code of ${list(repos)}, and taking one of their issues gives you a worktree on its own branch` : ''}.`);
  if (has('tracker')) {
    can.push(tracker?.reachable
      ? `munin's tracker: take, review and file issues${tracker.projects?.length ? `, in ${list(tracker.projects)}` : ''}.`
      : "munin's tracker: you have it, but it can't be reached right now.");
  }

  // "Gmail: sending mail" → "sending mail (Gmail)"; "Pushing to git" → "pushing to git".
  const asks = (agent.askFirst || []).filter((rule) => rule.on).map((rule) => {
    const [, app, what] = /^([^:]+): (.+)$/.exec(rule.label) || [];
    return app ? `${what} (${app})` : rule.label[0].toLowerCase() + rule.label.slice(1);
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

// What the agent remembers about you, as plain statements, after the identity.
export function about(agent, name) {
  const notes = agent.memory || [];
  return notes.length ? [`What you know about ${name || 'the person you work for'}:`, ...notes.map((n) => `- ${n.text}`)].join('\n') : undefined;
}
