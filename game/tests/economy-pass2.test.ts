/**
 * Economy pass 2 (TECH_SPEC §5.4, §5.8, §5.12): gear savings, enhance expected-value gate, Town Hall lead for craft
 * tiers, value-based auto-investment.
 */
import { bestEnhance, enhanceReserveMul, enhanceSavingsHold, savingsTarget, upgradeSavings } from '../src/core/ai/utility';
import { EventBuffer } from '../src/core/events';
import { rollHunter } from '../src/core/hunterFactory';
import { NavGraph } from '../src/core/pathfinding';
import { Rng } from '../src/core/rng';
import { createWorld } from '../src/core/simulation';
import type { SystemContext } from '../src/core/system';
import {
  autoInvest, chooseInvestment, investPriority, investValue, levelCost, otherCandidates, urgentCandidates,
} from '../src/core/systems/town';
import type { GearInstance, Hunter, World } from '../src/core/world';
import { testConfig } from './helpers';

const config = testConfig();
const f = config.formula;
const nav = new NavGraph(config);

function makeCtx(seed = 1): SystemContext & { events: EventBuffer } {
  return {
    world: createWorld(config, seed), config, nav, rng: new Rng(seed),
    events: new EventBuffer(), debug: { aiScores: new Map() }, dtMs: 100,
  };
}

function hunter(patch: Partial<Hunter> = {}): Hunter {
  const h = rollHunter(config, new Rng(5), 'h0', config.index.squareNode, { x: 0, y: 0 }, 0);
  h.level = 1;
  h.personalities = [];
  h.equipment = {};
  h.skills = {};
  h.traits = {};
  h.traitPoints = 0;
  h.ai.goal = null;
  Object.assign(h, patch);
  return h;
}

const gear = (gearId: string, enhance: number, qualityId = 'q.rare'): GearInstance => ({ uid: `g-${gearId}`, gearId, qualityId, enhance });
const def = (id: string) => config.index.gear.get(id)!;

describe('gear savings (TECH_SPEC §5.4)', () => {
  it('holds upgradeSavingsFrac × the price of the cheapest craftable upgrade / spendRatio', () => {
    const h = hunter({ level: 8, equipment: { weapon: gear('gear.w.club', 3) } });
    // tusk (Lv4) is the cheapest clear upgrade over club+3; iron (Lv8) costs more.
    const price = def('gear.w.tusk').basePrice * f.aiTypicalQualityMult;
    expect(upgradeSavings(config, h, 'weapon')).toBeCloseTo((f.upgradeSavingsFrac * price) / f.spendRatio);
    // More than the old ≈ 0.3 × price / spendRatio: enough to pass auto-craft's buyer test (craftAffordFrac × list price).
    expect(f.upgradeSavingsFrac * f.spendRatio).toBeGreaterThanOrEqual(f.craftAffordFrac);
    const t = savingsTarget(config, h, 'weapon')!;
    const cur = 4 * (1 + 3 * f.enhanceStatPerLevel);
    expect(t.relGainPerGold).toBeCloseTo((9 * f.aiTypicalQualityMult - cur) / cur / price);
  });

  it('an upgrade on sale or being crafted is saved for in full, at its current (marked-down) price', () => {
    const w = createWorld(config, 1);
    const h = hunter({ level: 8, equipment: { weapon: gear('gear.w.tusk', 0) } });
    const base = upgradeSavings(config, h, 'weapon', w); // iron, typical quality, theoretical
    expect(base).toBeCloseTo((f.upgradeSavingsFrac * 500 * f.aiTypicalQualityMult) / f.spendRatio);
    expect(f.upgradeSavingsConcreteFrac).toBe(1);
    w.town.crafting['bld.smithy'] = { gearId: 'gear.w.iron', remainingMs: 1000 };
    expect(upgradeSavings(config, h, 'weapon', w)).toBeCloseTo((500 * f.aiTypicalQualityMult) / f.spendRatio);
    w.town.shop.push({ uid: 's1', gearId: 'gear.w.iron', qualityId: 'q.rare', enhance: 0, price: 250, listPrice: 500, listedAtMs: 0 });
    expect(upgradeSavings(config, h, 'weapon', w)).toBeCloseTo(250 / f.spendRatio);
  });

  it('dips into the savings only for an enhance that beats the upgrade by enhanceVsUpgradeMul per gold', () => {
    // Club +0 → +1 (90 %, cost 6) gains 5.4 % of the slot for 6 gold; the tusk gains ~100 % for ~200 gold.
    const h = hunter({ level: 4, equipment: { weapon: gear('gear.w.club', 0) } });
    const t = savingsTarget(config, h, 'weapon')!;
    const r0 = config.enhance[0]!;
    const cost = Math.round(60 * r0.costFrac);
    const enhPerGold = (r0.successRate * f.enhanceStatPerLevel) / cost;
    expect(enhPerGold).toBeGreaterThan(t.relGainPerGold);
    h.gold = Math.ceil(cost * enhanceReserveMul(config, r0.successRate));
    expect(h.gold).toBeLessThan(t.hold);
    // Better value, but not by enhanceVsUpgradeMul (the +1 is lost when the club is replaced): it waits.
    expect(enhPerGold).toBeLessThan(f.enhanceVsUpgradeMul * t.relGainPerGold);
    expect(bestEnhance(config, h)).toBeNull();
    const at1 = { ...config, formula: { ...f, enhanceVsUpgradeMul: 1 } };
    expect(bestEnhance(at1, h)?.slot).toBe('weapon');
    // With the savings in hand the try goes ahead anyway.
    h.gold = Math.ceil(cost * enhanceReserveMul(config, r0.successRate) + t.hold);
    expect(bestEnhance(config, h)?.slot).toBe('weapon');
  });

  it('savings are per hunter: enhancing a slot with no upgrade does not spend what is kept for another slot', () => {
    // Accessory core (Lv9) is top of its tier at level 9; the armor (padded) has a clear upgrade (hide/plate).
    const h = hunter({ level: 9, equipment: { necklace: gear('gear.r.core', 0), body: gear('gear.a.padded', config.enhance.length) } }); // maxed: not enhanceable itself
    expect(upgradeSavings(config, h, 'necklace')).toBe(0);
    const hold = enhanceSavingsHold(config, h);
    expect(hold).toBe(upgradeSavings(config, h, 'body'));
    expect(hold).toBeGreaterThan(0);
    const c = Math.round(def('gear.r.core').basePrice * config.enhance[0]!.costFrac);
    h.gold = Math.ceil(c * enhanceReserveMul(config, config.enhance[0]!.successRate) + hold) - 1;
    expect(bestEnhance(config, h)).toBeNull();
    h.gold += 2;
    expect(bestEnhance(config, h)?.slot).toBe('necklace');
  });
});

describe('enhance expected-value gate (TECH_SPEC §5.4)', () => {
  /** Lowest success rate a drop step may have: (2p − 1) / p ≥ enhanceMinNetFrac ⇔ p ≥ 1 / (2 − enhanceMinNetFrac). */
  const pMin = 1 / (2 - f.enhanceMinNetFrac);

  it('never tries a drop step whose expected gain is below enhanceMinNetFrac × the success-weighted step', () => {
    expect(f.enhanceMinNetFrac).toBeLessThanOrEqual(0);
    expect(pMin).toBeGreaterThan(f.enhanceMinSuccess); // the gate is what actually binds
    const losing = config.enhance.findIndex((r, i) => i > 0 && r.dropOnFail && r.successRate < pMin - 1e-9);
    expect(losing).toBeGreaterThan(0);
    const h = hunter({ gold: 1e9, equipment: { weapon: gear('gear.w.club', losing) } });
    expect(bestEnhance(config, h)).toBeNull();
    h.equipment.weapon = gear('gear.w.club', losing - 1); // the step before is within the gate
    const e = bestEnhance(config, h);
    expect(e).not.toBeNull();
    const step = 4 * f.enhanceStatPerLevel;
    expect(e!.expectedGain).toBeGreaterThanOrEqual(f.enhanceMinNetFrac * e!.successRate * step - 1e-9);
  });

  it('the Forge bonus can make a step worth trying again (same rate the forge uses)', () => {
    const at = config.enhance.findIndex((r, i) => i > 0 && r.dropOnFail && r.successRate < pMin - 1e-9);
    const w = createWorld(config, 1);
    const forge = w.town.buildings.find((s) => s.buildingId === config.index.forge)!;
    const h = hunter({ gold: 1e9, equipment: { weapon: gear('gear.w.club', at) } });
    expect(bestEnhance(config, h, w)).toBeNull();
    forge.level = config.index.buildings.get(config.index.forge)!.maxLevel; // +0.08
    expect(config.enhance[at]!.successRate + 0.08).toBeGreaterThanOrEqual(pMin);
    expect(bestEnhance(config, h, w)?.slot).toBe('weapon');
  });

  it('picks the slot with the best net expected gain per gold', () => {
    // Weapon at a fair 50 % drop step (EV 0) vs armor at a safe step: the armor wins although both are allowed.
    expect(pMin).toBeLessThanOrEqual(0.5);
    const fair = config.enhance.findIndex((r, i) => i > 0 && r.dropOnFail && Math.abs(r.successRate - 0.5) < 1e-9);
    const h = hunter({ gold: 1e9, equipment: { weapon: gear('gear.w.club', fair), body: gear('gear.a.padded', 0) } });
    expect(bestEnhance(config, h)?.slot).toBe('body');
  });
});

/** World with one hunter at `level` and every building at level 1. */
function townAt(level: number): SystemContext & { events: EventBuffer } {
  const ctx = makeCtx();
  const h = rollHunter(config, new Rng(7), 'h0', config.index.squareNode, { x: 0, y: 0 }, 0);
  h.level = level;
  ctx.world.hunters.push(h);
  return ctx;
}

describe('craft tier urgency (TECH_SPEC §5.12)', () => {
  it('starts the Town Hall step investTownHallLeadLevels before the craft step it unblocks', () => {
    // Smithy Lv1 (cap 15) needs Town Hall 2 for its next level; next smithy recipe above the cap is Lv22.
    const next = Math.min(...config.gear.filter((g) => g.craftBuilding === 'bld.smithy' && g.level > 15).map((g) => g.level));
    const lead = f.craftLevelAhead + f.investCraftLeadLevels;
    expect(f.investTownHallLeadLevels).toBeGreaterThan(0);
    const early = townAt(next - lead - f.investTownHallLeadLevels - 1);
    expect(urgentCandidates(config, early.world)).toEqual([]);
    const thTime = townAt(next - lead - f.investTownHallLeadLevels);
    expect(urgentCandidates(config, thTime.world).map((c) => c.buildingId)).toEqual(['bld.townhall']);
    // Once the Town Hall is up, the smithy itself is urgent only at the normal lead.
    const w = thTime.world;
    w.town.buildings.find((s) => s.buildingId === 'bld.townhall')!.level = 2;
    expect(urgentCandidates(config, w)).toEqual([]);
    w.hunters[0]!.level = next - lead;
    expect(urgentCandidates(config, w).map((c) => c.buildingId)).toContain('bld.smithy');
  });

  it('lists craft steps before the Town Hall step (they raise a tier cap right away)', () => {
    // Jeweler can still level under the current Town Hall, the Smithy cannot: both urgent, the Jeweler comes first
    // although the Smithy is first in config order.
    const ctx = townAt(40);
    const w = ctx.world;
    const set = (id: string, lv: number) => { w.town.buildings.find((s) => s.buildingId === id)!.level = lv; };
    set('bld.townhall', 3);
    set('bld.smithy', 3);
    set('bld.jeweler', 2);
    const ids = urgentCandidates(config, w).map((c) => c.buildingId);
    expect(ids).toEqual(['bld.jeweler', 'bld.townhall']);
    expect(config.buildings.findIndex((b) => b.id === 'bld.smithy')).toBeLessThan(config.buildings.findIndex((b) => b.id === 'bld.jeweler'));
  });

  it('imports missing materials for an urgent step after investUrgentImportSec (sooner than investImportSec)', () => {
    expect(f.investUrgentImportSec).toBeLessThan(f.investImportSec);
    const ctx = townAt(30);
    const w = ctx.world;
    w.town.gold = 1e5;
    autoInvest(ctx);
    expect(w.town.investPlan?.urgent).toBe(true);
    expect(w.town.buildings.some((s) => s.upgrade)).toBe(false);
    w.timeMs += f.investUrgentImportSec * 1000;
    autoInvest(ctx);
    expect(w.town.buildings.some((s) => s.upgrade?.auto && (s.upgrade.importGold ?? 0) > 0)).toBe(true);
  });
});

describe('value-based auto-investment (TECH_SPEC §5.12)', () => {
  const rich = (): World => {
    const w = createWorld(config, 1); // no hunters → nothing urgent
    for (const s of w.town.buildings) if (s.buildingId === config.index.townHall) s.level = 8;
    w.town.gold = 1e6;
    return w;
  };

  it('every step kind but the craft cap has value, and priority is value per gold', () => {
    const w = rich();
    const cands = otherCandidates(config, w);
    for (const kind of ['service', 'shop', 'forge', 'academy', 'tradingPost', 'storehouse']) {
      const c = cands.find((x) => config.index.buildings.get(x.buildingId)!.kind === kind)!;
      expect(c).toBeDefined();
      expect(investValue(config, c)).toBeGreaterThan(0);
      expect(investPriority(config, w, c)).toBeCloseTo(investValue(config, c) / c.cost.gold);
    }
  });

  /** Order in which steps get picked (applied instantly) by `pick`, as buildingId:toLevel. */
  const pickOrder = (pick: (w: World) => ReturnType<typeof chooseInvestment>, n: number): string[] => {
    const w = rich();
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const c = pick(w);
      if (!c) break;
      out.push(`${c.buildingId}:${c.toLevel}`);
      const s = w.town.buildings.find((x) => x.id === c.plotId);
      if (s) s.level = c.toLevel;
      else w.town.buildings.push({ id: c.plotId, buildingId: c.buildingId, level: c.toLevel, upgrade: null });
      w.town.investPlan = null;
    }
    return out;
  };
  const cheapestFirst = (w: World) =>
    otherCandidates(config, w).reduce<ReturnType<typeof chooseInvestment>>((a, b) => (!a || b.cost.gold < a.cost.gold ? b : a), null);

  it('Academy and Trading Post are upgraded much earlier than under the old cheapest-step rule', () => {
    const byValue = pickOrder((w) => chooseInvestment(config, w), 60);
    const byPrice = pickOrder(cheapestFirst, 60);
    for (const id of ['bld.academy', 'bld.trading']) {
      const v = byValue.indexOf(`${id}:2`);
      const p = byPrice.indexOf(`${id}:2`);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(p);
    }
    // The first pick is the best value per gold, not the cheapest step.
    const w = rich();
    const first = chooseInvestment(config, w)!;
    const cheapest = cheapestFirst(w)!;
    expect(first.buildingId).not.toBe(cheapest.buildingId);
    expect(investPriority(config, w, first)).toBeGreaterThan(investPriority(config, w, cheapest));
  });

  it('keeps a non-urgent plan while Town gold dips under the target (import timer is not reset)', () => {
    const ctx = makeCtx();
    const w = ctx.world;
    w.town.gold = 1e5;
    autoInvest(ctx);
    const plan = w.town.investPlan!;
    expect(plan).not.toBeNull();
    expect(plan.urgent).toBe(false);
    w.town.gold = 0;
    w.timeMs += 10_000;
    autoInvest(ctx);
    expect(w.town.investPlan).toEqual(plan);
    // Back above target after investImportSec: the import goes through on the same plan.
    w.town.gold = 1e5;
    w.timeMs = plan.sinceMs + f.investImportSec * 1000;
    autoInvest(ctx);
    const s = w.town.buildings.find((x) => x.id === plan.plotId)!;
    expect(s.upgrade?.toLevel).toBe(plan.toLevel);
    expect(levelCost(config, config.index.buildings.get(plan.buildingId)!, plan.toLevel)).not.toBeNull();
  });
});
