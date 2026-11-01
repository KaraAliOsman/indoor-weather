/**
 * Night veil ("Farol"): a BackSide sphere centred on the head that darkens
 * the room from the periphery towards a warm pool over the box, plus a few
 * paper stars. PURE module: GLSL strings only.
 *
 * Alpha mirrors veilAlpha() in mechanisms/night.ts (edge, band, pool, sky,
 * ink lip, caps). Static: no time uniform, nothing twinkles or flashes.
 * Output is premultiplied (the material sets premultipliedAlpha).
 *
 * Fragment composition (render/night-veil-material.ts):
 *   NOISE_CHUNK + NIGHT_VEIL_FRAG
 */
export const NIGHT_VEIL_VERT = /* glsl */ `
varying vec3 vVeilWorld;

void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vVeilWorld = w.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const NIGHT_VEIL_FRAG = /* glsl */ `
uniform vec3 uVeilHead;
uniform vec3 uVeilPoolDir;
uniform float uVeilEdge;
uniform float uVeilLip;
uniform float uVeilInner;
uniform float uVeilMax;
uniform float uVeilPool;
uniform float uVeilTableY;
uniform float uVeilSkyYaw;
uniform float uVeilStarVis;
uniform vec4 uVeilStars[24];
uniform vec4 uVeilSparks[4];
uniform vec3 uVeilColPool;
uniform vec3 uVeilColNight;
uniform vec3 uVeilColSky;
uniform vec3 uVeilColStar;

varying vec3 vVeilWorld;

const float VEIL_BAND = 60.0;
const float VEIL_POOL_DEG = 12.0;
const float VEIL_RAMP_DEG = 30.0;
const float VEIL_MAX_SPEED = 70.0;

// 4-point paper star around direction s (xyz) with angular radius s.w.
float veilStar(vec3 d, vec4 s) {
  float c = dot(d, s.xyz);
  if (c < cos(s.w * 2.0)) return 0.0;
  vec3 t = normalize(cross(s.xyz, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));
  vec3 b = cross(t, s.xyz);
  vec2 q = vec2(dot(d, t), dot(d, b)) / s.w;
  float k = sqrt(abs(q.x)) + sqrt(abs(q.y));
  return 1.0 - smoothstep(0.75, 1.0, k);
}

// Faint dotted thread between two stars (the constellation).
float veilLink(vec3 d, vec3 a, vec3 b) {
  vec3 ab = b - a;
  float h = clamp(dot(d - a, ab) / dot(ab, ab), 0.0, 1.0);
  vec3 c = normalize(a + ab * h);
  float dist = length(d - c);
  float dots = step(0.5, fract(h * 9.0));
  return (1.0 - smoothstep(0.0012, 0.0024, dist)) * dots * step(0.06, h) * step(h, 0.94);
}

void main() {
  vec3 d = normalize(vVeilWorld - uVeilHead);
  float theta = degrees(acos(clamp(dot(d, uVeilPoolDir), -1.0, 1.0)));
  float n = 5.0 * (2.0 * paperFbm(d * 3.0 + vec3(11.0)) - 1.0);
  float t = theta + n;

  float outer = smoothstep(uVeilEdge - VEIL_BAND, uVeilEdge, t);
  float night = mix(uVeilPool, uVeilMax, smoothstep(VEIL_POOL_DEG, VEIL_RAMP_DEG, theta));
  float sky = 0.06 * smoothstep(0.0, 0.5, d.y);
  float g = (t - uVeilEdge + 12.0) / 6.0;
  float lip = 0.05 * exp(-g * g) * min(abs(uVeilLip) / VEIL_MAX_SPEED, 1.0);
  float a = max(outer * (night + sky), uVeilInner * uVeilPool) + lip * outer;
  a = min(a, theta < VEIL_POOL_DEG ? uVeilPool : uVeilMax);

  // Sparks light the table: holes in the veil where it meets the table plane.
  if (d.y < -0.02) {
    vec3 h = uVeilHead + d * ((uVeilTableY - uVeilHead.y) / d.y);
    float lit = 0.0;
    for (int i = 0; i < 4; i++) {
      vec3 f = h - uVeilSparks[i].xyz;
      lit += uVeilSparks[i].w * exp(-dot(f, f) / 0.0025);
    }
    a = max(a - 0.22 * lit, 0.0);
  }

  vec3 rgb = mix(uVeilColPool, mix(uVeilColNight, uVeilColSky, smoothstep(0.0, 0.6, d.y)),
                 smoothstep(10.0, 28.0, theta));

  // Paper stars in the sky frame (-Z towards the box), only where the night has closed in.
  if (uVeilStarVis > 0.0 && d.y > 0.05) {
    float cs = cos(uVeilSkyYaw);
    float sn = sin(uVeilSkyYaw);
    vec3 ds = vec3(cs * d.x - sn * d.z, d.y, sn * d.x + cs * d.z);
    float star = 0.0;
    for (int i = 0; i < 24; i++) star = max(star, veilStar(ds, uVeilStars[i]));
    float link = veilLink(ds, uVeilStars[0].xyz, uVeilStars[1].xyz);
    link = max(link, veilLink(ds, uVeilStars[1].xyz, uVeilStars[2].xyz));
    link = max(link, veilLink(ds, uVeilStars[2].xyz, uVeilStars[3].xyz));
    link = max(link, veilLink(ds, uVeilStars[3].xyz, uVeilStars[0].xyz));
    link = max(link, veilLink(ds, uVeilStars[0].xyz, uVeilStars[2].xyz));
    link = max(link, veilLink(ds, uVeilStars[2].xyz, uVeilStars[4].xyz));
    link = max(link, veilLink(ds, uVeilStars[4].xyz, uVeilStars[5].xyz));
    float k = max(star * 0.55, link * 0.12) * uVeilStarVis * outer;
    rgb = mix(rgb, uVeilColStar, k);
    a = max(a, k * 0.6);
  }

  // Interleaved gradient noise dither (+-1/255) against banding on the dark gradient.
  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  a = clamp(a + (ign - 0.5) / 255.0, 0.0, 1.0);

  gl_FragColor = vec4(rgb, a);
  #include <colorspace_fragment>
  gl_FragColor.rgb *= gl_FragColor.a;
}
`;
