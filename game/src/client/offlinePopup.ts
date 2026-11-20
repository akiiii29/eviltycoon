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
  const away = r.capped
    ? `Vắng ${duration(r.awayMs)} (tính tối đa ${duration(r.creditedMs)})`
    : `Vắng ${duration(r.creditedMs)}`;
  line(box, away, 'debug-status');
  line(box, `Vàng +${r.gold} (Town +${r.townGold}) · Kill +${r.kills}`);
  const mats = Object.entries(r.materials)
    .map(([id, n]) => `${t(config, config.index.materials.get(id)?.nameKey ?? id)} ×${n}`)
    .join(', ');
  line(box, `Vật liệu vào kho: ${mats || '—'}`);
  line(box, 'Hunter', 'debug-sub');
  for (const g of r.hunters) {
    const h = world.hunters.find((x) => x.id === g.id);
    const cls = h ? t(config, config.index.classes.get(h.classId)?.nameKey ?? h.classId) : '';
    const lv = g.levelAfter > g.levelBefore ? `Lv${g.levelBefore} → Lv${g.levelAfter}` : `Lv${g.levelAfter}`;
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
