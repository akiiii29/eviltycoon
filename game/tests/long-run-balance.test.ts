/**
 * Long-run balance after M5 (TECH_SPEC §5.4, §5.7, §5.8): Town Storage cap + overflow export, tier-aware enhance cost and
 * autoCraftReserve, and the auto-difficulty softlock regression.
 */
import { describe, expect, it } from 'vitest';
import type { FormulaParams, GameConfig } from '../src/core/config/types';
import { EventBuffer, type SimEvent } from '../src/core/events';
import { rollHunter } from '../src/core/hunterFactory';
import { NavGraph } from '../src/core/pathfinding';
import { Rng } from '../src/core/rng';
import { createWorld, Simulation } from '../src/core/simulation';
import type { SystemContext } from '../src/core/system';
import { expectedEnhanceCost } from '../src/core/ai/utility';
import { GEAR_SLOTS } from '../src/core/config/types';
import { autoCraftReserve, dismantleItem } from '../src/core/systems/crafting';
import { economySystem, enhanceCost } from '../src/core/systems/economy';
import { autoAdvanceDifficulty, autoStepDownDifficulty, bestZoneRatio, bootstrapRatio, starterKitFor } from '../src/core/systems/gearTier';
import { reincarnate } from '../src/core/systems/progression';
import { exportStorageOverflow, storageRoom, storageUnits, surplusPrice } from '../src/core/systems/trading';
import { storageCapacity } from '../src/core/systems/town';
import type { Hunter, World } from '../src/core/world';
import { testConfig } from './helpers';

const base = testConfig();
const nav = new NavGraph(base);

function cfg(patch: Partial<FormulaParams> = {}): GameConfig {
  return { ...base, formula: { ...base.formula, ...patch } as FormulaParams };
}

function makeCtx(config: GameConfig = cfg(), seed = 1): SystemContext & { events: EventBuffer } {
  return {
    world: createWorld(config, seed), config, nav, rng: new Rng(seed),
    events: new EventBuffer(), debug: { aiScores: new Map() }, dtMs: 100,
  };
}

function addHunter(ctx: SystemContext, patch: Partial<Hunter> = {}): Hunter {
  const h = rollHunter(ctx.config, new Rng(7), 'h' + ctx.world.hunters.length, base.index.squareNode, { x: 0, y: 0 }, 0);
  Object.assign(h, patch);
  ctx.world.hunters.push(h);
  return h;
}

const ofType = <T extends SimEvent['type']>(evs: SimEvent[], t: T) => evs.filter((e) => e.type === t) as Extract<SimEvent, { type: T }>[];

describe('Town Storage cap (TECH_SPEC §5.7)', () => {
  it('is storageCapBase plus the Storehouse storageCap at its level; 0 = no cap', () => {
    const ctx = makeCtx();
    const w = ctx.world;
    expect(storageCapacity(ctx.config, w)).toBe(base.formula.storageCapBase);
    const sh = base.buildings.find((b) => b.kind === 'storehouse')!;
    w.town.buildings.push({ id: 'plot.test', buildingId: sh.id, level: 2, upgrade: null });
    expect(storageCapacity(ctx.config, w)).toBe(base.formula.storageCapBase + sh.storageCap![1]!);
    expect(storageCapacity(cfg({ storageCapBase: 0 }), w)).toBe(Infinity);
  });

  it('exports only units no request needs, most spare first, for Town gold at surplusPrice', () => {
    const ctx = makeCtx(cfg({ storageCapBase: 20 }));
    const w = ctx.world;
    w.town.autoCraft = false; // no crafting need: everything not essential for supplies is spare
    w.town.autoInvest = false;
    w.town.storage = { 'mat.star': 30, 'mat.shade': 5 };
    const gold0 = w.town.gold;
    const n = exportStorageOverflow(ctx);
    expect(n).toBe(15);
    expect(storageUnits(w)).toBe(20);
    expect(w.town.storage['mat.star']).toBe(15); // star had the most spare units
    expect(w.town.storage['mat.shade']).toBe(5);
    const ev = ofType(ctx.events.drain(), 'storageExported')[0]!;
    expect(ev.units).toBe(15);
    expect(w.town.gold - gold0).toBe(15 * surplusPrice(ctx.config, 'mat.star', w));
    expect(w.stats.storageExported).toBe(15);
    // Under the cap: nothing happens.
    expect(exportStorageOverflow(ctx)).toBe(0);
  });

  it('never exports units a player request needs', () => {
    const ctx = makeCtx(cfg({ storageCapBase: 10 }));
    const w = ctx.world;
    w.town.autoCraft = false;
    w.town.autoInvest = false;
    w.town.storage = { 'mat.star': 30 };
    w.town.requests = { 'mat.star': 25 };
    expect(exportStorageOverflow(ctx)).toBe(5);
    expect(w.town.storage['mat.star']).toBe(25); // still over the cap, but every unit is needed
  });

  it('a storage at the cap full of spare units still takes requested materials (spare units are exported first)', () => {
    const ctx = makeCtx(cfg({ storageCapBase: 10, tradeSaleTax: 0 }));
    const w = ctx.world;
    w.town.autoCraft = false;
    w.town.autoInvest = false;
    w.town.storage = { 'mat.star': 10 }; // spare: nothing requests star
    w.town.requests = { 'mat.gel': 4 };
    w.town.gold = 1000;
    const h = addHunter(ctx, { gold: 0, bag: { 'mat.gel': 4 } });
    h.ai.goal = { type: 'sell' };
    h.ai.phase = 'act';
    h.ai.forced = true;
    economySystem.update(ctx);
    expect(w.town.storage['mat.gel']).toBe(4);
    expect(w.town.storage['mat.star']).toBe(6);
    expect(storageUnits(w)).toBe(10);
    expect(h.bag).toEqual({});
  });

  it('dismantle returns fill the room and the rest becomes Town gold', () => {
    const ctx = makeCtx(cfg({ storageCapBase: 3, dismantleReturnFrac: 1 }));
    const w = ctx.world;
    w.town.storage = { 'mat.gel': 2 };
    const gold0 = w.town.gold;
    // gear.w.club = 4 gel → 1 fits, 3 exported.
    dismantleItem(ctx, { uid: 'x', gearId: 'gear.w.club', qualityId: base.qualities[0]!.id, enhance: 0 }, 'command');
    expect(w.town.storage['mat.gel']).toBe(3);
    expect(storageRoom(ctx.config, w)).toBe(0);
    expect(w.town.gold - gold0).toBe(3 * surplusPrice(ctx.config, 'mat.gel', w));
  });
});

describe('tier-aware costs (TECH_SPEC §5.4, §5.8)', () => {
  it('enhance cost × the tier gearPriceMul, the same for the forge and the AI estimate', () => {
    const ctx = makeCtx();
    const h = addHunter(ctx, { level: 30 });
    const q = base.qualities[0]!.id;
    h.equipment.weapon = { uid: 'w', gearId: 'gear.w.drake', qualityId: q, enhance: 0 };
    const easy = enhanceCost(base, h.equipment.weapon)!;
    expect(easy).toBe(Math.round(base.index.gear.get('gear.w.drake')!.basePrice * base.enhance[0]!.costFrac));
    h.equipment.weapon = { ...h.equipment.weapon, difficultyId: 'diff.hard' };
    const hard = enhanceCost(base, h.equipment.weapon)!;
    expect(hard).toBe(Math.round(easy * base.index.difficulties.get('diff.hard')!.gearPriceMul!));
    expect(expectedEnhanceCost(base, h, 'weapon')!.cost).toBe(hard);
  });

  it('autoCraftReserve counts the essence of every craftable tier', () => {
    const ctx = makeCtx();
    const w = ctx.world;
    addHunter(ctx, { level: 1 });
    const easy = autoCraftReserve(base, w);
    w.town.unlockedDifficulties.push('diff.normal', 'diff.hard');
    w.town.difficulty = 'diff.hard';
    const ess = base.index.materials.get('mat.ess.hard')!.price;
    expect(autoCraftReserve(base, w)).toBe(Math.max(easy, 3 * ess));
    expect(3 * ess).toBeGreaterThan(easy);
  });
});

/** Town with 8 hunters at max level and R(reinc − 1), difficulties up to `diff` unlocked and current (auto off). */
function lateTown(diff: string, reinc: number): Simulation {
  const sim = new Simulation(base, createWorld(base, 3));
  for (let i = 0; i < base.formula.hunterSlots; i++) sim.enqueue({ type: 'debug.spawnHunter' });
  sim.step();
  const w = sim.world;
  const order = base.index.difficulties.get(diff)!.order;
  for (const d of base.difficulties) if (d.order <= order && !w.town.unlockedDifficulties.includes(d.id)) w.town.unlockedDifficulties.push(d.id);
  w.town.difficulty = diff;
  w.town.autoDifficulty = false;
  for (const h of w.hunters) { h.level = base.formula.maxLevel; h.reincarnation = reinc - 1; h.gold = 100; }
  return sim;
}

function runKills(sim: Simulation, minutes: number): number {
  let kills = 0;
  for (let t = 0; t < minutes * 600; t++) {
    sim.step();
    for (const e of sim.drainEvents()) if (e.type === 'monsterKilled') kills++;
  }
  return kills;
}

describe('auto-difficulty softlock (TECH_SPEC §5.8)', () => {
  it('starter kit: lowest-level gear of every empty slot at the given tier', () => {
    const kit = starterKitFor(base, { equipment: {} }, 'diff.expert');
    expect(kit.map((g) => base.index.gear.get(g.gearId)!.slot).sort()).toEqual([...GEAR_SLOTS].sort());
    for (const g of kit) {
      expect(base.index.gear.get(g.gearId)!.level).toBe(1);
      expect(g.difficultyId).toBe('diff.expert');
      expect(g.enhance).toBe(0);
    }
    const one = { weapon: { uid: 'x', gearId: 'gear.w.iron', qualityId: kit[0]!.qualityId, enhance: 0 } };
    expect(starterKitFor(base, { equipment: one }, 'diff.expert')).toHaveLength(GEAR_SLOTS.length - 1);
  });

  it('regression: auto difficulty no longer climbs past what a reincarnated hunter can hunt (before: Lv1, 0 kills forever)', { timeout: 120_000 }, () => {
    /** Max-level R4 town on Normal with everything unlocked: run the auto-difficulty checks, then reincarnate everyone. */
    const climb = (gate: number): Simulation => {
      const sim = lateTown('diff.normal', 5);
      const config = cfg({ diffAutoMinRatio: gate });
      sim.world.town.autoDifficulty = true;
      for (const d of base.difficulties) if (!sim.world.town.unlockedDifficulties.includes(d.id)) sim.world.town.unlockedDifficulties.push(d.id);
      sim.runBetweenTicks((ctx) => {
        const c = { ...ctx, config };
        // gate 0 = the old rule: advance only, no step-down.
        for (let i = 0; i < 10; i++) if (gate === 0 || autoStepDownDifficulty(c) === null) autoAdvanceDifficulty(c);
        for (const h of sim.world.hunters) reincarnate(c, h);
      });
      sim.world.town.autoDifficulty = false;
      return sim;
    };
    // Before the fix (no gate): every difficulty whose unlock count is met is taken at once (Normal → Nightmare), and a
    // level-1 hunter — even with the starter kit — has no zone with power ratio ≥ zoneFitMin there: no kills, so no
    // materials, no crafts, no gear, forever.
    const old = climb(0);
    expect(old.world.town.difficulty).toBe('diff.nightmare');
    for (const h of old.world.hunters) expect(bestZoneRatio(base, h, 'diff.nightmare')).toBeLessThan(base.formula.zoneFitMin);
    expect(runKills(old, 5)).toBe(0);
    // With the gate the Town stops where every hunter, reincarnated with a starter kit, can still hunt; they do.
    const sim = climb(base.formula.diffAutoMinRatio);
    const order = base.index.difficulties.get(sim.world.town.difficulty)!.order;
    expect(order).toBeGreaterThanOrEqual(1);
    expect(order).toBeLessThan(base.index.difficulties.get('diff.nightmare')!.order);
    for (const h of sim.world.hunters) expect(Object.keys(h.equipment)).toHaveLength(GEAR_SLOTS.length);
    expect(sim.world.stats.starterKits).toBe(base.formula.hunterSlots);
    expect(runKills(sim, 15)).toBeGreaterThan(50);
    expect(sim.world.hunters.every((h) => h.level > 1)).toBe(true);
  });

  it('advance gate: no step up while a hunter could not bootstrap at the next difficulty', () => {
    const sim = lateTown('diff.hard', 4);
    const w: World = sim.world;
    w.town.autoDifficulty = true;
    for (const h of w.hunters) { h.reincarnation = 3; h.level = 1; }
    w.town.unlockedDifficulties.push('diff.expert');
    const ratios = w.hunters.map((h) => bootstrapRatio(base, h, 'diff.expert'));
    expect(ratios.every((r) => r > 0)).toBe(true);
    sim.runBetweenTicks((ctx) => {
      // Level-1 gearless hunters in the world block (actual ratio < gate) whatever their bootstrap ratio.
      expect(autoAdvanceDifficulty(ctx)).toBeNull();
      for (const h of w.hunters) h.level = base.formula.maxLevel;
      // A gate above every hunter's bootstrap ratio blocks; 0 = no gate (the old rule) steps up.
      expect(autoAdvanceDifficulty({ ...ctx, config: cfg({ diffAutoMinRatio: Math.max(...ratios) + 0.01 }) })).toBeNull();
      expect(autoAdvanceDifficulty({ ...ctx, config: cfg({ diffAutoMinRatio: 0 }) })).toBe('diff.expert');
    });
  });

  it('step-down rescues a stuck town (down only, then stable) and the gate keeps it from flapping', () => {
    // A save that is already stuck: gearless level-1 hunters at Expert.
    const sim = lateTown('diff.expert', 3);
    sim.runBetweenTicks((ctx) => { for (const h of sim.world.hunters) { reincarnate(ctx, h); h.equipment = {}; } });
    sim.world.town.autoDifficulty = true;
    sim.drainEvents();
    sim.runBetweenTicks((ctx) => {
      for (let i = 0; i < 10; i++) if (autoStepDownDifficulty(ctx) === null) autoAdvanceDifficulty(ctx);
    });
    const changes = sim.drainEvents().filter((e) => e.type === 'difficultyChanged')
      .map((e) => (e.type === 'difficultyChanged' ? `${e.difficultyId}${e.stepDown ? ' down' : ''}` : ''));
    expect(changes.length).toBeGreaterThanOrEqual(1);
    expect(changes.every((c) => c.endsWith(' down'))).toBe(true); // never back up while they are this weak
    const d = sim.world.town.difficulty;
    expect(base.index.difficulties.get(d)!.order).toBeLessThan(base.index.difficulties.get('diff.expert')!.order);
    for (const h of sim.world.hunters) expect(bestZoneRatio(base, h, d)).toBeGreaterThanOrEqual(base.formula.zoneFitMin);
  });
});
