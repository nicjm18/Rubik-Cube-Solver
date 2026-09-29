// Webcam capture + sticker color sampling/classification.

const GRID_FRACTION = 0.62; // grid size relative to the shorter video side
const SAMPLE_FRACTION = 0.4; // sampled patch size relative to a cell

export class Scanner {
  constructor(video, overlay) {
    this.video = video;
    this.overlay = overlay;
    this.ctx = overlay.getContext('2d');
    this.work = document.createElement('canvas');
    this.workCtx = this.work.getContext('2d', { willReadFrequently: true });
    this.stream = null;
    this.live = null; // latest 9 sampled RGB colors
    this.running = false;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.sample();
      this.draw();
      requestAnimationFrame(loop);
    };
    loop();
  }

  stop() {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  grid() {
    const w = this.video.videoWidth, h = this.video.videoHeight;
    const size = Math.min(w, h) * GRID_FRACTION;
    return { x: (w - size) / 2, y: (h - size) / 2, size, cell: size / 3 };
  }

  /** Median RGB of a patch in the middle of each of the 9 cells, in raw (unmirrored) camera coords. */
  sample() {
    const w = this.video.videoWidth, h = this.video.videoHeight;
    if (!w || !h) return;
    if (this.work.width !== w) { this.work.width = w; this.work.height = h; }
    this.workCtx.drawImage(this.video, 0, 0, w, h);
    const g = this.grid();
    const patch = Math.max(4, Math.round(g.cell * SAMPLE_FRACTION));
    const colors = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const cx = g.x + (c + 0.5) * g.cell, cy = g.y + (r + 0.5) * g.cell;
        const data = this.workCtx.getImageData(Math.round(cx - patch / 2), Math.round(cy - patch / 2), patch, patch).data;
        colors.push(medianRGB(data));
      }
    }
    this.live = colors;
  }

  /** Overlay is mirrored with CSS together with the video, so we draw in raw camera coordinates. */
  draw() {
    const w = this.video.videoWidth, h = this.video.videoHeight;
    if (this.overlay.width !== w) { this.overlay.width = w; this.overlay.height = h; }
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    const g = this.grid();
    // dim outside the grid
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, w, h);
    ctx.clearRect(g.x, g.y, g.size, g.size);
    ctx.lineWidth = Math.max(2, g.size / 150);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const x = g.x + c * g.cell, y = g.y + r * g.cell;
        roundRect(ctx, x + g.cell * 0.06, y + g.cell * 0.06, g.cell * 0.88, g.cell * 0.88, g.cell * 0.12);
        ctx.stroke();
        const col = this.live?.[r * 3 + c];
        if (col) {
          ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
          const s = g.cell * 0.22;
          ctx.beginPath();
          ctx.arc(x + g.cell / 2, y + g.cell / 2, s, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }
  }

  /** Returns the 9 colors of the face currently in view, in facelet order (true, unmirrored view). */
  capture() {
    this.sample();
    return this.live ? this.live.map((c) => c.slice()) : null;
  }
}

function medianRGB(data) {
  const rs = [], gs = [], bs = [];
  for (let i = 0; i < data.length; i += 4) { rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]); }
  const med = (a) => { a.sort((x, y) => x - y); return a[a.length >> 1]; };
  return [med(rs), med(gs), med(bs)];
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---- Color classification -------------------------------------------------

/**
 * Color features for matching: brightness-normalized RGB (chromaticity) plus a little brightness.
 * Shadows and uneven light mostly scale brightness, so this is far more robust than raw RGB or Lab.
 */
export function colorFeatures([r, g, b]) {
  const sum = r + g + b + 1;
  return [(r / sum) * 300, (g / sum) * 300, (b / sum) * 300, ((r + g + b) / 3) * 0.15];
}

export function featureDist(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += (a[i] - b[i]) ** 2;
  return d;
}

/**
 * Classifies 54 samples into 6 groups of exactly 9, seeded with the 6 center stickers.
 * samples: { U: [9 rgb], R: [...], ... } in URFDLB face order.
 * Returns a 54-char facelet string of face letters.
 */
export function classify(samples, faces) {
  const all = [];
  faces.forEach((f) => samples[f].forEach((rgb, i) => all.push({ v: colorFeatures(rgb), face: f, i })));
  let means = faces.map((f) => colorFeatures(samples[f][4]));
  let labels = null;

  for (let iter = 0; iter < 6; iter++) {
    // Balanced greedy assignment: closest (sample, class) pairs first, 9 per class.
    const pairs = [];
    all.forEach((s, si) => means.forEach((m, k) => pairs.push([featureDist(s.v, m), si, k])));
    pairs.sort((a, b) => a[0] - b[0]);
    const next = new Array(all.length).fill(-1);
    const count = new Array(6).fill(0);
    // centers are fixed
    all.forEach((s, si) => { if (s.i === 4) { next[si] = faces.indexOf(s.face); count[next[si]]++; } });
    for (const [, si, k] of pairs) {
      if (next[si] !== -1 || count[k] >= 9) continue;
      next[si] = k;
      count[k]++;
    }
    labels = next;
    means = faces.map((_, k) => {
      const members = all.filter((_, si) => labels[si] === k);
      return members[0].v.map((_, j) => members.reduce((acc, s) => acc + s.v[j], 0) / members.length);
    });
  }
  return labels.map((k) => faces[k]).join('');
}
