// Webcam capture, live face detection, camera direction check, and sticker color classification.

import { detectFace } from './faceDetector.js';

const GRID_FRACTION = 0.62; // guide square size relative to the shorter video side
const SAMPLE_FRACTION = 0.4; // sampled patch size relative to a cell
const UNIFORM_DISTANCE = 70; // max RGB distance (L1) from a patch's median to count as "same color"
const MOTION_SIZE = [160, 90]; // downscaled frame used for the camera direction check
const DETECT_WIDTH = 640; // frames are downscaled to this width for OpenCV face detection
const PATCH_FRACTION = 0.4; // sampled patch size relative to the detected sticker spacing

export class Scanner {
  constructor(video, overlay) {
    this.video = video;
    this.overlay = overlay;
    this.ctx = overlay.getContext('2d');
    this.work = document.createElement('canvas');
    this.workCtx = this.work.getContext('2d', { willReadFrequently: true });
    this.small = document.createElement('canvas');
    [this.small.width, this.small.height] = MOTION_SIZE;
    this.smallCtx = this.small.getContext('2d', { willReadFrequently: true });
    this.stream = null;
    this.live = null; // latest frame reading, see sample()
    this.running = false;
    this.onFrame = null; // called with each frame reading while scanning
    this.progress = 0; // 0..1, drawn as a ring while a face is held still
    this.motion = null; // active camera direction check
    this.cv = null; // OpenCV, once loaded: faces are then found anywhere in the picture
    this.frame = null; // pixels of the current frame (read once per frame; reading pixels is slow)
    this.detFrame = null; // downscaled copy for face detection
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
      if (this.motion) this.trackMotion();
      else {
        this.sample();
        if (this.live) this.onFrame?.(this.live);
      }
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

  /** Median color of a square patch, how much of it matches that color, and its brightness. */
  samplePatch(cx, cy, size) {
    const { data: px, width, height } = this.frame;
    const x0 = Math.max(0, Math.round(cx - size / 2)), x1 = Math.min(width, Math.round(cx + size / 2));
    const y0 = Math.max(0, Math.round(cy - size / 2)), y1 = Math.min(height, Math.round(cy + size / 2));
    const data = [];
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        data.push(px[i], px[i + 1], px[i + 2], 255);
      }
    }
    if (!data.length) return { color: [0, 0, 0], uniform: 0, brightness: 0 };
    const med = medianRGB(data);
    let close = 0;
    for (let i = 0; i < data.length; i += 4) {
      const d = Math.abs(data[i] - med[0]) + Math.abs(data[i + 1] - med[1]) + Math.abs(data[i + 2] - med[2]);
      if (d < UNIFORM_DISTANCE) close++;
    }
    return { color: med, uniform: close / (data.length / 4), brightness: (med[0] + med[1] + med[2]) / 3 };
  }

  /**
   * Reads the face in view (raw camera coordinates). Sets this.live to
   * { colors: 9 median RGBs in reading order, uniform: per sticker, the fraction of the patch matching
   *   its median color, brightness: per sticker 0..255, detected: found by OpenCV (else the fixed square),
   *   points: sticker centers, gapsDark: (fixed square only) whether the lines between cells are dark }.
   */
  sample() {
    const w = this.video.videoWidth, h = this.video.videoHeight;
    if (!w || !h) return;
    if (this.work.width !== w) { this.work.width = w; this.work.height = h; }
    this.workCtx.drawImage(this.video, 0, 0, w, h);
    this.frame = this.workCtx.getImageData(0, 0, w, h);
    const face = this.cv && this.detect(w, h);
    if (face) {
      const size = Math.max(4, Math.round(face.pitch * PATCH_FRACTION));
      const cells = face.points.map(([x, y]) => this.samplePatch(x, y, size));
      this.live = {
        colors: cells.map((c) => c.color),
        uniform: cells.map((c) => c.uniform),
        brightness: cells.map((c) => c.brightness),
        detected: true,
        points: face.points,
        pitch: face.pitch,
      };
      return;
    }
    const g = this.grid();
    const patch = Math.max(4, Math.round(g.cell * SAMPLE_FRACTION));
    const cells = [], points = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const cx = g.x + (c + 0.5) * g.cell, cy = g.y + (r + 0.5) * g.cell;
        points.push([cx, cy]);
        cells.push(this.samplePatch(cx, cy, patch));
      }
    }
    const brightness = cells.map((c) => c.brightness);
    // Lines between neighbouring cells: on a real cube these are dark plastic or shadow.
    const gap = Math.max(3, Math.round(g.cell * 0.08));
    const lum = (x, y) => this.samplePatch(x, y, gap).brightness;
    let dark = 0;
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 2; b++) {
        // vertical line between (row a, col b) and (row a, col b+1)
        if (lum(g.x + (b + 1) * g.cell, g.y + (a + 0.5) * g.cell) < 0.7 * Math.min(brightness[a * 3 + b], brightness[a * 3 + b + 1])) dark++;
        // horizontal line between (row b, col a) and (row b+1, col a)
        if (lum(g.x + (a + 0.5) * g.cell, g.y + (b + 1) * g.cell) < 0.7 * Math.min(brightness[b * 3 + a], brightness[(b + 1) * 3 + a])) dark++;
      }
    }
    this.live = {
      colors: cells.map((c) => c.color),
      uniform: cells.map((c) => c.uniform),
      brightness,
      detected: false,
      points,
      gapsDark: dark >= 8,
    };
  }

  /** Runs OpenCV face detection on a downscaled copy of the frame; returns full-size coordinates. */
  detect(w, h) {
    const scale = Math.min(1, DETECT_WIDTH / w);
    const dw = Math.round(w * scale), dh = Math.round(h * scale);
    if (this.detFrame?.width !== dw || this.detFrame?.height !== dh) {
      this.detFrame = { data: new Uint8ClampedArray(dw * dh * 4), width: dw, height: dh };
    }
    // nearest-pixel downscale (OpenCV blurs the image anyway)
    const src = this.frame.data, dst = this.detFrame.data;
    for (let y = 0; y < dh; y++) {
      const sy = Math.min(h - 1, Math.floor(y / scale));
      for (let x = 0; x < dw; x++) {
        const si = (sy * w + Math.min(w - 1, Math.floor(x / scale))) * 4, di = (y * dw + x) * 4;
        dst[di] = src[si]; dst[di + 1] = src[si + 1]; dst[di + 2] = src[si + 2]; dst[di + 3] = 255;
      }
    }
    const face = detectFace(this.cv, this.detFrame);
    if (!face) return null;
    return { points: face.points.map(([x, y]) => [x / scale, y / scale]), pitch: face.pitch / scale };
  }

  /**
   * Camera direction check. The user moves the cube to THEIR right; a normal webcam (facing the
   * user) sees that as movement toward the left of its image. Resolves true if the camera image is
   * mirrored, false if it's normal, or null if no clear sideways movement was seen in time.
   */
  detectMirroring(timeoutMs = 15000) {
    this.motion?.resolve(null);
    return new Promise((resolve) => {
      this.motion = { prev: null, points: [], start: performance.now(), timeoutMs, resolve };
    });
  }

  cancelMotion() {
    const m = this.motion;
    this.motion = null;
    m?.resolve(null);
  }

  trackMotion() {
    const m = this.motion;
    const [W, H] = MOTION_SIZE;
    this.smallCtx.drawImage(this.video, 0, 0, W, H);
    const data = this.smallCtx.getImageData(0, 0, W, H).data;
    // Centroid of colorful pixels that changed since the last frame = the moving cube (and hand).
    let sx = 0, sy = 0, n = 0;
    if (m.prev) {
      for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const changed = Math.abs(r - m.prev[i]) + Math.abs(g - m.prev[i + 1]) + Math.abs(b - m.prev[i + 2]) > 40;
        if (changed && max > 60 && (max - min) / max > 0.35) { sx += p % W; sy += Math.floor(p / W); n++; }
      }
    }
    m.prev = data;
    if (n > 25) m.points.push([sx / n / W, sy / n / H]);
    const first = m.points[0], last = m.points[m.points.length - 1];
    if (first && Math.abs(last[0] - first[0]) > 0.18) {
      this.motion = null;
      m.resolve(last[0] > first[0]);
    } else if (performance.now() - m.start > m.timeoutMs) {
      this.motion = null;
      m.resolve(null);
    }
  }

  /** The overlay shares the video's CSS mirroring, so we draw in raw camera coordinates. */
  draw() {
    const w = this.video.videoWidth, h = this.video.videoHeight;
    if (!w || !h) return;
    if (this.overlay.width !== w) { this.overlay.width = w; this.overlay.height = h; }
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    if (this.motion) {
      // show what the direction check is following
      const pts = this.motion.points.slice(-30);
      pts.forEach(([x, y], i) => {
        ctx.fillStyle = i === pts.length - 1 ? '#ff3d9a' : 'rgba(255,61,154,0.35)';
        ctx.beginPath();
        ctx.arc(x * w, y * h, i === pts.length - 1 ? 14 : 6, 0, Math.PI * 2);
        ctx.fill();
      });
      return;
    }
    const live = this.live;
    if (live?.detected) {
      // outline the face that was found, and show the color read from each sticker
      const c = live.points[4];
      const outline = [0, 2, 8, 6].map((i) => {
        const [x, y] = live.points[i];
        return [x + (x - c[0]) * 0.5, y + (y - c[1]) * 0.5]; // corner sticker center -> face corner
      });
      ctx.lineWidth = Math.max(3, live.pitch / 18);
      ctx.strokeStyle = this.progress > 0 ? '#ff3d9a' : 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      outline.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
      live.points.forEach(([x, y], i) => {
        const col = live.colors[i];
        ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath();
        ctx.arc(x, y, live.pitch * 0.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      });
      if (this.progress > 0) {
        ctx.strokeStyle = '#ff3d9a';
        ctx.lineWidth = Math.max(4, live.pitch / 10);
        ctx.beginPath();
        ctx.arc(c[0], c[1], live.pitch * 2.3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, this.progress));
        ctx.stroke();
      }
      return;
    }
    const g = this.grid();
    // Without OpenCV the face must fill the square; with it, the square is only a hint.
    ctx.fillStyle = this.cv ? 'rgba(0,0,0,0.12)' : 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, w, h);
    ctx.clearRect(g.x, g.y, g.size, g.size);
    ctx.lineWidth = Math.max(2, g.size / 150);
    ctx.strokeStyle = this.cv ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.9)';
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const x = g.x + c * g.cell, y = g.y + r * g.cell;
        roundRect(ctx, x + g.cell * 0.06, y + g.cell * 0.06, g.cell * 0.88, g.cell * 0.88, g.cell * 0.12);
        ctx.stroke();
        const col = !this.cv && live?.colors[r * 3 + c];
        if (col) {
          ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
          ctx.beginPath();
          ctx.arc(x + g.cell / 2, y + g.cell / 2, g.cell * 0.22, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }
    // hold-still progress ring
    if (this.progress > 0) {
      ctx.strokeStyle = '#ff3d9a';
      ctx.lineWidth = Math.max(4, g.size / 60);
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, g.size * 0.74, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, this.progress));
      ctx.stroke();
    }
  }

  /** The 9 colors of the face in view, in reading order of the raw camera image. */
  capture() {
    this.sample();
    return this.live ? this.live.colors.map((c) => c.slice()) : null;
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
 * samples: { key: [9 rgb], ... } for the 6 keys in `faces` (center = index 4).
 * Returns a 54-char string with, for each sticker, the key of the face whose center it matches.
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
