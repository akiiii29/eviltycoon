/**
 * Bounties (GDD §9, TECH_SPEC §5.9).
 *
 * The Town posts a bounty on a monster type or a whole zone: `kills` kills for `reward` gold. The reward is taken
 * from Town gold up front and held on the bounty (`escrow`), so town + escrow + hunter gold is conserved while it runs.
 *  - Each kill of a target pays the killer its share: the k-th kill pays floor(reward·k/kills) − floor(reward·(k−1)/kills),
 *    so the shares sum exactly to `reward`. A kill counts toward the FIRST matching bounty only (posting order).
 *  - On completion the kingdom pays the Town round(reward × bountyCompletionFrac) — new gold, < reward, so a bounty
 *    is a net Town sink of (1 − bountyCompletionFrac) × reward that flows to hunters.
 *  - Torment: kills of a bounty target spawned under a difficulty with order ≥ bountyTormentFromOrder roll their drops at
 *    chance × (1 + bountyTormentDropBonus × tier), tier = order − bountyTormentFromOrder + 1 (capped at 1). The number of
 *    RNG draws is unchanged, so a world without bounties plays out exactly as before.
 *  - Auto-bounties (town.autoBounty): every bountyAutoIntervalSec, if Town gold > bountyAutoGoldMul × townGoldTarget and no
 *    auto-bounty is active, post one on the monster hunters are hunting that drops the most requested material value
 *    (ties: more hunters in its zone, higher spawn weight, config order). Reward = round(bountyAutoRewardFrac × (gold −
 *    target)), kills = bountyAutoKills. Auto-bounties expire after bountyAutoExpireSec and refund the remaining escrow.
 * No RNG is drawn here; everything is deterministic from world state.
 */
import type { GameConfig, ZoneDef } from '../config/types';
import type { System, SystemContext } from '../system';
import type { Bounty, BountyTargetKind, Hunter, Monster, World } from '../world';
import { materialDemand, townGoldTarget } from './trading';

export function activeBounties(world: World): Bounty[] {
  return world.town.bounties ?? (world.town.bounties = []);
}

function matches(b: Bounty, m: Monster): boolean {
  return b.targetKind === 'zone' ? m.zoneId === b.targetId : m.defId === b.targetId;
}

/** Gold paid for the k-th kill (1-based) of a bounty; Σ over k = 1..kills is exactly `reward`. */
export function bountyKillShare(reward: number, kills: number, k: number): number {
  return Math.floor((reward * k) / kills) - Math.floor((reward * (k - 1)) / kills);
}

/** Drop-chance multiplier for a bounty-target kill under a difficulty (1 below the first Torment). */
export function bountyDropMul(config: GameConfig, difficultyId: string): number {
  const f = config.formula;
  const d = config.index.difficulties.get(difficultyId);
  if (!d) return 1;
  const tier = d.order - f.bountyTormentFromOrder + 1;
  return tier > 0 ? 1 + f.bountyTormentDropBonus * tier : 1;
}

/** Zones a monster type spawns in (a monster bounty is only postable on something that can be killed). */
function monsterSpawns(config: GameConfig, monsterId: string): boolean {
  return config.zones.some((z) => z.monsters.some((zm) => zm.monsterId === monsterId));
}

/** Validation shared by the command and auto-posting. Returns a rejection reason or null. */
export function validateBounty(config: GameConfig, world: World, kind: unknown, targetId: unknown, kills: unknown, reward: unknown): string | null {
  const f = config.formula;
  if (kind === 'monster') {
    if (typeof targetId !== 'string' || !config.index.monsters.has(targetId)) return 'unknown monster';
    if (!monsterSpawns(config, targetId)) return 'monster does not spawn';
  } else if (kind === 'zone') {
    if (typeof targetId !== 'string' || !config.index.zones.has(targetId)) return 'unknown zone';
  } else return 'invalid target kind';
  if (typeof kills !== 'number' || !Number.isInteger(kills) || kills < 1) return 'invalid kill count';
  if (kills > f.bountyMaxKills) return 'kill count too large';
  if (typeof reward !== 'number' || !Number.isInteger(reward)) return 'invalid reward';
  if (reward < kills) return 'reward below 1 gold per kill';
  if (reward > world.town.gold) return 'not enough gold';
  if (activeBounties(world).length >= f.bountyMaxActive) return 'too many bounties';
  return null;
}

/** Post a bounty (assumed valid): escrow the reward from Town gold. */
export function postBounty(ctx: SystemContext, targetKind: BountyTargetKind, targetId: string, kills: number, reward: number, auto: boolean): Bounty {
  const { world } = ctx;
  const b: Bounty = { id: `b${world.nextId++}`, targetKind, targetId, kills, progress: 0, reward, escrow: reward, auto, postedAtMs: world.timeMs };
  world.town.gold -= reward;
  activeBounties(world).push(b);
  world.stats.bountiesPosted = (world.stats.bountiesPosted ?? 0) + 1;
  ctx.events.emit(world.tick, { type: 'bountyPosted', bountyId: b.id, targetKind, targetId, kills, reward, auto });
  return b;
}

/** Remove a bounty and return its remaining escrow to the Town. */
export function cancelBounty(ctx: SystemContext, bountyId: string, reason: 'cancelled' | 'expired'): boolean {
  const list = activeBounties(ctx.world);
  const i = list.findIndex((b) => b.id === bountyId);
  if (i < 0) return false;
  const b = list[i]!;
  list.splice(i, 1);
  ctx.world.town.gold += b.escrow;
  ctx.events.emit(ctx.world.tick, { type: 'bountyCancelled', bountyId: b.id, refund: b.escrow, reason });
  return true;
}

/**
 * Called from combat.grantKill for every kill: advances the first matching bounty, pays the killer, completes it.
 * Returns the drop-chance multiplier for this kill (1 when the monster is no bounty target).
 */
export function bountyOnKill(ctx: SystemContext, h: Hunter, m: Monster): number {
  const { world, config } = ctx;
  const list = world.town.bounties;
  if (!list || list.length === 0) return 1;
  const i = list.findIndex((b) => matches(b, m));
  if (i < 0) return 1;
  const b = list[i]!;
  b.progress += 1;
  const pay = Math.min(b.escrow, bountyKillShare(b.reward, b.kills, b.progress));
  b.escrow -= pay;
  h.gold += pay;
  world.stats.bountyGoldPaid = (world.stats.bountyGoldPaid ?? 0) + pay;
  ctx.events.emit(world.tick, { type: 'bountyProgress', bountyId: b.id, hunterId: h.id, progress: b.progress, kills: b.kills, gold: pay });
  if (b.progress >= b.kills) {
    list.splice(i, 1);
    // Rounding guarantees escrow is 0 here; anything left (e.g. a hand-edited save) goes back to the Town.
    const kingdom = Math.round(b.reward * config.formula.bountyCompletionFrac);
    world.town.gold += kingdom + b.escrow;
    world.stats.bountiesCompleted = (world.stats.bountiesCompleted ?? 0) + 1;
    world.stats.bountyKingdomGold = (world.stats.bountyKingdomGold ?? 0) + kingdom;
    ctx.events.emit(world.tick, { type: 'bountyCompleted', bountyId: b.id, hunterId: h.id, reward: b.reward, kingdomGold: kingdom });
  }
  return bountyDropMul(config, m.difficultyId);
}

/**
 * AI zone-choice factor before normalisation (ai/utility.huntZoneMuls): 1 + bountyZoneBonus × share of the zone's spawn
 * weight that is a bounty target (1 for a zone bounty).
 */
export function bountyZoneMul(config: GameConfig, world: World, zone: ZoneDef): number {
  const list = world.town.bounties;
  if (!list || list.length === 0) return 1;
  let share = 0;
  if (list.some((b) => b.targetKind === 'zone' && b.targetId === zone.id)) share = 1;
  else {
    let total = 0;
    let hit = 0;
    for (const zm of zone.monsters) {
      total += zm.weight;
      if (list.some((b) => b.targetKind === 'monster' && b.targetId === zm.monsterId)) hit += zm.weight;
    }
    share = total > 0 ? hit / total : 0;
  }
  return 1 + config.formula.bountyZoneBonus * share;
}

/** Auto-bounty target: see the file comment. null when no hunter is hunting anything un-bountied. */
export function pickAutoBountyTarget(config: GameConfig, world: World): string | null {
  const hunting = new Map<string, number>();
  for (const h of world.hunters) {
    if (h.deadMs > 0 || h.ai.goal?.type !== 'hunt') continue;
    hunting.set(h.ai.goal.zoneId, (hunting.get(h.ai.goal.zoneId) ?? 0) + 1);
  }
  if (hunting.size === 0) return null;
  const list = activeBounties(world);
  const demand = materialDemand(config, world);
  let best: { id: string; value: number; hunters: number; share: number } | null = null;
  for (const z of config.zones) {
    const n = hunting.get(z.id) ?? 0;
    if (n === 0 || list.some((b) => b.targetKind === 'zone' && b.targetId === z.id)) continue;
    const totalW = z.monsters.reduce((a, zm) => a + zm.weight, 0);
    for (const zm of z.monsters) {
      if (list.some((b) => b.targetKind === 'monster' && b.targetId === zm.monsterId)) continue;
      const def = config.index.monsters.get(zm.monsterId);
      if (!def) continue;
      let value = 0;
      for (const d of def.drops) if ((demand[d.materialId] ?? 0) > 0) value += d.chance * (config.index.materials.get(d.materialId)?.price ?? 0);
      const share = totalW > 0 ? zm.weight / totalW : 0;
      if (!best || value > best.value || (value === best.value && (n > best.hunters || (n === best.hunters && share > best.share)))) {
        best = { id: zm.monsterId, value, hunters: n, share };
      }
    }
  }
  return best?.id ?? null;
}

function autoPost(ctx: SystemContext): void {
  const { world, config } = ctx;
  const f = config.formula;
  const list = activeBounties(world);
  if (list.length >= f.bountyMaxActive || list.some((b) => b.auto)) return;
  const target = townGoldTarget(config, world);
  if (!(world.town.gold > f.bountyAutoGoldMul * target)) return;
  const kills = Math.max(1, Math.floor(f.bountyAutoKills));
  const reward = Math.min(world.town.gold, Math.round(f.bountyAutoRewardFrac * (world.town.gold - target)));
  if (reward < kills) return;
  const monsterId = pickAutoBountyTarget(config, world);
  if (!monsterId) return;
  postBounty(ctx, 'monster', monsterId, kills, reward, true);
}

/** Expires auto-bounties and posts new ones (every bountyAutoIntervalSec of game time). */
export const bountySystem: System = {
  name: 'bounty',
  update(ctx) {
    const { world, config } = ctx;
    const f = config.formula;
    const everyTicks = Math.max(1, Math.round((f.bountyAutoIntervalSec * 1000) / ctx.dtMs));
    if (world.tick % everyTicks !== 0) return;
    const list = activeBounties(world);
    if (f.bountyAutoExpireSec > 0) {
      for (const b of [...list]) {
        if (b.auto && world.timeMs - b.postedAtMs >= f.bountyAutoExpireSec * 1000) cancelBounty(ctx, b.id, 'expired');
      }
    }
    if (world.town.autoBounty) autoPost(ctx);
  },
};
