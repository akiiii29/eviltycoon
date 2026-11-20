import type { GameConfig } from '../src/core/config/types';
import { EventBuffer, type SimEvent } from '../src/core/events';
import { hunterStats, mitigated, monsterStats } from '../src/core/formulas';
import { rollHunter } from '../src/core/hunterFactory';
import { NavGraph } from '../src/core/pathfinding';
import { Rng } from '../src/core/rng';
import { createWorld, Simulation } from '../src/core/simulation';
import type { SystemContext } from '../src/core/system';
import { combatSystem, damageMonster } from '../src/core/systems/combat';
import { skillsSystem } from '../src/core/systems/skills';
import { spawnSystem } from '../src/core/systems/spawn';
import type { Hunter, Monster } from '../src/core/world';
import { testConfig } from './helpers';

const config = testConfig();
const ZONE = 'zone.meadow';

function makeCtx(cfg: GameConfig = config): SystemContext {
  return {
    world: createWorld(cfg, 1), config: cfg, nav: new NavGraph(cfg), rng: new Rng(1),
    events: new EventBuffer(), debug: { aiScores: new Map() }, dtMs: 100,
  };
}

/** A hunter of `classId` standing in the meadow, hunting `targetId`, with auto-attacks disabled and no crit. */
function addHunter(ctx: SystemContext, classId: string, targetId: string | null): Hunter {
  const nodeId = ctx.config.index.zoneNodes.get(ZONE)![0]!;
  const node = ctx.nav.node(nodeId);
  const h = rollHunter(ctx.config, ctx.rng, `h${ctx.world.nextId++}`, nodeId, { x: node.x, y: node.y }, 0);
  h.classId = classId;
  h.jobTier = 0;
  h.skills = {};
  h.skillCdMs = {};
  h.traits = {};
  h.buffs = [];
  h.equipment = {};
  h.stats.crit = 0;
  h.insideBuildingId = null;
  h.attackCdMs = 1e9;
  h.ai = { goal: { type: 'hunt', zoneId: ZONE }, phase: 'act', path: [], decideInMs: 1e9, targetMonsterId: targetId, moveTo: null, forced: false };
  ctx.world.hunters.push(h);
  return h;
}

function addMonster(ctx: SystemContext, dx: number, dy = 0, difficultyId = 'diff.easy', hp = 1e6): Monster {
  const h = ctx.world.hunters[0];
  const nodeId = ctx.config.index.zoneNodes.get(ZONE)![0]!;
  const base = h ? h.position : ctx.nav.node(nodeId);
  const pos = { x: base.x + dx, y: base.y + dy };
  const m: Monster = {
    id: `m${ctx.world.nextId++}`, defId: 'mon.slime', zoneId: ZONE, hp, position: { ...pos }, home: { ...pos },
    targetHunterId: null, attackCdMs: 1e9, difficultyId,
  };
  ctx.world.monsters.push(m);
  return m;
}

function step(ctx: SystemContext): SimEvent[] {
  combatSystem.update(ctx);
  skillsSystem.update(ctx);
  ctx.world.tick += 1;
  return ctx.events.drain();
}

describe('M3 difficulty-scaled monsters', () => {
  it('monsters spawned under diff.normal are stronger and pay more than diff.easy', () => {
    const easy = makeCtx();
    spawnSystem.update(easy);
    const normal = makeCtx();
    normal.world.town.difficulty = 'diff.normal';
    spawnSystem.update(normal);
    expect(normal.world.monsters.length).toBeGreaterThan(0);
    for (const m of normal.world.monsters) expect(m.difficultyId).toBe('diff.normal');

    const me = easy.world.monsters[0]!, mn = { ...me, difficultyId: 'diff.normal' };
    const se = monsterStats(config, me), sn = monsterStats(config, mn);
    expect(sn.maxHp).toBeGreaterThan(se.maxHp);
    expect(sn.atk).toBeGreaterThan(se.atk);
    expect(sn.def).toBeGreaterThan(se.def);
    expect(sn.exp).toBeGreaterThan(se.exp);
    expect(sn.gold).toBeGreaterThan(se.gold);
    const sameDef = normal.world.monsters.find((m) => m.defId === me.defId);
    if (sameDef) expect(sameDef.hp).toBeCloseTo(sn.maxHp);
  });

  it('kill rewards (gold) and hunter mitigation use difficulty-scaled stats', () => {
    const gold: Record<string, number> = {};
    const dmg: Record<string, number> = {};
    for (const diff of ['diff.easy', 'diff.normal']) {
      const ctx = makeCtx();
      const h = addHunter(ctx, 'class.vanguard', null);
      const tough = addMonster(ctx, 1, 0, diff);
      dmg[diff] = damageMonster(ctx, h, tough, 100, false);
      const ts = monsterStats(config, tough);
      expect(dmg[diff]).toBeCloseTo(mitigated(100, ts.def, h.level, ts.level, config.formula));
      const weak = addMonster(ctx, 1, 0, diff, 1);
      const g0 = h.gold;
      damageMonster(ctx, h, weak, 100, false);
      gold[diff] = h.gold - g0;
      expect(h.kills).toBe(1);
      expect(ctx.events.drain().some((e) => e.type === 'monsterKilled')).toBe(true);
    }
    expect(gold['diff.normal']).toBeGreaterThan(gold['diff.easy']!);
    expect(dmg['diff.normal']).toBeLessThan(dmg['diff.easy']!);
  });

  it('kill EXP goes through gainExp (level cap respected)', () => {
    const slime = config.index.monsters.get('mon.slime')!;
    const cfg: GameConfig = {
      ...config,
      formula: { ...config.formula, maxLevel: 3 },
      index: { ...config.index, monsters: new Map([...config.index.monsters, ['mon.slime', { ...slime, exp: 1e6 }]]) },
    };
    const ctx = makeCtx(cfg);
    const h = addHunter(ctx, 'class.vanguard', null);
    h.level = 1;
    h.exp = 0;
    for (let i = 0; i < 3; i++) damageMonster(ctx, h, addMonster(ctx, 1, 0, 'diff.easy', 1), 100, false);
    expect(h.level).toBe(3);
    expect(h.exp).toBe(0);
    const ups = ctx.events.drain().filter((e) => e.type === 'levelUp');
    expect(ups.length).toBe(2);
  });
});

describe('M3 combat skills', () => {
  it('strike deals ATK × multiplier (mitigated) and sets the cooldown', () => {
    const ctx = makeCtx();
    const m = addMonster(ctx, 1);
    const h = addHunter(ctx, 'class.warden', m.id);
    m.position = { x: h.position.x + 1, y: h.position.y };
    h.skills['skill.warden.bash'] = 2;
    const sk = config.index.skills.get('skill.warden.bash')!;
    const events = step(ctx);
    const cast = events.filter((e) => e.type === 'skillCast');
    expect(cast).toEqual([expect.objectContaining({ hunterId: h.id, skillId: sk.id, targets: 1 })]);
    const ms = monsterStats(config, m);
    const expected = mitigated(hunterStats(config, h).atk * sk.value[1]!, ms.def, h.level, ms.level, config.formula);
    expect(1e6 - m.hp).toBeCloseTo(expected);
    expect(h.skillCdMs[sk.id]).toBe(sk.cooldownSec * 1000);
    expect(ctx.world.stats.skillCasts).toBe(1);
    // On cooldown: no second cast next tick; cooldown ticks down.
    expect(step(ctx).some((e) => e.type === 'skillCast')).toBe(false);
    expect(h.skillCdMs[sk.id]).toBe(sk.cooldownSec * 1000 - 100);
  });

  it('aoe hits only live monsters of the zone within radius of the target', () => {
    const ctx = makeCtx();
    const target = addMonster(ctx, 1);
    const h = addHunter(ctx, 'class.arcanist', target.id);
    target.position = { x: h.position.x + 1, y: h.position.y };
    const sk = config.index.skills.get('skill.arcanist.fireball')!;
    const r = sk.radius!;
    const near = addMonster(ctx, 1 + r - 0.5);
    const far = addMonster(ctx, 1 + r + 2);
    const otherZone = addMonster(ctx, 1.5);
    otherZone.zoneId = 'zone.other';
    h.skills[sk.id] = 1;
    const events = step(ctx);
    const cast = events.find((e) => e.type === 'skillCast');
    expect(cast).toMatchObject({ skillId: sk.id, targets: 2 });
    expect(target.hp).toBeLessThan(1e6);
    expect(near.hp).toBeLessThan(1e6);
    expect(far.hp).toBe(1e6);
    expect(otherZone.hp).toBe(1e6);
  });

  it('buff applies via hunterStats, refreshes without stacking, and expires', () => {
    const ctx = makeCtx();
    const m = addMonster(ctx, 1);
    const h = addHunter(ctx, 'class.reaver', m.id);
    m.position = { x: h.position.x + 1, y: h.position.y };
    h.jobTier = 1;
    const sk = config.index.skills.get('skill.reaver.bloodlust')!;
    h.skills[sk.id] = 1;
    const atk0 = hunterStats(config, h).atk;
    const events = step(ctx);
    expect(events.find((e) => e.type === 'skillCast')).toMatchObject({ skillId: sk.id, targets: 0 });
    expect(h.buffs).toEqual([{ sourceId: sk.id, stat: 'atkPct', value: sk.value[0], remainingMs: sk.keepSec![0]! * 1000 }]);
    expect(hunterStats(config, h).atk).toBeCloseTo(atk0 * (1 + sk.value[0]! / 100));
    expect(m.hp).toBe(1e6);

    // Refresh replaces instead of stacking.
    h.skillCdMs[sk.id] = 0;
    step(ctx);
    expect(h.buffs.length).toBe(1);
    expect(h.buffs[0]!.remainingMs).toBe(sk.keepSec![0]! * 1000);

    // Stop hunting so it is not recast; it expires after keepSec.
    h.ai.goal = { type: 'hunt', zoneId: ZONE };
    h.ai.phase = 'travel';
    for (let i = 0; i < sk.keepSec![0]! * 10; i++) step(ctx);
    expect(h.buffs).toEqual([]);
    expect(hunterStats(config, h).atk).toBeCloseTo(atk0);
  });

  it('does not cast skills locked by jobTierMin or not learned', () => {
    const ctx = makeCtx();
    const m = addMonster(ctx, 1);
    const h = addHunter(ctx, 'class.reaver', m.id);
    m.position = { x: h.position.x + 1, y: h.position.y };
    h.skills['skill.reaver.bloodlust'] = 3; // jobTierMin 1, hunter is tier 0
    h.skills['skill.warden.bash'] = 1; // other class
    expect(step(ctx).some((e) => e.type === 'skillCast')).toBe(false);
    expect(h.buffs).toEqual([]);
    // Learning the tier-0 skill makes it castable.
    h.skills['skill.reaver.rend'] = 1;
    expect(step(ctx).find((e) => e.type === 'skillCast')).toMatchObject({ skillId: 'skill.reaver.rend' });
  });

  it('does not cast out of range or when not hunting; dead hunters lose buffs', () => {
    const ctx = makeCtx();
    const m = addMonster(ctx, 1);
    const h = addHunter(ctx, 'class.warden', m.id);
    m.position = { x: h.position.x + config.formula.attackRange + 1, y: h.position.y };
    h.skills['skill.warden.bash'] = 1;
    expect(step(ctx).some((e) => e.type === 'skillCast')).toBe(false);
    h.buffs.push({ sourceId: 'x', stat: 'atkPct', value: 10, remainingMs: 1e6 });
    h.deadMs = 1e6;
    skillsSystem.update(ctx);
    expect(h.buffs).toEqual([]);
  });

  it('is deterministic inside a Simulation with an explicit systems list', () => {
    const run = () => {
      const s = new Simulation(config, createWorld(config, 5), [combatSystem, skillsSystem]);
      const ctx = makeCtx();
      ctx.world = s.world;
      const m = addMonster(ctx, 1, 0, 'diff.easy', 500);
      const h = addHunter(ctx, 'class.vanguard', m.id);
      m.position = { x: h.position.x + 1, y: h.position.y };
      h.stats.crit = 30;
      h.attackCdMs = 0;
      h.skills['skill.vanguard.cleave'] = 1;
      for (let i = 0; i < 200; i++) s.step();
      return JSON.stringify(s.world);
    };
    const a = run();
    expect(a).toBe(run());
    expect(JSON.parse(a).stats.skillCasts).toBeGreaterThan(0);
  });
});
