// munin's agent runtime, as the frontend sees it. When the runtime answers, at this page's
// own address (behind the edge) or on its own port on this machine, the frontend uses it.
// When it doesn't, munin is the tracker and outside agents: `runtime.kind` is 'none', the
// Agents part hides, and the frontend keeps looking, so a runtime that comes up later shows up
// without a reload. `munin demo`, or ?mock in the address, uses the mock in mock.js instead, so
// the Agents part can be shown and worked on without a runtime. All three have the same face.

import { connect } from './client.js';

const LOOK_AGAIN = 10 * 1000;

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
  return null;
}

async function wantsMock() {
  if (new URLSearchParams(location.search).has('mock')) return true;
  try {
    const response = await fetch('/api/me', { signal: AbortSignal.timeout(1500) });
    return response.ok && (await response.json()).demo === true;
  } catch {
    return false;
  }
}

// No runtime: no agents and nothing waiting; anything else says so.
const missing = () => Promise.reject(new Error("munin's agent runtime isn't running."));
const none = new Proxy({ kind: 'none', agents: async () => [], waiting: async () => [], subscribe: () => () => {}, linkTracker: undefined, then: undefined }, {
  get: (target, key) => (key in target || typeof key !== 'string' ? target[key] : missing),
});

let current = (await wantsMock()) ? (await import('./mock.js')).mock : (await find()) || none;

// Whoever listens hears from whichever runtime is current, and hears once when one turns up.
const listeners = new Set();
const hear = (...args) => listeners.forEach((fn) => fn(...args));
let unsubscribe = current.subscribe(hear);

// Look again after 10 seconds, then less and less often, down to once a minute.
async function lookAgain(wait = LOOK_AGAIN) {
  const found = document.hidden ? null : await find();
  if (!found) {
    setTimeout(() => lookAgain(Math.min(wait * 1.5, 60 * 1000)), wait);
    return;
  }
  current = found;
  unsubscribe();
  unsubscribe = current.subscribe(hear);
  hear();
}
if (current === none) setTimeout(lookAgain, LOOK_AGAIN);

export const runtime = new Proxy({}, {
  get(_, key) {
    if (key === 'subscribe') {
      return (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      };
    }
    const value = current[key];
    return typeof value === 'function' ? value.bind(current) : value;
  },
  has: (_, key) => key in current,
});
