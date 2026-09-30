// Finds a cube face anywhere in a camera frame, at any size, using OpenCV.
//
// 1. OpenCV finds sticker-like shapes: closed outlines that are roughly square (edges -> contours).
// 2. Among those, we look for a 3x3 lattice: a sticker with same-sized neighbours all around it.
// 3. The lattice gives the 9 sticker centers, in reading order (rows top to bottom, as the camera
//    sees them). Stickers OpenCV missed (glare, low contrast) are filled in from the lattice.

let cvPromise = null;

/** Loads OpenCV.js (a large WebAssembly module) once; resolves with the ready `cv` object. */
export function loadOpenCV() {
  cvPromise ??= import('@techstark/opencv-js').then(async (mod) => {
    const cv = mod.default ?? mod;
    if (cv instanceof Promise) return await cv;
    if (cv.Mat) return cv;
    await new Promise((resolve) => { cv.onRuntimeInitialized = resolve; });
    return cv;
  });
  return cvPromise;
}

/**
 * Sticker-like shapes in an RGBA image ({ data, width, height }).
 * Returns [{ x, y, side }] (center and approximate side length, in pixels).
 */
export function findStickers(cv, img) {
  const minSide = Math.min(img.width, img.height) * 0.025;
  const maxSide = Math.min(img.width, img.height) * 0.3;
  const src = new cv.Mat(img.height, img.width, cv.CV_8UC4);
  src.data.set(img.data);
  const gray = new cv.Mat();
  const edges = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const found = [];
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    cv.Canny(gray, edges, 20, 60);
    cv.dilate(edges, edges, kernel); // close small breaks in sticker outlines
    cv.findContours(edges, contours, hierarchy, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area < minSide * minSide || area > maxSide * maxSide) { cnt.delete(); continue; }
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.08 * cv.arcLength(cnt, true), true);
      const rect = cv.minAreaRect(cnt);
      const w = rect.size.width, h = rect.size.height;
      const squareish = Math.min(w, h) / Math.max(w, h) > 0.7; // roughly square...
      const solid = area / (w * h) > 0.7; // ...and filling its box (not an L or a ring)
      if (approx.rows >= 4 && approx.rows <= 6 && squareish && solid) {
        found.push({ x: rect.center.x, y: rect.center.y, side: Math.sqrt(area) });
      }
      approx.delete();
      cnt.delete();
    }
  } finally {
    [src, gray, edges, kernel, contours, hierarchy].forEach((m) => m.delete());
  }
  // The inside and outside of the same outline both show up: keep one per place and size.
  // (Different sizes at the same place are fine: the whole face is a big square around the center sticker.)
  found.sort((a, b) => b.side - a.side);
  const unique = [];
  for (const s of found) {
    const dup = unique.some((u) => Math.hypot(u.x - s.x, u.y - s.y) < 0.4 * Math.min(u.side, s.side) &&
      Math.abs(u.side / s.side - 1) < 0.35);
    if (!dup) unique.push(s);
  }
  return unique;
}

/**
 * Looks for a 3x3 face among sticker candidates. Returns null or
 * { points: 9 [x, y] in reading order, pitch (distance between sticker centers), matched (0..9) }.
 */
export function findLattice(stickers) {
  let best = null;
  for (const c of stickers) {
    const similar = stickers.filter((s) => Math.abs(s.side / c.side - 1) < 0.4);
    const near = similar.filter((s) => s !== c && Math.hypot(s.x - c.x, s.y - c.y) < 1.6 * c.side);
    if (!near.length) continue;
    // The closest same-sized neighbours are side by side with c: they give the spacing and direction.
    const dists = near.map((s) => Math.hypot(s.x - c.x, s.y - c.y));
    const pitch0 = Math.min(...dists);
    const edgeNbrs = near.filter((_, i) => dists[i] < pitch0 * 1.25);
    let angle = Math.atan2(edgeNbrs[0].y - c.y, edgeNbrs[0].x - c.x);
    // grid directions repeat every 90°: pick the one closest to "right" in the image
    angle = ((angle % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
    if (angle > Math.PI / 4) angle -= Math.PI / 2;
    const pitch = edgeNbrs.reduce((a, s) => a + Math.hypot(s.x - c.x, s.y - c.y), 0) / edgeNbrs.length;
    const u = [Math.cos(angle) * pitch, Math.sin(angle) * pitch]; // one column to the right
    const v = [-u[1], u[0]]; // one row down (image y grows downward)

    // c can be any of the 9 stickers: try each placement and keep the one that explains most stickers
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const cx = c.x - dc * u[0] - dr * v[0], cy = c.y - dc * u[1] - dr * v[1];
        const points = [];
        let matched = 0;
        for (let r = -1; r <= 1; r++) {
          for (let col = -1; col <= 1; col++) {
            const px = cx + col * u[0] + r * v[0], py = cy + col * u[1] + r * v[1];
            // snap to a detected sticker when there is one where the lattice expects it
            const hit = similar.find((s) => Math.hypot(s.x - px, s.y - py) < 0.3 * pitch);
            if (hit) matched++;
            points.push(hit ? [hit.x, hit.y] : [px, py]);
          }
        }
        if (!best || matched > best.matched) best = { points, pitch, matched };
      }
    }
  }
  return best && best.matched >= 6 ? best : null;
}

/** Finds a face in an RGBA image, or returns null. */
export function detectFace(cv, img) {
  return findLattice(findStickers(cv, img));
}
