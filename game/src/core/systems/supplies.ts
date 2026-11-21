/**
 * Service supplies and potion stock (TECH_SPEC §5.14; EHT-style "the Inn sells goods made from materials").
 *
 * - Every service building with `supplyCap` has a stock line `supply:<buildingId>`: one unit = one serving. Units are made
 *   from Town Storage materials by the recipes of config/consumable.json (`kind: supply`), one batch at a time
 *   (`craftSec`), up to `supplyCap[level]`. Serving a hunter takes one unit (systems/services.ts). Units of every tier are
 *   interchangeable; the tier only decides which material is used.
 * - The potion seller (the building with `potionCap`, the Infirmary) has a line `potion:<buildingId>` with one stock per
 *   potion tier, open once the Town Hall reaches potionTownHallLevel (systems/consumables.ts sells and drinks them).
 * - Essential recipe of a supply line = the tier most hunters use: the highest tier whose material drops in the zone a
 *   hunter farms (hunterTier; by level when it farms none — after reincarnation level and zone part ways). Its
 *   materials are requested by the Trading Post with priority (trading.autoMaterialDemand, economy.doSell buys them first)
 *   and production may use storage freely for it; another tier is used only from storage the crafting/investment requests
 *   do not need, so a stockout never eats a recipe's materials.
 * - Potion targets per tier = min(cap, hunters of that tier (hunterTier) × potionCarryMax); all of them are essential.
 * - An empty supply line is a stockout: the AI skips that service (hunters rest in town: free townIdleRegenPerSec regen,
 *   never a deadlock) and the time is counted (`stockoutMs`, stats.supplyStockoutMs).
 * Deterministic: no RNG, config order, timers in the world.
 */
import type { BuildingDef, ConsumableDef, ConsumableKind, GameConfig } from '../config/types';
import type { System, SystemContext } from '../system';
import type { Hunter, SupplyLine, World } from '../world';
import { buildingLevel, levelValue, townHallLevel } from './town';
import { baseMaterialNeed } from './trading';

/** Idle lines look for a recipe every SUPPLY_CHECK_TICKS ticks (1 s); the fallback tier check reads every request. */
const SUPPLY_CHECK_TICKS = 10;

export const lineKey =(kind: ConsumableKind, buildingId: string): string => `${kind}:${buildingId}`;

/** Every stock line of the config: [kind, building] for each service with supplyCap and the potion seller. */
export function stockLines(config: GameConfig): readonly { kind: ConsumableKind; building: BuildingDef; key: string }[] {
  let hit = linesCache.get(config);
  if (!hit) {
    hit = [];
    for (const b of config.buildings) {
      if (b.supplyCap) hit.push({ kind: 'supply', building: b, key: lineKey('supply', b.id) });
      if (b.potionCap) hit.push({ kind: 'potion', building: b, key: lineKey('potion', b.id) });
    }
    linesCache.set(config, hit);
  }
  return hit;
}
const linesCache = new WeakMap<GameConfig, { kind: ConsumableKind; building: BuildingDef; key: string }[]>();

/** Recipes of one line, by minLevel ascending (config order on ties). */
export function lineRecipes(config: GameConfig, kind: ConsumableKind, buildingId: string): readonly ConsumableDef[] {
  let byKey = recipeCache.get(config);
  if (!byKey) { byKey = new Map(); recipeCache.set(config, byKey); }
  const key = lineKey(kind, buildingId);
  let hit = byKey.get(key);
  if (!hit) {
    hit = config.consumables.filter((c) => c.kind === kind && c.buildingId === buildingId).sort((a, b) => a.minLevel - b.minLevel);
    byKey.set(key, hit);
  }
  return hit;
}
const recipeCache = new WeakMap<GameConfig, Map<string, ConsumableDef[]>>();

/** The tier for a level: the recipe with the highest minLevel ≤ level (the first one below every minLevel). */
export function tierFor(recipes: readonly ConsumableDef[], level: number): ConsumableDef | undefined {
  let best = recipes[0];
  for (const r of recipes) if (r.minLevel <= level) best = r;
  return best;
}

/** Zones where any material of the recipe drops (monster in the zone's spawn mix with a drop chance > 0), cached per config. */
function recipeZones(config: GameConfig, r: ConsumableDef): ReadonlySet<string> {
  let byId = zoneCache.get(config);
  if (!byId) {
    byId = new Map();
    for (const c of config.consumables) {
      const mats = new Set(c.materials.map((m) => m.materialId));
      const zs = new Set<string>();
      for (const z of config.zones) {
        for (const e of z.monsters) {
          if (e.weight <= 0) continue;
          if (config.index.monsters.get(e.monsterId)?.drops.some((d) => d.chance > 0 && mats.has(d.materialId))) zs.add(z.id);
        }
      }
      byId.set(c.id, zs);
    }
    zoneCache.set(config, byId);
  }
  return byId.get(r.id) ?? new Set();
}
const zoneCache = new WeakMap<GameConfig, Map<string, Set<string>>>();

/** Zone a hunter farms: its hunt goal's zone, else the zone of its last hunt goal (lastZoneId), else the zone it stands in. */
export function hunterZone(config: GameConfig, h: Hunter): string | undefined {
  if (h.ai.goal?.type === 'hunt') return h.ai.goal.zoneId;
  return h.lastZoneId ?? config.index.nodes.get(h.nodeId)?.zoneId;
}

/**
 * Tier a hunter uses on a line: the highest recipe whose materials drop in the zone it farms (so the request pulls
 * materials the hunter brings home anyway, also after reincarnation when level and zone part ways); else by level.
 */
export function hunterTier(config: GameConfig, recipes: readonly ConsumableDef[], h: Hunter): ConsumableDef | undefined {
  const z = hunterZone(config, h);
  if (z) for (let i = recipes.length - 1; i >= 0; i--) if (recipeZones(config, recipes[i]!).has(z)) return recipes[i];
  return tierFor(recipes, h.level);
}

/**
 * Essential tier of a supply line: the tier most hunters use (hunterTier; ties → higher tier); the first tier
 * without hunters.
 */
export function essentialTier(config: GameConfig, world: World, recipes: readonly ConsumableDef[]): ConsumableDef | undefined {
  const n = new Map<ConsumableDef, number>();
  for (const h of world.hunters) {
    const r = hunterTier(config, recipes, h);
    if (r) n.set(r, (n.get(r) ?? 0) + 1);
  }
  let best: ConsumableDef | undefined;
  let bestN = 0;
  for (const r of recipes) {
    const k = n.get(r) ?? 0;
    if (k > 0 && k >= bestN) { best = r; bestN = k; }
  }
  return best ?? recipes[0];
}

/** Median level of the hunters in town/field (journeys excluded); 1 without hunters. */
export function townRefLevel(world: World): number {
  const lv = world.hunters.map((h) => h.level).sort((a, b) => a - b);
  return lv.length ? lv[Math.floor((lv.length - 1) / 2)]! : 1;
}

/** Stock cap of a line now: 0 while the building is not working, potions also 0 under potionTownHallLevel. */
export function lineCap(config: GameConfig, world: World, kind: ConsumableKind, b: BuildingDef): number {
  const lv = buildingLevel(world, b.id);
  if (lv < 1) return 0;
  if (kind === 'supply') return levelValue(b.supplyCap, lv) ?? 0;
  if (townHallLevel(config, world) < config.formula.potionTownHallLevel) return 0;
  return levelValue(b.potionCap, lv) ?? 0;
}

export function getLine(world: World, key: string): SupplyLine | undefined {
  return world.town.supply?.[key];
}

function ensureLine(world: World, key: string): SupplyLine {
  const all = world.town.supply ?? (world.town.supply = {});
  return all[key] ?? (all[key] = { stock: {}, job: null, stockoutMs: 0 });
}

/** Units in stock over every tier of a line. */
export function lineStock(world: World, key: string): number {
  const l = getLine(world, key);
  let n = 0;
  if (l) for (const id in l.stock) n += l.stock[id]!;
  return n;
}

/** False only for a service with supplies whose stock is empty (services without supplyCap are unlimited). */
export function serviceInStock(world: World, b: BuildingDef): boolean {
  return !b.supplyCap || lineStock(world, lineKey('supply', b.id)) > 0;
}

/** Take one serving from a service's stock (lowest tier first). False when out of stock; true for unlimited services. */
export function takeSupply(world: World, config: GameConfig, b: BuildingDef): boolean {
  if (!b.supplyCap) return true;
  const l = getLine(world, lineKey('supply', b.id));
  if (!l) return false;
  for (const r of lineRecipes(config, 'supply', b.id)) {
    const n = l.stock[r.id] ?? 0;
    if (n <= 0) continue;
    if (n > 1) l.stock[r.id] = n - 1;
    else delete l.stock[r.id];
    world.stats.supplyUsed = (world.stats.supplyUsed ?? 0) + 1;
    return true;
  }
  return false;
}

/**
 * Target stock per recipe of a line (only recipes with a target > 0 are listed): supply → the essential tier at the
 * line cap; potion → per tier min(cap, hunters whose tier it is × potionCarryMax).
 */
export function lineTargets(config: GameConfig, world: World, kind: ConsumableKind, b: BuildingDef): Map<string, number> {
  const out = new Map<string, number>();
  const cap = lineCap(config, world, kind, b);
  if (cap <= 0) return out;
  const recipes = lineRecipes(config, kind, b.id);
  if (kind === 'supply') {
    const r = essentialTier(config, world, recipes);
    if (r) out.set(r.id, cap);
    return out;
  }
  const carry = Math.max(0, Math.floor(config.formula.potionCarryMax));
  for (const h of world.hunters) {
    const r = hunterTier(config, recipes, h);
    if (r) out.set(r.id, (out.get(r.id) ?? 0) + carry);
  }
  for (const [id, n] of out) {
    if (n <= 0) out.delete(id);
    else out.set(id, Math.min(cap, n));
  }
  return out;
}

/** Units of a recipe still wanted: min(target − stock − units in production, room left in the line). */
function deficit(line: SupplyLine | undefined, r: ConsumableDef, target: number, room: number): number {
  const have = (line?.stock[r.id] ?? 0) + (line?.job?.consumableId === r.id ? r.units : 0);
  return Math.max(0, Math.min(target - have, room));
}

function lineRoom(world: World, key: string, cap: number, config: GameConfig): number {
  const l = getLine(world, key);
  const job = l?.job ? (config.index.consumables.get(l.job.consumableId)?.units ?? 0) : 0;
  return cap - lineStock(world, key) - job;
}

/**
 * Materials the stock lines want in storage (full counts; the Trading Post subtracts storage): for every recipe with a
 * deficit, its materials × min(supplyRequestBatches, batches to cover it). These are the "essential" requests.
 */
export function supplyMaterialNeed(config: GameConfig, world: World): Record<string, number> {
  const out: Record<string, number> = {};
  const maxBatches = Math.max(0, Math.floor(config.formula.supplyRequestBatches ?? 0));
  if (maxBatches <= 0) return out;
  for (const { kind, building: b, key } of stockLines(config)) {
    const cap = lineCap(config, world, kind, b);
    if (cap <= 0) continue;
    const room = lineRoom(world, key, cap, config);
    if (room <= 0) continue;
    const line = getLine(world, key);
    for (const [id, target] of lineTargets(config, world, kind, b)) {
      const r = config.index.consumables.get(id)!;
      const d = deficit(line, r, target, room);
      if (d <= 0) continue;
      const batches = Math.min(maxBatches, Math.ceil(d / r.units));
      for (const m of r.materials) out[m.materialId] = (out[m.materialId] ?? 0) + m.count * batches;
    }
  }
  return out;
}

function hasIngredients(world: World, r: ConsumableDef, reserved?: Record<string, number>): boolean {
  return r.materials.every((m) => (world.town.storage[m.materialId] ?? 0) - (reserved?.[m.materialId] ?? 0) >= m.count);
}

/**
 * Recipe to start on an idle line, or null: the deficit recipes (largest deficit first, then higher tier) whose materials
 * are in storage; for a supply line with no such recipe, any other tier (highest first) whose materials are in storage
 * beyond what crafting/investment requests need (trading.baseMaterialNeed).
 */
export function pickRecipe(config: GameConfig, world: World, kind: ConsumableKind, b: BuildingDef): ConsumableDef | null {
  const cap = lineCap(config, world, kind, b);
  const key = lineKey(kind, b.id);
  const room = lineRoom(world, key, cap, config);
  if (cap <= 0 || room <= 0) return null;
  const line = getLine(world, key);
  const wanted: { r: ConsumableDef; d: number }[] = [];
  const targets = lineTargets(config, world, kind, b);
  for (const [id, target] of targets) {
    const r = config.index.consumables.get(id)!;
    const d = deficit(line, r, target, room);
    if (d > 0) wanted.push({ r, d });
  }
  wanted.sort((x, y) => y.d - x.d || y.r.minLevel - x.r.minLevel);
  for (const { r } of wanted) if (hasIngredients(world, r)) return r;
  if (kind !== 'supply') return null;
  const recipes = lineRecipes(config, kind, b.id);
  let reserved: Record<string, number> | undefined;
  for (let i = recipes.length - 1; i >= 0; i--) {
    const r = recipes[i]!;
    if (targets.has(r.id) || !r.materials.some((m) => (world.town.storage[m.materialId] ?? 0) >= m.count)) continue;
    reserved ??= baseMaterialNeed(config, world);
    if (hasIngredients(world, r, reserved)) return r;
  }
  return null;
}

function startJob(ctx: SystemContext, line: SupplyLine, r: ConsumableDef): void {
  const st = ctx.world.town.storage;
  for (const m of r.materials) {
    const left = (st[m.materialId] ?? 0) - m.count;
    if (left > 0) st[m.materialId] = left;
    else delete st[m.materialId];
  }
  line.job = { consumableId: r.id, remainingMs: Math.max(1, Math.round(r.craftSec * 1000)) };
}

/** Stock lines of a new game: every supply line full (level-1 cap) with its first tier; potion lines empty. */
export function initialSupply(config: GameConfig, levelOf: (buildingId: string) => number = () => 1, refLevel = 1): Record<string, SupplyLine> {
  const out: Record<string, SupplyLine> = {};
  for (const { kind, building: b, key } of stockLines(config)) {
    const stock: Record<string, number> = {};
    if (kind === 'supply') {
      const cap = levelValue(b.supplyCap, levelOf(b.id)) ?? 0;
      const r = tierFor(lineRecipes(config, kind, b.id), refLevel);
      if (r && cap > 0) stock[r.id] = cap;
    }
    out[key] = { stock, job: null, stockoutMs: 0 };
  }
  return out;
}

/**
 * Production (runs after the Trading Post, before crafting, so essential materials go to supplies first): finishes batches,
 * starts the next one on idle lines (checked every tick while a line is below its cap), counts service stockouts.
 */
export const suppliesSystem: System = {
  name: 'supplies',
  update(ctx) {
    const { world, config, dtMs } = ctx;
    for (const { kind, building: b, key } of stockLines(config)) {
      if (buildingLevel(world, b.id) < 1) continue;
      const line = ensureLine(world, key);
      let justDone = false;
      if (line.job) {
        line.job.remainingMs -= dtMs;
        if (line.job.remainingMs <= 0) {
          const r = config.index.consumables.get(line.job.consumableId);
          line.job = null;
          justDone = true;
          if (r) {
            line.stock[r.id] = (line.stock[r.id] ?? 0) + r.units;
            const st = world.stats;
            if (kind === 'supply') st.supplyProduced = (st.supplyProduced ?? 0) + r.units;
            else st.potionsProduced = (st.potionsProduced ?? 0) + r.units;
            ctx.events.emit(world.tick, { type: 'supplyProduced', buildingId: b.id, consumableId: r.id, units: r.units });
          }
        }
      }
      // A batch that just finished starts the next at once; idle lines look for materials once per second.
      if (!line.job && (justDone || world.tick % SUPPLY_CHECK_TICKS === 0)) {
        const r = pickRecipe(config, world, kind, b);
        if (r) startJob(ctx, line, r);
      }
      if (kind === 'supply' && lineStock(world, key) <= 0) {
        line.stockoutMs += dtMs;
        world.stats.supplyStockoutMs = (world.stats.supplyStockoutMs ?? 0) + dtMs;
      }
    }
  },
};
