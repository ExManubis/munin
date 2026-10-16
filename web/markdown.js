// A small Markdown subset for text agents write: paragraphs, line breaks, `code`,
// fenced code blocks, **bold**, *italic*, bullet lists and http(s) links.
// It builds DOM nodes directly, so raw HTML in the text only ever shows up as text.

import { h } from './ui.js';

const FENCE = /^\s*(`{3,}|~{3,})/;
const BULLET = /^\s*[-*+]\s+/;

export function markdown(text, cls) {
  const root = h('div', { class: ['md', cls] });
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(FENCE);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++; // the closing fence (or the end of the text)
      root.append(h('pre', {}, h('code', {}, body.join('\n'))));
    } else if (!line.trim()) {
      i++;
    } else if (BULLET.test(line)) {
      const list = h('ul');
      while (i < lines.length && BULLET.test(lines[i])) {
        let item = lines[i++].replace(BULLET, '');
        // Indented lines that follow belong to the same item.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !BULLET.test(lines[i])) item += `\n${lines[i++].trim()}`;
        list.append(h('li', {}, inline(item)));
      }
      root.append(list);
    } else {
      const para = [];
      while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !BULLET.test(lines[i])) para.push(lines[i++]);
      root.append(h('p', {}, inline(para.join('\n'))));
    }
  }
  return root;
}

function safeUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function link(raw, children, fallback) {
  const href = safeUrl(raw);
  if (!href) return fallback;
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow' }, children);
}

// Earlier rules win when two matches start at the same place.
const RULES = [
  [/`([^`\n]+)`/, (m) => h('code', {}, m[1])],
  [/\[([^\]\n]+)\]\(\s*([^)\s]+)\s*\)/, (m) => link(m[2], inline(m[1]), m[0])],
  [/\bhttps?:\/\/[^\s<>()]*[^\s<>().,;:!?'"\]]/, (m) => link(m[0], m[0], m[0])],
  [/\*\*(?=\S)([^\n]*?\S)\*\*/, (m) => h('strong', {}, inline(m[1]))],
  [/(?<![\w])__(?=\S)([^\n]*?\S)__(?![\w])/, (m) => h('strong', {}, inline(m[1]))],
  [/\*(?=[^\s*])([^*\n]*?[^\s*])\*/, (m) => h('em', {}, inline(m[1]))],
  [/(?<![\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w])/, (m) => h('em', {}, inline(m[1]))],
  [/\n/, () => h('br')],
];

function inline(text) {
  const out = [];
  let rest = text;
  while (rest) {
    let best = null;
    for (const [re, make] of RULES) {
      const m = re.exec(rest);
      if (m && (!best || m.index < best.m.index)) best = { m, make };
    }
    if (!best) {
      out.push(rest);
      break;
    }
    if (best.m.index) out.push(rest.slice(0, best.m.index));
    out.push(best.make(best.m));
    rest = rest.slice(best.m.index + best.m[0].length);
  }
  return out;
}
