import { loadConfig } from '../src/core/config/load';
import type { GameConfig } from '../src/core/config/types';
import { expToNext, needMax } from '../src/core/formulas';
import {
  applyOffline, estimateOffline, measureRates, newTracker, offlineGap, recordSample, type OfflineTracker,
} from '../src/core/offline';
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

  it('is deterministic, scales with time and never negative', () => {
    const w = base.sim.world;
    const r1 = estimateOffline(config, w, base.tracker, T0, T0 + HOUR);
    const r1b = estimateOffline(config, w, base.tracker, T0, T0 + HOUR);
    const r2 = estimateOffline(config, w, base.tracker, T0, T0 + 2 * HOUR);
    expect(r1b).toEqual(r1);
    expect(r1.skipped).toBeNull();
    expect(r1.hunters.length).toBeGreaterThan(0);
    expect(r2.kills).toBeGreaterThanOrEqual(2 * r1.kills - r1.hunters.length);
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
    const half = configWith({ offlineEfficiency: 0.5 });
    const w = base.sim.world;
    const full = estimateOffline(config, w, base.tracker, T0, T0 + 2 * HOUR);
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

  // Measured with tools-style runs (seeds 1-3, warm 30/60/150/240 min): kills -43..+26 %, worst while the sim is
  // accelerating (60-120 min: gear/zone upgrades double the kill rate). See TECH_SPEC §9.
  it('estimates kills and levels within loose bounds (seed 1, after 30 min of play)', () => {
    for (const seed of [1]) {
      const r = compare(seed, 30);
      expect(Math.abs(r.killErr)).toBeLessThan(0.5);
      expect(r.estLv).toBeGreaterThan(0);
      expect(Math.abs(r.estLv - r.actLv)).toBeLessThanOrEqual(Math.max(4, r.actLv));
    }
  }, 60_000);
});
