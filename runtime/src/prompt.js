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

// Abilities an agent can have that munin can't give it yet, said the way the prompt says them.
// MUN-6 (apps) and MUN-8 (the web) take theirs off this list.
const NOT_YET = {
  apps: (owner) => `${owner} calendar, mail and other apps aren't connected to munin yet`,
  web: () => "you can't search or read the web yet",
  images: () => "you can't make pictures yet",
};
const capital = (text) => text[0].toUpperCase() + text.slice(1);
const article = (word) => `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;

// The section that opens the prompt. `name` is what the agent calls you, or null while munin
// has no name for you.
export function identity(agent, name) {
  const you = name || 'the person you work for';
  const missing = Object.entries(NOT_YET).filter(([ability]) => agent.abilities?.[ability]).map(([, says]) => says(name ? `${name}'s` : 'their'));
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
    '',
    [
      missing.length ? `${capital(missing.join('; '))}. Only mention that when you're asked for something that needs them, and then help with what you're given.` : null,
      `${name || 'They'} may be away for hours. When you need a decision, use ask_human. When you learn something about ${you} that will still be true next week, use remember.`,
    ].filter(Boolean).join(' '),
  ].join('\n');
}

// What the agent remembers about you, as plain statements, after the identity.
export function about(agent, name) {
  const notes = agent.memory || [];
  return notes.length ? [`What you know about ${name || 'the person you work for'}:`, ...notes.map((n) => `- ${n.text}`)].join('\n') : undefined;
}
