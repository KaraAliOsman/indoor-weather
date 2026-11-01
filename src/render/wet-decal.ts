import {
  Color,
  DataTexture,
  LinearFilter,
  Mesh,
  PlaneGeometry,
  RGFormat,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  type Object3D,
} from '@iwsdk/core';
import { WET } from '../storm/wet-map.ts';
import type { WetMap } from '../storm/wet-map.ts';
import { WET_FRAG, WET_VERT } from './glsl/wet.ts';

/**
 * The wet-table decal: one quad in the box frame, 0.6 mm above the table,
 * sampling the CPU wet map (RG8 DataTexture, re-uploaded only when the map
 * steps, 15 Hz). Drawn before the veil (renderOrder −55) with a polygon
 * offset so it never fights the real table's depth.
 */

/** Palette (canon §6): wet ink, glint, cloud shadow. */
const COL_WET = 0x0a1622;
const COL_GLINT = 0xe6f0f8;
const COL_SHADOW = 0x1a120b;

export interface WetDecal {
  readonly mesh: Mesh;
  /** Uploads the map when it changed since the last call. */
  sync(): void;
  /** Cloud shadow: centre (box XZ) and strength 0..1 of the canon's 0.22. */
  setShadow(x: number, z: number, strength: number): void;
  dispose(): void;
}

export function createWetDecal(parent: Object3D, map: WetMap, floorY = 0): WetDecal {
  const texture = new DataTexture(map.data, map.cols, map.rows, RGFormat, UnsignedByteType);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  const [sx, sz] = WET.sizeM;
  const geometry = new PlaneGeometry(sx, sz);
  geometry.rotateX(-Math.PI / 2);
  // After the rotation v = 0 lies at +Z; the map's row 0 is at −Z.
  const uv = geometry.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  geometry.translate(map.centerX, floorY + 0.0006, map.centerZ);

  const material = new ShaderMaterial({
    name: 'wet-decal',
    vertexShader: WET_VERT,
    fragmentShader: WET_FRAG,
    uniforms: {
      uWetTex: { value: texture },
      uTexel: { value: new Vector2(1 / map.cols, 1 / map.rows) },
      uWetColor: { value: new Color(COL_WET) },
      uGlintColor: { value: new Color(COL_GLINT) },
      uShadowColor: { value: new Color(COL_SHADOW) },
      uShadowAlpha: { value: 0 },
      uShadowCenter: { value: new Vector2() },
      uShadowHalf: { value: new Vector2(0.2, 0.11) },
    },
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'wet-decal';
  mesh.renderOrder = -55;
  mesh.frustumCulled = false;
  parent.add(mesh);

  let uploaded = -1;
  return {
    mesh,
    sync() {
      if (map.version === uploaded) return;
      uploaded = map.version;
      texture.needsUpdate = true;
    },
    setShadow(x, z, strength) {
      const u = material.uniforms;
      (u.uShadowCenter.value as Vector2).set(x, z);
      u.uShadowAlpha.value = 0.22 * Math.min(1, Math.max(0, strength));
    },
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}
