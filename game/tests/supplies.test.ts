/** Service supplies, potions and the revive fee (TECH_SPEC §5.14). */
import { describe, expect, it } from 'vitest';
import { potionDrinkLine, retreatHpFloor, scoreGoals, shouldRetreatBeforeNextKill, urgentThreshold } from '../src/core/ai/utility';
import { loadConfig, type RawConfig } from '../src/core/config/load';
import type { GameConfig } from '../src/core/config/types';
import { EventBuffer } from '../src/core/events';
import { needMax } from '../src/core/formulas';
import { rollHunter } from '../src/core/hunterFactory';
import { NavGraph } from '../src/core/pathfinding';
import { Rng } from '../src/core/rng';
import { deserialize, SAVE_FORMAT } from '../src/core/save/save';
import { createWorld, Simulation } from '../src/core/simulation';
import type { SystemContext } from '../src/core/system';
import { combatSystem } from '../src/core/systems/combat';
import {
  bestPotionPurchase, buyPotions, consumablesSystem, maybeDrink, potionPrice, potionTiers, potionUseSystem, reviveDelayMs, reviveFee,
} from '../src/core/systems/consumables';
import { economySystem } from '../src/core/systems/economy';
import { servicePrice, servicesSystem } from '../src/core/systems/services';
import {
  lineKey, lineRecipes, lineStock, pickRecipe, serviceInStock, suppliesSystem, supplyMaterialNeed, tierFor,
} from '../src/core/systems/supplies';
import { autoMaterialDemand, baseMaterialNeed, sellOrder } from '../src/core/systems/trading';
import { WORLD_SCHEMA_VERSION, type Hunter, type World } from '../src/core/world';
import { readRawConfig, testConfig } from './helpers';

const config = testConfig();
const nav = new NavGraph(config);
const f = config.formula;
const INF = 'bld.infirmary';
const REST = 'bld.restaurant';

function makeConfig(edit: (raw: Record<string, any>) => void): GameConfig {
  const raw = readRawConfig() as Record<string, any>;
  edit(raw);
  return loadConfig(raw as RawConfig);
}

function makeCtx(seed = 1): SystemContext & { events: EventBuffer } {
  return { world: createWorld(config, seed), config, nav, rng: new Rng(seed), events: new EventBuffer(), debug: { aiScores: new Map() }, dtMs: 100 };
}

function addHunter(ctx: SystemContext, patch: Partial<Hunter> = {}): Hunter {
  const sq = nav.node(config.index.squareNode);
  const h = rollHunter(config, new Rng(7 + ctx.world.hunters.length), 'h' + ctx.world.hunters.length, sq.id, { x: sq.x, y: sq.y }, 0);
  Object.assign(h, patch);
  ctx.world.hunters.push(h);
  return h;
}

function placeInZone(h: Hunter, zoneId: string): void {
  const n = nav.node(config.index.zones.get(zoneId)!.entryNode);
  h.nodeId = n.id;
  h.position = { x: n.x, y: n.y };
}

const setLevel = (w: World, id: string, level: number) => { w.town.buildings.find((s) => s.buildingId === id)!.level = level; };
const line = (w: World, kind: 'supply' | 'potion', id: string) => w.town.supply[lineKey(kind, id)]!;
const tick = (ctx: SystemContext, n = 1, sys = suppliesSystem) => { for (let i = 0; i < n; i++) { sys.update(ctx); ctx.world.tick++; } };

describe('config', () => {
  it('loads the consumable table: four service lines and the potion line, each from minLevel 1', () => {
    for (const id of [INF, REST, 'bld.tavern', 'bld.inn']) expect(lineRecipes(config, 'supply', id)[0]!.minLevel).toBe(1);
    expect(config.index.potionSeller).toBe(INF);
    expect(potionTiers(config).length).toBeGreaterThan(1);
    expect(potionTiers(config).every((c) => c.heal! > 0 && c.price! > 0)).toBe(true);
  });

  it('rejects inconsistent rows', () => {
    expect(() => makeConfig((raw) => { raw.consumable[0].buildingId = 'bld.shop'; })).toThrow(/consumable\[0\]\.buildingId/);
    expect(() => makeConfig((raw) => { const p = raw.consumable.find((c: any) => c.kind === 'potion'); delete p.heal; })).toThrow(/heal and price/);
    expect(() => makeConfig((raw) => { raw.consumable = raw.consumable.filter((c: any) => !(c.buildingId === 'bld.inn' && c.minLevel === 1)); }))
      .toThrow(/supply:bld.inn.*minLevel 1/);
    expect(() => makeConfig((raw) => { raw.consumable[0].materials[0].materialId = 'mat.nope'; })).toThrow(/consumable\[0\]\.materials\[0\]\.materialId/);
    expect(() => makeConfig((raw) => { delete raw.formula_params.potionCarryMax; })).toThrow(/potionCarryMax/);
  });
});

describe('service supplies', () => {
  it('a new town starts with full service stock; each serving takes one unit', () => {
    const ctx = makeCtx();
    const cap = config.index.buildings.get(INF)!.supplyCap![0]!;
    expect(lineStock(ctx.world, lineKey('supply', INF))).toBe(cap);
    const h = addHunter(ctx, { gold: 1000 });
    h.needs.hp = 1;
    h.ai.goal = { type: 'service', buildingId: INF };
    h.ai.phase = 'act';
    servicesSystem.update(ctx);
    expect(h.insideBuildingId).toBe(INF);
    expect(lineStock(ctx.world, lineKey('supply', INF))).toBe(cap - 1);
    expect(ctx.world.stats.supplyUsed).toBe(1);
  });

  it('out of stock: the AI skips the service, an arrival is turned away unpaid, and resting still regenerates', () => {
    const ctx = makeCtx();
    line(ctx.world, 'supply', REST).stock = {};
    const b = config.index.buildings.get(REST)!;
    expect(serviceInStock(ctx.world, b)).toBe(false);
    const h = addHunter(ctx, { gold: 1000 });
    h.needs.satiety = 5;
    const goals = scoreGoals(config, nav, ctx.world, h);
    expect(goals.some((c) => c.goal.type === 'service' && c.goal.buildingId === REST)).toBe(false);
    expect(goals.some((c) => c.goal.type === 'wander')).toBe(true);
    h.ai.goal = { type: 'service', buildingId: REST };
    h.ai.phase = 'act';
    servicesSystem.update(ctx);
    expect(h.ai.goal).toBeNull();
    expect(h.insideBuildingId).toBeNull();
    expect(h.gold).toBe(1000);
    expect(ctx.world.stats.serviceStockouts).toBe(1);
    // The stockout timer runs while the line is empty and the building works.
    tick(ctx, 10);
    expect(line(ctx.world, 'supply', REST).stockoutMs).toBe(1000);
    expect(ctx.world.stats.supplyStockoutMs).toBe(1000);
  });

  it('produces the essential tier from storage: materials taken at start, units after craftSec', () => {
    const ctx = makeCtx();
    const l = line(ctx.world, 'supply', REST);
    l.stock = {};
    const r = tierFor(lineRecipes(config, 'supply', REST), 1)!;
    for (const m of r.materials) ctx.world.town.storage[m.materialId] = m.count;
    tick(ctx, 1);
    expect(l.job?.consumableId).toBe(r.id);
    for (const m of r.materials) expect(ctx.world.town.storage[m.materialId] ?? 0).toBe(0);
    tick(ctx, Math.ceil(r.craftSec * 10));
    expect(l.stock[r.id]).toBe(r.units);
    expect(ctx.world.stats.supplyProduced).toBe(r.units);
  });

  it('the essential tier follows the median hunter level', () => {
    const ctx = makeCtx();
    for (let i = 0; i < 3; i++) addHunter(ctx, { level: 60 });
    addHunter(ctx, { level: 2 });
    line(ctx.world, 'supply', REST).stock = {};
    const want = tierFor(lineRecipes(config, 'supply', REST), 60)!;
    expect(want.minLevel).toBeGreaterThan(1);
    const need = supplyMaterialNeed(config, ctx.world);
    for (const m of want.materials) expect(need[m.materialId]).toBeGreaterThanOrEqual(m.count);
  });

  it('requests essential materials even with auto-craft off, and the Trading Post buys them first when gold is short', () => {
    const ctx = makeCtx();
    ctx.world.town.autoCraft = false;
    ctx.world.town.autoInvest = false;
    line(ctx.world, 'supply', INF).stock = {};
    const r = lineRecipes(config, 'supply', INF)[0]!;
    const mat = r.materials[0]!.materialId;
    expect(autoMaterialDemand(config, ctx.world)[mat]).toBeGreaterThan(0);
    expect(baseMaterialNeed(config, ctx.world)[mat]).toBeUndefined();
    // A bag with an earlier-id material: the essential one still sells first.
    const other = 'mat.aaa';
    expect(sellOrder(config, ctx.world, { [other]: 1, [mat]: 1 })[0]).toBe(mat);
    const h = addHunter(ctx);
    h.bag = { [mat]: 50, 'mat.core': 5 };
    ctx.world.town.requests = { 'mat.core': 5 };
    ctx.world.town.gold = 4 * (config.index.materials.get(mat)!.price);
    h.ai.goal = { type: 'sell' };
    h.ai.phase = 'act';
    economySystem.update(ctx);
    expect(ctx.world.town.storage[mat]).toBe(4); // all the gold went to the essential material
    expect(ctx.world.town.storage['mat.core'] ?? 0).toBe(0);
  });

  it('a fallback tier only uses storage the crafting/investment requests do not need', () => {
    const ctx = makeCtx();
    for (let i = 0; i < 4; i++) addHunter(ctx, { level: 20 });
    const recipes = lineRecipes(config, 'supply', REST);
    const essential = tierFor(recipes, 20)!;
    const low = recipes[0]!;
    expect(low.id).not.toBe(essential.id);
    line(ctx.world, 'supply', REST).stock = {};
    const mat = low.materials[0]!.materialId;
    const reserved = baseMaterialNeed(config, ctx.world)[mat] ?? 0;
    ctx.world.town.storage[mat] = reserved + low.materials[0]!.count - 1;
    expect(pickRecipe(config, ctx.world, 'supply', config.index.buildings.get(REST)!)).toBeNull();
    ctx.world.town.storage[mat] = reserved + low.materials[0]!.count;
    expect(pickRecipe(config, ctx.world, 'supply', config.index.buildings.get(REST)!)?.id).toBe(low.id);
  });

  it('full stock requests nothing; building level raises the cap', () => {
    const ctx = makeCtx();
    expect(supplyMaterialNeed(config, ctx.world)).toEqual({});
    setLevel(ctx.world, REST, 3);
    const cap3 = config.index.buildings.get(REST)!.supplyCap![2]!;
    expect(cap3).toBeGreaterThan(config.index.buildings.get(REST)!.supplyCap![0]!);
    expect(Object.keys(supplyMaterialNeed(config, ctx.world)).length).toBeGreaterThan(0);
  });
});

describe('potions', () => {
  function shopCtx(): SystemContext & { events: EventBuffer } {
    const ctx = makeCtx();
    setLevel(ctx.world, config.index.townHall, f.potionTownHallLevel);
    const t = potionTiers(config);
    line(ctx.world, 'potion', INF).stock = { [t[0]!.id]: 10, [t[1]!.id]: 10, [t[2]!.id]: 10 };
    return ctx;
  }

  it('are sold only from potionTownHallLevel', () => {
    const ctx = makeCtx();
    line(ctx.world, 'potion', INF).stock = { [potionTiers(config)[0]!.id]: 10 };
    const h = addHunter(ctx, { gold: 1000 });
    expect(bestPotionPurchase(config, ctx.world, h)).toBeNull();
    setLevel(ctx.world, config.index.townHall, f.potionTownHallLevel);
    expect(bestPotionPurchase(config, ctx.world, h)?.count).toBe(f.potionCarryMax);
  });

  it('price scales with the tier and the hunter level', () => {
    const [t1, t2] = potionTiers(config);
    const h = { level: t1!.minLevel } as Hunter;
    expect(potionPrice(config, h, t1!)).toBe(t1!.price);
    const hi = { level: t1!.minLevel + 10 } as Hunter;
    expect(potionPrice(config, hi, t1!)).toBe(Math.round(t1!.price! * (1 + f.potionPriceLevelPct / 10)));
    expect(t2!.price!).toBeGreaterThan(t1!.price!);
  });

  it('buy: own tier, carry limit, spend cap, in-stock lower tier; Town gets the fee cut', () => {
    const ctx = shopCtx();
    const t = potionTiers(config);
    const h = addHunter(ctx, { level: t[1]!.minLevel, gold: 10000 });
    const buy = bestPotionPurchase(config, ctx.world, h)!;
    expect(buy.consumable.id).toBe(t[1]!.id);
    expect(buy.count).toBe(f.potionCarryMax);
    const town0 = ctx.world.town.gold;
    buyPotions(ctx, h);
    const paid = buy.count * buy.price;
    expect(h.gold).toBe(10000 - paid);
    expect(ctx.world.town.gold - town0).toBe(Math.round(paid * f.feeTownShare));
    expect(h.potions![t[1]!.id]).toBe(f.potionCarryMax);
    expect(bestPotionPurchase(config, ctx.world, h)).toBeNull(); // pack full
    // Own tier sold out → the tier below.
    const h2 = addHunter(ctx, { level: t[1]!.minLevel, gold: 10000 });
    delete line(ctx.world, 'potion', INF).stock[t[1]!.id];
    expect(bestPotionPurchase(config, ctx.world, h2)?.consumable.id).toBe(t[0]!.id);
    // Spend cap: potionSpendFrac × gold must pay for one.
    const poor = addHunter(ctx, { level: t[0]!.minLevel, gold: Math.floor(t[0]!.price! / f.potionSpendFrac) - 1 });
    expect(bestPotionPurchase(config, ctx.world, poor)).toBeNull();
  });

  it('the AI offers buyPotion in town and the goal is carried out at the Infirmary door', () => {
    const ctx = shopCtx();
    const h = addHunter(ctx, { gold: 5000 });
    const c = scoreGoals(config, nav, ctx.world, h).find((x) => x.goal.type === 'buyPotion');
    expect(c?.score).toBeCloseTo(f.potionBuyScore, 5);
    h.ai.goal = c!.goal;
    h.ai.phase = 'act';
    consumablesSystem.update(ctx);
    expect(h.ai.goal).toBeNull();
    expect(ctx.world.stats.potionsBought).toBe(f.potionCarryMax);
  });

  it('drinks in the field under the drink line, which is above the backstop and kill-boundary lines', () => {
    const ctx = shopCtx();
    const t = potionTiers(config);
    const h = addHunter(ctx, { level: 20, potions: { [t[1]!.id]: 2 } });
    placeInZone(h, 'zone.meadow');
    const max = needMax(config, h, 'hp');
    const line = potionDrinkLine(config, nav, ctx.world, h);
    expect(line).toBeLessThan(0.9);
    expect(line).toBeGreaterThanOrEqual(f.potionUseHpFrac);
    expect(line).toBeGreaterThanOrEqual(Math.max(urgentThreshold(config, h, 'hp'), retreatHpFloor(config, nav, ctx.world, h)));
    // Any HP at which the kill boundary would send the hunter home is under the drink line (capped at 0.95: above that a
    // potion cannot help, the zone is simply too hard).
    for (let frac = 0.05; frac < 0.949; frac += 0.05) {
      h.needs.hp = frac * max;
      if (shouldRetreatBeforeNextKill(config, nav, ctx.world, h, 'zone.meadow')) expect(frac).toBeLessThan(line);
    }
    h.needs.hp = Math.min(0.95, line + 0.02) * max;
    expect(maybeDrink(ctx, h)).toBe(false);
    h.needs.hp = 0.2 * max;
    potionUseSystem.update(ctx);
    expect(h.needs.hp).toBeCloseTo(Math.min(max, (0.2 + t[1]!.heal!) * max), 5);
    expect(h.potions![t[1]!.id]).toBe(1);
    expect(h.potionCdMs).toBe(f.potionCooldownSec * 1000);
    // Cooldown, then in town: no drinking.
    h.needs.hp = 0.1 * max;
    expect(maybeDrink(ctx, h)).toBe(false);
    h.potionCdMs = 0;
    const sq = nav.node(config.index.squareNode);
    h.nodeId = sq.id;
    h.position = { x: sq.x, y: sq.y };
    expect(maybeDrink(ctx, h)).toBe(false);
    expect(ctx.world.stats.potionsUsed).toBe(1);
  });
});

describe('revive fee', () => {
  it('scales with level, is paid at revive above the Infirmary price, Town gets the fee cut', () => {
    const ctx = makeCtx();
    const h = addHunter(ctx, { level: 30, gold: 5000 });
    const fee = reviveFee(config, h);
    expect(fee).toBe(Math.round(f.reviveFeeBase + f.reviveFeePerLevel * 29));
    expect(reviveDelayMs(config, ctx.world, h)).toBe(f.reviveSec * 1000);
    h.deadMs = 100;
    h.ai.goal = { type: 'dead' };
    const town0 = ctx.world.town.gold;
    combatSystem.update(ctx);
    expect(h.deadMs).toBe(0);
    expect(h.gold).toBe(5000 - fee);
    expect(ctx.world.town.gold - town0).toBe(Math.round(fee * f.feeTownShare));
    expect(ctx.world.stats.reviveFees).toBe(fee);
    const ev = ctx.events.drain().find((e) => e.type === 'hunterRevived');
    expect(ev).toMatchObject({ fee });
  });

  it('a broke hunter keeps its Infirmary price, pays the rest and waits reviveBrokeDelayMul longer', () => {
    const ctx = makeCtx();
    const h = addHunter(ctx, { level: 30, gold: 0 });
    const keep = servicePrice(config, h, config.index.buildings.get(INF)!, 1);
    h.gold = keep + 10;
    expect(reviveDelayMs(config, ctx.world, h)).toBe(f.reviveSec * 1000 * f.reviveBrokeDelayMul);
    h.deadMs = 100;
    h.ai.goal = { type: 'dead' };
    combatSystem.update(ctx);
    expect(h.gold).toBe(keep);
    expect(ctx.world.stats.reviveFees).toBe(10);
    expect(ctx.world.stats.reviveBroke).toBe(1);
  });
});

describe('migration v9 → v11 (→ v12)', () => {
  it('adds full supply lines, empty potion packs (journey hunters too) and zero stats', () => {
    const s = new Simulation(config, createWorld(config, 3));
    for (let i = 0; i < 4; i++) s.enqueue({ type: 'debug.spawnHunter' });
    for (let i = 0; i < 600; i++) s.step();
    const w = JSON.parse(JSON.stringify(s.world)) as Record<string, any>;
    delete w.town.supply;
    const away = JSON.parse(JSON.stringify(w.hunters.pop()));
    w.journeys = [{ id: 'j1', journeyId: config.journeys[0]!.id, difficultyId: 'diff.easy', hunters: [away], teamPower: 1, successChance: 0.5, durationMs: 1000, remainingMs: 1000, startedAtMs: 0, cost: 0 }];
    for (const h of [...w.hunters, away, ...w.journeys[0].hunters]) { delete h.potions; delete h.potionCdMs; }
    for (const k of ['supplyProduced', 'supplyUsed', 'serviceStockouts', 'supplyStockoutMs', 'potionsProduced', 'potionsBought', 'potionsUsed', 'potionGold', 'reviveFees', 'reviveBroke']) delete w.stats[k];
    w.schemaVersion = 9;
    setLevel(w as World, INF, 3);
    const r = deserialize(JSON.stringify({ format: SAVE_FORMAT, schemaVersion: 9, configVersion: config.version, savedAt: 0, world: w }), config);
    expect(WORLD_SCHEMA_VERSION).toBe(14);
    expect(r.migratedFrom).toBe(9);
    const m = r.world;
    expect(m.schemaVersion).toBe(14);
    expect(lineStock(m, lineKey('supply', INF))).toBe(config.index.buildings.get(INF)!.supplyCap![2]);
    expect(lineStock(m, lineKey('supply', REST))).toBe(config.index.buildings.get(REST)!.supplyCap![0]);
    expect(lineStock(m, lineKey('potion', INF))).toBe(0);
    for (const h of m.hunters) expect(h.potions).toEqual({});
    expect(m.journeys[0]!.hunters[0]!.potions).toEqual({});
    expect(m.stats).toMatchObject({ supplyProduced: 0, potionsBought: 0, reviveFees: 0, supplyStockoutMs: 0 });
    // Keeps running.
    const s2 = new Simulation(config, m);
    for (let i = 0; i < 100; i++) s2.step();
  });

  it('a current-version save without supply lines (placeholder v10 → v11 build) gets them at load', () => {
    const w = JSON.parse(JSON.stringify(createWorld(config, 1))) as Record<string, any>;
    delete w.town.supply;
    const r = deserialize(JSON.stringify({ format: SAVE_FORMAT, schemaVersion: WORLD_SCHEMA_VERSION, configVersion: config.version, savedAt: 0, world: w }), config);
    expect(r.migratedFrom).toBeNull();
    expect(lineStock(r.world, lineKey('supply', INF))).toBe(config.index.buildings.get(INF)!.supplyCap![0]);
  });

  it('is idempotent: existing supply lines and packs win', () => {
    const w = JSON.parse(JSON.stringify(createWorld(config, 1))) as Record<string, any>;
    w.town.supply[lineKey('supply', INF)].stock = { x: 3 };
    w.schemaVersion = 10;
    const r = deserialize(JSON.stringify({ format: SAVE_FORMAT, schemaVersion: 10, configVersion: config.version, savedAt: 0, world: w }), config);
    expect(r.world.town.supply[lineKey('supply', INF)]!.stock).toEqual({ x: 3 });
  });
});

describe('integration', () => {
  it('a 3-hour town keeps services stocked from storage and sells/drinks potions', () => {
    // Potions from Town Hall 2 here so a short run sees them (live config opens them later, potionTownHallLevel).
    const cfg = makeConfig((raw) => { raw.formula_params.potionTownHallLevel = 2; });
    const s = new Simulation(cfg, createWorld(cfg, 1));
    for (let i = 0; i < f.hunterSlots; i++) s.enqueue({ type: 'debug.spawnHunter' });
    for (let i = 0; i < 3 * 3600 * 10; i++) s.step();
    const st = s.world.stats;
    expect(st.supplyProduced).toBeGreaterThan(0);
    expect(st.supplyUsed).toBe(st.serviceUses);
    expect(st.potionsBought).toBeGreaterThan(0);
    expect(st.potionsUsed).toBeGreaterThan(0);
    // Stockouts stay short: under 5 % of service time.
    expect(st.supplyStockoutMs).toBeLessThan(0.05 * 4 * 3 * 3600 * 1000);
  }, 120000);
});
