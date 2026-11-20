import { rollHunter } from '../hunterFactory';
import type { System, SystemContext } from '../system';
import type { Hunter } from '../world';

export function spawnHunter(ctx: SystemContext): Hunter {
  const { world, config, rng, nav } = ctx;
  const sq = nav.node(config.index.squareNode);
  const id = `h${world.nextId++}`;
  const pos = { x: sq.x + rng.range(-1, 1), y: sq.y + rng.range(-1, 1) };
  const hunter = rollHunter(config, rng, id, sq.id, pos, world.timeMs);
  world.hunters.push(hunter);
  ctx.events.emit(world.tick, { type: 'hunterArrived', hunterId: id });
  return hunter;
}

/** GDD §3 step 2: hunters visit the town over time until slots are full. */
export const arrivalsSystem: System = {
  name: 'arrivals',
  update(ctx) {
    const { world, config } = ctx;
    if (world.hunters.length >= config.formula.hunterSlots) {
      world.town.arrivalTimerMs = 0;
      return;
    }
    world.town.arrivalTimerMs += ctx.dtMs;
    if (world.town.arrivalTimerMs >= config.formula.arrivalIntervalSec * 1000) {
      world.town.arrivalTimerMs = 0;
      spawnHunter(ctx);
    }
  },
};
