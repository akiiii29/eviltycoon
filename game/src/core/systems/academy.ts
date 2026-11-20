import type { GameConfig } from '../config/types';
import type { System, SystemContext } from '../system';
import { isAlive, type Hunter } from '../world';
import { feeTownCut } from './economy';

/**
 * Next skill level the hunter may study and its gold cost, or null when not allowed
 * (unknown skill, other class, job tier too low, maxed, hunter level too low). Gold is NOT checked here.
 */
export function nextSkillStudy(config: GameConfig, h: Hunter, skillId: string): { level: number; cost: number } | null {
  const def = config.index.skills.get(skillId);
  if (!def || def.classId !== h.classId || def.jobTierMin > h.jobTier) return null;
  const level = (h.skills[skillId] ?? 0) + 1;
  if (level > def.maxLevel) return null;
  const minLevel = def.studyLevel[level - 1];
  const cost = def.studyGold[level - 1];
  if (minLevel === undefined || cost === undefined || h.level < minLevel) return null;
  return { level, cost };
}

/** True when the hunter may raise this trait by one level right now (class, max level, trait points). */
export function canLearnTrait(config: GameConfig, h: Hunter, traitId: string): boolean {
  const def = config.index.traits.get(traitId);
  if (!def) return false;
  if (def.classId !== undefined && def.classId !== h.classId) return false;
  if ((h.traits[traitId] ?? 0) >= def.maxLevel) return false;
  return h.traitPoints >= def.pointCost;
}

function learnSkill(ctx: SystemContext, h: Hunter, skillId: string): void {
  const { world, config } = ctx;
  const next = nextSkillStudy(config, h, skillId);
  if (!next || h.gold < next.cost) return;
  h.gold -= next.cost;
  world.town.gold += feeTownCut(config, next.cost); // the rest leaves the economy (gold sink)
  h.skills[skillId] = next.level;
  world.stats.learned += 1;
  ctx.events.emit(world.tick, { type: 'learned', hunterId: h.id, kind: 'skill', id: skillId, level: next.level, cost: next.cost });
}

function learnTrait(ctx: SystemContext, h: Hunter, traitId: string): void {
  const { world, config } = ctx;
  if (!canLearnTrait(config, h, traitId)) return;
  const def = config.index.traits.get(traitId)!;
  h.traitPoints -= def.pointCost;
  const level = (h.traits[traitId] ?? 0) + 1;
  h.traits[traitId] = level;
  world.stats.learned += 1;
  ctx.events.emit(world.tick, { type: 'learned', hunterId: h.id, kind: 'trait', id: traitId, level, cost: def.pointCost });
}

/**
 * Academy (GDD M3): a hunter standing at the Academy door with a `learn` goal studies a skill level (gold)
 * or a trait level (trait points). Re-validated here; acts once and clears the goal either way.
 */
export const academySystem: System = {
  name: 'academy',
  update(ctx) {
    for (const h of ctx.world.hunters) {
      if (!isAlive(h) || h.insideBuildingId || h.ai.phase !== 'act') continue;
      const goal = h.ai.goal;
      if (!goal || goal.type !== 'learn') continue;
      if (goal.kind === 'skill') learnSkill(ctx, h, goal.id);
      else learnTrait(ctx, h, goal.id);
      h.ai.goal = null;
      h.ai.forced = false;
    }
  },
};
