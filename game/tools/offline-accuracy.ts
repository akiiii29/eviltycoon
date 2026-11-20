/**
 * Offline estimate accuracy (TECH_SPEC §9): npx vite-node tools/offline-accuracy.ts [seeds] [warmMinutes] [gapMinutes]
 *   seeds        comma list, default 1,2,3
 *   warmMinutes  comma list of minutes played before the gap, default 30,60,150,240
 *   gapMinutes   length of the simulated absence, default 60
 * One continuous run per seed, sampled every tick like the client does every frame. At each warm point the world and
 * the rate tracker are cloned and `estimateOffline` predicts the next `gap` minutes; the run then actually plays them
 * and the prediction is compared with what happened (kills, level gain of the hunters present at the warm point —
 * one reincarnation counts as maxLevel levels — and the mean per-hunter level error). Gold is printed but not scored:
 * the real run spends gold on gear/enhancing, the estimate only credits net gains floored at 0.
 * Env OFFLINE_FP="key=value,..." overrides formula_params for the run.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadConfig, type RawConfig } from '../src/core/config/load';
import { estimateOffline, recordSample, type OfflineReport, type OfflineTracker } from '../src/core/offline';
import { createWorld, Simulation } from '../src/core/simulation';
import type { World } from '../src/core/world';

const seeds = (process.argv[2] ?? '1,2,3').split(',').map(Number);
const warms = (process.argv[3] ?? '30,60,150,240').split(',').map(Number).sort((a, b) => a - b);
const gap = Number(process.argv[4] ?? 60);
const dir = join(process.cwd(), 'config');
const raw: Record<string, unknown> = {};
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) raw[basename(f, '.json')] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
for (const kv of (process.env.OFFLINE_FP ?? '').split(',').filter(Boolean)) {
  const [k, v] = kv.split('=');
  (raw.formula_params as Record<string, number>)[k!.trim()] = Number(v);
}
const config = loadConfig(raw as RawConfig);
const T0 = 1_700_000_000_000;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const maxLv = config.formula.maxLevel;
const absLevel = (h: { level: number; reincarnation: number }) => h.level + h.reincarnation * maxLv;

interface Pending { warm: number; w0: World; est: OfflineReport }
const pct = (est: number, real: number) => (real === 0 ? (est === 0 ? 0 : Infinity) : ((est - real) / real) * 100);
const fmt = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(0)}%`;

console.log('seed warm | kills est/real err | levels est/real err | mean |lv err| | gold est / real net');
const all: { kills: number; levels: number }[] = [];
for (const seed of seeds) {
  const sim = new Simulation(config, createWorld(config, seed));
  for (let i = 0; i < config.formula.hunterSlots; i++) sim.enqueue({ type: 'debug.spawnHunter' });
  let tracker: OfflineTracker | null = null;
  const pending: Pending[] = [];
  const end = warms[warms.length - 1]! + gap;
  const started = Date.now();
  for (let m = 0; m <= end; m++) {
    if (warms.includes(m)) {
      const w0 = clone(sim.world);
      const est = estimateOffline(config, w0, clone(tracker), T0, T0 + gap * 60_000);
      pending.push({ warm: m, w0, est });
    }
    for (const p of pending.filter((x) => x.warm + gap === m)) {
      const w1 = sim.world;
      const { w0, est } = p;
      const realKills = w1.stats.kills - w0.stats.kills;
      let realLv = 0, estLv = 0, err = 0;
      for (const h0 of w0.hunters) {
        const h1 = w1.hunters.find((x) => x.id === h0.id);
        if (!h1) continue;
        const g = est.hunters.find((x) => x.id === h0.id);
        const after = g ? g.levelAfter + (h0.reincarnation + g.reincarnations) * maxLv : absLevel(h0);
        realLv += absLevel(h1) - absLevel(h0);
        estLv += after - absLevel(h0);
        err += Math.abs(after - absLevel(h1));
      }
      const gold = (w: World) => w.town.gold + w.hunters.reduce((a, h) => a + h.gold, 0);
      const k = pct(est.kills, realKills);
      const l = pct(estLv, realLv);
      all.push({ kills: k, levels: l });
      console.log(
        `${seed} ${String(p.warm).padStart(4)} | ${est.kills}/${realKills} ${fmt(k)} | +${estLv}/+${realLv} ${fmt(l)} | ` +
        `${(err / w0.hunters.length).toFixed(2)} | ${est.gold} / ${gold(w1) - gold(w0)}`,
      );
    }
    if (m === end) break;
    for (let i = 0; i < 600; i++) {
      sim.step();
      tracker = recordSample(config, sim.world, tracker);
    }
    sim.drainEvents();
  }
  console.log(`seed ${seed}: wall ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
const worst = (k: 'kills' | 'levels') => all.reduce((a, r) => (Math.abs(r[k]) > Math.abs(a) ? r[k] : a), 0);
console.log(`worst: kills ${fmt(worst('kills'))}, levels ${fmt(worst('levels'))}`);
