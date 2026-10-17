// Routines that start on mail or the calendar, through Gmail and Google Calendar (googleapps.js).
// Gmail is asked about once a minute whether anything changed (its history id, which costs
// nothing); only then does each mail routine run its search and compare with what it saw
// before, and the agent wakes only for what's new. The calendar is looked at once a minute for
// what starts soon and for new invitations. The first look at anything only notes what's there:
// what was in the inbox before a routine existed isn't news.

export class WatchError extends Error {}

export const MAIL_EXAMPLES = "Try 'When new mail arrives', 'When mail from ann@example.com arrives', 'When mail about invoices arrives' or 'When mail matching is:important arrives'.";
export const CALENDAR_EXAMPLES = "Try 'Before each meeting', '15 minutes before each event' or 'When an invitation arrives'.";
export const POLL_MS = 60 * 1000;
const SEEN = 300; // thread and event ids a routine remembers having seen

// "When mail from ann@example.com arrives" → { query: 'from:ann@example.com' }.
export function parseMail(when) {
  const s = String(when || '').trim().replace(/[.!]+$/, '');
  const m = /^(?:when |whenever |if )?(?:new |any |a )?(?:mail|email|e-mail|an email|a mail)(?: (from|about|matching|with) (.+?))?(?: (?:arrives|comes in|comes|lands|is received))?$/i.exec(s);
  if (!m) throw new WatchError(`munin doesn't understand "${s}" for mail. ${MAIL_EXAMPLES}`);
  const [, how, what] = m;
  if (!how) return { query: '' };
  const words = what.trim();
  if (!words) throw new WatchError(`Say who or what the mail is ${how}. ${MAIL_EXAMPLES}`);
  if (how.toLowerCase() === 'from') return { query: `from:${/\s/.test(words) ? `"${words}"` : words}`, from: words };
  if (how.toLowerCase() === 'about') return { query: `subject:(${words}) OR ${/\s/.test(words) ? `"${words}"` : words}`, about: words };
  return { query: words, matching: words };
}

export const describeMail = (watch) => (watch.from ? `When mail from ${watch.from} arrives`
  : watch.about ? `When mail about ${watch.about} arrives`
    : watch.matching ? `When mail matching ${watch.matching} arrives` : 'When new mail arrives');

// "15 minutes before each meeting" → { before: 15, meetings: true }; "When an invitation
// arrives" → { invitations: true }. A meeting has other people in it; an event is anything timed.
export function parseCalendar(when) {
  const s = String(when || '').trim().replace(/[.!]+$/, '').toLowerCase();
  if (/^(when |whenever )?(an |a |new )?(invitation|invite)s? (arrives?|comes in)$/.test(s)) return { invitations: true };
  const m = /^(?:(\d{1,3}) ?(?:minutes?|mins?|m)|(an?|one|1) hour|(\d) hours?)? ?before (?:each|every|a|the next|my) (meeting|event)s?$/.exec(s);
  if (!m) throw new WatchError(`munin doesn't understand "${when}" for the calendar. ${CALENDAR_EXAMPLES}`);
  const before = m[1] ? Number(m[1]) : m[2] ? 60 : m[3] ? Number(m[3]) * 60 : 10;
  if (before < 1 || before > 24 * 60) throw new WatchError('Between a minute and a day before.');
  return { before, meetings: m[4] === 'meeting' };
}

export function describeCalendar(watch) {
  if (watch.invitations) return 'When an invitation arrives';
  const lead = watch.before % 60 === 0 ? `${watch.before / 60} ${watch.before === 60 ? 'hour' : 'hours'}` : `${watch.before} minutes`;
  return `${lead} before each ${watch.meetings ? 'meeting' : 'event'}`;
}

const remember = (seen, ids) => [...new Set([...ids, ...(seen || [])])].slice(0, SEEN);

// One look for one agent: start the routines that something new matched. `google` is the
// agent's access (googleapps.js watch), or null when it doesn't have the app; `run(routine,
// why)` starts a routine. Returns whether anything to keep changed.
export async function watchMail(agent, google, run, t) {
  const routines = agent.routines.filter((r) => r.trigger === 'mail' && r.mail);
  if (!routines.length || !google) return false;
  const history = await google.historyId();
  if (history === agent.mailHistory && routines.every((r) => r.mailSeen)) return false; // nothing changed
  agent.mailHistory = history;
  for (const routine of routines) {
    const threads = await google.threads(`in:inbox newer_than:2d${routine.mail.query ? ` ${routine.mail.query}` : ''}`);
    const fresh = routine.mailSeen ? threads.filter((thread) => !routine.mailSeen.includes(thread.id)) : [];
    routine.mailSeen = remember(routine.mailSeen, threads.map((thread) => thread.id));
    if (fresh.length) await run(routine, `new mail arrived:\n${fresh.slice(0, 10).map((thread) => thread.line).join('\n')}`);
  }
  return true;
}

export async function watchCalendar(agent, google, run, t) {
  const routines = agent.routines.filter((r) => r.trigger === 'calendar' && r.calendar);
  if (!routines.length || !google) return false;
  let dirty = false;
  const soon = routines.filter((r) => r.calendar.before);
  if (soon.length) {
    const furthest = Math.max(...soon.map((r) => r.calendar.before));
    const { events, zone } = await google.events(new Date(t), new Date(t + (furthest + 2) * 60 * 1000));
    for (const routine of soon) {
      const due = events.filter((e) => e.start?.dateTime && (!routine.calendar.meetings || (e.attendees || []).length > 1)
        && Date.parse(e.start.dateTime) - t <= routine.calendar.before * 60 * 1000 && Date.parse(e.start.dateTime) > t
        && !(routine.calendarSeen || []).includes(`${e.id}@${e.start.dateTime}`));
      if (!due.length) continue;
      routine.calendarSeen = remember(routine.calendarSeen, due.map((e) => `${e.id}@${e.start.dateTime}`));
      dirty = true;
      const lines = due.map((e) => `${e.summary || '(no title)'} at ${google.time(e.start, zone)}, in ${Math.round((Date.parse(e.start.dateTime) - t) / 60000)} minutes (event ${e.id})${e.location ? `, ${e.location}` : ''}`);
      await run(routine, `${due.length === 1 ? 'this is coming up' : 'these are coming up'}:\n${lines.join('\n')}`);
    }
  }
  for (const routine of routines.filter((r) => r.calendar.invitations)) {
    const invitations = await google.invitations(new Date(t));
    const fresh = routine.calendarSeen ? invitations.filter((e) => !routine.calendarSeen.includes(e.id)) : [];
    routine.calendarSeen = remember(routine.calendarSeen, invitations.map((e) => e.id));
    dirty = true;
    if (fresh.length) await run(routine, `${fresh.length === 1 ? 'an invitation arrived' : 'invitations arrived'}:\n${fresh.slice(0, 10).map((e) => `${e.summary || '(no title)'} at ${google.time(e.start)} from ${e.organizer?.email || 'someone'} (event ${e.id})`).join('\n')}`);
  }
  return dirty;
}
