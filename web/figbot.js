// Figbot, the halftone sphere with two eyes, ported from figment-engineering/figbot
// (src/model.ts and src/svg.ts). Every agent wears it in its own colour; its expression
// says what the agent is doing, or for a minute how the work is going (faceOf). Faces are
// drawn on small canvases; working faces look around and blink, idle ones blink now and then.

export const COLOURS = {
  white: '#EDEDED',
  ember: '#F2A65A',
  coral: '#F07C6B',
  rose: '#E98BB8',
  iris: '#A99BF5',
  sky: '#6FB3F2',
  teal: '#4FC7B8',
  moss: '#9CCB6B',
  straw: '#E3CF6E',
};

// What an agent is doing → Figbot's expression for it.
export const EXPRESSION = {
  working: 'thinking',
  idle: 'idle',
  asks: 'curious',
  failed: 'worried',
  paused: 'sleepy',
  finished: 'happy',
};

// What an agent's face shows: for a minute, the passing expression it set (excited, happy,
// worried; the runtime's set_expression), and otherwise its status. Status wins whenever you're
// needed or it's paused: an agent asking you something looks curious, whatever it set.
export function faceOf(agent, state = agent.state, at = Date.now()) {
  const passing = agent.expression;
  if (!passing || Date.parse(passing.until) <= at || state === 'asks' || state === 'paused') return state;
  return passing.pose;
}

// The model ------------------------------------------------------------------------

const BG = -1;
const HOLE = 0;
const DEFAULT_EYE = { scale: 1, sx: 1, lid: 0, low: 0, slant: 0 };
const DEFAULT_POSE = { shape: 'oval', open: 1, gx: 0, gy: 0, tilt: 0, squash: 0, bob: 0, glint: true, exposure: 1, eyes: [DEFAULT_EYE, DEFAULT_EYE] };
const BODY = { cx: 0.58, cy: 0.7, R: 0.64 };
// eye centre x, y and the sign of its inner side
const SLOTS = [[0.37, 0.45, 1], [0.69, 0.41, -1]];
const RX = 0.105, RY = 0.16;
const GLINT_R = 0.034, STROKE = 0.034, MIN_OPEN = 0.01;

const norm = (v) => {
  const m = Math.hypot(...v);
  return v.map((x) => x / m);
};
const LIGHT = norm([-0.55, -0.65, 0.55]);
const HALF = norm([LIGHT[0], LIGHT[1], LIGHT[2] + 1]);

const eye = (o = {}) => ({ ...DEFAULT_EYE, ...o });
const pose = (o) => ({ ...DEFAULT_POSE, ...o });

const POSES = {
  idle: pose({}),
  curious: pose({ tilt: 0.2, gx: 0.035, gy: -0.03, eyes: [eye({ scale: 0.86, lid: 0.12 }), eye({ scale: 1.16 })] }),
  happy: pose({ shape: 'arc', squash: 0.05, bob: -0.02 }),
  excited: pose({ shape: 'chevron', squash: 0.07, bob: -0.03, tilt: -0.08 }),
  thinking: pose({ tilt: -0.1, gx: 0.04, gy: -0.06, glint: false, eyes: [eye({ scale: 0.95, low: 0.38 }), eye({ scale: 0.95, low: 0.38 })] }),
  sleepy: pose({ tilt: 0.24, gy: 0.025, glint: false, exposure: 0.7, bob: 0.02, eyes: [eye({ lid: 0.72 }), eye({ lid: 0.66 })] }),
  worried: pose({ gx: -0.02, gy: 0.03, squash: 0.03, eyes: [eye({ scale: 0.92, lid: 0.3, slant: 1.4 }), eye({ scale: 0.92, lid: 0.3, slant: 1.4 })] }),
};

function seg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const k = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - ax - vx * k, py - ay - vy * k);
}

// HOLE or 1 (glint) inside an eye, null on skin. (u, v) is in face space.
function eyeAt(p, u, v) {
  const open = Math.max(p.open, MIN_OPEN);
  for (let k = 0; k < 2; k++) {
    const [x0, y0, inner] = SLOTS[k];
    const e = p.eyes[k];
    const ex = x0 + p.gx, ey = y0 + p.gy;
    const rx = RX * e.scale * e.sx, ry = RY * e.scale;
    const dx = u - ex, dy = v - ey;
    if (Math.abs(dx) > rx * 1.3 || Math.abs(dy) > ry * 1.3) continue;

    if (p.shape === 'arc') {
      const d = Math.hypot(dx / rx, dy / (ry * 0.8 * open));
      if (dy < 0.02 && d < 1 && d > 0.42) return HOLE;
      continue;
    }
    if (p.shape === 'chevron') {
      const tx = ex + inner * rx * 0.75, bx = ex - inner * rx * 0.85, arm = ry * 0.7 * open;
      if (Math.min(seg(u, v, bx, ey - arm, tx, ey), seg(u, v, bx, ey + arm, tx, ey)) < STROKE) return HOLE;
      continue;
    }
    if ((dx / rx) ** 2 + (dy / (ry * open)) ** 2 >= 1) continue;
    const top = ey - ry + e.lid * 2 * ry - e.slant * inner * dx;
    const bottom = ey + ry - e.low * 2 * ry;
    if (v < top || v > bottom) continue;
    if (p.glint && p.open > 0.6 && e.lid < 0.25 && Math.hypot(dx + rx * 0.32, dy + ry * 0.42) < GLINT_R * e.scale) return 1;
    return HOLE;
  }
  return null;
}

// BG outside the body, HOLE in an eye, otherwise the dot's luminance in (0, 1].
function sample(p, u, v) {
  const Rx = BODY.R * (1 + p.squash), Ry = BODY.R * (1 - p.squash);
  const cx = BODY.cx, cy = BODY.cy + p.bob + 0.6 * (BODY.R - Ry);
  const x = (u - cx) / Rx, y = (v - cy) / Ry;
  const d2 = x * x + y * y;
  if (d2 > 1) return BG;

  // face space: undo the tilt about the body centre; eyes ride along with bob and squash
  const c = Math.cos(-p.tilt), s = Math.sin(-p.tilt);
  const fu = cx + (u - cx) * c - (v - cy) * s;
  const fv = BODY.cy + (u - cx) * s + (v - cy) * c;
  const hit = eyeAt(p, fu, fv);
  if (hit !== null) return hit;

  const z = Math.sqrt(1 - d2);
  const ndl = Math.max(0, x * LIGHT[0] + y * LIGHT[1] + z * LIGHT[2]);
  const ndh = Math.max(0, x * HALF[0] + y * HALF[1] + z * HALF[2]);
  const lum = 0.06 + 0.78 * ndl + 0.5 * ndh ** 40 + 0.12 * (1 - z) ** 3;
  return Math.min(1, Math.max(Number.MIN_VALUE, p.exposure * lum));
}

// Dot radius as a fraction of a cell; 0 when there's no dot.
function dotRadius(lum) {
  if (lum <= 0) return 0;
  const r = Math.sqrt(lum) * 0.52;
  return r < 0.07 ? 0 : r;
}

// Blending, from figment's src/model.ts and src/timeline.ts ---------------------------

const TRANSITION = 0.35; // seconds from one expression to the next
const mix = (a, b, k) => a * (1 - k) + b * k;
const smoothstep = (k) => {
  const x = Math.min(1, Math.max(0, k));
  return x * x * (3 - 2 * x);
};
const lerpEye = (a, b, k) => ({ scale: mix(a.scale, b.scale, k), sx: mix(a.sx, b.sx, k), lid: mix(a.lid, b.lid, k), low: mix(a.low, b.low, k), slant: mix(a.slant, b.slant, k) });

// Numbers interpolate; the eyes' shape and the glint switch halfway.
function lerp(a, b, k) {
  const late = k >= 0.5;
  return {
    shape: late ? b.shape : a.shape, open: mix(a.open, b.open, k), gx: mix(a.gx, b.gx, k), gy: mix(a.gy, b.gy, k),
    tilt: mix(a.tilt, b.tilt, k), squash: mix(a.squash, b.squash, k), bob: mix(a.bob, b.bob, k),
    glint: late ? b.glint : a.glint, exposure: mix(a.exposure, b.exposure, k), eyes: [lerpEye(a.eyes[0], b.eyes[0], k), lerpEye(a.eyes[1], b.eyes[1], k)],
  };
}

// a → b at raw progress k; a change of the eyes' shape hides behind a blink.
function transition(a, b, k) {
  const p = lerp(a, b, smoothstep(k));
  if (a.shape !== b.shape) p.open *= 1 - 0.94 * (1 - Math.abs(2 * Math.min(1, Math.max(0, k)) - 1));
  return p;
}

// Drawing ---------------------------------------------------------------------------

// Cells across: one per pixel up to 20 px; 36 px uses 24 (1.5 px a dot), 72 px uses 36, and a
// big face (100 px and up) a finer 48.
function gridFor(size) {
  if (size <= 20) return size;
  if (size >= 100) return 48;
  return size <= 40 ? 24 : 36;
}

function draw(canvas, p, colour, size) {
  const dpr = canvas.width / size;
  const n = gridFor(size);
  const cell = (size / n) * dpr;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = colour;
  g.beginPath();
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const r = dotRadius(sample(p, (i + 0.5) / n, (j + 0.5) / n)) * cell;
      if (r <= 0) continue;
      const x = (i + 0.5) * cell, y = (j + 0.5) * cell;
      g.moveTo(x + r, y);
      g.arc(x, y, r, 0, Math.PI * 2);
    }
  }
  g.fill();
}

const still = new Map(); // drawn faces by colour, expression and size, copied rather than redrawn
// What each face (an agent's, at a size) last showed, so a new expression blends in. Screens
// draw new canvases when they redraw, so this outlives them.
const shown = new Map();

// A Figbot as a <canvas>. `colour` is a name from COLOURS (or a hex), `state` a key of
// EXPRESSION. Faces move and blend from one expression to the next, as `seed` (the agent)
// changes state; `animate: false` keeps one still.
export function figbot({ colour = 'white', state = 'idle', size = 18, label, seed = '', animate = true, cls } = {}) {
  const hex = COLOURS[colour] || colour || COLOURS.white;
  const expression = EXPRESSION[state] || state;
  const dpr = Math.min(3, Math.ceil(window.devicePixelRatio || 1));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size * dpr;
  canvas.style.width = canvas.style.height = `${size}px`;
  canvas.className = ['figbot', state === 'paused' && 'paused', cls].filter(Boolean).join(' ');
  if (label) {
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', label);
  } else {
    canvas.setAttribute('aria-hidden', 'true');
  }

  const moves = animate && !calm.matches;
  const change = moves && seed ? changeOf(`${seed}|${size}`, expression) : null;
  const entry = { canvas, hex, expression, size, change, hash: hashOf(seed || `${hex}${expression}`) };
  if (change) {
    draw(canvas, poseAt(entry, performance.now() / 1000), hex, size); // mid-blend: not the still
  } else {
    const key = `${hex}|${expression}|${size}|${dpr}`;
    let drawn = still.get(key);
    if (!drawn) {
      drawn = document.createElement('canvas');
      drawn.width = drawn.height = size * dpr;
      draw(drawn, POSES[expression] || POSES.idle, hex, size);
      still.set(key, drawn);
    }
    canvas.getContext('2d').drawImage(drawn, 0, 0);
  }

  if (moves) {
    moving.add(entry);
    if (!frame) frame = requestAnimationFrame(tick);
  }
  return canvas;
}

// Motion -------------------------------------------------------------------------------

const calm = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: true }; // no window: a test
const moving = new Set();
let frame = 0;
let last = 0;

function hashOf(text) {
  let n = 2166136261;
  for (const ch of text) n = Math.imul(n ^ ch.codePointAt(0), 16777619) >>> 0;
  return n;
}

// 0..1 openness for a blink every 4–7 s; phase and period come from the face's seed, so
// one agent's faces blink together and keep blinking through redraws.
function blinkAt(t, hash) {
  const period = 4 + (hash % 3000) / 1000;
  const phase = ((hash >>> 12) % 1000) / 1000 * period;
  const d = Math.abs(((t + phase) % period) - period / 2);
  return d < 0.09 ? Math.max(0.06, d / 0.09) : 1;
}

// The blend a face is in, if its expression changed in the last moment: { from, at }.
function changeOf(id, expression) {
  const now = performance.now() / 1000;
  const was = shown.get(id);
  if (was && was.expression !== expression) {
    const change = { expression, from: was.expression, at: now };
    shown.set(id, change);
    return change;
  }
  if (!was) shown.set(id, { expression, from: null, at: 0 });
  return was?.from && now - was.at < TRANSITION ? was : null;
}

function poseAt(entry, t) {
  const to = POSES[entry.expression] || POSES.idle;
  const { change } = entry;
  const k = change ? (t - change.at) / TRANSITION : 1;
  const base = k < 1 ? transition(POSES[change.from] || POSES.idle, to, Math.max(0, k)) : to;
  const p = { ...base, open: base.open * blinkAt(t, entry.hash), bob: base.bob + 0.006 * Math.sin(t * 1.35) };
  if (entry.expression === 'thinking') {
    // looking about while it works: big enough to read at 18 px
    const phase = (entry.hash % 628) / 100;
    p.gx = base.gx + 0.05 * Math.sin(t * 1.6 + phase);
    p.gy = base.gy + 0.015 * Math.sin(t * 0.9 + phase);
  }
  if (entry.expression === 'idle' || entry.expression === 'sleepy' || entry.expression === 'happy') {
    // now and then it glances about, and comes back
    const phase = (entry.hash % 628) / 100;
    p.gx = base.gx + 0.035 * Math.sin(t * 0.55 + phase) ** 3;
    p.gy = base.gy + 0.012 * Math.sin(t * 0.4 + phase);
  }
  return p;
}

function tick(now) {
  frame = 0;
  if (!moving.size || calm.matches) return;
  frame = requestAnimationFrame(tick);
  if (document.hidden || now - last < 50) return; // about 20 frames a second is plenty
  last = now;
  const t = now / 1000;
  for (const entry of moving) {
    if (!entry.canvas.isConnected) {
      // drawn but not on the page yet, or taken off it by a redraw
      entry.missed = (entry.missed || 0) + 1;
      if (entry.missed > 40) moving.delete(entry);
      continue;
    }
    entry.missed = 0;
    draw(entry.canvas, poseAt(entry, t), entry.hex, entry.size);
  }
}
