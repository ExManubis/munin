// Meetings: figbots talking with each other in turns, with you able to join (MUN-41). A meeting
// is a list of participants (agents, plus you) and a transcript of short speeches. Meetings live
// in a session doc of their own (munin.meetings), so they survive restarts, and who has been
// asked to speak (`asked`) is kept with them. Creating a meeting, and every speech of yours,
// starts a discussion (as Hermes Agent's group chats do): up to ROUNDS rounds in which each figbot
// with something new to hear speaks once, with speak_in_meeting, in its session for the meeting.
// Whoever starts rotates each round, and nobody speaks twice in a row. A round where nobody says
// anything settles the discussion; ROUNDS rounds or SPEECHES figbot speeches bound it. Then the
// meeting waits for you. A turn the agent ends without the tool still counts: what it said is its
// speech, and nothing is a pass (as is SILENCE).

export const SILENCE = 'NO_REPLY';
export const ROUNDS = 3; // rounds a discussion goes at most
export const SPEECHES = 10; // figbot speeches a discussion has at most
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

// Who a round asks, in order: the figbots still here, starting one further along each round, and
// never the one that spoke last first. The human is in participants as null: they speak when they
// like, and munin never asks them for a turn.
export function roundOf(meeting, agents, round) {
  const names = meeting.participants.filter((name) => name && agents.has(name));
  if (!names.length) return [];
  const shift = round % names.length;
  const order = [...names.slice(shift), ...names.slice(0, shift)];
  const last = meeting.speeches.at(-1)?.from;
  if (order.length > 1 && order[0] === last) order.push(order.shift());
  return order;
}

// Whether a figbot has something to answer: it hasn't had a turn yet, or someone else has said
// something since its last one. One that hasn't is skipped, so a lone figbot doesn't answer itself.
export const hasNews = (meeting, name) => meeting.seen?.[name] === undefined
  || meeting.speeches.slice(meeting.seen[name]).some((s) => s.from !== name);

// A new discussion, from now: everyone gets a first round.
export function discussion(meeting, agents) {
  return { round: 0, queue: roundOf(meeting, agents, 0), spoke: false, speeches: 0 };
}

// What a discussion does next: ask a figbot (`ask`), or stop and say why (`settled` when a round
// went silent, `bounded` at the caps). Moves the discussion along as it decides; `skip(name)` says
// whether a figbot can't take a turn now (gone, or nothing new for it).
export function nextTurn(talk, meeting, agents, skip) {
  for (;;) {
    if (talk.speeches >= SPEECHES) return { stop: 'bounded' };
    const name = talk.queue.shift();
    if (name === undefined) {
      if (!talk.spoke) return { stop: 'settled' };
      if (talk.round + 1 >= ROUNDS) return { stop: 'bounded' };
      Object.assign(talk, { round: talk.round + 1, spoke: false, queue: roundOf(meeting, agents, talk.round + 1) });
      continue;
    }
    if (!skip(name)) return { ask: name };
  }
}

// Which meeting and which turn a turn input is for, from its text (turnText's first line), or null.
const TURN = /^You're in a munin meeting called .* \(meeting ([\w-]+), turn (\d+)\)/;
export function meetingOfTurn(text) {
  const m = TURN.exec(String(text || ''));
  return m ? { id: m[1], turn: Number(m[2]) } : null;
}

// A meeting as the frontend sees it. `agentFor` maps a participant name to its settings, for
// each speaker's colour and role.
export function meetingOut(meeting, agentFor) {
  const participants = meeting.participants.map((name) => (name ? agentFor(name) : { name: null, human: true }));
  return {
    id: meeting.id, title: meeting.title, status: meeting.status,
    // talking: figbots are taking turns; settled: a round went by with nothing new; bounded: it
    // reached its rounds or speeches. The last two wait for you.
    state: meeting.status === 'closed' ? 'closed' : meeting.talk || meeting.asked ? 'talking' : meeting.waiting || 'settled',
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