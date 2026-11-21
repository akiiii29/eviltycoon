/**
 * Combat / zone-model accuracy report (TECH_SPEC §5.2, §5.3): npx vite-node tools/combat-report.ts [minutes] [seed]
 * Env REPORT_FP="key=value,..." overrides formula_params for the run (no file is changed), like tools/pacing.ts.
 * Prints, per zone, while a hunter's goal is to hunt that zone and it stands in it:
 *   kills, measured HP lost per kill, the AI's prediction (zoneDanger.dmgPerKill = crowd × duel) and the bare duel,
 *   measured / predicted, kills per full HP bar (measured) vs killsPerLife (predicted);
 * then deaths by zone with the hunter's goal and the reason of its last goal change, and HP lost on trips home
 * (from the returnTown decision to reaching town) vs the predicted trip cost (tripHomeDamage).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { dangerCache, tripHomeDamage, zoneDanger } from '../src/core/ai/utility';
import { loadConfig, type RawConfig } from '../src/core/config/load';
import { GEAR_SLOTS } from '../src/core/config/types';
import { duel, hunterStats, monsterTypeStats, moodStatMult, needMax } from '../src/core/formulas';
import { NavGraph } from '../src/core/pathfinding';
import { createWorld, Simulation } from '../src/core/simulation';

const minutes = Number(process.argv[2] ?? 720);
const seed = Number(process.argv[3] ?? 1);
const dir = join(process.cwd(), 'config');
const raw: Record<string, unknown> = {};
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) raw[basename(f, '.json')] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
for (const kv of (process.env.REPORT_FP ?? '').split(',').filter(Boolean)) {
  const [k, v] = kv.split('=');
  (raw.formula_params as Record<string, number>)[k!.trim()] = Number(v);
}
const config = loadConfig(raw as RawConfig);
const nav = new NavGraph(config);
const sim = new Simulation(config, createWorld(config, seed));
for (let i = 0; i < config.formula.hunterSlots; i++) sim.enqueue({ type: 'debug.spawnHunter' });

interface Acc { kills: number; taken: number; pred: number; duel: number; hpBars: number; ticks: number; engaged: number; busy: number; hunters: number; own: number; lag: number }
const acc: Record<string, Acc> = {};
const zoneOf = (nodeId: string) => config.index.nodes.get(nodeId)?.zoneId;
/** Hunter level − mean level of its equipped gear (empty slot = level 0). */
const gearLag = (h: { level: number; equipment: Record<string, { gearId: string } | undefined> }) => {
  let s = 0;
  for (const slot of GEAR_SLOTS) s += config.index.gear.get(h.equipment[slot]?.gearId ?? '')?.level ?? 0;
  return h.level - s / 3;
};
const lastChange = new Map<string, { reason: string; goal: string; tick: number; hp: number; on: number }>();
const deaths: { zone: string; goal: string; reason: string; sinceSec: number; hpAtChange: number; level: number; on: number; gearLag: number; min: number }[] = [];
/** Trips home: HP lost from the returnTown decision (in a zone) to arrival in town, vs prediction. */
const trips = new Map<string, { zone: string; hp0: number; pred: number; maxHp: number; midFight: boolean }>();
const tripStats: Record<string, { n: number; lost: number; pred: number; ratios: number[]; deaths: number; low: number }> = {};

const ticks = minutes * 600;
/** Same accumulators by (zone, n): n = hunters whose goal is to hunt that zone (what zoneScores counts). */
const bins: Record<string, { kills: number; taken: number; duel: number; pred: number; alive: number; ticks: number }> = {};
let goalCount: Record<string, number> = {};
let aliveCount: Record<string, number> = {};
const ownTarget = new Map<string, string>();
const firsts: { lv20?: number; lv50?: number; reinc?: number } = {};
/** Goal changes to `enhance` per hunter (TODO §2: reckless hunters enhance less). */
const enhanceGoals = new Map<string, number>();
/** Mood while hunting (hunter in the zone its goal hunts), per hunter-tick: Σ mood frac, ticks under moodPenaltyFrac, Σ live mood mult. */
const moodAcc = { ticks: 0, frac: 0, low: 0, mult: 0, tavern: 0, zoneSwitch: 0 };
const lastHunt = new Map<string, string>();
for (let t = 0; t < ticks; t++) {
  sim.step();
  const w = sim.world;
  for (const e of sim.drainEvents()) {
    if (e.type === 'goalChanged') {
      if (e.goal.startsWith('hunt:')) {
        const prev = lastHunt.get(e.hunterId);
        if (prev && prev !== e.goal && zoneOf(w.hunters.find((x) => x.id === e.hunterId)!.nodeId)) moodAcc.zoneSwitch++;
        lastHunt.set(e.hunterId, e.goal);
      }
      if (e.goal.startsWith('service:') && config.index.buildings.get(e.goal.slice(8))?.need === 'mood') moodAcc.tavern++;
      if (e.goal.startsWith('enhance:')) enhanceGoals.set(e.hunterId, (enhanceGoals.get(e.hunterId) ?? 0) + 1);
      const h = w.hunters.find((x) => x.id === e.hunterId)!;
      lastChange.set(h.id, { reason: e.reason, goal: e.goal, tick: w.tick, hp: h.needs.hp / needMax(config, h, 'hp'), on: w.monsters.filter((m) => m.targetHunterId === h.id && m.hp > 0 && m.zoneId === zoneOf(h.nodeId)).length });
      const z = zoneOf(h.nodeId);
      if (e.goal === 'returnTown' && z) {
        const c = dangerCache(config, h, w);
        const pred = tripHomeDamage(config, nav, h, h.position, nav.nearest(h.position), w.town.difficulty, c);
        const midFight = w.monsters.some((m) => m.targetHunterId === h.id && m.hp > 0);
        trips.set(h.id, { zone: z, hp0: h.needs.hp, pred, maxHp: c.maxHp, midFight });
      } else trips.delete(h.id);
      continue;
    }
    if (e.type === 'levelUp') {
      if (e.level >= 20) firsts.lv20 ??= w.tick / 600;
      if (e.level >= 50) firsts.lv50 ??= w.tick / 600;
      continue;
    }
    if (e.type === 'reincarnated') { firsts.reinc ??= w.tick / 600; continue; }
    if (e.type === 'hunterDied') {
      const h = w.hunters.find((x) => x.id === e.hunterId)!;
      const lc = lastChange.get(h.id);
      const z = zoneOf(h.nodeId) ?? 'town';
      deaths.push({ zone: z, goal: lc?.goal ?? '-', reason: lc?.reason ?? '-', sinceSec: lc ? (w.tick - lc.tick) / 10 : -1, hpAtChange: lc?.hp ?? -1, level: h.level, on: lc?.on ?? -1, gearLag: gearLag(h), min: Math.floor(w.tick / 600) });
      const tr = trips.get(h.id);
      if (tr) {
        const k = `${tr.zone}${tr.midFight ? ' fight' : ' calm'}`;
        const s = (tripStats[k] ??= { n: 0, lost: 0, pred: 0, ratios: [], deaths: 0, low: 0 });
        s.deaths++;
        trips.delete(h.id);
      }
      continue;
    }
    if (e.type !== 'hit' && e.type !== 'monsterKilled') continue;
    const hid = e.type === 'hit' ? e.targetId : e.hunterId;
    const h = w.hunters.find((x) => x.id === hid);
    const g = h?.ai.goal;
    if (!h || g?.type !== 'hunt' || zoneOf(h.nodeId) !== g.zoneId) continue;
    const a = (acc[g.zoneId] ??= { kills: 0, taken: 0, pred: 0, duel: 0, hpBars: 0, ticks: 0, engaged: 0, busy: 0, hunters: 0, own: 0, lag: 0 });
    const b = (bins[`${g.zoneId}|${goalCount[g.zoneId] ?? 1}`] ??= { kills: 0, taken: 0, duel: 0, pred: 0, alive: 0, ticks: 0 });
    if (e.type === 'hit') { if (!e.evaded) b.taken += e.damage; }
    if (e.type === 'hit') {
      if (!e.evaded) { a.taken += e.damage; a.hpBars += e.damage / needMax(config, h, 'hp'); }
    } else {
      a.kills++;
      if (e.type === 'monsterKilled' && ownTarget.get(e.monsterId) === h.id) a.own++;
      const pk = zoneDanger(config, h, g.zoneId, w.town.difficulty, dangerCache(config, h, w)).dmgPerKill;
      a.pred += pk; b.pred += pk;
      const s = hunterStats(config, h, { steady: true });
      const z = config.index.zones.get(g.zoneId)!;
      let wsum = 0, d = 0;
      for (const m of z.monsters) { wsum += m.weight; d += m.weight * duel(config, h, s, monsterTypeStats(config, m.monsterId, w.town.difficulty)).dmgPerKill; }
      a.duel += d / wsum;
      b.kills++; b.duel += d / wsum;
    }
  }
  goalCount = {}; aliveCount = {};
  for (const h of w.hunters) { const g = h.ai.goal; if (g?.type === 'hunt') goalCount[g.zoneId] = (goalCount[g.zoneId] ?? 0) + 1; }
  for (const m of w.monsters) aliveCount[m.zoneId] = (aliveCount[m.zoneId] ?? 0) + 1;
  for (const h of w.hunters) {
    const g = h.ai.goal;
    if (g?.type !== 'hunt' || zoneOf(h.nodeId) !== g.zoneId) continue;
    const b = (bins[`${g.zoneId}|${goalCount[g.zoneId]}`] ??= { kills: 0, taken: 0, duel: 0, pred: 0, alive: 0, ticks: 0 });
    b.ticks++; b.alive += aliveCount[g.zoneId] ?? 0;
  }
  // Engagement: monsters targeting each hunting hunter, in attack range.
  const inZone: Record<string, number> = {};
  for (const h of w.hunters) { const g = h.ai.goal; if (g?.type === 'hunt' && zoneOf(h.nodeId) === g.zoneId) inZone[g.zoneId] = (inZone[g.zoneId] ?? 0) + 1; }
  ownTarget.clear();
  for (const m of w.monsters) if (m.targetHunterId) ownTarget.set(m.id, m.targetHunterId);
  for (const h of w.hunters) {
    const g = h.ai.goal;
    if (g?.type !== 'hunt' || zoneOf(h.nodeId) !== g.zoneId) continue;
    const a = (acc[g.zoneId] ??= { kills: 0, taken: 0, pred: 0, duel: 0, hpBars: 0, ticks: 0, engaged: 0, busy: 0, hunters: 0, own: 0, lag: 0 });
    let n = 0;
    for (const m of w.monsters) if (m.targetHunterId === h.id && Math.hypot(m.position.x - h.position.x, m.position.y - h.position.y) <= config.formula.attackRange) n++;
    const mf = h.needs.mood / config.formula.needMax;
    moodAcc.ticks++; moodAcc.frac += mf; moodAcc.mult += moodStatMult(mf, config.formula); if (mf < config.formula.moodPenaltyFrac) moodAcc.low++;
    a.ticks++; a.lag += gearLag(h); a.engaged += n; if (n > 0) a.busy++; a.hunters += inZone[g.zoneId]!;
  }
  // Trips that reached town.
  for (const h of w.hunters) {
    const tr = trips.get(h.id);
    if (!tr || zoneOf(h.nodeId)) continue;
    const k = `${tr.zone}${tr.midFight ? ' fight' : ' calm'}`;
    const s = (tripStats[k] ??= { n: 0, lost: 0, pred: 0, ratios: [], deaths: 0, low: 0 });
    const lost = Math.max(0, tr.hp0 - h.needs.hp);
    s.n++; s.lost += lost; if (h.needs.hp / tr.maxHp < 0.1) s.low++; s.pred += tr.pred; s.ratios.push(tr.pred > 0 ? lost / tr.pred : 0);
    trips.delete(h.id);
  }
}

const short = (id: string) => id.replace(/^zone\./, '');
console.log(`seed ${seed}, ${minutes} min: deaths ${sim.world.stats.deaths}`);
console.log('zone      kills  HP/kill  pred  duel  meas/pred meas/duel  kills/HPbar  engaged busy attackers/busy hunters ownKill gearLag');
for (const z of config.zones) {
  const a = acc[z.id];
  if (!a || a.kills === 0) continue;
  const m = a.taken / a.kills, p = a.pred / a.kills, d = a.duel / a.kills;
  console.log(`${short(z.id).padEnd(9)} ${String(a.kills).padStart(6)} ${m.toFixed(1).padStart(8)} ${p.toFixed(1).padStart(5)} ${d.toFixed(1).padStart(5)}  ${(m / p).toFixed(2).padStart(8)} ${(m / d).toFixed(2).padStart(9)}  ${(a.kills / Math.max(a.hpBars, 1e-9)).toFixed(1).padStart(10)}  ${(a.engaged / a.ticks).toFixed(2).padStart(7)} ${(a.busy / a.ticks).toFixed(2)} ${(a.engaged / Math.max(1, a.busy)).toFixed(2).padStart(6)} ${(a.hunters / a.ticks).toFixed(1).padStart(6)} ${(a.own / a.kills).toFixed(2)} ${(a.lag / a.ticks).toFixed(1).padStart(5)}`);
}
const dz: Record<string, number> = {};
for (const d of deaths) dz[d.zone] = (dz[d.zone] ?? 0) + 1;
console.log(`deaths by zone ${JSON.stringify(dz)}`);
for (const d of deaths) console.log(`  death t${d.min}m ${short(d.zone)} L${d.level} gearLag ${d.gearLag.toFixed(0)} goal ${d.goal} (${d.reason}) ${d.sinceSec.toFixed(1)}s after change at hp ${d.hpAtChange.toFixed(2)} attackers ${d.on}`);
console.log('trips home: zone start  n  lost/pred(mean) p50 p90 p99 deaths arrived<10%');
for (const [k, s] of Object.entries(tripStats).sort()) {
  const r = s.ratios.sort((a, b) => a - b);
  const q = (p: number) => (r.length ? r[Math.floor(p * (r.length - 1))]!.toFixed(2) : '-');
  console.log(`  ${k.padEnd(16)} ${String(s.n).padStart(5)} ${(s.lost / Math.max(s.pred, 1e-9)).toFixed(2)} ${q(0.5)} ${q(0.9)} ${q(0.99)} ${s.deaths} ${s.low}`);
}
console.log('bins: zone|n kills meas/duel alive');
for (const [k, b] of Object.entries(bins).sort()) if (b.kills >= 30) console.log(`  BIN ${k} ${b.kills} ${(b.taken / b.duel).toFixed(3)} pred ${(b.taken / b.pred).toFixed(3)} ${(b.alive / Math.max(1, b.ticks)).toFixed(1)} ${b.taken.toFixed(0)} ${b.duel.toFixed(0)}`);
let tripN = 0, tripLow = 0, tripDeaths = 0;
for (const s of Object.values(tripStats)) { tripN += s.n; tripLow += s.low; tripDeaths += s.deaths; }
const fm = (v?: number) => (v === undefined ? 'never' : `${v.toFixed(0)}m`);
console.log(`TOTAL deaths ${sim.world.stats.deaths} lv20 ${fm(firsts.lv20)} lv50 ${fm(firsts.lv50)} reinc ${fm(firsts.reinc)} trip deaths ${tripDeaths} trips ${tripN} arrived<10% ${tripLow}`);
const reck = sim.world.hunters.filter((h) => h.personalities.includes('pers.reckless'));
const rest = sim.world.hunters.filter((h) => !h.personalities.includes('pers.reckless'));
const avgEnh = (hs: typeof reck) => (hs.length ? (hs.reduce((a, h) => a + (enhanceGoals.get(h.id) ?? 0), 0) / hs.length).toFixed(0) : '-');
console.log(`ENHANCE goals/hunter: reckless ${avgEnh(reck)} (${reck.length}) others ${avgEnh(rest)} (${rest.length})`);
const mt = Math.max(1, moodAcc.ticks);
console.log(`MOOD while hunting: mean ${(moodAcc.frac / mt).toFixed(3)} under-penalty ${(moodAcc.low / mt).toFixed(3)} mean stat mult ${(moodAcc.mult / mt).toFixed(4)} tavern visits/hunter-hour ${(moodAcc.tavern / (sim.world.hunters.length * minutes / 60)).toFixed(2)} field zone switches/hunter-hour ${(moodAcc.zoneSwitch / (sim.world.hunters.length * minutes / 60)).toFixed(2)}`);
