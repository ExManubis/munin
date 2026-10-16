// munin's agent runtime, as the frontend sees it. When the runtime answers, at this page's
// own address (behind the edge) or on its own port on this machine, the frontend uses it;
// otherwise it falls back to the mock in mock.js, so the Agents part still has something
// to show. Both have the same functions.

import { connect } from './client.js';

async function answers(base) {
  try {
    const response = await fetch(`${base}/runtime/api/me`, { signal: AbortSignal.timeout(1500) });
    return response.ok && (await response.json()).kind === 'runtime';
  } catch {
    return false;
  }
}

async function find() {
  let stored = null;
  try {
    stored = localStorage.getItem('munin:runtime-url');
  } catch {
    // no storage: just look in the usual places
  }
  // On this machine the runtime usually runs next to the tracker on its own port; behind the
  // edge it's at this page's own address. Try the likelier one first.
  const port = `${location.protocol}//${location.hostname}:7779`;
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
  const candidates = [stored, ...(local ? [port, location.origin] : [location.origin, port])].filter(Boolean);
  for (const base of candidates) if (await answers(base)) return connect(base);
  return (await import('./mock.js')).mock;
}

export const runtime = await find();
