/**
 * Wet table decal (direccion/canon.md §6). PURE module: GLSL strings only.
 *
 * A flat quad on the real table, in the box frame, over the wet map
 * (storm/wet-map.ts → uWetTex, RG8: R rain shine, G soaked). It covers the
 * passthrough wood with plain alpha (never multiply): a cool glossy film for rain shine, a darker soak, and
 * a meniscus where the shine changes fast, which is what draws the edge of a
 * dry handprint. A few texels catch a cool glint while it rains. The cloud's
 * soft shadow is drawn in the same pass.
 *
 * Multiview: only modelMatrix / projectionMatrix / modelViewMatrix in the
 * vertex shader, nothing per-view in the fragment.
 */

export const WET_VERT = /* glsl */ `
varying vec2 vUv;
varying vec2 vXZ;

void main() {
  vUv = uv;
  // Box frame XZ of this fragment (the quad lies in the box's XZ plane).
  vXZ = position.xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const WET_FRAG = /* glsl */ `
uniform sampler2D uWetTex;
uniform vec2 uTexel;
uniform vec3 uWetColor;
uniform vec3 uGlintColor;
uniform vec3 uShadowColor;
uniform float uShadowAlpha;
uniform vec2 uShadowCenter;
uniform vec2 uShadowHalf;

varying vec2 vUv;
varying vec2 vXZ;

float wetHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 rg = texture2D(uWetTex, vUv).rg;
  float rx = texture2D(uWetTex, vUv + vec2(uTexel.x, 0.0)).r - texture2D(uWetTex, vUv - vec2(uTexel.x, 0.0)).r;
  float rz = texture2D(uWetTex, vUv + vec2(0.0, uTexel.y)).r - texture2D(uWetTex, vUv - vec2(0.0, uTexel.y)).r;
  float meniscus = smoothstep(0.02, 0.08, 0.5 * length(vec2(rx, rz)));
  // Soft elliptical edge of the map: the decal never shows a rectangle.
  vec2 e = (vUv - 0.5) * 2.0;
  float edge = 1.0 - smoothstep(0.8, 1.0, length(e));
  // Wet wood is darker AND glossy: a cool sheen of the room on the water film
  // (rain shine R), over the darker soak (G). The dry print stays warm and
  // matte, so it reads even when the room is dimmed; its edge gets the
  // meniscus, a dark line where the water film stops.
  float wet = clamp(0.62 * rg.r + 0.38 * rg.g, 0.0, 1.0);
  vec3 col = mix(uWetColor, uGlintColor * 0.72, 0.42 * rg.r);
  float a = 0.5 * wet;
  col = mix(col, uWetColor, 0.8 * meniscus);
  a = max(a, 0.46 * meniscus) * edge;
  // Glints: about 1 texel in 250, only while it rains on it.
  vec2 cell = floor(vUv / uTexel);
  float glint = step(0.996, wetHash(cell)) * rg.r * edge;
  col = mix(col, uGlintColor, glint);
  a = max(a, 0.5 * glint);
  // Cloud shadow: soft ellipse, about 4 cm of edge.
  vec2 s = (vXZ - uShadowCenter) / uShadowHalf;
  float shade = uShadowAlpha * (1.0 - smoothstep(0.6, 1.0, length(s)));
  float outA = a + shade * (1.0 - a);
  vec3 outC = outA > 0.0 ? (col * a + uShadowColor * shade * (1.0 - a)) / outA : col;
  if (outA < 0.002) discard;
  gl_FragColor = vec4(outC, outA);
  #include <colorspace_fragment>
}
`;
