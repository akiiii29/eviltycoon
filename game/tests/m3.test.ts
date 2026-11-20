import { loadConfig } from '../src/core/config/load';
import { hunterStats } from '../src/core/formulas';
import { createWorld, Simulation } from '../src/core/simulation';
import { readRawConfig } from './helpers';

/**
 * M3 "done when": Normal unlocks per GDD §8 (≥3 hunters reincarnated at least once).
 * Uses a fast-progress config (low max level, cheap EXP) so the whole loop fits in a test.
 */
function fastConfig() {
  const raw = JSON.parse(JSON.stringify(readRawConfig())) as Record<string, any>;
  raw.formula_params.maxLevel = 8;
  raw.formula_params.expBase = 4;
  for (const j of raw.job) if (j.tier > 0) j.unlockLevel = j.tier === 1 ? 4 : 7;
  return loadConfig(raw as any);
}

describe('M3 progression loop (integration)', () => {
  it('hunters level, change job, reincarnate, and Normal unlocks per GDD §8', () => {
    const config = fastConfig();
    const s = new Simulation(config, createWorld(config, 41));
    for (let i = 0; i < config.formula.hunterSlots; i++) s.enqueue({ type: 'debug.spawnHunter' });
    const seen = new Set<string>();
    let unlockedAt = -1;
    for (let t = 0; t < 180 * 600 && unlockedAt < 0; t++) {
      s.step();
      for (const e of s.drainEvents()) {
        seen.add(e.type);
        if (e.type === 'difficultyUnlocked' && e.difficultyId === 'diff.normal') unlockedAt = t;
      }
    }
    expect(seen.has('jobChanged')).toBe(true);
    expect(seen.has('reincarnated')).toBe(true);
    expect(seen.has('skillCast') || seen.has('learned')).toBe(true);
    expect(unlockedAt).toBeGreaterThan(0);
    const reinc = s.world.hunters.filter((h) => h.reincarnation >= 1).length;
    expect(reinc).toBeGreaterThanOrEqual(3);
    expect(s.world.town.unlockedDifficulties).toContain('diff.normal');
    expect(s.world.town.unlockedDifficulties).not.toContain('diff.hard');

    // Switching to Normal makes new monsters stronger.
    s.enqueue({ type: 'town.setDifficulty', difficultyId: 'diff.normal' });
    s.world.monsters = [];
    s.world.zones = {};
    s.step();
    const m = s.world.monsters[0]!;
    expect(m.difficultyId).toBe('diff.normal');
    expect(m.hp).toBeGreaterThan(config.index.monsters.get(m.defId)!.hp);

    // Reincarnated hunters are stronger at level 1 than a fresh roll would be.
    const r = s.world.hunters.find((h) => h.reincarnation >= 1 && h.level === 1);
    if (r) expect(hunterStats(config, r).hp).toBeGreaterThan(r.rollStats.hp);
  }, 120_000);

  it('Normal does not unlock with only 2 reincarnated hunters', () => {
    const config = fastConfig();
    const s = new Simulation(config, createWorld(config, 2));
    for (let i = 0; i < 3; i++) s.enqueue({ type: 'debug.spawnHunter' });
    s.step();
    s.world.hunters[0]!.reincarnation = 1;
    s.world.hunters[1]!.reincarnation = 1;
    s.step();
    expect(s.world.town.unlockedDifficulties).not.toContain('diff.normal');
    s.world.hunters[2]!.reincarnation = 1;
    s.step();
    expect(s.world.town.unlockedDifficulties).toContain('diff.normal');
  });
});
