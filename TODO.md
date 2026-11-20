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
- 🟡 **Nhiều đồ craft bị bỏ** — không đổi so với trước (8 giờ: trước crafted 205–240 / bought 125–156; sau crafted 207–240 / bought 116–133, `gearScrapped` 80–102; con số ~25% cũ là lúc 4 giờ) → phí vàng craft. `craftAffordFrac` 0,5 làm shop trống vì hunter không bao giờ đủ tiền; 0,2 đang dùng. Xem lại tỷ lệ chất lượng, `shopScrapSec`, hoặc tính "người hưởng lợi" theo khả năng mua.
- 🟡 **Sàn giảm giá không bao giờ chạm:** với `shopStaleSec` 600, `shopMarkdownPct` 10, `shopScrapSec` 1800 thì giá chỉ xuống 80% trước khi bị bỏ; `shopMarkdownFloor` 0,5 vô dụng.
- 🟡 **Quy tắc "đã có hàng" khi auto-craft** tính 1 món/slot cho mọi hunter → mỗi slot chỉ cung cấp từng món một. Đổi sang tính theo số bản nếu thấy craft bị nghẽn. (Yêu cầu NL tự động đã bỏ qua quy tắc này để mua sẵn NL cho bản tiếp theo.)
- ✅ Event/stat `gearScrapped` (và `materialsDiscarded`); `tools/headless.ts` in timeline gồm số món trong shop, kho, yêu cầu, vàng hunter và sổ thu/chi vàng Town.

## 2. AI hunter

- ✅ ~~Hunter tái sinh mạnh vượt mọi vùng ở độ khó Dễ chọn vùng dễ nhất~~: `formulas.zoneScores` có tie-break — trong các vùng "thoải mái" (ratio ≥ `zoneFitBest`) vùng khó nhất giữ điểm, mỗi bậc dễ hơn bị trừ `zoneTierBonus` (0,06 > `decisionNoise`); có test. Còn lại: gợi ý/tự chuyển độ khó khi hunter vượt mọi vùng.
- 🟡 AI chấm vùng có thêm hệ số đông người (`zoneShare`: vùng hồi 1 quái mỗi `respawnSec`, chia cho số hunter đang săn), được chuẩn hóa để vùng tốt nhất giữ điểm. Quãng đường về Town giờ được tính qua **rút lui** (TECH_SPEC §5.2): vùng khác được chấm với ngưỡng HP để bắt đầu một kill ở đó (`zoneEntryHpLine`), nên hunter không đi tới vùng mà phải quay về ngay. Chưa tính thời gian đi đường vào EXP/giờ (vùng xa vẫn được chấm như vùng gần) và hunter đi chung đường.
- 🟡 ~~Hunter **Liều lĩnh** gần như không cường hóa~~ — "gần như không" là **sai**, nhưng họ cường hóa **ít hơn**. Đo headless 15 giờ (số lần đổi goal sang `enhance` / hunter, không phải số lần thử; Liều lĩnh có ở seed 2, 3, 5 với 2/1/3 hunter):
  - trước khi sửa rút lui: Liều lĩnh 178 / 93 / 477 so với hunter khác 272 / 207 / 296;
  - sau khi sửa rút lui: 172 / 152 / 174 so với 268 / 233 / 293 (≈ 35–40% ít hơn). Mua đồ và học gần như bằng nhau (vd. seed 5: shop 17 vs 19 / hunter).
  - Không sửa: điểm săn ×1,15 là chủ ý của tính cách. Nguyên nhân chính xác (khi nào điểm săn thắng dải cường hóa ~1,04–1,10) chưa đo; nếu design muốn Liều lĩnh cường hóa ngang hunter khác thì cần hệ số `goal.enhance` riêng cho tính cách này.
- ✅ Các hằng số cường hóa và điểm goal ở Town đã chuyển từ `src/core/ai/utility.ts` vào `formula_params.json` (giá trị giữ nguyên, pacing 240 phút seed 2 giống từng byte): `enhanceRiskExp`, `enhanceMinSuccess`, `upgradeSavingsFrac`, `aiTypicalQualityMult`, `enhanceBaseScore`, `enhanceGainWeight`, `shopBaseScore`, `shopGainWeight`, `sellBaseScore`, `sellFillWeight`, `learnSkillScore`, `learnTraitScore`, `econMulFloor`, `serviceFullFrac`, `serviceLowBase`, `serviceLowWeight`, `serviceWeight`, `bagReturnScore`, `restScoreWeight`.
- ✅ Trùng tên `enhanceCost`: bản trong `ai/utility.ts` đổi thành `expectedEnhanceCost` (bản ở `systems/economy.ts` giữ nguyên).
- 🟡 Test tích hợp Học Viện (`tests/academy.test.ts`) đã nới thành "≥ một nửa hunter đi học".
- 🟡 Lệnh tái sinh thủ công cho phép khi hunter đang ở ngoài field (AI đã được reset để tự về); cân nhắc yêu cầu ở Town.

## 3. Nhịp tiến trình & combat

- ✅ ~~**Mọi công thức là placeholder**~~: đã có mô hình combat (TECH_SPEC §5.3, §7.1): DEF hyperbol theo level người đánh có trần, phạt chênh level, crit/né có trần, cộng dồn % theo nhóm có trần, tỷ lệ sức mạnh = √(kill mỗi thanh HP / `zoneRefKills`) tính từ chính công thức combat (bỏ `recommendedPower`). Test `tests/formulas.test.ts` (đơn vị + so dự đoán với combat mô phỏng). Số liệu vẫn là **[ĐỀ XUẤT]** chờ design duyệt.
- ✅ ~~**Lv50 đến sớm**~~ (3,2–3,9 giờ trước đây): giờ 4,05–4,78 giờ (6 seed, Dễ). Lv20 53–81 phút (trước 66–80), tái sinh đầu 11,7–13,3 giờ (trước 8,6–10,4). Đòn bẩy chính là EXP quái từ Vách Tro trở đi giảm còn 0,36× (EXP/HP ≈ 0,09–0,11 như Đồng Cỏ/Phế Tích; Đầm Sương giữ nguyên làm vùng tăng tốc) — combat đúng hơn làm hunter săn hiệu quả hơn nên Lv20→50 nhanh gấp ~2 lần nếu giữ EXP cũ.
- 🟡 Lv20 dao động theo seed (53–81 phút); seed 2 đạt Lv20 lúc 53 phút (hơi sớm).
- 🟡 Hunter tụt hậu: lúc 2 giờ có 5–7/8 hunter đạt Lv20 (seed 1–6; trước 4–8/8 ở seed 1–5).
- ✅ ~~Chết nhiều ở vùng cuối trên đường về Town~~ — đã sửa bằng **rút lui theo sát thương dự kiến** (TECH_SPEC §5.2, `ai/utility.ts`: `retreatHpFloor`, `shouldRetreatBeforeNextKill`, `zoneEntryHpLine`; tham số `retreatTripMul` 3, `retreatKillMul` 1, `retreatHpCap` 0,6).
  - Chẩn đoán (headless 15 giờ, seed 1–5): 100% cái chết xảy ra sau khi hunter đã quyết định về Town; ở Vực Thẳm phần lớn chết **ngay trong vùng đang rời** 1–5 giây sau quyết định (quái đang đánh + quái chen vào lúc rút ra), các vùng dưới đóng góp ≈ 0. Chuyến về bắt đầu khi **không có quái nào đang đánh** gần như miễn phí (HP mất p90 ≈ 0,06 ở Vực Thẳm), còn chuyến bắt đầu giữa trận mất p50 0,08 / p90 0,2 / p99 0,31 thanh HP. Mô hình "thời gian trong vùng × DPS vùng (duel)" khớp: HP mất / dự đoán p50 ≈ 1,0, p90 ≈ 1,9, p99 ≈ 2,7 ở mọi vùng → `retreatTripMul` 3.
  - Số liệu (pacing 900 phút, seed 1–5, trước → sau): tổng chết 378 → 9 (71/127/70/17/93 → 2/4/1/2/0); theo vùng Đầm Sương+Vách Tro+Sông Băng 130 → 1, Thành Cổ Chìm 118 → 4, Vực Thẳm 123 → 4; chết trong 30 phút đầu vào Thành Cổ Chìm/Vực Thẳm 45 → 1. (Số "trước" đo lại trên `ea4b8aa`, khác chút so với 47 / 107 ghi trước đây.)
  - Nhịp: Lv20 57–85 → 61–83 phút; Lv50 4,20–5,10 → 4,37–5,07 giờ; tái sinh đầu 11,85–14,20 → 13,42–14,37 giờ (tb 13,3 → 13,8). Chết trước đây là "dịch chuyển miễn phí về Town" (không mất EXP/vàng, hồi sinh 15 s) nên bớt chết làm cuối game chậm hơn một chút.
  - Số hunter đã tái sinh lúc 15 giờ: 8/6/6/2/4 → 5/6/6/2/5 (26 → 24 trên 40).
  - Độ nhạy: `retreatTripMul` 2 / 2,5 / 3 cho tổng chết 141 / 62 / 9 (cùng 5 seed dùng để chỉnh, chưa kiểm trên seed khác).
  - 🟡 Còn lại: tái sinh đầu seed 4 là 14,37 giờ (trước 14,07; seed 5 trước 14,20), hơi quá mục tiêu 8–14 giờ. Lv20 dao động mạnh theo seed (đổi một tham số nhỏ có thể đẩy một seed lên 88–89 phút). Ở Vực Thẳm vẫn chỉ ~5 kill/thanh HP so với `zoneRefKills` = 8 (dự đoán lạc quan ~1,4×), nay hunter về sớm hơn thay vì chết. Rút lui không áp dụng ở ranh giới kill cho lệnh Move của người chơi (backstop khẩn cấp vẫn áp dụng).
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
