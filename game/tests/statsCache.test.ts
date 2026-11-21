import { hunterStats } from '../src/core/formulas';
import { rollHunter } from '../src/core/hunterFactory';
import { NavGraph } from '../src/core/pathfinding';
import { Rng } from '../src/core/rng';
import { createWorld, Simulation } from '../src/core/simulation';
import { cacheVerifyEnabled, setStatsCacheVerify } from '../src/core/statsCache';
import type { Hunter } from '../src/core/world';
import { testConfig } from './helpers';

const config = testConfig();
const nav = new NavGraph(config);

function hunter(): Hunter {
  const nodeId = config.index.zoneNodes.get('zone.meadow')![0]!;
  const n = nav.node(nodeId);
  return rollHunter(config, new Rng(5), 'h0', nodeId, { x: n.x, y: n.y }, 0);
}

/** Bypasses the memo by handing hunterStats a fresh copy of the hunter (a new object never hits the cache). */
function fresh(h: Hunter, steady = false) {
  return hunterStats(config, structuredClone(h), { steady });
}

describe('statsCache: memoised hunterStats (TECH_SPEC §10)', () => {
  it('returns the same frozen object while inputs are unchanged', () => {
    const h = hunter();
    const a = hunterStats(config, h);
    expect(hunterStats(config, h)).toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
    expect(() => { (a as { atk: number }).atk = 1; }).toThrow();
    expect(hunterStats(config, h, { steady: true })).not.toBe(a);
  });

  it('recomputes after every in-place input change', () => {
    const h = hunter();
    const gear = config.gear.find((g) => g.slot === 'weapon')!;
    const trait = config.traits.find((t) => t.stat === 'atkPct') ?? config.traits[0]!;
    const steps: [string, () => void][] = [
      ['base stat', () => { h.stats.atk += 3; }],
      ['level', () => { h.level += 1; }],
      ['job tier', () => { h.jobTier += 1; }],
      ['reincarnation', () => { h.reincarnation += 1; }],
      ['equip', () => { h.equipment.weapon = { uid: 'g1', gearId: gear.id, qualityId: config.qualities[0]!.id, enhance: 0 }; }],
      ['enhance', () => { h.equipment.weapon!.enhance += 1; }],
      ['quality', () => { h.equipment.weapon!.qualityId = config.qualities[config.qualities.length - 1]!.id; }],
      ['trait', () => { h.traits[trait.id] = (h.traits[trait.id] ?? 0) + 1; }],
      ['buff', () => { h.buffs.push({ sourceId: 'b', stat: 'atkPct', value: 20, remainingMs: 1000 }); }],
      ['buff value', () => { h.buffs[0]!.value = 30; }],
      ['mood', () => { h.needs.mood = 0; }],
      ['unequip', () => { delete h.equipment.weapon; }],
      // M5 (progressionStats.ts): job branch, growth properties, runes.
      ['job tier 3', () => { h.jobTier = 3; }],
      ['job branch', () => { h.jobId = config.index.jobsByClass.get(h.classId)!.filter((j) => j.tier === 3)[1]!.id; }],
      ['growth', () => { h.growth = { 'growth.atk': 2 }; }],
      ['growth level', () => { h.growth!['growth.atk'] = 3; }],
      ['growth hp', () => { h.growth!['growth.hp'] = 1; }],
      ['rune socket', () => { h.runes = [{ runeId: 'rune.might', grade: 1 }, null]; }],
      ['rune grade', () => { h.runes![0]!.grade = 4; }],
      ['rune second', () => { h.runes![1] = { runeId: 'rune.edge', grade: 2 }; }],
      ['rune type', () => { h.runes![0]!.runeId = 'rune.vigor'; }],
      ['rune out', () => { h.runes![0] = null; }],
    ];
    for (const [label, change] of steps) {
      hunterStats(config, h);
      hunterStats(config, h, { steady: true });
      change();
      expect(hunterStats(config, h), label).toEqual(fresh(h));
      expect(hunterStats(config, h, { steady: true }), label).toEqual(fresh(h, true));
    }
  });

  it('verify mode finds no stale hit over a 10-minute run', () => {
    const was = cacheVerifyEnabled();
    setStatsCacheVerify(true);
    try {
      const sim = new Simulation(config, createWorld(config, 11));
      for (let i = 0; i < config.formula.hunterSlots; i++) sim.enqueue({ type: 'debug.spawnHunter' });
      for (let t = 0; t < 6000; t++) sim.step();
      expect(sim.world.stats.kills).toBeGreaterThan(0);
    } finally {
      setStatsCacheVerify(was);
    }
  });
});
