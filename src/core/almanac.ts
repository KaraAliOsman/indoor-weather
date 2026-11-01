/**
 * Almanac progression — the page of the day, its seal and the saved days.
 *
 * PURE module: no three, no @iwsdk/core, no Math.random, no Date.now(). The
 * caller passes the local Date (or a 'YYYY-MM-DD' key) and a Storage-like
 * object, so every result is reproducible in tests.
 *
 * - Page of the day: every variant (leaf palette, swirl sense, kite print,
 *   cloud shape, melodic mode, surprise, moon phase) derives from the LOCAL
 *   calendar date. The seed is FNV-1a of the 'YYYY-MM-DD' key.
 * - Seal: one bit per completed chapter (wind, night, storm) plus the secret
 *   kite glyph [S]. The story is complete (finale + stamp) when the three
 *   chapter bits are set.
 * - Persistence: one JSON value under `indoorweather.v1` (experiencia §4,
 *   "Persistencia"). Reading never throws: corrupt JSON is backed up and
 *   replaced by a fresh state; unknown top-level fields owned by other
 *   modules (settings, metrics, anchor) are kept as they are.
 */
import { STORAGE_PREFIX } from '../boot/reset.ts';
import type { MechanismId } from './types.ts';
import { decodePrint } from '../storm/print.ts';

// ---------------------------------------------------------------------------
// Constants

export const ALMANAC_VERSION = 1;
/** The single key of the save (?reset=1 removes it with the prefix). */
export const ALMANAC_KEY = `${STORAGE_PREFIX}v1`;
/** Unreadable payloads are moved here once, so nothing is lost silently. */
export const ALMANAC_CORRUPT_KEY = `${STORAGE_PREFIX}v1.corrupt`;
/**
 * `?day=±n` / `?demoWeek=1` sessions write here instead: a simulated tomorrow
 * must not stamp the real tomorrow (the judge would come back to a finished
 * day). Same prefix, so ?reset=1 removes it too.
 */
export const ALMANAC_SIM_KEY = `${STORAGE_PREFIX}v1.sim`;
/** Saves are throttled to one every 5 s unless forced (beat edge, stamp). */
export const SAVE_MIN_INTERVAL_MS = 5000;
/** Keep at most this many days (≈ a year): bounds the localStorage value. */
export const MAX_DAYS = 400;
/** Strip segment: 36 columns × 6 rows, one byte per column (low 6 bits). */
export const STRIP_COLUMNS = 36;
export const STRIP_ROWS = 6;

/** Seal bits. The chapter order is the story order. */
export type SealId = MechanismId | 'shelter';
/** canon §9: wind 1, storm 4, dawn 8, shelter 16 (bit 2 was the retired night chapter). */
export const SEAL_BIT: Readonly<Record<SealId, number>> = {
  wind: 1,
  storm: 4,
  dawn: 8,
  /** The kite was sheltered by a hand (or the paper umbrella). Not needed for the finale. */
  shelter: 16,
};
export const CHAPTERS: readonly MechanismId[] = ['wind', 'storm', 'dawn'];
/** wind | storm | dawn. */
export const STORY_SEAL_MASK = 13;
const ALL_SEAL_MASK = 29;

const SYNODIC_DAYS = 29.530588853;
/** Epoch day (UTC midnight based) of the new moon of 2000-01-06 18:14 UTC. */
const NEW_MOON_EPOCH_DAY = 10962.76;

// ---------------------------------------------------------------------------
// Types (local to M2; core/types.ts is untouched)

/** Local calendar date, 'YYYY-MM-DD'. */
export type DateKey = string;

export type MelodicMode = 'd-major-pentatonic' | 'b-minor-pentatonic';

/** 1 canonical · 2 rainbow · 3 snow · 4 second kite · 5 petals · 6 more sparks · 7 roll. */
export type Surprise = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface DailyPage {
  day: DateKey;
  /** FNV-1a of `day`. */
  seed: number;
  /** Days since 1970-01-01 of the local date. */
  epochDay: number;
  /** 1-based day of the almanac (firstDay = 1). */
  dayNumber: number;
  surprise: Surprise;
  /** 0 new · 2 first quarter · 4 full · 6 last quarter. */
  moon: number;
  /** 0..4 two-ink riso combination (season-biased). */
  leafPalette: number;
  /** +1 counter-clockwise seen from above, -1 clockwise; alternates daily. */
  swirl: 1 | -1;
  /** 0..5 riso print. */
  kitePattern: number;
  /** 0..2 cloud silhouette. */
  cloudShape: number;
  /** D major pentatonic on even epoch days, B minor pentatonic on odd. */
  melodicMode: MelodicMode;
  /** Packed leafPalette + 5·(kitePattern + 6·cloudShape), as saved. */
  variant: number;
  /** Stamp numerals, e.g. '31·10'. */
  label: string;
}

export interface DayRecord {
  /** SEAL_BIT mask. */
  seal: number;
  moon: number;
  variant: number;
  /** base64 of STRIP_COLUMNS bytes; absent until the finale wrote it. */
  strip?: string;
  /** The day's dry handprint (storm/print.ts run-length bits); absent until the storm kept one. */
  print?: string;
}

export interface AlmanacProgress {
  day: DateKey;
  /** Last beat reached today (GamePhase or finer); resume point. */
  beat: string;
}

export interface AlmanacState {
  version: typeof ALMANAC_VERSION;
  firstDay: DateKey;
  days: Record<DateKey, DayRecord>;
  progress?: AlmanacProgress;
  nuxSeen: boolean;
  /** Fields owned by other modules (settings, metrics, anchor): kept verbatim. */
  extra: Record<string, unknown>;
}

export type LoadStatus = 'fresh' | 'loaded' | 'migrated' | 'corrupt' | 'future' | 'unavailable';

export interface LoadResult {
  state: AlmanacState;
  status: LoadStatus;
}

/** The subset of DOM Storage the almanac needs (localStorage in the app). */
export interface AlmanacStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// ---------------------------------------------------------------------------
// Dates

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);
/** Keys stay 4-digit years: 1000-01-01 … 9999-12-31 (days since 1970). */
const MIN_EPOCH_DAY = -354_285;
const MAX_EPOCH_DAY = 2_932_896;
/** NaN/±Infinity (a bad `?day=` param) count as 0; the rest is truncated. */
const wholeDays = (n: number) => (Number.isFinite(n) ? Math.trunc(n) : 0);

/** 'YYYY-MM-DD' of the LOCAL calendar date (not UTC: the day turns at local midnight). */
export function localDateKey(date: Date): DateKey {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function isDateKey(value: unknown): value is DateKey {
  if (typeof value !== 'string') return false;
  const m = DATE_KEY_RE.exec(value);
  if (!m) return false;
  const y = +m[1]!;
  const mo = +m[2]!;
  const d = +m[3]!;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** Days since 1970-01-01 of a valid key (calendar arithmetic, no time zone). */
export function epochDay(key: DateKey): number {
  const m = DATE_KEY_RE.exec(key);
  if (!m) throw new Error(`almanac: bad date key ${key}`);
  return Math.round(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!) / 86_400_000);
}

/** Always a valid key: non-finite input is day 0, the range is clamped to 4-digit years. */
export function dateKeyFromEpochDay(day: number): DateKey {
  const d = Math.min(MAX_EPOCH_DAY, Math.max(MIN_EPOCH_DAY, wholeDays(day)));
  const t = new Date(d * 86_400_000);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** `?day=+1` and the recap walk the calendar with this. */
export function shiftDateKey(key: DateKey, days: number): DateKey {
  return dateKeyFromEpochDay(epochDay(key) + wholeDays(days));
}

/**
 * Today for the almanac: the local date plus the judges' `?day=±n` offset.
 * Never throws and always returns a valid key (an Invalid Date or a garbage
 * offset must not crash dailyPage at boot).
 */
export function todayKey(now: Date, dayOffset = 0): DateKey {
  const key = Number.isFinite(now.getTime()) ? localDateKey(now) : '';
  const base = isDateKey(key) ? epochDay(key) : 0;
  return dateKeyFromEpochDay(base + wholeDays(dayOffset));
}

// ---------------------------------------------------------------------------
// Page of the day

/** FNV-1a 32-bit of the key: the seed of the day. */
export function daySeed(key: DateKey): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: deterministic [0, 1) stream from a 32-bit seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Moon phase in eighths (0 new … 4 full … 7), computed at local noon. */
export function moonPhase(key: DateKey): number {
  const age = (epochDay(key) + 0.5 - NEW_MOON_EPOCH_DAY) / SYNODIC_DAYS;
  const frac = age - Math.floor(age);
  return Math.floor(frac * 8 + 0.5) % 8;
}

/** Northern meteorological season: 0 winter (DJF), 1 spring, 2 summer, 3 autumn. */
function season(key: DateKey): number {
  const month = +key.slice(5, 7);
  return Math.floor((month % 12) / 3);
}

export function packVariant(leafPalette: number, kitePattern: number, cloudShape: number): number {
  return leafPalette + 5 * (kitePattern + 6 * cloudShape);
}

/**
 * The page of `day`. Same key → same page on every device and every run.
 * `firstDay` only moves the 7-day surprise cycle (day 1 is always canonical).
 */
export function dailyPage(day: DateKey, firstDay: DateKey = day): DailyPage {
  const seed = daySeed(day);
  const rand = mulberry32(seed);
  const ed = epochDay(day);
  const dayNumber = Math.max(1, ed - epochDay(firstDay) + 1);
  const leafPalette = (season(day) + Math.floor(rand() * 2) * 2) % 5;
  const kitePattern = Math.floor(rand() * 6);
  const cloudShape = Math.floor(rand() * 3);
  const even = ed % 2 === 0;
  return {
    day,
    seed,
    epochDay: ed,
    dayNumber,
    surprise: (((dayNumber - 1) % 7) + 1) as Surprise,
    moon: moonPhase(day),
    leafPalette,
    swirl: even ? 1 : -1,
    kitePattern,
    cloudShape,
    melodicMode: even ? 'd-major-pentatonic' : 'b-minor-pentatonic',
    variant: packVariant(leafPalette, kitePattern, cloudShape),
    label: `${day.slice(8, 10)}·${day.slice(5, 7)}`,
  };
}

// ---------------------------------------------------------------------------
// Seals

export function hasSeal(mask: number, id: SealId): boolean {
  return (mask & SEAL_BIT[id]) !== 0;
}

/** Finale condition: wind, night and storm are all stamped. */
export function isStoryComplete(mask: number): boolean {
  return (mask & STORY_SEAL_MASK) === STORY_SEAL_MASK;
}

/** The next chapter to play today, or null when the story is complete. */
export function nextChapter(mask: number): MechanismId | null {
  for (const id of CHAPTERS) if (!hasSeal(mask, id)) return id;
  return null;
}

export function sealOf(state: AlmanacState, day: DateKey): number {
  return state.days[day]?.seal ?? 0;
}

/** Whether today's story is done (the same-day return lands in free play). */
export function isFinaleReady(state: AlmanacState, day: DateKey): boolean {
  return isStoryComplete(sealOf(state, day));
}

function recordFor(state: AlmanacState, day: DateKey): DayRecord {
  const existing = state.days[day];
  if (existing) return existing;
  const page = dailyPage(day, state.firstDay);
  return { seal: 0, moon: page.moon, variant: page.variant };
}

function withDay(state: AlmanacState, day: DateKey, record: DayRecord): AlmanacState {
  const firstDay = epochDay(day) < epochDay(state.firstDay) ? day : state.firstDay;
  return { ...state, firstDay, days: prune({ ...state.days, [day]: record }) };
}

/**
 * Earns the seal bit of `id` on `day`. Returns a NEW state (the input is not
 * mutated); idempotent: earning an earned seal returns the same object.
 */
export function earnSeal(state: AlmanacState, day: DateKey, id: SealId): AlmanacState {
  const record = recordFor(state, day);
  const bit = SEAL_BIT[id];
  if (state.days[day] && (record.seal & bit) !== 0) return state;
  return withDay(state, day, { ...record, seal: record.seal | bit });
}

/** Saves the finale's hole mask (one byte per column) as the day's strip segment. */
export function recordStrip(state: AlmanacState, day: DateKey, holes: ArrayLike<number>): AlmanacState {
  const record = recordFor(state, day);
  return withDay(state, day, { ...record, strip: encodeStrip(holes) });
}

/** Keeps the first valid handprint of the day (the storm can print once per run, the day keeps one). */
export function recordPrint(state: AlmanacState, day: DateKey, print: string): AlmanacState {
  const record = recordFor(state, day);
  if (record.print || !decodePrint(print)) return state;
  return withDay(state, day, { ...record, print });
}

export function setProgress(state: AlmanacState, day: DateKey, beat: string): AlmanacState {
  return { ...state, progress: { day, beat } };
}

/** Resume point, only for the same day (yesterday's half story is not resumed). */
export function resumeBeat(state: AlmanacState, day: DateKey): string | null {
  return state.progress && state.progress.day === day ? state.progress.beat : null;
}

export function markNuxSeen(state: AlmanacState): AlmanacState {
  return state.nuxSeen ? state : { ...state, nuxSeen: true };
}

/**
 * The strip of the last `count` days ending at `today`, oldest first.
 * Skipped days are null (blank segment; no streak, no guilt).
 */
export function stripDays(
  state: AlmanacState,
  today: DateKey,
  count: number,
): { day: DateKey; record: DayRecord | null }[] {
  const out: { day: DateKey; record: DayRecord | null }[] = [];
  const start = Math.max(epochDay(state.firstDay), epochDay(today) - count + 1);
  for (let d = start; d <= epochDay(today); d++) {
    const key = dateKeyFromEpochDay(d);
    out.push({ day: key, record: state.days[key] ?? null });
  }
  return out;
}

/**
 * `?demoWeek=1`: seeds the 6 days before `today` as complete days with a
 * deterministic strip, so the multi-day strip can be judged in one visit.
 * Days that already have a record (really played) are left untouched.
 */
export function seedDemoWeek(state: AlmanacState, today: DateKey): AlmanacState {
  let next = state;
  for (let i = 6; i >= 1; i--) {
    const day = shiftDateKey(today, -i);
    if (state.days[day]) continue;
    const rand = mulberry32(daySeed(day) ^ 0x5eed);
    const holes = new Array<number>(STRIP_COLUMNS);
    for (let c = 0; c < STRIP_COLUMNS; c++) holes[c] = rand() < 0.55 ? 1 << Math.floor(rand() * STRIP_ROWS) : 0;
    next = recordStrip(next, day, holes);
    for (const id of CHAPTERS) next = earnSeal(next, day, id);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Strip encoding

export function encodeStrip(holes: ArrayLike<number>): string {
  let s = '';
  for (let c = 0; c < STRIP_COLUMNS; c++) {
    const v = c < holes.length ? holes[c]! : 0;
    s += String.fromCharCode(v & 0x3f);
  }
  return btoa(s);
}

/** Null when `strip` is not base64 of exactly STRIP_COLUMNS bytes. */
export function decodeStrip(strip: string): Uint8Array | null {
  let raw: string;
  try {
    raw = atob(strip);
  } catch {
    return null;
  }
  if (raw.length !== STRIP_COLUMNS) return null;
  const out = new Uint8Array(STRIP_COLUMNS);
  for (let c = 0; c < STRIP_COLUMNS; c++) out[c] = raw.charCodeAt(c) & 0x3f;
  return out;
}

// ---------------------------------------------------------------------------
// State, migration and validation

export function createAlmanacState(today: DateKey): AlmanacState {
  return { version: ALMANAC_VERSION, firstDay: today, days: {}, nuxSeen: false, extra: {} };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Keeps the MAX_DAYS most recent days. */
function prune(days: Record<DateKey, DayRecord>): Record<DateKey, DayRecord> {
  const keys = Object.keys(days);
  if (keys.length <= MAX_DAYS) return days;
  keys.sort();
  const out: Record<DateKey, DayRecord> = {};
  for (const k of keys.slice(keys.length - MAX_DAYS)) out[k] = days[k]!;
  return out;
}

function sanitizeDay(day: DateKey, raw: unknown): DayRecord | null {
  if (!isObject(raw)) return null;
  const page = dailyPage(day);
  const record: DayRecord = {
    seal: isInt(raw.seal) ? raw.seal & ALL_SEAL_MASK : 0,
    moon: isInt(raw.moon) && raw.moon >= 0 && raw.moon < 8 ? raw.moon : page.moon,
    variant: isInt(raw.variant) && raw.variant >= 0 && raw.variant < 90 ? raw.variant : page.variant,
  };
  if (typeof raw.strip === 'string' && decodeStrip(raw.strip)) record.strip = raw.strip;
  if (typeof raw.print === 'string' && decodePrint(raw.print)) record.print = raw.print;
  return record;
}

/** v0 (pre-almanac M1 snapshot): `{ day, completed: ['wind', …] }`, no `version`. */
function migrateV0(raw: Record<string, unknown>, today: DateKey): Record<string, unknown> {
  const { day, completed, ...rest } = raw;
  const key = isDateKey(day) ? day : today;
  let seal = 0;
  if (Array.isArray(completed)) {
    for (const id of completed as unknown[]) if (id === 'wind' || id === 'storm' || id === 'dawn') seal |= SEAL_BIT[id];
  }
  return { ...rest, version: 1, firstDay: key, days: seal ? { [key]: { seal } } : {} };
}

/**
 * Raw parsed JSON → valid state. Never throws. Unknown versions newer than
 * this build return status 'future' (the store then refuses to overwrite).
 */
export function migrateAlmanac(raw: unknown, today: DateKey): LoadResult {
  if (!isObject(raw)) return { state: createAlmanacState(today), status: 'corrupt' };
  let status: LoadStatus = 'loaded';
  let data = raw;
  if (data.version === undefined) {
    data = migrateV0(data, today);
    status = 'migrated';
  } else if (!isInt(data.version) || data.version < 1) {
    return { state: createAlmanacState(today), status: 'corrupt' };
  } else if (data.version > ALMANAC_VERSION) {
    return { state: createAlmanacState(today), status: 'future' };
  }
  const { firstDay, days, progress, nuxSeen } = data;
  const extra: Record<string, unknown> = { ...data };
  for (const k of ['version', 'firstDay', 'days', 'progress', 'nuxSeen']) delete extra[k];
  const cleanDays: Record<DateKey, DayRecord> = {};
  let earliest: DateKey | null = null;
  if (isObject(days)) {
    for (const [k, v] of Object.entries(days)) {
      if (!isDateKey(k)) continue;
      const rec = sanitizeDay(k, v);
      if (!rec) continue;
      cleanDays[k] = rec;
      if (earliest === null || k < earliest) earliest = k;
    }
  }
  let first: DateKey = isDateKey(firstDay) ? firstDay : (earliest ?? today);
  if (earliest !== null && earliest < first) first = earliest;
  const state: AlmanacState = {
    version: ALMANAC_VERSION,
    firstDay: first,
    days: prune(cleanDays),
    nuxSeen: nuxSeen === true,
    extra,
  };
  if (isObject(progress) && isDateKey(progress.day) && typeof progress.beat === 'string' && progress.beat.length <= 32) {
    state.progress = { day: progress.day, beat: progress.beat };
  }
  return { state, status };
}

export function serializeAlmanac(state: AlmanacState): string {
  const out: Record<string, unknown> = {
    ...state.extra,
    version: ALMANAC_VERSION,
    firstDay: state.firstDay,
    days: state.days,
    nuxSeen: state.nuxSeen,
  };
  if (state.progress) out.progress = state.progress;
  return JSON.stringify(out);
}

// ---------------------------------------------------------------------------
// Store (Storage injected; every access in try/catch)

export interface AlmanacStore {
  load(today: DateKey): LoadResult;
  /**
   * Writes if `force` or ≥ SAVE_MIN_INTERVAL_MS since the last write.
   * Returns true when written. Never throws (quota, private mode). A
   * throttled state is kept as pending and written by `flush` (or the next
   * save), so the last beat edge is not lost. A clock that went backwards
   * does not block saves; a non-finite `nowMs` only writes when forced.
   */
  save(state: AlmanacState, nowMs: number, force?: boolean): boolean;
  /** Writes the pending (throttled) state once the interval has passed. No allocation when idle. */
  flush(nowMs: number): boolean;
  /** A throttled state is waiting for `flush`. */
  readonly pending: boolean;
  /** True after a 'future' load: this build must not clobber a newer save. */
  readonly readOnly: boolean;
}

export interface AlmanacStoreOptions {
  /**
   * `?day=±n` or `?demoWeek=1`: read the simulated save (falling back to the
   * real one) and write only to ALMANAC_SIM_KEY, never to ALMANAC_KEY.
   */
  simulated?: boolean;
}

export function createAlmanacStore(
  storage: AlmanacStorage | undefined,
  options: AlmanacStoreOptions = {},
): AlmanacStore {
  const writeKey = options.simulated ? ALMANAC_SIM_KEY : ALMANAC_KEY;
  let lastWriteMs = -Infinity;
  let readOnly = false;
  let pendingState: AlmanacState | null = null;
  const write = (state: AlmanacState, nowMs: number): boolean => {
    if (!storage || readOnly) return false;
    try {
      storage.setItem(writeKey, serializeAlmanac(state));
    } catch {
      return false;
    }
    pendingState = null;
    if (Number.isFinite(nowMs)) lastWriteMs = nowMs;
    return true;
  };
  /** Due once the interval passed, or when the clock went backwards. */
  const due = (nowMs: number) =>
    Number.isFinite(nowMs) && (nowMs < lastWriteMs || nowMs - lastWriteMs >= SAVE_MIN_INTERVAL_MS);
  return {
    get readOnly() {
      return readOnly;
    },
    get pending() {
      return pendingState !== null;
    },
    load(today) {
      if (!storage) return { state: createAlmanacState(today), status: 'unavailable' };
      let text: string | null;
      let fromReal = false;
      try {
        text = storage.getItem(writeKey);
        // A simulated session starts from the real save but never writes it.
        if (text === null && options.simulated) {
          text = storage.getItem(ALMANAC_KEY);
          fromReal = true;
        }
      } catch {
        return { state: createAlmanacState(today), status: 'unavailable' };
      }
      if (text === null) return { state: createAlmanacState(today), status: 'fresh' };
      const result = migrateAlmanac(safeParse(text), today);
      if (result.status === 'corrupt' && !fromReal) {
        try {
          storage.setItem(ALMANAC_CORRUPT_KEY, text);
          storage.removeItem(writeKey);
        } catch {
          // Blocked storage: the fresh state simply overwrites later.
        }
      }
      readOnly = result.status === 'future';
      return result;
    },
    save(state, nowMs, force = false) {
      if (!storage || readOnly) return false;
      if (!force && !due(nowMs)) {
        pendingState = state;
        return false;
      }
      return write(state, nowMs);
    },
    flush(nowMs) {
      if (pendingState === null || !due(nowMs)) return false;
      return write(pendingState, nowMs);
    },
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
