// Runs the Kociemba two-phase solver off the main thread (table setup takes a few seconds).
import Cube from 'cubejs';

Cube.initSolver();
self.postMessage({ type: 'ready' });

self.onmessage = (e) => {
  const { id, facelets } = e.data;
  try {
    const solution = Cube.fromString(facelets).solve();
    self.postMessage({ type: 'solution', id, solution });
  } catch (err) {
    self.postMessage({ type: 'error', id, error: String(err?.message || err) });
  }
};
