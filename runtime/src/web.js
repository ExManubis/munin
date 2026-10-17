// The web, for agents with the Web ability. Reading a page is munin's own tool: the runtime
// fetches it (never a coder's container), refuses this machine, private networks and the tailnet,
// and hands back readable text. Searching is OpenRouter's: an agent on an OpenRouter model gets a
// web_search tool, which the request to OpenRouter swaps for its openrouter:web_search server tool
// (withWebSearch), so the model searches as it answers and OpenRouter bills the searches.

import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-durable';

export const SEARCH = { max_results: 5 };
export const MAX_SEARCHES = 5; // per answer, so a model can't run up searches in one go
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CHARS = 20000;
const MAX_REDIRECTS = 5;

// Addresses a page may not be fetched from: this machine, private, shared and link-local
// networks (the tailnet's 100.64.0.0/10 among them), multicast and reserved ranges, and any
// IPv6 address that carries one of those IPv4 addresses (mapped, compatible, NAT64, 6to4).
const privateV4 = ([a, b]) => a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
  || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;

// An IPv6 address as its eight 16-bit groups, or null when it isn't one.
function groupsOf(address) {
  let text = String(address).toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text); // a dotted IPv4 tail: ::ffff:127.0.0.1
  if (tail) {
    const [a, b, c, d] = tail[1].split('.').map(Number);
    text = `${text.slice(0, -tail[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const parts = [...head, ...Array(Math.max(fill, 0)).fill('0'), ...rest];
  if (parts.length !== 8 || parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  return parts.map((p) => parseInt(p, 16));
}

export function isPrivate(address) {
  if (isIP(address) === 4) return privateV4(address.split('.').map(Number));
  const g = groupsOf(address);
  if (!g) return true; // not an address munin understands: don't fetch it
  const v4 = (hi, lo) => privateV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  const zero = (n) => g.slice(0, n).every((x) => x === 0);
  if (zero(5) && g[5] === 0xffff) return v4(g[6], g[7]); // ::ffff:a.b.c.d, mapped
  if (zero(6)) return true; // ::, ::1 and ::a.b.c.d, compatible: none of them the open web
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64: reaches IPv4, this machine's included, through a gateway
  if (g[0] === 0x2002) return v4(g[1], g[2]); // 6to4 carries an IPv4 address
  return (g[0] & 0xfe00) === 0xfc00 // unique local, the tailnet's fd7a:115c:a1e0::/48 among them
    || (g[0] & 0xffc0) === 0xfe80 // link-local
    || (g[0] & 0xff00) === 0xff00 // multicast
    || (g[0] === 0x2001 && g[1] === 0xdb8); // documentation
}

// The DNS lookup the connection itself uses, so the address checked is the address connected to:
// a name that resolves to a private address, now or on a second look, isn't connected to.
export function guardedLookup(resolve = (host) => lookup(host, { all: true })) {
  return (hostname, options, callback) => {
    resolve(hostname).then((found) => {
      if (!found.length) return callback(Object.assign(new Error(`${hostname} can't be found.`), { code: 'ENOTFOUND' }));
      if (found.some(({ address }) => isPrivate(address))) {
        return callback(Object.assign(new Error(`${hostname} is on a private network or this machine, which agents can't read from.`), { code: 'EPRIVATE' }));
      }
      return options?.all ? callback(null, found.map(({ address, family }) => ({ address, family: family || isIP(address) }))) : callback(null, found[0].address, found[0].family || isIP(found[0].address));
    }, callback);
  };
}

// fetch, but over Node's http and https with guardedLookup, and redirects left to the caller.
function guardedFetch(url, { signal, headers }) {
  return new Promise((done, fail) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.get(url, { headers, signal, lookup: guardedLookup() }, (response) => {
      const empty = response.statusCode === 204 || response.statusCode === 304;
      const out = new Headers();
      for (const [key, value] of Object.entries(response.headers)) out.set(key, Array.isArray(value) ? value.join(', ') : String(value));
      if (empty) response.resume();
      done(new Response(empty ? null : Readable.toWeb(response), { status: response.statusCode, headers: out }));
    });
    request.on('error', (err) => fail(err.code === 'EPRIVATE' || err.code === 'ENOTFOUND' ? new Error(err.message) : err));
  });
}

// A page's text, roughly as a reader sees it: no scripts, styles or markup.
export function textOf(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// `resolve` and `fetch` are for tests; the real fetch checks addresses again as it connects.
export async function readPage(address, { resolve = (host) => lookup(host, { all: true }), fetch = guardedFetch, signal } = {}) {
  let url;
  try {
    url = new URL(String(address).trim());
  } catch {
    throw new Error(`"${address}" isn't a web address.`);
  }
  for (let hop = 0; ; hop++) {
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https pages can be read.');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [{ address: host }] : await resolve(host).catch(() => []);
    if (!addresses.length) throw new Error(`${url.hostname} can't be found.`);
    if (addresses.some(({ address: a }) => isPrivate(a))) throw new Error(`${url.hostname} is on a private network or this machine, which agents can't read from.`);
    // Checked here for a clear answer, and again by the connection's own lookup (guardedFetch).
    const response = await fetch(url, { redirect: 'manual', signal: signal || AbortSignal.timeout(20 * 1000), headers: { 'User-Agent': 'munin (reading a page for an agent)', Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' } });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      if (hop >= MAX_REDIRECTS) throw new Error(`${address} redirects too many times.`);
      url = new URL(response.headers.get('location'), url); // checked again on the next hop
      continue;
    }
    if (!response.ok) throw new Error(`${url.href} answered ${response.status}.`);
    const type = response.headers.get('content-type') || '';
    if (!/text\/|json|xml/.test(type)) throw new Error(`${url.href} is ${type.split(';')[0] || 'not text'}, which munin can't read as a page.`);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (size < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    reader.cancel().catch(() => {});
    const raw = Buffer.concat(chunks).toString('utf8');
    const text = /html/.test(type) ? textOf(raw) : raw.trim();
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.trim();
    const cut = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n\n[… the page goes on; munin read the first ${MAX_CHARS} characters]` : text;
    return { url: url.href, title: title ? textOf(title) : null, text: cut };
  }
}

export const readPageTool = (options) => defineTool({
  name: 'read_page',
  description: 'Read a web page and get its text. Give its full address, starting with https://.',
  parameters: Type.Object({ url: Type.String({ description: 'The page, like https://example.com/post' }) }),
  async execute(args, api, context) {
    try {
      const page = await readPage(args.url, { ...options, signal: context.abortSignal });
      return { output: [{ type: 'text', text: `${page.title ? `${page.title}\n` : ''}${page.url}\n\n${page.text}` }] };
    } catch (err) {
      if (context.abortSignal?.aborted) throw err;
      return { output: [{ type: 'text', text: err.message }], isError: true };
    }
  },
});

// Offered to agents on OpenRouter models; the request swaps it for OpenRouter's search, so the
// model never calls this itself. If it somehow does, it says why that didn't work.
export const webSearchTool = defineTool({
  name: 'web_search',
  description: 'Search the web for current information. Results come back with their sources.',
  parameters: Type.Object({ query: Type.String() }),
  async execute() {
    return { output: [{ type: 'text', text: "Search runs at OpenRouter, and this request didn't reach it there. Use read_page with an address instead." }], isError: true };
  },
});

// The request to OpenRouter, with munin's web_search tool swapped for OpenRouter's server tool.
// Works on both shapes pi-ai sends: OpenAI chat completions ({type: 'function', function: {name}})
// and Anthropic messages ({name, input_schema}). Undefined when there's nothing to swap.
export function withWebSearch(payload) {
  const tools = Array.isArray(payload?.tools) ? payload.tools : null;
  if (!tools) return undefined;
  const ours = (tool) => tool?.function?.name === 'web_search' || (tool?.name === 'web_search' && tool.input_schema);
  if (!tools.some(ours)) return undefined;
  const openai = tools.some((tool) => tool?.type === 'function');
  return {
    ...payload,
    tools: [...tools.filter((tool) => !ours(tool)), { type: 'openrouter:web_search', parameters: { ...SEARCH, max_uses: MAX_SEARCHES } }],
    ...(openai ? { max_tool_calls: payload.max_tool_calls ?? MAX_SEARCHES } : {}),
  };
}
