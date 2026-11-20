import { loadConfig, ConfigError } from '../core/config/load';
import type { GameConfig } from '../core/config/types';
import { deserialize, serialize, SaveError } from '../core/save/save';
import { IndexedDbStorage } from '../core/save/storage';
import { createWorld, Simulation } from '../core/simulation';
import { rawConfigFromBundle } from './configSource';
import { DebugOverlay } from './debugOverlay';
import { Renderer } from './render';
import './style.css';

const SLOT = 'main';
const AUTOSAVE_MS = 30_000;
const OVERLAY_MS = 200;

function fatal(message: string): never {
  const el = document.createElement('pre');
  el.className = 'fatal';
  el.textContent = message;
  document.body.appendChild(el);
  throw new Error(message);
}

async function boot(): Promise<void> {
  let config: GameConfig;
  try {
    config = loadConfig(rawConfigFromBundle());
  } catch (e) {
    fatal(e instanceof ConfigError ? e.message : String(e));
  }

  const storage = new IndexedDbStorage();
  const sim = new Simulation(config, createWorld(config, Date.now() >>> 0));
  let status = 'new game';

  async function load(): Promise<boolean> {
    const text = await storage.read(SLOT);
    if (!text) { status = 'no save'; return false; }
    try {
      const r = deserialize(text, config);
      sim.setWorld(r.world);
      const away = Math.round((Date.now() - r.savedAt) / 1000);
      status = `loaded (saved ${away}s ago${r.migratedFrom !== null ? `, migrated from v${r.migratedFrom}` : ''}${r.configChanged ? ', config changed' : ''})`;
      return true;
    } catch (e) {
      status = e instanceof SaveError ? `load failed: ${e.message}` : `load failed: ${String(e)}`;
      return false;
    }
  }

  async function save(): Promise<void> {
    try {
      await storage.write(SLOT, serialize(sim.world, Date.now()));
      status = `saved at tick ${sim.world.tick}`;
    } catch (e) {
      status = `save failed: ${String(e)}`;
    }
  }

  async function reset(): Promise<void> {
    await storage.remove(SLOT);
    sim.setWorld(createWorld(config, Date.now() >>> 0));
    status = 'reset';
  }

  await load();

  const app = document.getElementById('app')!;
  const canvas = document.createElement('canvas');
  canvas.className = 'view';
  app.appendChild(canvas);
  const renderer = new Renderer(canvas, config);
  const overlay = new DebugOverlay(app, sim, {
    save: () => void save(),
    load: () => void load(),
    reset: () => void reset(),
  });
  const panel = app.querySelector<HTMLElement>('.debug');
  const fitView = () => {
    renderer.leftInsetPx = panel ? panel.offsetWidth + 16 : 0;
    renderer.resize();
  };
  fitView();
  window.addEventListener('resize', fitView);

  // Expose for console debugging only.
  (window as unknown as { sim: Simulation }).sim = sim;

  let last = performance.now();
  let lastOverlay = 0;
  let lastSave = last;
  function frame(now: number): void {
    const dt = Math.min(now - last, 1000);
    last = now;
    sim.advance(dt);
    overlay.pushEvents(sim.drainEvents());
    renderer.sync(sim.world);
    renderer.draw();
    if (now - lastOverlay > OVERLAY_MS) {
      overlay.setStatus(status);
      overlay.render();
      lastOverlay = now;
    }
    if (now - lastSave > AUTOSAVE_MS) {
      lastSave = now;
      void save();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void save();
  });
}

void boot();
