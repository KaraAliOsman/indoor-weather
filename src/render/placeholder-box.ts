import { BoxGeometry, Mesh, MeshBasicMaterial, type World } from '@iwsdk/core';

/**
 * M0 stand-in for the almanac box: a closed cardboard block at the fallback
 * placement (45 cm ahead, at seated table height). Replaced by the real box
 * and the placement system in M1.
 */
export function addPlaceholderBox(world: World): Mesh {
  const box = new Mesh(
    new BoxGeometry(0.24, 0.08, 0.18),
    new MeshBasicMaterial({ color: 0xc9a46a }),
  );
  box.name = 'almanac-box-placeholder';
  box.position.set(0, 0.78, -0.45);
  world.createTransformEntity(box);
  return box;
}
