/** Trading Post material requests (GDD §5): request-based buying, player requests, AI zone preference, price levers. */
import { describe, expect, it } from 'vitest';
import { scoreGoals } from '../src/core/ai/utility';
import { applyCommand } from '../src/core/commands';
import type { FormulaParams, GameConfig } from '../src/core/config/types';
import { EventBuffer, type SimEvent } from '../src/core/events';
import { zoneScores } from '../src/core/formulas';
import { rollHunter } from '../src/core/hunterFactory';
import { NavGraph } from '../src/core/pathfinding';
import { Rng } from '../src/core/rng';
import { createWorld } from '../src/core/simulation';
import type { SystemContext } from '../src/core/system';
import { autoCraftReserve, craftingSystem } from '../src/core/systems/crafting';
import { economySystem } from '../src/core/systems/economy';
import { servicePrice } from '../src/core/systems/services';
import {
  autoMaterialDemand, materialDemand, requestedDropShare, surplusFloor, surplusPrice,
} from '../src/core/systems/trading';
import type { Goal, Hunter } from '../src/core/world';
import { testConfig } from './helpers';

const base = testConfig();
const nav = new NavGraph(base);

/** Live config with the trading values pinned, so the tests don't move with config tuning. */
function cfg(patch: Partial<FormulaParams> = {}): GameConfig {
  return {
    ...base,
    formula: {
      ...base.formula,
      requestMaxCopies: 2, requestZoneBonus: 0.3, requestMaxUnits: 999, tradeSaleTax: 0,
      tradeSurplusPriceFrac: 0.5, tradeSurplusFloorMul: 5, craftAffordFrac: 0, servicePriceLevelPct: 0,
      craftLevelAhead: 2, minUpgradeGain: 0.12,
      ...patch,
    },
  };
}

function makeCtx(config: GameConfig = cfg(), seed = 1): SystemContext & { events: EventBuffer } {
  return {
    world: createWorld(config, seed), config, nav, rng: new Rng(seed),
    events: new EventBuffer(), debug: { aiScores: new Map() }, dtMs: 100,
  };
}

function hunter(config: GameConfig, patch: Partial<Hunter> = {}, id = 'h1'): Hunter {
  const h = rollHunter(config, new Rng(7), id, base.index.squareNode, { x: 0, y: 0 }, 0);
  Object.assign(h, patch);
  return h;
}

function addHunter(ctx: SystemContext, patch: Partial<Hunter> = {}): Hunter {
  const h = hunter(ctx.config, patch, 'h' + ctx.world.hunters.length);
  ctx.world.hunters.push(h);
  return h;
}

function arrive(h: Hunter, goal: Goal): void {
  h.ai.goal = goal;
  h.ai.phase = 'act';
  h.ai.forced = true;
}

const ofType = <T extends SimEvent['type']>(evs: SimEvent[], t: T) =>
  evs.filter((e): e is Extract<SimEvent, { type: T }> => e.type === t);

describe('automatic requests from auto-craft needs', () => {
  it('requests materials for min(wanters, requestMaxCopies) crafts of every useful recipe, minus storage', () => {
    const ctx = makeCtx();
    addHunter(ctx, { level: 1 }); // empty slots → club (gel 4), padded (gel 3 + hide 1), charm (gel 5) are upgrades
    expect(autoMaterialDemand(ctx.config, ctx.world)).toEqual({ 'mat.gel': 12, 'mat.hide': 1 });
    ctx.world.town.storage = { 'mat.gel': 5 };
    expect(autoMaterialDemand(ctx.config, ctx.world)).toEqual({ 'mat.gel': 7, 'mat.hide': 1 });
    addHunter(ctx, { level: 1 });
    addHunter(ctx, { level: 1 }); // 3 wanters → capped at 2 copies
    expect(autoMaterialDemand(ctx.config, ctx.world)).toEqual({ 'mat.gel': 19, 'mat.hide': 2 });
  });

  it('requests nothing when auto-craft is off or nobody would be upgraded', () => {
    const ctx = makeCtx();
    const h = addHunter(ctx, { level: 1 });
    ctx.world.town.autoCraft = false;
    expect(autoMaterialDemand(ctx.config, ctx.world)).toEqual({});
    ctx.world.town.autoCraft = true;
    h.equipment = {
      weapon: { uid: 'a', gearId: 'gear.w.club', qualityId: 'q.mythic', enhance: 5 },
      armor: { uid: 'b', gearId: 'gear.a.padded', qualityId: 'q.mythic', enhance: 5 },
      accessory: { uid: 'c', gearId: 'gear.r.charm', qualityId: 'q.mythic', enhance: 5 },
    };
    expect(autoMaterialDemand(ctx.config, ctx.world)).toEqual({});
  });

  it('craftAffordFrac: hunters who cannot come close to paying do not count', () => {
    const ctx = makeCtx(cfg({ craftAffordFrac: 1 }));
    addHunter(ctx, { level: 1, gold: 0 });
    expect(autoMaterialDemand(ctx.config, ctx.world)).toEqual({});
    ctx.world.hunters[0]!.gold = 1000;
    expect(autoMaterialDemand(ctx.config, ctx.world)).toEqual({ 'mat.gel': 12, 'mat.hide': 1 });
  });
});

describe('request-based buying at the Trading Post', () => {
  it('buys only up to the automatic request; the excess is discarded when the town has no surplus gold', () => {
    const ctx = makeCtx();
    const h = addHunter(ctx, { level: 1, gold: 0, bag: { 'mat.gel': 15, 'mat.ore': 4 } });
    ctx.world.town.gold = 100; // below the surplus floor (5 × autoCraftReserve = 5 × 24)
    expect(surplusFloor(ctx.config, ctx.world)).toBe(5 * autoCraftReserve(ctx.config, ctx.world));
    arrive(h, { type: 'sell' });
    economySystem.update(ctx);
    // gel: 12 requested × 4 = 48; 3 gel + 4 ore (unrequested) discarded.
    expect(h.gold).toBe(48);
    expect(ctx.world.town.gold).toBe(52);
    expect(ctx.world.town.storage).toEqual({ 'mat.gel': 12 });
    expect(h.bag).toEqual({});
    expect(ctx.world.stats.materialsSold).toBe(12);
    expect(ctx.world.stats.materialsDiscarded).toBe(7);
    const evs = ctx.events.drain();
    expect(ofType(evs, 'materialsSold')).toMatchObject([{ units: 12, gold: 48 }]);
    expect(ofType(evs, 'materialsDiscarded')).toMatchObject([{ hunterId: h.id, units: 7 }]);
    expect(materialDemand(ctx.config, ctx.world)).toEqual({ 'mat.hide': 1 }); // the gel request is filled
  });

  it('a rich town buys unrequested units at the surplus price for export (never stored), down to the floor', () => {
    const ctx = makeCtx();
    ctx.world.town.autoCraft = false;
    const h = addHunter(ctx, { level: 1, gold: 0, bag: { 'mat.gel': 10, 'mat.ore': 10 } });
    const floor = surplusFloor(ctx.config, ctx.world); // 120
    expect(surplusPrice(ctx.config, 'mat.gel')).toBe(2); // 4 × 0.5
    expect(surplusPrice(ctx.config, 'mat.ore')).toBe(12); // 24 × 0.5
    ctx.world.town.gold = floor + 20 + 12 * 3 + 5; // gel 10 × 2 = 20, then 3 ore fit (5 left over)
    arrive(h, { type: 'sell' });
    economySystem.update(ctx);
    expect(h.gold).toBe(20 + 36);
    expect(ctx.world.town.gold).toBe(floor + 5);
    expect(ctx.world.town.storage).toEqual({});
    expect(h.bag).toEqual({});
    expect(ctx.world.stats.materialsSold).toBe(13);
    expect(ctx.world.stats.materialsDiscarded).toBe(7);
  });

  it('two hunters selling in the same tick never fill the same request twice', () => {
    const ctx = makeCtx(cfg({ tradeSurplusPriceFrac: 0 }));
    ctx.world.town.autoCraft = false;
    ctx.world.town.requests = { 'mat.ore': 4 };
    ctx.world.town.gold = 10_000;
    const a = addHunter(ctx, { gold: 0, bag: { 'mat.ore': 3 } });
    const b = addHunter(ctx, { gold: 0, bag: { 'mat.ore': 3 } });
    arrive(a, { type: 'sell' });
    arrive(b, { type: 'sell' });
    economySystem.update(ctx);
    expect(a.gold).toBe(72);
    expect(b.gold).toBe(24);
    expect(ctx.world.town.storage).toEqual({ 'mat.ore': 4 });
    expect(ctx.world.town.requests).toEqual({});
    expect(ctx.world.stats.materialsDiscarded).toBe(2);
  });

  it('tradeSaleTax: the hunter receives round(price × (1 − tax)); the town pays the same', () => {
    const ctx = makeCtx(cfg({ tradeSaleTax: 0.25 }));
    ctx.world.town.autoCraft = false;
    ctx.world.town.requests = { 'mat.ore': 2 };
    ctx.world.town.gold = 100;
    const h = addHunter(ctx, { gold: 0, bag: { 'mat.ore': 2 } });
    arrive(h, { type: 'sell' });
    economySystem.update(ctx);
    expect(h.gold).toBe(36); // 2 × round(24 × 0.75)
    expect(ctx.world.town.gold).toBe(64);
  });
});

describe('player request command (town.requestMaterial)', () => {
  it('sets, replaces and clears a request', () => {
    const ctx = makeCtx();
    applyCommand(ctx, { type: 'town.requestMaterial', materialId: 'mat.ore', count: 10 });
    expect(ctx.world.town.requests).toEqual({ 'mat.ore': 10 });
    applyCommand(ctx, { type: 'town.requestMaterial', materialId: 'mat.ore', count: 3 });
    expect(ctx.world.town.requests).toEqual({ 'mat.ore': 3 });
    expect(materialDemand(ctx.config, ctx.world)['mat.ore']).toBe(3);
    applyCommand(ctx, { type: 'town.requestMaterial', materialId: 'mat.ore', count: 0 });
    expect(ctx.world.town.requests).toEqual({});
    expect(ofType(ctx.events.drain(), 'commandRejected')).toEqual([]);
  });

  it('rejects unknown materials and invalid counts with commandRejected', () => {
    const ctx = makeCtx();
    const bad: [string, number, string][] = [
      ['mat.nope', 5, 'unknown material'],
      ['mat.ore', -1, 'invalid count'],
      ['mat.ore', 1.5, 'invalid count'],
      ['mat.ore', Number.NaN, 'invalid count'],
      ['mat.ore', 1000, 'count too large'],
    ];
    for (const [materialId, count] of bad) applyCommand(ctx, { type: 'town.requestMaterial', materialId, count });
    expect(ofType(ctx.events.drain(), 'commandRejected').map((e) => e.reason)).toEqual(bad.map((b) => b[2]));
    expect(ctx.world.town.requests).toEqual({});
  });

  it('player requests add to the automatic ones and are filled first', () => {
    const ctx = makeCtx();
    const h = addHunter(ctx, { level: 1, gold: 0, bag: { 'mat.gel': 20 } });
    ctx.world.town.gold = 100; // no surplus purchases
    applyCommand(ctx, { type: 'town.requestMaterial', materialId: 'mat.gel', count: 5 });
    expect(materialDemand(ctx.config, ctx.world)['mat.gel']).toBe(12 + 5);
    arrive(h, { type: 'sell' });
    economySystem.update(ctx);
    expect(ctx.world.town.storage).toEqual({ 'mat.gel': 17 });
    expect(ctx.world.town.requests).toEqual({});
    expect(h.gold).toBe(68);
  });
});

describe('AI: prefer zones that drop requested materials', () => {
  const config = cfg();
  /** A hunter strong enough for both the meadow and the ruins (base stats scaled up). */
  function twoZoneHunter(): Hunter {
    for (let k = 1; k <= 20; k += 0.25) {
      const h = hunter(config);
      h.stats = { ...h.stats, atk: h.stats.atk * k, hp: h.stats.hp * k };
      h.needs.hp = h.stats.hp;
      const w = createWorld(config, 1);
      const scores = zoneScores(config, w, h);
      const fits = ['zone.meadow', 'zone.ruins'].map((id) => scores.find((z) => z.zone.id === id)!.fit);
      if (fits.every((f) => f > 0)) return h;
    }
    throw new Error('no stat scale fits both zones');
  }
  function huntScores(requests: Record<string, number>): Map<string, number> {
    const w = createWorld(config, 1);
    w.town.autoCraft = false;
    w.town.requests = requests;
    const out = new Map<string, number>();
    for (const c of scoreGoals(config, nav, w, twoZoneHunter())) if (c.goal.type === 'hunt') out.set(c.goal.zoneId, c.score);
    return out;
  }

  it('requestedDropShare is the requested share of the zone drop value', () => {
    const meadow = config.index.zones.get('zone.meadow')!;
    expect(requestedDropShare(config, meadow, {})).toBe(0);
    expect(requestedDropShare(config, meadow, { 'mat.gel': 1, 'mat.hide': 1, 'mat.tusk': 1 })).toBeCloseTo(1);
    const gelOnly = requestedDropShare(config, meadow, { 'mat.gel': 1 });
    // slime 3 × 0.6 × 4 = 7.2 vs boar 1 × (0.5 × 8 + 0.3 × 14) = 8.2
    expect(gelOnly).toBeCloseTo(7.2 / 15.4);
  });

  it('a requested zone gains on an unrequested one, without raising the best hunt score', () => {
    const none = huntScores({});
    const ore = huntScores({ 'mat.ore': 10 }); // ruins drop ore
    const gel = huntScores({ 'mat.gel': 10, 'mat.hide': 10, 'mat.tusk': 10 }); // meadow drops
    const gap = (s: Map<string, number>) => s.get('zone.ruins')! - s.get('zone.meadow')!;
    expect(gap(ore)).toBeGreaterThan(gap(none));
    expect(gap(gel)).toBeLessThan(gap(none));
    const best = (s: Map<string, number>) => Math.max(...s.values());
    expect(best(ore)).toBeLessThanOrEqual(best(none) + 1e-9);
    expect(best(gel)).toBeLessThanOrEqual(best(none) + 1e-9);
    // The zone with the strongest request keeps its unrequested score; the others are scaled down.
    expect(ore.get('zone.ruins')).toBeCloseTo(none.get('zone.ruins')!);
  });

  it('never pulls a hunter into a zone it cannot survive', () => {
    const s = huntScores({ 'mat.star': 99, 'mat.shade': 99 }); // abyss drops
    expect(s.has('zone.abyss')).toBe(false);
  });

  it('a full bag of unrequested materials sends the hunter home (the post discards them), a broke-town requested bag does not', () => {
    const w = createWorld(config, 1);
    w.town.autoCraft = false;
    const field = config.nodes.find((n) => n.zoneId === 'zone.meadow')!;
    const h = hunter(config, { level: 1, bag: { 'mat.gel': config.formula.bagCapacity } });
    h.nodeId = field.id;
    h.position = { x: field.x, y: field.y };
    const ret = () => scoreGoals(config, nav, w, h).find((c) => c.goal.type === 'returnTown')!.score;
    w.town.gold = 0;
    expect(ret()).toBeCloseTo(1.2); // junk → dump trip
    w.town.requests = { 'mat.gel': 5 };
    expect(ret()).toBeCloseTo(1.2); // 25 units beyond the request would be discarded → trip clears room
    w.town.requests = { 'mat.gel': 999 };
    expect(ret()).toBeLessThan(1.2); // all requested but the town cannot pay: keep hunting
    w.town.gold = 10_000;
    expect(ret()).toBeCloseTo(1.2);
  });
});

describe('gearScrapped event/stat', () => {
  it('the crafting system reports items scrapped after shopScrapSec', () => {
    const ctx = makeCtx(cfg({ shopScrapSec: 1800 }));
    ctx.world.town.autoCraft = false;
    ctx.world.timeMs = 1800 * 1000;
    ctx.world.town.shop.push({ uid: 'g1', gearId: 'gear.w.club', qualityId: 'q.rare', enhance: 0, price: 48, listPrice: 60, listedAtMs: 0 });
    craftingSystem.update(ctx);
    expect(ctx.world.town.shop).toEqual([]);
    expect(ctx.world.stats.gearScrapped).toBe(1);
    expect(ofType(ctx.events.drain(), 'gearScrapped')).toMatchObject([{ itemUid: 'g1', gearId: 'gear.w.club', qualityId: 'q.rare' }]);
  });
});

describe('service prices scale with level', () => {
  it('round(base × (1 + pct/100 × (level − 1))), used by the services system and the AI', () => {
    const config = cfg({ servicePriceLevelPct: 2 });
    const inn = config.index.buildings.get('bld.inn')!; // base 18
    expect(servicePrice(config, hunter(config, { level: 1 }), inn)).toBe(18);
    expect(servicePrice(config, hunter(config, { level: 51 }), inn)).toBe(36);
    expect(servicePrice(cfg(), hunter(config, { level: 51 }), inn)).toBe(18);

    const ctx = makeCtx(config);
    const h = addHunter(ctx, { level: 51, gold: 30 });
    h.needs.stamina = 10;
    // The AI does not offer a service it cannot pay for at the scaled price.
    expect(scoreGoals(config, nav, ctx.world, h).some((c) => c.goal.type === 'service' && c.goal.buildingId === inn.id)).toBe(false);
    h.gold = 40;
    expect(scoreGoals(config, nav, ctx.world, h).some((c) => c.goal.type === 'service' && c.goal.buildingId === inn.id)).toBe(true);
    applyCommand(ctx, { type: 'hunter.activity', hunterId: h.id, buildingId: inn.id });
    expect(ofType(ctx.events.drain(), 'commandRejected')).toEqual([]);
  });
});
