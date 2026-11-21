/**
 * M5 gear depth (TECH_SPEC §4.2): grades and option lines rolled at craft, gear sets, gear skills.
 * Pure helpers over config + gear instances; stat application is in formulas.hunterStats (gear category), the economy
 * hooks read gearBonus (combat: lifesteal / gold / EXP / drops; needs: drain), the AI values gear with formulas.gearScore.
 */
import {
  GEAR_SLOTS, GEAR_STATS, type GameConfig, type GearGradeDef, type GearOptionDef, type GearOptionKind, type GearSkillDef,
  type GearSlot, type GearStat,
} from './config/types';
import type { Rng } from './rng';
import type { GearInstance, GearOption, Hunter } from './world';

export type GearMods = Record<GearStat, number>;

export function emptyMods(): GearMods {
  const m = {} as GearMods;
  for (const s of GEAR_STATS) m[s] = 0;
  return m;
}

/** Grade of an item (absent/unknown = the first, no-option grade). */
export function gradeOf(config: GameConfig, g: Pick<GearInstance, 'gradeId'>): GearGradeDef {
  return (g.gradeId ? config.index.gearGrades.get(g.gradeId) : undefined) ?? config.gearGrades[0]!;
}

/** Add an item's option lines to `mods` (stat lines) and `skills` (gear-skill lines). Unknown ids are ignored. */
export function addItemMods(config: GameConfig, g: GearInstance, mods: GearMods, skills?: GearSkillDef[]): void {
  if (!g.options) return;
  for (const line of g.options) {
    const o = config.index.gearOptions.get(line.id);
    if (!o) continue;
    if (o.stat) mods[o.stat] += line.value;
    else if (o.gearSkillId && skills) {
      const sk = config.index.gearSkills.get(o.gearSkillId);
      if (sk && !skills.includes(sk)) skills.push(sk);
    }
  }
}

/** Equipped pieces per set: setId → number of slots holding a piece of it. `override` replaces one slot (null = empty). */
export function setCounts(
  config: GameConfig, equipment: Hunter['equipment'], override?: { slot: GearSlot; item: GearInstance | null },
): Map<string, number> {
  const out = new Map<string, number>();
  for (const slot of GEAR_SLOTS) {
    const g = override && override.slot === slot ? override.item : equipment[slot];
    if (!g) continue;
    const setId = config.index.gear.get(g.gearId)?.setId;
    if (setId) out.set(setId, (out.get(setId) ?? 0) + 1);
  }
  return out;
}

/** Add the (cumulative) bonuses of every set reached by `counts`. */
export function addSetMods(config: GameConfig, counts: Map<string, number>, mods: GearMods, skills?: GearSkillDef[]): void {
  for (const [setId, n] of counts) {
    const set = config.index.gearSets.get(setId);
    if (!set) continue;
    for (const b of set.bonuses) {
      if (n < b.pieces) continue;
      if (b.stat && b.value !== undefined) mods[b.stat] += b.value;
      else if (b.gearSkillId && skills) {
        const sk = config.index.gearSkills.get(b.gearSkillId);
        if (sk && !skills.includes(sk)) skills.push(sk);
      }
    }
  }
}

export interface HunterGearMods {
  /** Σ option lines + set bonuses per stat (raw, uncapped). */
  mods: GearMods;
  /** Gear skills granted by option lines and set bonuses (each once, slot order then set order). */
  skills: GearSkillDef[];
}

/**
 * Everything a hunter's equipment adds beyond main stats: option lines + reached set bonuses. Memoised per hunter on a
 * by-value snapshot of its equipment (per slot: gearId and every option id/value, so in-place edits are caught); the
 * result is frozen and shared. Derived data only (never saved).
 */
export function hunterGearMods(config: GameConfig, h: Hunter): Readonly<HunterGearMods> {
  const e = modsCache.get(h);
  if (e && e.config === config && sameEquipment(e.key, h)) return e.out;
  const mods = emptyMods();
  const skills: GearSkillDef[] = [];
  for (const slot of GEAR_SLOTS) {
    const g = h.equipment[slot];
    if (g) addItemMods(config, g, mods, skills);
  }
  if (config.gearSets.length > 0) addSetMods(config, setCounts(config, h.equipment), mods, skills);
  const out = Object.freeze({ mods: Object.freeze(mods), skills: Object.freeze(skills) as GearSkillDef[] });
  modsCache.set(h, { config, key: equipmentKey(h), out });
  return out;
}

const modsCache = new WeakMap<Hunter, { config: GameConfig; key: (string | number | null)[]; out: Readonly<HunterGearMods> }>();

function equipmentKey(h: Hunter): (string | number | null)[] {
  const k: (string | number | null)[] = [];
  for (const slot of GEAR_SLOTS) {
    const g = h.equipment[slot];
    if (!g) { k.push(null); continue; }
    k.push(g.gearId, g.options ? g.options.length : 0);
    if (g.options) for (const o of g.options) k.push(o.id, o.value);
  }
  return k;
}

function sameEquipment(k: (string | number | null)[], h: Hunter): boolean {
  let j = 0;
  for (const slot of GEAR_SLOTS) {
    const g = h.equipment[slot];
    if (!g) { if (k[j++] !== null) return false; continue; }
    const n = g.options ? g.options.length : 0;
    if (k[j++] !== g.gearId || k[j++] !== n) return false;
    for (let i = 0; i < n; i++) if (k[j++] !== g.options![i]!.id || !Object.is(k[j++], g.options![i]!.value)) return false;
  }
  return j === k.length;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * One gear stat of a hunter for the economy hooks, clamped: % stats to [gearPctFloor, gearPctCap], needSavePct to
 * ±gearNeedSaveCap, lifesteal to [0, gearPctCap]. 0 when nothing equipped adds it.
 */
export function gearBonus(config: GameConfig, h: Hunter, stat: GearStat): number {
  let any = false;
  for (const slot of GEAR_SLOTS) if (h.equipment[slot]) { any = true; break; }
  if (!any) return 0;
  return clampGearStat(config, stat, hunterGearMods(config, h).mods[stat]);
}

export function clampGearStat(config: GameConfig, stat: GearStat, v: number): number {
  const f = config.formula;
  if (stat === 'needSavePct') return clamp(v, -f.gearNeedSaveCap, f.gearNeedSaveCap);
  if (stat === 'lifesteal') return clamp(v, 0, f.gearPctCap);
  if (stat === 'crit' || stat === 'eva') return v; // flat points; the chance formulas cap them
  return clamp(v, f.gearPctFloor, f.gearPctCap);
}

/** Gear skills of the hunter's equipment (option lines + set bonuses); [] without equipment. */
export function hunterGearSkills(config: GameConfig, h: Hunter): GearSkillDef[] {
  for (const slot of GEAR_SLOTS) if (h.equipment[slot]) return hunterGearMods(config, h).skills;
  return [];
}

/** Multiplier on need drain (satiety/stamina/mood decay, satiety per attack): 1 − needSavePct / 100 (exactly 1 without it). */
export function needDrainMul(config: GameConfig, h: Hunter): number {
  const v = gearBonus(config, h, 'needSavePct');
  return v === 0 ? 1 : 1 - v / 100;
}

/** Multiplier of a hunter's gear % stat (goldPct / expPct / dropPct …): 1 + clamped / 100, exactly 1 without it. */
export function gearPctMul(config: GameConfig, h: Hunter, stat: GearStat): number {
  const v = gearBonus(config, h, stat);
  return v === 0 ? 1 : Math.max(0, 1 + v / 100);
}

/** Multiplier from a gear % bonus: 1 + v/100 (v already clamped). */
export function pctMul(v: number): number {
  return 1 + v / 100;
}

function pool(config: GameConfig, kind: GearOptionKind, slot: GearSlot, taken: Set<string>): GearOptionDef[] {
  return config.gearOptions.filter((o) => o.kind === kind && o.weight > 0 && !taken.has(o.id) && (!o.slots || o.slots.includes(slot)));
}

/**
 * Roll a fresh craft's grade and option lines (deterministic, sim RNG). RNG order, after the quality draw: one grade draw;
 * then per line: (non-unique lines with negChance > 0) one kind draw, one option draw, one value draw (stat lines only).
 * The first `uniques` lines come from the unique pool, the rest positive or negative. No line repeats an option id; a line
 * whose pool is empty is skipped. Values = uniform [min, max) × grade valueMul (negative lines unscaled), rounded to 0.1.
 * Returns {} for the first (no-option) grade so plain items stay plain.
 */
export function rollGearOptions(config: GameConfig, rng: Rng, slot: GearSlot): { gradeId?: string; options?: GearOption[] } {
  const grades = config.gearGrades;
  if (grades.length === 0) return {};
  const grade = rng.weighted(grades, (g) => g.chance);
  if (grade === grades[0] && grade.options === 0) return {};
  const taken = new Set<string>();
  const lines: GearOption[] = [];
  for (let i = 0; i < grade.options; i++) {
    let kind: GearOptionKind = 'positive';
    if (i < grade.uniques) kind = 'unique';
    else if (grade.negChance > 0 && rng.chance(grade.negChance)) kind = 'negative';
    const p = pool(config, kind, slot, taken);
    if (p.length === 0) continue;
    const o = rng.weighted(p, (x) => x.weight);
    taken.add(o.id);
    let value = 0;
    if (o.stat) {
      const mul = kind === 'negative' ? 1 : grade.valueMul;
      value = Math.round(rng.range(o.min, o.max) * mul * 10) / 10;
    }
    lines.push({ id: o.id, value });
  }
  const out: { gradeId?: string; options?: GearOption[] } = { gradeId: grade.id };
  if (lines.length > 0) out.options = lines;
  return out;
}

/** Copy the gear-depth fields (grade, option lines) of `from` onto `to`, leaving them absent when `from` has none. */
export function copyGearDepth<T extends GearInstance>(to: T, from: GearInstance): T {
  if (from.gradeId !== undefined) to.gradeId = from.gradeId;
  if (from.options !== undefined) to.options = from.options.map((o) => ({ id: o.id, value: o.value }));
  return to;
}
