// Routines that start when something happens in the tracker: "When an issue moves to In
// review", "When vera moves my issue to Todo", "When an issue in MUN is created", "When
// someone comments on my issue". The runtime reads the tracker's event feed with the agent's
// own token and matches its lines here, without asking a model. Anything else is refused
// with examples rather than guessed at.

export class WatchError extends Error {}

const EXAMPLES = "Try 'When an issue moves to In review', 'When vera moves my issue to Todo', 'When an issue in MUN is created' or 'When someone comments on my issue'.";
const STATUS_WORDS = { todo: 'Todo', in_progress: 'In progress', in_review: 'In review', done: 'Done', cancelled: 'Cancelled' };
const STATUS = '(to ?do|in progress|in review|review|done|cancell?ed)';
const statusOf = (word) => ({ todo: 'todo', 'to do': 'todo', 'in progress': 'in_progress', 'in review': 'in_review', review: 'in_review', done: 'done', cancelled: 'cancelled', canceled: 'cancelled' })[word];
// Words that can start "When … moves" without naming anyone.
const NOBODY = new Set(['an', 'a', 'the', 'any', 'anyone', 'someone', 'somebody', 'anybody', 'another', 'other', 'issue', 'issues', 'something', 'anything', 'work', 'it', 'one', 'my', 'new', 'human', 'agent']);
const VERBS = '(moves|moved|sends|sent|takes|took|picks|comments|commented|answers|answered|replies|files|filed|creates|created|asks|asked|requests|merges|merged|finishes|finished|starts|marks|cancels|reviews|opens|adds)';

// A watch is { event: status | created | comment | question | any, to?, from?, by?, assignee?, project? }.
export function parseWatch(text, agentName) {
  const original = String(text || '').trim();
  const fail = (why) => {
    throw new WatchError(`${why} ${EXAMPLES}`);
  };
  const watch = {};
  let s = ` ${original} `;

  s = s.replace(/\bin ([A-Z][A-Z0-9]{0,9})\b/, (_, key) => {
    watch.project = key;
    return ' ';
  });
  s = s.toLowerCase();
  if (/\b(my|mine)\b|\bassigned to me\b/.test(s)) watch.assignee = agentName;
  const owner = /\b([a-z][\w.-]*)'s\b/.exec(s) || /\bassigned to ([a-z][\w.-]*)\b/.exec(s);
  if (owner && owner[1] !== 'me') watch.assignee = owner[1];
  const by = new RegExp(`^\\s*when\\s+([a-z][\\w.-]*)\\s+${VERBS}\\b`).exec(s) || /\bby ([a-z][\w.-]*)\b/.exec(s);
  if (by && !NOBODY.has(by[1])) watch.by = by[1];

  let m;
  if (/\b(anything|something)\s+(happens|changes)\b/.test(s)) watch.event = 'any';
  else if (/\b(asks|asked)\b|\bquestion\b/.test(s)) watch.event = 'question';
  else if (/\b(comments?|commented|answers|answered|replies|replied)\b/.test(s)) watch.event = 'comment';
  else if (/\b(sends?|sent)\b.*\bback\b|\brequests? changes\b|\bbounces?\b/.test(s)) Object.assign(watch, { event: 'status', from: 'in_review', to: 'todo' });
  else if ((m = new RegExp(`\\bfrom ${STATUS} to ${STATUS}\\b`).exec(s))) Object.assign(watch, { event: 'status', from: statusOf(m[1]), to: statusOf(m[2]) });
  else if ((m = new RegExp(`\\b(?:moves?|moved|goes|gone|lands?|set|is)\\b.*?\\b(?:to|in|into) ${STATUS}\\b`).exec(s))) Object.assign(watch, { event: 'status', to: statusOf(m[1]) });
  else if (/\b(needs|waiting for|ready for|sent to|goes to) review\b/.test(s)) Object.assign(watch, { event: 'status', to: 'in_review' });
  else if (/\b(takes|took|is taken|picks up|picked up|starts)\b/.test(s)) Object.assign(watch, { event: 'status', to: 'in_progress' });
  else if (/\b(merges|merged|finishes|finished|is done|completes|completed)\b/.test(s)) Object.assign(watch, { event: 'status', to: 'done' });
  else if (/\b(creates|created|files|filed|adds|added|opens|opened)\b|\bnew issue\b/.test(s)) watch.event = 'created';
  else fail(`munin doesn't know what to watch for in "${original}".`);
  if (watch.event === 'status' && !watch.to) fail('Say which status, like "moves to In review".');
  return watch;
}

// The watch in munin's words, so you see what it understood.
export function describeWatch(w) {
  const where = w.project ? ` in ${w.project}` : '';
  const whose = w.assignee ? `${w.assignee}'s issue` : 'an issue';
  switch (w.event) {
    case 'any': return `When anything happens${where || ' in the tracker'}`;
    case 'created': return w.by ? `When ${w.by} files an issue${where}` : `When an issue${where} is created`;
    case 'comment': return `When ${w.by || 'someone'} comments on ${whose}${where}`;
    case 'question': return `When ${w.by || 'an agent'} asks the human about ${whose}${where}`;
    default: {
      const move = `${w.from ? `from ${STATUS_WORDS[w.from]} ` : ''}to ${STATUS_WORDS[w.to]}`;
      return w.by ? `When ${w.by} moves ${whose}${where} ${move}` : `When ${whose}${where} moves ${move}`;
    }
  }
}

// One line of the tracker's `events` tool: "#412 2026-10-16 14:02 UTC  MUN-5  vera moved it
// from in_review to todo".
export function parseEventLine(line) {
  const m = /^#(\d+) \S+ \S+ UTC\s+(\S+)\s+(.*)$/.exec(String(line).trim());
  if (!m) return null;
  const event = { id: Number(m[1]), ref: m[2], project: m[2].split('-')[0], line: String(line).trim() };
  const text = m[3];
  let x;
  if ((x = /^(\S+) created it$/.exec(text))) return { ...event, kind: 'created', actor: x[1] };
  if ((x = /^(\S+) moved it from (\S+) to (\S+)$/.exec(text))) return { ...event, kind: 'status', actor: x[1], from: x[2], to: x[3] };
  if ((x = /^(\S+) took it$/.exec(text))) return { ...event, kind: 'status', actor: x[1], from: null, to: 'in_progress' };
  if ((x = /^(\S+) asked the human: /.exec(text))) return { ...event, kind: 'question', actor: x[1] };
  if ((x = /^(\S+) commented: /.exec(text))) return { ...event, kind: 'comment', actor: x[1] };
  return { ...event, kind: 'other', actor: text.split(' ')[0] };
}

// The `events` tool's answer: its events, and the id to ask after next time.
export function readFeed(text) {
  const lines = String(text || '').split('\n');
  const events = lines.map(parseEventLine).filter(Boolean);
  const next = /(?:Next time|More): events\(after=(\d+)\)/.exec(text);
  const nothing = /Nothing new after event (\d+)/.exec(text);
  return { events, next: next ? Number(next[1]) : nothing ? Number(nothing[1]) : events.at(-1)?.id ?? null, more: /^More: /m.test(text) };
}

// Whether an event starts the routine, before checking whose issue it is. An agent's own
// doing never starts its routines unless the routine names it.
export function matches(watch, event, agentName) {
  if (event.actor === agentName && watch.by !== agentName) return false;
  if (watch.project && event.project !== watch.project) return false;
  if (watch.by && event.actor !== watch.by) return false;
  switch (watch.event) {
    case 'any': return true;
    case 'created': return event.kind === 'created';
    case 'comment': return event.kind === 'comment' || event.kind === 'question';
    case 'question': return event.kind === 'question';
    default: return event.kind === 'status' && event.to === watch.to && (!watch.from || event.from === watch.from);
  }
}
