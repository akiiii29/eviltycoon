/**
 * Headless run for tuning (TECH_SPEC §11): npx vite-node tools/headless.ts [minutes] [seed] [snapshotEveryMin]
 * Prints a timeline (town gold, shop items, storage units, hunter gold avg/max, avg level, current difficulty, items in
 * Town gear storage — TECH_SPEC §5.8) every
 * snapshotEveryMin game minutes (default 60) plus the town gold ledger of that window (in: services, shop sales,
 * forge/academy fee cut; out: material purchases, craft gold), the bounty ledger (escrow posted, refunds, paid to hunters,
 * kingdom completion gold), the Town tax on kill gold (`tax`), the building ledger (gold invested in builds/upgrades
 * incl. material imports, refunds, material units consumed; TECH_SPEC §5.12) with every building's level (`*` = upgrade
 * running) and the hunter gold ledger (gross: kill gold before tax, enhance and skill-study spending), then event counts,
 * stats, active bounties, buildings and the final hunter list.
 * Supplies/potions/revive (TECH_SPEC §5.14): per window `supply` = service stockout minutes per service (inf/rest/tav/inn),
 * units served / produced, turned-away arrivals; `potion` = bought / drunk, gold hunters paid (Town cut), HP retreats started
 * while carrying a potion; `revive` = fees paid (Town cut), revives that could not pay. Potion and revive gold are explicit
 * ledger terms (not in `fees`).
 * Env HEADLESS_FP="key=value,..." overrides formula_params for the run (no file is changed), like tools/pacing.ts.
 * Env HEADLESS_JOURNEY="journeyId@minute[xN],..." sends the journeyTeamMax strongest Town hunters (bestJourneyTeam) on
 * that journey from that game minute on, N times in a row (retried each minute until accepted); journey events and
 * active journeys are printed (TECH_SPEC §5.11). Without it no journey is started (output as before journeys existed).
 * M5 hunter systems (TECH_SPEC §4.1): the end prints the waiting queue (size/max, front entries, timers), invitation
 * tickets and every invite / queue / banish / donate event (`hunters` log); each hunter line shows tier and personalities.
 * Env HEADLESS_INVITE="invitationId@minute,..." uses that invitation (town.invite) at that game minute.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadConfig, type RawConfig } from '../src/core/config/load';
import { createWorld, Simulation } from '../src/core/simulation';
import { craftGoldCost } from '../src/core/systems/crafting';
import { bestJourneyTeam } from '../src/core/systems/journey';
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
    `hunterGold avg ${String(avg).padStart(6)} max ${String(Math.max(0, ...gold)).padStart(6)} avgLv ${lv} diff ${w.town.difficulty.replace(/^diff\./, '')} gearStore ${(w.town.gearStorage ?? []).length}`;
}

/** Planned journeys: destination, first minute, launches left; `waiting` = a start command is in flight. */
const plans = (process.env.HEADLESS_JOURNEY ?? '').split(',').filter(Boolean).map((p) => {
  const m = /^([^@]+)@(\d+(?:\.\d+)?)(?:x(\d+))?$/.exec(p.trim());
  if (!m || !config.index.journeys.has(m[1]!)) throw new Error(`HEADLESS_JOURNEY: bad entry "${p}"`);
  return { id: m[1]!, at: Number(m[2]), left: Number(m[3] ?? 1), waiting: false };
});
const journeyLog: string[] = [];
const fmtMin = (tick: number) => `${(tick / 600).toFixed(1)}m`;

const counts: Record<string, number> = {};
const reasons: Record<string, number> = {};
const timeline: string[] = [];
const ledger = { svc: 0, shop: 0, fees: 0, mats: 0, craft: 0 };
/** Bounties (TECH_SPEC §5.9): escrowed when posted, refunds of cancelled/expired ones, kingdom completion gold, paid to hunters. */
const bl = { escrow: 0, refund: 0, kingdom: 0, paid: 0, posted: 0, done: 0 };
const escrowNow = (w: World): number => (w.town.bounties ?? []).reduce((a, b) => a + b.escrow, 0);
/** Buildings (TECH_SPEC §5.12): gold paid for builds/upgrades (incl. imports), refunds of cancelled ones, material units used. */
const inv = { gold: 0, refund: 0, mats: 0, imp: 0, done: 0 };
const short = (id: string) => id.replace(/^bld\./, '');
const levels = (w: World): string =>
  (w.town.buildings ?? []).map((s) => `${short(s.buildingId)}${s.level}${s.upgrade ? '*' : ''}`).join(' ');
/** Hunter side (gross amounts the hunters paid): enhance tries, skill study. Kill gold is the residual of the window. */
const hl = { enh: 0, skill: 0 };
/** Supplies / potions / revive fee (TECH_SPEC §5.14), per window. */
const sp = { potGold: 0, potTown: 0, potBought: 0, potUsed: 0, revFee: 0, revTown: 0, served: 0, made: 0, denied: 0, potRetreat: 0 };
const svcIds = config.buildings.filter((b) => b.supplyCap).map((b) => b.id);
const stockoutMs = (w: World) => svcIds.map((id) => w.town.supply?.[`supply:${id}`]?.stockoutMs ?? 0);
let stockout0 = stockoutMs(sim.world);
/** Town tax taken from kill gold (taxCollected events). */
let tax = 0;
const hunterGold = (w: World): number => w.hunters.reduce((a, h) => a + h.gold, 0);
let hunterGold0 = hunterGold(sim.world);
/** Requested-material spend (approx.: per-tick storage increases × salePrice); the rest of `mats` is surplus export. */
let reqMats = 0;
let prevStorage: Record<string, number> = { ...sim.world.town.storage };
let townGold0 = sim.world.town.gold;
let townGoldMin = Infinity;
const ticks = minutes * 600;
/** HEADLESS_INVITE plan (TECH_SPEC §4.1): invitation id → game minute. */
const invitePlan = (process.env.HEADLESS_INVITE ?? '').split(',').filter(Boolean).map((p) => {
  const m = /^([^@]+)@(\d+)$/.exec(p.trim());
  if (!m || !config.index.invitations.has(m[1]!)) throw new Error(`HEADLESS_INVITE: bad entry "${p}"`);
  return { id: m[1]!, at: Number(m[2]) };
});
const hunterLog: string[] = [];
for (let t = 0; t < ticks; t++) {
  if (t % 600 === 0) {
    for (const p of invitePlan) if (p.at === t / 600) sim.enqueue({ type: 'town.invite', invitationId: p.id });
    for (const p of plans) {
      if (p.left <= 0 || p.waiting || t / 600 < p.at) continue;
      const def = config.index.journeys.get(p.id)!;
      const team = bestJourneyTeam(config, sim.world, def);
      if (team.length < config.formula.journeyTeamMax) continue;
      sim.enqueue({ type: 'journey.start', journeyId: p.id, hunterIds: team.map((h) => h.id) });
      p.waiting = true;
    }
  }
  sim.step();
  const st = sim.world.town.storage;
  for (const k in st) { const d = (st[k] ?? 0) - (prevStorage[k] ?? 0); if (d > 0) reqMats += d * salePrice(config, k); }
  prevStorage = { ...st };
  if (t % 600 === 0) townGoldMin = Math.min(townGoldMin, sim.world.town.gold); // sampled once per game-minute
  for (const e of sim.drainEvents()) {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    if (e.type === 'hunterInvited') hunterLog.push(`${fmtMin(e.tick)} invite ${e.invitationId} ${e.tier} paid ${e.paid}${e.gold ? ` ${e.gold}g` : ''} → ${e.hunterId ?? `queue ${e.queueUid}`}`);
    else if (e.type === 'hunterQueued' && e.source !== 'visitor') hunterLog.push(`${fmtMin(e.tick)} queued ${e.queueUid} ${e.source} pos ${e.position}`);
    else if (e.type === 'hunterArrived' && e.fromQueue) hunterLog.push(`${fmtMin(e.tick)} ${e.hunterId} entered from queue (${e.source})`);
    else if (e.type === 'hunterBanished') hunterLog.push(`${fmtMin(e.tick)} banished ${e.hunterId} items ${e.itemUids.length} gold ${e.gold}`);
    else if (e.type === 'hunterDonated') hunterLog.push(`${fmtMin(e.tick)} donated ${e.gold}g → ${e.hunterId}`);
    else if (e.type === 'commandRejected' && (e.command === 'town.invite' || e.command.startsWith('hunter.'))) hunterLog.push(`${fmtMin(e.tick)} rejected ${e.command}: ${e.reason}`);
    if (e.type === 'journeyStarted' || (e.type === 'commandRejected' && e.command === 'journey.start')) {
      const p = plans.find((x) => x.waiting && (e.type === 'commandRejected' || x.id === e.journeyId));
      if (p) { p.waiting = false; if (e.type === 'journeyStarted') p.left -= 1; }
    }
    if (e.type === 'journeyStarted') {
      const lv = e.hunterIds.map((id) => sim.world.journeys.flatMap((j) => j.hunters).find((h) => h.id === id)?.level ?? '?');
      journeyLog.push(`${fmtMin(e.tick)} start ${e.journeyUid} ${e.journeyId} [${e.hunterIds.map((id, i) => `${id} Lv${lv[i]}`).join(', ')}] power ${e.teamPower.toFixed(2)} chance ${(e.successChance * 100).toFixed(0)}% cost ${e.cost}`);
    } else if (e.type === 'journeyCompleted') {
      const r = e.rewards;
      journeyLog.push(`${fmtMin(e.tick)} done  ${e.journeyUid} ${e.journeyId} ${e.success ? 'SUCCESS' : 'FAIL'} gold ${r.gold} exp ${r.exp}/hunter mats ${JSON.stringify(r.materials)} items ${JSON.stringify(r.items)}`);
    } else if (e.type === 'journeyRecalled') journeyLog.push(`${fmtMin(e.tick)} recall ${e.journeyUid} ${e.journeyId}`);
    else if (e.type === 'commandRejected' && e.command.startsWith('journey.')) journeyLog.push(`${fmtMin(e.tick)} rejected ${e.command}: ${e.reason}`);
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
    else if (e.type === 'taxCollected') tax += e.gold;
    else if (e.type === 'craftStarted') {
      // Gear tier of the job just started (TECH_SPEC §5.8): craft gold × gearPriceMul.
      const g = config.index.gear.get(e.gearId);
      if (g) ledger.craft += craftGoldCost(config, g, sim.world.town.crafting[e.buildingId]?.difficultyId);
    }
    if (e.type === 'potionBought') { sp.potGold += e.gold; sp.potTown += e.townGold; sp.potBought += e.count; }
    else if (e.type === 'potionUsed') sp.potUsed += 1;
    else if (e.type === 'hunterRevived') { sp.revFee += e.fee ?? 0; sp.revTown += e.townGold ?? 0; }
    else if (e.type === 'serviceUsed') sp.served += 1;
    else if (e.type === 'supplyProduced' && config.index.buildings.get(e.buildingId)?.supplyCap && e.consumableId.startsWith('sup.')) sp.made += e.units;
    else if (e.type === 'serviceStockout') sp.denied += 1;
    if (e.type === 'goalChanged' && e.goal === 'returnTown' && /^(retreat hp|urgent hp)/.test(e.reason)) {
      const hh = sim.world.hunters.find((x) => x.id === e.hunterId);
      if (hh && Object.values(hh.potions ?? {}).some((n) => n > 0)) sp.potRetreat += 1;
    }
    if (e.type === 'goalChanged') reasons[`${e.goal.split(':')[0]} <- ${e.reason.split(' ')[0]}`] = (reasons[`${e.goal.split(':')[0]} <- ${e.reason.split(' ')[0]}`] ?? 0) + 1;
  }
  if (snapEvery > 0 && (t + 1) % (snapEvery * 600) === 0) {
    // Fee cut = residual of the town window (the share depends on town gold, see trading.townFeeShare).
    ledger.fees = sim.world.town.gold - townGold0 - ledger.svc - ledger.shop + ledger.mats + ledger.craft + bl.escrow - bl.refund - bl.kingdom + inv.gold - inv.refund - tax - sp.potTown - sp.revTown;
    townGold0 = sim.world.town.gold;
    const kill = hunterGold(sim.world) - hunterGold0 + ledger.svc + ledger.shop + hl.enh + hl.skill - ledger.mats - bl.paid + tax + sp.potGold + sp.revFee;
    const so = stockoutMs(sim.world).map((x, i) => Math.round((x - stockout0[i]!) / 60000));
    stockout0 = stockoutMs(sim.world);
    timeline.push(snapshot(sim.world, (t + 1) / 600) +
      ` | in svc ${ledger.svc} shop ${ledger.shop} fees ${ledger.fees} tax ${tax} out mats ${ledger.mats} (req ${reqMats}) craft ${ledger.craft}` +
      ` | hunter kill ${kill} enh ${hl.enh} skill ${hl.skill} | burned ${hl.enh + hl.skill - ledger.fees + ledger.craft + sp.potGold - sp.potTown + sp.revFee - sp.revTown}` +
      ` | supply stockoutMin [${so.join(' ')}] served ${sp.served} made ${sp.made} denied ${sp.denied}` +
      ` | potion bought ${sp.potBought} used ${sp.potUsed} gold ${sp.potGold} (town ${sp.potTown}) hpRetreatWithPotion ${sp.potRetreat}` +
      ` | revive fees ${sp.revFee} (town ${sp.revTown})` +
      ` total ${sim.world.town.gold + hunterGold(sim.world) + escrowNow(sim.world)} townMin ${townGoldMin}` +
      ` | bounty posted ${bl.posted} done ${bl.done} escrow ${bl.escrow} refund ${bl.refund} paid ${bl.paid} kingdom ${bl.kingdom} held ${escrowNow(sim.world)}` +
      ` | build invest ${inv.gold - inv.refund} (import ${inv.imp}) mats ${inv.mats} done ${inv.done} [${levels(sim.world)}]`);
    inv.gold = inv.refund = inv.mats = inv.imp = inv.done = 0;
    bl.escrow = bl.refund = bl.kingdom = bl.paid = bl.posted = bl.done = 0;
    townGoldMin = Infinity;
    hunterGold0 = hunterGold(sim.world);
    ledger.svc = ledger.shop = ledger.fees = ledger.mats = ledger.craft = 0;
    hl.enh = hl.skill = 0;
    tax = 0;
    reqMats = 0;
    for (const k of Object.keys(sp) as (keyof typeof sp)[]) sp[k] = 0;
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
for (const [k, l] of Object.entries(w.town.supply ?? {})) {
  console.log(`  stock ${k} ${JSON.stringify(l.stock)} job ${l.job ? `${l.job.consumableId} ${Math.ceil(l.job.remainingMs / 1000)}s` : '-'} stockout ${Math.round(l.stockoutMs / 60000)}m`);
}
if (plans.length > 0 || journeyLog.length > 0) {
  console.log('journeys');
  for (const l of journeyLog) console.log('  ' + l);
  for (const j of w.journeys ?? []) {
    console.log(`  active ${j.id} ${j.journeyId} [${j.hunters.map((h) => h.id).join(', ')}] left ${Math.round(j.remainingMs / 1000)}s power ${j.teamPower.toFixed(2)} chance ${(j.successChance * 100).toFixed(0)}%`);
  }
}
for (const b of w.town.bounties ?? []) {
  console.log(`bounty ${b.id} ${b.auto ? 'auto' : 'player'} ${b.targetKind}:${b.targetId} ${b.progress}/${b.kills} reward ${b.reward} escrow ${b.escrow} age ${Math.round((w.timeMs - b.postedAtMs) / 60000)}m`);
}
if ((w.town as { requests?: unknown }).requests) console.log('requests', (w.town as { requests?: unknown }).requests);
console.log(`buildings [${levels(w)}] autoInvest ${w.town.autoInvest} plan ${w.town.investPlan ? JSON.stringify(w.town.investPlan) : '-'}`);
for (const s of w.town.buildings ?? []) {
  if (s.upgrade) console.log(`  building ${s.id} ${s.buildingId} Lv${s.level} → ${s.upgrade.toLevel} ${Math.ceil(s.upgrade.remainingMs / 1000)}s left`);
}
{
  const q = w.town.queue ?? [];
  const f = config.formula;
  console.log(`queue ${q.length}/${f.queueMax} front [${q.slice(0, 5).map((e) => `${e.uid}:${e.source}${e.tier ? '/' + e.tier : ''}`).join(', ')}] queueTimer ${Math.round((w.town.queueTimerMs ?? 0) / 1000)}s autoInviteTimer ${Math.round((w.town.autoInviteTimerMs ?? 0) / 1000)}s tickets ${JSON.stringify(w.town.tickets ?? {})}`);
  console.log(`invites ${w.stats.invites ?? 0} (gold ${w.stats.inviteGold ?? 0}) auto ${w.stats.autoInvites ?? 0} queue joined ${w.stats.queueJoined ?? 0} entered ${w.stats.queueEntered ?? 0} banished ${w.stats.banished ?? 0} donated ${w.stats.donatedGold ?? 0}g`);
  if (hunterLog.length) { console.log('hunters'); for (const l of hunterLog) console.log('  ' + l); }
}
for (const h of w.hunters) {
  const n = h.needs;
  const eq = Object.entries(h.equipment).map(([s, g]) => `${s}:${g!.gearId.split('.').pop()}/${g!.qualityId.slice(2)}+${g!.enhance}${g!.difficultyId && g!.difficultyId !== config.difficulties[0]!.id ? '@' + g!.difficultyId.replace(/^diff\./, '') : ''}`).join(' ');
  console.log(`${h.id} ${h.tier} [${h.personalities.map((p) => p.replace(/^pers\./, '')).join(',')}] Lv${h.level} gold ${h.gold} kills ${h.kills} [${eq}] potions ${JSON.stringify(h.potions ?? {})} goal ${h.ai.goal ? JSON.stringify(h.ai.goal) : '-'} ${h.ai.phase} hp ${(n.hp / h.stats.hp * 100).toFixed(0)}% sat ${n.satiety.toFixed(0)} mood ${n.mood.toFixed(0)} sta ${n.stamina.toFixed(0)}`);
}
