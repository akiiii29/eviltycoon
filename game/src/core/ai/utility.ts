/** Goal scoring (TECH_SPEC §5). Pure functions: given state, return scored candidates. */
import { GEAR_SLOTS, NEED_KEYS, type GameConfig, type GearSlot, type ModStat, type NeedKey } from '../config/types';
import {
  duel, expectedHit, gearMainValue, type EffectiveStats, planStats, liveCrowd, monsterStats, monsterTypeStats, moveSpeed, needFrac, needMax,
  slotValue, urgentFrac, zoneCrowd, zoneOccupancy, type ZoneOccupancy, zoneScores, type ZoneScore,
} from '../formulas';
import { personalityFactor } from '../hunterFactory';
import type { NavGraph } from '../pathfinding';
import { canLearnTrait, nextSkillStudy } from '../systems/academy';
import { bestPotionPurchase } from '../systems/consumables';
import { servicePrice } from '../systems/services';
import { serviceInStock } from '../systems/supplies';
import { buildingLevel, enhanceBonus, gearCraftable } from '../systems/town';
import { bountyZoneMul } from '../systems/bounty';
import { bagHasSellable, bagUnrequested, materialDemand, requestZoneMul, type Demand } from '../systems/trading';
import { bagCount, type Goal, type Hunter, type ShopItem, type World } from '../world';

export interface Candidate {
  goal: Goal;
  score: number;
  label: string;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Urgent threshold for one need, scaled by personality (`urgent.<need>`; e.g. reckless halves the HP threshold). */
export function urgentThreshold(config: GameConfig, h: Hunter, need: NeedKey): number {
  return urgentFrac(config.formula, need) * personalityFactor(config, h, `urgent.${need}`);
}

/**
 * First need below its (personality-scaled) urgent threshold, if any.
 * `hpFloor` (see retreatHpFloor) raises the HP threshold to what the trip home is expected to cost; it is never
 * scaled by personality, so even a reckless hunter does not start a lethal walk home.
 */
export function urgentNeed(config: GameConfig, h: Hunter, hpFloor = 0): NeedKey | null {
  for (const n of NEED_KEYS) {
    const u = urgentThreshold(config, h, n);
    if (needFrac(config, h, n) < (n === 'hp' ? Math.max(u, hpFloor) : u)) return n;
  }
  return null;
}

/**
 * 0 if any need is urgent, 1 if all needs are above the soft threshold, linear in between (worst need wins).
 * The urgent threshold is scaled by the `urgent.<need>` personality factor (reckless HP ×0.5 → 0.125).
 * `inField`: the soft threshold is scaled too (never above softNeedFrac), so a reckless hunter keeps fighting
 * down to ~15 % HP; in town it stays unscaled so a revived (30 % HP) reckless hunter still heals before going out.
 * `hpFloor` (retreatHpFloor): when it is above the HP urgent threshold, the whole HP band (urgent and soft) shifts
 * up by the difference, so the hunter has the same HP margin to play with on top of the trip home.
 */
export function needsOk(config: GameConfig, h: Hunter, inField = false, hpFloor = 0): number {
  const f = config.formula;
  let worst = 1;
  for (const n of NEED_KEYS) {
    const k = personalityFactor(config, h, `urgent.${n}`);
    const base = urgentFrac(f, n) * k;
    const shift = n === 'hp' ? Math.max(0, hpFloor - base) : 0;
    const u = base + shift;
    const soft = Math.max(inField ? f.softNeedFrac * Math.min(k, 1) : f.softNeedFrac, base + 0.01) + shift;
    worst = Math.min(worst, clamp01((needFrac(config, h, n) - u) / (soft - u)));
  }
  return worst;
}

// ---------------------------------------------------------------------------------------------------------------
// Retreat: HP the hunter needs to get home alive (TECH_SPEC §5.2 "Rút lui").
// ---------------------------------------------------------------------------------------------------------------

/** Danger of a zone for one hunter, from the duel model (planStats: steady stats × current mood), × crowd factor. Absolute HP. */
export interface ZoneDanger {
  /** Spawn-weighted HP lost per second while monsters of this zone are on the hunter. */
  dps: number;
  /** Spawn-weighted HP lost per kill (what one more kill is expected to cost). */
  dmgPerKill: number;
}

/**
 * Per-call cache for one hunter: planning stats (formulas.planStats: no buffs, current mood on ATK/DEF — a low-mood
 * hunter's lower DEF raises its retreat floor and kill cost), current max HP and zone dangers. Pass one cache to several
 * retreat functions in the same decision so the stats and the duels run once. With a world, zone danger uses
 * the live crowd factor (formulas.crowdFactor: monsters alive per hunter, this hunter counted once); without one
 * (unit tests, no live zone) the static zoneCrowd.
 */
export interface DangerCache {
  stats: EffectiveStats;
  maxHp: number;
  zones: Map<string, ZoneDanger>;
  world?: World;
  occupancy?: ZoneOccupancy;
}

export function dangerCache(config: GameConfig, h: Hunter, world?: World): DangerCache {
  return { stats: planStats(config, h), maxHp: Math.max(needMax(config, h, 'hp'), 1), zones: new Map(), world };
}

function cacheCrowd(config: GameConfig, h: Hunter, zoneId: string, c: DangerCache): number {
  const zone = config.index.zones.get(zoneId)!;
  if (!c.world) return zoneCrowd(zone, config.formula);
  c.occupancy ??= zoneOccupancy(config, c.world, h.id);
  return liveCrowd(c.occupancy, zone, config.formula);
}

export function zoneDanger(config: GameConfig, h: Hunter, zoneId: string, difficultyId: string, cache?: DangerCache): ZoneDanger {
  const c = cache ?? dangerCache(config, h);
  const hit = c.zones.get(zoneId);
  if (hit) return hit;
  const zone = config.index.zones.get(zoneId)!;
  let w = 0, dps = 0, dmg = 0;
  for (const e of zone.monsters) {
    const d = duel(config, h, c.stats, monsterTypeStats(config, e.monsterId, difficultyId));
    w += e.weight;
    dps += e.weight * d.monsterDps;
    dmg += e.weight * d.dmgPerKill;
  }
  const crowd = cacheCrowd(config, h, zoneId, c);
  const out = w > 0 ? { dps: (crowd * dps) / w, dmgPerKill: (crowd * dmg) / w } : { dps: 0, dmgPerKill: 0 };
  c.zones.set(zoneId, out);
  return out;
}

/** Path length per zone from a node to the town square (config geometry only), cached per NavGraph. */
const legsCache = new WeakMap<NavGraph, Map<string, readonly (readonly [string, number])[]>>();

function legsHome(config: GameConfig, nav: NavGraph, fromNode: string): readonly (readonly [string, number])[] {
  let byNode = legsCache.get(nav);
  if (!byNode) { byNode = new Map(); legsCache.set(nav, byNode); }
  const hit = byNode.get(fromNode);
  if (hit) return hit;
  const len = new Map<string, number>();
  const add = (z: string | undefined, d: number) => { if (z) len.set(z, (len.get(z) ?? 0) + d); };
  const path = nav.path(fromNode, config.index.squareNode) ?? [];
  for (let i = 1; i < path.length; i++) {
    const a = nav.node(path[i - 1]!), b = nav.node(path[i]!);
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    add(a.zoneId, d / 2);
    add(b.zoneId, d / 2);
  }
  const out = [...len];
  byNode.set(fromNode, out);
  return out;
}

/**
 * Expected HP lost walking from `from` (a point standing at node `fromNode`) to the town square:
 *   Σ_zones (path length inside the zone / moveSpeed) × zoneDanger.dps.
 * Each path segment counts half for the zone of each end node (town nodes have no zone and cost nothing); the
 * stretch from `from` to `fromNode` counts for fromNode's zone. The zones walked through are counted too (on the
 * linear map, the whole way home), although with the level-gap rules lower zones cost almost nothing; in practice
 * the zone being left dominates.
 */
export function tripHomeDamage(
  config: GameConfig, nav: NavGraph, h: Hunter, from: { x: number; y: number }, fromNode: string, difficultyId: string, cache?: DangerCache,
): number {
  if (!nav.path(fromNode, config.index.squareNode)) return 0;
  const c = cache ?? dangerCache(config, h);
  const speed = Math.max(moveSpeed(config, h), 0.01);
  const start = nav.node(fromNode);
  let dmg = 0;
  if (start.zoneId) dmg += (Math.hypot(start.x - from.x, start.y - from.y) / speed) * zoneDanger(config, h, start.zoneId, difficultyId, c).dps;
  for (const [z, d] of legsHome(config, nav, fromNode)) dmg += (d / speed) * zoneDanger(config, h, z, difficultyId, c).dps;
  return dmg;
}

/**
 * Expected damage of the next hit of every monster on the hunter right now (alive, targeting it, in the zone the
 * hunter stands in): Σ expectedHit(monster ATK vs hunter planning DEF/EVA). Leaving mid-fight costs about one more
 * hit from each of them (monsters are slower than hunters), and a pile-on of several is what kills.
 */
export function engagedHitDamage(config: GameConfig, nav: NavGraph, world: World, h: Hunter, cache?: DangerCache): number {
  const zone = nav.node(h.nodeId).zoneId;
  if (!zone) return 0;
  const f = config.formula;
  const c = cache ?? dangerCache(config, h, world);
  let dmg = 0;
  for (const m of world.monsters) {
    if (m.targetHunterId !== h.id || m.hp <= 0 || m.zoneId !== zone) continue;
    const ms = monsterStats(config, m);
    dmg += expectedHit(ms.atk, c.stats.def, ms.level, h.level, ms.crit, f.monsterCritMultiplier, c.stats.eva, f);
  }
  return dmg;
}

/**
 * HP fraction under which the hunter must head home from where it stands (0 in town):
 *   min(retreatHpCap, (retreatTripMul × tripHomeDamage + retreatBurstMul × engagedHitDamage) / maxHp).
 * retreatTripMul > 1 covers the variance of the walk out (crits, adds on the way); the engaged term covers the
 * monsters already on the hunter, so a pile-on raises the floor at once instead of only after the HP is gone.
 * `at` defaults to the hunter's position; scoreGoals uses a zone's entry node to judge a zone before going there
 * (no monster is on the hunter there, so only the trip term counts).
 */
export function retreatHpFloor(
  config: GameConfig, nav: NavGraph, world: World, h: Hunter,
  at?: { pos: { x: number; y: number }; node: string }, cache?: DangerCache,
): number {
  const f = config.formula;
  const node = at?.node ?? nav.nearest(h.position);
  if (!nav.node(node).zoneId) return 0;
  const c = cache ?? dangerCache(config, h, world);
  let dmg = f.retreatTripMul * tripHomeDamage(config, nav, h, at?.pos ?? h.position, node, world.town.difficulty, c);
  if (!at && f.retreatBurstMul > 0) dmg += f.retreatBurstMul * engagedHitDamage(config, nav, world, h, c);
  return Math.min(f.retreatHpCap, dmg / c.maxHp);
}

/**
 * HP floor for the urgent backstop. Computed only when it could matter (in the field, HP between the
 * personality HP threshold and retreatHpCap), so the per-tick backstop stays cheap.
 */
export function backstopHpFloor(config: GameConfig, nav: NavGraph, world: World, h: Hunter): number {
  if (!currentZone(nav, h)) return 0;
  const hp = needFrac(config, h, 'hp');
  if (hp >= config.formula.retreatHpCap || hp < urgentThreshold(config, h, 'hp')) return 0;
  return retreatHpFloor(config, nav, world, h);
}

/** One more kill in a zone, as a fraction of max HP, × retreatKillMul. */
function killCostFrac(config: GameConfig, h: Hunter, zoneId: string, difficultyId: string, c: DangerCache): number {
  return (config.formula.retreatKillMul * zoneDanger(config, h, zoneId, difficultyId, c).dmgPerKill) / c.maxHp;
}

/**
 * HP fraction a hunter needs to start hunting a zone it is not in yet: the retreat line at the zone's entry node
 * plus one kill there,  max(HP urgent threshold, retreatHpFloor(entry)) + retreatKillMul × dmgPerKill / maxHp.
 * Same rule as shouldRetreatBeforeNextKill, so a hunter that sets out is not sent straight back.
 */
export function zoneEntryHpLine(config: GameConfig, nav: NavGraph, world: World, h: Hunter, zoneId: string, cache?: DangerCache): number {
  const c = cache ?? dangerCache(config, h, world);
  const entry = nav.node(config.index.zones.get(zoneId)!.entryNode);
  const floor = retreatHpFloor(config, nav, world, h, { pos: entry, node: entry.id }, c);
  return Math.max(urgentThreshold(config, h, 'hp'), floor) + killCostFrac(config, h, zoneId, world.town.difficulty, c);
}

/**
 * Kill boundary: between two fights (nothing is attacking the hunter), head home now if one more kill in the
 * current zone is expected to take HP under the retreat line:
 *   hpFrac − retreatKillMul × dmgPerKill / maxHp < max(HP urgent threshold, retreatHpFloor).
 * Leaving between fights is cheap (no monster is on the hunter), leaving mid-fight is what kills.
 */
export function shouldRetreatBeforeNextKill(config: GameConfig, nav: NavGraph, world: World, h: Hunter, zoneId: string): boolean {
  const c = dangerCache(config, h, world);
  const hp = h.needs.hp / c.maxHp;
  const kill = killCostFrac(config, h, zoneId, world.town.difficulty, c);
  if (hp - kill >= config.formula.retreatHpCap) return false;
  const line = Math.max(urgentThreshold(config, h, 'hp'), retreatHpFloor(config, nav, world, h, undefined, c));
  return hp - kill < line;
}

/**
 * HP fraction under which a hunter carrying potions drinks one in the field (TECH_SPEC §5.14; 0 in town): the highest of
 *  - potionUseHpFrac,
 *  - the kill-boundary line max(HP urgent threshold, retreatHpFloor) + one kill (shouldRetreatBeforeNextKill),
 *  - the middle of the field HP needs band (needsOk's HP term at 0.5, about where returnTown overtakes hunt),
 * capped at 0.95. The urgent backstop line (max(threshold, floor)) is below the kill-boundary line, so a potion is drunk
 * before any retreat rule fires; the retreat rules themselves are unchanged.
 */
export function potionDrinkLine(config: GameConfig, nav: NavGraph, world: World, h: Hunter): number {
  const f = config.formula;
  const zone = currentZone(nav, h);
  if (!zone) return 0;
  const c = dangerCache(config, h, world);
  const floor = retreatHpFloor(config, nav, world, h, undefined, c);
  const k = personalityFactor(config, h, 'urgent.hp');
  const base = urgentFrac(f, 'hp') * k;
  const shift = Math.max(0, floor - base);
  const u = base + shift;
  const soft = Math.max(f.softNeedFrac * Math.min(k, 1), base + 0.01) + shift;
  const kill = Math.max(urgentThreshold(config, h, 'hp'), floor) + killCostFrac(config, h, zone, world.town.difficulty, c);
  return Math.min(0.95, Math.max(f.potionUseHpFrac ?? 0, kill, u + 0.5 * (soft - u)));
}

/** Zone the hunter is currently standing in, or null when in town. */
export function currentZone(nav: NavGraph, h: Hunter): string | null {
  return nav.node(h.nodeId).zoneId ?? null;
}

export function sameGoal(a: Goal | null, b: Goal | null): boolean {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === 'hunt' && b.type === 'hunt') return a.zoneId === b.zoneId;
  if (a.type === 'service' && b.type === 'service') return a.buildingId === b.buildingId;
  if (a.type === 'shop' && b.type === 'shop') return a.itemUid === b.itemUid;
  if (a.type === 'enhance' && b.type === 'enhance') return a.slot === b.slot;
  if (a.type === 'learn' && b.type === 'learn') return a.kind === b.kind && a.id === b.id;
  if (a.type === 'buyPotion' && b.type === 'buyPotion') return a.consumableId === b.consumableId;
  return true;
}

/** Bag fill 0..1 (total units / bagCapacity). */
export function bagFill(config: GameConfig, h: Hunter): number {
  const cap = config.formula.bagCapacity;
  return cap > 0 ? clamp01(bagCount(h) / cap) : 0;
}

/**
 * Best affordable, equippable upgrade on sale, or null.
 * Budget = gold × spendRatio × personality(spendRatio); gain = (new − current) / max(current, 1), must be ≥ minUpgradeGain.
 * Highest score (shopBaseScore + min(gain,1) × shopGainWeight) wins; ties → lower price, then uid.
 */
export function bestShopPurchase(config: GameConfig, world: World, h: Hunter): { item: ShopItem; gain: number } | null {
  const f = config.formula;
  const budget = h.gold * f.spendRatio * personalityFactor(config, h, 'spendRatio');
  let best: { item: ShopItem; gain: number } | null = null;
  for (const item of world.town.shop) {
    const def = config.index.gear.get(item.gearId);
    if (!def || h.level < def.level || item.price > budget) continue;
    const cur = slotValue(config, h, def.slot);
    const gain = (gearMainValue(config, item) - cur) / Math.max(cur, 1);
    if (gain < f.minUpgradeGain) continue;
    if (!best) { best = { item, gain }; continue; }
    const a = Math.min(gain, 1);
    const b = Math.min(best.gain, 1);
    if (a > b || (a === b && (item.price < best.item.price || (item.price === best.item.price && item.uid < best.item.uid)))) {
      best = { item, gain };
    }
  }
  return best;
}

/**
 * Expected cost and success rate of enhancing a slot's gear to its next level (AI estimate):
 * round(basePrice × enhance[next-1].costFrac); null if empty/maxed. The forge's own price is
 * systems/economy.enhanceCost (per gear instance). With `world` the success rate includes the Forge level's enhanceBonus.
 */
export function expectedEnhanceCost(config: GameConfig, h: Hunter, slot: GearSlot, world?: World): { cost: number; successRate: number } | null {
  const g = h.equipment[slot];
  if (!g) return null;
  const def = config.index.gear.get(g.gearId);
  const row = config.enhance[g.enhance]; // next = g.enhance + 1 → enhance[next - 1]
  if (!def || !row) return null;
  const bonus = world ? enhanceBonus(config, world) : 0;
  const k = personalityFactor(config, h, 'enhance.success'); // TECH_SPEC §5.5, same rate as economy.doEnhance
  return { cost: Math.round(def.basePrice * row.costFrac), successRate: Math.min(1, (row.successRate + bonus) * k) };
}

/**
 * Gold the hunter must hold to try an enhance, as a multiple of its cost:
 * enhanceGoldReserveMul / successRate^enhanceRiskExp (risk budget: riskier steps need more spare gold,
 * e.g. ×2 at 100 %, ×2.4 at 70 %, ×2.8 at 50 %, ×3.7 at 30 % with exponent 0.5).
 */
export function enhanceReserveMul(config: GameConfig, successRate: number): number {
  const f = config.formula;
  return f.enhanceGoldReserveMul / Math.pow(Math.max(successRate, 0.01), f.enhanceRiskExp);
}

/** The upgrade a hunter is saving for in one slot (see upgradeSavings). */
export interface SavingsTarget {
  /** Gold to keep back. */
  hold: number;
  /** Relative slot gain of the upgrade per gold of its price: ((value − current) / max(current, 1)) / price. */
  relGainPerGold: number;
}

/**
 * The upgrade to save for in one slot, or null. Upgrades = ≥ minUpgradeGain over the current value, wearable at the
 * hunter's level:
 *  - concrete (with `world`): items on sale (current marked-down price, actual quality) and items being crafted
 *    (Rare reference value, price basePrice × aiTypicalQualityMult) → hold upgradeSavingsConcreteFrac × price / spend;
 *  - otherwise any gear whose craft building allows its tier (TECH_SPEC §5.12; the AI assumes an uncommon-ish roll:
 *    value and price × aiTypicalQualityMult) → hold upgradeSavingsFrac × price / spend,
 * with spend = spendRatio × personality (the gold whose shop budget covers the price). The cheapest concrete upgrade
 * wins over any theoretical one; within a kind the cheapest wins.
 */
export function savingsTarget(config: GameConfig, h: Hunter, slot: GearSlot, world?: World): SavingsTarget | null {
  const f = config.formula;
  const cur = slotValue(config, h, slot);
  const spend = Math.max(f.spendRatio * personalityFactor(config, h, 'spendRatio'), 0.01);
  const line = cur * (1 + f.minUpgradeGain);
  let best: { price: number; value: number } | null = null;
  const consider = (price: number, value: number) => { if (!best || price < best.price) best = { price, value }; };
  if (world) {
    for (const it of world.town.shop) {
      const def = config.index.gear.get(it.gearId);
      const v = def ? gearMainValue(config, it) : 0;
      if (!def || def.slot !== slot || def.level > h.level || v < line) continue;
      consider(it.price, v);
    }
    for (const k in world.town.crafting) {
      const job = world.town.crafting[k];
      const def = job ? config.index.gear.get(job.gearId) : undefined;
      if (!def || def.slot !== slot || def.level > h.level || def.mainValue < line) continue;
      consider(def.basePrice * f.aiTypicalQualityMult, def.mainValue);
    }
  }
  let frac = f.upgradeSavingsConcreteFrac;
  if (!best) {
    frac = f.upgradeSavingsFrac;
    for (const def of config.gear) {
      if (def.slot !== slot || def.level > h.level) continue;
      if (world && !gearCraftable(config, world, def)) continue;
      const v = def.mainValue * f.aiTypicalQualityMult;
      if (v < line) continue;
      consider(def.basePrice * f.aiTypicalQualityMult, v);
    }
  }
  const t = best as { price: number; value: number } | null;
  if (!t) return null;
  return { hold: (frac * t.price) / spend, relGainPerGold: (t.value - cur) / Math.max(cur, 1) / Math.max(t.price, 1) };
}

/** Gold to keep back for the next gear upgrade of one slot (savingsTarget.hold; 0 when there is none). */
export function upgradeSavings(config: GameConfig, h: Hunter, slot: GearSlot, world?: World): number {
  return savingsTarget(config, h, slot, world)?.hold ?? 0;
}

/**
 * The savings an enhance must respect: the target with the largest hold over all slots (null when nothing is worth
 * saving for). Per hunter, not per enhanced slot, so polishing a slot with no upgrade in sight does not spend the gold
 * put aside for another slot.
 */
export function enhanceSavings(config: GameConfig, h: Hunter, world?: World): SavingsTarget | null {
  let best: SavingsTarget | null = null;
  for (const slot of GEAR_SLOTS) {
    const t = savingsTarget(config, h, slot, world);
    if (t && (!best || t.hold > best.hold)) best = t;
  }
  return best;
}

/** Gold an enhance must leave untouched when it is worse value than the upgrade saved for (enhanceSavings.hold). */
export function enhanceSavingsHold(config: GameConfig, h: Hunter, world?: World): number {
  return enhanceSavings(config, h, world)?.hold ?? 0;
}

export interface EnhanceChoice {
  slot: GearSlot;
  cost: number;
  successRate: number;
  /** Expected main-stat change of the try (success gain minus the expected loss from dropOnFail), absolute. */
  expectedGain: number;
  /** expectedGain relative to the slot's current value. */
  expectedRelGain: number;
}

/**
 * Best next enhance over equipped slots, or null. A slot qualifies only if
 *  - successRate ≥ enhanceMinSuccess,
 *  - the try is worth it after the dropOnFail risk: expectedGain ≥ enhanceMinNetFrac × successRate × step
 *    (with step = loss this is (2p − 1) / p ≥ enhanceMinNetFrac, i.e. p ≥ 1 / (2 − enhanceMinNetFrac) on drop steps),
 *  - gold ≥ cost × enhanceReserveMul(successRate), plus the gear savings (enhanceSavings.hold) unless this try is
 *    clearly better value than the upgrade saved for (expectedRelGain / cost ≥ enhanceVsUpgradeMul × its
 *    relGainPerGold; the multiplier stands for the enhance being lost when the piece is replaced): cheap early steps
 *    still happen, gambles on gear about to be replaced do not.
 * Among those, the highest expectedGain / cost wins (expected stat gain per gold, net of the expected loss);
 * ties → GEAR_SLOTS order.
 */
export function bestEnhance(config: GameConfig, h: Hunter, world?: World): EnhanceChoice | null {
  const f = config.formula;
  const minSuccess = f.enhanceMinSuccess;
  const minNet = f.enhanceMinNetFrac ?? -Infinity;
  let best: EnhanceChoice | null = null;
  let bestPerGold = -Infinity;
  let saving: SavingsTarget | null | undefined;
  for (const slot of GEAR_SLOTS) {
    const c = expectedEnhanceCost(config, h, slot, world);
    const g = h.equipment[slot];
    if (!c || !g || c.successRate < minSuccess) continue;
    const cur = gearMainValue(config, g);
    const step = gearMainValue(config, { ...g, enhance: g.enhance + 1 }) - cur;
    const row = config.enhance[g.enhance]!;
    const loss = row.dropOnFail && g.enhance > 0 ? cur - gearMainValue(config, { ...g, enhance: g.enhance - 1 }) : 0;
    const expectedGain = c.successRate * step - (1 - c.successRate) * loss;
    if (expectedGain < minNet * c.successRate * step - 1e-9) continue;
    const reserve = c.cost * enhanceReserveMul(config, c.successRate);
    if (h.gold < reserve) continue;
    const expectedRelGain = expectedGain / Math.max(cur, 1);
    if (saving === undefined) saving = enhanceSavings(config, h, world);
    if (saving && expectedRelGain / Math.max(c.cost, 1) < f.enhanceVsUpgradeMul * saving.relGainPerGold && h.gold < reserve + saving.hold) continue;
    const perGold = expectedGain / Math.max(c.cost, 1);
    if (perGold > bestPerGold) {
      bestPerGold = perGold;
      best = { slot, cost: c.cost, successRate: c.successRate, expectedGain, expectedRelGain };
    }
  }
  return best;
}

/** Class-agnostic trait preference for the AI (first = most wanted). */
const TRAIT_PRIORITY: readonly ModStat[] = ['atkPct', 'hpPct', 'defPct', 'atkSpeedPct', 'crit', 'eva'];

/**
 * What the hunter should study at the Academy, or null.
 * Skills first: cheapest learnable next level (ties → skill id), only if gold ≥ cost × enhanceGoldReserveMul
 * (at level 1 the starting gold is kept back, so a fresh hunter hunts before studying).
 * Otherwise a learnable trait (enough points, not maxed), by TRAIT_PRIORITY then trait id; cost = point cost.
 */
export function bestLearn(config: GameConfig, h: Hunter, world?: World): { kind: 'skill' | 'trait'; id: string; cost: number } | null {
  const f = config.formula;
  // A level-1 hunter hunts first: it only studies with gold to spare beyond its starting purse.
  const spare = h.level >= 2 ? h.gold : h.gold - f.startingGold;
  let skill: { id: string; cost: number } | null = null;
  for (const def of config.skills) {
    const next = nextSkillStudy(config, h, def.id, world);
    if (!next || spare < next.cost * f.enhanceGoldReserveMul) continue;
    if (!skill || next.cost < skill.cost || (next.cost === skill.cost && def.id < skill.id)) skill = { id: def.id, cost: next.cost };
  }
  if (skill) return { kind: 'skill', ...skill };

  let trait: { id: string; cost: number; rank: number } | null = null;
  for (const def of config.traits) {
    if (!canLearnTrait(config, h, def.id)) continue;
    const r = TRAIT_PRIORITY.indexOf(def.stat);
    const rank = r < 0 ? TRAIT_PRIORITY.length : r;
    if (!trait || rank < trait.rank || (rank === trait.rank && def.id < trait.id)) trait = { id: def.id, cost: def.pointCost, rank };
  }
  return trait ? { kind: 'trait', id: trait.id, cost: trait.cost } : null;
}

/**
 * True when the bag holds at least one REQUESTED unit the town can afford to buy (avoids a sell goal that sells nothing).
 * `demand` defaults to the current Trading Post requests (materialDemand).
 */
export function townCanBuyFrom(config: GameConfig, world: World, h: Hunter, demand: Demand = materialDemand(config, world)): boolean {
  return bagHasSellable(config, world, h.bag, demand);
}

/**
 * Trading Post requests steer zone CHOICE only: each viable zone (zoneFit > 0) gets
 * requestZoneMul / (max requestZoneMul over viable zones), so the hunt score never rises above what it was
 * without requests (hunting vs. town goals is unchanged when the best zone is requested, slightly lower if not),
 * and a requested zone beats an unrequested one of similar fit. Zones the hunter cannot survive never get a bonus.
 * With `world`, active bounties multiply in bountyZoneMul before the normalisation.
 */
export function huntZoneMuls(config: GameConfig, scores: readonly ZoneScore[], demand: Demand, world?: World): Map<string, number> {
  const raw = new Map<string, number>();
  let max = 0;
  for (const { zone: z, fit } of scores) {
    if (fit <= 0) continue;
    // Bounty targets (systems/bounty.ts) steer zone choice the same way, inside the same normalisation.
    const m = requestZoneMul(config, z, demand) * (world ? bountyZoneMul(config, world, z) : 1);
    raw.set(z.id, m);
    max = Math.max(max, m);
  }
  if (max > 0) for (const [id, m] of raw) raw.set(id, m / max);
  return raw;
}

/** Scores every available goal (without noise), highest first. */
export function scoreGoals(config: GameConfig, nav: NavGraph, world: World, h: Hunter): Candidate[] {
  const f = config.formula;
  const out: Candidate[] = [];
  const zoneNow = currentZone(nav, h);
  const inField = zoneNow !== null;
  const danger = dangerCache(config, h, world);
  // Retreat floor where the hunter stands (0 in town): the needs band in the field sits on top of the trip home.
  const hereFloor = inField ? retreatHpFloor(config, nav, world, h, undefined, danger) : 0;
  const ok = needsOk(config, h, inField, hereFloor);
  const huntMul = personalityFactor(config, h, 'goal.hunt');
  const fill = bagFill(config, h);
  const demand = materialDemand(config, world);

  const scores = zoneScores(config, world, h, true);
  const zoneMul = huntZoneMuls(config, scores, demand, world);
  for (const { zone: z, fit } of scores) {
    // Another zone is judged by the HP needed to start a kill there (zoneEntryHpLine): a hunter does not set out
    // for a zone it would have to leave again at the first kill boundary.
    let zoneOk = ok;
    if (fit > 0 && z.id !== zoneNow) zoneOk = needsOk(config, h, inField, zoneEntryHpLine(config, nav, world, h, z.id, danger));
    let s = fit * zoneOk * huntMul;
    if (s > 0) s *= zoneMul.get(z.id) ?? 1;
    if (s > 0 && h.ai.goal?.type === 'hunt' && h.ai.goal.zoneId === z.id) s += f.huntStickiness;
    if (s > 0) out.push({ goal: { type: 'hunt', zoneId: z.id }, score: s, label: `hunt ${z.id}` });
  }

  const sellable = townCanBuyFrom(config, world, h, demand);
  // A full bag holding unrequested materials blocks requested drops; the post discards those, so the trip clears room.
  const dump = fill >= f.bagReturnFrac && bagUnrequested(h.bag, demand) > 0;
  if (zoneNow) {
    // In the field: services are only reachable by going home first; a full bag also sends the hunter home,
    // but only if the trading post will buy or discard something (otherwise hunters would shuttle back and forth).
    const bagScore = fill >= f.bagReturnFrac && (sellable || dump) ? f.bagReturnScore : 0;
    out.push({ goal: { type: 'returnTown' }, score: Math.max(1 - ok, bagScore), label: 'returnTown' });
  } else {
    for (const b of config.buildings) {
      if (b.kind !== 'service' || !b.need || b.price === undefined) continue;
      const lv = buildingLevel(world, b.id);
      if (lv < 1) continue; // not built yet
      if (!serviceInStock(world, b)) continue; // out of supplies (TECH_SPEC §5.14): rest instead
      const frac = needFrac(config, h, b.need);
      if (frac >= f.serviceFullFrac || h.gold < servicePrice(config, h, b, lv)) continue;
      const base = frac < f.softNeedFrac ? f.serviceLowBase + f.serviceLowWeight * (1 - frac) : f.serviceWeight * (1 - frac);
      const s = base * personalityFactor(config, h, `goal.service.${b.need}`);
      out.push({ goal: { type: 'service', buildingId: b.id }, score: s, label: `service ${b.need}` });
    }

    // Economy (M2): damped when needs are low so services still win.
    const econMul = Math.max(ok, f.econMulFloor);
    const built = (id: string) => buildingLevel(world, id) >= 1;
    if ((sellable || dump) && built(config.index.tradingPost)) {
      out.push({ goal: { type: 'sell' }, score: (f.sellBaseScore + f.sellFillWeight * fill) * econMul, label: 'sell' });
    }
    const buy = built(config.index.shop) ? bestShopPurchase(config, world, h) : null;
    if (buy) {
      const s = (f.shopBaseScore + Math.min(buy.gain, 1) * f.shopGainWeight) * econMul;
      out.push({ goal: { type: 'shop', itemUid: buy.item.uid }, score: s, label: `shop ${buy.item.gearId}` });
    }
    const enh = built(config.index.forge) ? bestEnhance(config, h, world) : null;
    if (enh) {
      out.push({ goal: { type: 'enhance', slot: enh.slot }, score: (f.enhanceBaseScore + f.enhanceGainWeight * enh.expectedRelGain) * econMul, label: `enhance ${enh.slot}` });
    }
    const learn = built(config.index.academy) ? bestLearn(config, h, world) : null;
    if (learn) {
      const s = (learn.kind === 'skill' ? f.learnSkillScore : f.learnTraitScore) * econMul;
      out.push({ goal: { type: 'learn', kind: learn.kind, id: learn.id }, score: s, label: `learn ${learn.kind} ${learn.id}` });
    }

    // Potions (TECH_SPEC §5.14): restock the pack at the seller, scored like an economy goal.
    const potion = bestPotionPurchase(config, world, h);
    if (potion) {
      out.push({ goal: { type: 'buyPotion', consumableId: potion.consumable.id }, score: f.potionBuyScore * econMul, label: `buyPotion ${potion.consumable.id}` });
    }

    // Idling in town also recovers needs slowly for free, so a tired hunter who cannot pay rests instead of hunting.
    out.push({ goal: { type: 'wander', nodeId: '' }, score: Math.max(f.wanderScore, f.restScoreWeight * (1 - ok)), label: 'wander/rest' });
  }
  return out.sort((a, b) => b.score - a.score);
}
