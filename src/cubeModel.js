// Pure cube logic (no DOM): facelet geometry, moves, validation.
//
// Facelet strings follow the Kociemba convention used by cubejs:
// 54 chars, faces in order U R F D L B, 9 stickers each, row-major as seen
// from outside the face:
//   U: seen from above, B edge at top      R: seen from the right, U on top
//   F: seen from the front, U on top       D: seen from below, F edge at top
//   L: seen from the left, U on top        B: seen from the back, U on top
//
// 3D coordinates: x = right, y = up, z = toward the viewer (front).

export const FACES = ['U', 'R', 'F', 'D', 'L', 'B'];

export const FACE_NORMALS = {
  U: [0, 1, 0],
  R: [1, 0, 0],
  F: [0, 0, 1],
  D: [0, -1, 0],
  L: [-1, 0, 0],
  B: [0, 0, -1],
};

export const SOLVED = FACES.map((f) => f.repeat(9)).join('');

/** Cubie position [x,y,z] (each in -1..1) of sticker i (0..8) on a face. */
export function faceletPosition(face, i) {
  const r = Math.floor(i / 3);
  const c = i % 3;
  switch (face) {
    case 'U': return [c - 1, 1, r - 1];
    case 'R': return [1, 1 - r, 1 - c];
    case 'F': return [c - 1, 1 - r, 1];
    case 'D': return [c - 1, -1, 1 - r];
    case 'L': return [-1, 1 - r, c - 1];
    case 'B': return [1 - c, 1 - r, -1];
  }
  throw new Error(`bad face ${face}`);
}

function faceFromNormal([x, y, z]) {
  if (y === 1) return 'U';
  if (y === -1) return 'D';
  if (x === 1) return 'R';
  if (x === -1) return 'L';
  if (z === 1) return 'F';
  return 'B';
}

const sameVec = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** Inverse of faceletPosition: global facelet index (0..53) of a sticker. */
export function faceletIndex(pos, normal) {
  const face = faceFromNormal(normal);
  for (let i = 0; i < 9; i++) {
    if (sameVec(faceletPosition(face, i), pos)) return FACES.indexOf(face) * 9 + i;
  }
  throw new Error('sticker not found');
}

// Clockwise quarter turn of a face (looking at it) = -90° around its outward normal.
// axis: 0=x 1=y 2=z, layer: coordinate of the slice, dir: sign of the rotation angle.
export const MOVE_DEFS = {
  U: { axis: 1, layer: 1, dir: -1 },
  D: { axis: 1, layer: -1, dir: 1 },
  R: { axis: 0, layer: 1, dir: -1 },
  L: { axis: 0, layer: -1, dir: 1 },
  F: { axis: 2, layer: 1, dir: -1 },
  B: { axis: 2, layer: -1, dir: 1 },
};

/** "R" -> {face:'R', turns:1}, "R'" -> turns -1, "R2" -> turns 2 */
export function parseMove(m) {
  const face = m[0];
  if (!MOVE_DEFS[face]) throw new Error(`bad move ${m}`);
  const turns = m[1] === "'" ? -1 : m[1] === '2' ? 2 : 1;
  return { face, turns };
}

export function invertMove(m) {
  const { face, turns } = parseMove(m);
  return turns === 2 ? m : turns === 1 ? `${face}'` : face;
}

export function parseAlg(alg) {
  return alg.trim().split(/\s+/).filter(Boolean);
}

/** Rotate integer vector v by quarterTurns * 90° around axis. */
function rotate(v, axis, quarterTurns) {
  let [x, y, z] = v;
  const n = ((quarterTurns % 4) + 4) % 4;
  for (let k = 0; k < n; k++) {
    if (axis === 0) [y, z] = [-z, y];
    else if (axis === 1) [x, z] = [z, -x];
    else [x, y] = [-y, x];
  }
  return [x, y, z];
}

/** Apply one move to a facelet string; returns the new string. */
export function applyMove(facelets, move) {
  const { face, turns } = parseMove(move);
  const { axis, layer, dir } = MOVE_DEFS[face];
  const out = facelets.split('');
  for (const f of FACES) {
    for (let i = 0; i < 9; i++) {
      const pos = faceletPosition(f, i);
      if (pos[axis] !== layer) continue;
      const q = dir * turns;
      const to = faceletIndex(rotate(pos, axis, q), rotate(FACE_NORMALS[f], axis, q));
      out[to] = facelets[FACES.indexOf(f) * 9 + i];
    }
  }
  return out.join('');
}

export function applyAlg(facelets, alg) {
  const moves = Array.isArray(alg) ? alg : parseAlg(alg);
  return moves.reduce(applyMove, facelets);
}

// ---- Validation -----------------------------------------------------------
// Standard Kociemba corner/edge facelet tables (0-based global indices).
const U = 0, R = 9, F = 18, D = 27, L = 36, B = 45;
export const CORNER_FACELETS = [
  [U + 8, R + 0, F + 2], [U + 6, F + 0, L + 2], [U + 0, L + 0, B + 2], [U + 2, B + 0, R + 2],
  [D + 2, F + 8, R + 6], [D + 0, L + 8, F + 6], [D + 6, B + 8, L + 6], [D + 8, R + 8, B + 6],
];
export const EDGE_FACELETS = [
  [U + 5, R + 1], [U + 7, F + 1], [U + 3, L + 1], [U + 1, B + 1],
  [D + 5, R + 7], [D + 1, F + 7], [D + 3, L + 7], [D + 7, B + 7],
  [F + 5, R + 3], [F + 3, L + 5], [B + 5, L + 3], [B + 3, R + 5],
];
const CORNER_COLORS = CORNER_FACELETS.map((c) => c.map((i) => SOLVED[i]));
const EDGE_COLORS = EDGE_FACELETS.map((e) => e.map((i) => SOLVED[i]));

function permutationParity(p) {
  let parity = 0;
  const seen = new Array(p.length).fill(false);
  for (let i = 0; i < p.length; i++) {
    if (seen[i]) continue;
    let len = 0;
    for (let j = i; !seen[j]; j = p[j]) { seen[j] = true; len++; }
    parity ^= (len - 1) & 1;
  }
  return parity;
}

/**
 * Checks that a facelet string (letters URFDLB, '?' = unknown) is a real,
 * solvable cube. Returns { ok: true } or { ok: false, error: '...' }.
 */
export function validate(facelets) {
  if (facelets.length !== 54) return { ok: false, error: 'The cube must have 54 stickers.' };
  if (facelets.includes('?')) {
    const n = facelets.split('').filter((c) => c === '?').length;
    return { ok: false, error: `${n} sticker${n > 1 ? 's are' : ' is'} still unknown.` };
  }
  for (let i = 0; i < 6; i++) {
    if (facelets[i * 9 + 4] !== FACES[i]) return { ok: false, error: 'Center stickers are inconsistent.' };
  }
  for (const f of FACES) {
    const n = facelets.split('').filter((c) => c === f).length;
    if (n !== 9) return { ok: false, error: `Color of the ${f} face appears ${n} times (must be 9).` };
  }

  const cp = [], co = [];
  for (const facelet of CORNER_FACELETS) {
    const cols = facelet.map((i) => facelets[i]);
    const ori = cols.findIndex((c) => c === 'U' || c === 'D');
    if (ori < 0) return { ok: false, error: 'A corner piece has an impossible color combination.' };
    const c1 = cols[(ori + 1) % 3], c2 = cols[(ori + 2) % 3];
    const piece = CORNER_COLORS.findIndex((cc) => cc[0] === cols[ori] && cc[1] === c1 && cc[2] === c2);
    if (piece < 0) return { ok: false, error: 'A corner piece has an impossible color combination.' };
    cp.push(piece);
    co.push(ori);
  }
  const ep = [], eo = [];
  for (const facelet of EDGE_FACELETS) {
    const [a, b] = facelet.map((i) => facelets[i]);
    let piece = EDGE_COLORS.findIndex((e) => e[0] === a && e[1] === b);
    let ori = 0;
    if (piece < 0) {
      piece = EDGE_COLORS.findIndex((e) => e[0] === b && e[1] === a);
      ori = 1;
    }
    if (piece < 0) return { ok: false, error: 'An edge piece has an impossible color combination.' };
    ep.push(piece);
    eo.push(ori);
  }
  if (new Set(cp).size !== 8) return { ok: false, error: 'Some corner piece appears twice — check the colors.' };
  if (new Set(ep).size !== 12) return { ok: false, error: 'Some edge piece appears twice — check the colors.' };
  if (co.reduce((a, b) => a + b, 0) % 3 !== 0) return { ok: false, error: 'A corner is twisted (unsolvable as scanned) — check the colors.' };
  if (eo.reduce((a, b) => a + b, 0) % 2 !== 0) return { ok: false, error: 'An edge is flipped (unsolvable as scanned) — check the colors.' };
  if (permutationParity(cp) !== permutationParity(ep)) {
    return { ok: false, error: 'Two pieces are swapped (unsolvable as scanned) — check the colors.' };
  }
  return { ok: true };
}

// ---- Repairing scanning mistakes ------------------------------------------
// A "scan transform" remaps a scanned cube:
//   swapRL: swap the right and left faces
//   mirror: mirror every face image left-right
//   rots:   quarter turns per face (URFDLB order)
// swapRL + mirror together reflect the whole cube, which is how a mirrored camera image is undone.
const MIRROR_IDX = [2, 1, 0, 5, 4, 3, 8, 7, 6];
const ROT_IDX = [6, 3, 0, 7, 4, 1, 8, 5, 2]; // turned[i] = original[ROT_IDX[i]]
const SWAP_RL = { R: 'L', L: 'R' };

/** For each facelet index of the repaired cube, the index it comes from in the scanned cube. */
export function scanTransformSources({ swapRL = false, mirror = false, rots = [0, 0, 0, 0, 0, 0] }) {
  const src = [];
  FACES.forEach((f, fi) => {
    const from = FACES.indexOf(swapRL ? SWAP_RL[f] || f : f);
    for (let i = 0; i < 9; i++) {
      let j = i;
      for (let r = 0; r < rots[fi]; r++) j = ROT_IDX[j];
      if (mirror) j = MIRROR_IDX[j];
      src.push(from * 9 + j);
    }
  });
  return src;
}

/** Letter relabeling that goes with a transform (swapping faces swaps which center a color refers to). */
export const relabelFor = ({ swapRL = false }) => (c) => (swapRL ? SWAP_RL[c] || c : c);

export function applyScanTransform(facelets, t) {
  const relabel = relabelFor(t);
  return scanTransformSources(t).map((s) => relabel(facelets[s])).join('');
}

export function randomScramble(length = 22) {
  const faces = Object.keys(MOVE_DEFS);
  const opposite = { U: 'D', D: 'U', R: 'L', L: 'R', F: 'B', B: 'F' };
  const moves = [];
  while (moves.length < length) {
    const f = faces[Math.floor(Math.random() * 6)];
    const prev = moves[moves.length - 1]?.[0];
    const prev2 = moves[moves.length - 2]?.[0];
    if (f === prev || (f === prev2 && opposite[f] === prev)) continue;
    moves.push(f + ['', "'", '2'][Math.floor(Math.random() * 3)]);
  }
  return moves;
}
