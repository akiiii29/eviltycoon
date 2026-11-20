/** Goal scoring (TECH_SPEC §5). Pure functions: given state, return scored candidates. */
import { GEAR_SLOTS, NEED_KEYS, type GameConfig, type GearSlot, type ModStat, type NeedKey } from '../config/types';
import { gearMainValue, needFrac, slotValue, urgentFrac, zoneScores, type ZoneScore } from '../formulas';
import { personalityFactor } from '../hunterFactory';
import type { NavGraph } from '../pathfinding';
import { canLearnTrait, nextSkillStudy } from '../systems/academy';
import { servicePrice } from '../systems/services';
import { bagHasSellable, bagUnrequested, materialDemand, requestZoneMul, type Demand } from '../systems/trading';
import { bagCount, type Goal, type Hunter, type ShopItem, type World } from '../world';

export interface Candidate {
  goal: Goal;
  score: number;
  label: string;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Urgent threshold for one need, scaled by personality (`urgent.<need>`; e.g. reckless halves the HP threshold). */
export function urgentThreshold(config: GameConfig, h: Hunter, need: NeedKey): number {
  return urgentFrac(config.formula, need) * personalityFactor(config, h, `urgent.${need}`);
}

/** First need below its (personality-scaled) urgent threshold, if any. */
export function urgentNeed(config: GameConfig, h: Hunter): NeedKey | null {
  for (const n of NEED_KEYS) if (needFrac(config, h, n) < urgentThreshold(config, h, n)) return n;
  return null;
}

/**
 * 0 if any need is urgent, 1 if all needs are above the soft threshold, linear in between (worst need wins).
 * The urgent threshold is scaled by the `urgent.<need>` personality factor (reckless HP ×0.5 → 0.125).
 * `inField`: the soft threshold is scaled too (never above softNeedFrac), so a reckless hunter keeps fighting
 * down to ~15 % HP; in town it stays unscaled so a revived (30 % HP) reckless hunter still heals before going out.
 */
export function needsOk(config: GameConfig, h: Hunter, inField = false): number {
  const f = config.formula;
  let worst = 1;
  for (const n of NEED_KEYS) {
    const k = personalityFactor(config, h, `urgent.${n}`);
    const u = urgentFrac(f, n) * k;
    const soft = Math.max(inField ? f.softNeedFrac * Math.min(k, 1) : f.softNeedFrac, u + 0.01);
    worst = Math.min(worst, clamp01((needFrac(config, h, n) - u) / (soft - u)));
  }
  return worst;
}

/** Zone the hunter is currently standing in, or null when in town. */
export function currentZone(nav: NavGraph, h: Hunter): string | null {
  return nav.node(h.nodeId).zoneId ?? null;
}

export function sameGoal(a: Goal | null, b: Goal | null): boolean {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === 'hunt' && b.type === 'hunt') return a.zoneId === b.zoneId;
  if (a.type === 'service' && b.type === 'service') return a.buildingId === b.buildingId;
  if (a.type === 'shop' && b.type === 'shop') return a.itemUid === b.itemUid;
  if (a.type === 'enhance' && b.type === 'enhance') return a.slot === b.slot;
  if (a.type === 'learn' && b.type === 'learn') return a.kind === b.kind && a.id === b.id;
  return true;
}

/** Bag fill 0..1 (total units / bagCapacity). */
export function bagFill(config: GameConfig, h: Hunter): number {
  const cap = config.formula.bagCapacity;
  return cap > 0 ? clamp01(bagCount(h) / cap) : 0;
}

/**
 * Best affordable, equippable upgrade on sale, or null.
 * Budget = gold × spendRatio × personality(spendRatio); gain = (new − current) / max(current, 1), must be ≥ minUpgradeGain.
 * Highest score (1.1 + min(gain,1) × 0.5) wins; ties → lower price, then uid.
 */
export function bestShopPurchase(config: GameConfig, world: World, h: Hunter): { item: ShopItem; gain: number } | null {
  const f = config.formula;
  const budget = h.gold * f.spendRatio * personalityFactor(config, h, 'spendRatio');
  let best: { item: ShopItem; gain: number } | null = null;
  for (const item of world.town.shop) {
    const def = config.index.gear.get(item.gearId);
    if (!def || h.level < def.level || item.price > budget) continue;
    const cur = slotValue(config, h, def.slot);
    const gain = (gearMainValue(config, item) - cur) / Math.max(cur, 1);
    if (gain < f.minUpgradeGain) continue;
    if (!best) { best = { item, gain }; continue; }
    const a = Math.min(gain, 1);
    const b = Math.min(best.gain, 1);
    if (a > b || (a === b && (item.price < best.item.price || (item.price === best.item.price && item.uid < best.item.uid)))) {
      best = { item, gain };
    }
  }
  return best;
}

/** Cost of enhancing a slot's gear to its next level: round(basePrice × enhance[next-1].costFrac); null if empty/maxed. */
export function enhanceCost(config: GameConfig, h: Hunter, slot: GearSlot): { cost: number; successRate: number } | null {
  const g = h.equipment[slot];
  if (!g) return null;
  const def = config.index.gear.get(g.gearId);
  const row = config.enhance[g.enhance]; // next = g.enhance + 1 → enhance[next - 1]
  if (!def || !row) return null;
  return { cost: Math.round(def.basePrice * row.costFrac), successRate: row.successRate };
}

/** Enhance risk budget: exponent on 1/successRate in the gold reserve (see enhanceReserveMul). */
export const ENHANCE_RISK_EXP = 0.5;
/** Never gamble below this success rate (hard stop at +10 with the current table; gold usually binds far earlier). */
export const ENHANCE_MIN_SUCCESS = 0.3;
/** Fraction of the next gear upgrade's shop budget kept back before enhancing an outdated piece. */
export const UPGRADE_SAVINGS_FRAC = 0.3;
/** Enhance score = (ENHANCE_BASE_SCORE + ENHANCE_GAIN_WEIGHT × expected relative slot gain) × econMul. */
export const ENHANCE_BASE_SCORE = 1.04;
export const ENHANCE_GAIN_WEIGHT = 1;

/**
 * Gold the hunter must hold to try an enhance, as a multiple of its cost:
 * enhanceGoldReserveMul / successRate^ENHANCE_RISK_EXP (risk budget: riskier steps need more spare gold,
 * e.g. ×2 at 100 %, ×2.4 at 70 %, ×2.8 at 50 %, ×3.7 at 30 %).
 */
export function enhanceReserveMul(config: GameConfig, successRate: number): number {
  return config.formula.enhanceGoldReserveMul / Math.pow(Math.max(successRate, 0.01), ENHANCE_RISK_EXP);
}

/** Quality multiplier the AI assumes for a gear piece it has not seen yet (uncommon-ish). */
const TYPICAL_QUALITY_MULT = 0.9;

/**
 * Gold to keep back before enhancing a slot: when a clearly better gear piece for that slot is wearable at the
 * hunter's level (typical-quality value ≥ current × (1 + minUpgradeGain)), the shop budget needed to buy it
 * (UPGRADE_SAVINGS_FRAC × basePrice × TYPICAL_QUALITY_MULT / (spendRatio × personality)); otherwise 0.
 * Polishing gear that is about to be replaced is wasted gold, so this keeps enhancing from starving gear upgrades.
 */
export function upgradeSavings(config: GameConfig, h: Hunter, slot: GearSlot): number {
  const f = config.formula;
  const cur = slotValue(config, h, slot);
  const spend = Math.max(f.spendRatio * personalityFactor(config, h, 'spendRatio'), 0.01);
  let need = 0;
  for (const def of config.gear) {
    if (def.slot !== slot || def.level > h.level) continue;
    if (def.mainValue * TYPICAL_QUALITY_MULT < cur * (1 + f.minUpgradeGain)) continue;
    const budget = (UPGRADE_SAVINGS_FRAC * def.basePrice * TYPICAL_QUALITY_MULT) / spend;
    need = need === 0 ? budget : Math.min(need, budget);
  }
  return need;
}

export interface EnhanceChoice {
  slot: GearSlot;
  cost: number;
  successRate: number;
  /** Expected main-stat change of the try (success gain minus the expected loss from dropOnFail), absolute. */
  expectedGain: number;
  /** expectedGain relative to the slot's current value. */
  expectedRelGain: number;
}

/**
 * Best next enhance over equipped slots, or null. A slot qualifies only if
 * successRate ≥ ENHANCE_MIN_SUCCESS and gold ≥ cost × enhanceReserveMul(successRate) + upgradeSavings(slot).
 * Among those, the highest (successRate × stat step) / cost wins (expected stat gain per gold); ties → GEAR_SLOTS order.
 */
export function bestEnhance(config: GameConfig, h: Hunter): EnhanceChoice | null {
  let best: EnhanceChoice | null = null;
  let bestPerGold = -Infinity;
  for (const slot of GEAR_SLOTS) {
    const c = enhanceCost(config, h, slot);
    const g = h.equipment[slot];
    if (!c || !g || c.successRate < ENHANCE_MIN_SUCCESS) continue;
    if (h.gold < c.cost * enhanceReserveMul(config, c.successRate) + upgradeSavings(config, h, slot)) continue;
    const cur = gearMainValue(config, g);
    const step = gearMainValue(config, { ...g, enhance: g.enhance + 1 }) - cur;
    const row = config.enhance[g.enhance]!;
    const loss = row.dropOnFail && g.enhance > 0 ? cur - gearMainValue(config, { ...g, enhance: g.enhance - 1 }) : 0;
    const expectedGain = c.successRate * step - (1 - c.successRate) * loss;
    const perGold = (c.successRate * step) / Math.max(c.cost, 1);
    if (perGold > bestPerGold) {
      bestPerGold = perGold;
      best = { slot, cost: c.cost, successRate: c.successRate, expectedGain, expectedRelGain: expectedGain / Math.max(cur, 1) };
    }
  }
  return best;
}

/** Class-agnostic trait preference for the AI (first = most wanted). */
const TRAIT_PRIORITY: readonly ModStat[] = ['atkPct', 'hpPct', 'defPct', 'atkSpeedPct', 'crit', 'eva'];

/**
 * What the hunter should study at the Academy, or null.
 * Skills first: cheapest learnable next level (ties → skill id), only if gold ≥ cost × enhanceGoldReserveMul
 * (at level 1 the starting gold is kept back, so a fresh hunter hunts before studying).
 * Otherwise a learnable trait (enough points, not maxed), by TRAIT_PRIORITY then trait id; cost = point cost.
 */
export function bestLearn(config: GameConfig, h: Hunter): { kind: 'skill' | 'trait'; id: string; cost: number } | null {
  const f = config.formula;
  // A level-1 hunter hunts first: it only studies with gold to spare beyond its starting purse.
  const spare = h.level >= 2 ? h.gold : h.gold - f.startingGold;
  let skill: { id: string; cost: number } | null = null;
  for (const def of config.skills) {
    const next = nextSkillStudy(config, h, def.id);
    if (!next || spare < next.cost * f.enhanceGoldReserveMul) continue;
    if (!skill || next.cost < skill.cost || (next.cost === skill.cost && def.id < skill.id)) skill = { id: def.id, cost: next.cost };
  }
  if (skill) return { kind: 'skill', ...skill };

  let trait: { id: string; cost: number; rank: number } | null = null;
  for (const def of config.traits) {
    if (!canLearnTrait(config, h, def.id)) continue;
    const r = TRAIT_PRIORITY.indexOf(def.stat);
    const rank = r < 0 ? TRAIT_PRIORITY.length : r;
    if (!trait || rank < trait.rank || (rank === trait.rank && def.id < trait.id)) trait = { id: def.id, cost: def.pointCost, rank };
  }
  return trait ? { kind: 'trait', id: trait.id, cost: trait.cost } : null;
}

/**
 * True when the bag holds at least one REQUESTED unit the town can afford to buy (avoids a sell goal that sells nothing).
 * `demand` defaults to the current Trading Post requests (materialDemand).
 */
export function townCanBuyFrom(config: GameConfig, world: World, h: Hunter, demand: Demand = materialDemand(config, world)): boolean {
  return bagHasSellable(config, world, h.bag, demand);
}

/**
 * Trading Post requests steer zone CHOICE only: each viable zone (zoneFit > 0) gets
 * requestZoneMul / (max requestZoneMul over viable zones), so the hunt score never rises above what it was
 * without requests (hunting vs. town goals is unchanged when the best zone is requested, slightly lower if not),
 * and a requested zone beats an unrequested one of similar fit. Zones the hunter cannot survive never get a bonus.
 */
export function huntZoneMuls(config: GameConfig, scores: readonly ZoneScore[], demand: Demand): Map<string, number> {
  const raw = new Map<string, number>();
  let max = 0;
  for (const { zone: z, fit } of scores) {
    if (fit <= 0) continue;
    const m = requestZoneMul(config, z, demand);
    raw.set(z.id, m);
    max = Math.max(max, m);
  }
  if (max > 0) for (const [id, m] of raw) raw.set(id, m / max);
  return raw;
}

/** Scores every available goal (without noise), highest first. */
export function scoreGoals(config: GameConfig, nav: NavGraph, world: World, h: Hunter): Candidate[] {
  const f = config.formula;
  const out: Candidate[] = [];
  const zoneNow = currentZone(nav, h);
  const ok = needsOk(config, h, zoneNow !== null);
  const huntMul = personalityFactor(config, h, 'goal.hunt');
  const fill = bagFill(config, h);
  const demand = materialDemand(config, world);

  const scores = zoneScores(config, world, h);
  const zoneMul = huntZoneMuls(config, scores, demand);
  for (const { zone: z, fit } of scores) {
    let s = fit * ok * huntMul;
    if (s > 0) s *= zoneMul.get(z.id) ?? 1;
    if (s > 0 && h.ai.goal?.type === 'hunt' && h.ai.goal.zoneId === z.id) s += f.huntStickiness;
    if (s > 0) out.push({ goal: { type: 'hunt', zoneId: z.id }, score: s, label: `hunt ${z.id}` });
  }

  const sellable = townCanBuyFrom(config, world, h, demand);
  // A full bag holding unrequested materials blocks requested drops; the post discards those, so the trip clears room.
  const dump = fill >= f.bagReturnFrac && bagUnrequested(h.bag, demand) > 0;
  if (zoneNow) {
    // In the field: services are only reachable by going home first; a full bag also sends the hunter home,
    // but only if the trading post will buy or discard something (otherwise hunters would shuttle back and forth).
    const bagScore = fill >= f.bagReturnFrac && (sellable || dump) ? 1.2 : 0;
    out.push({ goal: { type: 'returnTown' }, score: Math.max(1 - ok, bagScore), label: 'returnTown' });
  } else {
    for (const b of config.buildings) {
      if (b.kind !== 'service' || !b.need || b.price === undefined) continue;
      const frac = needFrac(config, h, b.need);
      if (frac >= 0.98 || h.gold < servicePrice(config, h, b)) continue;
      const base = frac < f.softNeedFrac ? 0.6 + 0.4 * (1 - frac) : 0.5 * (1 - frac);
      const s = base * personalityFactor(config, h, `goal.service.${b.need}`);
      out.push({ goal: { type: 'service', buildingId: b.id }, score: s, label: `service ${b.need}` });
    }

    // Economy (M2): damped when needs are low so services still win.
    const econMul = Math.max(ok, 0.5);
    if (sellable || dump) {
      out.push({ goal: { type: 'sell' }, score: (0.4 + 1.0 * fill) * econMul, label: 'sell' });
    }
    const buy = bestShopPurchase(config, world, h);
    if (buy) {
      const s = (1.1 + Math.min(buy.gain, 1) * 0.5) * econMul;
      out.push({ goal: { type: 'shop', itemUid: buy.item.uid }, score: s, label: `shop ${buy.item.gearId}` });
    }
    const enh = bestEnhance(config, h);
    if (enh) {
      out.push({ goal: { type: 'enhance', slot: enh.slot }, score: (ENHANCE_BASE_SCORE + ENHANCE_GAIN_WEIGHT * enh.expectedRelGain) * econMul, label: `enhance ${enh.slot}` });
    }
    const learn = bestLearn(config, h);
    if (learn) {
      const s = (learn.kind === 'skill' ? 1.15 : 1.2) * econMul;
      out.push({ goal: { type: 'learn', kind: learn.kind, id: learn.id }, score: s, label: `learn ${learn.kind} ${learn.id}` });
    }

    // Idling in town also recovers needs slowly for free, so a tired hunter who cannot pay rests instead of hunting.
    out.push({ goal: { type: 'wander', nodeId: '' }, score: Math.max(f.wanderScore, 0.5 * (1 - ok)), label: 'wander/rest' });
  }
  return out.sort((a, b) => b.score - a.score);
}
