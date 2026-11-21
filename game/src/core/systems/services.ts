import type { BuildingDef, GameConfig } from '../config/types';
import { needMax } from '../formulas';
import type { System } from '../system';
import { isAlive, type Hunter } from '../world';
import { takeSupply } from './supplies';
import { buildingLevel, levelValue, serviceRestorePerSec } from './town';

/**
 * Price a hunter pays for a service:
 * round(base × (1 + servicePriceLevelPct / 100 × (level − 1) + servicePriceLatePct / 100 × max(0, level − servicePriceLateLevel))).
 * Scales with level so late-game hunter gold flows back to the town (a rich town burns it through townFeeShare);
 * the steeper late term starts only at servicePriceLateLevel so early pacing is untouched.
 * `base` is the building's price at its building level (`price[buildingLvl − 1]`, TECH_SPEC §5.12; 1 when omitted);
 * `level` in the formula is the hunter's level.
 * Single source for the system, AI and commands.
 */
export function servicePrice(config: GameConfig, h: Hunter, b: BuildingDef, buildingLvl = 1): number {
  const f = config.formula;
  const base = levelValue(b.price, Math.max(1, buildingLvl)) ?? 0;
  const pct = f.servicePriceLevelPct ?? 0;
  const late = (f.servicePriceLatePct ?? 0) * Math.max(0, h.level - (f.servicePriceLateLevel ?? 0));
  return Math.round(base * (1 + (pct / 100) * Math.max(0, h.level - 1) + late / 100));
}

/**
 * Town services (GDD §5): a hunter at the door pays once, goes inside, recovers the need,
 * then comes out and decides again. Each entry takes one supply unit (systems/supplies.ts, TECH_SPEC §5.13); with the
 * stock empty the hunter is turned away unpaid (`serviceStockout`) and decides again (resting in town still regenerates).
 */
export const servicesSystem: System = {
  name: 'services',
  update(ctx) {
    const { world, config, dtMs } = ctx;
    for (const h of world.hunters) {
      if (!isAlive(h)) continue;
      const goal = h.ai.goal;

      if (h.insideBuildingId) {
        const b = config.index.buildings.get(h.insideBuildingId)!;
        const need = b.need!;
        const max = needMax(config, h, need);
        h.needs[need] = Math.min(max, h.needs[need] + (serviceRestorePerSec(world, b) * dtMs) / 1000);
        if (h.needs[need] >= max) {
          h.insideBuildingId = null;
          h.ai.goal = null; // decide again next tick
          h.ai.forced = false;
        }
        continue;
      }

      if (goal?.type !== 'service' || h.ai.phase !== 'act') continue;
      const b = config.index.buildings.get(goal.buildingId)!;
      const lv = buildingLevel(world, b.id);
      if (lv < 1) {
        h.ai.goal = null;
        continue;
      }
      const price = servicePrice(config, h, b, lv);
      if (h.gold < price) {
        h.ai.goal = null;
        continue;
      }
      if (!takeSupply(world, config, b)) {
        h.ai.goal = null;
        h.ai.forced = false;
        world.stats.serviceStockouts = (world.stats.serviceStockouts ?? 0) + 1;
        ctx.events.emit(world.tick, { type: 'serviceStockout', hunterId: h.id, buildingId: b.id });
        continue;
      }
      h.gold -= price;
      world.town.gold += price;
      world.stats.serviceUses += 1;
      h.insideBuildingId = b.id;
      ctx.events.emit(world.tick, { type: 'serviceUsed', hunterId: h.id, buildingId: b.id, price });
    }
  },
};
