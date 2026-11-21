import { applyCommand, type Command } from './commands';
import type { GameConfig } from './config/types';
import { EventBuffer, type SimEvent } from './events';
import { NavGraph } from './pathfinding';
import { Rng } from './rng';
import type { SimDebug, System, SystemContext } from './system';
import { aiSystem, urgentBackstopSystem } from './systems/ai';
import { arrivalsSystem } from './systems/arrivals';
import { academySystem } from './systems/academy';
import { bountySystem } from './systems/bounty';
import { combatSystem } from './systems/combat';
import { consumablesSystem, potionUseSystem } from './systems/consumables';
import { craftingSystem } from './systems/crafting';
import { journeySystem } from './systems/journey';
import { economySystem } from './systems/economy';
import { movementSystem } from './systems/movement';
import { needsSystem } from './systems/needs';
import { progressionSystem } from './systems/progression';
import { servicesSystem } from './systems/services';
import { skillsSystem } from './systems/skills';
import { spawnSystem } from './systems/spawn';
import { initialSupply, suppliesSystem } from './systems/supplies';
import { initialBuildings, townSystem } from './systems/town';
import { townAuraSystem } from './systems/monument';
import { trainingSystem } from './systems/training';
import { WORLD_SCHEMA_VERSION, type World } from './world';

export const TICK_MS = 100; // 10 ticks per second (TECH_SPEC §3.2)
/** Avoid a spiral of death after a long frame or tab switch; longer gaps only advance wall-clock timers (TECH_SPEC §9). */
const MAX_TICKS_PER_ADVANCE = 600;

/**
 * Fixed per-tick order (TECH_SPEC §3.2; commands are applied first in `step()`). `urgentBackstop` re-runs the AI's
 * emergency check after combat/skills; the Trading Post lives inside `economy`. `town` (constructions, auto-investment) runs
 * after crafting and before `bounty`, so investment spends spare Town gold before the auto-bounty looks at it. `potionUse` drinks
 * between skills and the backstop (a potion answers the hit before a retreat fires); `consumables` sells potions at the door;
 * `supplies` produces service/potion stock after the Trading Post and before crafting (essential materials first,
 * TECH_SPEC §5.14). `townAura` syncs the monument aura onto hunters right after arrivals, before anything reads their stats;
 * `training` runs Training Ground sessions next to the academy (TECH_SPEC §5.15). New systems go here and in §3.2.
 */
export const DEFAULT_SYSTEMS: readonly System[] = [
  arrivalsSystem,
  townAuraSystem,
  aiSystem,
  movementSystem,
  combatSystem,
  skillsSystem,
  potionUseSystem,
  urgentBackstopSystem,
  servicesSystem,
  economySystem,
  consumablesSystem,
  suppliesSystem,
  academySystem,
  trainingSystem,
  craftingSystem,
  townSystem,
  bountySystem,
  journeySystem,
  needsSystem,
  progressionSystem,
  spawnSystem,
];

export function createWorld(config: GameConfig, seed: number): World {
  return {
    schemaVersion: WORLD_SCHEMA_VERSION,
    configVersion: config.version,
    seed,
    rng: new Rng(seed).state,
    tick: 0,
    timeMs: 0,
    nextId: 1,
    town: {
      gold: config.formula.townStartingGold,
      arrivalTimerMs: 0,
      storage: {},
      shop: [],
      crafting: Object.fromEntries(config.buildings.filter((b) => b.kind === 'craft').map((b) => [b.id, null])),
      autoCraft: true,
      difficulty: config.difficulties[0]!.id,
      unlockedDifficulties: [config.difficulties[0]!.id],
      autoReincarnate: true,
      requests: {},
      bounties: [],
      autoBounty: true,
      buildings: initialBuildings(config),
      autoInvest: true,
      investPlan: null,
      gearStorage: [],
      autoDifficulty: true,
      supply: initialSupply(config),
      queue: [],
      queueTimerMs: 0,
      autoInviteTimerMs: 0,
      tickets: {},
    },
    hunters: [],
    monsters: [],
    journeys: [],
    portal: [],
    zones: {},
    stats: { kills: 0, deaths: 0, serviceUses: 0, materialsSold: 0, crafted: 0, gearBought: 0, enhanceTries: 0, enhanceSuccess: 0, skillCasts: 0, jobChanges: 0, reincarnations: 0, learned: 0, materialsDiscarded: 0, gearScrapped: 0, bountiesPosted: 0, bountiesCompleted: 0, bountyGoldPaid: 0, bountyKingdomGold: 0, buildingsBuilt: 0, buildingUpgrades: 0, investGold: 0, investMaterials: 0, investImportGold: 0, journeysStarted: 0, journeysSucceeded: 0, journeysFailed: 0, journeysRecalled: 0, journeyGold: 0, gearDismantled: 0, gearReclaimed: 0, gearRelisted: 0, supplyProduced: 0, supplyUsed: 0, serviceStockouts: 0, supplyStockoutMs: 0, potionsProduced: 0, potionsBought: 0, potionsUsed: 0, potionGold: 0, reviveFees: 0, reviveBroke: 0, queueJoined: 0, queueEntered: 0, invites: 0, inviteGold: 0, autoInvites: 0, donatedGold: 0, banished: 0, personalityRerolls: 0, trainSessions: 0, trainGold: 0, trainExp: 0, libraryExp: 0 },
  };
}

export class Simulation {
  readonly config: GameConfig;
  readonly nav: NavGraph;
  readonly debug: SimDebug = { aiScores: new Map() };
  world: World;
  speed = 1;
  paused = false;
  private rng: Rng;
  private events = new EventBuffer();
  private queue: Command[] = [];
  private accumulatorMs = 0;
  private systems: readonly System[];

  constructor(config: GameConfig, world: World, systems: readonly System[] = DEFAULT_SYSTEMS) {
    this.config = config;
    this.nav = new NavGraph(config);
    this.world = world;
    this.rng = new Rng(world.rng);
    this.systems = systems;
  }

  /** Replace the whole world (load/reset). */
  setWorld(world: World): void {
    this.world = world;
    this.rng = new Rng(world.rng);
    this.queue = [];
    this.accumulatorMs = 0;
    this.debug.aiScores.clear();
  }

  enqueue(cmd: Command): void {
    this.queue.push(cmd);
  }

  /** Run exactly one fixed step. */
  step(): void {
    const ctx: SystemContext = {
      world: this.world, config: this.config, nav: this.nav, rng: this.rng,
      events: this.events, debug: this.debug, dtMs: TICK_MS,
    };
    const cmds = this.queue;
    this.queue = [];
    for (const c of cmds) applyCommand(ctx, c);
    for (const s of this.systems) s.update(ctx);
    this.world.tick += 1;
    this.world.timeMs += TICK_MS;
    this.world.rng = this.rng.state;
  }

  /**
   * Advance by real elapsed time (scaled by speed). Returns ticks run.
   * `alpha` in [0,1) is how far we are into the next tick, for render interpolation.
   */
  advance(realMs: number): { ticks: number; alpha: number } {
    if (this.paused) return { ticks: 0, alpha: 0 };
    this.accumulatorMs += realMs * this.speed;
    let ticks = 0;
    while (this.accumulatorMs >= TICK_MS && ticks < MAX_TICKS_PER_ADVANCE) {
      this.step();
      this.accumulatorMs -= TICK_MS;
      ticks++;
    }
    if (ticks === MAX_TICKS_PER_ADVANCE) this.accumulatorMs = 0;
    return { ticks, alpha: this.accumulatorMs / TICK_MS };
  }

  /**
   * Run `fn` between ticks with this simulation's live RNG and event buffer (e.g. resolving journeys that ended while
   * the game was closed, TECH_SPEC §5.10). The RNG state is written back to the world like at the end of `step()`, so
   * draws made here are never replayed. Does not advance tick/time.
   */
  runBetweenTicks<T>(fn: (ctx: SystemContext) => T): T {
    const ctx: SystemContext = {
      world: this.world, config: this.config, nav: this.nav, rng: this.rng,
      events: this.events, debug: this.debug, dtMs: 0,
    };
    const out = fn(ctx);
    this.world.rng = this.rng.state;
    return out;
  }

  drainEvents(): SimEvent[] {
    return this.events.drain();
  }
}
