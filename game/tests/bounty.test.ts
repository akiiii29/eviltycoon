/** Bounties (GDD §9, TECH_SPEC §5.9): command validation, escrow, per-kill payout, completion, Torment drops, AI, auto-bounty. */
import { describe, expect, it } from 'vitest';
import { huntZoneMuls, scoreGoals } from '../src/core/ai/utility';
import { applyCommand, type Command } from '../src/core/commands';
import type { FormulaParams, GameConfig } from '../src/core/config/types';
import { EventBuffer, type SimEvent } from '../src/core/events';
import { monsterStats, zoneScores } from '../src/core/formulas';
import { rollHunter } from '../src/core/hunterFactory';
import { NavGraph } from '../src/core/pathfinding';
import { Rng } from '../src/core/rng';
import { deserialize, serialize } from '../src/core/save/save';
import { createWorld, Simulation } from '../src/core/simulation';
import type { SystemContext } from '../src/core/system';
import { bountyDropMul, bountyKillShare, bountySystem, bountyZoneMul } from '../src/core/systems/bounty';
import { damageMonster } from '../src/core/systems/combat';
import { townGoldTarget } from '../src/core/systems/trading';
import type { Hunter, Monster } from '../src/core/world';
import { testConfig } from './helpers';

const base = testConfig();
const nav = new NavGraph(base);

/** Live config with the bounty values pinned, so the tests don't move with config tuning. */
function cfg(patch: Partial<FormulaParams> = {}): GameConfig {
  return {
    ...base,
    formula: {
      ...base.formula,
      bountyMaxActive: 3, bountyMaxKills: 1000, bountyCompletionFrac: 0.25, bountyZoneBonus: 0.3,
      bountyTormentFromOrder: 5, bountyTormentDropBonus: 0.25, bountyAutoIntervalSec: 60, bountyAutoGoldMul: 1,
      bountyAutoRewardFrac: 0.1, bountyAutoKills: 30, bountyAutoExpireSec: 1800, requestZoneBonus: 0.3,
      ...patch,
    },
  };
}

function makeCtx(config: GameConfig = cfg(), gold = 10_000): SystemContext & { events: EventBuffer } {
  const world = createWorld(config, 1);
  world.town.gold = gold;
  return { world, config, nav, rng: new Rng(1), events: new EventBuffer(), debug: { aiScores: new Map() }, dtMs: 100 };
}

function addHunter(ctx: SystemContext, patch: Partial<Hunter> = {}): Hunter {
  const h = rollHunter(ctx.config, new Rng(7), 'h' + ctx.world.hunters.length, base.index.squareNode, { x: 0, y: 0 }, 0);
  Object.assign(h, patch);
  ctx.world.hunters.push(h);
  return h;
}

/** Kill a fresh monster through the real kill path (combat.damageMonster → grantKill). Returns the monster's kill gold. */
function kill(ctx: SystemContext, h: Hunter, defId: string, zoneId: string, difficultyId = 'diff.easy'): number {
  const m: Monster = {
    id: `m${ctx.world.nextId++}`, defId, zoneId, hp: 1, position: { x: 0, y: 0 }, home: { x: 0, y: 0 },
    targetHunterId: null, attackCdMs: 0, difficultyId,
  };
  ctx.world.monsters.push(m);
  damageMonster(ctx, h, m, 1e9, false);
  return monsterStats(ctx.config, m).gold;
}

const post = (ctx: SystemContext, c: Partial<Extract<Command, { type: 'town.postBounty' }>> = {}) =>
  applyCommand(ctx, { type: 'town.postBounty', targetKind: 'monster', targetId: 'mon.slime', kills: 10, reward: 1000, ...c } as Command);

const ofType = <T extends SimEvent['type']>(evs: SimEvent[], t: T) =>
  evs.filter((e): e is Extract<SimEvent, { type: T }> => e.type === t);

const escrow = (ctx: SystemContext) => ctx.world.town.bounties.reduce((a, b) => a + b.escrow, 0);

describe('town.postBounty command', () => {
  it('rejects bad targets, counts, rewards and too many bounties with commandRejected', () => {
    const ctx = makeCtx(cfg({ bountyMaxActive: 2, bountyMaxKills: 100 }), 5000);
    const cases: [Partial<Extract<Command, { type: 'town.postBounty' }>>, string][] = [
      [{ targetId: 'mon.nope' }, 'unknown monster'],
      [{ targetKind: 'zone', targetId: 'zone.nope' }, 'unknown zone'],
      [{ targetKind: 'boss' as never }, 'invalid target kind'],
      [{ kills: 0 }, 'invalid kill count'],
      [{ kills: 2.5 }, 'invalid kill count'],
      [{ kills: 101 }, 'kill count too large'],
      [{ reward: 99.5 }, 'invalid reward'],
      [{ kills: 50, reward: 49 }, 'reward below 1 gold per kill'],
      [{ reward: 5001 }, 'not enough gold'],
    ];
    for (const [c, reason] of cases) {
      post(ctx, c);
      const r = ofType(ctx.events.drain(), 'commandRejected');
      expect(r.map((e) => e.reason), JSON.stringify(c)).toEqual([reason]);
    }
    expect(ctx.world.town.bounties).toEqual([]);
    expect(ctx.world.town.gold).toBe(5000);
    post(ctx);
    post(ctx, { targetKind: 'zone', targetId: 'zone.ruins' });
    post(ctx);
    expect(ofType(ctx.events.drain(), 'commandRejected').map((e) => e.reason)).toEqual(['too many bounties']);
    applyCommand(ctx, { type: 'town.cancelBounty', bountyId: 'b-none' });
    expect(ofType(ctx.events.drain(), 'commandRejected').map((e) => e.reason)).toEqual(['unknown bounty']);
  });

  it('escrows the reward from town gold up front; cancelling refunds what is left', () => {
    const ctx = makeCtx(cfg(), 5000);
    const h = addHunter(ctx);
    post(ctx, { kills: 4, reward: 1000 });
    const posted = ofType(ctx.events.drain(), 'bountyPosted');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ targetKind: 'monster', targetId: 'mon.slime', kills: 4, reward: 1000, auto: false });
    expect(ctx.world.town.gold).toBe(4000);
    expect(ctx.world.town.bounties[0]).toMatchObject({ progress: 0, escrow: 1000, reward: 1000 });
    kill(ctx, h, 'mon.slime', 'zone.meadow');
    expect(escrow(ctx)).toBe(750);
    applyCommand(ctx, { type: 'town.cancelBounty', bountyId: ctx.world.town.bounties[0]!.id });
    const ev = ofType(ctx.events.drain(), 'bountyCancelled');
    expect(ev).toEqual([expect.objectContaining({ refund: 750, reason: 'cancelled' })]);
    expect(ctx.world.town.gold).toBe(4750);
    expect(ctx.world.town.bounties).toEqual([]);
  });
});

describe('bounty payout', () => {
  it('per-kill shares sum exactly to the reward', () => {
    for (const [reward, kills] of [[1000, 3], [7, 7], [101, 10], [99999, 997]] as const) {
      let sum = 0;
      for (let k = 1; k <= kills; k++) {
        const s = bountyKillShare(reward, kills, k);
        expect(s).toBeGreaterThanOrEqual(Math.floor(reward / kills));
        sum += s;
      }
      expect(sum).toBe(reward);
    }
  });

  it('pays the killer per target kill, ignores other monsters, and completes with the kingdom payout', () => {
    const ctx = makeCtx(cfg({ bountyCompletionFrac: 0.25 }), 5000);
    const a = addHunter(ctx);
    const b = addHunter(ctx);
    post(ctx, { kills: 3, reward: 1000 });
    ctx.events.drain();
    const total0 = ctx.world.town.gold + escrow(ctx) + a.gold + b.gold;

    const g0 = a.gold;
    const boarGold = kill(ctx, a, 'mon.boar', 'zone.meadow'); // not a target
    expect(a.gold - g0).toBe(boarGold);
    expect(ctx.world.town.bounties[0]!.progress).toBe(0);

    let killGold = boarGold;
    const ga = a.gold, gb = b.gold;
    killGold += kill(ctx, a, 'mon.slime', 'zone.meadow');
    killGold += kill(ctx, b, 'mon.slime', 'zone.meadow');
    const progress = ofType(ctx.events.drain(), 'bountyProgress');
    expect(progress.map((e) => [e.hunterId, e.progress, e.gold])).toEqual([[a.id, 1, 333], [b.id, 2, 333]]);
    // Town + escrow + hunters is conserved while the bounty runs (kill gold is the only new gold).
    expect(ctx.world.town.gold + escrow(ctx) + a.gold + b.gold).toBe(total0 + killGold);

    const town = ctx.world.town.gold;
    killGold += kill(ctx, b, 'mon.slime', 'zone.meadow');
    const ev = ctx.events.drain();
    expect(ofType(ev, 'bountyProgress')[0]).toMatchObject({ progress: 3, gold: 334 });
    expect(ofType(ev, 'bountyCompleted')).toEqual([expect.objectContaining({ hunterId: b.id, reward: 1000, kingdomGold: 250 })]);
    expect(ctx.world.town.bounties).toEqual([]);
    expect(ctx.world.town.gold).toBe(town + 250);
    expect(a.gold - ga + b.gold - gb).toBe(1000 + killGold - boarGold);
    expect(ctx.world.stats).toMatchObject({ bountiesPosted: 1, bountiesCompleted: 1, bountyGoldPaid: 1000, bountyKingdomGold: 250 });
    // Net town cost of the bounty: reward − kingdom payout.
    expect(ctx.world.town.gold).toBe(5000 - 1000 + 250);
  });

  it('a zone bounty counts any kill in the zone; a kill advances only the first matching bounty', () => {
    const ctx = makeCtx(cfg(), 5000);
    const h = addHunter(ctx);
    post(ctx, { targetKind: 'zone', targetId: 'zone.meadow', kills: 5, reward: 50 });
    post(ctx, { targetId: 'mon.slime', kills: 5, reward: 50 });
    kill(ctx, h, 'mon.boar', 'zone.meadow');
    kill(ctx, h, 'mon.slime', 'zone.meadow');
    kill(ctx, h, 'mon.golem', 'zone.ruins');
    expect(ctx.world.town.bounties.map((b) => b.progress)).toEqual([2, 0]);
  });
});

describe('Torment raises bounty-target drop rates', () => {
  it('drop multiplier is 1 below bountyTormentFromOrder, then 1 + bonus × tier', () => {
    const c = cfg({ bountyTormentFromOrder: 5, bountyTormentDropBonus: 0.25 });
    expect(bountyDropMul(c, 'diff.easy')).toBe(1);
    expect(bountyDropMul(c, 'diff.nightmare')).toBe(1); // order 4
    expect(bountyDropMul(c, 'diff.torment1')).toBeCloseTo(1.25);
    expect(bountyDropMul(c, 'diff.torment3')).toBeCloseTo(1.75);
  });

  it('only bounty targets killed under Torment drop more, with the same number of RNG draws', () => {
    // Bonus 1 at torment1 → slime gel 0.6 × 2 → always drops.
    const c = cfg({ bountyTormentDropBonus: 1 });
    const drops = (bounty: boolean, diff: string) => {
      const ctx = makeCtx(c, 1e6);
      const h = addHunter(ctx);
      if (bounty) post(ctx, { kills: 1000, reward: 1000 });
      let gel = 0;
      for (let i = 0; i < 40; i++) {
        h.bag = {};
        kill(ctx, h, 'mon.slime', 'zone.meadow', diff);
        gel += h.bag['mat.gel'] ?? 0;
      }
      return { gel, rng: ctx.rng.state };
    };
    expect(drops(true, 'diff.torment1').gel).toBe(40);
    expect(drops(false, 'diff.torment1').gel).toBeLessThan(40);
    expect(drops(true, 'diff.easy')).toEqual(drops(false, 'diff.easy'));
    expect(drops(true, 'diff.torment1').rng).toEqual(drops(false, 'diff.torment1').rng);
  });
});

describe('AI: bounty targets steer zone choice', () => {
  function twoZoneHunter(): Hunter {
    for (let k = 1; k <= 20; k += 0.25) {
      const h = rollHunter(base, new Rng(7), 'h0', base.index.squareNode, { x: 0, y: 0 }, 0);
      h.stats = { ...h.stats, atk: h.stats.atk * k, hp: h.stats.hp * k };
      h.needs.hp = h.stats.hp;
      const scores = zoneScores(base, createWorld(base, 1), h);
      if (['zone.meadow', 'zone.ruins'].every((id) => scores.find((z) => z.zone.id === id)!.fit > 0)) return h;
    }
    throw new Error('no stat scale fits both zones');
  }
  function huntScores(bounty?: { targetKind: 'monster' | 'zone'; targetId: string }): Map<string, number> {
    const ctx = makeCtx(cfg(), 10_000);
    ctx.world.town.autoCraft = false; // no automatic material requests
    if (bounty) post(ctx, { ...bounty, kills: 10, reward: 100 });
    const out = new Map<string, number>();
    for (const c of scoreGoals(ctx.config, nav, ctx.world, twoZoneHunter())) if (c.goal.type === 'hunt') out.set(c.goal.zoneId, c.score);
    return out;
  }

  it('bountyZoneMul = 1 + bonus × target share of spawn weight (1 for a zone bounty)', () => {
    const ctx = makeCtx(cfg({ bountyZoneBonus: 0.3 }));
    const meadow = base.index.zones.get('zone.meadow')!;
    expect(bountyZoneMul(ctx.config, ctx.world, meadow)).toBe(1);
    post(ctx, { targetId: 'mon.boar' }); // weight 1 of 4
    expect(bountyZoneMul(ctx.config, ctx.world, meadow)).toBeCloseTo(1 + 0.3 * 0.25);
    post(ctx, { targetKind: 'zone', targetId: 'zone.meadow' });
    expect(bountyZoneMul(ctx.config, ctx.world, meadow)).toBeCloseTo(1.3);
  });

  it('a bounty zone gains on the others without raising the best hunt score', () => {
    const none = huntScores();
    const golem = huntScores({ targetKind: 'monster', targetId: 'mon.golem' }); // ruins
    const meadow = huntScores({ targetKind: 'zone', targetId: 'zone.meadow' });
    const gap = (s: Map<string, number>) => s.get('zone.ruins')! - s.get('zone.meadow')!;
    expect(gap(golem)).toBeGreaterThan(gap(none));
    expect(gap(meadow)).toBeLessThan(gap(none));
    const best = (s: Map<string, number>) => Math.max(...s.values());
    expect(best(golem)).toBeLessThanOrEqual(best(none) + 1e-9);
    expect(best(meadow)).toBeLessThanOrEqual(best(none) + 1e-9);
    expect(golem.get('zone.ruins')).toBeCloseTo(none.get('zone.ruins')!);
  });

  it('never boosts a zone the hunter cannot survive', () => {
    const ctx = makeCtx(cfg());
    post(ctx, { targetKind: 'zone', targetId: 'zone.abyss' });
    const scores = zoneScores(ctx.config, ctx.world, twoZoneHunter());
    const muls = huntZoneMuls(ctx.config, scores, {}, ctx.world);
    expect(muls.has('zone.abyss')).toBe(false);
  });
});

describe('auto-bounties', () => {
  /** World with one hunter hunting the meadow and town gold `gold`; runs the bounty system on its check tick. */
  function autoCtx(gold: number, patch: Partial<FormulaParams> = {}) {
    const ctx = makeCtx(cfg(patch), gold);
    const h = addHunter(ctx);
    h.ai.goal = { type: 'hunt', zoneId: 'zone.meadow' };
    return { ctx, h, target: townGoldTarget(ctx.config, ctx.world) };
  }

  it('posts one bounty on a hunted monster when town gold is above the treasury target, escrowing frac × excess', () => {
    const { ctx, target } = autoCtx(0);
    ctx.world.town.gold = target + 10_000;
    const rng0 = ctx.rng.state;
    bountySystem.update(ctx);
    expect(ctx.rng.state).toEqual(rng0); // no RNG drawn
    expect(ctx.world.town.bounties).toHaveLength(1);
    const b = ctx.world.town.bounties[0]!;
    expect(b).toMatchObject({ auto: true, targetKind: 'monster', kills: 30, reward: 1000, escrow: 1000 });
    expect(['mon.slime', 'mon.boar']).toContain(b.targetId);
    expect(ctx.world.town.gold).toBe(target + 9000);
    // Only one auto-bounty at a time.
    bountySystem.update(ctx);
    expect(ctx.world.town.bounties).toHaveLength(1);
  });

  it('prefers the hunted monster that drops requested materials', () => {
    const { ctx, target } = autoCtx(0);
    ctx.world.town.autoCraft = false;
    ctx.world.town.requests = { 'mat.tusk': 5 }; // boar drop
    ctx.world.town.gold = target + 10_000;
    bountySystem.update(ctx);
    expect(ctx.world.town.bounties[0]!.targetId).toBe('mon.boar');
  });

  it('does nothing below the target, when switched off, off the check tick, or with nobody hunting', () => {
    const below = autoCtx(0);
    below.ctx.world.town.gold = below.target;
    bountySystem.update(below.ctx);
    expect(below.ctx.world.town.bounties).toHaveLength(0);

    const off = autoCtx(0);
    off.ctx.world.town.gold = off.target + 10_000;
    applyCommand(off.ctx, { type: 'town.setAutoBounty', on: false });
    bountySystem.update(off.ctx);
    expect(off.ctx.world.town.bounties).toHaveLength(0);

    const tick = autoCtx(0);
    tick.ctx.world.town.gold = tick.target + 10_000;
    tick.ctx.world.tick = 1;
    bountySystem.update(tick.ctx);
    expect(tick.ctx.world.town.bounties).toHaveLength(0);

    const idle = autoCtx(0);
    idle.ctx.world.town.gold = idle.target + 10_000;
    idle.h.ai.goal = null;
    bountySystem.update(idle.ctx);
    expect(idle.ctx.world.town.bounties).toHaveLength(0);
  });

  it('auto-bounties expire after bountyAutoExpireSec and refund the escrow; player bounties do not', () => {
    const { ctx, target } = autoCtx(0, { bountyAutoExpireSec: 600 });
    ctx.world.town.gold = target + 10_000;
    bountySystem.update(ctx);
    post(ctx, { targetKind: 'zone', targetId: 'zone.ruins', kills: 10, reward: 100 });
    ctx.events.drain();
    const gold = ctx.world.town.gold;
    ctx.world.timeMs += 600_000;
    ctx.world.tick += 6000;
    ctx.world.town.autoBounty = false;
    bountySystem.update(ctx);
    expect(ofType(ctx.events.drain(), 'bountyCancelled')).toEqual([expect.objectContaining({ refund: 1000, reason: 'expired' })]);
    expect(ctx.world.town.gold).toBe(gold + 1000);
    expect(ctx.world.town.bounties.map((b) => b.auto)).toEqual([false]);
  });
});

describe('bounty determinism', () => {
  it('a run with a player bounty is deterministic and survives a save/load mid-bounty', () => {
    const config = testConfig();
    const start = () => {
      const s = new Simulation(config, createWorld(config, 11));
      for (let i = 0; i < 4; i++) s.enqueue({ type: 'debug.spawnHunter' });
      s.enqueue({ type: 'town.postBounty', targetKind: 'zone', targetId: 'zone.meadow', kills: 200, reward: 400 });
      return s;
    };
    const a = start();
    const b = start();
    for (let i = 0; i < 3000; i++) { a.step(); b.step(); }
    expect(a.world.town.bounties).toHaveLength(1);
    expect(a.world.town.bounties[0]!.progress).toBeGreaterThan(0);
    expect(JSON.stringify(a.world)).toBe(JSON.stringify(b.world));

    const c = new Simulation(config, createWorld(config, 1));
    c.setWorld(deserialize(serialize(a.world, 0), config).world);
    for (let i = 0; i < 3000; i++) { a.step(); c.step(); }
    expect(JSON.stringify(c.world)).toBe(JSON.stringify(a.world));
  });
});
