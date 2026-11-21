import type { GameConfig } from '../src/core/config/types';
import { EventBuffer, type SimEvent } from '../src/core/events';
import { hunterStats, mitigated, monsterStats } from '../src/core/formulas';
import { rollHunter } from '../src/core/hunterFactory';
import { NavGraph } from '../src/core/pathfinding';
import { Rng } from '../src/core/rng';
import { createWorld, Simulation } from '../src/core/simulation';
import type { SystemContext } from '../src/core/system';
import { combatSystem } from '../src/core/systems/combat';
import type { World } from '../src/core/world';
import { testConfig } from './helpers';

/**
 * These tests check the combat system's RNG wiring (evade roll, then crit roll), so the crit chance cap is lifted
 * (crit 100 must mean "always crits"), and `alwaysEvade` turns any EVA into a certain dodge. The caps and curves
 * themselves are tested in formulas.test.ts.
 */
const shipped = testConfig();
const base: GameConfig = { ...shipped, formula: { ...shipped.formula, critChanceCap: 1 } };
const alwaysEvade = (cfg: GameConfig): GameConfig => ({ ...cfg, formula: { ...cfg.formula, dodgeCap: 1, dodgeHalf: 0 } });
const ZONE = 'zone.meadow';
const MON = 'mon.slime';

/** Clone of the config with the slime's crit chance overridden. */
function withCrit(crit: number): GameConfig {
  const slime = base.index.monsters.get(MON)!;
  return {
    ...base,
    index: { ...base.index, monsters: new Map([...base.index.monsters, [MON, { ...slime, crit }]]) },
  };
}

/** Put one tanky hunter (no attacks of its own, given evasion) and one adjacent slime into `world`. */
function setup(cfg: GameConfig, world: World, eva: number, seed = 1): void {
  const nav = new NavGraph(cfg);
  const nodeId = cfg.index.zoneNodes.get(ZONE)![0]!;
  const node = nav.node(nodeId);
  const h = rollHunter(cfg, new Rng(seed), `h${world.nextId++}`, nodeId, { x: node.x, y: node.y }, 0);
  h.traits = {};
  h.buffs = [];
  h.equipment = {};
  h.skills = {};
  h.stats.eva = eva;
  h.stats.hp = 1e9;
  h.needs.hp = 1e9;
  h.insideBuildingId = null;
  h.attackCdMs = 1e9;
  h.ai = { goal: { type: 'hunt', zoneId: ZONE }, phase: 'act', path: [], decideInMs: 1e9, targetMonsterId: null, moveTo: null, forced: false };
  world.hunters.push(h);
  const pos = { x: h.position.x + 1, y: h.position.y };
  world.monsters.push({
    id: `m${world.nextId++}`, defId: MON, zoneId: ZONE, hp: 1e9, position: { ...pos }, home: { ...pos },
    targetHunterId: h.id, attackCdMs: 0, difficultyId: 'diff.easy',
  });
}

/** Run combat alone for `ticks` steps and return the monster->hunter hit events. */
function run(cfg: GameConfig, eva: number, ticks = 300, seed = 7): SimEvent[] {
  const world = createWorld(cfg, seed);
  world.hunters = [];
  world.monsters = [];
  setup(cfg, world, eva);
  const ctx: SystemContext = {
    world, config: cfg, nav: new NavGraph(cfg), rng: new Rng(world.rng),
    events: new EventBuffer(), debug: { aiScores: new Map() }, dtMs: 100,
  };
  const out: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    combatSystem.update(ctx);
    world.tick += 1;
    out.push(...ctx.events.drain());
  }
  const mId = world.monsters[0]!.id;
  return out.filter((e) => e.type === 'hit' && e.attackerId === mId);
}

function normalDamage(cfg: GameConfig): number {
  const world = createWorld(cfg, 1);
  world.hunters = [];
  world.monsters = [];
  setup(cfg, world, 0);
  const ms = monsterStats(cfg, world.monsters[0]!);
  const h = world.hunters[0]!;
  return mitigated(ms.atk, hunterStats(cfg, h).def, ms.level, h.level, cfg.formula);
}

type Hit = Extract<SimEvent, { type: 'hit' }>;

describe('balance: monster critical hits', () => {
  it('config exposes monster crit and the multiplier', () => {
    expect(base.formula.monsterCritMultiplier).toBeGreaterThan(1);
    expect(typeof base.index.monsters.get(MON)!.crit).toBe('number');
  });

  it('crit 100 always crits for mitigated damage × monsterCritMultiplier', () => {
    const cfg = withCrit(100);
    const hits = run(cfg, 0) as Hit[];
    expect(hits.length).toBeGreaterThan(2);
    const expected = normalDamage(cfg) * cfg.formula.monsterCritMultiplier;
    for (const e of hits) {
      expect(e.evaded).toBe(false);
      expect(e.crit).toBe(true);
      expect(e.damage).toBeCloseTo(expected);
    }
  });

  it('crit 0 never crits and deals plain mitigated damage', () => {
    const cfg = withCrit(0);
    const hits = run(cfg, 0) as Hit[];
    expect(hits.length).toBeGreaterThan(2);
    const expected = normalDamage(cfg);
    for (const e of hits) {
      expect(e.crit).toBe(false);
      expect(e.damage).toBeCloseTo(expected);
    }
  });

  it('evaded hits never crit and deal no damage, even at crit 100', () => {
    const hits = run(alwaysEvade(withCrit(100)), 100) as Hit[];
    expect(hits.length).toBeGreaterThan(2);
    for (const e of hits) {
      expect(e.evaded).toBe(true);
      expect(e.crit).toBe(false);
      expect(e.damage).toBe(0);
    }
  });

  it('mixed evade/crit outcomes are deterministic for a fixed seed', () => {
    const cfg = withCrit(50);
    const a = run(cfg, 30, 600);
    const b = run(cfg, 30, 600);
    expect(a).toEqual(b);
    const hits = a as Hit[];
    expect(hits.some((e) => e.crit)).toBe(true);
    expect(hits.some((e) => !e.crit && !e.evaded)).toBe(true);
    expect(hits.some((e) => e.evaded)).toBe(true);
    for (const e of hits) if (e.evaded) expect(e.crit).toBe(false);
  });

  it('is deterministic inside a Simulation with an explicit systems list', () => {
    const cfg = withCrit(50);
    const once = () => {
      const world = createWorld(cfg, 11);
      world.hunters = [];
      world.monsters = [];
      setup(cfg, world, 20);
      const s = new Simulation(cfg, world, [combatSystem]);
      for (let i = 0; i < 400; i++) s.step();
      return JSON.stringify(s.world);
    };
    const a = once();
    expect(a).toBe(once());
    expect(JSON.parse(a).hunters[0].needs.hp).toBeLessThan(1e9);
  });
});

describe('mood per monster attack (GDD §4.2, EHT: every attack lowers mood)', () => {
  it('each monster attack costs moodPerHitTaken × personality mood, dodged attacks included', () => {
    for (const cfg of [base, alwaysEvade(base)]) {
      const world = createWorld(cfg, 1);
      world.hunters = [];
      world.monsters = [];
      setup(cfg, world, 100);
      const h = world.hunters[0]!;
      h.personalities = [];
      const ctx: SystemContext = {
        world, config: cfg, nav: new NavGraph(cfg), rng: new Rng(world.rng),
        events: new EventBuffer(), debug: { aiScores: new Map() }, dtMs: 100,
      };
      let attacks = 0, dodged = 0;
      for (let i = 0; i < 300; i++) {
        combatSystem.update(ctx);
        world.tick += 1;
        for (const e of ctx.events.drain()) {
          if (e.type === 'hit' && e.targetId === h.id) { attacks++; if (e.evaded) dodged++; }
        }
      }
      expect(attacks).toBeGreaterThan(2);
      if (cfg !== base) expect(dodged).toBe(attacks);
      expect(h.needs.mood).toBeCloseTo(cfg.formula.needMax - attacks * cfg.formula.moodPerHitTaken, 9);
    }
  });
});
