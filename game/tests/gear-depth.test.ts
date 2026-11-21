/**
 * M5 gear depth (TECH_SPEC §4.2, §5.4, §5.8): 8 slots, grades + option lines rolled at craft, stat application and the
 * stats cache, gear sets, gear skills, economy hooks, AI valuation, the v12 → v13 migration.
 */
import { describe, expect, it } from 'vitest';
import { GEAR_SLOTS, type GameConfig, type GearSlot } from '../src/core/config/types';
import { EventBuffer } from '../src/core/events';
import { expectedGearExtra, gearMainValue, gearScore, hunterStats, monsterTypeStats, slotValue } from '../src/core/formulas';
import { gearBonus, hunterGearMods, needDrainMul, rollGearOptions } from '../src/core/gear';
import { rollHunter } from '../src/core/hunterFactory';
import { NavGraph } from '../src/core/pathfinding';
import { Rng } from '../src/core/rng';
import { deserialize, SAVE_FORMAT } from '../src/core/save/save';
import { createWorld, Simulation } from '../src/core/simulation';
import { cacheVerifyEnabled, setStatsCacheVerify } from '../src/core/statsCache';
import type { SystemContext } from '../src/core/system';
import { bestShopPurchase } from '../src/core/ai/utility';
import { combatSystem, damageMonster } from '../src/core/systems/combat';
import { craftingSystem, gearListPrice, listStoredGear, reclaimGear } from '../src/core/systems/crafting';
import { economySystem } from '../src/core/systems/economy';
import { needsSystem } from '../src/core/systems/needs';
import { skillsSystem } from '../src/core/systems/skills';
import { WORLD_SCHEMA_VERSION, type GearInstance, type Hunter, type Monster, type ShopItem } from '../src/core/world';
import { testConfig } from './helpers';

const base = testConfig();
const nav = new NavGraph(base);

function makeCtx(config: GameConfig = base, seed = 1): SystemContext & { events: EventBuffer } {
  return {
    world: createWorld(config, seed), config, nav, rng: new Rng(seed),
    events: new EventBuffer(), debug: { aiScores: new Map() }, dtMs: 100,
  };
}

function addHunter(ctx: SystemContext, patch: Partial<Hunter> = {}): Hunter {
  const h = rollHunter(ctx.config, new Rng(7), 'h' + ctx.world.hunters.length, base.index.squareNode, { x: 0, y: 0 }, 0);
  Object.assign(h, patch);
  ctx.world.hunters.push(h);
  return h;
}

function hunter(patch: Partial<Hunter> = {}): Hunter {
  const h = rollHunter(base, new Rng(7), 'hx', base.index.squareNode, { x: 0, y: 0 }, 0);
  return Object.assign(h, patch);
}

const item = (gearId: string, extra: Partial<GearInstance> = {}): GearInstance => ({ uid: 'u-' + gearId, gearId, qualityId: 'q.rare', enhance: 0, ...extra });
const opt = (id: string, value: number) => ({ id, value });
const gearOf = (slot: GearSlot, level: number) => base.gear.find((g) => g.slot === slot && g.level === level)!;

describe('8 gear slots', () => {
  it('every slot has recipes; weapon/armor at the Smithy, accessories at the Jeweler; main stat per slot', () => {
    expect(GEAR_SLOTS).toEqual(['weapon', 'head', 'body', 'gloves', 'shoes', 'necklace', 'ring', 'belt']);
    const stat: Record<GearSlot, string> = { weapon: 'atk', head: 'def', body: 'def', gloves: 'def', shoes: 'def', necklace: 'hp', ring: 'hp', belt: 'hp' };
    for (const slot of GEAR_SLOTS) {
      const rows = base.gear.filter((g) => g.slot === slot);
      expect(rows.length, slot).toBeGreaterThanOrEqual(11);
      for (const g of rows) {
        expect(g.mainStat, g.id).toBe(stat[slot]);
        expect(g.craftBuilding, g.id).toBe(['necklace', 'ring', 'belt'].includes(slot) ? 'bld.jeweler' : 'bld.smithy');
      }
    }
  });

  it('a tier of the armor / accessory group adds up to the old single piece (same total power per level)', () => {
    // Old 3-slot table: armor L1 4 DEF, L80 114 DEF; accessory L1 60 HP, L81 3300 HP.
    const sum = (slots: GearSlot[], level: number) => slots.reduce((s, slot) => s + gearOf(slot, level).mainValue, 0);
    expect(sum(['head', 'body', 'gloves', 'shoes'], 1)).toBeCloseTo(4, 6);
    expect(sum(['head', 'body', 'gloves', 'shoes'], 80)).toBeCloseTo(114, 6);
    expect(sum(['necklace', 'ring', 'belt'], 1)).toBeCloseTo(60, 6);
    expect(sum(['necklace', 'ring', 'belt'], 81)).toBeCloseTo(3300, 6);
    expect(gearOf('weapon', 80).mainValue).toBe(210);
  });
});

describe('grades and option lines rolled at craft', () => {
  it('is deterministic per seed and follows the grade table', () => {
    const a = new Rng(42), b = new Rng(42);
    for (let i = 0; i < 200; i++) expect(rollGearOptions(base, a, 'weapon')).toEqual(rollGearOptions(base, b, 'weapon'));
    const rng = new Rng(3);
    const n = 20_000;
    const count = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const slot = GEAR_SLOTS[i % GEAR_SLOTS.length]!;
      const r = rollGearOptions(base, rng, slot);
      const grade = base.index.gearGrades.get(r.gradeId ?? base.gearGrades[0]!.id)!;
      count.set(grade.id, (count.get(grade.id) ?? 0) + 1);
      if (!r.gradeId) { expect(r.options).toBeUndefined(); continue; }
      const lines = r.options ?? [];
      expect(lines.length).toBe(grade.options); // every pool is large enough (config check)
      expect(new Set(lines.map((l) => l.id)).size).toBe(lines.length); // no repeated option
      lines.forEach((l, k) => {
        const o = base.index.gearOptions.get(l.id)!;
        if (o.slots) expect(o.slots).toContain(slot);
        expect(o.kind === 'unique').toBe(k < grade.uniques);
        const mul = o.kind === 'negative' ? 1 : grade.valueMul;
        if (o.stat) {
          expect(l.value).toBeGreaterThanOrEqual(Math.round(o.min * mul * 10) / 10 - 1e-9);
          expect(l.value).toBeLessThanOrEqual(Math.round(o.max * mul * 10) / 10 + 1e-9);
        } else expect(l.value).toBe(0);
      });
    }
    for (const g of base.gearGrades) expect((count.get(g.id) ?? 0) / n, g.id).toBeCloseTo(g.chance, 1);
    expect(base.gearGrades[0]!.options).toBe(0);
  });

  it('a crafted shop item carries grade + options; price × grade priceMult; RNG order quality → grade → lines', () => {
    const ctx = makeCtx();
    const gear = base.index.gear.get('gear.w.club')!;
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      ctx.world.town.shop = [];
      ctx.world.town.crafting['bld.smithy'] = { gearId: gear.id, remainingMs: 0 };
      const probe = new Rng(ctx.rng.state);
      const q = probe.weighted(base.qualities, (x) => x.craftChance);
      const depth = rollGearOptions(base, probe, gear.slot);
      craftingSystem.update(ctx);
      const it = ctx.world.town.shop[0]!;
      expect(it.qualityId).toBe(q.id);
      expect(it.gradeId).toBe(depth.gradeId);
      expect(it.options).toEqual(depth.options);
      const gm = base.index.gearGrades.get(it.gradeId ?? base.gearGrades[0]!.id)!.priceMult;
      expect(it.listPrice).toBe(Math.round(gear.basePrice * q.priceMult * gm));
      seen.add(it.gradeId ?? 'none');
    }
    expect(seen.size).toBeGreaterThan(2);
  });
});

describe('stat application (gear category) and the stats cache', () => {
  it('% options and set bonuses multiply as their own category; crit/eva add flat; negatives allowed down to the floor', () => {
    const h = hunter({ level: 30 });
    h.equipment.weapon = item('gear.w.drake');
    const plain = { ...hunterStats(base, h, { steady: true }) };
    h.equipment.weapon = item('gear.w.drake', { gradeId: 'gr.a', options: [opt('opt.atk', 4), opt('opt.crit', 2)] });
    const s = hunterStats(base, h, { steady: true });
    expect(s.atk).toBeCloseTo(plain.atk * 1.04, 9);
    expect(s.crit).toBeCloseTo(plain.crit + 2, 9);
    expect(s.hp).toBeCloseTo(plain.hp, 9);
    h.equipment.weapon = item('gear.w.drake', { options: [opt('opt.n.atk', -3)] });
    expect(hunterStats(base, h, { steady: true }).atk).toBeCloseTo(plain.atk * 0.97, 9);
    h.equipment.weapon = item('gear.w.drake', { options: [opt('opt.n.atk', -500)] });
    expect(hunterStats(base, h, { steady: true }).atk).toBeCloseTo(plain.atk * (1 + base.formula.gearPctFloor / 100), 9);
    h.equipment.weapon = item('gear.w.drake', { options: [opt('opt.speed', 1e6)] });
    expect(hunterStats(base, h).atkSpeed).toBeGreaterThanOrEqual(base.formula.minAttackInterval);
  });

  it('recomputes when an option line changes in place (verify mode finds no stale hit)', () => {
    const was = cacheVerifyEnabled();
    setStatsCacheVerify(true);
    try {
      const h = hunter({ level: 10 });
      h.equipment.weapon = item('gear.w.iron', { gradeId: 'gr.b', options: [opt('opt.atk', 2)] });
      const fresh = () => hunterStats(base, structuredClone(h));
      const steps: (() => void)[] = [
        () => { h.equipment.weapon!.options![0]!.value = 3; },
        () => { h.equipment.weapon!.options![0]!.id = 'opt.hp'; },
        () => { h.equipment.weapon!.options!.push(opt('opt.crit', 1)); },
        () => { delete h.equipment.weapon!.options; },
        () => { h.equipment.ring = item('gear.ring.core', { options: [opt('opt.u.keen', 4)] }); },
      ];
      for (const step of steps) {
        hunterStats(base, h);
        slotValue(base, h, 'weapon');
        step();
        expect(hunterStats(base, h)).toEqual(fresh());
        expect(slotValue(base, h, 'weapon')).toBe(gearScore(base, h, h.equipment.weapon!, 'weapon'));
      }
    } finally {
      setStatsCacheVerify(was);
    }
  });
});

describe('gear sets', () => {
  const tide = (slot: GearSlot) => base.gear.find((g) => g.slot === slot && g.setId === 'set.tidewall')!;
  it('2/4/6-piece bonuses are cumulative and count slots holding a piece of the set', () => {
    const set = base.index.gearSets.get('set.tidewall')!;
    const h = hunter({ level: 70 });
    const slots: GearSlot[] = ['weapon', 'head', 'body', 'gloves', 'shoes', 'necklace'];
    const want = (n: number) => {
      const m: Record<string, number> = {};
      for (const b of set.bonuses) if (n >= b.pieces && b.stat) m[b.stat] = (m[b.stat] ?? 0) + b.value!;
      return m;
    };
    for (let n = 0; n <= slots.length; n++) {
      for (const s of GEAR_SLOTS) delete h.equipment[s];
      slots.slice(0, n).forEach((s) => { h.equipment[s] = item(tide(s).id); });
      const mods = hunterGearMods(base, h).mods;
      for (const [stat, v] of Object.entries(want(n))) expect(mods[stat as keyof typeof mods], `${n} pieces ${stat}`).toBe(v);
      if (n < 2) expect(Object.values(mods).every((v) => v === 0)).toBe(true);
    }
    expect(gearBonus(base, h, 'lifesteal')).toBe(1); // 6-piece bonus
  });

  it('the 6-piece Starless bonus grants its gear skill', () => {
    const h = hunter({ level: 81 });
    const star = (slot: GearSlot) => base.gear.find((g) => g.slot === slot && g.setId === 'set.starless')!;
    (['weapon', 'head', 'body', 'gloves', 'shoes'] as GearSlot[]).forEach((s) => { h.equipment[s] = item(star(s).id); });
    expect(hunterGearMods(base, h).skills.map((s) => s.id)).toEqual([]);
    h.equipment.belt = item(star('belt').id);
    expect(hunterGearMods(base, h).skills.map((s) => s.id)).toEqual(['gsk.starfall']);
  });
});

describe('gear skills and economy hooks', () => {
  function fight(config: GameConfig) {
    const ctx = makeCtx(config, 5);
    const h = addHunter(ctx, { level: 20 });
    const zone = base.zones[0]!;
    const nodeId = base.index.zoneNodes.get(zone.id)![0]!;
    const n = nav.node(nodeId);
    h.nodeId = nodeId;
    h.position = { x: n.x, y: n.y };
    const m: Monster = {
      id: 'm1', defId: zone.monsters[0]!.monsterId, zoneId: zone.id, hp: 1e9, position: { x: n.x, y: n.y }, home: { x: n.x, y: n.y },
      targetHunterId: null, attackCdMs: 1e9, difficultyId: 'diff.easy',
    };
    ctx.world.monsters = [m];
    h.ai = { goal: { type: 'hunt', zoneId: zone.id }, phase: 'act', path: [], decideInMs: 1e9, targetMonsterId: 'm1', moveTo: null, forced: false };
    return { ctx, h, m };
  }

  it('a gear skill procs on auto-attacks (sim RNG), casts its skill at its level, and respects its cooldown', () => {
    const config: GameConfig = {
      ...base,
      gearSkills: base.gearSkills.map((g) => (g.id === 'gsk.emberburst' ? { ...g, chance: 1, cooldownSec: 2 } : g)),
    };
    config.index = { ...base.index, gearSkills: new Map(config.gearSkills.map((g) => [g.id, g])) };
    const { ctx, h } = fight(config);
    h.equipment.weapon = item('gear.w.fang', { gradeId: 'gr.ss', options: [opt('opt.u.ember', 0)] });
    for (let t = 0; t < 100; t++) { combatSystem.update(ctx); skillsSystem.update(ctx); } // 10 s (skills tick the cooldown)
    const casts = ctx.events.drain().filter((e) => e.type === 'skillCast' && e.skillId === 'gsk.emberburst');
    // One proc per attack once off cooldown: at most one every 2 s, at least every 2 s + one attack interval.
    expect(casts.length).toBeGreaterThanOrEqual(3);
    expect(casts.length).toBeLessThanOrEqual(6);
    expect(ctx.world.stats.gearSkillProcs).toBe(casts.length);
    // Deterministic: the same fight gives the same procs.
    const again = fight(config);
    again.h.equipment.weapon = item('gear.w.fang', { gradeId: 'gr.ss', options: [opt('opt.u.ember', 0)] });
    for (let t = 0; t < 100; t++) { combatSystem.update(again.ctx); skillsSystem.update(again.ctx); }
    expect(again.ctx.world.stats.gearSkillProcs).toBe(casts.length);
  });

  it('no gear skill → no extra RNG draw (same RNG state as with plain gear)', () => {
    const a = fight(base), b = fight(base);
    a.h.equipment.weapon = item('gear.w.fang');
    b.h.equipment.weapon = item('gear.w.fang', { gradeId: 'gr.b', options: [opt('opt.atk', 0)] });
    for (let t = 0; t < 50; t++) { combatSystem.update(a.ctx); combatSystem.update(b.ctx); }
    expect(b.ctx.rng.state).toEqual(a.ctx.rng.state);
  });

  it('lifesteal heals a share of the damage that landed; gold / EXP / drop bonuses; need drain', () => {
    const { ctx, h, m } = fight(base);
    h.equipment.weapon = item('gear.w.fang', { options: [opt('opt.u.thirst', 2.5)] });
    const max = hunterStats(base, h).hp;
    h.needs.hp = max / 2;
    m.hp = 50;
    const dealt = damageMonster(ctx, h, m, 1e6, false);
    expect(dealt).toBeGreaterThan(50);
    expect(h.needs.hp).toBeCloseTo(max / 2 + 50 * 0.025, 9); // overkill does not heal
    // gold / EXP: × (1 + bonus), clamped to gearPctCap (tax off, neutral personalities so only the gear acts).
    const kill = (lines: { id: string; value: number }[]) => {
      const x = fight(base);
      x.ctx.world.town.taxRate = 0;
      x.h.personalities = [];
      x.h.equipment.ring = item('gear.ring.fang', { options: lines });
      x.m.hp = 1;
      x.h.gold = 0;
      x.h.exp = 0;
      damageMonster(x.ctx, x.h, x.m, 1e6, false);
      return x.h;
    };
    const ms = monsterTypeStats(base, base.zones[0]!.monsters[0]!.monsterId, 'diff.easy');
    expect(base.formula.taxMinRate).toBe(0);
    const plainK = kill([]);
    expect(plainK.gold).toBe(ms.gold);
    const goldK = kill([opt('opt.gold', 1000)]); // clamped to +gearPctCap
    expect(goldK.gold).toBe(Math.round(ms.gold * (1 + base.formula.gearPctCap / 100)));
    expect(goldK.gold).toBeGreaterThan(plainK.gold);
    expect(goldK.exp).toBe(plainK.exp);
    const expK = kill([opt('opt.exp', 25)]);
    expect(plainK.exp).toBeGreaterThan(0);
    expect(expK.exp).toBeCloseTo(plainK.exp * 1.25, 9);
    expect(expK.gold).toBe(plainK.gold);
    // drops: same RNG draws, each drop chance × 1.4 → every plain drop also drops, and more on top over many kills.
    const countDrops = (lines: { id: string; value: number }[]) => {
      const x = fight(base);
      x.h.equipment.ring = item('gear.ring.fang', { options: lines });
      let n = 0;
      for (let i = 0; i < 300; i++) {
        x.m.hp = 1; x.h.bag = {};
        damageMonster(x.ctx, x.h, x.m, 1e6, false);
        for (const k in x.h.bag) n += x.h.bag[k]!;
      }
      return n;
    };
    const plainDrops = countDrops([]);
    expect(countDrops([opt('opt.loot', 40)])).toBeGreaterThan(plainDrops);
    // needs: −5 % drain
    const n = makeCtx();
    const a = addHunter(n), b = addHunter(n);
    for (const x of [a, b]) { x.nodeId = base.index.zoneNodes.get(base.zones[0]!.id)![0]!; x.ai.goal = { type: 'hunt', zoneId: base.zones[0]!.id }; }
    b.equipment.belt = item('gear.belt.fang', { options: [opt('opt.thrift', 5)] });
    expect(needDrainMul(base, b)).toBeCloseTo(0.95, 12);
    const s0 = a.needs.stamina;
    for (let t = 0; t < 100; t++) needsSystem.update(n);
    expect(s0 - b.needs.stamina).toBeCloseTo((s0 - a.needs.stamina) * 0.95, 6);
  });
});

describe('AI gear valuation (gearScore)', () => {
  it('plain items score their main value; options and sets add main-stat units; negatives subtract', () => {
    const h = hunter({ level: 30 });
    h.equipment.weapon = item('gear.w.cinder');
    const plain = item('gear.w.frost');
    expect(gearScore(base, h, plain)).toBe(gearMainValue(base, plain));
    const good = item('gear.w.frost', { gradeId: 'gr.a', options: [opt('opt.atk', 4), opt('opt.crit', 2)] });
    const bad = item('gear.w.frost', { gradeId: 'gr.b', options: [opt('opt.n.atk', -3)] });
    expect(gearScore(base, h, good)).toBeGreaterThan(gearScore(base, h, plain));
    expect(gearScore(base, h, bad)).toBeLessThan(gearScore(base, h, plain));
    // +4 % ATK ≈ 4 % of the raw ATK total in ATK units (linearised).
    const onlyAtk = item('gear.w.frost', { options: [opt('opt.atk', 4)] });
    const growth = base.index.jobsByClass.get(h.classId)![h.jobTier]!.statMult * (1 + h.reincarnation * base.formula.reincStatBonus);
    const raw = h.stats.atk * growth + gearMainValue(base, h.equipment.weapon!);
    expect(gearScore(base, h, onlyAtk) - gearMainValue(base, onlyAtk)).toBeCloseTo(0.04 * raw, 6);
  });

  it('the shop purchase prefers the item with better options at the same main value and price', () => {
    const ctx = makeCtx();
    const h = addHunter(ctx, { level: 30, gold: 1e6 });
    h.equipment.weapon = item('gear.w.cinder'); // 42 → drake 58: gain < 1 (the AI caps gain at 1)
    const shop = (uid: string, extra: Partial<GearInstance>): ShopItem => ({ ...item('gear.w.drake', extra), uid, price: 100, listPrice: 100, listedAtMs: 0 });
    ctx.world.town.shop = [shop('a', { options: [opt('opt.n.atk', -3)] }), shop('b', { options: [opt('opt.atk', 4)] }), shop('c', {})];
    expect(bestShopPurchase(base, ctx.world, h)?.item.uid).toBe('b');
  });

  it('a piece that completes a set bonus is worth more than the same main value outside the set', () => {
    const h = hunter({ level: 70 });
    const tide = (slot: GearSlot) => base.gear.find((g) => g.slot === slot && g.setId === 'set.tidewall')!;
    h.equipment.weapon = item(tide('weapon').id);
    const inSet = item(tide('body').id);
    expect(gearScore(base, h, inSet, 'body')).toBeGreaterThan(gearMainValue(base, inSet));
    // A recipe not rolled yet counts its set bonus but no option lines (they are a coin flip until crafted).
    expect(expectedGearExtra(base, h, tide('body'))).toBeCloseTo(gearScore(base, h, inSet, 'body') - gearMainValue(base, inSet), 9);
    expect(expectedGearExtra(base, h, base.index.gear.get('gear.w.void')!)).toBe(0);
  });
});

describe('end to end: craft → shop → buy → equip → reclaim → relist keeps grade and options', () => {
  it('options survive every hand-off', () => {
    const ctx = makeCtx();
    const h = addHunter(ctx, { level: 5, gold: 1e6 });
    const lines = [opt('opt.atk', 3.3), opt('opt.u.keen', 3.5)];
    const it: ShopItem = { ...item('gear.w.tusk', { gradeId: 'gr.ss', options: lines }), uid: 'g77', price: 50, listPrice: 50, listedAtMs: 0 };
    ctx.world.town.shop = [it];
    h.ai.goal = { type: 'shop', itemUid: 'g77' };
    h.ai.phase = 'act';
    h.nodeId = base.index.squareNode;
    economySystem.update(ctx);
    expect(h.equipment.weapon).toEqual({ uid: 'g77', gearId: 'gear.w.tusk', qualityId: 'q.rare', enhance: 0, gradeId: 'gr.ss', options: lines });
    expect(hunterStats(base, h).crit).toBeCloseTo(hunterStats(base, { ...h, equipment: {} }).crit + 3.5, 9);
    reclaimGear(ctx, h, 'command');
    const stored = ctx.world.town.gearStorage[0]!;
    expect(stored).toMatchObject({ uid: 'g77', gradeId: 'gr.ss', options: lines });
    expect(listStoredGear(ctx, 'g77')).toBeNull();
    const relisted = ctx.world.town.shop.find((x) => x.uid === 'g77')!;
    expect(relisted.options).toEqual(lines);
    expect(relisted.price).toBe(gearListPrice(base, stored));
    expect(gearListPrice(base, stored)).toBe(Math.round(base.index.gear.get('gear.w.tusk')!.basePrice * base.index.gearGrades.get('gr.ss')!.priceMult));
  });
});

describe('migration v12 → v13', () => {
  it('moves armor → body and accessory → necklace (hunters, journeys, portal, enhance goal); no grade/options', () => {
    const s = new Simulation(base, createWorld(base, 3));
    s.enqueue({ type: 'debug.spawnHunter' });
    s.enqueue({ type: 'debug.spawnHunter' });
    s.step();
    const w = JSON.parse(JSON.stringify(s.world)) as Record<string, any>;
    const old = {
      weapon: { uid: 'e1', gearId: 'gear.w.club', qualityId: 'q.rare', enhance: 1, difficultyId: 'diff.easy' },
      armor: { uid: 'e2', gearId: 'gear.a.hide', qualityId: 'q.epic', enhance: 2, difficultyId: 'diff.easy' },
      accessory: { uid: 'e3', gearId: 'gear.r.fang', qualityId: 'q.common', enhance: 0, difficultyId: 'diff.easy' },
    };
    w.hunters[0].equipment = structuredClone(old);
    w.hunters[0].ai.goal = { type: 'enhance', slot: 'armor' };
    const away = { ...structuredClone(w.hunters[1]), id: 'away', equipment: structuredClone(old) };
    const inPortal = { ...structuredClone(w.hunters[1]), id: 'portal', equipment: { accessory: structuredClone(old.accessory) } };
    w.hunters = [w.hunters[0]];
    w.journeys = [{ id: 'j1', journeyId: base.journeys[0]!.id, difficultyId: 'diff.easy', hunters: [away], teamPower: 1, successChance: 0.5, durationMs: 1000, remainingMs: 1000, startedAtMs: 0, cost: 0 }];
    w.portal = [{ hunter: inPortal, durationMs: 1000, remainingMs: 1000, enteredAtMs: 0 }];
    w.schemaVersion = 12;
    const r = deserialize(JSON.stringify({ format: SAVE_FORMAT, schemaVersion: 12, configVersion: base.version, savedAt: 0, world: w }), base);
    expect(r.migratedFrom).toBe(12);
    expect(WORLD_SCHEMA_VERSION).toBe(15);
    expect(r.world.schemaVersion).toBe(15);
    const want = { weapon: old.weapon, body: old.armor, necklace: old.accessory };
    expect(r.world.hunters[0]!.equipment).toEqual(want);
    expect(r.world.hunters[0]!.ai.goal).toEqual({ type: 'enhance', slot: 'body' });
    expect(r.world.journeys[0]!.hunters[0]!.equipment).toEqual(want);
    expect(r.world.portal[0]!.hunter.equipment).toEqual({ necklace: old.accessory });
    // The migrated world keeps running (hunters re-gear the new slots).
    const sim = new Simulation(base, r.world);
    for (let t = 0; t < 600; t++) sim.step();
    expect(sim.world.tick).toBeGreaterThan(r.world.tick - 1);
  });

  it('a current-version save written while v12 → v13 was a placeholder is remapped at load (idempotent)', () => {
    const s = new Simulation(base, createWorld(base, 4));
    s.enqueue({ type: 'debug.spawnHunter' });
    s.step();
    const w = JSON.parse(JSON.stringify(s.world)) as Record<string, any>;
    const armor = { uid: 'e2', gearId: 'gear.a.hide', qualityId: 'q.epic', enhance: 2, difficultyId: 'diff.easy' };
    w.hunters[0].equipment = { armor };
    const text = JSON.stringify({ format: SAVE_FORMAT, schemaVersion: WORLD_SCHEMA_VERSION, configVersion: base.version, savedAt: 0, world: w });
    const r = deserialize(text, base);
    expect(r.world.hunters[0]!.equipment).toEqual({ body: armor });
    const again = deserialize(JSON.stringify({ format: SAVE_FORMAT, schemaVersion: WORLD_SCHEMA_VERSION, configVersion: base.version, savedAt: 0, world: r.world }), base);
    expect(again.world.hunters[0]!.equipment).toEqual({ body: armor });
  });
});
