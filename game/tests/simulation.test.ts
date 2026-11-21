import { tierFromPoints } from '../src/core/hunterFactory';
import { createWorld, Simulation, TICK_MS } from '../src/core/simulation';
import { arrivalsSystem } from '../src/core/systems/arrivals';
import { needsSystem } from '../src/core/systems/needs';
import { testConfig } from './helpers';

const config = testConfig();
const snapshot = (s: Simulation) => JSON.stringify(s.world);

describe('Simulation', () => {
  it('advance() runs fixed ticks and carries the remainder', () => {
    const s = new Simulation(config, createWorld(config, 1));
    expect(s.advance(250).ticks).toBe(2);
    expect(s.advance(50).ticks).toBe(1); // 50 left over + 50
    expect(s.world.tick).toBe(3);
    expect(s.world.timeMs).toBe(3 * TICK_MS);
  });

  it('speed scales ticks; pause stops them', () => {
    const s = new Simulation(config, createWorld(config, 1));
    s.speed = 4;
    expect(s.advance(1000).ticks).toBe(40);
    s.paused = true;
    expect(s.advance(1000).ticks).toBe(0);
  });

  it('is deterministic: same seed + same commands → identical world', () => {
    const run = () => {
      const s = new Simulation(config, createWorld(config, 1234));
      for (let i = 0; i < 3000; i++) {
        if (i === 10) s.enqueue({ type: 'debug.spawnHunter' });
        s.step();
      }
      return snapshot(s);
    };
    expect(run()).toBe(run());
  });

  it('different seeds diverge', () => {
    const a = new Simulation(config, createWorld(config, 1));
    const b = new Simulation(config, createWorld(config, 2));
    for (let i = 0; i < 300; i++) { a.step(); b.step(); }
    expect(snapshot(a)).not.toBe(snapshot(b));
  });

  it('hunters arrive on the configured interval until slots are full', () => {
    const s = new Simulation(config, createWorld(config, 5));
    const perArrival = (config.formula.arrivalIntervalSec * 1000) / TICK_MS;
    for (let i = 0; i < perArrival; i++) s.step();
    expect(s.world.hunters.length).toBe(1);
    for (let i = 0; i < perArrival * (config.formula.hunterSlots + 5); i++) s.step();
    expect(s.world.hunters.length).toBe(config.formula.hunterSlots);
    expect(s.drainEvents().filter((e) => e.type === 'hunterArrived').length).toBe(config.formula.hunterSlots);
  });

  it('rolled hunters respect class stat ranges and have valid personalities', () => {
    const s = new Simulation(config, createWorld(config, 99));
    for (let i = 0; i < config.formula.hunterSlots; i++) s.enqueue({ type: 'debug.spawnHunter' });
    s.step();
    for (const h of s.world.hunters) {
      const cls = config.index.classes.get(h.classId)!;
      const gi = { normal: 0, high: 1, highest: 2 }[h.statGrades.hp];
      const [min, max] = cls.statRanges.hp[gi]!;
      expect(h.stats.hp).toBeGreaterThanOrEqual(min);
      expect(h.stats.hp).toBeLessThanOrEqual(max);
      expect(new Set(h.personalities).size).toBe(config.formula.personalitiesPerHunter);
      for (const p of h.personalities) expect(config.index.personalities.has(p)).toBe(true);
    }
  });

  it('needs decay over time, never below 0, and personality modifiers apply', () => {
    // Needs system only, hunter parked in the field so town idle regen does not apply.
    const s = new Simulation(config, createWorld(config, 3), [arrivalsSystem, needsSystem]);
    s.enqueue({ type: 'debug.spawnHunter' });
    s.step();
    const h = s.world.hunters[0]!;
    h.nodeId = 'z1.a';
    h.ai.goal = { type: 'hunt', zoneId: 'zone.meadow' };
    h.personalities = ['pers.sleepy', 'pers.plain']; // stamina decays ×1.3
    const before = h.needs.stamina;
    for (let i = 0; i < 10; i++) s.step(); // 1 game second
    expect(before - h.needs.stamina).toBeCloseTo(config.formula.staminaDecayPerSec * 1.3, 6);
    for (let i = 0; i < 20000; i++) s.step();
    expect(h.needs.stamina).toBe(0);
  });

  it('rejects invalid commands with an event instead of throwing', () => {
    const s = new Simulation(config, createWorld(config, 3));
    s.enqueue({ type: 'debug.restoreNeeds', hunterId: 'nope' });
    s.step();
    expect(s.drainEvents()).toContainEqual(expect.objectContaining({ type: 'commandRejected', reason: 'unknown hunter' }));
  });

  it('tier thresholds follow hunter_tier (GDD §4.2, scaled to 5 graded stats: 0/3/5/7/8 of 10 points)', () => {
    const config = testConfig();
    expect([0, 2, 3, 4, 5, 6, 7, 8, 10].map((p) => tierFromPoints(config, p))).toEqual(
      ['normal', 'normal', 'rare', 'rare', 'superior', 'superior', 'heroic', 'legendary', 'legendary']);
  });
});
