# TODO — Town Hunter

Tình trạng hiện tại: đã xong M0–M3 và một lượt cân bằng (xem `game/README.md`, `TECH_SPEC.md`).
Mọi công thức và số liệu đều là **placeholder** chờ design chốt.

Ký hiệu: 🔴 lỗi/cần sửa sớm · 🟡 cân bằng/cải thiện · ⚪ chưa làm (tính năng) · ✅ đã xong

---

## 1. Kinh tế

- ✅ **Kinh tế cuối game sụp — đã sửa** (Trạm Thu Mua theo yêu cầu vật liệu, `src/core/systems/trading.ts`, TECH_SPEC §5.7, world v6).
  - Trước: sau ~6–8 giờ game vàng Town còn 22–1.831, shop 0–2 món, kho 2.000–2.400 NL, mỗi hunter giữ ~3.800–6.800 vàng (tb).
  - Sửa: Trạm Thu Mua chỉ mua NL **được yêu cầu** (tự sinh từ nhu cầu auto-craft + lệnh `town.requestMaterial` của người chơi); phần vượt yêu cầu không vào kho, Town chỉ mua "để xuất đi" với giá 60% khi vàng Town trên sàn (`tradeSurplusFloorMul × autoCraftReserve`), còn lại hunter bỏ. AI ưu tiên vùng rơi NL đang được yêu cầu (chỉ đổi lựa chọn vùng, không tăng điểm săn). Đòn bẩy phụ: giá dịch vụ tăng 1%/level (`servicePriceLevelPct`), chỉ tính hunter đủ tiền ≥ 20% giá món là người hưởng lợi khi chọn công thức (`craftAffordFrac`), thuế bán `tradeSaleTax` (đang 0).
  - Sau (headless 8 giờ, seed 1–5): vàng Town 10.000–22.800, shop 11–12 món, kho 112–175 NL, vàng hunter tb 2.300–3.500; Lv tb lúc 2 giờ 17–24 (trước 20–25), lúc 8 giờ 75–82 (trước 73–84).
  - Còn lại: sau ~9–12 giờ (sau tái sinh) vàng Town có thể giảm về vài nghìn (vẫn > 0, shop còn hàng) vì hunter tái sinh trả dịch vụ rẻ lại trong khi auto-craft và mua NL đắt vẫn chạy; cần theo dõi khi làm offline/Bounty. Chưa có UI để người chơi đặt yêu cầu (chỉ có command).
- 🟡 **Không có chỗ tiêu vàng phía hunter** — đỡ hơn (vàng hunter tb lúc 8 giờ 2.300–3.500, trước 3.800–6.800, và vẫn tăng dần sau đó); cần thêm chỗ tiêu thật (potion, Bank, upgrade tier…).
- ✅ **Kho Town dư nguyên liệu** — kho chỉ nhận phần được yêu cầu (≈100–200 NL thay vì 2.000+). Save cũ vẫn giữ kho đã chất đống (migration không xóa).
- 🟡 **~40% đồ craft bị bỏ** (8 giờ: crafted 207–240, bought 116–133, `gearScrapped` 80–102) → phí vàng craft. `craftAffordFrac` 0,5 làm shop trống vì hunter không bao giờ đủ tiền; 0,2 đang dùng. Xem lại tỷ lệ chất lượng, `shopScrapSec`, hoặc tính "người hưởng lợi" theo khả năng mua.
- 🟡 **Sàn giảm giá không bao giờ chạm:** với `shopStaleSec` 600, `shopMarkdownPct` 10, `shopScrapSec` 1800 thì giá chỉ xuống 80% trước khi bị bỏ; `shopMarkdownFloor` 0,5 vô dụng.
- 🟡 **Quy tắc "đã có hàng" khi auto-craft** tính 1 món/slot cho mọi hunter → mỗi slot chỉ cung cấp từng món một. Đổi sang tính theo số bản nếu thấy craft bị nghẽn. (Yêu cầu NL tự động đã bỏ qua quy tắc này để mua sẵn NL cho bản tiếp theo.)
- ✅ Event/stat `gearScrapped` (và `materialsDiscarded`); `tools/headless.ts` in timeline gồm số món trong shop, kho, yêu cầu, vàng hunter và sổ thu/chi vàng Town.

## 2. AI hunter

- 🟡 **Hunter tái sinh mạnh vượt mọi vùng ở độ khó Dễ:** khi tỷ lệ sức mạnh > ~3,3× vùng khó nhất thì mọi vùng có điểm bằng nhau, AI có thể chọn vùng dễ nhất (đã thấy chọn Đồng Cỏ ở tỷ lệ 1141). Cần: tie-break ưu tiên vùng cao hơn, và/hoặc gợi ý/tự chuyển độ khó.
- 🟡 Hunter **Liều lĩnh** có thể gần như không cường hóa (điểm săn ×1,15 cao hơn dải điểm cường hóa ~1,04–1,10) — chưa kiểm chứng.
- 🟡 Các hằng số cường hóa (`ENHANCE_RISK_EXP`, `ENHANCE_MIN_SUCCESS`, `UPGRADE_SAVINGS_FRAC`, `ENHANCE_BASE_SCORE`, `ENHANCE_GAIN_WEIGHT`) đang viết cứng trong `src/core/ai/utility.ts` → chuyển vào `formula_params.json`.
- 🟡 Trùng tên `enhanceCost` ở `ai/utility.ts` và `systems/economy.ts` (khác chữ ký) → đổi tên một bên.
- 🟡 Test tích hợp Học Viện (`tests/academy.test.ts`) đã nới thành "≥ một nửa hunter đi học".
- 🟡 Lệnh tái sinh thủ công cho phép khi hunter đang ở ngoài field (AI đã được reset để tự về); cân nhắc yêu cầu ở Town.

## 3. Nhịp tiến trình & combat

- 🟡 **Lv50 đến sớm:** 3,2–3,5 giờ (mục tiêu 4–6 giờ). Tái sinh lần đầu 8,6–9 giờ (đạt 8–14 giờ). Lv20 đạt 66–80 phút.
- 🟡 Hunter tụt hậu: lúc 2 giờ chỉ 6/8 hunter đạt Lv20 ở một số seed.
- 🟡 Chết nhiều ở cửa vùng mới khi có đồ tốt (~3–12 lần/30 phút ở Đầm Sương/Vách Tro/Sông Băng).
- 🟡 Tỷ lệ cường hóa thành công trung bình 0,646 (đạt), nhưng mức cường hóa phụ thuộc seed (+1,2 đến +3,0).
- 🔴 **Mọi công thức là placeholder** (`src/core/formulas.ts`): sát thương, giảm sát thương theo DEF, crit, né, buff cộng dồn, sức mạnh hunter, độ hợp vùng.
- ⚪ **Mood ảnh hưởng chỉ số** (GDD §4.2: "các stat khác scale theo Mood") — chưa làm.
- 🟡 Hiệu năng: thêm ~60 quái làm test M2 chạy ~12 giây; 12 giờ game ~60 giây headless. Chưa có spatial hash (TECH_SPEC §10).

## 4. Tính năng chưa làm (theo TECH_SPEC §12 và GDD)

### M4
- ⚪ Bounty (GDD §9): Town đặt bounty, hunter nhận thưởng theo kill, Town nhận vàng khi xong; Torment tăng tỉ lệ rơi.
- ✅ Trading Post theo yêu cầu vật liệu (xem mục 1; còn thiếu UI đặt yêu cầu).
- ⚪ Journey (GDD §9): 3 NPC, chạy offline, team power, tỉ lệ thành công.
- ⚪ Tiến trình offline (TECH_SPEC §9): ước lượng theo tốc độ trung bình, trần 8 giờ, popup tổng kết.
- ⚪ Kiểm thử theo checklist GDD §13.

### M5
- ⚪ UI hoàn chỉnh thay cho debug overlay: Town view, danh sách/chi tiết hunter, menu lệnh (Items / Move / Learn / Activities / Manage), màn building, kho, tiến trình (GDD §10).
- ⚪ Chuyển ngôn ngữ vi/en trong UI; tutorial.
- ⚪ Headless xuất CSV để tuning (TECH_SPEC §11).

### M6
- ⚪ Online: tài khoản, cloud save, IAP; Raid, PvP, Guild, World Boss, Tower Defense, chat, ranking.

### Hệ thống trong GDD chưa có
- ⚪ Town Hall và **nâng cấp/đặt building**, slot building, cấp shop giới hạn tier đồ (GDD §5).
- ⚪ Invitation (vé gọi hunter theo tier, GDD §4.1), Donate / Banish.
- ⚪ Upgrade đồ lên tier (Dark Stone), option/set/skill trang bị, rune, relic, thú cưỡi, potion/Alchemist.
- ⚪ Training Ground, Bank, Courage Headstone, Fountain of Life, Library of Wisdom.
- ⚪ Học skill/trait bằng lệnh của người chơi (hiện chỉ AI tự học).

## 5. Đồ họa / client

- ⚪ Sprite nhân vật từ PX2D, scene pixel-art Three.js cho Town và các vùng (GDD §11); hiện là ô màu placeholder.
- ⚪ Camera pan/zoom, chọn hunter bằng click.
- 🟡 Renderer tô màu vùng: chỉ Đồng Cỏ có màu riêng, các vùng còn lại dùng chung màu.
- 🟡 Log `skillCast` trong overlay có thể quá nhiều.

## 6. Save / migration

- 🟡 Migration v1→v2 viết cứng node `t.square`; migration v3→v4 ước lượng `rollStats` bằng mức tăng level mặc định của M1.
- 🟡 Cùng một tick có thể vừa `jobChanged` vừa `reincarnated` (vô hại, UI có thể hiện 2 thông báo).

## 7. Dữ liệu & tài liệu

- 🔴 **Pháp lý/IP:** phụ lục GDD và `data_tables/` chứa dữ liệu trích từ bản build của một game thương mại. Không phát hành game với tên, text, số liệu sao chép; dùng làm tham chiếu khoảng giá trị. Tên/nội dung trong `game/config/` là bản tự đặt.
- 🟡 Dữ liệu trích: ~30% cột chưa rõ nghĩa (TBD), 8 bảng khớp byte nhưng chưa xác nhận đúng class, thiếu `sharedassets0.assets` (localUI, slang, help).
- 🟡 Cập nhật `TECH_SPEC.md` theo các quyết định đã chốt khi code (backstop khẩn cấp chạy lại sau combat, thứ tự system, world v5, công thức cường hóa theo kỳ vọng…).
- ⚪ CI chạy `npm test`, `npm run config:check`, `npm run build`.
