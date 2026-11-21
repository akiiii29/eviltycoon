import type { GameConfig, GearDef, GearQualityDef } from '../config/types';
import type { EffectiveStats } from '../formulas';
import { GEAR_SLOTS } from '../config/types';
import {
  expectedGearExtraFor, expectedGearScore, gearMainValue, gearScore, hunterStats, slotValue, slotValueFor,
} from '../formulas';
import { copyGearDepth, gradeOf, rollGearOptions } from '../gear';
import { personalityFactor } from '../hunterFactory';
import { cacheVerifyEnabled } from '../statsCache';
import type { System, SystemContext } from '../system';
import type { GearInstance, Hunter, ShopItem, World } from '../world';
import { baseTier, craftTiers, recipeMaterials, tierCraftable, tierDef, tierPriceMul } from './gearTier';
import { buildingLevel, gearCraftable, shopCapacity as shopCapacityAt } from './town';
import { storeOrExport } from './trading';

/** Max items on sale (the shop building's capacity at its level, systems/town.ts). */
export function shopCapacity(config: GameConfig, world: World): number {
  return shopCapacityAt(config, world);
}

/** Number of craft jobs currently running (they will each need a shop slot). */
function runningJobs(world: World): number {
  let n = 0;
  for (const k in world.town.crafting) if (world.town.crafting[k]) n++;
  return n;
}

/** True when the shop can take one more item counting jobs already running. */
export function shopHasRoom(world: World, config: GameConfig): boolean {
  return world.town.shop.length + runningJobs(world) < shopCapacity(config, world);
}

/**
 * Town Storage holds the recipe's materials. Without `config` only the plain recipe (gear.materials) is checked;
 * with it, the recipe at gear tier `difficultyId` (plus its essence, gearTier.recipeMaterials).
 */
export function hasMaterials(world: World, gear: GearDef, config?: GameConfig, difficultyId?: string): boolean {
  const mats = config ? recipeMaterials(config, gear, difficultyId) : gear.materials;
  return mats.every((m) => (world.town.storage[m.materialId] ?? 0) >= m.count);
}

/** Town gold paid to start crafting this gear: round(basePrice × craftGoldFrac × tier gearPriceMul). */
export function craftGoldCost(config: GameConfig, gear: GearDef, difficultyId?: string): number {
  return Math.round(gear.basePrice * config.formula.craftGoldFrac * tierPriceMul(config, difficultyId));
}

/**
 * List price of a fresh craft: round(basePrice × quality priceMult × tier gearPriceMul × grade priceMult).
 * `gradeId` absent = the first (no-option) grade, priceMult 1 in the shipped table.
 */
export function craftListPrice(config: GameConfig, gear: GearDef, q: GearQualityDef, difficultyId?: string, gradeId?: string): number {
  return Math.round(gear.basePrice * q.priceMult * tierPriceMul(config, difficultyId) * gradeOf(config, { gradeId }).priceMult);
}

/**
 * Shop price of a used (reclaimed) item: round(basePrice × priceMult × tier gearPriceMul × grade priceMult ×
 * (1 + enhance × enhanceStatPerLevel)), i.e. the craft price scaled like its main stat by the enhance level. 0 for unknown gear/quality.
 */
export function gearListPrice(config: GameConfig, g: GearInstance): number {
  const def = config.index.gear.get(g.gearId);
  const q = config.index.qualities.get(g.qualityId);
  if (!def || !q) return 0;
  return Math.round(def.basePrice * q.priceMult * tierPriceMul(config, g.difficultyId) * gradeOf(config, g).priceMult *
    (1 + g.enhance * config.formula.enhanceStatPerLevel));
}

function maxHunterLevel(world: World): number {
  let lv = 0;
  for (const h of world.hunters) lv = Math.max(lv, h.level);
  return lv > 0 ? lv : 1;
}

/**
 * Gold the town keeps back from AUTO-crafting so the trading post can always buy materials:
 * 3 × the most expensive material price of the CURRENT tier, i.e. materials used by recipes with
 * gear.level ≤ max hunter level + craftLevelAhead (all materials if no recipe qualifies).
 * Tier-relative rather than "most expensive material in config", because late-game materials
 * (hundreds of gold) would otherwise block early crafting entirely. Gear tiers count too: the essence of every
 * craftable tier (gearTier.craftTiers) is one of those materials.
 * Manual `town.craft` ignores this reserve and only needs the craft cost itself.
 */
export function autoCraftReserve(config: GameConfig, world: World): number {
  const cap = maxHunterLevel(world) + config.formula.craftLevelAhead;
  let max = 0;
  for (const g of config.gear) {
    if (g.level > cap) continue;
    for (const m of g.materials) max = Math.max(max, config.index.materials.get(m.materialId)?.price ?? 0);
  }
  if (max === 0) for (const m of config.materials) max = Math.max(max, m.price);
  // Tier-aware (TECH_SPEC §5.8): the essence of every craftable gear tier is bought like any recipe material.
  for (const t of craftTiers(config, world)) {
    if (t.essenceId) max = Math.max(max, config.index.materials.get(t.essenceId)?.price ?? 0);
  }
  return 3 * max;
}

/**
 * Start a craft job in a craft building at gear tier `difficultyId` (default: the base tier), consuming the tier's
 * recipe materials (incl. essence) from Town Storage and craftGoldCost from town gold.
 * Returns null on success, else a rejection reason.
 */
export function startCraft(ctx: SystemContext, buildingId: string, gearId: string, difficultyId?: string): string | null {
  const { world, config } = ctx;
  const b = config.index.buildings.get(buildingId);
  if (!b) return 'unknown building';
  if (b.kind !== 'craft') return 'not a craft building';
  if (buildingLevel(world, buildingId) < 1) return 'building not built';
  const gear = config.index.gear.get(gearId);
  if (!gear || gear.craftBuilding !== buildingId) return 'gear not made here';
  if (!gearCraftable(config, world, gear)) return 'gear tier locked by building level';
  if (difficultyId !== undefined && !config.index.difficulties.has(difficultyId)) return 'unknown difficulty';
  const tier = difficultyId ?? baseTier(config);
  if (!tierCraftable(config, world, tier)) return 'gear tier locked by difficulty';
  if (world.town.crafting[buildingId]) return 'building is busy';
  if (!hasMaterials(world, gear, config, tier)) return 'missing materials';
  if (!shopHasRoom(world, config)) return 'shop is full';
  const cost = craftGoldCost(config, gear, tier);
  if (world.town.gold < cost) return 'not enough town gold';
  world.town.gold -= cost;
  for (const m of recipeMaterials(config, gear, tier)) {
    const left = world.town.storage[m.materialId]! - m.count;
    if (left > 0) world.town.storage[m.materialId] = left;
    else delete world.town.storage[m.materialId];
  }
  world.town.crafting[buildingId] = { gearId, remainingMs: gear.craftSec * 1000, difficultyId: tier };
  ctx.events.emit(world.tick, { type: 'craftStarted', buildingId, gearId });
  return null;
}

/** The "Rare" reference quality used to judge recipes: statMult 1 (else the one closest to 1). */
export function referenceQuality(config: GameConfig): GearQualityDef | undefined {
  let best: GearQualityDef | undefined;
  for (const q of config.qualities) {
    if (!best || Math.abs(q.statMult - 1) < Math.abs(best.statMult - 1)) best = q;
  }
  return best;
}

/**
 * Markdown steps from list price to the floor: ceil((1 − shopMarkdownFloor) × 100 / shopMarkdownPct), 0 when
 * markdowns are off (shopStaleSec or shopMarkdownPct ≤ 0). The epsilon keeps float noise such as
 * (1 − 0.7) × 100 / 10 = 3.0000000000000004 from adding a step.
 */
export function shopMarkdownSteps(f: GameConfig['formula']): number {
  if (f.shopStaleSec <= 0 || f.shopMarkdownPct <= 0) return 0;
  return Math.max(0, Math.ceil(((1 - f.shopMarkdownFloor) * 100) / f.shopMarkdownPct - 1e-9));
}

/**
 * Age (s) at which an unsold item is scrapped: the time to mark it down to the floor
 * (shopMarkdownSteps × shopStaleSec) plus shopFloorHoldSec at the floor price.
 * Derived, so the floor is always reached and offered before scrapping. Infinity when shopFloorHoldSec < 0 (never scrap).
 */
export function shopScrapAgeSec(f: GameConfig['formula']): number {
  if (f.shopFloorHoldSec < 0) return Infinity;
  return shopMarkdownSteps(f) * Math.max(0, f.shopStaleSec) + f.shopFloorHoldSec;
}

/**
 * Shop turnover (deterministic, listing order): every shopStaleSec unsold the price drops by
 * shopMarkdownPct% of listPrice, never below round(listPrice × shopMarkdownFloor);
 * once the item has sat at the floor for shopFloorHoldSec (age ≥ shopScrapAgeSec) it is removed.
 * The price is derived from the item's age each tick, so it is idempotent and save-safe.
 * Returns the items removed this call (the crafting system dismantles them, dismantleItem: gearDismantled, or
 * gearScrapped when nothing comes back).
 */
export function updateShopTurnover(world: World, config: GameConfig): ShopItem[] {
  const f = config.formula;
  const staleMs = f.shopStaleSec * 1000;
  const scrapMs = shopScrapAgeSec(f) * 1000;
  const shop = world.town.shop;
  const scrapped: ShopItem[] = [];
  let w = 0;
  for (let r = 0; r < shop.length; r++) {
    const it = shop[r]!;
    const age = world.timeMs - it.listedAtMs;
    if (age >= scrapMs) {
      scrapped.push(it);
      continue;
    }
    if (staleMs > 0) {
      const steps = Math.max(0, Math.floor(age / staleMs));
      const floor = Math.round(it.listPrice * f.shopMarkdownFloor);
      const marked = Math.round((it.listPrice * (100 - steps * f.shopMarkdownPct)) / 100);
      it.price = Math.min(it.listPrice, Math.max(floor, marked));
    }
    shop[w++] = it;
  }
  shop.length = w;
  return scrapped;
}

/**
 * Same-slot items already on sale (actual quality, tier and option lines) or being crafted (reference quality, job tier,
 * expected option lines), counting only items whose gear level ≤ this recipe's (usable no later than the new item).
 * The value is per hunter (gearScore / expectedGearScore, M5), so the stock is returned as a list.
 */
interface Covered { item: GearInstance; def: GearDef; job: boolean }

function coveredStock(config: GameConfig, world: World, gear: GearDef, refQualityId: string): Covered[] {
  const out: Covered[] = [];
  for (const it of world.town.shop) {
    const d = config.index.gear.get(it.gearId);
    if (d && d.slot === gear.slot && d.level <= gear.level) out.push({ item: it, def: d, job: false });
  }
  for (const k in world.town.crafting) {
    const job = world.town.crafting[k];
    const d = job ? config.index.gear.get(job.gearId) : undefined;
    if (job && d && d.slot === gear.slot && d.level <= gear.level) {
      out.push({ item: { uid: '', gearId: d.id, qualityId: refQualityId, enhance: 0, difficultyId: job.difficultyId }, def: d, job: true });
    }
  }
  return out;
}

/** Best value of the covered stock for one hunter (0 when there is none). */
function coveredValue(config: GameConfig, h: Hunter, stock: readonly Covered[]): number {
  let v = 0;
  for (const c of stock) {
    const x = c.job ? expectedGearScore(config, h, c.def, gearMainValue(config, c.item)) : gearScore(config, h, c.item, c.def.slot);
    if (x > v) v = x;
  }
  return v;
}

/**
 * Number of hunters (level ≥ gear.level − craftLevelAhead) who would probably buy this recipe's output at gear tier
 * `difficultyId` (default base). A hunter counts when, summed over the craft qualities, the craftChance of the rolls
 * that are an upgrade of ≥ minUpgradeGain over their slot value AND that they can afford (shop budget ≥
 * craftAffordFrac × that quality's list price at this tier) reaches craftMinSellChance. Gain uses the same formula as the
 * AI's shop purchase: (new − ref) / max(ref, 1).
 * Judging every roll, not just the Rare one, keeps auto-craft from making gear whose likely Common/Uncommon roll is
 * no upgrade, or that nobody can pay for, which then sits unsold and is dismantled.
 *
 * Stock already on sale / being crafted (same slot, gear level ≤ recipe) is counted by copies: hunters who would
 * still gain over max(slot value, best stocked value) always count; hunters the stock already serves count only
 * beyond the number of stocked copies (each copy serves one hunter).
 */
export function recipeBeneficiaries(ctx: SystemContext, gear: GearDef, difficultyId?: string): number {
  const { config, world } = ctx;
  const refQ = referenceQuality(config);
  if (!refQ) return 0;
  const stock = coveredStock(config, world, gear, refQ.id);
  const all = countUpgrades(config, world, gear, null, difficultyId);
  if (stock.length === 0) return all;
  const beyond = countUpgrades(config, world, gear, stock, difficultyId);
  return beyond + Math.max(0, all - beyond - stock.length);
}

/**
 * Like recipeBeneficiaries but ignoring what is already on sale or being crafted: how many hunters this
 * recipe would upgrade at all. Drives the Trading Post's automatic material requests, so materials for
 * the next copies are bought while the current one is still on the shelf.
 */
export function recipeWanters(config: GameConfig, world: World, gear: GearDef, difficultyId?: string): number {
  return countUpgrades(config, world, gear, null, difficultyId);
}

/**
 * Tier the Trading Post requests materials for (trading.autoMaterialDemand): the highest craftable tier (craftTiers)
 * at which the recipe upgrades someone (recipeWanters ≥ 1), with that wanter count; null when no tier has a wanter.
 */
export function demandTier(config: GameConfig, world: World, gear: GearDef): { difficultyId: string; wanters: number } | null {
  const tiers = craftTiers(config, world);
  for (let i = tiers.length - 1; i >= 0; i--) {
    const w = recipeWanters(config, world, gear, tiers[i]!.id);
    if (w > 0) return { difficultyId: tiers[i]!.id, wanters: w };
  }
  return null;
}

export type DemandTier = { difficultyId: string; wanters: number } | null;

/**
 * Memo of demandTiers (TECH_SPEC §10), two levels, both validated by value on every call:
 *  - per world: the whole result, with the craftable flag of each recipe (gearCraftable), the craftable tier ids
 *    (craftTiers) and per hunter in world order its object, level, budget bucket and steady stats object;
 *  - per hunter: whether it wants each (recipe, tier) (countUpgrades' per-hunter test, filled lazily), valid while its
 *    level, budget bucket and steady stats object are unchanged. The steady stats object (statsCache.ts) covers the slot
 *    values and set shares the test reads; the budget (gold × spendRatio × personality) only matters through its
 *    position among the roll budgets (budgetBucket). When one hunter's gold crosses a bucket only its own table refills.
 */
interface DemandMemo {
  config: GameConfig;
  craftable: boolean[];
  tiers: string[];
  hunters: (Hunter | number | object)[];
  out: readonly DemandTier[];
}

interface HunterDemand {
  config: GameConfig;
  level: number;
  bucket: number;
  stats: object;
  /** recipe → tier id → wants. */
  wants: Map<GearDef, Map<string, boolean>>;
}

const demandMemo = new WeakMap<World, DemandMemo>();
const hunterDemand = new WeakMap<Hunter, HunterDemand>();

/**
 * demandTier of every recipe in config.gear order, null for recipes the craft building cannot make yet
 * (gearCraftable) or that nobody wants. Same results as calling gearCraftable + demandTier per recipe; memoised (see
 * DemandMemo) because the AI asks for the Trading Post demand at every decision. TH_VERIFY_CACHES=1 recomputes with
 * demandTier on every call and throws on a mismatch.
 */
export function demandTiers(config: GameConfig, world: World): readonly DemandTier[] {
  const craftable = config.gear.map((g) => gearCraftable(config, world, g));
  const tierDefs = craftTiers(config, world);
  const tiers = tierDefs.map((d) => d.id);
  const f = config.formula;
  const thresholds = budgetThresholds(config);
  const hunters: (Hunter | number | object)[] = [];
  const rows: { h: Hunter; budget: number; stats: EffectiveStats; e: HunterDemand }[] = [];
  for (const h of world.hunters) {
    // Same expression as countUpgrades.
    const budget = h.gold * f.spendRatio * personalityFactor(config, h, 'spendRatio');
    const bucket = budgetBucket(thresholds, budget);
    const stats = hunterStats(config, h, { steady: true });
    hunters.push(h, h.level, bucket, stats);
    let e = hunterDemand.get(h);
    if (!e || e.config !== config || e.level !== h.level || e.bucket !== bucket || e.stats !== stats) {
      e = { config, level: h.level, bucket, stats, wants: new Map() };
      hunterDemand.set(h, e);
    }
    rows.push({ h, budget, stats, e });
  }
  const m = demandMemo.get(world);
  let out: readonly DemandTier[];
  if (m && m.config === config && sameList(m.craftable, craftable) && sameList(m.tiers, tiers) && sameList(m.hunters, hunters)) {
    out = m.out;
  } else {
    out = Object.freeze(config.gear.map((g, i) => {
      if (!craftable[i]) return null;
      // demandTier: highest craftable tier with a wanter (recipeWanters = countUpgrades without stock).
      for (let t = tiers.length - 1; t >= 0; t--) {
        const rolls = craftRolls(config, g, tiers[t]);
        if (!rolls) continue;
        let w = 0;
        for (const r of rows) {
          if (r.h.level < g.level - f.craftLevelAhead) continue;
          let byTier = r.e.wants.get(g);
          if (!byTier) { byTier = new Map(); r.e.wants.set(g, byTier); }
          let want = byTier.get(tiers[t]!);
          if (want === undefined) {
            want = hunterWants(config, r.h, r.stats, r.budget, g, rolls, null);
            byTier.set(tiers[t]!, want);
          }
          if (want) w++;
        }
        if (w > 0) return { difficultyId: tiers[t]!, wanters: w };
      }
      return null;
    }));
    demandMemo.set(world, { config, craftable, tiers, hunters, out });
  }
  if (cacheVerifyEnabled()) {
    const fresh = config.gear.map((g, i) => (craftable[i] ? demandTier(config, world, g) : null));
    if (fresh.some((t, i) => t?.difficultyId !== out[i]?.difficultyId || t?.wanters !== out[i]?.wanters)) {
      throw new Error('demandTiers: stale value: an input is missing from the snapshot');
    }
  }
  return out;
}

/** Every positive craft-roll minBudget of every recipe at every tier, sorted ascending (config only, cached). */
const thresholdsCache = new WeakMap<GameConfig, { formula: GameConfig['formula']; list: number[] }>();

function budgetThresholds(config: GameConfig): number[] {
  const c = thresholdsCache.get(config);
  if (c && c.formula === config.formula) return c.list;
  const set = new Set<number>();
  for (const g of config.gear) {
    for (const d of config.difficulties) for (const r of craftRolls(config, g, d.id) ?? []) if (r.minBudget > 0) set.add(r.minBudget);
  }
  const list = [...set].sort((a, b) => a - b);
  thresholdsCache.set(config, { formula: config.formula, list });
  return list;
}

/**
 * Number of thresholds ≤ budget. Two budgets in the same bucket compare the same way against every threshold, so
 * countUpgrades' `budget < minBudget` tests give the same results for both.
 */
function budgetBucket(list: readonly number[], budget: number): number {
  if (Number.isNaN(budget)) return -1;
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]! <= budget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

interface CraftRoll { chance: number; value: number; minBudget: number }

/** Config-only roll table per (recipe, tier), cached per (config, formula) object (TECH_SPEC §10). Null when no quality can roll. */
const rollsCache = new WeakMap<GameConfig, { formula: GameConfig['formula']; byGear: Map<GearDef, Map<string, CraftRoll[] | null>> }>();

function craftRolls(config: GameConfig, gear: GearDef, difficultyId?: string): CraftRoll[] | null {
  let c = rollsCache.get(config);
  if (!c || c.formula !== config.formula) { c = { formula: config.formula, byGear: new Map() }; rollsCache.set(config, c); }
  const tier = tierDef(config, difficultyId).id;
  let byTier = c.byGear.get(gear);
  if (!byTier) { byTier = new Map(); c.byGear.set(gear, byTier); }
  const hit = byTier.get(tier);
  if (hit !== undefined) return hit;
  const f = config.formula;
  let total = 0;
  for (const q of config.qualities) total += Math.max(0, q.craftChance);
  const rolls = total <= 0 ? null : config.qualities.map((q) => ({
    chance: Math.max(0, q.craftChance) / total,
    value: gearMainValue(config, { uid: '', gearId: gear.id, qualityId: q.id, enhance: 0, difficultyId: tier }),
    // Hunters who could not come close to paying do not count: that gear just gets dismantled later,
    // wasting the craft gold and the materials bought for it.
    minBudget: (f.craftAffordFrac ?? 0) * craftListPrice(config, gear, q, tier),
  }));
  byTier.set(tier, rolls);
  return rolls;
}

/**
 * Hunters for whom this recipe's sellable rolls (see recipeBeneficiaries) reach craftMinSellChance, judged over
 * max(slot value, best covered stock for them). Roll values are the quality's main value + the hunter's expected
 * option lines / set bonus (formulas.expectedGearExtra, M5).
 */
function countUpgrades(config: GameConfig, world: World, gear: GearDef, covered: readonly Covered[] | null, difficultyId?: string): number {
  const f = config.formula;
  const rolls = craftRolls(config, gear, difficultyId);
  if (!rolls) return 0;
  let n = 0;
  for (const h of world.hunters) {
    if (h.level < gear.level - f.craftLevelAhead) continue;
    const budget = h.gold * f.spendRatio * personalityFactor(config, h, 'spendRatio');
    if (hunterWants(config, h, hunterStats(config, h, { steady: true }), budget, gear, rolls, covered)) n++;
  }
  return n;
}

/** countUpgrades' test for one hunter (level filter already passed); `s` = its steady stats, `budget` its shop budget. */
function hunterWants(
  config: GameConfig, h: Hunter, s: EffectiveStats, budget: number, gear: GearDef, rolls: readonly CraftRoll[], covered: readonly Covered[] | null,
): boolean {
  const f = config.formula;
  const minChance = f.craftMinSellChance ?? 0;
  const ref = Math.max(slotValueFor(config, h, s, gear.slot), covered ? coveredValue(config, h, covered) : 0);
  const extra = expectedGearExtraFor(config, h, s, gear);
  let chance = 0;
  for (const r of rolls) {
    if (r.minBudget > 0 && budget < r.minBudget) continue;
    if ((r.value + extra - ref) / Math.max(ref, 1) >= f.minUpgradeGain) chance += r.chance;
  }
  return chance > 0 && chance >= minChance - 1e-9;
}

/**
 * Auto-craft choice: among this building's recipes its level allows (gear level cap) at every craftable gear tier
 * (gearTier.craftTiers), with the tier's materials in storage and town gold ≥ craft cost + autoCraftReserve, pick the
 * (recipe, tier) that benefits the most hunters (recipeBeneficiaries), then higher tier, then higher gear level, then
 * gearId. Null when it would help nobody (no junk).
 */
export function pickCraft(ctx: SystemContext, buildingId: string): { gear: GearDef; difficultyId: string } | null {
  const { world, config } = ctx;
  const reserve = autoCraftReserve(config, world);
  const tiers = craftTiers(config, world);
  let best: { gear: GearDef; difficultyId: string; order: number } | null = null;
  let bestN = 0;
  for (const g of config.gear) {
    if (g.craftBuilding !== buildingId || !gearCraftable(config, world, g)) continue;
    for (const t of tiers) {
      if (!hasMaterials(world, g, config, t.id)) continue;
      if (world.town.gold < craftGoldCost(config, g, t.id) + reserve) continue;
      const n = recipeBeneficiaries(ctx, g, t.id);
      if (n <= 0) continue;
      const b = best;
      const better = !b || n > bestN || (n === bestN && (t.order > b.order || (t.order === b.order &&
        (g.level > b.gear.level || (g.level === b.gear.level && g.id < b.gear.id)))));
      if (better) {
        best = { gear: g, difficultyId: t.id, order: t.order };
        bestN = n;
      }
    }
  }
  return best ? { gear: best.gear, difficultyId: best.difficultyId } : null;
}

/** The recipe pickCraft would start (at whichever tier it picks). */
export function pickRecipe(ctx: SystemContext, buildingId: string): GearDef | null {
  return pickCraft(ctx, buildingId)?.gear ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// Dismantle, reclaim and Town gear storage (TECH_SPEC §5.8).
// ---------------------------------------------------------------------------------------------------------------

/**
 * Materials an item gives back when dismantled: floor(count × dismantleReturnFrac) of every material of its recipe at
 * its tier (incl. essence), zero counts left out. Deterministic (no RNG).
 */
export function dismantleYield(config: GameConfig, g: GearInstance): Record<string, number> {
  const def = config.index.gear.get(g.gearId);
  const out: Record<string, number> = {};
  if (!def) return out;
  const frac = Math.max(0, config.formula.dismantleReturnFrac ?? 0);
  for (const m of recipeMaterials(config, def, g.difficultyId)) {
    const n = Math.floor(m.count * frac + 1e-9);
    if (n > 0) out[m.materialId] = (out[m.materialId] ?? 0) + n;
  }
  return out;
}

/**
 * Dismantle an item already taken out of the shop/storage: its dismantleYield goes to Town Storage, `gearDismantled`
 * stat + event. A shop item that yields nothing (e.g. dismantleReturnFrac 0) is reported as gearScrapped instead, as
 * before dismantling existed (the two are exclusive per item). Returns the materials given back.
 */
export function dismantleItem(ctx: SystemContext, g: GearInstance, source: 'shop' | 'storage' | 'command'): Record<string, number> {
  const { world, config } = ctx;
  const mats = dismantleYield(config, g);
  const ids = Object.keys(mats).sort();
  if (ids.length === 0 && source === 'shop') {
    world.stats.gearScrapped = (world.stats.gearScrapped ?? 0) + 1;
    const price = (g as Partial<ShopItem>).price ?? 0;
    ctx.events.emit(world.tick, { type: 'gearScrapped', itemUid: g.uid, gearId: g.gearId, qualityId: g.qualityId, price });
    return mats;
  }
  storeOrExport(ctx, mats); // up to the Town Storage cap, the rest exported for Town gold (TECH_SPEC §5.7)
  world.stats.gearDismantled = (world.stats.gearDismantled ?? 0) + 1;
  ctx.events.emit(world.tick, {
    type: 'gearDismantled', itemUid: g.uid, gearId: g.gearId, qualityId: g.qualityId, difficultyId: g.difficultyId, source, materials: mats,
  });
  return mats;
}

function gearStorage(world: World): GearInstance[] {
  return world.town.gearStorage ?? (world.town.gearStorage = []);
}

/** Dismantle the oldest stored items beyond gearStorageMax. */
export function trimGearStorage(ctx: SystemContext): void {
  const store = gearStorage(ctx.world);
  const max = Math.max(0, Math.floor(ctx.config.formula.gearStorageMax ?? 0));
  while (store.length > max) dismantleItem(ctx, store.shift()!, 'storage');
}

/**
 * Reclaim (TECH_SPEC §5.8): unequip all of a hunter's gear into Town gear storage, keeping quality, enhance and tier
 * (an item without a tier gets the base tier). Called by progression.reincarnate and the `hunter.reclaimGear` command.
 * No-op on a context without a Town (offline projection stubs). Returns the number of items reclaimed.
 */
export function reclaimGear(ctx: SystemContext, h: Hunter, reason: 'reincarnation' | 'command' = 'reincarnation'): number {
  const { world, config } = ctx;
  if (!world?.town) return 0;
  const store = gearStorage(world);
  const uids: string[] = [];
  for (const slot of GEAR_SLOTS) {
    const g = h.equipment[slot];
    if (!g) continue;
    store.push(copyGearDepth({ uid: g.uid, gearId: g.gearId, qualityId: g.qualityId, enhance: g.enhance, difficultyId: g.difficultyId ?? baseTier(config) }, g));
    uids.push(g.uid);
    delete h.equipment[slot];
  }
  if (uids.length === 0) return 0;
  world.stats.gearReclaimed = (world.stats.gearReclaimed ?? 0) + uids.length;
  ctx.events.emit(world.tick, { type: 'gearReclaimed', hunterId: h.id, itemUids: uids, reason });
  trimGearStorage(ctx);
  return uids.length;
}

/** Player command: reclaim a hunter's gear now (current HP clamps to the gear-less max). */
export function reclaimHunterGear(ctx: SystemContext, h: Hunter): string | null {
  if (reclaimGear(ctx, h, 'command') === 0) return 'nothing equipped';
  h.needs.hp = Math.min(h.needs.hp, hunterStats(ctx.config, h).hp);
  return null;
}

/**
 * Hunters who would buy this stored item if it were on sale: level ≥ gear level, shop budget (gold × spendRatio ×
 * personality) ≥ craftAffordFrac × its list price, and main value ≥ minUpgradeGain over max(slot value, best same-slot
 * item on sale they could wear) — the AI's purchase rule (ai/utility.bestShopPurchase).
 */
export function storedGearBuyers(config: GameConfig, world: World, g: GearInstance): number {
  const def = config.index.gear.get(g.gearId);
  if (!def) return 0;
  const f = config.formula;
  const minBudget = (f.craftAffordFrac ?? 0) * gearListPrice(config, g);
  let n = 0;
  for (const h of world.hunters) {
    if (h.level < def.level) continue;
    if (h.gold * f.spendRatio * personalityFactor(config, h, 'spendRatio') < minBudget) continue;
    const value = gearScore(config, h, g, def.slot);
    let ref = slotValue(config, h, def.slot);
    for (const it of world.town.shop) {
      const d = config.index.gear.get(it.gearId);
      if (d && d.slot === def.slot && d.level <= h.level) ref = Math.max(ref, gearScore(config, h, it, d.slot));
    }
    if ((value - ref) / Math.max(ref, 1) >= f.minUpgradeGain) n++;
  }
  return n;
}

/** Put a stored item on sale at gearListPrice (normal markdown/dismantle schedule). Null on success, else the reason. */
export function listStoredGear(ctx: SystemContext, uid: string): string | null {
  const { world, config } = ctx;
  const store = gearStorage(world);
  const i = store.findIndex((x) => x.uid === uid);
  if (i < 0) return 'unknown stored item';
  if (!config.index.gear.has(store[i]!.gearId)) return 'unknown gear';
  if (!shopHasRoom(world, config)) return 'shop is full';
  const g = store.splice(i, 1)[0]!;
  const price = gearListPrice(config, g);
  world.town.shop.push({ ...g, price, listPrice: price, listedAtMs: world.timeMs });
  world.stats.gearRelisted = (world.stats.gearRelisted ?? 0) + 1;
  ctx.events.emit(world.tick, { type: 'gearRelisted', itemUid: g.uid, gearId: g.gearId, price });
  return null;
}

/** Player command: dismantle a stored item now. */
export function dismantleStoredGear(ctx: SystemContext, uid: string): string | null {
  const store = gearStorage(ctx.world);
  const i = store.findIndex((x) => x.uid === uid);
  if (i < 0) return 'unknown stored item';
  dismantleItem(ctx, store.splice(i, 1)[0]!, 'command');
  return null;
}

/**
 * Auto-craft companion: when the shop has room, put the stored item with the most storedGearBuyers (≥ 1; ties → the
 * oldest) on sale. Items nobody can wear or gain from stay in storage (listing them would only run the markdown
 * clock down to dismantling). At most one per call.
 */
export function autoListStoredGear(ctx: SystemContext): void {
  const { world, config } = ctx;
  const store = world.town.gearStorage;
  if (!store || store.length === 0 || !shopHasRoom(world, config)) return;
  let best: GearInstance | null = null;
  let bestN = 0;
  for (const g of store) {
    const n = storedGearBuyers(config, world, g);
    if (n > bestN) { best = g; bestN = n; }
  }
  if (best) listStoredGear(ctx, best.uid);
}

/** Craft buildings (GDD §6): turn Town Storage materials into shop gear of a rolled quality at a gear tier. */
export const craftingSystem: System = {
  name: 'crafting',
  update(ctx) {
    const { world, config, dtMs } = ctx;
    // Unsold at scrap age: dismantled into materials (or scrapped when nothing comes back).
    for (const it of updateShopTurnover(world, config)) dismantleItem(ctx, it, 'shop');
    // Reclaimed gear goes back on sale first (free for the Town) when someone would buy it.
    if (world.town.autoCraft) autoListStoredGear(ctx);
    const cap = shopCapacity(config, world);
    for (const b of config.buildings) {
      if (b.kind !== 'craft' || buildingLevel(world, b.id) < 1) continue;
      const job = world.town.crafting[b.id] ?? null;
      if (world.town.crafting[b.id] === undefined) world.town.crafting[b.id] = null; // old saves

      if (job) {
        job.remainingMs = Math.max(0, job.remainingMs - dtMs);
        if (job.remainingMs > 0 || world.town.shop.length >= cap) continue; // hold until there is room
        const gear = config.index.gear.get(job.gearId);
        if (gear) {
          const q = ctx.rng.weighted(config.qualities, (x) => x.craftChance);
          // M5 (TECH_SPEC §4.2): grade + option lines, drawn right after the quality.
          const depth = rollGearOptions(config, ctx.rng, gear.slot);
          const uid = 'g' + world.nextId++;
          const tier = tierDef(config, job.difficultyId).id;
          const price = craftListPrice(config, gear, q, tier, depth.gradeId);
          const item: ShopItem = { uid, gearId: gear.id, qualityId: q.id, enhance: 0, difficultyId: tier, price, listPrice: price, listedAtMs: world.timeMs };
          world.town.shop.push(copyGearDepth(item, depth as GearInstance));
          world.stats.crafted += 1;
          ctx.events.emit(world.tick, {
            type: 'gearCrafted', buildingId: b.id, itemUid: uid, gearId: gear.id, qualityId: q.id, difficultyId: tier,
            ...(depth.gradeId ? { gradeId: depth.gradeId } : {}),
          });
        }
        world.town.crafting[b.id] = null;
        continue; // start the next one on a later tick
      }

      if (!world.town.autoCraft || !shopHasRoom(world, config)) continue;
      const pick = pickCraft(ctx, b.id);
      if (pick) startCraft(ctx, b.id, pick.gear.id, pick.difficultyId);
    }
  },
};
