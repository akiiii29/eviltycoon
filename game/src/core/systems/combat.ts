import { critChance, critMultiplier, dodgeChance, hunterStats, mitigated, monsterStats } from '../formulas';
import { gearBonus, gearPctMul, hunterGearSkills, needDrainMul } from '../gear';
import { personalityFactor } from '../hunterFactory';
import { gainExp } from '../progress';
import { SpatialHash } from '../spatial';
import type { System, SystemContext } from '../system';
import { bagCount, dist, findHunter, findMonster, isAlive, newAiState, type Hunter, type Monster } from '../world';
import { bountyOnKill } from './bounty';
import { payReviveFee, reviveDelayMs } from './consumables';
import { dropEssence } from './gearTier';
import { stepTowards } from './movement';
import { procGearSkills } from './skills';
import { grantKillGold } from './tax';
import { libraryExpMul } from './town';

/**
 * Per-tick aggro index (TECH_SPEC §10), derived data rebuilt in combatSystem.update after revives: every
 * hunter that monsters could target (alive, outside), keyed by its index in world.hunters, plus the zones
 * those hunters stand in. Hunters do not move while monsters act, so it stays exact for the whole pass.
 */
const aggroGrid = new SpatialHash();
const aggroZones = new Set<string>();
const aggroScratch: number[] = [];

function buildAggroIndex(ctx: SystemContext): void {
  aggroGrid.clear();
  aggroZones.clear();
  const hs = ctx.world.hunters;
  for (let i = 0; i < hs.length; i++) {
    const h = hs[i]!;
    if (!isAlive(h) || h.insideBuildingId) continue;
    aggroGrid.insert(i, h.position.x, h.position.y);
    const zone = ctx.nav.node(h.nodeId).zoneId;
    if (zone) aggroZones.add(zone);
  }
}

function killHunter(ctx: SystemContext, h: Hunter): void {
  h.needs.hp = 0;
  // Revive fee (TECH_SPEC §5.14): a hunter who cannot pay it in full waits longer.
  h.deadMs = reviveDelayMs(ctx.config, ctx.world, h);
  h.ai = { ...newAiState(), goal: { type: 'dead' } };
  h.attackCdMs = 0;
  ctx.world.stats.deaths += 1;
  for (const m of ctx.world.monsters) if (m.targetHunterId === h.id) m.targetHunterId = null;
  ctx.events.emit(ctx.world.tick, { type: 'hunterDied', hunterId: h.id });
}

function revive(ctx: SystemContext, h: Hunter): void {
  const sq = ctx.nav.node(ctx.config.index.squareNode);
  h.deadMs = 0;
  h.position = { x: sq.x, y: sq.y };
  h.nodeId = sq.id;
  h.needs.hp = hunterStats(ctx.config, h).hp * ctx.config.formula.reviveHpFrac;
  h.ai = newAiState();
  const paid = payReviveFee(ctx, h);
  ctx.events.emit(ctx.world.tick, { type: 'hunterRevived', hunterId: h.id, fee: paid.fee, townGold: paid.townGold });
}

function grantKill(ctx: SystemContext, h: Hunter, m: Monster): void {
  const { config, world } = ctx;
  const def = config.index.monsters.get(m.defId)!;
  const ms = monsterStats(config, m);
  h.kills += 1;
  // Personality gain.gold / gain.exp (TECH_SPEC §5.5) × M5 gear goldPct / expPct (§4.2) on kill rewards
  // (factor 1 = unchanged, bit for bit).
  const goldK = personalityFactor(config, h, 'gain.gold') * gearPctMul(config, h, 'goldPct');
  grantKillGold(ctx, h, goldK === 1 ? ms.gold : Math.max(0, Math.round(ms.gold * goldK))); // minus Town tax (tax.ts)
  world.stats.kills += 1;
  ctx.events.emit(world.tick, { type: 'monsterKilled', hunterId: h.id, monsterId: m.id, defId: m.defId });
  // Bounty payout; a bounty target killed under Torment drops more (one RNG draw per drop either way).
  const dropMul = bountyOnKill(ctx, h, m) * gearPctMul(config, h, 'dropPct');
  // M2: material drops go into the hunter's bag while there is room.
  for (const d of def.drops) {
    if (!ctx.rng.chance(dropMul === 1 ? d.chance : Math.min(1, d.chance * dropMul))) continue;
    if (bagCount(h) >= config.formula.bagCapacity) break;
    h.bag[d.materialId] = (h.bag[d.materialId] ?? 0) + 1;
  }
  dropEssence(ctx, h, m); // gear-tier essence of the monster's difficulty (TECH_SPEC §5.8); no RNG draw on Easy
  // Personality gain.exp × M5 gear expPct (§4.2), then the Library (TECH_SPEC §5.15): × (1 + killExpPct / 100); exactly
  // ms.exp without any.
  const expK = personalityFactor(config, h, 'gain.exp') * gearPctMul(config, h, 'expPct');
  const base = expK === 1 ? ms.exp : Math.max(0, ms.exp * expK);
  const expMul = libraryExpMul(config, world);
  if (expMul !== 1) world.stats.libraryExp = (world.stats.libraryExp ?? 0) + base * (expMul - 1);
  gainExp(ctx, h, expMul === 1 ? base : base * expMul);
}

/**
 * One hit from a hunter on a monster: difficulty-scaled mitigation, optional crit (rolled via ctx.rng),
 * aggro, `hit` event, and kill rewards. Returns the damage dealt (0 if the monster was already dead).
 * Shared by auto-attacks and skills.
 */
export function damageMonster(ctx: SystemContext, h: Hunter, m: Monster, rawAtk: number, critAllowed: boolean): number {
  if (m.hp <= 0) return 0;
  const { config, world, rng } = ctx;
  const f = config.formula;
  const critStat = hunterStats(config, h).crit;
  const crit = critAllowed && rng.chance(critChance(critStat, f));
  const ms = monsterStats(config, m);
  const dmg = mitigated(rawAtk, ms.def, h.level, ms.level, f) * (crit ? critMultiplier(critStat, f.critMultiplier, f) : 1);
  const before = m.hp;
  m.hp -= dmg;
  // M5 lifesteal (gear option / set, TECH_SPEC §4.2): heal a % of the damage that landed (overkill excluded).
  const steal = gearBonus(config, h, 'lifesteal');
  if (steal > 0) h.needs.hp = Math.min(hunterStats(config, h).hp, h.needs.hp + (Math.min(dmg, before) * steal) / 100);
  if (!m.targetHunterId) m.targetHunterId = h.id;
  ctx.events.emit(world.tick, { type: 'hit', attackerId: h.id, targetId: m.id, damage: dmg, crit, evaded: false });
  if (m.hp <= 0) grantKill(ctx, h, m);
  return dmg;
}

function hunterAttacks(ctx: SystemContext, h: Hunter): void {
  const { config, world, dtMs } = ctx;
  const f = config.formula;
  const ai = h.ai;
  if (ai.goal?.type !== 'hunt' || ai.phase !== 'act' || !ai.targetMonsterId) return;
  const m = findMonster(world, ai.targetMonsterId);
  if (!m || m.hp <= 0 || dist(h.position, m.position) > f.attackRange) return;

  h.attackCdMs -= dtMs;
  if (h.attackCdMs > 0) return;
  const s = hunterStats(config, h);
  h.attackCdMs += s.atkSpeed * 1000;
  if (h.attackCdMs < 0) h.attackCdMs = 0;

  // GDD §4.2: satiety drops each time the hunter attacks (× gear needSavePct, M5).
  h.needs.satiety = Math.max(0, h.needs.satiety - f.satietyPerAttack * personalityFactor(config, h, 'decay.satiety') * needDrainMul(config, h));
  damageMonster(ctx, h, m, s.atk, true);
  // M5 gear skills: proc after the auto-attack (no RNG draw without gear skills).
  if (config.gearSkills.length > 0) {
    const gs = hunterGearSkills(config, h);
    if (gs.length > 0) procGearSkills(ctx, h, m, gs);
  }
}

function monsterActs(ctx: SystemContext, m: Monster): void {
  const { config, world, rng, dtMs } = ctx;
  const f = config.formula;
  const def = config.index.monsters.get(m.defId)!;
  const sec = dtMs / 1000;

  let target = m.targetHunterId ? findHunter(world, m.targetHunterId) : undefined;
  const valid = (h: Hunter | undefined): h is Hunter =>
    !!h && isAlive(h) && !h.insideBuildingId && ctx.nav.node(h.nodeId).zoneId === m.zoneId && dist(h.position, m.home) <= f.monsterLeashRange;
  if (!valid(target)) {
    target = undefined;
    m.targetHunterId = null;
    let bestD = def.aggroRange;
    // Spatial query instead of scanning every hunter; candidates come back in world.hunters order, so the
    // `<=` tie-break (last nearest wins) is unchanged. No eligible hunter in this zone → nothing can be valid.
    if (aggroZones.has(m.zoneId)) {
      for (const i of aggroGrid.candidates(m.position.x, m.position.y, def.aggroRange, aggroScratch)) {
        const h = world.hunters[i]!;
        if (!valid(h)) continue;
        const d = dist(h.position, m.position);
        if (d <= bestD) { bestD = d; target = h; }
      }
    }
    if (target) m.targetHunterId = target.id;
  }

  if (!target) {
    stepTowards(m.position, m.home, def.moveSpeed * sec);
    m.attackCdMs = Math.max(0, m.attackCdMs - dtMs);
    return;
  }
  if (dist(m.position, target.position) > f.attackRange) {
    stepTowards(m.position, target.position, def.moveSpeed * sec);
    return;
  }
  m.attackCdMs -= dtMs;
  if (m.attackCdMs > 0) return;
  m.attackCdMs += def.attackSpeed * 1000;
  if (m.attackCdMs < 0) m.attackCdMs = 0;

  const ts = hunterStats(config, target);
  // RNG order is fixed: evade roll first, crit roll only when the hit lands.
  const ms = monsterStats(config, m);
  const evaded = rng.chance(dodgeChance(ts.eva, f));
  const crit = !evaded && rng.chance(critChance(ms.crit, f));
  const dmg = evaded ? 0 : mitigated(ms.atk, ts.def, ms.level, target.level, f) * (crit ? critMultiplier(ms.crit, f.monsterCritMultiplier, f) : 1);
  ctx.events.emit(world.tick, { type: 'hit', attackerId: m.id, targetId: target.id, damage: dmg, crit, evaded });
  // GDD §4.2 / EHT: mood drops every time a monster attacks the hunter, dodged attacks included.
  target.needs.mood = Math.max(0, target.needs.mood - f.moodPerHitTaken * personalityFactor(config, target, 'decay.mood'));
  if (evaded) return;
  target.needs.hp -= dmg;
  if (target.needs.hp <= 0) killHunter(ctx, target);
}

/** Auto-combat, kills/rewards/level-up, death and revive (TECH_SPEC §7; per-hit formulas in formulas.ts). */
export const combatSystem: System = {
  name: 'combat',
  update(ctx) {
    const { world, dtMs } = ctx;
    for (const h of world.hunters) {
      if (h.deadMs > 0) {
        h.deadMs -= dtMs;
        if (h.deadMs <= 0) revive(ctx, h);
      }
    }
    for (const h of world.hunters) if (isAlive(h) && !h.insideBuildingId) hunterAttacks(ctx, h);
    world.monsters = world.monsters.filter((m) => m.hp > 0);
    buildAggroIndex(ctx);
    for (const m of world.monsters) monsterActs(ctx, m);
  },
};
