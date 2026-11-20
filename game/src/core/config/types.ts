/** Typed view of the built config. Shapes mirror TECH_SPEC §8.2; tables are added per milestone. */

export type StatKey = 'hp' | 'atk' | 'def' | 'eva' | 'crit';
export const STAT_KEYS: readonly StatKey[] = ['hp', 'atk', 'def', 'eva', 'crit'];

export type NeedKey = 'hp' | 'satiety' | 'mood' | 'stamina';
export const NEED_KEYS: readonly NeedKey[] = ['hp', 'satiety', 'mood', 'stamina'];

/** [min, max] per stat grade: Normal, High, Highest. */
export type GradeRanges = [[number, number], [number, number], [number, number]];

export interface ClassDef {
  id: string;
  nameKey: string;
  attackSpeed: number;
  statRanges: Record<StatKey, GradeRanges>;
}

export interface PersonalityModifier {
  target: string;
  op: 'mul' | 'add';
  value: number;
}

export interface PersonalityDef {
  id: string;
  nameKey: string;
  weight: number;
  modifiers: PersonalityModifier[];
}

export interface StatGradeDef {
  grade: 'normal' | 'high' | 'highest';
  point: number;
  rollChance: number;
}

export type MapNodeKind = 'square' | 'road' | 'door' | 'gate' | 'field';

export interface MapNode {
  id: string;
  x: number;
  y: number;
  kind: MapNodeKind;
  /** Set for field nodes; town nodes have none. */
  zoneId?: string;
}

export interface MapEdge {
  a: string;
  b: string;
  road: boolean;
}

export type BuildingKind = 'service' | 'tradingPost' | 'craft' | 'shop' | 'forge' | 'academy';
export const BUILDING_KINDS: readonly BuildingKind[] = ['service', 'tradingPost', 'craft', 'shop', 'forge', 'academy'];

/**
 * Stat modifiers shared by traits and skill buffs (M3).
 * *Pct are percent of the stat (atkSpeedPct REDUCES the attack interval, i.e. attacks faster); crit/eva are flat points.
 */
export type ModStat = 'atkPct' | 'defPct' | 'hpPct' | 'atkSpeedPct' | 'crit' | 'eva';
export const MOD_STATS: readonly ModStat[] = ['atkPct', 'defPct', 'hpPct', 'atkSpeedPct', 'crit', 'eva'];

export interface JobDef {
  id: string;
  classId: string;
  /** 0 = starting job; job changes happen automatically at unlockLevel. */
  tier: number;
  nameKey: string;
  unlockLevel: number;
  /** Multiplier on base stats (hp/atk/def) while in this job. */
  statMult: number;
}

export type SkillKind = 'strike' | 'aoe' | 'buff';

export interface SkillDef {
  id: string;
  classId: string;
  nameKey: string;
  jobTierMin: number;
  kind: SkillKind;
  cooldownSec: number;
  maxLevel: number;
  /** Per level (length = maxLevel): strike/aoe = damage multiplier of ATK; buff = ModStat value. */
  value: number[];
  /** buff only: duration per level (s). */
  keepSec?: number[];
  /** aoe only: radius (world units). */
  radius?: number;
  /** buff only. */
  buffStat?: ModStat;
  /** Per level: min hunter level and gold to learn that level at the Academy. */
  studyLevel: number[];
  studyGold: number[];
}

export interface TraitDef {
  id: string;
  /** Omitted = any class. */
  classId?: string;
  nameKey: string;
  stat: ModStat;
  valuePerLevel: number;
  maxLevel: number;
  /** Trait points per level. */
  pointCost: number;
}

export interface DifficultyDef {
  id: string;
  order: number;
  nameKey: string;
  /** GDD §8: at least `hunterCount` hunters with reincarnation ≥ `reincarnation`. */
  unlockHunters: number;
  unlockReincarnation: number;
  monsterHpMul: number;
  monsterAtkMul: number;
  monsterDefMul: number;
  rewardMul: number;
}

export interface BuildingDef {
  id: string;
  nameKey: string;
  kind: BuildingKind;
  doorNode: string;
  /** service only: need restored, points per second while inside, entry price. */
  need?: NeedKey;
  restorePerSec?: number;
  price?: number;
  /** shop only: max items on sale. */
  capacity?: number;
  /** Visual footprint (world units), centered at x,y. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export type GearSlot = 'weapon' | 'armor' | 'accessory';
export const GEAR_SLOTS: readonly GearSlot[] = ['weapon', 'armor', 'accessory'];
export type MainStat = 'atk' | 'def' | 'hp';

export interface MaterialDef {
  id: string;
  nameKey: string;
  /** Gold the trading post pays per unit. */
  price: number;
}

export interface GearDef {
  id: string;
  nameKey: string;
  slot: GearSlot;
  /** Minimum hunter level to equip. */
  level: number;
  mainStat: MainStat;
  mainValue: number;
  /** Craft building (kind "craft") that makes it. */
  craftBuilding: string;
  craftSec: number;
  materials: { materialId: string; count: number }[];
  /** Shop price at Rare quality (×quality.priceMult). */
  basePrice: number;
}

export interface GearQualityDef {
  id: string;
  nameKey: string;
  /** GDD §6: Common −20% … Mythic +20% relative to Rare → statMult 0.8 … 1.2. */
  statMult: number;
  priceMult: number;
  craftChance: number;
}

export interface EnhanceDef {
  /** Target level (+1 … +max). */
  level: number;
  successRate: number;
  /** Gold cost as a fraction of the gear's basePrice. */
  costFrac: number;
  /** GDD §6: from +10 a failure drops one level. */
  dropOnFail: boolean;
}

export interface ZoneDef {
  id: string;
  nameKey: string;
  entryNode: string;
  monsterCap: number;
  respawnSec: number;
  monsters: { monsterId: string; weight: number }[];
}

export interface MonsterDef {
  id: string;
  nameKey: string;
  level: number;
  hp: number;
  atk: number;
  def: number;
  attackSpeed: number;
  moveSpeed: number;
  aggroRange: number;
  exp: number;
  gold: number;
  /** Critical hit chance in percent (burst damage). */
  crit: number;
  drops: { materialId: string; chance: number }[];
}

export interface FormulaParams {
  needMax: number;
  /** Time-based need decay per second (GDD §4.2: stamina decays with time). */
  staminaDecayPerSec: number;
  satietyDecayPerSec: number;
  moodDecayPerSec: number;
  /** Event-based need decay (GDD §4.2). */
  satietyPerAttack: number;
  moodPerHitTaken: number;
  /** Free slow recovery while idling in town, so a broke hunter never deadlocks. */
  townIdleRegenPerSec: number;
  hunterSlots: number;
  arrivalIntervalSec: number;
  personalitiesPerHunter: number;
  startingGold: number;
  /** Movement. */
  moveSpeed: number;
  roadSpeedMul: number;
  arriveEpsilon: number;
  /** Combat (TECH_SPEC §7.1; equations in formulas.ts). */
  attackRange: number;
  /** DEF reduction R = min(defReductionCap, DEF / (DEF + defPerLevel × attacker level + defFlat)). */
  defPerLevel: number;
  defFlat: number;
  defReductionCap: number;
  /** Floor of a single hit after DEF. */
  minDamage: number;
  /** Level-gap damage penalty G = max(levelGapMin, 1 − levelGapStep × max(0, L_def − L_att − levelGapGrace)). */
  levelGapGrace: number;
  levelGapStep: number;
  levelGapMin: number;
  /** Hunter crit damage multiplier; chance = min(critChanceCap, crit%/100); crit% over the cap adds critOverflowMult per 1.0. */
  critMultiplier: number;
  critChanceCap: number;
  critOverflowMult: number;
  /** Dodge chance = dodgeCap × EVA / (EVA + dodgeHalf). */
  dodgeCap: number;
  dodgeHalf: number;
  /** Stacking caps (percent) per modifier category: traits and skill buffs. */
  traitPctCap: number;
  buffPctCap: number;
  /** Fastest allowed attack interval in seconds. */
  minAttackInterval: number;
  /** Mood scales ATK/DEF: no penalty at mood ≥ moodPenaltyFrac × max, linear down to moodStatFloor at 0 (1 = off). */
  moodPenaltyFrac: number;
  moodStatFloor: number;
  monsterLeashRange: number;
  reviveSec: number;
  reviveHpFrac: number;
  /** Progression. */
  expBase: number;
  expExponent: number;
  levelHpGain: number;
  levelAtkGain: number;
  levelDefGain: number;
  /** AI (TECH_SPEC §5). */
  decisionIntervalSec: number;
  decisionNoise: number;
  huntStickiness: number;
  urgentHpFrac: number;
  urgentSatietyFrac: number;
  urgentMoodFrac: number;
  urgentStaminaFrac: number;
  softNeedFrac: number;
  zoneFitMin: number;
  zoneFitBest: number;
  zoneFitEasy: number;
  /** zoneFit at ratio = zoneFitMin (start of the ramp). */
  zoneFitRampLow: number;
  /** zoneFit lost per 1.0 of ratio above zoneFitEasy, down to zoneFitFloor. */
  zoneFitDecay: number;
  zoneFitFloor: number;
  /** Tie-break: an easier comfortable zone scores this much less per tier below the hardest comfortable zone. */
  zoneTierBonus: number;
  /** Kills per full HP bar that count as power ratio 1 (ratio = √(killsPerLife / zoneRefKills)). */
  zoneRefKills: number;
  /** Spawn-pressure multiplier on HP lost per kill = zoneCrowdRespawnSec / zone.respawnSec. */
  zoneCrowdRespawnSec: number;
  /** Fit multiplier of a fully crowded zone (see formulas.zoneShare); 1 = ignore crowding. */
  zoneShareFloor: number;
  wanderScore: number;
  /** Economy (M2). */
  bagCapacity: number;
  townStartingGold: number;
  spendRatio: number;
  minUpgradeGain: number;
  enhanceStatPerLevel: number;
  enhanceGoldReserveMul: number;
  craftLevelAhead: number;
  bagReturnFrac: number;
  /** Progression (M3). */
  maxLevel: number;
  maxReincarnation: number;
  /** Base stat multiplier per reincarnation: × (1 + n × reincStatBonus). */
  reincStatBonus: number;
  traitPointsPerReinc: number;
  /** One trait point every N levels. */
  traitPointLevelStep: number;
  /** Balance pass (gold sinks, shop turnover, monster burst). */
  /** Town pays this fraction of a gear's basePrice in gold to start crafting it. */
  craftGoldFrac: number;
  /** Share of forge/academy fees that goes to the town; the rest leaves the economy. */
  feeTownShare: number;
  /** Shop items unsold for shopStaleSec get marked down by shopMarkdownPct% every shopStaleSec, down to shopMarkdownFloor × list price; scrapped after shopScrapSec. */
  shopStaleSec: number;
  shopMarkdownPct: number;
  shopMarkdownFloor: number;
  shopScrapSec: number;
  /** Damage multiplier of a monster critical hit (chance = MonsterDef.crit %). */
  monsterCritMultiplier: number;
  /** Trading Post material requests (GDD §5). The post buys only requested units; the rest is discarded. */
  /** Auto-request: per useful recipe, keep materials for min(hunters it would upgrade, requestMaxCopies) crafts. */
  requestMaxCopies: number;
  /** Hunt score × (1 + requestZoneBonus × requested share of the zone's drop value). */
  requestZoneBonus: number;
  /** Max units a player request (town.requestMaterial) may ask for per material. */
  requestMaxUnits: number;
  /** Hunter receives round(price × (1 − tradeSaleTax)) per unit; the town pays the same (the tax is simply not paid out). */
  tradeSaleTax: number;
  /**
   * Unrequested materials: the post buys them at round(price × tradeSurplusPriceFrac × (1 − tradeSaleTax)) for export
   * (never stored), paid only from town gold above tradeSurplusFloorMul × autoCraftReserve; the rest is discarded.
   */
  tradeSurplusPriceFrac: number;
  tradeSurplusFloorMul: number;
  /** A hunter only counts as a recipe beneficiary (auto-craft, auto-requests) with shop budget ≥ craftAffordFrac × basePrice. */
  craftAffordFrac: number;
  /** Service price = round(base × (1 + servicePriceLevelPct / 100 × (level − 1))). */
  servicePriceLevelPct: number;
  /** AI enhance (TECH_SPEC §5.2). Gold reserve to try an enhance = cost × enhanceGoldReserveMul / successRate^enhanceRiskExp. */
  enhanceRiskExp: number;
  /** The AI never tries an enhance step below this success rate. */
  enhanceMinSuccess: number;
  /** Fraction of the next gear upgrade's shop budget kept back before enhancing an outdated piece. */
  upgradeSavingsFrac: number;
  /** Quality multiplier the AI assumes for a gear piece it has not seen yet (upgradeSavings). */
  aiTypicalQualityMult: number;
  /** Enhance score = (enhanceBaseScore + enhanceGainWeight × expected relative slot gain) × econMul. */
  enhanceBaseScore: number;
  enhanceGainWeight: number;
  /** Town goal scores (TECH_SPEC §5.2), all × econMul = max(needsOk, econMulFloor). */
  /** Shop: shopBaseScore + min(gain, 1) × shopGainWeight. */
  shopBaseScore: number;
  shopGainWeight: number;
  /** Sell: sellBaseScore + sellFillWeight × bagFill. */
  sellBaseScore: number;
  sellFillWeight: number;
  /** Academy: learn a skill / a trait. */
  learnSkillScore: number;
  learnTraitScore: number;
  econMulFloor: number;
  /** Services: skipped when need ≥ serviceFullFrac; need < softNeedFrac → serviceLowBase + serviceLowWeight × (1 − need), else serviceWeight × (1 − need). */
  serviceFullFrac: number;
  serviceLowBase: number;
  serviceLowWeight: number;
  serviceWeight: number;
  /** ReturnTown score with a full bag the trading post will take. */
  bagReturnScore: number;
  /** Idling in town (wander/rest) = max(wanderScore, restScoreWeight × (1 − needsOk)). */
  restScoreWeight: number;
  [key: string]: number;
}

export interface LocEntry {
  key: string;
  vi: string;
  en: string;
}

export interface GameConfig {
  version: string;
  formula: FormulaParams;
  classes: ClassDef[];
  personalities: PersonalityDef[];
  statGrades: StatGradeDef[];
  nodes: MapNode[];
  edges: MapEdge[];
  buildings: BuildingDef[];
  zones: ZoneDef[];
  monsters: MonsterDef[];
  materials: MaterialDef[];
  gear: GearDef[];
  qualities: GearQualityDef[];
  /** Sorted by level; enhance[i] is the step to level i+1. */
  enhance: EnhanceDef[];
  jobs: JobDef[];
  skills: SkillDef[];
  traits: TraitDef[];
  /** Sorted by order (index 0 = starting difficulty). */
  difficulties: DifficultyDef[];
  loc: LocEntry[];
  /** Lookups built by the loader. */
  index: {
    classes: Map<string, ClassDef>;
    personalities: Map<string, PersonalityDef>;
    nodes: Map<string, MapNode>;
    buildings: Map<string, BuildingDef>;
    zones: Map<string, ZoneDef>;
    monsters: Map<string, MonsterDef>;
    materials: Map<string, MaterialDef>;
    gear: Map<string, GearDef>;
    qualities: Map<string, GearQualityDef>;
    loc: Map<string, LocEntry>;
    /** First building of each economic kind (M2 has exactly one of each, except craft). */
    tradingPost: string;
    shop: string;
    forge: string;
    academy: string;
    jobs: Map<string, JobDef>;
    /** classId → jobs sorted by tier. */
    jobsByClass: Map<string, JobDef[]>;
    skills: Map<string, SkillDef>;
    traits: Map<string, TraitDef>;
    difficulties: Map<string, DifficultyDef>;
    /** The single town square node (spawn / revive / return point). */
    squareNode: string;
    /** Field node ids per zone. */
    zoneNodes: Map<string, string[]>;
  };
}
