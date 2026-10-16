// The runtime's HTTP API under /runtime/api (docs/runtime-api.md), and a stream that says
// "changed" whenever anything does. Like the tracker, it has no login: it listens on
// 127.0.0.1, refuses other host names, and lets in browsers only from pages on this machine.
// Behind the edge (tailscale serve), its public name gets in too, but only for the people in
// MUNIN_USERS: Serve says who's calling in Tailscale-User-Login, having removed any the caller
// sent.

import { createServer } from 'node:http';
import { RuntimeError } from './runtime.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const hostOf = (value) => {
  try {
    return new URL(`http://${value}`).hostname;
  } catch {
    return '';
  }
};

export function createRuntimeServer(runtime, settings) {
  const local = LOOPBACK.has(settings.host);
  const edge = settings.publicUrl ? new URL(settings.publicUrl) : null;
  const people = new Set((settings.users || []).map((u) => u.toLowerCase()));
  if (edge && !people.size) throw new Error('MUNIN_PUBLIC_URL is set, so say who may use munin through it: MUNIN_USERS=you@example.com.');
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern: new RegExp(`^/runtime/api${pattern}$`), handler });
  const enc = (s) => decodeURIComponent(s);

  route('GET', '/me', () => runtime.me());
  route('GET', '/agents', () => runtime.agents());
  route('POST', '/agents', (m, body) => runtime.createAgent(body));
  route('GET', '/agents/([^/]+)', (m) => runtime.agent(enc(m[1])));
  route('PATCH', '/agents/([^/]+)', (m, body) => runtime.updateAgent(enc(m[1]), body));
  route('DELETE', '/agents/([^/]+)', (m) => runtime.deleteAgent(enc(m[1])));
  route('POST', '/agents/([^/]+)/pause', (m) => runtime.pause(enc(m[1])));
  route('POST', '/agents/([^/]+)/resume', (m) => runtime.resume(enc(m[1])));
  route('GET', '/agents/([^/]+)/conversation', (m) => runtime.conversation(enc(m[1])));
  route('POST', '/agents/([^/]+)/messages', (m, body) => runtime.send(enc(m[1]), body.text));
  route('POST', '/agents/([^/]+)/items/([^/]+)/answer', (m, body) => runtime.answer(enc(m[1]), enc(m[2]), body));
  route('POST', '/agents/([^/]+)/items/([^/]+)/decide', (m, body) => runtime.decide(enc(m[1]), enc(m[2]), body.decision));
  route('POST', '/agents/([^/]+)/items/([^/]+)/undo', (m) => runtime.undo(enc(m[1]), enc(m[2])));
  route('POST', '/agents/([^/]+)/runs/([^/]+)/stop', (m) => runtime.stopRun(enc(m[1]), enc(m[2])));
  route('POST', '/agents/([^/]+)/routines', (m, body) => runtime.addRoutine(enc(m[1]), body));
  route('PATCH', '/agents/([^/]+)/routines/([^/]+)', (m, body) => runtime.updateRoutine(enc(m[1]), enc(m[2]), body));
  route('DELETE', '/agents/([^/]+)/routines/([^/]+)', (m) => runtime.deleteRoutine(enc(m[1]), enc(m[2])));
  route('POST', '/agents/([^/]+)/routines/([^/]+)/run', (m) => runtime.runRoutine(enc(m[1]), enc(m[2])));
  route('DELETE', '/agents/([^/]+)/memory/([^/]+)', (m) => runtime.forget(enc(m[1]), enc(m[2])));
  route('GET', '/waiting', () => runtime.waiting());
  route('GET', '/providers', () => runtime.providers());
  route('GET', '/models', () => runtime.models());
  route('GET', '/repos', () => runtime.repos());
  route('PUT', '/repos/([^/]+)', (m, body) => runtime.setRepo(enc(m[1]), body));
  route('DELETE', '/repos/([^/]+)', (m) => runtime.removeRepo(enc(m[1])));

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://runtime');
    // Web pages elsewhere can't use DNS rebinding to reach this, and only local pages get CORS.
    const host = hostOf(req.headers.host || '');
    const viaEdge = Boolean(edge) && host === edge.hostname;
    if (local && !LOOPBACK.has(host) && !viaEdge) return send(res, 400, { detail: 'Invalid host.' });
    if (viaEdge) {
      const login = String(req.headers['tailscale-user-login'] || '').trim().toLowerCase();
      if (!people.has(login)) {
        const who = login ? `${login} isn't` : "Tailscale didn't say who you are, so you aren't";
        return send(res, 403, { detail: `${who} one of munin's people. Its owner adds people to MUNIN_USERS.` });
      }
    }
    const origin = req.headers.origin;
    let originHost = '';
    try {
      originHost = origin ? new URL(origin).hostname : '';
    } catch {
      // not a URL: refused below
    }
    const cors = origin && LOOPBACK.has(originHost)
      ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' }
      : {};
    const sameEdge = viaEdge && origin === edge.origin; // the frontend, served at the same address
    if (origin && !cors['Access-Control-Allow-Origin'] && !sameEdge) return send(res, 403, { detail: 'Not from this machine.' });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }

    if (req.method === 'GET' && url.pathname === '/runtime/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', ...cors });
      res.write(': connected\n\n');
      let timer = null;
      const unsubscribe = runtime.subscribe(() => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          res.write('event: changed\ndata: {}\n\n');
        }, 100);
      });
      const keepalive = setInterval(() => res.write(': keepalive\n\n'), 25000);
      req.on('close', () => {
        unsubscribe();
        clearInterval(keepalive);
        clearTimeout(timer);
      });
      return undefined;
    }

    for (const { method, pattern, handler } of routes) {
      const m = url.pathname.match(pattern);
      if (!m || method !== req.method) continue;
      try {
        let body = {};
        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const raw = Buffer.concat(chunks).toString('utf8');
          body = raw ? JSON.parse(raw) : {};
        }
        const result = await handler(m, body);
        return send(res, req.method === 'POST' && /\/(agents|routines)$/.test(url.pathname) ? 201 : 200, result ?? {}, cors);
      } catch (err) {
        if (err instanceof SyntaxError) return send(res, 400, { detail: 'That isn’t JSON.' }, cors);
        if (err instanceof RuntimeError) return send(res, err.status, { detail: err.message }, cors);
        console.error(err);
        return send(res, 500, { detail: 'Something went wrong in the runtime.' }, cors);
      }
    }
    return send(res, 404, { detail: 'Not found.' }, cors);
  });
}
