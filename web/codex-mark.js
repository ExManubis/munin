// OpenAI's mark, in the brand's dither, for agents that are Codex (codex, codex-1 and on, or
// named after OpenAI or GPT). Drawn from OpenAI's own mark (simple-icons, 24 units square) onto
// the same pixel grids as an agent's face, in white. Its strokes are thin, so they stay solid;
// the checkerboard takes their soft edges, and more of them toward the bottom, like munin's
// own mark.

const COLOUR = '#EDEDED';
const KNOT = new Path2D('M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z');
const SHADE = 0.6; // below this share of the mark's height, the checkerboard

export const isCodex = (name) => /^(codex|openai|gpt)/i.test(name || '');

const gridFor = (size) => (size <= 20 ? size : size <= 40 ? 24 : size < 100 ? 36 : 48);
const SAMPLES = 8; // per cell, each way, to measure how much of a cell the mark covers

// How much of each cell the mark covers, 0 to 1, on an n×n grid with a cell's margin round it.
function coverage(n) {
  const side = n * SAMPLES;
  const c = document.createElement('canvas');
  c.width = c.height = side;
  const g = c.getContext('2d', { willReadFrequently: true });
  const inner = n - 2;
  g.translate(SAMPLES, SAMPLES);
  g.scale((inner * SAMPLES) / 24, (inner * SAMPLES) / 24);
  g.fill(KNOT);
  const alpha = g.getImageData(0, 0, side, side).data;
  const cells = new Float32Array(n * n);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) cells[Math.floor(y / SAMPLES) * n + Math.floor(x / SAMPLES)] += alpha[(y * side + x) * 4 + 3] / 255;
  }
  return cells.map((v) => v / (SAMPLES * SAMPLES));
}

const drawn = new Map();

export function codexMark({ size = 18, label } = {}) {
  const dpr = Math.min(3, Math.ceil(window.devicePixelRatio || 1));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size * dpr;
  canvas.style.width = canvas.style.height = `${size}px`;
  canvas.className = 'figbot codex-mark';
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
    const cells = coverage(n);
    g.fillStyle = COLOUR;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const c = cells[j * n + i];
        if (c < 0.25) continue;
        const low = (j - 1 + 0.5) / (n - 2) >= SHADE;
        const solid = c >= (low ? 0.8 : 0.5);
        if (solid || (i + j) % 2 === 0) g.fillRect(Math.round(i * px), Math.round(j * px), Math.ceil(px), Math.ceil(px));
      }
    }
    drawn.set(key, out);
  }
  canvas.getContext('2d').drawImage(drawn.get(key), 0, 0);
  return canvas;
}
