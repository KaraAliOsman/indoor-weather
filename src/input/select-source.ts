import type { InputManager } from '@iwsdk/core';
import type { Handedness, HandSample } from '../core/types.ts';
import { createSelectQueue, type SelectEdge, type SelectQueue } from './select-queue.ts';

/**
 * Source A of the pinch: the system select, per hand.
 *
 * - `input.xr.gamepads[h]` present (IWER hands, controllers, Quest hands if
 *   the browser exposes a Gamepad) → its select edges ('gamepad').
 * - Otherwise a hand source → session selectstart/selectend filtered by
 *   `inputSource.hand` and handedness, through a queue that delivers one edge
 *   per frame ('events'). Same rules as IWSDK 1.0.1's private bridge
 *   (xr-input-manager.js:283-306, 346-379), which it does not expose.
 * - NEVER the 'select' event: IWER 2.5.0 fires it on press, before selectstart.
 */
export interface SelectSource {
  attach(session: XRSession): void;
  detach(): void;
  /** Fills selectStart/selectEnd/selecting/rawSelectStart/selectPath. Call once per hand per frame. */
  read(h: Handedness, out: HandSample): void;
}

export function createSelectSource(input: InputManager): SelectSource {
  const queues: Record<Handedness, SelectQueue> = { left: createSelectQueue(), right: createSelectQueue() };
  /** Source whose events are in the queue; a new source starts from scratch. */
  const bound: Record<Handedness, XRInputSource | null> = { left: null, right: null };
  let session: XRSession | null = null;

  const clear = (h: Handedness): void => {
    bound[h] = null;
    queues[h].reset();
  };

  const onEdge = (e: XRInputSourceEvent, edge: SelectEdge): void => {
    const src = e.inputSource;
    const h = src.handedness;
    if (!src.hand || (h !== 'left' && h !== 'right')) return;
    if (bound[h] !== src) {
      queues[h].reset();
      bound[h] = src;
    }
    queues[h].push(edge);
  };
  const onStart = (e: XRInputSourceEvent): void => onEdge(e, 'start');
  const onEnd = (e: XRInputSourceEvent): void => onEdge(e, 'end');

  const write = (out: HandSample, start: boolean, end: boolean, selecting: boolean): void => {
    out.selectStart = start;
    out.rawSelectStart = start;
    out.selectEnd = end;
    out.selecting = selecting;
  };

  const detach = (): void => {
    if (session) {
      session.removeEventListener('selectstart', onStart);
      session.removeEventListener('selectend', onEnd);
      session = null;
    }
    clear('left');
    clear('right');
  };

  return {
    attach(s) {
      if (session === s) return;
      detach();
      session = s;
      s.addEventListener('selectstart', onStart);
      s.addEventListener('selectend', onEnd);
    },

    detach,

    read(h, out) {
      const gp = input.xr.gamepads[h];
      if (gp) {
        // Gamepad edges are authoritative; stale queued events must not replay later.
        if (bound[h]) clear(h);
        write(out, gp.getSelectStart(), gp.getSelectEnd(), gp.getSelecting());
        out.selectPath = 'gamepad';
        return;
      }
      const primary = input.xr.getPrimaryInputSource(h);
      if (primary?.hand) {
        out.selectPath = 'events';
        if (bound[h] === primary) {
          const edge = queues[h].take();
          write(out, edge.start, edge.end, edge.selecting);
        } else {
          // No events from this source yet, or they came from a source that is gone.
          if (bound[h]) clear(h);
          write(out, false, false, false);
        }
        return;
      }
      if (bound[h]) clear(h);
      write(out, false, false, false);
      out.selectPath = 'none';
    },
  };
}
