import { hunterStats } from './formulas';
import type { SystemContext } from './system';
import { findHunter, isAlive } from './world';
import { spawnHunter } from './systems/arrivals';
import { setGoal } from './systems/ai';
import { startCraft } from './systems/crafting';
import { servicePrice } from './systems/services';
import { reincarnate } from './systems/progression';
import { cancelBounty, postBounty, validateBounty } from './systems/bounty';
import { journeyOfHunter, recallJourney, startJourney, townHunterCount, validateJourney } from './systems/journey';

/** Player/debug commands. Queued by UI, applied at the start of the next tick (TECH_SPEC §3.1). */
export type Command =
  /** GDD §3.1 Move: send a hunter to a zone, or back to town. */
  | { type: 'hunter.move'; hunterId: string; zoneId: string | 'town' }
  /** GDD §3.1 Activities: send a hunter to a service building. */
  | { type: 'hunter.activity'; hunterId: string; buildingId: string }
  | { type: 'debug.spawnHunter' }
  | { type: 'debug.removeHunter'; hunterId: string }
  | { type: 'debug.restoreNeeds'; hunterId: string }
  /** GDD §6: start crafting a gear in a craft building from Town Storage materials. */
  | { type: 'town.craft'; buildingId: string; gearId: string }
  /** GDD §6: toggle automatic recipe choice for idle craft buildings. */
  | { type: 'town.setAutoCraft'; on: boolean }
  /** GDD §8: manually reincarnate a max-level hunter. */
  | { type: 'hunter.reincarnate'; hunterId: string }
  /** GDD §8: switch to an unlocked difficulty (affects new monster spawns only). */
  | { type: 'town.setDifficulty'; difficultyId: string }
  /** GDD §8: toggle automatic reincarnation of max-level hunters in town. */
  | { type: 'town.setAutoReincarnate'; on: boolean }
  /**
   * GDD §5: place a Trading Post request — the post buys up to `count` more units of the material
   * (on top of the automatic requests). Sets (does not add to) the outstanding count; 0 cancels it.
   */
  | { type: 'town.requestMaterial'; materialId: string; count: number }
  /**
   * GDD §9: post a bounty — `kills` kills of a monster type (anywhere) or in a zone, for `reward` gold in total, taken
   * from Town gold now (escrow) and paid out per kill (TECH_SPEC §5.9).
   */
  | { type: 'town.postBounty'; targetKind: 'monster' | 'zone'; targetId: string; kills: number; reward: number }
  /** Cancel an active bounty; its unpaid escrow returns to Town gold. */
  | { type: 'town.cancelBounty'; bountyId: string }
  /** Toggle automatic bounties when Town gold is above its treasury target. */
  | { type: 'town.setAutoBounty'; on: boolean }
  /**
   * GDD §9 Journey: send 1..journeyTeamMax hunters that are in Town (alive, not inside a building) to a destination of
   * config/journey.json; costs its `cost` Town gold (TECH_SPEC §5.10).
   */
  | { type: 'journey.start'; journeyId: string; hunterIds: string[] }
  /** Bring a running journey's team home now (no reward, cost not refunded). */
  | { type: 'journey.recall'; journeyUid: string };

type Handler<C extends Command> = (ctx: SystemContext, cmd: C) => string | null;

function controllable(ctx: SystemContext, hunterId: string): string | null {
  if (journeyOfHunter(ctx.world, hunterId)) return 'hunter is on a journey';
  const h = findHunter(ctx.world, hunterId);
  if (!h) return 'unknown hunter';
  if (!isAlive(h)) return 'hunter is dead';
  if (h.insideBuildingId) return 'hunter is inside a building';
  return null;
}

/** Each handler returns null on success or a rejection reason. */
const HANDLERS: { [K in Command['type']]: Handler<Extract<Command, { type: K }>> } = {
  'hunter.move': (ctx, cmd) => {
    const bad = controllable(ctx, cmd.hunterId);
    if (bad) return bad;
    const h = findHunter(ctx.world, cmd.hunterId)!;
    if (cmd.zoneId === 'town') return setGoal(ctx, h, { type: 'returnTown' }, 'order', true) ? null : 'no path';
    if (!ctx.config.index.zones.has(cmd.zoneId)) return 'unknown zone';
    return setGoal(ctx, h, { type: 'hunt', zoneId: cmd.zoneId }, 'order', true) ? null : 'no path';
  },
  'hunter.activity': (ctx, cmd) => {
    const bad = controllable(ctx, cmd.hunterId);
    if (bad) return bad;
    const h = findHunter(ctx.world, cmd.hunterId)!;
    const b = ctx.config.index.buildings.get(cmd.buildingId);
    if (!b || b.kind !== 'service') return 'unknown service building';
    if (h.gold < servicePrice(ctx.config, h, b)) return 'not enough gold';
    return setGoal(ctx, h, { type: 'service', buildingId: b.id }, 'order', true) ? null : 'no path';
  },
  'debug.spawnHunter': (ctx) => {
    if (townHunterCount(ctx.world) >= ctx.config.formula.hunterSlots) return 'no free slot';
    spawnHunter(ctx);
    return null;
  },
  'debug.removeHunter': (ctx, cmd) => {
    if (journeyOfHunter(ctx.world, cmd.hunterId)) return 'hunter is on a journey';
    const i = ctx.world.hunters.findIndex((h) => h.id === cmd.hunterId);
    if (i < 0) return 'unknown hunter';
    ctx.world.hunters.splice(i, 1);
    for (const m of ctx.world.monsters) if (m.targetHunterId === cmd.hunterId) m.targetHunterId = null;
    ctx.events.emit(ctx.world.tick, { type: 'hunterLeft', hunterId: cmd.hunterId });
    return null;
  },
  'debug.restoreNeeds': (ctx, cmd) => {
    if (journeyOfHunter(ctx.world, cmd.hunterId)) return 'hunter is on a journey';
    const h = findHunter(ctx.world, cmd.hunterId);
    if (!h) return 'unknown hunter';
    if (!isAlive(h)) return 'hunter is dead';
    const max = ctx.config.formula.needMax;
    h.needs.satiety = max;
    h.needs.mood = max;
    h.needs.stamina = max;
    h.needs.hp = hunterStats(ctx.config, h).hp;
    return null;
  },
  'town.craft': (ctx, cmd) => startCraft(ctx, cmd.buildingId, cmd.gearId),
  'town.setAutoCraft': (ctx, cmd) => {
    ctx.world.town.autoCraft = !!cmd.on;
    return null;
  },
  'hunter.reincarnate': (ctx, cmd) => {
    const bad = controllable(ctx, cmd.hunterId);
    if (bad) return bad;
    return reincarnate(ctx, findHunter(ctx.world, cmd.hunterId)!);
  },
  'town.setDifficulty': (ctx, cmd) => {
    if (!ctx.config.index.difficulties.has(cmd.difficultyId)) return 'unknown difficulty';
    if (!ctx.world.town.unlockedDifficulties.includes(cmd.difficultyId)) return 'difficulty locked';
    ctx.world.town.difficulty = cmd.difficultyId;
    ctx.events.emit(ctx.world.tick, { type: 'difficultyChanged', difficultyId: cmd.difficultyId });
    return null;
  },
  'town.setAutoReincarnate': (ctx, cmd) => {
    ctx.world.town.autoReincarnate = !!cmd.on;
    return null;
  },
  'town.requestMaterial': (ctx, cmd) => {
    if (!ctx.config.index.materials.has(cmd.materialId)) return 'unknown material';
    const n = cmd.count;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return 'invalid count';
    if (n > ctx.config.formula.requestMaxUnits) return 'count too large';
    const req = ctx.world.town.requests ?? (ctx.world.town.requests = {});
    if (n === 0) delete req[cmd.materialId];
    else req[cmd.materialId] = n;
    return null;
  },
  'town.postBounty': (ctx, cmd) => {
    const bad = validateBounty(ctx.config, ctx.world, cmd.targetKind, cmd.targetId, cmd.kills, cmd.reward);
    if (bad) return bad;
    postBounty(ctx, cmd.targetKind, cmd.targetId, cmd.kills, cmd.reward, false);
    return null;
  },
  'town.cancelBounty': (ctx, cmd) => (cancelBounty(ctx, cmd.bountyId, 'cancelled') ? null : 'unknown bounty'),
  'town.setAutoBounty': (ctx, cmd) => {
    ctx.world.town.autoBounty = !!cmd.on;
    return null;
  },
  'journey.start': (ctx, cmd) => {
    const bad = validateJourney(ctx, cmd.journeyId, cmd.hunterIds);
    if (bad) return bad;
    startJourney(ctx, ctx.config.index.journeys.get(cmd.journeyId)!, cmd.hunterIds);
    return null;
  },
  'journey.recall': (ctx, cmd) => (recallJourney(ctx, cmd.journeyUid) ? null : 'unknown journey'),
};

export function applyCommand(ctx: SystemContext, cmd: Command): void {
  const handler = HANDLERS[cmd.type] as Handler<Command> | undefined;
  const reason = handler ? handler(ctx, cmd) : 'unknown command';
  if (reason) ctx.events.emit(ctx.world.tick, { type: 'commandRejected', command: cmd.type, reason });
}
