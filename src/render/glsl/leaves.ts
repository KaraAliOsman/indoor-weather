/**
 * Wind leaves: 40 paper leaves animated entirely in the vertex shader.
 * PURE module: GLSL strings only.
 *
 * Space: box local (the mesh frame equals the box frame; y = 0 is the table
 * surface, +Z the front face). Per leaf: aSeed (4 x U[0,1)) and aGroup (0..3).
 * A group stays inside the box until uGust[group] >= 0 (its release time, s),
 * then each leaf, staggered by its seed:
 *   1. slides out of the slot along +Z and unfolds (0.3 s),
 *   2. flies with the wind: lift, sway, tumble (whole turns, so it lands flat),
 *   3. rests on the table, and
 *   4. SHRINKS away (never fades: no transparency) when it leaves the uArea
 *      rectangle or when its rest time is over.
 * instanceMatrix is not used: every pose comes from the seeds.
 *
 * Fragment composition (render/leaves-material.ts):
 *   NOISE_CHUNK + PAPER_CHUNK + LEAVES_FRAG
 */
export const LEAVES_VERT = /* glsl */ `
attribute vec4 aSeed;
attribute float aGroup;

uniform float uTime;
uniform vec4 uGust;
uniform vec2 uWindDir;
uniform vec2 uArea;
uniform vec2 uAreaCenter;
uniform vec3 uSlot;
uniform vec2 uLeafHalf;
uniform vec3 uInks[6];

varying vec3 vInk;
varying float vInkId;
varying vec3 vNormalW;
varying vec3 vPaper;
varying vec2 vLeaf;

const float LEAF_PI = 3.14159265;
const float LEAF_TAU = 6.28318531;
const float LEAF_EXIT_S = 0.3;
const float LEAF_STAGGER_S = 0.7;
const float LEAF_REST_S = 14.0;
const float LEAF_SHRINK_S = 0.6;

mat3 leafRotY(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
}

mat3 leafRotZ(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0);
}

// Rodrigues rotation about the unit axis k (column-major).
mat3 leafAxisAngle(vec3 k, float a) {
  float c = cos(a);
  float s = sin(a);
  float t = 1.0 - c;
  return mat3(
    t * k.x * k.x + c,       t * k.x * k.y + s * k.z, t * k.x * k.z - s * k.y,
    t * k.x * k.y - s * k.z, t * k.y * k.y + c,       t * k.y * k.z + s * k.x,
    t * k.x * k.z + s * k.y, t * k.y * k.z - s * k.x, t * k.z * k.z + c
  );
}

float leafRelease(float group) {
  return group < 0.5 ? uGust.x : (group < 1.5 ? uGust.y : (group < 2.5 ? uGust.z : uGust.w));
}

void main() {
  float released = leafRelease(aGroup);
  float age = uTime - released - aSeed.x * LEAF_STAGGER_S;
  float alive = step(0.0, released) * step(0.0, age);
  age = max(age, 0.0);

  vec2 wind = normalize(uWindDir);
  vec2 side = vec2(-wind.y, wind.x);

  // Flight plan: slot -> just outside the front face -> a landing spot downwind.
  vec3 start = uSlot + vec3((aSeed.y - 0.5) * 0.03, 0.002, -0.006);
  vec3 exitP = uSlot + vec3((aSeed.y - 0.5) * 0.04, 0.008 + 0.012 * aSeed.z, 0.03 + 0.012 * aSeed.w);
  vec2 land = exitP.xz + wind * (0.06 + 0.27 * aSeed.y) + side * ((aSeed.z - 0.5) * 0.2);
  land.y = max(land.y, uSlot.z + 0.025 + 0.03 * aSeed.x);   // never under the box
  float restY = 0.0006 + 0.0016 * aSeed.w;                    // stacking offsets: no z-fighting
  float flightS = 1.2 + 1.4 * aSeed.w;

  float e = clamp(age / LEAF_EXIT_S, 0.0, 1.0);
  float u = clamp((age - LEAF_EXIT_S) / flightS, 0.0, 1.0);
  float inAir = smoothstep(0.0, 0.15, u) * (1.0 - u);
  float phase = age * (4.0 + 3.0 * aSeed.w) + aSeed.x * LEAF_TAU;

  vec3 p;
  if (age < LEAF_EXIT_S) {
    p = mix(start, exitP, e * (2.0 - e));
  } else {
    vec2 xz = mix(exitP.xz, land, 1.0 - (1.0 - u) * (1.0 - u));
    xz += side * sin(phase) * 0.02 * inAir;
    float lift = sin(LEAF_PI * u) * (0.04 + 0.07 * aSeed.z);
    float y = mix(exitP.y, restY, u * u) + lift + cos(phase * 1.3) * 0.006 * inAir;
    p = vec3(xz.x, y, xz.y);
  }

  // Orientation: yaw towards the wind, whole-turn tumble (flat again at u = 1), sway roll.
  float ease = smoothstep(0.0, 1.0, u);
  float turns = floor(1.0 + 2.0 * aSeed.z);
  vec3 tumbleAxis = normalize(vec3(aSeed.y - 0.5, 0.25, aSeed.w - 0.5));
  float yaw = (atan(wind.x, wind.y) + (aSeed.x - 0.5) * 2.4) * ease;
  float roll = sin(phase) * 0.7 * inAir;
  mat3 rot = leafRotY(yaw) * leafAxisAngle(tumbleAxis, LEAF_TAU * turns * ease) * leafRotZ(roll);

  // Unfold on the way out; shrink outside the area and at the end of the rest.
  float sc = alive * mix(0.35, 1.0, e);
  vec2 outside = max(abs(p.xz - uAreaCenter) - uArea, 0.0);
  sc *= 1.0 - smoothstep(0.0, 0.04, length(outside));
  float lifeEnd = LEAF_EXIT_S + flightS + LEAF_REST_S * (0.7 + 0.6 * aSeed.z);
  sc *= 1.0 - smoothstep(lifeEnd, lifeEnd + LEAF_SHRINK_S, age);

  float inkPick = fract(aSeed.x * 7.13 + aSeed.z * 3.71);
  float inkId = inkPick < 0.45 ? 4.0 : (inkPick < 0.8 ? 3.0 : 1.0);
  vInkId = inkId;
  vInk = uInks[int(inkId)];
  vNormalW = normalize(mat3(modelMatrix) * (rot * normal));
  vPaper = position + aSeed.xyz * 8.0;
  vLeaf = position.xz / uLeafHalf;

  vec3 boxPos = p + rot * (position * sc);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(boxPos, 1.0);
}
`;

export const LEAVES_FRAG = /* glsl */ `
varying vec3 vInk;
varying float vInkId;
varying vec3 vNormalW;
varying vec3 vPaper;
varying vec2 vLeaf;

void main() {
  vec3 n = normalize(vNormalW);
  n = gl_FrontFacing ? n : -n;
  // Printed midrib (letterpress line in the dark ink).
  float rib = (1.0 - smoothstep(0.05, 0.11, abs(vLeaf.x))) * step(abs(vLeaf.y), 0.86);
  vec3 ink = mix(vInk, uInks[2], rib * 0.6);
  vec3 col = paperShade(ink, vInkId, vPaper, n);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
