import { dangerCache, scoreGoals, zoneDanger } from '../src/core/ai/utility';
import type { FormulaParams, GameConfig } from '../src/core/config/types';
import { EventBuffer } from '../src/core/events';
import {
  critChance, critMultiplier, crowdFactor, defReduction, dodgeChance, duel, expectedHit, hunterPower, hunterStats, killsPerLife, levelGapMult,
  liveCrowd, mitigated, moodStatMult, monsterTypeStats, powerRatio, stackPct, zoneFit, zoneOccupancy, zoneScores, zoneShare,
} from '../src/core/formulas';
import { rollHunter } from '../src/core/hunterFactory';
import { NavGraph } from '../src/core/pathfinding';
import { Rng } from '../src/core/rng';
import { createWorld, Simulation } from '../src/core/simulation';
import type { SystemContext } from '../src/core/system';
import { combatSystem } from '../src/core/systems/combat';
import type { Hunter } from '../src/core/world';
import { testConfig } from './helpers';

const config = testConfig();
const f = config.formula;
const nav = new NavGraph(config);

/** A bare hunter (no gear, skills, traits, buffs, personalities) at `level`, base stats grown like gainExp does. */
function bareHunter(level: number, zoneId = 'zone.meadow', seed = 3): Hunter {
  const nodeId = config.index.zoneNodes.get(zoneId)![0]!;
  const node = nav.node(nodeId);
  const h = rollHunter(config, new Rng(seed), 'h0', nodeId, { x: node.x, y: node.y }, 0);
  h.level = level;
  h.stats.hp += (level - 1) * f.levelHpGain;
  h.stats.atk += (level - 1) * f.levelAtkGain;
  h.stats.def += (level - 1) * f.levelDefGain;
  h.equipment = {};
  h.skills = {};
  h.traits = {};
  h.buffs = [];
  h.personalities = [];
  h.insideBuildingId = null;
  return h;
}

describe('formulas: DEF reduction', () => {
  it('is 0 at 0 DEF (and for negative DEF), rises with DEF and never reaches the cap', () => {
    expect(defReduction(0, 10, f)).toBe(0);
    expect(defReduction(-50, 10, f)).toBe(0);
    let prev = 0;
    for (const def of [1, 10, 50, 100, 500]) {
      const r = defReduction(def, 10, f);
      expect(r).toBeGreaterThan(prev);
      expect(r).toBeLessThan(1);
      prev = r;
    }
    expect(defReduction(1e9, 1, f)).toBeLessThan(f.defReductionCap);
    expect(defReduction(1e9, 1, f)).toBeGreaterThan(f.defSoftKnee);
    expect(f.defReductionCap).toBeLessThan(1);
  });

  it('soft cap: the plain hyperbola up to defSoftKnee, then smooth (same value and slope) and still rising', () => {
    const half = (lvl: number) => f.defPerLevel * lvl + f.defFlat;
    const atRaw = (raw: number, lvl: number) => (raw / (1 - raw)) * half(lvl); // DEF giving that hyperbola value
    expect(f.defSoftKnee).toBeLessThan(f.defReductionCap);
    for (const raw of [0.1, 0.4, f.defSoftKnee]) expect(defReduction(atRaw(raw, 30), 30, f)).toBeCloseTo(raw, 10);
    const k = atRaw(f.defSoftKnee, 30), e = 1e-3;
    const slope = (d: number) => (defReduction(d + e, 30, f) - defReduction(d - e, 30, f)) / (2 * e);
    expect(slope(k + 2 * e) / slope(k - 2 * e)).toBeCloseTo(1, 2);
    let prev = 0;
    for (let d = k; d < 50 * k; d *= 1.5) {
      const r = defReduction(d, 30, f);
      expect(r).toBeGreaterThanOrEqual(prev);
      expect(r).toBeLessThan(f.defReductionCap);
      prev = r;
    }
    // defSoftKnee ≥ cap is the old hard clamp.
    const hard = { ...f, defSoftKnee: f.defReductionCap };
    expect(defReduction(1e9, 1, hard)).toBe(f.defReductionCap);
    expect(defReduction(atRaw(0.5, 30), 30, hard)).toBeCloseTo(0.5, 10);
  });

  it('Torment I vs a reincarnated Lv30 hunter: monsterDefMul still matters (no saturation at the cap)', () => {
    const torment = config.index.difficulties.get('diff.torment1')!;
    const hard = { ...f, defSoftKnee: f.defReductionCap };
    for (const id of ['mon.voidcrawler', 'mon.hollowlord']) {
      const def = config.index.monsters.get(id)!.def;
      const r13 = defReduction(def * torment.monsterDefMul, 30, f);
      const r20 = defReduction(def * config.index.difficulties.get('diff.torment2')!.monsterDefMul, 30, f);
      expect(r20).toBeGreaterThan(r13 + 0.005);
      expect(r20).toBeLessThan(f.defReductionCap);
      // With the old hard clamp the same DEF step changed little or nothing.
      expect(defReduction(def * 20, 30, hard) - defReduction(def * 13, 30, hard)).toBeLessThan(r20 - r13);
    }
  });

  it('half value scales with the attacker level: the same DEF stops less against a higher-level attacker', () => {
    const half = (lvl: number) => f.defPerLevel * lvl + f.defFlat;
    expect(defReduction(half(20), 20, f)).toBeCloseTo(0.5);
    expect(defReduction(100, 80, f)).toBeLessThan(defReduction(100, 10, f));
    // Level 0 / negative levels are treated as level 1 (no division by a tiny constant).
    expect(defReduction(50, 0, f)).toBe(defReduction(50, 1, f));
  });

  it('hits never deal 0 or negative damage, and huge DEF leaves a bit more than (1 − cap) of ATK', () => {
    expect(mitigated(0, 0, 1, 1, f)).toBe(f.minDamage);
    expect(mitigated(-10, 0, 1, 1, f)).toBe(f.minDamage);
    expect(mitigated(1, 1e9, 1, 1, f)).toBe(f.minDamage);
    expect(mitigated(1000, 1e9, 1, 1, f)).toBeGreaterThan(1000 * (1 - f.defReductionCap));
    expect(mitigated(1000, 1e9, 1, 1, f)).toBeLessThan(1000 * (1 - f.defSoftKnee));
    expect(mitigated(100, 0, 5, 5, f)).toBe(100);
  });

  it('is monotonic: more ATK never deals less, more DEF never takes more', () => {
    for (let a = 1; a < 500; a += 37) expect(mitigated(a + 10, 40, 20, 20, f)).toBeGreaterThanOrEqual(mitigated(a, 40, 20, 20, f));
    for (let d = 0; d < 500; d += 37) expect(mitigated(200, d + 10, 20, 20, f)).toBeLessThanOrEqual(mitigated(200, d, 20, 20, f));
  });
});

describe('formulas: level gap', () => {
  it('is neutral at equal level, inside the grace window and when the attacker is higher', () => {
    expect(levelGapMult(30, 30, f)).toBe(1);
    expect(levelGapMult(30, 30 + f.levelGapGrace, f)).toBe(1);
    expect(levelGapMult(90, 10, f)).toBe(1);
  });

  it('penalises an attacker far below its target, down to levelGapMin', () => {
    const g1 = levelGapMult(20, 20 + f.levelGapGrace + 1, f);
    expect(g1).toBeCloseTo(1 - f.levelGapStep);
    expect(levelGapMult(20, 40, f)).toBeLessThan(g1);
    expect(levelGapMult(1, 100, f)).toBe(f.levelGapMin);
    expect(f.levelGapMin).toBeGreaterThan(0);
    // A level-35 monster barely scratches a level-85 hunter with the same DEF it would face from a peer.
    expect(mitigated(68, 240, 35, 85, f)).toBeLessThan(mitigated(68, 240, 35, 35, f) * 0.5);
  });
});

describe('formulas: crit and dodge', () => {
  it('crit chance is linear in the stat, clamped to [0, critChanceCap]', () => {
    expect(critChance(0, f)).toBe(0);
    expect(critChance(-5, f)).toBe(0);
    expect(critChance(10, f)).toBeCloseTo(0.1);
    expect(critChance(1e6, f)).toBe(f.critChanceCap);
    expect(f.critChanceCap).toBeLessThan(1);
  });

  it('crit points over the cap turn into crit damage', () => {
    expect(critMultiplier(10, f.critMultiplier, f)).toBe(f.critMultiplier);
    const capPts = f.critChanceCap * 100;
    expect(critMultiplier(capPts, f.critMultiplier, f)).toBe(f.critMultiplier);
    expect(critMultiplier(capPts + 20, f.critMultiplier, f)).toBeCloseTo(f.critMultiplier + 0.2 * f.critOverflowMult);
    expect(critMultiplier(capPts + 20, f.monsterCritMultiplier, f)).toBeCloseTo(f.monsterCritMultiplier + 0.2 * f.critOverflowMult);
  });

  it('dodge has diminishing returns, half the cap at dodgeHalf, never reaches the cap', () => {
    expect(dodgeChance(0, f)).toBe(0);
    expect(dodgeChance(-10, f)).toBe(0);
    expect(dodgeChance(f.dodgeHalf, f)).toBeCloseTo(f.dodgeCap / 2);
    let prev = 0;
    for (const e of [1, 5, 20, 50, 200, 1e6]) {
      const d = dodgeChance(e, f);
      expect(d).toBeGreaterThan(prev);
      expect(d).toBeLessThan(f.dodgeCap);
      prev = d;
    }
    // Diminishing: the second +20 EVA is worth less than the first.
    expect(dodgeChance(40, f) - dodgeChance(20, f)).toBeLessThan(dodgeChance(20, f));
  });

  it('expected hit = hit × (1 − dodge) × (1 + P(crit)·(mult − 1))', () => {
    const hit = mitigated(100, 30, 20, 20, f);
    const p = critChance(30, f);
    expect(expectedHit(100, 30, 20, 20, 30, f.critMultiplier, 25, f)).toBeCloseTo(hit * (1 - dodgeChance(25, f)) * (1 + p * (f.critMultiplier - 1)));
    expect(expectedHit(100, 30, 20, 20, 0, f.critMultiplier, 0, f)).toBeCloseTo(hit);
  });
});

describe('formulas: stacking', () => {
  it('is additive within a category, multiplicative across, and capped per category', () => {
    expect(stackPct(0, 0, f)).toBe(1);
    expect(stackPct(20, 0, f)).toBeCloseTo(1.2);
    expect(stackPct(20 + 20, 0, f)).toBeCloseTo(1.4); // two traits: +40 %, not +44 %
    expect(stackPct(20, 20, f)).toBeCloseTo(1.44); // trait × buff
    expect(stackPct(1e6, 0, f)).toBeCloseTo(1 + f.traitPctCap / 100);
    expect(stackPct(0, 1e6, f)).toBeCloseTo(1 + f.buffPctCap / 100);
    expect(stackPct(1e6, 1e6, f)).toBeCloseTo((1 + f.traitPctCap / 100) * (1 + f.buffPctCap / 100));
    expect(stackPct(-50, -50, f)).toBe(1);
  });

  it('hunterStats applies the caps to traits and buffs; steady stats ignore buffs', () => {
    const h = bareHunter(10);
    const atk0 = hunterStats(config, h).atk;
    h.buffs = [1, 2, 3, 4, 5].map((i) => ({ sourceId: `b${i}`, stat: 'atkPct' as const, value: 100, remainingMs: 1e6 }));
    expect(hunterStats(config, h).atk).toBeCloseTo(atk0 * (1 + f.buffPctCap / 100));
    expect(hunterStats(config, h, { steady: true }).atk).toBeCloseTo(atk0);
    h.buffs = [{ sourceId: 'haste', stat: 'atkSpeedPct', value: 1e6, remainingMs: 1e6 }];
    expect(hunterStats(config, h).atkSpeed).toBeGreaterThanOrEqual(f.minAttackInterval);
  });
});

describe('formulas: mood', () => {
  const on: FormulaParams = { ...f, moodPenaltyFrac: 0.5, moodStatFloor: 0.8 };
  it('is 1 above the threshold and falls linearly to the floor at 0 mood', () => {
    expect(moodStatMult(1, on)).toBe(1);
    expect(moodStatMult(0.5, on)).toBe(1);
    expect(moodStatMult(0.25, on)).toBeCloseTo(0.9);
    expect(moodStatMult(0, on)).toBeCloseTo(0.8);
    expect(moodStatMult(-1, on)).toBeCloseTo(0.8);
  });

  it('scales ATK/DEF but not HP, and only outside steady stats', () => {
    const cfg: GameConfig = { ...config, formula: on };
    const h = bareHunter(10);
    const full = hunterStats(cfg, h);
    h.needs.mood = 0;
    const sad = hunterStats(cfg, h);
    expect(sad.atk).toBeCloseTo(full.atk * 0.8);
    expect(sad.def).toBeCloseTo(full.def * 0.8);
    expect(sad.hp).toBe(full.hp);
    expect(hunterStats(cfg, h, { steady: true }).atk).toBeCloseTo(full.atk);
  });

  it('shipped config states whether mood scaling is on (moodStatFloor = 1 means off)', () => {
    expect(f.moodStatFloor).toBeGreaterThan(0);
    expect(f.moodStatFloor).toBeLessThanOrEqual(1);
  });
});

describe('formulas: zone fit and tie-break', () => {
  it('zoneFit ramps, plateaus and decays to the floor', () => {
    expect(zoneFit(f.zoneFitMin - 0.01, f)).toBe(0);
    expect(zoneFit(Number.NaN, f)).toBe(0);
    expect(zoneFit(f.zoneFitMin, f)).toBeCloseTo(f.zoneFitRampLow);
    expect(zoneFit((f.zoneFitMin + f.zoneFitBest) / 2, f)).toBeCloseTo((f.zoneFitRampLow + 1) / 2);
    expect(zoneFit(f.zoneFitBest, f)).toBe(1);
    expect(zoneFit(f.zoneFitEasy, f)).toBe(1);
    expect(zoneFit(f.zoneFitEasy + 0.5, f)).toBeLessThan(1);
    expect(zoneFit(1e6, f)).toBe(f.zoneFitFloor);
  });

  it('crowding: a zone supplies one monster per respawnSec, shared by its hunters', () => {
    const z = config.zones[0]!;
    expect(zoneShare(z.respawnSec * 4, 1, z)).toBe(1);
    expect(zoneShare(z.respawnSec * 4, 8, z)).toBeCloseTo(0.5);
    expect(zoneShare(z.respawnSec * 4, 16, z)).toBeLessThan(zoneShare(z.respawnSec * 4, 8, z));
  });

  it('an absurdly strong hunter (all zones at the floor) prefers the hardest zone by more than the decision noise', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const h = bareHunter(100, 'zone.meadow', seed);
      h.stats.hp *= 1e4;
      h.stats.atk *= 1e4;
      h.stats.def *= 1e4;
      const scores = zoneScores(config, createWorld(config, seed), h);
      for (const s of scores) expect(s.ratio).toBeGreaterThan(f.zoneFitEasy);
      const top = scores[scores.length - 1]!;
      for (const s of scores.slice(0, -1)) expect(top.fit - s.fit).toBeGreaterThan(f.decisionNoise);
    }
    expect(f.zoneTierBonus).toBeGreaterThan(f.decisionNoise);
  });

  it('through scoreGoals, even a timid (× 0.7) over-powered hunter ranks the hardest zone first and the meadow far below', () => {
    const h = bareHunter(100, 'zone.meadow', 2);
    h.personalities = ['pers.timid'];
    h.stats.hp *= 1e4;
    h.stats.atk *= 1e4;
    h.stats.def *= 1e4;
    h.needs.hp = hunterStats(config, h).hp; // full HP, so needsOk = 1
    const hunts = scoreGoals(config, nav, createWorld(config, 2), h).filter((c) => c.goal.type === 'hunt');
    const by = (id: string) => hunts.find((c) => (c.goal as { zoneId: string }).zoneId === id)?.score ?? 0; // absent = score 0
    const top = config.zones[config.zones.length - 1]!.id;
    expect(Math.max(...hunts.map((c) => c.score))).toBe(by(top));
    // Adjacent tiers may sit within the noise after × 0.7; the easiest zone must not.
    expect(by(top) - by('zone.meadow')).toBeGreaterThan(f.decisionNoise * 2);
  });

  it('the tie-break never raises the best zone and leaves zones that are not comfortable alone', () => {
    const h = bareHunter(12, 'zone.meadow');
    const w = createWorld(config, 1);
    const scores = zoneScores(config, w, h);
    const noTie = zoneScores({ ...config, formula: { ...f, zoneTierBonus: 0 } }, w, h);
    expect(Math.max(...scores.map((s) => s.fit))).toBeLessThanOrEqual(Math.max(...scores.map((s) => zoneFit(s.ratio, f))) + 1e-12);
    scores.forEach((s, i) => {
      expect(s.fit).toBeLessThanOrEqual(noTie[i]!.fit + 1e-12);
      if (s.ratio < f.zoneFitBest) expect(s.fit).toBeCloseTo(noTie[i]!.fit, 12);
    });
  });

  it('powerRatio grows with level and falls with zone depth; hunterPower grows with level', () => {
    const w = createWorld(config, 1);
    const lo = bareHunter(5), hi = bareHunter(40);
    for (const z of config.zones) expect(powerRatio(config, w, hi, z)).toBeGreaterThan(powerRatio(config, w, lo, z));
    const r = config.zones.map((z) => powerRatio(config, w, hi, z));
    for (let i = 1; i < r.length; i++) expect(r[i]!).toBeLessThan(r[i - 1]!);
    expect(hunterPower(config, hi)).toBeGreaterThan(hunterPower(config, lo));
  });

  it('crowdFactor = zoneCrowdMul × √(monsters alive per hunter), floored at zoneCrowdMinRho', () => {
    expect(crowdFactor(12, 1, f)).toBeCloseTo(f.zoneCrowdMul * Math.sqrt(12));
    expect(crowdFactor(12, 4, f)).toBeCloseTo(crowdFactor(3, 1, f));
    expect(crowdFactor(12, 4, f) / crowdFactor(12, 1, f)).toBeCloseTo(0.5);
    expect(crowdFactor(0, 3, f)).toBeCloseTo(f.zoneCrowdMul * Math.sqrt(f.zoneCrowdMinRho));
    expect(crowdFactor(5, 0, f)).toBe(crowdFactor(5, 1, f)); // never divides by fewer than one hunter
  });

  it('zoneOccupancy: unvisited zones count as full, the judging hunter is left out of the hunter counts', () => {
    const w = createWorld(config, 1);
    const a = bareHunter(20, 'zone.marsh'), b = bareHunter(20, 'zone.marsh');
    b.id = 'h1';
    a.ai.goal = b.ai.goal = { type: 'hunt', zoneId: 'zone.marsh' };
    w.hunters.push(a, b);
    const occ = zoneOccupancy(config, w, a.id);
    expect(occ.hunters.get('zone.marsh')).toBe(1);
    expect(occ.alive.get('zone.marsh')).toBe(config.index.zones.get('zone.marsh')!.monsterCap);
    w.zones['zone.marsh'] = { respawnMs: 0 }; // visited, now empty
    expect(zoneOccupancy(config, w, a.id).alive.get('zone.marsh')).toBe(0);
  });

  it('powerRatio is √(killsPerLife / zoneRefKills): 4× the kills per life is 2× the ratio', () => {
    const w = createWorld(config, 1);
    const h = bareHunter(20);
    const z = config.index.zones.get('zone.marsh')!;
    const crowd = liveCrowd(zoneOccupancy(config, w, h.id), z, f);
    expect(powerRatio(config, w, h, z)).toBeCloseTo(Math.sqrt(killsPerLife(config, h, z, 'diff.easy', crowd) / f.zoneRefKills));
    // A lone hunter in a full (unvisited) zone: ρ = monsterCap.
    expect(crowd).toBeCloseTo(crowdFactor(z.monsterCap, 1, f));
  });
});

/**
 * Balance: the expected duel (what the AI uses) predicts the simulated combat system. One hunter, one monster at
 * a time, level frozen, HP refilled; skills stripped (duel() adds strike/aoe skills as ATK × mult / cooldown,
 * which the per-hit formulas already cover). Tolerance 15 %: the duel is a continuous approximation
 * (no overkill on the last hit, no first-attack delay).
 */
describe('balance: duel prediction vs simulated combat', () => {
  const cases: [string, string, number][] = [
    ['zone.meadow', 'mon.slime', 3], ['zone.ruins', 'mon.golem', 10], ['zone.marsh', 'mon.bogling', 18],
    ['zone.crags', 'mon.cinderimp', 28], ['zone.glacier', 'mon.rimewolf', 45], ['zone.citadel', 'mon.drownedknight', 30],
  ];
  for (const [zoneId, monId, level] of cases) {
    it(`${monId} vs a level-${level} hunter`, () => {
      const world = createWorld(config, 1);
      world.hunters = [];
      world.monsters = [];
      const h = bareHunter(level, zoneId);
      h.needs.hp = 1e12;
      h.ai = { goal: { type: 'hunt', zoneId }, phase: 'act', path: [], decideInMs: 1e9, targetMonsterId: null, moveTo: null, forced: false };
      world.hunters.push(h);
      const ctx: SystemContext = { world, config, nav, rng: new Rng(9), events: new EventBuffer(), debug: { aiScores: new Map() }, dtMs: 100 };
      const md = config.index.monsters.get(monId)!;
      const spawn = () => {
        const pos = { x: h.position.x + 1, y: h.position.y };
        const m = { id: `m${world.nextId++}`, defId: monId, zoneId, hp: md.hp, position: { ...pos }, home: { ...pos }, targetHunterId: null, attackCdMs: md.attackSpeed * 1000, difficultyId: 'diff.easy' };
        world.monsters.push(m);
        h.ai.targetMonsterId = m.id;
      };
      spawn();
      let kills = 0, taken = 0, ticks = 0;
      while (kills < 150) {
        combatSystem.update(ctx);
        world.tick++;
        ticks++;
        for (const e of ctx.events.drain()) {
          if (e.type === 'hit' && e.targetId === h.id) taken += e.damage;
          if (e.type === 'monsterKilled') kills++;
        }
        h.needs.hp = 1e12;
        h.exp = 0;
        if (world.monsters.length === 0) spawn();
      }
      const d = duel(config, h, hunterStats(config, h, { steady: true }), monsterTypeStats(config, monId, 'diff.easy'));
      const simTtk = (ticks * ctx.dtMs) / 1000 / kills;
      expect(taken / kills / d.dmgPerKill).toBeGreaterThan(0.85);
      expect(taken / kills / d.dmgPerKill).toBeLessThan(1.15);
      expect(simTtk / d.ttk).toBeGreaterThan(0.9);
      expect(simTtk / d.ttk).toBeLessThan(1.2);
    });
  }
});

/**
 * Balance in the full simulation: HP lost per kill while hunting a zone stays within a broad band of the AI's
 * prediction (zoneDanger.dmgPerKill with the live crowd factor, formulas.crowdFactor). Over 10 seeds × 15 h the
 * per-zone ratio is 1.01–1.20 (early 6 s-respawn zones highest); the band leaves room for one seed's noise. It catches
 * a predictor that drifts from the combat system (e.g. a formula changed in one place only).
 */
describe('balance: in-zone HP cost vs prediction', () => {
  it('measured / predicted HP lost per kill (live crowd factor) is within [0.7, 1.45] in every zone with enough kills', () => {
    const sim = new Simulation(config, createWorld(config, 2));
    for (let i = 0; i < f.hunterSlots; i++) sim.enqueue({ type: 'debug.spawnHunter' });
    const acc: Record<string, { taken: number; pred: number; kills: number }> = {};
    for (let t = 0; t < 150 * 600; t++) {
      sim.step();
      for (const e of sim.drainEvents()) {
        if (e.type !== 'hit' && e.type !== 'monsterKilled') continue;
        const hid = e.type === 'hit' ? e.targetId : e.hunterId;
        const h = sim.world.hunters.find((x) => x.id === hid);
        const g = h?.ai.goal;
        if (!h || g?.type !== 'hunt' || config.index.nodes.get(h.nodeId)?.zoneId !== g.zoneId) continue;
        const a = (acc[g.zoneId] ??= { taken: 0, pred: 0, kills: 0 });
        if (e.type === 'hit') {
          if (!e.evaded) a.taken += e.damage;
        } else {
          a.kills++;
          a.pred += zoneDanger(config, h, g.zoneId, sim.world.town.difficulty, dangerCache(config, h, sim.world)).dmgPerKill;
        }
      }
    }
    const checked = Object.entries(acc).filter(([, a]) => a.kills >= 100);
    expect(checked.length).toBeGreaterThanOrEqual(2);
    for (const [, a] of checked) {
      expect(a.taken / a.pred).toBeGreaterThan(0.7);
      expect(a.taken / a.pred).toBeLessThan(1.45);
    }
  }, 120_000);
});
