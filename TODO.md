# TODO — Town Hunter

Tình trạng hiện tại: đã xong M0–M3 và một lượt cân bằng (xem `game/README.md`, `TECH_SPEC.md`).
Số liệu đều là **đề xuất** chờ design chốt (công thức combat: TECH_SPEC §7.1).

Ký hiệu: 🔴 lỗi/cần sửa sớm · 🟡 cân bằng/cải thiện · ⚪ chưa làm (tính năng)

---

## 1. Kinh tế

- 🔴 **Kinh tế cuối game sụp:** sau ~6–8 giờ game, vàng Town còn 48–1.800, cửa hàng gần trống, trong khi mỗi hunter giữ ~3.000–6.000 vàng không có chỗ tiêu.
  - Nguyên nhân: Trạm Thu Mua mua **mọi** nguyên liệu, trả hết vàng Town cho hunter; craft món cấp cao cần vàng dự trữ lớn (`autoCraftReserve` = 3 × giá nguyên liệu đắt nhất của tier).
  - Hướng sửa đề xuất (giống GDD §5 "Trading Post: yêu cầu vật liệu"): Trạm Thu Mua chỉ mua theo **yêu cầu** (tự sinh từ auto-craft hoặc người chơi đặt), AI ưu tiên vùng rơi nguyên liệu đang được yêu cầu. Phương án phụ: thuế khi bán, giá giảm khi kho dư, dịch vụ đắt dần theo level.
- 🟡 **Không có chỗ tiêu vàng phía hunter** (vàng hunter phình to cuối game).
- 🟡 **Kho Town dư nguyên liệu** (hàng trăm gel/quặng/lõi đá không dùng).
- 🟡 **~25% đồ craft bị bỏ** (crafted ~160 so với bought ~120 sau 4 giờ) → phí vàng craft. Xem lại tỷ lệ chất lượng hoặc `shopScrapSec`.
- 🟡 **Sàn giảm giá không bao giờ chạm:** với `shopStaleSec` 600, `shopMarkdownPct` 10, `shopScrapSec` 1800 thì giá chỉ xuống 80% trước khi bị bỏ; `shopMarkdownFloor` 0,5 vô dụng.
- 🟡 **Quy tắc "đã có hàng" khi auto-craft** tính 1 món/slot cho mọi hunter → mỗi slot chỉ cung cấp từng món một. Đổi sang tính theo số bản nếu thấy craft bị nghẽn.
- 🟡 Thiếu event/stat `gearScrapped`; `tools/headless.ts` chưa in số món trong shop.

## 2. AI hunter

- ✅ ~~Hunter tái sinh mạnh vượt mọi vùng ở độ khó Dễ chọn vùng dễ nhất~~: `formulas.zoneScores` có tie-break — trong các vùng "thoải mái" (ratio ≥ `zoneFitBest`) vùng khó nhất giữ điểm, mỗi bậc dễ hơn bị trừ `zoneTierBonus` (0,06 > `decisionNoise`); có test. Còn lại: gợi ý/tự chuyển độ khó khi hunter vượt mọi vùng.
- 🟡 AI chấm vùng có thêm hệ số đông người (`zoneShare`: vùng hồi 1 quái mỗi `respawnSec`, chia cho số hunter đang săn), được chuẩn hóa để vùng tốt nhất giữ điểm. Chưa tính quãng đường về Town (transit) và hunter đi chung đường.
- 🟡 Hunter **Liều lĩnh** có thể gần như không cường hóa (điểm săn ×1,15 cao hơn dải điểm cường hóa ~1,04–1,10) — chưa kiểm chứng.
- 🟡 Các hằng số cường hóa (`ENHANCE_RISK_EXP`, `ENHANCE_MIN_SUCCESS`, `UPGRADE_SAVINGS_FRAC`, `ENHANCE_BASE_SCORE`, `ENHANCE_GAIN_WEIGHT`) đang viết cứng trong `src/core/ai/utility.ts` → chuyển vào `formula_params.json`.
- 🟡 Trùng tên `enhanceCost` ở `ai/utility.ts` và `systems/economy.ts` (khác chữ ký) → đổi tên một bên.
- 🟡 Test tích hợp Học Viện (`tests/academy.test.ts`) đã nới thành "≥ một nửa hunter đi học".
- 🟡 Lệnh tái sinh thủ công cho phép khi hunter đang ở ngoài field (AI đã được reset để tự về); cân nhắc yêu cầu ở Town.

## 3. Nhịp tiến trình & combat

- ✅ ~~**Mọi công thức là placeholder**~~: đã có mô hình combat (TECH_SPEC §5.3, §7.1): DEF hyperbol theo level người đánh có trần, phạt chênh level, crit/né có trần, cộng dồn % theo nhóm có trần, tỷ lệ sức mạnh = √(kill mỗi thanh HP / `zoneRefKills`) tính từ chính công thức combat (bỏ `recommendedPower`). Test `tests/formulas.test.ts` (đơn vị + so dự đoán với combat mô phỏng). Số liệu vẫn là **[ĐỀ XUẤT]** chờ design duyệt.
- ✅ ~~**Lv50 đến sớm**~~ (3,2–3,9 giờ trước đây): giờ 4,05–4,78 giờ (6 seed, Dễ). Lv20 53–81 phút (trước 66–80), tái sinh đầu 11,7–13,3 giờ (trước 8,6–10,4). Đòn bẩy chính là EXP quái từ Vách Tro trở đi giảm còn 0,36× (EXP/HP ≈ 0,09–0,11 như Đồng Cỏ/Phế Tích; Đầm Sương giữ nguyên làm vùng tăng tốc) — combat đúng hơn làm hunter săn hiệu quả hơn nên Lv20→50 nhanh gấp ~2 lần nếu giữ EXP cũ.
- 🟡 Lv20 dao động theo seed (53–81 phút); seed 2 đạt Lv20 lúc 53 phút (hơi sớm).
- 🟡 Hunter tụt hậu: lúc 2 giờ có 5–7/8 hunter đạt Lv20 (seed 1–6; trước 4–8/8 ở seed 1–5).
- 🟡 Chết: tổng 15 giờ giảm khoảng một nửa (14–111, trước 43–225, seed 1–5). Giai đoạn Đầm Sương→Sông Băng giảm rõ: chết mỗi cửa sổ 30 phút (1h30–5h00) tối đa 0–7 (trước 3–25); tổng chết ở Đầm Sương+Vách Tro+Sông Băng 4–48 (trước 25–123); chết trong 30 phút đầu vào 3 vùng này 12 (trước 21, cộng 5 seed). **Nhưng cuối game tệ hơn:** chết trong 30 phút đầu vào Thành Cổ Chìm/Vực Thẳm 47 (trước 21) và tổng chết ở Vực Thẳm 107 (trước 66); ở Vực Thẳm đo được chỉ ~5 kill/thanh HP so với mục tiêu `zoneRefKills` = 8 (dự đoán lạc quan ~1,4×). Chết gần như luôn **trên đường về Town** khi HP đã dưới ngưỡng khẩn cấp (Liều lĩnh 12,5%). Gợi ý: `zoneCrowd` riêng cho vùng cuối / aggroRange, ngưỡng HP khẩn cấp theo sát thương dự kiến trên đường về, hoặc potion.
- 🟡 Dự đoán HP mất mỗi kill lệch theo vùng (đo/dự đoán: Phế Tích ~1,0, Đầm Sương/Vách Tro/Vực Thẳm ~1,4–1,5, Thành Cổ Chìm ~0,8): `zoneCrowd` mới chỉ dựa vào `respawnSec`; chưa tính aggroRange, quái chen vào và AoE.
- 🟡 **Hồi quy phía kinh tế sau đổi combat** (chưa sửa, thuộc kinh tế/AI): tỷ lệ cường hóa thành công qua 15 giờ 0,57–0,61 (trước 0,60–0,66, mục tiêu ~0,65). Giờ đầu (`tools/headless.ts 60`, seed 1–3): craft 18–36 (trước 41–54), mua đồ 13–30 (trước 29–40), thử cường hóa 129–229 (trước 62–93), kill 654–784 (trước 714–920). Giả thuyết (chưa kiểm chứng): hunter rời Đồng Cỏ sớm (Lv4–5) nên ít gel/hide cho đồ cấp 1, vàng dồn vào cường hóa đồ cũ.
- ⚪ **Mood ảnh hưởng chỉ số** (GDD §4.2): đã có `moodStatMult` (ATK/DEF giảm tuyến tính dưới `moodPenaltyFrac`, sàn `moodStatFloor`) nhưng **đang tắt** (`moodStatFloor = 1`): bật ở 0,85 làm số lần chết tăng ~1,5× vì AI chấm vùng bằng chỉ số "steady" (không mood). Cần AI về Tavern sớm hơn khi mood thấp trước khi bật.
- 🟡 Hiệu năng: thêm ~60 quái làm test M2 chạy ~12 giây; 12 giờ game ~60 giây headless. Chưa có spatial hash (TECH_SPEC §10).

## 4. Tính năng chưa làm (theo TECH_SPEC §12 và GDD)

### M4
- ⚪ Bounty (GDD §9): Town đặt bounty, hunter nhận thưởng theo kill, Town nhận vàng khi xong; Torment tăng tỉ lệ rơi.
- ⚪ Trading Post theo yêu cầu vật liệu (xem mục 1).
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
