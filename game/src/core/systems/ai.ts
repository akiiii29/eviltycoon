import { backstopHpFloor, currentZone, sameGoal, scoreGoals, shouldRetreatBeforeNextKill, urgentNeed } from '../ai/utility';
import type { System, SystemContext } from '../system';
import { dist, findMonster, isAlive, type Goal, type Hunter } from '../world';
import { buildingDoor } from './town';

/** Destination node for a goal. */
function destination(ctx: SystemContext, h: Hunter, goal: Goal): string | null {
  const { config, world } = ctx;
  // Building doors come from the plot the building stands on; unbuilt buildings have none (TECH_SPEC §5.12).
  switch (goal.type) {
    case 'hunt': return config.index.zones.get(goal.zoneId)?.entryNode ?? null;
    case 'service': return buildingDoor(config, world, goal.buildingId);
    case 'returnTown': return config.index.squareNode;
    case 'wander': return goal.nodeId || null;
    case 'sell': return buildingDoor(config, world, config.index.tradingPost);
    case 'shop': return buildingDoor(config, world, config.index.shop);
    case 'enhance': return buildingDoor(config, world, config.index.forge);
    case 'learn': return buildingDoor(config, world, config.index.academy);
    case 'buyPotion': return config.index.potionSeller ? buildingDoor(config, world, config.index.potionSeller) : null;
    case 'dead': return null;
  }
}

function goalLabel(g: Goal): string {
  switch (g.type) {
    case 'hunt': return `hunt:${g.zoneId}`;
    case 'service': return `service:${g.buildingId}`;
    case 'wander': return `wander:${g.nodeId}`;
    case 'shop': return `shop:${g.itemUid}`;
    case 'enhance': return `enhance:${g.slot}`;
    case 'learn': return `learn:${g.kind}:${g.id}`;
    case 'buyPotion': return `buyPotion:${g.consumableId}`;
    default: return g.type;
  }
}

/**
 * In a zone the hunter steers freely, so a path that starts at the nearest zone node can skip it when heading
 * straight for the next node of the same zone is not longer: a retreat does not first walk back into the monsters
 * it is leaving (TECH_SPEC §5.2).
 */
function skipNodeBehind(ctx: SystemContext, h: Hunter, path: string[]): void {
  if (path.length < 2) return;
  const a = ctx.nav.node(path[0]!), b = ctx.nav.node(path[1]!);
  if (!a.zoneId || b.zoneId !== a.zoneId || ctx.nav.node(h.nodeId).zoneId !== a.zoneId) return;
  if (dist(h.position, b) <= Math.hypot(b.x - a.x, b.y - a.y)) path.shift();
}

/** Assign a goal and plan the path to it. Exported for commands (player orders). */
export function setGoal(ctx: SystemContext, h: Hunter, goal: Goal, reason: string, forced = false): boolean {
  const ai = h.ai;
  const f = ctx.config.formula;
  ai.targetMonsterId = null;
  ai.moveTo = null;
  ai.forced = forced;
  ai.decideInMs = f.decisionIntervalSec * 1000;

  // Already standing in the target zone: hunt right here.
  if (goal.type === 'hunt' && currentZone(ctx.nav, h) === goal.zoneId) {
    ai.goal = goal;
    ai.path = [];
    ai.phase = 'act';
  } else {
    const dest = destination(ctx, h, goal);
    const start = ctx.nav.nearest(h.position);
    const path = dest ? ctx.nav.path(start, dest) : null;
    if (!path) {
      ai.goal = null;
      return false;
    }
    skipNodeBehind(ctx, h, path);
    ai.goal = goal;
    ai.path = path;
    ai.phase = path.length ? 'travel' : 'act';
  }
  ctx.events.emit(ctx.world.tick, { type: 'goalChanged', hunterId: h.id, goal: goalLabel(goal), reason });
  return true;
}

function decide(ctx: SystemContext, h: Hunter): void {
  const { config, nav, rng } = ctx;
  const scored = scoreGoals(config, nav, ctx.world, h);
  ctx.debug.aiScores.set(h.id, scored.map((c) => ({ label: c.label, score: c.score })));
  // Small noise so hunters do not act in lockstep (TECH_SPEC §5.1).
  let best = scored[0];
  let bestScore = -Infinity;
  for (const c of scored) {
    const s = c.score + rng.range(0, config.formula.decisionNoise);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  if (!best) return;

  let goal = best.goal;
  if (goal.type === 'wander') {
    const roads = config.nodes.filter((n) => n.kind === 'road' || n.kind === 'square');
    goal = { type: 'wander', nodeId: rng.pick(roads).id };
  }
  if (sameGoal(h.ai.goal, goal) && goal.type !== 'wander') {
    h.ai.decideInMs = config.formula.decisionIntervalSec * 1000;
    return;
  }
  setGoal(ctx, h, goal, `utility ${best.score.toFixed(2)}`);
}

/** While hunting in the zone: pick/keep a target and steer towards it, or roam. */
function huntAct(ctx: SystemContext, h: Hunter, zoneId: string): void {
  const { world, config, rng } = ctx;
  const ai = h.ai;
  let target = ai.targetMonsterId ? findMonster(world, ai.targetMonsterId) : undefined;
  if (!target || target.hp <= 0 || target.zoneId !== zoneId) {
    // Kill boundary: with nothing on the hunter, leave now if the next kill would take HP under the retreat line
    // (not for player orders; the urgent backstop still applies to those).
    if (!ai.forced && !world.monsters.some((m) => m.targetHunterId === h.id && m.hp > 0)
      && shouldRetreatBeforeNextKill(config, ctx.nav, world, h, zoneId)) {
      setGoal(ctx, h, { type: 'returnTown' }, 'retreat hp');
      return;
    }
    target = undefined;
    let bestD = Infinity;
    for (const m of world.monsters) {
      if (m.zoneId !== zoneId || m.hp <= 0) continue;
      // Prefer monsters already fighting me.
      const d = dist(h.position, m.position) - (m.targetHunterId === h.id ? 1000 : 0);
      if (d < bestD) { bestD = d; target = m; }
    }
    ai.targetMonsterId = target?.id ?? null;
  }

  if (target) {
    ai.moveTo = dist(h.position, target.position) > config.formula.attackRange * 0.9 ? { ...target.position } : null;
    return;
  }
  // Nothing to fight: roam between zone nodes.
  if (!ai.moveTo || dist(h.position, ai.moveTo) <= config.formula.arriveEpsilon) {
    const n = ctx.nav.node(rng.pick(config.index.zoneNodes.get(zoneId)!));
    ai.moveTo = { x: n.x, y: n.y };
  }
}

/** Hunter decision-making (TECH_SPEC §5). Runs before movement and combat. */
/**
 * Hard backstop: an urgent need in the field sends the hunter home, even over a player order.
 * Returns true when it fired. Runs in the AI pass and again right after combat (urgentBackstopSystem),
 * so a hit that makes a need urgent is acted on in the same tick.
 */
export function applyUrgentBackstop(ctx: SystemContext, h: Hunter): boolean {
  if (!isAlive(h) || h.insideBuildingId) return false;
  if (!currentZone(ctx.nav, h) || h.ai.goal?.type === 'returnTown') return false;
  const need = urgentNeed(ctx.config, h, backstopHpFloor(ctx.config, ctx.nav, ctx.world, h));
  if (!need) return false;
  setGoal(ctx, h, { type: 'returnTown' }, `urgent ${need}`);
  return true;
}

/** Re-applies the urgent backstop after combat (see applyUrgentBackstop). */
export const urgentBackstopSystem: System = {
  name: 'urgentBackstop',
  update(ctx) {
    for (const h of ctx.world.hunters) applyUrgentBackstop(ctx, h);
  },
};

export const aiSystem: System = {
  name: 'ai',
  update(ctx) {
    const { config, nav, dtMs } = ctx;
    for (const h of ctx.world.hunters) {
      if (!isAlive(h) || h.insideBuildingId) continue;
      const ai = h.ai;

      if (applyUrgentBackstop(ctx, h)) continue;

      if (!ai.goal) {
        decide(ctx, h);
        continue;
      }

      if (ai.phase === 'act') {
        switch (ai.goal.type) {
          case 'returnTown':
            ai.goal = null; // arrived; choose a service next tick
            continue;
          case 'hunt':
            huntAct(ctx, h, ai.goal.zoneId);
            break;
          case 'wander':
            break;
          case 'sell':
          case 'shop':
          case 'enhance':
            continue; // performed by the economy system at the door, which clears the goal
          case 'learn':
            continue; // performed by the academy system at the door, which clears the goal
          default:
            continue; // services are handled by the services system
        }
        if (!ai.forced) {
          ai.decideInMs -= dtMs;
          if (ai.decideInMs <= 0) decide(ctx, h);
        }
      }
    }
  },
};
