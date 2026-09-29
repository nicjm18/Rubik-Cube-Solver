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

1. **Scan.** Click *Turn on camera*. Pick any face as the front and keep the same face on top.
   Show the front, then turn the cube left a quarter turn three times, then show the top and the bottom.
   The on-screen hints walk you through each face. Press **Capture** or <kbd>Space</kbd> for each face. The 3D view turns to show the face
   you're scanning. To re-scan a face, click its thumbnail. Face colors come from your cube's centers,
   so non-standard color schemes (common on keychain and off-brand cubes) work too.
2. **Check the colors.** The 2D map shows what was detected. If a sticker is wrong, pick a color and click
   the sticker to fix it. If a center shows the wrong color, click the center to recolor it. The app checks
   that the cube is physically possible. If a face was scanned turned sideways, it offers to fix it for you.
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
| `src/scanner.js` | Webcam capture and sticker color sampling. Groups the 54 stickers into 6 colors of 9, using the centers as seeds, by brightness-independent color (chromaticity) |
| `src/solver.worker.js` | [cubejs](https://github.com/ldez/cubejs) Kociemba two-phase solver, which finds a solution in about 20 moves. It runs in a Web Worker because building its tables takes about 5 s |
| `src/cube3d.js` | Three.js cube with animated layer turns, the direction arrows, and camera moves |
| `src/main.js` | UI flow: scan, check, solve |

Run `npm test` to check the move model against cubejs and to confirm that the solver's solutions solve the cube.

Tips for good scans: use even light, avoid glare on the stickers, and keep the cube close enough to fill the grid.
