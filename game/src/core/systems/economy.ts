import type { GameConfig, GearSlot } from '../config/types';
import { hunterStats } from '../formulas';
import type { System, SystemContext } from '../system';
import { isAlive, type GearInstance, type Hunter, type ShopItem, type World } from '../world';
import { materialDemand, salePrice, surplusBudget, surplusPrice, townFeeShare } from './trading';
import { enhanceBonus } from './town';

/** Gold cost of the next enhance step for this gear, or null when it is already at max (or unknown). */
export function enhanceCost(config: GameConfig, g: GearInstance): number | null {
  const def = config.index.gear.get(g.gearId);
  const row = config.enhance[g.enhance]; // enhance[i] is the step to level i+1
  if (!def || !row) return null;
  return Math.round(def.basePrice * row.costFrac);
}

/** True when the hunter may buy this shop item right now (level and gold). */
export function canBuy(config: GameConfig, h: Hunter, item: ShopItem): boolean {
  const def = config.index.gear.get(item.gearId);
  if (!def) return false;
  return h.level >= def.level && h.gold >= item.price;
}

/**
 * Part of a forge/academy fee the town receives; the hunter pays the full fee. Without `world`: round(fee × feeTownShare);
 * with it: round(fee × townFeeShare) (the share shrinks while town gold is above its target, trading.ts).
 */
export function feeTownCut(config: GameConfig, fee: number, world?: World): number {
  return Math.round(fee * (world ? townFeeShare(config, world) : config.formula.feeTownShare));
}

function done(h: Hunter): void {
  h.ai.goal = null;
  h.ai.forced = false;
}

/**
 * Trading Post (GDD §5, material requests). Per material in id order, with demand computed fresh
 * (so two hunters in the same tick never fill the same request twice):
 *  - requested units (≤ demand) are sold while town gold lasts, at salePrice; player requests are filled first;
 *  - requested units the town cannot afford yet stay in the bag;
 *  - units beyond the request are bought for export at surplusPrice while the surplus budget lasts
 *    (town gold above surplusFloor; never stored), the rest is discarded.
 */
function doSell(ctx: SystemContext, h: Hunter): void {
  const { world, config } = ctx;
  const demand = materialDemand(config, world);
  const requests = world.town.requests ?? (world.town.requests = {});
  let units = 0;
  let paid = 0;
  let discarded = 0;
  let budget = surplusBudget(config, world);
  for (const matId of Object.keys(h.bag).sort()) {
    const have = h.bag[matId]!;
    const wanted = Math.min(have, demand[matId] ?? 0);
    const price = salePrice(config, matId);
    const n = price > 0 ? Math.min(wanted, Math.floor(world.town.gold / price)) : wanted;
    if (n > 0) {
      const gold = n * price;
      world.town.gold -= gold;
      h.gold += gold;
      paid += gold;
      units += n;
      world.town.storage[matId] = (world.town.storage[matId] ?? 0) + n;
      const left = (requests[matId] ?? 0) - n;
      if (left > 0) requests[matId] = left;
      else delete requests[matId];
    }
    const extra = have - wanted;
    const sp = surplusPrice(config, matId, world);
    const x = sp > 0 ? Math.min(extra, Math.floor(budget / sp)) : 0;
    if (x > 0) {
      const gold = x * sp;
      world.town.gold -= gold;
      budget -= gold;
      h.gold += gold;
      paid += gold;
      units += x;
    }
    discarded += extra - x;
    const keep = wanted - n;
    if (keep > 0) h.bag[matId] = keep;
    else delete h.bag[matId];
  }
  if (units > 0) {
    world.stats.materialsSold += units;
    ctx.events.emit(world.tick, { type: 'materialsSold', hunterId: h.id, units, gold: paid });
  }
  if (discarded > 0) {
    world.stats.materialsDiscarded = (world.stats.materialsDiscarded ?? 0) + discarded;
    ctx.events.emit(world.tick, { type: 'materialsDiscarded', hunterId: h.id, units: discarded });
  }
}

function doShop(ctx: SystemContext, h: Hunter, itemUid: string): void {
  const { world, config } = ctx;
  const i = world.town.shop.findIndex((x) => x.uid === itemUid);
  if (i < 0) return;
  const item = world.town.shop[i]!;
  if (!canBuy(config, h, item)) return;
  const def = config.index.gear.get(item.gearId)!;
  h.gold -= item.price;
  world.town.gold += item.price;
  world.town.shop.splice(i, 1);
  const price = item.price;
  // Equip a plain GearInstance (shop-only fields price/listPrice/listedAtMs are dropped).
  h.equipment[def.slot] = { uid: item.uid, gearId: item.gearId, qualityId: item.qualityId, enhance: item.enhance }; // previous item is discarded
  // No free heal when max HP rises; only clamp if the new max is lower.
  h.needs.hp = Math.min(h.needs.hp, hunterStats(config, h).hp);
  world.stats.gearBought += 1;
  ctx.events.emit(world.tick, { type: 'gearBought', hunterId: h.id, itemUid: item.uid, gearId: item.gearId, price });
}

function doEnhance(ctx: SystemContext, h: Hunter, slot: GearSlot): void {
  const { world, config } = ctx;
  const g = h.equipment[slot];
  if (!g) return;
  const cost = enhanceCost(config, g);
  if (cost === null || h.gold < cost) return;
  const row = config.enhance[g.enhance]!;
  h.gold -= cost;
  world.town.gold += feeTownCut(config, cost, world); // the rest leaves the economy (gold sink)
  world.stats.enhanceTries += 1;
  // Forge level adds enhanceBonus to the success rate (TECH_SPEC §5.10); one RNG draw as before.
  const success = ctx.rng.chance(Math.min(1, row.successRate + enhanceBonus(config, world)));
  if (success) {
    g.enhance += 1;
    world.stats.enhanceSuccess += 1;
  } else if (row.dropOnFail && g.enhance > 0) {
    g.enhance -= 1;
  }
  ctx.events.emit(world.tick, { type: 'enhanceResult', hunterId: h.id, slot, success, level: g.enhance, cost });
}

/**
 * Economy actions on arrival (GDD §6): sell requested materials at the trading post, buy at the shop, enhance at the forge.
 * The AI walks the hunter to the door; this system acts once and clears the goal either way.
 */
export const economySystem: System = {
  name: 'economy',
  update(ctx) {
    for (const h of ctx.world.hunters) {
      if (!isAlive(h) || h.insideBuildingId || h.ai.phase !== 'act') continue;
      const goal = h.ai.goal;
      if (!goal) continue;
      if (goal.type === 'sell') doSell(ctx, h);
      else if (goal.type === 'shop') doShop(ctx, h, goal.itemUid);
      else if (goal.type === 'enhance') doEnhance(ctx, h, goal.slot);
      else continue;
      done(h);
    }
  },
};
