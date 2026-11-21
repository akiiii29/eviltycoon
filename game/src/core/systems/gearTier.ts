/**
 * Gear tiers per difficulty (TECH_SPEC §5.8).
 *
 * Every difficulty is also a gear tier: an item records the difficulty it was crafted at (`GearInstance.difficultyId`)
 * and its main stat is × that difficulty's `gearStatMul` (formulas.gearMainValue), its price and craft gold × `gearPriceMul`.
 * The first difficulty is the base tier (×1, plain recipe). A higher tier needs, on top of the recipe, its difficulty's
 * essence material (`essenceId`), which only monsters spawned under that difficulty drop. Tier and the Smithy/Jeweler
 * level cap (gear.level, systems/town.gearCraftable) are separate axes.
 *
 * Reincarnation unlocks harder difficulties; with `town.autoDifficulty` the Town steps up once enough hunters have
 * reincarnated, so the essence of the new tier starts dropping and its gear makes the old (reclaimed) gear obsolete.
 */
import type { DifficultyDef, GameConfig, GearDef } from '../config/types';
import type { SystemContext } from '../system';
import { bagCount, type Hunter, type Monster, type World } from '../world';
import { allHunters } from './journey';

export interface MaterialCount { materialId: string; count: number }

/** The difficulty row of a gear tier id (absent/unknown = the base tier, the first difficulty). */
export function tierDef(config: GameConfig, difficultyId: string | undefined): DifficultyDef {
  return (difficultyId ? config.index.difficulties.get(difficultyId) : undefined) ?? config.difficulties[0]!;
}

/** Base tier id (the first difficulty). */
export function baseTier(config: GameConfig): string {
  return config.difficulties[0]!.id;
}

export function tierPriceMul(config: GameConfig, difficultyId: string | undefined): number {
  return tierDef(config, difficultyId).gearPriceMul ?? 1;
}

/** Essence units a tier craft of this gear needs: max(1, round(gear.level × craftEssencePerLevel)); 0 for the base tier. */
export function essenceCount(config: GameConfig, gear: GearDef, difficultyId: string | undefined): number {
  const d = tierDef(config, difficultyId);
  if (!d.essenceId) return 0;
  return Math.max(1, Math.round(gear.level * config.formula.craftEssencePerLevel));
}

/** Recipe materials at a tier: the gear's materials plus the tier's essence (base tier: the plain recipe). */
export function recipeMaterials(config: GameConfig, gear: GearDef, difficultyId: string | undefined): readonly MaterialCount[] {
  const d = tierDef(config, difficultyId);
  const n = essenceCount(config, gear, difficultyId);
  if (!d.essenceId || n <= 0) return gear.materials;
  return [...gear.materials, { materialId: d.essenceId, count: n }];
}

/**
 * Tiers the craft buildings may use now: unlocked difficulties with order ≤ the current difficulty, lowest first.
 * Lower tiers stay craftable (their essence may still be in storage; the base tier needs none).
 */
export function craftTiers(config: GameConfig, world: World): DifficultyDef[] {
  const cur = config.index.difficulties.get(world.town.difficulty)?.order ?? 0;
  const unlocked = world.town.unlockedDifficulties;
  return config.difficulties.filter((d, i) => i === 0 || (d.order <= cur && unlocked.includes(d.id)));
}

/** True when a craft at this tier is allowed now (see craftTiers). */
export function tierCraftable(config: GameConfig, world: World, difficultyId: string | undefined): boolean {
  const d = tierDef(config, difficultyId);
  return craftTiers(config, world).includes(d);
}

/**
 * Essence drop on a kill: monsters spawned under a difficulty with an essence drop it with essenceDropChance into the
 * killer's bag while there is room. No RNG draw (and no change) for difficulties without essence, so Easy runs are
 * unchanged by this feature.
 */
export function dropEssence(ctx: SystemContext, h: Hunter, m: Monster): void {
  const d = ctx.config.index.difficulties.get(m.difficultyId);
  if (!d?.essenceId || !(d.essenceDropChance && d.essenceDropChance > 0)) return;
  if (!ctx.rng.chance(d.essenceDropChance)) return;
  if (bagCount(h) >= ctx.config.formula.bagCapacity) return;
  h.bag[d.essenceId] = (h.bag[d.essenceId] ?? 0) + 1;
}

/**
 * Auto difficulty (town.autoDifficulty, TECH_SPEC §5.8): step up one difficulty when the next one (by order) is
 * unlocked and at least max(its unlockHunters, ceil(diffAutoAdvanceFrac × hunters)) hunters (incl. those on a journey)
 * have reincarnation ≥ its unlockReincarnation. Never steps down. Returns the new difficulty id or null.
 */
export function autoAdvanceDifficulty(ctx: SystemContext): string | null {
  const { world, config } = ctx;
  if (!world.town.autoDifficulty) return null;
  const cur = config.index.difficulties.get(world.town.difficulty);
  const i = cur ? config.difficulties.indexOf(cur) : 0;
  const next = config.difficulties[i + 1];
  if (!next || !world.town.unlockedDifficulties.includes(next.id)) return null;
  const hunters = allHunters(world);
  const need = Math.max(next.unlockHunters, Math.ceil(config.formula.diffAutoAdvanceFrac * hunters.length - 1e-9), 1);
  let n = 0;
  for (const h of hunters) if (h.reincarnation >= next.unlockReincarnation) n++;
  if (n < need) return null;
  world.town.difficulty = next.id;
  ctx.events.emit(world.tick, { type: 'difficultyChanged', difficultyId: next.id });
  return next.id;
}
