// The painted sheet: washi ground (the whole sea, past every edge), the calligraphic wave strokes, and a
// soft light rig for the figures and dice (the board itself is unlit ink and wash). No table, slab, frame,
// brass, compass or graticule (docs/INK.md B §7).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { BoardGeometry } from '../map/types';
import { GROUND_FRAG, GROUND_VERT, INK_GLSL, type SharedUniforms } from './inkGlsl';
import type { InkLayer } from './ink';
import { PAPER_DEEP } from './util';

export interface SceneParts {
  scene: THREE.Scene;
  ground: THREE.Mesh;
  waves: WaveStrokes;
  key: THREE.DirectionalLight;
  envTexture: THREE.Texture;
  materials: THREE.Material[];
}

/** Old frame width (the camera's framing pads by it). */
export const FRAME_W = 2.3;

const WAVE_VERT = /* glsl */ `
uniform vec2 uBoard;
uniform float uTime;
uniform float uAmb;
uniform float uPhase;
varying vec2 vUv;
varying vec2 vBP;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  // (v4 E10: the wave marks are printed texture and hold still; the mist drifts over them)
  vBP = vec2(w.x + uBoard.x * 0.5, uBoard.y * 0.5 - w.z);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const WAVE_FRAG = /* glsl */ `
${INK_GLSL}
uniform sampler2D uWaves;
uniform float uRow;
uniform float uRows;
uniform float uAlpha;
uniform float uPhase;
varying vec2 vUv;
varying vec2 vBP;
void main() {
  float a = texture2D(uWaves, vec2(vUv.x, (uRow + 1.0 - vUv.y) / uRows)).r;
  // (v4 E10 / E3: still, and Layer 3: ≤ 15 % against the sea)
  a *= uAlpha;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uInkCoast * vignette(), a);
}
`;

/** 6–8 calligraphic wave strokes on the open sea, placed per game (seeded), ivory at 10–14 %. */
export class WaveStrokes {
  group = new THREE.Group();
  private meshes: THREE.Mesh[] = [];
  private mats: THREE.ShaderMaterial[] = [];
  private geo: THREE.PlaneGeometry;
  private placedSeed = NaN;

  constructor(
    private g: BoardGeometry,
    private ink: InkLayer,
    shared: SharedUniforms,
  ) {
    this.geo = new THREE.PlaneGeometry(1, 1);
    this.geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 8; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          ...shared,
          uWaves: { value: ink.waves },
          uRow: { value: 0 },
          uRows: { value: ink.waveRows },
          uAlpha: { value: 0.12 },
          uPhase: { value: i * 1.7 },
        },
        vertexShader: WAVE_VERT,
        fragmentShader: WAVE_FRAG,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      });
      const m = new THREE.Mesh(this.geo, mat);
      m.renderOrder = 1;
      m.visible = false;
      this.meshes.push(m);
      this.mats.push(mat);
      this.group.add(m);
    }
    this.place(7);
  }

  /** Whether any sea lane's polyline passes through the box centred at (x, y), half-sizes hx × hy (board units). */
  nearLane(x: number, y: number, hx: number, hy: number): boolean {
    const inBox = (px: number, py: number) => Math.abs(px - x) <= hx && Math.abs(py - y) <= hy;
    for (const l of this.g.seaLanes)
      for (const seg of l.segments)
        for (let i = 1; i < seg.length; i++) {
          const [ax, ay] = seg[i - 1];
          const [bx, by] = seg[i];
          const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.25));
          for (let k = 0; k <= n; k++) if (inBox(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n)) return true;
        }
    return false;
  }

  /** Scatter the strokes over open water (≥ 2.2 units from any coast, clear of the sea lanes, apart from each other). */
  place(seed: number): void {
    if (seed === this.placedSeed) return;
    this.placedSeed = seed;
    let s = (seed >>> 0) * 2654435761 + 12345;
    const rnd = () => {
      s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x6d2b79f5) >>> 0;
      s ^= s >>> 13;
      return ((s >>> 0) % 100000) / 100000;
    };
    const W = this.g.width;
    const H = this.g.height;
    const placed: [number, number, number][] = [];
    const want = 6 + Math.floor(rnd() * 3);
    for (let tries = 0; tries < 600 && placed.length < want; tries++) {
      const len = 6.5 + rnd() * 3;
      const x = 4 + rnd() * (W - 8);
      const y = 3 + rnd() * (H - 6);
      // the whole stroke on open water
      let ok = true;
      for (const f of [-0.5, -0.25, 0, 0.25, 0.5])
        if (this.ink.seaDistance(x + f * len, y) < 2.2) {
          ok = false;
          break;
        }
      if (!ok) continue;
      // v4 E9: never under a sea lane (the stroke's box, len × 0.3 len, plus a unit of air)
      if (this.nearLane(x, y, len / 2 + 1, len * 0.15 + 1)) continue;
      if (placed.some(([px, py]) => Math.hypot((px - x) * 0.7, py - y) < 11)) continue;
      placed.push([x, y, len]);
    }
    this.meshes.forEach((m, i) => {
      const p = placed[i];
      m.visible = !!p;
      if (!p) return;
      const [x, y, len] = p;
      m.position.set(x - W / 2, 0.012, H / 2 - y);
      m.scale.set(len, 1, len * 0.3);
      const mat = this.mats[i];
      mat.uniforms.uRow.value = Math.floor(rnd() * this.ink.waveRows) % this.ink.waveRows;
      // (v4 E3 Layer 3: ≤ 15 % against the sea; v3 drew them at 15–20 %)
      mat.uniforms.uAlpha.value = 0.11 + rnd() * 0.03;
      mat.uniforms.uPhase.value = rnd() * 6.283;
      // some swells run the other way
      if (rnd() < 0.35) m.scale.x = -len;
    });
  }

  get materials(): THREE.Material[] {
    return this.mats;
  }

  dispose(): void {
    this.geo.dispose();
    this.mats.forEach((m) => m.dispose());
  }
}

export function buildScene(renderer: THREE.WebGLRenderer, g: BoardGeometry, ink: InkLayer, shared: SharedUniforms): SceneParts {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PAPER_DEEP);
  const materials: THREE.Material[] = [];

  // A soft environment and a gentle key for the figures and the dice (MeshStandard); nothing casts shadows
  // on the painted board.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environment = envTexture;
  scene.environmentIntensity = 0.22;
  const key = new THREE.DirectionalLight('#fff1dc', 2.0);
  key.position.set(-14, 62, 34);
  scene.add(key);
  const fill = new THREE.DirectionalLight('#b4c4e0', 0.45);
  fill.position.set(40, 30, -30);
  scene.add(fill);
  const hemi = new THREE.HemisphereLight('#d2d8e6', '#1a2238', 0.7);
  scene.add(hemi);

  const W = g.width;
  const H = g.height;
  // The ground: one big sheet, the board rect in the middle (ink sampled there), paper to every edge.
  const groundMat = new THREE.ShaderMaterial({
    uniforms: shared,
    vertexShader: GROUND_VERT,
    fragmentShader: GROUND_FRAG,
    toneMapped: false,
  });
  materials.push(groundMat);
  const geo = new THREE.PlaneGeometry(W * 7, H * 9);
  geo.rotateX(-Math.PI / 2);
  const ground = new THREE.Mesh(geo, groundMat);
  ground.renderOrder = 0;
  scene.add(ground);

  const waves = new WaveStrokes(g, ink, shared);
  scene.add(waves.group);
  materials.push(...waves.materials);

  return { scene, ground, waves, key, envTexture, materials };
}
