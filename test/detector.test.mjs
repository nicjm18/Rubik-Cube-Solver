// Checks the OpenCV face detector on synthetic camera frames.
import assert from 'node:assert/strict';
import { loadOpenCV, detectFace } from '../src/faceDetector.js';

const cv = await loadOpenCV();
const COLORS = [[215, 215, 210], [180, 30, 35], [20, 150, 80], [215, 205, 40], [235, 100, 25], [25, 65, 180]];
const W = 640, H = 360;

/** Draws a cube face (dark body + 9 stickers) centered at (cx, cy), sticker pitch p, tilted by angle a. */
function frame({ cx, cy, p, a, colors, light, noise = 16, hidden = -1 }) {
  const data = new Uint8ClampedArray(W * H * 4);
  const cos = Math.cos(a), sin = Math.sin(a);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // background: a soft gradient with noise, plus a skin-colored "hand" blob
      let rgb = [120 + x / 12, 118 + y / 10, 112].map((v) => v + (Math.random() - 0.5) * noise);
      if (Math.hypot(x - cx - 1.9 * p, y - cy - 1.2 * p) < 1.1 * p) rgb = [205, 150, 120];
      // point in face coordinates (units of pitch, face center at 0,0)
      const dx = x - cx, dy = y - cy;
      const fx = (dx * cos + dy * sin) / p, fy = (-dx * sin + dy * cos) / p;
      if (Math.abs(fx) < 1.55 && Math.abs(fy) < 1.55) {
        rgb = [22, 22, 24];
        const col = Math.round(fx), row = Math.round(fy);
        if (Math.abs(fx - col) < 0.43 && Math.abs(fy - row) < 0.43 && Math.abs(col) <= 1 && Math.abs(row) <= 1) {
          const k = (row + 1) * 3 + col + 1;
          rgb = k === hidden ? [250, 250, 250] : colors[k].map((v) => v * light + (Math.random() - 0.5) * noise * 0.6);
          if (row === -1 && col === -1 && fx - col < -0.2 && fy - row < -0.2) rgb = [250, 250, 250]; // glare
        }
      }
      const i = (y * W + x) * 4;
      data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
    }
  }
  return { data, width: W, height: H };
}

let ok = 0;
const N = 30;
for (let t = 0; t < N; t++) {
  const p = 25 + Math.random() * 35; // small (keychain, far) to large (close)
  const a = (Math.random() - 0.5) * (Math.PI / 3); // tilted up to ±30°
  const cx = 1.8 * p + Math.random() * (W - 3.6 * p), cy = 1.8 * p + Math.random() * (H - 3.6 * p);
  const colors = Array.from({ length: 9 }, () => COLORS[Math.floor(Math.random() * 6)]);
  // a third of the frames are noise-free (flat colors), a third have one sticker washed out by glare
  const noise = t % 3 === 0 ? 0 : 16;
  const hidden = t % 3 === 1 ? Math.floor(Math.random() * 9) : -1;
  const face = detectFace(cv, frame({ cx, cy, p, a, colors, light: 0.75 + Math.random() * 0.35, noise, hidden }));
  if (!face) continue;
  // expected sticker centers in reading order
  const good = face.points.every(([x, y], i) => {
    const col = (i % 3) - 1, row = Math.floor(i / 3) - 1;
    const ex = cx + (col * Math.cos(a) - row * Math.sin(a)) * p;
    const ey = cy + (col * Math.sin(a) + row * Math.cos(a)) * p;
    return Math.hypot(x - ex, y - ey) < 0.25 * p;
  });
  if (good) ok++;
}
console.log(`face detector: ${ok}/${N} faces found with all 9 stickers in the right place`);
assert.ok(ok >= N * 0.9, 'detector finds most faces');

// no cube in the picture: nothing found
const empty = frame({ cx: -500, cy: -500, p: 30, a: 0, colors: [], light: 1 });
assert.equal(detectFace(cv, empty), null, 'no face in an empty frame');
console.log('detector ok');
process.exit(0); // OpenCV keeps the event loop alive
