import { shopCapacity } from '../src/core/systems/town';
import { hunterStats } from '../src/core/formulas';
import { createWorld, Simulation } from '../src/core/simulation';
import { bagCount } from '../src/core/world';
import { testConfig } from './helpers';

const config = testConfig();

function run(seed: number, minutes: number) {
  const s = new Simulation(config, createWorld(config, seed));
  for (let i = 0; i < config.formula.hunterSlots; i++) s.enqueue({ type: 'debug.spawnHunter' });
  const events: Record<string, number> = {};
  for (let t = 0; t < minutes * 600; t++) {
    s.step();
    for (const e of s.drainEvents()) events[e.type] = (events[e.type] ?? 0) + 1;
    // Invariants every tick.
    for (const h of s.world.hunters) {
      expect(bagCount(h)).toBeLessThanOrEqual(config.formula.bagCapacity);
      expect(h.gold).toBeGreaterThanOrEqual(0);
    }
    expect(s.world.town.gold).toBeGreaterThanOrEqual(0);
    const shopCap = shopCapacity(config, s.world); // at the shop's current level
    expect(s.world.town.shop.length).toBeLessThanOrEqual(shopCap);
  }
  return { s, events };
}

describe('M2 closed loop: hunt → sell → craft → buy (integration)', () => {
  it('materials flow from monsters to storage to shop to hunters', () => {
    const { s, events } = run(31, 60);
    const st = s.world.stats;
    expect(st.materialsSold).toBeGreaterThan(50);
    expect(st.crafted).toBeGreaterThan(5);
    expect(st.gearBought).toBeGreaterThan(5);
    expect(events.materialsSold).toBeGreaterThan(5);
    expect(events.gearBought).toBe(st.gearBought);
    // Most hunters end up wearing something, which raises effective stats above base.
    const geared = s.world.hunters.filter((h) => Object.keys(h.equipment).length > 0);
    expect(geared.length).toBeGreaterThanOrEqual(config.formula.hunterSlots / 2);
    for (const h of geared) {
      const eff = hunterStats(config, h);
      expect(eff.atk + eff.def + eff.hp).toBeGreaterThan(h.stats.atk + h.stats.def + h.stats.hp);
    }
  });

  it('stays deterministic with the economy running', () => {
    const a = run(8, 15).s, b = run(8, 15).s;
    expect(JSON.stringify(a.world)).toBe(JSON.stringify(b.world));
  });
});
