/**
 * Trading Post material requests (GDD §5 "Trading Post: material requests").
 *
 * The post only buys REQUESTED materials:
 *  - automatic requests, derived every time from auto-craft needs (never stored): for every recipe that
 *    would upgrade w ≥ 1 hunters (recipeWanters, at the highest craftable gear tier with a wanter: crafting.demandTier),
 *    keep materials (incl. that tier's essence) for min(w, requestMaxCopies) crafts in Town Storage; plus the auto-investment plan and the
 *    essential supply/potion materials (TECH_SPEC §5.14); the request is whatever storage lacks;
 *  - player requests (`town.requests`, set by the `town.requestMaterial` command), on top of the automatic
 *    ones and decremented as hunters sell.
 * Unrequested materials (anything beyond the request) are never stored, so storage cannot pile up:
 *  - while town gold is above surplusFloor (tradeSurplusFloorMul × autoCraftReserve) the post buys them at a
 *    heavy discount (surplusPrice) "for export" — a rich town recycles gold to hunters, a poor one keeps it;
 *  - otherwise the hunter discards them at the post.
 */
import type { GameConfig, ZoneDef } from '../config/types';
import type { SystemContext } from '../system';
import type { World } from '../world';
import { autoCraftReserve, demandTiers } from './crafting';
import { recipeMaterials } from './gearTier';
import { supplyMaterialNeed } from './supplies';
import { extraRequestCopies, investMaterialNeed, storageCapacity, surplusPriceMul } from './town';

export type Demand = Record<string, number>;

/**
 * Materials crafting and investment want in storage (full counts, storage not subtracted): auto-craft needs (when
 * auto-craft is on; only recipes the craft building's level allows; copies = requestMaxCopies + Storehouse requestCopies)
 * plus the materials of the auto-investment plan (TECH_SPEC §5.12, when auto-invest is on). Supplies use it to keep their
 * fallback tiers off these units (systems/supplies.ts).
 */
export function baseMaterialNeed(config: GameConfig, world: World): Demand {
  const need: Demand = {};
  const copies = Math.max(0, Math.floor(config.formula.requestMaxCopies)) + (copiesBonus(config, world));
  if (world.town.autoCraft && copies > 0) {
    // Gear tiers (TECH_SPEC §5.8): materials (incl. essence) of the highest craftable tier someone wants, per craftable
    // recipe (crafting.demandTiers = gearCraftable + demandTier per recipe, memoised: TECH_SPEC §10).
    const tiers = demandTiers(config, world);
    for (let i = 0; i < config.gear.length; i++) {
      const g = config.gear[i]!;
      const t = tiers[i];
      if (!t) continue;
      const n = Math.min(t.wanters, copies);
      for (const m of recipeMaterials(config, g, t.difficultyId)) need[m.materialId] = (need[m.materialId] ?? 0) + m.count * n;
    }
  }
  const invest = investMaterialNeed(config, world);
  for (const id in invest) need[id] = (need[id] ?? 0) + invest[id]!;
  return need;
}

/**
 * Automatic requests: baseMaterialNeed plus the essential supply/potion materials (supplies.supplyMaterialNeed, TECH_SPEC
 * §5.14; requested even with auto-craft off), minus what storage already holds.
 */
export function autoMaterialDemand(config: GameConfig, world: World): Demand {
  const need = baseMaterialNeed(config, world);
  const supply = supplyMaterialNeed(config, world);
  for (const id in supply) need[id] = (need[id] ?? 0) + supply[id]!;
  const out: Demand = {};
  for (const id of Object.keys(need).sort()) {
    const lack = need[id]! - (world.town.storage[id] ?? 0);
    if (lack > 0) out[id] = lack;
  }
  return out;
}

/**
 * Order in which the Trading Post pays for a bag (economy.doSell): materials the supplies still lack (essential, TECH_SPEC
 * §5.14) first, then the rest, each group by material id. When Town gold runs short the essentials are bought first.
 */
export function sellOrder(config: GameConfig, world: World, bag: Record<string, number>): string[] {
  const supply = supplyMaterialNeed(config, world);
  const ids = Object.keys(bag).sort();
  const essential = (id: string) => (supply[id] ?? 0) > (world.town.storage[id] ?? 0);
  return [...ids.filter(essential), ...ids.filter((id) => !essential(id))];
}

/** Units of each material the Trading Post will buy right now: automatic + player requests. */
export function materialDemand(config: GameConfig, world: World): Demand {
  const out = autoMaterialDemand(config, world);
  const player = world.town.requests ?? {};
  for (const id in player) {
    const n = player[id] ?? 0;
    if (n > 0) out[id] = (out[id] ?? 0) + n;
  }
  return out;
}

/** Gold a hunter receives per unit sold: round(price × (1 − tradeSaleTax)). The town pays the same amount. */
export function salePrice(config: GameConfig, materialId: string): number {
  const price = config.index.materials.get(materialId)?.price ?? 0;
  return Math.round(price * (1 - config.formula.tradeSaleTax));
}

function copiesBonus(config: GameConfig, world: World): number {
  return Math.max(0, Math.floor(config.formula.requestMaxCopies)) > 0 ? extraRequestCopies(config, world) : 0;
}

/**
 * Discount price for unrequested units: round(price × tradeSurplusPriceFrac × Trading Post surplusPriceMul × (1 − tradeSaleTax))
 * (the multiplier is 1 without `world`).
 */
export function surplusPrice(config: GameConfig, materialId: string, world?: World): number {
  const f = config.formula;
  const price = config.index.materials.get(materialId)?.price ?? 0;
  const mul = world ? surplusPriceMul(config, world) : 1;
  return Math.round(price * f.tradeSurplusPriceFrac * mul * (1 - f.tradeSaleTax));
}

/** Town gold the post never spends on unrequested units: tradeSurplusFloorMul × autoCraftReserve. */
export function surplusFloor(config: GameConfig, world: World): number {
  return config.formula.tradeSurplusFloorMul * autoCraftReserve(config, world);
}

/**
 * Town treasury target: max(feeTownTargetMin, feeTownTargetMul × autoCraftReserve). Tier-relative like the surplus
 * floor, so it grows with the materials the town has to buy; the minimum keeps early-game fees in the town.
 */
export function townGoldTarget(config: GameConfig, world: World): number {
  const f = config.formula;
  return Math.max(f.feeTownTargetMin ?? 0, (f.feeTownTargetMul ?? 0) * autoCraftReserve(config, world));
}

/**
 * Share of a forge/academy fee the town keeps right now: feeTownShare while town gold ≤ townGoldTarget, then
 * feeTownShare × target / townGold (halved at 2 × target). The rest leaves the economy. This is the restoring force
 * on town gold: above the surplus floor the post already exports every unrequested unit, so without it any surplus of
 * fee + service + shop income over material purchases piles up without bound (feeTownTargetMul 0 = constant share).
 */
export function townFeeShare(config: GameConfig, world: World): number {
  const f = config.formula;
  if (!(f.feeTownTargetMul > 0) && !(f.feeTownTargetMin > 0)) return f.feeTownShare;
  const target = townGoldTarget(config, world);
  const gold = world.town.gold;
  return gold <= target ? f.feeTownShare : (f.feeTownShare * target) / gold;
}

/** Town gold available for unrequested (surplus) purchases right now. */
export function surplusBudget(config: GameConfig, world: World): number {
  return Math.max(0, world.town.gold - surplusFloor(config, world));
}

/**
 * Share (0..1) of a zone's expected drop value (monster weight × drop chance × material price) that is
 * currently requested. Used by the AI to prefer zones that drop what the town needs.
 */
export function requestedDropShare(config: GameConfig, zone: ZoneDef, demand: Demand): number {
  let total = 0;
  let wanted = 0;
  for (const zm of zone.monsters) {
    const def = config.index.monsters.get(zm.monsterId);
    if (!def) continue;
    for (const d of def.drops) {
      const v = zm.weight * d.chance * (config.index.materials.get(d.materialId)?.price ?? 0);
      total += v;
      if ((demand[d.materialId] ?? 0) > 0) wanted += v;
    }
  }
  return total > 0 ? wanted / total : 0;
}

/** Hunt score multiplier for a zone: 1 + requestZoneBonus × requestedDropShare. */
export function requestZoneMul(config: GameConfig, zone: ZoneDef, demand: Demand): number {
  return 1 + config.formula.requestZoneBonus * requestedDropShare(config, zone, demand);
}

/**
 * True when the post would pay for at least one bag unit: a requested unit the town can afford, or an
 * unrequested one within the surplus budget (a sell goal that earns nothing is never offered).
 */
export function bagHasSellable(config: GameConfig, world: World, bag: Record<string, number>, demand: Demand): boolean {
  let budget: number | null = null;
  for (const id in bag) {
    const have = bag[id] ?? 0;
    if (have <= 0) continue;
    const want = demand[id] ?? 0;
    if (want > 0 && world.town.gold >= salePrice(config, id)) return true;
    if (have > want) {
      const p = surplusPrice(config, id, world);
      budget ??= surplusBudget(config, world);
      if (p > 0 && budget >= p) return true;
    }
  }
  return false;
}

/** Units in the bag beyond the request (the post would buy them as surplus or discard them): Σ max(0, have − demand). */
export function bagUnrequested(bag: Record<string, number>, demand: Demand): number {
  let n = 0;
  for (const id in bag) n += Math.max(0, (bag[id] ?? 0) - (demand[id] ?? 0));
  return n;
}

// ---------------------------------------------------------------------------------------------------------------
// Town Storage cap (TECH_SPEC §5.7): storageCapBase + Storehouse storageCap[level] material units.
// ---------------------------------------------------------------------------------------------------------------

/** Material units in Town Storage. */
export function storageUnits(world: World): number {
  let n = 0;
  for (const k in world.town.storage) n += world.town.storage[k]!;
  return n;
}

/** Units Town Storage can still take (Infinity without a cap). */
export function storageRoom(config: GameConfig, world: World): number {
  return Math.max(0, storageCapacity(config, world) - storageUnits(world));
}

/**
 * Put materials into Town Storage up to its room (id order); the rest is sold for export at surplusPrice into Town gold
 * (dismantle returns: "surplus to gold"). Stats `storageExported` / `storageExportGold`, event `storageExported`
 * (only when something was exported). Returns the gold.
 */
export function storeOrExport(ctx: SystemContext, mats: Record<string, number>): number {
  const { world, config } = ctx;
  let room = storageRoom(config, world);
  const out: Record<string, number> = {};
  for (const id of Object.keys(mats).sort()) {
    const n = mats[id]!;
    const keep = Math.min(n, room);
    if (keep > 0) { world.town.storage[id] = (world.town.storage[id] ?? 0) + keep; room -= keep; }
    if (n > keep) out[id] = n - keep;
  }
  return exportUnits(ctx, out);
}

function exportUnits(ctx: SystemContext, out: Record<string, number>): number {
  const { world, config } = ctx;
  let units = 0;
  let gold = 0;
  for (const id in out) { units += out[id]!; gold += out[id]! * surplusPrice(config, id, world); }
  if (units <= 0) return 0;
  world.town.gold += gold;
  world.stats.storageExported = (world.stats.storageExported ?? 0) + units;
  world.stats.storageExportGold = (world.stats.storageExportGold ?? 0) + gold;
  ctx.events.emit(world.tick, { type: 'storageExported', materials: out, units, gold });
  return gold;
}

/**
 * Export up to `units` Town Storage units no request needs (storage − (baseMaterialNeed + supplies + player requests)),
 * the material with the most spare units first (ties: id), at surplusPrice into Town gold. Needed units are never
 * exported. Returns the units exported.
 */
export function exportSpare(ctx: SystemContext, units: number): number {
  const { world, config } = ctx;
  if (!(units > 0)) return 0;
  const need = baseMaterialNeed(config, world);
  const supply = supplyMaterialNeed(config, world);
  const player = world.town.requests ?? {};
  const st = world.town.storage;
  const spare = Object.keys(st).map((id) => ({ id, n: st[id]! - (need[id] ?? 0) - (supply[id] ?? 0) - (player[id] ?? 0) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: Record<string, number> = {};
  let left = units;
  for (const x of spare) {
    if (left <= 0) break;
    const k = Math.min(x.n, left);
    const rest = st[x.id]! - k;
    if (rest > 0) st[x.id] = rest;
    else delete st[x.id];
    out[x.id] = k;
    left -= k;
  }
  exportUnits(ctx, out);
  return units - left;
}

/**
 * Room for `units` requested units: when storage is short of room, spare units are exported first (exportSpare), so a
 * storage filled with dismantle returns never turns requested materials away. Returns the room afterwards.
 */
export function ensureStorageRoom(ctx: SystemContext, units: number): number {
  const room = storageRoom(ctx.config, ctx.world);
  if (room >= units) return room;
  exportSpare(ctx, units - room);
  return storageRoom(ctx.config, ctx.world);
}

/** Over the cap (old saves with a pile, a cap lowered by config): exportSpare down to the cap. Returns units exported. */
export function exportStorageOverflow(ctx: SystemContext): number {
  return exportSpare(ctx, storageUnits(ctx.world) - storageCapacity(ctx.config, ctx.world));
}
