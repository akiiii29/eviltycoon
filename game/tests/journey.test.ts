/** Journeys (GDD §9, TECH_SPEC §5.10): validation, team power / chance, outcome, rewards, absence, save/load, offline. */
import { describe, expect, it } from 'vitest';
import { loadConfig, type RawConfig } from '../src/core/config/load';
import type { GameConfig } from '../src/core/config/types';
import type { SimEvent } from '../src/core/events';
import { hunterStats, journeySuccessChance, needMax, teamPower, zonePower, zoneScores } from '../src/core/formulas';
import { applyOffline, estimateOffline, offlineJourneyMs, takeSample } from '../src/core/offline';
import { gainExp } from '../src/core/progress';
import { deserialize, SAVE_FORMAT, serialize } from '../src/core/save/save';
import { createWorld, Simulation } from '../src/core/simulation';
import type { SystemContext } from '../src/core/system';
import { advanceJourneys, journeyOfHunter, townHunterCount } from '../src/core/systems/journey';
import { WORLD_SCHEMA_VERSION, type Hunter, type World } from '../src/core/world';
import { readRawConfig } from './helpers';

/** Shipped config with the journey numbers pinned (tests must not move with tuning). */
function makeConfig(edit?: (raw: Record<string, any>) => void): GameConfig {
  const raw = readRawConfig() as Record<string, any>;
  Object.assign(raw.formula_params, {
    journeyTeamMax: 3, journeyMaxActive: 2, journeySuccessAtRec: 0.75, journeySuccessExp: 2,
    journeySuccessMin: 0.05, journeySuccessMax: 0.95, journeyReturnNeedFrac: 0.5,
  });
  raw.journey = [
    {
      id: 'j.test', nameKey: raw.journey[0].nameKey, durationSec: 60, zoneId: 'zone.ruins', recommendedPower: 3, cost: 100,
      gold: 300, exp: 500, materials: [{ materialId: 'mat.ore', count: 5 }], rare: [{ gearId: 'gear.w.iron', qualityId: 'q.rare', chance: 1 }],
      failHpFrac: 0.3, failRewardFrac: 0.25,
    },
    { ...raw.journey[0], id: 'j.long', durationSec: 3600 },
  ];
  edit?.(raw);
  return loadConfig(raw as RawConfig);
}
const config = makeConfig();
const T0 = 1_700_000_000_000;

/** A sim with all slots filled, run one tick so the hunters exist (they arrive at the square, i.e. in Town). */
function townSim(seed = 3, cfg = config): Simulation {
  const s = new Simulation(cfg, createWorld(cfg, seed));
  for (let i = 0; i < cfg.formula.hunterSlots; i++) s.enqueue({ type: 'debug.spawnHunter' });
  s.step();
  s.drainEvents();
  return s;
}

function send(s: Simulation, cmd: Parameters<Simulation['enqueue']>[0]): SimEvent[] {
  s.enqueue(cmd);
  s.step();
  return s.drainEvents();
}

const rejected = (ev: SimEvent[]) => ev.find((e) => e.type === 'commandRejected') as Extract<SimEvent, { type: 'commandRejected' }> | undefined;
const ids = (s: Simulation, n: number) => s.world.hunters.slice(0, n).map((h) => h.id);

function runUntilDone(s: Simulation, maxTicks = 100_000): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < maxTicks && s.world.journeys.length > 0; i++) {
    s.step();
    all.push(...s.drainEvents());
  }
  return all;
}

describe('journey.start validation', () => {
  it('rejects bad destinations, teams and hunters with a reason', () => {
    const s = townSim();
    const [a, b, c, d] = ids(s, 4) as [string, string, string, string];
    const reason = (cmd: any) => rejected(send(s, cmd))?.reason;
    expect(reason({ type: 'journey.start', journeyId: 'nope', hunterIds: [a] })).toBe('unknown journey');
    expect(reason({ type: 'journey.start', journeyId: 'j.test', hunterIds: [] })).toMatch(/team must have 1\.\.3/);
    expect(reason({ type: 'journey.start', journeyId: 'j.test', hunterIds: [a, b, c, d] })).toMatch(/team must have/);
    expect(reason({ type: 'journey.start', journeyId: 'j.test', hunterIds: 'h1' })).toMatch(/team must have/);
    expect(reason({ type: 'journey.start', journeyId: 'j.test', hunterIds: [a, a] })).toBe('duplicate hunter');
    expect(reason({ type: 'journey.start', journeyId: 'j.test', hunterIds: ['h999'] })).toBe('unknown hunter');

    const h = s.world.hunters.find((x) => x.id === a)!;
    h.deadMs = 5000;
    expect(reason({ type: 'journey.start', journeyId: 'j.test', hunterIds: [a] })).toBe('hunter is dead');
    h.deadMs = 0;
    h.insideBuildingId = 'bld.inn';
    expect(reason({ type: 'journey.start', journeyId: 'j.test', hunterIds: [a] })).toBe('hunter is inside a building');
    h.insideBuildingId = null;
    const field = config.nodes.find((n) => n.zoneId)!;
    const saved = { nodeId: h.nodeId, ai: h.ai };
    h.nodeId = field.id;
    h.ai = { ...h.ai, goal: { type: 'hunt', zoneId: field.zoneId! }, forced: true };
    expect(reason({ type: 'journey.start', journeyId: 'j.test', hunterIds: [a] })).toBe('hunter is not in town');
    Object.assign(h, saved);

    s.world.town.gold = 99;
    expect(reason({ type: 'journey.start', journeyId: 'j.test', hunterIds: [a] })).toBe('not enough gold');
    s.world.town.gold = 10_000;
    expect(s.world.journeys).toEqual([]);
    expect(s.world.stats.journeysStarted).toBe(0);
  });

  it('limits concurrent journeys and refuses hunters already away; recall needs a real journey', () => {
    const s = townSim();
    s.world.town.gold = 10_000;
    const [a, b, c] = ids(s, 3) as [string, string, string];
    expect(rejected(send(s, { type: 'journey.start', journeyId: 'j.long', hunterIds: [a] }))).toBeUndefined();
    expect(rejected(send(s, { type: 'journey.start', journeyId: 'j.long', hunterIds: [a, b] }))?.reason).toBe('hunter is on a journey');
    expect(rejected(send(s, { type: 'journey.start', journeyId: 'j.long', hunterIds: [b] }))).toBeUndefined();
    expect(rejected(send(s, { type: 'journey.start', journeyId: 'j.long', hunterIds: [c] }))?.reason).toBe('too many journeys');
    expect(rejected(send(s, { type: 'journey.recall', journeyUid: 'j0' }))?.reason).toBe('unknown journey');
  });

  it('rejects Move / Activities / reincarnate / debug commands for a hunter on a journey', () => {
    const s = townSim();
    const a = ids(s, 1)[0]!;
    send(s, { type: 'journey.start', journeyId: 'j.long', hunterIds: [a] });
    for (const cmd of [
      { type: 'hunter.move', hunterId: a, zoneId: 'zone.meadow' },
      { type: 'hunter.move', hunterId: a, zoneId: 'town' },
      { type: 'hunter.activity', hunterId: a, buildingId: 'bld.inn' },
      { type: 'hunter.reincarnate', hunterId: a },
      { type: 'debug.removeHunter', hunterId: a },
      { type: 'debug.restoreNeeds', hunterId: a },
    ] as const) {
      expect(rejected(send(s, cmd))?.reason, cmd.type).toBe('hunter is on a journey');
    }
  });
});

describe('team power and success chance', () => {
  const s = townSim(7);
  const zone = config.index.zones.get('zone.ruins')!;
  const diff = s.world.town.difficulty;

  it('success chance is monotone in team power and clamped', () => {
    const f = config.formula;
    let prev = -1;
    for (let p = 0; p <= 10; p += 0.25) {
      const c = journeySuccessChance(p, 3, f);
      expect(c).toBeGreaterThanOrEqual(prev);
      expect(c).toBeGreaterThanOrEqual(f.journeySuccessMin);
      expect(c).toBeLessThanOrEqual(f.journeySuccessMax);
      prev = c;
    }
    expect(journeySuccessChance(3, 3, f)).toBeCloseTo(f.journeySuccessAtRec, 10);
    expect(journeySuccessChance(1.5, 3, f)).toBeCloseTo(0.75 * 0.25, 10);
    expect(journeySuccessChance(1e9, 3, f)).toBe(f.journeySuccessMax);
    expect(journeySuccessChance(0, 3, f)).toBe(f.journeySuccessMin);
  });

  it('team power is the sum of member zonePower (the AI power ratio) and grows with members and levels', () => {
    const [a, b, c] = s.world.hunters as [Hunter, Hunter, Hunter];
    const pa = zonePower(config, a, zone, diff);
    expect(pa).toBeGreaterThan(0);
    expect(teamPower(config, [a], zone, diff)).toBeCloseTo(pa, 10);
    expect(teamPower(config, [a, b], zone, diff)).toBeGreaterThan(pa);
    expect(teamPower(config, [a, b, c], zone, diff)).toBeGreaterThan(teamPower(config, [a, b], zone, diff));
    // Same as the AI's zone ratio at the current difficulty.
    expect(zoneScores(config, s.world, a).find((z) => z.zone.id === zone.id)!.ratio).toBeCloseTo(pa, 10);
    const strong = JSON.parse(JSON.stringify(a)) as Hunter;
    gainExp({ world: s.world, config, events: { emit() {} } } as unknown as SystemContext, strong, 20_000);
    expect(strong.level).toBeGreaterThan(a.level);
    expect(zonePower(config, strong, zone, diff)).toBeGreaterThan(pa);
  });

  it('snapshots power and chance at departure', () => {
    const t = townSim(7);
    t.world.town.gold = 10_000;
    const team = t.world.hunters.slice(0, 3);
    const want = teamPower(config, team, zone, diff);
    const ev = send(t, { type: 'journey.start', journeyId: 'j.test', hunterIds: team.map((h) => h.id) });
    const started = ev.find((e) => e.type === 'journeyStarted') as Extract<SimEvent, { type: 'journeyStarted' }>;
    expect(started.teamPower).toBeCloseTo(want, 10);
    expect(started.successChance).toBeCloseTo(journeySuccessChance(want, 3, config.formula), 10);
    expect(t.world.journeys[0]).toMatchObject({ journeyId: 'j.test', teamPower: started.teamPower, successChance: started.successChance, cost: 100 });
  });
});

describe('journey lifecycle', () => {
  it('members leave the field: not in world.hunters, keep their slot, needs frozen, untouched by the sim', () => {
    const s = townSim();
    s.world.town.gold = 10_000;
    const team = ids(s, 3);
    const goldBefore = s.world.town.gold;
    send(s, { type: 'journey.start', journeyId: 'j.long', hunterIds: team });
    expect(s.world.town.gold).toBe(goldBefore - config.journeys.find((j) => j.id === 'j.long')!.cost);
    expect(s.world.hunters.map((h) => h.id)).not.toContain(team[0]);
    expect(s.world.hunters.length).toBe(config.formula.hunterSlots - 3);
    expect(townHunterCount(s.world)).toBe(config.formula.hunterSlots);
    const away = JSON.stringify(s.world.journeys[0]!.hunters);
    for (let i = 0; i < 3000; i++) s.step(); // 5 minutes: arrivals would have refilled free slots by now
    expect(townHunterCount(s.world)).toBe(config.formula.hunterSlots);
    expect(JSON.stringify(s.world.journeys[0]!.hunters)).toBe(away); // frozen: needs, position, AI, EXP
    for (const h of s.world.hunters) {
      if (h.ai.goal?.type === 'hunt') expect(team).not.toContain(h.id);
    }
    expect(s.world.monsters.some((m) => m.targetHunterId && team.includes(m.targetHunterId))).toBe(false);
    expect(journeyOfHunter(s.world, team[0]!)?.journeyId).toBe('j.long');
  });

  it('success: rewards to Town and members, team returns to the square and resumes AI', () => {
    const s = townSim();
    s.world.town.gold = 10_000;
    const team = ids(s, 3);
    const lv = s.world.hunters.slice(0, 3).map((h) => h.level);
    send(s, { type: 'journey.start', journeyId: 'j.test', hunterIds: team });
    s.world.journeys[0]!.successChance = 1; // force the outcome (the roll is rng.next() < chance)
    const gold = s.world.town.gold;
    const ore = s.world.town.storage['mat.ore'] ?? 0;
    const shop = s.world.town.shop.length;
    const ev = runUntilDone(s);
    const done = ev.find((e) => e.type === 'journeyCompleted') as Extract<SimEvent, { type: 'journeyCompleted' }>;
    expect(done).toMatchObject({ success: true, offline: false, hunterIds: team });
    const mul = config.index.difficulties.get(s.world.town.difficulty)!.rewardMul;
    expect(done.rewards.gold).toBe(Math.round(300 * mul));
    expect(done.rewards.exp).toBe(Math.round(500 * mul));
    expect(done.rewards.materials).toEqual({ 'mat.ore': 5 });
    expect(done.rewards.items).toHaveLength(1);
    expect(s.world.town.storage['mat.ore']).toBe(ore + 5);
    expect(s.world.town.shop.length).toBe(shop + 1);
    expect(s.world.town.shop.find((i) => i.uid === done.rewards.items[0]!.uid)).toMatchObject({ gearId: 'gear.w.iron', qualityId: 'q.rare' });
    // Town gold also moves through services/shop that tick; the journey part is exact in the stat.
    expect(s.world.stats.journeyGold).toBe(done.rewards.gold);
    expect(s.world.town.gold).toBeGreaterThanOrEqual(gold + done.rewards.gold - 1000);
    expect(s.world.stats).toMatchObject({ journeysStarted: 1, journeysSucceeded: 1, journeysFailed: 0 });
    expect(s.world.journeys).toEqual([]);
    const back = team.map((id) => s.world.hunters.find((h) => h.id === id)!);
    back.forEach((h, i) => expect(h.level).toBeGreaterThan(lv[i]!));
    for (const h of back) {
      expect(config.index.nodes.get(h.nodeId)?.zoneId).toBeUndefined();
      // (+1 %: the needs system already ran one tick of idle Town regen after the return)
      for (const n of ['satiety', 'mood', 'stamina'] as const) expect(h.needs[n]).toBeLessThanOrEqual(0.51 * needMax(config, h, n));
    }
    for (let i = 0; i < 50; i++) s.step();
    expect(back.some((h) => h.ai.goal !== null)).toBe(true);
  });

  it('failure: no gold/materials/items, a fraction of the EXP, members come back wounded', () => {
    const s = townSim();
    s.world.town.gold = 10_000;
    const team = ids(s, 2);
    send(s, { type: 'journey.start', journeyId: 'j.test', hunterIds: team });
    s.world.journeys[0]!.successChance = 0;
    const ore = s.world.town.storage['mat.ore'] ?? 0;
    const done = runUntilDone(s).find((e) => e.type === 'journeyCompleted') as Extract<SimEvent, { type: 'journeyCompleted' }>;
    const mul = config.index.difficulties.get(s.world.town.difficulty)!.rewardMul;
    expect(done.success).toBe(false);
    expect(done.rewards).toEqual({ gold: 0, exp: Math.round(500 * mul * 0.25), materials: {}, items: [] });
    expect(s.world.town.storage['mat.ore'] ?? 0).toBe(ore);
    expect(s.world.stats).toMatchObject({ journeysFailed: 1, journeysSucceeded: 0, journeyGold: 0 });
    for (const id of team) {
      const h = s.world.hunters.find((x) => x.id === id)!;
      expect(h.needs.hp).toBeLessThanOrEqual(0.31 * hunterStats(config, h).hp); // + one tick of Town regen
    }
  });

  it('a rare find is sold at the markdown floor when the shop is full', () => {
    const s = townSim();
    s.world.town.gold = 10_000;
    const cap = config.index.buildings.get(config.index.shop)!.capacity!;
    while (s.world.town.shop.length < cap) {
      s.world.town.shop.push({ uid: `gx${s.world.town.shop.length}`, gearId: 'gear.w.club', qualityId: 'q.common', enhance: 0, price: 1e9, listPrice: 1e9, listedAtMs: s.world.timeMs });
    }
    send(s, { type: 'journey.start', journeyId: 'j.test', hunterIds: ids(s, 1) });
    s.world.journeys[0]!.successChance = 1;
    const done = runUntilDone(s).find((e) => e.type === 'journeyCompleted') as Extract<SimEvent, { type: 'journeyCompleted' }>;
    const g = config.index.gear.get('gear.w.iron')!;
    const sold = Math.round(Math.round(g.basePrice * config.index.qualities.get('q.rare')!.priceMult) * config.formula.shopMarkdownFloor);
    expect(done.rewards.items).toEqual([{ gearId: 'gear.w.iron', qualityId: 'q.rare', soldFor: sold }]);
    expect(done.rewards.gold).toBe(Math.round(300 * config.index.difficulties.get(s.world.town.difficulty)!.rewardMul) + sold);
  });

  it('recall brings the team home now with no reward', () => {
    const s = townSim();
    const team = ids(s, 2);
    send(s, { type: 'journey.start', journeyId: 'j.long', hunterIds: team });
    const exp = s.world.journeys[0]!.hunters.map((h) => [h.level, h.exp]);
    const ev = send(s, { type: 'journey.recall', journeyUid: s.world.journeys[0]!.id });
    expect(ev.some((e) => e.type === 'journeyRecalled')).toBe(true);
    expect(s.world.journeys).toEqual([]);
    expect(team.map((id) => { const h = s.world.hunters.find((x) => x.id === id)!; return [h.level, h.exp]; })).toEqual(exp);
    expect(s.world.stats.journeysRecalled).toBe(1);
  });

  it('a member at max level returns and is auto-reincarnated in Town afterwards (not while away)', () => {
    const s = townSim();
    const h = s.world.hunters[0]!;
    gainExp({ world: s.world, config, events: { emit() {} } } as unknown as SystemContext, h, 1e9);
    expect(h.level).toBe(config.formula.maxLevel);
    h.nodeId = config.index.squareNode;
    h.insideBuildingId = null;
    s.world.town.autoReincarnate = true;
    // Same tick: the command removes it before progression runs, so it leaves at max level.
    send(s, { type: 'journey.start', journeyId: 'j.test', hunterIds: [h.id] });
    expect(s.world.journeys[0]?.hunters[0]?.reincarnation).toBe(0);
    for (let i = 0; i < 500; i++) s.step();
    expect(s.world.journeys[0]?.hunters[0]?.reincarnation ?? 0).toBe(0);
    runUntilDone(s);
    for (let i = 0; i < 20; i++) s.step();
    expect(s.world.hunters.find((x) => x.id === h.id)!.reincarnation).toBe(1);
  });

  it('is deterministic: same seed and commands give the same outcome and world', () => {
    const run = () => {
      const s = townSim(11);
      s.world.town.gold = 10_000;
      send(s, { type: 'journey.start', journeyId: 'j.test', hunterIds: ids(s, 3) });
      const ev = runUntilDone(s);
      for (let i = 0; i < 300; i++) s.step();
      return { world: JSON.stringify(s.world), done: JSON.stringify(ev.filter((e) => e.type === 'journeyCompleted')) };
    };
    const a = run();
    expect(run()).toEqual(a);
    expect(a.done).toContain('journeyCompleted');
  });
});

describe('journey save/load and offline', () => {
  function midJourney(seed = 5): Simulation {
    const s = townSim(seed);
    s.world.town.gold = 10_000;
    send(s, { type: 'journey.start', journeyId: 'j.long', hunterIds: ids(s, 3) });
    for (let i = 0; i < 600; i++) s.step();
    s.drainEvents();
    return s;
  }

  it('round-trips mid-journey and continues identically to an unsaved run', () => {
    const a = midJourney();
    a.world.journeys[0]!.remainingMs = 20_000; // keep the test short
    const b = new Simulation(config, createWorld(config, 1));
    b.setWorld(deserialize(serialize(a.world, T0), config).world);
    expect(JSON.stringify(b.world)).toBe(JSON.stringify(a.world));
    expect(b.world.journeys).toHaveLength(1);
    const ea = runUntilDone(a);
    const eb = runUntilDone(b);
    for (let i = 0; i < 200; i++) { a.step(); b.step(); }
    expect(JSON.stringify(b.world)).toBe(JSON.stringify(a.world));
    expect(JSON.stringify(eb)).toBe(JSON.stringify(ea));
  });

  /** What the client does on load (main.ts creditOffline). */
  function creditOffline(s: Simulation, savedAt: number, now: number, tracker: any = null) {
    const r = estimateOffline(config, s.world, tracker, savedAt, now);
    if (!r.skipped) applyOffline(config, s.world, r, tracker);
    r.journeys = s.runBetweenTicks((ctx) => advanceJourneys(ctx, offlineJourneyMs(savedAt, now), true));
    return r;
  }

  it('journeys advance by the wall-clock gap and resolve on load (even without rates / below offlineMinAwaySec)', () => {
    const a = midJourney();
    const text = serialize(a.world, T0);
    const left = a.world.journeys[0]!.remainingMs;

    // Short gap: counts down, nothing resolves.
    const b = new Simulation(config, createWorld(config, 1));
    b.setWorld(deserialize(text, config).world);
    const short = creditOffline(b, T0, T0 + 30_000);
    expect(short.skipped).toBe('tooShort');
    expect(short.journeys).toEqual([]);
    expect(b.world.journeys[0]!.remainingMs).toBe(left - 30_000);

    // Long gap: resolves on load with the sim RNG, team back in Town, event flagged offline.
    const c = new Simulation(config, createWorld(config, 1));
    c.setWorld(deserialize(text, config).world);
    const rngBefore = JSON.stringify(c.world.rng);
    const long = creditOffline(c, T0, T0 + left + 5_000);
    expect(long.skipped).toBe('noRates'); // no tracker: the journey still completes
    expect(long.journeys).toHaveLength(1);
    expect(c.world.journeys).toEqual([]);
    expect(townHunterCount(c.world)).toBe(c.world.hunters.length);
    expect(JSON.stringify(c.world.rng)).not.toBe(rngBefore); // the roll was drawn and written back
    expect(c.world.stats.journeysSucceeded + c.world.stats.journeysFailed).toBe(1);
    const ev = c.drainEvents().find((e) => e.type === 'journeyCompleted') as Extract<SimEvent, { type: 'journeyCompleted' }>;
    expect(ev.offline).toBe(true);
    expect(ev.success).toBe(long.journeys[0]!.success);

    // Deterministic: same save + same gap → same result, and the sim continues identically.
    const d = new Simulation(config, createWorld(config, 1));
    d.setWorld(deserialize(text, config).world);
    expect(JSON.stringify(creditOffline(d, T0, T0 + left + 5_000))).toBe(JSON.stringify(long));
    for (let i = 0; i < 300; i++) { c.step(); d.step(); }
    expect(JSON.stringify(d.world)).toBe(JSON.stringify(c.world));
  });

  it('unknown save time / clock going backwards do not advance journeys; no journeys leaves the RNG untouched', () => {
    expect(offlineJourneyMs(0, T0)).toBe(0);
    expect(offlineJourneyMs(T0, T0 - 1000)).toBe(0);
    expect(offlineJourneyMs(T0, T0 + 1234)).toBe(1234);
    const s = townSim();
    const rng = JSON.stringify(s.world.rng);
    expect(s.runBetweenTicks((ctx) => advanceJourneys(ctx, 10 * 3_600_000, true))).toEqual([]);
    expect(JSON.stringify(s.world.rng)).toBe(rng);
    expect(s.drainEvents()).toEqual([]);
  });

  it('a journey reward is not measured as a town gold rate (no 8 h extrapolation of a windfall)', () => {
    const s = townSim();
    send(s, { type: 'journey.start', journeyId: 'j.test', hunterIds: ids(s, 1) });
    s.world.journeys[0]!.successChance = 1;
    const before = takeSample(config, s.world, 0);
    const gold = s.world.town.gold;
    s.runBetweenTicks((ctx) => advanceJourneys(ctx, 1e9));
    expect(s.world.town.gold).toBeGreaterThan(gold);
    expect(takeSample(config, s.world, 0).townGold).toBe(before.townGold);
  });

  it('members away get no rate-based offline gains or needs refill', () => {
    const s = townSim();
    const tracker = { seed: s.world.seed, epoch: 0, samples: [] as any[] };
    // Fake a measured window where every hunter earned EXP/gold.
    const sample = (t: number, k: number) => ({
      timeMs: t, epoch: 0, townGold: 0, storage: {},
      hunters: s.world.hunters.map((h) => ({ id: h.id, reincarnation: h.reincarnation, level: 1, lifeExp: k * 100, gold: k * 10, kills: k })),
    });
    tracker.samples.push(sample(0, 0), sample(600_000, 1));
    const team = ids(s, 2);
    send(s, { type: 'journey.start', journeyId: 'j.long', hunterIds: team });
    const awayBefore = JSON.stringify(s.world.journeys[0]!.hunters);
    const r = estimateOffline(config, s.world, tracker, T0, T0 + 600_000);
    expect(r.hunters.map((g) => g.id)).not.toContain(team[0]);
    applyOffline(config, s.world, r, tracker);
    expect(JSON.stringify(s.world.journeys[0]!.hunters)).toBe(awayBefore);
  });
});

describe('migration to v9', () => {
  it('migrates a v7 save (no journeys) and keeps running', () => {
    const w = JSON.parse(JSON.stringify(createWorld(config, 4))) as Record<string, any>;
    delete w.journeys;
    for (const k of ['journeysStarted', 'journeysSucceeded', 'journeysFailed', 'journeysRecalled', 'journeyGold']) delete w.stats[k];
    w.schemaVersion = 7;
    const r = deserialize(JSON.stringify({ format: SAVE_FORMAT, schemaVersion: 7, configVersion: config.version, savedAt: 0, world: w }), config);
    expect(r.migratedFrom).toBe(7);
    expect(WORLD_SCHEMA_VERSION).toBe(9);
    expect(r.world.schemaVersion).toBe(9);
    expect(r.world.journeys).toEqual([]);
    expect(r.world.stats).toMatchObject({ journeysStarted: 0, journeysSucceeded: 0, journeysFailed: 0, journeysRecalled: 0, journeyGold: 0 });
    const s = new Simulation(config, r.world as World);
    for (let i = 0; i < config.formula.hunterSlots; i++) s.enqueue({ type: 'debug.spawnHunter' });
    s.step();
    expect(rejected(send(s, { type: 'journey.start', journeyId: 'j.test', hunterIds: ids(s, 2) }))).toBeUndefined();
    for (let i = 0; i < 900; i++) s.step();
    expect(s.world.stats.journeysSucceeded + s.world.stats.journeysFailed).toBe(1);
  });

  it('keeps an existing journeys array (idempotent, safe to reorder after the buildings migration)', () => {
    const s = townSim();
    send(s, { type: 'journey.start', journeyId: 'j.long', hunterIds: ids(s, 1) });
    const w = JSON.parse(JSON.stringify(s.world));
    w.schemaVersion = 7;
    const r = deserialize(JSON.stringify({ format: SAVE_FORMAT, schemaVersion: 7, configVersion: config.version, savedAt: 0, world: w }), config);
    expect(r.world.journeys).toHaveLength(1);
    expect(r.world.stats.journeysStarted).toBe(1);
  });
});

describe('journey config', () => {
  it('rejects bad rows and min > max chance', () => {
    expect(() => makeConfig((raw) => { raw.journey[0].zoneId = 'zone.nope'; })).toThrow(/journey\[0\]\.zoneId/);
    expect(() => makeConfig((raw) => { raw.journey[0].rare[0].chance = 2; })).toThrow(/journey\[0\]\.rare\[0\]\.chance/);
    expect(() => makeConfig((raw) => { raw.formula_params.journeySuccessMin = 0.9; raw.formula_params.journeySuccessMax = 0.5; })).toThrow(/journeySuccessMin/);
    expect(() => makeConfig((raw) => { delete raw.formula_params.journeyTeamMax; })).toThrow(/journeyTeamMax/);
  });
});
