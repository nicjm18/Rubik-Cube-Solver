import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { FACES, FACE_NORMALS, faceletIndex, MOVE_DEFS, parseMove } from './cubeModel.js';

// Display colors by name. Which face gets which color is decided from the scanned centers.
export const PALETTE = {
  white: '#f4f4f0',
  red: '#d8202c',
  green: '#12a150',
  yellow: '#ffd21f',
  orange: '#ff7b12',
  blue: '#1b5fd9',
};
export const UNKNOWN_COLOR = '#4b5160';

const AXES = ['x', 'y', 'z'];
const AXIS_VECTORS = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
const DEFAULT_VIEW = new THREE.Vector3(4.2, 4.4, 7.6);
const VIEW_DISTANCE = DEFAULT_VIEW.length();

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

function stickerGeometry(size, radius) {
  const s = size / 2, r = radius;
  const shape = new THREE.Shape();
  shape.moveTo(-s + r, -s);
  shape.lineTo(s - r, -s);
  shape.quadraticCurveTo(s, -s, s, -s + r);
  shape.lineTo(s, s - r);
  shape.quadraticCurveTo(s, s, s - r, s);
  shape.lineTo(-s + r, s);
  shape.quadraticCurveTo(-s, s, -s, s - r);
  shape.lineTo(-s, -s + r);
  shape.quadraticCurveTo(-s, -s, -s + r, -s);
  return new THREE.ShapeGeometry(shape, 4);
}

export class Cube3D {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    this.camera.position.copy(DEFAULT_VIEW);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(5, 9, 7);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-6, -3, -5);
    this.scene.add(fill);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 7;
    this.controls.maxDistance = 20;

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.bodyGeo = new RoundedBoxGeometry(0.96, 0.96, 0.96, 3, 0.1);
    this.bodyMat = new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.6 });
    this.stickerGeo = stickerGeometry(0.8, 0.12);
    this.stickerMats = Object.fromEntries(
      [...FACES, '?'].map((k) => [k, new THREE.MeshStandardMaterial({ color: UNKNOWN_COLOR, roughness: 0.35 })]),
    );

    this.cubies = [];
    this.queue = [];
    this.current = null; // running animation
    this.cameraTween = null;
    this.speed = 1; // animation speed multiplier
    this.arrow = null;
    this.idleCallbacks = [];

    this.setState('?'.repeat(54));

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop((t) => this.tick(t));
  }

  /** colors: { U: '#hex', R: ..., ... } — the display color of each face's stickers. */
  setFaceColors(colors) {
    for (const f of FACES) this.stickerMats[f].color.set(colors[f]);
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    // keep the whole cube in view on narrow screens
    this.camera.fov = w < h ? 34 * Math.min(1.6, h / w) : 34;
    this.camera.updateProjectionMatrix();
  }

  /** Rebuild the cube from a 54-char facelet string (URFDLB letters or '?'). Cancels animations. */
  setState(facelets) {
    this.queue = [];
    if (this.current) {
      this.current.resolve();
      this.current = null;
    }
    this.root.clear();
    this.cubies = [];
    for (let x = -1; x <= 1; x++) {
      for (let y = -1; y <= 1; y++) {
        for (let z = -1; z <= 1; z++) {
          if (!x && !y && !z) continue;
          const cubie = new THREE.Group();
          cubie.position.set(x, y, z);
          cubie.add(new THREE.Mesh(this.bodyGeo, this.bodyMat));
          for (const f of FACES) {
            const n = FACE_NORMALS[f];
            if (n[0] !== 0 && n[0] !== x) continue;
            if (n[1] !== 0 && n[1] !== y) continue;
            if (n[2] !== 0 && n[2] !== z) continue;
            const color = facelets[faceletIndex([x, y, z], n)];
            const sticker = new THREE.Mesh(this.stickerGeo, this.stickerMats[color] || this.stickerMats['?']);
            const normal = new THREE.Vector3(...n);
            sticker.position.copy(normal).multiplyScalar(0.483);
            sticker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
            cubie.add(sticker);
          }
          this.root.add(cubie);
          this.cubies.push(cubie);
        }
      }
    }
    this.showArrow(null);
  }

  /** Queue an animated move ("R", "U'", "F2"...). Resolves when it finishes. */
  move(m) {
    return new Promise((resolve) => {
      this.queue.push({ m, resolve });
    });
  }

  get busy() {
    return !!this.current || this.queue.length > 0;
  }

  /** Runs cb once no moves are queued or running. */
  whenIdle(cb) {
    if (!this.busy) cb();
    else this.idleCallbacks.push(cb);
  }

  startNext(now) {
    const next = this.queue.shift();
    if (!next) return;
    const { face, turns } = parseMove(next.m);
    const { axis, layer, dir } = MOVE_DEFS[face];
    const pivot = new THREE.Object3D();
    this.root.add(pivot);
    for (const c of this.cubies) {
      if (Math.round(c.position.getComponent(axis)) === layer) pivot.attach(c);
    }
    const base = 380 / this.speed;
    this.current = {
      pivot,
      axis,
      angle: (dir * turns * Math.PI) / 2,
      start: now,
      duration: turns === 2 ? base * 1.5 : base,
      resolve: next.resolve,
    };
  }

  finishCurrent() {
    const { pivot, resolve } = this.current;
    pivot.updateMatrixWorld();
    for (const c of [...pivot.children]) {
      this.root.attach(c);
      c.position.set(Math.round(c.position.x), Math.round(c.position.y), Math.round(c.position.z));
      // snap rotation to exact multiples of 90° to avoid drift
      const m = new THREE.Matrix4().makeRotationFromQuaternion(c.quaternion);
      for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) m.elements[i] = Math.round(m.elements[i]);
      c.quaternion.setFromRotationMatrix(m);
    }
    this.root.remove(pivot);
    this.current = null;
    resolve();
  }

  tick(now) {
    if (!this.current && this.queue.length) this.startNext(now);
    if (this.current) {
      const c = this.current;
      const t = Math.min(1, (now - c.start) / c.duration);
      c.pivot.rotation[AXES[c.axis]] = c.angle * easeInOut(t);
      if (t >= 1) {
        this.finishCurrent();
        if (this.queue.length) this.startNext(now);
        else {
          const cbs = this.idleCallbacks;
          this.idleCallbacks = [];
          cbs.forEach((cb) => cb());
        }
      }
    }
    if (this.cameraTween) this.stepCamera(now);
    if (this.arrow) this.arrow.children.forEach((c) => (c.material.opacity = 0.75 + 0.25 * Math.sin(now / 220)));
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  // ---- Camera --------------------------------------------------------------

  /** Smoothly move the camera to look straight at a face (or the default 3/4 view when face is null). */
  viewFace(face) {
    let target;
    if (!face) target = DEFAULT_VIEW.clone();
    else {
      target = new THREE.Vector3(...FACE_NORMALS[face]).multiplyScalar(VIEW_DISTANCE);
      // For U/D, stay slightly on the front side so the front edge is at the bottom (U) / top (D).
      if (face === 'U' || face === 'D') target.z = 0.02;
    }
    const from = new THREE.Spherical().setFromVector3(this.camera.position);
    const to = new THREE.Spherical().setFromVector3(target);
    let dTheta = to.theta - from.theta;
    if (dTheta > Math.PI) dTheta -= 2 * Math.PI;
    if (dTheta < -Math.PI) dTheta += 2 * Math.PI;
    this.cameraTween = { from, dTheta, to, start: performance.now(), duration: 700 };
  }

  stepCamera(now) {
    const { from, dTheta, to, start, duration } = this.cameraTween;
    const t = Math.min(1, (now - start) / duration);
    const e = easeInOut(t);
    const s = new THREE.Spherical(
      from.radius + (to.radius - from.radius) * e,
      from.phi + (to.phi - from.phi) * e,
      from.theta + dTheta * e,
    );
    this.camera.position.setFromSpherical(s);
    this.camera.lookAt(0, 0, 0);
    if (t >= 1) this.cameraTween = null;
  }

  // ---- Direction arrow -----------------------------------------------------

  /** Shows a ring of arrows around the layer that the given move turns (null hides it). */
  showArrow(m) {
    if (this.arrow) {
      this.scene.remove(this.arrow);
      this.arrow.traverse((o) => o.geometry?.dispose());
      this.arrow = null;
    }
    if (!m) return;
    const { face, turns } = parseMove(m);
    const { axis, layer, dir } = MOVE_DEFS[face];
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0xff3d9a, transparent: true, opacity: 1 });
    const R = 2.3, tube = 0.055, segs = 3, arc = (Math.PI * 2) / segs - 0.45;
    for (let k = 0; k < segs; k++) {
      const a0 = (k * Math.PI * 2) / segs;
      const torus = new THREE.Mesh(new THREE.TorusGeometry(R, tube, 8, 40, arc), mat.clone());
      torus.rotation.z = a0;
      group.add(torus);
      const heads = turns === 2 ? [0, 0.22] : [0];
      for (const back of heads) {
        const a1 = a0 + arc - back;
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.4, 16), mat.clone());
        const tangent = new THREE.Vector3(-Math.sin(a1), Math.cos(a1), 0);
        cone.position.set(R * Math.cos(a1), R * Math.sin(a1), 0).addScaledVector(tangent, 0.12);
        cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);
        group.add(cone);
      }
    }
    // Arrow ring is drawn counter-clockwise around local +Z; a positive rotation about +Z.
    const sign = Math.sign(dir * turns);
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), AXIS_VECTORS[axis].clone().multiplyScalar(sign));
    group.position.copy(AXIS_VECTORS[axis]).multiplyScalar(layer);
    this.arrow = group;
    this.scene.add(group);
  }
}
