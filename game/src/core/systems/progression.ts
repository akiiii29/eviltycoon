import { newAiState } from '../world';
import type { GameConfig } from '../config/types';
import { hunterStats } from '../formulas';
import type { System, SystemContext } from '../system';
import { isAlive, type Hunter, type PortalStay, type World } from '../world';
import { setGoal } from './ai';
import { allHunters } from './journey';
import { reclaimGear } from './crafting';
import { autoAdvanceDifficulty } from './gearTier';

/**
 * M3 progression (GDD §8): automatic job changes, reincarnation and difficulty unlocks.
 * Runs late in the tick (after combat/EXP gain).
 *
 * Reincarnation goes through the Reincarnation Portal (EHT; TECH_SPEC §5.13): a hunter that qualifies (auto-reincarnate
 * in Town, or the `hunter.reincarnate` command) gets the forced AI goal `reincarnate`, walks to the portal node
 * (`config.index.portalNode`, next to the square where new hunters arrive) and enters it (`enterPortal`, called by the AI
 * at the end of the path): like a journey member it is MOVED out of `world.hunters` into `world.portal` for
 * `reincarnationSec` (game time while playing, wall-clock time while closed: `advancePortal`). Then `reincarnate()` runs
 * and the hunter reappears at the portal node at level 1. It keeps its slot and counts in `allHunters` meanwhile.
 */

/** Advance one job tier if the class has a next job and the hunter reached its unlock level. */
function tryJobChange(ctx: SystemContext, h: Hunter): void {
  const jobs = ctx.config.index.jobsByClass.get(h.classId);
  const next = jobs?.find((j) => j.tier === h.jobTier + 1);
  if (!next || h.level < next.unlockLevel) return;
  const oldMax = hunterStats(ctx.config, h).hp;
  h.jobTier = next.tier;
  const newMax = hunterStats(ctx.config, h).hp;
  // Keep the current HP fraction when max HP changes.
  if (oldMax > 0) h.needs.hp = Math.min(newMax, (h.needs.hp * newMax) / oldMax);
  ctx.world.stats.jobChanges += 1;
  ctx.events.emit(ctx.world.tick, { type: 'jobChanged', hunterId: h.id, jobId: next.id, tier: next.tier });
}

function inTown(config: GameConfig, h: Hunter): boolean {
  return !config.index.nodes.get(h.nodeId)?.zoneId;
}

/**
 * Reincarnate a max-level hunter back to level 1 (GDD §8). Returns null on success, else the reason.
 * Keeps skills and traits; equipment is reclaimed into Town gear storage (crafting.reclaimGear); resets
 * level/EXP/job/base stats; grants trait points.
 */
export function reincarnate(ctx: SystemContext, h: Hunter): string | null {
  const f = ctx.config.formula;
  if (h.level < f.maxLevel) return 'not at max level';
  if (h.reincarnation >= f.maxReincarnation) return 'reincarnation cap reached';
  h.reincarnation += 1;
  h.level = 1;
  h.exp = 0;
  h.jobTier = 0;
  h.stats = { ...h.rollStats };
  h.traitPoints += f.traitPointsPerReinc;
  h.buffs = [];
  // Reclaim (TECH_SPEC §5.8): equipment goes to Town gear storage (stats kept), to be resold or dismantled.
  reclaimGear(ctx, h);
  // A level-1 hunter must re-decide (e.g. leave a zone that is now too hard).
  h.ai = newAiState();
  h.needs.hp = hunterStats(ctx.config, h).hp;
  ctx.world.stats.reincarnations += 1;
  ctx.events.emit(ctx.world.tick, { type: 'reincarnated', hunterId: h.id, count: h.reincarnation });
  return null;
}

/** Null when the hunter may reincarnate (same level/cap rules as `reincarnate`), else the reason. */
export function reincarnateBlocker(config: GameConfig, h: Hunter): string | null {
  const f = config.formula;
  if (h.level < f.maxLevel) return 'not at max level';
  if (h.reincarnation >= f.maxReincarnation) return 'reincarnation cap reached';
  return null;
}

export function portalStays(world: World): PortalStay[] {
  return world.portal ?? (world.portal = []);
}

/** The portal stay of a hunter, if it is inside the portal. */
export function portalStayOf(world: World, hunterId: string): PortalStay | undefined {
  return (world.portal ?? []).find((p) => p.hunter.id === hunterId);
}

/** Give the hunter the forced goal `reincarnate` (walk to the portal). False if there is no path. */
export function sendToPortal(ctx: SystemContext, h: Hunter, reason: string): boolean {
  return setGoal(ctx, h, { type: 'reincarnate' }, reason, true);
}

/**
 * The hunter reached the portal (AI, goal `reincarnate`, phase act): re-check the rules, then move it out of
 * `world.hunters` into the portal for reincarnationSec. When the rules no longer hold the goal is just cleared.
 * Reassigns `world.hunters` (no splice), so a caller iterating the old array is not disturbed.
 */
export function enterPortal(ctx: SystemContext, h: Hunter): boolean {
  const { world, config } = ctx;
  if (reincarnateBlocker(config, h) !== null || !isAlive(h)) {
    h.ai = newAiState();
    return false;
  }
  world.hunters = world.hunters.filter((x) => x !== h);
  for (const m of world.monsters) if (m.targetHunterId === h.id) m.targetHunterId = null;
  h.ai = newAiState();
  h.buffs = [];
  const ms = Math.max(0, config.formula.reincarnationSec) * 1000;
  portalStays(world).push({ hunter: h, durationMs: ms, remainingMs: ms, enteredAtMs: world.timeMs });
  ctx.events.emit(world.tick, { type: 'portalEntered', hunterId: h.id, durationSec: ms / 1000 });
  return true;
}

/** A hunter that came out of the portal (offline report, TECH_SPEC §9). */
export interface PortalCompletion {
  hunterId: string;
  /** Reincarnation count after leaving (unchanged when `reincarnate` refused, e.g. a config change since the save). */
  reincarnation: number;
  reincarnated: boolean;
}

/**
 * Count every portal stay down by `ms`; those at 0 run `reincarnate()` and come back at the portal node, in entry order.
 * Used per tick by the progression system and once with the wall-clock gap on load / tab return (offline.ts).
 * A refused reincarnation still brings the hunter back (never stranded). No RNG.
 */
export function advancePortal(ctx: SystemContext, ms: number): PortalCompletion[] {
  const list = ctx.world.portal;
  if (!list || list.length === 0 || !(ms > 0)) return [];
  const keep: PortalStay[] = [];
  const done: PortalStay[] = [];
  for (const p of list) {
    p.remainingMs = Math.max(0, p.remainingMs - ms);
    (p.remainingMs > 0 ? keep : done).push(p);
  }
  if (done.length === 0) return [];
  ctx.world.portal = keep;
  return done.map((p) => leavePortal(ctx, p.hunter));
}

function leavePortal(ctx: SystemContext, h: Hunter): PortalCompletion {
  const { world, config } = ctx;
  const node = config.index.nodes.get(config.index.portalNode) ?? config.index.nodes.get(config.index.squareNode)!;
  h.position = { x: node.x, y: node.y };
  h.nodeId = node.id;
  h.insideBuildingId = null;
  h.attackCdMs = 0;
  h.ai = newAiState();
  world.hunters.push(h);
  const reincarnated = reincarnate(ctx, h) === null;
  return { hunterId: h.id, reincarnation: h.reincarnation, reincarnated };
}

/** Whether the unlock condition of a difficulty is currently met (ignores whether it is already unlocked). */
export function isDifficultyUnlockable(config: GameConfig, world: World, diffId: string): boolean {
  const d = config.index.difficulties.get(diffId);
  if (!d) return false;
  let n = 0;
  for (const h of allHunters(world)) if (h.reincarnation >= d.unlockReincarnation) n++;
  return n >= d.unlockHunters;
}

function checkDifficultyUnlocks(ctx: SystemContext): void {
  const { world, config } = ctx;
  const unlocked = world.town.unlockedDifficulties;
  for (const d of config.difficulties) {
    if (unlocked.includes(d.id)) continue;
    if (!isDifficultyUnlockable(config, world, d.id)) continue;
    unlocked.push(d.id);
    ctx.events.emit(world.tick, { type: 'difficultyUnlocked', difficultyId: d.id });
  }
}

export const progressionSystem: System = {
  name: 'progression',
  update(ctx) {
    const { world, config } = ctx;
    advancePortal(ctx, ctx.dtMs);
    for (const h of world.hunters) {
      tryJobChange(ctx, h);
      // Auto-reincarnation (in Town only, so a hunter never leaves a hunt for it): walk to the portal.
      if (
        world.town.autoReincarnate &&
        isAlive(h) &&
        !h.insideBuildingId &&
        inTown(config, h) &&
        h.ai.goal?.type !== 'reincarnate' &&
        reincarnateBlocker(config, h) === null
      ) {
        sendToPortal(ctx, h, 'auto reincarnate');
      }
    }
    checkDifficultyUnlocks(ctx);
    autoAdvanceDifficulty(ctx); // town.autoDifficulty (gearTier.ts, TECH_SPEC §5.8)
  },
};
