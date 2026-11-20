import { applyCommand, type Command } from '../src/core/commands';
import { validateConfig } from '../src/core/config/load';
import type { GameConfig } from '../src/core/config/types';
import { EventBuffer, type SimEvent } from '../src/core/events';
import { rollHunter } from '../src/core/hunterFactory';
import { NavGraph } from '../src/core/pathfinding';
import { Rng } from '../src/core/rng';
import { createWorld, Simulation } from '../src/core/simulation';
import type { SystemContext } from '../src/core/system';
import { startCraft, pickRecipe } from '../src/core/systems/crafting';
import { economySystem } from '../src/core/systems/economy';
import { servicePrice, servicesSystem } from '../src/core/systems/services';
import { nextSkillStudy } from '../src/core/systems/academy';
import { autoMaterialDemand, materialDemand, surplusPrice } from '../src/core/systems/trading';
import {
  autoInvest, buildingDoor, buildingLevel, chooseInvestment, craftMaxGearLevel, enhanceBonus, extraRequestCopies, levelCost,
  shopCapacity, studyGoldMul, townHallLevel, townSystem,
} from '../src/core/systems/town';
import type { Hunter, World } from '../src/core/world';
import { readRawConfig, testConfig } from './helpers';

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

/** Apply a command and return the rejection reason (null = accepted). */
function run(ctx: SystemContext & { events: EventBuffer }, cmd: Command): string | null {
  ctx.events.drain();
  applyCommand(ctx, cmd);
  const rej = ctx.events.drain().find((e): e is Extract<SimEvent, { type: 'commandRejected' }> => e.type === 'commandRejected');
  return rej ? rej.reason : null;
}

const lv = (w: World, id: string) => w.town.buildings.find((s) => s.buildingId === id)?.level ?? 0;
const setLevel = (w: World, id: string, level: number) => { w.town.buildings.find((s) => s.buildingId === id)!.level = level; };

/** Put the materials of a level cost into storage. */
function stock(w: World, bId: string, toLevel: number): void {
  const c = levelCost(config, config.index.buildings.get(bId)!, toLevel)!;
  for (const id in c.materials) w.town.storage[id] = (w.town.storage[id] ?? 0) + c.materials[id]!;
}

/** Run townSystem until no upgrade is running (max n ticks). */
function finish(ctx: SystemContext, n = 100000): void {
  for (let i = 0; i < n && ctx.world.town.buildings.some((s) => s.upgrade); i++) {
    townSystem.update(ctx);
    ctx.world.tick++;
    ctx.world.timeMs += ctx.dtMs;
  }
}

describe('town buildings: config and new game', () => {
  it('starts every pre-built building at level 1 on its plot, Town Hall included', () => {
    const w = createWorld(config, 1);
    expect(townHallLevel(config, w)).toBe(1);
    const started = config.plots.filter((p) => p.startBuilding).map((p) => p.startBuilding);
    expect(w.town.buildings.map((s) => s.buildingId)).toEqual(started);
    expect(w.town.buildings.every((s) => s.level === 1 && s.upgrade === null)).toBe(true);
    expect(w.town.autoInvest).toBe(true);
    // Level 1 = the pre-building numbers (shop 12, inn 8/s, price 18).
    expect(shopCapacity(config, w)).toBe(12);
    expect(config.index.buildings.get('bld.inn')!.restorePerSec![0]).toBe(8);
    expect(servicePrice(config, { level: 1 } as Hunter, config.index.buildings.get('bld.inn')!, 1)).toBe(18);
    // Free plots exist and have doors that are no destination yet.
    const free = config.plots.filter((p) => !p.startBuilding);
    expect(free.length).toBeGreaterThan(0);
    expect(buildingDoor(config, w, 'bld.storehouse')).toBeNull();
    expect(buildingDoor(config, w, 'bld.inn')).toBe('d.inn');
  });

  it('rejects broken building/plot config', () => {
    const raw = JSON.parse(JSON.stringify(readRawConfig())) as Record<string, any>;
    raw.building.find((b: any) => b.id === 'bld.smithy').maxGearLevel.pop(); // wrong length
    raw.building_plot.find((p: any) => p.id === 'plot.ne').doorNode = 'd.inn'; // shared door
    raw.building_plot.find((p: any) => p.id === 'plot.shop').townHallLevel = 3; // pre-built on a locked plot
    delete raw.building.find((b: any) => b.id === 'bld.shop').capacity;
    const msgs = validateConfig(raw as any).map((i) => `${i.path}: ${i.message}`);
    expect(msgs.some((m) => m.includes('maxGearLevel') && m.includes('expected length'))).toBe(true);
    // Shape errors stop the cross-table pass; fix them and check the map rules.
    raw.building.find((b: any) => b.id === 'bld.smithy').maxGearLevel.push(81);
    const msgs2 = validateConfig(raw as any).map((i) => `${i.path}: ${i.message}`);
    expect(msgs2).toContain('building_plot: door "d.inn" used by 2 plots');
    expect(msgs2.some((m) => m.includes('capacity') && m.includes('required for kind "shop"'))).toBe(true);
    expect(msgs2.some((m) => m.includes('needs Town Hall 3'))).toBe(true);
    expect(msgs2.some((m) => m.includes('d.plot.ne') && m.includes('door node without a building plot'))).toBe(true);
  });
});

describe('town commands', () => {
  it('upgrade pays gold + storage materials now, finishes after its time, keeps the old level meanwhile', () => {
    const ctx = makeCtx();
    const w = ctx.world;
    w.town.gold = 10000;
    stock(w, 'bld.townhall', 2);
    const cost = levelCost(config, config.index.buildings.get('bld.townhall')!, 2)!;
    expect(run(ctx, { type: 'town.upgrade', buildingInstanceId: 'plot.townhall' })).toBeNull();
    expect(w.town.gold).toBe(10000 - cost.gold);
    expect(Object.keys(w.town.storage)).toEqual([]);
    expect(lv(w, 'bld.townhall')).toBe(1);
    expect(run(ctx, { type: 'town.upgrade', buildingInstanceId: 'plot.townhall' })).toBe('upgrade in progress');
    let ticks = 0;
    for (; w.town.buildings[0]!.upgrade; ticks++) { townSystem.update(ctx); w.tick++; w.timeMs += 100; }
    expect(ticks).toBe(Math.ceil(cost.ms / 100));
    expect(lv(w, 'bld.townhall')).toBe(2);
    expect(w.stats.buildingUpgrades).toBe(1);
    expect(w.stats.investGold).toBe(cost.gold);
  });

  it('rejects unknown instances, Town Hall locks, missing gold/materials, max level and full slots', () => {
    const ctx = makeCtx();
    const w = ctx.world;
    w.town.autoInvest = false;
    expect(run(ctx, { type: 'town.upgrade', buildingInstanceId: 'plot.nope' })).toBe('unknown building instance');
    expect(run(ctx, { type: 'town.upgrade', buildingInstanceId: 'plot.smithy' })).toBe('locked by Town Hall level');
    w.town.gold = 0;
    expect(run(ctx, { type: 'town.upgrade', buildingInstanceId: 'plot.townhall' })).toBe('missing materials');
    stock(w, 'bld.townhall', 2);
    expect(run(ctx, { type: 'town.upgrade', buildingInstanceId: 'plot.townhall' })).toBe('not enough town gold');
    setLevel(w, 'bld.forge', config.index.buildings.get('bld.forge')!.maxLevel);
    expect(run(ctx, { type: 'town.upgrade', buildingInstanceId: 'plot.forge' })).toBe('max level');
    // Concurrency: buildMaxConcurrent upgrades at once.
    w.town.gold = 1e6;
    setLevel(w, 'bld.townhall', 8);
    for (const id of ['bld.inn', 'bld.tavern', 'bld.restaurant']) stock(w, id, 2);
    expect(run(ctx, { type: 'town.upgrade', buildingInstanceId: 'plot.inn' })).toBeNull();
    expect(run(ctx, { type: 'town.upgrade', buildingInstanceId: 'plot.tavern' })).toBeNull();
    expect(config.formula.buildMaxConcurrent).toBe(2);
    expect(run(ctx, { type: 'town.upgrade', buildingInstanceId: 'plot.restaurant' })).toBe('construction slots full');
  });

  it('builds a type on a free plot: plot/type locks, occupied plot, one per type; cancel refunds everything', () => {
    const ctx = makeCtx();
    const w = ctx.world;
    w.town.autoInvest = false;
    w.town.gold = 1e6;
    expect(run(ctx, { type: 'town.build', buildingId: 'bld.nope', plotId: 'plot.ne' })).toBe('unknown building');
    expect(run(ctx, { type: 'town.build', buildingId: 'bld.storehouse', plotId: 'plot.nope' })).toBe('unknown plot');
    expect(run(ctx, { type: 'town.build', buildingId: 'bld.storehouse', plotId: 'plot.inn' })).toBe('plot occupied');
    expect(run(ctx, { type: 'town.build', buildingId: 'bld.storehouse', plotId: 'plot.ne' })).toBe('plot locked by Town Hall level');
    setLevel(w, 'bld.townhall', 2);
    expect(run(ctx, { type: 'town.build', buildingId: 'bld.storehouse', plotId: 'plot.ne' })).toBe('building locked by Town Hall level');
    expect(run(ctx, { type: 'town.build', buildingId: 'bld.inn', plotId: 'plot.ne' })).toBe('already built');
    setLevel(w, 'bld.townhall', 3);
    expect(run(ctx, { type: 'town.build', buildingId: 'bld.storehouse', plotId: 'plot.ne' })).toBe('missing materials');
    stock(w, 'bld.storehouse', 1);
    const storage = { ...w.town.storage };
    expect(run(ctx, { type: 'town.build', buildingId: 'bld.storehouse', plotId: 'plot.ne' })).toBeNull();
    expect(buildingLevel(w, 'bld.storehouse')).toBe(0); // under construction: not usable
    expect(buildingDoor(config, w, 'bld.storehouse')).toBeNull();
    expect(run(ctx, { type: 'town.cancelUpgrade', buildingInstanceId: 'plot.ne' })).toBeNull();
    expect(w.town.gold).toBe(1e6);
    expect(w.town.storage).toEqual(storage);
    expect(w.town.buildings.some((s) => s.id === 'plot.ne')).toBe(false);
    expect(run(ctx, { type: 'town.cancelUpgrade', buildingInstanceId: 'plot.inn' })).toBe('no upgrade in progress');
    // Build for real.
    expect(run(ctx, { type: 'town.build', buildingId: 'bld.storehouse', plotId: 'plot.ne' })).toBeNull();
    finish(ctx);
    expect(buildingLevel(w, 'bld.storehouse')).toBe(1);
    expect(buildingDoor(config, w, 'bld.storehouse')).toBe('d.plot.ne');
    expect(w.stats.buildingsBuilt).toBe(1);
    expect(w.town.buildings.map((s) => s.id)).toEqual(config.plots.map((p) => p.id).filter((id) => w.town.buildings.some((s) => s.id === id)));
  });

  it('toggles auto-invest', () => {
    const ctx = makeCtx();
    expect(run(ctx, { type: 'town.setAutoInvest', on: false })).toBeNull();
    expect(ctx.world.town.autoInvest).toBe(false);
  });
});

describe('per-level effects', () => {
  it('craft buildings cap the craftable gear tier (startCraft, pickRecipe, auto-requests)', () => {
    const ctx = makeCtx();
    const w = ctx.world;
    w.town.gold = 1e6;
    w.town.storage = { 'mat.cinder': 50, 'mat.scale': 50 };
    expect(craftMaxGearLevel(config, w, 'bld.smithy')).toBe(15);
    expect(startCraft(ctx, 'bld.smithy', 'gear.w.cinder')).toBe('gear tier locked by building level'); // Lv22
    addHunter(ctx, { level: 30, gold: 1e5 });
    expect(pickRecipe(ctx, 'bld.smithy')?.id).not.toBe('gear.w.cinder');
    w.town.autoInvest = false;
    expect(Object.keys(autoMaterialDemand(config, w)).some((id) => id === 'mat.cinder')).toBe(false);
    setLevel(w, 'bld.smithy', 2);
    expect(craftMaxGearLevel(config, w, 'bld.smithy')).toBe(23);
    expect(startCraft(ctx, 'bld.smithy', 'gear.w.cinder')).toBeNull();
  });

  it('shop capacity, service restore/price, forge bonus, academy discount, storehouse copies, trading post surplus price', () => {
    const w = createWorld(config, 1);
    setLevel(w, 'bld.shop', 3);
    expect(shopCapacity(config, w)).toBe(16);
    const inn = config.index.buildings.get('bld.inn')!;
    const h = { level: 1 } as Hunter;
    expect(servicePrice(config, h, inn, 3)).toBeGreaterThan(servicePrice(config, h, inn, 1));
    expect(enhanceBonus(config, w)).toBe(0);
    setLevel(w, 'bld.forge', 3);
    expect(enhanceBonus(config, w)).toBeCloseTo(0.04);
    expect(studyGoldMul(config, w)).toBe(1);
    setLevel(w, 'bld.academy', 5);
    expect(studyGoldMul(config, w)).toBe(0.8);
    const s = new Simulation(config, createWorld(config, 3));
    s.enqueue({ type: 'debug.spawnHunter' });
    s.step();
    const hh = s.world.hunters[0]!;
    hh.level = 50;
    const sk = config.skills.find((x) => x.classId === hh.classId && x.jobTierMin <= hh.jobTier)!;
    const full = nextSkillStudy(config, hh, sk.id)!.cost;
    expect(nextSkillStudy(config, hh, sk.id, w)!.cost).toBe(Math.round(full * 0.8));
    expect(extraRequestCopies(config, w)).toBe(0);
    w.town.buildings.push({ id: 'plot.ne', buildingId: 'bld.storehouse', level: 2, upgrade: null });
    expect(extraRequestCopies(config, w)).toBe(2);
    const base = surplusPrice(config, 'mat.star', w);
    setLevel(w, 'bld.trading', 4);
    expect(surplusPrice(config, 'mat.star', w)).toBe(Math.round(base * 1.3));
  });

  it('services restore faster at a higher level', () => {
    const ctx = makeCtx();
    const h = addHunter(ctx, { gold: 1000 });
    h.needs.stamina = 0;
    h.insideBuildingId = 'bld.inn';
    servicesSystem.update(ctx);
    const one = h.needs.stamina;
    h.needs.stamina = 0;
    setLevel(ctx.world, 'bld.inn', 5);
    servicesSystem.update(ctx);
    expect(h.needs.stamina).toBeCloseTo(one * 1.6, 5);
  });

  it('the forge level raises the enhance success rate (same single RNG draw)', () => {
    const cfg = { ...config, enhance: config.enhance.map((r) => ({ ...r, successRate: 0.95 })) };
    const tries = (forge: number) => {
      const ctx = makeCtx(cfg, 5);
      setLevel(ctx.world, 'bld.forge', forge);
      let ok = 0;
      for (let i = 0; i < 400; i++) {
        const h = addHunter(ctx, { gold: 1e6, equipment: { weapon: { uid: 'u' + i, gearId: 'gear.w.club', qualityId: 'q.rare', enhance: 0 } } });
        h.ai.goal = { type: 'enhance', slot: 'weapon' };
        h.ai.phase = 'act';
        economySystem.update(ctx);
        if (h.equipment.weapon!.enhance === 1) ok++;
        ctx.world.hunters.length = 0;
      }
      return ok;
    };
    expect(tries(5)).toBeGreaterThan(tries(1)); // 0.95 + 0.08 caps at 1
    expect(tries(5)).toBe(400);
  });
});

describe('auto-investment', () => {
  it('upgrades the Town Hall, then the craft building, when hunters are about to be gear-capped', () => {
    const ctx = makeCtx();
    const w = ctx.world;
    w.town.gold = 5000;
    const f = config.formula;
    // The smithy's next step needs Town Hall 2, so the Town Hall looks investTownHallLeadLevels further ahead:
    // level + craftLevelAhead + investCraftLeadLevels + investTownHallLeadLevels < gear Lv22 → nothing urgent yet.
    addHunter(ctx, { level: 22 - f.craftLevelAhead - f.investCraftLeadLevels - f.investTownHallLeadLevels - 1 });
    expect(chooseInvestment(config, w)?.urgent ?? false).toBe(false);
    w.hunters[0]!.level = 17; // 23 ≥ 22: smithy Lv1 (≤15) blocks Lv22 recipes
    const c = chooseInvestment(config, w)!;
    expect(c).toMatchObject({ buildingId: 'bld.townhall', toLevel: 2, urgent: true }); // smithy Lv2 needs Town Hall 2
    // No materials yet: the plan is stored and the Trading Post requests them.
    autoInvest(ctx);
    expect(w.town.investPlan).toMatchObject({ buildingId: 'bld.townhall', toLevel: 2 });
    const need = levelCost(config, config.index.buildings.get('bld.townhall')!, 2)!.materials;
    const demand = materialDemand(config, w);
    for (const id in need) expect(demand[id]).toBeGreaterThanOrEqual(need[id]!);
    stock(w, 'bld.townhall', 2);
    autoInvest(ctx);
    expect(w.town.buildings.find((s) => s.buildingId === 'bld.townhall')!.upgrade).not.toBeNull();
    finish(ctx);
    expect(chooseInvestment(config, w)).toMatchObject({ buildingId: 'bld.smithy', toLevel: 2, urgent: true });
  });

  it('spends only gold above the treasury target on non-urgent steps', () => {
    const ctx = makeCtx();
    const w = ctx.world;
    // No hunters → nothing urgent. Town Hall Lv2 (cheapest) costs 400.
    w.town.gold = 5000 + 399; // target = feeTownTargetMin 5000 here
    expect(chooseInvestment(config, w)).toBeNull();
    w.town.gold = 5000 + 400;
    expect(chooseInvestment(config, w)).toMatchObject({ buildingId: 'bld.townhall', urgent: false });
  });

  it('imports missing materials after investImportSec at investImportPriceMul × price', () => {
    const ctx = makeCtx();
    const w = ctx.world;
    w.town.gold = 1e5;
    autoInvest(ctx);
    expect(w.town.investPlan).not.toBeNull();
    expect(w.town.buildings.some((s) => s.upgrade)).toBe(false);
    w.timeMs += config.formula.investImportSec * 1000;
    const gold = w.town.gold;
    autoInvest(ctx);
    const started = w.town.buildings.find((s) => s.upgrade)!;
    expect(started).toBeDefined();
    expect(w.stats.investImportGold).toBeGreaterThan(0);
    expect(gold - w.town.gold).toBe(started.upgrade!.gold);
    expect(started.upgrade!.importedUnits).toBeGreaterThan(0);
    // Cancel: all gold back, but imported units are not handed out as free materials.
    const storageBefore = JSON.stringify(w.town.storage);
    expect(run(ctx, { type: 'town.cancelUpgrade', buildingInstanceId: started.id })).toBeNull();
    expect(w.town.gold).toBe(gold);
    expect(JSON.stringify(w.town.storage)).toBe(storageBefore);
    expect(w.stats.investGold).toBe(0);
    expect(w.stats.investImportGold).toBe(0);
    expect(w.stats.investMaterials).toBe(0);
  });

  it('is a real sink and stays deterministic: two identical runs match, and auto-invest off changes nothing in buildings', () => {
    const runSim = (on: boolean) => {
      const s = new Simulation(config, createWorld(config, 21));
      s.world.town.autoInvest = on;
      for (let i = 0; i < config.formula.hunterSlots; i++) s.enqueue({ type: 'debug.spawnHunter' });
      for (let t = 0; t < 600 * 90; t++) s.step();
      return s.world;
    };
    const a = runSim(true);
    const b = runSim(true);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.stats.investGold).toBeGreaterThan(0);
    expect(a.town.buildings.some((s) => s.level > 1)).toBe(true);
    const off = runSim(false);
    expect(off.stats.investGold).toBe(0);
    expect(off.town.buildings.every((s) => s.level === 1)).toBe(true);
  }, 120000);
});
