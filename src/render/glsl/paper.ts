/**
 * Paper v1: cardstock in 5 inks with procedural fibres and letterpress
 * mottling (band-limited with fwidth), lit by one key light fixed to the box. PURE module: GLSL strings only.
 *
 * Multiview rules (docs/architecture-m1.md §2): nothing three injects is
 * declared here; the per-eye matrices are only used in the vertex shader;
 * lighting runs in world space with mat3(modelMatrix), so both eyes shade
 * identically and the fragment needs no view matrix at all.
 *
 * Fragment composition (render/paper-material.ts):
 *   NOISE_CHUNK + PAPER_CHUNK + PAPER_FRAG
 */

/** Box, tab, cloud, kite. aInk selects one of the 6 inks per vertex (0..5). */
export const PAPER_VERT = /* glsl */ `
attribute float aInk;

uniform vec3 uInks[6];

varying vec3 vInk;
varying float vInkId;
varying vec3 vNormalW;
varying vec3 vPaper;

void main() {
  vec3 pos = position;
  vec3 nrm = normal;
#if defined(USE_INSTANCING) && defined(PAPER_INSTANCED)
  pos = (instanceMatrix * vec4(pos, 1.0)).xyz;
  nrm = mat3(instanceMatrix) * nrm;
#endif
  float inkId = clamp(floor(aInk + 0.5), 0.0, 5.0);
  vInkId = inkId;
  vInk = uInks[int(inkId)];
  // World normal from the model matrix (uniform scale): no per-eye normalMatrix.
  vNormalW = normalize(mat3(modelMatrix) * nrm);
  // Fibres stick to the object, not to the world.
  vPaper = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`;

/** Shared fragment shading (box and leaves). Needs NOISE_CHUNK first. */
export const PAPER_CHUNK = /* glsl */ `
uniform vec3 uInks[6];
uniform vec3 uKeyDir;
uniform float uGrain;
uniform float uContrast;

// ink: linear colour; inkId: 0 paper, 1 board, 2..5 printed inks;
// p: object-space position (m); n: unit world normal facing the viewer.
vec3 paperShade(vec3 ink, float inkId, vec3 p, vec3 n) {
  // Fibres run along x; the grain is finer and isotropic. Both fade out once
  // a noise cell is smaller than ~2 px (no mipmaps here): the paper must not
  // shimmer when the head moves, and the grain hashes are skipped entirely.
  vec3 pf = p * vec3(140.0, 480.0, 480.0);
  float aaF = 1.0 - smoothstep(0.4, 0.8, length(fwidth(pf)));
  float fibre = mix(0.5, paperFbm(pf), aaF);
  vec3 pg = p * 900.0;
  float aaG = 1.0 - smoothstep(0.4, 0.8, length(fwidth(pg)));
  float grain = 0.5;
  if (aaG > 0.0) grain = mix(0.5, paperNoise(pg + vec3(31.0, 7.0, 19.0)), aaG);
  vec3 col = ink * (1.0 + uGrain * ((fibre - 0.5) * 0.24 + (grain - 0.5) * 0.12));
  // Letterpress: printed inks let the sheet show through on the fibre peaks.
  float printed = step(1.5, inkId);
  col = mix(col, uInks[0], printed * uGrain * 0.22 * smoothstep(0.55, 0.8, fibre));
  // Fixed key light + ambient, world space, wrapped so no face goes black.
  float wrap = clamp((dot(n, uKeyDir) + 0.4) / 1.4, 0.0, 1.0);
  col *= 0.56 + 0.5 * wrap;
  // High contrast (M2 accessibility): push away from linear mid grey.
  col = mix(col, clamp((col - 0.18) * 1.8 + 0.18, 0.0, 1.0), uContrast);
  return col;
}
`;

export const PAPER_FRAG = /* glsl */ `
uniform float uTime;
uniform float uHighlight;
uniform float uWet;

varying vec3 vInk;
varying float vInkId;
varying vec3 vNormalW;
varying vec3 vPaper;

void main() {
  vec3 col = paperShade(vInk, vInkId, vPaper, normalize(vNormalW));
  // Soaked paper (canon §7): darker, 40 % less saturated, a cool cast.
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, mix(vec3(lum), col, 0.6) * vec3(0.78, 0.82, 0.9), uWet);
  // Grab affordance: a warm lift with a slow pulse.
  float glow = uHighlight * (0.2 + 0.08 * sin(uTime * 6.0));
  col = mix(col, vec3(1.0, 0.86, 0.6), glow);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
