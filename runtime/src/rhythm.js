// An agent's own rhythm, beyond what you ask and its routines: a heartbeat, when it may speak up
// without being asked, and a journal at the end of each day it worked.
//
// The heartbeat is OpenClaw's: every so often munin checks in, and the agent says something only
// when it's worth saying, answering NO_REPLY otherwise, which munin keeps out of the
// conversation and off your phone. How willing it is to speak is its proactivity: off, when it
// matters, or chatty (Inner Thoughts' threshold, as a setting). The journal is Generative
// Agents' reflection, once a day: the agent writes what it did, learned and what's still open,
// and keeps what will still be true next week with its own memory and skill tools, so it never
// rewrites its memory as a block.

export const PROACTIVITY = ['off', 'matters', 'chatty'];
// A companion is chatty, an assistant speaks up when something's about to be missed, and the
// rest only when asked: a coder that's blocked asks you anyway.
export const proactivityFor = (role) => ({ companion: 'chatty', assistant: 'matters' }[role] || 'off');

const HOUR = 60 * 60 * 1000;
export const HEARTBEAT_MS = 2 * HOUR; // between heartbeats, and the quiet before one
export const AWAKE = [8, 21]; // the hours heartbeats happen in, in the runtime's time zone
export const JOURNAL_HOUR = 21; // the journal is written after this hour
export const JOURNAL_QUIET_MS = 30 * 60 * 1000; // and once the conversation has been quiet this long
export const NO_REPLY = 'NO_REPLY';

// A reply that says nothing: NO_REPLY, perhaps with punctuation around it.
export const isQuiet = (text) => /^\W*NO_REPLY\W*$/.test(String(text || '').trim());

// The local day of a moment, like 2026-10-17.
export function dayOf(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Whether it's time for a heartbeat. `lastAt` is the conversation's last item, `lastHumanAt` your
// last message, `rhythm` what the agent keeps: { heartbeat, spoke, journal }. A heartbeat comes
// after a quiet spell, counted from the agent's making when it has said nothing yet, and an agent
// that spoke up unasked waits for your answer before it does again.
export function heartbeatDue(agent, { now, lastAt = null, lastHumanAt = null }) {
  if (agent.paused || !agent.proactivity || agent.proactivity === 'off') return false;
  const hour = new Date(now).getHours();
  if (hour < AWAKE[0] || hour >= AWAKE[1]) return false;
  const rhythm = agent.rhythm || {};
  if (now - (rhythm.heartbeat || 0) < HEARTBEAT_MS) return false;
  if (now - (lastAt ?? agent.createdAt ?? 0) < HEARTBEAT_MS) return false;
  if (rhythm.spoke && !(lastHumanAt > rhythm.spoke)) return false;
  return true;
}

// Whether it's time for the day's journal: late enough, a day it worked, quiet for a while (so it
// doesn't cut into a conversation), and not written yet.
export function journalDue(agent, { now, workedToday, lastAt = null }) {
  if (agent.paused || !workedToday || !lastAt || now - lastAt < JOURNAL_QUIET_MS) return false;
  return new Date(now).getHours() >= JOURNAL_HOUR && agent.rhythm?.journal !== dayOf(now);
}

const when = (now) => new Date(now).toLocaleString('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit' });

export function heartbeatText(agent, who, now) {
  const start = `munin checking in: it's ${when(now)}, and nobody has asked you anything.`;
  if (agent.proactivity === 'chatty') {
    return `${start} If you have something worth sharing with ${who} (something you noticed, a thought, a question, a riddle, a strange fact), say it briefly, in your own voice. If not, reply with exactly ${NO_REPLY} and nothing else. Don't say you're checking in.`;
  }
  return `${start} Look at what you can see (your routines, your apps, your issues, what you were last asked) for anything ${who} needs to know soon or is about to forget. If there's something, say it in a sentence or two. If not, reply with exactly ${NO_REPLY} and nothing else; that's the usual answer. Don't say you're checking in.`;
}

// Written to the person as "you": told it was for them and for itself, Haiku wrote about them in
// the third person and guessed their pronoun.
export function journalText(who) {
  return `End of the day. Write today's entry in your journal, which ${who} reads on your profile, so write it to them as "you": what you did today, what you learned, and what's still open or bothering you about the work. Three or four plain sentences in your own voice, no headings or lists. First, if you learned something that will still be true next week, remember it or change a note; if you worked out how to do something you'll do again, save it as a skill. Then reply with just the entry, and leave out what you did or didn't save.`;
}
