// Signing in with Google: your OAuth client, Google's consent page and the runtime's callback,
// against a stand-in for Google's token endpoint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildModels } from '../src/models.js';
import { openRuntime } from '../src/runtime.js';
import { createRuntimeServer } from '../src/server.js';
import { openGoogle } from '../src/google.js';

const CLIENT = { web: { client_id: '1234-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-secret', redirect_uris: [] } };
const idToken = (email) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`;

// Google's token and revoke endpoints, as far as munin uses them.
async function fakeGoogle() {
  const seen = [];
  let challenge = null; // the last sign-in's, to check the verifier against
  let refreshes = 0;
  let revoked = false;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const form = Object.fromEntries(new URLSearchParams(body));
    seen.push([req.url, form]);
    const json = (status, value) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (req.url === '/revoke') return json(200, {});
    if (form.client_id !== CLIENT.web.client_id || form.client_secret !== CLIENT.web.client_secret) return json(401, { error: 'invalid_client' });
    if (form.grant_type === 'authorization_code') {
      const hashed = createHash('sha256').update(form.code_verifier || '').digest('base64url');
      if (form.code !== 'the-code' || hashed !== challenge) return json(400, { error: 'invalid_grant', error_description: 'Bad code or verifier.' });
      return json(200, {
        access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, id_token: idToken('mikkel@example.com'),
        scope: 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events',
      });
    }
    if (form.grant_type === 'refresh_token') {
      if (revoked || form.refresh_token !== 'refresh-1') return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      refreshes += 1;
      return json(200, { access_token: `access-${refreshes + 1}`, expires_in: 3600 });
    }
    return json(400, { error: 'unsupported_grant_type' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    endpoints: { auth: 'https://accounts.example/auth', token: `${base}/token`, revoke: `${base}/revoke` },
    seen,
    expect: (url) => { challenge = new URL(url).searchParams.get('code_challenge'); },
    revoke: () => { revoked = true; },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

async function serve(dir, endpoints) {
  const settings = { db: join(dir, 'runtime.sqlite'), googleFile: join(dir, 'google.json'), host: '127.0.0.1', agentsDir: join(dir, 'agents'), ollamaUrl: null, user: 'Mikkel' };
  const runtime = await openRuntime(settings, { models: await buildModels(settings, { env: {} }), google: { endpoints } });
  const server = createRuntimeServer(runtime, settings);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/runtime/api`;
  const call = async (method, path, body) => {
    const response = await fetch(base + path, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, location: response.headers.get('location'), body: await response.json().catch(() => null) };
  };
  const close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await runtime.close();
  };
  return { port, call, close };
}

test('sign in with Google: your client, the consent page, and back to Settings', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-google-'));
  const google = await fakeGoogle();
  t.after(() => google.close());
  let served = await serve(dir, google.endpoints);
  t.after(() => served.close());
  const { call, port } = served;
  const callback = `http://localhost:${port}/runtime/api/google/callback`;

  assert.deepEqual((await call('GET', '/google')).body, { client: { configured: false }, account: null, redirect: callback });
  assert.equal((await call('POST', '/google/signin', { services: ['gmail'] })).status, 422, 'no client yet');
  assert.match((await call('PUT', '/google/client', { json: 'not json' })).body.detail, /isn't the JSON Google Cloud gives you/);
  assert.match((await call('PUT', '/google/client', { json: JSON.stringify({ web: { client_id: 'nope', client_secret: 'x' } }) })).body.detail, /doesn't look like a Google OAuth client/);
  assert.deepEqual((await call('PUT', '/google/client', { json: JSON.stringify(CLIENT) })).body.client, { configured: true, id: CLIENT.web.client_id });

  assert.match((await call('POST', '/google/signin', { services: ['drive'] })).body.detail, /gmail and calendar/);
  const { url } = (await call('POST', '/google/signin', { services: ['gmail', 'calendar'], back: 'http://127.0.0.1:7777/#/settings' })).body;
  const asked = new URL(url).searchParams;
  assert.equal(new URL(url).origin + new URL(url).pathname, 'https://accounts.example/auth');
  assert.deepEqual(
    ['client_id', 'redirect_uri', 'response_type', 'access_type', 'prompt', 'code_challenge_method'].map((key) => asked.get(key)),
    [CLIENT.web.client_id, callback, 'code', 'offline', 'consent', 'S256'],
  );
  assert.deepEqual(asked.get('scope').split(' '), [
    'openid', 'email',
    'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events',
  ]);

  // Google sends the browser back with a code: the runtime trades it, then back to Settings.
  google.expect(url);
  const state = asked.get('state');
  const done = await call('GET', `/google/callback?state=${state}&code=the-code`);
  assert.equal(done.status, 302);
  const back = new URL(done.location);
  assert.equal(`${back.origin}${back.pathname}${back.hash}`, 'http://127.0.0.1:7777/#/settings');
  assert.deepEqual([back.searchParams.get('google'), back.searchParams.get('message')], ['ok', 'Signed in with Google as mikkel@example.com.']);
  const signedIn = (await call('GET', '/google')).body;
  assert.deepEqual(signedIn.account, { email: 'mikkel@example.com', services: ['gmail', 'calendar'], organise: false, working: true, problem: null }, "Gmail without gmail.modify: it works, it just can't organise");
  assert.ok(!JSON.stringify(signedIn).includes('refresh-1') && !JSON.stringify(signedIn).includes('GOCSPX'), 'no secret comes back');

  const again = await call('GET', `/google/callback?state=${state}&code=the-code`);
  assert.equal(again.status, 400, 'a sign-in is used once');

  // Cancelled at Google, and a page that isn't munin's own isn't gone back to.
  const other = (await call('POST', '/google/signin', { services: ['calendar'], back: 'https://evil.example/' })).body.url;
  const cancelled = await call('GET', `/google/callback?state=${new URL(other).searchParams.get('state')}&error=access_denied`);
  assert.deepEqual([cancelled.status, cancelled.location], [400, null]);

  // Kept across a restart, readable by the runtime's user only.
  await served.close();
  assert.equal((await stat(join(dir, 'google.json'))).mode & 0o777, 0o600);
  assert.match(await readFile(join(dir, 'google.json'), 'utf8'), /refresh-1/);
  served = await serve(dir, google.endpoints);
  assert.equal((await served.call('GET', '/google')).body.account.email, 'mikkel@example.com');

  await served.call('DELETE', '/google');
  assert.equal((await served.call('GET', '/google')).body.account, null);
  assert.deepEqual(google.seen.at(-1), ['/revoke', { token: 'refresh-1' }], 'signing out revokes it at Google');
});

test('the access token is renewed before it runs out, and a revoked sign-in says so', async (t) => {
  const google = await fakeGoogle();
  t.after(() => google.close());
  let clock = 1_000_000;
  const store = await openGoogle({ file: null, endpoints: google.endpoints, now: () => clock });
  await store.setClient(CLIENT);
  await assert.rejects(store.accessToken(), /Nobody is signed in/);
  const { url } = store.signIn({ services: ['calendar'], redirect: 'http://localhost:7779/runtime/api/google/callback' });
  google.expect(url);
  await store.finish({ state: new URL(url).searchParams.get('state'), code: 'the-code' });

  assert.equal(await store.accessToken(), 'access-1');
  clock += 59 * 60 * 1000 + 30 * 1000; // within a minute of running out
  const [a, b] = await Promise.all([store.accessToken(), store.accessToken()]);
  assert.deepEqual([a, b], ['access-2', 'access-2'], 'renewed once, for both');
  assert.equal(google.seen.filter(([, form]) => form.grant_type === 'refresh_token').length, 1);

  google.revoke();
  clock += 2 * 60 * 60 * 1000;
  await assert.rejects(store.accessToken(), /stopped working \(it was revoked, or expired\)\. Sign in again/);
  assert.equal(store.status().account.working, false);
  assert.equal(store.signedIn(), false);
});
