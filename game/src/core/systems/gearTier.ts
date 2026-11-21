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
import { GEAR_SLOTS, type DifficultyDef, type GameConfig, type GearDef, type GearQualityDef, type GearSlot } from '../config/types';
import { crowdFactor, killsPerLife } from '../formulas';
import type { SystemContext } from '../system';
import { bagCount, isAlive, type GearInstance, type Hunter, type Monster, type World } from '../world';
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

/**
 * Gold of one enhance step (TECH_SPEC §5.4/§5.8): round(basePrice × costFrac × tier gearPriceMul). Tier-aware like the
 * shop price and the main stat (× gearStatMul), so a high-tier piece costs as much more to enhance as it is worth more;
 * base-tier gear (×1) costs exactly what it did before tiers existed. Shared by the forge (economy.enhanceCost) and the
 * AI estimate (ai/utility.expectedEnhanceCost).
 */
export function enhanceStepCost(config: GameConfig, gear: GearDef, costFrac: number, difficultyId: string | undefined): number {
  return Math.round(gear.basePrice * costFrac * tierPriceMul(config, difficultyId));
}

/**
 * Essence units a tier craft of this gear needs: max(1, round(gear.level × craftEssencePerLevel × essenceMul)); 0 for the
 * base tier. essenceMul (M5) = the piece's share of its slot group, so a full 8-slot kit needs about what 3 pieces did.
 */
export function essenceCount(config: GameConfig, gear: GearDef, difficultyId: string | undefined): number {
  const d = tierDef(config, difficultyId);
  if (!d.essenceId) return 0;
  return Math.max(1, Math.round(gear.level * config.formula.craftEssencePerLevel * (gear.essenceMul ?? 1)));
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

// ---------------------------------------------------------------------------------------------------------------
// Starter kit, auto difficulty with a bootstrap gate and a step-down (TECH_SPEC §5.8, long-run balance).
// ---------------------------------------------------------------------------------------------------------------

/** Quality of starter-kit pieces: the "Rare" reference (statMult closest to 1), as crafting.referenceQuality. */
function kitQuality(config: GameConfig): GearQualityDef | undefined {
  let best: GearQualityDef | undefined;
  for (const q of config.qualities) if (!best || Math.abs(q.statMult - 1) < Math.abs(best.statMult - 1)) best = q;
  return best;
}

/** Starter-kit recipe per slot: the lowest-level gear of each slot (ties: config order). */
function kitGear(config: GameConfig): Map<GearSlot, GearDef> {
  const out = new Map<GearSlot, GearDef>();
  for (const g of config.gear) {
    const cur = out.get(g.slot);
    if (!cur || g.level < cur.level) out.set(g.slot, g);
  }
  return out;
}

/**
 * Starter-kit pieces for the empty slots of `h` at gear tier `difficultyId`: the lowest-level gear of each slot, reference
 * quality, +0, no option lines (uid left empty). A level-1 hunter without gear cannot kill anything from Expert on
 * (power ratio < zoneFitMin even in the first zone), so with no kills there are no materials, no crafts and no way out:
 * the kit is what lets a reincarnated (or newly arrived) hunter bootstrap on a raised difficulty.
 */
export function starterKitFor(config: GameConfig, h: Pick<Hunter, 'equipment'>, difficultyId: string): GearInstance[] {
  const q = kitQuality(config);
  if (!q) return [];
  const tier = tierDef(config, difficultyId).id;
  const out: GearInstance[] = [];
  const kit = kitGear(config);
  for (const slot of GEAR_SLOTS) {
    const g = kit.get(slot);
    if (!g || h.equipment[slot]) continue;
    out.push({ uid: '', gearId: g.id, qualityId: q.id, enhance: 0, difficultyId: tier });
  }
  return out;
}

/**
 * Give `h` a free starter kit (starterKitFor at the Town's current difficulty) when the Town is above the base
 * difficulty — on reincarnation (after reclaim) and on arrival. At the base difficulty nothing happens (a fresh game
 * plays exactly as before). Event `starterKitGiven`, stat `starterKits`. Returns the number of pieces.
 */
export function giveStarterKit(ctx: SystemContext, h: Hunter): number {
  const { world, config } = ctx;
  if (!world?.town || world.town.difficulty === baseTier(config)) return 0;
  const items = starterKitFor(config, h, world.town.difficulty);
  if (items.length === 0) return 0;
  for (const it of items) {
    it.uid = 'g' + world.nextId++;
    h.equipment[config.index.gear.get(it.gearId)!.slot] = it;
  }
  world.stats.starterKits = (world.stats.starterKits ?? 0) + 1;
  ctx.events.emit(world.tick, { type: 'starterKitGiven', hunterId: h.id, itemUids: items.map((x) => x.uid), difficultyId: world.town.difficulty });
  return items.length;
}

/**
 * Best power ratio over the zones for a hunter alone in a full zone (steady stats): sqrt(killsPerLife / zoneRefKills)
 * with crowdFactor(monsterCap, 1) — the AI's scale (formulas.powerRatio) in the worst live case, which is what a hunter
 * walking into an untouched or refilled zone sees (the static zoneCrowd is far milder and over-states it).
 */
export function bestZoneRatio(config: GameConfig, h: Hunter, difficultyId: string): number {
  const f = config.formula;
  let best = 0;
  for (const z of config.zones) {
    const kills = killsPerLife(config, h, z, difficultyId, crowdFactor(z.monsterCap, 1, f));
    best = Math.max(best, Math.sqrt(kills / f.zoneRefKills));
  }
  return best;
}

/**
 * Bootstrap ratio of a hunter at a difficulty: bestZoneRatio of the hunter as it would be right after reincarnating there
 * — level 1, base job, its rolled base stats, only a starter kit of that tier (traits, skills, runes, growth kept).
 * The weakest hunter's bootstrap ratio decides whether the Town may step up (autoAdvanceDifficulty).
 */
export function bootstrapRatio(config: GameConfig, h: Hunter, difficultyId: string): number {
  const probe: Hunter = { ...h, level: 1, exp: 0, jobTier: 0, stats: { ...h.rollStats }, equipment: {}, buffs: [] };
  delete probe.jobId;
  for (const it of starterKitFor(config, probe, difficultyId)) probe.equipment[config.index.gear.get(it.gearId)!.slot] = it;
  return bestZoneRatio(config, probe, difficultyId);
}

/**
 * Auto difficulty (town.autoDifficulty, TECH_SPEC §5.8): step up one difficulty when the next one (by order) is
 * unlocked, at least max(its unlockHunters, ceil(diffAutoAdvanceFrac × hunters)) hunters (incl. those on a journey)
 * have reincarnation ≥ its unlockReincarnation, AND every hunter's bootstrapRatio there is ≥ diffAutoMinRatio (a
 * hunter reincarnating at the new difficulty must be able to hunt the easiest zone, else it sits at level 1 with 0 kills
 * forever), AND every hunter in the world as it is now has a zone with bestZoneRatio ≥ diffAutoMinRatio there.
 * Returns the new difficulty id or null.
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
  const min = config.formula.diffAutoMinRatio ?? 0;
  if (min > 0) {
    for (const h of hunters) if (bootstrapRatio(config, h, next.id) < min) return null;
    // Hunters in the world as they are now, too (a low-level one in old-tier gear would trip the step-down at once).
    for (const h of world.hunters) if (isAlive(h) && bestZoneRatio(config, h, next.id) < min) return null;
  }
  world.town.difficulty = next.id;
  ctx.events.emit(world.tick, { type: 'difficultyChanged', difficultyId: next.id });
  return next.id;
}

/**
 * Auto step-down (town.autoDifficulty): when a hunter in the world (alive, not on a journey / in the portal) has no zone
 * with bestZoneRatio ≥ zoneFitMin at the current difficulty — it cannot hunt anywhere — the Town drops one difficulty
 * (event `difficultyChanged` with `stepDown`). Safety net for saves that are already stuck and for weak arrivals; the
 * advance gate (diffAutoMinRatio > zoneFitMin) keeps it from flapping. Returns the new difficulty id or null.
 */
export function autoStepDownDifficulty(ctx: SystemContext): string | null {
  const { world, config } = ctx;
  if (!world.town.autoDifficulty) return null;
  const cur = config.index.difficulties.get(world.town.difficulty);
  const i = cur ? config.difficulties.indexOf(cur) : 0;
  if (!cur || i <= 0) return null;
  const minFit = config.formula.zoneFitMin;
  const stuck = world.hunters.some((h) => isAlive(h) && bestZoneRatio(config, h, cur.id) < minFit);
  if (!stuck) return null;
  const lower = config.difficulties[i - 1]!;
  world.town.difficulty = lower.id;
  ctx.events.emit(world.tick, { type: 'difficultyChanged', difficultyId: lower.id, stepDown: true });
  return lower.id;
}
