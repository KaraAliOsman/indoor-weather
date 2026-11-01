import { AudioContext as ThreeAudioContext } from '@iwsdk/core';
import type { ActuationTarget, EventBus, HandleRegistry } from '../core/types.ts';

/**
 * Minimal paper foley, synthesised (no audio assets, no network):
 *   handle:grab → tick, notch → rustle, mechanism:complete → whoosh.
 *
 * Runs on three's shared AudioContext, the same one IWSDK's AudioListener
 * (on player.head) drives, so HRTF panners placed at the handle's world grab
 * point are heard from the right place. One noise buffer is synthesised at
 * creation; each sound is a short filtered noise burst. At most 3 voices
 * (the oldest is cut), master → DynamicsCompressor → destination.
 * Sounds are skipped while the context is not running (IWSDK suspends it on
 * sessionend; main.ts resumes it on the next select).
 *
 * AudioSource is not used: it needs a `src` URL.
 */

type Sound = 'tick' | 'rustle' | 'whoosh';

interface Voice {
  readonly src: AudioBufferSourceNode;
  readonly nodes: readonly AudioNode[];
}

const MAX_VOICES = 3;
const NOISE_S = 1.5;
const REF_DISTANCE_M = 0.3;
const MAX_DISTANCE_M = 5;
/** Floor for exponential ramps (they cannot reach 0). */
const SILENT = 0.0005;

export interface Foley {
  dispose(): void;
}

function createNoise(ctx: BaseAudioContext): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * NOISE_S);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  // Seeded LCG white noise, gently low-passed so the bursts sound like paper, not hiss.
  let s = 0x9e3779b9;
  let prev = 0;
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const white = s / 2147483648 - 1;
    prev = prev * 0.35 + white * 0.65;
    data[i] = prev;
  }
  return buffer;
}

export function createFoley(bus: EventBus, handles: HandleRegistry): Foley {
  let ctx: AudioContext;
  try {
    ctx = ThreeAudioContext.getContext();
  } catch {
    return { dispose() {} }; // no WebAudio: stay silent
  }

  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 12;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.2;
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(compressor);
  compressor.connect(ctx.destination);

  const noise = createNoise(ctx);
  const voices: Voice[] = [];

  const release = (v: Voice): void => {
    const i = voices.indexOf(v);
    if (i >= 0) voices.splice(i, 1);
    for (const n of v.nodes) n.disconnect();
  };

  const play = (sound: Sound, target: ActuationTarget): void => {
    if (ctx.state !== 'running') return;
    const at = handles.get(target)?.grabPoint;
    if (!at) return;
    if (voices.length >= MAX_VOICES) {
      const oldest = voices[0];
      oldest.src.onended = null;
      try {
        oldest.src.stop();
      } catch {
        // already stopped
      }
      release(oldest);
    }

    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    const filter = ctx.createBiquadFilter();
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t0);
    const pan = ctx.createPanner();
    pan.panningModel = 'HRTF';
    pan.distanceModel = 'inverse';
    pan.refDistance = REF_DISTANCE_M;
    pan.maxDistance = MAX_DISTANCE_M;
    pan.rolloffFactor = 1;
    pan.positionX.value = at.x;
    pan.positionY.value = at.y;
    pan.positionZ.value = at.z;

    let duration: number;
    if (sound === 'tick') {
      // Card click: very short, bright.
      filter.type = 'highpass';
      filter.frequency.value = 2600;
      filter.Q.value = 0.7;
      env.gain.linearRampToValueAtTime(0.55, t0 + 0.003);
      env.gain.exponentialRampToValueAtTime(SILENT, t0 + 0.05);
      duration = 0.06;
    } else if (sound === 'rustle') {
      // Paper rustle: band-passed, with a second crackle on the way down.
      filter.type = 'bandpass';
      filter.frequency.value = 1500 + Math.random() * 900;
      filter.Q.value = 0.9;
      env.gain.linearRampToValueAtTime(0.42, t0 + 0.025);
      env.gain.linearRampToValueAtTime(0.14, t0 + 0.12);
      env.gain.linearRampToValueAtTime(0.3, t0 + 0.18);
      env.gain.exponentialRampToValueAtTime(SILENT, t0 + 0.45);
      duration = 0.5;
    } else {
      // Whoosh: a low-pass sweep up and back down.
      filter.type = 'lowpass';
      filter.Q.value = 0.6;
      filter.frequency.setValueAtTime(250, t0);
      filter.frequency.exponentialRampToValueAtTime(2200, t0 + 0.45);
      filter.frequency.exponentialRampToValueAtTime(500, t0 + 1.3);
      env.gain.linearRampToValueAtTime(0.5, t0 + 0.4);
      env.gain.exponentialRampToValueAtTime(SILENT, t0 + 1.4);
      duration = 1.5;
    }

    src.connect(filter);
    filter.connect(env);
    env.connect(pan);
    pan.connect(master);
    const voice: Voice = { src, nodes: [src, filter, env, pan] };
    voices.push(voice);
    src.onended = () => release(voice);
    const offset = Math.random() * Math.max(0, NOISE_S - duration * 1.1);
    src.start(t0, offset, duration);
  };

  const off = [
    bus.on('handle:grab', (e) => play('tick', e.target)),
    bus.on('notch', (e) => play('rustle', e.target)),
    bus.on('mechanism:complete', (e) => play('whoosh', e.target)),
  ];

  return {
    dispose() {
      for (const f of off) f();
      for (const v of voices.slice()) {
        v.src.onended = null;
        try {
          v.src.stop();
        } catch {
          // already stopped
        }
        release(v);
      }
      master.disconnect();
      compressor.disconnect();
    },
  };
}
