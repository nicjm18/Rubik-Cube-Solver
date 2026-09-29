// Puts 6 scanned faces together, whatever order and rotation they were shown in.
//
// The pieces of a real cube only fit together one way: every corner and edge must carry colors
// of neighbouring centers, in the right order. So we try every placement of the faces and keep
// the one where the most pieces make sense. The first face shown becomes the front, held the
// way it was shown, which fixes the whole-cube orientation (and makes the search 24x smaller).

import { FACES, CORNER_FACELETS, EDGE_FACELETS, SOLVED, validate } from './cubeModel.js';

const ROT_IDX = [6, 3, 0, 7, 4, 1, 8, 5, 2]; // quarter turn: turned[i] = original[ROT_IDX[i]]
const MIRROR_IDX = [2, 1, 0, 5, 4, 3, 8, 7, 6];

export function rotateGrid(grid, quarterTurns) {
  let g = grid;
  for (let r = 0; r < quarterTurns; r++) g = ROT_IDX.map((i) => g[i]);
  return g;
}

export const mirrorGrid = (grid) => MIRROR_IDX.map((i) => grid[i]);

// Every way a corner or edge can read at a given spot: a solved piece, possibly twisted/flipped.
const VALID_CORNERS = new Set();
for (const c of CORNER_FACELETS) {
  const s = c.map((i) => SOLVED[i]).join('');
  for (let k = 0; k < 3; k++) VALID_CORNERS.add(s.slice(k) + s.slice(0, k));
}
const VALID_EDGES = new Set();
for (const e of EDGE_FACELETS) {
  const [a, b] = e.map((i) => SOLVED[i]);
  VALID_EDGES.add(a + b);
  VALID_EDGES.add(b + a);
}
export const MAX_SCORE = CORNER_FACELETS.length + EDGE_FACELETS.length;

const permutations = (a) =>
  a.length <= 1 ? [a] : a.flatMap((x, i) => permutations([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]));

/**
 * grids: 6 arrays of 9 color classes (0..5), where grid k's center has class k.
 * Returns { gridAt: {U: gridIndex, ...}, rotation: {U: quarterTurns, ...}, facelets, score, valid }.
 * score counts pieces that make sense (MAX_SCORE when all do); valid means the cube is solvable.
 */
export function assembleFaces(grids) {
  const turned = grids.map((g) => [0, 1, 2, 3].map((r) => rotateGrid(g, r)));
  const others = ['U', 'R', 'D', 'L', 'B']; // F is fixed: first grid, as shown
  let best = null;
  const f = new Array(54);

  for (const perm of permutations([1, 2, 3, 4, 5])) {
    const gridAt = { F: 0 };
    others.forEach((p, i) => { gridAt[p] = perm[i]; });
    const letterOf = [];
    for (const p of FACES) letterOf[gridAt[p]] = p;

    for (let n = 0; n < 4 ** others.length; n++) {
      const rotation = { F: 0 };
      others.forEach((p, i) => { rotation[p] = (n >> (2 * i)) & 3; });
      FACES.forEach((p, pi) => {
        const g = turned[gridAt[p]][rotation[p]];
        for (let i = 0; i < 9; i++) f[pi * 9 + i] = letterOf[g[i]];
      });
      let score = 0;
      for (const [a, b, c] of CORNER_FACELETS) if (VALID_CORNERS.has(f[a] + f[b] + f[c])) score++;
      for (const [a, b] of EDGE_FACELETS) if (VALID_EDGES.has(f[a] + f[b])) score++;
      if (best && score < best.score) continue;
      if (best && score === best.score && score < MAX_SCORE) continue;
      const facelets = f.join('');
      const valid = score === MAX_SCORE && validate(facelets).ok;
      if (valid) return { gridAt: { ...gridAt }, rotation, facelets, score, valid };
      if (!best || score > best.score) best = { gridAt: { ...gridAt }, rotation, facelets, score, valid };
    }
  }
  return best;
}
