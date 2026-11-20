/** Headless run for tuning (TECH_SPEC §11): npx vite-node tools/headless.ts [minutes] [seed] */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadConfig, type RawConfig } from '../src/core/config/load';
import { createWorld, Simulation } from '../src/core/simulation';

const minutes = Number(process.argv[2] ?? 20);
const seed = Number(process.argv[3] ?? 1);
const dir = join(process.cwd(), 'config');
const raw: Record<string, unknown> = {};
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) raw[basename(f, '.json')] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
const config = loadConfig(raw as RawConfig);
const sim = new Simulation(config, createWorld(config, seed));
for (let i = 0; i < config.formula.hunterSlots; i++) sim.enqueue({ type: 'debug.spawnHunter' });

const counts: Record<string, number> = {};
const reasons: Record<string, number> = {};
const ticks = minutes * 600;
for (let t = 0; t < ticks; t++) {
  sim.step();
  for (const e of sim.drainEvents()) {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    if (e.type === 'goalChanged') reasons[`${e.goal.split(':')[0]} <- ${e.reason.split(' ')[0]}`] = (reasons[`${e.goal.split(':')[0]} <- ${e.reason.split(' ')[0]}`] ?? 0) + 1;
  }
}
const w = sim.world;
console.log(`${minutes} game min, seed ${seed}`);
console.log('events', counts);
console.log('goal changes', reasons);
console.log('stats', w.stats, 'town gold', w.town.gold, 'monsters', w.monsters.length);
for (const h of w.hunters) {
  const n = h.needs;
  const eq = Object.entries(h.equipment).map(([s, g]) => `${s}:${g!.gearId.split('.').pop()}/${g!.qualityId.slice(2)}+${g!.enhance}`).join(' ');
  console.log(`${h.id} Lv${h.level} gold ${h.gold} kills ${h.kills} [${eq}] goal ${h.ai.goal ? JSON.stringify(h.ai.goal) : '-'} ${h.ai.phase} hp ${(n.hp / h.stats.hp * 100).toFixed(0)}% sat ${n.satiety.toFixed(0)} mood ${n.mood.toFixed(0)} sta ${n.stamina.toFixed(0)}`);
}
