import { needsOk, scoreGoals, urgentNeed } from '../src/core/ai/utility';
import { validateConfig } from '../src/core/config/load';
import { needFrac, urgentFrac, zoneFit } from '../src/core/formulas';
import { NavGraph } from '../src/core/pathfinding';
import { createWorld, Simulation } from '../src/core/simulation';
import type { Hunter } from '../src/core/world';
import { readRawConfig, testConfig } from './helpers';

const config = testConfig();
const nav = new NavGraph(config);
const world0 = createWorld(config, 1);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function simWithHunters(seed: number, n: number): Simulation {
  const s = new Simulation(config, createWorld(config, seed));
  for (let i = 0; i < n; i++) s.enqueue({ type: 'debug.spawnHunter' });
  s.step();
  return s;
}

function freshHunter(): Hunter {
  return clone(simWithHunters(11, 1).world.hunters[0]!);
}

describe('map config', () => {
  it('rejects unreachable nodes, wrong door kinds and zone-less field nodes', () => {
    const raw = clone(readRawConfig()) as Record<string, any>;
    raw.map_node.push({ id: 'island', x: 99, y: 99, kind: 'road' });
    raw.building[0].doorNode = 't.n';
    raw.map_node.find((n: any) => n.id === 'z1.b').zoneId = undefined;
    const msgs = validateConfig(raw as any).map((i) => `${i.path}: ${i.message}`);
    expect(msgs).toContain('map_node.island: unreachable from the square');
    expect(msgs).toContain('building[0].doorNode: node "t.n" is not a door');
    expect(msgs.some((m) => m.includes('field node needs zoneId'))).toBe(true);
  });
});

describe('NavGraph', () => {
  it('finds a connected path between endpoints', () => {
    const p = nav.path('d.infirmary', 'z2.d')!;
    expect(p[0]).toBe('d.infirmary');
    expect(p.at(-1)).toBe('z2.d');
    for (let i = 1; i < p.length; i++) expect(nav.edge(p[i - 1]!, p[i]!)).toBeDefined();
  });

  it('prefers the road over an equally long dirt shortcut', () => {
    // square→gate direct (22, dirt) vs square→e→gate (22, road ×1.5 faster).
    expect(nav.path('t.square', 't.gate')).toEqual(['t.square', 't.e', 't.gate']);
  });

  it('returns a copy so callers can mutate it', () => {
    const a = nav.path('t.square', 'z1.a')!;
    a.shift();
    expect(nav.path('t.square', 'z1.a')![0]).toBe('t.square');
  });
});

describe('utility AI', () => {
  it('zone fit: 0 when too weak, best near 1.1×, lower when far too easy', () => {
    const f = config.formula;
    expect(zoneFit(60, 100, f)).toBe(0);
    expect(zoneFit(110, 100, f)).toBe(1);
    expect(zoneFit(400, 100, f)).toBeLessThan(1);
  });

  it('a fresh hunter in town goes hunting in the zone that fits', () => {
    const h = freshHunter();
    const top = scoreGoals(config, nav, world0, h)[0]!;
    expect(top.goal).toEqual({ type: 'hunt', zoneId: 'zone.meadow' });
  });

  it('a hungry hunter in town with gold picks the restaurant', () => {
    const h = freshHunter();
    h.needs.satiety = 15;
    expect(scoreGoals(config, nav, world0, h)[0]!.goal).toEqual({ type: 'service', buildingId: 'bld.restaurant' });
  });

  it('a broke hunter cannot pick paid services', () => {
    const h = freshHunter();
    h.needs.satiety = 15;
    h.gold = 0;
    expect(scoreGoals(config, nav, world0, h).some((c) => c.goal.type === 'service')).toBe(false);
  });

  it('in the field, low needs make returning home win over hunting', () => {
    const h = freshHunter();
    h.nodeId = 'z1.b';
    h.ai.goal = { type: 'hunt', zoneId: 'zone.meadow' };
    h.needs.stamina = 15;
    expect(needsOk(config, h)).toBeLessThan(0.5);
    expect(scoreGoals(config, nav, world0, h)[0]!.goal.type).toBe('returnTown');
  });

  it('urgentNeed reports the first need below its threshold', () => {
    const h = freshHunter();
    expect(urgentNeed(config, h)).toBeNull();
    h.needs.hp = h.stats.hp * 0.2;
    expect(urgentNeed(config, h)).toBe('hp');
  });
});

describe('M1 loop (integration)', () => {
  it('hunters hunt, return before needs hit urgent, use services and keep going', () => {
    const s = simWithHunters(21, config.formula.hunterSlots);
    const f = config.formula;
    let returnsFromField = 0, serviceUses = 0, kills = 0;
    const tripsTo = new Map<string, Set<string>>();
    for (let t = 0; t < 30 * 600; t++) { // 30 game minutes
      s.step();
      for (const e of s.drainEvents()) {
        if (e.type === 'goalChanged') {
          const set = tripsTo.get(e.hunterId) ?? new Set();
          set.add(e.goal.split(':')[0]!);
          tripsTo.set(e.hunterId, set);
          if (e.goal === 'returnTown') {
            returnsFromField++;
            // Whenever a hunter decides to go home, at least one need is at or below the soft threshold.
            const h = s.world.hunters.find((x) => x.id === e.hunterId)!;
            const worst = Math.min(...(['hp', 'satiety', 'mood', 'stamina'] as const).map((n) => needFrac(config, h, n)));
            expect(worst).toBeLessThanOrEqual(f.softNeedFrac + 1e-9);
          }
        }
        if (e.type === 'serviceUsed') serviceUses++;
        if (e.type === 'monsterKilled') kills++;
      }
      // No hunter ever stays in the field with an urgent need for more than one tick.
      for (const h of s.world.hunters) {
        if (h.deadMs > 0 || !nav.node(h.nodeId).zoneId) continue;
        if (urgentNeed(config, h)) expect(h.ai.goal?.type).toBe('returnTown');
      }
    }
    expect(kills).toBeGreaterThan(100);
    expect(returnsFromField).toBeGreaterThan(10);
    expect(serviceUses).toBeGreaterThan(10);
    for (const [, goals] of tripsTo) {
      expect(goals.has('hunt')).toBe(true);
      expect(goals.has('returnTown')).toBe(true);
    }
    expect(s.world.town.gold).toBeGreaterThan(0);
  });

  it('urgent thresholds force an immediate return even over a player order', () => {
    const s = simWithHunters(5, 1);
    const h = s.world.hunters[0]!;
    s.enqueue({ type: 'hunter.move', hunterId: h.id, zoneId: 'zone.meadow' });
    for (let i = 0; i < 600 && !nav.node(h.nodeId).zoneId; i++) s.step();
    expect(nav.node(h.nodeId).zoneId).toBe('zone.meadow');
    expect(h.ai.forced).toBe(true);
    h.needs.stamina = config.formula.needMax * urgentFrac(config.formula, 'stamina') * 0.5;
    s.step();
    expect(h.ai.goal?.type).toBe('returnTown');
  });

  it('dead hunters revive at the square after the configured delay', () => {
    const s = simWithHunters(5, 1);
    const h = s.world.hunters[0]!;
    s.enqueue({ type: 'hunter.move', hunterId: h.id, zoneId: 'zone.ruins' });
    h.stats.def = 0;
    h.stats.eva = 0;
    h.needs.hp = 1; // next hit kills; urgent return is too late once a golem is adjacent
    let died = false;
    for (let i = 0; i < 6000 && !died; i++) {
      s.step();
      died = s.drainEvents().some((e) => e.type === 'hunterDied');
      if (!died && h.ai.goal?.type === 'returnTown') { h.needs.hp = 1; s.enqueue({ type: 'hunter.move', hunterId: h.id, zoneId: 'zone.ruins' }); }
    }
    expect(died).toBe(true);
    expect(h.ai.goal?.type).toBe('dead');
    let ticks = 0, revived = false;
    while (!revived && ticks < 1000) {
      s.step();
      ticks++;
      revived = s.drainEvents().some((e) => e.type === 'hunterRevived' && e.hunterId === h.id);
    }
    expect(revived).toBe(true);
    expect(ticks).toBe(config.formula.reviveSec * 10);
    expect(h.nodeId).toBe(config.index.squareNode);
    // Same tick as revive: only idle regen of one tick may have been added on top.
    expect(h.needs.hp / h.stats.hp).toBeGreaterThanOrEqual(config.formula.reviveHpFrac);
    expect(h.needs.hp / h.stats.hp).toBeLessThan(config.formula.reviveHpFrac + 0.01);
  });

  it('hunter.activity rejects when the hunter cannot pay', () => {
    const s = simWithHunters(5, 1);
    const h = s.world.hunters[0]!;
    h.gold = 0;
    s.enqueue({ type: 'hunter.activity', hunterId: h.id, buildingId: 'bld.inn' });
    s.step();
    expect(s.drainEvents()).toContainEqual(expect.objectContaining({ type: 'commandRejected', reason: 'not enough gold' }));
  });

  it('stays deterministic with AI, combat and spawning', () => {
    const run = () => {
      const s = simWithHunters(77, 6);
      for (let i = 0; i < 6000; i++) s.step();
      return JSON.stringify(s.world);
    };
    expect(run()).toBe(run());
  });
});
