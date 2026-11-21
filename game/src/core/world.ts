import type { RngState } from './rng';
import type { GearSlot, ModStat, NeedKey, StatKey } from './config/types';

export type { GearSlot, NeedKey } from './config/types';

/**
 * Bump when the World shape changes and add a migration in save/migrations.ts.
 * v8 = Town buildings (TECH_SPEC §5.12); v9 = journeys (TECH_SPEC §5.11);
 * v10 = gear tiers per difficulty, Town gear storage (reclaim), dismantle, auto difficulty (TECH_SPEC §5.8);
 * v11 = reserved for another branch (placeholder migration); v12 = reincarnation portal (`portal`, TECH_SPEC §5.13).
 */
export const WORLD_SCHEMA_VERSION = 12;

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
  | { type: 'learn'; kind: 'skill' | 'trait'; id: string }
  /** v12: walk to the Reincarnation Portal and enter it (re-validated on arrival; TECH_SPEC §5.13). */
  | { type: 'reincarnate' };

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
  /**
   * v10: gear tier = id of the difficulty it was crafted at (main stat × that difficulty's gearStatMul, TECH_SPEC §5.8).
   * Optional in the type so code that creates gear without a tier (journey loot) gets the base tier; the v9 → v10
   * migration writes the base difficulty id on every existing item.
   */
  difficultyId?: string;
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
  /** v10: gear tier the job was started at (its essence is already paid); absent = base tier. */
  difficultyId?: string;
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

/** v8: a construction or upgrade in progress (TECH_SPEC §5.12). Gold and materials were paid when it started. */
export interface BuildingUpgrade {
  toLevel: number;
  remainingMs: number;
  totalMs: number;
  /**
   * What was paid, refunded on cancel: `gold` (imported material gold included) and the units taken from storage.
   * Imported units (bought for `importGold`) are not given back as materials.
   */
  gold: number;
  materials: Record<string, number>;
  importGold: number;
  importedUnits: number;
  /** Started by the Town's auto-investment rather than a player command. */
  auto: boolean;
}

/** v8: a building standing on a plot (TECH_SPEC §5.12). `id` is the plot id (one building per plot). */
export interface BuildingState {
  id: string;
  buildingId: string;
  /** 0 while the first construction is running (not usable yet). Upgrades keep the old level working until done. */
  level: number;
  upgrade: BuildingUpgrade | null;
}

/** v8: the auto-investment's current goal (systems/town.ts): the Trading Post requests its materials. */
export interface InvestPlan {
  plotId: string;
  buildingId: string;
  toLevel: number;
  /** Craft-tier cap (or the Town Hall level blocking it) that hunters are about to hit: may spend below the treasury target. */
  urgent: boolean;
  /** world.timeMs when this plan was first chosen (missing materials are imported after investImportSec). */
  sinceMs: number;
}

/**
 * v9: a team away on a journey (systems/journey.ts, TECH_SPEC §5.11). Its hunters are MOVED out of `world.hunters`
 * into `hunters` here while away, so no field/AI/needs/progression system can touch them; they come back (appended
 * to `world.hunters`) at the town square when the journey ends or is recalled.
 */
export interface Journey {
  id: string;
  /** Destination id (config/journey.json). */
  journeyId: string;
  /** Difficulty at departure (team power and reward multiplier use it). */
  difficultyId: string;
  hunters: Hunter[];
  /** Snapshot at departure: Σ formulas.zonePower of the members, and the resulting success chance. */
  teamPower: number;
  successChance: number;
  durationMs: number;
  /** Counts down by game time while playing and by wall-clock time while offline; resolves at 0. */
  remainingMs: number;
  startedAtMs: number;
  /** Town gold paid at departure. */
  cost: number;
}

/**
 * v12: a hunter inside the Reincarnation Portal (systems/progression.ts, TECH_SPEC §5.13). Like a journey member, the
 * hunter is MOVED out of `world.hunters` while inside (no system sees it; it keeps its slot and counts in allHunters).
 * When `remainingMs` reaches 0 (game time while playing, wall-clock time while offline) progression.reincarnate runs
 * and the hunter comes back at the portal node at level 1.
 */
export interface PortalStay {
  hunter: Hunter;
  durationMs: number;
  remainingMs: number;
  /** world.timeMs when the hunter entered. */
  enteredAtMs: number;
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
    /** v8: buildings on plots, in plot config order (TECH_SPEC §5.12). */
    buildings: BuildingState[];
    /** v8: spend Town gold above the treasury target (and materials) on building upgrades automatically. */
    autoInvest: boolean;
    investPlan: InvestPlan | null;
    /**
     * Tax rate on kill gold set by `town.setTaxRate` (systems/tax.ts, TECH_SPEC §5.10). Optional, no schema bump:
     * absent = config `taxRate`.
     */
    taxRate?: number;
    /**
     * v10: Town gear storage — equipment reclaimed from hunters (on reincarnation or `hunter.reclaimGear`), oldest first.
     * Items keep quality/enhance/tier; they are put back on sale in the shop or dismantled (TECH_SPEC §5.8).
     */
    gearStorage: GearInstance[];
    /** v10: step the difficulty up automatically once enough hunters have reincarnated (formula diffAutoAdvanceFrac). */
    autoDifficulty: boolean;
  };
  /** Arrays (not maps) so iteration order is stable and deterministic. */
  hunters: Hunter[];
  monsters: Monster[];
  /** v9: teams away on a journey, in departure order. */
  journeys: Journey[];
  /** v12: hunters inside the Reincarnation Portal, in entry order. */
  portal: PortalStay[];
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
    /** v8: constructions/upgrades finished; gold and material units spent on them (incl. imports); gold paid for imports. */
    buildingsBuilt: number;
    buildingUpgrades: number;
    investGold: number;
    investMaterials: number;
    investImportGold: number;
    /** Tax taken from kill gold into Town gold (systems/tax.ts). Optional, no schema bump: absent = 0. */
    taxCollected?: number;
    /** v9: journeys started / succeeded / failed / recalled, Town gold earned from journeys (rewards, rare sold). */
    journeysStarted: number;
    journeysSucceeded: number;
    journeysFailed: number;
    journeysRecalled: number;
    journeyGold: number;
    /** v10: items dismantled into materials (shop items at scrap age, stored gear, command) / equipment reclaimed into storage / stored items put back on sale. */
    gearDismantled: number;
    gearReclaimed: number;
    gearRelisted: number;
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
