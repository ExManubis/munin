// Signing in with Google, for Gmail and Calendar. You bring the OAuth client: a "Web application"
// client from your own Google Cloud project, whose JSON you paste in Settings. Signing in goes
// to Google's consent page (PKCE, offline access) and comes back to the runtime's callback,
// which trades the code for tokens. The runtime keeps the client and the tokens in google.json
// next to its database, readable by its own user only, renews the access token itself, and
// never hands either back: the API says which account is signed in and what it allows.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class GoogleError extends Error {}

export const ENDPOINTS = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
};

// What each service asks Google for. Reading needs no asking in munin; changing things asks
// first (MUN-7), so these allow what the agents' tools do.
export const SCOPES = {
  gmail: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'],
  calendar: ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events'],
};
const IDENTITY = ['openid', 'email'];

const PENDING_MS = 10 * 60 * 1000; // a sign-in left at Google's page this long is forgotten
const b64url = (buffer) => buffer.toString('base64url');

// The client from the JSON Google Cloud gives you ({"web": {...}} or {"installed": {...}}), or
// from its id and secret.
export function readClient(input) {
  let fields = input;
  if (typeof input === 'string') {
    try {
      fields = JSON.parse(input);
    } catch {
      throw new GoogleError("That isn't the JSON Google Cloud gives you for an OAuth client.");
    }
  }
  const client = fields?.web || fields?.installed || fields || {};
  const id = String(client.client_id || client.clientId || '').trim();
  const secret = String(client.client_secret || client.clientSecret || '').trim();
  if (!id.endsWith('.apps.googleusercontent.com')) throw new GoogleError("That doesn't look like a Google OAuth client: its id ends in .apps.googleusercontent.com.");
  if (!secret) throw new GoogleError('The client needs its secret too. Download the JSON again from Google Cloud, under Credentials.');
  return { id, secret };
}

// `file` is google.json (null in tests keeps it in memory); `endpoints` and `fetch` are for tests.
export async function openGoogle({ file, endpoints = ENDPOINTS, fetch = globalThis.fetch, now = Date.now }) {
  let saved = { client: null, account: null };
  if (file) {
    try {
      saved = { ...saved, ...JSON.parse(await readFile(file, 'utf8')) };
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`Can't read the Google sign-in in ${file}: ${err.message}`);
    }
  }
  const save = async () => {
    if (!file) return;
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file);
  };
  const pending = new Map(); // state → { verifier, redirect, back, services, at }
  let refreshing = null;
  let problem = null; // why the saved sign-in stopped working, when it has

  async function tokenRequest(params) {
    let response;
    try {
      response = await fetch(endpoints.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: saved.client.id, client_secret: saved.client.secret, ...params }),
        signal: AbortSignal.timeout(30 * 1000),
      });
    } catch {
      throw new GoogleError("Can't reach Google to sign in.");
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new GoogleError(body.error_description || body.error || `Google answered ${response.status}.`);
      error.code = body.error;
      throw error;
    }
    return body;
  }

  // The signed-in email, from the id token Google sends with the first tokens (it came straight
  // from Google over TLS, so its signature needn't be checked here).
  const emailOf = (idToken) => {
    try {
      return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')).email || null;
    } catch {
      return null;
    }
  };

  const describe = (redirect) => ({
    client: saved.client ? { configured: true, id: saved.client.id } : { configured: false },
    account: saved.account ? {
      email: saved.account.email,
      services: Object.keys(SCOPES).filter((service) => SCOPES[service].every((scope) => saved.account.scopes.includes(scope))),
      working: !problem,
      problem,
    } : null,
    redirect,
  });

  return {
    status: (redirect) => describe(redirect),

    async setClient(input) {
      saved = { ...saved, client: readClient(input), account: null };
      problem = null;
      await save();
      return describe();
    },

    // The address of Google's consent page for these services. `redirect` is the runtime's
    // callback as you reach it, and `back` the page to return to afterwards.
    signIn({ services = ['gmail', 'calendar'], redirect, back }) {
      if (!saved.client) throw new GoogleError('Add your Google OAuth client first.');
      const unknown = services.filter((service) => !SCOPES[service]);
      if (unknown.length || !services.length) throw new GoogleError(`munin can sign in for ${Object.keys(SCOPES).join(' and ')}.`);
      for (const [state, entry] of pending) if (now() - entry.at > PENDING_MS) pending.delete(state);
      const state = b64url(randomBytes(24));
      const verifier = b64url(randomBytes(48));
      pending.set(state, { verifier, redirect, back, services, at: now() });
      const query = new URLSearchParams({
        client_id: saved.client.id,
        redirect_uri: redirect,
        response_type: 'code',
        scope: [...IDENTITY, ...services.flatMap((service) => SCOPES[service])].join(' '),
        access_type: 'offline', // a refresh token, so the sign-in lasts
        prompt: 'consent', // and a new one each time, even for an account that said yes before
        include_granted_scopes: 'true',
        state,
        code_challenge: b64url(createHash('sha256').update(verifier).digest()),
        code_challenge_method: 'S256',
      });
      return { url: `${endpoints.auth}?${query}` };
    },

    // Google's redirect back: the tokens for the code, or why not. Returns the page to go back to.
    async finish({ state, code, error }) {
      const entry = pending.get(state);
      pending.delete(state);
      if (!entry || now() - entry.at > PENDING_MS) throw new GoogleError('That sign-in is too old or was already used. Start it again from Settings.');
      if (error) throw Object.assign(new GoogleError(error === 'access_denied' ? 'Google sign-in was cancelled.' : `Google said: ${error}.`), { back: entry.back });
      try {
        const tokens = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: entry.verifier, redirect_uri: entry.redirect });
        if (!tokens.refresh_token) throw new GoogleError("Google didn't send a refresh token, so the sign-in wouldn't last. Sign in again.");
        saved = {
          ...saved,
          account: {
            email: emailOf(tokens.id_token),
            scopes: String(tokens.scope || '').split(' ').filter(Boolean),
            refresh: tokens.refresh_token,
            access: tokens.access_token,
            expires: now() + (Number(tokens.expires_in) || 3600) * 1000,
          },
        };
        problem = null;
        await save();
        return { back: entry.back, email: saved.account.email };
      } catch (err) {
        err.back = entry.back;
        throw err;
      }
    },

    // A fresh access token for calls to Google, renewed a minute before it runs out.
    async accessToken() {
      const account = saved.account;
      if (!account) throw new GoogleError('Nobody is signed in with Google. Sign in under Google in Settings.');
      if (problem) throw new GoogleError(problem);
      if (account.access && account.expires - now() > 60 * 1000) return account.access;
      refreshing ||= (async () => {
        try {
          const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: account.refresh });
          Object.assign(account, { access: tokens.access_token, expires: now() + (Number(tokens.expires_in) || 3600) * 1000 });
          if (tokens.refresh_token) account.refresh = tokens.refresh_token;
          await save();
          return account.access;
        } catch (err) {
          if (err.code === 'invalid_grant') problem = `The Google sign-in for ${account.email || 'your account'} stopped working (it was revoked, or expired). Sign in again under Google in Settings.`;
          throw problem ? new GoogleError(problem) : err;
        } finally {
          refreshing = null;
        }
      })();
      return refreshing;
    },

    async signOut() {
      const token = saved.account?.refresh;
      saved = { ...saved, account: null };
      problem = null;
      await save();
      if (token) await fetch(endpoints.revoke, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) }).catch(() => {});
    },

    signedIn: () => Boolean(saved.account) && !problem,
  };
}
