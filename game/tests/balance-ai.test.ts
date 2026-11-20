import {
  bestEnhance, ENHANCE_BASE_SCORE, ENHANCE_MIN_SUCCESS, enhanceReserveMul, needsOk, scoreGoals, upgradeSavings, urgentNeed,
} from '../src/core/ai/utility';
import { rollHunter } from '../src/core/hunterFactory';
import { NavGraph } from '../src/core/pathfinding';
import { Rng } from '../src/core/rng';
import { createWorld } from '../src/core/simulation';
import type { GearInstance, Hunter } from '../src/core/world';
import { testConfig } from './helpers';

const config = testConfig();
const nav = new NavGraph(config);
const f = config.formula;

/** A level-1 hunter in town with full needs, no gear and no personalities, plus the patch. */
function hunter(patch: Partial<Hunter> = {}): Hunter {
  const h = rollHunter(config, new Rng(5), 'h0', config.index.squareNode, { x: 0, y: 0 }, 0);
  h.level = 1;
  h.personalities = [];
  h.equipment = {};
  h.skills = {};
  h.traits = {};
  h.traitPoints = 0;
  h.ai.goal = null;
  h.nodeId = config.index.squareNode;
  Object.assign(h, patch);
  return h;
}

const gear = (gearId: string, enhance: number, qualityId = 'q.rare'): GearInstance => ({ uid: `g-${gearId}`, gearId, qualityId, enhance });
const rowAt = (enhance: number) => config.enhance[enhance]!; // step from +enhance to +enhance+1
const cost = (basePrice: number, enhance: number) => Math.round(basePrice * rowAt(enhance).costFrac);

describe('balance AI: enhance risk budget', () => {
  it('reserve multiple grows as the success rate falls', () => {
    expect(enhanceReserveMul(config, 1)).toBeCloseTo(f.enhanceGoldReserveMul);
    expect(enhanceReserveMul(config, 0.5)).toBeGreaterThan(enhanceReserveMul(config, 0.7));
    expect(enhanceReserveMul(config, 0.7)).toBeGreaterThan(enhanceReserveMul(config, 0.95));
  });

  it('a risky step needs more spare gold than a safe one of the same cost', () => {
    const h = hunter({ equipment: { weapon: gear('gear.w.club', 4) } }); // +4 → +5
    const c = cost(60, 4);
    const need = Math.ceil(c * enhanceReserveMul(config, rowAt(4).successRate));
    expect(need).toBeGreaterThan(c * f.enhanceGoldReserveMul);
    h.gold = need - 1;
    expect(bestEnhance(config, h)).toBeNull();
    h.gold = need;
    expect(bestEnhance(config, h)).toMatchObject({ slot: 'weapon', cost: c, successRate: rowAt(4).successRate });
  });

  it('when the risky slot is not affordable, a safe slot is still enhanced', () => {
    const h = hunter({ equipment: { weapon: gear('gear.w.club', 5), armor: gear('gear.a.padded', 0) } });
    h.gold = Math.ceil(cost(60, 0) * enhanceReserveMul(config, rowAt(0).successRate)); // enough for padded +0 → +1 only
    expect(bestEnhance(config, h)?.slot).toBe('armor');
  });

  it(`never gambles below ${ENHANCE_MIN_SUCCESS} success`, () => {
    const first = config.enhance.findIndex((r) => r.successRate < ENHANCE_MIN_SUCCESS);
    expect(first).toBeGreaterThan(0);
    const h = hunter({ gold: 1e9, equipment: { weapon: gear('gear.w.club', first) } });
    expect(bestEnhance(config, h)).toBeNull();
    h.equipment.weapon = gear('gear.w.club', first - 1);
    expect(bestEnhance(config, h)?.successRate).toBeGreaterThanOrEqual(ENHANCE_MIN_SUCCESS);
  });

  it('the score does not collapse with the success rate (a 50–60 % gamble still beats hunting with spare gold)', () => {
    const h = hunter({ gold: 1e6, equipment: { weapon: gear('gear.w.club', 4) } }); // 60 % in the current table
    expect(rowAt(4).successRate).toBeGreaterThanOrEqual(ENHANCE_MIN_SUCCESS);
    const scored = scoreGoals(config, nav, createWorld(config, 1), h);
    const enh = scored.find((c) => c.goal.type === 'enhance')!;
    expect(enh.score).toBeGreaterThan(ENHANCE_BASE_SCORE - 0.02);
    const hunt = Math.max(...scored.filter((c) => c.goal.type === 'hunt').map((c) => c.score));
    expect(enh.score).toBeGreaterThan(hunt);
  });

  it('expected gain accounts for dropOnFail (EV = step × (2·successRate − 1))', () => {
    const at = config.enhance.findIndex((r, i) => i > 0 && r.dropOnFail && r.successRate >= ENHANCE_MIN_SUCCESS);
    expect(at).toBeGreaterThan(0);
    const h = hunter({ gold: 1e9, equipment: { weapon: gear('gear.w.club', at) } });
    const e = bestEnhance(config, h)!;
    // Enhance is linear in the base value, so the +1 and −1 steps are both 4 × enhanceStatPerLevel.
    const step = 4 * f.enhanceStatPerLevel;
    expect(e.expectedGain).toBeCloseTo(step * (2 * rowAt(at).successRate - 1));
  });

  it('keeps back savings for a wearable upgrade instead of polishing outdated gear', () => {
    const h = hunter({ level: 4, equipment: { weapon: gear('gear.w.club', 0) } });
    const savings = upgradeSavings(config, h, 'weapon');
    expect(savings).toBeGreaterThan(0); // tusk (level 4) is a clear upgrade over a club
    const base = cost(60, 0) * enhanceReserveMul(config, rowAt(0).successRate);
    h.gold = Math.floor(base + savings) - 1;
    expect(bestEnhance(config, h)).toBeNull();
    h.gold = Math.ceil(base + savings);
    expect(bestEnhance(config, h)?.slot).toBe('weapon');
    // At level 1 nothing better is wearable: no savings.
    expect(upgradeSavings(config, hunter({ equipment: { weapon: gear('gear.w.club', 0) } }), 'weapon')).toBe(0);
  });
});

describe('balance AI: reckless urgent threshold', () => {
  const inField = (h: Hunter): Hunter => {
    h.nodeId = 'z1.b';
    h.ai.goal = { type: 'hunt', zoneId: 'zone.meadow' };
    return h;
  };

  it('plain hunters are urgent at 20 % HP, reckless only below ~12.5 %', () => {
    const plain = hunter();
    const reckless = hunter({ personalities: ['pers.reckless'] });
    for (const h of [plain, reckless]) h.needs.hp = h.stats.hp * 0.2;
    expect(urgentNeed(config, plain)).toBe('hp');
    expect(urgentNeed(config, reckless)).toBeNull();
    reckless.needs.hp = reckless.stats.hp * 0.12;
    expect(urgentNeed(config, reckless)).toBe('hp');
    // Other needs are not affected by the trait.
    const r2 = hunter({ personalities: ['pers.reckless'] });
    r2.needs.stamina = f.needMax * (f.urgentStaminaFrac - 0.01);
    expect(urgentNeed(config, r2)).toBe('stamina');
  });

  it('in the field a reckless hunter at 20 % HP keeps hunting; a plain one heads home', () => {
    const plain = inField(hunter());
    const reckless = inField(hunter({ personalities: ['pers.reckless'] }));
    for (const h of [plain, reckless]) h.needs.hp = h.stats.hp * 0.2;
    expect(needsOk(config, plain, true)).toBe(0);
    expect(needsOk(config, reckless, true)).toBeGreaterThan(0.5);
    const w = createWorld(config, 1);
    expect(scoreGoals(config, nav, w, plain)[0]!.goal.type).toBe('returnTown');
    expect(scoreGoals(config, nav, w, reckless)[0]!.goal.type).toBe('hunt');
  });

  it('in town a revived reckless hunter (30 % HP) heals before going out again', () => {
    const h = hunter({ personalities: ['pers.reckless'], gold: 100 });
    h.needs.hp = h.stats.hp * f.reviveHpFrac;
    expect(scoreGoals(config, nav, createWorld(config, 1), h)[0]!.goal).toEqual({ type: 'service', buildingId: 'bld.infirmary' });
  });
});

describe('balance AI: hunt before studying', () => {
  it('a fresh level-1 hunter with its starting gold goes hunting, not to the Academy', () => {
    const h = hunter({ gold: f.startingGold, classId: 'class.vanguard', jobTier: 0 });
    const scored = scoreGoals(config, nav, createWorld(config, 1), h);
    expect(scored[0]!.goal.type).toBe('hunt');
    expect(scored.some((c) => c.goal.type === 'learn')).toBe(false);
  });
});
