import { needMax } from '../formulas';
import { personalityFactor } from '../hunterFactory';
import type { System } from '../system';
import { NEED_KEYS } from '../config/types';
import { isAlive, type NeedKey } from '../world';
import { fountainRegenMul } from './town';

const DECAY: { need: Exclude<NeedKey, 'hp'>; param: 'staminaDecayPerSec' | 'satietyDecayPerSec' | 'moodDecayPerSec' }[] = [
  { need: 'stamina', param: 'staminaDecayPerSec' },
  { need: 'satiety', param: 'satietyDecayPerSec' },
  { need: 'mood', param: 'moodDecayPerSec' },
];

/** Fraction under which a "needLow" event fires (UI hint only; the AI uses formula thresholds). */
const LOW_FRACTION = 0.25;

/**
 * Time-based need changes. Event-based decay (satiety per attack, mood per hit) lives in combat.
 * Idle hunters in town recover slowly for free so a broke hunter can never deadlock.
 */
export const needsSystem: System = {
  name: 'needs',
  update(ctx) {
    const { world, config, nav } = ctx;
    const sec = ctx.dtMs / 1000;
    const max = config.formula.needMax;
    for (const h of world.hunters) {
      if (!isAlive(h)) continue;
      // Max HP can drop (buff expiry, gear swap, job/reincarnation): never keep HP above it.
      h.needs.hp = Math.min(h.needs.hp, needMax(config, h, 'hp'));
      if (h.insideBuildingId) continue;

      for (const d of DECAY) {
        const before = h.needs[d.need];
        const rate = config.formula[d.param] * personalityFactor(config, h, `decay.${d.need}`);
        if (rate === 0) continue;
        const after = Math.max(0, before - rate * sec);
        h.needs[d.need] = after;
        if (before >= max * LOW_FRACTION && after < max * LOW_FRACTION) {
          ctx.events.emit(world.tick, { type: 'needLow', hunterId: h.id, need: d.need, value: after });
        }
      }

      const idleInTown = (!h.ai.goal || h.ai.goal.type === 'wander') && !nav.node(h.nodeId).zoneId;
      if (idleInTown) {
        // Fountain (TECH_SPEC §5.15) multiplies the free idle regen; × 1 without one.
        const regen = config.formula.townIdleRegenPerSec * fountainRegenMul(config, world) * sec;
        for (const n of NEED_KEYS) {
          const cap = needMax(config, h, n);
          h.needs[n] = Math.min(cap, h.needs[n] + regen * (cap / max));
        }
      }
    }
  },
};
