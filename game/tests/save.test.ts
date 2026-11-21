import 'fake-indexeddb/auto';
import { deserialize, SaveError, serialize, SAVE_FORMAT } from '../src/core/save/save';
import { IndexedDbStorage, MemoryStorage } from '../src/core/save/storage';
import { createWorld, Simulation } from '../src/core/simulation';
import { WORLD_SCHEMA_VERSION } from '../src/core/world';
import { estimateRollStats, migrationSpawnNode } from '../src/core/save/migrations';
import { loadConfig } from '../src/core/config/load';
import type { GameConfig } from '../src/core/config/types';
import { readRawConfig, testConfig } from './helpers';

const config = testConfig();

function runFor(s: Simulation, n: number) {
  for (let i = 0; i < n; i++) s.step();
}

describe('save/load', () => {
  it('round-trips and continues identically to an unsaved run', () => {
    const a = new Simulation(config, createWorld(config, 77));
    runFor(a, 1500);
    const text = serialize(a.world, 1000);

    const b = new Simulation(config, createWorld(config, 1));
    b.setWorld(deserialize(text, config).world);
    expect(JSON.stringify(b.world)).toBe(JSON.stringify(a.world));

    runFor(a, 1500);
    runFor(b, 1500);
    expect(JSON.stringify(b.world)).toBe(JSON.stringify(a.world));
  });

  it('flags config version changes', () => {
    const w = createWorld(config, 1);
    expect(deserialize(serialize(w, 0), { ...config, version: 'other' }).configChanged).toBe(true);
    expect(deserialize(serialize(w, 0), config).configChanged).toBe(false);
  });

  it('migrates v0 saves to the current schema', () => {
    const w = createWorld(config, 1) as any;
    delete w.town.arrivalTimerMs;
    w.hunters = [{ id: 'h1' }];
    w.schemaVersion = 0;
    const text = JSON.stringify({ format: SAVE_FORMAT, schemaVersion: 0, configVersion: config.version, savedAt: 5, world: w });
    const r = deserialize(text, config);
    expect(r.migratedFrom).toBe(0);
    expect(r.world.schemaVersion).toBe(WORLD_SCHEMA_VERSION);
    expect(r.world.town.arrivalTimerMs).toBe(0);
    expect(r.world.hunters[0]!.reincarnation).toBe(0);
  });

  it('migrates M0 (v1) saves: hunters land on the square with fresh AI, and the game runs on', () => {
    const s = new Simulation(config, createWorld(config, 4));
    s.enqueue({ type: 'debug.spawnHunter' });
    s.step();
    const w = JSON.parse(JSON.stringify(s.world));
    for (const h of w.hunters) for (const k of ['nodeId', 'insideBuildingId', 'ai', 'attackCdMs', 'deadMs', 'kills']) delete h[k];
    delete w.monsters; delete w.zones; delete w.stats;
    w.schemaVersion = 1;
    const text = JSON.stringify({ format: SAVE_FORMAT, schemaVersion: 1, configVersion: config.version, savedAt: 0, world: w });
    const r = deserialize(text, config);
    expect(r.migratedFrom).toBe(1);
    expect(r.world.hunters[0]!.nodeId).toBe(config.index.squareNode);
    const s2 = new Simulation(config, r.world);
    for (let i = 0; i < 600; i++) s2.step();
    expect(s2.world.monsters.length).toBeGreaterThan(0);
  });

  it('migrates M1 (v2) saves: empty bags/equipment, town economy initialised', () => {
    const s = new Simulation(config, createWorld(config, 6));
    s.enqueue({ type: 'debug.spawnHunter' });
    s.step();
    const w = JSON.parse(JSON.stringify(s.world));
    for (const h of w.hunters) { delete h.equipment; delete h.bag; }
    w.town = { gold: 123, arrivalTimerMs: 0 };
    w.stats = { kills: 1, deaths: 0, serviceUses: 2 };
    w.schemaVersion = 2;
    const r = deserialize(JSON.stringify({ format: SAVE_FORMAT, schemaVersion: 2, configVersion: config.version, savedAt: 0, world: w }), config);
    expect(r.migratedFrom).toBe(2);
    expect(r.world.town.gold).toBe(123);
    expect(r.world.town.shop).toEqual([]);
    expect(r.world.town.autoCraft).toBe(true);
    expect(r.world.hunters[0]!.bag).toEqual({});
    expect(r.world.stats.kills).toBe(1);
    expect(r.world.stats.crafted).toBe(0);
    const s2 = new Simulation(config, r.world);
    for (let i = 0; i < 600; i++) s2.step(); // runs without throwing on missing crafting keys
  });

  it('migrates M2 (v3) saves: Easy difficulty, empty skills/traits, roll stats recovered', () => {
    const s = new Simulation(config, createWorld(config, 9));
    s.enqueue({ type: 'debug.spawnHunter' });
    s.step();
    const w = JSON.parse(JSON.stringify(s.world));
    const h = w.hunters[0];
    const roll = { ...h.rollStats };
    h.level = 3; h.stats.hp += 40; h.stats.atk += 2; h.stats.def += 2;
    for (const k of ['rollStats', 'skills', 'skillCdMs', 'traits', 'traitPoints', 'buffs']) delete h[k];
    for (const m of w.monsters) delete m.difficultyId;
    for (const k of ['difficulty', 'unlockedDifficulties', 'autoReincarnate']) delete w.town[k];
    for (const k of ['skillCasts', 'jobChanges', 'reincarnations', 'learned']) delete w.stats[k];
    w.schemaVersion = 3;
    const r = deserialize(JSON.stringify({ format: SAVE_FORMAT, schemaVersion: 3, configVersion: config.version, savedAt: 0, world: w }), config);
    expect(r.migratedFrom).toBe(3);
    const mh = r.world.hunters[0]!;
    expect(mh.rollStats.hp).toBe(roll.hp);
    expect(mh.rollStats.atk).toBe(roll.atk);
    expect(mh.skills).toEqual({});
    expect(r.world.town.difficulty).toBe('diff.easy');
    expect(r.world.monsters.every((m) => m.difficultyId === 'diff.easy')).toBe(true);
    const s2 = new Simulation(config, r.world);
    for (let i = 0; i < 600; i++) s2.step();
  });

  it('migrates v4 saves: shop items get listPrice and listedAtMs', () => {
    const w = JSON.parse(JSON.stringify(createWorld(config, 3)));
    w.timeMs = 5000;
    w.town.shop = [{ uid: 'g1', gearId: 'gear.w.club', qualityId: 'q.rare', enhance: 0, price: 60 }];
    w.schemaVersion = 4;
    const r = deserialize(JSON.stringify({ format: SAVE_FORMAT, schemaVersion: 4, configVersion: config.version, savedAt: 0, world: w }), config);
    expect(r.migratedFrom).toBe(4);
    expect(r.world.town.shop[0]).toMatchObject({ price: 60, listPrice: 60, listedAtMs: 5000 });
  });

  it('migrates v5 saves: empty Trading Post requests and zeroed discard/scrap stats, keeps storage', () => {
    const w = JSON.parse(JSON.stringify(createWorld(config, 3)));
    delete w.town.requests;
    delete w.stats.materialsDiscarded;
    delete w.stats.gearScrapped;
    w.town.storage = { 'mat.gel': 300 };
    w.schemaVersion = 5;
    const r = deserialize(JSON.stringify({ format: SAVE_FORMAT, schemaVersion: 5, configVersion: config.version, savedAt: 0, world: w }), config);
    expect(r.migratedFrom).toBe(5);
    expect(r.world.schemaVersion).toBe(WORLD_SCHEMA_VERSION);
    expect(r.world.town.requests).toEqual({});
    expect(r.world.town.storage).toEqual({ 'mat.gel': 300 });
    expect(r.world.stats.materialsDiscarded).toBe(0);
    expect(r.world.stats.gearScrapped).toBe(0);
    const s2 = new Simulation(config, r.world);
    for (let i = 0; i < 600; i++) s2.step();
  });

  it('migrates a v6 save (no bounties) and keeps running', () => {
    const w = JSON.parse(JSON.stringify(createWorld(config, 4)));
    delete w.town.bounties;
    delete w.town.autoBounty;
    for (const k of ['bountiesPosted', 'bountiesCompleted', 'bountyGoldPaid', 'bountyKingdomGold']) delete w.stats[k];
    w.town.requests = { 'mat.ore': 7 };
    w.schemaVersion = 6;
    const r = deserialize(JSON.stringify({ format: SAVE_FORMAT, schemaVersion: 6, configVersion: config.version, savedAt: 0, world: w }), config);
    expect(r.migratedFrom).toBe(6);
    expect(r.world.schemaVersion).toBe(WORLD_SCHEMA_VERSION);
    expect(WORLD_SCHEMA_VERSION).toBe(15);
    expect(r.world.town.bounties).toEqual([]);
    expect(r.world.town.autoBounty).toBe(true);
    expect(r.world.town.requests).toEqual({ 'mat.ore': 7 });
    expect(r.world.stats).toMatchObject({ bountiesPosted: 0, bountiesCompleted: 0, bountyGoldPaid: 0, bountyKingdomGold: 0 });
    const s2 = new Simulation(config, r.world);
    s2.enqueue({ type: 'debug.spawnHunter' });
    for (let i = 0; i < 600; i++) s2.step();
  });

  /** A v7 save: no town.buildings / autoInvest / investPlan / building stats. */
  function v7Save(mutate: (w: any) => void): string {
    const w = JSON.parse(JSON.stringify(createWorld(config, 4)));
    delete w.town.buildings;
    delete w.town.autoInvest;
    delete w.town.investPlan;
    for (const k of ['buildingsBuilt', 'buildingUpgrades', 'investGold', 'investMaterials', 'investImportGold']) delete w.stats[k];
    mutate(w);
    w.schemaVersion = 7;
    return JSON.stringify({ format: SAVE_FORMAT, schemaVersion: 7, configVersion: config.version, savedAt: 0, world: w });
  }

  it('migrates a fresh v7 save: every start building at level 1, auto-invest on, building stats 0', () => {
    const r = deserialize(v7Save(() => {}), config);
    expect(r.migratedFrom).toBe(7);
    expect(r.world.schemaVersion).toBe(WORLD_SCHEMA_VERSION);
    expect(WORLD_SCHEMA_VERSION).toBe(15);
    const fresh = createWorld(config, 4);
    expect(r.world.town.buildings).toEqual(fresh.town.buildings);
    expect(r.world.town.buildings.every((b) => b.level === 1 && b.upgrade === null)).toBe(true);
    expect(r.world.town.autoInvest).toBe(true);
    expect(r.world.town.investPlan).toBeNull();
    expect(r.world.stats).toMatchObject({ buildingsBuilt: 0, buildingUpgrades: 0, investGold: 0, investMaterials: 0, investImportGold: 0 });
  });

  it('fills buildings into a v9 save made before buildings existed (Journey-only build) and the town keeps working', () => {
    const w = JSON.parse(v7Save(() => {})).world;
    w.schemaVersion = WORLD_SCHEMA_VERSION;
    const r = deserialize(JSON.stringify({ format: SAVE_FORMAT, schemaVersion: WORLD_SCHEMA_VERSION, configVersion: config.version, savedAt: 0, world: w }), config);
    expect(r.migratedFrom).toBeNull();
    expect(r.world.town.buildings).toEqual(createWorld(config, 4).town.buildings);
    expect(r.world.town.autoInvest).toBe(true);
    expect(r.world.stats.investGold).toBe(0);
    const s2 = new Simulation(config, r.world);
    s2.enqueue({ type: 'debug.spawnHunter' });
    for (let i = 0; i < 600; i++) s2.step();
    expect(s2.world.stats.serviceUses + s2.world.stats.kills).toBeGreaterThan(0);
  });

  it('migrates a late v7 save at levels that keep its gear craftable (craft buildings, Town Hall)', () => {
    const s = new Simulation(config, createWorld(config, 4));
    s.enqueue({ type: 'debug.spawnHunter' });
    s.step();
    const text = v7Save((w) => {
      w.hunters = JSON.parse(JSON.stringify(s.world.hunters));
      w.hunters[0].level = 47; // + craftLevelAhead 2 = 49
      // a Lv51 item on sale raises the bar to 51: smithy recipes up to Lv50, jeweler up to Lv51
      w.town.shop = [{ uid: 'gx', gearId: 'gear.r.pearl', qualityId: 'q.rare', enhance: 0, price: 1, listPrice: 1, listedAtMs: 0 }];
    });
    const r = deserialize(text, config);
    const lv = (id: string) => r.world.town.buildings.find((b) => b.buildingId === id)!.level;
    const cap = (id: string) => config.index.buildings.get(id)!.maxGearLevel![lv(id) - 1]!;
    expect(cap('bld.smithy')).toBeGreaterThanOrEqual(50);
    expect(config.index.buildings.get('bld.smithy')!.maxGearLevel![lv('bld.smithy') - 2]!).toBeLessThan(50); // lowest such level
    expect(cap('bld.jeweler')).toBeGreaterThanOrEqual(51);
    expect(lv('bld.townhall')).toBe(Math.max(lv('bld.smithy'), lv('bld.jeweler')));
    expect(lv('bld.shop')).toBe(1);
    const s2 = new Simulation(config, r.world);
    for (let i = 0; i < 600; i++) s2.step();
    expect(s2.world.town.buildings.length).toBeGreaterThanOrEqual(r.world.town.buildings.length);
  });

  describe('config-derived migration values', () => {
    /** Current config with the square renamed/moved and non-default level gains. */
    function altConfig(): GameConfig {
      const raw = JSON.parse(JSON.stringify(readRawConfig()).replaceAll('"t.square"', '"t.plaza"'));
      const sq = raw.map_node.find((n: any) => n.id === 't.plaza');
      sq.x = 2; sq.y = -3;
      Object.assign(raw.formula_params, { levelHpGain: 35, levelAtkGain: 3, levelDefGain: 2 });
      return loadConfig(raw);
    }

    function v1Save(cfg: GameConfig, seed: number): string {
      const s = new Simulation(cfg, createWorld(cfg, seed));
      s.enqueue({ type: 'debug.spawnHunter' });
      s.step();
      const w = JSON.parse(JSON.stringify(s.world));
      for (const h of w.hunters) for (const k of ['nodeId', 'insideBuildingId', 'ai', 'attackCdMs', 'deadMs', 'kills']) delete h[k];
      delete w.monsters; delete w.zones; delete w.stats;
      w.schemaVersion = 1;
      return JSON.stringify({ format: SAVE_FORMAT, schemaVersion: 1, configVersion: cfg.version, savedAt: 0, world: w });
    }

    it('v1→v2 places hunters on the config square node (id and coordinates), not a hard-coded one', () => {
      const cfg = altConfig();
      expect(migrationSpawnNode(cfg)).toEqual({ id: 't.plaza', x: 2, y: -3 });
      const r = deserialize(v1Save(cfg, 4), cfg);
      for (const h of r.world.hunters) {
        expect(h.nodeId).toBe('t.plaza');
        expect(h.position).toEqual({ x: 2, y: -3 });
      }
      const s2 = new Simulation(cfg, r.world);
      for (let i = 0; i < 600; i++) s2.step();
    });

    it('falls back to the M1 square when the config has no square node', () => {
      const broken = { ...config, nodes: [], index: { ...config.index, nodes: new Map(), squareNode: 'missing' } } as GameConfig;
      expect(migrationSpawnNode(broken)).toEqual({ id: 't.square', x: 0, y: 0 });
    });

    it('v3→v4 recovers rollStats using the config level gains', () => {
      const cfg = altConfig();
      const s = new Simulation(cfg, createWorld(cfg, 9));
      s.enqueue({ type: 'debug.spawnHunter' });
      s.step();
      const w = JSON.parse(JSON.stringify(s.world));
      const h = w.hunters[0];
      const roll = { ...h.rollStats };
      h.level = 5; h.stats.hp += 4 * 35; h.stats.atk += 4 * 3; h.stats.def += 4 * 2;
      for (const k of ['rollStats', 'skills', 'skillCdMs', 'traits', 'traitPoints', 'buffs']) delete h[k];
      w.schemaVersion = 3;
      const r = deserialize(JSON.stringify({ format: SAVE_FORMAT, schemaVersion: 3, configVersion: cfg.version, savedAt: 0, world: w }), cfg);
      expect(r.world.hunters[0]!.rollStats).toEqual(roll);
    });

    it('estimateRollStats leaves non-growing stats alone and clamps to the class roll range', () => {
      const f = config.formula;
      const cls = config.classes[0]!;
      const r = cls.statRanges;
      // Unknown class: only floored at 0.
      expect(estimateRollStats(config, { hp: 100, atk: 1, def: 0, crit: 7 }, 3)).toEqual({
        hp: Math.max(0, 100 - 2 * f.levelHpGain), atk: Math.max(0, 1 - 2 * f.levelAtkGain), def: 0, crit: 7,
      });
      expect(estimateRollStats(config, { hp: 50 }, 0).hp).toBe(50);
      // Known class: stripped values outside the possible roll are clamped into it.
      const low = estimateRollStats(config, { hp: 1, atk: 0, def: 0, crit: 7 }, 10, cls.id);
      expect(low).toEqual({ hp: r.hp[0]![0], atk: r.atk[0]![0], def: r.def[0]![0], crit: 7 });
      const high = estimateRollStats(config, { hp: 1e6, atk: 1e6, def: 1e6 }, 1, cls.id);
      expect(high).toEqual({ hp: r.hp[2]![1], atk: r.atk[2]![1], def: r.def[2]![1] });
    });
  });

  it('rejects garbage, foreign files and future schema versions', () => {
    expect(() => deserialize('{', config)).toThrow(SaveError);
    expect(() => deserialize('{"a":1}', config)).toThrow(/not a save file/);
    const w = createWorld(config, 1);
    const future = JSON.stringify({ format: SAVE_FORMAT, schemaVersion: WORLD_SCHEMA_VERSION + 1, configVersion: '', savedAt: 0, world: w });
    expect(() => deserialize(future, config)).toThrow(/newer than this build/);
  });

  it.each([
    ['memory', () => new MemoryStorage()],
    ['indexeddb', () => new IndexedDbStorage()],
  ])('%s storage reads, writes and removes', async (_, make) => {
    const st = make();
    expect(await st.read('s')).toBeNull();
    await st.write('s', 'hello');
    expect(await st.read('s')).toBe('hello');
    await st.write('s', 'again');
    expect(await st.read('s')).toBe('again');
    await st.remove('s');
    expect(await st.read('s')).toBeNull();
  });
});
