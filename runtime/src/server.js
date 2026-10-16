// The runtime's HTTP API under /runtime/api (docs/runtime-api.md), and a stream that says
// "changed" whenever anything does. Like the tracker, it has no login: it listens on
// 127.0.0.1, refuses other host names, and lets in browsers only from pages on this machine.

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
  route('DELETE', '/agents/([^/]+)/memory/([^/]+)', (m) => runtime.forget(enc(m[1]), enc(m[2])));
  route('GET', '/waiting', () => runtime.waiting());
  route('GET', '/providers', () => runtime.providers());
  route('GET', '/models', () => runtime.models());

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://runtime');
    // Web pages elsewhere can't use DNS rebinding to reach this, and only local pages get CORS.
    if (local && !LOOPBACK.has(hostOf(req.headers.host || ''))) return send(res, 400, { detail: 'Invalid host.' });
    const origin = req.headers.origin;
    const cors = origin && LOOPBACK.has(new URL(origin).hostname)
      ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' }
      : {};
    if (origin && !cors['Access-Control-Allow-Origin']) return send(res, 403, { detail: 'Not from this machine.' });
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
        if (req.method === 'POST' || req.method === 'PATCH') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const raw = Buffer.concat(chunks).toString('utf8');
          body = raw ? JSON.parse(raw) : {};
        }
        const result = await handler(m, body);
        return send(res, req.method === 'POST' && url.pathname.endsWith('/agents') ? 201 : 200, result ?? {}, cors);
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
