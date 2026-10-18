// opencode's mark (opencode.ai), in the brand's dither, for agents that are opencode: a white frame
// with a grey block low in its window. Here the frame is solid and the grey block is the
// checkerboard, which is how white reads as grey in munin's dither.

const COLOUR = '#EDEDED';
// opencode's proportions (simple-icons, 24 units tall): the frame is 20 wide, its sides 5 thick and
// its top and bottom 4.8; the grey block fills the lower two thirds of the window.
const SCALE = 0.62; // the mark's height as a share of its square, as in opencode's icon

export const isOpencode = (name) => /^open-?code/i.test(name || '');

const gridFor = (size) => (size <= 20 ? size : size <= 40 ? 24 : size < 100 ? 36 : 48);

const drawn = new Map();

export function opencodeMark({ size = 18, label } = {}) {
  const dpr = Math.min(3, Math.ceil(window.devicePixelRatio || 1));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size * dpr;
  canvas.style.width = canvas.style.height = `${size}px`;
  canvas.className = 'figbot opencode-mark';
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
    // Straight lines, so whole cells: the frame's edges stay crisp at every size.
    const h = Math.round(n * SCALE);
    const w = Math.round((h * 20) / 24);
    const side = Math.max(1, Math.round((h * 5) / 24));
    const top = Math.max(1, Math.round((h * 4.8) / 24));
    const block = top + Math.round((h - 2 * top) / 3);
    const [x0, y0] = [Math.floor((n - w) / 2), Math.floor((n - h) / 2)];
    g.fillStyle = COLOUR;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const inWindow = x >= side && x < w - side && y >= top && y < h - top;
        const solid = !inWindow;
        const grey = inWindow && y >= block && (x + y) % 2 === 0;
        if (solid || grey) g.fillRect(Math.round((x0 + x) * px), Math.round((y0 + y) * px), Math.ceil(px), Math.ceil(px));
      }
    }
    drawn.set(key, out);
  }
  canvas.getContext('2d').drawImage(drawn.get(key), 0, 0);
  return canvas;
}
