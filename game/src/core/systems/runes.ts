import type { GameConfig } from '../config/types';
import { relicValue } from '../progressionStats';
import type { System, SystemContext } from '../system';
import { isAlive, type Hunter, type Monster, type RuneItem, type World } from '../world';

/**
 * Runes (TECH_SPEC §5.15, config/rune.json). A kill of a monster of level ≥ a rune's minMonsterLevel can drop that rune:
 * ONE RNG draw per kill against the summed chances (dropChance[grade − 1] of every eligible rune × grade, × (1 +
 * runeDropPct / 100) of the Relic of Fortune); no draw when no rune is eligible (low zones keep their RNG stream).
 * Drops go to the Town rune stash (best first, at most runeStashMax: the worst is discarded). Runes are socketed into
 * HUNTERS (formula runeSlots sockets, kept for life and across reincarnation, unlike gear): with town.autoRune (default
 * on) a hunter standing in Town takes the best stash rune into an empty socket, or swaps it for a socketed rune of a
 * lower grade. Socketed runes add valueByGrade[grade − 1] of their stat in the trait category (formulas.hunterStats).
 */

/** Stash order: grade descending, then rune config order (stable). */
function runeRank(config: GameConfig, r: RuneItem): number {
  const i = config.runes.findIndex((x) => x.id === r.runeId);
  return r.grade * 1000 - (i < 0 ? 999 : i);
}

export function runeStash(world: World): RuneItem[] {
  return world.town.runes ?? (world.town.runes = []);
}

/** Put a rune into the stash at its rank; beyond runeStashMax the worst (last) is discarded. */
export function stashRune(ctx: SystemContext, r: RuneItem): void {
  const { config, world } = ctx;
  const stash = runeStash(world);
  const rank = runeRank(config, r);
  let at = stash.findIndex((x) => runeRank(config, x) < rank);
  if (at < 0) at = stash.length;
  stash.splice(at, 0, { runeId: r.runeId, grade: r.grade });
  const max = Math.max(0, Math.floor(config.formula.runeStashMax));
  while (stash.length > max) {
    stash.pop();
    world.stats.runesDiscarded = (world.stats.runesDiscarded ?? 0) + 1;
  }
}

/** Roll a rune drop for a kill (combat.grantKill). */
export function dropRune(ctx: SystemContext, h: Hunter, m: Monster): void {
  const { config, world } = ctx;
  if (config.runes.length === 0) return;
  const level = config.index.monsters.get(m.defId)?.level ?? 0;
  const mul = 1 + relicValue(config, world, 'runeDropPct') / 100;
  let total = 0;
  for (const r of config.runes) if (level >= r.minMonsterLevel) for (const c of r.dropChance) total += c * mul;
  if (!(total > 0)) return;
  let x = ctx.rng.next();
  if (x >= total) return;
  for (const r of config.runes) {
    if (level < r.minMonsterLevel) continue;
    for (let g = 0; g < r.dropChance.length; g++) {
      x -= r.dropChance[g]! * mul;
      if (x < 0) {
        const item = { runeId: r.id, grade: g + 1 };
        world.stats.runesDropped = (world.stats.runesDropped ?? 0) + 1;
        stashRune(ctx, item);
        ctx.events.emit(world.tick, { type: 'runeDropped', hunterId: h.id, runeId: r.id, grade: g + 1 });
        return;
      }
    }
  }
}

/** The hunter's sockets, padded to runeSlots (extra sockets of a lowered runeSlots are kept but not counted). */
export function runeSockets(config: GameConfig, h: Hunter): (RuneItem | null)[] {
  const r = h.runes ?? (h.runes = []);
  while (r.length < Math.max(0, Math.floor(config.formula.runeSlots))) r.push(null);
  return r;
}

/** Socket stash rune `stashIndex` into `slot` (a socketed rune goes back to the stash). Returns null or the reason. */
export function socketRune(ctx: SystemContext, h: Hunter, slot: number, stashIndex: number): string | null {
  const { config, world } = ctx;
  const stash = runeStash(world);
  if (!Number.isInteger(slot) || slot < 0 || slot >= Math.floor(config.formula.runeSlots)) return 'invalid socket';
  if (!Number.isInteger(stashIndex) || stashIndex < 0 || stashIndex >= stash.length) return 'invalid stash index';
  const sockets = runeSockets(config, h);
  const [item] = stash.splice(stashIndex, 1);
  const old = sockets[slot];
  sockets[slot] = item!;
  if (old) stashRune(ctx, old);
  ctx.events.emit(world.tick, { type: 'runeSocketed', hunterId: h.id, slot, runeId: item!.runeId, grade: item!.grade });
  return null;
}

/** Take the rune out of `slot` back into the stash. Returns null or the reason. */
export function unsocketRune(ctx: SystemContext, h: Hunter, slot: number): string | null {
  const sockets = runeSockets(ctx.config, h);
  if (!Number.isInteger(slot) || slot < 0 || slot >= sockets.length) return 'invalid socket';
  const old = sockets[slot];
  if (!old) return 'socket is empty';
  sockets[slot] = null;
  stashRune(ctx, old);
  return null;
}

/** Auto-socketing (town.autoRune): hunters in Town take the best stash runes into empty / lower-grade sockets. */
export const runesSystem: System = {
  name: 'runes',
  update(ctx) {
    const { world, config } = ctx;
    if (world.town.autoRune === false || !world.town.runes?.length) return;
    const slots = Math.floor(config.formula.runeSlots);
    if (slots <= 0) return;
    for (const h of world.hunters) {
      const stash = world.town.runes;
      if (stash.length === 0) return;
      if (!isAlive(h) || config.index.nodes.get(h.nodeId)?.zoneId) continue;
      const sockets = runeSockets(config, h);
      for (let s = 0; s < slots && stash.length > 0; s++) {
        const cur = sockets[s];
        if (!cur || stash[0]!.grade > cur.grade) socketRune(ctx, h, s, 0);
      }
    }
  },
};
