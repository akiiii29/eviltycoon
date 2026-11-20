/**
 * Trading Post material requests (GDD §5 "Trading Post: material requests").
 *
 * The post only buys REQUESTED materials:
 *  - automatic requests, derived every time from auto-craft needs (never stored): for every recipe that
 *    would upgrade w ≥ 1 hunters (recipeWanters), keep materials for min(w, requestMaxCopies) crafts in
 *    Town Storage; the request is whatever storage lacks;
 *  - player requests (`town.requests`, set by the `town.requestMaterial` command), on top of the automatic
 *    ones and decremented as hunters sell.
 * Unrequested materials (anything beyond the request) are never stored, so storage cannot pile up:
 *  - while town gold is above surplusFloor (tradeSurplusFloorMul × autoCraftReserve) the post buys them at a
 *    heavy discount (surplusPrice) "for export" — a rich town recycles gold to hunters, a poor one keeps it;
 *  - otherwise the hunter discards them at the post.
 */
import type { GameConfig, ZoneDef } from '../config/types';
import type { World } from '../world';
import { autoCraftReserve, recipeWanters } from './crafting';

export type Demand = Record<string, number>;

/** Automatic requests from auto-craft needs (empty when auto-craft is off). */
export function autoMaterialDemand(config: GameConfig, world: World): Demand {
  const need: Demand = {};
  if (!world.town.autoCraft) return need;
  const copies = Math.max(0, Math.floor(config.formula.requestMaxCopies));
  if (copies === 0) return need;
  for (const g of config.gear) {
    const w = recipeWanters(config, world, g);
    if (w <= 0) continue;
    const n = Math.min(w, copies);
    for (const m of g.materials) need[m.materialId] = (need[m.materialId] ?? 0) + m.count * n;
  }
  const out: Demand = {};
  for (const id of Object.keys(need).sort()) {
    const lack = need[id]! - (world.town.storage[id] ?? 0);
    if (lack > 0) out[id] = lack;
  }
  return out;
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

/** Discount price for unrequested units: round(price × tradeSurplusPriceFrac × (1 − tradeSaleTax)). */
export function surplusPrice(config: GameConfig, materialId: string): number {
  const f = config.formula;
  const price = config.index.materials.get(materialId)?.price ?? 0;
  return Math.round(price * f.tradeSurplusPriceFrac * (1 - f.tradeSaleTax));
}

/** Town gold the post never spends on unrequested units: tradeSurplusFloorMul × autoCraftReserve. */
export function surplusFloor(config: GameConfig, world: World): number {
  return config.formula.tradeSurplusFloorMul * autoCraftReserve(config, world);
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
      const p = surplusPrice(config, id);
      budget ??= surplusBudget(config, world);
      if (p > 0 && budget >= p) return true;
    }
  }
  return false;
}

/** Units in the bag that are not requested at all (they would be discarded at the post). */
export function bagUnrequested(bag: Record<string, number>, demand: Demand): number {
  let n = 0;
  for (const id in bag) if ((demand[id] ?? 0) <= 0) n += bag[id] ?? 0;
  return n;
}
