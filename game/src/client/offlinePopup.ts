import { t } from '../core/config/load';
import type { GameConfig } from '../core/config/types';
import type { OfflineReport } from '../core/offline';

function duration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  const h = Math.floor(min / 60);
  if (h > 0) return `${h} giờ ${min % 60} phút`;
  return min > 0 ? `${min} phút` : `${Math.floor(ms / 1000)} giây`;
}

function line(parent: HTMLElement, text: string, cls?: string): HTMLElement {
  const el = document.createElement('div');
  if (cls) el.className = cls;
  el.textContent = text;
  parent.appendChild(el);
  return el;
}

/**
 * Summary of what ran on wall-clock time while away (TECH_SPEC §9: no hunting offline, like EHT): time away, hunters that
 * arrived, journeys completed, reincarnations finished in the portal, buildings finished. Plain DOM; closes on OK.
 */
export function showOfflinePopup(root: HTMLElement, config: GameConfig, r: OfflineReport): void {
  root.querySelector('.offline-popup')?.remove();
  const box = document.createElement('div');
  box.className = 'offline-popup';
  line(box, 'Trong lúc bạn vắng mặt', 'debug-head');
  line(box, `Vắng ${duration(r.awayMs)} · hunter không săn khi game đóng`, 'debug-status');
  const matName = (id: string) => t(config, config.index.materials.get(id)?.nameKey ?? id);
  if (r.arrivals.length > 0) line(box, `Hunter mới đến: ${r.arrivals.join(', ')}`);
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
  // Reincarnation Portal (TECH_SPEC §5.13).
  if (r.reincarnations.length > 0) {
    line(box, 'Cổng Tái Sinh', 'debug-sub');
    for (const p of r.reincarnations) {
      line(box, p.reincarnated ? `${p.hunterId} tái sinh lần ${p.reincarnation} → Lv1` : `${p.hunterId} ra khỏi cổng (không tái sinh được)`, 'offline-hunter');
    }
  }
  // Constructions/upgrades finished on wall-clock time (TECH_SPEC §5.12).
  if (r.buildings.length > 0) {
    line(box, 'Công trình hoàn thành', 'debug-sub');
    for (const b of r.buildings) {
      const name = t(config, config.index.buildings.get(b.buildingId)?.nameKey ?? b.buildingId);
      line(box, `${name} → Lv${b.level}`, 'offline-hunter');
    }
  }
  const row = document.createElement('div');
  row.className = 'debug-row';
  const ok = document.createElement('button');
  ok.textContent = 'OK';
  row.appendChild(ok);
  box.appendChild(row);
  ok.addEventListener('click', () => box.remove());
  root.appendChild(box);
}
