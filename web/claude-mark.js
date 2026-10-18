// Claude's spark, in the brand's dither, for agents that are Claude (claude-code, or
// claude-1 and on from `munin run`). Drawn from Claude's own mark (simple-icons, 24 units
// square) onto the same pixel grids as an agent's face: solid at the heart, its rays thinning
// to a checkerboard toward their tips.

const COLOUR = '#D97757';
const SPARK = new Path2D('m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z');
const CENTRE = [12.6, 12]; // where the rays meet, in the mark's own units
const TIPS = 0.86; // past this share of the radius, rays thin to the checkerboard

export const isClaude = (name) => /^claude/i.test(name || '');

const gridFor = (size) => (size <= 20 ? size : size <= 40 ? 24 : size < 100 ? 36 : 48);
const SAMPLES = 8; // per cell, each way, to measure how much of a cell the mark covers

// How much of each cell the mark covers, 0 to 1, on an n×n grid with a cell's margin round it.
function coverage(n) {
  const side = n * SAMPLES;
  const c = document.createElement('canvas');
  c.width = c.height = side;
  const g = c.getContext('2d', { willReadFrequently: true });
  const inner = n - 2; // a cell clear on each side
  g.translate(SAMPLES, SAMPLES);
  g.scale((inner * SAMPLES) / 24, (inner * SAMPLES) / 24);
  g.fill(SPARK);
  const alpha = g.getImageData(0, 0, side, side).data;
  const cells = new Float32Array(n * n);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) cells[Math.floor(y / SAMPLES) * n + Math.floor(x / SAMPLES)] += alpha[(y * side + x) * 4 + 3] / 255;
  }
  return cells.map((v) => v / (SAMPLES * SAMPLES));
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
    const cells = coverage(n);
    const at = (u) => 0.5 + 1 + (u / 24) * (n - 2) - 0.5; // a mark coordinate → cell index
    const [mx, my] = [at(CENTRE[0]), at(CENTRE[1])];
    const reach = (n - 2) / 2;
    g.fillStyle = COLOUR;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const c = cells[j * n + i];
        if (c < 0.3) continue;
        const r = Math.hypot(i - mx, j - my) / reach;
        // Solid where the mark fills the cell, toward the heart; the checkerboard where it only
        // grazes it, and out at the tips.
        const solid = c >= 0.6 && r < TIPS;
        if (solid || (i + j) % 2 === 0) g.fillRect(Math.round(i * px), Math.round(j * px), Math.ceil(px), Math.ceil(px));
      }
    }
    drawn.set(key, out);
  }
  canvas.getContext('2d').drawImage(drawn.get(key), 0, 0);
  return canvas;
}
