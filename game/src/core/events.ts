/** One-way events from simulation to UI/render (VFX, sound, toasts). Never read back by the sim. */
export type SimEvent =
  | { type: 'hunterArrived'; tick: number; hunterId: string }
  | { type: 'hunterLeft'; tick: number; hunterId: string }
  | { type: 'needLow'; tick: number; hunterId: string; need: string; value: number }
  | { type: 'goalChanged'; tick: number; hunterId: string; goal: string; reason: string }
  | { type: 'serviceUsed'; tick: number; hunterId: string; buildingId: string; price: number }
  | { type: 'hit'; tick: number; attackerId: string; targetId: string; damage: number; crit: boolean; evaded: boolean }
  | { type: 'monsterKilled'; tick: number; hunterId: string; monsterId: string; defId: string }
  | { type: 'hunterDied'; tick: number; hunterId: string }
  | { type: 'hunterRevived'; tick: number; hunterId: string }
  | { type: 'levelUp'; tick: number; hunterId: string; level: number }
  | { type: 'materialsSold'; tick: number; hunterId: string; units: number; gold: number }
  /** Unrequested materials thrown away at the Trading Post (it only buys requested ones). */
  | { type: 'materialsDiscarded'; tick: number; hunterId: string; units: number }
  /** A shop item left unsold at its floor price for shopFloorHoldSec was removed (no refund). */
  | { type: 'gearScrapped'; tick: number; itemUid: string; gearId: string; qualityId: string; price: number }
  | { type: 'craftStarted'; tick: number; buildingId: string; gearId: string }
  | { type: 'gearCrafted'; tick: number; buildingId: string; itemUid: string; gearId: string; qualityId: string }
  | { type: 'gearBought'; tick: number; hunterId: string; itemUid: string; gearId: string; price: number }
  | { type: 'enhanceResult'; tick: number; hunterId: string; slot: string; success: boolean; level: number; cost: number }
  | { type: 'skillCast'; tick: number; hunterId: string; skillId: string; targets: number }
  | { type: 'jobChanged'; tick: number; hunterId: string; jobId: string; tier: number }
  | { type: 'reincarnated'; tick: number; hunterId: string; count: number }
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
  /** Journeys (TECH_SPEC §5.10). `cost` left Town gold; the members left world.hunters. */
  | { type: 'journeyStarted'; tick: number; journeyUid: string; journeyId: string; hunterIds: string[]; teamPower: number; successChance: number; durationSec: number; cost: number }
  /** Outcome rolled at completion (online: the tick remainingMs hit 0; offline: on load). `offline` = resolved on load. */
  | { type: 'journeyCompleted'; tick: number; journeyUid: string; journeyId: string; hunterIds: string[]; success: boolean; successChance: number; rewards: JourneyRewards; offline: boolean }
  /** Recalled by the player: members return now with no reward (cost is not refunded). */
  | { type: 'journeyRecalled'; tick: number; journeyUid: string; journeyId: string; hunterIds: string[] }
  | { type: 'commandRejected'; tick: number; command: string; reason: string };

/** What a finished journey paid out (TECH_SPEC §5.10). */
export interface JourneyRewards {
  /** Town gold (reward + rare items sold because the shop was full). */
  gold: number;
  /** EXP given to EACH member. */
  exp: number;
  /** Materials added to Town storage. */
  materials: Record<string, number>;
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
