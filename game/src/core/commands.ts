import { hunterStats } from './formulas';
import type { SystemContext } from './system';
import { findHunter, isAlive } from './world';
import { admitInvited, hasFreeSlot, queueHasRoom, removeHunter, spawnHunter } from './systems/arrivals';
import { rollInvitationTier, rollPersonalities } from './hunterFactory';
import { setGoal } from './systems/ai';
import { dismantleStoredGear, listStoredGear, reclaimGear, reclaimHunterGear, startCraft } from './systems/crafting';
import { servicePrice } from './systems/services';
import { portalStayOf, reincarnateBlocker, sendToPortal } from './systems/progression';
import { cancelBounty, postBounty, validateBounty } from './systems/bounty';
import { buildingLevel, cancelUpgrade, startBuild, startUpgrade } from './systems/town';
import { setTaxRate, validateTaxRate } from './systems/tax';
import { journeyOfHunter, recallJourney, startJourney, townHunterCount, validateJourney } from './systems/journey';
import { chooseJob } from './systems/progression';
import { learnPlanBlocker, readyStudy } from './systems/academy';
import { compose } from './systems/compose';
import { socketRune, unsocketRune } from './systems/runes';
import { upgradeRelic } from './systems/relics';
import { mountBlocker } from './systems/mounts';
import type { LearnKind } from './world';

/** Player/debug commands. Queued by UI, applied at the start of the next tick (TECH_SPEC §3.1). */
export type Command =
  /** GDD §3.1 Move: send a hunter to a zone, or back to town. */
  | { type: 'hunter.move'; hunterId: string; zoneId: string | 'town' }
  /** GDD §3.1 Activities: send a hunter to a service building. */
  | { type: 'hunter.activity'; hunterId: string; buildingId: string }
  | { type: 'debug.spawnHunter' }
  | { type: 'debug.removeHunter'; hunterId: string }
  | { type: 'debug.restoreNeeds'; hunterId: string }
  /**
   * GDD §6: start crafting a gear in a craft building from Town Storage materials, at gear tier `difficultyId`
   * (an unlocked difficulty ≤ the current one; default the base tier; TECH_SPEC §5.8).
   */
  | { type: 'town.craft'; buildingId: string; gearId: string; difficultyId?: string }
  /** TECH_SPEC §5.8: move a hunter's equipment into Town gear storage (hunter in Town, not on a journey). */
  | { type: 'hunter.reclaimGear'; hunterId: string }
  /** Put a stored item on sale in the shop (needs a free shop slot). */
  | { type: 'town.listGear'; itemUid: string }
  /** Dismantle a stored item into dismantleReturnFrac of its recipe materials. */
  | { type: 'town.dismantleGear'; itemUid: string }
  /** Toggle the automatic difficulty step-up after reincarnations (manual town.setDifficulty turns it off). */
  | { type: 'town.setAutoDifficulty'; on: boolean }
  /** GDD §6: toggle automatic recipe choice for idle craft buildings. */
  | { type: 'town.setAutoCraft'; on: boolean }
  /** GDD §8: send a max-level hunter in Town to the Reincarnation Portal (reincarnates after reincarnationSec; TECH_SPEC §5.13). */
  | { type: 'hunter.reincarnate'; hunterId: string }
  /** GDD §8: switch to an unlocked difficulty (affects new monster spawns only; turns town.autoDifficulty off). */
  | { type: 'town.setDifficulty'; difficultyId: string }
  /** GDD §8: toggle automatic reincarnation of max-level hunters in town. */
  | { type: 'town.setAutoReincarnate'; on: boolean }
  /**
   * GDD §5: place a Trading Post request — the post buys up to `count` more units of the material
   * (on top of the automatic requests). Sets (does not add to) the outstanding count; 0 cancels it.
   */
  | { type: 'town.requestMaterial'; materialId: string; count: number }
  /**
   * GDD §9: post a bounty — `kills` kills of a monster type (anywhere) or in a zone, for `reward` gold in total, taken
   * from Town gold now (escrow) and paid out per kill (TECH_SPEC §5.9).
   */
  | { type: 'town.postBounty'; targetKind: 'monster' | 'zone'; targetId: string; kills: number; reward: number }
  /** Cancel an active bounty; its unpaid escrow returns to Town gold. */
  | { type: 'town.cancelBounty'; bountyId: string }
  /** Toggle automatic bounties when Town gold is above its treasury target. */
  | { type: 'town.setAutoBounty'; on: boolean }
  /** GDD §5: build a building type on a free plot (gold + Town Storage materials paid now; TECH_SPEC §5.12). */
  | { type: 'town.build'; buildingId: string; plotId: string }
  /** Upgrade a building instance (id = its plot id) by one level. */
  | { type: 'town.upgrade'; buildingInstanceId: string }
  /** Cancel a running construction/upgrade (full refund). */
  | { type: 'town.cancelUpgrade'; buildingInstanceId: string }
  /** Toggle the Town's automatic investment of spare gold in building upgrades. */
  | { type: 'town.setAutoInvest'; on: boolean }
  /** Town tax on kill gold (TECH_SPEC §5.10), within [taxMinRate, taxMaxRate]. */
  | { type: 'town.setTaxRate'; rate: number }
  /**
   * GDD §9 Journey: send 1..journeyTeamMax hunters that are in Town (alive, not inside a building) to a destination of
   * config/journey.json; costs its `cost` Town gold (TECH_SPEC §5.11).
   */
  | { type: 'journey.start'; journeyId: string; hunterIds: string[] }
  /** Bring a running journey's team home now (no reward, cost not refunded). */
  | { type: 'journey.recall'; journeyUid: string }
  /**
   * M5 (TECH_SPEC §4.1): use an invitation of config/invitation.json — one owned ticket (town.tickets) if any, else its
   * `gold` Town gold (Town Hall ≥ townHallLevel). Rolls a tier with its tierChances; the hunter enters now when a slot is
   * free, else waits at the front of the queue. Rejected when Town and queue are both full.
   */
  | { type: 'town.invite'; invitationId: string }
  /** EHT Manage → Donate: move `gold` (positive integer ≤ Town gold) to a hunter. */
  | { type: 'hunter.donate'; hunterId: string; gold: number }
  /**
   * EHT Manage → Banish: the hunter leaves for good. Equipment → Town gear storage (same reclaim as hunter.reclaimGear);
   * its gold, bag and potions leave with it. Frees a slot (the queue front enters this tick).
   */
  | { type: 'hunter.banish'; hunterId: string }
  /** M5: reroll a hunter's personalities for personalityRerollGold Town gold. */
  | { type: 'hunter.rerollPersonality'; hunterId: string }
  /** Debug: add invitation tickets (no gameplay source yet). */
  | { type: 'debug.grantTicket'; invitationId: string; count: number }
  // ---- M5 progression depth (TECH_SPEC §4.1, §5.16) ----
  /**
   * Choose the hunter's branch of the job tree by naming a job of it (a branch job or a later one of the same branch).
   * Stored as `jobBranch` (kept across reincarnation); changes job now when that job is next and unlocked. Rejected when
   * the hunter already advanced into another branch (until it reincarnates).
   */
  | { type: 'hunter.chooseJob'; hunterId: string; jobId: string }
  /**
   * Study plan: the next level of a skill (gold), trait (trait points) or growth property (gold). Kept on the hunter until
   * learned; the AI goes to the Academy for it as soon as it can be paid and spends nothing of that currency meanwhile.
   * Rejected only when it can never happen (unknown, another class, maxed); sends the hunter now when it is in Town and can.
   */
  | { type: 'hunter.learn'; hunterId: string; kind: LearnKind; id: string }
  /** Drop the hunter's study plan (the AI picks what to learn again). */
  | { type: 'hunter.cancelLearn'; hunterId: string }
  /** Buy a mount at the Shop (hunter in Town, level, faster than its own, gold ≥ price). */
  | { type: 'hunter.buyMount'; hunterId: string; mountId: string }
  /** Socket rune `stashIndex` of the Town rune stash into socket `slot` of the hunter (the old rune goes back). */
  | { type: 'hunter.socketRune'; hunterId: string; slot: number; stashIndex: number }
  | { type: 'hunter.unsocketRune'; hunterId: string; slot: number }
  /** Toggle automatic socketing of stash runes into hunters in Town. */
  | { type: 'town.setAutoRune'; on: boolean }
  /** Compose `count` units of `materialId`'s composeTo material from Town Storage (`materialId` = the source). */
  | { type: 'town.compose'; materialId: string; count: number }
  /** Buy the next level of a relic with Town gold and storage materials. */
  | { type: 'town.upgradeRelic'; relicId: string }
  /** Toggle automatic relic purchases (off by default). */
  | { type: 'town.setAutoRelic'; on: boolean };

type Handler<C extends Command> = (ctx: SystemContext, cmd: C) => string | null;

/** Away (journey / Reincarnation Portal): not in world.hunters, so no command can reach it. */
function awayReason(ctx: SystemContext, hunterId: string): string | null {
  if (journeyOfHunter(ctx.world, hunterId)) return 'hunter is on a journey';
  if (portalStayOf(ctx.world, hunterId)) return 'hunter is in the reincarnation portal';
  return null;
}

function controllable(ctx: SystemContext, hunterId: string): string | null {
  const away = awayReason(ctx, hunterId);
  if (away) return away;
  const h = findHunter(ctx.world, hunterId);
  if (!h) return 'unknown hunter';
  if (!isAlive(h)) return 'hunter is dead';
  if (h.insideBuildingId) return 'hunter is inside a building';
  return null;
}

/** Each handler returns null on success or a rejection reason. */
const HANDLERS: { [K in Command['type']]: Handler<Extract<Command, { type: K }>> } = {
  'hunter.move': (ctx, cmd) => {
    const bad = controllable(ctx, cmd.hunterId);
    if (bad) return bad;
    const h = findHunter(ctx.world, cmd.hunterId)!;
    if (cmd.zoneId === 'town') return setGoal(ctx, h, { type: 'returnTown' }, 'order', true) ? null : 'no path';
    if (!ctx.config.index.zones.has(cmd.zoneId)) return 'unknown zone';
    return setGoal(ctx, h, { type: 'hunt', zoneId: cmd.zoneId }, 'order', true) ? null : 'no path';
  },
  'hunter.activity': (ctx, cmd) => {
    const bad = controllable(ctx, cmd.hunterId);
    if (bad) return bad;
    const h = findHunter(ctx.world, cmd.hunterId)!;
    const b = ctx.config.index.buildings.get(cmd.buildingId);
    if (!b || b.kind !== 'service') return 'unknown service building';
    const lv = buildingLevel(ctx.world, b.id);
    if (lv < 1) return 'building not built';
    if (h.gold < servicePrice(ctx.config, h, b, lv)) return 'not enough gold';
    return setGoal(ctx, h, { type: 'service', buildingId: b.id }, 'order', true) ? null : 'no path';
  },
  'debug.spawnHunter': (ctx) => {
    if (townHunterCount(ctx.world) >= ctx.config.formula.hunterSlots) return 'no free slot';
    spawnHunter(ctx);
    return null;
  },
  'debug.removeHunter': (ctx, cmd) => {
    const away = awayReason(ctx, cmd.hunterId);
    if (away) return away;
    return removeHunter(ctx, cmd.hunterId) ? null : 'unknown hunter';
  },
  'debug.restoreNeeds': (ctx, cmd) => {
    const away = awayReason(ctx, cmd.hunterId);
    if (away) return away;
    const h = findHunter(ctx.world, cmd.hunterId);
    if (!h) return 'unknown hunter';
    if (!isAlive(h)) return 'hunter is dead';
    const max = ctx.config.formula.needMax;
    h.needs.satiety = max;
    h.needs.mood = max;
    h.needs.stamina = max;
    h.needs.hp = hunterStats(ctx.config, h).hp;
    return null;
  },
  'town.craft': (ctx, cmd) => startCraft(ctx, cmd.buildingId, cmd.gearId, cmd.difficultyId),
  'hunter.reclaimGear': (ctx, cmd) => {
    const bad = controllable(ctx, cmd.hunterId);
    if (bad) return bad;
    const h = findHunter(ctx.world, cmd.hunterId)!;
    if (ctx.config.index.nodes.get(h.nodeId)?.zoneId) return 'hunter is not in town';
    return reclaimHunterGear(ctx, h);
  },
  'town.listGear': (ctx, cmd) => listStoredGear(ctx, cmd.itemUid),
  'town.dismantleGear': (ctx, cmd) => dismantleStoredGear(ctx, cmd.itemUid),
  'town.setAutoDifficulty': (ctx, cmd) => {
    ctx.world.town.autoDifficulty = !!cmd.on;
    return null;
  },
  'town.setAutoCraft': (ctx, cmd) => {
    ctx.world.town.autoCraft = !!cmd.on;
    return null;
  },
  'hunter.reincarnate': (ctx, cmd) => {
    const bad = controllable(ctx, cmd.hunterId);
    if (bad) return bad;
    const h = findHunter(ctx.world, cmd.hunterId)!;
    // Same rule as auto-reincarnation (progressionSystem): only from Town. Order it home with Move first.
    if (ctx.config.index.nodes.get(h.nodeId)?.zoneId) return 'hunter is not in town';
    const why = reincarnateBlocker(ctx.config, h);
    if (why) return why;
    if (h.ai.goal?.type === 'reincarnate') return null; // already on its way
    // Walk to the portal; the reincarnation itself happens there (progression.enterPortal / advancePortal).
    return sendToPortal(ctx, h, 'order') ? null : 'no path';
  },
  'town.setDifficulty': (ctx, cmd) => {
    if (!ctx.config.index.difficulties.has(cmd.difficultyId)) return 'unknown difficulty';
    if (!ctx.world.town.unlockedDifficulties.includes(cmd.difficultyId)) return 'difficulty locked';
    ctx.world.town.difficulty = cmd.difficultyId;
    // The player's choice wins over the automatic step-up (TECH_SPEC §5.8); town.setAutoDifficulty turns it back on.
    ctx.world.town.autoDifficulty = false;
    ctx.events.emit(ctx.world.tick, { type: 'difficultyChanged', difficultyId: cmd.difficultyId });
    return null;
  },
  'town.setAutoReincarnate': (ctx, cmd) => {
    ctx.world.town.autoReincarnate = !!cmd.on;
    return null;
  },
  'town.requestMaterial': (ctx, cmd) => {
    if (!ctx.config.index.materials.has(cmd.materialId)) return 'unknown material';
    const n = cmd.count;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return 'invalid count';
    if (n > ctx.config.formula.requestMaxUnits) return 'count too large';
    const req = ctx.world.town.requests ?? (ctx.world.town.requests = {});
    if (n === 0) delete req[cmd.materialId];
    else req[cmd.materialId] = n;
    return null;
  },
  'town.postBounty': (ctx, cmd) => {
    const bad = validateBounty(ctx.config, ctx.world, cmd.targetKind, cmd.targetId, cmd.kills, cmd.reward);
    if (bad) return bad;
    postBounty(ctx, cmd.targetKind, cmd.targetId, cmd.kills, cmd.reward, false);
    return null;
  },
  'town.cancelBounty': (ctx, cmd) => (cancelBounty(ctx, cmd.bountyId, 'cancelled') ? null : 'unknown bounty'),
  'town.setAutoBounty': (ctx, cmd) => {
    ctx.world.town.autoBounty = !!cmd.on;
    return null;
  },
  'town.build': (ctx, cmd) => startBuild(ctx, cmd.buildingId, cmd.plotId),
  'town.upgrade': (ctx, cmd) => startUpgrade(ctx, cmd.buildingInstanceId),
  'town.cancelUpgrade': (ctx, cmd) => cancelUpgrade(ctx, cmd.buildingInstanceId),
  'town.setAutoInvest': (ctx, cmd) => {
    ctx.world.town.autoInvest = !!cmd.on;
    if (!ctx.world.town.autoInvest) ctx.world.town.investPlan = null;
    return null;
  },
  'town.setTaxRate': (ctx, cmd) => {
    const bad = validateTaxRate(ctx.config, cmd.rate);
    if (bad) return bad;
    setTaxRate(ctx, cmd.rate);
    return null;
  },
  'journey.start': (ctx, cmd) => {
    const bad = validateJourney(ctx, cmd.journeyId, cmd.hunterIds);
    if (bad) return bad;
    startJourney(ctx, ctx.config.index.journeys.get(cmd.journeyId)!, cmd.hunterIds);
    return null;
  },
  'journey.recall': (ctx, cmd) => (recallJourney(ctx, cmd.journeyUid) ? null : 'unknown journey'),
  'town.invite': (ctx, cmd) => {
    const { world, config } = ctx;
    const inv = config.index.invitations.get(cmd.invitationId);
    if (!inv) return 'unknown invitation';
    const tickets = world.town.tickets ?? (world.town.tickets = {});
    const useTicket = (tickets[inv.id] ?? 0) > 0;
    const gold = useTicket ? 0 : inv.gold;
    if (gold === undefined) return 'no ticket';
    if (!useTicket && inv.townHallLevel && buildingLevel(world, config.index.townHall) < inv.townHallLevel) return 'town hall level too low';
    if (world.town.gold < gold) return 'not enough gold';
    if (!hasFreeSlot(ctx) && !queueHasRoom(ctx)) return 'town and queue are full';
    if (useTicket) {
      tickets[inv.id] = tickets[inv.id]! - 1;
      if (tickets[inv.id] === 0) delete tickets[inv.id];
    } else {
      world.town.gold -= gold; // leaves the economy (gold sink)
      world.stats.inviteGold = (world.stats.inviteGold ?? 0) + gold;
    }
    world.stats.invites = (world.stats.invites ?? 0) + 1;
    const tier = rollInvitationTier(ctx.rng, inv);
    const r = admitInvited(ctx, tier, 'invite', inv.id);
    ctx.events.emit(world.tick, { type: 'hunterInvited', invitationId: inv.id, tier, paid: useTicket ? 'ticket' : 'gold', gold, hunterId: r.hunterId, queueUid: r.queueUid });
    return null;
  },
  'hunter.donate': (ctx, cmd) => {
    const away = awayReason(ctx, cmd.hunterId);
    if (away) return away;
    const h = findHunter(ctx.world, cmd.hunterId);
    if (!h) return 'unknown hunter';
    const g = cmd.gold;
    if (typeof g !== 'number' || !Number.isInteger(g) || g <= 0) return 'invalid gold';
    if (ctx.world.town.gold < g) return 'not enough gold';
    ctx.world.town.gold -= g;
    h.gold += g;
    ctx.world.stats.donatedGold = (ctx.world.stats.donatedGold ?? 0) + g;
    ctx.events.emit(ctx.world.tick, { type: 'hunterDonated', hunterId: h.id, gold: g });
    return null;
  },
  'hunter.banish': (ctx, cmd) => {
    const away = awayReason(ctx, cmd.hunterId);
    if (away) return away;
    const h = findHunter(ctx.world, cmd.hunterId);
    if (!h) return 'unknown hunter';
    const itemUids = Object.values(h.equipment).filter((g) => !!g).map((g) => g!.uid);
    reclaimGear(ctx, h, 'command'); // → town.gearStorage (gearReclaimed event); trims storage over gearStorageMax
    ctx.world.stats.banished = (ctx.world.stats.banished ?? 0) + 1;
    ctx.events.emit(ctx.world.tick, { type: 'hunterBanished', hunterId: h.id, itemUids, gold: h.gold });
    removeHunter(ctx, h.id);
    return null;
  },
  'hunter.rerollPersonality': (ctx, cmd) => {
    const away = awayReason(ctx, cmd.hunterId);
    if (away) return away;
    const h = findHunter(ctx.world, cmd.hunterId);
    if (!h) return 'unknown hunter';
    const gold = ctx.config.formula.personalityRerollGold ?? 0;
    if (ctx.world.town.gold < gold) return 'not enough gold';
    ctx.world.town.gold -= gold; // gold sink
    const from = h.personalities;
    h.personalities = rollPersonalities(ctx.config, ctx.rng);
    ctx.world.stats.personalityRerolls = (ctx.world.stats.personalityRerolls ?? 0) + 1;
    ctx.events.emit(ctx.world.tick, { type: 'personalityRerolled', hunterId: h.id, from, to: h.personalities, gold });
    return null;
  },
  'debug.grantTicket': (ctx, cmd) => {
    if (!ctx.config.index.invitations.has(cmd.invitationId)) return 'unknown invitation';
    const n = cmd.count;
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0 || n > 1000) return 'invalid count';
    const tickets = ctx.world.town.tickets ?? (ctx.world.town.tickets = {});
    tickets[cmd.invitationId] = (tickets[cmd.invitationId] ?? 0) + n;
    return null;
  },  'hunter.chooseJob': (ctx, cmd) => {
    const away = awayReason(ctx, cmd.hunterId);
    if (away) return away;
    const h = findHunter(ctx.world, cmd.hunterId);
    if (!h) return 'unknown hunter';
    return chooseJob(ctx, h, cmd.jobId);
  },
  'hunter.learn': (ctx, cmd) => {
    const away = awayReason(ctx, cmd.hunterId);
    if (away) return away;
    const h = findHunter(ctx.world, cmd.hunterId);
    if (!h) return 'unknown hunter';
    if (cmd.kind !== 'skill' && cmd.kind !== 'trait' && cmd.kind !== 'growth') return 'unknown study kind';
    const plan = { kind: cmd.kind, id: cmd.id };
    const why = learnPlanBlocker(ctx.config, h, plan);
    if (why) return why;
    h.learnPlan = plan;
    // Go now when it can be done now (in Town, Academy built); otherwise the AI goes once it can (ai/utility.bestLearn).
    const inTown = !ctx.config.index.nodes.get(h.nodeId)?.zoneId;
    if (controllable(ctx, h.id) === null && inTown && buildingLevel(ctx.world, ctx.config.index.academy) >= 1 && readyStudy(ctx.config, h, plan.kind, plan.id, ctx.world)) {
      setGoal(ctx, h, { type: 'learn', kind: plan.kind, id: plan.id }, 'order', true);
    }
    return null;
  },
  'hunter.cancelLearn': (ctx, cmd) => {
    const away = awayReason(ctx, cmd.hunterId);
    if (away) return away;
    const h = findHunter(ctx.world, cmd.hunterId);
    if (!h) return 'unknown hunter';
    if (!h.learnPlan) return 'no study plan';
    delete h.learnPlan;
    return null;
  },
  'hunter.buyMount': (ctx, cmd) => {
    const bad = controllable(ctx, cmd.hunterId);
    if (bad) return bad;
    const h = findHunter(ctx.world, cmd.hunterId)!;
    if (ctx.config.index.nodes.get(h.nodeId)?.zoneId) return 'hunter is not in town';
    if (buildingLevel(ctx.world, ctx.config.index.shop) < 1) return 'shop not built';
    const why = mountBlocker(ctx.config, h, cmd.mountId);
    if (why) return why;
    return setGoal(ctx, h, { type: 'buyMount', mountId: cmd.mountId }, 'order', true) ? null : 'no path';
  },
  'hunter.socketRune': (ctx, cmd) => {
    const away = awayReason(ctx, cmd.hunterId);
    if (away) return away;
    const h = findHunter(ctx.world, cmd.hunterId);
    if (!h) return 'unknown hunter';
    return socketRune(ctx, h, cmd.slot, cmd.stashIndex);
  },
  'hunter.unsocketRune': (ctx, cmd) => {
    const away = awayReason(ctx, cmd.hunterId);
    if (away) return away;
    const h = findHunter(ctx.world, cmd.hunterId);
    if (!h) return 'unknown hunter';
    return unsocketRune(ctx, h, cmd.slot);
  },
  'town.setAutoRune': (ctx, cmd) => {
    ctx.world.town.autoRune = !!cmd.on;
    return null;
  },
  'town.compose': (ctx, cmd) => compose(ctx, cmd.materialId, cmd.count),
  'town.upgradeRelic': (ctx, cmd) => upgradeRelic(ctx, cmd.relicId),
  'town.setAutoRelic': (ctx, cmd) => {
    ctx.world.town.autoRelic = !!cmd.on;
    return null;
  },
};

export function applyCommand(ctx: SystemContext, cmd: Command): void {
  const handler = HANDLERS[cmd.type] as Handler<Command> | undefined;
  const reason = handler ? handler(ctx, cmd) : 'unknown command';
  if (reason) ctx.events.emit(ctx.world.tick, { type: 'commandRejected', command: cmd.type, reason });
}
