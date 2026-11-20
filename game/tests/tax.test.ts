/** Town tax on kill gold (TECH_SPEC §5.10): rate bounds, command, collection at the kill, mood cost, save, determinism. */
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../src/core/commands';
import { ConfigError, loadConfig } from '../src/core/config/load';
import type { FormulaParams, GameConfig } from '../src/core/config/types';
import { EventBuffer, type SimEvent } from '../src/core/events';
import { monsterStats } from '../src/core/formulas';
import { personalityFactor, rollHunter } from '../src/core/hunterFactory';
import { NavGraph } from '../src/core/pathfinding';
import { Rng } from '../src/core/rng';
import { deserialize, serialize } from '../src/core/save/save';
import { createWorld, Simulation } from '../src/core/simulation';
import type { SystemContext } from '../src/core/system';
import { damageMonster } from '../src/core/systems/combat';
import { taxMoodLoss, taxOn, taxRate } from '../src/core/systems/tax';
import type { Hunter, Monster } from '../src/core/world';
import { readRawConfig, testConfig } from './helpers';

const base = testConfig();
const nav = new NavGraph(base);

/** Live config with the tax values pinned, so the tests don't move with config tuning. */
function cfg(patch: Partial<FormulaParams> = {}): GameConfig {
  return {
    ...base,
    formula: { ...base.formula, taxRate: 0.1, taxMinRate: 0, taxMaxRate: 0.5, taxMoodFreeRate: 0.1, taxMoodPerKill: 10, ...patch },
  };
}

function makeCtx(config: GameConfig = cfg()): SystemContext & { events: EventBuffer } {
  const world = createWorld(config, 1);
  world.town.gold = 1000;
  return { world, config, nav, rng: new Rng(1), events: new EventBuffer(), debug: { aiScores: new Map() }, dtMs: 100 };
}

function addHunter(ctx: SystemContext): Hunter {
  const h = rollHunter(ctx.config, new Rng(7), 'h' + ctx.world.hunters.length, base.index.squareNode, { x: 0, y: 0 }, 0);
  h.gold = 0;
  ctx.world.hunters.push(h);
  return h;
}

/** Kill a fresh monster through the real kill path (combat.damageMonster → grantKill). Returns its kill gold. */
function kill(ctx: SystemContext, h: Hunter, defId: string, zoneId: string, difficultyId = 'diff.easy'): number {
  const m: Monster = {
    id: `m${ctx.world.nextId++}`, defId, zoneId, hp: 1, position: { x: 0, y: 0 }, home: { x: 0, y: 0 },
    targetHunterId: null, attackCdMs: 0, difficultyId,
  };
  ctx.world.monsters.push(m);
  damageMonster(ctx, h, m, 1e9, false);
  return monsterStats(ctx.config, m).gold;
}

const ofType = <T extends SimEvent['type']>(evs: SimEvent[], t: T) =>
  evs.filter((e): e is Extract<SimEvent, { type: T }> => e.type === t);

/** A monster worth ≥ 10 gold on Easy (taxed at 10%), and the zone it spawns in. */
const RICH = 'mon.hollowlord';
const richZone = base.zones.find((z) => z.monsters.some((zm) => zm.monsterId === RICH))!.id;

describe('tax rate', () => {
  it('taxOn floors gold × rate and never taxes zero/negative gold or rate', () => {
    expect(taxOn(105, 0.1)).toBe(10);
    expect(taxOn(9, 0.1)).toBe(0);
    expect(taxOn(2, 0.5)).toBe(1);
    expect(taxOn(0, 0.5)).toBe(0);
    expect(taxOn(100, 0)).toBe(0);
  });

  it('defaults to config taxRate, follows town.taxRate, and clamps to [taxMinRate, taxMaxRate]', () => {
    const config = cfg({ taxRate: 0.15, taxMinRate: 0.05, taxMaxRate: 0.4 });
    const world = createWorld(config, 1);
    expect(world.town.taxRate).toBeUndefined();
    expect(taxRate(config, world)).toBe(0.15);
    world.town.taxRate = 0.3;
    expect(taxRate(config, world)).toBe(0.3);
    world.town.taxRate = 0.9; // e.g. a save made with looser bounds
    expect(taxRate(config, world)).toBe(0.4);
    world.town.taxRate = 0;
    expect(taxRate(config, world)).toBe(0.05);
  });

  it('config check rejects taxRate outside [taxMinRate, taxMaxRate] and out-of-range keys', () => {
    const bad = (patch: Record<string, number>) => {
      const raw = readRawConfig();
      raw.formula_params = { ...(raw.formula_params as object), ...patch } as never;
      return () => loadConfig(raw);
    };
    expect(bad({ taxRate: 0.6, taxMaxRate: 0.5 })).toThrow(ConfigError);
    expect(bad({ taxRate: 0.05, taxMinRate: 0.1 })).toThrow(ConfigError);
    expect(bad({ taxMaxRate: 1.5 })).toThrow(ConfigError);
    expect(bad({ taxMoodPerKill: -1 })).toThrow(ConfigError);
    expect(bad({ taxRate: 0.2 })).not.toThrow();
  });
});

describe('town.setTaxRate command', () => {
  it('rejects non-numbers and out-of-bounds rates with commandRejected, accepts the bounds', () => {
    const ctx = makeCtx(cfg({ taxMinRate: 0.05, taxMaxRate: 0.4 }));
    const cases: [unknown, string][] = [
      ['0.2', 'invalid rate'], [Number.NaN, 'invalid rate'], [Number.POSITIVE_INFINITY, 'invalid rate'], [undefined, 'invalid rate'],
      [0.04, 'rate below minimum'], [-0.1, 'rate below minimum'], [0.41, 'rate above maximum'],
    ];
    for (const [rate, reason] of cases) {
      applyCommand(ctx, { type: 'town.setTaxRate', rate: rate as number });
      const rej = ofType(ctx.events.drain(), 'commandRejected');
      expect(rej.map((e) => e.reason)).toEqual([reason]);
      expect(ctx.world.town.taxRate).toBeUndefined();
    }
    for (const rate of [0.05, 0.4, 0.25]) {
      applyCommand(ctx, { type: 'town.setTaxRate', rate });
      const evs = ctx.events.drain();
      expect(ofType(evs, 'commandRejected')).toHaveLength(0);
      expect(ofType(evs, 'taxRateChanged').map((e) => e.rate)).toEqual([rate]);
      expect(ctx.world.town.taxRate).toBe(rate);
    }
  });
});

describe('tax collection at the kill', () => {
  it('moves floor(gold × rate) from the killer to Town gold, with stat and event; total gold conserved', () => {
    const ctx = makeCtx();
    const h = addHunter(ctx);
    const gold = kill(ctx, h, RICH, richZone);
    const tax = Math.floor(gold * 0.1);
    expect(tax).toBeGreaterThan(0);
    expect(h.gold).toBe(gold - tax);
    expect(ctx.world.town.gold).toBe(1000 + tax);
    expect(ctx.world.stats.taxCollected).toBe(tax);
    expect(ofType(ctx.events.drain(), 'taxCollected')).toEqual([expect.objectContaining({ hunterId: h.id, gold: tax })]);
  });

  it('scales with the rate and difficulty reward; kills worth < 1 / rate gold and rate 0 pay nothing', () => {
    const ctx = makeCtx();
    const h = addHunter(ctx);
    const slimeGold = kill(ctx, h, 'mon.slime', 'zone.meadow');
    expect(slimeGold).toBeLessThan(10);
    expect(h.gold).toBe(slimeGold); // floor(2 × 0.1) = 0
    expect(ofType(ctx.events.drain(), 'taxCollected')).toHaveLength(0);

    ctx.world.town.taxRate = 0.5;
    h.gold = 0;
    const g = kill(ctx, h, RICH, richZone, 'diff.normal');
    expect(h.gold).toBe(g - Math.floor(g * 0.5));

    ctx.world.town.taxRate = 0;
    h.gold = 0;
    const g0 = kill(ctx, h, RICH, richZone);
    expect(h.gold).toBe(g0);
    expect(ctx.world.stats.taxCollected).toBe(Math.floor(g * 0.5));
  });

  it('does not tax bounty payouts (they are Town gold already)', () => {
    const ctx = makeCtx(cfg({ taxRate: 0.5, taxMoodPerKill: 0 }));
    ctx.world.town.gold = 10_000;
    const h = addHunter(ctx);
    applyCommand(ctx, { type: 'town.postBounty', targetKind: 'monster', targetId: RICH, kills: 2, reward: 1000 });
    const gold = kill(ctx, h, RICH, richZone);
    expect(h.gold).toBe(gold - Math.floor(gold * 0.5) + 500);
  });
});

describe('tax mood cost', () => {
  it('costs no mood at or below taxMoodFreeRate', () => {
    const ctx = makeCtx();
    const h = addHunter(ctx);
    h.needs.mood = 50;
    kill(ctx, h, RICH, richZone);
    expect(h.needs.mood).toBe(50);
    expect(taxMoodLoss(ctx.config, 0.1)).toBe(0);
  });

  it('each taxed kill above the free rate costs taxMoodPerKill × (rate − free) × personality mood; untaxed kills cost none', () => {
    const ctx = makeCtx();
    const h = addHunter(ctx);
    ctx.world.town.taxRate = 0.4;
    h.needs.mood = 50;
    kill(ctx, h, RICH, richZone);
    const loss = 10 * (0.4 - 0.1) * personalityFactor(ctx.config, h, 'decay.mood');
    expect(h.needs.mood).toBeCloseTo(50 - loss, 9);
    const before = h.needs.mood;
    kill(ctx, h, 'mon.slime', 'zone.meadow'); // floor(2 × 0.4) = 0 tax → no mood cost
    expect(h.needs.mood).toBe(before);
    h.needs.mood = 0.1;
    kill(ctx, h, RICH, richZone);
    expect(h.needs.mood).toBe(0);
  });
});

describe('tax save and determinism', () => {
  it('town.taxRate survives a save; a save without it (pre-tax) loads at the config default', () => {
    const config = testConfig();
    const w = createWorld(config, 3);
    w.town.taxRate = 0.35;
    const loaded = deserialize(serialize(w, 0), config).world;
    expect(loaded.town.taxRate).toBe(0.35);
    const old = createWorld(config, 3);
    delete old.town.taxRate;
    delete old.stats.taxCollected;
    const l2 = deserialize(serialize(old, 0), config).world;
    expect(taxRate(config, l2)).toBe(config.formula.taxRate);
  });

  it('a taxed run is deterministic, survives save/load, and taxCollected equals the sum of its events', () => {
    const config = testConfig();
    const start = () => {
      const s = new Simulation(config, createWorld(config, 5));
      for (let i = 0; i < 4; i++) s.enqueue({ type: 'debug.spawnHunter' });
      s.enqueue({ type: 'town.setTaxRate', rate: 0.5 });
      return s;
    };
    const a = start();
    const b = start();
    let evTax = 0;
    for (let i = 0; i < 3000; i++) {
      a.step(); b.step();
      for (const e of a.drainEvents()) if (e.type === 'taxCollected') evTax += e.gold;
      b.drainEvents();
    }
    expect(a.world.town.taxRate).toBe(0.5);
    expect(a.world.stats.taxCollected ?? 0).toBe(evTax);
    expect(JSON.stringify(a.world)).toBe(JSON.stringify(b.world));

    const c = new Simulation(config, createWorld(config, 1));
    c.setWorld(deserialize(serialize(a.world, 0), config).world);
    for (let i = 0; i < 3000; i++) { a.step(); c.step(); }
    expect(JSON.stringify(c.world)).toBe(JSON.stringify(a.world));
    expect(a.world.stats.taxCollected ?? 0).toBeGreaterThan(evTax);
  });
});
