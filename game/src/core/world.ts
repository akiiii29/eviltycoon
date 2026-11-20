import type { RngState } from './rng';
import type { GearSlot, ModStat, NeedKey, StatKey } from './config/types';

export type { GearSlot, NeedKey } from './config/types';

/** Bump when the World shape changes and add a migration in save/migrations.ts. */
export const WORLD_SCHEMA_VERSION = 7;

export type Grade = 'normal' | 'high' | 'highest';
export type HunterTier = 'normal' | 'rare' | 'superior' | 'heroic' | 'legendary';

export interface Vec2 {
  x: number;
  y: number;
}

export type Goal =
  | { type: 'hunt'; zoneId: string }
  | { type: 'service'; buildingId: string }
  | { type: 'returnTown' }
  | { type: 'wander'; nodeId: string }
  | { type: 'dead' }
  /** M2: sell requested bag materials at the trading post (unrequested ones are discarded there). */
  | { type: 'sell' }
  /** M2: buy a specific shop item (re-validated on arrival). */
  | { type: 'shop'; itemUid: string }
  /** M2: try to enhance the gear in a slot at the forge. */
  | { type: 'enhance'; slot: GearSlot }
  /** M3: learn/upgrade a skill (gold) or a trait (trait points) at the Academy (re-validated on arrival). */
  | { type: 'learn'; kind: 'skill' | 'trait'; id: string };

/** Temporary stat modifier from a buff skill. */
export interface Buff {
  sourceId: string;
  stat: ModStat;
  value: number;
  remainingMs: number;
}

/** A concrete piece of gear (crafted, on sale or equipped). */
export interface GearInstance {
  uid: string;
  gearId: string;
  qualityId: string;
  enhance: number;
}

export interface ShopItem extends GearInstance {
  /** Current price (may be marked down). */
  price: number;
  /** Price when listed (markdown floor is relative to this). */
  listPrice: number;
  /** world.timeMs when the item was put on sale. */
  listedAtMs: number;
}

export interface CraftJob {
  gearId: string;
  remainingMs: number;
}

export type GoalType = Goal['type'];

export interface AiState {
  goal: Goal | null;
  /** travel = following `path`; act = doing the goal at its destination. */
  phase: 'travel' | 'act';
  /** Remaining node ids to walk through (front = next). */
  path: string[];
  /** Countdown to the next periodic re-decision (hunting/wandering only). */
  decideInMs: number;
  targetMonsterId: string | null;
  /** Free-movement target (chasing a monster, roaming a zone). */
  moveTo: Vec2 | null;
  /** Command-forced goal: kept until done or an urgent need overrides it. */
  forced: boolean;
}

export interface Hunter {
  id: string;
  classId: string;
  jobTier: number;
  tier: HunterTier;
  statGrades: Record<StatKey, Grade>;
  /** Base stats (class roll + level gains), WITHOUT gear/job/traits/buffs. Use formulas.hunterStats() for effective values. */
  stats: Record<StatKey, number> & { atkSpeed: number };
  /** The original class roll at level 1; reincarnation resets `stats` to this. */
  rollStats: Record<StatKey, number> & { atkSpeed: number };
  /** M3: learned skill levels (skillId → level ≥ 1) and per-skill cooldown remaining. */
  skills: Record<string, number>;
  skillCdMs: Record<string, number>;
  /** M3: trait levels (traitId → level) and unspent trait points. */
  traits: Record<string, number>;
  traitPoints: number;
  buffs: Buff[];
  equipment: Partial<Record<GearSlot, GearInstance>>;
  /** Materials carried: materialId → count. Capacity = formula.bagCapacity (total units). */
  bag: Record<string, number>;
  level: number;
  exp: number;
  reincarnation: number;
  gold: number;
  needs: Record<NeedKey, number>;
  personalities: string[];
  position: Vec2;
  /** Last waypoint node reached. */
  nodeId: string;
  insideBuildingId: string | null;
  ai: AiState;
  attackCdMs: number;
  /** > 0 while dead (counts down to revive). */
  deadMs: number;
  kills: number;
  arrivedAtMs: number;
}

export interface Monster {
  id: string;
  defId: string;
  zoneId: string;
  hp: number;
  position: Vec2;
  home: Vec2;
  targetHunterId: string | null;
  attackCdMs: number;
  /** M3: difficulty the monster was spawned under (scales its stats and rewards). */
  difficultyId: string;
}

export type BountyTargetKind = 'monster' | 'zone';

/** v7: a Town bounty (systems/bounty.ts, TECH_SPEC §5.9). */
export interface Bounty {
  id: string;
  /** 'monster' = kills of that monster type anywhere; 'zone' = any kill in that zone. */
  targetKind: BountyTargetKind;
  targetId: string;
  /** Kills required and kills so far. */
  kills: number;
  progress: number;
  /** Total reward (taken from Town gold when posted) and the part not yet paid out. */
  reward: number;
  escrow: number;
  /** Posted by the auto-bounty rule (expires after bountyAutoExpireSec) rather than by the player. */
  auto: boolean;
  postedAtMs: number;
}

export interface World {
  schemaVersion: number;
  configVersion: string;
  seed: number;
  rng: RngState;
  tick: number;
  timeMs: number;
  nextId: number;
  town: {
    gold: number;
    arrivalTimerMs: number;
    /** Town Storage: materialId → count. */
    storage: Record<string, number>;
    /** Items on sale in the shop, in listing order. */
    shop: ShopItem[];
    /** One job (or null) per craft building id. */
    crafting: Record<string, CraftJob | null>;
    /** When on, idle craft buildings pick what to make automatically. */
    autoCraft: boolean;
    /** M3: current difficulty id; unlocked ids in order; auto-reincarnate hunters at max level. */
    difficulty: string;
    unlockedDifficulties: string[];
    autoReincarnate: boolean;
    /**
     * v6: player-placed Trading Post requests, materialId → units still wanted (on top of the automatic
     * requests derived from auto-craft needs, see systems/trading.ts). Decremented as hunters sell.
     */
    requests: Record<string, number>;
    /** v7: active bounties in posting order (a kill counts toward the first matching one). */
    bounties: Bounty[];
    /** v7: post bounties automatically when Town gold is above its treasury target. */
    autoBounty: boolean;
    /**
     * Tax rate on kill gold set by `town.setTaxRate` (systems/tax.ts, TECH_SPEC §5.10). Optional, no schema bump:
     * absent = config `taxRate`.
     */
    taxRate?: number;
  };
  /** Arrays (not maps) so iteration order is stable and deterministic. */
  hunters: Hunter[];
  monsters: Monster[];
  zones: Record<string, { respawnMs: number }>;
  stats: {
    kills: number;
    deaths: number;
    serviceUses: number;
    materialsSold: number;
    crafted: number;
    gearBought: number;
    enhanceTries: number;
    enhanceSuccess: number;
    skillCasts: number;
    jobChanges: number;
    reincarnations: number;
    learned: number;
    /** v6: unrequested material units hunters threw away at the Trading Post. */
    materialsDiscarded: number;
    /** v6: shop items removed unsold (age ≥ shopScrapAgeSec). */
    gearScrapped: number;
    /** v7: bounties posted / completed, gold paid to hunters, completion gold the Town got from the kingdom. */
    bountiesPosted: number;
    bountiesCompleted: number;
    bountyGoldPaid: number;
    bountyKingdomGold: number;
    /** Tax taken from kill gold into Town gold (systems/tax.ts). Optional, no schema bump: absent = 0. */
    taxCollected?: number;
  };
}

export function bagCount(h: Hunter): number {
  let n = 0;
  for (const k in h.bag) n += h.bag[k]!;
  return n;
}

export function findHunter(world: World, id: string): Hunter | undefined {
  return world.hunters.find((h) => h.id === id);
}

export function findMonster(world: World, id: string): Monster | undefined {
  return world.monsters.find((m) => m.id === id);
}

export function newAiState(): AiState {
  return { goal: null, phase: 'act', path: [], decideInMs: 0, targetMonsterId: null, moveTo: null, forced: false };
}

export function isAlive(h: Hunter): boolean {
  return h.deadMs <= 0;
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
