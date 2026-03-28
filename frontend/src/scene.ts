import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const VIEW_PRESETS: Record<string, [number, number, number]> = {
  lateral_left:  [-300, 0, 0],
  lateral_right: [300, 0, 0],
  dorsal:        [0, 0, 300],
  ventral:       [0, 0, -300],
  anterior:      [0, 300, 0],
  posterior:     [0, -300, 0],
};

export interface SceneContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
}

export function initScene(canvas: HTMLCanvasElement): SceneContext {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a1a);

  scene.add(new THREE.AmbientLight(0xffffff, 0.5));

  const key = new THREE.DirectionalLight(0xffffff, 0.8);
  key.position.set(100, 200, 150);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xffffff, 0.4);
  fill.position.set(-100, -50, -100);
  scene.add(fill);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);

  const camera = new THREE.PerspectiveCamera(45, 1, 1, 1000);
  camera.up.set(0, 0, 1);
  camera.position.set(-300, 0, 0);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 100;
  controls.maxDistance = 600;
  controls.screenSpacePanning = true;

  return { scene, camera, renderer, controls };
}

/**
 * Yoke two hemisphere OrbitControls so that rotating/zooming/panning one
 * mirrors the movement on the other (X-axis mirrored for bilateral view).
 * Returns an object with an `enabled` property to toggle yoking at runtime.
 */
export function yokeControls(
  ctxA: SceneContext,
  ctxB: SceneContext,
): { enabled: boolean } {
  const yoke = { enabled: true };
  let syncing = false;

  function mirrorAtoB(src: SceneContext, dst: SceneContext): void {
    if (!yoke.enabled || syncing) return;
    syncing = true;

    dst.camera.position.set(
      -src.camera.position.x,
      src.camera.position.y,
      src.camera.position.z,
    );
    dst.controls.target.set(
      -src.controls.target.x,
      src.controls.target.y,
      src.controls.target.z,
    );
    dst.controls.update();

    syncing = false;
  }

  ctxA.controls.addEventListener('change', () => mirrorAtoB(ctxA, ctxB));
  ctxB.controls.addEventListener('change', () => mirrorAtoB(ctxB, ctxA));

  return yoke;
}

export function resizeToContainer(ctx: SceneContext, container: HTMLElement): void {
  const w = container.clientWidth;
  const h = container.clientHeight;
  ctx.camera.aspect = w / h;
  ctx.camera.updateProjectionMatrix();
  ctx.renderer.setSize(w, h);
}

export function applyViewPreset(ctx: SceneContext, presetName: string): void {
  const pos = VIEW_PRESETS[presetName];
  if (!pos) return;
  ctx.camera.up.set(0, 0, 1);
  ctx.camera.position.set(pos[0], pos[1], pos[2]);
  ctx.controls.target.set(0, 0, 0);
  ctx.controls.update();
}
