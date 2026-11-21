/**
 * M4 acceptance (docs/QA_M4.md): cross-system scenarios for Trading Post requests, Bounty, Tax, Journey, Town Hall /
 * buildings, offline progress (wall-clock timers only) and save migrations v0 → v12, all through the public command API in one world.
 * Per-system rules are unit-tested in bounty/tax/journey/town/trading/offline/save.test.ts; this file checks that
 * they hold together (invariants, accounting, determinism across save/load, old saves loading into a working M4 town).
 * Item ids (QA-…) refer to the checklist in docs/QA_M4.md.
 */
import type { GameConfig } from '../src/core/config/types';
import type { Command } from '../src/core/commands';
import type { SimEvent } from '../src/core/events';
import { needMax } from '../src/core/formulas';
import { advanceOfflineWallClock, offlineWallClockMs } from '../src/core/offline';
import { deserialize, SAVE_FORMAT, serialize } from '../src/core/save/save';
import { createWorld, Simulation } from '../src/core/simulation';
import { bountyKillShare } from '../src/core/systems/bounty';
import { advanceJourneys, allHunters, bestJourneyTeam, townHunterCount } from '../src/core/systems/journey';
import { taxRate } from '../src/core/systems/tax';
import { shopCapacity, townHallLevel } from '../src/core/systems/town';
import { isAlive, WORLD_SCHEMA_VERSION, type World } from '../src/core/world';
import { testConfig } from './helpers';

const config: GameConfig = testConfig();
const f = config.formula;
const T0 = 1_700_000_000_000;
const MIN = 600; // ticks per game minute
const JOURNEY = 'journey.mossway';

type Rejection = { command: string; reason: string };

/** Invariants every M4 world must keep (QA-INV). Returns the violations (empty = ok). */
function violations(cfg: GameConfig, w: World): string[] {
  const bad: string[] = [];
  const intGe0 = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  if (!intGe0(w.town.gold)) bad.push(`town gold ${w.town.gold}`);
  for (const [id, n] of Object.entries(w.town.storage)) if (!intGe0(n)) bad.push(`storage ${id}=${n}`);
  const ids = new Set<string>();
  for (const h of allHunters(w)) {
    if (ids.has(h.id)) bad.push(`duplicate hunter ${h.id}`);
    ids.add(h.id);
    if (!intGe0(h.gold)) bad.push(`${h.id} gold ${h.gold}`);
    if (!(h.level >= 1 && h.level <= cfg.formula.maxLevel)) bad.push(`${h.id} level ${h.level}`);
    for (const k of ['hp', 'satiety', 'mood', 'stamina'] as const) {
      const v = h.needs[k];
      if (!Number.isFinite(v) || v < 0 || v > needMax(cfg, h, k) + 1e-6) bad.push(`${h.id} ${k}=${v}`);
    }
  }
  if (townHunterCount(w) > cfg.formula.hunterSlots) bad.push(`hunters ${townHunterCount(w)} > slots`);
  // Bounties: escrow = reward − what the paid kills took (per-kill shares sum exactly to the reward).
  const bounties = w.town.bounties ?? [];
  if (bounties.length > cfg.formula.bountyMaxActive) bad.push(`bounties ${bounties.length}`);
  for (const b of bounties) {
    let paid = 0;
    for (let k = 1; k <= b.progress; k++) paid += bountyKillShare(b.reward, b.kills, k);
    if (b.escrow !== b.reward - paid) bad.push(`bounty ${b.id} escrow ${b.escrow} != ${b.reward - paid}`);
    if (b.progress >= b.kills) bad.push(`bounty ${b.id} not removed at ${b.progress}/${b.kills}`);
  }
  // Journeys: bounded, members out of the field.
  const js = w.journeys ?? [];
  if (js.length > cfg.formula.journeyMaxActive) bad.push(`journeys ${js.length}`);
  for (const j of js) for (const m of j.hunters) if (w.hunters.some((h) => h.id === m.id)) bad.push(`${m.id} both away and in field`);
  // Buildings: within max level, never above the Town Hall (except the Town Hall itself), bounded concurrent jobs.
  const th = townHallLevel(cfg, w);
  let busy = 0;
  for (const s of w.town.buildings ?? []) {
    const b = cfg.index.buildings.get(s.buildingId);
    if (!b) { bad.push(`unknown building ${s.buildingId}`); continue; }
    const top = s.upgrade ? s.upgrade.toLevel : s.level;
    if (top > b.maxLevel) bad.push(`${s.id} level ${top} > max`);
    if (b.kind !== 'townHall' && top > th) bad.push(`${s.id} level ${top} > Town Hall ${th}`);
    if (s.upgrade) busy++;
  }
  if (busy > Math.max(1, cfg.formula.buildMaxConcurrent)) bad.push(`${busy} constructions`);
  if (w.town.shop.length > shopCapacity(cfg, w)) bad.push(`shop ${w.town.shop.length} > capacity`);
  const rate = taxRate(cfg, w);
  if (rate < cfg.formula.taxMinRate || rate > cfg.formula.taxMaxRate) bad.push(`tax ${rate}`);
  return bad;
}

interface RunResult {
  sim: Simulation;
  events: SimEvent[];
  rejected: Rejection[];
  violations: string[];
  /** What was in flight when the world went through save/load (swapAt only). */
  atSwap: { journeys: number; bounties: number; upgrades: number } | null;
}

/**
 * The scripted 20-minute M4 session (QA-LOOP): 6 hunters (+ arrivals), tax 20 %, two bounties, Town Hall 1 → 3, a shop
 * upgrade cancelled, a Storehouse built on a new plot, one journey run to completion and one recalled, auto-invest
 * switched on half-way. `swapAt`: at that tick save → load into a fresh simulation and continue (QA-SAVE).
 */
function runSession(seed: number, swapAt = -1, minutes = 20): RunResult {
  let sim = new Simulation(config, createWorld(config, seed));
  const events: SimEvent[] = [];
  const rejected: Rejection[] = [];
  const bad: string[] = [];
  const w = () => sim.world;
  const send = (c: Command) => sim.enqueue(c);
  const give = (id: string, n: number) => { w().town.storage[id] = (w().town.storage[id] ?? 0) + n; };
  let sent = 0;
  let recallUid: string | null = null;
  let recallAt = -1;
  let atSwap: RunResult['atSwap'] = null;

  for (let t = 0; t < minutes * MIN; t++) {
    if (t === swapAt) {
      atSwap = {
        journeys: w().journeys.length,
        bounties: (w().town.bounties ?? []).length,
        upgrades: w().town.buildings.filter((b) => b.upgrade).length,
      };
      const text = serialize(w(), T0);
      const loaded = deserialize(text, config);
      sim = new Simulation(config, createWorld(config, 1));
      sim.setWorld(loaded.world);
    }
    switch (t) {
      case 0:
        w().town.gold += 20_000; // a rich Town so the script is about rules, not about saving up
        for (let i = 0; i < 6; i++) send({ type: 'debug.spawnHunter' });
        send({ type: 'town.setAutoInvest', on: false });
        send({ type: 'town.setTaxRate', rate: 0.2 });
        give('mat.ore', 4); give('mat.reed', 6); give('mat.cinder', 10);
        break;
      case 60:
        send({ type: 'town.upgrade', buildingInstanceId: 'plot.townhall' }); // → 2 (60 s)
        send({ type: 'town.build', buildingId: 'bld.storehouse', plotId: 'plot.ne' }); // expected: plot locked
        send({ type: 'town.requestMaterial', materialId: 'mat.gel', count: 15 });
        break;
      case MIN:
        send({ type: 'town.postBounty', targetKind: 'zone', targetId: 'zone.meadow', kills: 20, reward: 200 });
        send({ type: 'town.postBounty', targetKind: 'monster', targetId: 'mon.boar', kills: 5, reward: 50 });
        break;
      case MIN + 300: // Town Hall 2 is done
        send({ type: 'town.upgrade', buildingInstanceId: 'plot.townhall' }); // → 3 (120 s)
        send({ type: 'town.upgrade', buildingInstanceId: 'plot.shop' }); // → 2
        send({ type: 'town.upgrade', buildingInstanceId: 'plot.forge' }); // expected: construction slots full
        break;
      case MIN + 350:
        send({ type: 'town.cancelUpgrade', buildingInstanceId: 'plot.shop' }); // full refund
        break;
      case 4 * MIN: // Town Hall 3 is done
        send({ type: 'town.build', buildingId: 'bld.storehouse', plotId: 'plot.ne' });
        break;
      case 10 * MIN:
        send({ type: 'town.setAutoInvest', on: true });
        for (const b of w().town.bounties ?? []) if (b.targetKind === 'monster' && !b.auto) send({ type: 'town.cancelBounty', bountyId: b.id });
        break;
    }
    // Journeys: send the best Town team as soon as one exists (from 2 min), a second one later and recall it.
    if (t >= 2 * MIN && sent < 2 && (sent === 0 || t >= 5 * MIN)) {
      const team = bestJourneyTeam(config, w(), config.index.journeys.get(JOURNEY)!);
      if (team.length > 0) {
        send({ type: 'journey.start', journeyId: JOURNEY, hunterIds: team.map((h) => h.id) });
        sent++;
        if (sent === 2) recallAt = t + 200;
      }
    }
    if (t === recallAt && recallUid) send({ type: 'journey.recall', journeyUid: recallUid });

    sim.step();
    for (const e of sim.drainEvents()) {
      if (e.type === 'commandRejected') rejected.push({ command: e.command, reason: e.reason });
      if (e.type === 'journeyStarted' && sent === 2) recallUid = e.journeyUid;
      if (e.type !== 'hit') events.push(e);
    }
    if (t % MIN === MIN - 1) for (const v of violations(config, w())) bad.push(`t=${t}: ${v}`);
  }
  return { sim, events, rejected, violations: bad, atSwap };
}

const sum = (evs: SimEvent[], type: string, key: string) =>
  evs.filter((e) => e.type === type).reduce((a, e) => a + Number((e as unknown as Record<string, number>)[key] ?? 0), 0);
const ofType = <T extends SimEvent['type']>(evs: SimEvent[], type: T) => evs.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

// One shared session (≈ 1–2 s) for the loop, accounting and offline checks (in beforeAll: a failure there fails
// the tests that use it with a readable error instead of aborting the whole file at collection).
let session: RunResult;
beforeAll(() => {
  session = runSession(4);
});

/** Hunters a player command can address now (alive, outside buildings). */
const controllable = (w: World) => w.hunters.filter((h) => isAlive(h) && !h.insideBuildingId);

describe('QA-LOOP: all M4 systems in one 20-minute session', () => {
  it('keeps every invariant at every minute and only the expected commands are rejected', () => {
    const w = session.sim.world;
    const st = w.stats;
    console.log(`[m4 session] seed 4, 20 min: kills ${st.kills}, hunters ${townHunterCount(w)}, town gold ${w.town.gold}, ` +
      `tax ${st.taxCollected}, bounty paid ${st.bountyGoldPaid} / kingdom ${st.bountyKingdomGold} (${st.bountiesCompleted} done), ` +
      `journeys ok ${st.journeysSucceeded} fail ${st.journeysFailed} recalled ${st.journeysRecalled}, invest ${st.investGold}g, ` +
      `buildings ${w.town.buildings.filter((b) => b.level > 1 || b.id === 'plot.ne').map((b) => `${b.id}:${b.level}`).join(' ')}, ` +
      `sold ${st.materialsSold}, crafted ${st.crafted}, bought ${st.gearBought}`);
    expect(session.violations).toEqual([]);
    expect(violations(config, session.sim.world)).toEqual([]);
    expect(session.rejected).toEqual([
      { command: 'town.build', reason: 'plot locked by Town Hall level' },
      { command: 'town.upgrade', reason: 'construction slots full' },
    ]);
  });

  it('tax: 20 % of kill gold goes to the Town; the stat equals the sum of its events', () => {
    const w = session.sim.world;
    expect(taxRate(config, w)).toBe(0.2);
    expect(ofType(session.events, 'taxRateChanged').map((e) => e.rate)).toEqual([0.2]);
    const collected = sum(session.events, 'taxCollected', 'gold');
    expect(collected).toBeGreaterThan(0);
    expect(w.stats.taxCollected).toBe(collected);
  });

  it('bounties: paid gold equals the per-kill events, completions pay the kingdom share, a cancel refunds escrow', () => {
    const w = session.sim.world;
    const ev = session.events;
    expect(ofType(ev, 'bountyPosted').filter((e) => !e.auto)).toHaveLength(2);
    expect(w.stats.bountyGoldPaid).toBe(sum(ev, 'bountyProgress', 'gold'));
    expect(sum(ev, 'bountyProgress', 'gold')).toBeGreaterThan(0);
    for (const c of ofType(ev, 'bountyCompleted')) expect(c.kingdomGold).toBe(Math.round(c.reward * f.bountyCompletionFrac));
    expect(w.stats.bountyKingdomGold).toBe(sum(ev, 'bountyCompleted', 'kingdomGold'));
    // The zone bounty on the starting zone is finished within 20 minutes.
    const zone = ofType(ev, 'bountyPosted').find((e) => e.targetKind === 'zone' && !e.auto)!;
    expect(ofType(ev, 'bountyCompleted').some((e) => e.bountyId === zone.bountyId)).toBe(true);
    // The monster bounty either completed or was cancelled at 10 min with its unpaid escrow refunded.
    const mon = ofType(ev, 'bountyPosted').find((e) => e.targetKind === 'monster' && !e.auto)!;
    const done = ofType(ev, 'bountyCompleted').some((e) => e.bountyId === mon.bountyId);
    const cancel = ofType(ev, 'bountyCancelled').find((e) => e.bountyId === mon.bountyId);
    expect(done || cancel !== undefined).toBe(true);
    if (cancel) {
      const paid = ofType(ev, 'bountyProgress').filter((e) => e.bountyId === mon.bountyId).reduce((a, e) => a + e.gold, 0);
      expect(cancel.refund).toBe(50 - paid);
    }
  });

  it('buildings: Town Hall 1 → 3, cancelled shop upgrade fully refunded, Storehouse built on the unlocked plot', () => {
    const w = session.sim.world;
    const ev = session.events;
    const lv = (id: string) => w.town.buildings.find((s) => s.id === id)?.level;
    expect(lv('plot.townhall')).toBeGreaterThanOrEqual(3);
    expect(w.town.buildings.find((s) => s.id === 'plot.ne')?.buildingId).toBe('bld.storehouse');
    expect(lv('plot.ne')).toBeGreaterThanOrEqual(1);
    const shopStart = ofType(ev, 'buildingStarted').find((e) => e.instanceId === 'plot.shop' && !e.auto)!;
    const shopCancel = ofType(ev, 'buildingCancelled').find((e) => e.instanceId === 'plot.shop')!;
    expect(shopCancel.refund).toBe(shopStart.gold);
    expect(ofType(ev, 'buildingCompleted').filter((e) => e.instanceId === 'plot.townhall').map((e) => e.level).slice(0, 2)).toEqual([2, 3]);
  });

  it('journeys: one completes and returns its team, one is recalled; members are back in the field', () => {
    const w = session.sim.world;
    const ev = session.events;
    expect(ofType(ev, 'journeyStarted')).toHaveLength(2);
    expect(ofType(ev, 'journeyRecalled')).toHaveLength(1);
    const done = ofType(ev, 'journeyCompleted');
    expect(done).toHaveLength(1);
    expect(done[0]!.offline).toBe(false);
    expect(w.journeys).toEqual([]);
    for (const id of [...done[0]!.hunterIds, ...ofType(ev, 'journeyRecalled')[0]!.hunterIds]) {
      expect(w.hunters.some((h) => h.id === id), id).toBe(true);
    }
    expect(w.stats.journeysStarted).toBe(2);
    expect(w.stats.journeysRecalled).toBe(1);
    expect((w.stats.journeysSucceeded ?? 0) + (w.stats.journeysFailed ?? 0)).toBe(1);
  });

  it('trading post: the player request is filled by sales and the Town still crafts and sells', () => {
    const w = session.sim.world;
    expect(w.town.requests?.['mat.gel'] ?? 0).toBeLessThan(15);
    expect(w.stats.materialsSold).toBeGreaterThan(0);
    expect(w.stats.crafted).toBeGreaterThan(0);
    expect(w.stats.kills).toBeGreaterThan(100);
    expect(w.town.autoInvest).toBe(true);
  });
});

describe('QA-SAVE: save/load in the middle of everything continues identically', () => {
  it('swap the world through serialize/deserialize at 5.5 min (journey away, bounty and construction running)', () => {
    const swapAt = 5.5 * MIN;
    const b = runSession(4, swapAt);
    // The interesting state really was in flight at the swap.
    expect(b.atSwap!.journeys).toBeGreaterThan(0);
    expect(b.atSwap!.bounties).toBeGreaterThan(0);
    expect(b.atSwap!.upgrades).toBeGreaterThan(0);
    expect(JSON.stringify(b.sim.world)).toBe(JSON.stringify(session.sim.world));
    expect(JSON.stringify(b.events)).toBe(JSON.stringify(session.events));
  });
});

describe('QA-OFFLINE: credit on load with a journey and an upgrade in flight', () => {
  /** What the client does on boot (main.ts creditOffline). */
  function load(text: string, now: number) {
    const r0 = deserialize(text, config);
    const sim = new Simulation(config, createWorld(config, 1));
    sim.setWorld(r0.world);
    const r = sim.runBetweenTicks((ctx) => advanceOfflineWallClock(ctx, offlineWallClockMs(r0.savedAt, now)));
    return { sim, r };
  }

  function savedWithJourneyAndUpgrade(): string {
    // A copy of the session world (the shared session must stay untouched for the other checks).
    const s = new Simulation(config, createWorld(config, 1));
    s.setWorld(deserialize(serialize(session.sim.world, T0), config).world);
    const w = s.world;
    // Bring everyone home so a team is available, then start a 10-minute journey and a Town Hall upgrade.
    for (const h of controllable(w)) s.enqueue({ type: 'hunter.move', hunterId: h.id, zoneId: 'town' });
    const def = config.index.journeys.get(JOURNEY)!;
    for (let i = 0; i < 3 * MIN && bestJourneyTeam(config, w, def).length === 0; i++) s.step();
    s.enqueue({ type: 'journey.start', journeyId: JOURNEY, hunterIds: bestJourneyTeam(config, w, def).map((h) => h.id) });
    w.town.gold += 5_000;
    for (const m of config.index.buildings.get('bld.townhall')!.upgradeCost[townHallLevel(config, w)]?.materials ?? []) {
      w.town.storage[m.materialId] = (w.town.storage[m.materialId] ?? 0) + m.count;
    }
    s.world.town.autoInvest = false;
    if (!w.town.buildings.some((b) => b.upgrade)) s.enqueue({ type: 'town.upgrade', buildingInstanceId: 'plot.townhall' });
    s.step();
    const rej = s.drainEvents().filter((e) => e.type === 'commandRejected');
    expect(rej).toEqual([]);
    expect(w.journeys).toHaveLength(1);
    expect(w.town.buildings.some((b) => b.upgrade)).toBe(true);
    return serialize(w, T0);
  }

  let text: string;
  let before: World;
  beforeAll(() => {
    text = savedWithJourneyAndUpgrade();
    before = deserialize(text, config).world;
  });

  it('2 h away: no hunting is credited; the journey resolves and the upgrade finishes on wall-clock time', () => {
    const { sim, r } = load(text, T0 + 2 * 3_600_000);
    const w = sim.world;
    expect(r.awayMs).toBe(2 * 3_600_000);
    expect(r.journeys).toHaveLength(1);
    expect(w.journeys).toEqual([]);
    expect(ofType(sim.drainEvents(), 'journeyCompleted')[0]?.offline).toBe(true);
    const up0 = before.town.buildings.find((b) => b.upgrade)!;
    expect(up0.upgrade!.remainingMs).toBeLessThan(2 * 3_600_000);
    expect(r.buildings.map((b) => b.instanceId)).toContain(up0.id);
    expect(w.town.buildings.find((b) => b.id === up0.id)!.upgrade).toBeNull();
    // Hunters that stayed in Town gained nothing (EHT: no hunting offline); the game time did not move.
    const away = new Set(r.journeys.flatMap((j) => j.hunterIds));
    for (const h0 of before.hunters) {
      if (away.has(h0.id)) continue;
      const h = w.hunters.find((x) => x.id === h0.id)!;
      expect([h.level, h.exp, h.gold, h.kills]).toEqual([h0.level, h0.exp, h0.gold, h0.kills]);
    }
    expect([w.tick, w.timeMs]).toEqual([before.tick, before.timeMs]);
    expect(violations(config, w)).toEqual([]);
    for (let i = 0; i < MIN; i++) sim.step();
    expect(violations(config, sim.world)).toEqual([]);
  });

  it('20 h away: timers use the raw gap (no cap); the journey still resolves', () => {
    const { r } = load(text, T0 + 20 * 3_600_000);
    expect(r.awayMs).toBe(20 * 3_600_000);
    expect(r.journeys).toHaveLength(1);
  });

  it('a clock that went backwards credits nothing and leaves the journey running', () => {
    const { sim, r } = load(text, T0 - 60_000);
    expect(r.awayMs).toBe(0);
    expect(r.journeys).toEqual([]);
    expect(sim.world.journeys).toHaveLength(1);
  });
});

/**
 * Old saves (QA-MIG): a mid-game world stripped back to the shape of each schema version (fields added by the later
 * migrations removed, as the migration table in TECH_SPEC §9 lists them), then loaded: it must reach v9 with every
 * M4 field present and accept the M4 commands.
 */
function downgrade(src: World, v: number): Record<string, any> {
  const w = JSON.parse(JSON.stringify(src)) as Record<string, any>;
  const del = (o: Record<string, any> | undefined, ...keys: string[]) => { if (o) for (const k of keys) delete o[k]; };
  const hunters = w.hunters as Record<string, any>[];
  if (v < 9) { delete w.journeys; del(w.stats, 'journeysStarted', 'journeysSucceeded', 'journeysFailed', 'journeysRecalled', 'journeyGold'); }
  if (v < 8) { del(w.town, 'buildings', 'autoInvest', 'investPlan'); del(w.stats, 'buildingsBuilt', 'buildingUpgrades', 'investGold', 'investMaterials', 'investImportGold'); }
  if (v < 7) { del(w.town, 'bounties', 'autoBounty', 'taxRate'); del(w.stats, 'bountiesPosted', 'bountiesCompleted', 'bountyGoldPaid', 'bountyKingdomGold', 'taxCollected'); }
  if (v < 6) { del(w.town, 'requests'); del(w.stats, 'materialsDiscarded', 'gearScrapped'); }
  if (v < 5) for (const it of w.town.shop) del(it, 'listPrice', 'listedAtMs');
  if (v < 4) {
    for (const h of hunters) del(h, 'rollStats', 'skills', 'skillCdMs', 'traits', 'traitPoints', 'buffs');
    for (const m of w.monsters ?? []) del(m, 'difficultyId');
    del(w.town, 'difficulty', 'unlockedDifficulties', 'autoReincarnate');
    del(w.stats, 'skillCasts', 'jobChanges', 'reincarnations', 'learned');
  }
  if (v < 3) {
    for (const h of hunters) del(h, 'equipment', 'bag');
    del(w.town, 'storage', 'shop', 'crafting', 'autoCraft');
    del(w.stats, 'materialsSold', 'crafted', 'gearBought', 'enhanceTries', 'enhanceSuccess');
  }
  if (v < 2) {
    for (const h of hunters) del(h, 'position', 'nodeId', 'insideBuildingId', 'ai', 'attackCdMs', 'deadMs', 'kills');
    delete w.monsters; delete w.zones; delete w.stats;
  }
  if (v < 1) { del(w.town, 'arrivalTimerMs'); for (const h of hunters) del(h, 'reincarnation'); }
  w.schemaVersion = v;
  return w;
}

describe('QA-MIG: every schema version v0..v8 (and a pre-building v9) loads into a working M4 town', () => {
  let base: World;
  beforeAll(() => {
    const s = new Simulation(config, createWorld(config, 2));
    for (let i = 0; i < 4; i++) s.enqueue({ type: 'debug.spawnHunter' });
    for (let i = 0; i < 4 * MIN; i++) s.step();
    base = s.world;
  });
  const oldSave = (v: number): Record<string, any> => {
    expect(base.journeys).toEqual([]);
    if (v < WORLD_SCHEMA_VERSION) return downgrade(base, v);
    const w = downgrade(base, WORLD_SCHEMA_VERSION); // v9 made before buildings existed
    delete w.town.buildings; delete w.town.autoInvest; delete w.town.investPlan;
    return w;
  };
  const cases: [string, number][] = [];
  for (let v = 0; v < WORLD_SCHEMA_VERSION; v++) cases.push([`v${v}`, v]);
  cases.push(['v9 without buildings', WORLD_SCHEMA_VERSION]);

  it.each(cases)('%s', (_label, version) => {
    const old = oldSave(version);
    const text = JSON.stringify({ format: SAVE_FORMAT, schemaVersion: old.schemaVersion, configVersion: config.version, savedAt: T0, world: old });
    const r = deserialize(text, config);
    const w = r.world;
    expect(w.schemaVersion).toBe(WORLD_SCHEMA_VERSION);
    expect(r.migratedFrom).toBe(old.schemaVersion < WORLD_SCHEMA_VERSION ? old.schemaVersion : null);
    // Every M4 field is there.
    expect(w.journeys).toEqual([]);
    expect(Array.isArray(w.town.bounties)).toBe(true);
    expect(typeof w.town.autoBounty).toBe('boolean');
    expect(w.town.buildings.map((s) => s.id)).toEqual(config.plots.filter((p) => p.startBuilding).map((p) => p.id));
    expect(w.town.autoInvest).toBe(true);
    expect(w.town.requests).toBeDefined();
    expect(taxRate(config, w)).toBe(f.taxRate);
    expect(violations(config, w)).toEqual([]);

    // The M4 commands work on the migrated town.
    const s = new Simulation(config, createWorld(config, 1));
    s.setWorld(w);
    w.town.gold += 5_000;
    w.town.autoInvest = false;
    for (const m of config.index.buildings.get('bld.townhall')!.upgradeCost[townHallLevel(config, w)]?.materials ?? []) {
      w.town.storage[m.materialId] = (w.town.storage[m.materialId] ?? 0) + m.count;
    }
    s.enqueue({ type: 'town.setTaxRate', rate: 0.15 });
    s.enqueue({ type: 'town.postBounty', targetKind: 'zone', targetId: 'zone.meadow', kills: 5, reward: 50 });
    s.enqueue({ type: 'town.requestMaterial', materialId: 'mat.gel', count: 5 });
    if (!w.town.buildings.some((b) => b.upgrade)) s.enqueue({ type: 'town.upgrade', buildingInstanceId: 'plot.townhall' });
    for (const h of controllable(w)) s.enqueue({ type: 'hunter.move', hunterId: h.id, zoneId: 'town' });
    const def = config.index.journeys.get(JOURNEY)!;
    const evs: SimEvent[] = [];
    let journeySent = false;
    for (let i = 0; i < 3 * MIN; i++) {
      if (!journeySent && i > 0) {
        const team = bestJourneyTeam(config, s.world, def);
        if (team.length > 0) { s.enqueue({ type: 'journey.start', journeyId: JOURNEY, hunterIds: team.map((h) => h.id) }); journeySent = true; }
      }
      s.step();
      evs.push(...s.drainEvents());
    }
    expect(evs.filter((e) => e.type === 'commandRejected')).toEqual([]);
    expect(ofType(evs, 'taxRateChanged')).toHaveLength(1);
    expect(ofType(evs, 'bountyPosted').some((e) => !e.auto)).toBe(true);
    expect(ofType(evs, 'buildingStarted').some((e) => !e.auto)).toBe(true);
    expect(ofType(evs, 'journeyStarted')).toHaveLength(1);
    expect(violations(config, s.world)).toEqual([]);
  });
});

describe('QA-CMD: M4 commands reject bad input through commandRejected (the UI contract)', () => {
  it('one representative rejection per command, with its reason', () => {
    const s = new Simulation(config, createWorld(config, 6));
    for (let i = 0; i < 2; i++) s.enqueue({ type: 'debug.spawnHunter' });
    s.step();
    const [a, b] = s.world.hunters;
    const field = config.nodes.find((n) => n.zoneId)!;
    b!.nodeId = field.id;
    b!.position = { x: field.x, y: field.y };
    b!.level = f.maxLevel;
    s.world.town.autoReincarnate = false;
    s.drainEvents();
    const cases: [Command, string][] = [
      [{ type: 'town.setTaxRate', rate: f.taxMaxRate + 0.01 }, 'rate above maximum'],
      [{ type: 'town.setTaxRate', rate: Number.NaN }, 'invalid rate'],
      [{ type: 'town.postBounty', targetKind: 'zone', targetId: 'zone.meadow', kills: 10, reward: s.world.town.gold + 1 }, 'not enough gold'],
      [{ type: 'town.postBounty', targetKind: 'zone', targetId: 'zone.nowhere', kills: 1, reward: 1 }, 'unknown zone'],
      [{ type: 'town.cancelBounty', bountyId: 'b-none' }, 'unknown bounty'],
      [{ type: 'town.requestMaterial', materialId: 'mat.nothing', count: 1 }, 'unknown material'],
      [{ type: 'town.requestMaterial', materialId: 'mat.gel', count: -1 }, 'invalid count'],
      [{ type: 'town.build', buildingId: 'bld.storehouse', plotId: 'plot.ne' }, 'plot locked by Town Hall level'],
      [{ type: 'town.upgrade', buildingInstanceId: 'plot.shop' }, 'locked by Town Hall level'],
      [{ type: 'town.cancelUpgrade', buildingInstanceId: 'plot.shop' }, 'no upgrade in progress'],
      [{ type: 'journey.start', journeyId: JOURNEY, hunterIds: [b!.id] }, 'hunter is not in town'],
      [{ type: 'journey.start', journeyId: 'journey.nowhere', hunterIds: [a!.id] }, 'unknown journey'],
      [{ type: 'journey.recall', journeyUid: 'j-none' }, 'unknown journey'],
      [{ type: 'hunter.reincarnate', hunterId: b!.id }, 'hunter is not in town'],
    ];
    for (const [cmd, reason] of cases) {
      s.enqueue(cmd);
      s.step();
      const rej = s.drainEvents().filter((e) => e.type === 'commandRejected');
      expect(rej, `${cmd.type} → ${reason}`).toEqual([expect.objectContaining({ command: cmd.type, reason })]);
    }
    expect(b!.level).toBe(f.maxLevel);
    expect(b!.reincarnation).toBe(0);
  });
});
