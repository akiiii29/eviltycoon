/**
 * Training Ground (M5, TECH_SPEC §5.15): hunters buy EXP with gold — a hunter gold sink and a catch-up for hunters behind
 * the town's top hunter (late arrivals, the first ones out of the Reincarnation Portal).
 *
 * - One session: at the door the hunter pays round(trainGoldPerExp × EXP) and gets
 *   EXP = round(trainExpFrac[building level] × exp_curve EXP of the hunter's level and reincarnation, progressionStats.expRequired) through progress.gainExp (the library bonus does
 *   not apply), then stays inside trainSessionSec (needs frozen, like a service) and comes out to decide again.
 * - Cap: only while hunter level < top level − trainLevelGap[building level], top = highest level over every Town hunter
 *   (journey and portal included). The top hunter can never train, so the pacing of the lead is untouched by construction.
 * - Gold goes through economy.feeTownCut like the forge/academy fees: the Town keeps its share, the rest leaves the economy.
 * Deterministic: no RNG.
 */
import type { BuildingDef, GameConfig } from '../config/types';
import { expRequired } from '../progressionStats';
import { gainExp } from '../progress';
import type { System, SystemContext } from '../system';
import { isAlive, type Hunter, type World } from '../world';
import { feeTownCut } from './economy';
import { allHunters } from './journey';
import { buildingLevel, buildingOfKind, levelValue } from './town';

/** The Training Ground type of the config, if any. */
export function trainingBuilding(config: GameConfig): BuildingDef | undefined {
  return buildingOfKind(config, 'training');
}

/** Highest level over every Town hunter (in town, on a journey, in the portal). */
export function topHunterLevel(world: World): number {
  let lv = 0;
  for (const h of allHunters(world)) lv = Math.max(lv, h.level);
  return lv;
}

/** Level a hunter may train up to (exclusive): top level − trainLevelGap; 0 when the Training Ground is not working. */
export function trainLevelCap(config: GameConfig, world: World): number {
  const b = trainingBuilding(config);
  const lv = b ? buildingLevel(world, b.id) : 0;
  if (!b || lv < 1) return 0;
  return Math.min(config.formula.maxLevel, topHunterLevel(world) - (levelValue(b.trainLevelGap, lv) ?? 0));
}

export interface TrainOffer {
  exp: number;
  price: number;
}

/** One session for this hunter now (EXP and price), or null (no working Training Ground, at/above the cap, max level). */
export function trainOffer(config: GameConfig, world: World, h: Hunter): TrainOffer | null {
  const b = trainingBuilding(config);
  const lv = b ? buildingLevel(world, b.id) : 0;
  if (!b || lv < 1) return null;
  const f = config.formula;
  if (h.level >= f.maxLevel || h.level >= trainLevelCap(config, world)) return null;
  const exp = Math.max(1, Math.round((levelValue(b.trainExpFrac, lv) ?? 0) * expRequired(config, h.level, h.reincarnation)));
  return { exp, price: Math.max(0, Math.round(f.trainGoldPerExp * exp)) };
}

function startSession(ctx: SystemContext, h: Hunter): boolean {
  const { world, config } = ctx;
  const offer = trainOffer(config, world, h);
  const b = trainingBuilding(config);
  if (!offer || !b || h.gold < offer.price) return false;
  h.gold -= offer.price;
  const townGold = feeTownCut(config, offer.price, world);
  world.town.gold += townGold; // the rest leaves the economy (gold sink)
  const st = world.stats;
  st.trainSessions = (st.trainSessions ?? 0) + 1;
  st.trainGold = (st.trainGold ?? 0) + offer.price;
  st.trainExp = (st.trainExp ?? 0) + offer.exp;
  gainExp(ctx, h, offer.exp);
  h.insideBuildingId = b.id;
  h.trainMs = Math.max(1, Math.round(config.formula.trainSessionSec * 1000));
  ctx.events.emit(world.tick, { type: 'trained', hunterId: h.id, exp: offer.exp, price: offer.price, townGold, level: h.level });
  return true;
}

/**
 * Hunters at the Training Ground door with a `train` goal start a session (re-validated; the goal is cleared when it
 * cannot start); hunters inside count down and come out with no goal.
 */
export const trainingSystem: System = {
  name: 'training',
  update(ctx) {
    const { world, config, dtMs } = ctx;
    const b = trainingBuilding(config);
    if (!b) return;
    for (const h of world.hunters) {
      if (!isAlive(h)) continue;
      if (h.insideBuildingId === b.id) {
        h.trainMs = Math.max(0, (h.trainMs ?? 0) - dtMs);
        if (h.trainMs > 0) continue;
        delete h.trainMs;
        h.insideBuildingId = null;
        h.ai.goal = null; // decide again next tick
        h.ai.forced = false;
        continue;
      }
      if (h.insideBuildingId || h.ai.phase !== 'act' || h.ai.goal?.type !== 'train') continue;
      if (!startSession(ctx, h)) {
        h.ai.goal = null;
        h.ai.forced = false;
      }
    }
  },
};
