import type { ClassDef, GameConfig, InvitationDef, StatKey } from './config/types';
import { HUNTER_TIERS, STAT_KEYS } from './config/types';
import type { Rng } from './rng';
import { newAiState, type Grade, type Hunter, type HunterTier, type Vec2 } from './world';

const GRADE_INDEX: Record<Grade, 0 | 1 | 2> = { normal: 0, high: 1, highest: 2 };

/**
 * GDD §4.2: grade points G = Σ stat_grade.point (N_high + 2 × N_highest) → the highest tier whose hunter_tier minPoints
 * (ceil(minPointsFrac × maxPoints), scaled to the number of graded stats; TECH_SPEC §4.1) G reaches.
 */
export function tierFromPoints(config: GameConfig, points: number): HunterTier {
  const tiers = config.hunterTiers;
  for (let i = tiers.length - 1; i > 0; i--) if (points >= tiers[i]!.minPoints) return tiers[i]!.tier;
  return tiers[0]?.tier ?? 'normal';
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
  return buildHunter(config, rng, id, cls, grades, stats, tierFromPoints(config, points), nodeId, position, nowMs);
}

/** One stat-grade combination (a grade per STAT_KEYS entry) with its natural probability and points. */
interface GradeCombo {
  grades: Grade[];
  weight: number;
  points: number;
}

const COMBOS = new WeakMap<GameConfig, GradeCombo[]>();

/** Every grade combination (3^|STAT_KEYS|), weighted by the product of stat_grade rollChance. Cached per config. */
function gradeCombos(config: GameConfig): GradeCombo[] {
  let out = COMBOS.get(config);
  if (out) return out;
  out = [{ grades: [], weight: 1, points: 0 }];
  for (let i = 0; i < STAT_KEYS.length; i++) {
    const next: GradeCombo[] = [];
    for (const c of out) for (const g of config.statGrades) {
      next.push({ grades: [...c.grades, g.grade], weight: c.weight * g.rollChance, points: c.points + g.point });
    }
    out = next;
  }
  COMBOS.set(config, out);
  return out;
}

/**
 * Natural probability of each hunter tier for a plain visitor (stat_grade odds; tiers the grade points cannot reach are 0).
 * Used by tests / tools to compare with invitation odds.
 */
export function naturalTierOdds(config: GameConfig): Record<HunterTier, number> {
  const out: Record<HunterTier, number> = { normal: 0, rare: 0, superior: 0, heroic: 0, legendary: 0 };
  for (const c of gradeCombos(config)) out[tierFromPoints(config, c.points)] += c.weight;
  return out;
}

/** Roll an invitation's hunter tier (one RNG draw, `tierChances` as relative weights; TECH_SPEC §4.1). */
export function rollInvitationTier(rng: Rng, inv: InvitationDef): HunterTier {
  return rng.weighted(HUNTER_TIERS, (t) => inv.tierChances[t] ?? 0);
}

/**
 * Roll a hunter of a given tier (invitations, TECH_SPEC §4.1): class, then ONE weighted draw over the grade combinations
 * whose points give that tier (tierFromPoints), weighted by their natural probability — the exact natural distribution
 * conditioned on the tier — then the stat values as rollHunter does. Fallback for a config whose hunter_tier leaves a tier
 * unreachable (the shipped table scales with the number of graded stats, so every tier is reachable): take the
 * highest-point combinations, keep the rolled tier and roll each stat in the upper half of its grade range.
 */
export function rollHunterOfTier(
  config: GameConfig, rng: Rng, id: string, tier: HunterTier, nodeId: string, position: Vec2, nowMs: number,
): Hunter {
  const cls = rng.pick(config.classes);
  const all = gradeCombos(config);
  let pool = all.filter((c) => tierFromPoints(config, c.points) === tier && c.weight > 0);
  const reachable = pool.length > 0;
  if (!reachable) {
    const top = Math.max(...all.filter((c) => c.weight > 0).map((c) => c.points));
    pool = all.filter((c) => c.points === top && c.weight > 0);
  }
  const combo = rng.weighted(pool, (c) => c.weight);
  const grades = {} as Record<StatKey, Grade>;
  const stats = {} as Record<StatKey, number>;
  STAT_KEYS.forEach((k, i) => {
    const g = combo.grades[i]!;
    grades[k] = g;
    const [min, max] = cls.statRanges[k][GRADE_INDEX[g]];
    stats[k] = rng.int(reachable ? min : Math.ceil((min + max) / 2), max);
  });
  return buildHunter(config, rng, id, cls, grades, stats, tier, nodeId, position, nowMs);
}

/** `personalitiesPerHunter` distinct personalities by weight (draws one RNG value each). */
export function rollPersonalities(config: GameConfig, rng: Rng): string[] {
  const personalities: string[] = [];
  const pool = config.personalities.filter((p) => p.weight > 0);
  const want = Math.min(config.formula.personalitiesPerHunter, pool.length);
  while (personalities.length < want) {
    const p = rng.weighted(pool.filter((x) => !personalities.includes(x.id)), (x) => x.weight);
    personalities.push(p.id);
  }
  return personalities;
}

function buildHunter(
  config: GameConfig, rng: Rng, id: string, cls: ClassDef, grades: Record<StatKey, Grade>, stats: Record<StatKey, number>,
  tier: HunterTier, nodeId: string, position: Vec2, nowMs: number,
): Hunter {
  const personalities = rollPersonalities(config, rng);
  const max = config.formula.needMax;
  return {
    id,
    classId: cls.id,
    jobTier: 0,
    tier,
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
