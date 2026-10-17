// Gmail and Google Calendar as apps that come with munin, on Google's regular APIs, with the
// Google sign-in (google.js) for their token. Each tool says whether it only reads
// (annotations.readOnlyHint) and, if it changes something, what kind of change (`ask`), so the
// app's ask-first rules (apps.js) cover the rest. Gmail has one rule per kind: sending and the
// bin ask you first, organising (labels, archive, read) doesn't. Calendar asks before any change.

export const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const CALENDAR = 'https://www.googleapis.com/calendar/v3';
const MAX_THREADS = 10;
const MAX_BODY = 8000;
const MAX_TEXT = 20000;
const MAX_BATCH = 50;
// Labels Gmail keeps for itself that an agent can't set by name: the bin and spam have their
// own way in (trash_threads), and the rest Gmail sets.
const NOT_BY_NAME = ['TRASH', 'SPAM', 'SENT', 'DRAFT', 'CHAT'];

const reads = { readOnlyHint: true };
const changesThings = { readOnlyHint: false };
const object = (properties, required = []) => ({ type: 'object', properties, required });
const string = (description) => ({ type: 'string', description });

// Plain text from a bit of HTML mail.
const plain = (html) => String(html).replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|tr)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const cut = (text, max) => (text.length > max ? `${text.slice(0, max)}\n[… cut at ${max} characters]` : text);

// A header's value, Gmail style: [{name, value}].
const header = (headers, name) => headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

// The message's text: its text/plain part, or its HTML made plain.
function bodyOf(payload) {
  const parts = [];
  const walk = (part) => {
    if (!part) return;
    parts.push(part);
    for (const child of part.parts || []) walk(child);
  };
  walk(payload);
  const decode = (part) => Buffer.from(part.body?.data || '', 'base64url').toString('utf8');
  const text = parts.find((p) => p.mimeType === 'text/plain' && p.body?.data);
  if (text) return decode(text).trim();
  const html = parts.find((p) => p.mimeType === 'text/html' && p.body?.data);
  return html ? plain(decode(html)) : '';
}

// A header value that may hold non-ASCII, as RFC 2047 wants it.
const encodeHeader = (value) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`);
const oneLine = (value) => String(value || '').replace(/[\r\n]+/g, ' ').trim(); // no header injection

// A plain-text mail as Gmail's API takes it (base64url RFC 822), replying in a thread when asked.
export function rawMail({ to, cc, subject, body, inReplyTo, references }) {
  const lines = [
    `To: ${oneLine(to)}`,
    ...(cc ? [`Cc: ${oneLine(cc)}`] : []),
    `Subject: ${encodeHeader(oneLine(subject))}`,
    ...(inReplyTo ? [`In-Reply-To: ${oneLine(inReplyTo)}`, `References: ${oneLine([references, inReplyTo].filter(Boolean).join(' '))}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    String(body || ''),
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

// `google` is the sign-in (google.js); `fetch`, `gmail` and `calendar` are for tests.
export function googleApps({ google, fetch = globalThis.fetch, gmail = GMAIL, calendar = CALENDAR }) {
  async function call(base, path, { method = 'GET', query, body, signal } = {}) {
    const token = await google.accessToken();
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query || {})) {
      for (const one of [value].flat()) if (one !== undefined && one !== null && one !== '') params.append(key, String(one)); // arrays repeat
    }
    const url = `${base}${path}${params.size ? `?${params}` : ''}`;
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: signal || AbortSignal.timeout(30 * 1000),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new Error("Can't reach Google right now.");
    }
    if (response.status === 204) return null;
    const out = await response.json().catch(() => null);
    if (!response.ok) {
      const why = out?.error?.message || response.statusText;
      if (response.status === 403 && /insufficient|scope/i.test(why)) throw new Error(`Google says the sign-in doesn't allow that (${why}). Sign in with Google again in Settings.`);
      throw new Error(`Google said: ${why} (${response.status}).`);
    }
    return out;
  }
  const ready = (service, name) => () => {
    const status = google.status();
    if (!status.account) return { ok: false, detail: 'Sign in with Google in Settings' };
    if (!status.account.working) return { ok: false, detail: status.account.problem };
    if (!status.account.services.includes(service)) return { ok: false, detail: `The Google sign-in doesn't include ${name}; sign in again` };
    return { ok: true, detail: `As ${status.account.email || 'your Google account'}` };
  };

  // A thread on a few lines: who, when, what.
  const threadLine = (thread) => {
    const first = thread.messages?.[0]?.payload?.headers;
    const last = thread.messages?.at(-1)?.payload?.headers;
    return `${thread.id} · ${header(last, 'Date')} · from ${header(last, 'From')} · ${header(first, 'Subject') || '(no subject)'} (${thread.messages?.length || 1} ${thread.messages?.length === 1 ? 'message' : 'messages'})`;
  };

  // Threads given as one id, a list, or ids separated by commas: at most 50.
  const threadsOf = (threads) => {
    const ids = [threads].flat().flatMap((t) => String(t || '').split(',')).map((t) => t.trim()).filter(Boolean);
    if (!ids.length) throw new Error('Say which threads, by their ids from search_mail.');
    if (ids.length > MAX_BATCH) throw new Error(`At most ${MAX_BATCH} threads at a time.`);
    return [...new Set(ids)];
  };
  const canOrganise = () => {
    if (!google.status().account?.organise) throw new Error('Organising mail needs one more permission from Google: sign in with Google again under Google in Settings.');
  };
  const modify = (ids, change, signal) => Promise.all(ids.map((id) => call(gmail, `/threads/${encodeURIComponent(id)}/modify`, { method: 'POST', body: change, signal })));
  const threadsSchema = { type: 'string', description: 'Thread ids from search_mail, separated by commas' };

  const gmailApp = {
    id: 'gmail',
    name: 'Gmail',
    ready: ready('gmail', 'Gmail'),
    // One ask-first rule per kind of change (apps.js), so sorting can go without asking while
    // sending still asks.
    rules: [
      { kind: 'send', label: 'Gmail: sending mail', what: 'send mail', third: 'sends mail', on: true },
      { kind: 'trash', label: 'Gmail: moving mail to the bin', what: 'move mail to the bin', third: 'moves mail to the bin', on: true },
      { kind: 'organise', label: 'Gmail: labelling, archiving and marking read', what: 'organise your mail', third: 'organises your mail', on: false },
    ],
    tools: [
      {
        name: 'search_mail',
        description: 'Find mail threads with Gmail\'s search, like "is:unread newer_than:2d" or "from:ann@example.com subject:lunch". Lists up to 10, newest first.',
        inputSchema: object({ query: string('Gmail search, like is:unread or from:someone'), max: { type: 'number', description: 'How many, up to 10' } }, ['query']),
        annotations: reads,
        async run({ query, max }, signal) {
          const found = await call(gmail, '/threads', { query: { q: query, maxResults: Math.min(Math.max(Number(max) || MAX_THREADS, 1), MAX_THREADS) }, signal });
          if (!found?.threads?.length) return `No mail matches "${query}".`;
          const threads = await Promise.all(found.threads.map((t) => call(gmail, `/threads/${encodeURIComponent(t.id)}`, {
            query: { format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] }, signal,
          })));
          return threads.map((thread, i) => `${threadLine(thread)}\n  ${found.threads[i].snippet || ''}`.trim()).join('\n');
        },
      },
      {
        name: 'read_thread',
        description: 'Read a mail thread by its id (from search_mail): every message, with who sent it, to whom, when, and its text.',
        inputSchema: object({ thread: string('The thread id') }, ['thread']),
        annotations: reads,
        async run({ thread }, signal) {
          const found = await call(gmail, `/threads/${encodeURIComponent(thread)}`, { query: { format: 'full' }, signal });
          const text = (found.messages || []).map((m) => {
            const h = m.payload?.headers;
            return [`From: ${header(h, 'From')}`, `To: ${header(h, 'To')}`, ...(header(h, 'Cc') ? [`Cc: ${header(h, 'Cc')}`] : []), `Date: ${header(h, 'Date')}`, `Subject: ${header(h, 'Subject')}`, '', cut(bodyOf(m.payload), MAX_BODY)].join('\n');
          }).join('\n\n---\n\n');
          return cut(text || 'That thread is empty.', MAX_TEXT);
        },
      },
      {
        name: 'draft_mail',
        description: "Write a draft in Gmail, for Mikkel to look over and send. Give the thread id to reply in a thread. Nothing is sent.",
        inputSchema: object({ to: string('Who to, like ann@example.com'), cc: string('Copy to, if anyone'), subject: string('The subject'), body: string('The text'), thread: string('A thread id, to reply in it') }, ['to', 'subject', 'body']),
        annotations: reads, // a draft goes nowhere until someone sends it
        async run(args, signal) {
          const reply = args.thread ? await replyHeaders(args.thread, signal) : {};
          const draft = await call(gmail, '/drafts', { method: 'POST', body: { message: { raw: rawMail({ ...args, ...reply }), ...(args.thread ? { threadId: args.thread } : {}) } }, signal });
          return `Drafted "${args.subject}" to ${args.to}. It's in Gmail's Drafts (draft ${draft.id}), not sent.`;
        },
      },
      {
        name: 'send_mail',
        description: 'Send a mail from Gmail. Give the thread id to reply in a thread. munin asks first.',
        inputSchema: object({ to: string('Who to, like ann@example.com'), cc: string('Copy to, if anyone'), subject: string('The subject'), body: string('The text'), thread: string('A thread id, to reply in it') }, ['to', 'subject', 'body']),
        annotations: changesThings,
        ask: 'send',
        async run(args, signal) {
          const reply = args.thread ? await replyHeaders(args.thread, signal) : {};
          const sent = await call(gmail, '/messages/send', { method: 'POST', body: { raw: rawMail({ ...args, ...reply }), ...(args.thread ? { threadId: args.thread } : {}) }, signal });
          return `Sent "${args.subject}" to ${args.to} (message ${sent.id}).`;
        },
      },
      {
        name: 'list_labels',
        description: "Gmail's labels: yours, and the ones Gmail keeps (INBOX, UNREAD, STARRED, IMPORTANT).",
        inputSchema: object({}),
        annotations: reads,
        async run(args, signal) {
          const found = await call(gmail, '/labels', { signal });
          const labels = (found?.labels || []).filter((l) => !NOT_BY_NAME.includes(l.id));
          const mine = labels.filter((l) => l.type === 'user').map((l) => l.name).sort();
          const gmails = labels.filter((l) => l.type !== 'user').map((l) => l.name).sort();
          return `Yours: ${mine.join(', ') || 'none yet'}\nGmail's: ${gmails.join(', ')}`;
        },
      },
      {
        name: 'label_threads',
        description: 'Add labels to threads and take others off, by name. A label that doesn\'t exist yet is made. Takes STARRED and IMPORTANT too.',
        inputSchema: object({ threads: threadsSchema, add: string('Labels to add, separated by commas'), remove: string('Labels to take off, separated by commas') }, ['threads']),
        annotations: changesThings,
        ask: 'organise',
        async run({ threads, add, remove }, signal) {
          canOrganise();
          const ids = threadsOf(threads);
          const names = (list) => String(list || '').split(',').map((n) => n.trim()).filter(Boolean);
          const adding = names(add);
          const removing = names(remove);
          if (!adding.length && !removing.length) throw new Error('Say which labels to add or take off.');
          const refused = [...adding, ...removing].filter((n) => NOT_BY_NAME.includes(n.toUpperCase()));
          if (refused.length) throw new Error(`${refused.join(', ')} can't be set by name. To move mail to the bin, use trash_threads.`);
          const known = (await call(gmail, '/labels', { signal }))?.labels || [];
          const find = (name) => known.find((l) => l.name.toLowerCase() === name.toLowerCase() || l.id === name.toUpperCase());
          const made = [];
          const idOf = async (name, create) => {
            const label = find(name);
            if (label) return label.id;
            if (!create) return null;
            const created = await call(gmail, '/labels', { method: 'POST', body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }, signal });
            known.push(created);
            made.push(name);
            return created.id;
          };
          const addIds = [];
          for (const name of adding) addIds.push(await idOf(name, true));
          const removeIds = (await Promise.all(removing.map((name) => idOf(name, false)))).filter(Boolean);
          await modify(ids, { addLabelIds: addIds, removeLabelIds: removeIds }, signal);
          return [
            `${ids.length} ${ids.length === 1 ? 'thread' : 'threads'}:${adding.length ? ` added ${adding.join(', ')}` : ''}${adding.length && removing.length ? ';' : ''}${removing.length ? ` took off ${removing.join(', ')}` : ''}.`,
            made.length ? `Made the label${made.length === 1 ? '' : 's'} ${made.join(', ')}.` : null,
          ].filter(Boolean).join(' ');
        },
      },
      {
        name: 'archive_threads',
        description: 'Archive threads: out of the inbox, still in All Mail and searchable.',
        inputSchema: object({ threads: threadsSchema }, ['threads']),
        annotations: changesThings,
        ask: 'organise',
        async run({ threads }, signal) {
          canOrganise();
          const ids = threadsOf(threads);
          await modify(ids, { removeLabelIds: ['INBOX'] }, signal);
          return `Archived ${ids.length} ${ids.length === 1 ? 'thread' : 'threads'}.`;
        },
      },
      {
        name: 'mark_threads',
        description: 'Mark threads read or unread.',
        inputSchema: object({ threads: threadsSchema, read: { type: 'boolean', description: 'true for read, false for unread' } }, ['threads', 'read']),
        annotations: changesThings,
        ask: 'organise',
        async run({ threads, read }, signal) {
          canOrganise();
          const ids = threadsOf(threads);
          await modify(ids, read === false ? { addLabelIds: ['UNREAD'] } : { removeLabelIds: ['UNREAD'] }, signal);
          return `Marked ${ids.length} ${ids.length === 1 ? 'thread' : 'threads'} ${read === false ? 'unread' : 'read'}.`;
        },
      },
      {
        name: 'trash_threads',
        description: "Move threads to the bin. Gmail empties it after 30 days; until then they can come back. munin asks first.",
        inputSchema: object({ threads: threadsSchema }, ['threads']),
        annotations: changesThings,
        ask: 'trash',
        async run({ threads }, signal) {
          canOrganise();
          const ids = threadsOf(threads);
          await Promise.all(ids.map((id) => call(gmail, `/threads/${encodeURIComponent(id)}/trash`, { method: 'POST', signal })));
          return `Moved ${ids.length} ${ids.length === 1 ? 'thread' : 'threads'} to the bin.`;
        },
      },
    ],
  };

  // What a reply needs to land in its thread: the last message's Message-ID and References.
  async function replyHeaders(thread, signal) {
    const found = await call(gmail, `/threads/${encodeURIComponent(thread)}`, { query: { format: 'metadata' }, signal });
    const last = found.messages?.at(-1)?.payload?.headers;
    return { inReplyTo: header(last, 'Message-ID') || header(last, 'Message-Id'), references: header(last, 'References') };
  }

  // An event on one line, in its calendar's time zone.
  const when = (point, zone) => {
    if (point?.date) return point.date;
    const at = new Date(point?.dateTime);
    return Number.isNaN(at.getTime()) ? '?' : at.toLocaleString('en-GB', { timeZone: zone || undefined, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };
  const eventLine = (e, zone) => {
    const mine = e.attendees?.find((a) => a.self)?.responseStatus;
    return `${e.id} · ${when(e.start, zone)} – ${when(e.end, zone)} · ${e.summary || '(no title)'}${e.location ? ` · ${e.location}` : ''}${e.attendees?.length ? ` · ${e.attendees.length} people` : ''}${mine && mine !== 'accepted' ? ` · you: ${mine}` : ''}`;
  };
  const point = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? { date: value } : { dateTime: new Date(value).toISOString() });
  const checkTime = (value, field) => {
    if (value === undefined) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) && Number.isNaN(new Date(value).getTime())) throw new Error(`${field} isn't a time: give it like 2026-10-20T12:00:00+02:00, or a date like 2026-10-20 for all day.`);
  };
  const eventFields = (args) => {
    checkTime(args.start, 'start');
    checkTime(args.end, 'end');
    return {
      ...(args.title !== undefined ? { summary: args.title } : {}),
      ...(args.start !== undefined ? { start: point(args.start) } : {}),
      ...(args.end !== undefined ? { end: point(args.end) } : {}),
      ...(args.location !== undefined ? { location: args.location } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.attendees !== undefined ? { attendees: String(args.attendees).split(',').map((email) => ({ email: email.trim() })).filter((a) => a.email) } : {}),
    };
  };
  const eventSchema = {
    title: string('What it is'),
    start: string('When it starts: 2026-10-20T12:00:00+02:00, or 2026-10-20 for all day'),
    end: string('When it ends, the same way'),
    location: string('Where, if anywhere'),
    description: string('Notes'),
    attendees: string('Who to invite, comma separated emails; they get an invitation'),
  };

  const calendarApp = {
    id: 'google-calendar',
    name: 'Google Calendar',
    ready: ready('calendar', 'Google Calendar'),
    tools: [
      {
        name: 'list_events',
        description: 'List events on the main calendar between two times (today, by default), or matching some words.',
        inputSchema: object({ from: string('From when, like 2026-10-17 or 2026-10-17T09:00:00+02:00; today by default'), to: string('Until when; the end of `from`\'s day by default'), query: string('Words to look for') }),
        annotations: reads,
        async run({ from, to, query }, signal) {
          checkTime(from, 'from');
          checkTime(to, 'to');
          const start = from ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(from) ? `${from}T00:00:00` : from) : new Date(new Date().setHours(0, 0, 0, 0));
          const end = to ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59` : to) : new Date(new Date(start).setHours(23, 59, 59, 999));
          const found = await call(calendar, '/calendars/primary/events', {
            query: { timeMin: start.toISOString(), timeMax: end.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: 50, q: query }, signal,
          });
          const events = found?.items || [];
          return events.length ? `Times in ${found.timeZone || 'the calendar\'s time zone'}.\n${events.map((e) => eventLine(e, found.timeZone)).join('\n')}` : 'Nothing on the calendar then.';
        },
      },
      {
        name: 'create_event',
        description: 'Put an event on the main calendar. munin asks first; anyone in attendees gets an invitation.',
        inputSchema: object(eventSchema, ['title', 'start', 'end']),
        annotations: changesThings,
        async run(args, signal) {
          const fields = eventFields(args);
          const made = await call(calendar, '/calendars/primary/events', { method: 'POST', query: { sendUpdates: fields.attendees?.length ? 'all' : 'none' }, body: fields, signal });
          return `Added: ${eventLine(made)}`;
        },
      },
      {
        name: 'update_event',
        description: 'Change an event by its id (from list_events): only what you give changes. munin asks first.',
        inputSchema: object({ event: string('The event id'), ...eventSchema }, ['event']),
        annotations: changesThings,
        async run({ event, ...args }, signal) {
          const fields = eventFields(args);
          const changed = await call(calendar, `/calendars/primary/events/${encodeURIComponent(event)}`, { method: 'PATCH', query: { sendUpdates: 'all' }, body: fields, signal });
          return `Changed: ${eventLine(changed)}`;
        },
      },
      {
        name: 'delete_event',
        description: 'Take an event off the calendar by its id. munin asks first.',
        inputSchema: object({ event: string('The event id') }, ['event']),
        annotations: changesThings,
        async run({ event }, signal) {
          await call(calendar, `/calendars/primary/events/${encodeURIComponent(event)}`, { method: 'DELETE', query: { sendUpdates: 'all' }, signal });
          return `Deleted event ${event}.`;
        },
      },
      {
        name: 'respond_to_event',
        description: "Answer an invitation by the event's id: accepted, declined or tentative. munin asks first.",
        inputSchema: object({ event: string('The event id'), answer: { type: 'string', enum: ['accepted', 'declined', 'tentative'] } }, ['event', 'answer']),
        annotations: changesThings,
        async run({ event, answer }, signal) {
          const found = await call(calendar, `/calendars/primary/events/${encodeURIComponent(event)}`, { signal });
          const attendees = found.attendees || [];
          if (!attendees.some((a) => a.self)) throw new Error(`"${found.summary}" isn't an invitation to answer: you aren't on its guest list.`);
          const updated = await call(calendar, `/calendars/primary/events/${encodeURIComponent(event)}`, {
            method: 'PATCH', query: { sendUpdates: 'all' }, body: { attendees: attendees.map((a) => (a.self ? { ...a, responseStatus: answer } : a)) }, signal,
          });
          return `Answered ${answer} to "${updated.summary}".`;
        },
      },
    ],
  };

  return [gmailApp, calendarApp];
}
