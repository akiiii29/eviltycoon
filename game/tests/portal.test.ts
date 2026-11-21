/**
 * Reincarnation Portal (EHT; TECH_SPEC §5.13): a qualifying hunter walks to the portal next to the square, is away for
 * reincarnationSec (game time while playing, wall-clock time offline), then comes out reincarnated at level 1.
 */
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../src/core/events';
import { NavGraph } from '../src/core/pathfinding';
import { advanceOfflineWallClock, offlineHasNews } from '../src/core/offline';
import { deserialize, SAVE_FORMAT, serialize } from '../src/core/save/save';
import { createWorld, Simulation } from '../src/core/simulation';
import { allHunters, townHunterCount } from '../src/core/systems/journey';
import { isDifficultyUnlockable, portalStayOf } from '../src/core/systems/progression';
import { newAiState, type Hunter } from '../src/core/world';
import { testConfig } from './helpers';

const config = testConfig();
const f = config.formula;
const T0 = 1_700_000_000_000;
const PORTAL_MS = f.reincarnationSec * 1000;

/** A Town with `n` hunters; the first is at max level on the square. Auto-reincarnation off unless `auto`. */
function town(n: number, auto = false, seed = 3): { s: Simulation; h: Hunter } {
  const s = new Simulation(config, createWorld(config, seed));
  for (let i = 0; i < n; i++) s.enqueue({ type: 'debug.spawnHunter' });
  s.step();
  s.drainEvents();
  s.world.town.autoReincarnate = auto;
  const h = s.world.hunters[0]!;
  const sq = config.index.nodes.get(config.index.squareNode)!;
  h.level = f.maxLevel;
  h.exp = 0;
  h.nodeId = sq.id;
  h.position = { x: sq.x, y: sq.y };
  h.insideBuildingId = null;
  h.ai = newAiState();
  return { s, h };
}

/** Step until the hunter is inside the portal (at most `max` ticks); returns the ticks taken. */
function untilInside(s: Simulation, h: Hunter, max = 1200): number {
  let i = 0;
  for (; i < max && !portalStayOf(s.world, h.id); i++) s.step();
  return i;
}

function ofType<T extends SimEvent['type']>(ev: SimEvent[], type: T): Extract<SimEvent, { type: T }>[] {
  return ev.filter((e) => e.type === type) as Extract<SimEvent, { type: T }>[];
}

describe('portal on the map', () => {
  it('is a leaf node next to the square where hunters arrive, and never a snapping target', () => {
    expect(config.index.portalNode).toBe('t.portal');
    const p = config.index.nodes.get('t.portal')!;
    const sq = config.index.nodes.get(config.index.squareNode)!;
    expect(p.kind).toBe('portal');
    expect(p.zoneId).toBeUndefined();
    expect(Math.hypot(p.x - sq.x, p.y - sq.y)).toBeLessThan(10);
    expect(config.edges.filter((e) => e.a === p.id || e.b === p.id)).toEqual([{ a: sq.id, b: p.id, road: false }]);
    const nav = new NavGraph(config);
    // A hunter leaving the portal starts its path at the square (the portal itself is never a snap target).
    expect(nav.nearest({ x: p.x, y: p.y })).toBe(sq.id);
    // Not on a building plot.
    for (const pl of config.plots) expect(Math.abs(p.x - pl.x) >= pl.w / 2 || Math.abs(p.y - pl.y) >= pl.h / 2, pl.id).toBe(true);
    expect(nav.path(sq.id, p.id)).toEqual([sq.id, p.id]);
  });
});

describe('reincarnation through the portal', () => {
  it('auto: walks to the portal, is away reincarnationSec (keeps its slot), comes out at level 1 on the portal', () => {
    const { s, h } = town(2, true);
    const slots = townHunterCount(s.world);
    const reinc = h.reincarnation;
    s.step();
    expect(h.ai.goal).toEqual({ type: 'reincarnate' });
    untilInside(s, h);
    const entered = ofType(s.drainEvents(), 'portalEntered');
    expect(entered).toEqual([expect.objectContaining({ hunterId: h.id, durationSec: f.reincarnationSec })]);
    const enteredTick = entered[0]!.tick;
    // Away: out of world.hunters, still counted (slot, allHunters), untouched by the systems.
    expect(s.world.hunters).not.toContain(h);
    expect(allHunters(s.world)).toContain(h);
    expect(townHunterCount(s.world)).toBe(slots);
    expect(h.level).toBe(f.maxLevel);
    const frozen = JSON.stringify(h.needs);
    let ticks = 0;
    while (portalStayOf(s.world, h.id) && ticks < PORTAL_MS / 100 + 10) { s.step(); ticks++; }
    const ev = s.drainEvents();
    const done = ofType(ev, 'reincarnated');
    expect(done).toEqual([expect.objectContaining({ hunterId: h.id, count: reinc + 1 })]);
    // The entry tick already counts down once (progression runs after the AI in the same tick).
    expect((done[0]!.tick - enteredTick + 1) * 100).toBe(PORTAL_MS);
    expect(h.reincarnation).toBe(reinc + 1);
    expect(h.level).toBe(1);
    expect(h.nodeId).toBe(config.index.portalNode);
    expect(s.world.hunters).toContain(h);
    expect(s.world.portal).toEqual([]);
    expect(JSON.parse(frozen).satiety).toBe(h.needs.satiety); // needs frozen while inside
    expect(s.world.stats.reincarnations).toBe(1);
    // Level 1 hunter is not sent back.
    for (let i = 0; i < 50; i++) s.step();
    expect(h.ai.goal?.type).not.toBe('reincarnate');
  });

  it('player command from Town works with auto off; commands cannot reach a hunter inside the portal', () => {
    const { s, h } = town(1);
    s.enqueue({ type: 'hunter.reincarnate', hunterId: h.id });
    untilInside(s, h);
    expect(portalStayOf(s.world, h.id)).toBeDefined();
    s.drainEvents();
    s.enqueue({ type: 'hunter.move', hunterId: h.id, zoneId: 'town' });
    s.enqueue({ type: 'hunter.reincarnate', hunterId: h.id });
    s.enqueue({ type: 'debug.removeHunter', hunterId: h.id });
    s.step();
    const rej = ofType(s.drainEvents(), 'commandRejected').map((e) => e.reason);
    expect(rej).toEqual(['hunter is in the reincarnation portal', 'hunter is in the reincarnation portal', 'hunter is in the reincarnation portal']);
  });

  it('re-validates at the portal: a hunter that no longer qualifies does not enter', () => {
    const { s, h } = town(1);
    s.enqueue({ type: 'hunter.reincarnate', hunterId: h.id });
    s.step();
    expect(h.ai.goal).toEqual({ type: 'reincarnate' });
    h.level = f.maxLevel - 1; // e.g. a config change
    for (let i = 0; i < 300; i++) s.step();
    expect(portalStayOf(s.world, h.id)).toBeUndefined();
    expect(s.world.hunters).toContain(h);
    expect(h.reincarnation).toBe(0);
    expect(h.ai.goal?.type).not.toBe('reincarnate');
  });

  it('difficulty unlocks count hunters inside the portal', () => {
    const d = config.difficulties.find((x) => x.unlockHunters > 0 && x.unlockReincarnation >= 1)!;
    const { s, h } = town(Math.max(2, d.unlockHunters));
    const others = s.world.hunters.filter((x) => x !== h).slice(0, d.unlockHunters - 1);
    for (const o of others) o.reincarnation = d.unlockReincarnation;
    h.reincarnation = d.unlockReincarnation;
    h.level = f.maxLevel;
    s.world.town.unlockedDifficulties = [config.difficulties[0]!.id];
    // Move h into the portal by hand (no step in between: the unlock check must see it there).
    s.runBetweenTicks(() => {
      s.world.hunters = s.world.hunters.filter((x) => x !== h);
      s.world.portal.push({ hunter: h, durationMs: PORTAL_MS, remainingMs: PORTAL_MS, enteredAtMs: s.world.timeMs });
    });
    expect(isDifficultyUnlockable(config, s.world, d.id)).toBe(true);
    s.step();
    expect(s.world.town.unlockedDifficulties).toContain(d.id);
    expect(portalStayOf(s.world, h.id)).toBeDefined();
  });
});

describe('portal save/load and offline', () => {
  function inside(): { s: Simulation; h: Hunter } {
    const t = town(2);
    t.s.enqueue({ type: 'hunter.reincarnate', hunterId: t.h.id });
    untilInside(t.s, t.h);
    for (let i = 0; i < 100; i++) t.s.step();
    t.s.drainEvents();
    return t;
  }

  it('round-trips mid-process and continues identically', () => {
    const { s: a } = inside();
    a.world.portal[0]!.remainingMs = 5_000;
    const b = new Simulation(config, createWorld(config, 1));
    b.setWorld(deserialize(serialize(a.world, T0), config).world);
    expect(JSON.stringify(b.world)).toBe(JSON.stringify(a.world));
    expect(b.world.portal).toHaveLength(1);
    for (let i = 0; i < 200; i++) { a.step(); b.step(); }
    expect(a.world.portal).toEqual([]);
    expect(JSON.stringify(b.world)).toBe(JSON.stringify(a.world));
    expect(JSON.stringify(b.drainEvents())).toBe(JSON.stringify(a.drainEvents()));
  });

  it('completes on wall-clock time while closed; a shorter gap only counts down', () => {
    const { s, h } = inside();
    const left = s.world.portal[0]!.remainingMs;
    expect(left).toBe(PORTAL_MS - 101 * 100);
    const text = serialize(s.world, T0);

    const b = new Simulation(config, createWorld(config, 1));
    b.setWorld(deserialize(text, config).world);
    const short = b.runBetweenTicks((ctx) => advanceOfflineWallClock(ctx, 60_000));
    expect(short.reincarnations).toEqual([]);
    expect(b.world.portal[0]!.remainingMs).toBe(left - 60_000);

    const c = new Simulation(config, createWorld(config, 1));
    c.setWorld(deserialize(text, config).world);
    const [tick, timeMs] = [c.world.tick, c.world.timeMs];
    const long = c.runBetweenTicks((ctx) => advanceOfflineWallClock(ctx, left + 1));
    expect(long.reincarnations).toEqual([{ hunterId: h.id, reincarnation: 1, reincarnated: true }]);
    expect(offlineHasNews(long)).toBe(true);
    expect(c.world.portal).toEqual([]);
    const back = c.world.hunters.find((x) => x.id === h.id)!;
    expect([back.level, back.reincarnation, back.nodeId]).toEqual([1, 1, config.index.portalNode]);
    expect([c.world.tick, c.world.timeMs]).toEqual([tick, timeMs]);
    expect(ofType(c.drainEvents(), 'reincarnated')).toHaveLength(1);
    for (let i = 0; i < 600; i++) c.step(); // and the game runs on
  });

  it('migrates a v11 save (no portal field) to v12', () => {
    const w = JSON.parse(JSON.stringify(createWorld(config, 4))) as Record<string, unknown>;
    delete w.portal;
    w.schemaVersion = 11;
    const r = deserialize(JSON.stringify({ format: SAVE_FORMAT, schemaVersion: 11, configVersion: config.version, savedAt: 0, world: w }), config);
    expect(r.migratedFrom).toBe(11);
    expect(r.world.schemaVersion).toBe(12);
    expect(r.world.portal).toEqual([]);
  });
});
