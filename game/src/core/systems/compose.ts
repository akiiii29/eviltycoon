import type { GameConfig } from '../config/types';
import type { System, SystemContext } from '../system';
import type { World } from '../world';
import { supplyMaterialNeed } from './supplies';
import { buildingLevel } from './town';
import { autoMaterialDemand, baseMaterialNeed } from './trading';

/**
 * Material composition (TECH_SPEC §5.15, `material.composeTo`): at the Trading Post, `count` units of a material in Town
 * Storage become one unit of its composeTo material (one step; tier essences never compose). Ratios are set so N × price
 * > the result's price: composing loses gold value and only pays when a material is short.
 *  - Command `town.compose { materialId (the source), count (units to make) }`.
 *  - Automatic: every composeIntervalSec, for each material the automatic requests still lack (autoMaterialDemand),
 *    storage units of a material that composes into it are used — only units beyond what crafting / investment /
 *    supplies still want of that source (baseMaterialNeed + supplyMaterialNeed). No RNG.
 */

/** Null when `count` units of materialId's composeTo can be made from storage now, else the reason. */
export function composeBlocker(config: GameConfig, world: World, materialId: string, count: number): string | null {
  const m = config.index.materials.get(materialId);
  if (!m) return 'unknown material';
  if (!m.composeTo) return 'material does not compose';
  if (!Number.isInteger(count) || count < 1) return 'invalid count';
  if (buildingLevel(world, config.index.tradingPost) < 1) return 'trading post not built';
  if ((world.town.storage[materialId] ?? 0) < m.composeTo.count * count) return 'not enough in storage';
  return null;
}

/** Compose (re-validated). Returns null or the reason. */
export function compose(ctx: SystemContext, materialId: string, count: number, auto = false): string | null {
  const { config, world } = ctx;
  const why = composeBlocker(config, world, materialId, count);
  if (why) return why;
  const to = config.index.materials.get(materialId)!.composeTo!;
  const used = to.count * count;
  const st = world.town.storage;
  const left = (st[materialId] ?? 0) - used;
  if (left > 0) st[materialId] = left;
  else delete st[materialId];
  st[to.materialId] = (st[to.materialId] ?? 0) + count;
  world.stats.materialsComposed = (world.stats.materialsComposed ?? 0) + count;
  ctx.events.emit(world.tick, { type: 'materialsComposed', from: materialId, to: to.materialId, used, made: count, auto });
  return null;
}

/** One automatic pass (see module comment). Returns units made. */
export function autoCompose(ctx: SystemContext): number {
  const { config, world } = ctx;
  if (buildingLevel(world, config.index.tradingPost) < 1) return 0;
  const lack = autoMaterialDemand(config, world);
  const ids = Object.keys(lack);
  if (ids.length === 0) return 0;
  const keep = baseMaterialNeed(config, world);
  const supply = supplyMaterialNeed(config, world);
  let made = 0;
  for (const target of ids) {
    let want = lack[target]!;
    for (const src of config.materials) {
      if (want <= 0) break;
      if (src.composeTo?.materialId !== target) continue;
      const free = (world.town.storage[src.id] ?? 0) - (keep[src.id] ?? 0) - (supply[src.id] ?? 0);
      const k = Math.min(want, Math.floor(free / src.composeTo.count));
      if (k < 1) continue;
      if (compose(ctx, src.id, k, true) === null) {
        want -= k;
        made += k;
      }
    }
  }
  return made;
}

export const composeSystem: System = {
  name: 'compose',
  update(ctx) {
    const sec = ctx.config.formula.composeIntervalSec;
    if (!(sec > 0)) return;
    const every = Math.max(1, Math.round((sec * 1000) / ctx.dtMs));
    if (ctx.world.tick % every === every - 1) autoCompose(ctx);
  },
};
