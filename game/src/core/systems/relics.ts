import type { GameConfig, RelicDef } from '../config/types';
import type { System, SystemContext } from '../system';
import type { World } from '../world';
import { townGoldTarget } from './trading';

/**
 * Relics (TECH_SPEC §5.16, config/relic.json): Town-wide permanent upgrades with levels, paid with Town gold (leaves the
 * economy) and Town Storage materials. Effects are read where a World is at hand (progressionStats.relicValue):
 * expPct (every EXP gain, progress.gainExp), runeDropPct (rune drop chances, runes.dropRune), growthCostPct (growth
 * property price, academy.nextGrowth). No stat effect, so hunterStats stays a function of the hunter alone.
 * Command `town.upgradeRelic`; with town.autoRelic (default off) the cheapest affordable level is bought every 60 s when
 * Town gold ≥ relicAutoGoldMul × townGoldTarget + its gold cost and the materials are in storage.
 */

export function relicLevel(world: World, relicId: string): number {
  return world.town.relics?.[relicId] ?? 0;
}

/** Cost of the next level of a relic, or null at max level / unknown. */
export function relicNextCost(config: GameConfig, world: World, relicId: string): RelicDef['upgradeCost'][number] | null {
  const r = config.index.relics.get(relicId);
  if (!r) return null;
  const lv = relicLevel(world, relicId);
  return lv >= r.maxLevel ? null : (r.upgradeCost[lv] ?? null);
}

/** Null when the Town can buy the next level of this relic now, else the reason. */
export function relicUpgradeBlocker(config: GameConfig, world: World, relicId: string): string | null {
  const r = config.index.relics.get(relicId);
  if (!r) return 'unknown relic';
  const cost = relicNextCost(config, world, relicId);
  if (!cost) return 'relic at max level';
  if (world.town.gold < cost.gold) return 'not enough town gold';
  for (const m of cost.materials) if ((world.town.storage[m.materialId] ?? 0) < m.count) return 'missing materials';
  return null;
}

/** Buy the next relic level (re-validated). Returns null or the reason. */
export function upgradeRelic(ctx: SystemContext, relicId: string, auto = false): string | null {
  const { config, world } = ctx;
  const why = relicUpgradeBlocker(config, world, relicId);
  if (why) return why;
  const cost = relicNextCost(config, world, relicId)!;
  world.town.gold -= cost.gold;
  for (const m of cost.materials) {
    const left = (world.town.storage[m.materialId] ?? 0) - m.count;
    if (left > 0) world.town.storage[m.materialId] = left;
    else delete world.town.storage[m.materialId];
  }
  const level = relicLevel(world, relicId) + 1;
  (world.town.relics ??= {})[relicId] = level;
  world.stats.relicUpgrades = (world.stats.relicUpgrades ?? 0) + 1;
  ctx.events.emit(world.tick, { type: 'relicUpgraded', relicId, level, gold: cost.gold, auto });
  return null;
}

/** town.autoRelic pass: the cheapest affordable next level (ties → config order), if Town gold is well above target. */
export function autoRelic(ctx: SystemContext): boolean {
  const { config, world } = ctx;
  const floor = config.formula.relicAutoGoldMul * townGoldTarget(config, world);
  let best: { id: string; gold: number } | null = null;
  for (const r of config.relics) {
    const cost = relicNextCost(config, world, r.id);
    if (!cost || relicUpgradeBlocker(config, world, r.id) !== null || world.town.gold < floor + cost.gold) continue;
    if (!best || cost.gold < best.gold) best = { id: r.id, gold: cost.gold };
  }
  return best ? upgradeRelic(ctx, best.id, true) === null : false;
}

const AUTO_RELIC_EVERY_TICKS = 600;

export const relicsSystem: System = {
  name: 'relics',
  update(ctx) {
    if (ctx.world.town.autoRelic && ctx.world.tick % AUTO_RELIC_EVERY_TICKS === AUTO_RELIC_EVERY_TICKS - 1) autoRelic(ctx);
  },
};
