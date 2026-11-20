import { needMax } from '../formulas';
import type { System } from '../system';
import { isAlive } from '../world';

/**
 * Town services (GDD §5): a hunter at the door pays once, goes inside, recovers the need,
 * then comes out and decides again. Stock/capacity arrive with the economy in M2.
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
        h.needs[need] = Math.min(max, h.needs[need] + (b.restorePerSec! * dtMs) / 1000);
        if (h.needs[need] >= max) {
          h.insideBuildingId = null;
          h.ai.goal = null; // decide again next tick
          h.ai.forced = false;
        }
        continue;
      }

      if (goal?.type !== 'service' || h.ai.phase !== 'act') continue;
      const b = config.index.buildings.get(goal.buildingId)!;
      const price = b.price ?? 0;
      if (h.gold < price) {
        h.ai.goal = null;
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
