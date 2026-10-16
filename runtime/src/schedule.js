// Routine schedules, from what you'd write: "Weekdays 07:30", "Mondays at 9", "Every night
// 02:00", "Every 2 hours, 08–18", "Every 30 minutes on weekdays". Anything else is refused
// with examples rather than guessed at. Times are the runtime's local time (its TZ).

export class ScheduleError extends Error {}

const EXAMPLES = "Try 'Weekdays 07:30', 'Mondays at 9', 'Every night 02:00' or 'Every 2 hours, 08–18'.";
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PLURAL = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const DAY_WORDS = {
  sun: 0, sunday: 0, sundays: 0, mon: 1, monday: 1, mondays: 1, tue: 2, tues: 2, tuesday: 2, tuesdays: 2,
  wed: 3, wednesday: 3, wednesdays: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, thursdays: 4,
  fri: 5, friday: 5, fridays: 5, sat: 6, saturday: 6, saturdays: 6,
};
const ALL = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKENDS = [0, 6];
// Words that only make a schedule read well.
const FILLER = new Set(['every', 'each', 'at', 'on', 'and', 'the', 'day', 'days', 'daily', 'night', 'nights', 'nightly', 'morning', 'mornings', 'evening', 'evenings', 'afternoon', 'afternoons', 'in']);

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

// "7", "07:30", "7.30pm", "7am", "noon", "midnight" → minutes after midnight.
function timeOf(token) {
  if (token === 'noon') return 12 * 60;
  if (token === 'midnight') return 0;
  const m = /^(\d{1,2})(?:[:.](\d{2}))?(am|pm)?$/.exec(token);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] || 0);
  if (m[3]) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (m[3] === 'pm' ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function dayRange(a, b) {
  const out = [];
  for (let d = a; ; d = (d + 1) % 7) {
    out.push(d);
    if (d === b) return out;
  }
}

// A schedule is { days, times } (minutes after midnight) or { days, every, from, to }.
export function parseSchedule(text) {
  let s = ` ${String(text || '').toLowerCase()} `
    .replace(/[–—]/g, '-')
    .replace(/(\d)\s*(am|pm)\b/g, '$1$2')
    .replace(/,/g, ' ');
  const fail = (why) => {
    throw new ScheduleError(`${why} ${EXAMPLES}`);
  };

  // How often, for repeating schedules.
  let every = null;
  s = s.replace(/\bevery\s+(\d+)\s*(minutes?|mins?|m|hours?|hrs?|h)\b/, (_, n, unit) => {
    every = Number(n) * (unit.startsWith('h') ? 60 : 1);
    return ' ';
  }).replace(/\b(hourly|every hour)\b/, () => {
    every = 60;
    return ' ';
  }).replace(/\bevery half hour\b/, () => {
    every = 30;
    return ' ';
  }).replace(/\bevery quarter hour\b/, () => {
    every = 15;
    return ' ';
  });
  if (every !== null && (every < 5 || every > 24 * 60)) fail('Repeat every 5 minutes at the most often, and once a day at the least.');

  // Between which times, for repeating schedules: "08-18", "from 9am to 5pm", "between 8 and 18".
  let window = null;
  const T = '(\\d{1,2}(?:[:.]\\d{2})?(?:am|pm)?|noon|midnight)';
  const takeWindow = (whole, a, b) => {
    const from = timeOf(a);
    const to = timeOf(b);
    if (from === null || to === null) return whole;
    window = { from, to: to === 0 ? 24 * 60 - 1 : to };
    return ' ';
  };
  s = s.replace(new RegExp(`\\bbetween\\s+${T}\\s+and\\s+${T}(?![\\w:.])`), takeWindow)
    .replace(new RegExp(`(?:\\bfrom\\s+)?(?<![\\w:.])${T}\\s*(?:-|\\bto\\b|\\buntil\\b|\\btill\\b)\\s*${T}(?![\\w:.])`), takeWindow);

  // Which days.
  let days = null;
  const addDays = (list) => {
    days = [...new Set([...(days || []), ...list])];
  };
  s = s.replace(/\b(weekdays?|workdays?)\b/g, () => {
    addDays(WEEKDAYS);
    return ' ';
  }).replace(/\bweekends?\b/g, () => {
    addDays(WEEKENDS);
    return ' ';
  }).replace(/\b([a-z]+)\s*(?:-|to|through|until)\s*([a-z]+)\b/g, (whole, a, b) => {
    if (!(a in DAY_WORDS) || !(b in DAY_WORDS)) return whole;
    addDays(dayRange(DAY_WORDS[a], DAY_WORDS[b]));
    return ' ';
  });

  const times = [];
  for (const word of s.split(/\s+/).filter(Boolean)) {
    if (word in DAY_WORDS) addDays([DAY_WORDS[word]]);
    else if (timeOf(word) !== null) times.push(timeOf(word));
    else if (!FILLER.has(word)) fail(`munin doesn't know "${word}" in a schedule.`);
  }
  days = (days || ALL).sort((a, b) => a - b);

  if (every !== null) {
    if (times.length > 1) fail('A repeating schedule takes one window, like 08–18.');
    const from = window?.from ?? times[0] ?? 0;
    const to = window?.to ?? 24 * 60 - 1;
    if (to <= from) fail('The window has to end after it starts.');
    return { days, every, from, to };
  }
  if (window) fail('A window like 08–18 goes with a repeat, like "Every 2 hours, 08–18".');
  if (!times.length) fail('Say what time.');
  return { days, times: [...new Set(times)].sort((a, b) => a - b) };
}

function daysText(days) {
  if (days.length === 7) return null;
  if (days.join() === WEEKDAYS.join()) return 'weekdays';
  if (days.join() === WEEKENDS.join()) return 'weekends';
  // Monday first, the way a week reads.
  const ordered = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  return ordered.length === 1 ? PLURAL[ordered[0]] : ordered.map((d) => SHORT[d]).join(', ');
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// The schedule in munin's words, so you see what it understood: "Weekdays 07:30".
export function describeSchedule(schedule) {
  const days = daysText(schedule.days);
  if (schedule.times) return `${days ? cap(days) : 'Every day'} ${schedule.times.map(hhmm).join(', ')}`;
  const often = schedule.every === 60 ? 'Every hour'
    : schedule.every % 60 === 0 ? `Every ${schedule.every / 60} hours` : `Every ${schedule.every} minutes`;
  const whole = schedule.from === 0 && schedule.to === 24 * 60 - 1;
  return `${often}${days ? ` on ${days}` : ''}${whole ? '' : `, ${hhmm(schedule.from)}–${hhmm(schedule.to)}`}`;
}

// The first run strictly after `after` (a Date), in local time.
export function nextRun(schedule, after) {
  for (let offset = 0; offset <= 8; offset++) {
    const day = new Date(after.getFullYear(), after.getMonth(), after.getDate() + offset);
    if (!schedule.days.includes(day.getDay())) continue;
    const at = (minutes) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minutes / 60), minutes % 60);
    if (schedule.times) {
      for (const minutes of schedule.times) if (at(minutes) > after) return at(minutes);
    } else {
      for (let minutes = schedule.from; minutes <= schedule.to; minutes += schedule.every) if (at(minutes) > after) return at(minutes);
    }
  }
  return null;
}
