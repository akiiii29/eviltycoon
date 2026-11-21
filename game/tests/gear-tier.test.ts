/**
 * Gear tiers per difficulty, reclaim on reincarnation, Town gear storage, dismantle, auto difficulty (TECH_SPEC §5.8).
 */
import { describe, expect, it } from 'vitest';
import type { FormulaParams, GameConfig, GearSlot } from '../src/core/config/types';
import { EventBuffer, type SimEvent } from '../src/core/events';
import { gearMainValue, hunterStats } from '../src/core/formulas';
import { rollHunter } from '../src/core/hunterFactory';
import { NavGraph } from '../src/core/pathfinding';
import { Rng } from '../src/core/rng';
import { deserialize, SAVE_FORMAT } from '../src/core/save/save';
import { createWorld, Simulation } from '../src/core/simulation';
import type { SystemContext } from '../src/core/system';
import {
  autoListStoredGear, craftGoldCost, craftingSystem, dismantleYield, gearListPrice, pickCraft, reclaimGear, startCraft, storedGearBuyers,
} from '../src/core/systems/crafting';
import { autoAdvanceDifficulty, craftTiers, dropEssence, essenceCount, recipeMaterials } from '../src/core/systems/gearTier';
import { reincarnate } from '../src/core/systems/progression';
import { autoMaterialDemand } from '../src/core/systems/trading';
import { WORLD_SCHEMA_VERSION, type GearInstance, type Hunter, type Monster, type World } from '../src/core/world';
import { testConfig } from './helpers';

const base = testConfig();
const nav = new NavGraph(base);
const EASY = 'diff.easy';
const NORMAL = 'diff.normal';
const normal = base.index.difficulties.get(NORMAL)!;

function cfg(patch: Partial<FormulaParams> = {}): GameConfig {
  return {
    ...base,
    formula: { ...base.formula, craftAffordFrac: 0, craftMinSellChance: 0.35, minUpgradeGain: 0.12, craftLevelAhead: 2, ...patch },
  };
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

function equip(h: Hunter, slot: GearSlot, g: Omit<GearInstance, 'uid'>, uid = 'e-' + h.id + '-' + slot): GearInstance {
  const it = { uid, ...g };
  h.equipment[slot] = it;
  return it;
}

const ofType = <T extends SimEvent['type']>(evs: SimEvent[], t: T) => evs.filter((e) => e.type === t) as Extract<SimEvent, { type: T }>[];
const gear = (id: string) => base.index.gear.get(id)!;

/** Unlock and switch to Normal. */
function goNormal(world: World): void {
  if (!world.town.unlockedDifficulties.includes(NORMAL)) world.town.unlockedDifficulties.push(NORMAL);
  world.town.difficulty = NORMAL;
}

describe('gear tier stats and recipes', () => {
  it('main value is × the gearStatMul of the difficulty the item was made at (absent / base = ×1)', () => {
    const plain = { uid: 'a', gearId: 'gear.w.star', qualityId: 'q.rare', enhance: 0 };
    const v = gearMainValue(base, plain);
    expect(gearMainValue(base, { ...plain, difficultyId: EASY })).toBe(v);
    expect(gearMainValue(base, { ...plain, difficultyId: NORMAL })).toBeCloseTo(v * normal.gearStatMul!, 9);
    // The tier makes old gear obsolete: a Normal-tier Rare +0 beats an Easy-tier Rare +6 (enhanceStatPerLevel 0.06).
    expect(gearMainValue(base, { ...plain, difficultyId: NORMAL })).toBeGreaterThan(gearMainValue(base, { ...plain, enhance: 6 }) * (1 + base.formula.minUpgradeGain));
  });

  it('hunter stats follow a tier change of the equipped item (stats cache keyed on the tier)', () => {
    const ctx = makeCtx();
    const h = addHunter(ctx, { level: 80 });
    const g = equip(h, 'weapon', { gearId: 'gear.w.star', qualityId: 'q.rare', enhance: 0, difficultyId: EASY });
    const easyAtk = hunterStats(base, h).atk;
    g.difficultyId = NORMAL;
    expect(hunterStats(base, h).atk - easyAtk).toBeCloseTo(gearMainValue(base, g) - gearMainValue(base, { ...g, difficultyId: EASY }), 6);
  });

  it('tier recipes add max(1, round(level × craftEssencePerLevel)) essence; the base tier is the plain recipe', () => {
    const club = gear('gear.w.club');
    const star = gear('gear.w.star');
    expect(recipeMaterials(base, club, EASY)).toEqual(club.materials);
    expect(essenceCount(base, club, NORMAL)).toBe(1);
    expect(essenceCount(base, star, NORMAL)).toBe(Math.round(80 * base.formula.craftEssencePerLevel));
    expect(recipeMaterials(base, star, NORMAL)).toEqual([...star.materials, { materialId: normal.essenceId, count: essenceCount(base, star, NORMAL) }]);
  });

  it('only unlocked difficulties ≤ the current one are craft tiers', () => {
    const ctx = makeCtx();
    expect(craftTiers(base, ctx.world).map((d) => d.id)).toEqual([EASY]);
    ctx.world.town.unlockedDifficulties.push(NORMAL);
    expect(craftTiers(base, ctx.world).map((d) => d.id)).toEqual([EASY]); // unlocked but not played yet
    ctx.world.town.difficulty = NORMAL;
    expect(craftTiers(base, ctx.world).map((d) => d.id)).toEqual([EASY, NORMAL]);
  });
});

describe('tier crafting', () => {
  it('startCraft at a tier needs the tier unlocked and its essence, charges × gearPriceMul, and the item records the tier', () => {
    const ctx = makeCtx();
    const { world } = ctx;
    world.town.autoCraft = false;
    world.town.gold = 10_000;
    world.town.storage['mat.gel'] = 20;
    expect(startCraft(ctx, 'bld.smithy', 'gear.w.club', NORMAL)).toBe('gear tier locked by difficulty');
    expect(startCraft(ctx, 'bld.smithy', 'gear.w.club', 'diff.nope')).toBe('unknown difficulty');
    goNormal(world);
    expect(startCraft(ctx, 'bld.smithy', 'gear.w.club', NORMAL)).toBe('missing materials');
    world.town.storage[normal.essenceId!] = 1;
    const gold = world.town.gold;
    expect(startCraft(ctx, 'bld.smithy', 'gear.w.club', NORMAL)).toBeNull();
    expect(world.town.gold).toBe(gold - craftGoldCost(base, gear('gear.w.club'), NORMAL));
    expect(craftGoldCost(base, gear('gear.w.club'), NORMAL)).toBe(Math.round(60 * base.formula.craftGoldFrac * normal.gearPriceMul!));
    expect(world.town.storage[normal.essenceId!]).toBeUndefined();
    expect(world.town.storage['mat.gel']).toBe(16);
    expect(world.town.crafting['bld.smithy']).toMatchObject({ gearId: 'gear.w.club', difficultyId: NORMAL });
    world.town.crafting['bld.smithy']!.remainingMs = 0;
    world.town.difficulty = EASY; // a later difficulty change does not change a running job
    craftingSystem.update(ctx);
    const it = world.town.shop[0]!;
    expect(it.difficultyId).toBe(NORMAL);
    const q = base.index.qualities.get(it.qualityId)!;
    expect(it.listPrice).toBe(Math.round(60 * q.priceMult * normal.gearPriceMul!));
    expect(ofType(ctx.events.drain(), 'gearCrafted')[0]).toMatchObject({ difficultyId: NORMAL });
  });

  it('auto-craft picks the higher tier when it serves as many hunters, and the Trading Post requests its essence', () => {
    const ctx = makeCtx();
    const { world } = ctx;
    world.town.gold = 50_000;
    for (let i = 0; i < 3; i++) addHunter(ctx, { level: 1, gold: 5_000 });
    goNormal(world);
    // No essence yet: base tier only; the post asks for essence for the Normal tier.
    world.town.storage['mat.gel'] = 40;
    world.town.storage['mat.hide'] = 40;
    expect(pickCraft(ctx, 'bld.smithy')?.difficultyId).toBe(EASY);
    expect(autoMaterialDemand(base, world)[normal.essenceId!]).toBeGreaterThan(0);
    world.town.storage[normal.essenceId!] = 10;
    expect(pickCraft(ctx, 'bld.smithy')).toMatchObject({ difficultyId: NORMAL });
  });
});

describe('essence drops', () => {
  const monster = (difficultyId: string) => ({ id: 'm1', defId: base.monsters[0]!.id, difficultyId }) as unknown as Monster;

  it('only monsters spawned under a difficulty with essence drop it (no RNG draw on Easy)', () => {
    const ctx = makeCtx();
    const h = addHunter(ctx);
    const before = JSON.stringify(ctx.rng.state);
    for (let i = 0; i < 50; i++) dropEssence(ctx, h, monster(EASY));
    expect(JSON.stringify(ctx.rng.state)).toBe(before);
    expect(h.bag).toEqual({});
    for (let i = 0; i < 2000; i++) dropEssence(ctx, h, monster(NORMAL));
    const n = h.bag[normal.essenceId!] ?? 0;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(base.formula.bagCapacity);
  });
});

describe('reclaim', () => {
  it('reincarnation moves every equipped item into Town gear storage with its stats', () => {
    const ctx = makeCtx();
    const h = addHunter(ctx, { level: base.formula.maxLevel });
    equip(h, 'weapon', { gearId: 'gear.w.star', qualityId: 'q.epic', enhance: 6 });
    equip(h, 'armor', { gearId: 'gear.a.star', qualityId: 'q.rare', enhance: 5, difficultyId: NORMAL });
    expect(reincarnate(ctx, h)).toBeNull();
    expect(h.equipment).toEqual({});
    expect(ctx.world.town.gearStorage).toEqual([
      { uid: 'e-h0-weapon', gearId: 'gear.w.star', qualityId: 'q.epic', enhance: 6, difficultyId: EASY },
      { uid: 'e-h0-armor', gearId: 'gear.a.star', qualityId: 'q.rare', enhance: 5, difficultyId: NORMAL },
    ]);
    expect(h.needs.hp).toBeCloseTo(hunterStats(base, h).hp, 6);
    expect(ctx.world.stats.gearReclaimed).toBe(2);
  });

  it('is a no-op on the offline projection stub (a world without a Town)', () => {
    const h = rollHunter(base, new Rng(3), 'x', base.index.squareNode, { x: 0, y: 0 }, 0);
    h.level = base.formula.maxLevel;
    equip(h, 'weapon', { gearId: 'gear.w.club', qualityId: 'q.rare', enhance: 0 });
    const stub = { config: base, world: { tick: 0, stats: { reincarnations: 0 } }, events: new EventBuffer() } as unknown as SystemContext;
    expect(reclaimGear(stub, h)).toBe(0);
    expect(reincarnate(stub, h)).toBeNull();
    expect(h.reincarnation).toBe(1);
  });

  it('hunter.reclaimGear command: only in Town, with gear; HP clamps', () => {
    const s = new Simulation(base, createWorld(base, 2));
    s.enqueue({ type: 'debug.spawnHunter' });
    s.step();
    const h = s.world.hunters[0]!;
    s.world.town.autoCraft = false;
    const field = base.nodes.find((n) => n.zoneId)!;
    const run = (): SimEvent[] => { s.enqueue({ type: 'hunter.reclaimGear', hunterId: h.id }); s.step(); return s.drainEvents(); };
    h.equipment = {};
    expect(ofType(run(), 'commandRejected')[0]).toMatchObject({ reason: 'nothing equipped' });
    equip(h, 'accessory', { gearId: 'gear.r.star', qualityId: 'q.rare', enhance: 0 });
    h.needs.hp = hunterStats(base, h).hp;
    h.nodeId = field.id;
    expect(ofType(run(), 'commandRejected')[0]).toMatchObject({ reason: 'hunter is not in town' });
    h.nodeId = base.index.squareNode;
    h.ai.goal = null;
    const evs = run();
    expect(ofType(evs, 'commandRejected')).toEqual([]);
    expect(ofType(evs, 'gearReclaimed')[0]).toMatchObject({ hunterId: h.id, reason: 'command' });
    expect(h.equipment.accessory).toBeUndefined();
    expect(h.needs.hp).toBeLessThanOrEqual(hunterStats(base, h).hp + 1e-9);
    expect(s.world.town.gearStorage.map((g) => g.gearId)).toEqual(['gear.r.star']);
  });
});

describe('Town gear storage', () => {
  it('auto-lists a stored item only when someone would buy it, at the enhance-scaled price', () => {
    const ctx = makeCtx();
    const { world } = ctx;
    world.town.autoCraft = true;
    const item: GearInstance = { uid: 's1', gearId: 'gear.w.star', qualityId: 'q.rare', enhance: 6, difficultyId: EASY };
    world.town.gearStorage.push(item);
    addHunter(ctx, { level: 1, gold: 100_000 }); // cannot wear an L80 item
    expect(storedGearBuyers(base, world, item)).toBe(0);
    autoListStoredGear(ctx);
    expect(world.town.shop).toEqual([]);
    const buyer = addHunter(ctx, { level: 85, gold: 100_000 });
    equip(buyer, 'weapon', { gearId: 'gear.w.void', qualityId: 'q.rare', enhance: 0 });
    expect(storedGearBuyers(base, world, item)).toBe(1);
    autoListStoredGear(ctx);
    expect(world.town.gearStorage).toEqual([]);
    const price = Math.round(12500 * 1 * (1 + 6 * base.formula.enhanceStatPerLevel));
    expect(gearListPrice(base, item)).toBe(price);
    expect(world.town.shop).toEqual([{ ...item, price, listPrice: price, listedAtMs: world.timeMs }]);
    expect(world.stats.gearRelisted).toBe(1);
  });

  it('storage over gearStorageMax dismantles the oldest; dismantling returns floor(count × frac) incl. essence', () => {
    const ctx = makeCtx(cfg({ gearStorageMax: 1, dismantleReturnFrac: 0.5 }));
    const h = addHunter(ctx, { level: base.formula.maxLevel });
    equip(h, 'weapon', { gearId: 'gear.w.star', qualityId: 'q.rare', enhance: 0, difficultyId: NORMAL });
    equip(h, 'armor', { gearId: 'gear.a.star', qualityId: 'q.rare', enhance: 0 });
    reclaimGear(ctx, h);
    expect(ctx.world.town.gearStorage.map((g) => g.gearId)).toEqual(['gear.a.star']);
    const want = dismantleYield(ctx.config, { uid: '', gearId: 'gear.w.star', qualityId: 'q.rare', enhance: 0, difficultyId: NORMAL });
    // gear.w.star: void 1, shade 3, star 3 + Normal essence 4 → 0 / 1 / 1 / 2
    expect(want).toEqual({ 'mat.shade': 1, 'mat.star': 1, [normal.essenceId!]: 2 });
    expect(ctx.world.town.storage).toEqual(want);
    expect(ofType(ctx.events.drain(), 'gearDismantled')).toMatchObject([{ gearId: 'gear.w.star', source: 'storage', materials: want }]);
    expect(ctx.world.stats.gearDismantled).toBe(1);
  });

  it('town.listGear / town.dismantleGear commands', () => {
    const s = new Simulation(base, createWorld(base, 2));
    s.world.town.autoCraft = false;
    s.world.town.gearStorage.push({ uid: 's1', gearId: 'gear.w.club', qualityId: 'q.rare', enhance: 0, difficultyId: EASY });
    s.world.town.gearStorage.push({ uid: 's2', gearId: 'gear.w.club', qualityId: 'q.rare', enhance: 0, difficultyId: EASY });
    s.enqueue({ type: 'town.listGear', itemUid: 's1' });
    s.enqueue({ type: 'town.dismantleGear', itemUid: 's2' });
    s.enqueue({ type: 'town.dismantleGear', itemUid: 'nope' });
    s.step();
    const evs = s.drainEvents();
    expect(ofType(evs, 'commandRejected').map((e) => e.reason)).toEqual(['unknown stored item']);
    expect(s.world.town.shop.map((i) => i.uid)).toEqual(['s1']);
    expect(s.world.town.gearStorage).toEqual([]);
    expect(s.world.town.storage['mat.gel']).toBe(Math.floor(4 * base.formula.dismantleReturnFrac));
  });
});

describe('auto difficulty', () => {
  it('steps up once ceil(frac × hunters) hunters have the next difficulty reincarnation, never down; manual choice turns it off', () => {
    const ctx = makeCtx(cfg({ diffAutoAdvanceFrac: 0.5 }));
    const { world } = ctx;
    const hs = Array.from({ length: 8 }, () => addHunter(ctx));
    world.town.unlockedDifficulties.push(NORMAL);
    hs.slice(0, 3).forEach((h) => { h.reincarnation = 1; });
    expect(autoAdvanceDifficulty(ctx)).toBeNull(); // 3 < 4
    hs[3]!.reincarnation = 1;
    expect(autoAdvanceDifficulty(ctx)).toBe(NORMAL);
    expect(world.town.difficulty).toBe(NORMAL);
    expect(autoAdvanceDifficulty(ctx)).toBeNull(); // Hard is not unlocked
    world.town.autoDifficulty = false;
    world.town.difficulty = EASY;
    expect(autoAdvanceDifficulty(ctx)).toBeNull();

    const s = new Simulation(base, world);
    s.enqueue({ type: 'town.setAutoDifficulty', on: true });
    s.step();
    expect(world.town.difficulty).toBe(NORMAL); // progression system applies it
    s.enqueue({ type: 'town.setDifficulty', difficultyId: EASY });
    s.step();
    expect(world.town.autoDifficulty).toBe(false);
    expect(world.town.difficulty).toBe(EASY);
  });
});

describe('migration v9 → v10', () => {
  it('gives every existing item the base tier and adds gear storage / auto difficulty / stats', () => {
    const s = new Simulation(base, createWorld(base, 3));
    s.enqueue({ type: 'debug.spawnHunter' });
    s.step();
    const w = JSON.parse(JSON.stringify(s.world)) as Record<string, any>;
    w.hunters[0].equipment = { weapon: { uid: 'e1', gearId: 'gear.w.club', qualityId: 'q.rare', enhance: 1 } };
    w.town.shop = [{ uid: 'g9', gearId: 'gear.a.padded', qualityId: 'q.rare', enhance: 0, price: 60, listPrice: 60, listedAtMs: 0 }];
    w.town.crafting['bld.smithy'] = { gearId: 'gear.w.club', remainingMs: 500 };
    w.journeys = [{ id: 'j1', hunters: [{ ...w.hunters[0], id: 'away', equipment: { armor: { uid: 'e2', gearId: 'gear.a.hide', qualityId: 'q.rare', enhance: 0 } } }] }];
    delete w.town.gearStorage;
    delete w.town.autoDifficulty;
    for (const k of ['gearDismantled', 'gearReclaimed', 'gearRelisted']) delete w.stats[k];
    w.schemaVersion = 9;
    const r = deserialize(JSON.stringify({ format: SAVE_FORMAT, schemaVersion: 9, configVersion: base.version, savedAt: 0, world: w }), base);
    expect(r.migratedFrom).toBe(9);
    expect(r.world.schemaVersion).toBe(WORLD_SCHEMA_VERSION);
    expect(WORLD_SCHEMA_VERSION).toBe(12);
    expect(r.world.hunters[0]!.equipment.weapon).toEqual({ uid: 'e1', gearId: 'gear.w.club', qualityId: 'q.rare', enhance: 1, difficultyId: EASY });
    expect(r.world.town.shop[0]!.difficultyId).toBe(EASY);
    expect(r.world.town.crafting['bld.smithy']).toEqual({ gearId: 'gear.w.club', remainingMs: 500, difficultyId: EASY });
    expect(r.world.town.crafting['bld.jeweler']).toBeNull();
    expect((r.world.journeys[0] as any).hunters[0].equipment.armor.difficultyId).toBe(EASY);
    expect(r.world.town.gearStorage).toEqual([]);
    expect(r.world.town.autoDifficulty).toBe(true);
    expect(r.world.stats).toMatchObject({ gearDismantled: 0, gearReclaimed: 0, gearRelisted: 0 });
  });
});
