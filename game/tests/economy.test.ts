import { applyCommand } from '../src/core/commands';
import type { GameConfig } from '../src/core/config/types';
import { EventBuffer, type SimEvent } from '../src/core/events';
import { hunterStats } from '../src/core/formulas';
import { rollHunter } from '../src/core/hunterFactory';
import { NavGraph } from '../src/core/pathfinding';
import { Rng } from '../src/core/rng';
import { createWorld, Simulation } from '../src/core/simulation';
import type { SystemContext } from '../src/core/system';
import { craftingSystem, startCraft } from '../src/core/systems/crafting';
import { canBuy, economySystem, enhanceCost } from '../src/core/systems/economy';
import type { Goal, Hunter, ShopItem, World } from '../src/core/world';
import { testConfig } from './helpers';

const config = testConfig();
const nav = new NavGraph(config);

function makeCtx(cfg: GameConfig = config, seed = 1): SystemContext & { events: EventBuffer } {
  return {
    world: createWorld(cfg, seed), config: cfg, nav, rng: new Rng(seed),
    events: new EventBuffer(), debug: { aiScores: new Map() }, dtMs: 100,
  };
}

function addHunter(ctx: SystemContext, patch: Partial<Hunter> = {}): Hunter {
  const h = rollHunter(ctx.config, new Rng(7), 'h' + ctx.world.hunters.length, config.index.squareNode, { x: 0, y: 0 }, 0);
  Object.assign(h, patch);
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

function withEnhance(successRate: number): GameConfig {
  return { ...config, enhance: config.enhance.map((r) => ({ ...r, successRate })) };
}

function shopItem(world: World, gearId: string, price: number): ShopItem {
  const it: ShopItem = { uid: 'g' + world.nextId++, gearId, qualityId: 'q.rare', enhance: 0, price, listPrice: price, listedAtMs: world.timeMs };
  world.town.shop.push(it);
  return it;
}

describe('selling', () => {
  it('sells requested units in materialId order limited by town gold and moves them to storage', () => {
    const ctx = makeCtx({ ...config, formula: { ...config.formula, tradeSaleTax: 0 } });
    ctx.world.town.autoCraft = false; // only the player requests below
    ctx.world.town.requests = { 'mat.gel': 5, 'mat.hide': 3 };
    const h = addHunter(ctx, { gold: 0, bag: { 'mat.hide': 3, 'mat.gel': 5 } }); // gel 4g, hide 8g
    ctx.world.town.gold = 30;
    arrive(h, { type: 'sell' });
    economySystem.update(ctx);
    // gel first: 5×4 = 20, then 10 left → 1 hide (8); the 2 unaffordable hides are requested, so they stay in the bag.
    expect(h.gold).toBe(28);
    expect(ctx.world.town.gold).toBe(2);
    expect(h.bag).toEqual({ 'mat.hide': 2 });
    expect(ctx.world.town.storage).toEqual({ 'mat.gel': 5, 'mat.hide': 1 });
    expect(ctx.world.town.requests).toEqual({ 'mat.hide': 2 });
    expect(ctx.world.stats.materialsSold).toBe(6);
    expect(ofType(ctx.events.drain(), 'materialsSold')).toMatchObject([{ hunterId: h.id, units: 6, gold: 28 }]);
    expect(h.ai.goal).toBeNull();
    expect(h.ai.forced).toBe(false);
  });

  it('does nothing while travelling', () => {
    const ctx = makeCtx();
    const h = addHunter(ctx, { bag: { 'mat.gel': 1 } });
    arrive(h, { type: 'sell' });
    h.ai.phase = 'travel';
    economySystem.update(ctx);
    expect(h.bag).toEqual({ 'mat.gel': 1 });
    expect(h.ai.goal).toEqual({ type: 'sell' });
  });
});

describe('buying', () => {
  it('buys, equips (dropping price), pays the town and replaces the old item without healing', () => {
    const ctx = makeCtx();
    const h = addHunter(ctx, { gold: 100, level: 1 });
    h.equipment.accessory = { uid: 'old', gearId: 'gear.r.charm', qualityId: 'q.common', enhance: 0 };
    h.needs.hp = 10;
    const town0 = ctx.world.town.gold;
    const it = shopItem(ctx.world, 'gear.r.charm', 70);
    expect(canBuy(config, h, it)).toBe(true);
    arrive(h, { type: 'shop', itemUid: it.uid });
    economySystem.update(ctx);
    expect(h.gold).toBe(30);
    expect(ctx.world.town.gold).toBe(town0 + 70);
    expect(ctx.world.town.shop).toHaveLength(0);
    expect(h.equipment.accessory).toEqual({ uid: it.uid, gearId: 'gear.r.charm', qualityId: 'q.rare', enhance: 0 });
    expect(h.needs.hp).toBe(10);
    expect(ctx.world.stats.gearBought).toBe(1);
    expect(ofType(ctx.events.drain(), 'gearBought')).toMatchObject([{ itemUid: it.uid, price: 70 }]);
    expect(h.ai.goal).toBeNull();
  });

  it('fails when the item is gone, level too low, or gold too low', () => {
    const ctx = makeCtx();
    const h = addHunter(ctx, { gold: 1000, level: 1 });
    const town0 = ctx.world.town.gold;

    arrive(h, { type: 'shop', itemUid: 'nope' });
    economySystem.update(ctx);
    expect(h.ai.goal).toBeNull();

    const high = shopItem(ctx.world, 'gear.w.iron', 500); // level 8
    expect(canBuy(config, h, high)).toBe(false);
    arrive(h, { type: 'shop', itemUid: high.uid });
    economySystem.update(ctx);
    expect(h.equipment.weapon).toBeUndefined();
    expect(h.ai.goal).toBeNull();
    expect(h.ai.forced).toBe(false);

    h.gold = 10;
    const club = shopItem(ctx.world, 'gear.w.club', 60);
    arrive(h, { type: 'shop', itemUid: club.uid });
    economySystem.update(ctx);
    expect(h.equipment.weapon).toBeUndefined();
    expect(h.gold).toBe(10);
    expect(ctx.world.town.gold).toBe(town0);
    expect(ctx.world.town.shop).toHaveLength(2);
    expect(ctx.world.stats.gearBought).toBe(0);
  });
});

describe('enhancing', () => {
  function setup(cfg: GameConfig, enhance: number, gold = 10_000) {
    const ctx = makeCtx(cfg);
    const h = addHunter(ctx, { gold });
    h.equipment.weapon = { uid: 'w', gearId: 'gear.w.club', qualityId: 'q.rare', enhance }; // basePrice 60
    arrive(h, { type: 'enhance', slot: 'weapon' });
    return { ctx, h };
  }

  it('success raises the level, charges round(basePrice × costFrac), town gets only its feeTownShare cut', () => {
    const { ctx, h } = setup(withEnhance(1), 2);
    const cost = enhanceCost(config, h.equipment.weapon!)!;
    expect(cost).toBe(Math.round(60 * config.enhance[2]!.costFrac));
    const town0 = ctx.world.town.gold;
    economySystem.update(ctx);
    expect(h.equipment.weapon!.enhance).toBe(3);
    expect(h.gold).toBe(10_000 - cost);
    expect(ctx.world.town.gold).toBe(town0 + Math.round(cost * config.formula.feeTownShare));
    expect(ctx.world.stats).toMatchObject({ enhanceTries: 1, enhanceSuccess: 1 });
    expect(ofType(ctx.events.drain(), 'enhanceResult')).toMatchObject([{ success: true, level: 3, cost, slot: 'weapon' }]);
    expect(h.ai.goal).toBeNull();
  });

  it('failure below +10 keeps the level', () => {
    const { ctx, h } = setup(withEnhance(0), 3);
    economySystem.update(ctx);
    expect(h.equipment.weapon!.enhance).toBe(3);
    expect(ctx.world.stats).toMatchObject({ enhanceTries: 1, enhanceSuccess: 0 });
  });

  it('failure on a dropOnFail step drops one level, never destroys the gear', () => {
    const { ctx, h } = setup(withEnhance(0), 11);
    expect(config.enhance[11]!.dropOnFail).toBe(true);
    economySystem.update(ctx);
    expect(h.equipment.weapon).toBeDefined();
    expect(h.equipment.weapon!.enhance).toBe(10);
  });

  it('maxed gear, empty slot or too little gold does nothing but clears the goal', () => {
    const max = config.enhance.length;
    const { ctx, h } = setup(withEnhance(1), max);
    expect(enhanceCost(config, h.equipment.weapon!)).toBeNull();
    const gold0 = h.gold;
    economySystem.update(ctx);
    expect(h.equipment.weapon!.enhance).toBe(max);
    expect(h.gold).toBe(gold0);
    expect(h.ai.goal).toBeNull();

    arrive(h, { type: 'enhance', slot: 'armor' });
    economySystem.update(ctx);
    expect(h.ai.goal).toBeNull();

    const poor = setup(withEnhance(1), 0, 1);
    economySystem.update(poor.ctx);
    expect(poor.h.equipment.weapon!.enhance).toBe(0);
    expect(poor.ctx.world.stats.enhanceTries).toBe(0);
    expect(ctx.world.stats.enhanceTries).toBe(0);
  });
});

describe('crafting', () => {
  const capacity = config.index.buildings.get(config.index.shop)!.capacity!;

  it('a finished job becomes a shop item with a rolled quality and price', () => {
    const ctx = makeCtx();
    ctx.world.town.autoCraft = false;
    ctx.world.town.crafting['bld.smithy'] = { gearId: 'gear.w.club', remainingMs: 150 };
    craftingSystem.update(ctx);
    expect(ctx.world.town.crafting['bld.smithy']!.remainingMs).toBe(50);
    craftingSystem.update(ctx);
    expect(ctx.world.town.crafting['bld.smithy']).toBeNull();
    expect(ctx.world.town.shop).toHaveLength(1);
    const it = ctx.world.town.shop[0]!;
    const q = config.index.qualities.get(it.qualityId)!;
    expect(q).toBeDefined();
    expect(it).toMatchObject({ gearId: 'gear.w.club', enhance: 0, price: Math.round(60 * q.priceMult) });
    expect(it.uid).toMatch(/^g\d+$/);
    expect(ctx.world.stats.crafted).toBe(1);
    expect(ofType(ctx.events.drain(), 'gearCrafted')).toMatchObject([{ buildingId: 'bld.smithy', itemUid: it.uid }]);
  });

  it('holds a finished job while the shop is full', () => {
    const ctx = makeCtx();
    ctx.world.town.autoCraft = false;
    for (let i = 0; i < capacity; i++) shopItem(ctx.world, 'gear.w.club', 60);
    ctx.world.town.crafting['bld.smithy'] = { gearId: 'gear.w.club', remainingMs: 100 };
    craftingSystem.update(ctx);
    craftingSystem.update(ctx);
    expect(ctx.world.town.crafting['bld.smithy']).not.toBeNull();
    expect(ctx.world.town.shop).toHaveLength(capacity);
    ctx.world.town.shop.pop();
    craftingSystem.update(ctx);
    expect(ctx.world.town.crafting['bld.smithy']).toBeNull();
    expect(ctx.world.town.shop).toHaveLength(capacity);
  });

  it('treats a missing crafting entry (old save) as idle', () => {
    const ctx = makeCtx();
    addHunter(ctx, { level: 1 }); // empty accessory slot → a charm is worth crafting
    delete ctx.world.town.crafting['bld.jeweler'];
    ctx.world.town.crafting['bld.smithy'] = { gearId: 'gear.w.club', remainingMs: 99_999 }; // keep smithy off the gel
    ctx.world.town.storage = { 'mat.gel': 5 };
    craftingSystem.update(ctx);
    expect(ctx.world.town.crafting['bld.jeweler']).toEqual({ gearId: 'gear.r.charm', remainingMs: 20_000 });
  });

  it('auto-craft skips recipes already covered by the shop, consumes materials and town gold', () => {
    const ctx = makeCtx();
    addHunter(ctx, { level: 1 });
    // smithy can make club (4 gel) and padded (3 gel + 1 hide); tusk gear is level 4 (> 1 + ahead?).
    ctx.world.town.storage = { 'mat.gel': 7, 'mat.hide': 1, 'mat.tusk': 3 };
    shopItem(ctx.world, 'gear.w.club', 60); // a Rare club already on sale covers the weapon slot → padded
    const gold0 = ctx.world.town.gold;
    craftingSystem.update(ctx);
    expect(ctx.world.town.crafting['bld.smithy']).toEqual({ gearId: 'gear.a.padded', remainingMs: 20_000 });
    expect(ctx.world.town.gold).toBe(gold0 - Math.round(60 * config.formula.craftGoldFrac));
    expect(ctx.world.town.storage).toEqual({ 'mat.gel': 4, 'mat.tusk': 3 });
    // jeweler: charm needs 5 gel (only 4 left), fang needs level 5 → nothing.
    expect(ctx.world.town.crafting['bld.jeweler']).toBeNull();
    expect(ofType(ctx.events.drain(), 'craftStarted')).toMatchObject([{ buildingId: 'bld.smithy', gearId: 'gear.a.padded' }]);
  });

  it('auto-craft respects the level cap and autoCraft=false', () => {
    const ctx = makeCtx();
    addHunter(ctx, { level: 1, gold: 1000 }); // enough gold to count as a buyer (craftAffordFrac)
    ctx.world.town.storage = { 'mat.ore': 10, 'mat.core': 5 }; // only level 8-9 recipes
    craftingSystem.update(ctx);
    expect(ctx.world.town.crafting['bld.smithy']).toBeNull();
    ctx.world.hunters[0]!.level = 8;
    ctx.world.town.autoCraft = false;
    craftingSystem.update(ctx);
    expect(ctx.world.town.crafting['bld.smithy']).toBeNull();
    ctx.world.town.autoCraft = true;
    craftingSystem.update(ctx);
    // iron (lv 8) and plate (lv 8) both affordable, none on sale → tie on level → gearId order.
    expect(ctx.world.town.crafting['bld.smithy']!.gearId).toBe('gear.a.plate');
  });

  it('counts running jobs against shop capacity', () => {
    const ctx = makeCtx();
    for (let i = 0; i < capacity - 1; i++) shopItem(ctx.world, 'gear.w.club', 60);
    ctx.world.town.crafting['bld.jeweler'] = { gearId: 'gear.r.charm', remainingMs: 99_999 };
    ctx.world.town.storage = { 'mat.gel': 10 };
    expect(startCraft(ctx, 'bld.smithy', 'gear.w.club')).toBe('shop is full');
  });
});

describe('town commands', () => {
  it('town.craft rejects bad requests and starts a valid one', () => {
    const ctx = makeCtx();
    ctx.world.town.storage = { 'mat.gel': 4 };
    const reasons = (cmd: Parameters<typeof applyCommand>[1]) => {
      applyCommand(ctx, cmd);
      return ofType(ctx.events.drain(), 'commandRejected').map((e) => e.reason);
    };
    expect(reasons({ type: 'town.craft', buildingId: 'bld.nope', gearId: 'gear.w.club' })).toEqual(['unknown building']);
    expect(reasons({ type: 'town.craft', buildingId: 'bld.shop', gearId: 'gear.w.club' })).toEqual(['not a craft building']);
    expect(reasons({ type: 'town.craft', buildingId: 'bld.jeweler', gearId: 'gear.w.club' })).toEqual(['gear not made here']);
    expect(reasons({ type: 'town.craft', buildingId: 'bld.smithy', gearId: 'gear.a.hide' })).toEqual(['missing materials']);
    const cost = Math.round(60 * config.formula.craftGoldFrac);
    ctx.world.town.gold = cost - 1;
    expect(reasons({ type: 'town.craft', buildingId: 'bld.smithy', gearId: 'gear.w.club' })).toEqual(['not enough town gold']);
    expect(ctx.world.town.storage).toEqual({ 'mat.gel': 4 });
    ctx.world.town.gold = cost; // manual craft needs only the cost, not the auto-craft reserve
    expect(reasons({ type: 'town.craft', buildingId: 'bld.smithy', gearId: 'gear.w.club' })).toEqual([]);
    expect(ctx.world.town.crafting['bld.smithy']).toEqual({ gearId: 'gear.w.club', remainingMs: 20_000 });
    expect(ctx.world.town.storage).toEqual({});
    expect(ctx.world.town.gold).toBe(0);
    expect(reasons({ type: 'town.craft', buildingId: 'bld.smithy', gearId: 'gear.w.club' })).toEqual(['building is busy']);
  });

  it('town.setAutoCraft toggles the flag through the simulation queue', () => {
    const sim = new Simulation(config, createWorld(config, 3));
    sim.enqueue({ type: 'town.setAutoCraft', on: false });
    sim.step();
    expect(sim.world.town.autoCraft).toBe(false);
    sim.enqueue({ type: 'town.setAutoCraft', on: true });
    sim.step();
    expect(sim.world.town.autoCraft).toBe(true);
  });
});

describe('hp after buying', () => {
  it('clamps current hp if the new max is lower', () => {
    const ctx = makeCtx();
    const h = addHunter(ctx, { gold: 1000, level: 9 });
    h.equipment.accessory = { uid: 'big', gearId: 'gear.r.core', qualityId: 'q.mythic', enhance: 0 };
    h.needs.hp = hunterStats(config, h).hp;
    const it = shopItem(ctx.world, 'gear.r.charm', 70);
    arrive(h, { type: 'shop', itemUid: it.uid });
    economySystem.update(ctx);
    expect(h.needs.hp).toBe(hunterStats(config, h).hp);
  });
});
