import type { GameConfig, StatKey } from './config/types';
import { STAT_KEYS } from './config/types';
import type { Rng } from './rng';
import { newAiState, type Grade, type Hunter, type HunterTier, type Vec2 } from './world';

const GRADE_INDEX: Record<Grade, 0 | 1 | 2> = { normal: 0, high: 1, highest: 2 };

/** GDD §4.2: G = N_high + 2 × N_highest → tier. */
export function tierFromPoints(points: number): HunterTier {
  if (points >= 14) return 'legendary';
  if (points >= 10) return 'heroic';
  if (points >= 6) return 'superior';
  if (points >= 2) return 'rare';
  return 'normal';
}

export function rollHunter(config: GameConfig, rng: Rng, id: string, nodeId: string, position: Vec2, nowMs: number): Hunter {
  const cls = rng.pick(config.classes);
  const grades = {} as Record<StatKey, Grade>;
  const stats = {} as Record<StatKey, number>;
  let points = 0;
  for (const k of STAT_KEYS) {
    const g = rng.weighted(config.statGrades, (s) => s.rollChance);
    grades[k] = g.grade;
    points += g.point;
    const [min, max] = cls.statRanges[k][GRADE_INDEX[g.grade]];
    stats[k] = rng.int(min, max);
  }

  const personalities: string[] = [];
  const pool = config.personalities.filter((p) => p.weight > 0);
  const want = Math.min(config.formula.personalitiesPerHunter, pool.length);
  while (personalities.length < want) {
    const p = rng.weighted(pool.filter((x) => !personalities.includes(x.id)), (x) => x.weight);
    personalities.push(p.id);
  }

  const max = config.formula.needMax;
  return {
    id,
    classId: cls.id,
    jobTier: 0,
    tier: tierFromPoints(points),
    statGrades: grades,
    stats: { ...stats, atkSpeed: cls.attackSpeed },
    rollStats: { ...stats, atkSpeed: cls.attackSpeed },
    skills: {},
    skillCdMs: {},
    traits: {},
    traitPoints: 0,
    buffs: [],
    equipment: {},
    bag: {},
    potions: {},
    potionCdMs: 0,
    level: 1,
    exp: 0,
    reincarnation: 0,
    gold: config.formula.startingGold,
    needs: { hp: stats.hp, satiety: max, mood: max, stamina: max },
    personalities,
    position,
    nodeId,
    insideBuildingId: null,
    ai: newAiState(),
    attackCdMs: 0,
    deadMs: 0,
    kills: 0,
    arrivedAtMs: nowMs,
  };
}

/** Product of all `mul` modifiers plus sum of `add` modifiers for a target, across a hunter's personalities. */
export function personalityFactor(config: GameConfig, hunter: Hunter, target: string): number {
  let mul = 1;
  let add = 0;
  for (const pid of hunter.personalities) {
    const p = config.index.personalities.get(pid);
    if (!p) continue;
    for (const m of p.modifiers) {
      if (m.target !== target) continue;
      if (m.op === 'mul') mul *= m.value;
      else add += m.value;
    }
  }
  return mul + add;
}
