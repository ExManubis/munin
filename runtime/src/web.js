// The web, for agents with the Web ability. Reading a page is munin's own tool: the runtime
// fetches it (never a coder's container), refuses this machine, private networks and the tailnet,
// and hands back readable text. Searching is OpenRouter's: an agent on an OpenRouter model gets a
// web_search tool, which the request to OpenRouter swaps for its openrouter:web_search server tool
// (withWebSearch), so the model searches as it answers and OpenRouter bills the searches.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-durable';

export const SEARCH = { max_results: 5 };
export const MAX_SEARCHES = 5; // per answer, so a model can't run up searches in one go
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CHARS = 20000;
const MAX_REDIRECTS = 5;

// Addresses a page may not be fetched from: this machine, private and link-local networks, the
// tailnet (100.64.0.0/10, fd7a:115c:a1e0::/48), and the like. munin listens on some of them.
export function isPrivate(address) {
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v6 = address.toLowerCase();
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('ff');
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

// `resolve` and `fetch` are for tests.
export async function readPage(address, { resolve = (host) => lookup(host, { all: true }), fetch = globalThis.fetch, signal } = {}) {
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
