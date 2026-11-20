/**
 * Town treasury balance (TECH_SPEC §5.7, trading.townFeeShare), live config, one seed, 6 game hours (~15 s).
 * Before the treasury rule town gold grew without bound once the post exported every unrequested unit
 * (seed 1, rule off: 1.3–3.3 × townGoldTarget over 3–6 h and rising; on: 0.5–1.6 ×); with it the town settles
 * in a band around the target while auto-craft keeps running.
 */
import { describe, expect, it } from 'vitest';
import { createWorld, Simulation } from '../src/core/simulation';
import { townGoldTarget } from '../src/core/systems/trading';
import { testConfig } from './helpers';

const config = testConfig();

describe('town treasury: gold settles near the target (integration, live config)', () => {
  it('from 3 h to 6 h town gold stays within 0.1–2.5 × townGoldTarget and crafting continues', () => {
    const s = new Simulation(config, createWorld(config, 1));
    for (let i = 0; i < config.formula.hunterSlots; i++) s.enqueue({ type: 'debug.spawnHunter' });
    const ratios: number[] = [];
    let crafted3h = 0;
    for (let t = 1; t <= 360 * 600; t++) {
      s.step();
      s.drainEvents();
      if (t === 180 * 600) crafted3h = s.world.stats.crafted;
      if (t >= 180 * 600 && t % (10 * 600) === 0) ratios.push(s.world.town.gold / townGoldTarget(config, s.world));
    }
    expect(Math.max(...ratios)).toBeLessThan(2.5);
    expect(Math.min(...ratios)).toBeGreaterThan(0.1);
    expect(s.world.stats.crafted - crafted3h).toBeGreaterThan(20);
    expect(s.world.town.shop.length).toBeGreaterThanOrEqual(3);
  }, 120_000);
});
