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
 *   AI power  = √(kills per life / zoneRefKills), from the same per-hit expectations as the combat system.
 */
import type { FormulaParams, GameConfig, GearSlot, MainStat, ModStat, NeedKey, SkillDef, StatKey, ZoneDef } from './config/types';
import { GEAR_SLOTS } from './config/types';
import { personalityFactor } from './hunterFactory';
import { memoHunterStats } from './statsCache';
import type { GearInstance, Hunter, Monster, World } from './world';

export type EffectiveStats = Record<StatKey, number> & { atkSpeed: number };

/** Unit conversion only: stats such as crit/eva and the *Pct modifiers are stored in percent. */
const PERCENT = 100;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

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

export interface StatOptions {
  /**
   * Steady-state stats: ignore temporary buffs and mood. Used by the AI power estimate so zone choice does not
   * flip every time a buff expires or mood dips.
   */
  steady?: boolean;
}

/**
 * Effective stats:
 *   hp/atk/def = (base × jobMult × (1 + reinc × reincStatBonus) + gear) × stackPct(trait%, buff%) [× mood for atk/def]
 *   crit/eva   = base + trait points + buff points (converted to chances by critChance / dodgeChance, which cap)
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
  const pct = (stat: ModStat) => stackPct(traitTotal(config, h, stat), buffs ? buffTotal(h, stat) : 0, f);
  const mood = buffs ? moodStatMult(h.needs.mood / f.needMax, f) : 1;
  s.hp *= pct('hpPct');
  s.atk *= pct('atkPct') * mood;
  s.def *= pct('defPct') * mood;
  s.crit += traitTotal(config, h, 'crit') + (buffs ? buffTotal(h, 'crit') : 0);
  s.eva += traitTotal(config, h, 'eva') + (buffs ? buffTotal(h, 'eva') : 0);
  s.atkSpeed = Math.max(f.minAttackInterval, s.atkSpeed / pct('atkSpeedPct'));
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

/** Value of the gear currently in a slot (0 if empty). Used to judge upgrades. */
export function slotValue(config: GameConfig, h: Hunter, slot: GearSlot): number {
  const g = h.equipment[slot];
  return g ? gearMainValue(config, g) : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Per-hit combat formulas (used by systems/combat.ts and by the AI estimate below — one source of truth).
// ---------------------------------------------------------------------------------------------------------------

/**
 * Fraction of damage removed by DEF:  R = min(cap, DEF / (DEF + defPerLevel · L_att + defFlat)).
 * Hyperbolic, so it rises with DEF with diminishing returns and never reaches 100 %. The "half-value" DEF
 * (R = 50 %) scales with the ATTACKER's level, so the same DEF stays meaningful over 100 levels and a hunter
 * who out-levels a zone shrugs off its monsters (and vice versa: a low-level hunter's DEF counts for little
 * against a high-level monster). The cap keeps a floor of (1 − cap) × ATK on every hit.
 */
export function defReduction(def: number, attackerLevel: number, f: FormulaParams): number {
  const d = Math.max(0, def);
  const half = f.defPerLevel * Math.max(1, attackerLevel) + f.defFlat;
  return Math.min(f.defReductionCap, d / (d + half));
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
  const monsterDps = expectedHit(m.atk, s.def, m.level, h.level, m.crit, f.monsterCritMultiplier, s.eva, f) / m.attackSpeed;
  const ttk = m.maxHp / hunterDps;
  return { hunterDps, monsterDps, ttk, dmgPerKill: monsterDps * ttk };
}

/**
 * Spawn-pressure multiplier on damage taken per kill in a zone:  zoneCrowdRespawnSec / respawnSec.
 * A zone refills one monster every respawnSec, so the rate at which extra monsters wander into a fight scales
 * with 1 / respawnSec. EMPIRICAL calibration, not a validated model: in headless runs fast-respawn zones cost
 * more HP per kill than the 1-v-1 duel predicts (adds), slow-respawn zones less (several hunters share targets).
 * With the shipped zones it is effectively two levels (0.5 for meadow/ruins, 1 elsewhere); measured/predicted
 * still ranges ~0.8–1.5 between zones with the same respawnSec (aggro range, AoE and adds are not modelled).
 */
export function zoneCrowd(zone: ZoneDef, f: FormulaParams): number {
  return f.zoneCrowdRespawnSec / zone.respawnSec;
}

/**
 * Expected kills per full HP bar in a zone, against its spawn mix (weights = spawn weights):
 *   killsPerLife = HP / (zoneCrowd × Σ_w dmgPerKill / Σ_w)
 * This is the Lanchester-style "DPS × HP vs DPS × HP" product: doubling either the hunter's damage or its
 * effective HP doubles it. Uses steady stats (no buffs, no mood) so zone choice does not flap.
 */
export function killsPerLife(config: GameConfig, h: Hunter, zone: ZoneDef, difficultyId: string): number {
  return zoneEstimate(config, h, zone, difficultyId).killsPerLife;
}

export interface ZoneEstimate {
  /** Expected kills per full HP bar (see killsPerLife). */
  killsPerLife: number;
  /** Spawn-weighted mean time to kill one monster, seconds. */
  ttk: number;
}

/** killsPerLife and mean TTK of a hunter in a zone, from duel() over the zone's spawn mix. */
export function zoneEstimate(config: GameConfig, h: Hunter, zone: ZoneDef, difficultyId: string): ZoneEstimate {
  const s = hunterStats(config, h, { steady: true });
  let w = 0, dmg = 0, ttk = 0;
  for (const e of zone.monsters) {
    const d = duel(config, h, s, monsterTypeStats(config, e.monsterId, difficultyId));
    w += e.weight;
    dmg += e.weight * d.dmgPerKill;
    ttk += e.weight * d.ttk;
  }
  dmg *= zoneCrowd(zone, config.formula);
  return { killsPerLife: dmg > 0 ? (s.hp * w) / dmg : Infinity, ttk: w > 0 ? ttk / w : Infinity };
}

/**
 * Power ratio of a hunter for a zone:  √(killsPerLife / zoneRefKills).
 * 1 = the hunter can take `zoneRefKills` kills on one HP bar (the design target for a comfortable zone).
 * The square root makes the ratio linear in stats: a hunter with 2× damage AND 2× effective HP scores 2×,
 * which keeps the zoneFit thresholds (0.7 / 1.1 / 2) readable.
 */
export function powerRatio(config: GameConfig, world: World, h: Hunter, zone: ZoneDef): number {
  return ratioFromKills(killsPerLife(config, h, zone, world.town.difficulty), config.formula);
}

function ratioFromKills(kills: number, f: FormulaParams): number {
  return Math.sqrt(kills / f.zoneRefKills);
}

/** powerRatio against a zone's spawn mix at an explicit difficulty (journeys snapshot it at departure). */
export function zonePower(config: GameConfig, h: Hunter, zone: ZoneDef, difficultyId: string): number {
  return ratioFromKills(killsPerLife(config, h, zone, difficultyId), config.formula);
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
 * Fit of every zone (config order = progression order): zoneFit(ratio) × crowding (zoneShare, counting the other
 * hunters whose goal is to hunt there), rescaled so the best zone keeps max zoneFit; then a tie-break towards
 * harder zones: among the zones
 * that are comfortable (ratio ≥ zoneFitBest), the hardest one keeps its fit and each easier comfortable zone
 * loses zoneTierBonus per tier below it. A hunter that out-classes every zone (all at zoneFitFloor) therefore
 * goes to the hardest one instead of a random/easiest one. zoneTierBonus (> decisionNoise) is applied at fit
 * level; the goal score is fit × needsOk × personality, so for e.g. a timid hunter (× 0.7) or low needs ADJACENT
 * tiers can fall within the decision noise, while zones two or more tiers down stay clearly behind.
 * The best zone's score is never raised, so other goals are unaffected.
 */
export function zoneScores(config: GameConfig, world: World, h: Hunter): ZoneScore[] {
  const f = config.formula;
  const others: Record<string, number> = {};
  for (const o of world.hunters) {
    if (o.id !== h.id && o.ai.goal?.type === 'hunt') others[o.ai.goal.zoneId] = (others[o.ai.goal.zoneId] ?? 0) + 1;
  }
  let bestRaw = 0, bestAdj = 0;
  const out = config.zones.map((zone) => {
    const est = zoneEstimate(config, h, zone, world.town.difficulty);
    const ratio = ratioFromKills(est.killsPerLife, f);
    const share = zoneShare(est.ttk, 1 + (others[zone.id] ?? 0), zone);
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
  return config.formula.moveSpeed * personalityFactor(config, h, 'moveSpeed');
}
