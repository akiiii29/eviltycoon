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
  /** A shop item left unsold for shopScrapSec was removed (no refund). */
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
  | { type: 'commandRejected'; tick: number; command: string; reason: string };

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
