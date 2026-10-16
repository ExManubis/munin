// munin's entrance, the first time it opens: a CRT that powers on, paints the raven and the
// wordmark row by row in phosphor, converges its colour guns, types the tagline and waits for a
// key; then the tube switches off onto setup. playIntro() resolves once it has.

// The lockups from brand/final, as sub-pixels, each unit 2 × 2 in the brand's dither: the raven
// and the wordmark side by side (118 × 22), or stacked (76 × 52) on a screen taller than wide.
const parse = (d) => {
  const cells = [];
  for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let i = 0; i < +m[3]; i++) cells.push([+m[1] + i, +m[2]]);
  }
  return cells;
};
// The raven's eye, two units on the second row: covering them is the brand's blink frame.
const ravenEye = (dx) => [10, 11, 14, 15].flatMap((x) => [[x + dx, 2], [x + dx, 3]]);
const SHAPES = {
  wide: { file: 'brand/munin-lockup-horizontal.svg', cols: 118, rows: 22, eye: ravenEye(0), height: 0.34 },
  tall: { file: 'brand/munin-lockup-stacked.svg', cols: 76, rows: 52, eye: ravenEye(22), height: 0.46 },
};
const TAGLINE = 'Huginn thinks. Munin remembers.';
const calm = matchMedia('(prefers-reduced-motion: reduce)');
const touch = matchMedia('(hover: none)').matches;

// Milliseconds from the start: the tube powers on, the beam paints the even rows and then the
// odd ones, the colour guns converge, the tagline types, and it waits for you.
const T = { line: [200, 460], open: [460, 1000], pass1: [1100, 2250], pass2: [2350, 3500], converge: [3500, 4350], tag: 4550, char: 52, press: 6400, blink: 5200 };
const ease = (k) => 1 - (1 - k) ** 3;
const span = ([a, b], t) => Math.min(1, Math.max(0, (t - a) / (b - a)));
// When the beam reaches a sub-pixel: its pass, then its row, then along the row left to right.
const litAt = (x, y, lk) => {
  const [a, b] = y % 2 === 0 ? T.pass1 : T.pass2;
  return a + ((y + x / lk.cols) / lk.rows) * (b - a);
};
const HOT_MS = 230; // how long a sub-pixel stays white-hot
const SETTLED = T.pass2[1] + HOT_MS * 6;

let crt = null;
let grain = '';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

function noise() {
  const c = canvas(128, 128);
  const g = c.getContext('2d');
  const d = g.createImageData(128, 128);
  for (let i = 0; i < d.data.length; i += 4) {
    const v = Math.random() * 255;
    d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
    d.data[i + 3] = 255;
  }
  g.putImageData(d, 0, 0);
  return c.toDataURL();
}

async function loadShapes() {
  await Promise.all(Object.values(SHAPES).map(async (shape) => {
    if (shape.cells) return;
    const svg = await (await fetch(shape.file)).text();
    shape.cells = parse(/ d="([^"]+)"/.exec(svg)[1]);
  }));
}

function layout() {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = innerWidth;
  const h = innerHeight;
  const lk = w < h * 0.9 ? SHAPES.tall : SHAPES.wide;
  const p = Math.max(3, Math.floor(Math.min((w * 0.84) / lk.cols, (h * lk.height) / lk.rows)));
  const lw = lk.cols * p;
  const lh = lk.rows * p;
  const pad = 4 * p;
  const L = {
    dpr, w, h, p, lw, lh, pad, gap: Math.max(1, Math.round(p * 0.14)), rows: lk.rows, eye: lk.eye,
    left: Math.round((w - lw) / 2), top: Math.round(h * 0.42 - lh / 2),
    cells: lk.cells.map(([x, y]) => [x, y, litAt(x, y, lk)]),
  };
  const bw = (lw + 2 * pad) * dpr;
  const bh = (lh + 2 * pad) * dpr;
  // The phosphor, what's still hot, and two blurs of them for the glow (drawn small, scaled up).
  L.logo = canvas(bw, bh);
  L.hot = canvas(bw, bh);
  L.soft = canvas(bw / 6, bh / 6);
  L.wide = canvas(bw / 18, bh / 18);
  L.hotSoft = canvas(bw / 8, bh / 8);
  return L;
}

// A sub-pixel lands white-hot when the beam passes and cools to the paper colour.
function paintLogo(L, t) {
  const g = L.logo.getContext('2d');
  const gh = L.hot.getContext('2d');
  for (const c of [g, gh]) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, L.logo.width, L.logo.height);
    c.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
  }
  const s = L.p - L.gap;
  for (const [x, y, t0] of L.cells) {
    if (t < t0) continue;
    const heat = Math.exp(-(t - t0) / HOT_MS);
    const X = L.pad + x * L.p;
    const Y = L.pad + y * L.p;
    g.fillStyle = 'rgb(232, 232, 226)';
    g.fillRect(X, Y, s, s);
    if (heat > 0.02) {
      g.fillStyle = `rgba(255, 255, 255, ${heat})`;
      g.fillRect(X, Y, s, s);
      gh.fillStyle = `rgba(255, 255, 255, ${heat})`;
      gh.fillRect(X - L.gap, Y - L.gap, s + 2 * L.gap, s + 2 * L.gap);
    }
  }
}

function shrink(src, dst) {
  const g = dst.getContext('2d');
  g.clearRect(0, 0, dst.width, dst.height);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, dst.width, dst.height);
}

function tint(src, colour) {
  const c = canvas(src.width, src.height);
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = colour;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

function paint(now) {
  if (!crt) return;
  crt.raf = requestAnimationFrame(paint);
  const t = now - crt.start;
  const { L, ctx: g } = crt;
  g.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  g.fillStyle = '#0a0a0a';
  g.fillRect(0, 0, L.w, L.h);

  // The tube warms up: a line across the middle, opening into a flash that fades.
  if (t >= T.line[0] && t < T.open[1]) {
    const k1 = ease(span(T.line, t));
    const k2 = span(T.open, t);
    const w = L.w * k1;
    const h = Math.max(2, L.h * ease(k2) * 0.9);
    g.globalAlpha = t < T.open[0] ? 1 : 0.85 * (1 - k2) ** 1.6;
    g.fillStyle = '#f4f4f4';
    g.shadowColor = 'rgba(244, 244, 244, 0.9)';
    g.shadowBlur = 28;
    g.fillRect((L.w - w) / 2, (L.h - h) / 2, w, h);
    g.shadowBlur = 0;
    g.globalAlpha = 1;
  }
  if (t >= T.open[0] && !crt.on) {
    crt.on = true;
    crt.el.classList.add('on');
  }

  if (t >= T.pass1[0]) {
    if (!crt.done) {
      paintLogo(L, t);
      shrink(L.logo, L.soft);
      shrink(L.logo, L.wide);
      shrink(L.hot, L.hotSoft);
      if (t > SETTLED) crt.done = true;
    }
    const x0 = L.left - L.pad;
    const y0 = L.top - L.pad;
    const bw = L.lw + 2 * L.pad;
    const bh = L.lh + 2 * L.pad;
    // Glow first, the phosphor on top.
    g.globalCompositeOperation = 'lighter';
    const breathe = 0.05 * Math.sin(t / 900);
    g.globalAlpha = 0.28 + breathe;
    g.drawImage(L.wide, x0, y0, bw, bh);
    g.globalAlpha = 0.34 + breathe;
    g.drawImage(L.soft, x0, y0, bw, bh);
    if (!crt.done) {
      g.globalAlpha = 0.9;
      g.drawImage(L.hotSoft, x0, y0, bw, bh);
    }
    g.globalAlpha = 1;
    // The three guns land apart and converge.
    const off = t < T.converge[0] ? 0 : 5 * (1 - ease(span(T.converge, t)));
    if (off > 0.15) {
      crt.red ||= tint(L.logo, 'rgb(232, 0, 0)');
      crt.cyan ||= tint(L.logo, 'rgb(0, 232, 226)');
      g.drawImage(crt.red, x0 - off, y0, bw, bh);
      g.drawImage(crt.cyan, x0 + off, y0, bw, bh);
    } else {
      g.globalCompositeOperation = 'source-over';
      g.drawImage(L.logo, x0, y0, bw, bh);
    }
    g.globalCompositeOperation = 'source-over';
    // Once it's settled, the raven blinks now and then while it waits.
    const since = t - (T.converge[1] + 700);
    if (since > 0 && since % T.blink < 170) {
      g.fillStyle = '#0a0a0a';
      for (const [x, y] of L.eye) g.fillRect(L.left + x * L.p - 1, L.top + y * L.p - 1, L.p + 1, L.p + 1);
    }
  }

  // The beam itself, sweeping down while it paints.
  for (const pass of [T.pass1, T.pass2]) {
    if (t < pass[0] || t > pass[1]) continue;
    const rows = ((t - pass[0]) / (pass[1] - pass[0])) * L.rows;
    const y = L.top + rows * L.p;
    const across = g.createLinearGradient(0, 0, L.w, 0);
    across.addColorStop(0, 'rgba(244, 244, 244, 0)');
    across.addColorStop(0.5 - L.lw / L.w / 2, 'rgba(244, 244, 244, 0.22)');
    across.addColorStop(0.5 + L.lw / L.w / 2, 'rgba(244, 244, 244, 0.22)');
    across.addColorStop(1, 'rgba(244, 244, 244, 0)');
    g.fillStyle = across;
    g.shadowColor = 'rgba(244, 244, 244, 0.7)';
    g.shadowBlur = 14;
    g.fillRect(0, y - 1, L.w, 2);
    g.fillStyle = 'rgba(255, 255, 255, 0.95)';
    g.shadowBlur = 22;
    g.fillRect(L.left + (rows % 1) * L.lw - 3, y - 2, 6, 4);
    g.shadowBlur = 0;
  }

  // Words, then the prompt.
  const typed = Math.max(0, Math.min(TAGLINE.length, Math.floor((t - T.tag) / T.char) + 1));
  if (t >= T.tag && typed !== crt.typed) {
    crt.typed = typed;
    crt.text.textContent = TAGLINE.slice(0, typed);
    if (!crt.cursor.isConnected) crt.tag.append(crt.cursor);
  }
  if (t >= T.press && !crt.prompted) {
    crt.prompted = true;
    crt.press.classList.add('show');
  }
}

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
};

export async function playIntro() {
  try {
    await loadShapes();
  } catch {
    return; // no lockups to draw: straight on to setup
  }
  grain ||= noise();
  const root = el('div', 'crt');
  root.setAttribute('role', 'img');
  root.setAttribute('aria-label', `munin. ${TAGLINE}`);
  const cv = el('canvas');
  const noiseLayer = el('div', 'grain');
  noiseLayer.style.backgroundImage = `url(${grain})`;
  const tag = el('p', 'tagline');
  tag.setAttribute('aria-hidden', 'true');
  const text = el('span');
  tag.append(text);
  const press = el('p', 'press', touch ? 'Tap to begin' : 'Press any key');
  root.append(cv, el('div', 'roll'), el('div', 'scan'), noiseLayer, el('div', 'vignette'), tag, press);
  document.body.append(root);

  return new Promise((resolve) => {
    crt = { el: root, tag, text, cursor: el('span', 'k'), press, ctx: cv.getContext('2d'), start: performance.now(), raf: 0, typed: -1, resolve };
    const size = () => {
      crt.L = layout();
      cv.width = Math.round(crt.L.w * crt.L.dpr);
      cv.height = Math.round(crt.L.h * crt.L.dpr);
      crt.done = false;
      crt.red = crt.cyan = null;
      tag.style.top = `${crt.L.top + crt.L.lh + Math.max(28, 2.2 * crt.L.p)}px`;
    };
    size();
    crt.resize = size;
    addEventListener('resize', size);
    addEventListener('keydown', onKey, true);
    root.addEventListener('pointerdown', () => crt && advance());
    if (calm.matches) crt.start -= T.press; // no motion: the finished picture, waiting
    crt.raf = requestAnimationFrame(paint);
  });
}

function onKey(e) {
  if (!crt || e.repeat || ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab'].includes(e.key)) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') return finish();
  advance();
}

// Before the prompt, a key shows the finished picture; after it, a key switches the tube off.
function advance() {
  if (performance.now() - crt.start < T.press) {
    crt.start = performance.now() - T.press;
    crt.done = false;
    crt.red = crt.cyan = null;
    return;
  }
  if (crt.closing) return;
  crt.closing = true;
  const off = calm.matches
    ? crt.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: 'forwards' })
    : crt.el.animate([
      { transform: 'scale(1, 1)', filter: 'brightness(1)' },
      { transform: 'scale(1, 0.005)', filter: 'brightness(2.4)', offset: 0.5 },
      { transform: 'scale(0.003, 0.005)', filter: 'brightness(4)', offset: 0.85 },
      { transform: 'scale(0, 0)', filter: 'brightness(4)', opacity: 0 },
    ], { duration: 860, easing: 'cubic-bezier(.65, 0, .35, 1)', fill: 'forwards' });
  off.onfinish = finish;
}

function finish() {
  if (!crt) return;
  cancelAnimationFrame(crt.raf);
  removeEventListener('resize', crt.resize);
  removeEventListener('keydown', onKey, true);
  crt.el.remove();
  const { resolve } = crt;
  crt = null;
  resolve();
}
