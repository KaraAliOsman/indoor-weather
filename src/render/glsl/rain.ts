/**
 * Storm rain (direccion/canon.md §6): slanted ink streaks that stop on your
 * hand and splash there. One instanced draw. PURE module: GLSL strings only.
 *
 * Rain space (storm/hand-field.ts): box-local coordinates sheared so the
 * slanted rain falls straight down. Each drop owns a fixed (u, w) inside the
 * impact ellipse (centred on the kite) and falls analytically:
 *   fallen = mod(t · v + phase, span + v · splash), y = cloudY − fallen.
 * The first thing under it (palm slab, finger/forearm capsule, the box lid,
 * else the table) is rainBlockY(), the exact twin of blockY() on the CPU, so the wet
 * map's dry print sits where the drops stopped. Once a drop passes that
 * height it turns into a short splash crown at the hit point for SPLASH_S,
 * then hides until it is re-emitted under the cloud.
 *
 * Multiview: only three's injected matrices and cameraPosition are used,
 * never redeclared.
 */

export const RAIN_VERT = /* glsl */ `
attribute vec4 aSeed;

uniform float uTime;
uniform float uDensity;
// Governor: drops[0] / instanceCount, so thinning stays a true fraction.
uniform float uRankScale;
uniform float uSpeed;
uniform float uCloudY;
uniform float uFloorY;
uniform vec2 uImpactCenter;
uniform vec2 uImpactHalf;
// Horizontal travel per metre of fall (rain space shear).
uniform vec2 uSlant;
uniform vec2 uDropSize;
uniform float uSplashS;
uniform vec4 uPalm[6];
uniform vec4 uCap[24];
// Box lid: half X, half Z, top Y (box frame); drops landing on it splash there.
uniform vec3 uLid;

varying vec2 vUv;
varying float vFade;
varying float vSplash;

const float HEAD_CLEAR = 0.35;

float palmTopY(int h, vec2 q) {
  vec4 c = uPalm[h * 3];
  if (c.w < 0.5) return -1e3;
  vec4 n = uPalm[h * 3 + 1];
  vec4 a = uPalm[h * 3 + 2];
  float y = c.y - (n.x * (q.x - c.x) + n.z * (q.y - c.z)) / n.y;
  vec3 d = vec3(q.x, y, q.y) - c.xyz;
  vec3 b = cross(n.xyz, a.xyz);
  float ea = dot(d, a.xyz) / n.w;
  float eb = dot(d, b) / a.w;
  return ea * ea + eb * eb <= 1.0 ? y : -1e3;
}

float capsuleTopY(int i, vec2 q) {
  vec4 a = uCap[i * 2];
  vec4 b = uCap[i * 2 + 1];
  if (a.w <= 0.0) return -1e3;
  vec3 e = b.xyz - a.xyz;
  float l2 = dot(e.xz, e.xz);
  float t = l2 > 1e-10 ? clamp(dot(q - a.xz, e.xz) / l2, 0.0, 1.0) : 0.0;
  vec2 p = a.xz + e.xz * t;
  vec2 dd = q - p;
  float d2 = dot(dd, dd);
  return d2 < a.w * a.w ? a.y + e.y * t + sqrt(a.w * a.w - d2) : -1e3;
}

float rainBlockY(vec2 q) {
  float top = uFloorY;
  float lh = uLid.z - uFloorY;
  vec2 onLid = vec2(q.x - uSlant.x * lh, q.y - uSlant.y * lh);
  if (abs(onLid.x) < uLid.x && abs(onLid.y) < uLid.y) top = uLid.z;
  for (int h = 0; h < 2; h++) top = max(top, palmTopY(h, q));
  for (int i = 0; i < 12; i++) top = max(top, capsuleTopY(i, q));
  return top;
}

// Rain space (u, y, w) → box frame.
vec3 unshear(vec2 q, float y) {
  float h = y - uFloorY;
  return vec3(q.x - uSlant.x * h, y, q.y - uSlant.y * h);
}

void main() {
  vUv = vec2(0.0);
  vFade = 0.0;
  vSplash = 0.0;
  // Thinning by seed: lowering the density hides drops evenly.
  if (aSeed.w * uRankScale >= uDensity) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  float ang = 6.2831853 * aSeed.x;
  vec2 q = uImpactCenter + vec2(cos(ang), sin(ang)) * sqrt(aSeed.y) * uImpactHalf;
  float v = uSpeed * (0.9 + 0.2 * aSeed.z);
  float span = max(uCloudY - uFloorY, 0.01);
  float cycle = span + v * uSplashS;
  float fallen = mod(uTime * v + aSeed.z * 97.0 * cycle, cycle);
  float y = uCloudY - fallen;
  float hitY = rainBlockY(q);

  vec3 local;
  vec3 world;
  if (y >= hitY) {
    // Streak: bottom at the drop, tail back up along the fall line, never above the cloud.
    vec3 axisL = normalize(vec3(-uSlant.x, 1.0, -uSlant.y));
    vec3 bottomL = unshear(q, y);
    vec3 bottomW = (modelMatrix * vec4(bottomL, 1.0)).xyz;
    vec3 axisW = normalize(mat3(modelMatrix) * axisL);
    vec3 toEye = cameraPosition - bottomW;
    vec3 side = cross(axisW, toEye);
    side = dot(side, side) > 1e-10 ? normalize(side) : vec3(1.0, 0.0, 0.0);
    float len = min(uDropSize.y, (uCloudY - y) / axisL.y);
    world = bottomW + side * position.x * uDropSize.x + axisW * position.y * len;
    vUv = vec2(position.x + 0.5, position.y);
    // Fade in just under the cloud so streaks never pop out of it.
    vFade = smoothstep(0.0, 0.03, uCloudY - y);
  } else {
    float age = (hitY - y) / v;
    if (age > uSplashS) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      return;
    }
    // Splash crown: a camera-facing ring that opens and fades at the hit point.
    float k = age / uSplashS;
    vec3 hitW = (modelMatrix * vec4(unshear(q, hitY), 1.0)).xyz;
    vec3 toEye = normalize(cameraPosition - hitW);
    vec3 side = normalize(cross(vec3(0.0, 1.0, 0.0), toEye) + vec3(1e-5, 0.0, 0.0));
    vec3 up = cross(toEye, side);
    // Crowns on a hand (above the table) are bigger: they are the "drops on your knuckles".
    float onHand = step(uFloorY + 0.01, hitY);
    float size = mix(0.003, 0.009, k) * (1.0 + 0.6 * onHand);
    world = hitW + up * 0.001 + side * position.x * size + up * (position.y - 0.25) * size;
    vUv = vec2(position.x + 0.5, position.y);
    vFade = (1.0 - k) * (1.0 + 0.5 * onHand);
    vSplash = 1.0;
  }
  if (distance(world, cameraPosition) < HEAD_CLEAR) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

export const RAIN_FRAG = /* glsl */ `
uniform vec3 uRainColor;
uniform float uAlpha;

varying vec2 vUv;
varying float vFade;
varying float vSplash;

void main() {
  float a;
  if (vSplash > 0.5) {
    // Crown: a thin open ring, brighter on its top half.
    vec2 p = vec2(vUv.x * 2.0 - 1.0, vUv.y * 2.0 - 0.5);
    float r = length(p * vec2(1.0, 1.6));
    float ring = smoothstep(0.55, 0.75, r) * (1.0 - smoothstep(0.8, 0.98, r));
    a = uAlpha * 1.3 * ring * vFade * (0.6 + 0.4 * step(0.0, p.y));
  } else {
    // Ink stroke: soft edges across, tapered tail on top.
    float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
    a = uAlpha * vFade * smoothstep(0.0, 0.45, across) * (1.0 - 0.7 * vUv.y);
  }
  if (a < 0.01) discard;
  gl_FragColor = vec4(uRainColor, a);
  #include <colorspace_fragment>
}
`;
