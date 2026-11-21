/**
 * Offline progress (TECH_SPEC §9), EHT rules: no hunting while the game is closed; only wall-clock timers advance —
 * journeys, the Reincarnation Portal (tests/portal.test.ts), constructions/upgrades and hunter arrivals.
 */
import { describe, expect, it } from 'vitest';
import { advanceOfflineWallClock, offlineHasNews, offlineWallClockMs } from '../src/core/offline';
import { deserialize, SAVE_FORMAT, serialize } from '../src/core/save/save';
import { createWorld, Simulation } from '../src/core/simulation';
import type { World } from '../src/core/world';
import { testConfig } from './helpers';

const config = testConfig();
const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;
const sec = 1000;

const clone = (w: World): World => JSON.parse(JSON.stringify(w)) as World;

/** A seeded game with every slot filled, played for a few minutes. */
const base = (() => {
  const s = new Simulation(config, createWorld(config, 1));
  for (let i = 0; i < config.formula.hunterSlots; i++) s.enqueue({ type: 'debug.spawnHunter' });
  for (let i = 0; i < 5 * 600; i++) s.step();
  s.drainEvents();
  return s.world;
})();

describe('offline gap', () => {
  it('is the raw wall-clock gap; unknown save time and clocks going backwards give 0', () => {
    expect(offlineWallClockMs(0, T0)).toBe(0);
    expect(offlineWallClockMs(Number.NaN, T0)).toBe(0);
    expect(offlineWallClockMs(T0, T0 - 1000)).toBe(0);
    expect(offlineWallClockMs(T0, T0 + 1234)).toBe(1234);
    expect(offlineWallClockMs(T0, T0 + 30 * HOUR)).toBe(30 * HOUR); // no cap
  });
});

describe('no hunting offline (EHT)', () => {
  it('a long gap credits no EXP, gold, kills, materials or needs, and does not move game time', () => {
    const w = clone(base);
    for (const b of w.town.buildings) b.upgrade = null;
    w.journeys = [];
    const sim = new Simulation(config, w);
    const hunters = JSON.stringify(w.hunters);
    const { gold, storage } = w.town;
    const st = JSON.stringify(w.stats);
    const [tick, timeMs] = [w.tick, w.timeMs];
    const r = sim.runBetweenTicks((ctx) => advanceOfflineWallClock(ctx, 8 * HOUR));
    // Town is full: visitors only join the waiting queue (v14, no RNG drawn), which is not news on its own.
    const queued = config.formula.queueMax - base.town.queue.length; // 8 h is far more than queueMax × queueArrivalIntervalSec
    expect(r).toEqual({ awayMs: 8 * HOUR, journeys: [], reincarnations: [], buildings: [], arrivals: [], queued });
    expect(sim.world.town.queue).toHaveLength(config.formula.queueMax);
    expect(offlineHasNews(r)).toBe(false);
    expect(JSON.stringify(sim.world.hunters)).toBe(hunters);
    expect(sim.world.town.gold).toBe(gold);
    expect(sim.world.town.storage).toEqual(storage);
    expect(JSON.stringify({ ...sim.world.stats, queueJoined: 0 })).toBe(JSON.stringify({ ...JSON.parse(st), queueJoined: 0 }));
    expect([sim.world.tick, sim.world.timeMs]).toEqual([tick, timeMs]);
  });

  it('a zero / unknown gap is a no-op on the world', () => {
    const sim = new Simulation(config, clone(base));
    const before = JSON.stringify(sim.world);
    sim.runBetweenTicks((ctx) => advanceOfflineWallClock(ctx, offlineWallClockMs(0, T0)));
    sim.runBetweenTicks((ctx) => advanceOfflineWallClock(ctx, offlineWallClockMs(T0, T0 - HOUR)));
    expect(JSON.stringify(sim.world)).toBe(before);
  });
});

describe('offline wall-clock timers (constructions, arrivals)', () => {
  function withUpgrade(remainingMs: number) {
    const w = clone(base);
    for (const b of w.town.buildings) b.upgrade = null;
    const s = w.town.buildings.find((b) => b.level >= 1)!;
    s.upgrade = { toLevel: s.level + 1, remainingMs, totalMs: remainingMs, gold: 0, materials: {}, importGold: 0, importedUnits: 0, auto: false };
    return { sim: new Simulation(config, w), s };
  }

  it('finishes constructions/upgrades whose time ran out during the gap (wall clock, not capped)', () => {
    const { sim, s } = withUpgrade(10 * HOUR);
    const level = s.level;
    const ups = sim.world.stats.buildingUpgrades ?? 0;
    const res = sim.runBetweenTicks((ctx) => advanceOfflineWallClock(ctx, offlineWallClockMs(T0, T0 + 11 * HOUR)));
    const b = sim.world.town.buildings.find((x) => x.id === s.id)!;
    expect(b.level).toBe(level + 1);
    expect(b.upgrade).toBeNull();
    expect(res.buildings).toEqual([{ instanceId: s.id, buildingId: s.buildingId, level: level + 1 }]);
    expect(offlineHasNews(res)).toBe(true);
    expect(sim.world.stats.buildingUpgrades).toBe(ups + 1);
    expect(sim.drainEvents().some((e) => e.type === 'buildingCompleted' && e.instanceId === s.id)).toBe(true);
  });

  it('a shorter gap only counts the timer down', () => {
    const { sim, s } = withUpgrade(60 * sec);
    expect(sim.runBetweenTicks((ctx) => advanceOfflineWallClock(ctx, 20 * sec)).buildings).toEqual([]);
    expect(sim.world.town.buildings.find((x) => x.id === s.id)!.upgrade!.remainingMs).toBe(40 * sec);
  });

  it('new hunters arrive while Town slots are free (one per arrivalIntervalSec, up to the free slots)', () => {
    const interval = config.formula.arrivalIntervalSec * sec;
    const slots = config.formula.hunterSlots;
    const make = () => {
      const w = clone(base);
      w.hunters = w.hunters.slice(0, slots - 3);
      w.town.arrivalTimerMs = 0;
      w.town.queue = []; // v14: queued hunters would take the free slots first (tests/hunters-m5.test.ts)
      return new Simulation(config, w);
    };
    const a = make();
    const ra = a.runBetweenTicks((ctx) => advanceOfflineWallClock(ctx, 2 * interval + interval / 2));
    expect(ra.arrivals).toHaveLength(2);
    expect(a.world.hunters).toHaveLength(slots - 1);
    expect(a.world.town.arrivalTimerMs).toBe(interval / 2);
    for (const id of ra.arrivals) expect(a.world.hunters.find((h) => h.id === id)!.nodeId).toBe(config.index.squareNode);
    const b = make();
    expect(b.runBetweenTicks((ctx) => advanceOfflineWallClock(ctx, 5 * HOUR)).arrivals).toHaveLength(3);
    expect(b.world.hunters).toHaveLength(slots);
    expect(b.world.town.arrivalTimerMs).toBe(0);
    // Full town: nobody arrives, the RNG is untouched.
    const c = new Simulation(config, clone(base));
    const rng = JSON.stringify(c.world.rng);
    expect(c.runBetweenTicks((ctx) => advanceOfflineWallClock(ctx, 5 * HOUR)).arrivals).toEqual([]);
    expect(JSON.stringify(c.world.rng)).toBe(rng);
  });
});

describe('save envelope (old offline samples)', () => {
  it('no longer writes rate samples', () => {
    expect(JSON.parse(serialize(base, T0))).not.toHaveProperty('offline');
  });

  it('old saves carrying `offline` rate samples (valid or junk) still load; the field is ignored', () => {
    const file = JSON.parse(serialize(base, T0));
    const samples = {
      seed: base.seed, epoch: 0,
      samples: [{ timeMs: 0, epoch: 0, townGold: 1, storage: {}, hunters: [{ id: base.hunters[0]!.id, reincarnation: 0, level: 1, lifeExp: 0, gold: 0, kills: 0 }] }],
    };
    for (const offline of [samples, 42, { junk: true }, null]) {
      const r = deserialize(JSON.stringify({ ...file, offline }), config);
      expect(r.savedAt).toBe(T0);
      expect(JSON.stringify(r.world)).toBe(JSON.stringify(base));
      expect(r).not.toHaveProperty('offline');
    }
    // An old-schema save with samples: migrates and loads the same way.
    const v9 = { ...JSON.parse(JSON.stringify(base)), schemaVersion: 9 } as Record<string, unknown>;
    delete v9.portal;
    const r = deserialize(JSON.stringify({ format: SAVE_FORMAT, schemaVersion: 9, configVersion: config.version, savedAt: T0, world: v9, offline: samples }), config);
    expect(r.migratedFrom).toBe(9);
    expect(r.world.portal).toEqual([]);
  });
});
