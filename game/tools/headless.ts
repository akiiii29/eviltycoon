/**
 * Headless run for tuning (TECH_SPEC §11): npx vite-node tools/headless.ts [minutes] [seed] [snapshotEveryMin]
 * Prints a timeline (town gold, shop items, storage units, hunter gold avg/max, avg level) every
 * snapshotEveryMin game minutes (default 60) plus the town gold ledger of that window (in: services, shop sales,
 * forge/academy fee cut; out: material purchases, craft gold), then event counts, stats and the final hunter list.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadConfig, type RawConfig } from '../src/core/config/load';
import { createWorld, Simulation } from '../src/core/simulation';
import type { World } from '../src/core/world';

const minutes = Number(process.argv[2] ?? 20);
const seed = Number(process.argv[3] ?? 1);
const snapEvery = Number(process.argv[4] ?? 60);
const dir = join(process.cwd(), 'config');
const raw: Record<string, unknown> = {};
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) raw[basename(f, '.json')] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
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
const share = config.formula.feeTownShare;
const ticks = minutes * 600;
for (let t = 0; t < ticks; t++) {
  sim.step();
  for (const e of sim.drainEvents()) {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    if (e.type === 'serviceUsed') ledger.svc += e.price;
    else if (e.type === 'gearBought') ledger.shop += e.price;
    else if (e.type === 'enhanceResult' || (e.type === 'learned' && e.kind === 'skill')) ledger.fees += Math.round(e.cost * share);
    else if (e.type === 'materialsSold') ledger.mats += e.gold;
    else if (e.type === 'craftStarted') ledger.craft += Math.round((config.index.gear.get(e.gearId)?.basePrice ?? 0) * config.formula.craftGoldFrac);
    if (e.type === 'goalChanged') reasons[`${e.goal.split(':')[0]} <- ${e.reason.split(' ')[0]}`] = (reasons[`${e.goal.split(':')[0]} <- ${e.reason.split(' ')[0]}`] ?? 0) + 1;
  }
  if (snapEvery > 0 && (t + 1) % (snapEvery * 600) === 0) {
    timeline.push(snapshot(sim.world, (t + 1) / 600) +
      ` | in svc ${ledger.svc} shop ${ledger.shop} fees ${ledger.fees} out mats ${ledger.mats} craft ${ledger.craft}`);
    ledger.svc = ledger.shop = ledger.fees = ledger.mats = ledger.craft = 0;
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
if ((w.town as { requests?: unknown }).requests) console.log('requests', (w.town as { requests?: unknown }).requests);
for (const h of w.hunters) {
  const n = h.needs;
  const eq = Object.entries(h.equipment).map(([s, g]) => `${s}:${g!.gearId.split('.').pop()}/${g!.qualityId.slice(2)}+${g!.enhance}`).join(' ');
  console.log(`${h.id} Lv${h.level} gold ${h.gold} kills ${h.kills} [${eq}] goal ${h.ai.goal ? JSON.stringify(h.ai.goal) : '-'} ${h.ai.phase} hp ${(n.hp / h.stats.hp * 100).toFixed(0)}% sat ${n.satiety.toFixed(0)} mood ${n.mood.toFixed(0)} sta ${n.stamina.toFixed(0)}`);
}
