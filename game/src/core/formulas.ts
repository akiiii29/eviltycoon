/**
 * All gameplay formulas live here so design can review and tune them in one place (TECH_SPEC §7).
 * Every formula is a PLACEHOLDER until design signs it off; coefficients come from formula_params.
 */
import type { FormulaParams, GameConfig, GearSlot, MainStat, ModStat, NeedKey, StatKey, ZoneDef } from './config/types';
import { GEAR_SLOTS } from './config/types';
import { personalityFactor } from './hunterFactory';
import type { GearInstance, Hunter, Monster, World } from './world';

export type EffectiveStats = Record<StatKey, number> & { atkSpeed: number };

/** Main stat value of a gear instance: base × quality × (1 + enhance × enhanceStatPerLevel). */
export function gearMainValue(config: GameConfig, g: GearInstance): number {
  const def = config.index.gear.get(g.gearId);
  const q = config.index.qualities.get(g.qualityId);
  if (!def || !q) return 0;
  return def.mainValue * q.statMult * (1 + g.enhance * config.formula.enhanceStatPerLevel);
}

export function gearMainStat(config: GameConfig, g: GearInstance): MainStat | undefined {
  return config.index.gear.get(g.gearId)?.mainStat;
}

/** Job tier stat multiplier for the hunter's current job (1 if unknown). */
export function jobMult(config: GameConfig, h: Hunter): number {
  return config.index.jobsByClass.get(h.classId)?.[h.jobTier]?.statMult ?? 1;
}

/** Sum of a modifier stat over learned traits and active buffs. */
export function modTotal(config: GameConfig, h: Hunter, stat: ModStat): number {
  let v = 0;
  for (const id in h.traits) {
    const t = config.index.traits.get(id);
    if (t && t.stat === stat) v += t.valuePerLevel * h.traits[id]!;
  }
  for (const b of h.buffs) if (b.stat === stat) v += b.value;
  return v;
}

/**
 * Effective stats (placeholder formula, TECH_SPEC §7):
 *   base (= roll + level gains) × job mult × (1 + reincarnation × reincStatBonus)   for hp/atk/def
 *   + equipped gear main stats
 *   × (1 + trait/buff %)                                                            for hp/atk/def
 *   crit/eva + flat trait/buff points; atkSpeed (interval) ÷ (1 + atkSpeedPct%).
 */
export function hunterStats(config: GameConfig, h: Hunter): EffectiveStats {
  const f = config.formula;
  const growth = jobMult(config, h) * (1 + h.reincarnation * f.reincStatBonus);
  const s: EffectiveStats = { ...h.stats };
  s.hp *= growth;
  s.atk *= growth;
  s.def *= growth;
  for (const slot of GEAR_SLOTS) {
    const g = h.equipment[slot];
    if (!g) continue;
    const stat = gearMainStat(config, g);
    if (stat) s[stat] += gearMainValue(config, g);
  }
  s.hp *= 1 + modTotal(config, h, 'hpPct') / 100;
  s.atk *= 1 + modTotal(config, h, 'atkPct') / 100;
  s.def *= 1 + modTotal(config, h, 'defPct') / 100;
  s.crit += modTotal(config, h, 'crit');
  s.eva += modTotal(config, h, 'eva');
  s.atkSpeed /= 1 + modTotal(config, h, 'atkSpeedPct') / 100;
  return s;
}

export interface MonsterStats {
  maxHp: number;
  atk: number;
  def: number;
  exp: number;
  gold: number;
}

/** Monster stats scaled by the difficulty it was spawned under. */
export function monsterStats(config: GameConfig, m: Monster): MonsterStats {
  const def = config.index.monsters.get(m.defId)!;
  const d = config.index.difficulties.get(m.difficultyId) ?? config.difficulties[0]!;
  return {
    maxHp: def.hp * d.monsterHpMul,
    atk: def.atk * d.monsterAtkMul,
    def: def.def * d.monsterDefMul,
    exp: def.exp * d.rewardMul,
    gold: Math.round(def.gold * d.rewardMul),
  };
}

/** Recommended power of a zone under the town's current difficulty (AI zone fit). */
export function zonePower(config: GameConfig, world: World, zone: ZoneDef): number {
  const d = config.index.difficulties.get(world.town.difficulty) ?? config.difficulties[0]!;
  return zone.recommendedPower * Math.sqrt(d.monsterHpMul * d.monsterAtkMul);
}

/** Value of the gear currently in a slot (0 if empty). Used to judge upgrades. */
export function slotValue(config: GameConfig, h: Hunter, slot: GearSlot): number {
  const g = h.equipment[slot];
  return g ? gearMainValue(config, g) : 0;
}

/** Rough combat strength used by the AI to pick a zone: DPS × survivability. */
export function hunterPower(config: GameConfig, h: Hunter): number {
  const s = hunterStats(config, h);
  return (s.atk / s.atkSpeed) * (s.hp / 100);
}

/** Damage after defence: atk × K / (K + def), min 1. */
export function mitigated(atk: number, def: number, f: FormulaParams): number {
  return Math.max(1, (atk * f.defConstant) / (f.defConstant + def));
}

export function expToNext(level: number, f: FormulaParams): number {
  return Math.round(f.expBase * Math.pow(level, f.expExponent));
}

export function needMax(config: GameConfig, h: Hunter, need: NeedKey): number {
  return need === 'hp' ? hunterStats(config, h).hp : config.formula.needMax;
}

export function needFrac(config: GameConfig, h: Hunter, need: NeedKey): number {
  return h.needs[need] / needMax(config, h, need);
}

export function urgentFrac(f: FormulaParams, need: NeedKey): number {
  switch (need) {
    case 'hp': return f.urgentHpFrac;
    case 'satiety': return f.urgentSatietyFrac;
    case 'mood': return f.urgentMoodFrac;
    case 'stamina': return f.urgentStaminaFrac;
  }
}

/**
 * Zone fit (TECH_SPEC §5.3): 0 below min ratio, ramps to 1 at best, flat until "easy",
 * then decays towards 0.4 (too easy = little EXP).
 */
export function zoneFit(power: number, recommended: number, f: FormulaParams): number {
  const r = power / recommended;
  if (r < f.zoneFitMin) return 0;
  if (r < f.zoneFitBest) return 0.3 + (0.7 * (r - f.zoneFitMin)) / (f.zoneFitBest - f.zoneFitMin);
  if (r <= f.zoneFitEasy) return 1;
  return Math.max(0.4, 1 - 0.3 * (r - f.zoneFitEasy));
}

export function moveSpeed(config: GameConfig, h: Hunter): number {
  return config.formula.moveSpeed * personalityFactor(config, h, 'moveSpeed');
}
