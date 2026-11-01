import {
  BackSide,
  Color,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  Vector4,
  type IUniform,
  type Object3D,
} from '@iwsdk/core';
import type { QualityLevel, Qualityable, Vec3 } from '../core/types.ts';
import {
  finiteVec3,
  NIGHT,
  NIGHT_STAR_COUNT,
  nightStars,
  nightStarVisibility,
  sparkIntensity,
  type NightState,
} from '../mechanisms/night.ts';
import { NIGHT_VEIL_FRAG, NIGHT_VEIL_VERT } from './glsl/night.ts';
import { NOISE_CHUNK } from './glsl/noise.ts';

/**
 * Night veil: one transparent BackSide sphere around the head (1 draw call).
 * depthTest/depthWrite off and renderOrder -50, so it is drawn first among
 * the transparents and handles/rings marked "after the veil" stay on top.
 * The room is darkened by alpha over passthrough: never setClearColor.
 *
 * The CPU sets the state from NightModel (mechanisms/night.ts); the shader
 * alpha mirrors veilAlpha() there.
 */

/** Palette (arte.md §2): luzFarol, veloNoche, veloNocheAlto, papel. */
const COL_POOL = 0xffb867;
const COL_NIGHT = 0x070b1a;
const COL_SKY = 0x0b1030;
const COL_STAR = 0xf2ebdd;
/** Sphere radius (m): well inside the far plane, outside any reachable object. */
export const VEIL_RADIUS_M = 3;
export const VEIL_RENDER_ORDER = -50;

export interface NightVeilUniforms {
  readonly uVeilHead: IUniform<Vector3>;
  readonly uVeilPoolDir: IUniform<Vector3>;
  readonly uVeilEdge: IUniform<number>;
  readonly uVeilLip: IUniform<number>;
  readonly uVeilInner: IUniform<number>;
  readonly uVeilMax: IUniform<number>;
  readonly uVeilPool: IUniform<number>;
  readonly uVeilTableY: IUniform<number>;
  readonly uVeilSkyYaw: IUniform<number>;
  readonly uVeilStarVis: IUniform<number>;
  readonly uVeilStars: IUniform<Vector4[]>;
  /** xyz world, w intensity 0..1 (sparks within 12 cm of the table). */
  readonly uVeilSparks: IUniform<Vector4[]>;
}

export function createNightVeilMaterial(o: { octaves?: 1 | 2 | 3; seed?: number } = {}): {
  material: ShaderMaterial;
  uniforms: NightVeilUniforms;
} {
  const stars = nightStars(o.seed);
  const starVecs: Vector4[] = [];
  for (let i = 0; i < NIGHT_STAR_COUNT; i++) {
    const s = stars[i];
    // Unused slots point at the floor: the shader only draws stars above the horizon.
    starVecs.push(s ? new Vector4(s.dir.x, s.dir.y, s.dir.z, s.size) : new Vector4(0, -1, 0, 0.001));
  }
  const uniforms: NightVeilUniforms = {
    uVeilHead: { value: new Vector3(0, 1.6, 0) },
    uVeilPoolDir: { value: new Vector3(0, -0.6, -0.8).normalize() },
    uVeilEdge: { value: NIGHT.edgeOpenDeg },
    uVeilLip: { value: 0 },
    uVeilInner: { value: 0 },
    uVeilMax: { value: 0.62 },
    uVeilPool: { value: 0.15 },
    uVeilTableY: { value: 0.75 },
    uVeilSkyYaw: { value: 0 },
    uVeilStarVis: { value: 0 },
    uVeilStars: { value: starVecs },
    uVeilSparks: { value: [new Vector4(), new Vector4(), new Vector4(), new Vector4()] },
  };
  const material = new ShaderMaterial({
    name: 'night-veil',
    uniforms: {
      ...uniforms,
      uVeilColPool: { value: new Color(COL_POOL) },
      uVeilColNight: { value: new Color(COL_NIGHT) },
      uVeilColSky: { value: new Color(COL_SKY) },
      uVeilColStar: { value: new Color(COL_STAR) },
    },
    defines: { PAPER_OCTAVES: o.octaves ?? 2 },
    vertexShader: NIGHT_VEIL_VERT,
    fragmentShader: NOISE_CHUNK + NIGHT_VEIL_FRAG,
    side: BackSide,
    transparent: true,
    premultipliedAlpha: true,
    blending: NormalBlending,
    depthTest: false,
    depthWrite: false,
  });
  return { material, uniforms };
}

export interface NightVeil extends Qualityable {
  readonly mesh: Mesh;
  /** Head (world) and the pool centre (world, bulb projected on the lid); call every frame. */
  setFrame(head: Readonly<Vec3>, pool: Readonly<Vec3>, tableY: number, boxYaw: number): void;
  /** Copies the NightModel state; hides the mesh while the veil is fully open. */
  setState(s: Readonly<NightState>): void;
  /** Global opacity 0..1 over the state (the dawn lifts the veil with it). */
  setFade(k: number): void;
  /** Up to 4 sparks (xyz world, w intensity); missing entries are cleared. */
  setSparks(sparks: ReadonlyArray<Readonly<{ x: number; y: number; z: number; w: number }>>): void;
  update(dt: number): void;
  dispose(): void;
}

/** Builds the veil (call on placement:commit, like the wind view: compiles during the settle). */
export function createNightVeil(parent: Object3D, o: { seed?: number } = {}): NightVeil {
  const { material, uniforms } = createNightVeilMaterial({ octaves: 2, seed: o.seed });
  const mesh = new Mesh(new SphereGeometry(VEIL_RADIUS_M, 48, 24), material);
  mesh.name = 'night-veil';
  mesh.renderOrder = VEIL_RENDER_ORDER;
  mesh.frustumCulled = false;
  mesh.visible = false;
  parent.add(mesh);

  let level = 0;
  let starVis = 0;
  let fade = 1;
  let last: Readonly<NightState> | null = null;

  return {
    mesh,
    setFrame(head, pool, tableY, boxYaw) {
      // Tracking loss can hand us NaN: keep last frame's pose rather than poison every fragment.
      if (!finiteVec3(head) || !finiteVec3(pool) || !Number.isFinite(tableY) || !Number.isFinite(boxYaw)) return;
      mesh.position.set(head.x, head.y, head.z);
      uniforms.uVeilHead.value.set(head.x, head.y, head.z);
      const pd = uniforms.uVeilPoolDir.value.set(pool.x - head.x, pool.y - head.y, pool.z - head.z);
      if (pd.lengthSq() > 1e-8) pd.normalize();
      else pd.set(0, -1, 0);
      uniforms.uVeilTableY.value = tableY;
      // Sky frame -Z = towards the box: the box's +Z faces (sin yaw, 0, cos yaw).
      uniforms.uVeilSkyYaw.value = -boxYaw;
    },
    setState(s) {
      last = s;
      level = s.level;
      uniforms.uVeilEdge.value = s.edgeDeg;
      uniforms.uVeilLip.value = s.lipSpeed;
      uniforms.uVeilInner.value = s.inner;
      uniforms.uVeilMax.value = s.veilMax * fade;
      uniforms.uVeilPool.value = s.poolAlpha * fade;
      mesh.visible = s.level > 0 && fade > 0;
    },
    setFade(k) {
      fade = k > 0 ? (k < 1 ? k : 1) : 0;
      if (last) this.setState(last);
    },
    setSparks(sparks) {
      const u = uniforms.uVeilSparks.value;
      for (let i = 0; i < u.length; i++) {
        const s = sparks[i];
        if (s && finiteVec3(s)) u[i].set(s.x, s.y, s.z, sparkIntensity(s.w));
        else u[i].set(0, -100, 0, 0);
      }
    },
    update(dt) {
      starVis = nightStarVisibility(starVis, level, dt);
      uniforms.uVeilStarVis.value = starVis;
    },
    setQuality(_level: QualityLevel) {
      // One draw, fixed cost: the governor leaves the veil alone (fbm stays at 2 octaves
      // so the ink edge looks the same at every level).
    },
    dispose() {
      parent.remove(mesh);
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
