import { bestEnhance, bestShopPurchase, enhanceReserveMul, scoreGoals } from '../src/core/ai/utility';
import { GEAR_SLOTS, type GearSlot } from '../src/core/config/types';
import { NavGraph } from '../src/core/pathfinding';
import { createWorld, Simulation } from '../src/core/simulation';
import type { Hunter, ShopItem, World } from '../src/core/world';
import { testConfig } from './helpers';

const config = testConfig();
const { enhanceBaseScore: ENHANCE_BASE_SCORE, enhanceGainWeight: ENHANCE_GAIN_WEIGHT } = config.formula;
const nav = new NavGraph(config);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** A fresh level-1 hunter in town with no personalities (so factors are neutral). */
function freshHunter(): Hunter {
  const s = new Simulation(config, createWorld(config, 11));
  s.enqueue({ type: 'debug.spawnHunter' });
  s.step();
  const h = clone(s.world.hunters[0]!);
  h.personalities = [];
  h.ai.goal = null;
  h.nodeId = config.index.squareNode;
  return h;
}

/** Every slot except `keep` gets maxed level-1 gear (nothing to enhance there, no upgrade to save for at level 1). */
function fillMaxed(h: Hunter, keep?: GearSlot): void {
  for (const slot of GEAR_SLOTS) {
    if (slot === keep) continue;
    const g = config.gear.find((x) => x.slot === slot && x.level === 1)!;
    h.equipment[slot] = { uid: 'm-' + slot, gearId: g.id, qualityId: 'q.rare', enhance: config.enhance.length };
  }
}

function freshWorld(shop: ShopItem[] = []): World {
  const w = createWorld(config, 1);
  w.town.shop = shop;
  return w;
}

const item = (uid: string, gearId: string, price: number, qualityId = 'q.rare', enhance = 0): ShopItem =>
  ({ uid, gearId, qualityId, enhance, price, listPrice: price, listedAtMs: 0 });

describe('M2 AI: selling', () => {
  it('full bag in town → sell wins', () => {
    const h = freshHunter();
    h.bag = { 'mat.gel': config.formula.bagCapacity };
    const top = scoreGoals(config, nav, freshWorld(), h)[0]!;
    expect(top.goal).toEqual({ type: 'sell' });
    expect(top.score).toBeCloseTo(1.4);
  });

  it('no sell goal with an empty bag or a broke town', () => {
    const h = freshHunter();
    expect(scoreGoals(config, nav, freshWorld(), h).some((c) => c.goal.type === 'sell')).toBe(false);
    h.bag = { 'mat.gel': 5 };
    const w = freshWorld();
    w.town.gold = 0;
    expect(scoreGoals(config, nav, w, h).some((c) => c.goal.type === 'sell')).toBe(false);
  });

  it('full bag in the field → returnTown', () => {
    const h = freshHunter();
    h.nodeId = 'z1.b';
    h.ai.goal = { type: 'hunt', zoneId: 'zone.meadow' };
    h.bag = { 'mat.gel': config.formula.bagCapacity };
    const top = scoreGoals(config, nav, freshWorld(), h)[0]!;
    expect(top.goal.type).toBe('returnTown');
    expect(top.score).toBeCloseTo(1.2);
  });

  it('half-full bag in the field keeps hunting', () => {
    const h = freshHunter();
    h.nodeId = 'z1.b';
    h.ai.goal = { type: 'hunt', zoneId: 'zone.meadow' };
    h.bag = { 'mat.gel': Math.floor(config.formula.bagCapacity / 2) };
    expect(scoreGoals(config, nav, freshWorld(), h)[0]!.goal.type).toBe('hunt');
  });
});

describe('M2 AI: shopping', () => {
  it('affordable upgrade → shop goal for that item', () => {
    const h = freshHunter();
    h.gold = 100;
    const w = freshWorld([item('s1', 'gear.w.club', 60)]);
    expect(bestShopPurchase(config, w, h)?.item.uid).toBe('s1');
    const top = scoreGoals(config, nav, w, h)[0]!;
    expect(top.goal).toEqual({ type: 'shop', itemUid: 's1' });
  });

  it('picks the best item; ties go to the lower price then uid', () => {
    const h = freshHunter();
    h.gold = 1000;
    const w = freshWorld([item('b', 'gear.w.club', 60), item('a', 'gear.w.club', 60), item('c', 'gear.a.padded', 50)]);
    // All three are gain ≥ 1 from an empty slot → same score; cheapest wins.
    expect(bestShopPurchase(config, w, h)?.item.uid).toBe('c');
    w.town.shop = [item('b', 'gear.w.club', 60), item('a', 'gear.w.club', 60)];
    expect(bestShopPurchase(config, w, h)?.item.uid).toBe('a');
  });

  it('ignores unaffordable items (budget = gold × spendRatio)', () => {
    const h = freshHunter();
    h.gold = 70; // budget 56 < 60
    const w = freshWorld([item('s1', 'gear.w.club', 60)]);
    expect(bestShopPurchase(config, w, h)).toBeNull();
    expect(scoreGoals(config, nav, w, h).some((c) => c.goal.type === 'shop')).toBe(false);
  });

  it('frugal personality shrinks the budget', () => {
    const h = freshHunter();
    h.gold = 100;
    h.personalities = ['pers.frugal']; // budget 40
    expect(bestShopPurchase(config, freshWorld([item('s1', 'gear.w.club', 60)]), h)).toBeNull();
  });

  it('ignores items above the hunter level', () => {
    const h = freshHunter();
    h.gold = 10000;
    const w = freshWorld([item('s1', 'gear.w.iron', 500)]);
    expect(bestShopPurchase(config, w, h)).toBeNull();
    h.level = 8;
    expect(bestShopPurchase(config, w, h)?.item.uid).toBe('s1');
  });

  it('ignores upgrades below minUpgradeGain', () => {
    const h = freshHunter();
    h.gold = 10000;
    h.equipment.weapon = { uid: 'eq', gearId: 'gear.w.club', qualityId: 'q.rare', enhance: 1 }; // 4.24
    const w = freshWorld([item('s1', 'gear.w.club', 60, 'q.epic')]); // 4.4 → gain ≈ 0.038
    expect(bestShopPurchase(config, w, h)).toBeNull();
    w.town.shop = [item('s2', 'gear.w.club', 60, 'q.mythic')]; // 4.8 → gain ≈ 0.13
    expect(bestShopPurchase(config, w, h)?.gain).toBeCloseTo(4.8 / 4.24 - 1);
  });

  it('a low need beats shopping', () => {
    const h = freshHunter();
    h.gold = 100;
    h.needs.satiety = 15;
    const scored = scoreGoals(config, nav, freshWorld([item('s1', 'gear.w.club', 60)]), h);
    expect(scored.some((c) => c.goal.type === 'shop')).toBe(true);
    expect(scored[0]!.goal).toEqual({ type: 'service', buildingId: 'bld.restaurant' });
  });
});

describe('M2 AI: enhancing', () => {
  it('only enhances with enough reserve gold (cost × enhanceReserveMul(successRate))', () => {
    const h = freshHunter();
    h.equipment.weapon = { uid: 'eq', gearId: 'gear.w.club', qualityId: 'q.rare', enhance: 0 };
    // Fill the other slots with maxed level-1 gear: nothing else to enhance and no gear upgrade to save for (§5.4).
    fillMaxed(h, 'weapon');
    const row = config.enhance[0]!;
    const cost = Math.round(60 * row.costFrac); // 6
    const need = Math.ceil(cost * enhanceReserveMul(config, row.successRate));
    h.gold = need - 1;
    expect(bestEnhance(config, h)).toBeNull();
    expect(scoreGoals(config, nav, freshWorld(), h).some((c) => c.goal.type === 'enhance')).toBe(false);
    h.gold = need;
    // +0 → +1 never drops; the step is 4 × enhanceStatPerLevel, i.e. enhanceStatPerLevel of the slot.
    const relGain = row.successRate * config.formula.enhanceStatPerLevel;
    expect(bestEnhance(config, h)).toMatchObject({ slot: 'weapon', cost, successRate: row.successRate });
    expect(bestEnhance(config, h)!.expectedRelGain).toBeCloseTo(relGain);
    const c = scoreGoals(config, nav, freshWorld(), h).find((x) => x.goal.type === 'enhance')!;
    expect(c.goal).toEqual({ type: 'enhance', slot: 'weapon' });
    expect(c.score).toBeCloseTo(ENHANCE_BASE_SCORE + ENHANCE_GAIN_WEIGHT * relGain);
  });

  it('picks the best expected stat gain per gold and skips maxed gear', () => {
    const h = freshHunter();
    h.gold = 100000;
    fillMaxed(h); // every other slot maxed
    h.equipment.weapon = { uid: 'w', gearId: 'gear.w.iron', qualityId: 'q.rare', enhance: 0 };
    h.equipment.body = { uid: 'a', gearId: 'gear.a.padded', qualityId: 'q.rare', enhance: 2 };
    // Expected stat gain per gold = successRate × mainValue × enhanceStatPerLevel / cost
    const [r0, r2] = [config.enhance[0]!, config.enhance[2]!];
    const iron = config.index.gear.get('gear.w.iron')!, padded = config.index.gear.get('gear.a.padded')!;
    const ironPerGold = (r0.successRate * iron.mainValue) / Math.round(iron.basePrice * r0.costFrac);
    const paddedPerGold = (r2.successRate * padded.mainValue) / Math.round(padded.basePrice * r2.costFrac);
    expect(bestEnhance(config, h)?.slot).toBe(ironPerGold >= paddedPerGold ? 'weapon' : 'body');
    delete h.equipment.weapon;
    expect(bestEnhance(config, h)?.slot).toBe('body');
    expect(bestEnhance(config, h)?.cost).toBe(Math.round(padded.basePrice * r2.costFrac));
  });
});
