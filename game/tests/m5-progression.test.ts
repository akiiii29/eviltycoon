import { bestLearn, enhanceSavingsHold, scoreGoals } from '../src/core/ai/utility';
import { applyCommand, type Command } from '../src/core/commands';
import { loadConfig, validateConfig } from '../src/core/config/load';
import { EventBuffer, type SimEvent } from '../src/core/events';
import { expToNext, hunterStats, moveSpeed, zonePower } from '../src/core/formulas';
import { rollHunter } from '../src/core/hunterFactory';
import { NavGraph } from '../src/core/pathfinding';
import { gainExp } from '../src/core/progress';
import { expRequired, jobChildren, jobOf, relicValue } from '../src/core/progressionStats';
import { Rng } from '../src/core/rng';
import { deserialize, SAVE_FORMAT, serialize } from '../src/core/save/save';
import { createWorld, Simulation } from '../src/core/simulation';
import type { SystemContext } from '../src/core/system';
import { academySystem, nextGrowth } from '../src/core/systems/academy';
import { autoCompose, compose } from '../src/core/systems/compose';
import { bestMount, mountsSystem } from '../src/core/systems/mounts';
import { autoPickJob, chooseJob, nextJob, progressionSystem, reincarnate } from '../src/core/systems/progression';
import { autoRelic, relicUpgradeBlocker, upgradeRelic } from '../src/core/systems/relics';
import { dropRune, runeStash, runesSystem, stashRune } from '../src/core/systems/runes';
import { baseMaterialNeed } from '../src/core/systems/trading';
import { newAiState, WORLD_SCHEMA_VERSION, type Hunter, type Monster } from '../src/core/world';
import { readRawConfig, testConfig } from './helpers';

const config = testConfig();
const nav = new NavGraph(config);
const CLASSES = config.classes.map((c) => c.id);

function makeCtx(seed = 1): SystemContext & { events: EventBuffer } {
  return {
    world: createWorld(config, seed), config, nav, rng: new Rng(seed),
    events: new EventBuffer(), debug: { aiScores: new Map() }, dtMs: 100,
  };
}

/** A vanguard in town with no personalities, skills or traits, and the given patch. */
function hunter(patch: Partial<Hunter> = {}): Hunter {
  const h = rollHunter(config, new Rng(7), 'h0', config.index.squareNode, { x: 0, y: 0 }, 0);
  Object.assign(h, { classId: 'class.vanguard', jobTier: 0, level: 1, skills: {}, traits: {}, traitPoints: 0, personalities: [] });
  h.nodeId = config.index.squareNode;
  Object.assign(h, patch);
  return h;
}

function cmd(ctx: SystemContext & { events: EventBuffer }, c: Command): string | null {
  ctx.events.drain();
  applyCommand(ctx, c);
  const rej = ctx.events.drain().find((e: SimEvent) => e.type === 'commandRejected') as Extract<SimEvent, { type: 'commandRejected' }> | undefined;
  return rej ? rej.reason : null;
}

function rawClone(): Record<string, any> {
  return JSON.parse(JSON.stringify(readRawConfig()));
}

describe('M5 config tables (TECH_SPEC §8)', () => {
  it('every class has a 9-job tree: tiers 0–2 single, tier 3 three branches, tier 4 one mastery per branch', () => {
    for (const c of CLASSES) {
      const jobs = config.index.jobsByClass.get(c)!;
      expect(jobs).toHaveLength(9);
      expect([0, 1, 2, 3, 4].map((t) => jobs.filter((j) => j.tier === t).length)).toEqual([1, 1, 1, 3, 3]);
      const t2 = jobs.find((j) => j.tier === 2)!;
      const branches = jobChildren(config, t2);
      expect(branches.map((j) => j.branch)).toEqual(['a', 'b', 'c']);
      for (const b of branches) {
        const kids = jobChildren(config, b);
        expect(kids).toHaveLength(1);
        expect(kids[0]!.unlockReincarnation).toBe(1);
      }
    }
  });

  it('exp_curve column 0 is exactly the M3 formula; later columns are never cheaper', () => {
    const f = config.formula;
    expect(config.expCurve).toHaveLength(f.maxLevel - 1);
    for (const r of config.expCurve) {
      expect(r.exp[0]).toBe(expToNext(r.level, f));
      for (let i = 1; i < r.exp.length; i++) expect(r.exp[i]!).toBeGreaterThanOrEqual(r.exp[i - 1]!);
    }
    expect(expRequired(config, 10, 0)).toBe(expToNext(10, f));
    expect(expRequired(config, 10, 99)).toBe(config.expCurve[9]!.exp[f.maxReincarnation]);
    expect(expRequired(config, 500, 0)).toBe(expToNext(500, f)); // no row → formula
  });

  it('rejects broken trees, curves, rune arrays and compositions', () => {
    const issues = (mut: (raw: Record<string, any>) => void) => {
      const raw = rawClone();
      mut(raw);
      return validateConfig(raw as never).map((i) => `${i.path}: ${i.message}`).join('\n');
    };
    expect(issues(() => {})).toBe('');
    expect(issues((r) => { r.job.find((j: any) => j.id === 'job.vanguard.3b').branch = 'a'; })).toMatch(/distinct branch/);
    expect(issues((r) => { delete r.job.find((j: any) => j.id === 'job.vanguard.4a').parentId; })).toMatch(/4a\.parentId/);
    expect(issues((r) => { r.job.find((j: any) => j.id === 'job.vanguard.4a').parentId = 'job.warden.3a'; })).toMatch(/same class/);
    expect(issues((r) => { r.exp_curve.pop(); })).toMatch(/exp_curve/);
    expect(issues((r) => { r.exp_curve[3].exp = [1]; })).toMatch(/exp_curve\[3\]\.exp/);
    expect(issues((r) => { r.rune[0].dropChance = [0.1]; })).toMatch(/rune\[0\]\.dropChance/);
    expect(issues((r) => { r.material.find((m: any) => m.id === 'mat.star').composeTo = { materialId: 'mat.gel', count: 2 }; })).toMatch(/cycle/);
    expect(issues((r) => { r.material.find((m: any) => m.id === 'mat.star').composeTo = { materialId: 'mat.ess.normal', count: 2 }; })).toMatch(/essences/);
  });
});

describe('job tree (TECH_SPEC §4.1)', () => {
  it('jobOf falls back to the first job of the tier; branch bias and flat crit/eva reach hunterStats', () => {
    const h = hunter({ jobTier: 3 });
    expect(jobOf(config, h)!.id).toBe('job.vanguard.3a');
    const a = hunterStats(config, h, { steady: true });
    const b = hunterStats(config, { ...h, jobId: 'job.vanguard.3b' }, { steady: true });
    const c = hunterStats(config, { ...h, jobId: 'job.vanguard.3c' }, { steady: true });
    expect(a.hp).toBeGreaterThan(b.hp);
    expect(b.atk).toBeGreaterThan(a.atk);
    expect(c.crit - a.crit).toBe(4);
    expect(c.eva - a.eva).toBe(4);
    // A stale jobId (wrong tier) is ignored.
    expect(jobOf(config, { ...h, jobTier: 2, jobId: 'job.vanguard.3b' })!.id).toBe('job.vanguard.2');
  });

  it('branches are rebalanced: AI power (zonePower) of the three branches within ±5 % of the unbiased job', () => {
    for (const c of CLASSES) {
      for (const tier of [3, 4]) {
        const jobs = config.index.jobsByClass.get(c)!.filter((j) => j.tier === tier);
        const h = hunter({ classId: c, level: 85, jobTier: tier, reincarnation: 1, stats: { hp: 600 + 84 * 20, atk: 10 + 84, def: 10 + 84, eva: 3, crit: 3, atkSpeed: 1 } });
        const zone = config.index.zones.get('zone.citadel')!;
        const plain = { ...config, index: { ...config.index, jobs: new Map(config.jobs.map((j) => [j.id, { ...j, statBias: undefined, crit: undefined, eva: undefined }])) } };
        const ref = zonePower(plain, { ...h, jobId: jobs[0]!.id }, zone, 'diff.easy');
        for (const j of jobs) {
          const p = zonePower(config, { ...h, jobId: j.id }, zone, 'diff.easy');
          expect(p / ref, `${j.id}`).toBeGreaterThan(0.95);
          expect(p / ref, `${j.id}`).toBeLessThan(1.05);
        }
      }
    }
  });

  it('the AI picks a branch deterministically from stat grades and personality', () => {
    const t3 = jobChildren(config, config.index.jobs.get('job.vanguard.2')!);
    const tank = hunter({ statGrades: { hp: 'highest', atk: 'normal', def: 'highest', eva: 'normal', crit: 'normal' } });
    const brute = hunter({ statGrades: { hp: 'normal', atk: 'highest', def: 'normal', eva: 'normal', crit: 'normal' } });
    const agile = hunter({ statGrades: { hp: 'normal', atk: 'normal', def: 'normal', eva: 'highest', crit: 'highest' } });
    expect(autoPickJob(config, tank, t3)!.branch).toBe('a');
    expect(autoPickJob(config, brute, t3)!.branch).toBe('b');
    expect(autoPickJob(config, agile, t3)!.branch).toBe('c');
    const reckless = hunter({ statGrades: { hp: 'normal', atk: 'normal', def: 'normal', eva: 'normal', crit: 'normal' }, personalities: ['pers.reckless'] });
    expect(autoPickJob(config, reckless, t3)!.branch).toBe('b');
    expect(autoPickJob(config, tank, t3)).toBe(autoPickJob(config, tank, t3));
  });

  it('advances through the tree by level and reincarnation; the player branch wins; reincarnation resets the job only', () => {
    const ctx = makeCtx();
    const h = hunter({ level: 69, jobTier: 2, jobId: 'job.vanguard.2', jobBranch: 'c' });
    ctx.world.hunters.push(h);
    ctx.world.town.autoReincarnate = false;
    progressionSystem.update(ctx);
    expect(h.jobTier).toBe(2);
    h.level = 70;
    progressionSystem.update(ctx);
    expect(h.jobId).toBe('job.vanguard.3c');
    h.level = 100;
    progressionSystem.update(ctx);
    expect(h.jobTier).toBe(3); // tier 4 needs a reincarnation
    expect(reincarnate(ctx, h)).toBeNull();
    expect(h.jobTier).toBe(0);
    expect(h.jobId).toBeUndefined();
    expect(h.jobBranch).toBe('c');
    for (const lv of [20, 50, 70, 80]) { h.level = lv; progressionSystem.update(ctx); }
    expect(h.jobId).toBe('job.vanguard.4c');
    expect(nextJob(config, h)).toBeUndefined();
  });

  it('hunter.chooseJob: plans the branch, changes now when unlocked, rejects another branch until reincarnation', () => {
    const ctx = makeCtx();
    const h = hunter({ level: 60, jobTier: 2 });
    ctx.world.hunters.push(h);
    expect(cmd(ctx, { type: 'hunter.chooseJob', hunterId: h.id, jobId: 'job.warden.3a' })).toMatch(/unknown job/);
    expect(cmd(ctx, { type: 'hunter.chooseJob', hunterId: h.id, jobId: 'job.vanguard.1' })).toMatch(/no branch/);
    expect(cmd(ctx, { type: 'hunter.chooseJob', hunterId: h.id, jobId: 'job.vanguard.4b' })).toBeNull();
    expect(h.jobBranch).toBe('b');
    expect(h.jobTier).toBe(2); // level 60 < 70: plan only
    h.level = 75;
    expect(chooseJob(ctx, h, 'job.vanguard.3a')).toBeNull(); // still unbranched: re-plan and change now
    expect(h.jobId).toBe('job.vanguard.3a');
    expect(cmd(ctx, { type: 'hunter.chooseJob', hunterId: h.id, jobId: 'job.vanguard.3b' })).toMatch(/another branch/);
    expect(cmd(ctx, { type: 'hunter.chooseJob', hunterId: 'nobody', jobId: 'job.vanguard.3b' })).toBe('unknown hunter');
  });
});

describe('hunter.learn: player study plans', () => {
  const CLEAVE = 'skill.vanguard.cleave'; // studyGold [50, ...]
  it('validates, stores the plan and sends a hunter in Town that can pay now', () => {
    const ctx = makeCtx();
    const h = hunter({ level: 5, gold: 1000 });
    ctx.world.hunters.push(h);
    expect(cmd(ctx, { type: 'hunter.learn', hunterId: h.id, kind: 'skill', id: 'skill.warden.bash' })).toMatch(/another class/);
    expect(cmd(ctx, { type: 'hunter.learn', hunterId: h.id, kind: 'skill', id: 'nope' })).toMatch(/unknown skill/);
    expect(cmd(ctx, { type: 'hunter.learn', hunterId: h.id, kind: 'growth', id: 'nope' })).toMatch(/unknown growth/);
    expect(cmd(ctx, { type: 'hunter.learn', hunterId: h.id, kind: 'oops' as never, id: CLEAVE })).toMatch(/kind/);
    const maxed = config.index.skills.get(CLEAVE)!.maxLevel;
    h.skills[CLEAVE] = maxed;
    expect(cmd(ctx, { type: 'hunter.learn', hunterId: h.id, kind: 'skill', id: CLEAVE })).toMatch(/max level/);
    h.skills = {};
    expect(cmd(ctx, { type: 'hunter.learn', hunterId: h.id, kind: 'skill', id: CLEAVE })).toBeNull();
    expect(h.learnPlan).toEqual({ kind: 'skill', id: CLEAVE });
    expect(h.ai.goal).toEqual({ type: 'learn', kind: 'skill', id: CLEAVE });
    expect(h.ai.forced).toBe(true);
    h.ai.phase = 'act';
    academySystem.update(ctx);
    expect(h.skills[CLEAVE]).toBe(1);
    expect(h.learnPlan).toBeUndefined();
    expect(cmd(ctx, { type: 'hunter.cancelLearn', hunterId: h.id })).toMatch(/no study plan/);
  });

  it('a pending gold plan blocks other gold studies; traits still auto-learn; it fires once affordable', () => {
    const h = hunter({ level: 30, jobTier: 1, gold: 300, traitPoints: 1, skills: { [CLEAVE]: 2 } });
    expect(bestLearn(config, h)).toMatchObject({ kind: 'skill', id: 'skill.vanguard.rage' }); // nothing planned: cheapest skill
    h.learnPlan = { kind: 'skill', id: CLEAVE }; // level 3 costs 400
    expect(bestLearn(config, h)?.kind).toBe('trait'); // gold saved for the plan, trait points free
    h.traitPoints = 0;
    expect(bestLearn(config, h)).toBeNull();
    h.gold = 400;
    expect(bestLearn(config, h)).toEqual({ kind: 'skill', id: CLEAVE, cost: 400 });
    h.learnPlan = { kind: 'trait', id: config.traits[0]!.id };
    h.traitPoints = 0;
    expect(bestLearn(config, h)?.kind).toBe('skill'); // trait plan: gold studies go on
  });

  it('a plan that can never happen is dropped by progression; cancelLearn clears it', () => {
    const ctx = makeCtx();
    const h = hunter({ level: 5 });
    ctx.world.hunters.push(h);
    h.learnPlan = { kind: 'skill', id: 'skill.removed' };
    progressionSystem.update(ctx);
    expect(h.learnPlan).toBeUndefined();
    h.learnPlan = { kind: 'skill', id: CLEAVE };
    expect(cmd(ctx, { type: 'hunter.cancelLearn', hunterId: h.id })).toBeNull();
    expect(h.learnPlan).toBeUndefined();
  });
});

describe('growth properties', () => {
  it('cost a hunter gold at the Academy and add flat base stats before the job multiplier', () => {
    const ctx = makeCtx();
    const h = hunter({ level: 10, gold: 5000 });
    ctx.world.hunters.push(h);
    const before = hunterStats(config, h, { steady: true });
    h.ai.goal = { type: 'learn', kind: 'growth', id: 'growth.atk' };
    h.ai.phase = 'act';
    const cost = nextGrowth(config, h, 'growth.atk', ctx.world)!.cost;
    academySystem.update(ctx);
    expect(h.growth).toEqual({ 'growth.atk': 1 });
    expect(h.gold).toBe(5000 - cost);
    expect(ctx.world.stats.growthBought).toBe(1);
    const after = hunterStats(config, h, { steady: true });
    expect(after.atk - before.atk).toBeCloseTo(config.index.growthProperties.get('growth.atk')!.valuePerLevel * (1 + 0), 6);
    expect(after.hp).toBe(before.hp);
  });

  it('the AI only buys one with gold well beyond the cost (growthReserveMul) and after skills/traits', () => {
    const h = hunter({ level: 2, skills: {}, gold: 0 });
    for (const s of config.skills.filter((x) => x.classId === h.classId)) h.skills[s.id] = s.maxLevel;
    const cheapest = Math.min(...config.growthProperties.map((g) => g.cost[0]!));
    h.gold = cheapest * config.formula.growthReserveMul;
    expect(bestLearn(config, h)).toBeNull(); // the gear savings come first
    h.gold += enhanceSavingsHold(config, h) - 1;
    expect(bestLearn(config, h)).toBeNull();
    h.gold += 1;
    expect(bestLearn(config, h)?.kind).toBe('growth');
  });
});

describe('exp_curve and the Relic of Wisdom', () => {
  it('a reincarnated hunter needs its column of EXP; the relic adds its percent', () => {
    const ctx = makeCtx();
    const h = hunter({ level: 10, exp: 0, reincarnation: 2 });
    const need = expRequired(config, 10, 2);
    gainExp(ctx, h, need - 1);
    expect(h.level).toBe(10);
    gainExp(ctx, h, 1);
    expect(h.level).toBe(11);
    ctx.world.town.relics = { 'relic.wisdom': 1 };
    const pct = config.index.relics.get('relic.wisdom')!.value[0]!;
    h.exp = 0;
    gainExp(ctx, h, 100);
    expect(h.exp).toBeCloseTo(100 * (1 + pct / 100), 9);
  });
});

describe('material composition', () => {
  it('town.compose turns N storage units into one of the next material; rejects bad input', () => {
    const ctx = makeCtx();
    ctx.world.town.storage = { 'mat.gel': 7 };
    expect(cmd(ctx, { type: 'town.compose', materialId: 'mat.gel', count: 2 })).toBeNull();
    expect(ctx.world.town.storage).toEqual({ 'mat.gel': 1, 'mat.hide': 2 });
    expect(cmd(ctx, { type: 'town.compose', materialId: 'mat.gel', count: 1 })).toMatch(/not enough/);
    expect(cmd(ctx, { type: 'town.compose', materialId: 'mat.star', count: 1 })).toMatch(/does not compose/);
    expect(cmd(ctx, { type: 'town.compose', materialId: 'mat.gel', count: 0 })).toMatch(/invalid count/);
    expect(cmd(ctx, { type: 'town.compose', materialId: 'mat.ess.hard', count: 1 })).toMatch(/does not compose/);
    expect(ctx.world.stats.materialsComposed).toBe(2);
  });

  it('auto-composition fills a short automatic request from surplus only', () => {
    const ctx = makeCtx();
    const h = hunter({ level: 3, gold: 100000 });
    ctx.world.hunters.push(h);
    // Something the auto-requests want and that a cheaper material composes into.
    const need = baseMaterialNeed(config, ctx.world);
    const target = Object.keys(need).find((id) => config.materials.some((m) => m.composeTo?.materialId === id))!;
    expect(target).toBeDefined();
    const src = config.materials.find((m) => m.composeTo?.materialId === target)!;
    const protectedUnits = need[src.id] ?? 0;
    ctx.world.town.storage = { [src.id]: protectedUnits + src.composeTo!.count * 2 + 1 };
    const made = autoCompose(ctx);
    expect(made).toBe(Math.min(2, need[target]!));
    expect(ctx.world.town.storage[src.id]).toBe(protectedUnits + src.composeTo!.count * (2 - made) + 1);
    expect(compose(ctx, src.id, 999)).toMatch(/not enough/);
  });
});

describe('runes', () => {
  const monster = (defId: string): Monster => ({ id: 'm1', defId, zoneId: 'z', hp: 0, position: { x: 0, y: 0 }, home: { x: 0, y: 0 }, targetHunterId: null, attackCdMs: 0, difficultyId: 'diff.easy' });
  const low = config.monsters.find((m) => m.level < 10)!;
  const high = config.monsters.find((m) => m.level >= 10)!;

  it('drop with one draw per kill (none below minMonsterLevel) into the stash, best first, capped', () => {
    const ctx = makeCtx();
    const h = hunter();
    let draws = 0;
    let next = 0;
    ctx.rng = { next: () => { draws++; return next; } } as unknown as Rng;
    dropRune(ctx, h, monster(low.id));
    expect(draws).toBe(0);
    dropRune(ctx, h, monster(high.id));
    expect(draws).toBe(1);
    expect(runeStash(ctx.world)).toEqual([{ runeId: config.runes[0]!.id, grade: 1 }]);
    next = 0.99;
    dropRune(ctx, h, monster(high.id));
    expect(runeStash(ctx.world)).toHaveLength(1);
    stashRune(ctx, { runeId: 'rune.edge', grade: 3 });
    expect(runeStash(ctx.world)[0]).toEqual({ runeId: 'rune.edge', grade: 3 });
    for (let i = 0; i < config.formula.runeStashMax + 5; i++) stashRune(ctx, { runeId: 'rune.veil', grade: 1 });
    expect(runeStash(ctx.world)).toHaveLength(config.formula.runeStashMax);
    expect(ctx.world.stats.runesDiscarded).toBe(7); // 2 + 35 runes, 30 kept
    expect(ctx.world.stats.runesDropped).toBe(1);
  });

  it('the Relic of Fortune raises the drop chance', () => {
    const ctx = makeCtx();
    const h = hunter();
    const total = config.runes.reduce((s, r) => s + r.dropChance.reduce((a, b) => a + b, 0), 0);
    ctx.rng = { next: () => total * 1.1 } as unknown as Rng;
    dropRune(ctx, h, monster(high.id));
    expect(runeStash(ctx.world)).toHaveLength(0);
    ctx.world.town.relics = { 'relic.fortune': 1 }; // +20 %
    expect(relicValue(config, ctx.world, 'runeDropPct')).toBe(20);
    dropRune(ctx, h, monster(high.id));
    expect(runeStash(ctx.world)).toHaveLength(1);
  });

  it('auto-socket in Town (better grade swaps), commands, and the stat effect', () => {
    const ctx = makeCtx();
    const h = hunter({ level: 10 });
    ctx.world.hunters.push(h);
    const base = hunterStats(config, h, { steady: true });
    ctx.world.town.runes = [{ runeId: 'rune.might', grade: 3 }, { runeId: 'rune.vigor', grade: 1 }, { runeId: 'rune.edge', grade: 1 }];
    runesSystem.update(ctx);
    expect(h.runes).toEqual([{ runeId: 'rune.might', grade: 3 }, { runeId: 'rune.vigor', grade: 1 }]);
    const s = hunterStats(config, h, { steady: true });
    expect(s.atk / base.atk).toBeCloseTo(1 + 3 / 100, 9);
    expect(s.hp / base.hp).toBeCloseTo(1 + 1 / 100, 9);
    stashRune(ctx, { runeId: 'rune.ward', grade: 2 });
    runesSystem.update(ctx);
    expect(h.runes![1]).toEqual({ runeId: 'rune.ward', grade: 2 });
    expect(runeStash(ctx.world).map((r) => r.runeId)).toEqual(['rune.vigor', 'rune.edge']);
    // A hunter in the field is not touched.
    h.nodeId = config.index.zoneNodes.get('zone.meadow')![0]!;
    h.runes = [null, null];
    runesSystem.update(ctx);
    expect(h.runes).toEqual([null, null]);
    expect(cmd(ctx, { type: 'hunter.socketRune', hunterId: h.id, slot: 0, stashIndex: 1 })).toBeNull();
    expect(h.runes![0]).toEqual({ runeId: 'rune.edge', grade: 1 });
    expect(cmd(ctx, { type: 'hunter.socketRune', hunterId: h.id, slot: 5, stashIndex: 0 })).toMatch(/socket/);
    expect(cmd(ctx, { type: 'hunter.socketRune', hunterId: h.id, slot: 0, stashIndex: 9 })).toMatch(/stash/);
    expect(cmd(ctx, { type: 'hunter.unsocketRune', hunterId: h.id, slot: 1 })).toMatch(/empty/);
    expect(cmd(ctx, { type: 'hunter.unsocketRune', hunterId: h.id, slot: 0 })).toBeNull();
    expect(h.runes![0]).toBeNull();
    expect(cmd(ctx, { type: 'town.setAutoRune', on: false })).toBeNull();
    h.nodeId = config.index.squareNode;
    runesSystem.update(ctx);
    expect(h.runes).toEqual([null, null]);
  });

  it('runes stay through reincarnation', () => {
    const ctx = makeCtx();
    const h = hunter({ level: config.formula.maxLevel, runes: [{ runeId: 'rune.might', grade: 2 }, null] });
    expect(reincarnate(ctx, h)).toBeNull();
    expect(h.runes![0]).toEqual({ runeId: 'rune.might', grade: 2 });
  });
});

describe('relics', () => {
  it('cost Town gold and storage materials per level; blockers; auto off by default', () => {
    const ctx = makeCtx();
    const r = config.index.relics.get('relic.patron')!;
    const c0 = r.upgradeCost[0]!;
    ctx.world.town.gold = c0.gold - 1;
    expect(relicUpgradeBlocker(config, ctx.world, r.id)).toMatch(/gold/);
    ctx.world.town.gold = c0.gold + 10;
    expect(cmd(ctx, { type: 'town.upgradeRelic', relicId: r.id })).toMatch(/materials/);
    for (const m of c0.materials) ctx.world.town.storage[m.materialId] = m.count;
    expect(cmd(ctx, { type: 'town.upgradeRelic', relicId: r.id })).toBeNull();
    expect(ctx.world.town.gold).toBe(10);
    expect(ctx.world.town.relics![r.id]).toBe(1);
    for (const m of c0.materials) expect(ctx.world.town.storage[m.materialId]).toBeUndefined();
    expect(cmd(ctx, { type: 'town.upgradeRelic', relicId: 'nope' })).toMatch(/unknown/);
    ctx.world.town.relics![r.id] = r.maxLevel;
    expect(relicUpgradeBlocker(config, ctx.world, r.id)).toMatch(/max level/);
    // Patronage discounts growth properties.
    const h = hunter();
    const full = config.index.growthProperties.get('growth.hp')!.cost[0]!;
    expect(nextGrowth(config, h, 'growth.hp', ctx.world)!.cost).toBe(Math.round(full * (1 - r.value[r.maxLevel - 1]! / 100)));
    expect(createWorld(config, 1).town.autoRelic).toBe(false);
  });

  it('autoRelic buys the cheapest level only with gold far above the treasury target', () => {
    const ctx = makeCtx();
    for (const r of config.relics) for (const m of r.upgradeCost[0]!.materials) ctx.world.town.storage[m.materialId] = 100;
    ctx.world.town.gold = 100;
    expect(autoRelic(ctx)).toBe(false);
    ctx.world.town.gold = 1e7;
    expect(autoRelic(ctx)).toBe(true);
    expect(Object.values(ctx.world.town.relics!)).toEqual([1]);
    expect(upgradeRelic(ctx, 'relic.fortune')).toBeNull();
  });
});

describe('mounts', () => {
  it('the AI buys the fastest affordable mount at the Shop with gold beyond the reserve; move speed rises; kept on reincarnation', () => {
    const ctx = makeCtx();
    const pony = config.index.mounts.get('mount.pony')!;
    const h = hunter({ level: pony.minLevel - 1, gold: 0 });
    ctx.world.hunters.push(h);
    h.gold = pony.price * config.formula.mountReserveMul + enhanceSavingsHold(config, { ...h, level: pony.minLevel }, ctx.world);
    expect(bestMount(config, h, ctx.world)).toBeNull(); // level
    h.level = pony.minLevel;
    expect(bestMount(config, h, ctx.world)?.id).toBe(pony.id);
    h.gold -= 1;
    expect(bestMount(config, h, ctx.world)).toBeNull(); // reserve
    h.gold += 1;
    const goals = scoreGoals(config, nav, ctx.world, h).map((c) => c.label);
    expect(goals).toContain(`buyMount ${pony.id}`);
    const speed = moveSpeed(config, h);
    const gold0 = h.gold, town0 = ctx.world.town.gold;
    h.ai.goal = { type: 'buyMount', mountId: pony.id };
    h.ai.phase = 'act';
    mountsSystem.update(ctx);
    expect(h.mount).toBe(pony.id);
    expect(h.ai.goal).toBeNull();
    expect(h.gold).toBe(gold0 - pony.price);
    expect(ctx.world.town.gold - town0).toBeLessThan(pony.price); // only the fee cut reaches the Town (gold sink)
    expect(moveSpeed(config, h)).toBeCloseTo(speed * pony.moveSpeedMul, 9);
    expect(bestMount(config, h, ctx.world)).toBeNull(); // not faster
    expect(cmd(ctx, { type: 'hunter.buyMount', hunterId: h.id, mountId: pony.id })).toMatch(/not faster/);
    expect(cmd(ctx, { type: 'hunter.buyMount', hunterId: h.id, mountId: 'mount.drake' })).toMatch(/level/);
    h.level = config.formula.maxLevel;
    expect(reincarnate(ctx, h)).toBeNull();
    expect(h.mount).toBe(pony.id);
  });

  it('hunter.buyMount sends the hunter to the Shop', () => {
    const ctx = makeCtx();
    const stag = config.index.mounts.get('mount.stag')!;
    const h = hunter({ level: stag.minLevel, gold: stag.price });
    ctx.world.hunters.push(h);
    expect(cmd(ctx, { type: 'hunter.buyMount', hunterId: h.id, mountId: stag.id })).toBeNull();
    expect(h.ai.goal).toEqual({ type: 'buyMount', mountId: stag.id });
    expect(h.ai.forced).toBe(true);
  });
});

describe('save v15 → v16', () => {
  it('a v12 save gets explicit job ids (journey and portal hunters too) and the M5 town fields; idempotent', () => {
    const sim = new Simulation(config, createWorld(config, 3));
    for (let i = 0; i < 3; i++) sim.enqueue({ type: 'debug.spawnHunter' });
    for (let t = 0; t < 50; t++) sim.step();
    const w = JSON.parse(serialize(sim.world, 0)).world;
    w.hunters[0].jobTier = 2;
    const away = { ...w.hunters[1] };
    w.hunters = [w.hunters[0], w.hunters[2]];
    w.journeys = [{ id: 'j1', journeyId: config.journeys[0]!.id, difficultyId: 'diff.easy', hunters: [away], teamPower: 1, successChance: 0.5, durationMs: 1000, remainingMs: 1000, startedAtMs: 0, cost: 0 }];
    const inPortal = { ...w.hunters[1], id: 'hp' };
    w.portal = [{ hunter: inPortal, durationMs: 1, remainingMs: 1, enteredAtMs: 0 }];
    for (const h of [...w.hunters, away, inPortal]) delete h.jobId;
    for (const k of ['runes', 'relics', 'autoRune', 'autoRelic']) delete w.town[k];
    delete w.stats.runesDropped;
    w.schemaVersion = 12;
    const r = deserialize(JSON.stringify({ format: SAVE_FORMAT, schemaVersion: 12, configVersion: config.version, savedAt: 0, world: w }), config);
    expect(WORLD_SCHEMA_VERSION).toBe(16);
    expect(r.migratedFrom).toBe(12);
    const m = r.world;
    expect(m.hunters[0]!.jobId).toBe(config.index.jobsByClass.get(m.hunters[0]!.classId)!.find((j) => j.tier === 2)!.id);
    expect(m.journeys[0]!.hunters[0]!.jobId).toMatch(/\.0$/);
    expect(m.portal[0]!.hunter.jobId).toMatch(/\.0$/);
    expect(m.town.runes).toEqual([]);
    expect(m.town.relics).toEqual({});
    expect(m.town.autoRune).toBe(true);
    expect(m.town.autoRelic).toBe(false);
    expect(m.stats.runesDropped).toBe(0);
    // Running on after the migration works, and re-loading a v16 save changes nothing.
    const s2 = new Simulation(config, m);
    for (let t = 0; t < 50; t++) s2.step();
    const again = deserialize(serialize(s2.world, 0), config).world;
    expect(again).toEqual(JSON.parse(serialize(s2.world, 0)).world);
  });
});

describe('integration', () => {
  it('a fast config reaches tier 3, buys runes/mounts/growth and keeps the stats cache consistent', () => {
    const raw = rawClone();
    raw.formula_params.maxLevel = 12;
    for (const r of raw.exp_curve) r.exp = r.exp.map(() => Math.round(4 * Math.pow(r.level, 1.15)));
    for (const j of raw.job) if (j.tier > 0) j.unlockLevel = [0, 3, 6, 9, 11][j.tier];
    for (const r of raw.rune) { r.minMonsterLevel = 1; r.dropChance = r.dropChance.map((c: number) => c * 200); }
    for (const m of raw.mount) { m.minLevel = 2; m.price = 50; }
    for (const g of raw.growth_property) g.cost = g.cost.map(() => 60);
    const cfg = loadConfig(raw as never);
    const sim = new Simulation(cfg, createWorld(cfg, 5));
    for (let i = 0; i < cfg.formula.hunterSlots; i++) sim.enqueue({ type: 'debug.spawnHunter' });
    const seen = new Set<string>();
    for (let t = 0; t < 60 * 600; t++) {
      sim.step();
      for (const e of sim.drainEvents()) {
        seen.add(e.type);
        if (e.type === 'learned') seen.add(`learned:${e.kind}`);
      }
    }
    expect(seen.has('runeDropped')).toBe(true);
    expect(seen.has('mountBought')).toBe(true);
    expect(seen.has('learned:growth')).toBe(true);
    const all = [...sim.world.hunters, ...sim.world.portal.map((p) => p.hunter)];
    expect(all.some((h) => h.jobTier >= 3 || h.reincarnation > 0)).toBe(true);
    for (const h of sim.world.hunters) expect(hunterStats(cfg, h)).toEqual(hunterStats(cfg, structuredClone(h)));
    expect(newAiState().goal).toBeNull();
  });
});
