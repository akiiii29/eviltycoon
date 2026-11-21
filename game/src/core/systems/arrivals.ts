/**
 * Hunter arrivals, waiting queue and auto-invite (GDD §3 step 2; EHT "Waiting Slot"; TECH_SPEC §4.1). World v14.
 *
 * One function, `advanceArrivals(ctx, ms)`, runs both every tick (arrivalsSystem, ms = dtMs) and once for the whole
 * offline gap (offline.advanceOfflineWallClock), so the rules are identical online and offline:
 *  1. Queue first: while Town has a free slot (townHunterCount < hunterSlots; journey/portal hunters keep theirs), the
 *     front of `town.queue` enters at once.
 *  2. Visitors: with a free slot (and so an empty queue) one arrives every arrivalIntervalSec (`arrivalTimerMs`, back to 0
 *     when Town is full — the pre-v14 rule, unchanged). While Town is full a visitor JOINS the queue every
 *     queueArrivalIntervalSec (`queueTimerMs`) until it holds queueMax; queue entries are lightweight records, rolled (sim
 *     RNG) only when they enter, so a full town draws no RNG.
 *  3. Auto-invite: while townHunterCount ≤ autoInviteMaxHunters (and a slot or queue room is left) a free hunter of the
 *     `autoInvite` invitation (its tier odds) arrives every autoInviteIntervalSec (`autoInviteTimerMs`, 0 otherwise).
 * Timers left inactive reset to 0. Invitations (`town.invite`) enter at once when a slot is free, else go to the queue front.
 */
import { rollHunter, rollHunterOfTier, rollInvitationTier } from '../hunterFactory';
import type { System, SystemContext } from '../system';
import type { Hunter, HunterTier, QueueEntry } from '../world';
import { townHunterCount } from './journey';

export type ArrivalSource = QueueEntry['source'];

/** Ensure the v14 town fields exist (worlds built by hand in tests / tools before v14). */
function q(ctx: SystemContext): QueueEntry[] {
  const t = ctx.world.town;
  if (!Array.isArray(t.queue)) t.queue = [];
  return t.queue;
}

/** Put a new hunter on the town square (visitor: normal grade roll; `tier` given: rolled for that tier). */
export function spawnHunter(ctx: SystemContext, tier?: HunterTier, source: ArrivalSource = 'visitor', fromQueue = false): Hunter {
  const { world, config, rng, nav } = ctx;
  const sq = nav.node(config.index.squareNode);
  const id = `h${world.nextId++}`;
  const pos = { x: sq.x + rng.range(-1, 1), y: sq.y + rng.range(-1, 1) };
  const hunter = tier
    ? rollHunterOfTier(config, rng, id, tier, sq.id, pos, world.timeMs)
    : rollHunter(config, rng, id, sq.id, pos, world.timeMs);
  world.hunters.push(hunter);
  if (fromQueue) world.stats.queueEntered = (world.stats.queueEntered ?? 0) + 1;
  ctx.events.emit(world.tick, { type: 'hunterArrived', hunterId: id, source, fromQueue });
  return hunter;
}

export function hasFreeSlot(ctx: SystemContext): boolean {
  return townHunterCount(ctx.world) < ctx.config.formula.hunterSlots;
}

export function queueHasRoom(ctx: SystemContext): boolean {
  return q(ctx).length < ctx.config.formula.queueMax;
}

/** Add a waiting hunter (front = invitations: ahead of visitors, behind earlier invitations). Caller checks queueHasRoom. */
export function joinQueue(ctx: SystemContext, entry: Omit<QueueEntry, 'uid' | 'queuedAtMs'>, front = false): QueueEntry {
  const { world } = ctx;
  // Own counter (not world.nextId): queueing must not shift the ids of hunters/gear made later.
  const n = (world.stats.queueJoined ?? 0) + 1;
  world.stats.queueJoined = n;
  const e: QueueEntry = { uid: `q${n}`, ...entry, queuedAtMs: world.timeMs };
  // `front`: ahead of every plain visitor, behind earlier invitations (first invited, first in).
  const list = q(ctx);
  let at = list.length;
  if (front) {
    at = list.findIndex((x) => x.source === 'visitor');
    if (at < 0) at = list.length;
  }
  list.splice(at, 0, e);
  ctx.events.emit(world.tick, { type: 'hunterQueued', queueUid: e.uid, source: e.source, tier: e.tier, position: at + 1 });
  return e;
}

/**
 * A hunter for an invitation-rolled tier: enters now with a free slot (ahead of the queue, like the queue front would),
 * else waits at the queue front. Caller checks a slot or queue room.
 */
export function admitInvited(ctx: SystemContext, tier: HunterTier, source: 'invite' | 'auto', invitationId?: string): { hunterId?: string; queueUid?: string } {
  if (hasFreeSlot(ctx)) return { hunterId: spawnHunter(ctx, tier, source).id };
  const e = joinQueue(ctx, { source, tier, ...(invitationId ? { invitationId } : {}) }, true);
  return { queueUid: e.uid };
}

/** Remove a hunter in world.hunters (banish / debug); frees its slot for the queue. Returns false if unknown. */
export function removeHunter(ctx: SystemContext, hunterId: string): boolean {
  const i = ctx.world.hunters.findIndex((h) => h.id === hunterId);
  if (i < 0) return false;
  ctx.world.hunters.splice(i, 1);
  for (const m of ctx.world.monsters) if (m.targetHunterId === hunterId) m.targetHunterId = null;
  ctx.events.emit(ctx.world.tick, { type: 'hunterLeft', hunterId });
  return true;
}

export interface ArrivalsResult {
  /** Hunters that entered Town (visitors, queue, auto-invites), in order. */
  arrived: string[];
  /** Queue uids that joined (visitors while full, auto-invites while full). */
  queued: string[];
}

function autoInvite(ctx: SystemContext, out: ArrivalsResult): void {
  const { config, world } = ctx;
  world.stats.autoInvites = (world.stats.autoInvites ?? 0) + 1;
  const inv = config.index.autoInvitation ? config.index.invitations.get(config.index.autoInvitation) : undefined;
  if (!inv) {
    // No autoInvite row: a plain visitor.
    if (hasFreeSlot(ctx)) out.arrived.push(spawnHunter(ctx, undefined, 'auto').id);
    else out.queued.push(joinQueue(ctx, { source: 'auto' }, true).uid);
    return;
  }
  const tier = rollInvitationTier(ctx.rng, inv);
  const r = admitInvited(ctx, tier, 'auto', inv.id);
  ctx.events.emit(world.tick, { type: 'hunterInvited', invitationId: inv.id, tier, paid: 'free', gold: 0, hunterId: r.hunterId, queueUid: r.queueUid });
  if (r.hunterId) out.arrived.push(r.hunterId);
  if (r.queueUid) out.queued.push(r.queueUid);
}

/** Advance the arrival / queue / auto-invite timers by `ms` (see file header). Deterministic; bounded by slots + queueMax. */
export function advanceArrivals(ctx: SystemContext, ms: number): ArrivalsResult {
  const { world, config } = ctx;
  const f = config.formula;
  const t = world.town;
  const out: ArrivalsResult = { arrived: [], queued: [] };
  const queue = q(ctx);
  t.queueTimerMs ??= 0;
  t.autoInviteTimerMs ??= 0;
  const arrivalMs = f.arrivalIntervalSec * 1000;
  const queueMs = (f.queueArrivalIntervalSec ?? 0) * 1000;
  const inviteMs = (f.autoInviteIntervalSec ?? 0) * 1000;
  const queueMax = f.queueMax ?? 0;
  let left = Math.max(0, ms);
  for (let guard = 0; guard < 100_000; guard++) {
    // 1. The queue fills free slots first.
    while (queue.length > 0 && hasFreeSlot(ctx)) {
      const e = queue.shift()!;
      out.arrived.push(spawnHunter(ctx, e.tier, e.source, true).id);
    }
    const count = townHunterCount(world);
    const free = count < f.hunterSlots;
    const room = queue.length < queueMax;
    const visitorOn = free;
    const queueOn = !free && room && queueMs > 0;
    const inviteOn = inviteMs > 0 && count <= (f.autoInviteMaxHunters ?? -1) && (free || room);
    if (!visitorOn) t.arrivalTimerMs = 0;
    if (!queueOn) t.queueTimerMs = 0;
    if (!inviteOn) t.autoInviteTimerMs = 0;
    if (!visitorOn && !queueOn && !inviteOn) break;
    // Time to the next due timer.
    let next = Infinity;
    if (visitorOn) next = Math.min(next, Math.max(0, arrivalMs - t.arrivalTimerMs));
    if (queueOn) next = Math.min(next, Math.max(0, queueMs - t.queueTimerMs));
    if (inviteOn) next = Math.min(next, Math.max(0, inviteMs - t.autoInviteTimerMs));
    const step = Math.min(next, left);
    if (visitorOn) t.arrivalTimerMs += step;
    if (queueOn) t.queueTimerMs += step;
    if (inviteOn) t.autoInviteTimerMs += step;
    left -= step;
    if (next > step) break; // nothing more due within `ms`
    // Fire one due timer, then re-evaluate (a fill can switch the other timers on/off).
    if (inviteOn && t.autoInviteTimerMs >= inviteMs) {
      t.autoInviteTimerMs -= inviteMs;
      autoInvite(ctx, out);
    } else if (visitorOn && t.arrivalTimerMs >= arrivalMs) {
      t.arrivalTimerMs = arrivalMs > 0 ? t.arrivalTimerMs - arrivalMs : 0;
      out.arrived.push(spawnHunter(ctx).id);
    } else if (queueOn && t.queueTimerMs >= queueMs) {
      t.queueTimerMs -= queueMs;
      out.queued.push(joinQueue(ctx, { source: 'visitor' }).uid);
    }
  }
  // Town full after the last arrival: the visitor timer rests at 0 (pre-v14 rule).
  if (!hasFreeSlot(ctx)) t.arrivalTimerMs = 0;
  return out;
}

/** GDD §3 step 2: hunters visit the town over time; a waiting queue while slots are full (TECH_SPEC §4.1). */
export const arrivalsSystem: System = {
  name: 'arrivals',
  update(ctx) {
    advanceArrivals(ctx, ctx.dtMs);
  },
};
