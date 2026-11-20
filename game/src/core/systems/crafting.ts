import type { GameConfig, GearDef, GearQualityDef } from '../config/types';
import { gearMainValue, slotValue } from '../formulas';
import { personalityFactor } from '../hunterFactory';
import type { System, SystemContext } from '../system';
import type { ShopItem, World } from '../world';

/** Max items on sale (from the shop building). */
export function shopCapacity(config: GameConfig): number {
  return config.index.buildings.get(config.index.shop)?.capacity ?? 0;
}

/** Number of craft jobs currently running (they will each need a shop slot). */
function runningJobs(world: World): number {
  let n = 0;
  for (const k in world.town.crafting) if (world.town.crafting[k]) n++;
  return n;
}

/** True when the shop can take one more item counting jobs already running. */
export function shopHasRoom(world: World, config: GameConfig): boolean {
  return world.town.shop.length + runningJobs(world) < shopCapacity(config);
}

export function hasMaterials(world: World, gear: GearDef): boolean {
  return gear.materials.every((m) => (world.town.storage[m.materialId] ?? 0) >= m.count);
}

/** Town gold paid to start crafting this gear: round(basePrice × craftGoldFrac). */
export function craftGoldCost(config: GameConfig, gear: GearDef): number {
  return Math.round(gear.basePrice * config.formula.craftGoldFrac);
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
 * (hundreds of gold) would otherwise block early crafting entirely.
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
  return 3 * max;
}

/**
 * Start a craft job in a craft building, consuming materials from Town Storage and
 * craftGoldCost from town gold. Returns null on success, else a rejection reason.
 */
export function startCraft(ctx: SystemContext, buildingId: string, gearId: string): string | null {
  const { world, config } = ctx;
  const b = config.index.buildings.get(buildingId);
  if (!b) return 'unknown building';
  if (b.kind !== 'craft') return 'not a craft building';
  const gear = config.index.gear.get(gearId);
  if (!gear || gear.craftBuilding !== buildingId) return 'gear not made here';
  if (world.town.crafting[buildingId]) return 'building is busy';
  if (!hasMaterials(world, gear)) return 'missing materials';
  if (!shopHasRoom(world, config)) return 'shop is full';
  const cost = craftGoldCost(config, gear);
  if (world.town.gold < cost) return 'not enough town gold';
  world.town.gold -= cost;
  for (const m of gear.materials) {
    const left = world.town.storage[m.materialId]! - m.count;
    if (left > 0) world.town.storage[m.materialId] = left;
    else delete world.town.storage[m.materialId];
  }
  world.town.crafting[buildingId] = { gearId, remainingMs: gear.craftSec * 1000 };
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
 * Shop turnover (deterministic, listing order): every shopStaleSec unsold the price drops by
 * shopMarkdownPct% of listPrice, never below round(listPrice × shopMarkdownFloor);
 * after shopScrapSec unsold the item is scrapped (removed, no refund).
 * The price is derived from the item's age each tick, so it is idempotent and save-safe.
 * Returns the items scrapped this call (the crafting system reports them as gearScrapped).
 */
export function updateShopTurnover(world: World, config: GameConfig): ShopItem[] {
  const f = config.formula;
  const staleMs = f.shopStaleSec * 1000;
  const scrapMs = f.shopScrapSec * 1000;
  const shop = world.town.shop;
  const scrapped: ShopItem[] = [];
  let w = 0;
  for (let r = 0; r < shop.length; r++) {
    const it = shop[r]!;
    const age = world.timeMs - it.listedAtMs;
    if (scrapMs > 0 && age >= scrapMs) {
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
 * Best value a same-slot item already on sale (actual quality) or being crafted (reference quality)
 * offers, counting only items whose gear level ≤ this recipe's (usable no later than the new item).
 */
function coveredValue(config: GameConfig, world: World, gear: GearDef, refQualityId: string): number {
  let v = 0;
  for (const it of world.town.shop) {
    const d = config.index.gear.get(it.gearId);
    if (d && d.slot === gear.slot && d.level <= gear.level) v = Math.max(v, gearMainValue(config, it));
  }
  for (const k in world.town.crafting) {
    const job = world.town.crafting[k];
    const d = job ? config.index.gear.get(job.gearId) : undefined;
    if (d && d.slot === gear.slot && d.level <= gear.level) {
      v = Math.max(v, gearMainValue(config, { uid: '', gearId: d.id, qualityId: refQualityId, enhance: 0 }));
    }
  }
  return v;
}

/**
 * Number of hunters (level ≥ gear.level − craftLevelAhead, shop budget ≥ craftAffordFrac × basePrice) for whom this recipe at reference quality
 * would be an upgrade of ≥ minUpgradeGain over max(their slot value, what is already covered).
 * Gain uses the same formula as the AI's shop purchase: (new − ref) / max(ref, 1).
 */
export function recipeBeneficiaries(ctx: SystemContext, gear: GearDef): number {
  return countUpgrades(ctx.config, ctx.world, gear, true);
}

/**
 * Like recipeBeneficiaries but ignoring what is already on sale or being crafted: how many hunters this
 * recipe would upgrade at all. Drives the Trading Post's automatic material requests, so materials for
 * the next copies are bought while the current one is still on the shelf.
 */
export function recipeWanters(config: GameConfig, world: World, gear: GearDef): number {
  return countUpgrades(config, world, gear, false);
}

function countUpgrades(config: GameConfig, world: World, gear: GearDef, useCovered: boolean): number {
  const f = config.formula;
  const refQ = referenceQuality(config);
  if (!refQ) return 0;
  const value = gearMainValue(config, { uid: '', gearId: gear.id, qualityId: refQ.id, enhance: 0 });
  const covered = useCovered ? coveredValue(config, world, gear, refQ.id) : 0;
  // Only hunters who could plausibly pay for it count (shop budget ≥ craftAffordFrac × basePrice): crafting
  // gear nobody can afford just gets it scrapped later, wasting the craft gold and the materials bought for it.
  const minBudget = (f.craftAffordFrac ?? 0) * gear.basePrice;
  let n = 0;
  for (const h of world.hunters) {
    if (h.level < gear.level - f.craftLevelAhead) continue;
    if (minBudget > 0 && h.gold * f.spendRatio * personalityFactor(config, h, 'spendRatio') < minBudget) continue;
    const ref = Math.max(slotValue(config, h, gear.slot), covered);
    if ((value - ref) / Math.max(ref, 1) >= f.minUpgradeGain) n++;
  }
  return n;
}

/**
 * Auto-craft choice: among this building's recipes with materials in storage and town gold ≥
 * craft cost + autoCraftReserve, pick the one that benefits the most hunters (recipeBeneficiaries),
 * then higher gear level, then gearId. Null when it would help nobody (no junk).
 */
export function pickRecipe(ctx: SystemContext, buildingId: string): GearDef | null {
  const { world, config } = ctx;
  const reserve = autoCraftReserve(config, world);
  let best: GearDef | null = null;
  let bestN = 0;
  for (const g of config.gear) {
    if (g.craftBuilding !== buildingId || !hasMaterials(world, g)) continue;
    if (world.town.gold < craftGoldCost(config, g) + reserve) continue;
    const n = recipeBeneficiaries(ctx, g);
    if (n <= 0) continue;
    const better = !best || n > bestN || (n === bestN && (g.level > best.level || (g.level === best.level && g.id < best.id)));
    if (better) {
      best = g;
      bestN = n;
    }
  }
  return best;
}

/** Craft buildings (GDD §6): turn Town Storage materials into shop gear of a rolled quality. */
export const craftingSystem: System = {
  name: 'crafting',
  update(ctx) {
    const { world, config, dtMs } = ctx;
    for (const it of updateShopTurnover(world, config)) {
      world.stats.gearScrapped = (world.stats.gearScrapped ?? 0) + 1;
      ctx.events.emit(world.tick, { type: 'gearScrapped', itemUid: it.uid, gearId: it.gearId, qualityId: it.qualityId, price: it.price });
    }
    const cap = shopCapacity(config);
    for (const b of config.buildings) {
      if (b.kind !== 'craft') continue;
      const job = world.town.crafting[b.id] ?? null;
      if (world.town.crafting[b.id] === undefined) world.town.crafting[b.id] = null; // old saves

      if (job) {
        job.remainingMs = Math.max(0, job.remainingMs - dtMs);
        if (job.remainingMs > 0 || world.town.shop.length >= cap) continue; // hold until there is room
        const gear = config.index.gear.get(job.gearId);
        if (gear) {
          const q = ctx.rng.weighted(config.qualities, (x) => x.craftChance);
          const uid = 'g' + world.nextId++;
          const price = Math.round(gear.basePrice * q.priceMult);
          world.town.shop.push({ uid, gearId: gear.id, qualityId: q.id, enhance: 0, price, listPrice: price, listedAtMs: world.timeMs });
          world.stats.crafted += 1;
          ctx.events.emit(world.tick, { type: 'gearCrafted', buildingId: b.id, itemUid: uid, gearId: gear.id, qualityId: q.id });
        }
        world.town.crafting[b.id] = null;
        continue; // start the next one on a later tick
      }

      if (!world.town.autoCraft || !shopHasRoom(world, config)) continue;
      const recipe = pickRecipe(ctx, b.id);
      if (recipe) startCraft(ctx, b.id, recipe.id);
    }
  },
};
