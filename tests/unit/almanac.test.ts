import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALMANAC_CORRUPT_KEY,
  ALMANAC_KEY,
  ALMANAC_SIM_KEY,
  createAlmanacState,
  createAlmanacStore,
  dailyPage,
  decodeStrip,
  earnSeal,
  encodeStrip,
  isDateKey,
  isFinaleReady,
  isStoryComplete,
  localDateKey,
  markNuxSeen,
  migrateAlmanac,
  moonPhase,
  nextChapter,
  recordStrip,
  resumeBeat,
  SAVE_MIN_INTERVAL_MS,
  sealOf,
  seedDemoWeek,
  serializeAlmanac,
  setProgress,
  shiftDateKey,
  STRIP_COLUMNS,
  stripDays,
  todayKey,
  type AlmanacStorage,
} from '../../src/core/almanac.ts';
import { resetProgress, STORAGE_PREFIX } from '../../src/boot/reset.ts';

/** In-memory Storage with the DOM shape (length/key) so resetProgress works on it. */
function memoryStorage(init: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(init));
  const s = {
    map,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
  return s;
}

const DAY = '2026-10-31';

test('local date key: uses the local calendar, pads, and validates', () => {
  assert.equal(localDateKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(localDateKey(new Date(2026, 9, 31, 0, 0, 1)), DAY);
  assert.equal(todayKey(new Date(2026, 9, 31, 12), 1), '2026-11-01');
  assert.equal(shiftDateKey('2028-02-28', 1), '2028-02-29');
  assert.equal(shiftDateKey('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDateKey('2026-03-01', -1), '2026-02-28');
  assert.ok(isDateKey(DAY));
  for (const bad of ['2026-02-30', '2026-13-01', '26-10-31', '2026-10-31T00', 20261031, null]) {
    assert.equal(isDateKey(bad), false, String(bad));
  }
});

test('daily page is deterministic per date and varies across dates', () => {
  assert.deepEqual(dailyPage(DAY), dailyPage(DAY));
  const seeds = new Set<number>();
  const variants = new Set<number>();
  let day = '2026-01-01';
  for (let i = 0; i < 365; i++) {
    const p = dailyPage(day);
    seeds.add(p.seed);
    variants.add(p.variant);
    assert.ok(p.leafPalette >= 0 && p.leafPalette < 5);
    assert.ok(p.kitePattern >= 0 && p.kitePattern < 6);
    assert.ok(p.cloudShape >= 0 && p.cloudShape < 3);
    assert.ok(p.moon >= 0 && p.moon < 8);
    const next = dailyPage(shiftDateKey(day, 1));
    // The swirl sense and the melodic mode alternate every day.
    assert.equal(next.swirl, -p.swirl as 1 | -1);
    assert.notEqual(next.melodicMode, p.melodicMode);
    day = shiftDateKey(day, 1);
  }
  assert.equal(seeds.size, 365);
  assert.ok(variants.size >= 20, `only ${variants.size} variants in a year`);
  assert.equal(dailyPage(DAY).label, '31·10');
});

test('surprise cycle: day 1 of the almanac is canonical, 7-day cycle', () => {
  const first = '2026-10-29';
  assert.equal(dailyPage(first, first).surprise, 1);
  assert.equal(dailyPage(shiftDateKey(first, 1), first).surprise, 2);
  assert.equal(dailyPage(shiftDateKey(first, 6), first).surprise, 7);
  assert.equal(dailyPage(shiftDateKey(first, 7), first).surprise, 1);
  // A clock that went backwards never yields day 0.
  assert.equal(dailyPage(shiftDateKey(first, -3), first).dayNumber, 1);
});

test('moon phase matches known lunations', () => {
  assert.equal(moonPhase('2000-01-06'), 0); // new moon
  assert.equal(moonPhase('2024-04-08'), 0); // total eclipse, new moon
  assert.equal(moonPhase('2024-04-23'), 4); // full moon
  assert.equal(moonPhase('2026-10-26'), 4); // full moon
});

test('seals: earned per chapter, idempotent, finale when the three are in', () => {
  let s = createAlmanacState(DAY);
  assert.equal(nextChapter(sealOf(s, DAY)), 'wind');
  const s0 = s;
  s = earnSeal(s, DAY, 'wind');
  assert.notEqual(s, s0);
  assert.deepEqual(s0.days, {}, 'input is not mutated');
  assert.equal(earnSeal(s, DAY, 'wind'), s, 'earning twice returns the same state');
  assert.equal(nextChapter(sealOf(s, DAY)), 'storm');
  assert.equal(isFinaleReady(s, DAY), false);
  s = earnSeal(s, DAY, 'shelter'); // secret glyph does not count for the finale
  s = earnSeal(s, DAY, 'storm');
  assert.equal(isFinaleReady(s, DAY), false);
  s = earnSeal(s, DAY, 'dawn');
  assert.equal(isFinaleReady(s, DAY), true);
  assert.equal(nextChapter(sealOf(s, DAY)), null);
  assert.equal(sealOf(s, DAY), 29);
  assert.equal(isStoryComplete(13), true);
  assert.equal(isStoryComplete(16 | 5), false);
  // Seals are per day: tomorrow starts empty.
  assert.equal(isFinaleReady(s, shiftDateKey(DAY, 1)), false);
  assert.equal(s.days[DAY]!.moon, dailyPage(DAY).moon);
  assert.equal(s.days[DAY]!.variant, dailyPage(DAY).variant);
});

test('strip encodes 36 columns × 6 bits and round-trips', () => {
  const holes = Array.from({ length: STRIP_COLUMNS }, (_, i) => (i * 7) & 0x3f);
  const b64 = encodeStrip(holes);
  assert.deepEqual([...decodeStrip(b64)!], holes);
  assert.equal(decodeStrip('not base64!!'), null);
  assert.equal(decodeStrip(btoa('short')), null);
  assert.deepEqual([...decodeStrip(encodeStrip([0xff]))!].slice(0, 2), [0x3f, 0]);
});

test('strip days: oldest first, skipped days blank, never before firstDay', () => {
  let s = createAlmanacState('2026-10-29');
  s = earnSeal(s, '2026-10-29', 'wind');
  s = earnSeal(s, DAY, 'wind');
  const days = stripDays(s, DAY, 7);
  assert.deepEqual(
    days.map((d) => [d.day, d.record !== null]),
    [
      ['2026-10-29', true],
      ['2026-10-30', false],
      [DAY, true],
    ],
  );
});

test('demo week seeds the 6 previous days complete and deterministic', () => {
  const s = seedDemoWeek(createAlmanacState(DAY), DAY);
  assert.equal(s.firstDay, '2026-10-25');
  const days = stripDays(s, DAY, 7);
  assert.equal(days.length, 7);
  for (const d of days.slice(0, 6)) {
    assert.ok(isStoryComplete(d.record!.seal));
    assert.ok(decodeStrip(d.record!.strip!));
  }
  assert.equal(days[6]!.record, null);
  assert.equal(serializeAlmanac(s), serializeAlmanac(seedDemoWeek(createAlmanacState(DAY), DAY)));
});

test('store: round trip under the prefixed key, throttle and force', () => {
  const storage = memoryStorage();
  const store = createAlmanacStore(storage);
  assert.equal(store.load(DAY).status, 'fresh');
  let s = earnSeal(createAlmanacState(DAY), DAY, 'wind');
  s = setProgress(markNuxSeen(recordStrip(s, DAY, [1, 2, 3])), DAY, 'storm');
  assert.equal(store.save(s, 1000), true);
  assert.ok(ALMANAC_KEY.startsWith(STORAGE_PREFIX));
  assert.equal(ALMANAC_KEY, 'indoorweather.v1');
  assert.equal(store.save(s, 1000 + SAVE_MIN_INTERVAL_MS - 1), false, 'throttled');
  assert.equal(store.save(s, 1001, true), true, 'forced (beat edge, stamp)');

  const loaded = createAlmanacStore(storage).load(DAY);
  assert.equal(loaded.status, 'loaded');
  assert.deepEqual(loaded.state, s);
  assert.equal(resumeBeat(loaded.state, DAY), 'storm');
  assert.equal(resumeBeat(loaded.state, shiftDateKey(DAY, 1)), null);

  // ?reset=1 removes it like every other prefixed key.
  assert.equal(resetProgress(storage as unknown as Storage), 1);
  assert.equal(createAlmanacStore(storage).load(DAY).status, 'fresh');
});

test('store: corrupt JSON never throws, is backed up once and replaced', () => {
  for (const text of ['{not json', 'null', '[1,2]', '"str"', '{"version":"x"}', '{"version":0}']) {
    const storage = memoryStorage({ [ALMANAC_KEY]: text });
    const r = createAlmanacStore(storage).load(DAY);
    assert.equal(r.status, 'corrupt', text);
    assert.deepEqual(r.state, createAlmanacState(DAY));
    assert.equal(storage.map.get(ALMANAC_CORRUPT_KEY), text);
    assert.equal(storage.map.has(ALMANAC_KEY), false);
  }
});

test('migration: field-level garbage is repaired, unknown fields kept', () => {
  const raw = {
    version: 1,
    firstDay: 'yesterday',
    days: {
      '2026-10-30': { seal: 1023, moon: 99, variant: -1, strip: '@@' },
      '2026-02-30': { seal: 7 },
      [DAY]: 'oops',
      '2026-10-31x': { seal: 7 },
    },
    progress: { day: DAY, beat: 42 },
    nuxSeen: 'yes',
    settings: { calm: true },
    metrics: { runs: 3 },
  };
  const { state, status } = migrateAlmanac(raw, DAY);
  assert.equal(status, 'loaded');
  assert.deepEqual(Object.keys(state.days), ['2026-10-30']);
  const d = state.days['2026-10-30']!;
  assert.equal(d.seal, 29);
  assert.equal(d.moon, dailyPage('2026-10-30').moon);
  assert.equal(d.variant, dailyPage('2026-10-30').variant);
  assert.equal(d.strip, undefined);
  assert.equal(state.firstDay, '2026-10-30');
  assert.equal(state.progress, undefined);
  assert.equal(state.nuxSeen, false);
  assert.deepEqual(state.extra, { settings: { calm: true }, metrics: { runs: 3 } });
  const out = JSON.parse(serializeAlmanac(state)) as Record<string, unknown>;
  assert.deepEqual(out.settings, { calm: true });
  assert.equal(out.version, 1);
});

test('migration v0 (M1 snapshot without version) → v1 seal mask', () => {
  const storage = memoryStorage({
    [ALMANAC_KEY]: JSON.stringify({ day: '2026-10-30', completed: ['wind', 'shelter', 'storm', 'bogus'] }),
  });
  const r = createAlmanacStore(storage).load(DAY);
  assert.equal(r.status, 'migrated');
  assert.equal(r.state.firstDay, '2026-10-30');
  assert.equal(sealOf(r.state, '2026-10-30'), 5);
  assert.equal(nextChapter(sealOf(r.state, '2026-10-30')), 'dawn');
});

test('a save from a newer build is never overwritten', () => {
  const text = JSON.stringify({ version: 9, firstDay: DAY, days: {} });
  const storage = memoryStorage({ [ALMANAC_KEY]: text });
  const store = createAlmanacStore(storage);
  assert.equal(store.load(DAY).status, 'future');
  assert.equal(store.readOnly, true);
  assert.equal(store.save(createAlmanacState(DAY), 0, true), false);
  assert.equal(storage.map.get(ALMANAC_KEY), text);
});

test('blocked storage (throws) or no storage: fresh state, no exceptions', () => {
  const throwing: AlmanacStorage = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
    removeItem() {
      throw new Error('SecurityError');
    },
  };
  const a = createAlmanacStore(throwing);
  assert.equal(a.load(DAY).status, 'unavailable');
  assert.equal(a.save(createAlmanacState(DAY), 0, true), false);
  const b = createAlmanacStore(undefined);
  assert.equal(b.load(DAY).status, 'unavailable');
  assert.equal(b.save(createAlmanacState(DAY), 0, true), false);
});

// --- Review fixes -----------------------------------------------------------

test('fix: a garbage ?day= offset or an Invalid Date never yields a key that crashes dailyPage', () => {
  const now = new Date(2026, 9, 31, 12);
  for (const off of [Number.NaN, Infinity, -Infinity, Number.parseInt('abc', 10)]) {
    assert.equal(todayKey(now, off), DAY, String(off));
  }
  for (const off of [1e9, -1e9, Number.MAX_SAFE_INTEGER]) {
    const key = todayKey(now, off);
    assert.ok(isDateKey(key), `${off} → ${key}`);
    assert.doesNotThrow(() => dailyPage(key));
  }
  assert.equal(todayKey(now, 1.9), '2026-11-01', 'fractional offsets truncate');
  const bad = todayKey(new Date(Number.NaN));
  assert.ok(isDateKey(bad), bad);
  assert.doesNotThrow(() => dailyPage(bad));
  assert.equal(shiftDateKey(DAY, Number.NaN), DAY);
  assert.ok(isDateKey(shiftDateKey('9999-12-31', 1)));
});

test('fix: demo week never overwrites days that were really played', () => {
  let s = createAlmanacState('2026-10-28');
  s = earnSeal(s, '2026-10-28', 'wind'); // real, half-played day inside the demo window
  s = recordStrip(s, '2026-10-27', [5, 5, 5]); // real strip (firstDay moves back)
  const realStrip = s.days['2026-10-27']!.strip;
  const seeded = seedDemoWeek(s, DAY);
  assert.equal(sealOf(seeded, '2026-10-28'), 1, 'real seal kept, not completed by the demo');
  assert.equal(seeded.days['2026-10-28']!.strip, undefined);
  assert.equal(seeded.days['2026-10-27']!.strip, realStrip);
  assert.ok(isStoryComplete(sealOf(seeded, '2026-10-25')));
  assert.ok(isStoryComplete(sealOf(seeded, '2026-10-30')));
});

test('fix: a NaN or backwards clock neither disables nor blocks the save throttle', () => {
  const storage = memoryStorage();
  const store = createAlmanacStore(storage);
  const s = createAlmanacState(DAY);
  // NaN used to poison lastWriteMs and switch the throttle off for good.
  assert.equal(store.save(s, Number.NaN), false, 'non-finite time only writes when forced');
  assert.equal(store.save(s, Number.NaN, true), true);
  assert.equal(store.save(s, 10_000), true);
  assert.equal(store.save(s, 10_001), false, 'still throttled after a NaN');
  // Switching from Date.now() to performance.now() used to block saves for decades.
  const big = createAlmanacStore(memoryStorage());
  assert.equal(big.save(s, 1.7e12), true);
  assert.equal(big.save(s, 50), true, 'clock went backwards: write and re-arm');
  assert.equal(big.save(s, 60), false);
});

test('fix: a throttled save is kept pending and flushed, not dropped', () => {
  const storage = memoryStorage();
  const store = createAlmanacStore(storage);
  let s = earnSeal(createAlmanacState(DAY), DAY, 'wind');
  assert.equal(store.save(s, 0, true), true);
  s = setProgress(s, DAY, 'storm'); // beat edge 1 s after the seal
  assert.equal(store.save(s, 1000), false);
  assert.equal(store.pending, true);
  assert.equal(store.flush(SAVE_MIN_INTERVAL_MS - 1), false);
  assert.equal(store.flush(SAVE_MIN_INTERVAL_MS), true);
  assert.equal(store.pending, false);
  assert.equal(store.flush(1e9), false, 'nothing pending: no write');
  assert.equal(resumeBeat(createAlmanacStore(storage).load(DAY).state, DAY), 'storm');
  // A forced save also clears the pending one.
  assert.equal(store.save(s, SAVE_MIN_INTERVAL_MS + 1), false);
  assert.equal(store.save(s, SAVE_MIN_INTERVAL_MS + 2, true), true);
  assert.equal(store.pending, false);
});

test('fix: simulated (?day / ?demoWeek) sessions read the real save but never write it', () => {
  const real = serializeAlmanac(earnSeal(createAlmanacState(DAY), DAY, 'wind'));
  const storage = memoryStorage({ [ALMANAC_KEY]: real });
  const tomorrow = shiftDateKey(DAY, 1);
  const sim = createAlmanacStore(storage, { simulated: true });
  const loaded = sim.load(tomorrow);
  assert.equal(loaded.status, 'loaded');
  assert.equal(sealOf(loaded.state, DAY), 1, 'the real day shows on the strip');
  let s = loaded.state;
  for (const id of ['wind', 'storm', 'dawn'] as const) s = earnSeal(s, tomorrow, id);
  assert.equal(sim.save(seedDemoWeek(s, tomorrow), 0, true), true);
  assert.equal(storage.map.get(ALMANAC_KEY), real, 'real save untouched');
  assert.ok(storage.map.get(ALMANAC_SIM_KEY)!.startsWith('{'));
  // The real tomorrow is still a new page.
  const realLoad = createAlmanacStore(storage).load(tomorrow);
  assert.equal(isFinaleReady(realLoad.state, tomorrow), false);
  // A second simulated visit continues the simulated save.
  assert.equal(isFinaleReady(createAlmanacStore(storage, { simulated: true }).load(tomorrow).state, tomorrow), true);
  // A corrupt real save is not moved away by a simulated session.
  const bad = memoryStorage({ [ALMANAC_KEY]: '{nope' });
  assert.equal(createAlmanacStore(bad, { simulated: true }).load(DAY).status, 'corrupt');
  assert.equal(bad.map.get(ALMANAC_KEY), '{nope');
  // ?reset=1 removes the simulated save too.
  assert.ok(ALMANAC_SIM_KEY.startsWith(STORAGE_PREFIX));
  resetProgress(storage as unknown as Storage);
  assert.equal(storage.map.size, 0);
});
