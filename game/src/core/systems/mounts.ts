import type { GameConfig, MountDef } from '../config/types';
import { enhanceSavingsHold } from '../ai/utility';
import { mountMul } from '../progressionStats';
import type { System, SystemContext } from '../system';
import { isAlive, type Hunter, type World } from '../world';
import { feeTownCut } from './economy';

/**
 * Mounts (TECH_SPEC §5.15): a hunter buys one at the Shop door with its own gold (Town gets the fee cut, the rest is a gold
 * sink); move speed × moveSpeedMul (formulas.moveSpeed) for good, also across reincarnation. Only a faster mount than the
 * one owned may be bought (the old one is given up).
 */

/** Null when the hunter may buy this mount now (level, faster than its own, gold ≥ price), else the reason. */
export function mountBlocker(config: GameConfig, h: Hunter, mountId: string): string | null {
  const m = config.index.mounts.get(mountId);
  if (!m) return 'unknown mount';
  if (h.level < m.minLevel) return 'level too low';
  if (m.moveSpeedMul <= mountMul(config, h)) return 'not faster than the current mount';
  if (h.gold < m.price) return 'not enough gold';
  return null;
}

/**
 * AI pick: the fastest mount the hunter may buy whose price × mountReserveMul fits in its gold beyond the gear savings
 * (ai/utility.enhanceSavingsHold), or null. A level-1 purse is never spent on it (minLevel ≥ 1 and the reserve).
 */
export function bestMount(config: GameConfig, h: Hunter, world?: World): MountDef | null {
  let best: MountDef | null = null;
  let hold: number | undefined;
  for (const m of config.mounts) {
    if (mountBlocker(config, h, m.id) !== null || h.gold < m.price * config.formula.mountReserveMul) continue;
    if (best && m.moveSpeedMul <= best.moveSpeedMul) continue;
    hold ??= enhanceSavingsHold(config, h, world);
    if (h.gold - hold < m.price * config.formula.mountReserveMul) continue;
    best = m;
  }
  return best;
}

/** Buy a mount (re-validated). Returns null or the reason. */
export function buyMount(ctx: SystemContext, h: Hunter, mountId: string): string | null {
  const why = mountBlocker(ctx.config, h, mountId);
  if (why) return why;
  const m = ctx.config.index.mounts.get(mountId)!;
  h.gold -= m.price;
  ctx.world.town.gold += feeTownCut(ctx.config, m.price, ctx.world);
  h.mount = m.id;
  ctx.world.stats.mountsBought = (ctx.world.stats.mountsBought ?? 0) + 1;
  ctx.events.emit(ctx.world.tick, { type: 'mountBought', hunterId: h.id, mountId: m.id, price: m.price });
  return null;
}

/** At the Shop door with a `buyMount` goal: buy (if still allowed) and clear the goal either way. Runs after `economy`. */
export const mountsSystem: System = {
  name: 'mounts',
  update(ctx) {
    for (const h of ctx.world.hunters) {
      if (!isAlive(h) || h.insideBuildingId || h.ai.phase !== 'act') continue;
      const goal = h.ai.goal;
      if (!goal || goal.type !== 'buyMount') continue;
      buyMount(ctx, h, goal.mountId);
      h.ai.goal = null;
      h.ai.forced = false;
    }
  },
};
