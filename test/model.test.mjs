// Verifies src/cubeModel.js against the cubejs reference implementation.
import assert from 'node:assert/strict';
import Cube from 'cubejs';
import { SOLVED, applyMove, applyAlg, validate, randomScramble, invertMove } from '../src/cubeModel.js';

for (const m of ['U', "U'", 'U2', 'R', "R'", 'R2', 'F', "F'", 'F2', 'D', "D'", 'D2', 'L', "L'", 'L2', 'B', "B'", 'B2']) {
  assert.equal(applyMove(SOLVED, m), new Cube().move(m).asString(), `move ${m}`);
}
for (let t = 0; t < 200; t++) {
  const s = randomScramble(25);
  const mine = applyAlg(SOLVED, s);
  assert.equal(mine, new Cube().move(s.join(' ')).asString(), 'scramble');
  assert.ok(validate(mine).ok, 'scrambled cube should validate');
  assert.equal(applyAlg(mine, [...s].reverse().map(invertMove)), SOLVED, 'inverse');
}
// Invalid cubes
const twist = (s, a, b, c) => { const x = s.split(''); [x[a], x[b], x[c]] = [x[b], x[c], x[a]]; return x.join(''); };
const swap = (s, a, b) => { const x = s.split(''); [x[a], x[b]] = [x[b], x[a]]; return x.join(''); };
assert.match(validate(twist(SOLVED, 8, 9, 20)).error, /twisted/);
assert.match(validate(swap(SOLVED, 5, 10)).error, /flipped/);
assert.match(validate(swap(SOLVED, 0, 18)).error, /impossible|twice/);
assert.match(validate('?' + SOLVED.slice(1)).error, /unknown/);

console.time('initSolver');
Cube.initSolver();
console.timeEnd('initSolver');
for (let t = 0; t < 20; t++) {
  const start = applyAlg(SOLVED, randomScramble());
  const sol = Cube.fromString(start).solve();
  assert.equal(applyAlg(start, sol), SOLVED, 'solution solves');
}
console.log('all tests passed');

// Faces shown in any order and rotation are put back together
{
  const { FACES, FACE_NORMALS, faceletPosition, faceletIndex } = await import('../src/cubeModel.js');
  const { assembleFaces, rotateGrid, MAX_SCORE } = await import('../src/assemble.js');
  const r90 = (v, axis) => { let [x, y, z] = v; if (axis === 0) [y, z] = [-z, y]; else if (axis === 1) [x, z] = [z, -x]; else [x, y] = [-y, x]; return [x, y, z]; };
  const turnCube = (c, axis) => {
    const o = [];
    FACES.forEach((f, fi) => { for (let i = 0; i < 9; i++) o[faceletIndex(r90(faceletPosition(f, i), axis), r90(FACE_NORMALS[f], axis))] = c[fi * 9 + i]; });
    return o.join('');
  };
  const orientations = (c) => {
    const seen = new Set([c]), queue = [c];
    while (queue.length) { const x = queue.pop(); for (const a of [0, 1, 2]) { const t = turnCube(x, a); if (!seen.has(t)) { seen.add(t); queue.push(t); } } }
    return seen;
  };
  const shuffle = (a) => a.map((x) => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
  // colors as the camera sees them: a letter per real color, independent of where faces end up
  const toColors = (facelets) => facelets.replace(/[URFDLB]/g, (c) => 'wrgyob'['URFDLB'.indexOf(c)]);

  console.time('assemble x20');
  for (let t = 0; t < 20; t++) {
    const cube = toColors(applyAlg(SOLVED, randomScramble()));
    const shown = shuffle(FACES.map((_, fi) => rotateGrid(cube.slice(fi * 9, fi * 9 + 9).split(''), Math.floor(Math.random() * 4))));
    const classOf = Object.fromEntries(shown.map((g, k) => [g[4], k]));
    const result = assembleFaces(shown.map((g) => g.map((c) => classOf[c])));
    assert.ok(result.valid, 'assembled cube is valid');
    const colors = result.facelets.replace(/[URFDLB]/g, (c) => shown[result.gridAt[c]][4]);
    assert.ok(orientations(cube).has(colors), 'assembled cube is the scanned cube');
  }
  console.timeEnd('assemble x20');

  // one misread sticker: still placed, with one piece flagged
  const cube = toColors(applyAlg(SOLVED, randomScramble()));
  const shown = FACES.map((_, fi) => cube.slice(fi * 9, fi * 9 + 9).split(''));
  const classOf = Object.fromEntries(shown.map((g, k) => [g[4], k]));
  const grids = shown.map((g) => g.map((c) => classOf[c]));
  grids[2][0] = (grids[2][0] + 1) % 6;
  const result = assembleFaces(grids);
  assert.ok(!result.valid && result.score >= MAX_SCORE - 2, 'misread cube placed with a low error count');
  console.log('assembly ok');
}
