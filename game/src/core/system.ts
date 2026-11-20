import type { GameConfig } from './config/types';
import type { EventBuffer } from './events';
import type { NavGraph } from './pathfinding';
import type { Rng } from './rng';
import type { World } from './world';

/** Non-serialized debug info for the overlay (never read by systems). */
export interface SimDebug {
  /** Last utility scores per hunter, highest first. */
  aiScores: Map<string, { label: string; score: number }[]>;
}

export interface SystemContext {
  world: World;
  config: GameConfig;
  nav: NavGraph;
  rng: Rng;
  events: EventBuffer;
  debug: SimDebug;
  /** Fixed step in milliseconds. */
  dtMs: number;
}

export interface System {
  name: string;
  update(ctx: SystemContext): void;
}
