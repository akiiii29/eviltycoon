/**
 * Headless run for tuning (TECH_SPEC §11): npx vite-node tools/headless.ts [minutes] [seed] [snapshotEveryMin]
 * Prints a timeline (town gold, shop items, storage units, hunter gold avg/max, avg level) every
 * snapshotEveryMin game minutes (default 60) plus the town gold ledger of that window (in: services, shop sales,
 * forge/academy fee cut; out: material purchases, craft gold), the bounty ledger (escrow posted, refunds, paid to hunters,
 * kingdom completion gold), the building ledger (gold invested in builds/upgrades incl. material imports, refunds,
 * material units consumed; TECH_SPEC §5.10) with every building's level (`*` = upgrade running) and the hunter gold ledger
 * (gross: kill gold, enhance and skill-study spending), then event counts, stats, active bounties, buildings and the final
 * hunter list.
 * Env HEADLESS_FP="key=value,..." overrides formula_params for the run (no file is changed), like tools/pacing.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadConfig, type RawConfig } from '../src/core/config/load';
import { createWorld, Simulation } from '../src/core/simulation';
import { salePrice } from '../src/core/systems/trading';
import type { World } from '../src/core/world';

const minutes = Number(process.argv[2] ?? 20);
const seed = Number(process.argv[3] ?? 1);
const snapEvery = Number(process.argv[4] ?? 60);
const dir = join(process.cwd(), 'config');
const raw: Record<string, unknown> = {};
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) raw[basename(f, '.json')] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
for (const kv of (process.env.HEADLESS_FP ?? '').split(',').filter(Boolean)) {
  const [k, v] = kv.split('=');
  (raw.formula_params as Record<string, number>)[k!.trim()] = Number(v);
}
const config = loadConfig(raw as RawConfig);
const sim = new Simulation(config, createWorld(config, seed));
for (let i = 0; i < config.formula.hunterSlots; i++) sim.enqueue({ type: 'debug.spawnHunter' });

function snapshot(w: World, min: number): string {
  const hs = w.hunters;
  const gold = hs.map((h) => h.gold);
  const avg = gold.length ? Math.round(gold.reduce((a, b) => a + b, 0) / gold.length) : 0;
  const lv = hs.length ? (hs.reduce((a, h) => a + h.level, 0) / hs.length).toFixed(1) : '0';
  let storage = 0;
  for (const k in w.town.storage) storage += w.town.storage[k]!;
  let bags = 0;
  for (const h of hs) for (const k in h.bag) bags += h.bag[k]!;
  const req = (w.town as { requests?: Record<string, number> }).requests;
  let reqUnits = 0;
  if (req) for (const k in req) reqUnits += req[k]!;
  return `t=${String(min).padStart(4)}m townGold ${String(w.town.gold).padStart(6)} shop ${String(w.town.shop.length).padStart(2)} ` +
    `storage ${String(storage).padStart(4)} bags ${String(bags).padStart(4)} requests ${String(reqUnits).padStart(3)} ` +
    `hunterGold avg ${String(avg).padStart(6)} max ${String(Math.max(0, ...gold)).padStart(6)} avgLv ${lv}`;
}

const counts: Record<string, number> = {};
const reasons: Record<string, number> = {};
const timeline: string[] = [];
const ledger = { svc: 0, shop: 0, fees: 0, mats: 0, craft: 0 };
/** Bounties (TECH_SPEC §5.9): escrowed when posted, refunds of cancelled/expired ones, kingdom completion gold, paid to hunters. */
const bl = { escrow: 0, refund: 0, kingdom: 0, paid: 0, posted: 0, done: 0 };
const escrowNow = (w: World): number => (w.town.bounties ?? []).reduce((a, b) => a + b.escrow, 0);
/** Buildings (TECH_SPEC §5.10): gold paid for builds/upgrades (incl. imports), refunds of cancelled ones, material units used. */
const inv = { gold: 0, refund: 0, mats: 0, imp: 0, done: 0 };
const short = (id: string) => id.replace(/^bld\./, '');
const levels = (w: World): string =>
  (w.town.buildings ?? []).map((s) => `${short(s.buildingId)}${s.level}${s.upgrade ? '*' : ''}`).join(' ');
/** Hunter side (gross amounts the hunters paid): enhance tries, skill study. Kill gold is the residual of the window. */
const hl = { enh: 0, skill: 0 };
const hunterGold = (w: World): number => w.hunters.reduce((a, h) => a + h.gold, 0);
let hunterGold0 = hunterGold(sim.world);
/** Requested-material spend (approx.: per-tick storage increases × salePrice); the rest of `mats` is surplus export. */
let reqMats = 0;
let prevStorage: Record<string, number> = { ...sim.world.town.storage };
let townGold0 = sim.world.town.gold;
let townGoldMin = Infinity;
const ticks = minutes * 600;
for (let t = 0; t < ticks; t++) {
  sim.step();
  const st = sim.world.town.storage;
  for (const k in st) { const d = (st[k] ?? 0) - (prevStorage[k] ?? 0); if (d > 0) reqMats += d * salePrice(config, k); }
  prevStorage = { ...st };
  if (t % 600 === 0) townGoldMin = Math.min(townGoldMin, sim.world.town.gold); // sampled once per game-minute
  for (const e of sim.drainEvents()) {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    if (e.type === 'serviceUsed') ledger.svc += e.price;
    else if (e.type === 'gearBought') ledger.shop += e.price;
    else if (e.type === 'enhanceResult' || (e.type === 'learned' && e.kind === 'skill')) {
      if (e.type === 'enhanceResult') hl.enh += e.cost;
      else hl.skill += e.cost;
    }
    else if (e.type === 'materialsSold') ledger.mats += e.gold;
    else if (e.type === 'bountyPosted') { bl.escrow += e.reward; bl.posted += 1; }
    else if (e.type === 'bountyCancelled') bl.refund += e.refund;
    else if (e.type === 'bountyCompleted') { bl.kingdom += e.kingdomGold; bl.done += 1; }
    else if (e.type === 'bountyProgress') bl.paid += e.gold;
    else if (e.type === 'buildingStarted') { inv.gold += e.gold; inv.mats += e.materials; inv.imp += e.importGold; }
    else if (e.type === 'buildingCancelled') inv.refund += e.refund;
    else if (e.type === 'buildingCompleted') inv.done += 1;
    else if (e.type === 'craftStarted') ledger.craft += Math.round((config.index.gear.get(e.gearId)?.basePrice ?? 0) * config.formula.craftGoldFrac);
    if (e.type === 'goalChanged') reasons[`${e.goal.split(':')[0]} <- ${e.reason.split(' ')[0]}`] = (reasons[`${e.goal.split(':')[0]} <- ${e.reason.split(' ')[0]}`] ?? 0) + 1;
  }
  if (snapEvery > 0 && (t + 1) % (snapEvery * 600) === 0) {
    // Fee cut = residual of the town window (the share depends on town gold, see trading.townFeeShare).
    ledger.fees = sim.world.town.gold - townGold0 - ledger.svc - ledger.shop + ledger.mats + ledger.craft + bl.escrow - bl.refund - bl.kingdom + inv.gold - inv.refund;
    townGold0 = sim.world.town.gold;
    const kill = hunterGold(sim.world) - hunterGold0 + ledger.svc + ledger.shop + hl.enh + hl.skill - ledger.mats - bl.paid;
    timeline.push(snapshot(sim.world, (t + 1) / 600) +
      ` | in svc ${ledger.svc} shop ${ledger.shop} fees ${ledger.fees} out mats ${ledger.mats} (req ${reqMats}) craft ${ledger.craft}` +
      ` | hunter kill ${kill} enh ${hl.enh} skill ${hl.skill} | burned ${hl.enh + hl.skill - ledger.fees + ledger.craft}` +
      ` total ${sim.world.town.gold + hunterGold(sim.world) + escrowNow(sim.world)} townMin ${townGoldMin}` +
      ` | bounty posted ${bl.posted} done ${bl.done} escrow ${bl.escrow} refund ${bl.refund} paid ${bl.paid} kingdom ${bl.kingdom} held ${escrowNow(sim.world)}` +
      ` | build invest ${inv.gold - inv.refund} (import ${inv.imp}) mats ${inv.mats} done ${inv.done} [${levels(sim.world)}]`);
    inv.gold = inv.refund = inv.mats = inv.imp = inv.done = 0;
    bl.escrow = bl.refund = bl.kingdom = bl.paid = bl.posted = bl.done = 0;
    townGoldMin = Infinity;
    hunterGold0 = hunterGold(sim.world);
    ledger.svc = ledger.shop = ledger.fees = ledger.mats = ledger.craft = 0;
    hl.enh = hl.skill = 0;
    reqMats = 0;
  }
}
const w = sim.world;
console.log(`${minutes} game min, seed ${seed}`);
console.log('timeline');
for (const l of timeline) console.log('  ' + l);
console.log('events', counts);
console.log('goal changes', reasons);
console.log('stats', w.stats, 'town gold', w.town.gold, 'shop items', w.town.shop.length, 'monsters', w.monsters.length);
console.log('storage', w.town.storage);
for (const b of w.town.bounties ?? []) {
  console.log(`bounty ${b.id} ${b.auto ? 'auto' : 'player'} ${b.targetKind}:${b.targetId} ${b.progress}/${b.kills} reward ${b.reward} escrow ${b.escrow} age ${Math.round((w.timeMs - b.postedAtMs) / 60000)}m`);
}
if ((w.town as { requests?: unknown }).requests) console.log('requests', (w.town as { requests?: unknown }).requests);
console.log(`buildings [${levels(w)}] autoInvest ${w.town.autoInvest} plan ${w.town.investPlan ? JSON.stringify(w.town.investPlan) : '-'}`);
for (const s of w.town.buildings ?? []) {
  if (s.upgrade) console.log(`  building ${s.id} ${s.buildingId} Lv${s.level} → ${s.upgrade.toLevel} ${Math.ceil(s.upgrade.remainingMs / 1000)}s left`);
}
for (const h of w.hunters) {
  const n = h.needs;
  const eq = Object.entries(h.equipment).map(([s, g]) => `${s}:${g!.gearId.split('.').pop()}/${g!.qualityId.slice(2)}+${g!.enhance}`).join(' ');
  console.log(`${h.id} Lv${h.level} gold ${h.gold} kills ${h.kills} [${eq}] goal ${h.ai.goal ? JSON.stringify(h.ai.goal) : '-'} ${h.ai.phase} hp ${(n.hp / h.stats.hp * 100).toFixed(0)}% sat ${n.satiety.toFixed(0)} mood ${n.mood.toFixed(0)} sta ${n.stamina.toFixed(0)}`);
}
