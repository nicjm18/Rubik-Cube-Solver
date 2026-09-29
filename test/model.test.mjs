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

// Typical scanning mistakes are detected and repaired
{
  const { findScanFixes, applyScanTransform } = await import('../src/cubeModel.js');
  for (let t = 0; t < 10; t++) {
    const start = applyAlg(SOLVED, randomScramble());
    // one face held sideways
    const rot = (s) => [6, 3, 0, 7, 4, 1, 8, 5, 2].map((i) => s[i]).join('');
    const turned = start.slice(0, 27) + rot(start.slice(27, 36)) + start.slice(36);
    if (!validate(turned).ok) assert.ok(findScanFixes(turned).some((f) => f.facelets === start), 'rotated face repaired');
    // cube turned right instead of left: R and L grids swapped
    const swapped = applyScanTransform(start, { swapRL: true });
    if (!validate(swapped).ok) assert.ok(findScanFixes(swapped).some((f) => f.facelets === start), 'R/L swap repaired');
    // mirrored camera image
    const mirrored = applyScanTransform(start, { mirror: true });
    if (!validate(mirrored).ok) assert.ok(findScanFixes(mirrored).some((f) => f.facelets === start), 'mirror repaired');
  }
  console.log('scan repairs ok');
}
