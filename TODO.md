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
- ✅ **Vàng Town tăng không giới hạn sau khi đổi Trạm Thu Mua + combat** — đã sửa (ngân khố Town, `trading.townFeeShare`, TECH_SPEC §5.7).
  - Trước (headless 12 giờ, seed 1–5): vàng Town 2,8–4,8k lúc 2 giờ → 34,9–60,8k lúc 8 giờ → 45,8–76,8k lúc 12 giờ, vẫn tăng; seed 1 lúc 16 giờ 121,7k.
  - Nguyên nhân (sổ thu/chi): "fees" = phần Town nhận (`feeTownShare` 0,8) từ tiền **cường hóa** của hunter (học skill chỉ đáng kể trước Lv35). Cường hóa là dòng chi lớn nhất của hunter (seed 1, 10–12 giờ: 236k/2 giờ), nên 80% chảy về Town (188k). Trên sàn surplus, Town đã mua hết NL vượt yêu cầu "để xuất" (~130k/2 giờ) mà vẫn dư; không có lực kéo vàng Town xuống. Tổng vàng (Town + hunter) tăng = vàng rơi từ quái (~100–110k/2 giờ, nguồn duy nhất) − vàng craft (~40k) − 20% tiền cường hóa bị đốt (~47k) ≈ +15–30k/2 giờ.
  - Sửa: trên mục tiêu ngân khố `max(feeTownTargetMin 5.000, feeTownTargetMul 10 × autoCraftReserve)` (cuối game ~18k), phần phí Town nhận giảm thành `feeTownShare × mục tiêu / vàng Town` (gấp đôi mục tiêu → còn một nửa); phần còn lại bị đốt. Thêm giá dịch vụ cuối game: + `servicePriceLatePct` 5%/level trên `servicePriceLateLevel` 40 (Lv90 ≈ 4,4× giá gốc, trước 1,9×), phần thu thêm về Town rồi bị đốt qua quy tắc trên khi Town giàu.
  - Sau (12 giờ, seed 1–5): vàng Town 13–30k từ 6 giờ trở đi (lúc 12 giờ 13,9–20,2k; thấp nhất trong cửa sổ 10–12 giờ 4,0–12,8k), shop 9–12 món lúc 12 giờ, auto-craft vẫn chạy (vàng craft 37–47k/2 giờ lúc 10–12 giờ). Nhịp không đổi: Lv20 đầu tiên 57–85 phút, Lv50 4,1–5,0 giờ (trước 57–85 phút, 4,2–5,1 giờ). Sau tái sinh (seed 1 tới 20 giờ, seed 3 tới 16 giờ): vàng Town dao động 9,8–31,6k ở các mốc 2 giờ, thấp nhất 2,4k (seed 1, 16–18 giờ; sàn surplus chặn phần mua "để xuất"), không có xu hướng tăng hay giảm (trước: seed 1 lên 121,7k lúc 16 giờ). Test `tests/balance-treasury.test.ts` (seed 1, 6 giờ, ~12 s): vàng Town trong 0,1–2,5 × mục tiêu từ 3 giờ (đo được 0,5–1,6 ×; tắt quy tắc thì 1,3–3,3 × và đang tăng → test fail).
  - 🟡 Còn lại: sau tái sinh (13–16 giờ) shop tụt 0–4 món (cũng vậy trước khi sửa: hunter Lv thấp giữ đồ star, không mua đồ thấp) — phần craft/shop.
- 🟡 **Vàng hunter vẫn tăng 8 → 12 giờ — không phải "không có chỗ tiêu" mà là tiền để dành cường hóa.** Probe (seed 1): vàng mỗi hunter luôn nằm ngay dưới ngưỡng AI cho lần cường hóa kế tiếp (`cost × enhanceReserveMul(successRate) + upgradeSavings`, `ai/utility.ts`), mà ngưỡng tỉ lệ với `basePrice` của đồ đang mặc (Lv60 7.000 → Lv80 12.500). Hunter tiêu gần hết thu nhập (cường hóa ~25–35k/hunter/2 giờ, vàng giữ ~5–8k). Tỉ lệ vàng / ngưỡng thấp nhất gần như không đổi (tb 0,80–0,91 ở mọi mốc 2–12 giờ), còn ngưỡng tb tăng 4,4k (8 giờ) → 7,9k (12 giờ). Vì vậy tăng giá dịch vụ (đã thêm phần dốc cuối game: không đổi vàng giữ), thuế bán hay giảm `enhanceGoldReserveMul` (thử 1,5) chỉ đổi mức chứ không đổi dạng: vàng tb lúc 8 → 12 giờ vẫn 2,6–3,6k → 5,5–7,6k. **Mục tiêu "vàng hunter phẳng 8 → 12 giờ" chưa đạt.** Sau 12 giờ vàng tb 6,3–8,4k (seed 1 tới 20 giờ), nhưng đoạn này trùng với tái sinh nên chưa tách được hiệu ứng "tier chạm trần". Hunter luôn phải giữ ít nhất chi phí lần thử kế tiếp = `basePrice × costFrac`, nên chỉnh ngưỡng AI thôi không bỏ được việc tỉ lệ theo tier. Cần quyết định: chi phí cường hóa không tỉ lệ thẳng với `basePrice` (sửa cả `economy.enhanceCost` và `ai/utility.enhanceCost`), hoặc giá đồ tier cao phẳng hơn (`gear.json`, ảnh hưởng shop/craft).
- ✅ **Kho Town dư nguyên liệu** — kho chỉ nhận phần được yêu cầu (≈100–200 NL thay vì 2.000+). Save cũ vẫn giữ kho đã chất đống (migration không xóa).
- 🟡 **Nhiều đồ craft bị bỏ** — không đổi so với trước (8 giờ: trước crafted 205–240 / bought 125–156; sau crafted 207–240 / bought 116–133, `gearScrapped` 80–102; con số ~25% cũ là lúc 4 giờ) → phí vàng craft. `craftAffordFrac` 0,5 làm shop trống vì hunter không bao giờ đủ tiền; 0,2 đang dùng. Xem lại tỷ lệ chất lượng, `shopScrapSec`, hoặc tính "người hưởng lợi" theo khả năng mua.
- 🟡 **Sàn giảm giá không bao giờ chạm:** với `shopStaleSec` 600, `shopMarkdownPct` 10, `shopScrapSec` 1800 thì giá chỉ xuống 80% trước khi bị bỏ; `shopMarkdownFloor` 0,5 vô dụng.
- 🟡 **Quy tắc "đã có hàng" khi auto-craft** tính 1 món/slot cho mọi hunter → mỗi slot chỉ cung cấp từng món một. Đổi sang tính theo số bản nếu thấy craft bị nghẽn. (Yêu cầu NL tự động đã bỏ qua quy tắc này để mua sẵn NL cho bản tiếp theo.)
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
