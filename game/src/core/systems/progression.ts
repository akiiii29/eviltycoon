import { newAiState } from '../world';
import type { GameConfig } from '../config/types';
import { hunterStats } from '../formulas';
import type { System, SystemContext } from '../system';
import { isAlive, type Hunter, type World } from '../world';
import { allHunters } from './journey';

/**
 * M3 progression (GDD §8): automatic job changes, reincarnation and difficulty unlocks.
 * Runs late in the tick (after combat/EXP gain).
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
 * Keeps skills, traits and equipment; resets level/EXP/job/base stats; grants trait points.
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
  // A level-1 hunter must re-decide (e.g. leave a zone that is now too hard).
  h.ai = newAiState();
  h.needs.hp = hunterStats(ctx.config, h).hp;
  ctx.world.stats.reincarnations += 1;
  ctx.events.emit(ctx.world.tick, { type: 'reincarnated', hunterId: h.id, count: h.reincarnation });
  return null;
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
    const f = config.formula;
    for (const h of world.hunters) {
      tryJobChange(ctx, h);
      if (
        world.town.autoReincarnate &&
        isAlive(h) &&
        !h.insideBuildingId &&
        inTown(config, h) &&
        h.level >= f.maxLevel &&
        h.reincarnation < f.maxReincarnation
      ) {
        reincarnate(ctx, h);
      }
    }
    checkDifficultyUnlocks(ctx);
  },
};
