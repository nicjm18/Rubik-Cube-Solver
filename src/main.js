import { Cube3D, PALETTE, UNKNOWN_COLOR } from './cube3d.js';
import { Scanner, classify, colorFeatures, featureDist } from './scanner.js';
import { assembleFaces, rotateGrid, mirrorGrid } from './assemble.js';
import {
  FACES, SOLVED, validate, scanTransformSources, relabelFor, applyAlg, parseAlg, parseMove, invertMove, randomScramble,
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

// Live capture tuning
const HOLD_MS = 800; // how long a face must be held still to be captured
const MIN_UNIFORM = 0.6; // each cell must be mostly one color...
const MIN_BRIGHTNESS = 35; // ...and not too dark
const STEADY_DIST = 12 ** 2; // max color change per cell between frames while "still"
const SAME_FACE_DIST = 25 ** 2; // center colors closer than this are the same face

const MIRROR_KEY = 'cubeSolver.cameraMirrored';

const hex = (f) => (f === '?' ? UNKNOWN_COLOR : PALETTE[state.faceColor[f]]);
const sw = (f) => `<span class="swatch" style="background:${hex(f)}"></span>`;
const col = (f) => `${sw(f)}<b>${state.faceColor[f].toUpperCase()}</b>`;
const known = (f) => !!state.samples[f] || !!state.colorFixes[f] || state.manualColors;
const rgbCss = ([r, g, b]) => `rgb(${r},${g},${b})`;

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

function loadMirrored() {
  try {
    const v = localStorage.getItem(MIRROR_KEY);
    return v === 'true' ? true : v === 'false' ? false : null;
  } catch {
    return null;
  }
}

const state = {
  phase: 'scan', // 'scan' | 'solve'
  liveFaces: [], // faces captured by the camera, in order: { colors: 9 RGB, raw camera orientation }
  assembly: null, // result of putting the 6 faces together
  samples: {}, // position (URFDLB) -> 9 RGB samples, once positions are known
  overrides: {}, // facelet index -> letter (manual fixes)
  facelets: '',
  faceColor: { ...STANDARD_SCHEME }, // face -> color name, detected from the centers
  colorFixes: {}, // face -> color name chosen by hand for a center
  manualColors: false, // colors entered without the camera (demo)
  mirrored: loadMirrored(), // does the camera send a mirrored image? null = not known yet
  askSide: false, // ask the one-time "which color is on the right" question
  checking: false, // camera direction check running
  checkNote: '',
  liveStatus: '',
  paint: 'U',
  solution: [],
  step: 0,
  playing: null,
};
const hold = { prev: null, since: null };

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

// ---- Colors and facelets --------------------------------------------------

const permutations = (a) =>
  a.length <= 1 ? [a] : a.flatMap((x, i) => permutations([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]));
const ALL_ASSIGNMENTS = permutations(COLOR_NAMES);

function nearestColorName(rgb) {
  const v = colorFeatures(rgb);
  return COLOR_NAMES.reduce((best, name) =>
    featureDist(v, colorFeatures(REFERENCE_RGB[name])) < featureDist(v, colorFeatures(REFERENCE_RGB[best])) ? name : best);
}

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
  cube.controls.autoRotate = state.phase === 'scan' && !state.assembly && !state.manualColors;
  renderPalette();
  renderFaces();
  renderNet();
  renderInstruction();
  updateValidation();
}

// ---- Live scanning --------------------------------------------------------

/** A captured face as it really looks (undoing a mirrored camera image). */
const trueGrid = (face) => (state.mirrored ? mirrorGrid(face.colors) : face.colors);

/** Index of an already captured face with the same center color, or -1. */
function findSameFace(colors) {
  const v = colorFeatures(colors[4]);
  return state.liveFaces.findIndex((f) => featureDist(v, colorFeatures(f.colors[4])) < SAME_FACE_DIST);
}

function handleFrame(live) {
  if (state.phase !== 'scan' || state.checking || state.liveFaces.length >= 6) {
    scanner.progress = 0;
    return;
  }
  const feats = live.colors.map(colorFeatures);
  const oneColor = feats.every((f) => featureDist(f, feats[4]) < SAME_FACE_DIST);
  const looksLikeFace = live.uniform.every((u) => u >= MIN_UNIFORM) &&
    live.brightness.every((b) => b >= MIN_BRIGHTNESS) &&
    (!oneColor || live.gapsDark); // a plain wall is one color too, so then require the dark lines of a cube
  const steady = !!hold.prev && feats.every((f, i) => featureDist(f, hold.prev[i]) < STEADY_DIST);
  hold.prev = feats;

  if (!looksLikeFace || !steady) {
    hold.since = null;
    scanner.progress = 0;
    setLiveStatus(looksLikeFace ? 'Hold it still…' : '');
    return;
  }
  const same = findSameFace(live.colors);
  if (same >= 0) {
    hold.since = null;
    scanner.progress = 0;
    setLiveStatus(`Got this face (#${same + 1}). Turn the cube to show another one.`);
    return;
  }
  const now = performance.now();
  hold.since ??= now;
  scanner.progress = (now - hold.since) / HOLD_MS;
  setLiveStatus('Hold it still…');
  if (scanner.progress >= 1) {
    scanner.progress = 0;
    hold.since = null;
    addFace(live.colors.map((c) => c.slice()));
  }
}

function setLiveStatus(text) {
  if (text === state.liveStatus) return;
  state.liveStatus = text;
  $('live-status').textContent = text;
}

function addFace(colors) {
  // capturing a face that's already there replaces it (handy to re-take a misread face)
  const same = findSameFace(colors);
  if (same >= 0) state.liveFaces[same] = { colors };
  else if (state.liveFaces.length < 6) state.liveFaces.push({ colors });
  else return;
  $('camera').classList.remove('flash');
  void $('camera').offsetWidth;
  $('camera').classList.add('flash');
  syncFaces();
}

function removeFace(k) {
  state.liveFaces.splice(k, 1);
  syncFaces();
}

/** Recomputes cube positions from the captured faces. */
function syncFaces() {
  state.manualColors = false;
  state.overrides = {};
  state.colorFixes = {};
  state.assembly = null;
  state.askSide = false;
  if (state.liveFaces.length === 6) {
    assemble();
  } else {
    // until all faces are in, only the first one has a known place: it's the front
    state.samples = state.liveFaces.length ? { F: trueGrid(state.liveFaces[0]) } : {};
  }
  refresh();
}

function assemble() {
  const grids = state.liveFaces.map(trueGrid);
  const keys = grids.map((_, k) => String(k));
  const labels = classify(Object.fromEntries(grids.map((g, k) => [keys[k], g])), keys);
  const classGrids = grids.map((_, k) => labels.slice(k * 9, k * 9 + 9).split('').map(Number));
  const result = assembleFaces(classGrids);
  state.assembly = result;
  state.samples = Object.fromEntries(FACES.map((p) => [p, rotateGrid(grids[result.gridAt[p]], result.rotation[p])]));
  state.askSide = state.mirrored === null;
  cube.viewFace(null);
}

function capture() {
  if (state.phase !== 'scan' || !scanner.running || state.checking) return;
  const colors = scanner.capture();
  if (colors) addFace(colors);
}

// ---- Camera ---------------------------------------------------------------

async function startCamera() {
  $('camera-error').hidden = true;
  try {
    await scanner.start();
    $('camera').classList.add('on');
    if (state.mirrored === null) runCameraCheck();
    else refresh({ redraw3d: false });
  } catch (err) {
    $('camera-error').hidden = false;
    $('camera-error').textContent =
      err.name === 'NotAllowedError'
        ? 'Camera permission was denied. Allow it in your browser, or fill the colors by hand below.'
        : `Could not start the camera (${err.name || err}). You can fill the colors by hand below.`;
  }
}

async function runCameraCheck() {
  if (!scanner.running) return;
  state.checking = true;
  state.checkNote = '';
  refresh({ redraw3d: false });
  const result = await scanner.detectMirroring();
  if (!state.checking) return; // skipped
  state.checking = false;
  if (result === null) {
    state.checkNote = "I couldn't see the movement. No problem: I'll ask you one question at the end instead.";
    refresh({ redraw3d: false });
  } else {
    setMirrored(result);
    state.checkNote = `Camera check done: your camera image is ${result ? 'mirrored' : 'normal'}.`;
    refresh({ redraw3d: false });
  }
}

function skipCameraCheck() {
  state.checking = false;
  scanner.cancelMotion();
  state.checkNote = "Skipped. I'll ask you one question at the end instead.";
  refresh({ redraw3d: false });
}

/** Records whether the camera mirrors, and fixes an already assembled cube if that changed. */
function setMirrored(value) {
  const before = state.mirrored ?? false;
  state.mirrored = value;
  try { localStorage.setItem(MIRROR_KEY, String(value)); } catch { /* storage unavailable */ }
  state.askSide = false;
  // a mirrored camera image shows the reflection of the real cube: undo it
  if (value !== before) {
    if (state.assembly) applyTransform({ swapRL: true, mirror: true });
    else if (state.liveFaces.length) syncFaces();
  }
  updatePreviewMirroring();
  refresh();
}

/** Show the preview like a mirror: flip a normal camera image, leave an already mirrored one alone. */
function updatePreviewMirroring() {
  $('mirror-wrap').classList.toggle('flip', !state.mirrored);
}

/** Applies a scan transform to the samples, manual fixes and center colors, keeping them consistent. */
function applyTransform(transform) {
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
}

// ---- Scan UI --------------------------------------------------------------

function renderInstruction() {
  const n = state.liveFaces.length;
  $('scan-progress').textContent = `${n} / 6`;
  $('capture').disabled = !scanner.running || state.checking || state.phase !== 'scan';
  let html;
  if (state.checking) {
    html = '<b>Quick camera check (only once):</b> hold the cube in the middle of the picture, ' +
      'then slowly move it to <b>your right</b> →<br><button class="link" id="skip-check">Skip</button>';
  } else if (n < 6 && !scanner.running) {
    html = state.manualColors
      ? 'Colors filled in by hand. Check them below, then press <b>Solve it</b>.'
      : 'Turn on the camera, then show the faces of your cube one by one.';
  } else if (n < 6) {
    html = `Show each face of the cube inside the square, <b>in any order and any way up</b>. ` +
      `Hold it still for a moment and it's captured automatically. ${n ? `${6 - n} to go!` : ''}`;
    if (state.checkNote) html = `<span class="muted">${state.checkNote}</span><br>` + html;
  } else {
    html = 'All 6 faces found! Check the colors below, then press <b>Solve it</b>. ' +
      'To re-take a face, show it again and press <b>Capture now</b>, or remove it with ×.';
  }
  $('scan-instruction').innerHTML = html;
  $('skip-check')?.addEventListener('click', skipCameraCheck);
  $('live-status').hidden = !scanner.running || state.checking || n >= 6;
  const mode = $('camera-mode');
  mode.hidden = !scanner.running || state.checking;
  mode.innerHTML = state.mirrored === null
    ? 'Camera direction: not checked yet · <button class="link" id="recheck">Check now</button>'
    : `Camera image: ${state.mirrored ? 'mirrored' : 'normal'} · <button class="link" id="recheck">Check again</button>`;
  $('recheck')?.addEventListener('click', runCameraCheck);
}

function renderFaces() {
  const box = $('faces');
  box.innerHTML = '';
  for (let k = 0; k < 6; k++) {
    const face = state.liveFaces[k];
    const slot = document.createElement('div');
    slot.className = 'face-thumb' + (face ? ' filled' : '');
    const mini = document.createElement('div');
    mini.className = 'mini';
    // shown the way it looked in the preview
    const shown = face ? (state.mirrored ? face.colors : mirrorGrid(face.colors)) : null;
    for (let i = 0; i < 9; i++) {
      const cell = document.createElement('i');
      if (shown) cell.style.background = rgbCss(shown[i]);
      mini.appendChild(cell);
    }
    const label = document.createElement('span');
    label.textContent = face ? nearestColorName(face.colors[4]) : `${k + 1}`;
    slot.append(mini, label);
    if (face) {
      const del = document.createElement('button');
      del.className = 'remove';
      del.title = 'Remove this face';
      del.textContent = '×';
      del.onclick = () => removeFace(k);
      slot.append(del);
    }
    box.appendChild(slot);
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
  if (v.ok && state.askSide) {
    el.className = 'validation';
    el.innerHTML = '<div class="fix-box">One question, only needed once: hold your cube with ' +
      `${col('U')} on top and ${col('F')} facing you. Which color is on the <b>right</b> side?</div>`;
    const row = document.createElement('div');
    row.className = 'row fix-choices';
    for (const [face, mirrored] of [['R', false], ['L', true]]) {
      const btn = document.createElement('button');
      btn.className = 'btn fix';
      btn.innerHTML = `${sw(face)}${state.faceColor[face]}`;
      btn.onclick = () => setMirrored(mirrored);
      row.append(btn);
    }
    el.append(row);
  } else if (v.ok) {
    el.textContent = state.facelets === SOLVED ? 'This cube is already solved!' : 'Looks good — this cube is solvable.';
    el.className = 'validation ok';
  } else if (state.assembly && !state.assembly.valid && !Object.keys(state.overrides).length) {
    el.textContent = 'Some stickers seem to be misread, so the faces don\'t fit together perfectly. ' +
      'Compare the map with your cube and fix the wrong stickers, or re-take a face.';
    el.className = 'validation bad';
  } else {
    el.textContent = v.error;
    el.className = 'validation bad';
  }
  const solveBtn = $('solve');
  if (state.phase === 'scan' && !pendingSolve) {
    solveBtn.disabled = !v.ok || state.askSide || state.facelets === SOLVED;
    solveBtn.textContent = solverReady ? 'Solve it' : 'Solve it (solver loading…)';
  }
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
  cube.controls.autoRotate = false;
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
  state.liveFaces = [];
  state.solution = [];
  $('solve-bar').hidden = true;
  $('stage-hint').hidden = false;
  cube.viewFace(null);
  syncFaces();
}

/** Fill the cube with a random (valid) scramble — handy to try the app without a camera. */
function demo() {
  resetAll();
  const scrambled = applyAlg(SOLVED, randomScramble());
  for (let i = 0; i < 54; i++) if (i % 9 !== 4) state.overrides[i] = scrambled[i];
  state.manualColors = true;
  refresh();
}

// ---- Wiring -----------------------------------------------------------------

scanner.onFrame = handleFrame;
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

cube.controls.autoRotateSpeed = 1.5;
cube.viewFace(null);
updatePreviewMirroring();
refresh();

if (import.meta.env.DEV) window.__app = { state, refresh, scanner, handleFrame, addFace, syncFaces }; // debugging hook
