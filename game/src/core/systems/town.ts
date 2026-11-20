/**
 * Town buildings (GDD §5, TECH_SPEC §5.11): Town Hall, building levels, plots, construction/upgrade, auto-investment.
 *
 * - `config.buildings` are building TYPES with per-level arrays (index i = level i + 1); `config.plots` are fixed map spots,
 *   each with its own door node. `world.town.buildings` holds what stands on which plot (id = plot id) and its level.
 *   At most one instance per type, so the rest of the sim keeps addressing a building by its type id.
 * - A plot's door is a destination only once a building of level ≥ 1 stands there (no nav-graph edits at runtime).
 * - The Town Hall level caps every other building's level and unlocks plots (`plot.townHallLevel`) and types
 *   (`requires.townHallLevel`).
 * - Build/upgrade pays gold (× buildCostMul) and Town Storage materials up front; both LEAVE the economy. The building keeps
 *   working at its old level until the upgrade finishes (sec × buildTimeMul).
 * - Auto-investment (`town.autoInvest`, default on): every townInvestIntervalSec, pick the next step (see `chooseInvestment`),
 *   store it as `town.investPlan` (the Trading Post requests its materials, systems/trading.ts) and start it once affordable.
 * Deterministic: no RNG, config/plot order everywhere, timers in the world.
 */
import type { BuildingDef, GameConfig, GearDef } from '../config/types';
import type { System, SystemContext } from '../system';
import type { BuildingState, InvestPlan, World } from '../world';
import { autoCraftReserve } from './crafting';
import { townGoldTarget } from './trading';

/** Value of a per-level list at `level` (clamped to the list; undefined below level 1 or for a missing list). */
export function levelValue<T>(list: readonly T[] | undefined, level: number): T | undefined {
  if (!list || list.length === 0 || level < 1) return undefined;
  return list[Math.min(level, list.length) - 1];
}

/** The building of this type standing in town (under construction included), or undefined. */
export function buildingState(world: World, buildingId: string): BuildingState | undefined {
  return (world.town.buildings ?? []).find((s) => s.buildingId === buildingId);
}

/** Working level of a building type: 0 when not built or still under its first construction. */
export function buildingLevel(world: World, buildingId: string): number {
  return buildingState(world, buildingId)?.level ?? 0;
}

export function townHallLevel(config: GameConfig, world: World): number {
  return buildingLevel(world, config.index.townHall);
}

/** Door node of a working building (level ≥ 1), else null: unbuilt plots are never a destination. */
export function buildingDoor(config: GameConfig, world: World, buildingId: string): string | null {
  const s = buildingState(world, buildingId);
  if (!s || s.level < 1) return null;
  return config.index.plots.get(s.id)?.doorNode ?? null;
}

// ---- Per-level effects (TECH_SPEC §5.11). A missing/unbuilt building gives the "off" value. ----

/** service: points restored per second inside. */
export function serviceRestorePerSec(world: World, b: BuildingDef): number {
  return levelValue(b.restorePerSec, Math.max(1, buildingLevel(world, b.id))) ?? 0;
}

/** shop: max items on sale (0 when the shop is not built). */
export function shopCapacity(config: GameConfig, world: World): number {
  const b = config.index.buildings.get(config.index.shop);
  return levelValue(b?.capacity, buildingLevel(world, config.index.shop)) ?? 0;
}

/** craft: highest gear.level the building can make at its current level (0 = cannot craft). */
export function craftMaxGearLevel(config: GameConfig, world: World, buildingId: string): number {
  return levelValue(config.index.buildings.get(buildingId)?.maxGearLevel, buildingLevel(world, buildingId)) ?? 0;
}

/** True when the gear's craft building currently allows its tier. */
export function gearCraftable(config: GameConfig, world: World, gear: GearDef): boolean {
  return gear.level <= craftMaxGearLevel(config, world, gear.craftBuilding);
}

/** forge: added to every enhance successRate. */
export function enhanceBonus(config: GameConfig, world: World): number {
  return levelValue(config.index.buildings.get(config.index.forge)?.enhanceBonus, buildingLevel(world, config.index.forge)) ?? 0;
}

/** academy: multiplier on skill study gold. */
export function studyGoldMul(config: GameConfig, world: World): number {
  return levelValue(config.index.buildings.get(config.index.academy)?.studyGoldMul, buildingLevel(world, config.index.academy)) ?? 1;
}

/** trading post: multiplier on tradeSurplusPriceFrac. */
export function surplusPriceMul(config: GameConfig, world: World): number {
  return levelValue(config.index.buildings.get(config.index.tradingPost)?.surplusPriceMul, buildingLevel(world, config.index.tradingPost)) ?? 1;
}

/** storehouse(s): extra copies kept by the automatic material requests. */
export function extraRequestCopies(config: GameConfig, world: World): number {
  let n = 0;
  for (const b of config.buildings) if (b.kind === 'storehouse') n += levelValue(b.requestCopies, buildingLevel(world, b.id)) ?? 0;
  return n;
}

// ---- Costs and validation ----

export interface LevelCost {
  gold: number;
  materials: Record<string, number>;
  ms: number;
}

/** Cost to reach `toLevel` (1 = build): upgradeCost[toLevel − 1], gold × buildCostMul, time × buildTimeMul. */
export function levelCost(config: GameConfig, b: BuildingDef, toLevel: number): LevelCost | null {
  const row = b.upgradeCost[toLevel - 1];
  if (!row) return null;
  const f = config.formula;
  const materials: Record<string, number> = {};
  for (const m of row.materials) materials[m.materialId] = (materials[m.materialId] ?? 0) + m.count;
  return {
    gold: Math.round(row.gold * (f.buildCostMul ?? 1)),
    materials,
    ms: Math.max(0, Math.round(row.sec * (f.buildTimeMul ?? 1) * 1000)),
  };
}

/** Material units still missing from Town Storage for this cost. */
export function missingMaterials(world: World, cost: LevelCost): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of Object.keys(cost.materials).sort()) {
    const lack = cost.materials[id]! - (world.town.storage[id] ?? 0);
    if (lack > 0) out[id] = lack;
  }
  return out;
}

function busyCount(world: World): number {
  let n = 0;
  for (const s of world.town.buildings ?? []) if (s.upgrade) n++;
  return n;
}

/** Room for one more construction/upgrade (buildMaxConcurrent). */
export function hasBuildSlot(config: GameConfig, world: World): boolean {
  return busyCount(world) < Math.max(1, Math.floor(config.formula.buildMaxConcurrent ?? 1));
}

/** Structural reasons a type cannot be built on a plot now (gold/materials/slots not checked). */
export function buildBlocker(config: GameConfig, world: World, buildingId: string, plotId: string): string | null {
  const b = config.index.buildings.get(buildingId);
  if (!b) return 'unknown building';
  const plot = config.index.plots.get(plotId);
  if (!plot) return 'unknown plot';
  if ((world.town.buildings ?? []).some((s) => s.id === plotId)) return 'plot occupied';
  if (buildingState(world, buildingId)) return 'already built';
  const th = townHallLevel(config, world);
  if (plot.townHallLevel > th) return 'plot locked by Town Hall level';
  if (b.requires.townHallLevel > th) return 'building locked by Town Hall level';
  return null;
}

/** Structural reasons an instance cannot be upgraded now (gold/materials/slots not checked). */
export function upgradeBlocker(config: GameConfig, world: World, instanceId: string): string | null {
  const s = (world.town.buildings ?? []).find((x) => x.id === instanceId);
  if (!s) return 'unknown building instance';
  const b = config.index.buildings.get(s.buildingId);
  if (!b) return 'unknown building';
  if (s.upgrade) return 'upgrade in progress';
  if (s.level >= b.maxLevel) return 'max level';
  if (b.kind !== 'townHall' && s.level + 1 > townHallLevel(config, world)) return 'locked by Town Hall level';
  return null;
}

/** Pay (gold incl. imported materials, storage materials) and start the job on a state. */
function begin(ctx: SystemContext, s: BuildingState, b: BuildingDef, cost: LevelCost, importGold: number, auto: boolean): void {
  const { world } = ctx;
  const paidGold = cost.gold + importGold;
  world.town.gold -= paidGold;
  const used: Record<string, number> = {};
  let units = 0;
  for (const id of Object.keys(cost.materials).sort()) {
    const want = cost.materials[id]!;
    const have = world.town.storage[id] ?? 0;
    const take = Math.min(have, want);
    const left = have - take;
    if (left > 0) world.town.storage[id] = left;
    else delete world.town.storage[id];
    used[id] = want; // imported units count as consumed too (and come back on cancel)
    units += want;
  }
  s.upgrade = { toLevel: s.level + 1, remainingMs: cost.ms, totalMs: cost.ms, gold: paidGold, materials: used, auto };
  const st = world.stats;
  st.investGold = (st.investGold ?? 0) + paidGold;
  st.investMaterials = (st.investMaterials ?? 0) + units;
  st.investImportGold = (st.investImportGold ?? 0) + importGold;
  ctx.events.emit(world.tick, { type: 'buildingStarted', instanceId: s.id, buildingId: b.id, toLevel: s.level + 1, gold: paidGold, materials: units, importGold, auto });
}

/** Gold to import missing materials at investImportPriceMul × price. */
export function importCost(config: GameConfig, missing: Record<string, number>): number {
  let g = 0;
  for (const id in missing) g += missing[id]! * Math.round((config.index.materials.get(id)?.price ?? 0) * config.formula.investImportPriceMul);
  return g;
}

/**
 * Start building a type on a free plot (null on success, else a rejection reason). The player path needs every material
 * in storage (`importGold` 0); auto-investment may pass the gold for imported missing units.
 */
export function startBuild(ctx: SystemContext, buildingId: string, plotId: string, auto = false, allowImport = false): string | null {
  const { world, config } = ctx;
  const bad = buildBlocker(config, world, buildingId, plotId);
  if (bad) return bad;
  if (!hasBuildSlot(config, world)) return 'construction slots full';
  const b = config.index.buildings.get(buildingId)!;
  const cost = levelCost(config, b, 1)!;
  const missing = missingMaterials(world, cost);
  const imp = allowImport ? importCost(config, missing) : 0;
  if (!allowImport && Object.keys(missing).length > 0) return 'missing materials';
  if (world.town.gold < cost.gold + imp) return 'not enough town gold';
  const s: BuildingState = { id: plotId, buildingId, level: 0, upgrade: null };
  // Keep plot config order so iteration stays deterministic and matches the map.
  const order = config.plots.map((p) => p.id);
  const list = world.town.buildings;
  const at = list.findIndex((x) => order.indexOf(x.id) > order.indexOf(plotId));
  if (at < 0) list.push(s);
  else list.splice(at, 0, s);
  begin(ctx, s, b, cost, imp, auto);
  return null;
}

/** Start upgrading a building instance by one level (null on success, else a rejection reason). */
export function startUpgrade(ctx: SystemContext, instanceId: string, auto = false, allowImport = false): string | null {
  const { world, config } = ctx;
  const bad = upgradeBlocker(config, world, instanceId);
  if (bad) return bad;
  if (!hasBuildSlot(config, world)) return 'construction slots full';
  const s = world.town.buildings.find((x) => x.id === instanceId)!;
  const b = config.index.buildings.get(s.buildingId)!;
  const cost = levelCost(config, b, s.level + 1)!;
  const missing = missingMaterials(world, cost);
  const imp = allowImport ? importCost(config, missing) : 0;
  if (!allowImport && Object.keys(missing).length > 0) return 'missing materials';
  if (world.town.gold < cost.gold + imp) return 'not enough town gold';
  begin(ctx, s, b, cost, imp, auto);
  return null;
}

/** Cancel a running construction/upgrade: everything paid comes back; a cancelled first construction frees the plot. */
export function cancelUpgrade(ctx: SystemContext, instanceId: string): string | null {
  const { world } = ctx;
  const i = (world.town.buildings ?? []).findIndex((x) => x.id === instanceId);
  if (i < 0) return 'unknown building instance';
  const s = world.town.buildings[i]!;
  const u = s.upgrade;
  if (!u) return 'no upgrade in progress';
  world.town.gold += u.gold;
  let units = 0;
  for (const id of Object.keys(u.materials).sort()) {
    world.town.storage[id] = (world.town.storage[id] ?? 0) + u.materials[id]!;
    units += u.materials[id]!;
  }
  const st = world.stats;
  st.investGold = (st.investGold ?? 0) - u.gold;
  st.investMaterials = (st.investMaterials ?? 0) - units;
  s.upgrade = null;
  if (s.level === 0) world.town.buildings.splice(i, 1);
  ctx.events.emit(world.tick, { type: 'buildingCancelled', instanceId, buildingId: s.buildingId, refund: u.gold });
  return null;
}

// ---- Auto-investment ----

interface Candidate {
  plotId: string;
  buildingId: string;
  toLevel: number;
  urgent: boolean;
  cost: LevelCost;
}

function maxHunterLevel(world: World): number {
  let lv = 0;
  for (const h of world.hunters) lv = Math.max(lv, h.level);
  return lv;
}

/** Next step of an instance if structurally allowed (not maxed, not upgrading, under the Town Hall cap). */
function upgradeCandidate(config: GameConfig, world: World, s: BuildingState, urgent: boolean): Candidate | null {
  if (upgradeBlocker(config, world, s.id)) return null;
  const b = config.index.buildings.get(s.buildingId)!;
  const cost = levelCost(config, b, s.level + 1);
  return cost ? { plotId: s.id, buildingId: b.id, toLevel: s.level + 1, urgent, cost } : null;
}

/**
 * Urgent step: the first craft building (config order) whose tier cap is below a recipe that hunters will want soon
 * (gear.level ≤ max hunter level + craftLevelAhead + investCraftLeadLevels). If its next level is above the Town Hall
 * level, the Town Hall upgrade is the urgent step instead. Null while nothing is about to be gear-capped (or the blocking
 * step is already running).
 */
export function urgentCandidate(config: GameConfig, world: World): Candidate | null {
  const f = config.formula;
  const want = maxHunterLevel(world) + f.craftLevelAhead + (f.investCraftLeadLevels ?? 0);
  for (const b of config.buildings) {
    if (b.kind !== 'craft') continue;
    const s = buildingState(world, b.id);
    if (!s || s.level < 1 || s.level >= b.maxLevel) continue;
    const cap = levelValue(b.maxGearLevel, s.level) ?? 0;
    if (!config.gear.some((g) => g.craftBuilding === b.id && g.level > cap && g.level <= want)) continue;
    if (s.upgrade) continue; // already on its way
    if (s.level + 1 > townHallLevel(config, world)) {
      const th = buildingState(world, config.index.townHall);
      if (!th || th.upgrade) continue;
      const c = upgradeCandidate(config, world, th, true);
      if (c) return c;
      continue;
    }
    const c = upgradeCandidate(config, world, s, true);
    if (c) return c;
  }
  return null;
}

/** Every other allowed step: upgrades of standing buildings and builds of unlocked types on the first free unlocked plot. */
export function otherCandidates(config: GameConfig, world: World): Candidate[] {
  const out: Candidate[] = [];
  for (const s of world.town.buildings ?? []) {
    const c = upgradeCandidate(config, world, s, false);
    if (c) out.push(c);
  }
  const th = townHallLevel(config, world);
  const plot = config.plots.find((p) => p.townHallLevel <= th && !(world.town.buildings ?? []).some((s) => s.id === p.id));
  if (plot) {
    for (const b of config.buildings) {
      if (buildBlocker(config, world, b.id, plot.id)) continue;
      const cost = levelCost(config, b, 1);
      if (cost) out.push({ plotId: plot.id, buildingId: b.id, toLevel: 1, urgent: false, cost });
    }
  }
  return out;
}

/** Lowest Town gold the step may leave: urgent → investUrgentReserveMul × autoCraftReserve; else investTargetMul × townGoldTarget. */
export function investFloor(config: GameConfig, world: World, urgent: boolean): number {
  const f = config.formula;
  return urgent ? f.investUrgentReserveMul * autoCraftReserve(config, world) : f.investTargetMul * townGoldTarget(config, world);
}

/**
 * The next investment: the urgent step if any (whatever the gold, so its materials get requested early); otherwise the
 * cheapest other step (gold, then config order) that Town gold above the treasury target can pay for, preferring steps
 * whose materials are already in storage. Null when there is nothing worth doing or no spare gold.
 */
export function chooseInvestment(config: GameConfig, world: World): Candidate | null {
  const urgent = urgentCandidate(config, world);
  if (urgent) return urgent;
  const floor = investFloor(config, world, false);
  const spare = world.town.gold - floor;
  let best: Candidate | null = null;
  let bestReady = false;
  for (const c of otherCandidates(config, world)) {
    if (c.cost.gold > spare) continue;
    const ready = Object.keys(missingMaterials(world, c.cost)).length === 0;
    if (!best || (ready && !bestReady) || (ready === bestReady && c.cost.gold < best.cost.gold)) {
      best = c;
      bestReady = ready;
    }
  }
  return best;
}

/** Materials of the stored investment plan (full counts; the Trading Post subtracts storage). Empty when auto-invest is off. */
export function investMaterialNeed(config: GameConfig, world: World): Record<string, number> {
  const plan = world.town.investPlan;
  if (!world.town.autoInvest || !plan) return {};
  const b = config.index.buildings.get(plan.buildingId);
  const cost = b ? levelCost(config, b, plan.toLevel) : null;
  return cost ? { ...cost.materials } : {};
}

function samePlan(a: InvestPlan | null, c: Candidate): boolean {
  return !!a && a.plotId === c.plotId && a.buildingId === c.buildingId && a.toLevel === c.toLevel;
}

/** One auto-investment decision (exported for tests). */
export function autoInvest(ctx: SystemContext): void {
  const { world, config } = ctx;
  const town = world.town;
  const c = chooseInvestment(config, world);
  if (!c) {
    town.investPlan = null;
    return;
  }
  const sinceMs = samePlan(town.investPlan, c) ? town.investPlan!.sinceMs : world.timeMs;
  town.investPlan = { plotId: c.plotId, buildingId: c.buildingId, toLevel: c.toLevel, urgent: c.urgent, sinceMs };
  if (!hasBuildSlot(config, world)) return;
  const missing = missingMaterials(world, c.cost);
  const lacking = Object.keys(missing).length > 0;
  const mayImport = world.timeMs - sinceMs >= config.formula.investImportSec * 1000;
  if (lacking && !mayImport) return;
  const imp = lacking ? importCost(config, missing) : 0;
  if (world.town.gold - c.cost.gold - imp < investFloor(config, world, c.urgent)) return;
  const exists = (town.buildings ?? []).some((s) => s.id === c.plotId);
  const err = exists ? startUpgrade(ctx, c.plotId, true, lacking) : startBuild(ctx, c.buildingId, c.plotId, true, lacking);
  if (!err) town.investPlan = null;
}

/** Buildings standing in a new game: every plot's startBuilding at startLevel (default 1), in plot order. */
export function initialBuildings(config: GameConfig): BuildingState[] {
  return config.plots
    .filter((p) => p.startBuilding !== undefined)
    .map((p) => ({ id: p.id, buildingId: p.startBuilding!, level: p.startLevel ?? 1, upgrade: null }));
}

/** Advances constructions/upgrades every tick; runs the auto-investment every townInvestIntervalSec of game time. */
export const townSystem: System = {
  name: 'town',
  update(ctx) {
    const { world, config, dtMs } = ctx;
    for (const s of world.town.buildings ?? []) {
      const u = s.upgrade;
      if (!u) continue;
      u.remainingMs = Math.max(0, u.remainingMs - dtMs);
      if (u.remainingMs > 0) continue;
      const first = s.level === 0;
      s.level = u.toLevel;
      s.upgrade = null;
      if (first) world.stats.buildingsBuilt = (world.stats.buildingsBuilt ?? 0) + 1;
      else world.stats.buildingUpgrades = (world.stats.buildingUpgrades ?? 0) + 1;
      ctx.events.emit(world.tick, { type: 'buildingCompleted', instanceId: s.id, buildingId: s.buildingId, level: s.level });
    }
    const every = Math.max(1, Math.round((config.formula.townInvestIntervalSec * 1000) / dtMs));
    if (world.tick % every !== 0) return;
    if (world.town.autoInvest) autoInvest(ctx);
    else world.town.investPlan = null;
  },
};
