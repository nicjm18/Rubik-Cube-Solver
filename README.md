# Cube Solver

Scan a Rubik's cube with your webcam, see it as a 3D cube, and solve it step by step. Every time you
advance a step, the 3D cube performs the same turn, so your real cube and the 3D one are solved together.

## Run it

```bash
npm install
npm run dev
```

Vite opens the app at http://localhost:5173. The camera only works on `localhost` or HTTPS.

## How to use it

1. **Scan.** Click *Turn on camera*. The first time, a quick camera check asks you to move the cube
   to your right. This tells the app whether your webcam flips the image, and the browser remembers it.
   Then show the 6 faces inside the square, **in any order and any way up**. Hold each one still for
   a moment and it's captured automatically. The app works out how the faces fit together from the
   cube's own pieces. If you skip the camera check, it asks one question about your cube at the end instead.
   To re-take a face, show it again and press **Capture now**, or remove it with ×.
2. **Check the colors.** The 2D map shows the assembled cube. If a sticker is wrong, pick a color and
   click the sticker. If a center shows the wrong color, click the center to recolor it. The app checks
   that the cube is physically possible.
3. **Solve.** Hold the cube the way the app says (the top and front center colors are shown). Then follow the instructions:
   - <kbd>→</kbd> / <kbd>Space</kbd> / **Next**: next move (the 3D cube animates it)
   - <kbd>←</kbd> / **Back**: undo the last move
   - <kbd>P</kbd> / **Play**: play the moves automatically
   - Click any move chip to jump to that step.

   A pink ring of arrows around the 3D cube shows which layer to turn and in which direction.

No cube handy? Click **Try a random scramble**.

## How it works

| File | What it does |
| --- | --- |
| `src/cubeModel.js` | Cube logic: sticker geometry, moves, and a solvability check (twists, flips, parity) |
| `src/assemble.js` | Puts the 6 scanned faces together, whatever order and rotation they were shown in, by finding the only arrangement where all corners and edges make sense |
| `src/scanner.js` | Webcam capture, live face detection (auto-capture when a face is held still), the camera direction check, and sticker color sampling. Groups the 54 stickers into 6 colors of 9, using the centers as seeds, by brightness-independent color (chromaticity) |
| `src/solver.worker.js` | [cubejs](https://github.com/ldez/cubejs) Kociemba two-phase solver, which finds a solution in about 20 moves. It runs in a Web Worker because building its tables takes about 5 s |
| `src/cube3d.js` | Three.js cube with animated layer turns, the direction arrows, and camera moves |
| `src/main.js` | UI flow: scan, check, solve |

Run `npm test` to check the move model against cubejs and to confirm that the solver's solutions solve the cube.

Tips for good scans: use even light, avoid glare on the stickers, and keep the cube close enough to fill the grid.
