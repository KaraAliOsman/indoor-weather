import { ReferenceSpaceType, SessionMode, type WorldOptions } from '@iwsdk/core';
import type { Flags } from './flags';

/**
 * World options for @iwsdk/core 1.0.1 (code-only project, no iwsdk.config.json).
 *
 * Left out on purpose: anchors, depthSensing, meshDetection, layers (quad and
 * cylinder layers are broken in 1.0.1) and gaze/eye tracking (Quest 3/3S have
 * no eye tracking). Every feature here is optional, never { required: true }.
 */
export function createWorldOptions(flags: Flags): WorldOptions {
  return {
    xr: {
      sessionMode: SessionMode.ImmersiveAR,
      referenceSpace: {
        type: ReferenceSpaceType.LocalFloor,
        fallbackOrder: [ReferenceSpaceType.Local],
      },
      features: {
        handTracking: true,
        hitTest: true,
        // Only used to find the table edge (Should); placement never depends on it.
        planeDetection: flags.planes,
      },
      // No automatic offerSession: our own button calls launchXR() synchronously.
      offer: 'none',
      restoreCameraOnExit: true,
    },
    // Stencil: the storm veil darkens the room but skips what the story is about (canon §5).
    render: { near: 0.05, far: 50, stencil: true },
    // Desktop mouse mode uses the same RayInteractable handles as hand rays.
    input: { canvasPointerEvents: true },
    features: {
      environmentRaycast: true,
      sceneUnderstanding: false,
      spatialUI: false,
      grabbing: false,
      physics: false,
      locomotion: false,
    },
  };
}
