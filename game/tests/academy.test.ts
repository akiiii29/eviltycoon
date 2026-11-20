import { bestLearn, scoreGoals } from '../src/core/ai/utility';
import { EventBuffer, type SimEvent } from '../src/core/events';
import { powerRatio } from '../src/core/formulas';
import { rollHunter } from '../src/core/hunterFactory';
import { NavGraph } from '../src/core/pathfinding';
import { Rng } from '../src/core/rng';
import { createWorld, DEFAULT_SYSTEMS, Simulation } from '../src/core/simulation';
import type { SystemContext } from '../src/core/system';
import { academySystem, canLearnTrait, nextSkillStudy } from '../src/core/systems/academy';
import { setGoal } from '../src/core/systems/ai';
import { newAiState, type Goal, type Hunter } from '../src/core/world';
import { testConfig } from './helpers';

const config = testConfig();
const nav = new NavGraph(config);

const CLEAVE = 'skill.vanguard.cleave'; // vanguard, jobTierMin 0, studyLevel [1,5,10,20,35], studyGold [50,150,400,900,2000]
const RAGE = 'skill.vanguard.rage'; // vanguard, jobTierMin 1
const BASH = 'skill.warden.bash'; // warden

function makeCtx(seed = 1): SystemContext & { events: EventBuffer } {
  return {
    world: createWorld(config, seed), config, nav, rng: new Rng(seed),
    events: new EventBuffer(), debug: { aiScores: new Map() }, dtMs: 100,
  };
}

/** A level-1 vanguard in town with no personalities, no skills/traits, and the given patch. */
function hunter(patch: Partial<Hunter> = {}): Hunter {
  const h = rollHunter(config, new Rng(7), 'h0', config.index.squareNode, { x: 0, y: 0 }, 0);
  h.classId = 'class.vanguard';
  h.jobTier = 0;
  h.level = 1;
  h.skills = {};
  h.traits = {};
  h.traitPoints = 0;
  h.personalities = [];
  h.ai.goal = null;
  h.nodeId = config.index.squareNode;
  Object.assign(h, patch);
  return h;
}

function atAcademy(ctx: SystemContext, patch: Partial<Hunter>, goal: Goal): Hunter {
  const h = hunter(patch);
  h.ai.goal = goal;
  h.ai.phase = 'act';
  h.ai.forced = true;
  ctx.world.hunters.push(h);
  return h;
}

const learned = (evs: SimEvent[]) => evs.filter((e): e is Extract<SimEvent, { type: 'learned' }> => e.type === 'learned');

function expectCleared(h: Hunter): void {
  expect(h.ai.goal).toBeNull();
  expect(h.ai.forced).toBe(false);
}

describe('Academy: skills', () => {
  it('nextSkillStudy gates on class, job tier, hunter level and max level', () => {
    expect(nextSkillStudy(config, hunter(), CLEAVE)).toEqual({ level: 1, cost: 50 });
    expect(nextSkillStudy(config, hunter({ skills: { [CLEAVE]: 1 } }), CLEAVE)).toBeNull(); // level 2 needs hunter lv 5
    expect(nextSkillStudy(config, hunter({ level: 5, skills: { [CLEAVE]: 1 } }), CLEAVE)).toEqual({ level: 2, cost: 150 });
    expect(nextSkillStudy(config, hunter(), BASH)).toBeNull(); // other class
    expect(nextSkillStudy(config, hunter({ level: 50 }), RAGE)).toBeNull(); // job tier 0 < 1
    expect(nextSkillStudy(config, hunter({ level: 50, jobTier: 1 }), RAGE)).toEqual({ level: 1, cost: 50 });
    expect(nextSkillStudy(config, hunter({ level: 99, skills: { [CLEAVE]: 5 } }), CLEAVE)).toBeNull(); // maxed
    expect(nextSkillStudy(config, hunter(), 'skill.nope')).toBeNull();
  });

  it('learns a skill level: hunter pays the full fee, the town gets its feeTownShare cut, emits learned', () => {
    const ctx = makeCtx();
    const town0 = ctx.world.town.gold;
    const h = atAcademy(ctx, { gold: 70 }, { type: 'learn', kind: 'skill', id: CLEAVE });
    academySystem.update(ctx);
    expect(h.skills[CLEAVE]).toBe(1);
    expect(h.gold).toBe(20);
    expect(ctx.world.town.gold).toBe(town0 + Math.round(50 * config.formula.feeTownShare)); // rest is a gold sink
    expect(ctx.world.stats.learned).toBe(1);
    expect(learned(ctx.events.drain())).toEqual([
      { type: 'learned', tick: ctx.world.tick, hunterId: h.id, kind: 'skill', id: CLEAVE, level: 1, cost: 50 },
    ]);
    expectCleared(h);
  });

  it.each<[string, Partial<Hunter>, string]>([
    ['not enough gold', { gold: 49 }, CLEAVE],
    ['hunter level too low', { gold: 1000, skills: { [CLEAVE]: 1 } }, CLEAVE],
    ['job tier too low', { gold: 1000, level: 50 }, RAGE],
    ['class mismatch', { gold: 1000 }, BASH],
    ['maxed', { gold: 99999, level: 99, skills: { [CLEAVE]: 5 } }, CLEAVE],
  ])('rejects: %s (goal still cleared)', (_name, patch, id) => {
    const ctx = makeCtx();
    const town0 = ctx.world.town.gold;
    const h = atAcademy(ctx, patch, { type: 'learn', kind: 'skill', id });
    const before = { gold: h.gold, skills: { ...h.skills } };
    academySystem.update(ctx);
    expect(h.gold).toBe(before.gold);
    expect(h.skills).toEqual(before.skills);
    expect(ctx.world.town.gold).toBe(town0);
    expect(ctx.world.stats.learned).toBe(0);
    expect(learned(ctx.events.drain())).toHaveLength(0);
    expectCleared(h);
  });

  it('does nothing while travelling', () => {
    const ctx = makeCtx();
    const h = atAcademy(ctx, { gold: 100 }, { type: 'learn', kind: 'skill', id: CLEAVE });
    h.ai.phase = 'travel';
    academySystem.update(ctx);
    expect(h.skills[CLEAVE]).toBeUndefined();
    expect(h.ai.goal).not.toBeNull();
  });
});

describe('Academy: traits', () => {
  it('spends trait points for +1 level', () => {
    const ctx = makeCtx();
    const h = atAcademy(ctx, { traitPoints: 2, traits: { 'trait.atk': 3 } }, { type: 'learn', kind: 'trait', id: 'trait.atk' });
    academySystem.update(ctx);
    expect(h.traits['trait.atk']).toBe(4);
    expect(h.traitPoints).toBe(1);
    expect(ctx.world.stats.learned).toBe(1);
    expect(learned(ctx.events.drain())[0]).toMatchObject({ kind: 'trait', id: 'trait.atk', level: 4, cost: 1 });
    expectCleared(h);
  });

  it('rejects without points, when maxed, or on class mismatch', () => {
    expect(canLearnTrait(config, hunter({ traitPoints: 0 }), 'trait.atk')).toBe(false);
    expect(canLearnTrait(config, hunter({ traitPoints: 5 }), 'trait.atk')).toBe(true);
    expect(canLearnTrait(config, hunter({ traitPoints: 5, traits: { 'trait.atk': 10 } }), 'trait.atk')).toBe(false);
    const classCfg = { ...config, index: { ...config.index, traits: new Map(config.index.traits) } };
    classCfg.index.traits.set('trait.atk', { ...config.index.traits.get('trait.atk')!, classId: 'class.warden' });
    expect(canLearnTrait(classCfg, hunter({ traitPoints: 5 }), 'trait.atk')).toBe(false);
    expect(canLearnTrait(classCfg, hunter({ traitPoints: 5, classId: 'class.warden' }), 'trait.atk')).toBe(true);

    const ctx = makeCtx();
    const h = atAcademy(ctx, { traitPoints: 0 }, { type: 'learn', kind: 'trait', id: 'trait.atk' });
    academySystem.update(ctx);
    expect(h.traits['trait.atk']).toBeUndefined();
    expect(ctx.world.stats.learned).toBe(0);
    expectCleared(h);
  });
});

describe('AI: bestLearn', () => {
  const reserve = config.formula.enhanceGoldReserveMul;

  it('prefers the cheapest learnable skill when affordable with reserve', () => {
    expect(bestLearn(config, hunter({ gold: 50 * reserve, level: 2, traitPoints: 3 }))).toEqual({ kind: 'skill', id: CLEAVE, cost: 50 });
    // Tier 1 at level 50: rage lv1 (50) is cheaper than cleave lv2 (150).
    const h = hunter({ gold: 10000, level: 50, jobTier: 1, skills: { [CLEAVE]: 1 } });
    expect(bestLearn(config, h)).toEqual({ kind: 'skill', id: RAGE, cost: 50 });
  });

  it('falls back to a trait when the skill is not affordable with reserve', () => {
    expect(bestLearn(config, hunter({ gold: 50 * reserve - 1, level: 2, traitPoints: 1 }))).toEqual({ kind: 'trait', id: 'trait.atk', cost: 1 });
    // atk maxed → next in priority (hpPct).
    expect(bestLearn(config, hunter({ gold: 0, traitPoints: 1, traits: { 'trait.atk': 10 } }))?.id).toBe('trait.hp');
  });

  it('none when nothing is affordable or learnable', () => {
    expect(bestLearn(config, hunter({ gold: 50 * reserve - 1, level: 2, traitPoints: 0 }))).toBeNull();
  });

  it('a level-1 hunter keeps its starting gold back and hunts before studying', () => {
    const start = config.formula.startingGold;
    expect(bestLearn(config, hunter({ gold: start }))).toBeNull();
    expect(bestLearn(config, hunter({ gold: start + 50 * reserve - 1 }))).toBeNull();
    expect(bestLearn(config, hunter({ gold: start + 50 * reserve }))).toEqual({ kind: 'skill', id: CLEAVE, cost: 50 });
    expect(bestLearn(config, hunter({ gold: start, level: 2 }))?.id).toBe(start >= 50 * reserve ? CLEAVE : undefined);
    const top = scoreGoals(config, nav, createWorld(config, 1), hunter({ gold: start }))[0]!;
    expect(top.goal.type).toBe('hunt');
  });

  it('AI picks learn in town with enough gold, and plans a path to the Academy door', () => {
    const ctx = makeCtx();
    const h = hunter({ gold: 50 * reserve, level: 2 });
    ctx.world.hunters.push(h);
    const top = scoreGoals(config, nav, ctx.world, h)[0]!;
    expect(top.goal).toEqual({ type: 'learn', kind: 'skill', id: CLEAVE });
    expect(top.score).toBeCloseTo(1.15);
    expect(setGoal(ctx, h, top.goal, 'test')).toBe(true);
    const door = config.plots.find((p) => p.startBuilding === config.index.academy)!.doorNode;
    expect(h.ai.path.at(-1)).toBe(door);
    const ev = ctx.events.drain().find((e) => e.type === 'goalChanged');
    expect(ev).toMatchObject({ goal: `learn:skill:${CLEAVE}` });
  });

  it('trait learn scores 1.2', () => {
    const h = hunter({ gold: 0, traitPoints: 1 });
    const c = scoreGoals(config, nav, createWorld(config, 1), h).find((x) => x.goal.type === 'learn')!;
    expect(c.goal).toEqual({ type: 'learn', kind: 'trait', id: 'trait.atk' });
    expect(c.score).toBeCloseTo(1.2);
  });
});

describe('AI: zone fit under difficulty', () => {
  it('a fresh hunter is weaker against every zone under Normal than under Easy', () => {
    const h = hunter({ gold: 0 });
    const world = (difficulty: string) => {
      const w = createWorld(config, 1);
      w.town.difficulty = difficulty;
      return w;
    };
    const easy = world('diff.easy'), normal = world('diff.normal');
    for (const z of config.zones) expect(powerRatio(config, normal, h, z)).toBeLessThan(powerRatio(config, easy, h, z));
    // Easy: the meadow is huntable. Normal: the hardest zone a fresh hunter may enter is no harder than on Easy.
    const huntable = (w: ReturnType<typeof world>) => scoreGoals(config, nav, w, h).filter((c) => c.goal.type === 'hunt').map((c) => (c.goal as { zoneId: string }).zoneId);
    expect(huntable(easy)).toContain('zone.meadow');
    const idx = (ids: string[]) => Math.max(-1, ...ids.map((id) => config.zones.findIndex((z) => z.id === id)));
    expect(idx(huntable(normal))).toBeLessThanOrEqual(idx(huntable(easy)));
  });
});

describe('Academy integration', () => {
  it('hunters walk to the Academy, learn, and keep hunting', () => {
    const systems = [...DEFAULT_SYSTEMS];
    if (!systems.includes(academySystem)) systems.splice(systems.findIndex((s) => s.name === 'economy') + 1, 0, academySystem);
    const s = new Simulation(config, createWorld(config, 3), systems);
    for (let i = 0; i < 4; i++) s.enqueue({ type: 'debug.spawnHunter' });
    let learnedN = 0;
    for (let t = 0; t < 10 * 600; t++) {
      s.step();
      learnedN += s.drainEvents().filter((e) => e.type === 'learned').length;
    }
    expect(learnedN).toBeGreaterThan(0);
    expect(s.world.stats.learned).toBe(learnedN);
    expect(s.world.stats.kills).toBeGreaterThan(20);
    // Loose on purpose: in a free run whether a hunter studies within 10 min depends on the economy, not the Academy.
    // Measured (seeds 1–8, 10 min, 8 hunters incl. arrivals): 3–6 of 8 studied. Hunters hunt first (a level-1 hunter
    // keeps its starting gold back); a hunter that reaches cost × reserve in Town often picks a service/shop goal first
    // and drops below the reserve again, and arrivals at 6–8 min have no time. A per-seed count would break on every
    // AI/economy tuning change, so the strict check is the controlled run below.
    const studied = s.world.hunters.filter((h) => Object.keys(h.skills).length > 0).length;
    expect(studied).toBeGreaterThanOrEqual(Math.ceil(s.world.hunters.length / 2));
  });

  it.each([1, 3, 7])('every hunter that can afford a skill in Town (needs full, nothing else to buy) studies it within a minute (seed %i)', (seed) => {
    const s = new Simulation(config, createWorld(config, seed));
    for (let i = 0; i < 4; i++) s.enqueue({ type: 'debug.spawnHunter' });
    s.step();
    const team = [...s.world.hunters];
    expect(team).toHaveLength(4);
    for (const h of team) {
      h.level = 2; // past the level-1 "keep the starting gold" rule
      // Neutral personality: reckless (goal.hunt ×1.15) ties learnSkillScore 1.15 once the meadow fit is 1, which is
      // the intended hunting bias (TODO §2), not an Academy bug.
      h.personalities = ['pers.plain'];
      h.gold = 5_000;
      h.ai = newAiState(); // the spawn tick already picked a hunt goal; decide again with the new purse
      expect(bestLearn(config, h)?.kind).toBe('skill');
    }
    for (let t = 0; t < 600; t++) s.step();
    for (const h of team) expect(Object.keys(h.skills).length, h.id).toBeGreaterThan(0);
  });
});
