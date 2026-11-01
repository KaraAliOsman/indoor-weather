import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFlags } from '../../src/boot/flags.ts';
import { resetProgress, STORAGE_PREFIX } from '../../src/boot/reset.ts';

test('parseFlags: defaults', () => {
  assert.deepEqual(parseFlags(''), {
    debug: false,
    reset: false,
    quality: null,
    roomOff: false,
    planes: true,
    showHands: false,
    pinch: 'select',
    veto: true,
    sem: null,
  });
});

test('parseFlags: all flags', () => {
  const f = parseFlags('?debug=1&reset=1&quality=low&room=off&planes=0&hands=show&pinch=distance&veto=0&sem=mesa');
  assert.equal(f.debug, true);
  assert.equal(f.reset, true);
  assert.equal(f.quality, 'low');
  assert.equal(f.roomOff, true);
  assert.equal(f.planes, false);
  assert.equal(f.showHands, true);
  assert.equal(f.pinch, 'distance');
  assert.equal(f.veto, false);
  assert.equal(f.sem, 'mesa');
});

test('parseFlags: unknown pinch / sem values fall back to the defaults', () => {
  const f = parseFlags('?pinch=magic&sem=empty&veto=1');
  assert.equal(f.pinch, 'select');
  assert.equal(f.sem, null);
  assert.equal(f.veto, true);
});

test('parseFlags: unknown quality is ignored', () => {
  assert.equal(parseFlags('?quality=ultra').quality, null);
});

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

test('resetProgress removes only our keys', () => {
  const s = new MemoryStorage();
  s.setItem(`${STORAGE_PREFIX}v1`, '{}');
  s.setItem(`${STORAGE_PREFIX}settings`, '{}');
  s.setItem('someone-else', 'keep');
  assert.equal(resetProgress(s), 2);
  assert.equal(s.length, 1);
  assert.equal(s.getItem('someone-else'), 'keep');
});
