import { t } from '../core/config/load';
import type { GameConfig } from '../core/config/types';
import type { OfflineReport } from '../core/offline';
import type { World } from '../core/world';

function duration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  const h = Math.floor(min / 60);
  return h > 0 ? `${h} giờ ${min % 60} phút` : `${min} phút`;
}

function line(parent: HTMLElement, text: string, cls?: string): HTMLElement {
  const el = document.createElement('div');
  if (cls) el.className = cls;
  el.textContent = text;
  parent.appendChild(el);
  return el;
}

/** Summary of offline progress (TECH_SPEC §9). Plain DOM, styled like the debug overlay; closes on click. */
export function showOfflinePopup(root: HTMLElement, config: GameConfig, world: World, r: OfflineReport): void {
  root.querySelector('.offline-popup')?.remove();
  const box = document.createElement('div');
  box.className = 'offline-popup';
  line(box, 'Trong lúc bạn vắng mặt', 'debug-head');
  const away = r.skipped
    ? `Vắng ${duration(r.awayMs)}`
    : r.capped
      ? `Vắng ${duration(r.awayMs)} (tính tối đa ${duration(r.creditedMs)})`
      : `Vắng ${duration(r.creditedMs)}`;
  line(box, away, 'debug-status');
  const matName = (id: string) => t(config, config.index.materials.get(id)?.nameKey ?? id);
  if (!r.skipped) {
    line(box, `Vàng +${r.gold} (Town +${r.townGold}) · Kill +${r.kills}`);
    const mats = Object.entries(r.materials).map(([id, n]) => `${matName(id)} ×${n}`).join(', ');
    line(box, `Vật liệu vào kho: ${mats || '—'}`);
  }
  // Journeys that ended while away (TECH_SPEC §5.11).
  if (r.journeys.length > 0) {
    line(box, 'Hành trình', 'debug-sub');
    for (const j of r.journeys) {
      const dest = t(config, config.index.journeys.get(j.journeyId)?.nameKey ?? j.journeyId);
      const w = j.rewards;
      const parts = [`EXP +${w.exp}/người`];
      if (w.gold > 0) parts.push(`vàng Town +${w.gold}`);
      const mats = Object.entries(w.materials).map(([id, n]) => `${matName(id)} ×${n}`).join(', ');
      if (mats) parts.push(`vào kho ${mats}`);
      const sold = Object.entries(w.exported ?? {}).map(([id, n]) => `${matName(id)} ×${n}`).join(', ');
      if (sold) parts.push(`bán xuất khẩu ${sold}`);
      for (const it of w.items) parts.push(`${t(config, config.index.gear.get(it.gearId)?.nameKey ?? it.gearId)} [${t(config, config.index.qualities.get(it.qualityId)?.nameKey ?? it.qualityId)}]`);
      line(box, `${dest} (${j.hunterIds.join(', ')}): ${j.success ? 'THÀNH CÔNG' : 'THẤT BẠI'} · ${parts.join(' · ')}`, 'offline-hunter');
    }
  }
  // Constructions/upgrades finished on wall-clock time (TECH_SPEC §5.12, §9).
  if (r.buildings.length > 0) {
    line(box, 'Công trình hoàn thành', 'debug-sub');
    for (const b of r.buildings) {
      const name = t(config, config.index.buildings.get(b.buildingId)?.nameKey ?? b.buildingId);
      line(box, `${name} → Lv${b.level}`, 'offline-hunter');
    }
  }
  if (r.arrivals.length > 0) line(box, `Hunter mới đến: ${r.arrivals.join(', ')}`);
  if (r.hunters.length > 0) line(box, 'Hunter', 'debug-sub');
  for (const g of r.hunters) {
    const h = world.hunters.find((x) => x.id === g.id);
    const cls = h ? t(config, config.index.classes.get(h.classId)?.nameKey ?? h.classId) : '';
    const reinc = g.reincarnations ?? 0;
    const lv = reinc > 0
      ? `Lv${g.levelBefore} → tái sinh ×${reinc} → Lv${g.levelAfter}`
      : g.levelAfter > g.levelBefore ? `Lv${g.levelBefore} → Lv${g.levelAfter}` : `Lv${g.levelAfter}`;
    line(box, `${g.id} ${cls} · ${lv} · vàng +${g.gold} · kill +${g.kills}`, 'offline-hunter');
  }
  const row = document.createElement('div');
  row.className = 'debug-row';
  const ok = document.createElement('button');
  ok.textContent = 'OK';
  row.appendChild(ok);
  box.appendChild(row);
  const close = () => box.remove();
  ok.addEventListener('click', close);
  root.appendChild(box);
}
