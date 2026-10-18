// Claude's spark, in the brand's dither, for agents that are Claude (claude-code, or
// claude-1 and on from `munin run`): solid at the heart, its rays thinning to a checkerboard
// toward their tips. Drawn in square pixels on the same grid sizes as an agent's face.

const COLOUR = '#D97757';
const RAYS = 12;
// Each ray's length, as a share of the radius, going round: uneven, like the real spark.
const LENGTHS = [1, 0.8, 0.92, 0.76, 0.98, 0.84, 0.9, 0.78, 1, 0.82, 0.94, 0.8];

export const isClaude = (name) => /^claude/i.test(name || '');

const gridFor = (size) => (size <= 20 ? size : size <= 40 ? 24 : size < 100 ? 36 : 48);

// 0 for no pixel, 1 for solid, 0.5 for the dither's half.
function cell(u, v) {
  const r = Math.hypot(u, v);
  if (r < 0.1) return 1;
  const a = Math.atan2(v, u) + Math.PI / 2;
  const step = (2 * Math.PI) / RAYS;
  const k = Math.round(a / step);
  const len = LENGTHS[((k % RAYS) + RAYS) % RAYS];
  if (r > len) return 0;
  const off = Math.abs(r * Math.sin(a - k * step)); // how far from the ray's middle
  const half = 0.032 + 0.04 * Math.sin((Math.PI * r) / len); // thin at both ends, fuller in the middle
  if (off > half) return 0;
  return r < len * 0.62 ? 1 : 0.5;
}

const drawn = new Map();

export function claudeMark({ size = 18, label } = {}) {
  const dpr = Math.min(3, Math.ceil(window.devicePixelRatio || 1));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size * dpr;
  canvas.style.width = canvas.style.height = `${size}px`;
  canvas.className = 'figbot claude-mark';
  if (label) {
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', label);
  } else {
    canvas.setAttribute('aria-hidden', 'true');
  }
  const key = `${size}|${dpr}`;
  if (!drawn.has(key)) {
    const out = document.createElement('canvas');
    out.width = out.height = size * dpr;
    const g = out.getContext('2d');
    const n = gridFor(size);
    const px = (size * dpr) / n;
    g.fillStyle = COLOUR;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const c = cell(((i + 0.5) / n) * 2 - 1, ((j + 0.5) / n) * 2 - 1);
        if (c === 1 || (c === 0.5 && (i + j) % 2 === 0)) g.fillRect(Math.round(i * px), Math.round(j * px), Math.ceil(px), Math.ceil(px));
      }
    }
    drawn.set(key, out);
  }
  canvas.getContext('2d').drawImage(drawn.get(key), 0, 0);
  return canvas;
}
