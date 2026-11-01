/**
 * Procedural noise for paper surfaces. PURE module: GLSL strings only, no imports.
 *
 * Integer lattice hash (no sin(), stable on mobile GPUs) + trilinear value
 * noise + fbm. The octave count is the PAPER_OCTAVES define (1..3), set per
 * material and lowered by the M3 quality governor.
 *
 * Inputs are in "noise units" (metres x frequency); keep |p| < 32768.
 */
export const NOISE_CHUNK = /* glsl */ `
#ifndef PAPER_OCTAVES
#define PAPER_OCTAVES 2
#endif

// Spatial-hash primes, then a 32-bit avalanche (lowbias32, C. Wellons, public domain).
// Explicit highp: 16-bit ints would wrap the lattice.
float paperHash(highp ivec3 c) {
  highp uint h = (uint(c.x) * 73856093u) ^ (uint(c.y) * 19349663u) ^ (uint(c.z) * 83492791u);
  h ^= h >> 16u;
  h *= 0x7feb352du;
  h ^= h >> 15u;
  h *= 0x846ca68bu;
  h ^= h >> 16u;
  return float(h >> 8u) * (1.0 / 16777216.0);
}

// Value noise in [0, 1). The lattice is offset so the int-to-uint casts never see negatives.
float paperNoise(vec3 p) {
  vec3 fl = floor(p);
  vec3 f = p - fl;
  highp ivec3 c = ivec3(fl) + ivec3(32768);
  vec3 w = f * f * (3.0 - 2.0 * f);
  float n000 = paperHash(c);
  float n100 = paperHash(c + ivec3(1, 0, 0));
  float n010 = paperHash(c + ivec3(0, 1, 0));
  float n110 = paperHash(c + ivec3(1, 1, 0));
  float n001 = paperHash(c + ivec3(0, 0, 1));
  float n101 = paperHash(c + ivec3(1, 0, 1));
  float n011 = paperHash(c + ivec3(0, 1, 1));
  float n111 = paperHash(c + ivec3(1, 1, 1));
  return mix(
    mix(mix(n000, n100, w.x), mix(n010, n110, w.x), w.y),
    mix(mix(n001, n101, w.x), mix(n011, n111, w.x), w.y),
    w.z
  );
}

// Normalised fbm in [0, 1).
float paperFbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < PAPER_OCTAVES; i++) {
    sum += amp * paperNoise(p);
    norm += amp;
    p = p * 2.03 + vec3(17.1, 9.2, 3.7);
    amp *= 0.5;
  }
  return sum / norm;
}
`;
