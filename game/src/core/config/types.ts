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
  /** M5 (TECH_SPEC §5.5): positive / negative / neutral for the player (display only; absent = neutral). */
  kind?: 'positive' | 'negative' | 'neutral';
  modifiers: PersonalityModifier[];
}

/**
 * Personality modifier targets read by the sim (TECH_SPEC §5.5). `<need>` = hp/satiety/mood/stamina.
 * goal.hunt, goal.service.<need>: utility × factor; spendRatio: shop/enhance/craft budget × factor;
 * decay.<need>: need loss × factor; urgent.<need>: urgent threshold × factor (urgent.hp = retreat line);
 * moveSpeed: × factor; M5: gain.gold (kill gold before tax), gain.exp (kill EXP), enhance.success (success rate).
 */
export const PERSONALITY_TARGETS: readonly string[] = [
  'goal.hunt', 'spendRatio', 'moveSpeed',
  ...(['hp', 'satiety', 'mood', 'stamina'] as const).flatMap((n) => [`goal.service.${n}`, `decay.${n}`, `urgent.${n}`]),
  'gain.gold', 'gain.exp', 'enhance.success',
];

export type HunterTierId = 'normal' | 'rare' | 'superior' | 'heroic' | 'legendary';
export const HUNTER_TIERS: readonly HunterTierId[] = ['normal', 'rare', 'superior', 'heroic', 'legendary'];

/**
 * M5 invitation ticket (config/invitation.json, TECH_SPEC §4.1): `town.invite` rolls a tier with `tierChances` (relative
 * weights), then stat grades conditioned on that tier. Paid with one ticket of this id (town.tickets) when the Town has
 * one, otherwise `gold` Town gold (absent = ticket only). `townHallLevel`: Town Hall level needed to buy it with gold.
 * `autoInvite`: the row the free auto-invite (few hunters left) uses (at most one row).
 */
export interface InvitationDef {
  id: string;
  nameKey: string;
  tierChances: Record<HunterTierId, number>;
  gold?: number;
  townHallLevel?: number;
  autoInvite?: boolean;
}

export interface StatGradeDef {
  grade: 'normal' | 'high' | 'highest';
  point: number;
  rollChance: number;
}

export type MapNodeKind = 'square' | 'road' | 'door' | 'gate' | 'field' | 'portal';

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

export type BuildingKind =
  | 'service' | 'tradingPost' | 'craft' | 'shop' | 'forge' | 'academy' | 'townHall' | 'storehouse'
  // M5 special buildings (TECH_SPEC §5.15), at most one of each:
  | 'training' | 'bank' | 'monument' | 'fountain' | 'library';
export const BUILDING_KINDS: readonly BuildingKind[] = [
  'service', 'tradingPost', 'craft', 'shop', 'forge', 'academy', 'townHall', 'storehouse',
  'training', 'bank', 'monument', 'fountain', 'library',
];

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
  /**
   * Gear tier of this difficulty (TECH_SPEC §5.8): gear crafted at this tier has main stat × gearStatMul and
   * price/craft gold × gearPriceMul (absent = 1). The first difficulty is the base tier (1, no essence).
   */
  gearStatMul?: number;
  gearPriceMul?: number;
  /** Loc key of the tier prefix shown before the gear name (absent = no prefix). */
  gearPrefixKey?: string;
  /** Material dropped only by monsters spawned under this difficulty (chance essenceDropChance per kill); tier crafts need it. */
  essenceId?: string;
  essenceDropChance?: number;
}

/** Gold, Town Storage materials and build time to reach one building level (TECH_SPEC §5.12). */
export interface BuildingLevelCost {
  gold: number;
  materials: { materialId: string; count: number }[];
  sec: number;
}

/**
 * A building TYPE (TECH_SPEC §5.12). Where it stands is a plot (`building_plot`); its level lives in the world.
 * Per-level arrays have length maxLevel: index i = level i + 1. upgradeCost[0] is the cost to build (level 1).
 * At most one instance per type (maxCount 1), so systems keep addressing buildings by type id.
 */
export interface BuildingDef {
  id: string;
  nameKey: string;
  kind: BuildingKind;
  maxLevel: number;
  /** Town Hall level needed to build this type. Any level of a non-Town-Hall building is also capped at the Town Hall level. */
  requires: { townHallLevel: number };
  upgradeCost: BuildingLevelCost[];
  /** service only: need restored, points per second while inside (per level), entry price (per level, before servicePrice scaling). */
  need?: NeedKey;
  restorePerSec?: number[];
  price?: number[];
  /** shop only: max items on sale (per level). */
  capacity?: number[];
  /** craft only: highest gear.level this building can craft (per level) — the craftable gear tier. */
  maxGearLevel?: number[];
  /** forge only: added to every enhance successRate (per level). */
  enhanceBonus?: number[];
  /** academy only: multiplier on skill study gold (per level). */
  studyGoldMul?: number[];
  /** tradingPost only: multiplier on tradeSurplusPriceFrac (per level). */
  surplusPriceMul?: number[];
  /** storehouse only: extra copies kept by the automatic material requests (per level). */
  requestCopies?: number[];
  /**
   * service only: max supply units in stock (per level; one unit = one serving, TECH_SPEC §5.14). Missing = the service
   * needs no supplies (unlimited, as before supplies existed).
   */
  supplyCap?: number[];
  /** Potion seller (the Infirmary, TECH_SPEC §5.14): max potions in stock over every tier (per level). */
  potionCap?: number[];
  // ---- M5 special buildings (TECH_SPEC §5.15), per level ----
  /**
   * training only: EXP one session grants, as a fraction of expToNext(hunter level); and how close to the town's top hunter
   * level training can bring a hunter (it may train while level < top level − trainLevelGap).
   */
  trainExpFrac?: number[];
  trainLevelGap?: number[];
  /** bank only: multiplier on the non-urgent auto-investment floor (investTargetMul × townGoldTarget); no gold is created. */
  investFloorMul?: number[];
  /** monument only: permanent town aura, percent ATK / DEF for every hunter (own category in hunterStats). */
  auraAtkPct?: number[];
  auraDefPct?: number[];
  /** fountain only: multiplier on townIdleRegenPerSec, and on the death timer (reviveSec). */
  townRegenMul?: number[];
  reviveSecMul?: number[];
  /** library only: percent extra EXP from kills (not from training or journeys). */
  killExpPct?: number[];
}

export type ConsumableKind = 'supply' | 'potion';

/**
 * A stock recipe (config/consumable.json, TECH_SPEC §5.14): `materials` from Town Storage → `units` in the stock of
 * `buildingId` after `craftSec`. `kind` supply = service servings (fungible across tiers); potion = an HP potion hunters
 * buy (`price` before level scaling) and drink in the field (`heal` × max HP). Rows of one building + kind form a tier
 * ladder by `minLevel` (the tier a hunter / the town median level uses).
 */
export interface ConsumableDef {
  id: string;
  nameKey?: string;
  kind: ConsumableKind;
  buildingId: string;
  minLevel: number;
  materials: { materialId: string; count: number }[];
  units: number;
  craftSec: number;
  heal?: number;
  price?: number;
}

/** A building plot (TECH_SPEC §5.12): a fixed spot on the map with its own door node (enterable only once built). */
export interface BuildingPlotDef {
  id: string;
  doorNode: string;
  /** Town Hall level that unlocks the plot. */
  townHallLevel: number;
  /** Building standing here in a new game (and at what level). */
  startBuilding?: string;
  startLevel?: number;
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
  /** Static crowd factor = zoneCrowdRespawnSec / zone.respawnSec; only journeys use it (the AI uses zoneCrowdMul/zoneCrowdMinRho). */
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
  /**
   * Unsold shop items are marked down by shopMarkdownPct% of list price every shopStaleSec, down to
   * shopMarkdownFloor × list price, and scrapped after sitting at the floor for shopFloorHoldSec
   * (scrap age = shopScrapAgeSec: steps-to-floor × shopStaleSec + shopFloorHoldSec; < 0 = never scrap).
   */
  shopStaleSec: number;
  shopMarkdownPct: number;
  shopMarkdownFloor: number;
  shopFloorHoldSec: number;
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
  /**
   * A hunter counts as a recipe beneficiary (auto-craft, auto-requests) when the quality rolls that would be an
   * upgrade for them AND cost ≤ budget / craftAffordFrac (list price of that quality) have total craftChance ≥ craftMinSellChance.
   */
  craftAffordFrac: number;
  craftMinSellChance: number;
  /** Service price = round(base × (1 + servicePriceLevelPct / 100 × (level − 1))). */
  servicePriceLevelPct: number;
  /** AI enhance (TECH_SPEC §5.2). Gold reserve to try an enhance = cost × enhanceGoldReserveMul / successRate^enhanceRiskExp. */
  enhanceRiskExp: number;
  /** The AI never tries an enhance step below this success rate. */
  enhanceMinSuccess: number;
  /**
   * The AI only tries an enhance whose expected gain net of the dropOnFail loss is ≥ enhanceMinNetFrac × the
   * success-weighted step (ai/utility.bestEnhance; 0 = never a losing gamble, p ≥ 0.5 on drop steps).
   */
  enhanceMinNetFrac: number;
  /**
   * An enhance may dip into the gear savings only when its expected relative gain per gold is ≥ enhanceVsUpgradeMul ×
   * that of the upgrade saved for (the enhance is lost when the piece is replaced).
   */
  enhanceVsUpgradeMul: number;
  /**
   * Gold kept back before enhancing, as a fraction of the gold whose shop budget covers the cheapest upgrade
   * (price / spendRatio; ai/utility.upgradeSavings): upgradeSavingsFrac for gear the Town could craft,
   * upgradeSavingsConcreteFrac for one on sale or being crafted. 1 = hold the full price.
   */
  upgradeSavingsFrac: number;
  upgradeSavingsConcreteFrac: number;
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
  /**
   * Retreat (TECH_SPEC §5.2): HP floor to head home = min(retreatHpCap, (retreatTripMul × expected HP lost on the
   * way home + retreatBurstMul × next hit of every monster on the hunter) / maxHp); between fights the hunter also
   * leaves if one more kill (× retreatKillMul) would cross it.
   */
  retreatTripMul: number;
  retreatKillMul: number;
  retreatHpCap: number;
  /**
   * Town treasury target = max(feeTownTargetMin, feeTownTargetMul × autoCraftReserve). Above it the town's fee share
   * shrinks: feeTownShare × target / townGold (the rest of the fee leaves the economy), so a rich town stops piling up gold.
   */
  feeTownTargetMul: number;
  feeTownTargetMin: number;
  /** Extra service price above servicePriceLateLevel: + servicePriceLatePct / 100 × (level − servicePriceLateLevel) × base. */
  servicePriceLatePct: number;
  servicePriceLateLevel: number;
  /** Bounties (TECH_SPEC §5.9, systems/bounty.ts). Max active bounties (player + auto) and max kills per bounty. */
  bountyMaxActive: number;
  bountyMaxKills: number;
  /** On completion the kingdom pays the Town round(reward × bountyCompletionFrac) (< 1: a bounty is a net Town sink). */
  bountyCompletionFrac: number;
  /** AI zone choice × (1 + bountyZoneBonus × bounty-target share of the zone's spawn weight), normalised like requests. */
  bountyZoneBonus: number;
  /** Bounty-target drops × (1 + bountyTormentDropBonus × (difficulty order − bountyTormentFromOrder + 1)) from that order on. */
  bountyTormentFromOrder: number;
  bountyTormentDropBonus: number;
  /**
   * Auto-bounty: every bountyAutoIntervalSec, if Town gold > bountyAutoGoldMul × townGoldTarget and no auto-bounty is
   * active, post bountyAutoKills kills for round(bountyAutoRewardFrac × (gold − target)); it expires (refund) after
   * bountyAutoExpireSec (0 = never).
   */
  bountyAutoIntervalSec: number;
  bountyAutoGoldMul: number;
  bountyAutoRewardFrac: number;
  bountyAutoKills: number;
  bountyAutoExpireSec: number;
  /**
   * Town buildings (TECH_SPEC §5.12, systems/town.ts). Auto-invest runs every townInvestIntervalSec; an "urgent" step
   * (a craft building whose gear tier cap is below max hunter level + craftLevelAhead + investCraftLeadLevels, or the Town
   * Hall level that blocks it) may spend down to investUrgentReserveMul × autoCraftReserve, any other step only gold above
   * investTargetMul × townGoldTarget. Materials missing for investImportSec are bought at investImportPriceMul × price.
   */
  townInvestIntervalSec: number;
  investCraftLeadLevels: number;
  investUrgentReserveMul: number;
  investTargetMul: number;
  investImportSec: number;
  investImportPriceMul: number;
  /**
   * The Town Hall step that unblocks a craft building is urgent investTownHallLeadLevels earlier than the craft step
   * itself; urgent steps import missing materials after investUrgentImportSec (non-urgent: investImportSec).
   */
  investTownHallLeadLevels: number;
  investUrgentImportSec: number;
  /**
   * Non-urgent step priority = investValue / gold (× investReadyMul when the materials are in storage), with
   * investValue = investValue<Kind> × effect gained (systems/town.investValue, TECH_SPEC §5.12).
   */
  investValueService: number;
  investValueShop: number;
  investValueForge: number;
  investValueAcademy: number;
  investValueTradingPost: number;
  investValueStorehouse: number;
  investValueTownHall: number;
  investValueCraft: number;
  investReadyMul: number;
  /** Max buildings under construction/upgrade at once (player and auto). */
  buildMaxConcurrent: number;
  /** Multipliers on every upgradeCost gold and sec (tuning). */
  buildCostMul: number;
  buildTimeMul: number;
  /**
   * Town tax on kill gold (TECH_SPEC §5.10, systems/tax.ts): tax = floor(gold × rate), rate = town.taxRate ?? taxRate in
   * [taxMinRate, taxMaxRate] (the `town.setTaxRate` bounds). Each taxed kill costs the killer
   * taxMoodPerKill × max(0, rate − taxMoodFreeRate) mood (× personality decay.mood).
   */
  taxRate: number;
  taxMinRate: number;
  taxMaxRate: number;
  taxMoodFreeRate: number;
  taxMoodPerKill: number;
  /** Journeys (TECH_SPEC §5.11, systems/journey.ts): hunters per team (GDD "3 NPC") and journeys running at once. */
  journeyTeamMax: number;
  journeyMaxActive: number;
  /**
   * Success chance = clamp(journeySuccessAtRec × (teamPower / recommendedPower)^journeySuccessExp,
   * journeySuccessMin, journeySuccessMax): journeySuccessAtRec at exactly the recommended power.
   */
  journeySuccessAtRec: number;
  journeySuccessExp: number;
  journeySuccessMin: number;
  journeySuccessMax: number;
  /** Returning hunters (either outcome) come back with satiety/mood/stamina at most journeyReturnNeedFrac × max. */
  journeyReturnNeedFrac: number;
  /**
   * Reincarnation Portal (TECH_SPEC §5.13): game seconds a hunter spends inside the portal before progression.reincarnate
   * runs (also counts down in wall-clock time while the game is closed, like a journey).
   */
  reincarnationSec: number;
  /** Live crowd factor on duel damage per kill = zoneCrowdMul × √max(zoneCrowdMinRho, monsters alive / hunters) (formulas.crowdFactor). */
  zoneCrowdMul: number;
  zoneCrowdMinRho: number;
  /** Retreat floor adds retreatBurstMul × Σ expected hit of the monsters on the hunter (TECH_SPEC §5.2). */
  retreatBurstMul: number;
  /** DEF reduction is the plain hyperbola up to this value, then bends smoothly towards defReductionCap (formulas.defReduction). */
  defSoftKnee: number;
  /** Kills per HP bar that count as journey power 1 per member (formulas.zonePower); the AI uses zoneRefKills. */
  journeyRefKills: number;
  /**
   * Gear tiers (TECH_SPEC §5.8): a dismantled item (shop item at scrap age, stored gear over gearStorageMax, command)
   * returns floor(count × dismantleReturnFrac) of every material of its recipe (incl. tier essence) to Town Storage.
   * 0 = old behaviour (scrapped, nothing back).
   */
  dismantleReturnFrac: number;
  /** Max reclaimed items kept in Town gear storage; the oldest beyond it are dismantled. */
  gearStorageMax: number;
  /** Essence units a tier craft needs: max(1, round(gear.level × craftEssencePerLevel)). */
  craftEssencePerLevel: number;
  /**
   * Auto difficulty (town.autoDifficulty): step up to the next unlocked difficulty when at least
   * ceil(diffAutoAdvanceFrac × hunters) hunters have reincarnation ≥ its unlockReincarnation. > 1 = never.
   */
  diffAutoAdvanceFrac: number;
  /**
   * Supplies and potions (TECH_SPEC §5.14, systems/supplies.ts, systems/consumables.ts). Automatic requests keep at most
   * supplyRequestBatches batches of the essential recipe per stock line.
   */
  supplyRequestBatches: number;
  /** Potions are sold once the Town Hall is at least potionTownHallLevel; hunters carry at most potionCarryMax. */
  potionTownHallLevel: number;
  potionCarryMax: number;
  /** Potion price = round(price × (1 + potionPriceLevelPct / 100 × max(0, level − minLevel))). */
  potionPriceLevelPct: number;
  /** A purchase spends at most potionSpendFrac × gold. AI score = potionBuyScore × econMul. */
  potionSpendFrac: number;
  potionBuyScore: number;
  /** Drink in the field below max(potionUseHpFrac, the HP retreat lines); potionCooldownSec between two potions. */
  potionUseHpFrac: number;
  potionCooldownSec: number;
  /**
   * Revive fee = round(reviveFeeBase + reviveFeePerLevel × (level − 1)), paid from gold above the hunter's Infirmary
   * price; a hunter who cannot pay it all pays what it can and waits reviveSec × reviveBrokeDelayMul.
   */
  reviveFeeBase: number;
  reviveFeePerLevel: number;
  reviveBrokeDelayMul: number;
  /**
   * M5 waiting queue and auto-invite (TECH_SPEC §4.1, systems/arrivals): at most queueMax hunters wait while Town slots are
   * full, one joins every queueArrivalIntervalSec; when townHunterCount ≤ autoInviteMaxHunters a free hunter of the
   * `autoInvite` invitation arrives every autoInviteIntervalSec. personalityRerollGold: Town gold per `hunter.rerollPersonality`.
   */
  queueMax: number;
  queueArrivalIntervalSec: number;
  autoInviteMaxHunters: number;
  autoInviteIntervalSec: number;
  personalityRerollGold: number;
  /**
   * Training Ground (TECH_SPEC §5.15): a session lasts trainSessionSec inside; price = round(trainGoldPerExp × EXP granted)
   * (through economy.feeTownCut); the AI trains only with gold ≥ price × trainGoldReserveMul + its gear savings;
   * score trainScore × econMul.
   */
  trainSessionSec: number;
  trainGoldPerExp: number;
  trainGoldReserveMul: number;
  trainScore: number;
  /** M5 special buildings (TECH_SPEC §5.15); auto-invest weights, same scheme as investValueService, see systems/town.investValue. */
  investValueTraining: number;
  investValueBank: number;
  investValueMonument: number;
  investValueFountain: number;
  investValueLibrary: number;
  [key: string]: number;
}

/** A journey destination (config/journey.json, TECH_SPEC §5.11). */
export interface JourneyDef {
  id: string;
  nameKey: string;
  /** Game seconds away (also counts down in wall-clock time while offline). */
  durationSec: number;
  /** The foes of the journey: team power is measured against this zone's spawn mix (formulas.zonePower). */
  zoneId: string;
  /** Team power (Σ zonePower of the members) at which the success chance is journeySuccessAtRec. */
  recommendedPower: number;
  /** Town gold paid when the team leaves (supplies; never refunded). */
  cost: number;
  /** Success rewards: Town gold and EXP per member (both × difficulty rewardMul), materials into Town storage. */
  gold: number;
  exp: number;
  materials: { materialId: string; count: number }[];
  /** Rare finds on success: each rolled once; a hit is listed in the shop (or sold at the markdown floor when full). */
  rare: { gearId: string; qualityId: string; chance: number }[];
  /** Failure: members return with HP at failHpFrac × max and get failRewardFrac of the EXP (no gold/materials/rare). */
  failHpFrac: number;
  failRewardFrac: number;
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
  /** M5 invitations (config/invitation.json), config order. */
  invitations: InvitationDef[];
  nodes: MapNode[];
  edges: MapEdge[];
  buildings: BuildingDef[];
  /** Building plots in config order (TECH_SPEC §5.12). */
  plots: BuildingPlotDef[];
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
  journeys: JourneyDef[];
  /** Stock recipes in config order (TECH_SPEC §5.14). */
  consumables: ConsumableDef[];
  loc: LocEntry[];
  /** Lookups built by the loader. */
  index: {
    classes: Map<string, ClassDef>;
    personalities: Map<string, PersonalityDef>;
    nodes: Map<string, MapNode>;
    buildings: Map<string, BuildingDef>;
    plots: Map<string, BuildingPlotDef>;
    /** The single Town Hall building type. */
    townHall: string;
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
    journeys: Map<string, JourneyDef>;
    consumables: Map<string, ConsumableDef>;
    invitations: Map<string, InvitationDef>;
    /** Id of the invitation with autoInvite (TECH_SPEC §4.1), or null (auto-invite rolls a plain visitor). */
    autoInvitation: string | null;
    /** The building that sells potions (first building with potionCap), or null. */
    potionSeller: string | null;
    /** The single town square node (spawn / revive / return point). */
    squareNode: string;
    /** The Reincarnation Portal node (map kind "portal"; the square when the map has none). */
    portalNode: string;
    /** Field node ids per zone. */
    zoneNodes: Map<string, string[]>;
  };
}
