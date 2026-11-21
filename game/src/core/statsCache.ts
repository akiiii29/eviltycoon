/**
 * Self-validating memo for formulas.hunterStats (TECH_SPEC §10). Derived data only: never stored in World or saves.
 *
 * Each hunter object keeps one entry per mode (steady / live) holding a snapshot of every input hunterStats reads:
 * config + formula identity, every `h.stats` field, classId, jobTier, reincarnation, level, each gear slot's
 * gearId/qualityId/enhance/difficultyId/option lines (id + value; set bonuses follow from the gearIds), trait levels, and for live stats also each buff's stat/value and `needs.mood`.
 * A call compares the snapshot with the hunter's current values (by value, so in-place mutation is caught) and
 * recomputes on any difference. No tick/id key: state that changes mid-tick (level-up, a new buff, mood decay,
 * equipping) simply misses, so results are identical to computing every time.
 *
 * Results are frozen and shared between callers; mutating one throws.
 *
 * If hunterStats ever reads a new hunter field, add it to `matches`/`capture` below. `setStatsCacheVerify(true)`
 * (or env TH_VERIFY_CACHES=1) recomputes on every hit and throws on a mismatch, to prove that.
 */
import { GEAR_SLOTS, type GameConfig } from './config/types';
import type { Hunter } from './world';

type Stats = Record<string, number>;

interface Entry {
  config: GameConfig;
  formula: GameConfig['formula'];
  out: Readonly<Stats>;
  statKeys: string[];
  statVals: number[];
  classId: string;
  jobTier: number;
  reincarnation: number;
  level: number;
  /**
   * Per GEAR_SLOTS slot: gearId, qualityId, enhance, difficultyId (gear tier), option-line count, then id/value per line
   * (v13; set bonuses derive from the gearIds). An empty slot is 5 nulls.
   */
  gear: (string | number | null)[];
  traitKeys: string[];
  traitVals: number[];
  /** Live only: stat, value pairs in buff order. */
  buffs: (string | number)[];
  mood: number;
}

interface Slots {
  steady?: Entry;
  live?: Entry;
}

const cache = new WeakMap<Hunter, Slots>();

let verify = (() => {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    return env?.TH_VERIFY_CACHES === '1';
  } catch {
    return false;
  }
})();

/** Debug/test switch: when on, every cache hit is recomputed and compared (throws on mismatch). */
export function setStatsCacheVerify(on: boolean): void {
  verify = on;
}

export function cacheVerifyEnabled(): boolean {
  return verify;
}

function matches(e: Entry, config: GameConfig, h: Hunter, steady: boolean): boolean {
  if (e.config !== config || e.formula !== config.formula) return false;
  if (e.classId !== h.classId || e.jobTier !== h.jobTier || e.reincarnation !== h.reincarnation || e.level !== h.level) return false;
  const s = h.stats as unknown as Stats;
  let i = 0;
  for (const k in s) {
    if (e.statKeys[i] !== k || !Object.is(e.statVals[i], s[k])) return false;
    i++;
  }
  if (i !== e.statKeys.length) return false;
  let j = 0;
  for (const slot of GEAR_SLOTS) {
    const g = h.equipment[slot];
    if (!g) {
      if (e.gear[j] !== null) return false;
      j += 5;
      continue;
    }
    if (e.gear[j] !== g.gearId || e.gear[j + 1] !== g.qualityId || e.gear[j + 2] !== g.enhance || e.gear[j + 3] !== (g.difficultyId ?? null)) return false;
    // v13 option lines (TECH_SPEC §4.2): count, then id/value pairs.
    const opts = g.options;
    const n = opts ? opts.length : 0;
    if (e.gear[j + 4] !== n) return false;
    j += 5;
    for (let k = 0; k < n; k++) {
      if (e.gear[j] !== opts![k]!.id || !Object.is(e.gear[j + 1], opts![k]!.value)) return false;
      j += 2;
    }
  }
  if (j !== e.gear.length) return false;
  i = 0;
  for (const k in h.traits) {
    if (e.traitKeys[i] !== k || !Object.is(e.traitVals[i], h.traits[k])) return false;
    i++;
  }
  if (i !== e.traitKeys.length) return false;
  if (!steady) {
    if (!Object.is(e.mood, h.needs.mood)) return false;
    const b = h.buffs;
    if (b.length * 2 !== e.buffs.length) return false;
    for (let n = 0; n < b.length; n++) {
      if (e.buffs[2 * n] !== b[n]!.stat || !Object.is(e.buffs[2 * n + 1], b[n]!.value)) return false;
    }
  }
  return true;
}

function capture(config: GameConfig, h: Hunter, steady: boolean, out: Readonly<Stats>): Entry {
  const s = h.stats as unknown as Stats;
  const statKeys: string[] = [];
  const statVals: number[] = [];
  for (const k in s) { statKeys.push(k); statVals.push(s[k]!); }
  const gear: (string | number | null)[] = [];
  for (const slot of GEAR_SLOTS) {
    const g = h.equipment[slot];
    if (g) {
      const opts = g.options ?? [];
      gear.push(g.gearId, g.qualityId, g.enhance, g.difficultyId ?? null, opts.length);
      for (const o of opts) gear.push(o.id, o.value);
    } else gear.push(null, null, null, null, null);
  }
  const traitKeys: string[] = [];
  const traitVals: number[] = [];
  for (const k in h.traits) { traitKeys.push(k); traitVals.push(h.traits[k]!); }
  const buffs: (string | number)[] = [];
  if (!steady) for (const b of h.buffs) buffs.push(b.stat, b.value);
  return {
    config, formula: config.formula, out, statKeys, statVals, classId: h.classId, jobTier: h.jobTier,
    reincarnation: h.reincarnation, level: h.level, gear, traitKeys, traitVals, buffs, mood: steady ? 0 : h.needs.mood,
  };
}

function sameStats(a: Readonly<Stats>, b: Readonly<Stats>): boolean {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i] || !Object.is(a[ka[i]!], b[kb[i]!])) return false;
  return true;
}

/** Memoised `compute(config, h, steady)`; see the module comment for when it recomputes. */
export function memoHunterStats<T extends object>(config: GameConfig, h: Hunter, steady: boolean, compute: () => T): Readonly<T> {
  let slots = cache.get(h);
  if (!slots) { slots = {}; cache.set(h, slots); }
  const e = steady ? slots.steady : slots.live;
  if (e && matches(e, config, h, steady)) {
    if (verify && !sameStats(e.out, compute() as unknown as Stats)) {
      throw new Error(`statsCache: stale hunterStats for ${h.id} (${steady ? 'steady' : 'live'}): an input is missing from the snapshot`);
    }
    return e.out as unknown as Readonly<T>;
  }
  const out = Object.freeze(compute()) as unknown as Readonly<Stats>;
  const entry = capture(config, h, steady, out);
  if (steady) slots.steady = entry;
  else slots.live = entry;
  return out as unknown as Readonly<T>;
}
