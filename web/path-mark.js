// An agent's mark drawn from its outline (24 units square, like simple-icons) onto the same pixel
// grids as an agent's face, in the brand's dither. `paint(cover, x, y)` picks each cell's colour,
// or null for none, from how much of the cell the outline covers (0 to 1) and where the cell sits
// in the mark (0 to 1 across and down).

const gridFor = (size) => (size <= 20 ? size : size <= 40 ? 24 : size < 100 ? 36 : 48);
const SAMPLES = 8; // per cell, each way, to measure how much of a cell the outline covers

// How much of each cell the outline covers, on an n×n grid with a cell's margin round it.
function coverage(n, path) {
  const side = n * SAMPLES;
  const c = document.createElement('canvas');
  c.width = c.height = side;
  const g = c.getContext('2d', { willReadFrequently: true });
  const inner = n - 2;
  g.translate(SAMPLES, SAMPLES);
  g.scale((inner * SAMPLES) / 24, (inner * SAMPLES) / 24);
  g.fill(path, 'evenodd');
  const alpha = g.getImageData(0, 0, side, side).data;
  const cells = new Float32Array(n * n);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) cells[Math.floor(y / SAMPLES) * n + Math.floor(x / SAMPLES)] += alpha[(y * side + x) * 4 + 3] / 255;
  }
  return cells.map((v) => v / (SAMPLES * SAMPLES));
}

// The usual rule for a mark in one colour: solid where the outline fills a cell, the checkerboard
// on its soft edges, and more of it toward the bottom, like munin's own mark.
export const shaded = (colour) => (cover, x, y, odd) => {
  if (cover < 0.25) return null;
  return cover >= (y >= 0.6 ? 0.8 : 0.5) || !odd ? colour : null;
};

const drawn = new Map();

export function pathMark(name, path, paint, { size = 18, label } = {}) {
  const dpr = Math.min(3, Math.ceil(window.devicePixelRatio || 1));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size * dpr;
  canvas.style.width = canvas.style.height = `${size}px`;
  canvas.className = `figbot ${name}-mark`;
  if (label) {
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', label);
  } else {
    canvas.setAttribute('aria-hidden', 'true');
  }
  const key = `${name}|${size}|${dpr}`;
  if (!drawn.has(key)) {
    const out = document.createElement('canvas');
    out.width = out.height = size * dpr;
    const g = out.getContext('2d');
    const n = gridFor(size);
    const px = (size * dpr) / n;
    const cells = coverage(n, path);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const colour = paint(cells[j * n + i], (i - 0.5) / (n - 2), (j - 0.5) / (n - 2), (i + j) % 2 === 1);
        if (!colour) continue;
        g.fillStyle = colour;
        g.fillRect(Math.round(i * px), Math.round(j * px), Math.ceil(px), Math.ceil(px));
      }
    }
    drawn.set(key, out);
  }
  canvas.getContext('2d').drawImage(drawn.get(key), 0, 0);
  return canvas;
}
