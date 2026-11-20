import {
  backstopHpFloor, needsOk, retreatHpFloor, scoreGoals, shouldRetreatBeforeNextKill, tripHomeDamage, urgentNeed,
  urgentThreshold, zoneDanger, zoneEntryHpLine,
} from '../src/core/ai/utility';
import { needMax } from '../src/core/formulas';
import { rollHunter } from '../src/core/hunterFactory';
import { NavGraph } from '../src/core/pathfinding';
import { Rng } from '../src/core/rng';
import { createWorld, Simulation } from '../src/core/simulation';
import { aiSystem } from '../src/core/systems/ai';
import type { Hunter, World } from '../src/core/world';
import { testConfig } from './helpers';

const config = testConfig();
const nav = new NavGraph(config);
const f = config.formula;

function hunter(patch: Partial<Hunter> = {}): Hunter {
  const h = rollHunter(config, new Rng(5), 'h0', config.index.squareNode, { x: 0, y: 0 }, 0);
  h.level = 1;
  h.personalities = [];
  h.equipment = {};
  h.skills = {};
  h.traits = {};
  h.ai.goal = null;
  Object.assign(h, patch);
  h.needs.hp = needMax(config, h, 'hp');
  return h;
}

/** Puts the hunter on a zone node, hunting that zone. */
function inZone(h: Hunter, zoneId: string, nodeSuffix = 'd'): Hunter {
  const node = config.index.zones.get(zoneId)!.entryNode.replace(/\.a$/, `.${nodeSuffix}`);
  const n = nav.node(node);
  h.nodeId = node;
  h.position = { x: n.x, y: n.y };
  h.ai.goal = { type: 'hunt', zoneId };
  h.ai.phase = 'act';
  return h;
}

const setHp = (h: Hunter, frac: number) => { h.needs.hp = needMax(config, h, 'hp') * frac; };
const world = (): World => createWorld(config, 1);

describe('retreat: expected damage on the way home', () => {
  it('costs nothing from town and more from deeper zones', () => {
    const w = world();
    const h = hunter({ level: 40 });
    expect(retreatHpFloor(config, nav, w, h)).toBe(0);
    expect(tripHomeDamage(config, nav, h, { x: 0, y: 0 }, config.index.squareNode, w.town.difficulty)).toBe(0);
    const from = (zoneId: string) => {
      const n = nav.node(config.index.zones.get(zoneId)!.entryNode);
      return tripHomeDamage(config, nav, h, n, n.id, w.town.difficulty);
    };
    expect(from('zone.meadow')).toBeGreaterThan(0);
    expect(from('zone.glacier')).toBeGreaterThan(from('zone.marsh'));
    expect(from('zone.abyss')).toBeGreaterThan(from('zone.glacier'));
  });

  it('is the zone DPS × time spent walking through it (single zone: meadow far node)', () => {
    const w = world();
    const h = inZone(hunter({ level: 10 }), 'zone.meadow');
    const d = zoneDanger(config, h, 'zone.meadow', w.town.difficulty);
    const dmg = tripHomeDamage(config, nav, h, h.position, h.nodeId, w.town.difficulty);
    // Path z1.d → z1.b/c → z1.a → gate: the last segment counts half (gate has no zone).
    const path = nav.path(h.nodeId, config.index.squareNode)!;
    let inMeadow = 0;
    for (let i = 1; i < path.length; i++) {
      const a = nav.node(path[i - 1]!), b = nav.node(path[i]!);
      const len = Math.hypot(a.x - b.x, a.y - b.y);
      inMeadow += (a.zoneId ? len / 2 : 0) + (b.zoneId ? len / 2 : 0);
    }
    expect(dmg).toBeCloseTo((inMeadow / f.moveSpeed) * d.dps, 6);
  });

  it('the floor is capped at retreatHpCap (a level-1 hunter deep in the abyss)', () => {
    const h = inZone(hunter(), 'zone.abyss');
    expect(retreatHpFloor(config, nav, world(), h)).toBe(f.retreatHpCap);
  });

  it('is negligible for a hunter far above the zone', () => {
    const h = inZone(hunter({ level: 60 }), 'zone.meadow');
    expect(retreatHpFloor(config, nav, world(), h)).toBeLessThan(urgentThreshold(config, h, 'hp') / 5);
  });
});

describe('retreat: thresholds', () => {
  it('urgentNeed uses max(personality threshold, hpFloor); the floor is not scaled by personality', () => {
    const plain = hunter();
    setHp(plain, 0.3);
    expect(urgentNeed(config, plain)).toBeNull();
    expect(urgentNeed(config, plain, 0.35)).toBe('hp');
    const reckless = hunter({ personalities: ['pers.reckless'] });
    setHp(reckless, 0.2);
    expect(urgentNeed(config, reckless)).toBeNull();
    expect(urgentNeed(config, reckless, 0.3)).toBe('hp');
  });

  it('needsOk: a floor at or below the urgent threshold changes nothing; above it the HP band shifts up', () => {
    const h = hunter();
    const base = urgentThreshold(config, h, 'hp');
    for (const hp of [0.2, 0.3, 0.35, 0.5]) {
      setHp(h, hp);
      expect(needsOk(config, h, true, base)).toBe(needsOk(config, h, true));
      expect(needsOk(config, h, true, base - 0.1)).toBe(needsOk(config, h, true));
    }
    const shift = 0.2;
    setHp(h, 0.32);
    const unshifted = needsOk(config, h, true);
    setHp(h, 0.32 + shift);
    expect(needsOk(config, h, true, base + shift)).toBeCloseTo(unshifted, 9);
    setHp(h, base + shift);
    expect(needsOk(config, h, true, base + shift)).toBe(0);
    setHp(h, f.softNeedFrac + shift);
    expect(needsOk(config, h, true, base + shift)).toBe(1);
  });

  it('backstopHpFloor is 0 in town and above retreatHpCap HP', () => {
    const w = world();
    const town = hunter();
    setHp(town, 0.1);
    expect(backstopHpFloor(config, nav, w, town)).toBe(0);
    const deep = inZone(hunter(), 'zone.abyss');
    setHp(deep, f.retreatHpCap + 0.05);
    expect(backstopHpFloor(config, nav, w, deep)).toBe(0);
    setHp(deep, f.retreatHpCap - 0.05);
    expect(backstopHpFloor(config, nav, w, deep)).toBe(f.retreatHpCap);
  });
});

describe('retreat: kill boundary', () => {
  it('leaves when one more kill would cross the retreat line, not otherwise', () => {
    const w = world();
    const weak = inZone(hunter(), 'zone.abyss');
    expect(shouldRetreatBeforeNextKill(config, nav, w, weak, 'zone.abyss')).toBe(true); // even at full HP
    const strong = inZone(hunter({ level: 60 }), 'zone.meadow');
    setHp(strong, 0.3);
    expect(shouldRetreatBeforeNextKill(config, nav, w, strong, 'zone.meadow')).toBe(false);
    // A fair fight: retreat exactly when HP − retreatKillMul × dmgPerKill drops under the line.
    const mid = inZone(hunter({ level: 12 }), 'zone.ruins');
    const kill = (f.retreatKillMul * zoneDanger(config, mid, 'zone.ruins', w.town.difficulty).dmgPerKill) / needMax(config, mid, 'hp');
    const line = Math.max(urgentThreshold(config, mid, 'hp'), retreatHpFloor(config, nav, w, mid));
    setHp(mid, line + kill + 0.01);
    expect(shouldRetreatBeforeNextKill(config, nav, w, mid, 'zone.ruins')).toBe(false);
    setHp(mid, line + kill - 0.01);
    expect(shouldRetreatBeforeNextKill(config, nav, w, mid, 'zone.ruins')).toBe(true);
  });

  it('a zone is not worth setting out for below its entry HP line', () => {
    const w = world();
    const h = hunter();
    const line = zoneEntryHpLine(config, nav, w, h, 'zone.meadow');
    expect(line).toBeGreaterThan(urgentThreshold(config, h, 'hp'));
    const huntsMeadow = () => scoreGoals(config, nav, w, h).some((c) => c.goal.type === 'hunt' && c.goal.zoneId === 'zone.meadow');
    setHp(h, line);
    expect(huntsMeadow()).toBe(false);
    setHp(h, 1);
    expect(huntsMeadow()).toBe(true);
  });
});

describe('retreat: AI system', () => {
  function sim(h: Hunter, attacker = false): Simulation {
    const w = world();
    w.hunters.push(h);
    if (attacker) {
      w.monsters.push({
        id: 'm1', defId: 'mon.voidcrawler', zoneId: 'zone.abyss', hp: 2900, position: { ...h.position }, home: { ...h.position },
        targetHunterId: h.id, attackCdMs: 1e9, difficultyId: w.town.difficulty,
      });
    }
    return new Simulation(config, w, [aiSystem]);
  }
  const reasons = (s: Simulation) => s.drainEvents().flatMap((e) => (e.type === 'goalChanged' ? [`${e.goal} ${e.reason}`] : []));

  it('between fights a hunter out of its depth walks home before the next kill', () => {
    const h = inZone(hunter(), 'zone.abyss');
    const s = sim(h);
    s.step();
    expect(h.ai.goal?.type).toBe('returnTown');
    expect(reasons(s)).toContain('returnTown retreat hp');
  });

  it('no kill-boundary retreat while a monster is on the hunter, or under a player order', () => {
    const busy = inZone(hunter(), 'zone.abyss');
    busy.ai.decideInMs = 1e9; // keep the utility re-decision out of this tick
    const s1 = sim(busy, true);
    s1.step();
    expect(busy.ai.goal).toEqual({ type: 'hunt', zoneId: 'zone.abyss' });
    const ordered = inZone(hunter(), 'zone.abyss');
    ordered.ai.forced = true;
    const s2 = sim(ordered);
    s2.step();
    expect(ordered.ai.goal).toEqual({ type: 'hunt', zoneId: 'zone.abyss' });
  });

  it('the urgent backstop fires at the retreat floor, above the base HP threshold, even under orders', () => {
    const h = inZone(hunter(), 'zone.abyss');
    h.ai.forced = true;
    setHp(h, f.retreatHpCap - 0.05); // well above urgentHpFrac, below the (capped) floor
    expect(urgentNeed(config, h)).toBeNull();
    const s = sim(h);
    s.step();
    expect(h.ai.goal?.type).toBe('returnTown');
    expect(reasons(s)).toContain('returnTown urgent hp');
  });
});
