import type { GameConfig } from '../config/types';

/**
 * MIGRATIONS[n] upgrades a world from schema v(n) to v(n+1).
 * Never edit an existing migration after release; add a new one and bump WORLD_SCHEMA_VERSION.
 *
 * Migrations receive the *current* (already loaded and validated) config. Values derived from it
 * (spawn node, level gains) reflect today's data, not the data the save was made with; that is the
 * best available estimate, and `LoadResult.configChanged` already flags saves from another config.
 */
export type Migration = (world: Record<string, unknown>, config: GameConfig) => Record<string, unknown>;

/** Fallback when the config has no usable square node (should not happen: config validation requires one). */
const M1_SQUARE = { id: 't.square', x: 0, y: 0 };

/** The town square, where new hunters arrive (same node `createWorld`/arrivals use). */
export function migrationSpawnNode(config: GameConfig): { id: string; x: number; y: number } {
  const node = config.index?.nodes.get(config.index.squareNode) ?? config.nodes?.find((n) => n.kind === 'square');
  return node ? { id: node.id, x: node.x, y: node.y } : M1_SQUARE;
}

/**
 * Estimate the level-1 roll of a hunter saved before rollStats existed, by removing the per-level
 * gains `gainExp` applies (formula.levelHpGain/AtkGain/DefGain). Other stats never grow with level.
 * When the class is known, hp/atk/def are clamped to its possible roll ([lowest-grade min, highest-grade max]
 * of `statRanges`), so a config whose gains changed since the save cannot yield an impossible (e.g. 0 HP) roll;
 * otherwise they are only floored at 0.
 */
export function estimateRollStats(
  config: GameConfig,
  stats: Record<string, number>,
  level: number,
  classId?: string,
): Record<string, number> {
  const f = config.formula;
  const lv = Math.max(1, Math.floor(level));
  const ranges = config.classes.find((c) => c.id === classId)?.statRanges;
  const strip = (k: 'hp' | 'atk' | 'def', gain: number) => {
    const v = (stats[k] ?? 0) - gain * (lv - 1);
    const r = ranges?.[k];
    if (!r) return Math.max(0, v);
    return Math.min(r[2][1], Math.max(r[0][0], v));
  };
  return { ...stats, hp: strip('hp', f.levelHpGain), atk: strip('atk', f.levelAtkGain), def: strip('def', f.levelDefGain) };
}

export const MIGRATIONS: Record<number, Migration> = {
  // v0 (pre-release prototype saves) had no town.arrivalTimerMs and no hunter.reincarnation.
  0: (w) => {
    const town = (w.town ?? {}) as Record<string, unknown>;
    const hunters = (Array.isArray(w.hunters) ? w.hunters : []) as Record<string, unknown>[];
    return {
      ...w,
      town: { gold: 0, ...town, arrivalTimerMs: town.arrivalTimerMs ?? 0 },
      hunters: hunters.map((h) => ({ reincarnation: 0, ...h })),
    };
  },
  // v1 (M0) → v2 (M1): map position, AI state, combat fields, monsters, zone timers, stats.
  1: (w, config) => {
    const sq = migrationSpawnNode(config);
    const hunters = (Array.isArray(w.hunters) ? w.hunters : []) as Record<string, unknown>[];
    return {
      ...w,
      hunters: hunters.map((h) => ({
        ...h,
        position: { x: sq.x, y: sq.y },
        nodeId: sq.id,
        insideBuildingId: null,
        ai: { goal: null, phase: 'act', path: [], decideInMs: 0, targetMonsterId: null, moveTo: null, forced: false },
        attackCdMs: 0,
        deadMs: 0,
        kills: 0,
      })),
      monsters: [],
      zones: {},
      stats: { kills: 0, deaths: 0, serviceUses: 0 },
    };
  },
  // v2 (M1) → v3 (M2): equipment, bag, town storage/shop/crafting, economy stats.
  2: (w) => {
    const hunters = (Array.isArray(w.hunters) ? w.hunters : []) as Record<string, unknown>[];
    const town = (w.town ?? {}) as Record<string, unknown>;
    const stats = (w.stats ?? {}) as Record<string, unknown>;
    return {
      ...w,
      hunters: hunters.map((h) => ({ equipment: {}, bag: {}, ...h })),
      town: { storage: {}, shop: [], crafting: {}, autoCraft: true, ...town },
      stats: { materialsSold: 0, crafted: 0, gearBought: 0, enhanceTries: 0, enhanceSuccess: 0, ...stats },
    };
  },
  // v3 (M2) → v4 (M3): skills/traits/buffs, roll stats, monster difficulty, town difficulty, new stats.
  3: (w, config) => {
    const hunters = (Array.isArray(w.hunters) ? w.hunters : []) as Record<string, any>[];
    const monsters = (Array.isArray(w.monsters) ? w.monsters : []) as Record<string, unknown>[];
    const town = (w.town ?? {}) as Record<string, unknown>;
    const stats = (w.stats ?? {}) as Record<string, unknown>;
    return {
      ...w,
      hunters: hunters.map((h) => {
        const rollStats = estimateRollStats(config, h.stats ?? {}, Number(h.level ?? 1) || 1, h.classId);
        return { rollStats, skills: {}, skillCdMs: {}, traits: {}, traitPoints: 0, buffs: [], ...h };
      }),
      monsters: monsters.map((m) => ({ difficultyId: 'diff.easy', ...m })),
      town: { difficulty: 'diff.easy', unlockedDifficulties: ['diff.easy'], autoReincarnate: true, ...town },
      stats: { skillCasts: 0, jobChanges: 0, reincarnations: 0, learned: 0, ...stats },
    };
  },
  // v4 (M3) → v5 (balance pass): shop items remember list price and listing time.
  4: (w) => {
    const town = (w.town ?? {}) as Record<string, any>;
    const now = Number(w.timeMs ?? 0);
    const shop = (Array.isArray(town.shop) ? town.shop : []) as Record<string, any>[];
    return { ...w, town: { ...town, shop: shop.map((i) => ({ listPrice: i.price, listedAtMs: now, ...i })) } };
  },
  // v5 → v6 (Trading Post requests): player material requests, discard/scrap stats.
  5: (w) => {
    const town = (w.town ?? {}) as Record<string, unknown>;
    const stats = (w.stats ?? {}) as Record<string, unknown>;
    return {
      ...w,
      town: { requests: {}, ...town },
      stats: { materialsDiscarded: 0, gearScrapped: 0, ...stats },
    };
  },
  // v6 → v7 (Bounty, GDD §9): active bounties, auto-bounty switch (on, like auto-craft), bounty stats.
  6: (w) => {
    const town = (w.town ?? {}) as Record<string, unknown>;
    const stats = (w.stats ?? {}) as Record<string, unknown>;
    return {
      ...w,
      town: { bounties: [], autoBounty: true, ...town },
      stats: { bountiesPosted: 0, bountiesCompleted: 0, bountyGoldPaid: 0, bountyKingdomGold: 0, ...stats },
    };
  },
  // v7 → v8 (Town buildings, TECH_SPEC §5.12): building instances on plots (levels that keep the save playing as before),
  // auto-invest (on, like auto-craft), building stats.
  7: (w, config) => {
    const town = (w.town ?? {}) as Record<string, unknown>;
    const stats = (w.stats ?? {}) as Record<string, unknown>;
    return {
      ...w,
      town: { buildings: migrationBuildings(config, w), autoInvest: true, investPlan: null, ...town },
      stats: { buildingsBuilt: 0, buildingUpgrades: 0, investGold: 0, investMaterials: 0, investImportGold: 0, ...stats },
    };
  },
  // v8 → v9 (Journey, GDD §9): no journey running, journey stats = 0.
  8: (w) => {
    const stats = (w.stats ?? {}) as Record<string, unknown>;
    return {
      ...w,
      journeys: Array.isArray(w.journeys) ? w.journeys : [],
      stats: { journeysStarted: 0, journeysSucceeded: 0, journeysFailed: 0, journeysRecalled: 0, journeyGold: 0, ...stats },
    };
  },
  // v9 → v10 and v10 → v11: PLACEHOLDERS (pass-through) for migrations that other branches add; the real ones replace
  // these when the branches are merged (and the portal migration below is renumbered if needed).
  9: (w) => w,
  10: (w) => w,
  // v11 → v12 (Reincarnation Portal, TECH_SPEC §5.13): nobody inside the portal (keep the array if already there).
  11: (w) => ({ ...w, portal: Array.isArray(w.portal) ? w.portal : [] }),
};

/** Apply the v7 → v8 building fields when absent (idempotent; existing fields win). Used at load for v9 saves made before buildings. */
export function fillMissingBuildings(w: Record<string, unknown>, config: GameConfig): Record<string, unknown> {
  const town = (w.town ?? {}) as Record<string, unknown>;
  return Array.isArray(town.buildings) ? w : MIGRATIONS[7]!(w, config);
}

/**
 * v7 → v8 building levels: every plot's startBuilding, at the lowest level that keeps the save playing as before —
 * craft buildings high enough for every recipe the old rules allowed (gear.level ≤ max hunter level + craftLevelAhead)
 * and for any gear already equipped, on sale or being crafted; the Town Hall at least as high as any other building.
 */
export function migrationBuildings(config: GameConfig, w: Record<string, unknown>): Record<string, unknown>[] {
  const hunters = (Array.isArray(w.hunters) ? w.hunters : []) as Record<string, any>[];
  const town = (w.town ?? {}) as Record<string, any>;
  const gearLevel = (id: unknown) => config.index.gear.get(typeof id === 'string' ? id : '')?.level ?? 0;
  let want = 0;
  for (const h of hunters) {
    want = Math.max(want, (Number(h.level) || 1) + config.formula.craftLevelAhead);
    for (const g of Object.values(h.equipment ?? {}) as { gearId?: unknown }[]) want = Math.max(want, gearLevel(g?.gearId));
  }
  for (const it of (Array.isArray(town.shop) ? town.shop : []) as { gearId?: unknown }[]) want = Math.max(want, gearLevel(it?.gearId));
  for (const job of Object.values(town.crafting ?? {}) as ({ gearId?: unknown } | null)[]) want = Math.max(want, gearLevel(job?.gearId));
  const out: { id: string; buildingId: string; level: number; upgrade: null }[] = [];
  let top = 1;
  for (const p of config.plots) {
    if (!p.startBuilding) continue;
    const b = config.index.buildings.get(p.startBuilding)!;
    let level = p.startLevel ?? 1;
    if (b.kind === 'craft' && b.maxGearLevel) {
      // Lowest level whose cap covers this building's highest recipe within `want`.
      const need = Math.max(0, ...config.gear.filter((g) => g.craftBuilding === b.id && g.level <= want).map((g) => g.level));
      while (level < b.maxLevel && (b.maxGearLevel[level - 1] ?? 0) < need) level++;
    }
    if (b.kind !== 'townHall') top = Math.max(top, level);
    out.push({ id: p.id, buildingId: b.id, level, upgrade: null });
  }
  const th = config.index.buildings.get(config.index.townHall);
  for (const s of out) if (th && s.buildingId === th.id) s.level = Math.min(th.maxLevel, Math.max(s.level, top));
  return out;
}
