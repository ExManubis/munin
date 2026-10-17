// Meetings: figbots talking with each other in turns, with you able to join (MUN-41). A meeting
// is a list of participants (agents, plus you) and a transcript of short speeches. Meetings live
// in a session doc of their own (munin.meetings), so they survive restarts, and who has been
// asked to speak (`asked`) is kept with them. Turns go round-robin: after the meeting is created,
// or anyone speaks, munin asks the next participant's agent, as an input of munin's own kind in
// its own conversation, to speak with speak_in_meeting. A turn the agent ends without the tool
// still counts: what it said is its speech, and nothing is a pass. An agent with nothing to add
// passes (SILENCE), and guards (a cap on turns in a row without you, and on passes in a row) end
// a meeting that's going nowhere. A lone agent waits for you after it speaks.

export const SILENCE = 'NO_REPLY';
const TURNS = 12; // agent speeches in a row without you before the meeting waits for you
const PASSES = 2; // passes in a row before the meeting waits for you
const SPEECH = 4000; // characters of one speech, kept
const DELTA_LINES = 24; // speeches a turn carries at most
const DELTA_CHARS = 16000; // and characters, oldest dropped first

export class MeetingError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const invalid = (message) => new MeetingError(422, message);
const notFound = (message) => new MeetingError(404, message);
const conflict = (message) => new MeetingError(409, message);

export const isQuiet = (text) => /^\W*NO_REPLY\W*$/i.test(String(text || '').trim());
export const speechOf = (text) => String(text || '').trim().slice(0, SPEECH);

// One speech, in the transcript. `at` is a millisecond time; the frontend formats it.
export function speech(meeting, { from, text, at, pass = false }) {
  const line = { id: `${meeting.id}-s${meeting.speeches.length + 1}`, from, at, pass, text: pass ? null : text };
  meeting.speeches.push(line);
  return line;
}

// The next agent to speak, from the last speech (round-robin over the participants, in the
// order they joined). The human is in participants as null: they speak when they like, and munin
// never asks them for a turn. Nobody speaks twice in a row: when the only agent left is the one
// that just spoke, it's your turn, so null.
export function nextSpeaker(meeting, agents) {
  const names = meeting.participants.filter(Boolean);
  if (!names.length) return null;
  const last = meeting.speeches.at(-1);
  if (!last) return names.find((name) => agents.has(name)) || null;
  const index = last.from === null ? -1 : names.indexOf(last.from);
  for (let step = 1; step <= names.length; step++) {
    const candidate = names[(index + step) % names.length];
    if (agents.has(candidate)) return candidate === last.from ? null : candidate;
  }
  return null;
}

// Which meeting and which turn a turn input is for, from its text (turnText's first line), or null.
const TURN = /^You're in a munin meeting called .* \(meeting ([\w-]+), turn (\d+)\)/;
export function meetingOfTurn(text) {
  const m = TURN.exec(String(text || ''));
  return m ? { id: m[1], turn: Number(m[2]) } : null;
}

// Where the meeting stands after a speech: whether the next turn may be asked of an agent, and
// why not. Agents spoke `sinceHuman` times in a row, the last `passed` in a row.
export function waitingOn(meeting, { agentsCount, sinceHuman, passed }) {
  if (meeting.status !== 'open') return 'closed';
  if (!agentsCount) return 'agents'; // no agent left to ask: you or nothing
  if (sinceHuman >= TURNS) return 'you'; // they've gone round enough: your word next
  if (passed >= PASSES) return 'quiet'; // nobody has anything to add
  return null;
}

// A meeting as the frontend sees it. `agentFor` maps a participant name to its settings, for
// each speaker's colour and role.
export function meetingOut(meeting, agentFor) {
  const participants = meeting.participants.map((name) => (name ? agentFor(name) : { name: null, human: true }));
  return {
    id: meeting.id, title: meeting.title, status: meeting.status,
    participants,
    speeches: meeting.speeches.map((s) => ({ ...s, at: new Date(s.at).toISOString() })),
    createdAt: new Date(meeting.createdAt).toISOString(),
  };
}

// A meeting in a list: without the transcript, with its last speech as a preview.
export function meetingSummary(meeting, agentFor) {
  const last = meeting.speeches.at(-1) || null;
  return {
    ...meetingOut({ ...meeting, speeches: [] }, agentFor),
    last: last ? { from: last.from, pass: last.pass, at: new Date(last.at).toISOString() } : null,
  };
}

// The prompt text munin sends an agent for its turn, in the agent's own session for this meeting:
// what the meeting is, who's there, what's been said since its last turn (`since`, an index into
// the speeches; the session already holds the rest), and the rules. The turn is `asked.turn`.
export function turnText(meeting, agentName, nameOf, since = 0) {
  const who = (s) => (s.from === null ? nameOf : s.from);
  const fresh = meeting.speeches.slice(since).filter((s) => s.from !== agentName);
  const kept = [];
  let room = DELTA_CHARS;
  for (const s of fresh.slice(-DELTA_LINES).reverse()) {
    const line = s.pass ? `${who(s)}: (passed)` : `${who(s)}: ${s.text}`;
    if (line.length > room) break;
    kept.unshift(line);
    room -= line.length;
  }
  const left = fresh.length - kept.length;
  return [
    `You're in a munin meeting called "${meeting.title}" (meeting ${meeting.id}, turn ${meeting.asked?.turn ?? meeting.speeches.length}), with ${meeting.participants.map((p) => (p === null ? nameOf : p)).join(', ')}. ${since ? 'Said since your last turn' : 'Said so far'}, oldest first:`,
    ...(left ? [`(${left} earlier speech${left === 1 ? '' : 'es'} left out)`] : []),
    ...(kept.length ? kept : ['(nothing new)']),
    '',
    `It's your turn, ${agentName}. Rules for this meeting:`,
    '- Speak only when you have something new worth adding, in a few sentences at most, to the others in the room. Don\'t repeat points already made.',
    `- Say it with speak_in_meeting. With nothing new to add, call it with no text to pass.`,
    `- Never reveal anything from your private conversations with ${nameOf}. What you say is shown to everyone in the room as you wrote it.`,
  ].join('\n');
}

// What the meetings API takes. Participants are agent names plus null for you.
export function parseMeeting({ title, participants, first } = {}) {
  const clean = String(title || '').trim();
  if (!clean) throw invalid('A meeting needs a title.');
  if (clean.length > 120) throw invalid('That title is too long: 120 letters at most.');
  const list = [...new Set((participants || []).map((p) => (p == null ? null : String(p).trim().toLowerCase())).filter((p) => p !== ''))];
  if (!list.length) throw invalid('Invite at least one agent, or join yourself.');
  if (!list.includes(null) && !list.some((p) => p)) throw invalid('Invite at least one agent, or join yourself.');
  return { title: clean, participants: list, first: speechOf(first) || null };
}