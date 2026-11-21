import { t } from '../core/config/load';
import type { GameConfig, GearDef } from '../core/config/types';
import { GEAR_SLOTS } from '../core/config/types';
import type { SimEvent } from '../core/events';
import { hunterStats, needMax } from '../core/formulas';
import { bestJourneyTeam, journeyPreview, townHunterCount } from '../core/systems/journey';
import type { Simulation } from '../core/simulation';
import { taxMoodLoss, taxRate } from '../core/systems/tax';
import { buildBlocker, craftMaxGearLevel, levelCost, shopCapacity, townHallLevel, upgradeBlocker } from '../core/systems/town';
import type { GearInstance, Hunter, NeedKey } from '../core/world';
import { bagCount } from '../core/world';

export interface OverlayActions {
  save(): void;
  load(): void;
  reset(): void;
}

const NEEDS: NeedKey[] = ['hp', 'satiety', 'mood', 'stamina'];
const NEED_LABEL: Record<NeedKey, string> = { hp: 'HP', satiety: 'No', mood: 'Vui', stamina: 'Sức' };
const MAX_LOG = 12;
/** skillCast events are summed over this many ticks (5 s game time) into one log line (TODO §5: log spam). */
export const SKILL_LOG_WINDOW_TICKS = 50;
/** Debug overlay "post bounty" buttons: a zone bounty of this size. */
const DEBUG_BOUNTY_KILLS = 10;
const DEBUG_BOUNTY_REWARD = 100;
/** Debug overlay "donate" button: Town gold given to a hunter per click (TECH_SPEC §4.1). */
const DEBUG_DONATE_GOLD = 100;

/**
 * Aggregates skillCast events into one line per window of SKILL_LOG_WINDOW_TICKS (by event tick, so x4 speed or a
 * paused game behave the same). Pure (no DOM) so it can be unit-tested. A tick going backwards (Load / Reset) closes
 * the open window.
 */
export class SkillCastLog {
  private start = -1;
  private casts = 0;
  private targets = 0;
  private perHunter = new Map<string, number>();

  constructor(private window = SKILL_LOG_WINDOW_TICKS) {}

  /** Lines (oldest first) closed by reaching `tick`; call with every event tick and the current world tick. */
  advance(tick: number): string[] {
    if (this.start < 0) return [];
    if (tick >= this.start && tick < this.start + this.window) return [];
    return [this.flush()];
  }

  /** Add a cast; returns lines of windows it closed. */
  add(tick: number, hunterId: string, targets: number): string[] {
    const out = this.advance(tick);
    if (this.start < 0) this.start = tick;
    this.casts += 1;
    this.targets += Math.max(1, targets);
    this.perHunter.set(hunterId, (this.perHunter.get(hunterId) ?? 0) + 1);
    return out;
  }

  private flush(): string {
    const top = [...this.perHunter].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const shown = top.slice(0, 3).map(([id, n]) => `${id} ×${n}`).join(', ');
    const more = top.length > 3 ? ` +${top.length - 3} hunter` : '';
    const line = `#${this.start} kỹ năng ×${this.casts} (${this.targets} mục tiêu, ${this.window / 10}s): ${shown}${more}`;
    this.start = -1;
    this.casts = 0;
    this.targets = 0;
    this.perHunter.clear();
    return line;
  }
}

function name(config: GameConfig, nameKey: string | undefined, fallback: string): string {
  return nameKey ? t(config, nameKey) : fallback;
}
function gearName(config: GameConfig, gearId: string): string {
  return name(config, config.index.gear.get(gearId)?.nameKey, gearId);
}
function qualityName(config: GameConfig, qualityId: string): string {
  return name(config, config.index.qualities.get(qualityId)?.nameKey, qualityId);
}
function buildingName(config: GameConfig, id: string): string {
  return name(config, config.index.buildings.get(id)?.nameKey, id);
}
function materialName(config: GameConfig, id: string): string {
  return name(config, config.index.materials.get(id)?.nameKey, id);
}
function slotName(config: GameConfig, slot: string): string {
  return t(config, `slot.${slot}`);
}
function skillName(config: GameConfig, id: string): string {
  return name(config, config.index.skills.get(id)?.nameKey, id);
}
function traitName(config: GameConfig, id: string): string {
  return name(config, config.index.traits.get(id)?.nameKey, id);
}
function bountyTargetName(config: GameConfig, kind: 'monster' | 'zone', id: string): string {
  return kind === 'zone' ? name(config, config.index.zones.get(id)?.nameKey, id) : name(config, config.index.monsters.get(id)?.nameKey, id);
}
function difficultyName(config: GameConfig, id: string): string {
  return name(config, config.index.difficulties.get(id)?.nameKey, id);
}
function journeyName(config: GameConfig, id: string): string {
  return name(config, config.index.journeys.get(id)?.nameKey, id);
}
function jobName(config: GameConfig, id: string): string {
  return name(config, config.index.jobs.get(id)?.nameKey, id);
}
/** Buff source is normally a skill id; fall back to traits, then the raw id. */
function sourceName(config: GameConfig, id: string): string {
  const k = config.index.skills.get(id)?.nameKey ?? config.index.traits.get(id)?.nameKey;
  return name(config, k, id);
}
/** Gear tier prefix (TECH_SPEC §5.8), e.g. "Tempered " — empty for the base tier. */
function tierPrefix(config: GameConfig, difficultyId: string | undefined): string {
  const k = difficultyId ? config.index.difficulties.get(difficultyId)?.gearPrefixKey : undefined;
  return k ? `${t(config, k)} ` : '';
}
function gearLabel(config: GameConfig, g: GearInstance): string {
  // M5 (TECH_SPEC §4.2): grade and option lines, e.g. "{S} (Attack +4.2%, Crit +2)".
  const grade = g.gradeId ? ` {${t(config, config.index.gearGrades.get(g.gradeId)?.nameKey ?? g.gradeId)}}` : '';
  const opts = (g.options ?? []).map((o) => t(config, config.index.gearOptions.get(o.id)?.nameKey ?? o.id).replace('{v}', String(o.value)));
  return `${tierPrefix(config, g.difficultyId)}${gearName(config, g.gearId)} [${qualityName(config, g.qualityId)}]${grade} +${g.enhance}${opts.length ? ` (${opts.join(', ')})` : ''}`;
}

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** Debug overlay (TECH_SPEC §11): state, controls, hunters, event log. Reads state, sends commands only. */
export class DebugOverlay {
  private root: HTMLElement;
  private stats: HTMLElement;
  private hunters: HTMLElement;
  private town: HTMLElement;
  /** Recipes per craft building id (static config, built once). */
  private recipes = new Map<string, GearDef[]>();
  private logEl: HTMLElement;
  private log: string[] = [];
  private status = '';
  private skillLog = new SkillCastLog();
  /** Hunters picked for the next journey (overlay-only state; stale ids are dropped when sending). */
  private team = new Set<string>();

  constructor(parent: HTMLElement, private sim: Simulation, private actions: OverlayActions) {
    this.root = document.createElement('div');
    this.root.className = 'debug';
    this.root.innerHTML = `
      <div class="debug-head">DEBUG · M4</div>
      <div class="debug-stats"></div>
      <div class="debug-row">
        <button data-a="pause">⏸</button>
        <button data-a="speed" data-v="1">x1</button>
        <button data-a="speed" data-v="2">x2</button>
        <button data-a="speed" data-v="4">x4</button>
        <button data-a="step">+1 tick</button>
      </div>
      <div class="debug-row">
        <button data-a="spawn">+ Hunter</button>
        <button data-a="save">Save</button>
        <button data-a="load">Load</button>
        <button data-a="reset">Reset</button>
      </div>
      <details class="debug-town" open><summary>Town</summary><div class="town-body"></div></details>
      <div class="debug-hunters"></div>
      <div class="debug-sub">Events</div>
      <div class="debug-log"></div>`;
    parent.appendChild(this.root);
    this.stats = this.root.querySelector('.debug-stats')!;
    this.hunters = this.root.querySelector('.debug-hunters')!;
    this.town = this.root.querySelector('.town-body')!;
    for (const g of sim.config.gear) {
      const list = this.recipes.get(g.craftBuilding) ?? [];
      list.push(g);
      this.recipes.set(g.craftBuilding, list);
    }
    this.logEl = this.root.querySelector('.debug-log')!;
    this.root.addEventListener('click', (e) => this.onClick(e));
  }

  private onClick(e: Event): void {
    const el = (e.target as HTMLElement).closest('button');
    if (!el) return;
    const a = el.dataset.a;
    const sim = this.sim;
    switch (a) {
      case 'pause': sim.paused = !sim.paused; break;
      case 'speed': sim.speed = Number(el.dataset.v); sim.paused = false; break;
      case 'step': sim.step(); break;
      case 'spawn': sim.enqueue({ type: 'debug.spawnHunter' }); break;
      case 'save': this.actions.save(); break;
      case 'load': this.actions.load(); break;
      case 'reset': this.actions.reset(); break;
      case 'restore': sim.enqueue({ type: 'debug.restoreNeeds', hunterId: el.dataset.id! }); break;
      case 'remove': sim.enqueue({ type: 'debug.removeHunter', hunterId: el.dataset.id! }); break;
      case 'move': sim.enqueue({ type: 'hunter.move', hunterId: el.dataset.id!, zoneId: el.dataset.zone! }); break;
      case 'craft': sim.enqueue({ type: 'town.craft', buildingId: el.dataset.b!, gearId: el.dataset.g! }); break;
      case 'autocraft': sim.enqueue({ type: 'town.setAutoCraft', on: !sim.world.town.autoCraft }); break;
      case 'difficulty': sim.enqueue({ type: 'town.setDifficulty', difficultyId: el.dataset.d! }); break;
      case 'autoreinc': sim.enqueue({ type: 'town.setAutoReincarnate', on: !sim.world.town.autoReincarnate }); break;
      case 'autodiff': sim.enqueue({ type: 'town.setAutoDifficulty', on: !sim.world.town.autoDifficulty }); break;
      case 'autobounty': sim.enqueue({ type: 'town.setAutoBounty', on: !sim.world.town.autoBounty }); break;
      case 'build': sim.enqueue({ type: 'town.build', buildingId: el.dataset.b!, plotId: el.dataset.p! }); break;
      case 'upgrade': sim.enqueue({ type: 'town.upgrade', buildingInstanceId: el.dataset.id! }); break;
      case 'cancelupgrade': sim.enqueue({ type: 'town.cancelUpgrade', buildingInstanceId: el.dataset.id! }); break;
      case 'autoinvest': sim.enqueue({ type: 'town.setAutoInvest', on: !sim.world.town.autoInvest }); break;
      case 'tax': sim.enqueue({ type: 'town.setTaxRate', rate: Number(el.dataset.v) }); break;
      case 'postbounty':
        sim.enqueue({ type: 'town.postBounty', targetKind: 'zone', targetId: el.dataset.z!, kills: DEBUG_BOUNTY_KILLS, reward: DEBUG_BOUNTY_REWARD });
        break;
      case 'cancelbounty': sim.enqueue({ type: 'town.cancelBounty', bountyId: el.dataset.id! }); break;
      case 'reincarnate': sim.enqueue({ type: 'hunter.reincarnate', hunterId: el.dataset.id! }); break;
      case 'team': {
        const id = el.dataset.id!;
        if (this.team.has(id)) this.team.delete(id);
        else this.team.add(id);
        break;
      }
      case 'journey': {
        const ids = [...this.team].filter((id) => sim.world.hunters.some((h) => h.id === id));
        sim.enqueue({ type: 'journey.start', journeyId: el.dataset.j!, hunterIds: ids });
        this.team.clear();
        break;
      }
      case 'journeybest': {
        const def = sim.config.index.journeys.get(el.dataset.j!);
        if (def) sim.enqueue({ type: 'journey.start', journeyId: def.id, hunterIds: bestJourneyTeam(sim.config, sim.world, def).map((h) => h.id) });
        break;
      }
      case 'recall': sim.enqueue({ type: 'journey.recall', journeyUid: el.dataset.id! }); break;
      // M5 hunter systems (TECH_SPEC §4.1).
      case 'invite': sim.enqueue({ type: 'town.invite', invitationId: el.dataset.i! }); break;
      case 'ticket': sim.enqueue({ type: 'debug.grantTicket', invitationId: el.dataset.i!, count: 1 }); break;
      case 'donate': sim.enqueue({ type: 'hunter.donate', hunterId: el.dataset.id!, gold: DEBUG_DONATE_GOLD }); break;
      case 'banish': sim.enqueue({ type: 'hunter.banish', hunterId: el.dataset.id! }); break;
      case 'reroll': sim.enqueue({ type: 'hunter.rerollPersonality', hunterId: el.dataset.id! }); break;
    }
    this.render();
  }

  setStatus(s: string): void {
    this.status = s;
  }

  pushEvents(events: SimEvent[]): void {
    const config = this.sim.config;
    const closed = (lines: string[]) => { for (const l of lines) this.log.unshift(l); };
    for (const e of events) {
      if (e.type === 'hit' || e.type === 'monsterKilled' || e.type === 'bountyProgress' || e.type === 'taxCollected') continue; // too noisy for the log
      if (e.type === 'skillCast') {
        closed(this.skillLog.add(e.tick, e.hunterId, e.targets));
        continue;
      }
      closed(this.skillLog.advance(e.tick));
      const line = economyLine(config, e) ?? progressLine(config, e);
      if (line) {
        this.log.unshift(`#${e.tick} ${line}`);
        continue;
      }
      const detail = 'hunterId' in e ? e.hunterId : '';
      let extra = '';
      if (e.type === 'needLow') extra = ` ${e.need}=${e.value.toFixed(1)}`;
      else if (e.type === 'commandRejected') extra = ` ${e.command}: ${e.reason}`;
      else if (e.type === 'goalChanged') extra = ` → ${e.goal} (${e.reason})`;
      else if (e.type === 'serviceUsed') extra = ` ${e.buildingId} -${e.price}g`;
      else if (e.type === 'levelUp') extra = ` Lv${e.level}`;
      this.log.unshift(`#${e.tick} ${e.type} ${detail}${extra}`);
    }
    closed(this.skillLog.advance(this.sim.world.tick));
    if (this.log.length > MAX_LOG) this.log.length = MAX_LOG;
  }

  private renderTown(): string {
    const { world, config } = this.sim;
    const town = world.town;
    const storage = Object.entries(town.storage).filter(([, n]) => n > 0)
      .map(([id, n]) => `${esc(materialName(config, id))} ×${n}`).join(', ') || '—';
    const crafts = config.buildings.filter((b) => b.kind === 'craft').map((b) => {
      const job = town.crafting[b.id] ?? null;
      let status = 'rảnh';
      if (job) {
        const total = (config.index.gear.get(job.gearId)?.craftSec ?? 0) * 1000;
        const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((1 - job.remainingMs / total) * 100))) : 0;
        status = `${gearName(config, job.gearId)} ${pct}%`;
      }
      const btns = (this.recipes.get(b.id) ?? [])
        .map((g) => `<button data-a="craft" data-b="${esc(b.id)}" data-g="${esc(g.id)}">+ ${esc(t(config, g.nameKey))}</button>`).join('');
      return `<div class="craft"><b>${esc(t(config, b.nameKey))}</b>: <span class="craft-job">${esc(status)}</span><div class="craft-btns">${btns}</div></div>`;
    }).join('');
    const cap = shopCapacity(config, world);
    const shop = town.shop.map((it) =>
      `<div class="shop-item">${esc(gearLabel(config, it))} <span class="price">${it.price}g</span></div>`).join('')
      || '<div class="shop-item">—</div>';
    return `
      town gold <b>${town.gold}</b><br>
      kho: ${storage}
      ${crafts}
      <div class="debug-row"><button data-a="autocraft">auto-craft: ${town.autoCraft ? 'BẬT' : 'TẮT'}</button></div>
      <div class="debug-sub">Cửa hàng ${town.shop.length}/${cap}</div>
      <div class="shop-list">${shop}</div>
      ${this.renderBuildings()}
      ${this.renderBounties()}
      ${this.renderTax()}
      ${this.renderJourneys()}
      ${this.renderInvites()}
      ${this.renderDifficulty()}`;
  }

  /**
   * Journey block (TECH_SPEC §5.11): running journeys (time left, power, chance, recall) and one row per destination
   * with the preview for the picked team (or the best Town team) and send buttons. Pick hunters with "+đội".
   */
  private renderJourneys(): string {
    const { world, config } = this.sim;
    const f = config.formula;
    const running = (world.journeys ?? []).map((j) =>
      `<div class="journey">${esc(journeyName(config, j.journeyId))} · ${esc(j.hunters.map((h) => `${h.id} Lv${h.level}`).join(', '))} · ` +
      `còn ${fmtTime(j.remainingMs)} · sức ${j.teamPower.toFixed(2)} · ${Math.round(j.successChance * 100)}% ` +
      `<button data-a="recall" data-id="${esc(j.id)}">gọi về</button></div>`).join('') || '<div class="journey">—</div>';
    const picked = world.hunters.filter((h) => this.team.has(h.id));
    const dests = config.journeys.map((d) => {
      const team = picked.length > 0 ? picked : bestJourneyTeam(config, world, d);
      const p = team.length > 0 ? journeyPreview({ config, world }, d, team) : null;
      const prev = p ? `${picked.length > 0 ? 'đội chọn' : 'đội tốt nhất'} ${p.teamPower.toFixed(2)} → ${Math.round(p.successChance * 100)}%` : 'không có hunter ở Town';
      return `<div class="journey-dest"><b>${esc(t(config, d.nameKey))}</b> · ${esc(name(config, config.index.zones.get(d.zoneId)?.nameKey, d.zoneId))} · ` +
        `đề xuất ${d.recommendedPower} · ${Math.round(d.durationSec / 60)} phút · phí ${d.cost}g · thưởng ${d.gold}g, ${d.exp} EXP<br>` +
        `<span class="journey-prev">${esc(prev)}</span> ` +
        `<button data-a="journey" data-j="${esc(d.id)}"${picked.length > 0 ? '' : ' disabled'}>gửi đội chọn</button>` +
        `<button data-a="journeybest" data-j="${esc(d.id)}"${bestJourneyTeam(config, world, d).length > 0 ? '' : ' disabled'}>gửi ${f.journeyTeamMax} mạnh nhất</button></div>`;
    }).join('');
    return `
      <div class="debug-sub">Hành trình ${(world.journeys ?? []).length}/${f.journeyMaxActive} · thành công ${world.stats.journeysSucceeded ?? 0} · thất bại ${world.stats.journeysFailed ?? 0} · đội chọn: ${esc([...this.team].join(', ') || '—')}</div>
      ${running}
      ${dests}`;
  }

  /** Town tax on kill gold (TECH_SPEC §5.10): current rate, total collected, −/+ 5 points within the config bounds. */
  /**
   * Buildings block (TECH_SPEC §5.12): each building with level/max, craft tier cap, upgrade progress, next cost and
   * upgrade/cancel buttons; free plots with a build button per buildable type; auto-invest toggle and its current plan.
   */
  private renderBuildings(): string {
    const { world, config } = this.sim;
    const town = world.town;
    const costText = (c: ReturnType<typeof levelCost>) => {
      if (!c) return '';
      const mats = Object.entries(c.materials).map(([id, n]) => `${materialName(config, id)}×${n}`).join(' ');
      return `${c.gold}g${mats ? ' ' + mats : ''} ${Math.round(c.ms / 1000)}s`;
    };
    const rows = (town.buildings ?? []).map((s) => {
      const b = config.index.buildings.get(s.buildingId);
      if (!b) return '';
      const cap = b.kind === 'craft' ? ` · đồ ≤ Lv${craftMaxGearLevel(config, world, b.id)}` : '';
      let status = '';
      if (s.upgrade) {
        const pct = s.upgrade.totalMs > 0 ? Math.round((1 - s.upgrade.remainingMs / s.upgrade.totalMs) * 100) : 100;
        status = ` → Lv${s.upgrade.toLevel} ${pct}% ${s.upgrade.auto ? '(tự động)' : ''} <button data-a="cancelupgrade" data-id="${esc(s.id)}">hủy</button>`;
      } else {
        const why = upgradeBlocker(config, world, s.id);
        const next = s.level < b.maxLevel ? costText(levelCost(config, b, s.level + 1)) : '';
        status = why ? ` <span class="req">${esc(why)}</span>` : ` <button data-a="upgrade" data-id="${esc(s.id)}">nâng (${esc(next)})</button>`;
      }
      return `<div class="building">${esc(t(config, b.nameKey))} Lv${s.level}/${b.maxLevel}${cap}${status}</div>`;
    }).join('');
    const th = townHallLevel(config, world);
    const free = config.plots.filter((p) => !(town.buildings ?? []).some((s) => s.id === p.id)).map((p) => {
      if (p.townHallLevel > th) return `<div class="building">${esc(p.id)}: <span class="req">cần Tòa Thị Chính Lv${p.townHallLevel}</span></div>`;
      const btns = config.buildings.filter((b) => !buildBlocker(config, world, b.id, p.id))
        .map((b) => `<button data-a="build" data-b="${esc(b.id)}" data-p="${esc(p.id)}">xây ${esc(t(config, b.nameKey))} (${esc(costText(levelCost(config, b, 1)))})</button>`).join('');
      return `<div class="building">${esc(p.id)}: trống ${btns || '—'}</div>`;
    }).join('');
    const plan = town.investPlan;
    const planText = plan ? `${buildingName(config, plan.buildingId)} → Lv${plan.toLevel}${plan.urgent ? ' (gấp)' : ''}` : '—';
    return `
      <div class="debug-sub">Công trình · đầu tư ${world.stats.investGold ?? 0}g</div>
      ${rows}${free}
      <div class="debug-row"><button data-a="autoinvest">tự đầu tư: ${town.autoInvest ? 'BẬT' : 'TẮT'}</button> kế hoạch: ${esc(planText)}</div>`;
  }

  private renderTax(): string {
    const { world, config } = this.sim;
    const f = config.formula;
    const rate = taxRate(config, world);
    const step = (d: number) => Math.round(Math.min(f.taxMaxRate, Math.max(f.taxMinRate, rate + d)) * 100) / 100;
    const btn = (d: number, label: string) => {
      const v = step(d);
      return `<button data-a="tax" data-v="${v}"${v === rate ? ' disabled' : ''}>${label}</button>`;
    };
    const mood = taxMoodLoss(config, rate);
    return `
      <div class="debug-sub">Thuế ${Math.round(rate * 100)}% vàng kill · đã thu ${world.stats.taxCollected ?? 0}g${mood > 0 ? ` · −${mood.toFixed(2)} mood/kill` : ''}</div>
      <div class="debug-row">${btn(-0.05, '−5%')}${btn(0.05, '+5%')}</div>`;
  }

  /** Bounty block (TECH_SPEC §5.9): active bounties with progress, escrow and a cancel button; auto-bounty toggle. */
  private renderBounties(): string {
    const { world, config } = this.sim;
    const town = world.town;
    const list = (town.bounties ?? []).map((b) =>
      `<div class="bounty">${b.auto ? '[tự động] ' : ''}${esc(bountyTargetName(config, b.targetKind, b.targetId))} ` +
      `${b.progress}/${b.kills} · thưởng ${b.reward}g (còn ${b.escrow}g) ` +
      `<button data-a="cancelbounty" data-id="${esc(b.id)}">hủy</button></div>`).join('') || '<div class="bounty">—</div>';
    // Debug post: a zone bounty of DEBUG_BOUNTY_KILLS kills for DEBUG_BOUNTY_REWARD gold (the command validates it).
    const post = config.zones.map((z) =>
      `<button data-a="postbounty" data-z="${esc(z.id)}">+${esc(t(config, z.nameKey))}</button>`).join('');
    return `
      <div class="debug-sub">Bounty ${(town.bounties ?? []).length}/${config.formula.bountyMaxActive} · xong ${world.stats.bountiesCompleted ?? 0} · trả ${world.stats.bountyGoldPaid ?? 0}g</div>
      ${list}
      <div class="debug-row bounty-post">đặt ${DEBUG_BOUNTY_KILLS} kill / ${DEBUG_BOUNTY_REWARD}g: ${post}</div>
      <div class="debug-row"><button data-a="autobounty">bounty tự động: ${town.autoBounty ? 'BẬT' : 'TẮT'}</button></div>`;
  }

  /**
   * M5 waiting queue and invitations (TECH_SPEC §4.1): queue (front first, invited tier shown), timers, tickets owned and
   * one "invite" button per invitation (ticket or gold cost; Town Hall requirement), "+vé" debug ticket.
   */
  private renderInvites(): string {
    const { world, config } = this.sim;
    const town = world.town;
    const f = config.formula;
    const queue = town.queue ?? [];
    const head = queue.slice(0, 8).map((e) => `${e.uid}${e.tier ? ` <span class="tier-${e.tier}">${e.tier}</span>` : ''}${e.source !== 'visitor' ? ` (${e.source === 'auto' ? 'mời tự động' : 'thư mời'})` : ''}`).join(', ');
    const th = townHallLevel(config, world);
    const btns = config.invitations.map((inv) => {
      const n = town.tickets?.[inv.id] ?? 0;
      const label = esc(t(config, inv.nameKey));
      const cost = n > 0 ? `vé ×${n}` : inv.gold === undefined ? 'cần vé' : `${inv.gold}g`;
      const locked = n === 0 && (inv.gold === undefined || (inv.townHallLevel ?? 0) > th);
      const req = n === 0 && inv.gold !== undefined && (inv.townHallLevel ?? 0) > th ? ` title="cần Town Hall Lv${inv.townHallLevel}"` : '';
      return `<button data-a="invite" data-i="${esc(inv.id)}"${locked ? ' disabled' : ''}${req}>mời: ${label} (${cost})</button><button data-a="ticket" data-i="${esc(inv.id)}" title="debug: +1 vé">+vé</button>`;
    }).join('');
    const full = townHunterCount(world) >= f.hunterSlots;
    const next = full
      ? `vào hàng chờ sau ${Math.max(0, f.queueArrivalIntervalSec - (town.queueTimerMs ?? 0) / 1000).toFixed(0)}s`
      : `hunter tới sau ${Math.max(0, f.arrivalIntervalSec - town.arrivalTimerMs / 1000).toFixed(0)}s`;
    const auto = townHunterCount(world) <= f.autoInviteMaxHunters
      ? ` · mời tự động sau ${Math.max(0, f.autoInviteIntervalSec - (town.autoInviteTimerMs ?? 0) / 1000).toFixed(0)}s` : '';
    return `
      <div class="debug-sub">Hàng chờ ${queue.length}/${f.queueMax} · ${next}${auto}</div>
      <div class="journey">${head || '—'}${queue.length > 8 ? ' …' : ''}</div>
      <div class="debug-row">${btns}</div>`;
  }

  /** M3 difficulty block: current, one button per difficulty (locked ones show their requirement), auto-reincarnate. */
  private renderDifficulty(): string {
    const { world, config } = this.sim;
    const town = world.town;
    const unlocked = new Set(town.unlockedDifficulties);
    const btns = config.difficulties.map((d) => {
      const label = esc(t(config, d.nameKey));
      const cur = d.id === town.difficulty ? ' class="on"' : '';
      if (unlocked.has(d.id)) return `<button data-a="difficulty" data-d="${esc(d.id)}"${cur}>${label}</button>`;
      const req = `${d.unlockHunters}×R${d.unlockReincarnation}`;
      return `<button disabled title="cần ${d.unlockHunters} hunter tái sinh ≥ ${d.unlockReincarnation}">${label} <span class="req">${req}</span></button>`;
    }).join('');
    return `
      <div class="debug-sub">Độ khó: <b class="diff-cur">${esc(difficultyName(config, town.difficulty))}</b></div>
      <div class="debug-row diff-btns">${btns}</div>
      <div class="debug-row"><button data-a="autoreinc">tự tái sinh: ${town.autoReincarnate ? 'BẬT' : 'TẮT'}</button> <button data-a="autodiff">tự tăng độ khó: ${town.autoDifficulty ? 'BẬT' : 'TẮT'}</button></div>`;
  }

  /** M3 progression lines for one hunter: skills, traits, buffs. */
  private renderProgress(h: Hunter): string {
    const config = this.sim.config;
    const skills = Object.entries(h.skills).filter(([, lv]) => lv > 0).map(([id, lv]) => {
      const cd = h.skillCdMs[id] ?? 0;
      return `${skillName(config, id)} ${lv}${cd > 0 ? ` (${Math.ceil(cd / 1000)}s)` : ''}`;
    }).join(' · ');
    const traits = Object.entries(h.traits).filter(([, lv]) => lv > 0)
      .map(([id, lv]) => `${traitName(config, id)} ${lv}`).join(' · ');
    const buffs = h.buffs.map((b) => `${sourceName(config, b.sourceId)} ${Math.ceil(b.remainingMs / 1000)}s`).join(' · ');
    return `<div class="hunter-prog">
        <div>kỹ năng: ${esc(skills || '—')}</div>
        <div>đặc tính: ${esc(traits || '—')} · điểm: ${h.traitPoints}</div>
        ${buffs ? `<div class="hunter-buffs">buff: ${esc(buffs)}</div>` : ''}</div>`;
  }

  private goalText(h: Hunter): string {
    const { world, config } = this.sim;
    const g = h.ai.goal;
    if (!g) return 'idle';
    switch (g.type) {
      case 'hunt': return `săn ${name(config, config.index.zones.get(g.zoneId)?.nameKey, g.zoneId)}`;
      case 'service': return buildingName(config, g.buildingId);
      case 'returnTown': return 'về Town';
      case 'dead': return `chết (${Math.ceil(h.deadMs / 1000)}s)`;
      case 'sell': return 'đi bán';
      case 'shop': {
        const it = world.town.shop.find((s) => s.uid === g.itemUid);
        return it ? `đi mua ${gearName(config, it.gearId)}` : 'đi mua';
      }
      case 'enhance': return `cường hóa ${slotName(config, g.slot)}`;
      case 'learn': return `học ${g.kind === 'skill' ? skillName(config, g.id) : traitName(config, g.id)}`;
      case 'buyPotion': return `mua ${name(config, config.index.consumables.get(g.consumableId)?.nameKey, g.consumableId)}`;
      case 'reincarnate': return 'đi tới Cổng Tái Sinh';
      default: return 'dạo';
    }
  }

  render(): void {
    const { world, config } = this.sim;
    this.stats.innerHTML = `
      config <b>${esc(config.version)}</b> · seed ${world.seed}<br>
      tick <b>${world.tick}</b> · time <b>${fmtTime(world.timeMs)}</b> · ${this.sim.paused ? '<b>PAUSED</b>' : `x${this.sim.speed}`}<br>
      hunters ${world.hunters.length}${(world.journeys ?? []).length ? ` (+${(world.journeys ?? []).reduce((a, j) => a + j.hunters.length, 0)} đi xa)` : ''}${(world.portal ?? []).length ? ` (+${(world.portal ?? []).length} trong cổng)` : ''}/${config.formula.hunterSlots} · next arrival ${Math.max(0, config.formula.arrivalIntervalSec - world.town.arrivalTimerMs / 1000).toFixed(0)}s<br>
      town gold <b>${world.town.gold}</b> · monsters ${world.monsters.length} · kills ${world.stats.kills} · deaths ${world.stats.deaths} · services ${world.stats.serviceUses}<br>
      bán NL ${world.stats.materialsSold} · bỏ NL ${world.stats.materialsDiscarded ?? 0} · bỏ đồ ${world.stats.gearScrapped ?? 0} · rã đồ ${world.stats.gearDismantled ?? 0} · kho đồ ${(world.town.gearStorage ?? []).length} · shop ${world.town.shop.length} · chế ${world.stats.crafted} · mua ${world.stats.gearBought} · cường hóa ${world.stats.enhanceSuccess}/${world.stats.enhanceTries}<br>
      kỹ năng ${world.stats.skillCasts} · chuyển nghề ${world.stats.jobChanges} · tái sinh ${world.stats.reincarnations} · học ${world.stats.learned}
      ${(world.portal ?? []).length ? `<br>Cổng Tái Sinh: ${esc((world.portal ?? []).map((p) => `${p.hunter.id} R${p.hunter.reincarnation} còn ${fmtTime(p.remainingMs)}`).join(', '))}` : ''}
      ${this.status ? `<br><span class="debug-status">${esc(this.status)}</span>` : ''}`;

    this.town.innerHTML = this.renderTown();

    this.hunters.innerHTML = world.hunters.map((h) => {
      const st = hunterStats(config, h);
      const bars = NEEDS.map((k) => {
        const cap = needMax(config, h, k);
        const pct = cap > 0 ? Math.max(0, Math.min(100, Math.round((h.needs[k] / cap) * 100))) : 0;
        return `<div class="bar" title="${k}"><span>${NEED_LABEL[k]}</span><i style="width:${pct}%" class="${pct < 25 ? 'low' : ''}"></i></div>`;
      }).join('');
      const persMark = { positive: '+', negative: '−', neutral: '' } as const;
      const pers = h.personalities.map((p) => {
        const d = config.index.personalities.get(p);
        return `${persMark[d?.kind ?? 'neutral']}${t(config, d?.nameKey ?? p)}`;
      }).join(', ');
      const cls = t(config, config.index.classes.get(h.classId)?.nameKey ?? h.classId);
      const job = config.index.jobsByClass.get(h.classId)?.[h.jobTier];
      const jobLabel = job ? jobName(config, job.id) : `job ${h.jobTier}`;
      const canReinc = h.level >= config.formula.maxLevel;
      const inField = !!config.index.nodes.get(h.nodeId)?.zoneId;
      const goal = this.goalText(h);
      const equip = GEAR_SLOTS.map((s) => {
        const it = h.equipment[s];
        return `${slotName(config, s)}: ${it ? gearLabel(config, it) : '—'}`;
      }).join(' · ');
      const where = h.insideBuildingId ? 'trong nhà' : h.ai.phase === 'travel' ? 'đang đi' : 'tại chỗ';
      const scores = (this.sim.debug.aiScores.get(h.id) ?? []).slice(0, 3).map((s) => `${s.label} ${s.score.toFixed(2)}`).join(' · ');
      const moves = [...config.zones.map((z) => [z.id, t(config, z.nameKey)]), ['town', 'Town']]
        .map(([id, name]) => `<button data-a="move" data-id="${esc(h.id)}" data-zone="${esc(id!)}">→${esc(name!)}</button>`).join('');
      return `<div class="hunter">
        <div class="hunter-top"><b>${esc(h.id)}</b> ${esc(cls)} <span class="reinc">R${h.reincarnation}</span> · ${esc(jobLabel)} · <span class="tier-${h.tier}">${h.tier}</span> · Lv${h.level}
          ${canReinc ? `<button data-a="reincarnate" data-id="${esc(h.id)}"${inField ? ' disabled title="phải ở Town (→Town trước)"' : ''}>Tái sinh</button>` : ''}<button data-a="team" data-id="${esc(h.id)}">${this.team.has(h.id) ? '−đội' : '+đội'}</button><button data-a="restore" data-id="${esc(h.id)}">hồi</button><button data-a="donate" data-id="${esc(h.id)}" title="Town → hunter">+${DEBUG_DONATE_GOLD}g</button><button data-a="reroll" data-id="${esc(h.id)}" title="đổi tính cách (${config.formula.personalityRerollGold}g Town)">tính cách</button><button data-a="banish" data-id="${esc(h.id)}" title="đuổi: đồ về kho Town">đuổi</button><button data-a="remove" data-id="${esc(h.id)}">×</button></div>
        <div class="hunter-sub">ATK ${Math.round(st.atk)} DEF ${Math.round(st.def)} HP ${Math.round(st.hp)} · ${h.gold}g · ${h.kills} kill · túi ${bagCount(h)}/${config.formula.bagCapacity} · ${esc(pers)}</div>
        <div class="hunter-equip">${esc(equip)}</div>
        ${this.renderProgress(h)}
        <div class="hunter-goal">${esc(goal)}${h.ai.forced ? ' (lệnh)' : ''} · ${where}</div>
        ${scores ? `<div class="hunter-scores">${esc(scores)}</div>` : ''}
        ${bars}
        <div class="hunter-moves">${moves}</div></div>`;
    }).join('');

    this.logEl.innerHTML = this.log.map((l) => `<div>${esc(l)}</div>`).join('');
  }
}

/** Readable log line for M2 economy events (null = use the generic line). */
function economyLine(config: GameConfig, e: SimEvent): string | null {
  switch (e.type) {
    case 'materialsSold': return `${e.hunterId} bán ${e.units} NL +${e.gold}g`;
    case 'materialsDiscarded': return `${e.hunterId} bỏ ${e.units} NL không được yêu cầu`;
    case 'gearScrapped': return `cửa hàng bỏ ${gearName(config, e.gearId)} [${qualityName(config, e.qualityId)}] (ế)`;
    case 'craftStarted': return `${buildingName(config, e.buildingId)} bắt đầu chế ${gearName(config, e.gearId)}`;
    case 'gearCrafted': return `${buildingName(config, e.buildingId)} chế xong ${tierPrefix(config, e.difficultyId)}${gearName(config, e.gearId)} [${qualityName(config, e.qualityId)}]`;
    case 'gearDismantled': return `rã ${tierPrefix(config, e.difficultyId)}${gearName(config, e.gearId)} [${qualityName(config, e.qualityId)}] → ${Object.entries(e.materials).map(([id, n]) => `${n} ${materialName(config, id)}`).join(', ') || 'không còn gì'}`;
    case 'gearReclaimed': return `${e.hunterId} trả ${e.itemUids.length} món đồ về kho Town${e.reason === 'reincarnation' ? ' (tái sinh)' : ''}`;
    case 'gearRelisted': return `cửa hàng bày bán lại ${gearName(config, e.gearId)} ${e.price}g`;
    case 'gearBought': return `${e.hunterId} mua ${gearName(config, e.gearId)} -${e.price}g`;
    case 'enhanceResult': {
      const slot = slotName(config, e.slot);
      return `${e.hunterId} cường hóa ${slot} ${e.success ? 'thành công' : 'thất bại'} → +${e.level} -${e.cost}g`;
    }
    default: return null;
  }
}

/** Readable log line for M3 progression events (null = use the generic line). skillCast is aggregated (SkillCastLog). */
function progressLine(config: GameConfig, e: SimEvent): string | null {
  switch (e.type) {
    case 'jobChanged': return `${e.hunterId} chuyển nghề → ${jobName(config, e.jobId)}`;
    case 'reincarnated': return `${e.hunterId} tái sinh lần ${e.count}`;
    case 'portalEntered': return `${e.hunterId} vào Cổng Tái Sinh (${Math.round(e.durationSec / 60)} phút)`;
    case 'learned': {
      const n = e.kind === 'skill' ? skillName(config, e.id) : traitName(config, e.id);
      return `${e.hunterId} học ${n} Lv${e.level} -${e.cost}${e.kind === 'skill' ? 'g' : ' điểm'}`;
    }
    case 'bountyPosted': return `${e.auto ? 'bounty tự động' : 'đặt bounty'}: ${bountyTargetName(config, e.targetKind, e.targetId)} ×${e.kills} -${e.reward}g`;
    case 'bountyCompleted': return `bounty ${e.bountyId} xong (${e.hunterId}) · vương quốc trả Town +${e.kingdomGold}g`;
    case 'bountyCancelled': return `bounty ${e.bountyId} ${e.reason === 'expired' ? 'hết hạn' : 'bị hủy'} · hoàn ${e.refund}g`;
    case 'journeyStarted': return `hành trình ${journeyName(config, e.journeyId)}: ${e.hunterIds.join(', ')} lên đường · sức ${e.teamPower.toFixed(2)} · ${Math.round(e.successChance * 100)}% · -${e.cost}g`;
    case 'journeyCompleted': return `hành trình ${journeyName(config, e.journeyId)} ${e.success ? 'thành công' : 'thất bại'}${e.offline ? ' (offline)' : ''} · +${e.rewards.gold}g · ${e.rewards.exp} EXP/người${e.rewards.items.length ? ` · ${e.rewards.items.length} đồ hiếm` : ''}`;
    case 'journeyRecalled': return `hành trình ${journeyName(config, e.journeyId)} bị gọi về (${e.hunterIds.join(', ')})`;
    case 'difficultyUnlocked': return `mở khóa độ khó ${difficultyName(config, e.difficultyId)}`;
    case 'buildingStarted': return `${e.auto ? 'tự đầu tư' : 'xây/nâng'}: ${buildingName(config, e.buildingId)} → Lv${e.toLevel} -${e.gold}g${e.materials ? `, ${e.materials} NL` : ''}${e.importGold ? ` (nhập ${e.importGold}g)` : ''}`;
    case 'buildingCompleted': return `${buildingName(config, e.buildingId)} xong → Lv${e.level}`;
    case 'buildingCancelled': return `hủy ${buildingName(config, e.buildingId)} · hoàn ${e.refund}g`;
    case 'taxRateChanged': return `thuế → ${Math.round(e.rate * 100)}%`;
    case 'difficultyChanged': return `độ khó → ${difficultyName(config, e.difficultyId)}`;
    // M5 hunter systems (TECH_SPEC §4.1).
    case 'hunterArrived': return e.fromQueue || (e.source && e.source !== 'visitor') ? `${e.hunterId} vào Town${e.fromQueue ? ' từ hàng chờ' : ''}${e.source === 'invite' ? ' (thư mời)' : e.source === 'auto' ? ' (mời tự động)' : ''}` : null;
    case 'hunterQueued': return `${e.queueUid} vào hàng chờ (vị trí ${e.position})${e.tier ? ` · ${e.tier}` : ''}`;
    case 'hunterInvited': {
      const name = t(config, config.index.invitations.get(e.invitationId)?.nameKey ?? e.invitationId);
      const paid = e.paid === 'ticket' ? 'dùng vé' : e.paid === 'gold' ? `-${e.gold}g` : 'miễn phí';
      return `${name}: ${e.tier} (${paid}) → ${e.hunterId ?? `hàng chờ ${e.queueUid}`}`;
    }
    case 'hunterDonated': return `Town tặng ${e.hunterId} ${e.gold}g`;
    case 'hunterBanished': return `đuổi ${e.hunterId} (${e.itemUids.length} món đồ về kho, mang theo ${e.gold}g)`;
    case 'personalityRerolled': return `${e.hunterId} đổi tính cách → ${e.to.map((p) => t(config, config.index.personalities.get(p)?.nameKey ?? p)).join(', ')} -${e.gold}g`;
    default: return null;
  }
}

