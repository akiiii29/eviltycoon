import { moveSpeed } from '../formulas';
import type { System } from '../system';
import { isAlive, type Vec2 } from '../world';

/** Move `p` towards `to` by at most `step`. Returns true when it arrives. */
export function stepTowards(p: Vec2, to: Vec2, step: number): boolean {
  const dx = to.x - p.x, dy = to.y - p.y;
  const d = Math.hypot(dx, dy);
  if (d <= step || d === 0) {
    p.x = to.x;
    p.y = to.y;
    return true;
  }
  p.x += (dx / d) * step;
  p.y += (dy / d) * step;
  return false;
}

/** Path following on the waypoint graph (roads are faster), plus free steering inside zones (TECH_SPEC §6). */
export const movementSystem: System = {
  name: 'movement',
  update(ctx) {
    const { config, nav, dtMs } = ctx;
    const sec = dtMs / 1000;
    for (const h of ctx.world.hunters) {
      if (!isAlive(h) || h.insideBuildingId) continue;
      const ai = h.ai;
      const base = moveSpeed(config, h) * sec;

      if (ai.phase === 'travel') {
        let budget = base;
        // Spend the whole step budget, possibly passing several nodes in one tick.
        while (budget > 0 && ai.path.length) {
          const nextId = ai.path[0]!;
          const next = nav.node(nextId);
          const mul = nav.speedMul(h.nodeId, nextId);
          const d = Math.hypot(next.x - h.position.x, next.y - h.position.y);
          const step = budget * mul;
          if (stepTowards(h.position, next, step)) {
            h.nodeId = nextId;
            ai.path.shift();
            budget -= d / mul;
          } else {
            budget = 0;
          }
        }
        if (!ai.path.length) ai.phase = 'act';
        continue;
      }

      if (ai.moveTo) {
        if (stepTowards(h.position, ai.moveTo, base)) ai.moveTo = null;
        // Track the nearest field node so "which zone am I in" stays correct while roaming.
        const zone = nav.node(h.nodeId).zoneId;
        if (zone) h.nodeId = nav.nearest(h.position, config.index.zoneNodes.get(zone));
      }
    }
  },
};
