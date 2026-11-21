/**
 * Town tax (M4, TECH_SPEC §5.10).
 *
 * What is taxed: **kill gold only**, at the moment it is earned (combat.grantKill → grantKillGold). Kill gold is the only
 * gold that enters the economy from outside (besides the kingdom's bounty completion gold, which goes to the Town). Every
 * other hunter income is already paid by the Town itself — material sales at the Trading Post (with its own
 * `tradeSaleTax`) and bounty payouts out of Town escrow — so taxing those would just be the Town paying itself less.
 * Collecting at the kill needs no "owed tax" state on the hunter, no visit to town and no RNG.
 *
 *  - tax = floor(killGold × rate); the hunter gets the rest, Town gold gets the tax. Gold stays an integer and the
 *    transfer is exact (hunter + town gold is unchanged by the tax). Kills worth less than 1 / rate gold pay nothing,
 *    so the cheap early-game monsters are effectively untaxed.
 *  - rate = town.taxRate (set by `town.setTaxRate`, optional in the save: no schema bump) or config `taxRate`, clamped to
 *    [taxMinRate, taxMaxRate].
 *  - Cost of a high rate: every taxed kill (tax > 0) costs the killer
 *    taxMoodPerKill × max(0, rate − taxMoodFreeRate) × personality(decay.mood) mood. Low mood sends hunters to the Tavern
 *    sooner (more time and gold spent in town, less hunting) and, under moodPenaltyFrac, lowers ATK/DEF (moodStatMult).
 *    At or below taxMoodFreeRate (≥ the default rate) there is no cost, so the default leaves pacing alone.
 */
import type { GameConfig } from '../config/types';
import { personalityFactor } from '../hunterFactory';
import type { SystemContext } from '../system';
import type { Hunter, World } from '../world';

/** Current tax rate: town.taxRate if the player set one, else config taxRate; clamped to [taxMinRate, taxMaxRate]. */
export function taxRate(config: GameConfig, world: World): number {
  const f = config.formula;
  const r = world.town.taxRate ?? f.taxRate;
  return Math.min(f.taxMaxRate, Math.max(f.taxMinRate, Number.isFinite(r) ? r : f.taxRate));
}

/** Tax on one kill worth `gold`: floor(gold × rate) (0 for gold ≤ 0). */
export function taxOn(gold: number, rate: number): number {
  return gold > 0 && rate > 0 ? Math.floor(gold * rate) : 0;
}

/** Mood a taxed kill costs before the personality factor: taxMoodPerKill × max(0, rate − taxMoodFreeRate). */
export function taxMoodLoss(config: GameConfig, rate: number): number {
  const f = config.formula;
  return f.taxMoodPerKill * Math.max(0, rate - f.taxMoodFreeRate);
}

/** Validation for `town.setTaxRate`. Returns a rejection reason or null. */
export function validateTaxRate(config: GameConfig, rate: unknown): string | null {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return 'invalid rate';
  if (rate < config.formula.taxMinRate) return 'rate below minimum';
  if (rate > config.formula.taxMaxRate) return 'rate above maximum';
  return null;
}

/** Set the Town tax rate (assumed valid). */
export function setTaxRate(ctx: SystemContext, rate: number): void {
  ctx.world.town.taxRate = rate;
  ctx.events.emit(ctx.world.tick, { type: 'taxRateChanged', rate });
}

/**
 * Called from combat.grantKill instead of `h.gold += gold`: pays the hunter the kill gold minus tax, moves the tax to
 * Town gold, applies the mood cost. Returns the tax taken.
 */
export function grantKillGold(ctx: SystemContext, h: Hunter, gold: number): number {
  const { world, config } = ctx;
  const rate = taxRate(config, world);
  const tax = taxOn(gold, rate);
  h.gold += gold - tax;
  if (tax <= 0) return 0;
  world.town.gold += tax;
  world.stats.taxCollected = (world.stats.taxCollected ?? 0) + tax;
  const mood = taxMoodLoss(config, rate);
  if (mood > 0) h.needs.mood = Math.max(0, h.needs.mood - mood * personalityFactor(config, h, 'decay.mood'));
  ctx.events.emit(world.tick, { type: 'taxCollected', hunterId: h.id, gold: tax });
  return tax;
}
