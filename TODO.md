# TODO — Town Hunter

Tình trạng hiện tại: đã xong M0–M3 và một lượt cân bằng (xem `game/README.md`, `TECH_SPEC.md`).
Số liệu đều là **đề xuất** chờ design chốt (công thức combat: TECH_SPEC §7.1).

Ký hiệu: 🔴 lỗi/cần sửa sớm · 🟡 cân bằng/cải thiện · ⚪ chưa làm (tính năng) · ✅ đã xong

---

## 1. Kinh tế

Số liệu hiện tại (headless 12 giờ `tools/headless.ts 720 <seed> 120`, seed 1–5, Dễ, commit `938cbfc`): vàng Town 17–21k lúc 6 giờ, 15–22k lúc 8 giờ, **22,3–27,6k lúc 12 giờ** (thấp nhất trong cửa sổ 10–12 giờ 14,8–20,0k); shop lúc 12 giờ 6–9 món; kho 65–105 NL; vàng hunter tb 2,8–4,1k lúc 8 giờ → 5,5–6,8k lúc 12 giờ; Lv tb lúc 12 giờ 83–87; crafted 162–185, mua 138–147, bỏ 11–32 món (7–17%); chưa ai tái sinh trước 12 giờ.

- ✅ **Kinh tế cuối game sụp** (vàng Town còn 22–1.831, shop 0–2 món, kho 2.000+ NL sau 6–8 giờ) — đã sửa bằng **Trạm Thu Mua theo yêu cầu vật liệu** (`src/core/systems/trading.ts`, TECH_SPEC §5.7, world v6): chỉ mua NL được yêu cầu (tự sinh từ nhu cầu auto-craft + lệnh `town.requestMaterial`); phần vượt yêu cầu không vào kho, Town chỉ mua "để xuất" với giá `tradeSurplusPriceFrac` khi vàng Town trên sàn `tradeSurplusFloorMul × autoCraftReserve`, còn lại hunter bỏ (`materialsDiscarded`). AI ưu tiên vùng rơi NL đang được yêu cầu. Đòn bẩy phụ: giá dịch vụ +1%/level (`servicePriceLevelPct`), thuế bán `tradeSaleTax` (đang 0). Save cũ vẫn giữ kho đã chất đống (migration không xóa).
- ✅ **Vàng Town tăng không giới hạn** (trước: 45,8–76,8k lúc 12 giờ, sau khi sửa shop 133–155k và vẫn tăng) — đã sửa bằng **mục tiêu ngân khố** (`trading.townGoldTarget`/`townFeeShare`, TECH_SPEC §5.7): trên mục tiêu `max(feeTownTargetMin 5.000, feeTownTargetMul 10 × autoCraftReserve)` phần phí cường hóa/học Town nhận giảm thành `feeTownShare × mục tiêu / vàng Town`, phần còn lại bị đốt; thêm giá dịch vụ cuối game `servicePriceLatePct` 5%/level trên `servicePriceLateLevel` 40. Vàng Town giờ ổn định (xem số liệu trên), không còn giảm dần 8 → 12 giờ cũng không tăng. Sau tái sinh (đo trước khi merge shop fix, seed 1 tới 20 giờ) dao động 9,8–31,6k, không có xu hướng. Test `tests/balance-treasury.test.ts` (seed 1, 3–6 giờ): 0,8–2,0 × mục tiêu (tắt quy tắc 2,3–5,0 × và đang tăng), ngưỡng test 3 ×.
- ✅ **Nhiều đồ craft bị bỏ** (trước 47–60%) — đã sửa (`src/core/systems/crafting.ts`, TECH_SPEC §5.8): auto-craft chấm **từng chất lượng** (hunter chỉ được tính khi tổng `craftChance` của các bản vừa là nâng cấp vừa mua được — ngân sách ≥ `craftAffordFrac` 0,35 × giá niêm yết — đạt `craftMinSellChance` 0,65; ngưỡng nằm trên tỷ lệ cộng dồn của `gear_quality.json`, đổi `craftChance` thì phải xem lại); đồ đang bán/đang chế tính theo **số bản** (mỗi bản phục vụ 1 hunter, hunter vẫn được nâng cấp so với món tốt nhất trong kho luôn được tính).
- ✅ **Sàn giảm giá không bao giờ chạm** — bỏ `shopScrapSec`; tuổi bỏ món = số bước giảm tới sàn × `shopStaleSec` + `shopFloorHoldSec` (`shopScrapAgeSec`). Mặc định 600 s/10%/0,5 + 600 s → giảm 100→50% trong 50 phút, bỏ lúc 60 phút. `config:check` từ chối giá trị sai và key cũ `shopScrapSec`; có test.
- ✅ Event/stat `gearScrapped` và `materialsDiscarded`; `tools/headless.ts` in timeline gồm shop, kho, yêu cầu, vàng hunter và sổ thu/chi vàng Town.
- 🟡 **Vàng hunter vẫn tăng 8 → 12 giờ** (2,8–4,1k → 5,5–6,8k) — không phải "không có chỗ tiêu" mà là tiền để dành cường hóa. Vàng mỗi hunter nằm ngay dưới ngưỡng AI cho lần cường hóa kế tiếp (`cost × enhanceReserveMul(successRate) + upgradeSavings`, `ai/utility.ts`), mà ngưỡng tỉ lệ với `basePrice` của đồ đang mặc (Lv60 7.000 → Lv80 12.500); tỉ lệ vàng / ngưỡng gần như không đổi (tb 0,80–0,91 ở mọi mốc). Tăng giá dịch vụ, thuế bán hay giảm `enhanceGoldReserveMul` chỉ đổi mức chứ không đổi dạng. Cần quyết định: chi phí cường hóa không tỉ lệ thẳng với `basePrice` (sửa cả `economy.enhanceCost` và `ai/utility.expectedEnhanceCost`), hoặc giá đồ tier cao phẳng hơn (`gear.json`, ảnh hưởng shop/craft).
- 🟡 **AI ít khi để dành đủ mua đồ tier mới:** `upgradeSavings` chỉ giữ `upgradeSavingsFrac` 0,3 × basePrice × `aiTypicalQualityMult` 0,9 / spendRatio ≈ 0,34 × basePrice (star: ~4,2k), trong khi mua món star (~12,5k × hệ số chất lượng) cần vàng ≈ giá / spendRatio 0,8 ≈ 15,6k, nên hunter đốt tiền vào cường hóa trước (hợp với shop còn tồn 6–9 món lúc 12 giờ). Đề xuất: giữ ≈ giá sàn của món nâng cấp (`shopMarkdownFloor × basePrice × aiTypicalQualityMult`).
- 🟡 Sau tái sinh (13–16 giờ) shop tụt 0–4 món (hunter Lv thấp giữ đồ star, không mua đồ thấp) — phía craft/shop.
- 🟡 Tỷ lệ bỏ đồ craft dao động theo seed: 7–17% (seed 2–3 bỏ 31–32 món).
- ⚪ UI để người chơi đặt yêu cầu vật liệu (hiện chỉ có command `town.requestMaterial`).

## 2. AI hunter

- ✅ ~~Hunter tái sinh mạnh vượt mọi vùng ở độ khó Dễ chọn vùng dễ nhất~~: `formulas.zoneScores` có tie-break — trong các vùng "thoải mái" (ratio ≥ `zoneFitBest`) vùng khó nhất giữ điểm, mỗi bậc dễ hơn bị trừ `zoneTierBonus` (0,06 > `decisionNoise`); có test.
- ⚪ Gợi ý/tự chuyển độ khó khi hunter vượt mọi vùng.
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
- ✅ ~~**Lv50 đến sớm**~~ (3,2–3,9 giờ trước đây): sau đổi combat 4,05–4,78 giờ (6 seed, Dễ), sau sửa rút lui 4,37–5,07 giờ (seed 1–5, xem dưới). Đòn bẩy chính là EXP quái từ Vách Tro trở đi giảm còn 0,36× (EXP/HP ≈ 0,09–0,11 như Đồng Cỏ/Phế Tích; Đầm Sương giữ nguyên làm vùng tăng tốc) — combat đúng hơn làm hunter săn hiệu quả hơn nên Lv20→50 nhanh gấp ~2 lần nếu giữ EXP cũ.
- 🟡 Hunter tụt hậu: lúc 2 giờ có 5–7/8 hunter đạt Lv20 (seed 1–6; trước 4–8/8 ở seed 1–5).
- ✅ ~~Chết nhiều ở vùng cuối trên đường về Town~~ — đã sửa bằng **rút lui theo sát thương dự kiến** (TECH_SPEC §5.2, `ai/utility.ts`: `retreatHpFloor`, `shouldRetreatBeforeNextKill`, `zoneEntryHpLine`; tham số `retreatTripMul` 3, `retreatKillMul` 1, `retreatHpCap` 0,6).
  - Chẩn đoán (headless 15 giờ, seed 1–5): 100% cái chết xảy ra sau khi hunter đã quyết định về Town; ở Vực Thẳm phần lớn chết **ngay trong vùng đang rời** 1–5 giây sau quyết định (quái đang đánh + quái chen vào lúc rút ra), các vùng dưới đóng góp ≈ 0. Chuyến về bắt đầu khi **không có quái nào đang đánh** gần như miễn phí (HP mất p90 ≈ 0,06 ở Vực Thẳm), còn chuyến bắt đầu giữa trận mất p50 0,08 / p90 0,2 / p99 0,31 thanh HP. Mô hình "thời gian trong vùng × DPS vùng (duel)" khớp: HP mất / dự đoán p50 ≈ 1,0, p90 ≈ 1,9, p99 ≈ 2,7 ở mọi vùng → `retreatTripMul` 3.
  - Số liệu (pacing 900 phút, seed 1–5, trước → sau): tổng chết 378 → 9 (71/127/70/17/93 → 2/4/1/2/0); theo vùng Đầm Sương+Vách Tro+Sông Băng 130 → 1, Thành Cổ Chìm 118 → 4, Vực Thẳm 123 → 4; chết trong 30 phút đầu vào Thành Cổ Chìm/Vực Thẳm 45 → 1. (Số "trước" đo lại trên `ea4b8aa`, khác chút so với 47 / 107 ghi trước đây.)
  - Nhịp: Lv20 57–85 → 61–83 phút; Lv50 4,20–5,10 → 4,37–5,07 giờ; tái sinh đầu 11,85–14,20 → 13,42–14,37 giờ (tb 13,3 → 13,8). Chết trước đây là "dịch chuyển miễn phí về Town" (không mất EXP/vàng, hồi sinh 15 s) nên bớt chết làm cuối game chậm hơn một chút.
  - Số hunter đã tái sinh lúc 15 giờ: 8/6/6/2/4 → 5/6/6/2/5 (26 → 24 trên 40).
  - Độ nhạy: `retreatTripMul` 2 / 2,5 / 3 cho tổng chết 141 / 62 / 9 (cùng 5 seed dùng để chỉnh, chưa kiểm trên seed khác).
  - 🟡 Còn lại: tái sinh đầu seed 4 là 14,37 giờ (trước 14,07; seed 5 trước 14,20), hơi quá mục tiêu 8–14 giờ. Lv20 dao động mạnh theo seed (61–83 phút; đổi một tham số nhỏ có thể đẩy một seed lên 88–89 phút). Ở Vực Thẳm vẫn chỉ ~5 kill/thanh HP so với `zoneRefKills` = 8 (dự đoán lạc quan ~1,4×), nay hunter về sớm hơn thay vì chết. Rút lui không áp dụng ở ranh giới kill cho lệnh Move của người chơi (backstop khẩn cấp vẫn áp dụng).
- 🟡 Dự đoán HP mất mỗi kill lệch theo vùng (đo/dự đoán: Phế Tích ~1,0, Đầm Sương/Vách Tro/Vực Thẳm ~1,4–1,5, Thành Cổ Chìm ~0,8): `zoneCrowd` mới chỉ dựa vào `respawnSec`; chưa tính aggroRange, quái chen vào và AoE.
- 🟡 **Hồi quy phía kinh tế sau đổi combat** (chưa sửa, thuộc kinh tế/AI): tỷ lệ cường hóa thành công qua 15 giờ 0,57–0,61 (trước 0,60–0,66, mục tiêu ~0,65). Giờ đầu (`tools/headless.ts 60`, seed 1–3): craft 18–36 (trước 41–54), mua đồ 13–30 (trước 29–40), thử cường hóa 129–229 (trước 62–93), kill 654–784 (trước 714–920). Giả thuyết (chưa kiểm chứng): hunter rời Đồng Cỏ sớm (Lv4–5) nên ít gel/hide cho đồ cấp 1, vàng dồn vào cường hóa đồ cũ.
- ⚪ **Mood ảnh hưởng chỉ số** (GDD §4.2): đã có `moodStatMult` (ATK/DEF giảm tuyến tính dưới `moodPenaltyFrac`, sàn `moodStatFloor`) nhưng **đang tắt** (`moodStatFloor = 1`): bật ở 0,85 làm số lần chết tăng ~1,5× vì AI chấm vùng bằng chỉ số "steady" (không mood). Cần AI về Tavern sớm hơn khi mood thấp trước khi bật.
- ✅ Spatial hash (TECH_SPEC §10, `tests/spatial.test.ts`) cho aggro của quái, skill AoE và đếm quái khi spawn; kết quả giống từng byte. 12 giờ game headless (8 hunter, ~80 quái): ~20,5 giây → ~16,8 giây (min của 3 lần, máy rảnh); CPU mô phỏng giảm ~6–18%.
- 🟡 Hiệu năng còn lại: chưa đo ở quy mô TECH_SPEC §10 (60 hunter, 300 quái). Phần nóng không phải truy vấn không gian: `hunterStats`/`needMax` gọi lặp qua `urgentNeed` mỗi tick (nên cache chỉ số hiệu dụng theo tick), `crafting.countUpgrades`/`pickRecipe`, và `findMonster`/`findHunter` tìm theo id tuyến tính. Test M2 (~9,5 giây) chủ yếu tốn vì `expect()` chạy mỗi tick cho mọi hunter: phần mô phỏng tương đương (60 phút seed 31 + 2×15 phút seed 8) chỉ ~2 giây.

## 4. Tính năng chưa làm (theo TECH_SPEC §12 và GDD)

### M4
- ✅ **Bounty** (GDD §9, TECH_SPEC §5.9, `src/core/systems/bounty.ts`, world v7): lệnh `town.postBounty` (quái hoặc vùng, số kill, thưởng; ký quỹ từ vàng Town), `town.cancelBounty`, `town.setAutoBounty`; thưởng chia theo từng kill; xong thì vương quốc trả Town 25% thưởng; Torment tăng tỉ lệ rơi của mục tiêu (+25%/bậc); AI ưu tiên vùng có mục tiêu (cùng chuẩn hóa với yêu cầu vật liệu); bounty tự động khi vàng Town trên mục tiêu ngân khố (10% phần vượt, 30 kill, hết hạn 30 phút).
  - Headless 12 giờ seed 1–5 (trước → sau): vàng Town 22,3–27,6k → 23,0–26,5k, vàng hunter tb 5,5–6,8k → 6,0–6,7k, Lv tb 83,1–86,6 → 82,1–85,9, shop 6–9 → 3–11 món, chết tổng 6 → 11 (seed 6–10: 9 → 4, cộng 10 seed 15 → 15) — trong nhiễu. Tắt auto-bounty: giống từng byte với trước.
  - 🟡 Còn lại: bounty tự động **không** phải chỗ tiêu vàng Town hiệu quả — quy tắc ngân khố bù lại, vàng Town gần như không đổi, phần chênh chảy sang hunter (với thưởng 0,2 vàng hunter tb cao hơn ở 4/5 seed). Nếu cần chỗ tiêu vàng Town thật thì phải là chi phí **ra khỏi** nền kinh tế (xây/nâng building), không phải chuyển cho hunter. Chưa có UI đặt bounty (chỉ command + nút hủy/bật-tắt trong debug overlay). Hiệu ứng Torment chưa đo trong mô phỏng dài (cần ≥ 5 lần tái sinh). Bounty tự động chỉ nhắm quái hunter đang săn nên ít đổi lựa chọn vùng; `bountyZoneBonus` chưa được tune.
- ✅ Trading Post theo yêu cầu vật liệu (xem mục 1; còn thiếu UI đặt yêu cầu).
- ⚪ Journey (GDD §9): 3 NPC, chạy offline, team power, tỉ lệ thành công.
- ✅ Tiến trình offline (TECH_SPEC §9): `src/core/offline.ts` ước lượng theo tốc độ trung bình 10 phút gần nhất (mẫu lưu trong envelope save, không đổi schema), trần `offlineMaxHours` 8, `offlineEfficiency` 1, chặn đồng hồ lùi/save không có thời gian; client áp dụng lúc boot và khi tab hiện lại, save ngay, popup tổng kết. Test `tests/offline.test.ts` (kể cả so với chạy thật 60 phút).
  - 🟡 Còn lại: ước lượng tuyến tính hụt nhiều khi game đang tăng tốc (sau 60 phút chơi: kill −28…−43 %, level ~½ thực tế; sau 150–240 phút sai ~±15 %). Gold dùng ròng sàn 0, không so được với thực tế (offline không mua/cường hóa). Offline không craft, không bán/mua shop, không tái sinh (EXP ở max level mất), không có hunter mới đến dù còn slot. Popup mới kiểm bằng DOM (nội dung đúng), chưa xem ảnh chụp.
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

- ✅ ~~Migration v1→v2 viết cứng node `t.square`; migration v3→v4 ước lượng `rollStats` bằng mức tăng level mặc định của M1.~~ Migration nhận config hiện tại (`deserialize(text, config)`): v1→v2 dùng node quảng trường của config (fallback `t.square`), v3→v4 trừ `levelHpGain/AtkGain/DefGain` của config và kẹp trong `statRanges` của class; có test (TECH_SPEC §9).
- 🟡 Cùng một tick có thể vừa `jobChanged` vừa `reincarnated` (vô hại, UI có thể hiện 2 thông báo). Đã ghi vào TECH_SPEC §3.2; không đổi code.

## 7. Dữ liệu & tài liệu

- 🔴 **Pháp lý/IP:** phụ lục GDD và `data_tables/` chứa dữ liệu trích từ bản build của một game thương mại. Không phát hành game với tên, text, số liệu sao chép; dùng làm tham chiếu khoảng giá trị. Tên/nội dung trong `game/config/` là bản tự đặt.
- 🟡 Dữ liệu trích: ~30% cột chưa rõ nghĩa (TBD), 8 bảng khớp byte nhưng chưa xác nhận đúng class, thiếu `sharedassets0.assets` (localUI, slang, help).
- ✅ ~~Cập nhật `TECH_SPEC.md` theo các quyết định đã chốt khi code (backstop khẩn cấp chạy lại sau combat, thứ tự system, world v6, công thức cường hóa theo kỳ vọng…).~~ Đã cập nhật §3.1–3.2 (module, thứ tự system thật), §4 (Hunter/GearInstance theo `world.ts`, công thức gear/cường hóa), §5.1–5.2 (goal và điểm theo `scoreGoals`, backstop khẩn cấp), §5.4 (mua đồ, cường hóa theo kỳ vọng), §6–7 (hiện trạng), §8 (bảng đã có, validate), §9 (file save, bảng migration v0→v6), §12 (hiện trạng).
- ✅ CI (`.github/workflows/ci.yml`, Node 22): `npm ci` → `npm test` → `npm run config:check` → `npm run build` trong `game/` mỗi push/PR.
