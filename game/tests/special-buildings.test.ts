/** M5 special buildings (TECH_SPEC §5.15): Training Ground, bank, monument aura, fountain, library; auto-invest; v15. */
import { describe, expect, it } from 'vitest';
import { bestTraining, scoreGoals } from '../src/core/ai/utility';
import { loadConfig, validateConfig } from '../src/core/config/load';
import type { GameConfig } from '../src/core/config/types';
import { EventBuffer } from '../src/core/events';
import { expToNext, hunterStats, planStats } from '../src/core/formulas';
import { rollHunter } from '../src/core/hunterFactory';
import { NavGraph } from '../src/core/pathfinding';
import { Rng } from '../src/core/rng';
import { deserialize, SAVE_FORMAT, serialize } from '../src/core/save/save';
import { createWorld, Simulation } from '../src/core/simulation';
import { cacheVerifyEnabled, setStatsCacheVerify } from '../src/core/statsCache';
import type { SystemContext } from '../src/core/system';
import { reviveDelayMs } from '../src/core/systems/consumables';
import { feeTownCut } from '../src/core/systems/economy';
import { townAuraSystem } from '../src/core/systems/monument';
import { needsSystem } from '../src/core/systems/needs';
import { servicesSystem } from '../src/core/systems/services';
import {
  bankFloorMul, buildingDoor, chooseInvestment, fountainRegenMul, investFloor, investValue, libraryExpMul, otherCandidates,
} from '../src/core/systems/town';
import { trainingSystem, trainLevelCap, trainOffer } from '../src/core/systems/training';
import { WORLD_SCHEMA_VERSION, type Hunter, type World } from '../src/core/world';
import { readRawConfig, testConfig } from './helpers';

const config = testConfig();
const nav = new NavGraph(config);
const KINDS = ['training', 'bank', 'monument', 'fountain', 'library'] as const;
const idOf = (kind: string) => config.buildings.find((b) => b.kind === kind)!.id;
const TRAIN = idOf('training');

function makeCtx(cfg: GameConfig = config, seed = 1): SystemContext & { events: EventBuffer } {
  return { world: createWorld(cfg, seed), config: cfg, nav, rng: new Rng(seed), events: new EventBuffer(), debug: { aiScores: new Map() }, dtMs: 100 };
}

function addHunter(ctx: SystemContext, patch: Partial<Hunter> = {}): Hunter {
  const h = rollHunter(ctx.config, new Rng(7 + ctx.world.hunters.length), 'h' + ctx.world.hunters.length, config.index.squareNode, { x: 0, y: 0 }, 0);
  Object.assign(h, patch);
  ctx.world.hunters.push(h);
  return h;
}

/** Step a simulation for `ms` of game time. */
function runFor(sim: Simulation, ms: number): void {
  for (let t = 0; t < ms; t += 100) sim.step();
}

/** Stand a building of a type on its first free plot at a level (no Town Hall check: effects only read the level). */
function place(w: World, buildingId: string, level: number): void {
  const s = w.town.buildings.find((x) => x.buildingId === buildingId);
  if (s) { s.level = level; return; }
  const plot = config.plots.find((p) => !w.town.buildings.some((x) => x.id === p.id))!;
  w.town.buildings.push({ id: plot.id, buildingId, level, upgrade: null });
}

describe('special buildings: config', () => {
  it('has one building of every M5 kind, each on the plot system, with room for all buildable types', () => {
    for (const k of KINDS) expect(config.buildings.filter((b) => b.kind === k)).toHaveLength(1);
    const buildable = config.buildings.filter((b) => !config.plots.some((p) => p.startBuilding === b.id));
    const free = config.plots.filter((p) => !p.startBuilding);
    expect(free.length).toBeGreaterThanOrEqual(buildable.length);
    const w = createWorld(config, 1);
    for (const k of KINDS) expect(buildingDoor(config, w, idOf(k))).toBeNull(); // not built in a new game
    // Every free plot door is reachable from the square.
    for (const p of free) expect(nav.path(config.index.squareNode, p.doorNode)).not.toBeNull();
  });

  it('rejects a second building of an M5 kind and a missing per-level field', () => {
    const raw = readRawConfig();
    const rows = raw.building as unknown as Record<string, unknown>[];
    const bank = rows.find((b) => b.kind === 'bank')!;
    rows.push({ ...bank, id: 'bld.bank2' });
    expect(validateConfig(raw).some((i) => i.message.includes('at most one "bank"'))).toBe(true);
    const raw2 = readRawConfig();
    const lib = (raw2.building as unknown as Record<string, unknown>[]).find((b) => b.kind === 'library')!;
    delete lib.killExpPct;
    expect(validateConfig(raw2).some((i) => i.path.endsWith('killExpPct'))).toBe(true);
  });
});

describe('Training Ground', () => {
  it('offers nothing until built; then EXP = trainExpFrac × expToNext, price = trainGoldPerExp × EXP, capped below the top', () => {
    const ctx = makeCtx();
    const top = addHunter(ctx, { level: 40 });
    const low = addHunter(ctx, { level: 10, gold: 100000 });
    expect(trainOffer(config, ctx.world, low)).toBeNull();
    place(ctx.world, TRAIN, 1);
    const b = config.index.buildings.get(TRAIN)!;
    expect(trainLevelCap(config, ctx.world)).toBe(40 - b.trainLevelGap![0]!);
    const o = trainOffer(config, ctx.world, low)!;
    expect(o.exp).toBe(Math.round(b.trainExpFrac![0]! * expToNext(10, config.formula)));
    expect(o.price).toBe(Math.round(config.formula.trainGoldPerExp * o.exp));
    expect(trainOffer(config, ctx.world, top)).toBeNull(); // the top hunter never trains
    low.level = 40 - b.trainLevelGap![0]!;
    expect(trainOffer(config, ctx.world, low)).toBeNull(); // at the cap
  });

  it('AI keeps a reserve and its gear savings; train is only scored when available', () => {
    const ctx = makeCtx();
    addHunter(ctx, { level: 40 });
    const h = addHunter(ctx, { level: 10, gold: 0 });
    const labels = () => scoreGoals(config, nav, ctx.world, h).map((c) => c.goal.type);
    expect(labels()).not.toContain('train');
    place(ctx.world, TRAIN, 1);
    const o = trainOffer(config, ctx.world, h)!;
    h.gold = o.price; // can pay but not the reserve
    expect(bestTraining(config, ctx.world, h)).toBeNull();
    h.gold = 1e6;
    expect(bestTraining(config, ctx.world, h)).not.toBeNull();
    expect(labels()).toContain('train');
  });

  it('a session at the door: pays (Town gets its fee cut), gains EXP, stays inside trainSessionSec, comes out', () => {
    const ctx = makeCtx();
    addHunter(ctx, { level: 40 });
    place(ctx.world, TRAIN, 2);
    const h = addHunter(ctx, { level: 10, gold: 5000 });
    h.ai.goal = { type: 'train' };
    h.ai.phase = 'act';
    const o = trainOffer(config, ctx.world, h)!;
    const town = ctx.world.town.gold;
    const cut = feeTownCut(config, o.price, ctx.world);
    const exp0 = h.exp;
    trainingSystem.update(ctx);
    expect(h.gold).toBe(5000 - o.price);
    expect(ctx.world.town.gold).toBe(town + cut);
    expect(h.level > 10 || h.exp === exp0 + o.exp).toBe(true);
    expect(h.insideBuildingId).toBe(TRAIN);
    expect(ctx.world.stats).toMatchObject({ trainSessions: 1, trainGold: o.price, trainExp: o.exp });
    // Needs are frozen and services ignore it.
    const sat = h.needs.satiety;
    const ticks = Math.round((config.formula.trainSessionSec * 1000) / ctx.dtMs);
    for (let i = 0; i < ticks - 1; i++) {
      servicesSystem.update(ctx);
      needsSystem.update(ctx);
      trainingSystem.update(ctx);
    }
    expect(h.needs.satiety).toBe(sat);
    expect(h.insideBuildingId).toBe(TRAIN);
    trainingSystem.update(ctx);
    expect(h.insideBuildingId).toBeNull();
    expect(h.ai.goal).toBeNull();
    expect(h.trainMs).toBeUndefined();
  });

  it('drops the goal without paying when the session is no longer allowed', () => {
    const ctx = makeCtx();
    place(ctx.world, TRAIN, 1);
    const h = addHunter(ctx, { level: 10, gold: 5000 }); // the top hunter itself
    h.ai.goal = { type: 'train' };
    h.ai.phase = 'act';
    trainingSystem.update(ctx);
    expect(h.gold).toBe(5000);
    expect(h.ai.goal).toBeNull();
    expect(h.insideBuildingId).toBeNull();
  });
});

describe('bank, fountain, library', () => {
  it('bank lowers only the non-urgent investment floor', () => {
    const ctx = makeCtx();
    const plain = investFloor(config, ctx.world, false);
    const urgent = investFloor(config, ctx.world, true);
    place(ctx.world, idOf('bank'), 2);
    const mul = config.index.buildings.get(idOf('bank'))!.investFloorMul![1]!;
    expect(bankFloorMul(config, ctx.world)).toBe(mul);
    expect(investFloor(config, ctx.world, false)).toBeCloseTo(plain * mul, 6);
    expect(investFloor(config, ctx.world, true)).toBe(urgent);
  });

  it('fountain multiplies the free idle regen and shortens the death timer', () => {
    const ctx = makeCtx();
    const h = addHunter(ctx, { level: 5 });
    h.needs.satiety = 50;
    h.ai.goal = null;
    needsSystem.update(ctx);
    const plain = h.needs.satiety - 50 + config.formula.satietyDecayPerSec * 0.1;
    const delay = reviveDelayMs(config, ctx.world, h);
    place(ctx.world, idOf('fountain'), 1);
    const b = config.index.buildings.get(idOf('fountain'))!;
    expect(fountainRegenMul(config, ctx.world)).toBe(b.townRegenMul![0]);
    h.needs.satiety = 50;
    needsSystem.update(ctx);
    const boosted = h.needs.satiety - 50 + config.formula.satietyDecayPerSec * 0.1;
    expect(boosted).toBeCloseTo(plain * b.townRegenMul![0]!, 6);
    expect(reviveDelayMs(config, ctx.world, h)).toBeCloseTo(delay * b.reviveSecMul![0]!, 6);
  });

  it('library multiplies kill EXP (exactly 1 without it) and is counted in stats', () => {
    const w = createWorld(config, 3);
    expect(libraryExpMul(config, w)).toBe(1);
    place(w, idOf('library'), 1);
    expect(libraryExpMul(config, w)).toBeCloseTo(1 + config.index.buildings.get(idOf('library'))!.killExpPct![0]! / 100, 9);
    const sim = new Simulation(config, w);
    runFor(sim, 10 * 60 * 1000);
    expect(sim.world.stats.kills).toBeGreaterThan(0);
    expect(sim.world.stats.libraryExp).toBeGreaterThan(0);
  });
});

describe('monument aura', () => {
  it('is synced onto hunters and raises ATK/DEF in steady and live stats; removed when gone', () => {
    const was = cacheVerifyEnabled();
    setStatsCacheVerify(true); // a stale cache entry would throw
    try {
      const ctx = makeCtx();
      const h = addHunter(ctx, { level: 20 });
      const base = hunterStats(config, h);
      const steady = hunterStats(config, h, { steady: true });
      townAuraSystem.update(ctx);
      expect(h.aura).toBeUndefined();
      place(ctx.world, idOf('monument'), 3);
      townAuraSystem.update(ctx);
      const b = config.index.buildings.get(idOf('monument'))!;
      expect(h.aura).toEqual({ atkPct: b.auraAtkPct![2], defPct: b.auraDefPct![2] });
      expect(hunterStats(config, h).atk).toBeCloseTo(base.atk * (1 + b.auraAtkPct![2]! / 100), 6);
      expect(hunterStats(config, h).def).toBeCloseTo(base.def * (1 + b.auraDefPct![2]! / 100), 6);
      expect(hunterStats(config, h, { steady: true }).atk).toBeCloseTo(steady.atk * (1 + b.auraAtkPct![2]! / 100), 6);
      expect(planStats(config, h).atk).toBeGreaterThan(steady.atk);
      expect(hunterStats(config, h).hp).toBe(base.hp);
      ctx.world.town.buildings = ctx.world.town.buildings.filter((s) => s.buildingId !== idOf('monument'));
      townAuraSystem.update(ctx);
      expect(h.aura).toBeUndefined();
      expect(hunterStats(config, h).atk).toBe(base.atk);
    } finally {
      setStatsCacheVerify(was);
    }
  });
});

describe('auto-invest with special buildings', () => {
  it('values every new kind (> 0 for a build and each upgrade), builds count as one full step', () => {
    for (const k of KINDS) {
      const b = config.index.buildings.get(idOf(k))!;
      for (let to = 1; to <= b.maxLevel; to++) {
        const v = investValue(config, { plotId: 'plot.ne', buildingId: b.id, toLevel: to, urgent: false, cost: { gold: 1, materials: {}, ms: 0 } });
        expect(v, `${k} → ${to}`).toBeGreaterThan(0);
      }
    }
    const t = investValue(config, { plotId: 'plot.ne', buildingId: TRAIN, toLevel: 1, urgent: false, cost: { gold: 1, materials: {}, ms: 0 } });
    expect(t).toBeCloseTo(config.formula.investValueTraining, 9);
  });

  it('zero weights switch a kind off; a free plot gets the best-value new building', () => {
    const ctx = makeCtx();
    const th = ctx.world.town.buildings.find((s) => s.buildingId === config.index.townHall)!;
    th.level = 8;
    for (const s of ctx.world.town.buildings) if (s.buildingId !== th.buildingId) s.level = config.index.buildings.get(s.buildingId)!.maxLevel;
    ctx.world.town.gold = 1e7;
    // Only build candidates are left (everything else is maxed) and they all go on the first free plot.
    const cands = otherCandidates(config, ctx.world);
    expect(cands.length).toBeGreaterThan(0);
    expect(new Set(cands.map((c) => c.plotId)).size).toBe(1);
    const pick = chooseInvestment(config, ctx.world)!;
    expect(pick.toLevel).toBe(1);
    // With every M5 weight at 0 and the storehouse at 0, nothing is worth building.
    const raw = readRawConfig();
    const fp = raw.formula_params as Record<string, number>;
    for (const k of ['investValueTraining', 'investValueBank', 'investValueMonument', 'investValueFountain', 'investValueLibrary', 'investValueStorehouse']) fp[k] = 0;
    const cfg0 = loadConfig(raw);
    expect(chooseInvestment(cfg0, ctx.world)).toBeNull();
  });
});

describe('save v15', () => {
  it('migrates a v12 save: new stats at 0, no aura / training fields, keeps running', () => {
    const w = JSON.parse(JSON.stringify(createWorld(config, 4))) as Record<string, any>;
    for (const k of ['trainSessions', 'trainGold', 'trainExp', 'libraryExp']) delete w.stats[k];
    w.schemaVersion = 12;
    const r = deserialize(JSON.stringify({ format: SAVE_FORMAT, schemaVersion: 12, configVersion: config.version, savedAt: 0, world: w }), config);
    expect(r.migratedFrom).toBe(12);
    expect(r.world.schemaVersion).toBe(WORLD_SCHEMA_VERSION);
    expect(WORLD_SCHEMA_VERSION).toBe(15);
    expect(r.world.stats).toMatchObject({ trainSessions: 0, trainGold: 0, trainExp: 0, libraryExp: 0 });
    const sim = new Simulation(config, r.world);
    runFor(sim, 60 * 1000);
    expect(sim.world.tick).toBeGreaterThan(0);
  });

  it('keeps existing v15 fields on a round trip mid-session (aura, training)', () => {
    const w = createWorld(config, 5);
    place(w, idOf('monument'), 1);
    place(w, TRAIN, 1);
    const sim = new Simulation(config, w);
    runFor(sim, 5 * 60 * 1000);
    const h = sim.world.hunters[0]!;
    expect(h.aura).toBeDefined();
    const text = serialize(sim.world, 0);
    const back = deserialize(text, config).world;
    expect(back.hunters[0]!.aura).toEqual(h.aura);
    const a = new Simulation(config, back);
    const b = new Simulation(config, deserialize(text, config).world);
    runFor(a, 60 * 1000);
    runFor(b, 60 * 1000);
    expect(serialize(a.world, 0)).toBe(serialize(b.world, 0));
  });
});
