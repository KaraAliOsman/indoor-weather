import {
  CapsuleGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  type InputLayout,
  type PerspectiveCamera,
  type Scene,
  type XRControllerVisualAdapter,
} from '@iwsdk/core';

/**
 * Low-poly stand-in for Touch controllers. Indoor Weather is hands-first; the
 * controller path exists so the app never breaks if a judge picks one up, and
 * so no controller GLB is fetched from the input-profiles CDN.
 */
export class ProxyController {
  static assetKeyPrefix = 'iw-ctl';
  static assetProfileId = 'proxy-controller';
  static assetPath = '/proxy/controller.gltf';

  model = new Group();
  xrInput?: XRControllerVisualAdapter;

  constructor(_scene: Scene, _camera: PerspectiveCamera, _gltfScene: Group, _layout: InputLayout) {
    const body = new Mesh(
      new CapsuleGeometry(0.018, 0.07, 4, 10),
      new MeshBasicMaterial({ color: 0xd8cfbf }),
    );
    // Point the capsule forward (-Z) along the grip, tilted like a held wand.
    body.rotation.x = Math.PI / 2 - 0.35;
    body.position.set(0, -0.01, 0.02);
    this.model.add(body);
    this.model.name = 'proxy-controller';
  }

  init(): void {}

  connect(_inputSource: XRInputSource, enabled: boolean): void {
    this.model.visible = enabled;
  }

  disconnect(): void {
    this.model.visible = false;
  }

  toggle(enabled: boolean): void {
    this.model.visible = enabled;
  }

  update(_delta: number): void {}
}
