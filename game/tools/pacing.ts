/**
 * Progression pacing report: npx vite-node tools/pacing.ts [minutes] [seed] [intervalMin] [townGoldFloor]
 * Env PACING_FP="key=value,..." overrides formula_params for the run (sensitivity sweeps).
 * Optional 4th arg townGoldFloor (default 0 = off): sensitivity knob that tops Town gold up to that floor every
 * game-minute, to see how pacing behaves when the economy is not gold-starved. Not a gameplay feature.
 * Runs the default Simulation with `hunterSlots` hunters (Easy difficulty) and prints, every interval
 * (default 30 game-minutes): max/median level, hunters that ever reached Lv20 / Lv50 / reincarnated,
 * the zone each hunter is hunting (with its power ratio for that zone, formulas.powerRatio) and the best gear level equipped,
 * plus Town building levels (TECH_SPEC §5.11; `*` = upgrade running) and the max craftable gear level (smithy/jeweler).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadConfig, type RawConfig } from '../src/core/config/load';
import { hunterPower, powerRatio } from '../src/core/formulas';
import { createWorld, Simulation } from '../src/core/simulation';
import { craftMaxGearLevel } from '../src/core/systems/town';

const minutes = Number(process.argv[2] ?? 120);
const seed = Number(process.argv[3] ?? 1);
const interval = Number(process.argv[4] ?? 30);
const townGoldFloor = Number(process.argv[5] ?? 0);
const dir = join(process.cwd(), 'config');
const raw: Record<string, unknown> = {};
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) raw[basename(f, '.json')] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
// Tuning knob: PACING_FP="key=value,key=value" overrides formula_params for this run only (no file is changed).
for (const kv of (process.env.PACING_FP ?? '').split(',').filter(Boolean)) {
  const [k, v] = kv.split('=');
  (raw.formula_params as Record<string, number>)[k!.trim()] = Number(v);
}
const config = loadConfig(raw as RawConfig);
const sim = new Simulation(config, createWorld(config, seed));
for (let i = 0; i < config.formula.hunterSlots; i++) sim.enqueue({ type: 'debug.spawnHunter' });

const ticksPerMin = 600;
const reached20 = new Set<string>();
const reached50 = new Set<string>();
const reinc = new Set<string>();
const reached100 = new Set<string>();
const firsts: Record<string, number | undefined> = { lv20: undefined, lv50: undefined, lv100: undefined, reinc: undefined };
let killsWindow = 0;
let deathsWindow = 0;
/** Deaths by zone (where the hunter stood when it died), over the whole run. */
const deathsByZone: Record<string, number> = {};
/** Deaths in the first 30 game-minutes after a hunter first sets foot in a zone ("new-zone entry" deaths). */
const entryDeaths: Record<string, number> = {};
const firstEntry = new Map<string, number>(); // `${hunterId}|${zoneId}` -> minute
/** Deaths by the hunter's goal at death (hunt in that zone / other zone / transit), and hunter level − zone top monster level. */
const deathsByGoal: Record<string, number> = {};
const deathGaps: number[] = [];
const lastGoal = new Map<string, string>();
const zoneTopLevel = (zid: string) => Math.max(...config.index.zones.get(zid)!.monsters.map((x) => config.index.monsters.get(x.monsterId)!.level));
const zoneShort = (id: string | undefined) => (id ? id.replace(/^zone\./, '') : '-');

function report(min: number): void {
  const w = sim.world;
  const levels = w.hunters.map((h) => h.level).sort((a, b) => a - b);
  const med = levels.length ? levels[Math.floor((levels.length - 1) / 2)]! : 0;
  const max = levels.length ? levels[levels.length - 1]! : 0;
  let bestGear = 0;
  const per: string[] = [];
  for (const h of w.hunters) {
    let hg = 0;
    for (const g of Object.values(h.equipment)) hg = Math.max(hg, config.index.gear.get(g!.gearId)?.level ?? 0);
    bestGear = Math.max(bestGear, hg);
    const goal = h.ai.goal;
    const node = config.index.nodes.get(h.nodeId);
    // Zone of the hunt goal; otherwise the goal type (e.g. returnTown while walking through a field).
    const zid = goal?.type === 'hunt' ? goal.zoneId : undefined;
    const z = zid ? config.index.zones.get(zid) : undefined;
    const ratio = z ? powerRatio(config, w, h, z).toFixed(2) : '';
    const r = h.reincarnation ? `R${h.reincarnation}` : '';
    per.push(`${r}L${h.level}@${zid ? zoneShort(zid) : (goal?.type ?? '-') + (node?.zoneId ? '~' + zoneShort(node.zoneId) : '')}${ratio ? '(' + ratio + ')' : ''} g${hg}`);
  }
  const powers = w.hunters.map((x) => hunterPower(config, x)).sort((a, b) => a - b);
  const golds = w.hunters.map((x) => x.gold).sort((a, b) => a - b);
  const mid = (a: number[]) => (a.length ? a[Math.floor((a.length - 1) / 2)]! : 0);
  const econ = `pow med ${mid(powers).toFixed(0)} max ${(powers[powers.length - 1] ?? 0).toFixed(0)} | gold town ${w.town.gold} med ${mid(golds)} | shop ${w.town.shop.length} | kills/h/hunter ${((killsWindow * 60) / interval / Math.max(1, w.hunters.length)).toFixed(0)} deaths ${deathsWindow}`;
  killsWindow = 0;
  deathsWindow = 0;
  const bl = (w.town.buildings ?? []).map((s) => `${s.buildingId.replace(/^bld\./, '')}${s.level}${s.upgrade ? '*' : ''}`).join(' ');
  const caps = config.buildings.filter((b) => b.kind === 'craft').map((b) => craftMaxGearLevel(config, w, b.id)).join('/');
  const h = String(Math.floor(min / 60)).padStart(2, ' ');
  const m = String(min % 60).padStart(2, '0');
  console.log(
    `${h}h${m} max L${max} med L${med} | ≥20:${reached20.size} ≥50:${reached50.size} max:${reached100.size} reinc:${reinc.size} | bestGear ${bestGear} | ${econ}
      ${per.join(' ')}
      town: craft cap ${caps} | ${bl}`,
  );
}

const t0 = Date.now();
for (let min = 1; min <= minutes; min++) {
  for (let t = 0; t < ticksPerMin; t++) {
    sim.step();
    for (const h of sim.world.hunters) {
      const g = h.ai.goal;
      if (g && g.type !== 'dead') lastGoal.set(h.id, g.type === 'hunt' ? `hunt:${g.zoneId}` : g.type);
      const zid = config.index.nodes.get(h.nodeId)?.zoneId;
      if (zid && !firstEntry.has(`${h.id}|${zid}`)) firstEntry.set(`${h.id}|${zid}`, min);
    }
    for (const e of sim.drainEvents()) {
      if (e.type === 'monsterKilled') killsWindow++;
      else if (e.type === 'hunterDied') {
        deathsWindow++;
        const hz = sim.world.hunters.find((x) => x.id === e.hunterId);
        const zid = hz ? config.index.nodes.get(hz.nodeId)?.zoneId : undefined;
        if (hz && zid) {
          // goal was already reset to 'dead'; use the last hunt zone recorded before death
          const g = lastGoal.get(hz.id) ?? '-';
          const kind = g === `hunt:${zid}` ? 'hunting-here' : g.startsWith('hunt:') ? 'hunt-elsewhere' : g;
          deathsByGoal[kind] = (deathsByGoal[kind] ?? 0) + 1;
          deathGaps.push(hz.level - zoneTopLevel(zid));
          deathsByZone[zid] = (deathsByZone[zid] ?? 0) + 1;
          const t = firstEntry.get(`${e.hunterId}|${zid}`);
          if (t !== undefined && min - t <= 30) entryDeaths[zid] = (entryDeaths[zid] ?? 0) + 1;
        }
      }
      else if (e.type === 'levelUp') {
        if (e.level >= 20 && !reached20.has(e.hunterId)) { reached20.add(e.hunterId); firsts.lv20 ??= min; }
        if (e.level >= 50 && !reached50.has(e.hunterId)) { reached50.add(e.hunterId); firsts.lv50 ??= min; }
        if (e.level >= config.formula.maxLevel && !reached100.has(e.hunterId)) { reached100.add(e.hunterId); firsts.lv100 ??= min; }
      } else if (e.type === 'reincarnated') {
        if (!reinc.has(e.hunterId)) { reinc.add(e.hunterId); firsts.reinc ??= min; }
      }
    }
  }
  if (townGoldFloor > 0 && sim.world.town.gold < townGoldFloor) sim.world.town.gold = townGoldFloor;
  if (min % interval === 0 || min === minutes) report(min);
}
const fmt = (v: number | undefined) => (v === undefined ? 'never' : `${(v / 60).toFixed(2)}h (${v}m)`);
const n20 = reached20.size, n = sim.world.hunters.length;
console.log(`seed ${seed}: hunters ever ≥Lv20 ${n20}/${n}, ≥Lv50 ${reached50.size}/${n}, reincarnated ${reinc.size}/${n}`);
console.log(`seed ${seed}: first Lv20 ${fmt(firsts.lv20)}, first Lv50 ${fmt(firsts.lv50)}, first Lv${config.formula.maxLevel} ${fmt(firsts.lv100)}, first reincarnation ${fmt(firsts.reinc)}; wall ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const zs = (o: Record<string, number>) => config.zones.map((z) => `${zoneShort(z.id)} ${o[z.id] ?? 0}`).join(', ');
const st = sim.world.stats;
console.log(`seed ${seed}: deaths ${st.deaths} by zone [${zs(deathsByZone)}]; within 30 min of first entry [${zs(entryDeaths)}]`);
console.log(`seed ${seed}: enhance ${st.enhanceSuccess}/${st.enhanceTries} = ${(st.enhanceSuccess / Math.max(1, st.enhanceTries)).toFixed(3)}`);
console.log(`seed ${seed}: buildings built ${st.buildingsBuilt ?? 0}, upgrades ${st.buildingUpgrades ?? 0}, invested ${st.investGold ?? 0} gold (import ${st.investImportGold ?? 0}), ${st.investMaterials ?? 0} material units`);
deathGaps.sort((a, b) => a - b);
const q = (p: number) => (deathGaps.length ? deathGaps[Math.floor(p * (deathGaps.length - 1))] : 0);
console.log(`seed ${seed}: deaths by goal ${JSON.stringify(deathsByGoal)}; hunter level − zone top monster level at death: p10 ${q(0.1)} p50 ${q(0.5)} p90 ${q(0.9)}`);
