/**
 * HP potions and the revive fee (TECH_SPEC §5.13) — the hunter gold sinks.
 *
 * - Potions are made by the potion seller's stock line (the Infirmary, systems/supplies.ts) from Town Storage materials,
 *   one stock per tier (config/consumable.json `kind: potion`), once the Town Hall reaches potionTownHallLevel.
 * - Buying (AI goal `buyPotion`, scored in ai/utility.ts): a hunter in town with room in its pack (potionCarryMax) buys its
 *   own tier (supplies.hunterTier: the tier whose material drops where it farms, else by level) or, when that is out of stock, the tier just below; as many as fit, the stock has
 *   and potionSpendFrac × gold pays for. Price = round(price × (1 + potionPriceLevelPct/100 × max(0, level − minLevel))).
 * - Drinking (`potionUseSystem`, between skills and the urgent backstop): in the field, with a potion and no cooldown,
 *   when HP is under ai/utility.potionDrinkLine (at or above every HP retreat line), the best carried tier heals
 *   heal × max HP. The retreat logic is untouched: with HP restored, its checks simply pass.
 * - Revive fee: round(reviveFeeBase + reviveFeePerLevel × (level − 1)), paid at revive from the gold above the hunter's
 *   Infirmary price (so it can still heal); a hunter who cannot pay it all pays what it can and lies dead
 *   reviveBrokeDelayMul × reviveSec instead of reviveSec.
 * - Where the gold goes: potion and revive payments go through economy.feeTownCut like forge/academy fees — the Town keeps
 *   feeTownShare while its gold is at or under the treasury target, less above it; the rest leaves the economy.
 */
import type { ConsumableDef, GameConfig } from '../config/types';
import { needFrac, needMax } from '../formulas';
import { currentZone, potionDrinkLine } from '../ai/utility';
import type { System, SystemContext } from '../system';
import { isAlive, type Hunter, type World } from '../world';
import { feeTownCut } from './economy';
import { servicePrice } from './services';
import { getLine, hunterTier, lineCap, lineKey, lineRecipes } from './supplies';
import { buildingLevel } from './town';

/** Potions carried in total. */
export function potionsCarried(h: Hunter): number {
  let n = 0;
  const p = h.potions;
  if (p) for (const id in p) n += p[id]!;
  return n;
}

/** Price of one potion of a tier for this hunter. */
export function potionPrice(config: GameConfig, h: Hunter, c: ConsumableDef): number {
  const pct = config.formula.potionPriceLevelPct ?? 0;
  return Math.round((c.price ?? 0) * (1 + (pct / 100) * Math.max(0, h.level - c.minLevel)));
}

/** Potion tiers of the seller (minLevel ascending); empty without a seller. */
export function potionTiers(config: GameConfig): readonly ConsumableDef[] {
  const seller = config.index.potionSeller;
  return seller ? lineRecipes(config, 'potion', seller) : [];
}

export interface PotionPurchase {
  consumable: ConsumableDef;
  count: number;
  price: number;
}

/**
 * What the hunter would buy right now, or null: its tier, else the tier just below (in-stock alternative), when the
 * seller is open (stock cap > 0), the pack has room and potionSpendFrac × gold pays for at least one.
 */
export function bestPotionPurchase(config: GameConfig, world: World, h: Hunter): PotionPurchase | null {
  const sellerId = config.index.potionSeller;
  const seller = sellerId ? config.index.buildings.get(sellerId) : undefined;
  if (!seller || lineCap(config, world, 'potion', seller) <= 0) return null;
  const room = Math.floor(config.formula.potionCarryMax) - potionsCarried(h);
  if (room <= 0) return null;
  const tiers = potionTiers(config);
  const own = hunterTier(config, tiers, h);
  if (!own) return null;
  const i = tiers.indexOf(own);
  const line = getLine(world, lineKey('potion', seller.id));
  const budget = h.gold * (config.formula.potionSpendFrac ?? 0);
  for (const c of [own, tiers[i - 1]]) {
    if (!c) continue;
    const stock = line?.stock[c.id] ?? 0;
    if (stock <= 0) continue;
    const price = potionPrice(config, h, c);
    const n = Math.min(room, stock, price > 0 ? Math.floor(budget / price) : room);
    return n >= 1 ? { consumable: c, count: n, price } : null;
  }
  return null;
}

/** At the seller's door: buy (re-validated) and clear the goal. */
export function buyPotions(ctx: SystemContext, h: Hunter): void {
  const { world, config } = ctx;
  const buy = bestPotionPurchase(config, world, h);
  if (!buy) return;
  const line = getLine(world, lineKey('potion', config.index.potionSeller!))!;
  const c = buy.consumable;
  const gold = buy.count * buy.price;
  const left = (line.stock[c.id] ?? 0) - buy.count;
  if (left > 0) line.stock[c.id] = left;
  else delete line.stock[c.id];
  const pack = h.potions ?? (h.potions = {});
  pack[c.id] = (pack[c.id] ?? 0) + buy.count;
  h.gold -= gold;
  const town = feeTownCut(config, gold, world);
  world.town.gold += town;
  const st = world.stats;
  st.potionsBought = (st.potionsBought ?? 0) + buy.count;
  st.potionGold = (st.potionGold ?? 0) + gold;
  ctx.events.emit(world.tick, { type: 'potionBought', hunterId: h.id, consumableId: c.id, count: buy.count, gold, townGold: town });
}

/** Highest carried tier (heals the most), or null. */
function bestCarried(config: GameConfig, h: Hunter): ConsumableDef | null {
  const p = h.potions;
  if (!p) return null;
  let best: ConsumableDef | null = null;
  for (const id in p) {
    if ((p[id] ?? 0) <= 0) continue;
    const c = config.index.consumables.get(id);
    if (c && (!best || c.minLevel > best.minLevel)) best = c;
  }
  return best;
}

/** Drink one potion now if the hunter should (field, potion carried, off cooldown, HP under the drink line). */
export function maybeDrink(ctx: SystemContext, h: Hunter): boolean {
  const { config, world, nav } = ctx;
  if (!isAlive(h) || h.insideBuildingId || (h.potionCdMs ?? 0) > 0 || potionsCarried(h) <= 0) return false;
  if (!currentZone(nav, h)) return false;
  const hp = needFrac(config, h, 'hp');
  if (hp >= 0.95 || hp >= potionDrinkLine(config, nav, world, h)) return false;
  const c = bestCarried(config, h);
  if (!c) return false;
  const p = h.potions!;
  if (p[c.id]! > 1) p[c.id]! -= 1;
  else delete p[c.id];
  const max = needMax(config, h, 'hp');
  h.needs.hp = Math.min(max, h.needs.hp + (c.heal ?? 0) * max);
  h.potionCdMs = Math.max(0, config.formula.potionCooldownSec ?? 0) * 1000;
  world.stats.potionsUsed = (world.stats.potionsUsed ?? 0) + 1;
  ctx.events.emit(world.tick, { type: 'potionUsed', hunterId: h.id, consumableId: c.id, hp: h.needs.hp });
  return true;
}

/** Runs after combat/skills and before the urgent backstop, so a hit that would send the hunter home is answered by a potion. */
export const potionUseSystem: System = {
  name: 'potionUse',
  update(ctx) {
    for (const h of ctx.world.hunters) {
      if (h.potionCdMs) h.potionCdMs = Math.max(0, h.potionCdMs - ctx.dtMs);
      // The zone a hunter in town last farmed (supplies.hunterTier): its last hunt goal, not the zones crossed walking home.
      const g = h.ai.goal;
      if (g?.type === 'hunt' && h.lastZoneId !== g.zoneId) h.lastZoneId = g.zoneId;
      maybeDrink(ctx, h);
    }
  },
};

/** buyPotion goals at the seller's door (like the economy system: act once, clear the goal). */
export const consumablesSystem: System = {
  name: 'consumables',
  update(ctx) {
    for (const h of ctx.world.hunters) {
      if (!isAlive(h) || h.insideBuildingId || h.ai.phase !== 'act' || h.ai.goal?.type !== 'buyPotion') continue;
      buyPotions(ctx, h);
      h.ai.goal = null;
      h.ai.forced = false;
    }
  },
};

// ---- Revive fee ----

/** Full revive fee: round(reviveFeeBase + reviveFeePerLevel × (level − 1)). */
export function reviveFee(config: GameConfig, h: Hunter): number {
  const f = config.formula;
  return Math.max(0, Math.round((f.reviveFeeBase ?? 0) + (f.reviveFeePerLevel ?? 0) * Math.max(0, h.level - 1)));
}

/** Gold the hunter keeps through a revive: its Infirmary price (the HP service), so it can still pay to heal. */
function reviveKeep(config: GameConfig, world: World, h: Hunter): number {
  const b = config.buildings.find((x) => x.kind === 'service' && x.need === 'hp');
  return b ? servicePrice(config, h, b, Math.max(1, buildingLevel(world, b.id))) : 0;
}

/** What the revive will take: min(fee, gold above the kept Infirmary price); `broke` when that is less than the fee. */
export function revivePayment(config: GameConfig, world: World, h: Hunter): { fee: number; pay: number; broke: boolean } {
  const fee = reviveFee(config, h);
  const pay = Math.min(fee, Math.max(0, h.gold - reviveKeep(config, world, h)));
  return { fee, pay, broke: pay < fee };
}

/** Death timer: reviveSec, × reviveBrokeDelayMul when the hunter cannot pay the full fee. */
export function reviveDelayMs(config: GameConfig, world: World, h: Hunter): number {
  const f = config.formula;
  const mul = revivePayment(config, world, h).broke ? Math.max(1, f.reviveBrokeDelayMul ?? 1) : 1;
  return f.reviveSec * 1000 * mul;
}

/** Pay the revive fee (Town gets feeTownCut of it, the rest leaves the economy). Returns the amounts for the event. */
export function payReviveFee(ctx: Pick<SystemContext, 'config' | 'world'>, h: Hunter): { fee: number; townGold: number } {
  const { config, world } = ctx;
  const { pay, broke } = revivePayment(config, world, h);
  const townGold = pay > 0 ? feeTownCut(config, pay, world) : 0;
  h.gold -= pay;
  world.town.gold += townGold;
  world.stats.reviveFees = (world.stats.reviveFees ?? 0) + pay;
  if (broke) world.stats.reviveBroke = (world.stats.reviveBroke ?? 0) + 1;
  return { fee: pay, townGold };
}
