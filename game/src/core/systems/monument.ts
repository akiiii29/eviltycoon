/**
 * Valor Stele (monument, M5, TECH_SPEC §5.15): a permanent per-level town aura, percent ATK and DEF for every hunter.
 *
 * hunterStats(config, h) has no world, so the aura is copied onto each hunter (`Hunter.aura`) by `townAuraSystem` right
 * after arrivals, before any system reads stats; statsCache snapshots it. Hunters away (journey, portal) keep the value
 * they left with and are re-synced on the first tick back. Without a working monument the field is absent (saves and
 * stats exactly as before the building existed).
 */
import type { GameConfig, ModStat } from '../config/types';
import type { System } from '../system';
import type { Hunter, World } from '../world';
import { kindValue } from './town';

/** The aura the town gives right now (empty when the monument is not built). */
export function townAura(config: GameConfig, world: World): Partial<Record<ModStat, number>> {
  const atk = kindValue(config, world, 'monument', 'auraAtkPct', 0);
  const def = kindValue(config, world, 'monument', 'auraDefPct', 0);
  const out: Partial<Record<ModStat, number>> = {};
  if (atk > 0) out.atkPct = atk;
  if (def > 0) out.defPct = def;
  return out;
}

/** Write `aura` on a hunter (deletes the field when empty; leaves an equal aura object untouched). */
export function applyAura(h: Hunter, aura: Partial<Record<ModStat, number>>): void {
  const keys = Object.keys(aura) as ModStat[];
  if (keys.length === 0) {
    if (h.aura) delete h.aura;
    return;
  }
  const cur = h.aura;
  if (cur && Object.keys(cur).length === keys.length && keys.every((k) => cur[k] === aura[k])) return;
  h.aura = { ...aura };
}

export const townAuraSystem: System = {
  name: 'townAura',
  update(ctx) {
    const aura = townAura(ctx.config, ctx.world);
    for (const h of ctx.world.hunters) applyAura(h, aura);
  },
};
