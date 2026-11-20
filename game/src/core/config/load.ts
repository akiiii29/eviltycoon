import { validateTables, type ConfigIssue, type FieldSpec, type TableSpec } from './schema';
import {
  BUILDING_KINDS, GEAR_SLOTS, MOD_STATS, NEED_KEYS, STAT_KEYS,
  type BuildingDef, type DifficultyDef, type EnhanceDef, type JobDef, type SkillDef, type TraitDef, type FormulaParams, type GameConfig, type GearDef, type GearQualityDef,
  type MapEdge, type MapNode, type MaterialDef, type MonsterDef, type ZoneDef,
} from './types';

const range: FieldSpec = { kind: 'array', length: 2, of: { kind: 'number', min: 0 } };
const gradeRanges: FieldSpec = { kind: 'array', length: 3, of: range };

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
      kind: { kind: 'enum', values: ['square', 'road', 'door', 'gate', 'field'] },
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
      need: { kind: 'enum', values: NEED_KEYS, optional: true },
      doorNode: { kind: 'ref', table: 'map_node' },
      restorePerSec: { kind: 'number', min: 0.001, optional: true },
      price: { kind: 'int', min: 0, optional: true },
      capacity: { kind: 'int', min: 1, optional: true },
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
  'craftGoldFrac', 'feeTownShare', 'shopStaleSec', 'shopMarkdownPct', 'shopMarkdownFloor', 'shopScrapSec', 'monsterCritMultiplier',
  'requestMaxCopies', 'requestZoneBonus', 'requestMaxUnits', 'tradeSaleTax', 'servicePriceLevelPct',
  'tradeSurplusPriceFrac', 'tradeSurplusFloorMul', 'craftAffordFrac',
  'enhanceRiskExp', 'enhanceMinSuccess', 'upgradeSavingsFrac', 'aiTypicalQualityMult', 'enhanceBaseScore', 'enhanceGainWeight',
  'shopBaseScore', 'shopGainWeight', 'sellBaseScore', 'sellFillWeight', 'learnSkillScore', 'learnTraitScore', 'econMulFloor',
  'serviceFullFrac', 'serviceLowBase', 'serviceLowWeight', 'serviceWeight', 'bagReturnScore', 'restScoreWeight',
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
    // AI enhance / town goal scores.
    range('enhanceRiskExp', 0, 5);
    range('enhanceMinSuccess', 0, 1);
    range('upgradeSavingsFrac', 0, 10);
    range('aiTypicalQualityMult', 0.01, 10);
    range('econMulFloor', 0, 1);
    range('serviceFullFrac', 0, 1);
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
  buildings.forEach((b, i) => {
    const n = byId.get(b.doorNode);
    if (n && n.kind !== 'door') issues.push({ path: `building[${i}].doorNode`, message: `node "${b.doorNode}" is not a door` });
    const need = (k: keyof BuildingDef) => {
      if (b[k] === undefined) issues.push({ path: `building[${i}].${k}`, message: `required for kind "${b.kind}"` });
    };
    if (b.kind === 'service') { need('need'); need('restorePerSec'); need('price'); }
    if (b.kind === 'shop') need('capacity');
  });
  for (const kind of ['tradingPost', 'shop', 'forge', 'academy'] as const) {
    const n = buildings.filter((b) => b.kind === kind).length;
    if (n !== 1) issues.push({ path: 'building', message: `need exactly one "${kind}" building, got ${n}` });
  }
  const byBuilding = new Map(buildings.map((b) => [b.id, b]));
  (raw.gear as GearDef[]).forEach((g, i) => {
    if (byBuilding.get(g.craftBuilding)?.kind !== 'craft') issues.push({ path: `gear[${i}].craftBuilding`, message: `"${g.craftBuilding}" is not a craft building` });
  });
  const q = raw.gear_quality as GearQualityDef[];
  const qs = q.reduce((s, x) => s + x.craftChance, 0);
  if (Math.abs(qs - 1) > 1e-6) issues.push({ path: 'gear_quality', message: `craftChance must sum to 1 (got ${qs})` });
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
  const jobsByClass = new Map<string, JobDef[]>(classes.map((c) => [c.id, jobs.filter((j) => j.classId === c.id).sort((a, b) => a.tier - b.tier)]));
  return {
    version: (raw.meta as { version: string }).version,
    formula: raw.formula_params as FormulaParams,
    classes,
    personalities,
    statGrades: raw.stat_grade as GameConfig['statGrades'],
    nodes,
    edges: raw.map_edge as MapEdge[],
    buildings,
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
    loc,
    index: {
      classes: new Map(classes.map((c) => [c.id, c])),
      personalities: new Map(personalities.map((p) => [p.id, p])),
      nodes: new Map(nodes.map((n) => [n.id, n])),
      buildings: new Map(buildings.map((b) => [b.id, b])),
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
      squareNode: nodes.find((n) => n.kind === 'square')!.id,
      zoneNodes,
    },
  };
}

export function t(config: GameConfig, key: string, lang: 'vi' | 'en' = 'vi'): string {
  const e = config.index.loc.get(key);
  return e ? e[lang] || e.en || key : key;
}
