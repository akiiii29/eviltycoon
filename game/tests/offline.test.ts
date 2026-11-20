import { loadConfig } from '../src/core/config/load';
import type { GameConfig } from '../src/core/config/types';
import { expToNext, needMax } from '../src/core/formulas';
import {
  advanceOfflineWallClock, applyOffline, estimateOffline, measureRates, newTracker, offlineGap, offlineWallClockMs, recordSample,
  type OfflineTracker,
} from '../src/core/offline';
import { EventBuffer } from '../src/core/events';
import { gainExp } from '../src/core/progress';
import type { SystemContext } from '../src/core/system';
import { deserialize, serialize } from '../src/core/save/save';
import { createWorld, Simulation } from '../src/core/simulation';
import { materialDemand } from '../src/core/systems/trading';
import type { World } from '../src/core/world';
import { readRawConfig, testConfig } from './helpers';

const config = testConfig();
const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

function configWith(over: Record<string, number>): GameConfig {
  const raw = readRawConfig();
  Object.assign(raw.formula_params as Record<string, number>, over);
  return loadConfig(raw);
}
/** Flat-rate estimate (the pre-growth-model behaviour). */
const flat = configWith({ offlineGrowthModel: 0 });

/** Run a seeded game for `minutes`, sampling every tick like the client does every frame. */
function play(cfg: GameConfig, seed: number, minutes: number, sim?: Simulation, tracker?: OfflineTracker | null) {
  const s = sim ?? new Simulation(cfg, createWorld(cfg, seed));
  if (!sim) for (let i = 0; i < cfg.formula.hunterSlots; i++) s.enqueue({ type: 'debug.spawnHunter' });
  let t = tracker ?? null;
  for (let i = 0; i < minutes * 600; i++) {
    s.step();
    t = recordSample(cfg, s.world, t);
  }
  s.drainEvents();
  return { sim: s, tracker: t! };
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

// Shared 20-minute run for the unit tests (cheap: ~0.5 s).
const base = play(config, 5, 20);

describe('offline gap guards', () => {
  it('ignores unknown save time, clocks going backwards and short gaps', () => {
    expect(offlineGap(config, 0, T0).skipped).toBe('unknownSaveTime');
    expect(offlineGap(config, NaN, T0).skipped).toBe('unknownSaveTime');
    expect(offlineGap(config, T0, T0 - 5000)).toMatchObject({ skipped: 'clockBackwards', creditedMs: 0, awayMs: 0 });
    expect(offlineGap(config, T0, T0).skipped).toBe('tooShort');
    expect(offlineGap(config, T0, T0 + 10_000).skipped).toBe('tooShort');
  });

  it(`caps credited time at offlineMaxHours (${config.formula.offlineMaxHours} h)`, () => {
    const g = offlineGap(config, T0, T0 + 3 * HOUR);
    expect(g).toMatchObject({ skipped: null, creditedMs: 3 * HOUR, capped: false });
    const huge = offlineGap(config, T0, T0 + 365 * 24 * HOUR);
    expect(huge.creditedMs).toBe(config.formula.offlineMaxHours * HOUR);
    expect(huge.capped).toBe(true);
    // The estimate itself is capped: a year away earns exactly as much as offlineMaxHours away.
    const w = base.sim.world;
    const a = estimateOffline(config, w, base.tracker, T0, T0 + config.formula.offlineMaxHours * HOUR);
    const b = estimateOffline(config, w, base.tracker, T0, T0 + 365 * 24 * HOUR);
    expect({ ...b, awayMs: 0, capped: false }).toEqual({ ...a, awayMs: 0, capped: false });
  });

  it('zero / negative / unknown gaps are a no-op on the world', () => {
    for (const now of [T0, T0 - HOUR, T0 + 1000]) {
      const w = clone(base.sim.world);
      const before = JSON.stringify(w);
      const r = estimateOffline(config, w, clone(base.tracker), T0, now);
      expect(r.skipped).not.toBeNull();
      expect(r.hunters).toEqual([]);
      applyOffline(config, w, r, clone(base.tracker));
      expect(JSON.stringify(w)).toBe(before);
    }
  });
});

describe('offline estimate', () => {
  it('credits nothing without rates (new game / old save without samples)', () => {
    const w = clone(base.sim.world);
    const r = estimateOffline(config, w, null, T0, T0 + HOUR);
    expect(r.skipped).toBe('noRates');
    expect(estimateOffline(config, w, newTracker(w.seed), T0, T0 + HOUR).skipped).toBe('noRates');
    // Samples from another world (other seed) are ignored.
    expect(estimateOffline(config, w, { ...clone(base.tracker), seed: w.seed + 1 }, T0, T0 + HOUR).skipped).toBe('noRates');
  });

  it('flat model (offlineGrowthModel 0): linear in time', () => {
    const w = base.sim.world;
    const r1 = estimateOffline(flat, w, base.tracker, T0, T0 + HOUR);
    const r2 = estimateOffline(flat, w, base.tracker, T0, T0 + 2 * HOUR);
    expect(r1.hunters.length).toBeGreaterThan(0);
    expect(Math.abs(r2.kills - 2 * r1.kills)).toBeLessThanOrEqual(2 * r1.hunters.length);
    for (const g of r1.hunters) expect(g.reincarnations).toBe(0);
  });

  it('does not mutate the world or the tracker', () => {
    const w = clone(base.sim.world);
    const t = clone(base.tracker);
    const before = JSON.stringify(w);
    const tb = JSON.stringify(t);
    estimateOffline(config, w, t, T0, T0 + 8 * HOUR);
    expect(JSON.stringify(w)).toBe(before);
    expect(JSON.stringify(t)).toBe(tb);
  });

  it('growth model: hunters that out-level their zone move on, so 8 h earn more levels than the flat rate', () => {
    const w = base.sim.world;
    const g = estimateOffline(config, w, base.tracker, T0, T0 + 8 * HOUR);
    const l = estimateOffline(flat, w, base.tracker, T0, T0 + 8 * HOUR);
    const lv = (r: typeof g) => r.hunters.reduce((a, h) => a + h.levelAfter - h.levelBefore, 0);
    expect(lv(g)).toBeGreaterThan(lv(l));
  });

  it('is deterministic, grows with time and never negative', () => {
    const w = base.sim.world;
    const r1 = estimateOffline(config, w, base.tracker, T0, T0 + HOUR);
    const r1b = estimateOffline(config, w, base.tracker, T0, T0 + HOUR);
    const r2 = estimateOffline(config, w, base.tracker, T0, T0 + 2 * HOUR);
    expect(r1b).toEqual(r1);
    expect(r1.skipped).toBeNull();
    expect(r1.hunters.length).toBeGreaterThan(0);
    expect(r2.kills).toBeGreaterThan(r1.kills);
    for (const h of [...r1.hunters, ...r2.hunters]) {
      expect(h.gold).toBeGreaterThanOrEqual(0);
      expect(h.kills).toBeGreaterThanOrEqual(0);
      expect(h.exp).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(h.gold) && Number.isInteger(h.kills) && Number.isInteger(h.exp)).toBe(true);
      expect(h.levelAfter).toBeGreaterThanOrEqual(h.levelBefore);
      expect(h.levelAfter).toBeLessThanOrEqual(config.formula.maxLevel);
    }
    expect(r1.townGold).toBeGreaterThanOrEqual(0);
    // Materials never exceed what the Trading Post would buy right now.
    const demand = materialDemand(config, w);
    for (const [id, n] of Object.entries(r2.materials)) expect(n).toBeLessThanOrEqual(demand[id] ?? 0);
  });

  it('offlineEfficiency scales gains; 0 credits nothing', () => {
    // Efficiency scales the projected time; with flat rates that is exactly the gains.
    const half = configWith({ offlineEfficiency: 0.5, offlineGrowthModel: 0 });
    const w = base.sim.world;
    const full = estimateOffline(flat, w, base.tracker, T0, T0 + 2 * HOUR);
    const g = estimateOffline(configWith({ offlineEfficiency: 0.5 }), w, base.tracker, T0, T0 + 2 * HOUR);
    expect(g.kills).toBeLessThan(estimateOffline(config, w, base.tracker, T0, T0 + 2 * HOUR).kills);
    const r = estimateOffline(half, w, base.tracker, T0, T0 + 2 * HOUR);
    const k = full.hunters.reduce((a, h) => a + h.kills, 0);
    expect(Math.abs(r.kills - k / 2)).toBeLessThanOrEqual(full.hunters.length);
    expect(estimateOffline(configWith({ offlineEfficiency: 0 }), w, base.tracker, T0, T0 + 2 * HOUR).skipped).toBe('noRates');
  });

  it('negative measured gold rates are floored at 0 (nobody comes back poorer)', () => {
    const t = clone(base.tracker);
    const last = t.samples[t.samples.length - 1]!;
    last.townGold -= 1e9;
    for (const h of last.hunters) h.gold -= 1e9;
    const w = clone(base.sim.world);
    const r = estimateOffline(config, w, t, T0, T0 + HOUR);
    expect(r.townGold).toBe(0);
    for (const h of r.hunters) expect(h.gold).toBe(0);
    const gold = w.hunters.map((h) => h.gold);
    const town = w.town.gold;
    applyOffline(config, w, r, t);
    expect(w.town.gold).toBe(town);
    expect(w.hunters.map((h) => h.gold)).toEqual(gold);
  });

  it('ignores pairs across a reincarnation', () => {
    const t = clone(base.tracker);
    const id = t.samples[0]!.hunters[0]!.id;
    // Pretend the hunter reincarnated between every pair: no rate for it.
    t.samples.forEach((s, i) => { const h = s.hunters.find((x) => x.id === id); if (h) h.reincarnation = i; });
    expect(measureRates(t).hunters[id]).toBeUndefined();
  });
});

describe('offline apply', () => {
  it('applies gains without breaking invariants, and the sim keeps running', () => {
    const w = clone(base.sim.world);
    const t = clone(base.tracker);
    const before = clone(w);
    const r = estimateOffline(config, w, t, T0, T0 + 8 * HOUR);
    expect(r.skipped).toBeNull();
    const epoch = t.epoch;
    applyOffline(config, w, r, t);
    expect(t.epoch).toBe(epoch + 1);
    // Time, tick and RNG are not advanced.
    expect(w.timeMs).toBe(before.timeMs);
    expect(w.tick).toBe(before.tick);
    expect(w.rng).toEqual(before.rng);
    for (const g of r.hunters) {
      const h = w.hunters.find((x) => x.id === g.id)!;
      const h0 = before.hunters.find((x) => x.id === g.id)!;
      expect(h.level).toBe(g.levelAfter);
      expect(h.level).toBeLessThanOrEqual(config.formula.maxLevel);
      if (h.level < config.formula.maxLevel) expect(h.exp).toBeLessThan(expToNext(h.level, config.formula));
      expect(h.stats.hp - h0.stats.hp).toBe((h.level - h0.level) * config.formula.levelHpGain);
      expect(h.gold).toBe(h0.gold + g.gold);
      expect(h.kills).toBe(h0.kills + g.kills);
    }
    expect(w.stats.kills).toBe(before.stats.kills + r.kills);
    expect(w.town.gold).toBe(before.town.gold + r.townGold);
    for (const [id, n] of Object.entries(r.materials)) expect(w.town.storage[id]).toBe((before.town.storage[id] ?? 0) + n);
    for (const h of w.hunters) {
      if (h.deadMs > 0) continue;
      for (const n of ['hp', 'satiety', 'mood', 'stamina'] as const) expect(h.needs[n]).toBe(needMax(config, h, n));
    }
    // Keep running: no throw, everyone alive soon, invariants of the sim hold.
    const sim = new Simulation(config, w);
    for (let i = 0; i < 600; i++) sim.step();
    for (const h of sim.world.hunters) {
      expect(h.needs.hp).toBeLessThanOrEqual(needMax(config, h, 'hp') + 1e-9);
      expect(h.level).toBeLessThanOrEqual(config.formula.maxLevel);
    }
  });

  it('decrements player Trading Post requests like a sale', () => {
    const w = clone(base.sim.world);
    const t = clone(base.tracker);
    // Make one measured material flow and request it.
    const id = config.materials[0]!.id;
    w.town.requests = { [id]: 3 };
    t.samples[t.samples.length - 1]!.storage[id] = (t.samples[t.samples.length - 1]!.storage[id] ?? 0) + 100;
    const r = estimateOffline(config, w, t, T0, T0 + HOUR);
    expect(r.materials[id]).toBeGreaterThan(0);
    applyOffline(config, w, r, t);
    if (r.materials[id]! >= 3) expect(w.town.requests[id]).toBeUndefined();
    else expect(w.town.requests[id]).toBe(3 - r.materials[id]!);
  });

  it('a second load does not compound: the applied jump never enters the rate window', () => {
    const cfg = config;
    const run = play(cfg, 9, 15);
    const w = run.sim.world;
    const t = run.tracker;
    const rates0 = measureRates(t);
    const r = estimateOffline(cfg, w, t, T0, T0 + 4 * HOUR);
    applyOffline(cfg, w, r, t);
    // Save → load → play a bit → second offline: rates are unaffected by the jump.
    const text = serialize(w, T0 + 4 * HOUR, t);
    const loaded = deserialize(text, cfg);
    expect(loaded.offline?.epoch).toBe(t.epoch);
    const sim = new Simulation(cfg, loaded.world);
    let tr: OfflineTracker | null = loaded.offline;
    for (let i = 0; i < 600; i++) { sim.step(); tr = recordSample(cfg, sim.world, tr); }
    const rates1 = measureRates(tr);
    for (const id of Object.keys(rates0.hunters)) {
      const a = rates0.hunters[id]!.killsPerMs;
      const b = rates1.hunters[id]?.killsPerMs ?? 0;
      // A compounding bug would put hours of kills into one 30 s pair (rate × hundreds).
      expect(b).toBeLessThan(a * 5 + 1e-6);
    }
  });
});

describe('offline reincarnation (progression rules)', () => {
  /** Base world with the first rated hunter pushed to just below max level. */
  function nearMax(patch: (w: World) => void = () => {}) {
    const w = clone(base.sim.world);
    const t = clone(base.tracker);
    const id = Object.keys(measureRates(t).hunters)[0]!;
    const h = w.hunters.find((x) => x.id === id)!;
    const ctx = { world: w, config, events: new EventBuffer() } as unknown as SystemContext;
    while (h.level < config.formula.maxLevel - 1) gainExp(ctx, h, expToNext(h.level, config.formula));
    patch(w);
    return { w, t, h };
  }

  it('auto-reincarnates at max level and keeps levelling; apply replays the same path', () => {
    const { w, t, h } = nearMax();
    const reinc0 = h.reincarnation;
    const r = estimateOffline(config, w, t, T0, T0 + 8 * HOUR);
    const g = r.hunters.find((x) => x.id === h.id)!;
    expect(g.reincarnations).toBeGreaterThanOrEqual(1);
    expect(g.lives).toHaveLength(g.reincarnations + 1);
    expect(g.exp).toBe(g.lives.reduce((a, n) => a + n, 0));
    expect(g.lives[1]!).toBeGreaterThan(0);
    const stats0 = w.stats.reincarnations;
    applyOffline(config, w, r, t);
    expect(h.reincarnation).toBe(reinc0 + g.reincarnations);
    expect(h.level).toBe(g.levelAfter);
    expect(w.stats.reincarnations).toBe(stats0 + g.reincarnations);
    // Base stats = rolled stats + per-level gains of the new life (progression.reincarnate reset them).
    expect(h.stats.hp).toBe(h.rollStats.hp + (h.level - 1) * config.formula.levelHpGain);
    // Reincarnation happens in Town: on the square, fresh AI.
    expect(h.nodeId).toBe(config.index.squareNode);
    expect(h.insideBuildingId).toBeNull();
    // And the sim keeps running.
    const sim = new Simulation(config, w);
    for (let i = 0; i < 300; i++) sim.step();
    expect(sim.world.hunters.find((x) => x.id === h.id)!.reincarnation).toBe(reinc0 + g.reincarnations);
  });

  it('no reincarnation with auto-reincarnate off or at the cap: EXP at max level is lost', () => {
    for (const patch of [
      (w: World) => { w.town.autoReincarnate = false; },
      (w: World) => { for (const h of w.hunters) h.reincarnation = config.formula.maxReincarnation; },
    ]) {
      const { w, t, h } = nearMax(patch);
      const reinc0 = h.reincarnation;
      const r = estimateOffline(config, w, t, T0, T0 + 8 * HOUR);
      const g = r.hunters.find((x) => x.id === h.id)!;
      expect(g.reincarnations).toBe(0);
      expect(g.levelAfter).toBe(config.formula.maxLevel);
      applyOffline(config, w, r, t);
      expect(h.reincarnation).toBe(reinc0);
      expect(h.level).toBe(config.formula.maxLevel);
      expect(h.exp).toBe(0);
    }
  });
});

describe('offline wall-clock timers (constructions, arrivals)', () => {
  const sec = 1000;
  function withUpgrade(remainingMs: number) {
    const w = clone(base.sim.world);
    const s = w.town.buildings.find((b) => b.buildingId !== undefined && !b.upgrade && b.level >= 1)!;
    s.upgrade = { toLevel: s.level + 1, remainingMs, totalMs: remainingMs, gold: 0, materials: {}, importGold: 0, importedUnits: 0, auto: false };
    return { sim: new Simulation(config, w), s };
  }

  it('finishes constructions/upgrades whose time ran out during the gap (wall clock, not capped)', () => {
    const { sim, s } = withUpgrade(10 * HOUR); // longer than offlineMaxHours: still finishes
    const level = s.level;
    const ups = sim.world.stats.buildingUpgrades ?? 0;
    const res = sim.runBetweenTicks((ctx) => advanceOfflineWallClock(ctx, offlineWallClockMs(T0, T0 + 11 * HOUR)));
    const b = sim.world.town.buildings.find((x) => x.id === s.id)!;
    expect(b.level).toBe(level + 1);
    expect(b.upgrade).toBeNull();
    expect(res.buildings).toEqual([{ instanceId: s.id, buildingId: s.buildingId, level: level + 1 }]);
    expect(sim.world.stats.buildingUpgrades).toBe(ups + 1);
    expect(sim.drainEvents().some((e) => e.type === 'buildingCompleted' && e.instanceId === s.id)).toBe(true);
  });

  it('a shorter gap only counts the timer down; unknown save time does nothing', () => {
    const { sim, s } = withUpgrade(60 * sec);
    expect(sim.runBetweenTicks((ctx) => advanceOfflineWallClock(ctx, 20 * sec)).buildings).toEqual([]);
    expect(sim.world.town.buildings.find((x) => x.id === s.id)!.upgrade!.remainingMs).toBe(40 * sec);
    const before = JSON.stringify(sim.world);
    sim.runBetweenTicks((ctx) => advanceOfflineWallClock(ctx, offlineWallClockMs(0, T0)));
    expect(JSON.stringify(sim.world)).toBe(before);
  });

  it('new hunters arrive while Town slots are free (one per arrivalIntervalSec, up to the free slots)', () => {
    const interval = config.formula.arrivalIntervalSec * sec;
    const slots = config.formula.hunterSlots;
    const make = () => {
      const w = clone(base.sim.world);
      w.hunters = w.hunters.slice(0, slots - 3);
      w.town.arrivalTimerMs = 0;
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
    const c = new Simulation(config, clone(base.sim.world));
    const rng = JSON.stringify(c.world.rng);
    expect(c.runBetweenTicks((ctx) => advanceOfflineWallClock(ctx, 5 * HOUR)).arrivals).toEqual([]);
    expect(JSON.stringify(c.world.rng)).toBe(rng);
  });
});

describe('save envelope', () => {
  it('old saves without samples load with offline = null', () => {
    const w = createWorld(config, 3);
    const r = deserialize(serialize(w, T0), config);
    expect(r.offline).toBeNull();
    expect(estimateOffline(config, r.world, r.offline, r.savedAt, T0 + HOUR).skipped).toBe('noRates');
  });

  it('round-trips samples and rejects malformed ones', () => {
    const text = serialize(base.sim.world, T0, base.tracker);
    expect(deserialize(text, config).offline).toEqual(base.tracker);
    const bad = JSON.parse(text);
    bad.offline.samples[0].hunters[0].gold = 'x';
    expect(deserialize(JSON.stringify(bad), config).offline).toBeNull();
    bad.offline = 42;
    expect(deserialize(JSON.stringify(bad), config).offline).toBeNull();
  });
});

/**
 * Accuracy vs. the real sim: play `warm` minutes, estimate the next 60 minutes from rates, then actually run them.
 * Bounds are loose on purpose (economy/combat are still being tuned); the printed errors are the real report.
 */
describe('offline estimate vs. real fast-forward (60 min)', () => {
  const cfg = configWith({ offlineEfficiency: 1 });
  function compare(seed: number, warm: number) {
    const run = play(cfg, seed, warm);
    const w0 = clone(run.sim.world);
    const est = estimateOffline(cfg, w0, run.tracker, T0, T0 + HOUR);
    play(cfg, seed, 60, run.sim, run.tracker);
    const w1 = run.sim.world;
    const actKills = w1.stats.kills - w0.stats.kills;
    const lvl = (w: World) => w.hunters.filter((h) => w0.hunters.some((x) => x.id === h.id));
    const actLv = lvl(w1).reduce((a, h) => a + h.level, 0) - w0.hunters.reduce((a, h) => a + h.level, 0);
    const estLv = est.hunters.reduce((a, h) => a + h.levelAfter - h.levelBefore, 0);
    const lvErr = w0.hunters.map((h0) => {
      const e = est.hunters.find((x) => x.id === h0.id);
      const h1 = w1.hunters.find((x) => x.id === h0.id)!;
      return Math.abs((e ? e.levelAfter : h0.level) - h1.level);
    });
    const goldAct = (w1.town.gold + w1.hunters.reduce((a, h) => a + h.gold, 0)) - (w0.town.gold + w0.hunters.reduce((a, h) => a + h.gold, 0));
    const killErr = (est.kills - actKills) / actKills;
    console.log(
      `[offline accuracy] seed ${seed} warm ${warm}m: kills est ${est.kills} / real ${actKills} (${(killErr * 100).toFixed(1)}%), ` +
      `levels est +${estLv} / real +${actLv} (mean |err| ${(lvErr.reduce((a, b) => a + b, 0) / lvErr.length).toFixed(2)} lv/hunter), ` +
      `gold est +${est.gold} / real net ${goldAct >= 0 ? '+' : ''}${goldAct}`,
    );
    return { killErr, estLv, actLv };
  }

  // Full table: `npx vite-node tools/offline-accuracy.ts` (seeds 1-3, warm 30/60/150/240 min). Growth model: kills
  // -26..+28 %, levels -45..+18 %, worst right before the gear-gated zone jump at 60-120 min. See TECH_SPEC §9.
  it('estimates kills and levels within loose bounds (seed 1, after 30 min of play)', () => {
    for (const seed of [1]) {
      const r = compare(seed, 30);
      expect(Math.abs(r.killErr)).toBeLessThan(0.5);
      expect(r.estLv).toBeGreaterThan(0);
      expect(Math.abs(r.estLv - r.actLv)).toBeLessThanOrEqual(Math.max(4, r.actLv));
    }
  }, 60_000);
});
