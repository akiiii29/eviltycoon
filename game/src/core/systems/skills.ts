import type { SkillDef } from '../config/types';
import { hunterStats } from '../formulas';
import { SpatialHash } from '../spatial';
import type { System, SystemContext } from '../system';
import { dist, findMonster, isAlive, type Hunter, type Monster } from '../world';
import { damageMonster } from './combat';

/**
 * AoE index over world.monsters (keyed by array index), built lazily on the first AoE cast of a skills pass
 * and dropped at the start of the next pass. Monsters do not move or get removed during the pass (dead ones
 * are filtered at the end), so it stays exact; the hp/zone/distance predicates are still checked per victim.
 */
const aoeGrid = new SpatialHash();
let aoeGridBuilt = false;
const aoeScratch: number[] = [];

function monsterGrid(ctx: SystemContext): SpatialHash {
  if (!aoeGridBuilt) {
    aoeGrid.clear();
    const ms = ctx.world.monsters;
    for (let i = 0; i < ms.length; i++) aoeGrid.insert(i, ms[i]!.position.x, ms[i]!.position.y);
    aoeGridBuilt = true;
  }
  return aoeGrid;
}

/** Tick buff durations and skill cooldowns by one step. */
function tickTimers(h: Hunter, dtMs: number): void {
  if (h.buffs.length > 0) {
    for (const b of h.buffs) b.remainingMs -= dtMs;
    h.buffs = h.buffs.filter((b) => b.remainingMs > 0);
  }
  for (const id in h.skillCdMs) h.skillCdMs[id] = Math.max(0, h.skillCdMs[id]! - dtMs);
}

/** First ready, learned, unlocked skill of the hunter's class (config order). */
function readySkill(ctx: SystemContext, h: Hunter): SkillDef | undefined {
  for (const sk of ctx.config.skills) {
    if (sk.classId !== h.classId) continue;
    if ((h.skills[sk.id] ?? 0) < 1) continue;
    if (sk.jobTierMin > h.jobTier) continue;
    if ((h.skillCdMs[sk.id] ?? 0) > 0) continue;
    return sk;
  }
  return undefined;
}

/** Cast one skill. Returns the number of monsters hit (0 for buffs). */
function cast(ctx: SystemContext, h: Hunter, sk: SkillDef, target: Monster): number {
  const lvl = Math.min(h.skills[sk.id]!, sk.value.length);
  const value = sk.value[lvl - 1]!;
  switch (sk.kind) {
    case 'strike': {
      damageMonster(ctx, h, target, hunterStats(ctx.config, h).atk * value, true);
      return 1;
    }
    case 'aoe': {
      const rawAtk = hunterStats(ctx.config, h).atk * value;
      const radius = sk.radius ?? 0;
      const center = { ...target.position };
      // Same predicate as a filter over world.monsters; candidates are ascending indices, so the victim
      // order (and with it the per-victim crit rolls) matches the linear scan.
      const victims: Monster[] = [];
      for (const i of monsterGrid(ctx).candidates(center.x, center.y, radius, aoeScratch)) {
        const m = ctx.world.monsters[i]!;
        if (m.hp > 0 && m.zoneId === target.zoneId && dist(m.position, center) <= radius) victims.push(m);
      }
      for (const m of victims) damageMonster(ctx, h, m, rawAtk, true);
      return victims.length;
    }
    case 'buff': {
      if (!sk.buffStat) return 0;
      const keep = sk.keepSec?.[lvl - 1] ?? 0;
      const buff = { sourceId: sk.id, stat: sk.buffStat, value, remainingMs: keep * 1000 };
      const i = h.buffs.findIndex((b) => b.sourceId === sk.id);
      if (i >= 0) h.buffs[i] = buff;
      else h.buffs.push(buff);
      return 0;
    }
  }
}

function tryCast(ctx: SystemContext, h: Hunter): void {
  const ai = h.ai;
  if (ai.goal?.type !== 'hunt' || ai.phase !== 'act' || !ai.targetMonsterId) return;
  const target = findMonster(ctx.world, ai.targetMonsterId);
  if (!target || target.hp <= 0 || dist(h.position, target.position) > ctx.config.formula.attackRange) return;
  const sk = readySkill(ctx, h);
  if (!sk) return;
  const targets = cast(ctx, h, sk, target);
  h.skillCdMs[sk.id] = sk.cooldownSec * 1000;
  ctx.world.stats.skillCasts += 1;
  ctx.events.emit(ctx.world.tick, { type: 'skillCast', hunterId: h.id, skillId: sk.id, targets });
}

/**
 * M3 active skills (run right after combat): ticks buffs/cooldowns, then auto-casts at most one ready
 * skill per hunting hunter per tick. Damage goes through combat.damageMonster (mitigation, crit, kills).
 */
export const skillsSystem: System = {
  name: 'skills',
  update(ctx) {
    const { world, dtMs } = ctx;
    aoeGridBuilt = false;
    for (const h of world.hunters) {
      if (!isAlive(h)) {
        if (h.buffs.length > 0) h.buffs = [];
        continue;
      }
      if (h.insideBuildingId) continue;
      tickTimers(h, dtMs);
      tryCast(ctx, h);
    }
    if (world.monsters.some((m) => m.hp <= 0)) world.monsters = world.monsters.filter((m) => m.hp > 0);
    aoeGridBuilt = false;
  },
};
