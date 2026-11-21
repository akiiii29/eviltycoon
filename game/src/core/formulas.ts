/**
 * All gameplay formulas live here so design can review and tune them in one place (TECH_SPEC §7).
 * Coefficients come from `config/formula_params.json`; no tuning number is written inline here.
 *
 * Combat model (TECH_SPEC §7.1):
 *   hit       = max(minDamage, ATK × (1 − R) × G),  R = min(defReductionCap, DEF / (DEF + defPerLevel·L_att + defFlat))
 *               G = level-gap penalty when the attacker is far below its target
 *   crit      = P(crit) = min(critChanceCap, CRIT%),  × critMultiplier (+ overflow above the cap)
 *   dodge     = P(dodge) = dodgeCap × EVA / (EVA + dodgeHalf)
 *   stacking  = (base × job × reinc + gear) × (1 + Σtrait%) × (1 + Σbuff%) × mood   (each Σ capped)
 *   AI power  = √(kills per life / zoneRefKills), from the same per-hit expectations as the combat system,
 *               × a live crowd factor (monsters alive per hunter in the zone).
 */
import type {
  FormulaParams, GameConfig, GearDef, GearSkillDef, GearSlot, GearStat, MainStat, ModStat, NeedKey, SkillDef, StatKey, ZoneDef,
} from './config/types';
import { GEAR_SLOTS } from './config/types';
import { addItemMods, addSetMods, clampGearStat, emptyMods, type GearMods, hunterGearMods, pctMul, setCounts } from './gear';
import { personalityFactor } from './hunterFactory';
import { growthFlat, jobOf, jobStatMult, mountMul, runeTotal } from './progressionStats';
import { cacheVerifyEnabled, memoHunterStats } from './statsCache';
import type { GearInstance, Hunter, Monster, World } from './world';

export type EffectiveStats = Record<StatKey, number> & { atkSpeed: number };

/** Unit conversion only: stats such as crit/eva and the *Pct modifiers are stored in percent. */
const PERCENT = 100;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Main stat value of a gear instance: base × quality × tier × (1 + enhance × enhanceStatPerLevel).
 * tier = gearStatMul of the difficulty the item was crafted at (TECH_SPEC §5.8; absent/unknown = 1).
 */
export function gearMainValue(config: GameConfig, g: GearInstance): number {
  const def = config.index.gear.get(g.gearId);
  const q = config.index.qualities.get(g.qualityId);
  if (!def || !q) return 0;
  const tier = g.difficultyId ? (config.index.difficulties.get(g.difficultyId)?.gearStatMul ?? 1) : 1;
  return def.mainValue * q.statMult * tier * (1 + g.enhance * config.formula.enhanceStatPerLevel);
}

export function gearMainStat(config: GameConfig, g: GearInstance): MainStat | undefined {
  return config.index.gear.get(g.gearId)?.mainStat;
}

/** Job stat multiplier (statMult, before the per-stat statBias) of the hunter's current job (1 if unknown). */
export function jobMult(config: GameConfig, h: Hunter): number {
  return jobOf(config, h)?.statMult ?? 1;
}

/** Sum of a modifier stat over learned traits (permanent category). */
export function traitTotal(config: GameConfig, h: Hunter, stat: ModStat): number {
  let v = 0;
  for (const id in h.traits) {
    const t = config.index.traits.get(id);
    if (t && t.stat === stat) v += t.valuePerLevel * h.traits[id]!;
  }
  return v;
}

/** Sum of a modifier stat over active skill buffs (temporary category). */
export function buffTotal(h: Hunter, stat: ModStat): number {
  let v = 0;
  for (const b of h.buffs) if (b.stat === stat) v += b.value;
  return v;
}

/** Sum of a modifier stat over learned traits and active buffs (uncapped; for display). */
export function modTotal(config: GameConfig, h: Hunter, stat: ModStat): number {
  return traitTotal(config, h, stat) + buffTotal(h, stat);
}

/**
 * Buff stacking rule for percentage modifiers: additive inside a category, multiplicative across
 * categories, each category capped:
 *   mult = (1 + min(traitPctCap, Σtrait%)/100) × (1 + min(buffPctCap, Σbuff%)/100)
 * Two +20 % buffs give +40 % (not +44 %), a +20 % trait with a +20 % buff gives +44 %; neither category can
 * run away on its own. Negative sums are clamped to 0 (no debuffs yet).
 */
export function stackPct(traitPct: number, buffPct: number, f: FormulaParams): number {
  return (1 + clamp(traitPct, 0, f.traitPctCap) / PERCENT) * (1 + clamp(buffPct, 0, f.buffPctCap) / PERCENT);
}

/**
 * Mood multiplier on ATK/DEF (GDD §4.2 "other stats scale with Mood"): 1 while mood ≥ moodPenaltyFrac × max,
 * then falls linearly to moodStatFloor at mood 0. moodStatFloor = 1 switches the effect off.
 */
export function moodStatMult(moodFrac: number, f: FormulaParams): number {
  if (f.moodPenaltyFrac <= 0) return 1;
  const short = clamp((f.moodPenaltyFrac - moodFrac) / f.moodPenaltyFrac, 0, 1);
  return 1 - (1 - f.moodStatFloor) * short;
}

/**
 * Planning stats for the AI's zone and retreat model (TECH_SPEC §5.2, §5.3): steady stats (no temporary buffs, so
 * zone choice does not flip when a buff expires) but WITH the current mood multiplier on ATK/DEF, since mood only
 * changes slowly in the field (monster attacks) and is what the hunter will actually fight with:
 *   atk/def = steady × moodStatMult(mood).
 * Not memoised itself: derived from the memoised steady stats (mood is read here, not inside hunterStats' steady slot).
 */
export function planStats(config: GameConfig, h: Hunter): EffectiveStats {
  const s = hunterStats(config, h, { steady: true });
  const m = moodStatMult(h.needs.mood / config.formula.needMax, config.formula);
  return m === 1 ? s : { ...s, atk: s.atk * m, def: s.def * m };
}

export interface StatOptions {
  /**
   * Steady-state stats: ignore temporary buffs and mood. Used by the AI power estimate so zone choice does not
   * flip every time a buff expires or mood dips.
   */
  steady?: boolean;
}

/**
 * Effective stats:
 *   hp/atk/def = ((base + growth) × jobMult × statBias × (1 + reinc × reincStatBonus) + gear) × stackPct(trait% + rune%, buff%) [× mood for atk/def]
 *   crit/eva   = base + job + trait points + rune points + buff points (converted to chances by critChance / dodgeChance, which cap)
 * (M5 job tree, growth properties and runes: progressionStats.ts, TECH_SPEC §5.16.)
 *   atkSpeed   = max(minAttackInterval, base interval ÷ stackPct(traitSpeed%, buffSpeed%))
 */
export function hunterStats(config: GameConfig, h: Hunter, opts: StatOptions = {}): EffectiveStats {
  // Memoised per hunter, recomputed whenever an input changes (statsCache.ts); the result is frozen.
  const steady = !!opts.steady;
  return memoHunterStats(config, h, steady, () => computeHunterStats(config, h, steady)) as EffectiveStats;
}

function computeHunterStats(config: GameConfig, h: Hunter, steady: boolean): EffectiveStats {
  const f = config.formula;
  const buffs = !steady;
  const reinc = 1 + h.reincarnation * f.reincStatBonus;
  const job = jobOf(config, h);
  const s: EffectiveStats = { ...h.stats };
  s.hp = (s.hp + growthFlat(config, h, 'hp')) * (jobStatMult(job, 'hp') * reinc);
  s.atk = (s.atk + growthFlat(config, h, 'atk')) * (jobStatMult(job, 'atk') * reinc);
  s.def = (s.def + growthFlat(config, h, 'def')) * (jobStatMult(job, 'def') * reinc);
  let equipped = false;
  for (const slot of GEAR_SLOTS) {
    const g = h.equipment[slot];
    if (!g) continue;
    equipped = true;
    const stat = gearMainStat(config, g);
    if (stat) s[stat] += gearMainValue(config, g);
  }
  // M5 gear category (option lines + set bonuses, TECH_SPEC §4.2): its own % category, clamped to
  // [gearPctFloor, gearPctCap] (may be negative), × the trait/rune/buff categories; crit/eva add flat points.
  const gm = equipped ? hunterGearMods(config, h).mods : null;
  const gp = (stat: ModStat) => (gm && gm[stat] !== 0 ? pctMul(clampGearStat(config, stat, gm[stat])) : 1);
  const perm = (stat: ModStat) => traitTotal(config, h, stat) + runeTotal(config, h, stat);
  const pct = (stat: ModStat) => stackPct(perm(stat), buffs ? buffTotal(h, stat) : 0, f);
  const mood = buffs ? moodStatMult(h.needs.mood / f.needMax, f) : 1;
  // Town aura (monument, TECH_SPEC §5.15): its own multiplicative category, steady and live; absent = × 1.
  const aura = (stat: ModStat) => 1 + (h.aura?.[stat] ?? 0) / PERCENT;
  s.hp *= pct('hpPct') * gp('hpPct') * aura('hpPct');
  s.atk *= pct('atkPct') * gp('atkPct') * mood * aura('atkPct');
  s.def *= pct('defPct') * gp('defPct') * mood * aura('defPct');
  s.crit += (job?.crit ?? 0) + perm('crit') + (buffs ? buffTotal(h, 'crit') : 0) + (gm ? gm.crit : 0);
  s.eva += (job?.eva ?? 0) + perm('eva') + (buffs ? buffTotal(h, 'eva') : 0) + (gm ? gm.eva : 0);
  s.atkSpeed = Math.max(f.minAttackInterval, s.atkSpeed / (pct('atkSpeedPct') * gp('atkSpeedPct')));
  return s;
}

export interface MonsterStats {
  level: number;
  maxHp: number;
  atk: number;
  def: number;
  /** Seconds between attacks. */
  attackSpeed: number;
  /** Crit stat in percent (chance via critChance). */
  crit: number;
  exp: number;
  gold: number;
}

/** Stats of a monster type under a difficulty (unknown difficulty = the starting one). */
export function monsterTypeStats(config: GameConfig, defId: string, difficultyId: string): MonsterStats {
  const def = config.index.monsters.get(defId)!;
  const d = config.index.difficulties.get(difficultyId) ?? config.difficulties[0]!;
  return {
    level: def.level,
    maxHp: def.hp * d.monsterHpMul,
    atk: def.atk * d.monsterAtkMul,
    def: def.def * d.monsterDefMul,
    attackSpeed: def.attackSpeed,
    crit: def.crit,
    exp: def.exp * d.rewardMul,
    gold: Math.round(def.gold * d.rewardMul),
  };
}

/** Monster stats scaled by the difficulty it was spawned under. */
export function monsterStats(config: GameConfig, m: Monster): MonsterStats {
  return monsterTypeStats(config, m.defId, m.difficultyId);
}

/**
 * Value of the gear currently in a slot (0 if empty), in units of its main stat (gearScore). Used to judge upgrades.
 * Memoised per (steady stats object, slot): the steady stats object changes whenever an input of the score does
 * (level, base stats, job, reincarnation, equipment incl. option lines — statsCache.ts).
 */
export function slotValue(config: GameConfig, h: Hunter, slot: GearSlot): number {
  const g = h.equipment[slot];
  if (!g) return 0;
  const s = hunterStats(config, h, { steady: true });
  let per = slotValueCache.get(s);
  if (!per) { per = new Map(); slotValueCache.set(s, per); }
  const hit = per.get(slot);
  if (hit !== undefined && hit.uid === g.uid) {
    if (cacheVerifyEnabled() && !Object.is(hit.v, gearScore(config, h, g, slot))) throw new Error(`slotValue: stale value for ${h.id} ${slot}`);
    return hit.v;
  }
  const v = gearScore(config, h, g, slot);
  per.set(slot, { uid: g.uid, v });
  return v;
}

const slotValueCache = new WeakMap<object, Map<GearSlot, { uid: string; v: number }>>();

// ---------------------------------------------------------------------------------------------------------------
// M5 gear valuation for the AI (TECH_SPEC §5.4): option lines, set bonuses and gear skills converted into units of the
// item's main stat, so upgrade gains stay slot-relative ((new − cur) / cur) as minUpgradeGain etc. were tuned for.
//   power P = √(DPS × effective HP)   →   score = main + Δln P(extras) / (∂ln P / ∂main)
// ---------------------------------------------------------------------------------------------------------------

/** Unclamped main-stat total before % modifiers: base × job × reinc + Σ equipped main values of that stat. */
function rawMainTotal(config: GameConfig, h: Hunter, stat: MainStat): number {
  // Same base as computeHunterStats: (roll + growth property) × job × reincarnation.
  const growth = jobStatMult(jobOf(config, h), stat) * (1 + h.reincarnation * config.formula.reincStatBonus);
  let v = (h.stats[stat] + growthFlat(config, h, stat)) * growth;
  for (const slot of GEAR_SLOTS) {
    const g = h.equipment[slot];
    if (g && gearMainStat(config, g) === stat) v += gearMainValue(config, g);
  }
  return v;
}

/** DEF "half value" vs a monster of the hunter's level (defReduction): Δln EHP / ΔDEF = 1 / (DEF + half) below the knee. */
function defHalf(config: GameConfig, h: Hunter): number {
  return config.formula.defPerLevel * Math.max(1, h.level) + config.formula.defFlat;
}

/** ∂ln P / ∂(one point of raw main stat), from the hunter's steady stats. */
export function mainStatWorth(config: GameConfig, h: Hunter, stat: MainStat): number {
  const s = hunterStats(config, h, { steady: true });
  const raw = Math.max(1, rawMainTotal(config, h, stat));
  if (stat === 'def') return (0.5 * (s.def / raw)) / Math.max(1e-9, s.def + defHalf(config, h));
  return 0.5 / raw;
}

/** Δln P of adding `mods` (gear stats) and gear `skills` to a hunter with steady stats `s` (linearised for % stats). */
export function gearModsWorth(config: GameConfig, h: Hunter, s: EffectiveStats, mods: Partial<GearMods>, skills: readonly GearSkillDef[] = []): number {
  const f = config.formula;
  let w = 0;
  const v = (k: GearStat) => mods[k] ?? 0;
  w += 0.5 * (v('atkPct') + v('hpPct')) / PERCENT;
  if (s.atkSpeed > f.minAttackInterval + 1e-9) w += (0.5 * v('atkSpeedPct')) / PERCENT;
  if (v('defPct') !== 0) w += (0.5 * (v('defPct') / PERCENT) * s.def) / Math.max(1e-9, s.def + defHalf(config, h));
  if (v('crit') !== 0) {
    const e = (c: number) => 1 + critChance(c, f) * (critMultiplier(c, f.critMultiplier, f) - 1);
    w += 0.5 * Math.log(e(s.crit + v('crit')) / e(s.crit));
  }
  if (v('eva') !== 0) w += 0.5 * Math.log((1 - dodgeChance(s.eva, f)) / (1 - dodgeChance(Math.max(0, s.eva + v('eva')), f)));
  w += v('lifesteal') * f.gearWorthLifesteal + v('goldPct') * f.gearWorthGoldPct + v('expPct') * f.gearWorthExpPct;
  w += v('dropPct') * f.gearWorthDropPct + v('needSavePct') * f.gearWorthNeedSavePct;
  for (const gs of skills) w += gearSkillWorth(config, h, s, gs);
  return w;
}

/** Expected casts per second of a gear skill: one proc every 1/chance attacks, then its cooldown. */
export function gearSkillRate(gs: GearSkillDef, atkInterval: number): number {
  if (!(gs.chance > 0)) return 0;
  return 1 / (atkInterval / gs.chance + gs.cooldownSec);
}

/** Δln P of a gear skill: damage skills add rate × mult × interval of the auto-attack DPS; buffs their stat × uptime. */
function gearSkillWorth(config: GameConfig, h: Hunter, s: EffectiveStats, gs: GearSkillDef): number {
  const sk = config.index.skills.get(gs.skillId);
  if (!sk) return 0;
  const lvl = Math.max(1, Math.min(gs.skillLevel, sk.value.length));
  const rate = gearSkillRate(gs, s.atkSpeed);
  if (sk.kind !== 'buff') return 0.5 * Math.log(1 + rate * sk.value[lvl - 1]! * s.atkSpeed);
  if (!sk.buffStat) return 0;
  const uptime = Math.min(1, (sk.keepSec?.[lvl - 1] ?? 0) * rate);
  return gearModsWorth(config, h, s, { [sk.buffStat]: sk.value[lvl - 1]! * uptime });
}

/**
 * A piece's share of its set bonus: Δln P of the (cumulative) bonus reached with `item` in `slot` (the hunter's other
 * slots as they are), divided by the number of pieces worn. An equal share rather than the marginal threshold bonus:
 * with a marginal credit every piece of a 4-piece set carries the whole 4-piece bonus, so no single swap ever looks
 * like an upgrade and hunters keep a low-level set for 40+ levels (seen in headless runs).
 */
function setShareWorth(config: GameConfig, h: Hunter, s: EffectiveStats, slot: GearSlot, item: GearInstance): number {
  const setId = config.index.gear.get(item.gearId)?.setId;
  if (!setId) return 0;
  const n = setCounts(config, h.equipment, { slot, item }).get(setId) ?? 0;
  if (n <= 0) return 0;
  const mods = emptyMods();
  const skills: GearSkillDef[] = [];
  addSetMods(config, new Map([[setId, n]]), mods, skills);
  return gearModsWorth(config, h, s, mods, skills) / n;
}

/** Extras (options, set share) in main-stat units, kept within ±gearExtraMaxFrac × the item's main value. */
function capExtra(config: GameConfig, extra: number, main: number): number {
  const cap = (config.formula.gearExtraMaxFrac ?? Infinity) * Math.max(0, main);
  return Math.max(-cap, Math.min(cap, extra));
}

/**
 * AI value of a gear instance for a hunter, in units of its main stat (TECH_SPEC §5.4):
 *   gearScore = gearMainValue + clamp(Δln P(option lines + gear skills + set share in `slot`) / mainStatWorth, ±gearExtraMaxFrac × main).
 * Plain items (no option lines, no set) score exactly gearMainValue, so the old upgrade rules are unchanged for them.
 */
export function gearScore(config: GameConfig, h: Hunter, g: GearInstance, slot?: GearSlot): number {
  const def = config.index.gear.get(g.gearId);
  if (!def) return 0;
  const main = gearMainValue(config, g);
  if (!g.options?.length && !def.setId) return main;
  const mods = emptyMods();
  const skills: GearSkillDef[] = [];
  addItemMods(config, g, mods, skills);
  const s = hunterStats(config, h, { steady: true });
  const w = gearModsWorth(config, h, s, mods, skills) + setShareWorth(config, h, s, slot ?? def.slot, g);
  return main + capExtra(config, w / mainStatWorth(config, h, def.mainStat), main);
}

/**
 * gearScore of a piece not rolled yet (theoretical craft, job in progress) whose main value is `mainValue`:
 * mainValue + its set share (capped like gearScore). Option lines are NOT anticipated: half of all crafts roll none and a
 * mean would make a same-tier recraft look like an upgrade (savings held and crafts made for a coin flip); the lines an
 * item actually has count once it is on sale (gearScore).
 */
export function expectedGearScore(config: GameConfig, h: Hunter, def: GearDef, mainValue: number): number {
  return mainValue + capExtra(config, expectedGearExtra(config, h, def), mainValue);
}

/** The uncapped part of expectedGearScore beyond the main value (same for every quality roll of a recipe): the set share. */
export function expectedGearExtra(config: GameConfig, h: Hunter, def: GearDef): number {
  if (!def.setId) return 0;
  const s = hunterStats(config, h, { steady: true });
  const w = setShareWorth(config, h, s, def.slot, { uid: '', gearId: def.id, qualityId: '', enhance: 0 });
  return w === 0 ? 0 : w / mainStatWorth(config, h, def.mainStat);
}

// ---------------------------------------------------------------------------------------------------------------
// Per-hit combat formulas (used by systems/combat.ts and by the AI estimate below — one source of truth).
// ---------------------------------------------------------------------------------------------------------------

/**
 * Fraction of damage removed by DEF (TECH_SPEC §7.1):
 *   raw = DEF / (DEF + defPerLevel · L_att + defFlat)
 *   R   = raw                                                         if raw ≤ defSoftKnee
 *         cap − (cap − knee) · exp(−(raw − knee) / (cap − knee))       above the knee   (cap = defReductionCap)
 * Hyperbolic, so it rises with DEF with diminishing returns and never reaches 100 %. The "half-value" DEF
 * (R = 50 %) scales with the ATTACKER's level, so the same DEF stays meaningful over 100 levels and a hunter
 * who out-levels a zone shrugs off its monsters (and vice versa: a low-level hunter's DEF counts for little
 * against a high-level monster). Above the knee R bends smoothly (same value and slope at the knee) towards the
 * cap and never reaches it, so extra DEF (e.g. monsterDefMul on Torment against a reincarnated low-level hunter)
 * always counts a little instead of being wasted at a hard clamp; every hit keeps more than (1 − cap) × ATK.
 * defSoftKnee ≥ defReductionCap is the old hard clamp min(cap, raw).
 */
export function defReduction(def: number, attackerLevel: number, f: FormulaParams): number {
  const d = Math.max(0, def);
  const half = f.defPerLevel * Math.max(1, attackerLevel) + f.defFlat;
  const raw = d / (d + half);
  const cap = f.defReductionCap;
  const knee = Math.min(f.defSoftKnee, cap);
  if (raw <= knee) return raw;
  if (knee >= cap) return cap;
  return cap - (cap - knee) * Math.exp(-(raw - knee) / (cap - knee));
}

/**
 * Level-gap multiplier on damage:  G = max(levelGapMin, 1 − levelGapStep × max(0, L_def − L_att − levelGapGrace)).
 * Only an attacker that is more than levelGapGrace levels BELOW its target is penalised (no bonus for being
 * higher). Effect: monsters of zones a hunter has out-grown barely scratch it on the way through, and a hunter
 * who walks into a zone above its level deals less, so the AI's power ratio holds it back until it is ready.
 */
export function levelGapMult(attackerLevel: number, defenderLevel: number, f: FormulaParams): number {
  const under = Math.max(0, defenderLevel - attackerLevel - f.levelGapGrace);
  return Math.max(f.levelGapMin, 1 - f.levelGapStep * under);
}

/** Damage of one non-crit hit:  max(minDamage, ATK × (1 − R) × G). Never 0 or negative. */
export function mitigated(atk: number, def: number, attackerLevel: number, defenderLevel: number, f: FormulaParams): number {
  return Math.max(f.minDamage, Math.max(0, atk) * (1 - defReduction(def, attackerLevel, f)) * levelGapMult(attackerLevel, defenderLevel, f));
}

/** Crit chance from the crit stat (percent points):  min(critChanceCap, CRIT / 100). */
export function critChance(crit: number, f: FormulaParams): number {
  return clamp(crit / PERCENT, 0, f.critChanceCap);
}

/**
 * Crit damage multiplier:  base + critOverflowMult × max(0, CRIT/100 − critChanceCap).
 * Crit points past the chance cap are not wasted: they turn into crit damage. Hunters use base = critMultiplier,
 * monsters base = monsterCritMultiplier.
 */
export function critMultiplier(crit: number, base: number, f: FormulaParams): number {
  return base + f.critOverflowMult * Math.max(0, crit / PERCENT - f.critChanceCap);
}

/**
 * Dodge chance from EVA:  dodgeCap × EVA / (EVA + dodgeHalf). Diminishing returns, half of the cap at
 * EVA = dodgeHalf, never reaches dodgeCap (no untouchable builds).
 */
export function dodgeChance(eva: number, f: FormulaParams): number {
  if (!(eva > 0)) return 0;
  return (f.dodgeCap * eva) / (eva + f.dodgeHalf);
}

/** Expected damage of one attack:  hit × (1 − P(dodge)) × (1 + P(crit) × (critMult − 1)). */
export function expectedHit(
  atk: number, def: number, attackerLevel: number, defenderLevel: number, crit: number, critBase: number, defenderEva: number,
  f: FormulaParams,
): number {
  const p = critChance(crit, f);
  return mitigated(atk, def, attackerLevel, defenderLevel, f) * (1 - dodgeChance(defenderEva, f)) * (1 + p * (critMultiplier(crit, critBase, f) - 1));
}

// ---------------------------------------------------------------------------------------------------------------
// AI estimate: expected duel, power ratio and zone fitness (TECH_SPEC §5.3).
// ---------------------------------------------------------------------------------------------------------------

/** Damage skills the hunter can auto-cast right now (learned, job tier unlocked). */
function damageSkills(config: GameConfig, h: Hunter): { sk: SkillDef; mult: number }[] {
  const out: { sk: SkillDef; mult: number }[] = [];
  for (const sk of config.skills) {
    if (sk.classId !== h.classId || sk.kind === 'buff' || sk.jobTierMin > h.jobTier) continue;
    const lvl = Math.min(h.skills[sk.id] ?? 0, sk.value.length);
    if (lvl >= 1) out.push({ sk, mult: sk.value[lvl - 1]! });
  }
  return out;
}

/** Damage gear skills (strike/aoe) of the hunter's equipment, with the multiplier of their skill level. */
function gearDamageSkills(config: GameConfig, h: Hunter): { gs: GearSkillDef; mult: number }[] {
  if (config.gearSkills.length === 0) return [];
  let any = false;
  for (const slot of GEAR_SLOTS) if (h.equipment[slot]) { any = true; break; }
  if (!any) return [];
  const gm = hunterGearMods(config, h); // memoised and frozen: key the derived list on it
  const hit = gearDamageCache.get(gm);
  if (hit) return hit;
  const out: { gs: GearSkillDef; mult: number }[] = [];
  for (const gs of gm.skills) {
    const sk = config.index.skills.get(gs.skillId);
    if (!sk || sk.kind === 'buff') continue;
    out.push({ gs, mult: sk.value[Math.max(1, Math.min(gs.skillLevel, sk.value.length)) - 1]! });
  }
  gearDamageCache.set(gm, out);
  return out;
}

const gearDamageCache = new WeakMap<object, { gs: GearSkillDef; mult: number }[]>();

export interface Duel {
  /** Expected damage per second the hunter deals to this monster (auto-attacks + damage skills, single target). */
  hunterDps: number;
  /** Expected damage per second the monster deals to the hunter. */
  monsterDps: number;
  /** Expected time to kill: maxHp / hunterDps. */
  ttk: number;
  /** Expected HP lost per kill: monsterDps × ttk. */
  dmgPerKill: number;
}

/**
 * Expected 1-v-1 fight, built only from expectedHit:
 *   hunterDps = E[hit(ATK)] / atkSpeed + Σ_skills E[hit(ATK × mult)] / cooldown
 *   monsterDps = E[hit(monster ATK)] / monster attackSpeed
 * Continuous approximation (ignores overkill on the last hit and time spent walking between monsters).
 */
export function duel(config: GameConfig, h: Hunter, s: EffectiveStats, m: MonsterStats): Duel {
  const f = config.formula;
  const hit = (atk: number) => expectedHit(atk, m.def, h.level, m.level, s.crit, f.critMultiplier, 0, f);
  let hunterDps = hit(s.atk) / s.atkSpeed;
  for (const { sk, mult } of damageSkills(config, h)) hunterDps += hit(s.atk * mult) / sk.cooldownSec;
  // M5 gear skills (damage kinds): proc rate gearSkillRate × one hit of the level's multiplier (single target).
  for (const gs of gearDamageSkills(config, h)) hunterDps += hit(s.atk * gs.mult) * gearSkillRate(gs.gs, s.atkSpeed);
  const monsterDps = expectedHit(m.atk, s.def, m.level, h.level, m.crit, f.monsterCritMultiplier, s.eva, f) / m.attackSpeed;
  const ttk = m.maxHp / hunterDps;
  return { hunterDps, monsterDps, ttk, dmgPerKill: monsterDps * ttk };
}

/**
 * Static crowd factor, used only where there is no live zone to look at (journeys, formulas.zonePower):
 *   zoneCrowdRespawnSec / respawnSec.
 * The AI uses the live crowd factor (crowdFactor / zoneOccupancy) instead.
 */
export function zoneCrowd(zone: ZoneDef, f: FormulaParams): number {
  return f.zoneCrowdRespawnSec / zone.respawnSec;
}

/**
 * Live crowd factor on the 1-v-1 duel's damage per kill (TECH_SPEC §5.3), from the monsters alive in the zone per
 * hunter hunting it (this one included):
 *   ρ = max(zoneCrowdMinRho, alive / hunters),   crowd = zoneCrowdMul × √ρ.
 * EMPIRICAL fit to headless runs (seeds 1–10, 15 h, every zone): measured HP lost per kill / duel prediction lies on
 * one curve of ρ in all zones — a lone hunter in a full zone (ρ ≈ 10–12) pulls adds and takes ≈ 2× the duel, hunters
 * sharing a zone split the aggro and gang up on each target (ρ ≈ 3 → ≈ 1.1×, ρ ≈ 0.25 → ≈ 0.3×). Respawn speed,
 * monster cap and aggro range act through ρ (a fast-respawn zone stays full under more hunters).
 */
export function crowdFactor(alive: number, hunters: number, f: FormulaParams): number {
  return f.zoneCrowdMul * Math.sqrt(Math.max(f.zoneCrowdMinRho, Math.max(0, alive) / Math.max(1, hunters)));
}

/** Monsters alive per zone and hunters whose goal is to hunt it (crowdFactor inputs), from world state. */
export interface ZoneOccupancy {
  alive: Map<string, number>;
  hunters: Map<string, number>;
}

/**
 * Live occupancy of every zone. A zone that has never been visited counts as full (monsterCap): the first visit
 * fills it. `excludeHunterId` is left out of the hunter counts (the hunter judging the zones adds itself as + 1).
 */
export function zoneOccupancy(config: GameConfig, world: World, excludeHunterId?: string): ZoneOccupancy {
  const alive = new Map<string, number>();
  const hunters = new Map<string, number>();
  for (const z of config.zones) alive.set(z.id, world.zones[z.id] ? 0 : z.monsterCap);
  for (const m of world.monsters) if (m.hp > 0 && world.zones[m.zoneId]) alive.set(m.zoneId, (alive.get(m.zoneId) ?? 0) + 1);
  for (const o of world.hunters) {
    if (o.id !== excludeHunterId && o.ai.goal?.type === 'hunt') hunters.set(o.ai.goal.zoneId, (hunters.get(o.ai.goal.zoneId) ?? 0) + 1);
  }
  return { alive, hunters };
}

/** Live crowd factor of a zone for a hunter not counted in `occ` (it adds itself as one more hunter). */
export function liveCrowd(occ: ZoneOccupancy, zone: ZoneDef, f: FormulaParams): number {
  return crowdFactor(occ.alive.get(zone.id) ?? zone.monsterCap, 1 + (occ.hunters.get(zone.id) ?? 0), f);
}

/**
 * Expected kills per full HP bar in a zone, against its spawn mix (weights = spawn weights):
 *   killsPerLife = HP / (crowd × Σ_w dmgPerKill / Σ_w)
 * `crowd` defaults to the static zoneCrowd (journeys); the AI passes the live crowdFactor.
 * This is the Lanchester-style "DPS × HP vs DPS × HP" product: doubling either the hunter's damage or its
 * effective HP doubles it. Uses steady stats (no buffs) so zone choice does not flap; `withMood` adds the current mood
 * multiplier (planStats), which the live AI uses (powerRatio, zoneScores).
 */
export function killsPerLife(config: GameConfig, h: Hunter, zone: ZoneDef, difficultyId: string, crowd?: number, withMood = false): number {
  return zoneEstimate(config, h, zone, difficultyId, crowd, withMood).killsPerLife;
}

export interface ZoneEstimate {
  /** Expected kills per full HP bar (see killsPerLife). */
  killsPerLife: number;
  /** Spawn-weighted mean time to kill one monster, seconds. */
  ttk: number;
}

/**
 * killsPerLife and mean TTK of a hunter in a zone, from duel() over the zone's spawn mix (crowd: see killsPerLife).
 * `withMood` (the AI's live zone choice): planStats, i.e. steady stats × the current mood multiplier on ATK/DEF;
 * without it (journeys, offline model) plain steady stats.
 */
export function zoneEstimate(
  config: GameConfig, h: Hunter, zone: ZoneDef, difficultyId: string, crowd = zoneCrowd(zone, config.formula), withMood = false,
): ZoneEstimate {
  const s = withMood ? planStats(config, h) : hunterStats(config, h, { steady: true });
  let w = 0, dmg = 0, ttk = 0;
  for (const e of zone.monsters) {
    const d = duel(config, h, s, monsterTypeStats(config, e.monsterId, difficultyId));
    w += e.weight;
    dmg += e.weight * d.dmgPerKill;
    ttk += e.weight * d.ttk;
  }
  dmg *= crowd;
  return { killsPerLife: dmg > 0 ? (s.hp * w) / dmg : Infinity, ttk: w > 0 ? ttk / w : Infinity };
}

/**
 * Power ratio of a hunter for a zone:  √(killsPerLife / zoneRefKills).
 * 1 = the hunter can take `zoneRefKills` kills on one HP bar (the design target for a comfortable zone).
 * The square root makes the ratio linear in stats: a hunter with 2× damage AND 2× effective HP scores 2×,
 * which keeps the zoneFit thresholds (0.7 / 1.1 / 2) readable.
 */
export function powerRatio(config: GameConfig, world: World, h: Hunter, zone: ZoneDef): number {
  const crowd = liveCrowd(zoneOccupancy(config, world, h.id), zone, config.formula);
  return ratioFromKills(killsPerLife(config, h, zone, world.town.difficulty, crowd, true), config.formula);
}

function ratioFromKills(kills: number, f: FormulaParams): number {
  return Math.sqrt(kills / f.zoneRefKills);
}

/**
 * powerRatio against a zone's spawn mix at an explicit difficulty (journeys snapshot it at departure). No live zone:
 * uses the static zoneCrowd and its own reference journeyRefKills (= the zoneRefKills the journey targets were set
 * with), so the journey power targets (config/journey.json) keep their meaning when the AI's zoneRefKills is retuned:
 *   √(killsPerLife(static crowd) / journeyRefKills).
 */
export function zonePower(config: GameConfig, h: Hunter, zone: ZoneDef, difficultyId: string): number {
  return Math.sqrt(killsPerLife(config, h, zone, difficultyId) / config.formula.journeyRefKills);
}

/**
 * Journey team power (TECH_SPEC §5.11): Σ zonePower of the members against the destination's foes. powerRatio is
 * linear in stats (2× DPS and 2× HP → 2×), so n identical hunters add up to n×, the same as one hunter with n× DPS
 * and n× HP (Lanchester-style). 1 per member = each could take zoneRefKills kills on one HP bar there.
 */
export function teamPower(config: GameConfig, team: readonly Hunter[], zone: ZoneDef, difficultyId: string): number {
  let p = 0;
  for (const h of team) p += zonePower(config, h, zone, difficultyId);
  return p;
}

/**
 * Journey success chance from team power P vs the destination's recommended power R:
 *   clamp(journeySuccessAtRec × (P / R)^journeySuccessExp, journeySuccessMin, journeySuccessMax)
 * Monotone in P; journeySuccessAtRec exactly at the recommendation; never certain either way.
 */
export function journeySuccessChance(power: number, recommended: number, f: FormulaParams): number {
  const r = recommended > 0 ? Math.max(0, power) / recommended : 0;
  const p = f.journeySuccessAtRec * Math.pow(r, f.journeySuccessExp);
  return clamp(Number.isFinite(p) ? p : f.journeySuccessMax, f.journeySuccessMin, f.journeySuccessMax);
}

/**
 * Share of the hunter's potential kill rate a zone can actually supply when n hunters (this one included)
 * hunt it: a zone respawns one monster per respawnSec, so
 *   share = min(1, (1 / respawnSec) / (n / ttk)) = min(1, ttk / (n × respawnSec)).
 * Applied softly to the fit as zoneShareFloor + (1 − zoneShareFloor) × share, so a crowded zone is still a
 * valid choice but hunters spread out instead of all starving in the same field.
 */
export function zoneShare(ttk: number, hunters: number, zone: ZoneDef): number {
  return Math.min(1, ttk / (Math.max(1, hunters) * zone.respawnSec));
}

/**
 * Zone-independent strength for display / telemetry only (the AI uses powerRatio):
 *   √(DPS vs 0 DEF × effective HP),  effective HP = HP / (1 − P(dodge)).
 */
export function hunterPower(config: GameConfig, h: Hunter): number {
  const f = config.formula;
  const s = hunterStats(config, h, { steady: true });
  const dps = (s.atk * (1 + critChance(s.crit, f) * (critMultiplier(s.crit, f.critMultiplier, f) - 1))) / s.atkSpeed;
  return Math.sqrt(dps * (s.hp / (1 - dodgeChance(s.eva, f))));
}

/**
 * Zone fit from the power ratio r (TECH_SPEC §5.3):
 *   r < zoneFitMin            → 0 (too dangerous)
 *   zoneFitMin ≤ r < Best     → linear ramp from zoneFitRampLow to 1
 *   Best ≤ r ≤ Easy           → 1
 *   r > Easy                  → max(zoneFitFloor, 1 − zoneFitDecay × (r − Easy))   (too easy, little EXP)
 */
export function zoneFit(r: number, f: FormulaParams): number {
  if (!(r >= f.zoneFitMin)) return 0;
  if (r < f.zoneFitBest) return f.zoneFitRampLow + ((1 - f.zoneFitRampLow) * (r - f.zoneFitMin)) / (f.zoneFitBest - f.zoneFitMin);
  if (r <= f.zoneFitEasy) return 1;
  return Math.max(f.zoneFitFloor, 1 - f.zoneFitDecay * (r - f.zoneFitEasy));
}

export interface ZoneScore {
  zone: ZoneDef;
  ratio: number;
  fit: number;
}

/**
 * Fit of every zone (config order = progression order): zoneFit(ratio) — ratio with the live crowd factor
 * (zoneOccupancy: monsters alive there; the other hunters whose goal is to hunt there, + 1 for this one) — × crowding
 * (zoneShare, same hunter count), rescaled so the best zone keeps max zoneFit; then a tie-break towards
 * harder zones: among the zones
 * that are comfortable (ratio ≥ zoneFitBest), the hardest one keeps its fit and each easier comfortable zone
 * loses zoneTierBonus per tier below it. A hunter that out-classes every zone (all at zoneFitFloor) therefore
 * goes to the hardest one instead of a random/easiest one. zoneTierBonus (> decisionNoise) is applied at fit
 * level; the goal score is fit × needsOk × personality, so for e.g. a timid hunter (× 0.7) or low needs ADJACENT
 * tiers can fall within the decision noise, while zones two or more tiers down stay clearly behind.
 * The best zone's score is never raised, so other goals are unaffected.
 * `withMood`: judge with planStats (current mood on ATK/DEF) — the live AI (scoreGoals) does; the offline model and
 * other callers keep steady stats.
 */
export function zoneScores(config: GameConfig, world: World, h: Hunter, withMood = false): ZoneScore[] {
  const f = config.formula;
  const occ = zoneOccupancy(config, world, h.id);
  let bestRaw = 0, bestAdj = 0;
  const out = config.zones.map((zone) => {
    const est = zoneEstimate(config, h, zone, world.town.difficulty, liveCrowd(occ, zone, f), withMood);
    const ratio = ratioFromKills(est.killsPerLife, f);
    const share = zoneShare(est.ttk, 1 + (occ.hunters.get(zone.id) ?? 0), zone);
    const raw = zoneFit(ratio, f);
    const fit = raw * (f.zoneShareFloor + (1 - f.zoneShareFloor) * share);
    bestRaw = Math.max(bestRaw, raw);
    bestAdj = Math.max(bestAdj, fit);
    return { zone, ratio, fit };
  });
  // Crowding only redistributes hunters between zones: rescale so the best zone keeps its uncrowded fit and the
  // balance between hunting and town goals is unchanged.
  if (bestAdj > 0) for (const z of out) z.fit *= bestRaw / bestAdj;
  let top = -1;
  out.forEach((z, i) => { if (z.ratio >= f.zoneFitBest) top = i; });
  for (let i = 0; i < top; i++) {
    const z = out[i]!;
    if (z.ratio >= f.zoneFitBest) z.fit = Math.max(0, z.fit - f.zoneTierBonus * (top - i));
  }
  return out;
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

export function moveSpeed(config: GameConfig, h: Hunter): number {
  return config.formula.moveSpeed * personalityFactor(config, h, 'moveSpeed') * mountMul(config, h);
}
