/**
 * M5 progression-depth inputs of formulas.hunterStats / moveSpeed / gainExp (TECH_SPEC §4.1, §5.16). Pure: config + hunter
 * only (no World), so hunterStats keeps its signature and statsCache can snapshot every input from the hunter.
 *
 *   job        jobOf(h): h.jobId when it is a job of the hunter's class at h.jobTier, else the first job of that tier
 *              (config order) — hunters built by hand or saved before v16 keep working with only `jobTier`.
 *   job stats  hp/atk/def × statMult × statBias[stat]; + flat crit/eva of the job.
 *   growth     flat hp/atk/def added to the base stats (before the job/reincarnation multipliers).
 *   runes      ModStat points of the socketed runes, in the trait category (permanent; shares traitPctCap).
 *   mount      move speed × moveSpeedMul of the owned mount.
 *   EXP        exp_curve[level − 1].exp[min(reincarnation, last column)].
 */
import type { GameConfig, JobDef, MainStat, ModStat, RelicEffect } from './config/types';
import type { Hunter, World } from './world';

/** The hunter's current job (see module comment), or undefined for a class without jobs. */
export function jobOf(config: GameConfig, h: Hunter): JobDef | undefined {
  if (h.jobId) {
    const j = config.index.jobs.get(h.jobId);
    if (j && j.classId === h.classId && j.tier === h.jobTier) return j;
  }
  return config.index.jobsByClass.get(h.classId)?.find((j) => j.tier === h.jobTier);
}

/** Parent of a job: parentId, or the only job of the class one tier down (validated by the loader). */
export function jobParent(config: GameConfig, j: JobDef): JobDef | undefined {
  if (j.tier === 0) return undefined;
  if (j.parentId) return config.index.jobs.get(j.parentId);
  return config.index.jobsByClass.get(j.classId)?.find((x) => x.tier === j.tier - 1);
}

/** Jobs one tier above `job` that advance from it (several = a branch choice), in config order. */
export function jobChildren(config: GameConfig, job: JobDef): JobDef[] {
  return (config.index.jobsByClass.get(job.classId) ?? []).filter((x) => x.tier === job.tier + 1 && jobParent(config, x)?.id === job.id);
}

/** The branch a job belongs to: its own `branch`, else its nearest ancestor's (undefined above no branch point). */
export function jobBranchOf(config: GameConfig, j: JobDef | undefined): string | undefined {
  for (let cur = j; cur; cur = jobParent(config, cur)) if (cur.branch) return cur.branch;
  return undefined;
}

/** hp/atk/def multiplier of a job: statMult × statBias[stat] (no job = 1). */
export function jobStatMult(job: JobDef | undefined, stat: MainStat): number {
  return (job?.statMult ?? 1) * (job?.statBias?.[stat] ?? 1);
}

/** Flat growth-property bonus on a base stat: Σ level × valuePerLevel. */
export function growthFlat(config: GameConfig, h: Hunter, stat: MainStat): number {
  const g = h.growth;
  if (!g) return 0;
  let v = 0;
  for (const id in g) {
    const def = config.index.growthProperties.get(id);
    if (def && def.stat === stat) v += def.valuePerLevel * Math.min(g[id]!, def.maxLevel);
  }
  return v;
}

/** ModStat points from the socketed runes (only the first runeSlots sockets count). */
export function runeTotal(config: GameConfig, h: Hunter, stat: ModStat): number {
  const r = h.runes;
  if (!r) return 0;
  let v = 0;
  const n = Math.min(r.length, Math.max(0, config.formula.runeSlots));
  for (let i = 0; i < n; i++) {
    const it = r[i];
    if (!it) continue;
    const def = config.index.runes.get(it.runeId);
    if (def && def.stat === stat) v += def.valueByGrade[it.grade - 1] ?? 0;
  }
  return v;
}

/** Move speed multiplier of the hunter's mount (1 without one). */
export function mountMul(config: GameConfig, h: Hunter): number {
  return h.mount ? (config.index.mounts.get(h.mount)?.moveSpeedMul ?? 1) : 1;
}

/**
 * EXP to go from `level` to level + 1 after `reincarnation` reincarnations: exp_curve (TECH_SPEC §8), last column for
 * higher counts; outside the table (no row) the M3 formula round(expBase × level^expExponent).
 */
export function expRequired(config: GameConfig, level: number, reincarnation: number): number {
  const row = config.expCurve?.[level - 1];
  if (!row || row.exp.length === 0) return Math.round(config.formula.expBase * Math.pow(level, config.formula.expExponent));
  return row.exp[Math.max(0, Math.min(reincarnation, row.exp.length - 1))]!;
}

/** Sum of the value of every relic with this effect at its current Town level (TECH_SPEC §5.16; 0 when none bought). */
export function relicValue(config: GameConfig, world: World, effect: RelicEffect): number {
  const lv = world.town.relics;
  if (!lv) return 0;
  let v = 0;
  for (const r of config.relics) {
    const n = Math.min(lv[r.id] ?? 0, r.maxLevel);
    if (r.effect === effect && n > 0) v += r.value[n - 1] ?? 0;
  }
  return v;
}
