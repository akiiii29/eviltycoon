/**
 * Offline progress (TECH_SPEC §9). Pure and deterministic, no DOM.
 *
 * Like Evil Hunter Tycoon there is NO hunting while the game is closed: no EXP, gold, kills, materials, needs refill or
 * level-ups are credited for the time away, and boss/hunting timers do not move. Only what runs on a wall-clock timer
 * advances, by the raw gap since the save (`offlineWallClockMs`: uncapped; 0 for an unknown save time or a clock that
 * went backwards):
 *  - journeys (TECH_SPEC §5.11, systems/journey.advanceJourneys);
 *  - hunters inside the Reincarnation Portal (TECH_SPEC §5.13, progression.advancePortal): they come out reincarnated;
 *  - constructions/upgrades (TECH_SPEC §5.12, town.advanceBuildingTimers): paid when started; auto-investment does NOT
 *    start new ones offline;
 *  - hunter arrivals (systems/arrivals rules: one every arrivalIntervalSec while Town slots are free).
 * The client calls `advanceOfflineWallClock` through Simulation.runBetweenTicks (the sim's live RNG: journeys and
 * arrivals draw it; `timeMs`/`tick` do not move) on load and when a hidden tab becomes visible again (the sim was paused).
 */
import type { SystemContext } from './system';
import { spawnHunter } from './systems/arrivals';
import { advanceJourneys, townHunterCount, type JourneyResult } from './systems/journey';
import { advancePortal, type PortalCompletion } from './systems/progression';
import { advanceBuildingTimers, type BuildingCompletion } from './systems/town';

export interface OfflineReport {
  /** Wall-clock time away that the timers advanced by (0 when the save time is unknown or the clock went back). */
  awayMs: number;
  /** Journeys that ended during the gap. */
  journeys: JourneyResult[];
  /** Hunters that came out of the Reincarnation Portal during the gap. */
  reincarnations: PortalCompletion[];
  /** Constructions/upgrades that finished during the gap. */
  buildings: BuildingCompletion[];
  /** Ids of hunters that arrived during the gap. */
  arrivals: string[];
}

/** Wall-clock ms the timers advance by while away: the raw gap (0 for unknown save time or a clock that went back). */
export function offlineWallClockMs(savedAt: number, now: number): number {
  if (!Number.isFinite(savedAt) || savedAt <= 0 || !Number.isFinite(now)) return 0;
  return Math.max(0, now - savedAt);
}

/** Whether anything finished during the gap (the client shows the popup only then). */
export function offlineHasNews(r: OfflineReport): boolean {
  return r.journeys.length > 0 || r.reincarnations.length > 0 || r.buildings.length > 0 || r.arrivals.length > 0;
}

/**
 * Advance journeys, portal stays, constructions/upgrades and hunter arrivals by `ms` (see the file header). Needs a full
 * sim context: call through Simulation.runBetweenTicks. Journeys and the portal first, so returning hunters keep their
 * slot before arrivals fill free ones.
 */
export function advanceOfflineWallClock(ctx: SystemContext, ms: number): OfflineReport {
  const out: OfflineReport = { awayMs: Math.max(0, ms), journeys: [], reincarnations: [], buildings: [], arrivals: [] };
  if (!(ms > 0)) return out;
  out.journeys = advanceJourneys(ctx, ms, true);
  out.reincarnations = advancePortal(ctx, ms);
  out.buildings = advanceBuildingTimers(ctx, ms);
  // systems/arrivals: the timer runs only while Town slots are free (journey/portal hunters keep theirs) and resets when full.
  const { world, config } = ctx;
  const interval = config.formula.arrivalIntervalSec * 1000;
  const free = config.formula.hunterSlots - townHunterCount(world);
  if (free <= 0) {
    world.town.arrivalTimerMs = 0;
    return out;
  }
  let timer = world.town.arrivalTimerMs + ms;
  const n = interval > 0 ? Math.min(free, Math.floor(timer / interval)) : free;
  for (let i = 0; i < n; i++) out.arrivals.push(spawnHunter(ctx).id);
  timer -= n * interval;
  world.town.arrivalTimerMs = townHunterCount(world) >= config.formula.hunterSlots ? 0 : Math.max(0, timer);
  return out;
}
