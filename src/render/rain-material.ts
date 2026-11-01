import {
  Color,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  type IUniform,
} from '@iwsdk/core';
import { rainCountForQuality, rainRankScale, rainSeeds, STORM } from '../mechanisms/storm.ts';
import { RAIN_CAP_VEC4, RAIN_PALM_VEC4, type HandField } from '../storm/hand-field.ts';
import { RAIN_FRAG, RAIN_VERT } from './glsl/rain.ts';

/**
 * Storm rain: one InstancedBufferGeometry draw for every drop. The fall, the
 * hand hits and the splash crowns run in the vertex shader
 * (render/glsl/rain.ts); the CPU writes a few uniforms per frame plus the
 * HandField (storm/hand-field.ts), already in rain space.
 *
 * Instanced attribute: aSeed (vec4, U[0,1), fixed seed): x/y place the drop
 * in the impact ellipse, z its phase and speed, w its density rank.
 * Governor lever: geometry.instanceCount (900 / 600 / 300) + uRankScale.
 */

export interface RainUniforms {
  readonly uTime: IUniform<number>;
  /** Visible fraction 0..1. */
  readonly uDensity: IUniform<number>;
  /** STORM.drops[0] / instanceCount (rainRankScale), set by setQuality. */
  readonly uRankScale: IUniform<number>;
  readonly uSpeed: IUniform<number>;
  /** Rain top (cloud underside) and table, box frame (m). */
  readonly uCloudY: IUniform<number>;
  readonly uFloorY: IUniform<number>;
  /** Impact ellipse on the table (box frame XZ). */
  readonly uImpactCenter: IUniform<Vector2>;
  readonly uImpactHalf: IUniform<Vector2>;
  /** Horizontal travel per metre of fall (kx, kz). */
  readonly uSlant: IUniform<Vector2>;
  /** Drop width x length (m). */
  readonly uDropSize: IUniform<Vector2>;
  readonly uSplashS: IUniform<number>;
  readonly uPalm: IUniform<Vector4[]>;
  readonly uCap: IUniform<Vector4[]>;
  /** Box lid blocker: half X, half Z, top Y (box frame). */
  readonly uLid: IUniform<Vector3>;
  readonly uRainColor: IUniform<Color>;
  readonly uAlpha: IUniform<number>;
}

export interface RainOptions {
  impactCenter: readonly [number, number];
  impactHalf: readonly [number, number];
  slant: readonly [number, number];
  cloudY: number;
  floorY?: number;
  /** Box lid: half X, half Z, top Y (box frame). */
  lid: readonly [number, number, number];
  /** Drop width (canon: 1.6 mm, high contrast 2.0 mm). */
  dropWidthM?: number;
  seed?: number;
}

/** Unit quad: x across [-0.5, 0.5], y along the fall [0, 1]; aSeed per instance. */
export function createRainGeometry(count: number = STORM.drops[0], seed = 0x9a1a): InstancedBufferGeometry {
  const g = new InstancedBufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.setAttribute('aSeed', new InstancedBufferAttribute(rainSeeds(count, seed), 4));
  g.instanceCount = count;
  return g;
}

export function createRainMaterial(o: Readonly<RainOptions>): { material: ShaderMaterial; uniforms: RainUniforms } {
  const uniforms: RainUniforms = {
    uTime: { value: 0 },
    uDensity: { value: 0 },
    uRankScale: { value: 1 },
    uSpeed: { value: 1.4 },
    uCloudY: { value: o.cloudY },
    uFloorY: { value: o.floorY ?? 0 },
    uImpactCenter: { value: new Vector2(o.impactCenter[0], o.impactCenter[1]) },
    uImpactHalf: { value: new Vector2(o.impactHalf[0], o.impactHalf[1]) },
    uSlant: { value: new Vector2(o.slant[0], o.slant[1]) },
    uDropSize: { value: new Vector2(o.dropWidthM ?? 0.0016, 0.03) },
    uSplashS: { value: 0.1 },
    uPalm: { value: Array.from({ length: RAIN_PALM_VEC4 }, () => new Vector4()) },
    uCap: { value: Array.from({ length: RAIN_CAP_VEC4 }, () => new Vector4()) },
    uLid: { value: new Vector3(o.lid[0], o.lid[1], o.lid[2]) },
    uRainColor: { value: new Color(0xcfe3f2) },
    uAlpha: { value: 0.55 },
  };
  const material = new ShaderMaterial({
    name: 'rain',
    vertexShader: RAIN_VERT,
    fragmentShader: RAIN_FRAG,
    uniforms: { ...uniforms },
    transparent: true,
    depthWrite: false,
  });
  return { material, uniforms };
}

export interface RainView {
  readonly mesh: Mesh;
  readonly uniforms: RainUniforms;
  /** Copies the HandField (rain space) into uPalm / uCap. */
  setField(f: Readonly<HandField>): void;
  setQuality(level: number): void;
  dispose(): void;
}

const copyVec4s = (src: Float32Array, dst: Vector4[]): void => {
  for (let i = 0; i < dst.length; i++) dst[i].set(src[i * 4], src[i * 4 + 1], src[i * 4 + 2], src[i * 4 + 3]);
};

/** Rain mesh in the box frame (frustumCulled = false: the shader moves the drops). */
export function createRainView(o: Readonly<RainOptions>): RainView {
  const geometry = createRainGeometry(STORM.drops[0], o.seed);
  const { material, uniforms } = createRainMaterial(o);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'storm-rain';
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  return {
    mesh,
    uniforms,
    setField(f) {
      copyVec4s(f.palm, uniforms.uPalm.value);
      copyVec4s(f.cap, uniforms.uCap.value);
    },
    setQuality(level) {
      geometry.instanceCount = rainCountForQuality(level);
      // Without this the first 300 drops (ranks < 1/3) all show at any density > 0.33.
      uniforms.uRankScale.value = rainRankScale(level);
    },
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
