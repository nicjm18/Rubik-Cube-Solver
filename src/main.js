import { Cube3D, PALETTE, UNKNOWN_COLOR } from './cube3d.js';
import { Scanner, classify, colorFeatures, featureDist } from './scanner.js';
import {
  FACES, SOLVED, validate, findScanFixes, scanTransformSources, relabelFor, applyAlg, parseAlg, parseMove, invertMove, randomScramble,
} from './cubeModel.js';

const $ = (id) => document.getElementById(id);

const SIDE = { U: 'top', R: 'right', F: 'front', D: 'bottom', L: 'left', B: 'back' };
const COLOR_NAMES = Object.keys(PALETTE);
// Standard color scheme — only used as a starting guess until the centers are scanned.
const STANDARD_SCHEME = { U: 'white', R: 'red', F: 'green', D: 'yellow', L: 'orange', B: 'blue' };
// Rough webcam-ish look of each sticker color, to recognise which color a center is.
const REFERENCE_RGB = {
  white: [220, 225, 225], red: [190, 30, 40], green: [20, 150, 80],
  yellow: [220, 215, 40], orange: [240, 110, 30], blue: [25, 70, 190],
};

const hex = (f) => (f === '?' ? UNKNOWN_COLOR : PALETTE[state.faceColor[f]]);
const sw = (f) => `<span class="swatch" style="background:${hex(f)}"></span>`;
const col = (f) => `${sw(f)}<b>${state.faceColor[f].toUpperCase()}</b>`;
const known = (f) => !!state.samples[f] || !!state.colorFixes[f] || state.manualColors;

// Scanning follows how the cube is moved, not its colors, so any color scheme works
// (many keychain and off-brand cubes use a non-standard one).
// The resulting sticker order matches the solver's conventions.
const SCAN_STEPS = [
  {
    face: 'F',
    text: () => 'Pick any face to be the <b>front</b> and show it to the camera. ' +
      'Remember which face is on <b>top</b> — keep it on top for the next 3 faces.',
  },
  {
    face: 'R',
    text: () => 'Turn the whole cube a quarter turn so the face that was on its <b>right</b> side now faces the camera. Same face on top.',
  },
  { face: 'B', text: () => 'Again: bring the face on the <b>right</b> side to the camera. Same face on top.' },
  { face: 'L', text: () => 'Once more: bring the face on the <b>right</b> side to the camera. Same face on top.' },
  {
    face: 'U',
    text: () => `Turn once more the same way so the first face${known('F') ? ` (${col('F')} center)` : ''} is in front again. ` +
      'Then tilt the cube <b>toward you</b>: the top face looks at the camera and the first face points <b>down</b>.',
  },
  {
    face: 'D',
    text: () => `Now show the <b>bottom</b> face: it looks at the camera and the first face${known('F') ? ` (${col('F')} center)` : ''} points <b>up</b>.`,
  },
];

const MOVE_TEXT = {
  U: ['Turn the <b>top</b> layer to the <b>left</b>', 'clockwise, seen from above'],
  "U'": ['Turn the <b>top</b> layer to the <b>right</b>', 'counter-clockwise, seen from above'],
  D: ['Turn the <b>bottom</b> layer to the <b>right</b>', 'clockwise, seen from below'],
  "D'": ['Turn the <b>bottom</b> layer to the <b>left</b>', 'counter-clockwise, seen from below'],
  R: ['Turn the <b>right</b> side <b>up</b> (away from you)', 'clockwise, seen from the right'],
  "R'": ['Turn the <b>right</b> side <b>down</b> (toward you)', 'counter-clockwise, seen from the right'],
  L: ['Turn the <b>left</b> side <b>down</b> (toward you)', 'clockwise, seen from the left'],
  "L'": ['Turn the <b>left</b> side <b>up</b> (away from you)', 'counter-clockwise, seen from the left'],
  F: ['Turn the <b>front</b> face <b>clockwise</b> ↻', 'like a steering wheel to the right'],
  "F'": ['Turn the <b>front</b> face <b>counter-clockwise</b> ↺', 'like a steering wheel to the left'],
  B: ['Turn the <b>back</b> layer so its top goes to the <b>left</b>', 'clockwise, seen from behind'],
  "B'": ['Turn the <b>back</b> layer so its top goes to the <b>right</b>', 'counter-clockwise, seen from behind'],
};
function describeMove(m) {
  const { face, turns } = parseMove(m);
  const faceLabel = `${sw(face)}${SIDE[face]} (${state.faceColor[face]} center)`;
  if (turns === 2) {
    return `Turn the <b>${SIDE[face]}</b> layer <b>twice</b> (180°)<small>${faceLabel} — either direction</small>`;
  }
  const [main, sub] = MOVE_TEXT[m];
  return `${main}<small>${faceLabel} — ${sub}</small>`;
}

// ---- State ------------------------------------------------------------------

const state = {
  phase: 'scan', // 'scan' | 'solve'
  samples: {}, // face -> 9 RGB samples
  overrides: {}, // facelet index -> letter (manual fixes)
  facelets: '',
  faceColor: { ...STANDARD_SCHEME }, // face -> color name, detected from the centers
  colorFixes: {}, // face -> color name chosen by hand for a center
  manualColors: false, // colors entered without the camera (demo)
  scanStep: 0,
  paint: 'U',
  solution: [],
  step: 0,
  playing: null,
};

const cube = new Cube3D($('viewport'));
const scanner = new Scanner($('video'), $('overlay'));

// ---- Solver worker ---------------------------------------------------------

const worker = new Worker(new URL('./solver.worker.js', import.meta.url), { type: 'module' });
let solverReady = false;
let pendingSolve = null;
worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'ready') {
    solverReady = true;
    $('solver-status').textContent = 'Solver ready';
    $('solver-status').classList.add('ready');
    updateValidation();
    if (pendingSolve) { const f = pendingSolve; pendingSolve = null; requestSolve(f); }
  } else if (msg.type === 'solution') {
    startSolve(parseAlg(msg.solution));
  } else if (msg.type === 'error') {
    $('validation').textContent = `Solver error: ${msg.error}`;
    $('validation').className = 'validation bad';
    $('solve').disabled = false;
  }
};

function requestSolve(facelets) {
  if (!solverReady) {
    pendingSolve = facelets;
    $('solve').textContent = 'Waiting for solver…';
    return;
  }
  $('solve').textContent = 'Solving…';
  worker.postMessage({ id: Date.now(), facelets });
}

// ---- Facelets from samples ------------------------------------------------

const permutations = (a) =>
  a.length <= 1 ? [a] : a.flatMap((x, i) => permutations([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]));
const ALL_ASSIGNMENTS = permutations(COLOR_NAMES);

/** Decides which display color each face gets, from the scanned center colors. */
function computeFaceColors() {
  let best = null, bestCost = Infinity;
  for (const names of ALL_ASSIGNMENTS) {
    let cost = 0;
    FACES.forEach((f, i) => {
      const center = state.samples[f]?.[4];
      cost += center
        ? featureDist(colorFeatures(center), colorFeatures(REFERENCE_RGB[names[i]]))
        : names[i] === STANDARD_SCHEME[f] ? 0 : 1; // unscanned faces: prefer the usual scheme
    });
    if (cost < bestCost) { bestCost = cost; best = names; }
  }
  const map = Object.fromEntries(FACES.map((f, i) => [f, best[i]]));
  // centers corrected by hand win; swap with whichever face had that color
  for (const [f, name] of Object.entries(state.colorFixes)) {
    const other = FACES.find((g) => map[g] === name);
    map[other] = map[f];
    map[f] = name;
  }
  state.faceColor = map;
  cube.setFaceColors(Object.fromEntries(FACES.map((f) => [f, PALETTE[map[f]]])));
}

function computeFacelets() {
  computeFaceColors();
  const out = FACES.map((f) => '?'.repeat(4) + f + '?'.repeat(4)).join('').split('');
  const scanned = FACES.filter((f) => state.samples[f]);
  if (scanned.length === 6) {
    const letters = classify(state.samples, FACES);
    for (let i = 0; i < 54; i++) out[i] = letters[i];
  } else if (scanned.length) {
    // provisional: nearest of (scanned center colors, or reference colors for faces not seen yet)
    const refs = FACES.map((f) => colorFeatures(state.samples[f]?.[4] || REFERENCE_RGB[state.faceColor[f]]));
    for (const f of scanned) {
      state.samples[f].forEach((rgb, i) => {
        const v = colorFeatures(rgb);
        let best = 0, bestD = Infinity;
        refs.forEach((r, k) => {
          const d = featureDist(v, r);
          if (d < bestD) { bestD = d; best = k; }
        });
        out[FACES.indexOf(f) * 9 + i] = i === 4 ? f : FACES[best];
      });
    }
  }
  for (const [i, v] of Object.entries(state.overrides)) out[i] = v;
  state.facelets = out.join('');
}

function refresh({ redraw3d = true } = {}) {
  computeFacelets();
  if (redraw3d && state.phase === 'scan') cube.setState(state.facelets);
  renderPalette();
  renderFaces();
  renderNet();
  renderInstruction();
  updateValidation();
}

// ---- Scan UI --------------------------------------------------------------

function renderInstruction() {
  const done = FACES.filter((f) => state.samples[f]).length;
  $('scan-progress').textContent = `${done} / 6`;
  if (state.scanStep >= SCAN_STEPS.length) {
    $('scan-instruction').innerHTML = 'All faces captured! Check the colors below, then press <b>Solve it</b>. Click a face above to re-scan it.';
    $('capture').disabled = true;
  } else {
    const s = SCAN_STEPS[state.scanStep];
    $('scan-instruction').innerHTML = s.text();
    $('capture').disabled = !scanner.running;
  }
}

function renderFaces() {
  const box = $('faces');
  box.innerHTML = '';
  SCAN_STEPS.forEach((s, idx) => {
    const btn = document.createElement('button');
    btn.className = 'face-thumb' + (idx === state.scanStep ? ' current' : '');
    btn.title = `Scan the ${SIDE[s.face]} face`;
    const mini = document.createElement('div');
    mini.className = 'mini';
    for (let i = 0; i < 9; i++) {
      const cell = document.createElement('i');
      const letter = state.facelets[FACES.indexOf(s.face) * 9 + i];
      cell.style.background = i === 4 && !known(s.face) ? UNKNOWN_COLOR : hex(letter);
      mini.appendChild(cell);
    }
    const label = document.createElement('span');
    label.textContent = SIDE[s.face];
    btn.append(mini, label);
    btn.onclick = () => {
      state.scanStep = idx;
      if (state.phase === 'scan') cube.viewFace(s.face);
      refresh({ redraw3d: false });
    };
    box.appendChild(btn);
  });
}

function capture() {
  if (state.scanStep >= SCAN_STEPS.length || !scanner.running) return;
  const colors = scanner.capture();
  if (!colors) return;
  const face = SCAN_STEPS[state.scanStep].face;
  state.samples[face] = colors;
  // re-scanning a face discards manual fixes on it
  for (let i = 0; i < 9; i++) delete state.overrides[FACES.indexOf(face) * 9 + i];
  $('camera').classList.remove('flash');
  void $('camera').offsetWidth;
  $('camera').classList.add('flash');
  // advance to the next face that hasn't been scanned yet
  let next = SCAN_STEPS.findIndex((s, i) => i > state.scanStep && !state.samples[s.face]);
  if (next < 0) next = SCAN_STEPS.findIndex((s) => !state.samples[s.face]);
  state.scanStep = next < 0 ? SCAN_STEPS.length : next;
  cube.viewFace(state.scanStep < SCAN_STEPS.length ? SCAN_STEPS[state.scanStep].face : null);
  refresh();
}

async function startCamera() {
  $('camera-error').hidden = true;
  try {
    await scanner.start();
    $('camera').classList.add('on');
    renderInstruction();
  } catch (err) {
    $('camera-error').hidden = false;
    $('camera-error').textContent =
      err.name === 'NotAllowedError'
        ? 'Camera permission was denied. Allow it in your browser, or fill the colors by hand below.'
        : `Could not start the camera (${err.name || err}). You can fill the colors by hand below.`;
  }
}

// ---- Net editor -----------------------------------------------------------

const NET_POS = { U: [0, 3], L: [3, 0], F: [3, 3], R: [3, 6], B: [3, 9], D: [6, 3] }; // [row, col]

function renderPalette() {
  const box = $('palette');
  box.innerHTML = '';
  for (const f of FACES) {
    const b = document.createElement('button');
    b.className = 'paint' + (state.paint === f ? ' active' : '');
    b.style.background = hex(f);
    b.title = state.faceColor[f];
    b.onclick = () => { state.paint = f; renderPalette(); };
    box.appendChild(b);
  }
}

function renderNet() {
  const net = $('net');
  net.innerHTML = '';
  FACES.forEach((f, fi) => {
    const [r0, c0] = NET_POS[f];
    for (let i = 0; i < 9; i++) {
      const idx = fi * 9 + i;
      const cell = document.createElement('div');
      cell.className = 'cell' + (i === 4 ? ' center' : '');
      cell.style.gridRow = r0 + Math.floor(i / 3) + 1;
      cell.style.gridColumn = c0 + (i % 3) + 1;
      cell.style.background = i === 4 && !known(f) ? UNKNOWN_COLOR : hex(state.facelets[idx]);
      cell.title = i === 4 ? `${SIDE[f]} center — click to change its color` : '';
      cell.onclick = () => {
        if (state.phase !== 'scan') return;
        if (i === 4) {
          // a center was recognised as the wrong color: give it the picked color (the two colors swap)
          if (state.paint !== f) state.colorFixes[f] = state.faceColor[state.paint];
        } else {
          state.overrides[idx] = state.paint;
        }
        refresh();
      };
      net.appendChild(cell);
    }
  });
}

function updateValidation() {
  const v = validate(state.facelets);
  const el = $('validation');
  if (v.ok) {
    el.textContent = state.facelets === SOLVED ? 'This cube is already solved!' : 'Looks good — this cube is solvable.';
    el.className = 'validation ok';
  } else {
    el.textContent = v.error;
    el.className = 'validation bad';
    offerScanFix(el);
  }
  const solveBtn = $('solve');
  if (state.phase === 'scan' && !pendingSolve) {
    solveBtn.disabled = !v.ok || state.facelets === SOLVED;
    solveBtn.textContent = solverReady ? 'Solve it' : 'Solve it (solver loading…)';
  }
}

/** If the scan is unsolvable because of a typical scanning mistake, offer to repair it. */
function offerScanFix(el) {
  const fixes = findScanFixes(state.facelets);
  if (!fixes.length) return;
  // Repairs can disagree about which color sits on the right; if so, ask the user.
  const byRightColor = new Map();
  for (const fix of fixes) {
    const right = state.faceColor[fix.transform.swapRL ? 'L' : 'R'];
    if (!byRightColor.has(right)) byRightColor.set(right, fix);
  }
  const box = document.createElement('div');
  box.className = 'fix-box';
  if (byRightColor.size === 1) {
    const { transform } = fixes[0];
    const reasons = [];
    if (transform.swapRL) reasons.push('the cube was turned to the right instead of the left');
    if (transform.mirror) reasons.push('your camera image is mirrored');
    const turned = FACES.filter((_, i) => transform.rots[i]).map((f) => SIDE[f]);
    if (turned.length) reasons.push(`the ${turned.join(', ')} face${turned.length > 1 ? 's were' : ' was'} scanned turned sideways`);
    box.innerHTML = `It looks like ${reasons.join(', and ')}.`;
    const btn = document.createElement('button');
    btn.className = 'btn fix';
    btn.textContent = 'Fix it automatically';
    btn.onclick = () => applyScanFix(transform);
    box.append(btn);
  } else {
    box.innerHTML = 'This looks like a left/right mix-up while scanning, and it can be fixed. One question: ' +
      `hold your cube with ${col('U')} on top and ${col('F')} facing you. Which color is on the <b>right</b> side?`;
    const row = document.createElement('div');
    row.className = 'row fix-choices';
    for (const [color, fix] of byRightColor) {
      const btn = document.createElement('button');
      btn.className = 'btn fix';
      btn.innerHTML = `<span class="swatch" style="background:${PALETTE[color]}"></span>${color}`;
      btn.onclick = () => applyScanFix(fix.transform);
      row.append(btn);
    }
    box.append(row);
  }
  el.append(box);
}

/** Applies a scan repair to the raw samples, manual fixes and center colors, so everything stays consistent. */
function applyScanFix(transform) {
  const src = scanTransformSources(transform);
  const relabel = relabelFor(transform);
  if (FACES.every((f) => state.samples[f])) {
    const flat = FACES.flatMap((f) => state.samples[f]);
    state.samples = Object.fromEntries(FACES.map((f, fi) => [f, src.slice(fi * 9, fi * 9 + 9).map((i) => flat[i])]));
  }
  const overrides = {};
  src.forEach((from, to) => {
    if (state.overrides[from] !== undefined) overrides[to] = relabel(state.overrides[from]);
  });
  state.overrides = overrides;
  const oldColors = { ...state.faceColor };
  state.colorFixes = Object.fromEntries(Object.entries(state.colorFixes).map(([f, name]) => [relabel(f), name]));
  if (transform.swapRL) { state.colorFixes.R = oldColors.L; state.colorFixes.L = oldColors.R; }
  refresh();
}

// ---- Solving ----------------------------------------------------------------

function startSolve(moves) {
  state.phase = 'solve';
  state.solution = moves;
  state.step = 0;
  $('solve').disabled = true;
  $('solve').textContent = 'Solving in progress →';
  $('solve-bar').hidden = false;
  $('stage-hint').hidden = true;
  $('hold').innerHTML = `Hold your cube with ${col('U')} on top and ${col('F')} facing you — keep it that way the whole time.`;
  cube.setState(state.facelets);
  cube.viewFace(null);
  renderMoves();
  renderStep();
}

function renderMoves() {
  const box = $('moves');
  box.innerHTML = '';
  state.solution.forEach((m, i) => {
    const chip = document.createElement('button');
    chip.className = 'chip' + (i < state.step ? ' done' : i === state.step ? ' now' : '');
    chip.textContent = m;
    chip.title = `Jump to step ${i + 1}`;
    chip.onclick = () => jumpTo(i);
    box.appendChild(chip);
  });
}

function renderStep() {
  const n = state.solution.length;
  const done = state.step >= n;
  $('step-count').textContent = done ? `Done — ${n} moves` : `Step ${state.step + 1} of ${n}`;
  const badge = $('move-badge');
  badge.textContent = done ? '✓' : state.solution[state.step];
  badge.classList.toggle('done', done);
  $('move-text').innerHTML = done
    ? 'Solved! Your cube should match the 3D one. 🎉<small>Press “New cube” to scan another one.</small>'
    : describeMove(state.solution[state.step]);
  $('prev').disabled = state.step === 0;
  $('next').disabled = done;
  $('play').disabled = done;
  renderMoves();
  cube.whenIdle(() => cube.showArrow(state.phase === 'solve' ? state.solution[state.step] : null));
}

function next() {
  if (state.phase !== 'solve' || state.step >= state.solution.length) return stopPlay();
  cube.showArrow(null);
  cube.move(state.solution[state.step]);
  state.step++;
  renderStep();
  if (state.step >= state.solution.length) stopPlay();
}

function prev() {
  if (state.phase !== 'solve' || state.step === 0) return;
  stopPlay();
  cube.showArrow(null);
  state.step--;
  cube.move(invertMove(state.solution[state.step]));
  renderStep();
}

function jumpTo(i) {
  stopPlay();
  state.step = i;
  cube.setState(applyAlg(state.facelets, state.solution.slice(0, i)));
  renderStep();
}

function togglePlay() {
  if (state.playing) return stopPlay();
  if (state.step >= state.solution.length) return;
  $('play').textContent = '❚❚ Pause';
  const tick = () => {
    next();
    if (state.playing) state.playing = setTimeout(() => cube.whenIdle(tick), 900 / cube.speed);
  };
  state.playing = true;
  tick();
}

function stopPlay() {
  if (state.playing && state.playing !== true) clearTimeout(state.playing);
  state.playing = null;
  $('play').textContent = '▶ Play';
}

function resetAll() {
  stopPlay();
  state.phase = 'scan';
  state.samples = {};
  state.overrides = {};
  state.colorFixes = {};
  state.manualColors = false;
  state.scanStep = 0;
  state.solution = [];
  $('solve-bar').hidden = true;
  $('stage-hint').hidden = false;
  cube.viewFace(SCAN_STEPS[0].face);
  refresh();
}

/** Fill the cube with a random (valid) scramble — handy to try the app without a camera. */
function demo() {
  resetAll();
  const scrambled = applyAlg(SOLVED, randomScramble());
  for (let i = 0; i < 54; i++) if (i % 9 !== 4) state.overrides[i] = scrambled[i];
  state.manualColors = true;
  state.scanStep = SCAN_STEPS.length;
  cube.viewFace(null);
  refresh();
}

// ---- Wiring -----------------------------------------------------------------

$('start-camera').onclick = startCamera;
$('capture').onclick = capture;
$('demo').onclick = demo;
$('reset').onclick = resetAll;
$('solve').onclick = () => {
  if (!validate(state.facelets).ok) return;
  $('solve').disabled = true;
  requestSolve(state.facelets);
};
$('next').onclick = () => { stopPlay(); next(); };
$('prev').onclick = prev;
$('play').onclick = togglePlay;
$('exit-solve').onclick = resetAll;
$('speed').oninput = (e) => { cube.speed = Number(e.target.value); };

window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea')) return;
  if (state.phase === 'solve') {
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); stopPlay(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
    else if (e.key.toLowerCase() === 'p') togglePlay();
  } else if (e.key === ' ') {
    e.preventDefault();
    capture();
  }
});

cube.viewFace(SCAN_STEPS[0].face);
refresh();

if (import.meta.env.DEV) window.__app = { state, refresh }; // debugging hook
