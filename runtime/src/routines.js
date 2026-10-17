// Routines: work an agent does on its own, on a schedule, when something happens in the
// tracker, or on mail and the calendar (googlewatch.js, through Gmail and Google Calendar). A
// routine that's due becomes an input in the agent's conversation, queued behind whatever it's
// doing, and shows there as "ran routine".

import { parseSchedule, describeSchedule, nextRun, ScheduleError } from './schedule.js';
import { parseWatch, describeWatch, readFeed, matches, WatchError } from './watch.js';
import { parseMail, describeMail, parseCalendar, describeCalendar, watchMail, watchCalendar, WatchError as GoogleWatchError, POLL_MS as GOOGLE_POLL_MS } from './googlewatch.js';

export const TRIGGERS = ['schedule', 'tracker', 'mail', 'calendar'];
// A run missed while the runtime was down still happens if it's this recent.
const CATCH_UP_MS = 15 * 60 * 1000;
export const POLL_MS = 30 * 1000;

export class RoutineError extends Error {}

// A routine from what you typed, with "when" in munin's words so you see what it understood.
export function prepareRoutine({ name, trigger = 'schedule', when = '', does = '' }, agent, now) {
  const clean = { name: String(name || '').trim(), trigger, when: String(when || '').trim(), does: String(does || '').trim() };
  if (!clean.name) throw new RoutineError('A routine needs a name.');
  if (clean.name.length > 80) throw new RoutineError('Keep the name under 80 characters.');
  if (!TRIGGERS.includes(trigger)) throw new RoutineError(`A routine starts on ${TRIGGERS.join(', ')}.`);
  if (!clean.does) throw new RoutineError(`Say what ${agent.name} should do.`);
  try {
    if (trigger === 'schedule') {
      const schedule = parseSchedule(clean.when);
      return { ...clean, when: describeSchedule(schedule), schedule, next: nextRun(schedule, new Date(now))?.getTime() ?? null };
    }
    if (trigger === 'tracker') {
      const watch = parseWatch(clean.when, agent.name);
      return { ...clean, when: describeWatch(watch), watch, next: null };
    }
    if (trigger === 'mail') {
      const mail = parseMail(clean.when || 'When new mail arrives');
      return { ...clean, when: describeMail(mail), mail, next: null };
    }
    const calendar = parseCalendar(clean.when || 'Before each meeting');
    return { ...clean, when: describeCalendar(calendar), calendar, next: null };
  } catch (err) {
    if (err instanceof ScheduleError || err instanceof WatchError || err instanceof GoogleWatchError) throw new RoutineError(err.message);
    throw err;
  }
}

// Why a routine isn't running, if it isn't. `has` says whether the agent has Gmail and Google
// Calendar working.
export function routineNote(routine, agent, has = {}) {
  if (routine.trigger === 'mail' && !routine.mail) return 'Edit it to set it up again.';
  if (routine.trigger === 'calendar' && !routine.calendar) return 'Edit it to set it up again.';
  if (routine.trigger === 'mail' && !has.mail) return `Starts once ${agent.name} has Gmail: sign in with Google in Settings, then pick Gmail on its profile.`;
  if (routine.trigger === 'calendar' && !has.calendar) return `Starts once ${agent.name} has Google Calendar: sign in with Google in Settings, then pick it on its profile.`;
  if (routine.trigger === 'mail' || routine.trigger === 'calendar') return null;
  if (routine.trigger === 'tracker' && !(agent.abilities.tracker && agent.tracker?.token)) return `Starts once ${agent.name} is in the tracker.`;
  if (!routine.schedule && !routine.watch) return 'Edit it to set it up again.';
  return null;
}

// `agents()` lists agents; `run(agent, routine, reason)` starts a routine; `feed(agent, args)`
// calls the tracker's `events` tool as the agent, and `issue(agent, ref)` its `get_issue`;
// `google(agent, 'mail' | 'calendar')` is its Gmail or Calendar to watch, or null;
// `save()` keeps what changed. `tick()` does whatever is due at `now()`.
export function createScheduler({ agents, run, feed, issue, google = () => null, save, now }) {
  const polled = new Map(); // agent name → when its feed was last read
  const looked = new Map(); // agent name → when its mail and calendar were last looked at

  async function mailAndCalendar(agent, t) {
    if (!agent.routines.some((r) => r.mail || r.calendar)) return false;
    if (t - (looked.get(agent.name) || 0) < GOOGLE_POLL_MS) return false;
    looked.set(agent.name, t);
    const start = (routine, why) => run(agent, routine, { why });
    let dirty = false;
    for (const [kind, watch] of [['mail', watchMail], ['calendar', watchCalendar]]) {
      try {
        dirty = (await watch(agent, google(agent, kind), start, t)) || dirty;
      } catch {
        // Google is away or refused; try again next look
      }
    }
    return dirty;
  }

  async function schedules(agent, t) {
    let dirty = false;
    for (const routine of agent.routines) {
      if (!routine.schedule) continue;
      if (routine.next == null) {
        routine.next = nextRun(routine.schedule, new Date(t))?.getTime() ?? null;
        dirty = true;
        continue;
      }
      if (routine.next > t) continue;
      const due = routine.next;
      routine.next = nextRun(routine.schedule, new Date(t))?.getTime() ?? null;
      dirty = true;
      if (t - due <= CATCH_UP_MS) await run(agent, routine, { why: `it's ${routine.when}` });
    }
    return dirty;
  }

  // Read what happened in the tracker since last time, and start the routines it matches.
  async function events(agent, t) {
    const watching = agent.routines.filter((r) => r.watch);
    if (!watching.length || !agent.abilities.tracker || !agent.tracker?.token) return false;
    if (t - (polled.get(agent.name) || 0) < POLL_MS) return false;
    polled.set(agent.name, t);
    if (agent.eventsAfter == null) {
      // The first look starts from now; what happened before isn't news.
      agent.eventsAfter = readFeed(await feed(agent, { limit: 1 })).next ?? 0;
      return true;
    }
    const hits = new Map(); // routine → events
    const owners = new Map(); // issue → assignee, looked up once a poll
    const ownerOf = async (ref) => {
      if (!owners.has(ref)) owners.set(ref, /Assignee: (\S+)/.exec(await issue(agent, ref))?.[1] ?? null);
      return owners.get(ref);
    };
    let after = agent.eventsAfter;
    for (let page = 0; page < 10; page++) {
      const found = readFeed(await feed(agent, { after, limit: 100 }));
      for (const event of found.events) {
        for (const routine of watching) {
          if (!matches(routine.watch, event, agent.name)) continue;
          if (routine.watch.assignee && await ownerOf(event.ref) !== routine.watch.assignee) continue;
          hits.set(routine, [...(hits.get(routine) || []), event]);
        }
      }
      after = found.next ?? after;
      if (!found.more) break;
    }
    const moved = after !== agent.eventsAfter;
    agent.eventsAfter = after;
    for (const [routine, found] of hits) {
      const refs = [...new Set(found.map((e) => e.ref))];
      await run(agent, routine, {
        why: `in the tracker:\n${found.slice(-10).map((e) => e.line).join('\n')}`,
        issue: refs.length === 1 ? { id: refs[0], title: null } : null,
      });
    }
    return moved || hits.size > 0;
  }

  let ticking = null;
  async function tick() {
    if (ticking) return ticking;
    ticking = (async () => {
      const t = now();
      let dirty = false;
      for (const agent of [...agents()]) {
        dirty = (await schedules(agent, t)) || dirty;
        dirty = (await mailAndCalendar(agent, t)) || dirty;
        try {
          dirty = (await events(agent, t)) || dirty;
        } catch {
          // the tracker is away or refused; try again next poll
        }
      }
      if (dirty) await save();
    })();
    try {
      await ticking;
    } finally {
      ticking = null;
    }
  }

  // How long until something might be due, for the timer.
  function wait() {
    const t = now();
    let soonest = POLL_MS;
    for (const agent of agents()) for (const r of agent.routines) if (r.next != null) soonest = Math.min(soonest, r.next - t);
    return Math.max(1000, soonest);
  }

  return { tick, wait };
}
