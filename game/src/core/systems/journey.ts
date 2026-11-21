import type { JourneyDef } from '../config/types';
import { NEED_KEYS } from '../config/types';
import type { JourneyRewards } from '../events';
import type { GameConfig } from '../config/types';
import { hunterStats, journeySuccessChance, needMax, teamPower, zonePower } from '../formulas';
import { gainExp } from '../progress';
import type { System, SystemContext } from '../system';
import { findHunter, isAlive, newAiState, type Hunter, type Journey, type World } from '../world';
import { shopCapacity } from './crafting';
import { materialDemand, surplusPrice } from './trading';

/**
 * Journeys (GDD §9 "3 NPC, runs offline, team power, success rate"; TECH_SPEC §5.11).
 *
 * The player sends a team of 1..journeyTeamMax hunters (the "3 NPC" = three hunter slots per journey) from Town to a
 * destination of config/journey.json. While away the members are MOVED out of `world.hunters` into the journey, so no
 * field/AI/combat/needs/progression system sees them (needs are frozen); they still hold a hunter slot.
 *  - team power  = Σ formulas.zonePower(member, destination zone, difficulty at departure)   (the AI's powerRatio)
 *  - success     = formulas.journeySuccessChance(team power, recommendedPower), snapshot at departure
 *  - the journey counts down `remainingMs` by game time (this system) and by wall-clock time while the game is closed
 *    (`advanceJourneys` from the client's offline step, via Simulation.runBetweenTicks); at 0 the outcome is rolled
 *    with the sim RNG (one draw, then one per rare entry on success) and the members return to the town square.
 *  - success: Town gold and per-member EXP (× difficulty rewardMul), materials via the Trading Post request rule
 *    (requested → storage, rest exported at surplusPrice for Town gold; routeRewardMaterials), rare gear finds
 *    listed in the shop (sold at the markdown floor when the shop is full);
 *    failure: failRewardFrac of the EXP only, members return with HP ≤ failHpFrac × max.
 *    Either way satiety/mood/stamina come back at most journeyReturnNeedFrac × max (they head for the services).
 * With no journey running nothing here draws RNG or emits events (the sim is byte-identical to before journeys).
 */

export interface JourneyResult {
  journeyUid: string;
  journeyId: string;
  hunterIds: string[];
  success: boolean;
  successChance: number;
  rewards: JourneyRewards;
}

export function activeJourneys(world: World): Journey[] {
  return world.journeys ?? (world.journeys = []);
}

/** The journey a hunter is away on, if any. */
export function journeyOfHunter(world: World, hunterId: string): Journey | undefined {
  return (world.journeys ?? []).find((j) => j.hunters.some((h) => h.id === hunterId));
}

/**
 * Hunters that belong to the Town: in the field/Town plus those away on journeys and inside the Reincarnation Portal
 * (they keep their slot, TECH_SPEC §5.13).
 */
export function townHunterCount(world: World): number {
  let n = world.hunters.length;
  for (const j of world.journeys ?? []) n += j.hunters.length;
  n += (world.portal ?? []).length;
  return n;
}

/** Every hunter of the Town, including those away on journeys or in the portal (for counts such as difficulty unlocks). */
export function allHunters(world: World): Hunter[] {
  const js = world.journeys ?? [];
  const ps = world.portal ?? [];
  if (js.length === 0 && ps.length === 0) return world.hunters;
  return [...world.hunters, ...js.flatMap((j) => j.hunters), ...ps.map((p) => p.hunter)];
}

function inTown(ctx: SystemContext, h: Hunter): boolean {
  return !ctx.config.index.nodes.get(h.nodeId)?.zoneId;
}

/** Team power and success chance a team would have now (also used by the debug overlay / headless for previews). */
export function journeyPreview(ctx: Pick<SystemContext, 'config' | 'world'>, def: JourneyDef, team: readonly Hunter[]): { teamPower: number; successChance: number } {
  const zone = ctx.config.index.zones.get(def.zoneId)!;
  const power = teamPower(ctx.config, team, zone, ctx.world.town.difficulty);
  return { teamPower: power, successChance: journeySuccessChance(power, def.recommendedPower, ctx.config.formula) };
}

/**
 * The journeyTeamMax strongest hunters that could leave now (alive, in Town, outside buildings), by zonePower against
 * the destination (ties: id). A helper for the debug overlay / headless tool; the sim never picks teams itself.
 */
export function bestJourneyTeam(config: GameConfig, world: World, def: JourneyDef): Hunter[] {
  const zone = config.index.zones.get(def.zoneId);
  if (!zone) return [];
  return world.hunters
    .filter((h) => isAlive(h) && !h.insideBuildingId && !config.index.nodes.get(h.nodeId)?.zoneId)
    .map((h) => ({ h, p: zonePower(config, h, zone, world.town.difficulty) }))
    .sort((a, b) => b.p - a.p || (a.h.id < b.h.id ? -1 : 1))
    .slice(0, config.formula.journeyTeamMax)
    .map((x) => x.h);
}

/** Null when `journey.start` would be accepted, else the rejection reason. */
export function validateJourney(ctx: SystemContext, journeyId: unknown, hunterIds: unknown): string | null {
  const { world, config } = ctx;
  const def = typeof journeyId === 'string' ? config.index.journeys.get(journeyId) : undefined;
  if (!def) return 'unknown journey';
  if (activeJourneys(world).length >= config.formula.journeyMaxActive) return 'too many journeys';
  if (!Array.isArray(hunterIds) || hunterIds.length === 0 || hunterIds.length > config.formula.journeyTeamMax) {
    return `team must have 1..${config.formula.journeyTeamMax} hunters`;
  }
  if (new Set(hunterIds).size !== hunterIds.length) return 'duplicate hunter';
  for (const id of hunterIds) {
    if (typeof id !== 'string') return 'unknown hunter';
    if (journeyOfHunter(world, id)) return 'hunter is on a journey';
    const h = findHunter(world, id);
    if (!h) return 'unknown hunter';
    if (!isAlive(h)) return 'hunter is dead';
    if (h.insideBuildingId) return 'hunter is inside a building';
    if (!inTown(ctx, h)) return 'hunter is not in town';
  }
  if (world.town.gold < def.cost) return 'not enough gold';
  return null;
}

/** Send a validated team (see validateJourney). Draws no RNG. */
export function startJourney(ctx: SystemContext, def: JourneyDef, hunterIds: string[]): Journey {
  const { world } = ctx;
  const team = hunterIds.map((id) => findHunter(world, id)!);
  const { teamPower: power, successChance } = journeyPreview(ctx, def, team);
  const ids = new Set(hunterIds);
  world.hunters = world.hunters.filter((h) => !ids.has(h.id));
  for (const m of world.monsters) if (m.targetHunterId && ids.has(m.targetHunterId)) m.targetHunterId = null;
  for (const h of team) {
    h.ai = newAiState();
    h.buffs = [];
  }
  const j: Journey = {
    id: `j${world.nextId++}`,
    journeyId: def.id,
    difficultyId: world.town.difficulty,
    hunters: team,
    teamPower: power,
    successChance,
    durationMs: def.durationSec * 1000,
    remainingMs: def.durationSec * 1000,
    startedAtMs: world.timeMs,
    cost: def.cost,
  };
  world.town.gold -= def.cost;
  activeJourneys(world).push(j);
  world.stats.journeysStarted = (world.stats.journeysStarted ?? 0) + 1;
  ctx.events.emit(world.tick, {
    type: 'journeyStarted', journeyUid: j.id, journeyId: def.id, hunterIds: [...hunterIds],
    teamPower: power, successChance, durationSec: def.durationSec, cost: def.cost,
  });
  return j;
}

/** Put a member back in Town (square node, fresh AI); `hpCapFrac` caps HP (failure), other needs are capped too. */
function returnHunter(ctx: SystemContext, h: Hunter, hpCapFrac: number | null): void {
  const { world, config, nav } = ctx;
  const sq = nav.node(config.index.squareNode);
  h.position = { x: sq.x, y: sq.y };
  h.nodeId = sq.id;
  h.insideBuildingId = null;
  h.ai = newAiState();
  h.attackCdMs = 0;
  h.buffs = [];
  const maxHp = hunterStats(config, h).hp;
  h.needs.hp = Math.min(h.needs.hp, maxHp, hpCapFrac === null ? maxHp : hpCapFrac * maxHp);
  for (const n of NEED_KEYS) {
    if (n === 'hp') continue;
    h.needs[n] = Math.min(h.needs[n], config.formula.journeyReturnNeedFrac * needMax(config, h, n));
  }
  world.hunters.push(h);
}

function emptyRewards(): JourneyRewards {
  return { gold: 0, exp: 0, materials: {}, items: [] };
}

/**
 * Reward materials follow the Trading Post request rule (§5.7) like a hunter's sale, but the Town owns them: the
 * requested part (materialDemand at return: automatic + player requests; player requests are decremented like a sale)
 * goes into storage, the rest is exported at surplusPrice straight away (gold added to `rewards.gold`, no surplus
 * budget needed since the Town pays nothing). Storage therefore never holds unrequested units. No RNG.
 * Rewrites `rewards.materials` to what was stored and fills `rewards.exported`.
 */
function routeRewardMaterials(config: GameConfig, world: World, rewards: JourneyRewards): void {
  const ids = Object.keys(rewards.materials).sort();
  if (ids.length === 0) return;
  const demand = materialDemand(config, world);
  const requests = world.town.requests ?? (world.town.requests = {});
  const stored: Record<string, number> = {};
  const exported: Record<string, number> = {};
  for (const id of ids) {
    const n = rewards.materials[id]!;
    const keep = Math.min(n, Math.max(0, demand[id] ?? 0));
    if (keep > 0) {
      stored[id] = keep;
      world.town.storage[id] = (world.town.storage[id] ?? 0) + keep;
      if (requests[id] !== undefined) {
        const left = requests[id]! - keep;
        if (left > 0) requests[id] = left;
        else delete requests[id];
      }
    }
    if (n > keep) {
      exported[id] = n - keep;
      rewards.gold += (n - keep) * surplusPrice(config, id, world);
    }
  }
  rewards.materials = stored;
  if (Object.keys(exported).length > 0) rewards.exported = exported;
}

/** Roll and apply the outcome of a journey whose time is up, and bring the team home. */
function resolveJourney(ctx: SystemContext, j: Journey, offline: boolean): JourneyResult {
  const { world, config, rng } = ctx;
  const def = config.index.journeys.get(j.journeyId);
  const rewards = emptyRewards();
  // A destination removed from config since the save: the team just comes back (no roll, no reward).
  const success = def ? rng.next() < j.successChance : false;
  if (def) {
    const mul = config.index.difficulties.get(j.difficultyId)?.rewardMul ?? 1;
    if (success) {
      rewards.gold = Math.round(def.gold * mul);
      rewards.exp = Math.round(def.exp * mul);
      for (const m of def.materials) rewards.materials[m.materialId] = (rewards.materials[m.materialId] ?? 0) + m.count;
      for (const r of def.rare) {
        if (!rng.chance(r.chance)) continue;
        const gear = config.index.gear.get(r.gearId);
        const q = config.index.qualities.get(r.qualityId);
        if (!gear || !q) continue;
        const price = Math.round(gear.basePrice * q.priceMult);
        if (world.town.shop.length < shopCapacity(config, world)) {
          const uid = 'g' + world.nextId++;
          world.town.shop.push({ uid, gearId: gear.id, qualityId: q.id, enhance: 0, price, listPrice: price, listedAtMs: world.timeMs });
          rewards.items.push({ gearId: gear.id, qualityId: q.id, uid });
        } else {
          const soldFor = Math.round(price * config.formula.shopMarkdownFloor);
          rewards.gold += soldFor;
          rewards.items.push({ gearId: gear.id, qualityId: q.id, soldFor });
        }
      }
    } else {
      rewards.exp = Math.round(def.exp * mul * def.failRewardFrac);
    }
  }
  routeRewardMaterials(config, world, rewards);
  world.town.gold += rewards.gold;
  world.stats.journeyGold = (world.stats.journeyGold ?? 0) + rewards.gold;
  const hpCap = success || !def ? null : def.failHpFrac;
  for (const h of j.hunters) {
    if (rewards.exp > 0) gainExp(ctx, h, rewards.exp);
    returnHunter(ctx, h, hpCap);
  }
  if (success) world.stats.journeysSucceeded = (world.stats.journeysSucceeded ?? 0) + 1;
  else world.stats.journeysFailed = (world.stats.journeysFailed ?? 0) + 1;
  const result: JourneyResult = {
    journeyUid: j.id, journeyId: j.journeyId, hunterIds: j.hunters.map((h) => h.id), success, successChance: j.successChance, rewards,
  };
  ctx.events.emit(world.tick, { type: 'journeyCompleted', ...result, offline });
  return result;
}

/**
 * Count every journey down by `ms` and resolve those that reach 0, in departure order. Used per tick by the system
 * (`ms` = dt) and once on load / tab return with the wall-clock gap (`offline` = true). Returns the resolved ones.
 */
export function advanceJourneys(ctx: SystemContext, ms: number, offline = false): JourneyResult[] {
  const list = ctx.world.journeys;
  if (!list || list.length === 0 || !(ms > 0)) return [];
  const done: JourneyResult[] = [];
  const keep: Journey[] = [];
  const ending: Journey[] = [];
  for (const j of list) {
    j.remainingMs = Math.max(0, j.remainingMs - ms);
    (j.remainingMs > 0 ? keep : ending).push(j);
  }
  if (ending.length === 0) return done;
  ctx.world.journeys = keep;
  for (const j of ending) done.push(resolveJourney(ctx, j, offline));
  return done;
}

/** Bring a team home early: no reward, cost not refunded. False if there is no such journey. */
export function recallJourney(ctx: SystemContext, journeyUid: unknown): boolean {
  const { world } = ctx;
  const list = activeJourneys(world);
  const i = list.findIndex((j) => j.id === journeyUid);
  if (i < 0) return false;
  const [j] = list.splice(i, 1);
  for (const h of j!.hunters) returnHunter(ctx, h, null);
  world.stats.journeysRecalled = (world.stats.journeysRecalled ?? 0) + 1;
  ctx.events.emit(world.tick, { type: 'journeyRecalled', journeyUid: j!.id, journeyId: j!.journeyId, hunterIds: j!.hunters.map((h) => h.id) });
  return true;
}

/** Runs after bounty, before needs (TECH_SPEC §3.2). No-op (no RNG, no events) while no journey is running. */
export const journeySystem: System = {
  name: 'journey',
  update(ctx) {
    advanceJourneys(ctx, ctx.dtMs);
  },
};
