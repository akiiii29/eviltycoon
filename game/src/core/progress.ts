import { expRequired, relicValue } from './progressionStats';
import type { SystemContext } from './system';
import type { Hunter } from './world';

/**
 * Add EXP and apply level-ups (M3): capped at formula.maxLevel (EXP stops accumulating at the cap),
 * base stat gains per level, and one trait point every `traitPointLevelStep` levels.
 * EXP per level comes from `exp_curve` by reincarnation count (M5, progressionStats.expRequired); the Relic of Wisdom
 * (relic effect expPct) adds its percent to every gain (TECH_SPEC §5.15).
 * Job changes and reincarnation are handled by the progression system, not here.
 */
export function gainExp(ctx: SystemContext, h: Hunter, amount: number): void {
  const f = ctx.config.formula;
  if (h.level >= f.maxLevel) {
    h.exp = 0;
    return;
  }
  const bonus = relicValue(ctx.config, ctx.world, 'expPct');
  h.exp += bonus > 0 ? amount * (1 + bonus / 100) : amount;
  while (h.level < f.maxLevel && h.exp >= expRequired(ctx.config, h.level, h.reincarnation)) {
    h.exp -= expRequired(ctx.config, h.level, h.reincarnation);
    h.level += 1;
    h.stats.hp += f.levelHpGain;
    h.stats.atk += f.levelAtkGain;
    h.stats.def += f.levelDefGain;
    h.needs.hp += f.levelHpGain;
    if (f.traitPointLevelStep > 0 && h.level % f.traitPointLevelStep === 0) h.traitPoints += 1;
    ctx.events.emit(ctx.world.tick, { type: 'levelUp', hunterId: h.id, level: h.level });
  }
  if (h.level >= f.maxLevel) h.exp = 0;
}
