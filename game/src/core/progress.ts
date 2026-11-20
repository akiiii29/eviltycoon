import { expToNext } from './formulas';
import type { SystemContext } from './system';
import type { Hunter } from './world';

/**
 * Add EXP and apply level-ups (M3): capped at formula.maxLevel (EXP stops accumulating at the cap),
 * base stat gains per level, and one trait point every `traitPointLevelStep` levels.
 * Job changes and reincarnation are handled by the progression system, not here.
 */
export function gainExp(ctx: SystemContext, h: Hunter, amount: number): void {
  const f = ctx.config.formula;
  if (h.level >= f.maxLevel) {
    h.exp = 0;
    return;
  }
  h.exp += amount;
  while (h.level < f.maxLevel && h.exp >= expToNext(h.level, f)) {
    h.exp -= expToNext(h.level, f);
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
