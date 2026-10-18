// pi's mark (pi.dev), in the brand's dither, for agents that are pi (pi, pi-1 and on). The mark is
// three blocks on a 4×4 grid, in pi's colours: solid at the top, thinning to a checkerboard
// toward the bottom, like munin's own mark.

// The blocks as cells of the 4×4 grid: [colour, [[column, row], …]].
const BLOCKS = [
  ['#F09082', [[0, 0], [1, 0], [2, 0], [2, 1]]],
  ['#4D9ABF', [[0, 1], [0, 2], [1, 2], [0, 3]]],
  ['#F1BE58', [[3, 2], [3, 3]]],
];
const SHADE = 0.6; // below this share of the mark's height, the checkerboard
const SCALE = 0.59; // the mark's share of its square, as on pi.dev

export const isPi = (name) => /^pi(?![a-z])/i.test(name || '');

const gridFor = (size) => (size <= 20 ? size : size <= 40 ? 24 : size < 100 ? 36 : 48);

const drawn = new Map();

export function piMark({ size = 18, label } = {}) {
  const dpr = Math.min(3, Math.ceil(window.devicePixelRatio || 1));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size * dpr;
  canvas.style.width = canvas.style.height = `${size}px`;
  canvas.className = 'figbot pi-mark';
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
    // Whole cells per block, so its edges stay crisp, centred in its square.
    const k = Math.max(1, Math.round((n * SCALE) / 4));
    const start = Math.floor((n - 4 * k) / 2);
    for (const [colour, cells] of BLOCKS) {
      g.fillStyle = colour;
      for (const [col, row] of cells) {
        for (let y = row * k; y < (row + 1) * k; y++) {
          for (let x = col * k; x < (col + 1) * k; x++) {
            const solid = (y + 0.5) / (4 * k) < SHADE;
            if (solid || (x + y) % 2 === 0) g.fillRect(Math.round((start + x) * px), Math.round((start + y) * px), Math.ceil(px), Math.ceil(px));
          }
        }
      }
    }
    drawn.set(key, out);
  }
  canvas.getContext('2d').drawImage(drawn.get(key), 0, 0);
  return canvas;
}
