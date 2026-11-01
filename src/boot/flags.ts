/**
 * URL flags. Read once at boot; never change during a session.
 *
 *   ?debug=1        in-world HUD, window.__indoor, shader error checks
 *   ?reset=1        wipe our saved progress and reload
 *   ?quality=high|medium|low   pin the quality governor
 *   ?room=off       fully opaque night veil (split-screen trailer shots)
 *   ?planes=0       do not request plane detection ("room without Space Setup")
 *   ?hands=show     draw the hands (emulator and trailer captures have no real hands)
 *   ?pinch=distance thumb/index distance instead of the system select (escape hatch)
 *   ?veto=0         disable the palm-to-face veto on pinch starts
 *   ?sem=mesa       dev builds only: install the MesaSEM table in the injected emulator
 */
export type QualityPin = 'high' | 'medium' | 'low' | null;

export type PinchSource = 'select' | 'distance';

export interface Flags {
  debug: boolean;
  reset: boolean;
  quality: QualityPin;
  roomOff: boolean;
  planes: boolean;
  showHands: boolean;
  pinch: PinchSource;
  veto: boolean;
  /** Only honoured in dev builds (the emulator never ships in dist). */
  sem: 'mesa' | null;
}

export function parseFlags(search: string): Flags {
  const q = new URLSearchParams(search);
  const quality = q.get('quality');
  return {
    debug: q.get('debug') === '1',
    reset: q.get('reset') === '1',
    quality: quality === 'high' || quality === 'medium' || quality === 'low' ? quality : null,
    roomOff: q.get('room') === 'off',
    planes: q.get('planes') !== '0',
    showHands: q.get('hands') === 'show',
    pinch: q.get('pinch') === 'distance' ? 'distance' : 'select',
    veto: q.get('veto') !== '0',
    sem: q.get('sem') === 'mesa' ? 'mesa' : null,
  };
}
