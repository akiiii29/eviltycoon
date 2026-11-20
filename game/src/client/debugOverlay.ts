import { t } from '../core/config/load';
import type { GameConfig, GearDef } from '../core/config/types';
import { GEAR_SLOTS } from '../core/config/types';
import type { SimEvent } from '../core/events';
import { hunterStats, needMax } from '../core/formulas';
import type { Simulation } from '../core/simulation';
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
function jobName(config: GameConfig, id: string): string {
  return name(config, config.index.jobs.get(id)?.nameKey, id);
}
/** Buff source is normally a skill id; fall back to traits, then the raw id. */
function sourceName(config: GameConfig, id: string): string {
  const k = config.index.skills.get(id)?.nameKey ?? config.index.traits.get(id)?.nameKey;
  return name(config, k, id);
}
function gearLabel(config: GameConfig, g: GearInstance): string {
  return `${gearName(config, g.gearId)} [${qualityName(config, g.qualityId)}] +${g.enhance}`;
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

  constructor(parent: HTMLElement, private sim: Simulation, private actions: OverlayActions) {
    this.root = document.createElement('div');
    this.root.className = 'debug';
    this.root.innerHTML = `
      <div class="debug-head">DEBUG · M3</div>
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
      case 'autobounty': sim.enqueue({ type: 'town.setAutoBounty', on: !sim.world.town.autoBounty }); break;
      case 'cancelbounty': sim.enqueue({ type: 'town.cancelBounty', bountyId: el.dataset.id! }); break;
      case 'reincarnate': sim.enqueue({ type: 'hunter.reincarnate', hunterId: el.dataset.id! }); break;
    }
    this.render();
  }

  setStatus(s: string): void {
    this.status = s;
  }

  pushEvents(events: SimEvent[]): void {
    const config = this.sim.config;
    for (const e of events) {
      if (e.type === 'hit' || e.type === 'monsterKilled' || e.type === 'bountyProgress') continue; // too noisy for the log
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
    const cap = config.index.buildings.get(config.index.shop)?.capacity ?? 0;
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
      ${this.renderBounties()}
      ${this.renderDifficulty()}`;
  }

  /** Bounty block (TECH_SPEC §5.9): active bounties with progress, escrow and a cancel button; auto-bounty toggle. */
  private renderBounties(): string {
    const { world, config } = this.sim;
    const town = world.town;
    const list = (town.bounties ?? []).map((b) =>
      `<div class="bounty">${b.auto ? '[tự động] ' : ''}${esc(bountyTargetName(config, b.targetKind, b.targetId))} ` +
      `${b.progress}/${b.kills} · thưởng ${b.reward}g (còn ${b.escrow}g) ` +
      `<button data-a="cancelbounty" data-id="${esc(b.id)}">hủy</button></div>`).join('') || '<div class="bounty">—</div>';
    return `
      <div class="debug-sub">Bounty ${(town.bounties ?? []).length}/${config.formula.bountyMaxActive} · xong ${world.stats.bountiesCompleted ?? 0} · trả ${world.stats.bountyGoldPaid ?? 0}g</div>
      ${list}
      <div class="debug-row"><button data-a="autobounty">bounty tự động: ${town.autoBounty ? 'BẬT' : 'TẮT'}</button></div>`;
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
      <div class="debug-row"><button data-a="autoreinc">tự tái sinh: ${town.autoReincarnate ? 'BẬT' : 'TẮT'}</button></div>`;
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
      default: return 'dạo';
    }
  }

  render(): void {
    const { world, config } = this.sim;
    this.stats.innerHTML = `
      config <b>${esc(config.version)}</b> · seed ${world.seed}<br>
      tick <b>${world.tick}</b> · time <b>${fmtTime(world.timeMs)}</b> · ${this.sim.paused ? '<b>PAUSED</b>' : `x${this.sim.speed}`}<br>
      hunters ${world.hunters.length}/${config.formula.hunterSlots} · next arrival ${Math.max(0, config.formula.arrivalIntervalSec - world.town.arrivalTimerMs / 1000).toFixed(0)}s<br>
      town gold <b>${world.town.gold}</b> · monsters ${world.monsters.length} · kills ${world.stats.kills} · deaths ${world.stats.deaths} · services ${world.stats.serviceUses}<br>
      bán NL ${world.stats.materialsSold} · bỏ NL ${world.stats.materialsDiscarded ?? 0} · bỏ đồ ${world.stats.gearScrapped ?? 0} · shop ${world.town.shop.length} · chế ${world.stats.crafted} · mua ${world.stats.gearBought} · cường hóa ${world.stats.enhanceSuccess}/${world.stats.enhanceTries}<br>
      kỹ năng ${world.stats.skillCasts} · chuyển nghề ${world.stats.jobChanges} · tái sinh ${world.stats.reincarnations} · học ${world.stats.learned}
      ${this.status ? `<br><span class="debug-status">${esc(this.status)}</span>` : ''}`;

    this.town.innerHTML = this.renderTown();

    this.hunters.innerHTML = world.hunters.map((h) => {
      const st = hunterStats(config, h);
      const bars = NEEDS.map((k) => {
        const cap = needMax(config, h, k);
        const pct = cap > 0 ? Math.max(0, Math.min(100, Math.round((h.needs[k] / cap) * 100))) : 0;
        return `<div class="bar" title="${k}"><span>${NEED_LABEL[k]}</span><i style="width:${pct}%" class="${pct < 25 ? 'low' : ''}"></i></div>`;
      }).join('');
      const pers = h.personalities.map((p) => t(config, config.index.personalities.get(p)?.nameKey ?? p)).join(', ');
      const cls = t(config, config.index.classes.get(h.classId)?.nameKey ?? h.classId);
      const job = config.index.jobsByClass.get(h.classId)?.[h.jobTier];
      const jobLabel = job ? jobName(config, job.id) : `job ${h.jobTier}`;
      const canReinc = h.level >= config.formula.maxLevel;
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
          ${canReinc ? `<button data-a="reincarnate" data-id="${esc(h.id)}">Tái sinh</button>` : ''}<button data-a="restore" data-id="${esc(h.id)}">hồi</button><button data-a="remove" data-id="${esc(h.id)}">×</button></div>
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
    case 'gearCrafted': return `${buildingName(config, e.buildingId)} chế xong ${gearName(config, e.gearId)} [${qualityName(config, e.qualityId)}]`;
    case 'gearBought': return `${e.hunterId} mua ${gearName(config, e.gearId)} -${e.price}g`;
    case 'enhanceResult': {
      const slot = slotName(config, e.slot);
      return `${e.hunterId} cường hóa ${slot} ${e.success ? 'thành công' : 'thất bại'} → +${e.level} -${e.cost}g`;
    }
    default: return null;
  }
}

/** Readable log line for M3 progression events (null = use the generic line). skillCast is logged too (compact). */
function progressLine(config: GameConfig, e: SimEvent): string | null {
  switch (e.type) {
    case 'skillCast': return `${e.hunterId} dùng ${skillName(config, e.skillId)}${e.targets > 1 ? ` ×${e.targets}` : ''}`;
    case 'jobChanged': return `${e.hunterId} chuyển nghề → ${jobName(config, e.jobId)}`;
    case 'reincarnated': return `${e.hunterId} tái sinh lần ${e.count}`;
    case 'learned': {
      const n = e.kind === 'skill' ? skillName(config, e.id) : traitName(config, e.id);
      return `${e.hunterId} học ${n} Lv${e.level} -${e.cost}${e.kind === 'skill' ? 'g' : ' điểm'}`;
    }
    case 'bountyPosted': return `${e.auto ? 'bounty tự động' : 'đặt bounty'}: ${bountyTargetName(config, e.targetKind, e.targetId)} ×${e.kills} -${e.reward}g`;
    case 'bountyCompleted': return `bounty ${e.bountyId} xong (${e.hunterId}) · vương quốc trả Town +${e.kingdomGold}g`;
    case 'bountyCancelled': return `bounty ${e.bountyId} ${e.reason === 'expired' ? 'hết hạn' : 'bị hủy'} · hoàn ${e.refund}g`;
    case 'difficultyUnlocked': return `mở khóa độ khó ${difficultyName(config, e.difficultyId)}`;
    case 'difficultyChanged': return `độ khó → ${difficultyName(config, e.difficultyId)}`;
    default: return null;
  }
}
