/**
 * Offline progress (TECH_SPEC §9). Pure and deterministic, no DOM.
 *
 * While playing, the client calls `recordSample` every frame; every `offlineSampleSec` game seconds it stores a small
 * snapshot (per hunter: life EXP, gold, kills; town: gold, storage). Rates are averaged over consecutive sample pairs in
 * the last `offlineWindowMin` game minutes. On return, `estimateOffline` projects those rates over the wall-clock time
 * away (capped at `offlineMaxHours`, × `offlineEfficiency`), and `applyOffline` writes the result into the world.
 *
 * Why an estimate and not a headless fast-forward: 12 game hours take ~17 s headless, so 8 h would block load for ~11 s.
 *
 * Growth model (`offlineGrowthModel` 1): a flat rate badly undershoots while the game accelerates (a hunter that
 * out-levels its zone moves to a harder one with more EXP per kill). So each hunter is projected on a scratch copy in
 * `offlineModelStepSec` steps: every step picks the zone the AI would (`zoneScores`), takes the combat model's kill rate
 * there (`zoneEstimate` TTK × `zoneShare`) and the zone's EXP per kill, multiplies by a per-hunter calibration
 * (measured rate / model rate at the moment of leaving, clamped to [offlineModelCalMin, offlineModelCalMax]; it carries
 * the time spent walking, in town, dead…), gains the EXP (gainExp, job tiers by unlockLevel) and re-picks. Gear, skills
 * and the town are frozen (no crafting/shop/enhancing offline), so growth from new gear is not predicted.
 *
 * Rules (the estimate never makes anyone poorer and never breaks sim invariants):
 *  - EXP goes through `gainExp` (level cap, per-level stat gains, trait points); job changes are left to the progression
 *    system on the next ticks. Reincarnation: with `town.autoReincarnate` a hunter that reaches max level reincarnates
 *    (progression.reincarnate: same rules and cap as the live system) and keeps levelling in the next step; the report
 *    keeps the EXP per life (`lives`) so `applyOffline` replays exactly the projected path. Without auto-reincarnation
 *    (or at the reincarnation cap) EXP at max level is lost, as in the live game. Reincarnated hunters are put on the
 *    Town square (live rule: reincarnation happens in Town);
 *  - hunter gold / town gold / materials stay flat-rate (gold is a net measure that spending makes noisy);
 *  - gold: net measured change per hunter and for the town, floored at 0 (offline nobody spends);
 *  - kills: added to `hunter.kills` and `stats.kills`;
 *  - materials: storage inflow rate per material, but only up to what the Trading Post would buy now
 *    (`materialDemand`: automatic + player requests; player requests are decremented like a sale). The purchase gold is
 *    already inside the town's net gold rate, so there is no second transfer;
 *  - needs: stamina/satiety/mood and HP refilled to their max (after level-ups); dead hunters revive on the next tick;
 *  - `timeMs`, `tick` and the RNG are NOT advanced (shop ages, spawn timers and determinism stay as they were).
 * A sample "epoch" is bumped on apply, so the jump never counts as measured play (no compounding across loads).
 *
 * Timers already running are not estimated: they run on wall-clock time (`advanceOfflineWallClock`). The client
 * advances them by `offlineWallClockMs` (the raw gap, not capped, not × efficiency, not gated by offlineMinAwaySec or by
 * rates) with the sim's live RNG (Simulation.runBetweenTicks) AFTER applyOffline:
 *  - journeys (TECH_SPEC §5.11, systems/journey.advanceJourneys): members away get no hunting gains or needs refill;
 *  - constructions/upgrades (TECH_SPEC §5.12, town.advanceBuildingTimers): they were paid when started, so finishing
 *    them is not an extrapolation; auto-investment does NOT start new ones offline;
 *  - hunter arrivals (systems/arrivals rules: one every arrivalIntervalSec while Town slots are free); new hunters get
 *    nothing for the rest of the gap.
 * The results go into `report.journeys` / `report.buildings` / `report.arrivals`.
 */
import type { GameConfig } from './config/types';
import { NEED_KEYS } from './config/types';
import { EventBuffer } from './events';
import { expToNext, monsterTypeStats, needMax, zoneEstimate, zoneScores } from './formulas';
import { gainExp } from './progress';
import type { SystemContext } from './system';
import { spawnHunter } from './systems/arrivals';
import { advanceJourneys, townHunterCount, type JourneyResult } from './systems/journey';
import { reincarnate } from './systems/progression';
import { advanceBuildingTimers, type BuildingCompletion } from './systems/town';
import { materialDemand } from './systems/trading';
import type { Hunter, World } from './world';

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
  /** Level at the end (in the last life when the hunter reincarnated). */
  levelAfter: number;
  /** Total EXP credited (Σ lives). */
  exp: number;
  /** EXP per life: [current life, after the 1st offline reincarnation, …]; length − 1 = reincarnations. */
  lives: number[];
  /** Reincarnations during the gap (= lives.length − 1). */
  reincarnations: number;
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
  /** Journeys that ended during the gap (filled from advanceOfflineWallClock; empty from estimateOffline). */
  journeys: JourneyResult[];
  /** Constructions/upgrades that finished during the gap (from advanceOfflineWallClock). */
  buildings: BuildingCompletion[];
  /** Ids of hunters that arrived during the gap (from advanceOfflineWallClock). */
  arrivals: string[];
}

/** What the wall-clock part of the offline step did (merged into the report by the caller). */
export interface WallClockResult {
  journeys: JourneyResult[];
  buildings: BuildingCompletion[];
  arrivals: string[];
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
    // Journey rewards are one-off windfalls, not a rate: keep them out of the measured town gold (TECH_SPEC §5.11).
    townGold: world.town.gold - (world.stats.journeyGold ?? 0),
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

/**
 * Wall-clock ms the timers (journeys, constructions, arrivals) advance by while away: the raw gap (0 for unknown save
 * time or a clock that went back).
 */
export function offlineWallClockMs(savedAt: number, now: number): number {
  if (!Number.isFinite(savedAt) || savedAt <= 0 || !Number.isFinite(now)) return 0;
  return Math.max(0, now - savedAt);
}

/** @deprecated name kept for callers from before buildings/arrivals: same as offlineWallClockMs. */
export const offlineJourneyMs = offlineWallClockMs;

function emptyReport(gap: Pick<OfflineReport, 'awayMs' | 'creditedMs' | 'capped' | 'skipped'>): OfflineReport {
  return { ...gap, hunters: [], townGold: 0, gold: 0, kills: 0, materials: {}, journeys: [], buildings: [], arrivals: [] };
}

/** Zone the AI would pick for `h` (max zoneScores fit; crowding from the hunt goals in `view`), null if none fits. */
function modelZone(config: GameConfig, view: World, h: Hunter): string | null {
  let best: ReturnType<typeof zoneScores>[number] | null = null;
  for (const s of zoneScores(config, view, h)) if (s.fit > 0 && (!best || s.fit > best.fit)) best = s;
  return best ? best.zone.id : null;
}

/**
 * Model kill / EXP rates (per ms, uncalibrated) of every hunting hunter in `view` (goal `hunt`). Per zone, the respawn
 * supply (1 monster / respawnSec, as in formulas.zoneShare) is split in proportion to each hunter's own kill speed
 * v = offlineHuntDuty / TTK (stronger hunters take more of the shared spawns), never above v:
 *   kills_i = v_i × min(1, 1 / (respawnSec × Σ_zone v_j));   EXP_i = kills_i × spawn-weighted monster EXP.
 * The duty matters because the per-hunter calibration cannot see it in a respawn-limited zone (the pool refills while
 * a hunter is in town, so the others kill more): without it a hunter moving to an uncrowded zone is overestimated.
 */
export function modelRates(config: GameConfig, view: World): Map<string, { killsPerMs: number; expPerMs: number; zoneId: string }> {
  const diff = view.town.difficulty;
  const speed = new Map<string, number>();
  const zoneSpeed: Record<string, number> = {};
  for (const h of view.hunters) {
    const g = h.ai.goal;
    if (g?.type !== 'hunt') continue;
    const zone = config.index.zones.get(g.zoneId);
    if (!zone) continue;
    const est = zoneEstimate(config, h, zone, diff);
    if (!(est.ttk > 0) || !Number.isFinite(est.ttk)) continue;
    // Time per kill = TTK + one trip to Town to heal per HP bar (killsPerLife kills), × 1 / offlineHuntDuty for the
    // rest (needs, selling, walking between monsters). A hunter that just moved to a hard zone heals often.
    const trip = est.killsPerLife > 0 && Number.isFinite(est.killsPerLife) ? config.formula.offlineTripSec / est.killsPerLife : 0;
    const v = config.formula.offlineHuntDuty / (est.ttk + trip);
    speed.set(h.id, v);
    zoneSpeed[zone.id] = (zoneSpeed[zone.id] ?? 0) + v;
  }
  const out = new Map<string, { killsPerMs: number; expPerMs: number; zoneId: string }>();
  for (const h of view.hunters) {
    const v = speed.get(h.id);
    if (v === undefined || h.ai.goal?.type !== 'hunt') continue;
    const zone = config.index.zones.get(h.ai.goal.zoneId)!;
    const kps = v * Math.min(1, 1 / (zone.respawnSec * zoneSpeed[zone.id]!));
    let w = 0, exp = 0;
    for (const e of zone.monsters) {
      w += e.weight;
      exp += e.weight * monsterTypeStats(config, e.monsterId, diff).exp;
    }
    if (!(w > 0)) continue;
    out.set(h.id, { killsPerMs: kps / 1000, expPerMs: (kps * exp) / w / 1000, zoneId: zone.id });
  }
  return out;
}

const clampCal = (x: number, f: GameConfig['formula']) => Math.min(f.offlineModelCalMax, Math.max(f.offlineModelCalMin, x));

/** Highest job tier the hunter's level unlocks (the progression system advances one tier per tick to the same end). */
function settleJob(config: GameConfig, h: Hunter): void {
  const jobs = config.index.jobsByClass.get(h.classId);
  for (;;) {
    const next = jobs?.find((j) => j.tier === h.jobTier + 1);
    if (!next || h.level < next.unlockLevel) return;
    h.jobTier = next.tier;
  }
}

/** Whether the live progression rules would reincarnate this hunter at max level (ignoring position). */
function canAutoReincarnate(config: GameConfig, world: World, h: Hunter): boolean {
  const f = config.formula;
  return !!world.town.autoReincarnate && h.level >= f.maxLevel && h.reincarnation < f.maxReincarnation;
}

interface Projection { lives: number[]; kills: number; level: number }

/**
 * Project the hunters with trusted rates (`rated`) over `tMs` of credited time on scratch copies (the world is not
 * touched), all together so zone crowding follows them: every step each rated hunter re-picks its zone (modelZone,
 * others where they were last step; hunters without rates stay on their current goal), then gains
 * calibration × model rate. Flat measured rates when the growth model is off or a hunter has no model zone.
 */
function projectHunters(config: GameConfig, world: World, rated: Record<string, HunterRates>, tMs: number): Map<string, Projection> {
  const f = config.formula;
  const growth = f.offlineGrowthModel > 0;
  const clones = world.hunters.map((h) => JSON.parse(JSON.stringify(h)) as Hunter);
  // zoneScores reads world.hunters (crowding) and town.difficulty; gainExp/reincarnate read config, world.tick/stats
  // and events. Scratch objects keep the real world untouched.
  const view = { ...world, hunters: clones } as World;
  const stub = { config, world: { tick: world.tick, stats: { reincarnations: 0 } }, events: new EventBuffer() } as unknown as SystemContext;
  const active = clones.filter((c) => rated[c.id]);
  const assign = () => {
    for (const c of active) {
      const z = modelZone(config, view, c);
      c.ai.goal = z ? { type: 'hunt', zoneId: z } : null;
    }
  };
  const st = new Map(active.map((c) => [c.id, { lives: [0], kills: 0, expAcc: 0, given: 0, calK: null as number | null, calE: null as number | null }]));
  if (growth) {
    assign();
    const m0 = modelRates(config, view);
    for (const c of active) {
      const r = rated[c.id]!;
      const m = m0.get(c.id);
      const s = st.get(c.id)!;
      s.calK = m && m.killsPerMs > 0 ? clampCal(r.killsPerMs / m.killsPerMs, f) : null;
      // At max level the EXP rate is not measurable (capped): fall back on the kill calibration.
      s.calE = m && m.expPerMs > 0 && c.level < f.maxLevel ? clampCal(r.expPerMs / m.expPerMs, f) : s.calK;
    }
  }
  const step = Math.max(1, f.offlineModelStepSec * 1000);
  for (let left = tMs; left > 0; left -= step) {
    const dt = Math.min(step, left);
    for (const c of active) {
      if (!canAutoReincarnate(config, world, c)) continue;
      reincarnate(stub, c);
      const s = st.get(c.id)!;
      s.lives.push(0);
      s.expAcc = s.given = 0;
    }
    let m: ReturnType<typeof modelRates> | null = null;
    if (growth) {
      assign();
      m = modelRates(config, view);
    }
    for (const c of active) {
      const r = rated[c.id]!;
      const s = st.get(c.id)!;
      const mr = m?.get(c.id);
      // A flat EXP rate measured in another life would be meaningless after a reincarnation: no model → no EXP.
      const eRate = s.calE !== null && mr ? s.calE * mr.expPerMs : s.lives.length > 1 ? 0 : r.expPerMs;
      const kRate = s.calK !== null && mr ? s.calK * mr.killsPerMs : r.killsPerMs;
      s.kills += kRate * dt;
      if (c.level >= f.maxLevel) continue; // EXP at the cap is lost (as in gainExp)
      s.expAcc += eRate * dt;
      const add = Math.floor(s.expAcc) - s.given;
      if (add <= 0) continue;
      s.given += add;
      s.lives[s.lives.length - 1]! += add;
      gainExp(stub, c, add);
      settleJob(config, c);
    }
  }
  const out = new Map<string, Projection>();
  for (const c of active) {
    const s = st.get(c.id)!;
    out.set(c.id, { lives: s.lives, kills: Math.floor(s.kills), level: c.level });
  }
  return out;
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

  const rated: Record<string, HunterRates> = {};
  for (const h of world.hunters) {
    const r = rates.hunters[h.id];
    if (r && r.windowMs >= minMs && r.windowMs > 0) rated[h.id] = r;
  }
  const proj = projectHunters(config, world, rated, t);
  for (const h of world.hunters) {
    const r = rated[h.id];
    const p = proj.get(h.id);
    if (!r || !p) continue;
    const exp = p.lives.reduce((a, n) => a + n, 0);
    const gold = Math.max(0, Math.floor(r.goldPerMs * t));
    const kills = Math.max(0, p.kills);
    if (exp === 0 && gold === 0 && kills === 0 && p.lives.length === 1) continue;
    report.hunters.push({
      id: h.id, levelBefore: h.level, levelAfter: p.level, exp, lives: p.lives, reincarnations: p.lives.length - 1, gold, kills,
    });
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
    // Replay the projected path: EXP of this life, then per offline reincarnation reincarnate + that life's EXP.
    const lives = g.lives ?? [g.exp];
    for (let i = 0; i < lives.length; i++) {
      if (i > 0 && !reincarnateOffline(ctx, h)) break;
      if (lives[i]! > 0) gainExp(ctx, h, lives[i]!);
    }
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

/** progression.reincarnate (same rules/cap) plus the Town position the live rule implies. False if it was refused. */
function reincarnateOffline(ctx: SystemContext, h: Hunter): boolean {
  if (!canAutoReincarnate(ctx.config, ctx.world, h) || reincarnate(ctx, h) !== null) return false;
  const sq = ctx.config.index.nodes.get(ctx.config.index.squareNode);
  if (sq) {
    h.position = { x: sq.x, y: sq.y };
    h.nodeId = sq.id;
  }
  h.insideBuildingId = null;
  h.attackCdMs = 0;
  return true;
}

/**
 * Wall-clock part of the offline step (see the file header): advance journeys, constructions/upgrades and hunter
 * arrivals by `ms` (the raw gap, offlineWallClockMs). Needs a full sim context (journeys/arrivals draw the sim RNG):
 * call through Simulation.runBetweenTicks, after applyOffline. Journeys first, so a returning team keeps its slot.
 */
export function advanceOfflineWallClock(ctx: SystemContext, ms: number): WallClockResult {
  const out: WallClockResult = { journeys: [], buildings: [], arrivals: [] };
  if (!(ms > 0)) return out;
  out.journeys = advanceJourneys(ctx, ms, true);
  out.buildings = advanceBuildingTimers(ctx, ms);
  // systems/arrivals: the timer runs only while Town slots are free (journey members keep theirs) and resets when full.
  const { world, config } = ctx;
  const interval = config.formula.arrivalIntervalSec * 1000;
  const free = config.formula.hunterSlots - townHunterCount(world);
  if (free <= 0) {
    world.town.arrivalTimerMs = 0;
    return out;
  }
  let timer = world.town.arrivalTimerMs + ms;
  const n = interval > 0 ? Math.min(free, Math.floor(timer / interval)) : free;
  for (let i = 0; i < n; i++) out.arrivals.push(spawnHunter(ctx).id);
  timer -= n * interval;
  world.town.arrivalTimerMs = townHunterCount(world) >= config.formula.hunterSlots ? 0 : Math.max(0, timer);
  return out;
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
