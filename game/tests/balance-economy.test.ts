import type { FormulaParams, GameConfig, GearSlot } from '../src/core/config/types';
import { EventBuffer } from '../src/core/events';
import { rollHunter } from '../src/core/hunterFactory';
import { NavGraph } from '../src/core/pathfinding';
import { Rng } from '../src/core/rng';
import { createWorld } from '../src/core/simulation';
import type { SystemContext } from '../src/core/system';
import { academySystem, nextSkillStudy } from '../src/core/systems/academy';
import {
  autoCraftReserve, craftGoldCost, craftingSystem, pickRecipe, recipeBeneficiaries, referenceQuality, startCraft,
  updateShopTurnover,
} from '../src/core/systems/crafting';
import { economySystem, enhanceCost, feeTownCut } from '../src/core/systems/economy';
import type { Hunter, ShopItem, World } from '../src/core/world';
import { testConfig } from './helpers';

const base = testConfig();
const nav = new NavGraph(base);

/** Live config with formula values pinned, so the tests don't move with config tuning. */
function cfg(patch: Partial<FormulaParams> = {}): GameConfig {
  return {
    ...base,
    formula: {
      ...base.formula,
      craftGoldFrac: 0.3, feeTownShare: 0.3, shopStaleSec: 600, shopMarkdownPct: 10, shopMarkdownFloor: 0.5, shopScrapSec: 1800,
      minUpgradeGain: 0.12, craftLevelAhead: 2,
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

function addHunter(ctx: SystemContext, patch: Partial<Hunter> = {}, gear: Partial<Record<GearSlot, string>> = {}): Hunter {
  const h = rollHunter(ctx.config, new Rng(7), 'h' + ctx.world.hunters.length, base.index.squareNode, { x: 0, y: 0 }, 0);
  Object.assign(h, patch);
  for (const [slot, gearId] of Object.entries(gear)) {
    h.equipment[slot as GearSlot] = { uid: 'e' + ctx.world.nextId++, gearId: gearId!, qualityId: 'q.rare', enhance: 0 };
  }
  ctx.world.hunters.push(h);
  return h;
}

function shopItem(world: World, gearId: string, price: number, qualityId = 'q.rare', listedAtMs = world.timeMs): ShopItem {
  const it: ShopItem = { uid: 'g' + world.nextId++, gearId, qualityId, enhance: 0, price, listPrice: price, listedAtMs };
  world.town.shop.push(it);
  return it;
}

const gear = (id: string) => base.index.gear.get(id)!;
/** 3 × the priciest material used by recipes with gear.level ≤ cap (expected auto-craft reserve). */
const tierReserve = (cap: number) =>
  3 * Math.max(...base.gear.filter((g) => g.level <= cap).flatMap((g) => g.materials.map((m) => base.index.materials.get(m.materialId)!.price)));

describe('craft gold cost', () => {
  it('startCraft charges round(basePrice × craftGoldFrac) from town gold, else rejects', () => {
    const ctx = makeCtx(cfg({ craftGoldFrac: 0.25 }));
    expect(craftGoldCost(ctx.config, gear('gear.a.padded'))).toBe(15); // 60 × 0.25
    expect(craftGoldCost(ctx.config, gear('gear.r.charm'))).toBe(18); // 70 × 0.25 = 17.5 → 18
    ctx.world.town.storage = { 'mat.gel': 5 };
    ctx.world.town.gold = 17;
    expect(startCraft(ctx, 'bld.jeweler', 'gear.r.charm')).toBe('not enough town gold');
    expect(ctx.world.town.storage).toEqual({ 'mat.gel': 5 });
    expect(ctx.world.town.crafting['bld.jeweler']).toBeNull();
    ctx.world.town.gold = 18;
    expect(startCraft(ctx, 'bld.jeweler', 'gear.r.charm')).toBeNull();
    expect(ctx.world.town.gold).toBe(0);
    expect(ctx.world.town.storage).toEqual({});
  });

  it('auto-craft keeps a reserve of 3 × the priciest current-tier material', () => {
    const ctx = makeCtx();
    ctx.world.town.autoCraft = true;
    addHunter(ctx, { level: 1 }); // empty slots; tier cap = 1 + 2 → club/padded/charm (gel 4, hide 8)
    const reserve = autoCraftReserve(ctx.config, ctx.world);
    expect(reserve).toBe(tierReserve(3));
    ctx.world.town.storage = { 'mat.gel': 5 };
    ctx.world.town.crafting['bld.smithy'] = { gearId: 'gear.w.club', remainingMs: 99_999 }; // smithy busy
    const cost = craftGoldCost(ctx.config, gear('gear.r.charm'));
    ctx.world.town.gold = cost + reserve - 1;
    craftingSystem.update(ctx);
    expect(ctx.world.town.crafting['bld.jeweler']).toBeNull();
    ctx.world.town.gold = cost + reserve;
    craftingSystem.update(ctx);
    expect(ctx.world.town.crafting['bld.jeweler']).toMatchObject({ gearId: 'gear.r.charm' });
    expect(ctx.world.town.gold).toBe(reserve);
  });

  it('the reserve grows with the tier hunters have reached', () => {
    const ctx = makeCtx();
    addHunter(ctx, { level: 7 }); // cap 9 → includes mat.core (40)
    expect(autoCraftReserve(ctx.config, ctx.world)).toBe(tierReserve(9));
  });
});

describe('fee split', () => {
  it('forge: hunter pays the full fee, town gets round(fee × feeTownShare)', () => {
    const config = cfg({ feeTownShare: 0.3 });
    const ctx = makeCtx({ ...config, enhance: config.enhance.map((r) => ({ ...r, successRate: 1 })) });
    const h = addHunter(ctx, { gold: 10_000 }, { weapon: 'gear.w.iron' });
    const cost = enhanceCost(ctx.config, h.equipment.weapon!)!;
    h.ai.goal = { type: 'enhance', slot: 'weapon' };
    h.ai.phase = 'act';
    const town0 = ctx.world.town.gold;
    economySystem.update(ctx);
    expect(h.gold).toBe(10_000 - cost);
    expect(ctx.world.town.gold).toBe(town0 + Math.round(cost * 0.3));
    expect(feeTownCut(ctx.config, 35)).toBe(11); // 10.5 → 11
  });

  it('academy: hunter pays the full fee, town gets round(fee × feeTownShare)', () => {
    const ctx = makeCtx(cfg({ feeTownShare: 0.5 }));
    const h = addHunter(ctx, { gold: 10_000, level: 1, classId: 'class.vanguard', jobTier: 0, skills: {} });
    const fee = nextSkillStudy(ctx.config, h, 'skill.vanguard.cleave')!.cost;
    h.ai.goal = { type: 'learn', kind: 'skill', id: 'skill.vanguard.cleave' };
    h.ai.phase = 'act';
    const town0 = ctx.world.town.gold;
    academySystem.update(ctx);
    expect(h.skills['skill.vanguard.cleave']).toBe(1);
    expect(h.gold).toBe(10_000 - fee);
    expect(ctx.world.town.gold).toBe(town0 + Math.round(fee * 0.5));
  });
});

describe('shop turnover', () => {
  it('marks down shopMarkdownPct% of listPrice per shopStaleSec unsold, then scraps after shopScrapSec', () => {
    const ctx = makeCtx();
    ctx.world.town.autoCraft = false;
    const a = shopItem(ctx.world, 'gear.w.club', 100, 'q.rare', 0);
    const b = shopItem(ctx.world, 'gear.a.padded', 60, 'q.rare', 300_000); // listed 5 min later
    const at = (sec: number) => {
      ctx.world.timeMs = sec * 1000;
      craftingSystem.update(ctx);
      return ctx.world.town.shop.map((x) => x.price);
    };
    expect(at(599)).toEqual([100, 60]);
    expect(at(600)).toEqual([90, 60]);
    expect(at(900)).toEqual([90, 54]);
    expect(at(1200)).toEqual([80, 54]);
    expect(at(1799)).toEqual([80, 48]);
    expect(at(1800)).toEqual([48]); // a scrapped (no refund), b keeps going
    expect(ctx.world.town.shop[0]!.uid).toBe(b.uid);
    expect(a.listPrice).toBe(100);
    expect(at(2100)).toEqual([]);
  });

  it('never goes below round(listPrice × shopMarkdownFloor)', () => {
    const config = cfg({ shopMarkdownPct: 30, shopMarkdownFloor: 0.45, shopScrapSec: 99_999 });
    const world = createWorld(config, 1);
    shopItem(world, 'gear.w.club', 75, 'q.rare', 0);
    for (const [sec, want] of [[600, 53], [1200, 34], [6000, 34]] as const) { // 52.5→53, 30 < floor 33.75→34
      world.timeMs = sec * 1000;
      updateShopTurnover(world, config);
      expect(world.town.shop[0]!.price).toBe(want);
    }
  });

  it('scrapping frees a shop slot for a held craft job', () => {
    const ctx = makeCtx();
    ctx.world.town.autoCraft = false;
    const cap = base.index.buildings.get(base.index.shop)!.capacity!;
    const old = shopItem(ctx.world, 'gear.w.club', 60, 'q.rare', 0);
    for (let i = 1; i < cap; i++) shopItem(ctx.world, 'gear.w.club', 60, 'q.rare', 500_000);
    ctx.world.town.crafting['bld.jeweler'] = { gearId: 'gear.r.charm', remainingMs: 0 };
    ctx.world.timeMs = 1_800_000; // the first item is exactly shopScrapSec old
    craftingSystem.update(ctx);
    expect(ctx.world.town.shop).toHaveLength(cap);
    expect(ctx.world.town.shop.some((x) => x.uid === old.uid)).toBe(false);
    expect(ctx.world.town.shop[cap - 1]!.gearId).toBe('gear.r.charm');
    expect(ctx.world.town.crafting['bld.jeweler']).toBeNull();
  });
});

describe('smarter auto-craft', () => {
  it('uses the statMult-1 quality as the reference', () => {
    expect(referenceQuality(base)?.statMult).toBe(1);
  });

  it('crafts nothing when no hunter would gain (no junk)', () => {
    const ctx = makeCtx();
    ctx.world.town.storage = { 'mat.gel': 50, 'mat.hide': 50 };
    craftingSystem.update(ctx); // no hunters at all
    expect(ctx.world.town.crafting['bld.smithy']).toBeNull();
    expect(ctx.world.town.crafting['bld.jeweler']).toBeNull();
    addHunter(ctx, { level: 1 }, { weapon: 'gear.w.club', armor: 'gear.a.padded', accessory: 'gear.r.charm' });
    craftingSystem.update(ctx); // already wearing every level-1 item at Rare
    expect(ctx.world.town.crafting['bld.smithy']).toBeNull();
    expect(ctx.world.town.crafting['bld.jeweler']).toBeNull();
    expect(ctx.world.town.storage).toEqual({ 'mat.gel': 50, 'mat.hide': 50 });
  });

  it('prefers the recipe that helps the most hunters, then the higher level', () => {
    const ctx = makeCtx();
    ctx.world.town.storage = { 'mat.gel': 50, 'mat.hide': 50, 'mat.tusk': 50 };
    addHunter(ctx, { level: 1 }, { weapon: 'gear.w.club' }); // needs armor
    addHunter(ctx, { level: 1 }, { weapon: 'gear.w.club' }); // needs armor
    addHunter(ctx, { level: 1 }, { armor: 'gear.a.padded' }); // needs a weapon
    expect(recipeBeneficiaries(ctx, gear('gear.a.padded'))).toBe(2);
    expect(recipeBeneficiaries(ctx, gear('gear.w.club'))).toBe(1);
    expect(recipeBeneficiaries(ctx, gear('gear.w.tusk'))).toBe(0); // level 4 > 1 + craftLevelAhead
    expect(pickRecipe(ctx, 'bld.smithy')!.id).toBe('gear.a.padded');

    ctx.world.hunters.forEach((h) => (h.level = 2)); // now level-4 gear is within reach for all three
    expect(recipeBeneficiaries(ctx, gear('gear.a.hide'))).toBe(3); // 9 vs 4 or 0
    expect(recipeBeneficiaries(ctx, gear('gear.w.tusk'))).toBe(3);
    expect(pickRecipe(ctx, 'bld.smithy')!.id).toBe('gear.a.hide'); // tie on count & level → gearId
  });

  it('does not craft what a same-slot item on sale (or being crafted) already covers', () => {
    const ctx = makeCtx();
    ctx.world.town.storage = { 'mat.gel': 50, 'mat.hide': 50 };
    addHunter(ctx, { level: 1 });
    shopItem(ctx.world, 'gear.w.club', 80, 'q.epic'); // 4.4 > Rare club 4 → weapon covered
    expect(recipeBeneficiaries(ctx, gear('gear.w.club'))).toBe(0);
    expect(recipeBeneficiaries(ctx, gear('gear.a.padded'))).toBe(1);
    // A common club (3.2) does not cover a Rare one (4): +25% ≥ minUpgradeGain.
    ctx.world.town.shop = [];
    shopItem(ctx.world, 'gear.w.club', 48, 'q.common');
    expect(recipeBeneficiaries(ctx, gear('gear.w.club'))).toBe(1);
    // Higher-level same-slot items don't cover lower-level recipes (the hunter can't use them yet).
    ctx.world.town.shop = [];
    shopItem(ctx.world, 'gear.w.tusk', 220);
    expect(recipeBeneficiaries(ctx, gear('gear.w.club'))).toBe(1);
    // A running craft job counts too (at reference quality).
    ctx.world.town.shop = [];
    ctx.world.town.crafting['bld.smithy'] = { gearId: 'gear.w.club', remainingMs: 1000 };
    expect(recipeBeneficiaries(ctx, gear('gear.w.club'))).toBe(0);
  });

  it('an unaffordable top pick does not block a cheaper useful one', () => {
    const ctx = makeCtx();
    ctx.world.town.storage = { 'mat.gel': 50, 'mat.hide': 50, 'mat.tusk': 50 };
    addHunter(ctx, { level: 2 }); // tusk/hide (lv4, cost 66) and club/padded (lv1, cost 18) all help
    const reserve = autoCraftReserve(ctx.config, ctx.world);
    ctx.world.town.gold = craftGoldCost(ctx.config, gear('gear.w.club')) + reserve;
    expect(pickRecipe(ctx, 'bld.smithy')!.level).toBe(1);
    ctx.world.town.gold = craftGoldCost(ctx.config, gear('gear.w.tusk')) + reserve;
    expect(pickRecipe(ctx, 'bld.smithy')!.level).toBe(4);
  });
});
