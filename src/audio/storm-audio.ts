import { AudioContext as ThreeAudioContext } from '@iwsdk/core';
import type { Vec3 } from '../core/types.ts';

/**
 * Storm sound (direccion/sonido.md, canon §8), synthesised: no assets, no network.
 *
 * - Rain bed: a looping pink-ish noise, band-passed, from the cloud.
 * - Patter on the wood: the same noise darker and grainier, from the kite.
 *   Both follow the rain density with a 0.3 s glide (never a click).
 * - Drops on your skin: tiny bright clicks at the sheltering hand, at a rate
 *   that follows how much of the rain the hand takes. They are what makes
 *   the shelter feel like a hand in the rain.
 * - One distant thunder: a slow low rumble (−24 dB), no light, no flash.
 *
 * Shares three's AudioContext with IWSDK's listener on the head, so the HRTF
 * panners sit where the cloud, the kite and the hand are. Skips everything
 * while the context is not running.
 */

export interface StormAudio {
  /**
   * Per frame. `density` 0..1; `cloud`, `kite` world points; `hand` the
   * sheltering hand (world) or null; `skin` 0..1 share of the rain on it.
   */
  update(dt: number, density: number, cloud: Readonly<Vec3>, kite: Readonly<Vec3>, hand: Readonly<Vec3> | null, skin: number): void;
  thunder(at: Readonly<Vec3>): void;
  dispose(): void;
}

const SILENT = 0.0005;
const NOISE_S = 4;

function pinkNoise(ctx: BaseAudioContext, seconds: number, seed: number): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buffer.getChannelData(0);
  // Paul Kellet's economy pink filter over a seeded LCG.
  let s = seed >>> 0;
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const w = s / 2147483648 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
  }
  // Cross-fade the ends so the loop has no seam.
  const fade = Math.floor(ctx.sampleRate * 0.05);
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    d[n - fade + i] = d[n - fade + i] * (1 - k) + d[i] * k;
  }
  return buffer;
}

function panner(ctx: AudioContext, ref: number): PannerNode {
  const p = ctx.createPanner();
  p.panningModel = 'HRTF';
  p.distanceModel = 'inverse';
  p.refDistance = ref;
  p.maxDistance = 6;
  p.rolloffFactor = 1;
  return p;
}

const place = (p: PannerNode, v: Readonly<Vec3>, t: number): void => {
  p.positionX.setTargetAtTime(v.x, t, 0.05);
  p.positionY.setTargetAtTime(v.y, t, 0.05);
  p.positionZ.setTargetAtTime(v.z, t, 0.05);
};

export function createStormAudio(): StormAudio {
  let ctx: AudioContext;
  try {
    ctx = ThreeAudioContext.getContext();
  } catch {
    return { update() {}, thunder() {}, dispose() {} };
  }
  const out = ctx.createGain();
  out.gain.value = 0.8;
  out.connect(ctx.destination);
  const noise = pinkNoise(ctx, NOISE_S, 0x5eed1234);

  // Rain bed from the cloud.
  const bed = ctx.createBufferSource();
  bed.buffer = noise;
  bed.loop = true;
  const bedFilter = ctx.createBiquadFilter();
  bedFilter.type = 'bandpass';
  bedFilter.frequency.value = 3200;
  bedFilter.Q.value = 0.45;
  const bedGain = ctx.createGain();
  bedGain.gain.value = 0;
  const bedPan = panner(ctx, 0.5);
  bed.connect(bedFilter).connect(bedGain).connect(bedPan).connect(out);

  // Patter on the wood from the kite: darker, offset in the loop so it never phases with the bed.
  const patter = ctx.createBufferSource();
  patter.buffer = noise;
  patter.loop = true;
  patter.playbackRate.value = 0.73;
  const patterFilter = ctx.createBiquadFilter();
  patterFilter.type = 'lowpass';
  patterFilter.frequency.value = 1400;
  const patterGain = ctx.createGain();
  patterGain.gain.value = 0;
  const patterPan = panner(ctx, 0.3);
  patter.connect(patterFilter).connect(patterGain).connect(patterPan).connect(out);

  // Skin drops: one shared panner at the hand, short clicks scheduled ahead.
  const skinPan = panner(ctx, 0.25);
  skinPan.connect(out);
  let started = false;
  let skinDue = 0;
  let rng = 0x1234567;
  const rand = (): number => {
    rng ^= rng << 13;
    rng ^= rng >>> 17;
    rng ^= rng << 5;
    return (rng >>> 0) / 4294967296;
  };

  const drop = (t: number): void => {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const offset = rand() * (NOISE_S - 0.1);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2400 + rand() * 3200;
    f.Q.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5 + 0.4 * rand(), t + 0.002);
    g.gain.exponentialRampToValueAtTime(SILENT, t + 0.035);
    src.connect(f).connect(g).connect(skinPan);
    src.start(t, offset, 0.05);
    src.onended = () => {
      src.disconnect();
      f.disconnect();
      g.disconnect();
    };
  };

  return {
    update(dt, density, cloud, kite, hand, skin) {
      if (ctx.state !== 'running') return;
      const t = ctx.currentTime;
      if (!started) {
        started = true;
        bed.start(t, 0);
        patter.start(t, NOISE_S / 2);
      }
      const d = density > 0 ? (density < 1 ? density : 1) : 0;
      // A sheltered kite is quieter under the hand: the patter thins out with the cover.
      bedGain.gain.setTargetAtTime(0.32 * d, t, 0.3);
      patterGain.gain.setTargetAtTime(0.22 * d * (1 - 0.6 * skin), t, 0.3);
      place(bedPan, cloud, t);
      place(patterPan, kite, t);
      if (!hand || skin <= 0 || d <= 0) {
        skinDue = 0;
        return;
      }
      place(skinPan, hand, t);
      // Up to ~22 drops per second on a hand that takes the whole rain; never more than 4 per frame.
      const rate = 22 * skin * d;
      skinDue += rate * dt;
      for (let n = 0; skinDue >= 1 && n < 4; n++) {
        skinDue -= 1;
        drop(t + 0.01 + rand() * dt);
      }
      if (skinDue > 4) skinDue = 0;
    },
    thunder(at) {
      if (ctx.state !== 'running') return;
      const t = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.playbackRate.value = 0.5;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(220, t);
      lp.frequency.exponentialRampToValueAtTime(90, t + 3);
      const g = ctx.createGain();
      // −24 dB peak, slow roll in and out: distant, never startling.
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.063, t + 0.6);
      g.gain.linearRampToValueAtTime(0.045, t + 1.4);
      g.gain.exponentialRampToValueAtTime(SILENT, t + 3.6);
      const p = panner(ctx, 1.5);
      place(p, at, t);
      src.connect(lp).connect(g).connect(p).connect(out);
      src.start(t, 0.3, 3.8);
      src.onended = () => {
        for (const n of [src, lp, g, p]) n.disconnect();
      };
    },
    dispose() {
      if (started) {
        bed.stop();
        patter.stop();
      }
      for (const n of [bed, bedFilter, bedGain, bedPan, patter, patterFilter, patterGain, patterPan, skinPan, out]) {
        n.disconnect();
      }
    },
  };
}
