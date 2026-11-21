/**
 * M5 hunter systems (TECH_SPEC §4.1, §5.5): waiting queue, auto-invite, invitations (tier odds → grades), donate, banish,
 * personality reroll, new personality targets, v13 → v14 migration, offline queue/arrivals.
 */
import { describe, expect, it } from 'vitest';
import { expectedEnhanceCost, urgentThreshold } from '../src/core/ai/utility';
import { applyCommand } from '../src/core/commands';
import { ConfigError, loadConfig } from '../src/core/config/load';
import { HUNTER_TIERS, PERSONALITY_TARGETS, STAT_KEYS, type FormulaParams, type GameConfig, type HunterTierId } from '../src/core/config/types';
import { EventBuffer, type SimEvent } from '../src/core/events';
import { monsterStats } from '../src/core/formulas';
import { naturalTierOdds, personalityFactor, rollHunter, rollHunterOfTier, rollInvitationTier, tierFromPoints } from '../src/core/hunterFactory';
import { advanceOfflineWallClock } from '../src/core/offline';
import { NavGraph } from '../src/core/pathfinding';
import { Rng } from '../src/core/rng';
import { deserialize, SAVE_FORMAT } from '../src/core/save/save';
import { createWorld, Simulation } from '../src/core/simulation';
import type { SystemContext } from '../src/core/system';
import { advanceArrivals } from '../src/core/systems/arrivals';
import { damageMonster } from '../src/core/systems/combat';
import { economySystem } from '../src/core/systems/economy';
import { townHunterCount } from '../src/core/systems/journey';
import { WORLD_SCHEMA_VERSION, type Hunter, type Monster, type World } from '../src/core/world';
import { readRawConfig, testConfig } from './helpers';

const base = testConfig();
const nav = new NavGraph(base);
const SEC = 1000;
const POINTS: Record<string, number> = { normal: 0, high: 1, highest: 2 };

function cfg(patch: Partial<FormulaParams> = {}): GameConfig {
  return { ...base, formula: { ...base.formula, ...patch } as FormulaParams };
}

function makeCtx(config: GameConfig = base, seed = 1): SystemContext & { events: EventBuffer } {
  const world = createWorld(config, seed);
  return { world, config, nav, rng: new Rng(seed), events: new EventBuffer(), debug: { aiScores: new Map() }, dtMs: 100 };
}

function addHunter(ctx: SystemContext, seed = 7): Hunter {
  const h = rollHunter(ctx.config, new Rng(seed), `h${ctx.world.nextId++}`, ctx.config.index.squareNode, { x: 0, y: 0 }, 0);
  ctx.world.hunters.push(h);
  return h;
}

function fill(ctx: SystemContext): void {
  while (townHunterCount(ctx.world) < ctx.config.formula.hunterSlots) addHunter(ctx, ctx.world.hunters.length + 1);
}

const ofType = <T extends SimEvent['type']>(evs: SimEvent[], t: T) =>
  evs.filter((e): e is Extract<SimEvent, { type: T }> => e.type === t);

function rejected(ctx: SystemContext & { events: EventBuffer }, cmd: Parameters<typeof applyCommand>[1]): string | null {
  applyCommand(ctx, cmd);
  const r = ofType(ctx.events.drain(), 'commandRejected');
  return r.length ? r[0]!.reason : null;
}

const points = (h: Hunter) => STAT_KEYS.reduce((a, k) => a + POINTS[h.statGrades[k]]!, 0);

describe('waiting queue (EHT waiting slot)', () => {
  it('a full town draws no RNG: visitors join the queue every queueArrivalIntervalSec up to queueMax', () => {
    const ctx = makeCtx(cfg({ queueMax: 3, queueArrivalIntervalSec: 60 }));
    fill(ctx);
    const rng = JSON.stringify(ctx.rng.state);
    const r = advanceArrivals(ctx, 150 * SEC);
    expect(r.arrived).toEqual([]);
    expect(r.queued).toHaveLength(2);
    expect(ctx.world.town.queueTimerMs).toBe(30 * SEC);
    expect(advanceArrivals(ctx, 10 * 3600 * SEC).queued).toHaveLength(1); // capped at queueMax
    expect(ctx.world.town.queue.map((e) => e.uid)).toEqual(['q1', 'q2', 'q3']);
    expect(ctx.world.town.queueTimerMs).toBe(0); // queue full: timer rests
    expect(ctx.world.town.arrivalTimerMs).toBe(0);
    expect(JSON.stringify(ctx.rng.state)).toBe(rng);
    expect(ctx.world.stats.queueJoined).toBe(3);
    expect(ofType(ctx.events.drain(), 'hunterQueued').map((e) => e.position)).toEqual([1, 2, 3]);
  });

  it('banish frees a slot and the queue front enters the same tick (gear → Town gear storage)', () => {
    const sim = new Simulation(base, createWorld(base, 3));
    for (let i = 0; i < base.formula.hunterSlots; i++) sim.enqueue({ type: 'debug.spawnHunter' });
    for (let i = 0; i < (base.formula.queueArrivalIntervalSec + 1) * 10; i++) sim.step();
    expect(sim.world.town.queue.length).toBe(1);
    const h = sim.world.hunters[0]!;
    h.equipment.weapon = { uid: 'g-ban', gearId: 'gear.w.club', qualityId: 'q.rare', enhance: 2 };
    h.gold = 77;
    const reclaimedBefore = sim.world.stats.gearReclaimed;
    sim.drainEvents();
    sim.enqueue({ type: 'hunter.banish', hunterId: h.id });
    sim.step();
    const ev = sim.drainEvents();
    expect(ofType(ev, 'commandRejected')).toEqual([]);
    expect(ofType(ev, 'hunterBanished')).toMatchObject([{ hunterId: h.id, itemUids: ['g-ban'], gold: 77 }]);
    expect(ofType(ev, 'gearReclaimed')[0]!.itemUids).toEqual(['g-ban']);
    expect(sim.world.hunters.find((x) => x.id === h.id)).toBeUndefined();
    expect(sim.world.stats.gearReclaimed).toBe(reclaimedBefore + 1);
    // In Town gear storage — or already put back on sale by the same tick's crafting system (TECH_SPEC §5.8).
    const kept = [...sim.world.town.gearStorage, ...sim.world.town.shop].find((g) => g.uid === 'g-ban');
    expect(kept).toMatchObject({ uid: 'g-ban', enhance: 2 });
    const arrived = ofType(ev, 'hunterArrived');
    expect(arrived).toHaveLength(1);
    expect(arrived[0]!.fromQueue).toBe(true);
    expect(sim.world.town.queue).toEqual([]);
    expect(sim.world.hunters).toHaveLength(base.formula.hunterSlots);
    expect(sim.world.stats).toMatchObject({ banished: 1, queueEntered: 1 });
  });

  it('banish/donate reject unknown hunters cleanly', () => {
    const ctx = makeCtx();
    expect(rejected(ctx, { type: 'hunter.banish', hunterId: 'nobody' })).toBe('unknown hunter');
    expect(rejected(ctx, { type: 'hunter.donate', hunterId: 'nobody', gold: 1 })).toBe('unknown hunter');
  });
});

describe('auto-invite (few hunters left)', () => {
  it('one hunter every autoInviteIntervalSec while townHunterCount ≤ autoInviteMaxHunters, odds of the autoInvite row', () => {
    // Visitors effectively off so only the auto-invite brings hunters.
    const ctx = makeCtx(cfg({ arrivalIntervalSec: 1e9, autoInviteMaxHunters: 2, autoInviteIntervalSec: 600 }));
    addHunter(ctx);
    const r = advanceArrivals(ctx, 1250 * SEC);
    expect(r.arrived).toHaveLength(2);
    expect(ctx.world.hunters).toHaveLength(3);
    expect(ctx.world.town.autoInviteTimerMs).toBe(0); // 3 > 2: timer off
    expect(advanceArrivals(ctx, 3600 * SEC).arrived).toEqual([]);
    const inv = ofType(ctx.events.drain(), 'hunterInvited');
    expect(inv.map((e) => [e.invitationId, e.paid])).toEqual([[base.index.autoInvitation, 'free'], [base.index.autoInvitation, 'free']]);
    for (const e of inv) expect(ctx.world.hunters.find((h) => h.id === e.hunterId)!.tier).toBe(e.tier);
    expect(ctx.world.stats.autoInvites).toBe(2);
  });

  it('runs offline too (same advanceArrivals): the queue fills free slots first, then visitors', () => {
    const sim = new Simulation(base, createWorld(base, 5));
    for (let i = 0; i < base.formula.hunterSlots; i++) sim.enqueue({ type: 'debug.spawnHunter' });
    sim.step();
    sim.world.town.queue.push({ uid: 'qx', source: 'invite', tier: 'superior', queuedAtMs: 0 });
    sim.world.hunters.splice(0, 2); // two slots free (e.g. banished before the save)
    const r = sim.runBetweenTicks((ctx) => advanceOfflineWallClock(ctx, 3600 * SEC));
    expect(r.arrivals).toHaveLength(2);
    const fromQueue = sim.world.hunters.find((h) => h.id === r.arrivals[0])!;
    expect(fromQueue.tier).toBe('superior');
    expect(sim.world.hunters).toHaveLength(base.formula.hunterSlots);
    expect(r.queued).toBe(Math.min(base.formula.queueMax, Math.floor((3600 - base.formula.arrivalIntervalSec) / base.formula.queueArrivalIntervalSec)));
  });
});

describe('invitations: tier odds drive grade rolls', () => {
  it('config has the invitation table, at most one autoInvite row, odds with a positive total', () => {
    expect(base.invitations.length).toBeGreaterThan(0);
    expect(base.index.autoInvitation).not.toBeNull();
    const bad = (mut: (raw: Record<string, any>) => void) => {
      const raw = readRawConfig() as Record<string, any>;
      mut(raw);
      return () => loadConfig(raw as never);
    };
    expect(bad((r) => { r.invitation[1].autoInvite = true; })).toThrow(ConfigError);
    expect(bad((r) => { r.invitation[0].tierChances = { normal: 0, rare: 0, superior: 0, heroic: 0, legendary: 0 }; })).toThrow(ConfigError);
    expect(bad((r) => { r.personality[0].modifiers.push({ target: 'gold.found', op: 'mul', value: 2 }); })).toThrow(ConfigError);
  });

  it('rollInvitationTier follows tierChances (deterministic per seed)', () => {
    const inv = base.invitations[0]!;
    const total = HUNTER_TIERS.reduce((a, t) => a + inv.tierChances[t], 0);
    const rng = new Rng(42);
    const n = 40000;
    const count: Record<string, number> = {};
    for (let i = 0; i < n; i++) { const t = rollInvitationTier(rng, inv); count[t] = (count[t] ?? 0) + 1; }
    for (const t of ['normal', 'rare', 'superior'] as const) {
      expect(Math.abs((count[t] ?? 0) / n - inv.tierChances[t] / total)).toBeLessThan(0.01);
    }
    const a = new Rng(9); const b = new Rng(9);
    expect(Array.from({ length: 50 }, () => rollInvitationTier(a, inv))).toEqual(Array.from({ length: 50 }, () => rollInvitationTier(b, inv)));
  });

  it('rollHunterOfTier gives grades whose points match the tier (every tier reachable)', () => {
    const rng = new Rng(3);
    for (const tier of HUNTER_TIERS) {
      for (let i = 0; i < 40; i++) {
        const h = rollHunterOfTier(base, rng, 'x', tier, base.index.squareNode, { x: 0, y: 0 }, 0);
        expect(h.tier).toBe(tier);
        expect(tierFromPoints(base, points(h))).toBe(tier);
        for (const k of STAT_KEYS) expect(h.stats[k]).toBe(h.rollStats[k]);
      }
    }
    // Fallback when a config leaves a tier unreachable: top-grade combination, stats in the upper half of the range.
    const strict = { ...base, hunterTiers: base.hunterTiers.map((t) => (t.tier === 'legendary' ? { ...t, minPoints: 99 } : t)) };
    for (let i = 0; i < 20; i++) {
      const h = rollHunterOfTier(strict, rng, 'x', 'legendary', base.index.squareNode, { x: 0, y: 0 }, 0);
      expect(h.tier).toBe('legendary');
      const cls = base.index.classes.get(h.classId)!;
      for (const k of STAT_KEYS) {
        expect(h.statGrades[k]).toBe('highest');
        const [min, max] = cls.statRanges[k][2];
        expect(h.rollStats[k]).toBeGreaterThanOrEqual(Math.ceil((min + max) / 2));
      }
    }
    // Same seed → same hunter.
    const x = rollHunterOfTier(base, new Rng(11), 'x', 'rare', 'n', { x: 0, y: 0 }, 0);
    const y = rollHunterOfTier(base, new Rng(11), 'x', 'rare', 'n', { x: 0, y: 0 }, 0);
    expect(x).toEqual(y);
  });

  it('invitation odds beat the natural visitor odds above normal', () => {
    const nat = naturalTierOdds(base);
    expect(HUNTER_TIERS.reduce((a, t) => a + nat[t], 0)).toBeCloseTo(1, 9);
    // Every tier reachable from grade points, rarer with each step (hunter_tier scaled to 5 graded stats).
    for (let i = 1; i < HUNTER_TIERS.length; i++) {
      expect(nat[HUNTER_TIERS[i]!]).toBeGreaterThan(0);
      expect(nat[HUNTER_TIERS[i]!]).toBeLessThan(nat[HUNTER_TIERS[i - 1]!]);
    }
    // Every invitation (incl. the free auto-invite) beats a free visitor at every tier from superior up, and
    // invitations in config order (dearer) are at least as good from superior up.
    let prevTop = 0;
    for (const inv of base.invitations) {
      const tot = HUNTER_TIERS.reduce((a, t: HunterTierId) => a + inv.tierChances[t], 0);
      for (const t of ['superior', 'heroic', 'legendary'] as const) expect(inv.tierChances[t] / tot).toBeGreaterThan(nat[t]);
      const top = (inv.tierChances.superior + inv.tierChances.heroic + inv.tierChances.legendary) / tot;
      expect(top).toBeGreaterThanOrEqual(prevTop);
      prevTop = top;
    }
  });

  it('hunter_tier: thresholds scale with the number of graded stats; config check rejects bad tables', () => {
    // 5 stats × 2 points = 10; fractions 0 / 0.3 / 0.5 / 0.7 / 0.8.
    expect(base.hunterTiers.map((t) => t.minPoints)).toEqual([0, 3, 5, 7, 8]);
    const bad = (mut: (raw: Record<string, any>) => void) => {
      const raw = readRawConfig() as Record<string, any>;
      mut(raw);
      return () => loadConfig(raw as never);
    };
    expect(bad((r) => { r.hunter_tier[2].minPointsFrac = 0.2; })).toThrow(ConfigError); // not increasing
    expect(bad((r) => { r.hunter_tier[0].minPointsFrac = 0.1; })).toThrow(ConfigError); // normal must start at 0
    expect(bad((r) => { r.hunter_tier.pop(); })).toThrow(ConfigError); // missing tier
    expect(bad((r) => { r.hunter_tier[3].minPointsFrac = 0.71; r.hunter_tier[4].minPointsFrac = 0.75; })).toThrow(ConfigError); // both 8 points
    expect(bad((r) => { r.hunter_tier[3].minPointsFrac = 0.61; r.hunter_tier[4].minPointsFrac = 0.75; })).not.toThrow(); // 7 / 8
  });

  it('town.invite: pays gold (gold sink) or a ticket first; hunter enters now, or waits at the queue front when full', () => {
    const ctx = makeCtx();
    const inv = base.invitations.find((i) => i.gold !== undefined && !i.townHallLevel)!;
    ctx.world.town.gold = inv.gold! - 1;
    expect(rejected(ctx, { type: 'town.invite', invitationId: inv.id })).toBe('not enough gold');
    expect(rejected(ctx, { type: 'town.invite', invitationId: 'inv.nope' })).toBe('unknown invitation');
    ctx.world.town.gold = inv.gold! + 5;
    applyCommand(ctx, { type: 'town.invite', invitationId: inv.id });
    let ev = ctx.events.drain();
    const e = ofType(ev, 'hunterInvited')[0]!;
    expect(e).toMatchObject({ invitationId: inv.id, paid: 'gold', gold: inv.gold });
    expect(ctx.world.town.gold).toBe(5);
    expect(ctx.world.hunters.find((h) => h.id === e.hunterId)!.tier).toBe(e.tier);
    expect(ofType(ev, 'hunterArrived')[0]).toMatchObject({ hunterId: e.hunterId, source: 'invite' });
    // Ticket first, no gold; town full → queue front.
    fill(ctx);
    ctx.world.town.queue.push({ uid: 'q-old', source: 'visitor', queuedAtMs: 0 });
    applyCommand(ctx, { type: 'debug.grantTicket', invitationId: inv.id, count: 1 });
    applyCommand(ctx, { type: 'town.invite', invitationId: inv.id });
    ev = ctx.events.drain();
    expect(ofType(ev, 'commandRejected')).toEqual([]);
    const q = ofType(ev, 'hunterInvited')[0]!;
    expect(q).toMatchObject({ paid: 'ticket', gold: 0 });
    expect(q.hunterId).toBeUndefined();
    expect(ctx.world.town.queue[0]).toMatchObject({ uid: q.queueUid, source: 'invite', tier: q.tier, invitationId: inv.id });
    expect(ctx.world.town.tickets[inv.id]).toBeUndefined();
    // A second invitation queues behind the first one, still ahead of the plain visitor.
    ctx.world.town.gold += inv.gold!;
    applyCommand(ctx, { type: 'town.invite', invitationId: inv.id });
    const q2 = ofType(ctx.events.drain(), 'hunterInvited')[0]!;
    expect(ctx.world.town.queue.map((x) => x.uid)).toEqual([q.queueUid, q2.queueUid, 'q-old']);
    expect(ctx.world.town.gold).toBe(5);
    expect(ctx.world.stats).toMatchObject({ invites: 3, inviteGold: 2 * inv.gold! });
    // Queue full and town full → rejected; ticket-only row without a ticket → rejected; Town Hall gate.
    const small = makeCtx(cfg({ queueMax: 0 }));
    fill(small);
    small.world.town.gold = 1e9;
    expect(rejected(small, { type: 'town.invite', invitationId: inv.id })).toBe('town and queue are full');
    const ticketOnly = base.invitations.find((i) => i.gold === undefined)!;
    expect(rejected(ctx, { type: 'town.invite', invitationId: ticketOnly.id })).toBe('no ticket');
    const gated = base.invitations.find((i) => (i.townHallLevel ?? 0) > 1 && i.gold !== undefined)!;
    const g = makeCtx();
    g.world.town.gold = 1e9;
    expect(rejected(g, { type: 'town.invite', invitationId: gated.id })).toBe('town hall level too low');
  });
});

describe('donate / reroll', () => {
  it('hunter.donate moves Town gold to the hunter; rejects bad amounts', () => {
    const ctx = makeCtx();
    const h = addHunter(ctx);
    h.gold = 10;
    ctx.world.town.gold = 300;
    for (const g of [0, -5, 1.5, Number.NaN, '7' as unknown as number]) expect(rejected(ctx, { type: 'hunter.donate', hunterId: h.id, gold: g })).toBe('invalid gold');
    expect(rejected(ctx, { type: 'hunter.donate', hunterId: h.id, gold: 301 })).toBe('not enough gold');
    expect(rejected(ctx, { type: 'hunter.donate', hunterId: h.id, gold: 250 })).toBeNull();
    expect([h.gold, ctx.world.town.gold, ctx.world.stats.donatedGold]).toEqual([260, 50, 250]);
  });

  it('hunter.rerollPersonality costs personalityRerollGold Town gold and draws a new set', () => {
    const ctx = makeCtx();
    const h = addHunter(ctx);
    ctx.world.town.gold = base.formula.personalityRerollGold - 1;
    expect(rejected(ctx, { type: 'hunter.rerollPersonality', hunterId: h.id })).toBe('not enough gold');
    ctx.world.town.gold = base.formula.personalityRerollGold;
    applyCommand(ctx, { type: 'hunter.rerollPersonality', hunterId: h.id });
    const e = ofType(ctx.events.drain(), 'personalityRerolled')[0]!;
    expect(e.to).toEqual(h.personalities);
    expect(new Set(h.personalities).size).toBe(base.formula.personalitiesPerHunter);
    expect(ctx.world.town.gold).toBe(0);
  });
});

describe('personality modifiers (TECH_SPEC §5.5)', () => {
  it('every config personality uses known targets; kinds cover positive, negative and neutral', () => {
    for (const p of base.personalities) for (const m of p.modifiers) expect(PERSONALITY_TARGETS).toContain(m.target);
    const kinds = new Set(base.personalities.map((p) => p.kind));
    expect(kinds).toEqual(new Set(['positive', 'negative', 'neutral']));
  });

  const withPers = (ctx: SystemContext, ids: string[]) => {
    const h = addHunter(ctx);
    h.personalities = ids;
    h.gold = 0;
    return h;
  };
  /** A monster worth ≥ 10 gold on Easy, so ×1.15 / ×0.88 survive rounding (same as tests/tax.test.ts). */
  const RICH = 'mon.hollowlord';
  const kill = (ctx: SystemContext, h: Hunter) => {
    const zone = base.zones.find((z) => z.monsters.some((zm) => zm.monsterId === RICH))!;
    const m: Monster = {
      id: `m${ctx.world.nextId++}`, defId: RICH, zoneId: zone.id, hp: 1, position: { x: 0, y: 0 }, home: { x: 0, y: 0 },
      targetHunterId: null, attackCdMs: 0, difficultyId: 'diff.easy',
    };
    ctx.world.monsters.push(m);
    damageMonster(ctx, h, m, 1e9, false);
    return monsterStats(ctx.config, m);
  };

  it('gain.gold and gain.exp scale kill rewards', () => {
    const noLevel = cfg({ taxRate: 0, taxMinRate: 0, expBase: 1e15 });
    // EXP per level comes from exp_curve (M5 progression): make every level unreachable there too.
    const ctx = makeCtx({ ...noLevel, expCurve: noLevel.expCurve.map((r) => ({ ...r, exp: r.exp.map(() => 1e15) })) }); // no tax, no level-up: compare raw totals
    const plain = withPers(ctx, ['pers.plain']);
    const lucky = withPers(ctx, ['pers.lucky', 'pers.studious']);
    const jinx = withPers(ctx, ['pers.jinxed', 'pers.dreamy']);
    const ms = kill(ctx, plain);
    for (let i = 0; i < 9; i++) { kill(ctx, plain); kill(ctx, lucky); kill(ctx, jinx); }
    kill(ctx, lucky); kill(ctx, jinx);
    const k = (id: string, t: string) => personalityFactor(base, { personalities: [id] } as Hunter, t);
    expect(plain.gold).toBe(10 * ms.gold);
    expect(lucky.gold).toBe(10 * Math.round(ms.gold * k('pers.lucky', 'gain.gold')));
    expect(jinx.gold).toBe(10 * Math.round(ms.gold * k('pers.jinxed', 'gain.gold')));
    expect(ms.gold).toBeGreaterThanOrEqual(10);
    expect(lucky.gold).toBeGreaterThan(plain.gold);
    expect(plain.gold).toBeGreaterThan(jinx.gold);
    expect(ms.exp).toBeGreaterThan(0);
    expect(plain.level).toBe(1);
    expect(plain.exp).toBeCloseTo(10 * ms.exp, 9);
    expect(lucky.exp).toBeCloseTo(10 * ms.exp * k('pers.studious', 'gain.exp'), 9);
    expect(jinx.exp).toBeCloseTo(10 * ms.exp * k('pers.dreamy', 'gain.exp'), 9);
  });

  it('enhance.success scales the enhance success rate (AI estimate and the forge roll)', () => {
    const ctx = makeCtx();
    const run = (ids: string[]) => {
      const h = withPers(ctx, ids);
      const g = { uid: `w${h.id}`, gearId: 'gear.w.club', qualityId: 'q.rare', enhance: 3 };
      h.equipment.weapon = g;
      const est = expectedEnhanceCost(base, h, 'weapon', ctx.world)!.successRate;
      let ok = 0;
      ctx.rng = new Rng(77);
      for (let i = 0; i < 3000; i++) {
        g.enhance = 3;
        h.gold = 1e6;
        h.ai.goal = { type: 'enhance', slot: 'weapon' };
        h.ai.phase = 'act';
        economySystem.update(ctx);
        if (g.enhance === 4) ok++;
      }
      return { est, rate: ok / 3000 };
    };
    const plain = run(['pers.plain']);
    const steady = run(['pers.steady']);
    const clumsy = run(['pers.clumsy']);
    expect(steady.est).toBeCloseTo(plain.est * 1.1, 9);
    expect(clumsy.est).toBeCloseTo(plain.est * 0.9, 9);
    expect(Math.abs(plain.rate - plain.est)).toBeLessThan(0.03);
    expect(Math.abs(steady.rate - steady.est)).toBeLessThan(0.03);
    expect(steady.rate).toBeGreaterThan(clumsy.rate);
  });

  it('retreat threshold (urgent.hp) and need decay targets', () => {
    const ctx = makeCtx();
    const plain = withPers(ctx, ['pers.plain']);
    const skittish = withPers(ctx, ['pers.skittish']);
    expect(urgentThreshold(base, skittish, 'hp')).toBeCloseTo(urgentThreshold(base, plain, 'hp') * 1.5, 9);
    const light = withPers(ctx, ['pers.lighteater']);
    expect(personalityFactor(base, light, 'decay.satiety')).toBeLessThan(1);
  });
});

describe('save v13 → v14', () => {
  it('a v12 save (pre-queue) loads with an empty queue, timers 0, no tickets, M5 stats 0, and keeps running', () => {
    const sim = new Simulation(base, createWorld(base, 2));
    for (let i = 0; i < 3; i++) sim.enqueue({ type: 'debug.spawnHunter' });
    for (let i = 0; i < 600; i++) sim.step();
    const w = JSON.parse(JSON.stringify(sim.world)) as Record<string, any>;
    for (const k of ['queue', 'queueTimerMs', 'autoInviteTimerMs', 'tickets']) delete w.town[k];
    for (const k of ['queueJoined', 'queueEntered', 'invites', 'inviteGold', 'autoInvites', 'donatedGold', 'banished', 'personalityRerolls']) delete w.stats[k];
    for (const v of [12, 13]) {
      w.schemaVersion = v;
      const r = deserialize(JSON.stringify({ format: SAVE_FORMAT, schemaVersion: v, configVersion: base.version, savedAt: 0, world: w }), base);
      expect(WORLD_SCHEMA_VERSION).toBe(16);
      expect(r.migratedFrom).toBe(v);
      const m = r.world as World;
      expect(m.schemaVersion).toBe(16);
      expect(m.town).toMatchObject({ queue: [], queueTimerMs: 0, autoInviteTimerMs: 0, tickets: {} });
      expect(m.stats).toMatchObject({ queueJoined: 0, queueEntered: 0, invites: 0, inviteGold: 0, autoInvites: 0, donatedGold: 0, banished: 0, personalityRerolls: 0 });
      const s2 = new Simulation(base, m);
      for (let i = 0; i < 300; i++) s2.step();
    }
  });

  it('keeps v14 fields that already exist (idempotent fill)', () => {
    const w = JSON.parse(JSON.stringify(createWorld(base, 1))) as Record<string, any>;
    w.town.queue = [{ uid: 'q9', source: 'visitor', queuedAtMs: 5 }];
    w.town.tickets = { 'inv.royal': 2 };
    w.stats.invites = 4;
    w.schemaVersion = 13;
    const r = deserialize(JSON.stringify({ format: SAVE_FORMAT, schemaVersion: 13, configVersion: base.version, savedAt: 0, world: w }), base);
    expect(r.world.town.queue).toEqual([{ uid: 'q9', source: 'visitor', queuedAtMs: 5 }]);
    expect(r.world.town.tickets).toEqual({ 'inv.royal': 2 });
    expect(r.world.stats.invites).toBe(4);
  });
});
