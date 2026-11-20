# Town Hunter — game client (M3)

Theo `../TECH_SPEC.md`:
- **M0:** core loop, config loader, save/load, debug overlay.
- **M1:** map waypoint và road, A*, 2 zone, 3 loại quái, 4 dịch vụ, AI hunter (utility: săn / về Town / dịch vụ / nghỉ), auto-combat, level-up, chết và hồi sinh, lệnh Move cho người chơi.
- **M2:** nguyên liệu rơi vào túi, Trạm Thu Mua, kho Town, Lò Rèn / Kim Hoàn craft (tự động hoặc theo lệnh) có quality, Cửa Hàng, hunter tự mua đồ tốt hơn, Lò Cường Hóa (+1..+15, từ +5 hỏng thì tụt cấp).
- **M3:** 3 bậc nghề mỗi class (tự chuyển theo level), skill chủ động (strike / aoe / buff) học ở Học Viện bằng vàng, trait học bằng điểm, level cap, tái sinh (tối đa 5), 8 độ khó mở theo GDD §8, quái mạnh và thưởng nhiều hơn theo độ khó.

```
npm install
npm run dev                              # http://localhost:5173
npm test                                 # unit + integration test
npm run config:check                     # kiểm tra config/*.json
npm run build                            # typecheck + build production
npx vite-node tools/headless.ts 60 1 10  # chạy 60 phút game không render (seed 1), timeline mỗi 10 phút + thống kê để tuning
```

Mọi công thức nằm ở `src/core/formulas.ts`, hệ số và ngưỡng AI ở `config/formula_params.json`. Mô hình combat (DEF, chênh level, crit, né, cộng dồn, sức mạnh/độ hợp vùng): `TECH_SPEC.md` §5.3, §7.1. Số liệu vẫn là đề xuất chờ design chốt.

`PACING_FP="key=value,..." npx vite-node tools/pacing.ts 900 1` chạy pacing với hệ số ghi đè (không sửa file).

## Cấu trúc

| Đường dẫn | Nội dung |
|---|---|
| `config/*.json` | Data gameplay. Tên file = tên bảng. Schema ở `src/core/config/load.ts` (`TABLE_SPECS`). |
| `src/core/` | Simulation thuần TS, không phụ thuộc DOM/Three. Deterministic theo seed. |
| `src/core/simulation.ts` | Fixed-step 10 tick/s, thứ tự system, hàng đợi command, tốc độ x1/x2/x4. |
| `src/core/systems/` | `arrivals`, `ai`, `movement`, `combat`, `services`, `needs`, `spawn` (chạy theo thứ tự này mỗi tick). |
| `src/core/ai/utility.ts` | Chấm điểm goal (TECH_SPEC §5), hàm thuần, có test. |
| `src/core/pathfinding.ts` | Waypoint graph + A*, road nhanh hơn, cache path. |
| `src/core/commands.ts` | Command của người chơi/debug; command sai sinh event `commandRejected`. |
| `src/core/save/` | Serialize, migration theo `schemaVersion`, storage IndexedDB/memory. |
| `src/client/` | Render Three.js (pipeline pixel: render target thấp + nearest), debug overlay, autosave 30 s. |
| `tests/` | Vitest. |

## Thêm bảng config mới

1. Tạo `config/<table>.json`.
2. Thêm spec vào `TABLE_SPECS` và type vào `src/core/config/types.ts`.
3. `npm run config:check`.

## Đổi shape của World

Tăng `WORLD_SCHEMA_VERSION` trong `src/core/world.ts` và thêm migration vào `src/core/save/migrations.ts`, kèm test.

Console trình duyệt có `window.sim` để debug.
