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
import { craftingSystem } from './systems/crafting';
import { economySystem } from './systems/economy';
import { movementSystem } from './systems/movement';
import { needsSystem } from './systems/needs';
import { progressionSystem } from './systems/progression';
import { servicesSystem } from './systems/services';
import { skillsSystem } from './systems/skills';
import { spawnSystem } from './systems/spawn';
import { WORLD_SCHEMA_VERSION, type World } from './world';

export const TICK_MS = 100; // 10 ticks per second (TECH_SPEC §3.2)
/** Avoid a spiral of death after a long frame or tab switch; offline progress handles longer gaps. */
const MAX_TICKS_PER_ADVANCE = 600;

/** Fixed order from TECH_SPEC §3.2. Later milestones insert economy/progression here. */
export const DEFAULT_SYSTEMS: readonly System[] = [
  arrivalsSystem,
  aiSystem,
  movementSystem,
  combatSystem,
  skillsSystem,
  urgentBackstopSystem,
  servicesSystem,
  economySystem,
  academySystem,
  craftingSystem,
  bountySystem,
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
    },
    hunters: [],
    monsters: [],
    zones: {},
    stats: { kills: 0, deaths: 0, serviceUses: 0, materialsSold: 0, crafted: 0, gearBought: 0, enhanceTries: 0, enhanceSuccess: 0, skillCasts: 0, jobChanges: 0, reincarnations: 0, learned: 0, materialsDiscarded: 0, gearScrapped: 0, bountiesPosted: 0, bountiesCompleted: 0, bountyGoldPaid: 0, bountyKingdomGold: 0 },
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

  drainEvents(): SimEvent[] {
    return this.events.drain();
  }
}
