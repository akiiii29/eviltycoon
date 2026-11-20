import { loadConfig } from '../src/core/config/load';
import type { GameConfig } from '../src/core/config/types';
import { hunterStats } from '../src/core/formulas';
import { createWorld, Simulation } from '../src/core/simulation';
import { isDifficultyUnlockable, progressionSystem } from '../src/core/systems/progression';
import { spawnSystem } from '../src/core/systems/spawn';
import type { Hunter } from '../src/core/world';
import { readRawConfig } from './helpers';

const MAX_LEVEL = 5;

/** Cloned config with a tiny level cap: job tier 1 at level 3, tier 2 at level 5. */
function smallConfig(): GameConfig {
  const raw = readRawConfig() as unknown as Record<string, unknown>;
  (raw.formula_params as Record<string, number>).maxLevel = MAX_LEVEL;
  for (const j of raw.job as { tier: number; unlockLevel: number }[]) {
    if (j.tier === 1) j.unlockLevel = 3;
    if (j.tier === 2) j.unlockLevel = 5;
  }
  return loadConfig(raw as never);
}

const config = smallConfig();

function makeSim(n: number, systems = [progressionSystem], seed = 7) {
  const s = new Simulation(config, createWorld(config, seed), systems);
  for (let i = 0; i < n; i++) s.enqueue({ type: 'debug.spawnHunter' });
  s.step();
  s.drainEvents();
  return s;
}

function eventsOf(s: Simulation, type: string) {
  return s.drainEvents().filter((e) => e.type === type);
}

function fieldNode(): string {
  return config.nodes.find((n) => n.zoneId)!.id;
}

describe('job change', () => {
  it('advances one tier at the unlock level and keeps the HP fraction', () => {
    const s = makeSim(1);
    const h = s.world.hunters[0]!;
    expect(h.jobTier).toBe(0);
    s.world.town.autoReincarnate = false;

    h.level = 2;
    s.step();
    expect(h.jobTier).toBe(0);

    h.level = 3;
    const oldMax = hunterStats(config, h).hp;
    h.needs.hp = oldMax * 0.5;
    s.step();
    expect(h.jobTier).toBe(1);
    const newMax = hunterStats(config, h).hp;
    expect(newMax).toBeGreaterThan(oldMax);
    expect(h.needs.hp / newMax).toBeCloseTo(0.5, 6);
    expect(s.world.stats.jobChanges).toBe(1);
    const ev = eventsOf(s, 'jobChanged');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ hunterId: h.id, tier: 1 });

    // Not yet at tier 2 unlock; stays at tier 1.
    s.step();
    expect(h.jobTier).toBe(1);

    // Max tier: one tier per tick, then stops.
    h.level = MAX_LEVEL;
    s.step();
    expect(h.jobTier).toBe(2);
    s.step();
    expect(h.jobTier).toBe(2);
    expect(s.world.stats.jobChanges).toBe(2);
  });
});

function maxOut(h: Hunter) {
  h.level = MAX_LEVEL;
  h.jobTier = 2;
  h.exp = 0;
  h.stats.hp += 50;
  h.stats.atk += 10;
  h.stats.def += 5;
}

describe('reincarnation', () => {
  it('resets level/job/stats to roll, keeps gear/skills/traits, adds trait points and raises effective stats', () => {
    const s = makeSim(1);
    const h = s.world.hunters[0]!;
    s.world.town.autoReincarnate = false;
    const gear = config.gear[0]!;
    h.equipment[gear.slot] = { uid: 'g1', gearId: gear.id, qualityId: config.qualities[0]!.id, enhance: 2 };
    h.skills = { 'skill.x': 3 };
    h.traits = { [config.traits[0]!.id]: 2 };
    h.buffs = [{ sourceId: 'b', stat: 'atkPct', value: 10, remainingMs: 5000 }];
    const tp = h.traitPoints;
    maxOut(h);
    h.needs.hp = 1;

    // Compare against a level-1, tier-0, 0-reincarnation version with the same gear/traits.
    const before = hunterStats(config, { ...h, level: 1, jobTier: 0, stats: { ...h.rollStats }, buffs: [] });

    s.enqueue({ type: 'hunter.reincarnate', hunterId: h.id });
    s.step();
    expect(eventsOf(s, 'reincarnated')).toEqual([expect.objectContaining({ hunterId: h.id, count: 1 })]);
    expect(h.reincarnation).toBe(1);
    expect(h.level).toBe(1);
    expect(h.exp).toBe(0);
    expect(h.jobTier).toBe(0);
    expect(h.stats).toEqual(h.rollStats);
    expect(h.stats).not.toBe(h.rollStats);
    expect(h.traitPoints).toBe(tp + config.formula.traitPointsPerReinc);
    expect(h.buffs).toEqual([]);
    expect(h.equipment[gear.slot]).toMatchObject({ uid: 'g1', enhance: 2 });
    expect(h.skills).toEqual({ 'skill.x': 3 });
    expect(h.traits).toEqual({ [config.traits[0]!.id]: 2 });
    const after = hunterStats(config, h);
    expect(h.needs.hp).toBeCloseTo(after.hp, 6);
    expect(after.hp).toBeGreaterThan(before.hp);
    expect(after.atk).toBeGreaterThan(before.atk);
    expect(s.world.stats.reincarnations).toBe(1);
  });

  it('is capped at maxReincarnation', () => {
    const s = makeSim(1);
    const h = s.world.hunters[0]!;
    s.world.town.autoReincarnate = false;
    const cap = config.formula.maxReincarnation;
    for (let i = 0; i < cap; i++) {
      maxOut(h);
      s.enqueue({ type: 'hunter.reincarnate', hunterId: h.id });
      s.step();
    }
    expect(h.reincarnation).toBe(cap);
    maxOut(h);
    s.drainEvents();
    s.enqueue({ type: 'hunter.reincarnate', hunterId: h.id });
    s.step();
    expect(h.reincarnation).toBe(cap);
    expect(h.level).toBe(MAX_LEVEL);
    expect(eventsOf(s, 'commandRejected')).toHaveLength(1);

    // Auto mode also respects the cap.
    s.world.town.autoReincarnate = true;
    s.step();
    expect(h.reincarnation).toBe(cap);
    expect(s.world.stats.reincarnations).toBe(cap);
  });

  it('manual command rejects dead, inside-building and below-max hunters', () => {
    const s = makeSim(1);
    const h = s.world.hunters[0]!;
    s.world.town.autoReincarnate = false;
    s.enqueue({ type: 'hunter.reincarnate', hunterId: h.id });
    s.step();
    expect(h.reincarnation).toBe(0);

    maxOut(h);
    h.deadMs = 1000;
    s.enqueue({ type: 'hunter.reincarnate', hunterId: h.id });
    s.step();
    expect(h.reincarnation).toBe(0);

    h.deadMs = 0;
    h.insideBuildingId = config.buildings[0]!.id;
    s.enqueue({ type: 'hunter.reincarnate', hunterId: h.id });
    s.step();
    expect(h.reincarnation).toBe(0);
    expect(eventsOf(s, 'commandRejected')).toHaveLength(3);

    h.insideBuildingId = null;
    s.enqueue({ type: 'hunter.reincarnate', hunterId: h.id });
    s.step();
    expect(h.reincarnation).toBe(1);
  });

  it('auto-reincarnates only when enabled, alive, outside buildings and in town', () => {
    const s = makeSim(1);
    const h = s.world.hunters[0]!;
    s.enqueue({ type: 'town.setAutoReincarnate', on: false });
    s.step();
    expect(s.world.town.autoReincarnate).toBe(false);
    maxOut(h);
    s.step();
    expect(h.reincarnation).toBe(0);

    s.enqueue({ type: 'town.setAutoReincarnate', on: true });
    const townNode = h.nodeId;
    h.nodeId = fieldNode();
    s.step();
    expect(h.reincarnation).toBe(0);

    h.nodeId = townNode;
    h.deadMs = 500;
    s.step();
    expect(h.reincarnation).toBe(0);

    h.deadMs = 0;
    h.insideBuildingId = config.buildings[0]!.id;
    s.step();
    expect(h.reincarnation).toBe(0);

    h.insideBuildingId = null;
    s.step();
    expect(h.reincarnation).toBe(1);
    expect(h.level).toBe(1);
  });
});

describe('difficulty unlock', () => {
  it('Normal unlocks exactly when 3 hunters have >= 1 reincarnation, and stays unlocked', () => {
    const s = makeSim(4);
    const hs = s.world.hunters;
    expect(s.world.town.unlockedDifficulties).toEqual(['diff.easy']);
    hs[0]!.reincarnation = 1;
    hs[1]!.reincarnation = 2;
    s.step();
    expect(isDifficultyUnlockable(config, s.world, 'diff.normal')).toBe(false);
    expect(s.world.town.unlockedDifficulties).toEqual(['diff.easy']);
    expect(eventsOf(s, 'difficultyUnlocked')).toHaveLength(0);

    hs[2]!.reincarnation = 1;
    s.step();
    expect(s.world.town.unlockedDifficulties).toEqual(['diff.easy', 'diff.normal']);
    expect(eventsOf(s, 'difficultyUnlocked')).toEqual([expect.objectContaining({ difficultyId: 'diff.normal' })]);

    // Hunters leave: remains unlocked, no duplicate.
    s.enqueue({ type: 'debug.removeHunter', hunterId: hs[0]!.id });
    s.step();
    expect(isDifficultyUnlockable(config, s.world, 'diff.normal')).toBe(false);
    expect(s.world.town.unlockedDifficulties).toEqual(['diff.easy', 'diff.normal']);
  });

  it('Torment I-III need 5 hunters at 5 reincarnations; lower tiers unlock in order', () => {
    const s = makeSim(6);
    const hs = s.world.hunters;
    for (let i = 0; i < 4; i++) hs[i]!.reincarnation = 5;
    s.step();
    // 4 hunters at 5: Normal (3/1), Hard (4/2) yes; Expert (5/3) no.
    expect(s.world.town.unlockedDifficulties).toEqual(['diff.easy', 'diff.normal', 'diff.hard']);
    expect(isDifficultyUnlockable(config, s.world, 'diff.torment1')).toBe(false);

    hs[4]!.reincarnation = 5;
    s.step();
    // 5 hunters at 5: Expert, Torment I-III; Nightmare needs 6 at 4.
    expect(s.world.town.unlockedDifficulties).toEqual([
      'diff.easy', 'diff.normal', 'diff.hard', 'diff.expert', 'diff.torment1', 'diff.torment2', 'diff.torment3',
    ]);

    hs[5]!.reincarnation = 4;
    s.step();
    expect(s.world.town.unlockedDifficulties).toContain('diff.nightmare');
    expect(s.world.town.unlockedDifficulties).toHaveLength(8);
  });
});

describe('town.setDifficulty', () => {
  it('rejects locked difficulties; new spawns use the new difficulty, existing monsters keep theirs', () => {
    const s = makeSim(3, [progressionSystem, spawnSystem]);
    expect(s.world.monsters.length).toBeGreaterThan(0);
    expect(s.world.monsters.every((m) => m.difficultyId === 'diff.easy')).toBe(true);

    s.enqueue({ type: 'town.setDifficulty', difficultyId: 'diff.normal' });
    s.step();
    expect(s.world.town.difficulty).toBe('diff.easy');
    expect(eventsOf(s, 'commandRejected')).toEqual([expect.objectContaining({ command: 'town.setDifficulty' })]);

    for (const h of s.world.hunters) h.reincarnation = 1;
    s.step();
    expect(s.world.town.unlockedDifficulties).toContain('diff.normal');
    s.drainEvents();

    s.enqueue({ type: 'town.setDifficulty', difficultyId: 'diff.normal' });
    s.step();
    expect(s.world.town.difficulty).toBe('diff.normal');
    expect(eventsOf(s, 'difficultyChanged')).toEqual([expect.objectContaining({ difficultyId: 'diff.normal' })]);

    const old = new Set(s.world.monsters.map((m) => m.id));
    expect(s.world.monsters.every((m) => m.difficultyId === 'diff.easy')).toBe(true);
    // Kill a zone's worth of monsters so respawns happen.
    const zoneId = s.world.monsters[0]!.zoneId;
    s.world.monsters = s.world.monsters.filter((m) => m.zoneId !== zoneId);
    for (let t = 0; t < 5000 && !s.world.monsters.some((m) => !old.has(m.id)); t++) s.step();
    const fresh = s.world.monsters.filter((m) => !old.has(m.id));
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((m) => m.difficultyId === 'diff.normal')).toBe(true);
    expect(s.world.monsters.filter((m) => old.has(m.id)).every((m) => m.difficultyId === 'diff.easy')).toBe(true);

    s.enqueue({ type: 'town.setDifficulty', difficultyId: 'diff.nope' });
    s.step();
    expect(s.world.town.difficulty).toBe('diff.normal');
  });
});
