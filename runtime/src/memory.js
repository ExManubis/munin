// What an agent remembers, in three kinds: about you, about how the work is done, and about how
// it works best itself. Each kind has room for so many characters, and the agent sees how full
// each is. When one is full it makes room itself, by changing or forgetting notes one at a time,
// before it can add more. Hermes Agent caps its memory the same way and never compacts it for
// the agent; ACE found that letting a model rewrite a whole memory at once can collapse it, so
// notes change one by one and never as a block.

import { randomBytes } from 'node:crypto';

export const KINDS = {
  you: { cap: 1500, heading: (who) => `What you know about ${who}` },
  work: { cap: 1500, heading: () => 'How the work is done here' },
  self: { cap: 1000, heading: () => "What you've learned about how you work best" },
};
const LONGEST = 300; // one note, in characters

export class MemoryError extends Error {}

// A note's kind; notes from before kinds are about you.
export const kindOf = (note) => (KINDS[note.kind] ? note.kind : 'you');

// How full each kind is: { you: { used, cap }, … }.
export function room(notes) {
  const out = Object.fromEntries(Object.entries(KINDS).map(([kind, { cap }]) => [kind, { used: 0, cap }]));
  for (const note of notes) out[kindOf(note)].used += note.text.length;
  return out;
}

const clean = (text) => String(text || '').trim().replace(/\s+/g, ' ');
const newId = () => `m${randomBytes(3).toString('hex')}`;
const chars = (n) => n.toLocaleString('en');

function check(notes, kind, text, without = null) {
  if (!KINDS[kind]) throw new MemoryError(`A note is about you, work or self, not ${kind}.`);
  if (!text) throw new MemoryError('Say what to remember, in a sentence.');
  if (text.length > LONGEST) throw new MemoryError(`Keep a note under ${LONGEST} characters: one short sentence.`);
  const { used, cap } = room(notes.filter((n) => n.id !== without))[kind];
  if (used + text.length > cap) {
    // Told only how to make room, Haiku asked the person which note to drop: they're its own.
    throw new MemoryError(`Your ${kind} notes are full (${chars(used)} of ${chars(cap)} characters, and this needs ${chars(text.length)}). They're your own notes, so make room yourself, without asking: change_note to say two notes in one or say one shorter, or forget_note on one that matters less. Then remember this again.`);
  }
}

// The notes with a new one first. Throws MemoryError when it doesn't fit.
export function addNote(notes, { kind = 'you', text }) {
  const note = { id: newId(), kind, text: clean(text) };
  check(notes, kind, note.text);
  return { notes: [note, ...notes], note };
}

// The notes with one changed in place: its text, its kind, or both.
export function changeNote(notes, id, { text, kind }) {
  const old = notes.find((n) => n.id === id);
  if (!old) throw new MemoryError(`There's no note ${id}.`);
  const note = { ...old, kind: kind ?? kindOf(old), text: text === undefined ? old.text : clean(text) };
  check(notes, note.kind, note.text, id);
  return { notes: notes.map((n) => (n.id === id ? note : n)), note, old };
}

export function forgetNote(notes, id) {
  const old = notes.find((n) => n.id === id);
  if (!old) throw new MemoryError(`There's no note ${id}.`);
  return { notes: notes.filter((n) => n.id !== id), old };
}

// What the agent remembers, for its prompt: each kind it has notes of, with how full it is and
// each note's id, so it can change or forget one.
export function remembered(notes, who) {
  const full = room(notes);
  const parts = [];
  for (const [kind, { heading }] of Object.entries(KINDS)) {
    const mine = notes.filter((n) => kindOf(n) === kind);
    if (!mine.length) continue;
    parts.push([`${heading(who)} (${chars(full[kind].used)} of ${chars(full[kind].cap)} characters):`, ...mine.map((n) => `- ${n.text} [${n.id}]`)].join('\n'));
  }
  return parts.length ? parts.join('\n\n') : undefined;
}
