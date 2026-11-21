/** One-way events from simulation to UI/render (VFX, sound, toasts). Never read back by the sim. */
export type SimEvent =
  /** v14: `source` visitor / invite / auto (auto-invite); `fromQueue` = came out of the waiting queue (TECH_SPEC §4.1). */
  | { type: 'hunterArrived'; tick: number; hunterId: string; source?: 'visitor' | 'invite' | 'auto'; fromQueue?: boolean }
  /** v14: a hunter joined the waiting queue (Town full); `position` 1 = front. `tier` set for invitations. */
  | { type: 'hunterQueued'; tick: number; queueUid: string; source: 'visitor' | 'invite' | 'auto'; tier?: string; position: number }
  /**
   * v14 `town.invite` / auto-invite: rolled `tier`; paid with a ticket, `gold` Town gold, or free (auto-invite). The hunter
   * entered (`hunterId`) or waits at the queue front (`queueUid`).
   */
  | { type: 'hunterInvited'; tick: number; invitationId: string; tier: string; paid: 'ticket' | 'gold' | 'free'; gold: number; hunterId?: string; queueUid?: string }
  /** v14 `hunter.donate`: Town gold moved to the hunter. */
  | { type: 'hunterDonated'; tick: number; hunterId: string; gold: number }
  /** v14 `hunter.banish`: the hunter left for good (gear → Town gear storage, see gearReclaimed; gold/bag leave with it). */
  | { type: 'hunterBanished'; tick: number; hunterId: string; itemUids: string[]; gold: number }
  /** v14 `hunter.rerollPersonality`: new personalities for `gold` Town gold. */
  | { type: 'personalityRerolled'; tick: number; hunterId: string; from: string[]; to: string[]; gold: number }
  | { type: 'hunterLeft'; tick: number; hunterId: string }
  | { type: 'needLow'; tick: number; hunterId: string; need: string; value: number }
  | { type: 'goalChanged'; tick: number; hunterId: string; goal: string; reason: string }
  | { type: 'serviceUsed'; tick: number; hunterId: string; buildingId: string; price: number }
  | { type: 'hit'; tick: number; attackerId: string; targetId: string; damage: number; crit: boolean; evaded: boolean }
  | { type: 'monsterKilled'; tick: number; hunterId: string; monsterId: string; defId: string }
  | { type: 'hunterDied'; tick: number; hunterId: string }
  /** v11: `fee` = revive fee paid, `townGold` = the Town's cut of it (TECH_SPEC §5.14). */
  | { type: 'hunterRevived'; tick: number; hunterId: string; fee?: number; townGold?: number }
  /** v11 supplies and potions (TECH_SPEC §5.14). */
  | { type: 'serviceStockout'; tick: number; hunterId: string; buildingId: string }
  | { type: 'supplyProduced'; tick: number; buildingId: string; consumableId: string; units: number }
  | { type: 'potionBought'; tick: number; hunterId: string; consumableId: string; count: number; gold: number; townGold: number }
  | { type: 'potionUsed'; tick: number; hunterId: string; consumableId: string; hp: number }
  | { type: 'levelUp'; tick: number; hunterId: string; level: number }
  | { type: 'materialsSold'; tick: number; hunterId: string; units: number; gold: number }
  /** Unrequested materials thrown away at the Trading Post (it only buys requested ones). */
  | { type: 'materialsDiscarded'; tick: number; hunterId: string; units: number }
  /** A shop item left unsold at its floor price for shopFloorHoldSec was removed (no refund). */
  | { type: 'gearScrapped'; tick: number; itemUid: string; gearId: string; qualityId: string; price: number }
  | { type: 'craftStarted'; tick: number; buildingId: string; gearId: string }
  | { type: 'gearCrafted'; tick: number; buildingId: string; itemUid: string; gearId: string; qualityId: string; difficultyId?: string }
  /**
   * TECH_SPEC §5.8: an item was dismantled — `materials` (floor(count × dismantleReturnFrac) of its recipe incl. tier essence)
   * went to Town Storage. `source`: shop = unsold at scrap age (instead of gearScrapped), storage = gear storage over
   * gearStorageMax, command = `town.dismantleGear`.
   */
  | { type: 'gearDismantled'; tick: number; itemUid: string; gearId: string; qualityId: string; difficultyId?: string; source: 'shop' | 'storage' | 'command'; materials: Record<string, number> }
  /** TECH_SPEC §5.8: a hunter's equipment went to Town gear storage (on reincarnation or `hunter.reclaimGear`). */
  | { type: 'gearReclaimed'; tick: number; hunterId: string; itemUids: string[]; reason: 'reincarnation' | 'command' }
  /** A stored (reclaimed) item was put back on sale in the shop. */
  | { type: 'gearRelisted'; tick: number; itemUid: string; gearId: string; price: number }
  | { type: 'gearBought'; tick: number; hunterId: string; itemUid: string; gearId: string; price: number }
  | { type: 'enhanceResult'; tick: number; hunterId: string; slot: string; success: boolean; level: number; cost: number }
  | { type: 'skillCast'; tick: number; hunterId: string; skillId: string; targets: number }
  | { type: 'jobChanged'; tick: number; hunterId: string; jobId: string; tier: number }
  | { type: 'reincarnated'; tick: number; hunterId: string; count: number }
  /** The hunter entered the Reincarnation Portal (left world.hunters for `durationSec`; TECH_SPEC §5.13). */
  | { type: 'portalEntered'; tick: number; hunterId: string; durationSec: number }
  | { type: 'learned'; tick: number; hunterId: string; kind: 'skill' | 'trait'; id: string; level: number; cost: number }
  | { type: 'difficultyUnlocked'; tick: number; difficultyId: string }
  | { type: 'difficultyChanged'; tick: number; difficultyId: string }
  /** Bounties (TECH_SPEC §5.9). `reward` was moved from Town gold into escrow. */
  | { type: 'bountyPosted'; tick: number; bountyId: string; targetKind: 'monster' | 'zone'; targetId: string; kills: number; reward: number; auto: boolean }
  /** A target kill: `gold` paid from escrow to the killer. */
  | { type: 'bountyProgress'; tick: number; bountyId: string; hunterId: string; progress: number; kills: number; gold: number }
  /** Last kill done; the Town received `kingdomGold` (round(reward × bountyCompletionFrac)) from the kingdom. */
  | { type: 'bountyCompleted'; tick: number; bountyId: string; hunterId: string; reward: number; kingdomGold: number }
  /** Cancelled by the player or an expired auto-bounty; `refund` (remaining escrow) went back to Town gold. */
  | { type: 'bountyCancelled'; tick: number; bountyId: string; refund: number; reason: 'cancelled' | 'expired' }
  /** Town buildings (TECH_SPEC §5.12): gold (incl. importGold) and material units were paid and leave the economy. */
  | { type: 'buildingStarted'; tick: number; instanceId: string; buildingId: string; toLevel: number; gold: number; materials: number; importGold: number; auto: boolean }
  | { type: 'buildingCompleted'; tick: number; instanceId: string; buildingId: string; level: number }
  /** A running construction/upgrade was cancelled; `refund` gold (and its materials) went back to the Town. */
  | { type: 'buildingCancelled'; tick: number; instanceId: string; buildingId: string; refund: number }
  /** Town tax (TECH_SPEC §5.10): `gold` of a kill's gold went to Town gold instead of the killer. */
  | { type: 'taxCollected'; tick: number; hunterId: string; gold: number }
  | { type: 'taxRateChanged'; tick: number; rate: number }
  /** Journeys (TECH_SPEC §5.11). `cost` left Town gold; the members left world.hunters. */
  | { type: 'journeyStarted'; tick: number; journeyUid: string; journeyId: string; hunterIds: string[]; teamPower: number; successChance: number; durationSec: number; cost: number }
  /** Outcome rolled at completion (online: the tick remainingMs hit 0; offline: on load). `offline` = resolved on load. */
  | { type: 'journeyCompleted'; tick: number; journeyUid: string; journeyId: string; hunterIds: string[]; success: boolean; successChance: number; rewards: JourneyRewards; offline: boolean }
  /** Recalled by the player: members return now with no reward (cost is not refunded). */
  | { type: 'journeyRecalled'; tick: number; journeyUid: string; journeyId: string; hunterIds: string[] }
  /** Training Ground session started (TECH_SPEC §5.15): EXP granted, gold paid (Town got `townGold` of it), level after. */
  | { type: 'trained'; tick: number; hunterId: string; exp: number; price: number; townGold: number; level: number }
  | { type: 'commandRejected'; tick: number; command: string; reason: string };

/** What a finished journey paid out (TECH_SPEC §5.11). */
export interface JourneyRewards {
  /** Town gold (reward + rare items sold because the shop was full). */
  gold: number;
  /** EXP given to EACH member. */
  exp: number;
  /** Materials added to Town storage (the requested part, Trading Post rule §5.7). */
  materials: Record<string, number>;
  /** Reward materials nobody requested: exported at surplusPrice, the gold is inside `gold`. Absent when none. */
  exported?: Record<string, number>;
  /** Rare finds: listed in the shop (`uid`) or sold at the markdown floor (`soldFor`) when the shop was full. */
  items: { gearId: string; qualityId: string; uid?: string; soldFor?: number }[];
}

export type SimEventInput = SimEvent extends infer E ? (E extends { tick: number } ? Omit<E, 'tick'> : never) : never;

export class EventBuffer {
  private items: SimEvent[] = [];

  emit(tick: number, e: SimEventInput): void {
    this.items.push({ ...e, tick } as SimEvent);
  }

  /** Returns and clears pending events. */
  drain(): SimEvent[] {
    const out = this.items;
    this.items = [];
    return out;
  }
}
