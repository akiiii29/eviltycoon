/**
 * MIGRATIONS[n] upgrades a world from schema v(n) to v(n+1).
 * Never edit an existing migration after release; add a new one and bump WORLD_SCHEMA_VERSION.
 */
export type Migration = (world: Record<string, unknown>) => Record<string, unknown>;

/** Square node in the M1 map; migrations cannot read config, so the id is pinned here. */
const M1_SQUARE = { id: 't.square', x: 0, y: 0 };

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
  1: (w) => {
    const hunters = (Array.isArray(w.hunters) ? w.hunters : []) as Record<string, unknown>[];
    return {
      ...w,
      hunters: hunters.map((h) => ({
        ...h,
        position: { x: M1_SQUARE.x, y: M1_SQUARE.y },
        nodeId: M1_SQUARE.id,
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
  3: (w) => {
    const hunters = (Array.isArray(w.hunters) ? w.hunters : []) as Record<string, any>[];
    const monsters = (Array.isArray(w.monsters) ? w.monsters : []) as Record<string, unknown>[];
    const town = (w.town ?? {}) as Record<string, unknown>;
    const stats = (w.stats ?? {}) as Record<string, unknown>;
    return {
      ...w,
      hunters: hunters.map((h) => {
        const lv = Math.max(1, Number(h.level ?? 1));
        // Approximate the level-1 roll by removing M1 default level gains (20 hp, 1 atk, 1 def per level).
        const st = h.stats ?? {};
        const rollStats = { ...st, hp: (st.hp ?? 0) - 20 * (lv - 1), atk: (st.atk ?? 0) - (lv - 1), def: (st.def ?? 0) - (lv - 1) };
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
};
