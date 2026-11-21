import type { GameConfig } from '../config/types';
import { relicValue } from '../progressionStats';
import type { System, SystemContext } from '../system';
import { isAlive, type Hunter, type LearnKind, type World } from '../world';
import { studyGoldMul } from './town';
import { feeTownCut } from './economy';

/**
 * Next skill level the hunter may study and its gold cost, or null when not allowed
 * (unknown skill, other class, job tier too low, maxed, hunter level too low). Gold is NOT checked here.
 * With `world` the cost is round(studyGold × the Academy's studyGoldMul) (TECH_SPEC §5.12).
 */
export function nextSkillStudy(config: GameConfig, h: Hunter, skillId: string, world?: World): { level: number; cost: number } | null {
  const def = config.index.skills.get(skillId);
  if (!def || def.classId !== h.classId || def.jobTierMin > h.jobTier) return null;
  const level = (h.skills[skillId] ?? 0) + 1;
  if (level > def.maxLevel) return null;
  const minLevel = def.studyLevel[level - 1];
  const cost = def.studyGold[level - 1];
  if (minLevel === undefined || cost === undefined || h.level < minLevel) return null;
  return { level, cost: world ? Math.round(cost * studyGoldMul(config, world)) : cost };
}

/** True when the hunter may raise this trait by one level right now (class, max level, trait points). */
export function canLearnTrait(config: GameConfig, h: Hunter, traitId: string): boolean {
  const def = config.index.traits.get(traitId);
  if (!def) return false;
  if (def.classId !== undefined && def.classId !== h.classId) return false;
  if ((h.traits[traitId] ?? 0) >= def.maxLevel) return false;
  return h.traitPoints >= def.pointCost;
}

/**
 * Next growth property level (TECH_SPEC §5.16) and its gold cost, or null (unknown, maxed). Gold is NOT checked here.
 * With `world` the cost is round(cost × (1 − growthCostPct / 100)) of the Town's Relic of Patronage.
 */
export function nextGrowth(config: GameConfig, h: Hunter, growthId: string, world?: World): { level: number; cost: number } | null {
  const def = config.index.growthProperties.get(growthId);
  if (!def) return null;
  const level = (h.growth?.[growthId] ?? 0) + 1;
  const cost = def.cost[level - 1];
  if (level > def.maxLevel || cost === undefined) return null;
  const off = world ? Math.min(100, relicValue(config, world, 'growthCostPct')) : 0;
  return { level, cost: off > 0 ? Math.round(cost * (1 - off / 100)) : cost };
}

/**
 * Why a study plan (`hunter.learn`) can NEVER be carried out, or null when it can (now or later: hunter level, job tier,
 * gold or trait points may still be missing). Never: unknown id, another class, already at max level.
 */
export function learnPlanBlocker(config: GameConfig, h: Hunter, plan: { kind: LearnKind; id: string }): string | null {
  switch (plan.kind) {
    case 'skill': {
      const def = config.index.skills.get(plan.id);
      if (!def) return 'unknown skill';
      if (def.classId !== h.classId) return 'skill of another class';
      return (h.skills[plan.id] ?? 0) >= def.maxLevel ? 'already at max level' : null;
    }
    case 'trait': {
      const def = config.index.traits.get(plan.id);
      if (!def) return 'unknown trait';
      if (def.classId !== undefined && def.classId !== h.classId) return 'trait of another class';
      return (h.traits[plan.id] ?? 0) >= def.maxLevel ? 'already at max level' : null;
    }
    case 'growth': {
      const def = config.index.growthProperties.get(plan.id);
      if (!def) return 'unknown growth property';
      return (h.growth?.[plan.id] ?? 0) >= def.maxLevel ? 'already at max level' : null;
    }
    default:
      return 'unknown study kind';
  }
}

/** The study a plan stands for if it can be done right now (rules + gold / trait points), with its cost; else null. */
export function readyStudy(config: GameConfig, h: Hunter, kind: LearnKind, id: string, world?: World): { kind: LearnKind; id: string; cost: number } | null {
  if (kind === 'trait') {
    if (!canLearnTrait(config, h, id)) return null;
    return { kind, id, cost: config.index.traits.get(id)!.pointCost };
  }
  const next = kind === 'skill' ? nextSkillStudy(config, h, id, world) : nextGrowth(config, h, id, world);
  return next && h.gold >= next.cost ? { kind, id, cost: next.cost } : null;
}

/** Drop the study plan once it was carried out (one level per plan). */
function planDone(h: Hunter, kind: LearnKind, id: string): void {
  if (h.learnPlan && h.learnPlan.kind === kind && h.learnPlan.id === id) delete h.learnPlan;
}

function learnSkill(ctx: SystemContext, h: Hunter, skillId: string): void {
  const { world, config } = ctx;
  const next = nextSkillStudy(config, h, skillId, world);
  if (!next || h.gold < next.cost) return;
  h.gold -= next.cost;
  world.town.gold += feeTownCut(config, next.cost, world); // the rest leaves the economy (gold sink)
  h.skills[skillId] = next.level;
  world.stats.learned += 1;
  planDone(h, 'skill', skillId);
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
  planDone(h, 'trait', traitId);
  ctx.events.emit(world.tick, { type: 'learned', hunterId: h.id, kind: 'trait', id: traitId, level, cost: def.pointCost });
}

/** Growth property (TECH_SPEC §5.16): gold like a skill (Town gets the fee cut, the rest is a sink), kept for life. */
function learnGrowth(ctx: SystemContext, h: Hunter, growthId: string): void {
  const { world, config } = ctx;
  const next = nextGrowth(config, h, growthId, world);
  if (!next || h.gold < next.cost) return;
  h.gold -= next.cost;
  world.town.gold += feeTownCut(config, next.cost, world);
  (h.growth ??= {})[growthId] = next.level;
  world.stats.learned += 1;
  world.stats.growthBought = (world.stats.growthBought ?? 0) + 1;
  planDone(h, 'growth', growthId);
  ctx.events.emit(world.tick, { type: 'learned', hunterId: h.id, kind: 'growth', id: growthId, level: next.level, cost: next.cost });
}

/**
 * Academy (GDD M3): a hunter standing at the Academy door with a `learn` goal studies a skill level (gold), a trait
 * level (trait points) or a growth property level (gold, M5). Re-validated here; acts once and clears the goal either way.
 */
export const academySystem: System = {
  name: 'academy',
  update(ctx) {
    for (const h of ctx.world.hunters) {
      if (!isAlive(h) || h.insideBuildingId || h.ai.phase !== 'act') continue;
      const goal = h.ai.goal;
      if (!goal || goal.type !== 'learn') continue;
      if (goal.kind === 'skill') learnSkill(ctx, h, goal.id);
      else if (goal.kind === 'growth') learnGrowth(ctx, h, goal.id);
      else learnTrait(ctx, h, goal.id);
      h.ai.goal = null;
      h.ai.forced = false;
    }
  },
};
