import { loadConfig, ConfigError } from '../core/config/load';
import type { GameConfig } from '../core/config/types';
import { advanceOfflineWallClock, offlineHasNews, offlineWallClockMs, type OfflineReport } from '../core/offline';
import { deserialize, serialize, SaveError } from '../core/save/save';
import { IndexedDbStorage } from '../core/save/storage';
import { createWorld, Simulation } from '../core/simulation';
import { rawConfigFromBundle } from './configSource';
import { DebugOverlay } from './debugOverlay';
import { showOfflinePopup } from './offlinePopup';
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
  let popupRoot: HTMLElement | null = null;
  let pendingReport: OfflineReport | null = null;

  /**
   * Offline progress (TECH_SPEC §9, EHT rules): no hunting while away; only wall-clock timers (journeys, the
   * Reincarnation Portal, constructions, hunter arrivals) advance by the gap since `since`. Returns the report when
   * anything finished (else null: no popup).
   */
  function creditOffline(since: number): OfflineReport | null {
    const r = sim.runBetweenTicks((ctx) => advanceOfflineWallClock(ctx, offlineWallClockMs(since, Date.now())));
    return offlineHasNews(r) ? r : null;
  }

  function showReport(r: OfflineReport | null): void {
    if (!r) return;
    if (popupRoot) showOfflinePopup(popupRoot, config, r);
    else pendingReport = r;
  }

  /** `offline`: credit the time since the save (boot only; the debug Load button just reloads). */
  async function load(offline = false): Promise<boolean> {
    const text = await storage.read(SLOT);
    if (!text) { status = 'no save'; return false; }
    try {
      const r = deserialize(text, config);
      sim.setWorld(r.world);
      const away = Math.round((Date.now() - r.savedAt) / 1000);
      status = `loaded (saved ${away}s ago${r.migratedFrom !== null ? `, migrated from v${r.migratedFrom}` : ''}${r.configChanged ? ', config changed' : ''})`;
      if (offline) {
        const rep = creditOffline(r.savedAt);
        if (rep) {
          status += `, offline ${Math.round(rep.awayMs / 60_000)} min (timers only)`;
          // Save right away so a reload before the next autosave cannot credit the same gap twice.
          await save();
          showReport(rep);
        }
      }
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

  await load(true);

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
  popupRoot = app;
  showReport(pendingReport);
  pendingReport = null;

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

  // A hidden tab stops requestAnimationFrame (the sim pauses): on return the wall-clock timers advance by the hidden time
  // (same rules as offline, TECH_SPEC §9).
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      void save();
    } else if (hiddenAt > 0) {
      const rep = creditOffline(hiddenAt);
      hiddenAt = 0;
      last = performance.now();
      if (rep) {
        void save();
        showReport(rep);
      }
    }
  });
}

void boot();
