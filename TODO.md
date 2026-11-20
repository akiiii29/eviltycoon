# TODO — Town Hunter

Tình trạng hiện tại: đã xong M0–M3 và một lượt cân bằng (xem `game/README.md`, `TECH_SPEC.md`).
Số liệu đều là **đề xuất** chờ design chốt (công thức combat: TECH_SPEC §7.1).

Ký hiệu: 🔴 lỗi/cần sửa sớm · 🟡 cân bằng/cải thiện · ⚪ chưa làm (tính năng) · ✅ đã xong

---

## 1. Kinh tế

- ✅ **Kinh tế cuối game sụp — đã sửa cho 8 giờ đầu** (Trạm Thu Mua theo yêu cầu vật liệu, `src/core/systems/trading.ts`, TECH_SPEC §5.7, world v6).
  - Trước: sau ~6–8 giờ game vàng Town còn 22–1.831, shop 0–2 món, kho 2.000–2.400 NL, mỗi hunter giữ ~3.800–6.800 vàng (tb).
  - Sửa: Trạm Thu Mua chỉ mua NL **được yêu cầu** (tự sinh từ nhu cầu auto-craft + lệnh `town.requestMaterial` của người chơi); phần vượt yêu cầu không vào kho, Town chỉ mua "để xuất đi" với giá 60% khi vàng Town trên sàn (`tradeSurplusFloorMul × autoCraftReserve`), còn lại hunter bỏ. AI ưu tiên vùng rơi NL đang được yêu cầu (chỉ đổi lựa chọn vùng, không tăng điểm săn). Đòn bẩy phụ: giá dịch vụ tăng 1%/level (`servicePriceLevelPct`), chỉ tính hunter đủ tiền ≥ 20% giá món là người hưởng lợi khi chọn công thức (`craftAffordFrac`), thuế bán `tradeSaleTax` (đang 0).
  - Sau (headless 8 giờ, seed 1–5): vàng Town 10.000–22.800, shop 11–12 món, kho 112–175 NL, vàng hunter tb 2.300–3.500; Lv tb lúc 2 giờ 17–24 (trước 20–25), lúc 8 giờ 75–82 (trước 73–84).
  - Nhịp đầu game chậm hơn một chút: Lv tb lúc 2 giờ thấp hơn 1–3,5 level ở mọi seed; Lv50 (tb) ~4–5 giờ.
  - 🟡 Còn lại: từ 8 → 12 giờ (sau tái sinh) vàng Town vẫn **giảm dần**: lúc 12 giờ 1.343–12.750 (seed 1–5), shop 7–11 món, nhưng có seed rơi dưới sàn surplus (~9.000). Nguyên nhân (sổ thu/chi headless): hunter tái sinh mua ít đồ (thu shop giảm mạnh), trong khi mua NL được yêu cầu giá đầy đủ + vàng craft (nhiều món sau đó bị bỏ) vẫn cao. Sàn surplus đã chặn phần mua "để xuất"; cần chỉnh phía craft/yêu cầu (vd. yêu cầu theo khả năng mua, giảm craft món bị bỏ). Chưa có UI để người chơi đặt yêu cầu (chỉ có command).
- 🟡 **Không có chỗ tiêu vàng phía hunter** — đỡ hơn (vàng hunter tb lúc 8 giờ 2.300–3.500, trước 3.800–6.800, và vẫn tăng dần sau đó); cần thêm chỗ tiêu thật (potion, Bank, upgrade tier…).
- ✅ **Kho Town dư nguyên liệu** — kho chỉ nhận phần được yêu cầu (≈100–200 NL thay vì 2.000+). Save cũ vẫn giữ kho đã chất đống (migration không xóa).
- ✅ **Nhiều đồ craft bị bỏ — đã sửa** (`src/core/systems/crafting.ts`, TECH_SPEC §5.8).
  - Nguyên nhân (headless 12 giờ seed 1, phân tích từng món bị bỏ): ~72% món bị bỏ là "có hunter muốn nhưng không đủ tiền" (giá niêm yết 1,5–3,3× ngân sách hunter tốt nhất, trung vị 2,2×) — `craftAffordFrac` 0,2 × basePrice quá lỏng và giá chỉ giảm tới 80% trước khi bỏ; ~28% là bản Common/Uncommon của tier cuối không đủ +12% so với đồ đang mặc (auto-craft chỉ xét chất lượng Rare, trong khi 65% lần roll ra 0,8/0,9).
  - Sửa: (1) lịch giảm giá chạm sàn rồi mới bỏ (xem dưới); (2) auto-craft chấm **từng chất lượng**: hunter chỉ được tính khi tổng `craftChance` của các bản vừa là nâng cấp vừa mua được (ngân sách ≥ `craftAffordFrac` 0,35 × giá niêm yết của chất lượng đó) ≥ `craftMinSellChance` 0,65 (tức Uncommon trở lên phải bán được; 0,35 ≈ quy tắc Rare cũ, đúng hẳn khi `craftAffordFrac` = 0; ngưỡng nằm đúng trên tỷ lệ cộng dồn của `gear_quality.json`, đổi `craftChance` thì phải xem lại); (3) đồ đang bán/đang chế tính theo **số bản**.
  - Headless 12 giờ seed 1–5, trước → sau: crafted 277–308 → 162–188; bought 110–142 → 137–160; scrapped 131–181 (47–60%) → 18–25 (**11–14%**); shop lúc 12 giờ 7–12 → 4–8 món (lúc 2 giờ 6–12 → 8–11); Lv tb lúc 12 giờ 77–89 → 78–89; vàng hunter tb lúc 12 giờ 5.240–9.436 → 5.878–10.556; vàng Town lúc 12 giờ 45.808–76.838 → 132.751–155.255.
  - 🟡 Còn lại: vàng Town tăng gấp ~2–3 lần (ít vàng craft và NL bị phí hơn) → càng cần chỗ tiêu vàng Town. Shop cuối game chỉ còn 4–8 món. Gear tier cuối (vd. star 12.500) vẫn đắt hơn vàng hunter tb (~7.000) — phía `gear.json`/AI. AI chỉ giữ `UPGRADE_SAVINGS_FRAC` 0,3 × basePrice trước khi cường hóa nên ít khi để dành đủ mua món tier mới (đề xuất cho người sửa `ai/utility.ts`: giữ ≈ giá sàn của món nâng cấp, tức `shopMarkdownFloor × basePrice × TYPICAL_QUALITY_MULT`).
- ✅ **Sàn giảm giá không bao giờ chạm — đã sửa:** bỏ `shopScrapSec`; tuổi bỏ món = số bước giảm tới sàn × `shopStaleSec` + `shopFloorHoldSec` (`shopScrapAgeSec`), nên giá luôn xuống tới `shopMarkdownFloor` và được chào ở giá sàn `shopFloorHoldSec` giây trước khi bỏ. Mặc định 600 s/10%/0,5 + 600 s → giảm 100→50% trong 50 phút, bỏ lúc 60 phút. `config:check` từ chối `shopMarkdownPct`/`shopStaleSec` ≤ 0, sàn ngoài 0,01..1 và key cũ `shopScrapSec`; có test cho mọi lịch (kể cả bước không chia hết và lỗi float).
- ✅ **Quy tắc "đã có hàng" khi auto-craft** giờ tính theo số bản: mỗi món đang bán/đang chế (cùng slot, level ≤ công thức) phục vụ 1 hunter; hunter vẫn được nâng cấp so với món tốt nhất trong kho luôn được tính. Headless (cùng quy tắc 0,65/0,35): bought +2–19% theo seed so với chỉ tính 1 món/slot, shop lúc 2 giờ 8–11 món thay vì 3–7, tỷ lệ bỏ 11–14% (trước 5–18%).
- ✅ Event/stat `gearScrapped` (và `materialsDiscarded`); `tools/headless.ts` in timeline gồm số món trong shop, kho, yêu cầu, vàng hunter và sổ thu/chi vàng Town.

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
