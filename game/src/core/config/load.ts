import { validateTables, type ConfigIssue, type FieldSpec, type TableSpec } from './schema';
import {
  BUILDING_KINDS, GEAR_SLOTS, GEAR_STATS, HUNTER_TIERS, MOD_STATS, NEED_KEYS, PERSONALITY_TARGETS, STAT_KEYS,
  type GearGradeDef, type GearOptionDef, type GearSetDef, type GearSkillDef,
  type InvitationDef, type PersonalityDef, type BuildingDef, type BuildingPlotDef, type ConsumableDef, type DifficultyDef, type JourneyDef, type EnhanceDef, type JobDef, type SkillDef, type TraitDef, type FormulaParams, type GameConfig, type GearDef, type GearQualityDef,
  type MapEdge, type MapNode, type MaterialDef, type MonsterDef, type ZoneDef,
} from './types';

const range: FieldSpec = { kind: 'array', length: 2, of: { kind: 'number', min: 0 } };
const gradeRanges: FieldSpec = { kind: 'array', length: 3, of: range };
/** Optional per-level list of a building (length = maxLevel, TECH_SPEC §8.1). */
const perLevel = (of: FieldSpec): FieldSpec => ({ kind: 'array', lengthFrom: 'maxLevel', optional: true, of });

/** Schema for every config table. Add new tables here (TECH_SPEC §8). */
export const TABLE_SPECS: Record<string, TableSpec> = {
  loc: {
    idField: 'key',
    row: { key: { kind: 'string', nonEmpty: true }, vi: { kind: 'string' }, en: { kind: 'string' } },
  },
  class: {
    idField: 'id',
    row: {
      id: { kind: 'string', nonEmpty: true },
      nameKey: { kind: 'ref', table: 'loc' },
      attackSpeed: { kind: 'number', min: 0.05 },
      statRanges: { kind: 'record', keys: STAT_KEYS, of: gradeRanges },
    },
  },
  personality: {
    idField: 'id',
    row: {
      id: { kind: 'string', nonEmpty: true },
      nameKey: { kind: 'ref', table: 'loc' },
      weight: { kind: 'number', min: 0 },
      kind: { kind: 'enum', values: ['positive', 'negative', 'neutral'], optional: true },
      modifiers: {
        kind: 'array',
        of: {
          kind: 'object',
          fields: {
            target: { kind: 'string', nonEmpty: true },
            op: { kind: 'enum', values: ['mul', 'add'] },
            value: { kind: 'number' },
          },
        },
      },
    },
  },
  invitation: {
    idField: 'id',
    row: {
      id: { kind: 'string', nonEmpty: true },
      nameKey: { kind: 'ref', table: 'loc' },
      tierChances: { kind: 'record', keys: HUNTER_TIERS, of: { kind: 'number', min: 0 } },
      gold: { kind: 'int', min: 0, optional: true },
      townHallLevel: { kind: 'int', min: 1, optional: true },
      autoInvite: { kind: 'bool', optional: true },
    },
  },
  stat_grade: {
    idField: 'grade',
    row: {
      grade: { kind: 'enum', values: ['normal', 'high', 'highest'] },
      point: { kind: 'int', min: 0 },
      rollChance: { kind: 'number', min: 0, max: 1 },
    },
  },
  zone: {
    idField: 'id',
    row: {
      id: { kind: 'string', nonEmpty: true },
      nameKey: { kind: 'ref', table: 'loc' },
      entryNode: { kind: 'ref', table: 'map_node' },
      monsterCap: { kind: 'int', min: 0 },
      respawnSec: { kind: 'number', min: 0 },
      monsters: {
        kind: 'array',
        minLength: 1,
        of: { kind: 'object', fields: { monsterId: { kind: 'ref', table: 'monster' }, weight: { kind: 'number', min: 0 } } },
      },
    },
  },
  map_node: {
    idField: 'id',
    row: {
      id: { kind: 'string', nonEmpty: true },
      x: { kind: 'number' },
      y: { kind: 'number' },
      kind: { kind: 'enum', values: ['square', 'road', 'door', 'gate', 'field', 'portal'] },
      zoneId: { kind: 'ref', table: 'zone', optional: true },
    },
  },
  map_edge: {
    row: {
      a: { kind: 'ref', table: 'map_node' },
      b: { kind: 'ref', table: 'map_node' },
      road: { kind: 'bool' },
    },
  },
  building: {
    idField: 'id',
    row: {
      id: { kind: 'string', nonEmpty: true },
      nameKey: { kind: 'ref', table: 'loc' },
      kind: { kind: 'enum', values: BUILDING_KINDS },
      maxLevel: { kind: 'int', min: 1 },
      requires: { kind: 'object', fields: { townHallLevel: { kind: 'int', min: 1 } } },
      upgradeCost: {
        kind: 'array',
        lengthFrom: 'maxLevel',
        of: {
          kind: 'object',
          fields: {
            gold: { kind: 'int', min: 0 },
            materials: {
              kind: 'array',
              of: { kind: 'object', fields: { materialId: { kind: 'ref', table: 'material' }, count: { kind: 'int', min: 1 } } },
            },
            sec: { kind: 'number', min: 0 },
          },
        },
      },
      need: { kind: 'enum', values: NEED_KEYS, optional: true },
      restorePerSec: perLevel({ kind: 'number', min: 0.001 }),
      price: perLevel({ kind: 'int', min: 0 }),
      capacity: perLevel({ kind: 'int', min: 1 }),
      maxGearLevel: perLevel({ kind: 'int', min: 0 }),
      enhanceBonus: perLevel({ kind: 'number', min: 0, max: 1 }),
      studyGoldMul: perLevel({ kind: 'number', min: 0 }),
      surplusPriceMul: perLevel({ kind: 'number', min: 0 }),
      requestCopies: perLevel({ kind: 'int', min: 0 }),
      supplyCap: perLevel({ kind: 'int', min: 0 }),
      potionCap: perLevel({ kind: 'int', min: 0 }),
      trainExpFrac: perLevel({ kind: 'number', min: 0, max: 1 }),
      trainLevelGap: perLevel({ kind: 'int', min: 0 }),
      investFloorMul: perLevel({ kind: 'number', min: 0, max: 1 }),
      auraAtkPct: perLevel({ kind: 'number', min: 0, max: 100 }),
      auraDefPct: perLevel({ kind: 'number', min: 0, max: 100 }),
      townRegenMul: perLevel({ kind: 'number', min: 0 }),
      reviveSecMul: perLevel({ kind: 'number', min: 0, max: 1 }),
      killExpPct: perLevel({ kind: 'number', min: 0, max: 100 }),
    },
  },
  building_plot: {
    idField: 'id',
    row: {
      id: { kind: 'string', nonEmpty: true },
      doorNode: { kind: 'ref', table: 'map_node' },
      townHallLevel: { kind: 'int', min: 1 },
      startBuilding: { kind: 'ref', table: 'building', optional: true },
      startLevel: { kind: 'int', min: 1, optional: true },
      x: { kind: 'number' },
      y: { kind: 'number' },
      w: { kind: 'number', min: 0.1 },
      h: { kind: 'number', min: 0.1 },
    },
  },
  monster: {
    idField: 'id',
    row: {
      id: { kind: 'string', nonEmpty: true },
      nameKey: { kind: 'ref', table: 'loc' },
      level: { kind: 'int', min: 1 },
      hp: { kind: 'number', min: 1 },
      atk: { kind: 'number', min: 0 },
      def: { kind: 'number', min: 0 },
      attackSpeed: { kind: 'number', min: 0.05 },
      moveSpeed: { kind: 'number', min: 0 },
      aggroRange: { kind: 'number', min: 0 },
      exp: { kind: 'number', min: 0 },
      gold: { kind: 'int', min: 0 },
      crit: { kind: 'number', min: 0, max: 100 },
      drops: {
        kind: 'array',
        of: { kind: 'object', fields: { materialId: { kind: 'ref', table: 'material' }, chance: { kind: 'number', min: 0, max: 1 } } },
      },
    },
  },
  material: {
    idField: 'id',
    row: {
      id: { kind: 'string', nonEmpty: true },
      nameKey: { kind: 'ref', table: 'loc' },
      price: { kind: 'int', min: 0 },
    },
  },
  gear: {
    idField: 'id',
    row: {
      id: { kind: 'string', nonEmpty: true },
      nameKey: { kind: 'ref', table: 'loc' },
      slot: { kind: 'enum', values: GEAR_SLOTS },
      level: { kind: 'int', min: 1 },
      mainStat: { kind: 'enum', values: ['atk', 'def', 'hp'] },
      mainValue: { kind: 'number', min: 0 },
      craftBuilding: { kind: 'ref', table: 'building' },
      craftSec: { kind: 'number', min: 0.1 },
      materials: {
        kind: 'array',
        minLength: 1,
        of: { kind: 'object', fields: { materialId: { kind: 'ref', table: 'material' }, count: { kind: 'int', min: 1 } } },
      },
      basePrice: { kind: 'int', min: 0 },
      essenceMul: { kind: 'number', min: 0.01, max: 10, optional: true },
      setId: { kind: 'ref', table: 'gear_set', optional: true },
    },
  },
  // M5 gear depth (TECH_SPEC §4.2): grades → option lines, sets, gear skills.
  gear_grade: {
    idField: 'id',
    row: {
      id: { kind: 'string', nonEmpty: true },
      nameKey: { kind: 'ref', table: 'loc' },
      chance: { kind: 'number', min: 0, max: 1 },
      options: { kind: 'int', min: 0, max: 8 },
      uniques: { kind: 'int', min: 0, max: 8 },
      negChance: { kind: 'number', min: 0, max: 1 },
      valueMul: { kind: 'number', min: 0 },
      priceMult: { kind: 'number', min: 0 },
    },
  },
  gear_option: {
    idField: 'id',
    row: {
      id: { kind: 'string', nonEmpty: true },
      nameKey: { kind: 'ref', table: 'loc' },
      kind: { kind: 'enum', values: ['positive', 'negative', 'unique'] },
      stat: { kind: 'enum', values: GEAR_STATS, optional: true },
      gearSkillId: { kind: 'ref', table: 'gear_skill', optional: true },
      min: { kind: 'number' },
      max: { kind: 'number' },
      weight: { kind: 'number', min: 0 },
      slots: { kind: 'array', of: { kind: 'enum', values: GEAR_SLOTS }, optional: true, minLength: 1 },
    },
  },
  gear_set: {
    idField: 'id',
    row: {
      id: { kind: 'string', nonEmpty: true },
      nameKey: { kind: 'ref', table: 'loc' },
      bonuses: {
        kind: 'array',
        minLength: 1,
        of: {
          kind: 'object',
          fields: {
            pieces: { kind: 'int', min: 1, max: 8 },
            stat: { kind: 'enum', values: GEAR_STATS, optional: true },
            value: { kind: 'number', optional: true },
            gearSkillId: { kind: 'ref', table: 'gear_skill', optional: true },
          },
        },
      },
    },
  },
  gear_skill: {
    idField: 'id',
    row: {
      id: { kind: 'string', nonEmpty: true },
      nameKey: { kind: 'ref', table: 'loc' },
      trigger: { kind: 'enum', values: ['attack'] },
      chance: { kind: 'number', min: 0, max: 1 },
      cooldownSec: { kind: 'number', min: 0 },
      skillId: { kind: 'ref', table: 'skill' },
      skillLevel: { kind: 'int', min: 1 },
    },
  },
  gear_quality: {
    idField: 'id',
    row: {
      id: { kind: 'string', nonEmpty: true },
      nameKey: { kind: 'ref', table: 'loc' },
      statMult: { kind: 'number', min: 0 },
      priceMult: { kind: 'number', min: 0 },
      craftChance: { kind: 'number', min: 0, max: 1 },
    },
  },
  enhance: {
    row: {
      level: { kind: 'int', min: 1 },
      successRate: { kind: 'number', min: 0, max: 1 },
      costFrac: { kind: 'number', min: 0 },
      dropOnFail: { kind: 'bool' },
    },
  },
  job: {
    idField: 'id',
    row: {
      id: { kind: 'string', nonEmpty: true },
      classId: { kind: 'ref', table: 'class' },
      tier: { kind: 'int', min: 0 },
      nameKey: { kind: 'ref', table: 'loc' },
      unlockLevel: { kind: 'int', min: 1 },
      statMult: { kind: 'number', min: 0.1 },
    },
  },
  skill: {
    idField: 'id',
    row: {
      id: { kind: 'string', nonEmpty: true },
      classId: { kind: 'ref', table: 'class' },
      nameKey: { kind: 'ref', table: 'loc' },
      jobTierMin: { kind: 'int', min: 0 },
      kind: { kind: 'enum', values: ['strike', 'aoe', 'buff'] },
      cooldownSec: { kind: 'number', min: 0.1 },
      maxLevel: { kind: 'int', min: 1 },
      value: { kind: 'array', lengthFrom: 'maxLevel', of: { kind: 'number', min: 0 } },
      keepSec: { kind: 'array', lengthFrom: 'maxLevel', optional: true, of: { kind: 'number', min: 0 } },
      radius: { kind: 'number', min: 0, optional: true },
      buffStat: { kind: 'enum', values: MOD_STATS, optional: true },
      studyLevel: { kind: 'array', lengthFrom: 'maxLevel', of: { kind: 'int', min: 1 } },
      studyGold: { kind: 'array', lengthFrom: 'maxLevel', of: { kind: 'int', min: 0 } },
    },
  },
  trait: {
    idField: 'id',
    row: {
      id: { kind: 'string', nonEmpty: true },
      classId: { kind: 'ref', table: 'class', optional: true },
      nameKey: { kind: 'ref', table: 'loc' },
      stat: { kind: 'enum', values: MOD_STATS },
      valuePerLevel: { kind: 'number' },
      maxLevel: { kind: 'int', min: 1 },
      pointCost: { kind: 'int', min: 1 },
    },
  },
  difficulty: {
    idField: 'id',
    row: {
      id: { kind: 'string', nonEmpty: true },
      order: { kind: 'int', min: 0 },
      nameKey: { kind: 'ref', table: 'loc' },
      unlockHunters: { kind: 'int', min: 0 },
      unlockReincarnation: { kind: 'int', min: 0 },
      monsterHpMul: { kind: 'number', min: 0.01 },
      monsterAtkMul: { kind: 'number', min: 0.01 },
      monsterDefMul: { kind: 'number', min: 0.01 },
      rewardMul: { kind: 'number', min: 0.01 },
      gearStatMul: { kind: 'number', min: 0.01, optional: true },
      gearPriceMul: { kind: 'number', min: 0.01, optional: true },
      gearPrefixKey: { kind: 'ref', table: 'loc', optional: true },
      essenceId: { kind: 'ref', table: 'material', optional: true },
      essenceDropChance: { kind: 'number', min: 0, max: 1, optional: true },
    },
  },
  journey: {
    idField: 'id',
    row: {
      id: { kind: 'string', nonEmpty: true },
      nameKey: { kind: 'ref', table: 'loc' },
      durationSec: { kind: 'number', min: 1 },
      zoneId: { kind: 'ref', table: 'zone' },
      recommendedPower: { kind: 'number', min: 0.01 },
      cost: { kind: 'int', min: 0 },
      gold: { kind: 'int', min: 0 },
      exp: { kind: 'number', min: 0 },
      materials: {
        kind: 'array',
        of: { kind: 'object', fields: { materialId: { kind: 'ref', table: 'material' }, count: { kind: 'int', min: 1 } } },
      },
      rare: {
        kind: 'array',
        of: {
          kind: 'object',
          fields: {
            gearId: { kind: 'ref', table: 'gear' },
            qualityId: { kind: 'ref', table: 'gear_quality' },
            chance: { kind: 'number', min: 0, max: 1 },
          },
        },
      },
      failHpFrac: { kind: 'number', min: 0.01, max: 1 },
      failRewardFrac: { kind: 'number', min: 0, max: 1 },
    },
  },
  // Supplies and potions (TECH_SPEC §5.14).
  consumable: {
    idField: 'id',
    row: {
      id: { kind: 'string', nonEmpty: true },
      nameKey: { kind: 'ref', table: 'loc', optional: true },
      kind: { kind: 'enum', values: ['supply', 'potion'] },
      buildingId: { kind: 'ref', table: 'building' },
      minLevel: { kind: 'int', min: 1 },
      materials: {
        kind: 'array',
        minLength: 1,
        of: { kind: 'object', fields: { materialId: { kind: 'ref', table: 'material' }, count: { kind: 'int', min: 1 } } },
      },
      units: { kind: 'int', min: 1 },
      craftSec: { kind: 'number', min: 0.1 },
      heal: { kind: 'number', min: 0.01, max: 1, optional: true },
      price: { kind: 'int', min: 0, optional: true },
    },
  },
};

/** Formula keys that must exist (other numeric keys are allowed for tuning). */
export const REQUIRED_FORMULA_KEYS: readonly (keyof FormulaParams)[] = [
  'needMax', 'staminaDecayPerSec', 'satietyDecayPerSec', 'moodDecayPerSec', 'satietyPerAttack', 'moodPerHitTaken',
  'townIdleRegenPerSec', 'hunterSlots', 'arrivalIntervalSec', 'personalitiesPerHunter', 'startingGold',
  'moveSpeed', 'roadSpeedMul', 'arriveEpsilon', 'attackRange',
  'defPerLevel', 'defFlat', 'defReductionCap', 'minDamage', 'levelGapGrace', 'levelGapStep', 'levelGapMin', 'critMultiplier', 'critChanceCap', 'critOverflowMult',
  'dodgeCap', 'dodgeHalf', 'traitPctCap', 'buffPctCap', 'minAttackInterval', 'moodPenaltyFrac', 'moodStatFloor',
  'monsterLeashRange',
  'reviveSec', 'reviveHpFrac', 'expBase', 'expExponent', 'levelHpGain', 'levelAtkGain', 'levelDefGain',
  'decisionIntervalSec', 'decisionNoise', 'huntStickiness', 'urgentHpFrac', 'urgentSatietyFrac', 'urgentMoodFrac',
  'urgentStaminaFrac', 'softNeedFrac', 'zoneFitMin', 'zoneFitBest', 'zoneFitEasy',
  'zoneFitRampLow', 'zoneFitDecay', 'zoneFitFloor', 'zoneTierBonus', 'zoneRefKills', 'zoneCrowdRespawnSec', 'zoneShareFloor', 'wanderScore',
  'bagCapacity', 'townStartingGold', 'spendRatio', 'minUpgradeGain', 'enhanceStatPerLevel', 'enhanceGoldReserveMul',
  'craftLevelAhead', 'bagReturnFrac',
  'maxLevel', 'maxReincarnation', 'reincStatBonus', 'traitPointsPerReinc', 'traitPointLevelStep',
  'craftGoldFrac', 'feeTownShare', 'shopStaleSec', 'shopMarkdownPct', 'shopMarkdownFloor', 'shopFloorHoldSec', 'monsterCritMultiplier',
  'requestMaxCopies', 'requestZoneBonus', 'requestMaxUnits', 'tradeSaleTax', 'servicePriceLevelPct',
  'tradeSurplusPriceFrac', 'tradeSurplusFloorMul', 'craftAffordFrac', 'craftMinSellChance',
  'enhanceRiskExp', 'enhanceMinSuccess', 'upgradeSavingsFrac', 'aiTypicalQualityMult', 'enhanceBaseScore', 'enhanceGainWeight',
  'shopBaseScore', 'shopGainWeight', 'sellBaseScore', 'sellFillWeight', 'learnSkillScore', 'learnTraitScore', 'econMulFloor',
  'serviceFullFrac', 'serviceLowBase', 'serviceLowWeight', 'serviceWeight', 'bagReturnScore', 'restScoreWeight',
  'retreatTripMul', 'retreatKillMul', 'retreatHpCap',
  'feeTownTargetMul', 'feeTownTargetMin', 'servicePriceLatePct', 'servicePriceLateLevel',
  'bountyMaxActive', 'bountyMaxKills', 'bountyCompletionFrac', 'bountyZoneBonus', 'bountyTormentFromOrder', 'bountyTormentDropBonus',
  'bountyAutoIntervalSec', 'bountyAutoGoldMul', 'bountyAutoRewardFrac', 'bountyAutoKills', 'bountyAutoExpireSec',
  'townInvestIntervalSec', 'investCraftLeadLevels', 'investUrgentReserveMul', 'investTargetMul', 'investImportSec', 'investImportPriceMul',
  'buildMaxConcurrent', 'buildCostMul', 'buildTimeMul',
  'taxRate', 'taxMinRate', 'taxMaxRate', 'taxMoodFreeRate', 'taxMoodPerKill',
  'journeyTeamMax', 'journeyMaxActive', 'journeySuccessAtRec', 'journeySuccessExp', 'journeySuccessMin', 'journeySuccessMax',
  'journeyReturnNeedFrac',
  'reincarnationSec',
  'zoneCrowdMul', 'zoneCrowdMinRho', 'retreatBurstMul', 'defSoftKnee', 'journeyRefKills',
  // Economy pass 2 (TECH_SPEC §5.4, §5.8, §5.12).
  'enhanceMinNetFrac', 'upgradeSavingsConcreteFrac', 'enhanceVsUpgradeMul', 'investTownHallLeadLevels', 'investUrgentImportSec', 'investValueService', 'investValueShop', 'investValueForge', 'investValueAcademy', 'investValueTradingPost', 'investValueStorehouse', 'investValueTownHall', 'investValueCraft', 'investReadyMul',
  // Gear tiers per difficulty, reclaim, dismantle (TECH_SPEC §5.8).
  'dismantleReturnFrac', 'gearStorageMax', 'craftEssencePerLevel', 'diffAutoAdvanceFrac',
  // Supplies, potions, revive fee (TECH_SPEC §5.14).
  'supplyRequestBatches', 'potionTownHallLevel', 'potionCarryMax', 'potionPriceLevelPct', 'potionSpendFrac', 'potionBuyScore',
  'potionUseHpFrac', 'potionCooldownSec', 'reviveFeeBase', 'reviveFeePerLevel', 'reviveBrokeDelayMul',
  // M5 hunter systems: waiting queue, auto-invite, personality reroll (TECH_SPEC §4.1, §5.5).
  'queueMax', 'queueArrivalIntervalSec', 'autoInviteMaxHunters', 'autoInviteIntervalSec', 'personalityRerollGold',
  // M5 special buildings (TECH_SPEC §5.15).
  'investValueTraining', 'investValueBank', 'investValueMonument', 'investValueFountain', 'investValueLibrary',
  'trainSessionSec', 'trainGoldPerExp', 'trainGoldReserveMul', 'trainScore',
  // M5 gear options / sets / gear skills (TECH_SPEC §4.2).
  'gearPctCap', 'gearPctFloor', 'gearNeedSaveCap', 'gearWorthLifesteal', 'gearWorthGoldPct', 'gearWorthExpPct', 'gearWorthDropPct',
  'gearWorthNeedSavePct',
];

export class ConfigError extends Error {
  constructor(public readonly issues: ConfigIssue[]) {
    super(`Config invalid (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n` +
      issues.map((i) => `  ${i.path}: ${i.message}`).join('\n'));
    this.name = 'ConfigError';
  }
}

export interface RawConfig {
  meta: unknown;
  formula_params: unknown;
  [table: string]: unknown;
}

export function validateConfig(raw: RawConfig): ConfigIssue[] {
  const issues = validateTables(raw, TABLE_SPECS);

  const meta = raw.meta as { version?: unknown } | undefined;
  if (!meta || typeof meta.version !== 'string' || meta.version === '') {
    issues.push({ path: 'meta.version', message: 'required non-empty string' });
  }

  const fp = raw.formula_params;
  if (typeof fp !== 'object' || fp === null || Array.isArray(fp)) {
    issues.push({ path: 'formula_params', message: 'expected object of numbers' });
  } else {
    const o = fp as Record<string, unknown>;
    for (const k of REQUIRED_FORMULA_KEYS) if (!(k in o)) issues.push({ path: `formula_params.${k}`, message: 'required' });
    for (const [k, v] of Object.entries(o)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) issues.push({ path: `formula_params.${k}`, message: 'expected number' });
    }
    // Trading Post requests / price levers: ranges that would break the economy if wrong.
    const range = (k: string, min: number, max: number) => {
      const v = o[k];
      if (typeof v === 'number' && (v < min || v > max)) issues.push({ path: `formula_params.${k}`, message: `expected ${min}..${max}` });
    };
    range('requestMaxCopies', 0, 100);
    range('requestZoneBonus', 0, 10);
    range('requestMaxUnits', 1, 1e6);
    range('tradeSaleTax', 0, 0.99);
    range('servicePriceLevelPct', 0, 100);
    range('tradeSurplusPriceFrac', 0, 1);
    range('tradeSurplusFloorMul', 0, 1000);
    range('craftAffordFrac', 0, 10);
    range('feeTownShare', 0, 1);
    range('feeTownTargetMul', 0, 1000);
    range('feeTownTargetMin', 0, 1e9);
    range('servicePriceLatePct', 0, 100);
    range('servicePriceLateLevel', 0, 1000);
    range('craftMinSellChance', 0, 1);
    range('dismantleReturnFrac', 0, 1);
    range('gearStorageMax', 0, 1000);
    range('craftEssencePerLevel', 0, 100);
    range('diffAutoAdvanceFrac', 0, 1e6);
    // Shop markdown schedule: the floor must be reachable (and offered) before an item is scrapped.
    // The scrap age is derived from it (crafting.shopScrapAgeSec), so only the inputs need checking.
    range('shopStaleSec', 1, 1e6);
    range('shopMarkdownPct', 1e-6, 100);
    range('shopMarkdownFloor', 0.01, 1);
    range('shopFloorHoldSec', -1, 1e6);
    if ('shopScrapSec' in o) {
      issues.push({ path: 'formula_params.shopScrapSec', message: 'removed: scrap age = markdown steps to the floor × shopStaleSec + shopFloorHoldSec' });
    }
    // AI enhance / town goal scores.
    range('enhanceRiskExp', 0, 5);
    range('enhanceMinSuccess', 0, 1);
    range('upgradeSavingsFrac', 0, 10);
    range('aiTypicalQualityMult', 0.01, 10);
    range('econMulFloor', 0, 1);
    range('serviceFullFrac', 0, 1);
    range('retreatTripMul', 0, 100);
    range('retreatKillMul', 0, 100);
    range('retreatHpCap', 0, 0.95);
    // Bounties (TECH_SPEC §5.9).
    range('bountyMaxActive', 0, 100);
    range('bountyMaxKills', 1, 1e6);
    range('bountyCompletionFrac', 0, 1);
    range('bountyZoneBonus', 0, 10);
    range('bountyTormentFromOrder', 0, 1000);
    range('bountyTormentDropBonus', 0, 10);
    range('bountyAutoIntervalSec', 0.1, 1e6);
    range('bountyAutoGoldMul', 0, 100);
    range('bountyAutoRewardFrac', 0, 1);
    range('bountyAutoKills', 1, 1e6);
    range('bountyAutoExpireSec', 0, 1e7);
    // Town buildings (TECH_SPEC §5.12).
    range('townInvestIntervalSec', 0.1, 1e6);
    range('investCraftLeadLevels', 0, 1000);
    range('investUrgentReserveMul', 0, 1000);
    range('investTargetMul', 0, 100);
    range('investImportSec', 0, 1e7);
    range('investImportPriceMul', 0, 100);
    range('buildMaxConcurrent', 1, 100);
    range('buildCostMul', 0, 100);
    range('buildTimeMul', 0, 100);
    // Town tax (TECH_SPEC §5.10): 0 ≤ taxMinRate ≤ taxRate ≤ taxMaxRate ≤ 1.
    range('taxMinRate', 0, 1);
    range('taxMaxRate', 0, 1);
    range('taxRate', 0, 1);
    range('taxMoodFreeRate', 0, 1);
    range('taxMoodPerKill', 0, 100);
    if (typeof o.taxRate === 'number' && typeof o.taxMinRate === 'number' && typeof o.taxMaxRate === 'number' &&
      !(o.taxMinRate <= o.taxRate && o.taxRate <= o.taxMaxRate)) {
      issues.push({ path: 'formula_params.taxRate', message: 'need taxMinRate ≤ taxRate ≤ taxMaxRate' });
    }
    // Journeys (TECH_SPEC §5.11).
    range('journeyTeamMax', 1, 10);
    range('journeyMaxActive', 0, 100);
    range('journeySuccessAtRec', 0, 1);
    range('journeySuccessExp', 0, 10);
    range('journeySuccessMin', 0, 1);
    range('journeySuccessMax', 0, 1);
    range('journeyReturnNeedFrac', 0, 1);
    if (typeof o.journeySuccessMin === 'number' && typeof o.journeySuccessMax === 'number' && o.journeySuccessMin > o.journeySuccessMax) {
      issues.push({ path: 'formula_params.journeySuccessMin', message: 'must be <= journeySuccessMax' });
    }
    // Reincarnation Portal (TECH_SPEC §5.13).
    range('reincarnationSec', 0, 86400);
    // Economy pass 2.
    range('enhanceMinNetFrac', -1, 1);
    range('upgradeSavingsConcreteFrac', 0, 10);
    range('enhanceVsUpgradeMul', 0, 1e6);
    range('investTownHallLeadLevels', 0, 1000);
    range('investUrgentImportSec', 0, 1e7);
    range('investValueService', 0, 1000);
    range('investValueShop', 0, 1000);
    range('investValueForge', 0, 1000);
    range('investValueAcademy', 0, 1000);
    range('investValueTradingPost', 0, 1000);
    range('investValueStorehouse', 0, 1000);
    range('investValueTownHall', 0, 1000);
    range('investValueCraft', 0, 1000);
    range('investReadyMul', 0, 1000);
    range('trainSessionSec', 0.1, 3600);
    range('trainGoldPerExp', 0, 1000);
    range('trainGoldReserveMul', 0, 1000);
    range('trainScore', 0, 100);
    for (const k of ['investValueTraining', 'investValueBank', 'investValueMonument', 'investValueFountain', 'investValueLibrary']) range(k, 0, 1000);
    // Supplies, potions, revive fee (TECH_SPEC §5.14).
    range('supplyRequestBatches', 0, 100);
    range('potionTownHallLevel', 1, 100);
    range('potionCarryMax', 0, 100);
    range('potionPriceLevelPct', 0, 100);
    range('potionSpendFrac', 0, 1);
    range('potionBuyScore', 0, 10);
    range('potionUseHpFrac', 0, 0.95);
    range('potionCooldownSec', 0, 3600);
    range('reviveFeeBase', 0, 1e6);
    range('reviveFeePerLevel', 0, 1e6);
    range('reviveBrokeDelayMul', 1, 100);
    // M5 waiting queue / auto-invite / personality reroll (TECH_SPEC §4.1).
    range('queueMax', 0, 1000);
    range('queueArrivalIntervalSec', 1, 1e7);
    range('autoInviteMaxHunters', 0, 1000);
    range('autoInviteIntervalSec', 1, 1e7);
    range('personalityRerollGold', 0, 1e9);
  }

  const grades = raw.stat_grade;
  if (Array.isArray(grades)) {
    const sum = grades.reduce((s: number, g) => s + (typeof g?.rollChance === 'number' ? g.rollChance : 0), 0);
    if (Math.abs(sum - 1) > 1e-6) issues.push({ path: 'stat_grade', message: `rollChance must sum to 1 (got ${sum})` });
  }

  const classes = raw.class;
  if (Array.isArray(classes)) {
    classes.forEach((c, i) => {
      const sr = (c as { statRanges?: Record<string, unknown> })?.statRanges;
      if (!sr) return;
      for (const k of STAT_KEYS) {
        const g = sr[k];
        if (!Array.isArray(g)) continue;
        g.forEach((r, gi) => {
          if (Array.isArray(r) && typeof r[0] === 'number' && typeof r[1] === 'number' && r[0] > r[1]) {
            issues.push({ path: `class[${i}].statRanges.${k}[${gi}]`, message: 'min > max' });
          }
        });
      }
    });
  }

  if (issues.length === 0) issues.push(...validateMap(raw));
  return issues;
}

/** Cross-table map rules; runs only when table shapes are already valid. */
function validateMap(raw: RawConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const nodes = raw.map_node as MapNode[];
  const edges = raw.map_edge as MapEdge[];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const squares = nodes.filter((n) => n.kind === 'square');
  if (squares.length !== 1) issues.push({ path: 'map_node', message: `need exactly one "square" node, got ${squares.length}` });
  // Reincarnation Portal (TECH_SPEC §5.13): at most one (none = reincarnation happens at the square).
  const portals = nodes.filter((n) => n.kind === 'portal');
  if (portals.length > 1) issues.push({ path: 'map_node', message: `at most one "portal" node, got ${portals.length}` });

  nodes.forEach((n, i) => {
    if (n.kind === 'field' && !n.zoneId) issues.push({ path: `map_node[${i}].zoneId`, message: 'field node needs zoneId' });
    if (n.kind !== 'field' && n.zoneId) issues.push({ path: `map_node[${i}].zoneId`, message: 'only field nodes belong to a zone' });
  });
  edges.forEach((e, i) => {
    if (e.a === e.b) issues.push({ path: `map_edge[${i}]`, message: 'self loop' });
  });
  (raw.zone as ZoneDef[]).forEach((z, i) => {
    const n = byId.get(z.entryNode);
    if (n && n.zoneId !== z.id) issues.push({ path: `zone[${i}].entryNode`, message: `node "${z.entryNode}" is not a field node of this zone` });
  });
  const buildings = raw.building as BuildingDef[];
  const th = buildings.find((b) => b.kind === 'townHall');
  buildings.forEach((b, i) => {
    const need = (k: keyof BuildingDef) => {
      if (b[k] === undefined) issues.push({ path: `building[${i}].${k}`, message: `required for kind "${b.kind}"` });
    };
    if (b.kind === 'service') { need('need'); need('restorePerSec'); need('price'); }
    if (b.kind === 'shop') need('capacity');
    if (b.kind === 'craft') need('maxGearLevel');
    if (b.kind === 'forge') need('enhanceBonus');
    if (b.kind === 'academy') need('studyGoldMul');
    if (b.kind === 'tradingPost') need('surplusPriceMul');
    if (b.kind === 'storehouse') need('requestCopies');
    if (b.kind === 'training') { need('trainExpFrac'); need('trainLevelGap'); }
    if (b.kind === 'bank') need('investFloorMul');
    if (b.kind === 'monument') { need('auraAtkPct'); need('auraDefPct'); }
    if (b.kind === 'fountain') { need('townRegenMul'); need('reviveSecMul'); }
    if (b.kind === 'library') need('killExpPct');
    if (th && b.kind !== 'townHall' && Math.max(b.requires.townHallLevel, b.maxLevel) > th.maxLevel) {
      issues.push({ path: `building[${i}]`, message: `needs a Town Hall level above its max level ${th.maxLevel}` });
    }
  });
  // Stock recipes (TECH_SPEC §5.14): supplies belong to a service with supplyCap, potions to the building with potionCap
  // (at most one) and need heal + price; every stock line needs a tier at minLevel 1 so any hunter level has one.
  const consumables = raw.consumable as ConsumableDef[];
  const typeById = new Map(buildings.map((b) => [b.id, b]));
  const lines = new Map<string, number>();
  consumables.forEach((c, i) => {
    const b = typeById.get(c.buildingId);
    if (!b) return;
    if (c.kind === 'supply' && (b.kind !== 'service' || !b.supplyCap)) issues.push({ path: `consumable[${i}].buildingId`, message: 'supply rows need a service building with supplyCap' });
    if (c.kind === 'potion') {
      if (!b.potionCap) issues.push({ path: `consumable[${i}].buildingId`, message: 'potion rows need a building with potionCap' });
      if (c.heal === undefined || c.price === undefined) issues.push({ path: `consumable[${i}]`, message: 'potion rows need heal and price' });
    }
    const key = `${c.kind}:${c.buildingId}`;
    lines.set(key, Math.min(lines.get(key) ?? Infinity, c.minLevel));
  });
  for (const [key, lv] of lines) if (lv !== 1) issues.push({ path: 'consumable', message: `stock line "${key}" needs a row with minLevel 1` });
  buildings.forEach((b, i) => {
    if (b.supplyCap && !lines.has(`supply:${b.id}`)) issues.push({ path: `building[${i}].supplyCap`, message: 'no supply recipe for this building' });
    if (b.potionCap && !lines.has(`potion:${b.id}`)) issues.push({ path: `building[${i}].potionCap`, message: 'no potion recipe for this building' });
  });
  if (buildings.filter((b) => b.potionCap).length > 1) issues.push({ path: 'building', message: 'at most one building may sell potions (potionCap)' });
  for (const kind of ['tradingPost', 'shop', 'forge', 'academy', 'townHall'] as const) {
    const n = buildings.filter((b) => b.kind === kind).length;
    if (n !== 1) issues.push({ path: 'building', message: `need exactly one "${kind}" building, got ${n}` });
  }
  // M5 special buildings (TECH_SPEC §5.15) are optional, at most one of each kind.
  for (const kind of ['training', 'bank', 'monument', 'fountain', 'library'] as const) {
    const n = buildings.filter((b) => b.kind === kind).length;
    if (n > 1) issues.push({ path: 'building', message: `at most one "${kind}" building, got ${n}` });
  }
  // Plots: doors are door nodes used by exactly one plot; a building type starts on at most one plot; the Town Hall starts built.
  const plots = raw.building_plot as BuildingPlotDef[];
  const doorUse = new Map<string, number>();
  const started = new Map<string, number>();
  const byType = new Map(buildings.map((b) => [b.id, b]));
  plots.forEach((p, i) => {
    const n = byId.get(p.doorNode);
    if (n && n.kind !== 'door') issues.push({ path: `building_plot[${i}].doorNode`, message: `node "${p.doorNode}" is not a door` });
    doorUse.set(p.doorNode, (doorUse.get(p.doorNode) ?? 0) + 1);
    if (p.startLevel !== undefined && p.startBuilding === undefined) issues.push({ path: `building_plot[${i}].startLevel`, message: 'needs startBuilding' });
    if (p.startBuilding !== undefined) {
      started.set(p.startBuilding, (started.get(p.startBuilding) ?? 0) + 1);
      const b = byType.get(p.startBuilding);
      if (b && (p.startLevel ?? 1) > b.maxLevel) issues.push({ path: `building_plot[${i}].startLevel`, message: `above maxLevel ${b.maxLevel}` });
    }
  });
  for (const [door, n] of doorUse) if (n > 1) issues.push({ path: 'building_plot', message: `door "${door}" used by ${n} plots` });
  for (const [id, n] of started) if (n > 1) issues.push({ path: 'building_plot', message: `"${id}" starts on ${n} plots (one instance per type)` });
  for (const n of nodes) if (n.kind === 'door' && !doorUse.has(n.id)) issues.push({ path: `map_node.${n.id}`, message: 'door node without a building plot' });
  const thPlot = th ? plots.find((p) => p.startBuilding === th.id) : undefined;
  if (th && !thPlot) issues.push({ path: 'building_plot', message: `the Town Hall "${th.id}" must start built on a plot` });
  const thStart = thPlot?.startLevel ?? 1;
  plots.forEach((p, i) => {
    if (p.startBuilding === undefined || p.startBuilding === th?.id) return;
    const b = byType.get(p.startBuilding);
    if (p.townHallLevel > thStart) issues.push({ path: `building_plot[${i}]`, message: `starts built but needs Town Hall ${p.townHallLevel} (starts at ${thStart})` });
    if (b && Math.max(b.requires.townHallLevel, p.startLevel ?? 1) > thStart) {
      issues.push({ path: `building_plot[${i}].startLevel`, message: `needs a Town Hall above its starting level ${thStart}` });
    }
  });
  const byBuilding = new Map(buildings.map((b) => [b.id, b]));
  (raw.gear as GearDef[]).forEach((g, i) => {
    if (byBuilding.get(g.craftBuilding)?.kind !== 'craft') issues.push({ path: `gear[${i}].craftBuilding`, message: `"${g.craftBuilding}" is not a craft building` });
  });
  const q = raw.gear_quality as GearQualityDef[];
  const qs = q.reduce((s, x) => s + x.craftChance, 0);
  if (Math.abs(qs - 1) > 1e-6) issues.push({ path: 'gear_quality', message: `craftChance must sum to 1 (got ${qs})` });
  issues.push(...validateGearDepth(raw));
  const classIds = (raw.class as { id: string }[]).map((c) => c.id);
  const jobs = raw.job as JobDef[];
  for (const c of classIds) {
    const tiers = jobs.filter((j) => j.classId === c).map((j) => j.tier).sort((a, b) => a - b);
    if (tiers[0] !== 0) issues.push({ path: 'job', message: `class "${c}" needs a tier-0 job` });
    tiers.forEach((t, k) => { if (t !== k) issues.push({ path: 'job', message: `class "${c}" job tiers must be 0..n without gaps` }); });
  }
  (raw.skill as SkillDef[]).forEach((sk, i) => {
    if (sk.kind === 'buff' && (!sk.buffStat || !sk.keepSec)) issues.push({ path: `skill[${i}]`, message: 'buff skills need buffStat and keepSec' });
    if (sk.kind === 'aoe' && sk.radius === undefined) issues.push({ path: `skill[${i}].radius`, message: 'aoe skills need radius' });
  });
  const diffs = [...(raw.difficulty as DifficultyDef[])].sort((a, b) => a.order - b.order);
  if (diffs[0] && (diffs[0].unlockHunters !== 0 || diffs[0].unlockReincarnation !== 0)) {
    issues.push({ path: 'difficulty', message: 'the first difficulty must be unlocked from the start (0/0)' });
  }
  // Gear tiers (TECH_SPEC §5.8): the first difficulty is the base tier (old gear migrates to it).
  if (diffs[0] && (diffs[0].essenceId || (diffs[0].gearStatMul ?? 1) !== 1 || (diffs[0].gearPriceMul ?? 1) !== 1)) {
    issues.push({ path: 'difficulty', message: 'the first difficulty is the base gear tier: no essenceId, gearStatMul/gearPriceMul 1' });
  }
  diffs.forEach((d, i) => {
    if (i > 0 && (d.gearStatMul ?? 1) < (diffs[i - 1]!.gearStatMul ?? 1)) {
      issues.push({ path: `difficulty.${d.id}.gearStatMul`, message: 'must not decrease with difficulty order' });
    }
    if (d.essenceId && !(d.essenceDropChance && d.essenceDropChance > 0)) {
      issues.push({ path: `difficulty.${d.id}.essenceDropChance`, message: 'needed (> 0) with essenceId' });
    }
  });
  // M5 invitations / personalities (TECH_SPEC §4.1, §5.5).
  const invs = raw.invitation as InvitationDef[];
  invs.forEach((inv, i) => {
    if (!(HUNTER_TIERS.reduce((a, t) => a + (inv.tierChances?.[t] ?? 0), 0) > 0)) {
      issues.push({ path: `invitation[${i}].tierChances`, message: 'needs a positive total' });
    }
  });
  if (invs.filter((inv) => inv.autoInvite).length > 1) issues.push({ path: 'invitation', message: 'at most one row with autoInvite' });
  (raw.personality as PersonalityDef[]).forEach((p, i) => {
    p.modifiers.forEach((m, j) => {
      if (!PERSONALITY_TARGETS.includes(m.target)) issues.push({ path: `personality[${i}].modifiers[${j}].target`, message: `unknown target "${m.target}"` });
    });
  });
  (raw.enhance as EnhanceDef[]).forEach((e, i) => {
    if (e.level !== i + 1) issues.push({ path: `enhance[${i}].level`, message: `expected ${i + 1} (rows must be +1, +2, … in order)` });
  });

  // Every node must be reachable from the square.
  if (squares.length === 1) {
    const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
    for (const e of edges) {
      adj.get(e.a)?.push(e.b);
      adj.get(e.b)?.push(e.a);
    }
    const seen = new Set([squares[0]!.id]);
    const stack = [squares[0]!.id];
    while (stack.length) for (const nb of adj.get(stack.pop()!) ?? []) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
    for (const n of nodes) if (!seen.has(n.id)) issues.push({ path: `map_node.${n.id}`, message: 'unreachable from the square' });
  }
  return issues;
}

/**
 * M5 gear depth cross-checks (TECH_SPEC §4.2, §8): grade chances sum to 1, grade 0 has no options (old gear migrates to
 * it), uniques ≤ options and every grade's lines can be filled for every slot; each option has exactly one of stat /
 * gearSkillId and min ≤ max; positive/unique values ≥ 0, negative ≤ 0; set bonuses have stat+value or a gear skill,
 * piece counts within the set's slots; every slot has at least one recipe.
 */
function validateGearDepth(raw: RawConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const grades = raw.gear_grade as GearGradeDef[];
  const options = raw.gear_option as GearOptionDef[];
  const sets = raw.gear_set as GearSetDef[];
  const gear = raw.gear as GearDef[];
  if (!Array.isArray(grades) || !Array.isArray(options) || !Array.isArray(sets) || !Array.isArray(gear)) return issues;
  const gs = grades.reduce((s, x) => s + x.chance, 0);
  if (Math.abs(gs - 1) > 1e-6) issues.push({ path: 'gear_grade', message: `chance must sum to 1 (got ${gs})` });
  if (grades[0] && grades[0].options !== 0) issues.push({ path: 'gear_grade[0].options', message: 'the first grade is the no-option grade (old gear): 0' });
  const pool = (slot: string, kind: string) => options.filter((o) => o.kind === kind && (!o.slots || o.slots.includes(slot as GearDef['slot']))).length;
  grades.forEach((g, i) => {
    if (g.uniques > g.options) issues.push({ path: `gear_grade[${i}].uniques`, message: 'must be ≤ options' });
    for (const slot of GEAR_SLOTS) {
      if (g.uniques > 0 && pool(slot, 'unique') < g.uniques) issues.push({ path: `gear_grade[${i}]`, message: `not enough unique options for slot ${slot}` });
      const rest = g.options - g.uniques;
      if (rest > 0 && pool(slot, 'positive') < rest) issues.push({ path: `gear_grade[${i}]`, message: `not enough positive options for slot ${slot}` });
      if (rest > 0 && g.negChance > 0 && pool(slot, 'negative') < rest) issues.push({ path: `gear_grade[${i}]`, message: `not enough negative options for slot ${slot}` });
    }
  });
  options.forEach((o, i) => {
    if ((o.stat === undefined) === (o.gearSkillId === undefined)) issues.push({ path: `gear_option[${i}]`, message: 'needs exactly one of stat / gearSkillId' });
    if (o.min > o.max) issues.push({ path: `gear_option[${i}]`, message: 'min > max' });
    if (o.kind === 'negative' ? o.max > 0 : o.min < 0) issues.push({ path: `gear_option[${i}]`, message: `${o.kind} option values must be ${o.kind === 'negative' ? '≤' : '≥'} 0` });
    if (o.gearSkillId && o.kind !== 'unique') issues.push({ path: `gear_option[${i}].gearSkillId`, message: 'only unique options grant gear skills' });
  });
  sets.forEach((s, i) => {
    const slots = new Set(gear.filter((g) => g.setId === s.id).map((g) => g.slot));
    s.bonuses.forEach((b, k) => {
      const statOk = b.stat !== undefined && b.value !== undefined;
      if (statOk === (b.gearSkillId !== undefined)) issues.push({ path: `gear_set[${i}].bonuses[${k}]`, message: 'needs stat + value or gearSkillId' });
      if (b.pieces > slots.size) issues.push({ path: `gear_set[${i}].bonuses[${k}].pieces`, message: `set has pieces in only ${slots.size} slots` });
    });
  });
  for (const slot of GEAR_SLOTS) if (!gear.some((g) => g.slot === slot)) issues.push({ path: 'gear', message: `no recipe for slot ${slot}` });
  return issues;
}

/** Validate and build a typed, indexed config. Throws ConfigError listing every issue. */
export function loadConfig(raw: RawConfig): GameConfig {
  const issues = validateConfig(raw);
  if (issues.length) throw new ConfigError(issues);

  const classes = raw.class as GameConfig['classes'];
  const personalities = raw.personality as GameConfig['personalities'];
  const loc = raw.loc as GameConfig['loc'];
  const nodes = raw.map_node as MapNode[];
  const zones = raw.zone as ZoneDef[];
  const zoneNodes = new Map<string, string[]>(zones.map((z) => [z.id, []]));
  for (const n of nodes) if (n.zoneId) zoneNodes.get(n.zoneId)!.push(n.id);
  const buildings = raw.building as BuildingDef[];
  const plots = raw.building_plot as BuildingPlotDef[];
  const monsters = raw.monster as MonsterDef[];
  const materials = raw.material as MaterialDef[];
  const gear = raw.gear as GearDef[];
  const qualities = raw.gear_quality as GearQualityDef[];
  const enhance = raw.enhance as EnhanceDef[];
  const kindId = (k: BuildingDef['kind']) => buildings.find((b) => b.kind === k)!.id;
  const jobs = raw.job as JobDef[];
  const skills = raw.skill as SkillDef[];
  const traits = raw.trait as TraitDef[];
  const difficulties = [...(raw.difficulty as DifficultyDef[])].sort((a, b) => a.order - b.order);
  const journeys = raw.journey as JourneyDef[];
  const consumables = raw.consumable as ConsumableDef[];
  const gearGrades = raw.gear_grade as GearGradeDef[];
  const gearOptions = raw.gear_option as GearOptionDef[];
  const gearSets = raw.gear_set as GearSetDef[];
  const gearSkills = raw.gear_skill as GearSkillDef[];
  const invitations = raw.invitation as InvitationDef[];
  const jobsByClass = new Map<string, JobDef[]>(classes.map((c) => [c.id, jobs.filter((j) => j.classId === c.id).sort((a, b) => a.tier - b.tier)]));
  return {
    version: (raw.meta as { version: string }).version,
    formula: raw.formula_params as FormulaParams,
    classes,
    personalities,
    statGrades: raw.stat_grade as GameConfig['statGrades'],
    invitations,
    nodes,
    edges: raw.map_edge as MapEdge[],
    buildings,
    plots,
    zones,
    monsters,
    materials,
    gear,
    qualities,
    enhance,
    jobs,
    skills,
    traits,
    difficulties,
    journeys,
    consumables,
    gearGrades,
    gearOptions,
    gearSets,
    gearSkills,
    loc,
    index: {
      classes: new Map(classes.map((c) => [c.id, c])),
      personalities: new Map(personalities.map((p) => [p.id, p])),
      nodes: new Map(nodes.map((n) => [n.id, n])),
      buildings: new Map(buildings.map((b) => [b.id, b])),
      plots: new Map(plots.map((p) => [p.id, p])),
      townHall: kindId('townHall'),
      zones: new Map(zones.map((z) => [z.id, z])),
      monsters: new Map(monsters.map((m) => [m.id, m])),
      materials: new Map(materials.map((m) => [m.id, m])),
      gear: new Map(gear.map((g) => [g.id, g])),
      qualities: new Map(qualities.map((x) => [x.id, x])),
      loc: new Map(loc.map((l) => [l.key, l])),
      tradingPost: kindId('tradingPost'),
      shop: kindId('shop'),
      forge: kindId('forge'),
      academy: kindId('academy'),
      jobs: new Map(jobs.map((j) => [j.id, j])),
      jobsByClass,
      skills: new Map(skills.map((x) => [x.id, x])),
      traits: new Map(traits.map((x) => [x.id, x])),
      difficulties: new Map(difficulties.map((d) => [d.id, d])),
      journeys: new Map(journeys.map((j) => [j.id, j])),
      consumables: new Map(consumables.map((c) => [c.id, c])),
      gearGrades: new Map(gearGrades.map((x) => [x.id, x])),
      gearOptions: new Map(gearOptions.map((x) => [x.id, x])),
      gearSets: new Map(gearSets.map((x) => [x.id, x])),
      gearSkills: new Map(gearSkills.map((x) => [x.id, x])),
      invitations: new Map(invitations.map((x) => [x.id, x])),
      autoInvitation: invitations.find((x) => x.autoInvite)?.id ?? null,
      potionSeller: buildings.find((b) => b.potionCap)?.id ?? null,
      squareNode: nodes.find((n) => n.kind === 'square')!.id,
      portalNode: (nodes.find((n) => n.kind === 'portal') ?? nodes.find((n) => n.kind === 'square')!).id,
      zoneNodes,
    },
  };
}

export function t(config: GameConfig, key: string, lang: 'vi' | 'en' = 'vi'): string {
  const e = config.index.loc.get(key);
  return e ? e[lang] || e.en || key : key;
}
