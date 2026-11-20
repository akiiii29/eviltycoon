/**
 * Offline progress (TECH_SPEC §9). Pure and deterministic, no DOM.
 *
 * While playing, the client calls `recordSample` every frame; every `offlineSampleSec` game seconds it stores a small
 * snapshot (per hunter: life EXP, gold, kills; town: gold, storage). Rates are averaged over consecutive sample pairs in
 * the last `offlineWindowMin` game minutes. On return, `estimateOffline` multiplies those rates by the wall-clock time
 * away (capped at `offlineMaxHours`, × `offlineEfficiency`), and `applyOffline` writes the result into the world.
 *
 * Why an estimate and not a headless fast-forward: 12 game hours take ~17 s headless, so 8 h would block load for ~11 s.
 *
 * Rules (the estimate never makes anyone poorer and never breaks sim invariants):
 *  - EXP goes through `gainExp` (level cap, per-level stat gains, trait points); job changes and reincarnation are left to
 *    the progression system on the next ticks (no offline reincarnation, EXP at max level is lost);
 *  - gold: net measured change per hunter and for the town, floored at 0 (offline nobody spends);
 *  - kills: added to `hunter.kills` and `stats.kills`;
 *  - materials: storage inflow rate per material, but only up to what the Trading Post would buy now
 *    (`materialDemand`: automatic + player requests; player requests are decremented like a sale). The purchase gold is
 *    already inside the town's net gold rate, so there is no second transfer;
 *  - needs: stamina/satiety/mood and HP refilled to their max (after level-ups); dead hunters revive on the next tick;
 *  - `timeMs`, `tick` and the RNG are NOT advanced (shop ages, spawn timers and determinism stay as they were).
 * A sample "epoch" is bumped on apply, so the jump never counts as measured play (no compounding across loads).
 */
import type { GameConfig } from './config/types';
import { NEED_KEYS } from './config/types';
import { EventBuffer } from './events';
import { expToNext, needMax } from './formulas';
import { gainExp } from './progress';
import type { SystemContext } from './system';
import { materialDemand } from './systems/trading';
import type { World } from './world';

export interface HunterSample {
  id: string;
  reincarnation: number;
  level: number;
  /** EXP since the start of the current life (sum of expToNext below `level` + exp). */
  lifeExp: number;
  gold: number;
  kills: number;
}

export interface RateSample {
  /** world.timeMs of the sample (game time). */
  timeMs: number;
  /** Pairs from different epochs are never compared (an offline apply happened in between). */
  epoch: number;
  townGold: number;
  storage: Record<string, number>;
  hunters: HunterSample[];
}

/** Persisted in the save envelope (not in World), so no schema bump. */
export interface OfflineTracker {
  seed: number;
  epoch: number;
  samples: RateSample[];
}

export interface HunterRates {
  /** Measured game ms the rates are averaged over. */
  windowMs: number;
  expPerMs: number;
  goldPerMs: number;
  killsPerMs: number;
}

export interface Rates {
  hunters: Record<string, HunterRates>;
  town: { windowMs: number; goldPerMs: number; materialsPerMs: Record<string, number> };
}

export interface HunterOfflineGain {
  id: string;
  levelBefore: number;
  levelAfter: number;
  exp: number;
  gold: number;
  kills: number;
}

export interface OfflineReport {
  /** Raw wall-clock gap (after guards: 0 when negative/unknown). */
  awayMs: number;
  /** Time actually credited (≤ offlineMaxHours). */
  creditedMs: number;
  capped: boolean;
  /** Why nothing was credited, if so. */
  skipped: null | 'clockBackwards' | 'unknownSaveTime' | 'tooShort' | 'noRates';
  hunters: HunterOfflineGain[];
  townGold: number;
  /** Gold total: town + all hunters. */
  gold: number;
  kills: number;
  materials: Record<string, number>;
}

export function newTracker(seed: number): OfflineTracker {
  return { seed, epoch: 0, samples: [] };
}

function lifeExp(config: GameConfig, level: number, exp: number): number {
  let n = exp;
  for (let l = 1; l < level; l++) n += expToNext(l, config.formula);
  return n;
}

export function takeSample(config: GameConfig, world: World, epoch: number): RateSample {
  return {
    timeMs: world.timeMs,
    epoch,
    townGold: world.town.gold,
    storage: { ...world.town.storage },
    hunters: world.hunters.map((h) => ({
      id: h.id,
      reincarnation: h.reincarnation,
      level: h.level,
      lifeExp: lifeExp(config, h.level, h.exp),
      gold: h.gold,
      kills: h.kills,
    })),
  };
}

/**
 * Take a sample if `offlineSampleSec` game seconds passed since the last one, then drop samples older than the window.
 * Returns the tracker to keep (a new one when the world was replaced: other seed or time went backwards).
 */
export function recordSample(config: GameConfig, world: World, tracker: OfflineTracker | null): OfflineTracker {
  let t = tracker;
  const last = t?.samples[t.samples.length - 1];
  if (!t || t.seed !== world.seed || (last && world.timeMs < last.timeMs)) t = newTracker(world.seed);
  const f = config.formula;
  const lastNow = t.samples[t.samples.length - 1];
  if (lastNow && world.timeMs - lastNow.timeMs < f.offlineSampleSec * 1000) return t;
  t.samples.push(takeSample(config, world, t.epoch));
  const oldest = world.timeMs - f.offlineWindowMin * 60_000;
  while (t.samples.length > 2 && t.samples[0]!.timeMs < oldest) t.samples.shift();
  return t;
}

/** Average rates over consecutive same-epoch sample pairs (per hunter: only pairs in the same life). */
export function measureRates(tracker: OfflineTracker | null): Rates {
  const hunters: Record<string, { ms: number; exp: number; gold: number; kills: number }> = {};
  const town = { ms: 0, gold: 0, mats: {} as Record<string, number> };
  const s = tracker?.samples ?? [];
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1]!;
    const b = s[i]!;
    const dt = b.timeMs - a.timeMs;
    if (a.epoch !== b.epoch || !(dt > 0)) continue;
    town.ms += dt;
    town.gold += b.townGold - a.townGold;
    for (const id in b.storage) {
      const d = (b.storage[id] ?? 0) - (a.storage[id] ?? 0);
      if (d > 0) town.mats[id] = (town.mats[id] ?? 0) + d;
    }
    for (const hb of b.hunters) {
      const ha = a.hunters.find((x) => x.id === hb.id);
      if (!ha || ha.reincarnation !== hb.reincarnation) continue;
      const acc = (hunters[hb.id] ??= { ms: 0, exp: 0, gold: 0, kills: 0 });
      acc.ms += dt;
      acc.exp += Math.max(0, hb.lifeExp - ha.lifeExp);
      acc.gold += hb.gold - ha.gold;
      acc.kills += Math.max(0, hb.kills - ha.kills);
    }
  }
  const out: Rates = { hunters: {}, town: { windowMs: town.ms, goldPerMs: 0, materialsPerMs: {} } };
  for (const id of Object.keys(hunters).sort()) {
    const h = hunters[id]!;
    out.hunters[id] = { windowMs: h.ms, expPerMs: h.exp / h.ms, goldPerMs: h.gold / h.ms, killsPerMs: h.kills / h.ms };
  }
  if (town.ms > 0) {
    out.town.goldPerMs = town.gold / town.ms;
    for (const id of Object.keys(town.mats).sort()) out.town.materialsPerMs[id] = town.mats[id]! / town.ms;
  }
  return out;
}

/**
 * Wall-clock time away with guards: unknown save time (≤ 0 / non-finite, e.g. old saves) and clocks that went
 * backwards credit nothing; gaps are capped at offlineMaxHours.
 */
export function offlineGap(config: GameConfig, savedAt: number, now: number): Pick<OfflineReport, 'awayMs' | 'creditedMs' | 'capped' | 'skipped'> {
  const f = config.formula;
  if (!Number.isFinite(savedAt) || savedAt <= 0 || !Number.isFinite(now)) {
    return { awayMs: 0, creditedMs: 0, capped: false, skipped: 'unknownSaveTime' };
  }
  const away = now - savedAt;
  if (away < 0) return { awayMs: 0, creditedMs: 0, capped: false, skipped: 'clockBackwards' };
  if (away < f.offlineMinAwaySec * 1000) return { awayMs: away, creditedMs: 0, capped: false, skipped: 'tooShort' };
  const cap = Math.max(0, f.offlineMaxHours) * 3_600_000;
  return { awayMs: away, creditedMs: Math.min(away, cap), capped: away > cap, skipped: null };
}

function emptyReport(gap: Pick<OfflineReport, 'awayMs' | 'creditedMs' | 'capped' | 'skipped'>): OfflineReport {
  return { ...gap, hunters: [], townGold: 0, gold: 0, kills: 0, materials: {} };
}

/** Level a hunter would reach from `level`/`exp` with `add` more EXP (same rules as gainExp). */
function levelAfter(config: GameConfig, level: number, exp: number, add: number): number {
  const f = config.formula;
  let lv = level;
  let e = exp + add;
  while (lv < f.maxLevel && e >= expToNext(lv, f)) {
    e -= expToNext(lv, f);
    lv += 1;
  }
  return lv;
}

/** Estimate (without changing the world) what happened during `creditedMs` of the gap. */
export function estimateOffline(
  config: GameConfig,
  world: World,
  tracker: OfflineTracker | null,
  savedAt: number,
  now: number,
): OfflineReport {
  const gap = offlineGap(config, savedAt, now);
  const report = emptyReport(gap);
  if (gap.skipped) return report;
  const f = config.formula;
  const rates = measureRates(tracker && tracker.seed === world.seed ? tracker : null);
  const minMs = f.offlineMinWindowSec * 1000;
  const t = gap.creditedMs * Math.max(0, f.offlineEfficiency);

  for (const h of world.hunters) {
    const r = rates.hunters[h.id];
    if (!r || r.windowMs < minMs || r.windowMs <= 0) continue;
    const exp = h.level >= f.maxLevel ? 0 : Math.floor(r.expPerMs * t);
    const gold = Math.max(0, Math.floor(r.goldPerMs * t));
    const kills = Math.max(0, Math.floor(r.killsPerMs * t));
    if (exp === 0 && gold === 0 && kills === 0) continue;
    report.hunters.push({ id: h.id, levelBefore: h.level, levelAfter: levelAfter(config, h.level, h.exp, exp), exp, gold, kills });
  }

  if (rates.town.windowMs >= minMs && rates.town.windowMs > 0) {
    report.townGold = Math.max(0, Math.floor(rates.town.goldPerMs * t));
    const demand = materialDemand(config, world);
    for (const id of Object.keys(rates.town.materialsPerMs).sort()) {
      const n = Math.min(Math.floor(rates.town.materialsPerMs[id]! * t), demand[id] ?? 0);
      if (n > 0) report.materials[id] = n;
    }
  }

  report.kills = report.hunters.reduce((a, h) => a + h.kills, 0);
  report.gold = report.townGold + report.hunters.reduce((a, h) => a + h.gold, 0);
  const any = report.hunters.length > 0 || report.townGold > 0 || Object.keys(report.materials).length > 0;
  if (!any) report.skipped = 'noRates';
  return report;
}

/**
 * Write an estimate into the world (mutates `world`) and bump the tracker epoch. A skipped report changes nothing.
 * Level-ups go through gainExp; their events go to `events` when given (else a throwaway buffer).
 */
export function applyOffline(
  config: GameConfig,
  world: World,
  report: OfflineReport,
  tracker: OfflineTracker | null,
  events: EventBuffer = new EventBuffer(),
): void {
  if (report.skipped) return;
  // gainExp only reads config/world/events from the context.
  const ctx = { world, config, events } as unknown as SystemContext;
  for (const g of report.hunters) {
    const h = world.hunters.find((x) => x.id === g.id);
    if (!h) continue;
    if (g.exp > 0) gainExp(ctx, h, g.exp);
    h.gold += g.gold;
    h.kills += g.kills;
    world.stats.kills += g.kills;
  }
  world.town.gold += report.townGold;
  const requests = world.town.requests ?? (world.town.requests = {});
  for (const id of Object.keys(report.materials).sort()) {
    const n = report.materials[id]!;
    world.town.storage[id] = (world.town.storage[id] ?? 0) + n;
    world.stats.materialsSold += n;
    if (requests[id] !== undefined) {
      const left = requests[id]! - n;
      if (left > 0) requests[id] = left;
      else delete requests[id];
    }
  }
  // Rested while away: refill needs (HP after level-ups); the dead revive on the next tick (combat.revive).
  for (const h of world.hunters) {
    h.buffs = [];
    if (h.deadMs > 0) {
      h.deadMs = Math.min(h.deadMs, 1);
      continue;
    }
    for (const n of NEED_KEYS) h.needs[n] = needMax(config, h, n);
  }
  if (tracker) tracker.epoch += 1;
}

/** Validate a tracker read from a save envelope; anything malformed becomes null (= no rates). */
export function parseTracker(raw: unknown): OfflineTracker | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Partial<OfflineTracker>;
  if (typeof o.seed !== 'number' || typeof o.epoch !== 'number' || !Array.isArray(o.samples)) return null;
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  for (const s of o.samples as unknown[]) {
    const x = s as Partial<RateSample>;
    if (!x || !num(x.timeMs) || !num(x.epoch) || !num(x.townGold) || typeof x.storage !== 'object' || x.storage === null || !Array.isArray(x.hunters)) return null;
    for (const h of x.hunters as Partial<HunterSample>[]) {
      if (!h || typeof h.id !== 'string' || !num(h.reincarnation) || !num(h.level) || !num(h.lifeExp) || !num(h.gold) || !num(h.kills)) return null;
    }
  }
  return o as OfflineTracker;
}
