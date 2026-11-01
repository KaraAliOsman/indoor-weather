import { AssetManager } from '@iwsdk/core';

/**
 * Zero cross-origin requests.
 *
 * IWSDK resolves controller/hand models from the WebXR input-profiles CDN, and
 * a profile's asset path wins over our visual class's own `assetPath`. This
 * wrapper rewrites any such URL to our self-hosted proxy glTF. Draco/KTX2/
 * meshopt are never used, so their unpkg decoders are never requested.
 */
export const INPUT_PROFILES_CDN = 'https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets';

export function installCdnGuard(baseUrl: string): void {
  const original = AssetManager.loadGLTF.bind(AssetManager);
  const proxy = `${baseUrl}proxy/controller.gltf`;
  AssetManager.loadGLTF = ((urlOrKey: string, key?: string) =>
    original(urlOrKey.startsWith(INPUT_PROFILES_CDN) ? proxy : urlOrKey, key)) as typeof AssetManager.loadGLTF;
}
