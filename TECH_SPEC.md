# TECH SPEC — Town & Hunter

Tài liệu kỹ thuật cho bước 1: kiến trúc, mô phỏng, AI hunter, save/offline và data schema.
Đi kèm: `GDD_GAMEPLAY_TOWN_HUNTER.docx` (luật chơi) và `data_tables/` (số liệu tham chiếu đã trích).

Quy ước: **[CHỐT]** là quyết định kỹ thuật; **[ĐỀ XUẤT]** là giá trị khởi điểm để tuning, có thể đổi trong config; **TBD** là chưa có căn cứ.

---

## 1. Mục tiêu kỹ thuật

| Mục tiêu | Yêu cầu |
|---|---|
| Data-driven | Mọi số liệu gameplay nằm trong config; code không hard-code giá trị cân bằng. |
| Mô phỏng tách khỏi render | Core simulation chạy không cần Three.js/DOM → test được, chạy offline-progress được, chạy server-side được sau này. |
| Deterministic | Cùng seed + cùng input → cùng kết quả. Dùng RNG có seed, không dùng `Math.random` trong core. |
| Hiệu năng | 60 hunter + 300 quái trên mobile web mid-range ở 60 FPS render; sim không quá 2 ms/tick. |
| Asset độc lập | Gameplay tham chiếu logical asset ID (`hunter.berserker.t1`), không tham chiếu đường dẫn file (GDD §11.1). |

## 2. Stack **[CHỐT]**

| Lớp | Công nghệ | Ghi chú |
|---|---|---|
| Ngôn ngữ | TypeScript (strict) | Dùng chung cho client, tool và server sau này. |
| Render môi trường/building | Three.js, camera orthographic, pixel-art (GDD §11) | Render vào render target độ phân giải thấp rồi upscale nearest để giữ pixel sắc. |
| Nhân vật | Sprite sheet xuất từ PX2D, vẽ dạng billboard quad trong scene Three.js | Một atlas cho mỗi class/tier; frame order/timing đọc từ JSON đi kèm. |
| UI | DOM overlay (React hoặc Preact) trên canvas | ~40 màn hình ở bản đầu; UI chỉ đọc state và gửi command. |
| Build | Vite | |
| Test | Vitest cho core simulation | Chạy giả lập 1 giờ game trong test để bắt lỗi cân bằng/AI. |
| Save | IndexedDB (local) → cloud save ở giai đoạn online | |
| Server (giai đoạn sau) | Node + Postgres | Chỉ cần cho account, IAP, ranking, PvP/guild. |

## 3. Kiến trúc

```
┌──────────── client ────────────┐
│  UI (DOM)      Render (Three)  │   ← chỉ đọc snapshot, gửi Command
│        ▲            ▲          │
│        │  snapshot  │          │
│  ┌─────┴────────────┴───────┐  │
│  │      Simulation core     │  │   ← thuần TS, không phụ thuộc DOM
│  │  World ─ Systems ─ RNG   │  │
│  └────────────┬─────────────┘  │
│               │ đọc            │
│        Config (JSON đã build)  │
│               │                │
│        SaveService (IndexedDB) │
└────────────────────────────────┘
```

### 3.1 Module core

| Module | Trách nhiệm |
|---|---|
| `world` | Chứa toàn bộ state: town, buildings, hunters, monsters, inventory, economy, clock. Serializable 100%. |
| `systems/needs` | Giảm HP/Satiety/Mood/Stamina theo sự kiện và thời gian. |
| `systems/ai` | Ra quyết định cho hunter (§5). |
| `systems/movement` | Di chuyển theo path trên waypoint graph. |
| `systems/combat` | Target, đòn đánh, skill, damage, chết/hồi sinh. |
| `systems/spawn` | Sinh quái theo zone và difficulty. |
| `systems/economy` | Shop, dịch vụ, craft, trading post, bounty, thuế. |
| `systems/progression` | EXP, level, chuyển nghề, reincarnation, unlock difficulty. |
| `systems/arrivals` | Hunter mới ghé Town theo slot, invitation. |
| `commands` | Hành động của người chơi (Move, Learn, Activities, Manage, build/upgrade…). Validate rồi đưa vào hàng đợi của tick kế tiếp. |
| `events` | Event bus một chiều sim → UI/render (hit, kill, levelup, purchase…) để chơi VFX/âm thanh/toast. |

### 3.2 Vòng lặp **[CHỐT]**

- Fixed-step simulation: **10 tick/giây** (`dt = 100 ms`). Render nội suy vị trí giữa 2 tick.
- Thứ tự system mỗi tick: `commands → arrivals → ai → movement → combat → needs → economy → progression → spawn → cleanup → emit events`.
- Tốc độ game x1/x2/x4: chạy nhiều tick trong một frame, không đổi `dt`.
- Mỗi system chỉ ghi vào phần state của nó, đọc phần còn lại. Không dùng singleton toàn cục.

## 4. Mô hình thực thể

### 4.1 Hunter (runtime)

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `id` | string | |
| `classId`, `jobTier` | ref, int 0..8 | Chuỗi chuyển nghề 9 bậc mỗi class. |
| `grade` | enum Normal/Rare/Superior/Heroic/Legendary | Theo điểm G (GDD §4.2). |
| `statGrades` | map stat → Normal/High/Highest | Roll lúc sinh hunter. |
| `baseStats` | HP, ATK, DEF, EVA, CRIT, ATKSPD | Roll trong khoảng của class theo statGrade. |
| `level`, `exp`, `reincarnation` | int | |
| `needs` | hp, satiety, mood, stamina (0..max) | |
| `gold` | int | Tiền riêng của hunter; dùng để mua đồ và dịch vụ. |
| `equipment` | slot → GearInstance | 7 slot (GDD §6). |
| `bag` | list ItemStack, `bagCapacity` | Nguyên liệu nhặt được, potion. |
| `skills`, `traits`, `traitPoints` | | |
| `personalities` | list ref (1–3) | Hệ số chỉnh hành vi (§5.5). |
| `ai` | `{state, goal, targetId, path, cooldowns, lastDecisionTick}` | |
| `position`, `zoneId` | | |

### 4.2 GearInstance

`{ gearId, quality (Common..Mythic), enhanceLevel, tier, options: [{optionId, value}], setId?, gearSkillId?, runes[] }`.
Chỉ số cuối = base theo `gearId` × hệ số quality (GDD §6) × đường cong enhance + options. Công thức cộng/nhân cụ thể: **TBD**, định nghĩa trong `formulas.ts` và có test.

## 5. AI hunter

### 5.1 Mô hình **[CHỐT]**

**Utility AI kết hợp state machine:**

- *State machine* lo phần **thực thi** một mục tiêu: `Idle → Travel → Act → Done`.
- *Utility* lo phần **chọn mục tiêu**: mỗi lần cần quyết định, chấm điểm tất cả goal khả dụng rồi chọn điểm cao nhất (có nhiễu nhỏ để hunter không đồng bộ).
- Quyết định lại khi: xong goal, có ngưỡng khẩn cấp bị vượt, có command của người chơi, hoặc mỗi **3 s** khi đang săn **[ĐỀ XUẤT]**.

### 5.2 Danh sách goal

| Goal | Điều kiện khả dụng | Điểm cơ sở (chuẩn hóa 0..1) |
|---|---|---|
| `Hunt(zone)` | Zone đã mở, không có nhu cầu khẩn cấp | `zoneFit × needsOk × (1 − bagFull)` |
| `ReturnTown` | Đang ở field | `max(urgency của các nhu cầu, bagFull, noPotion)` |
| `Heal` (Infirmary) | Ở Town, dịch vụ còn hàng, đủ tiền | `1 − hp/hpMax` |
| `Eat` (Restaurant) | như trên | `1 − satiety/max` |
| `Fun` (Tavern) | như trên | `1 − mood/max` |
| `Rest` (Inn) | như trên | `1 − stamina/max` |
| `BuyGear(slot)` | Shop có món tốt hơn và đủ tiền | `upgradeGain × affordability` |
| `BuyPotion` | Thiếu potion, đủ tiền | `1 − potionCount/potionTarget` |
| `SellMaterials` | Trạm Thu Mua sẽ trả tiền cho ít nhất 1 đơn vị trong bag (xem §5.7), hoặc bag ≥ `bagReturnFrac` và có NL không được yêu cầu (đi bỏ) | `bagFill` (tăng mạnh khi > 80%) |
| `Enhance/Upgrade` | Đủ tiền và vật liệu | `gain × affordability × riskTolerance` |
| `Train` | Hunter sợ săn (Coward…) hoặc chênh level lớn | theo GDD §5 Training Ground |
| `Wander` | fallback | hằng số nhỏ (0.05) |

**Nhu cầu khẩn cấp** (bỏ qua utility, ép `ReturnTown` ngay) **[ĐỀ XUẤT]**: HP < 25%, Satiety < 10%, Stamina < 10%.
**Nhu cầu mềm** (cộng điểm `ReturnTown`): bất kỳ nhu cầu < 40%.

### 5.3 Chấm điểm vùng săn

Tỷ lệ sức mạnh tính **từ chính công thức combat** (§7.1), không còn `recommendedPower` trong config:

```
duel(h, m)    = hunterDps = E[hit(ATK)]/atkSpeed + Σ skill E[hit(ATK×mult)]/cooldown
                monsterDps = E[hit(ATK quái)]/attackSpeed quái;  ttk = HP quái / hunterDps
                dmgPerKill = monsterDps × ttk
zoneCrowd     = zoneCrowdRespawnSec / respawnSec        (hiệu chỉnh thực nghiệm: zone hồi quái nhanh → nhiều quái chen vào)
killsPerLife  = HP hunter / (zoneCrowd × Σ_w dmgPerKill / Σ_w)   (w = trọng số spawn; chỉ số "steady": bỏ buff, mood)
ratio         = √(killsPerLife / zoneRefKills)          (1 = đánh được zoneRefKills con trên một thanh HP)
zoneFit       = 0 nếu ratio < zoneFitMin; ramp zoneFitRampLow→1 tới zoneFitBest; 1 tới zoneFitEasy;
                rồi giảm zoneFitDecay mỗi 1.0 ratio, sàn zoneFitFloor (quá dễ, ít EXP)
share         = min(1, ttk / (n × respawnSec))          (n = số hunter đang săn zone đó, kể cả mình)
fit           = zoneFit × (zoneShareFloor + (1 − zoneShareFloor) × share)
tie-break     = trong các zone "thoải mái" (ratio ≥ zoneFitBest), zone khó nhất giữ nguyên điểm,
                mỗi bậc dễ hơn bị trừ zoneTierBonus (> decisionNoise) → hunter vượt mọi zone chọn zone khó nhất
```

Căn bậc hai làm ratio tuyến tính theo chỉ số: hunter gấp đôi DPS **và** gấp đôi HP hiệu dụng có ratio ×2, nên ngưỡng 0.7 / 1.1 / 2 vẫn đọc được. Test `tests/formulas.test.ts` đối chiếu `duel()` với combat mô phỏng 1-đấu-1 (sai số ≤ 15%) và đối chiếu HP mất mỗi kill trong mô phỏng đầy đủ với dự đoán.

Ngưỡng là **[ĐỀ XUẤT]** (`formula_params.json`). Yêu cầu vật liệu (§5.7) chỉ đổi **lựa chọn vùng**: sau `fit` ở trên, mỗi vùng khả dụng (fit > 0) nhân `(1 + requestZoneBonus × tỉ lệ giá trị rơi đang được yêu cầu) / max(hệ số đó của các vùng khả dụng)`, nên điểm săn cao nhất không bao giờ tăng so với khi không có yêu cầu và vùng hunter không sống nổi không bao giờ được cộng. Chief dùng lệnh Move để ghi đè: goal `Hunt(zoneChỉĐịnh)` được giữ cho đến khi xong hoặc có nhu cầu khẩn cấp.

### 5.4 Mua đồ

- `upgradeGain = (score(mới) − score(cũ)) / score(cũ)`, với `score` là chỉ số chính có trọng số theo class (ví dụ Berserker ưu tiên ATK).
- Chỉ mua khi `upgradeGain ≥ 5%` và `giá ≤ gold × spendRatio` **[ĐỀ XUẤT]** (`spendRatio` mặc định 0.8).
- Đồ cũ bán lại cho shop hoặc vào kho Town (TBD theo thiết kế kinh tế).

### 5.5 Tính cách là hệ số (modifier)

Mỗi personality là một bộ hệ số nhân vào needs, utility hoặc stat. Ví dụ cấu trúc (giá trị **[ĐỀ XUẤT]**):

| Personality | Hiệu ứng |
|---|---|
| Hèn nhát | `Hunt` ×0.7; ngưỡng HP khẩn cấp 40% |
| Keo kiệt | `spendRatio` 0.4; dịch vụ ×0.8 |
| Ham ăn | Satiety giảm ×1.3 |
| Chạy nhanh | Tốc di chuyển ×1.15 |
| Sợ bệnh viện | `Heal` ×0.3 |

Tên và danh sách personality do team tự đặt; schema ở §8.

### 5.6 Gợi ý từ Chief (lời nhắc)

Lệnh "nhắc" của người chơi là một **utility bonus có thời hạn**: ví dụ `BuyGear +0.5 trong 60 s`. Không ép, trừ lệnh Move/Activities (ép).

### 5.7 Trạm Thu Mua theo yêu cầu vật liệu (GDD §5) **[ĐÃ LÀM]**

Code: `src/core/systems/trading.ts`, `economy.ts` (`doSell`), tham số trong `formula_params.json`.

- **Yêu cầu tự động** (không lưu trong save, tính lại mỗi lần): với mỗi công thức mà `recipeWanters` ≥ 1 (số hunter mua được món theo quy tắc chất lượng ở §5.8; khác `recipeBeneficiaries` ở chỗ không trừ đồ đang bán/đang chế), giữ trong kho đủ NL cho `min(wanters, requestMaxCopies)` lần chế. Yêu cầu = phần kho còn thiếu. Tắt auto-craft → không có yêu cầu tự động.
- **Yêu cầu của người chơi**: `town.requests` (world v6), đặt bằng lệnh `town.requestMaterial { materialId, count }` (đặt lại số, 0 = hủy; từ chối NL lạ, count không phải số nguyên ≥ 0, count > `requestMaxUnits`). Cộng thêm vào yêu cầu tự động và được lấp trước; giảm dần khi hunter bán.
- **Khi bán** (theo thứ tự materialId, yêu cầu tính lại cho từng hunter nên 2 hunter cùng tick không lấp trùng):
  - đơn vị được yêu cầu: Town mua giá `round(price × (1 − tradeSaleTax))` khi còn đủ vàng, vào kho; phần được yêu cầu mà Town chưa đủ vàng thì **giữ lại trong bag**;
  - đơn vị vượt yêu cầu: **không vào kho**. Nếu vàng Town > `tradeSurplusFloorMul × autoCraftReserve` thì Town mua "để xuất đi" với giá `round(price × tradeSurplusPriceFrac × (1 − tradeSaleTax))`, chỉ dùng phần vàng trên sàn đó; còn lại hunter **bỏ** tại Trạm (event `materialsDiscarded`, stat `materialsDiscarded`).
  - Ý đồ: Town giàu thì chảy vàng lại cho hunter (giữ nhịp đầu game), Town nghèo thì chỉ chi cho thứ nó dùng; kho không còn chất đống.
- **Đòn bẩy phụ**: `servicePriceLevelPct` (giá dịch vụ = `round(base × (1 + pct/100 × (level − 1)))`, một hàm `servicePrice` dùng chung cho system, AI và lệnh), `tradeSaleTax` (mặc định 0), `craftAffordFrac`. Giá giảm khi kho dư không cần nữa vì kho chỉ nhận phần được yêu cầu.

### 5.8 Shop: auto-craft và giảm giá (GDD §6) **[ĐÃ LÀM]**

Code: `src/core/systems/crafting.ts`, tham số trong `formula_params.json`.

- **Giảm giá**: món chưa bán cứ mỗi `shopStaleSec` giảm `shopMarkdownPct`% giá niêm yết, không dưới `round(listPrice × shopMarkdownFloor)`. Giá tính lại từ tuổi món mỗi tick (idempotent, an toàn với save).
- **Bỏ món**: tuổi bỏ = `shopScrapAgeSec` = `ceil((1 − floor) × 100 / pct)` bước × `shopStaleSec` + `shopFloorHoldSec` (không dùng `shopScrapSec` nữa) → giá luôn chạm sàn và được chào ở giá sàn `shopFloorHoldSec` giây trước khi bị bỏ (không hoàn tiền, event/stat `gearScrapped`). `shopFloorHoldSec` < 0 = không bao giờ bỏ. Mặc định 600 s / 10% / 0,5 / 600 s → 100→50% trong 3.000 s, bỏ lúc 3.600 s. `config:check` kiểm tra `shopStaleSec` ≥ 1, `shopMarkdownPct` trong (0, 100], `shopMarkdownFloor` trong [0,01; 1] và từ chối key cũ `shopScrapSec`.
- **Chọn công thức auto-craft** (`pickRecipe`): trong các công thức có đủ NL và vàng Town ≥ giá craft + `autoCraftReserve`, chọn cái có nhiều người hưởng lợi nhất (`recipeBeneficiaries`), rồi gear level cao hơn, rồi gearId; 0 người → không chế.
- **Người hưởng lợi**: hunter level ≥ gear.level − `craftLevelAhead`; với mỗi chất lượng q, bản q được tính nếu là nâng cấp ≥ `minUpgradeGain` (công thức như AI mua đồ) **và** ngân sách shop ≥ `craftAffordFrac × round(basePrice × q.priceMult)`; hunter được tính khi tổng `craftChance` (chuẩn hóa) của các bản đó ≥ `craftMinSellChance` (0,65 = Uncommon trở lên phải bán được; 0,35 = chỉ cần Rare, gần quy tắc cũ — trùng hẳn khi `craftAffordFrac` = 0). Ngưỡng so với tỷ lệ cộng dồn của `craftChance`, nên đổi `gear_quality.json` thì phải xem lại.
- **Đồ đã có**: món cùng slot, level ≤ công thức đang bán (chất lượng thật) hoặc đang chế (chất lượng tham chiếu Rare) tính theo **số bản**: hunter vẫn được nâng cấp so với món tốt nhất trong số đó luôn được tính; hunter mà món có sẵn đã phục vụ chỉ được tính phần vượt quá số bản.

## 6. Di chuyển và pathfinding

- Map là **waypoint graph**: node (vị trí, zoneId, loại: road/field/building-door) và cạnh (khoảng cách).
- Đường đi: A* trên graph, cost = khoảng cách / hệ số tốc độ của cạnh. Cạnh trên **Road** có hệ số > 1 **[ĐỀ XUẤT 1.5]**.
- Building có node cửa; khi đặt hoặc xóa building, graph cập nhật cạnh nối và cache path bị xóa.
- Cache path theo cặp (node đầu, node cuối), mất hiệu lực khi graph đổi.
- Trong field: đi tới node gần quái, sau đó steering tự do trong bán kính.
- Trên ~60 hunter: giới hạn 10 truy vấn A*/tick, còn lại xếp hàng.

## 7. Combat

- Hunter chọn mục tiêu là quái gần nhất trong tầm nhìn; ưu tiên quái đang đánh mình.
- Đòn đánh thường lặp theo chu kỳ `ATK SPD` (số nhỏ = nhanh, GDD §4.2).
- Skill: auto-cast khi hết cooldown và có mục tiêu hợp lệ; ưu tiên theo thứ tự trong config.
- Mọi công thức (damage, giảm sát thương theo DEF, crit, evasion, buff stacking) nằm trong `formulas.ts`, có unit test và lấy hệ số từ config `formula_params`.
- Mỗi đòn trúng: giảm Mood của mục tiêu bị đánh; mỗi đòn hunter đánh: giảm Satiety (GDD §4.2).

### 7.1 Mô hình combat **[ĐỀ XUẤT]**

Hằng số ở `formula_params.json`; phương trình và ý đồ ghi ở đầu mỗi hàm trong `formulas.ts`. Hunter và quái dùng cùng công thức (quái có `level` trong `monster.json`).

| Công thức | Phương trình | Ý đồ |
|---|---|---|
| Giảm sát thương theo DEF | `R = min(defReductionCap, DEF / (DEF + defPerLevel·L_tấn công + defFlat))` | Hyperbol: tăng dần, lợi ích giảm dần, không bao giờ 100%. DEF "nửa giá trị" tăng theo level **người đánh**, nên DEF giữ ý nghĩa suốt 100 level; hunter vượt cấp zone thì quái zone đó gần như không làm gì được. |
| Chênh level | `G = max(levelGapMin, 1 − levelGapStep × max(0, L_mục tiêu − L_tấn công − levelGapGrace))` | Chỉ phạt kẻ đánh thấp hơn mục tiêu quá `levelGapGrace` level (không thưởng khi cao hơn). Quái zone thấp không giết được hunter đang đi ngang về Town; hunter vào zone trên level gây ít sát thương → ratio thấp → AI chờ đủ level. |
| Một đòn | `hit = max(minDamage, ATK × (1 − R) × G)` | Không bao giờ 0/âm; DEF cực lớn vẫn còn `(1 − cap) × ATK`. |
| Crit | `P = min(critChanceCap, CRIT/100)`; `mult = base + critOverflowMult × max(0, CRIT/100 − critChanceCap)` | `base` = `critMultiplier` (hunter) / `monsterCritMultiplier` (quái). Điểm crit vượt trần chuyển thành sát thương crit. |
| Né | `P = dodgeCap × EVA / (EVA + dodgeHalf)` | Lợi ích giảm dần, bằng nửa trần tại `dodgeHalf`, không chạm trần. |
| Kỳ vọng một đòn | `E = hit × (1 − P_né) × (1 + P_crit × (mult − 1))` | Dùng cho AI (§5.3). Thứ tự RNG trong combat: né trước, crit chỉ khi trúng. |
| Cộng dồn % | `(base × job × (1 + reinc × reincStatBonus) + gear) × (1 + min(traitPctCap, Σtrait%)/100) × (1 + min(buffPctCap, Σbuff%)/100)` | Cộng trong cùng nhóm (trait / buff skill), nhân giữa các nhóm, mỗi nhóm có trần. Crit/EVA là điểm cộng thẳng, trần nằm ở hàm xác suất. Tốc đánh: `interval ÷ (cùng hệ số)`, sàn `minAttackInterval`. |
| Mood | `× moodStatMult` lên ATK/DEF: 1 khi mood ≥ `moodPenaltyFrac`, giảm tuyến tính tới `moodStatFloor` ở mood 0 | GDD §4.2. `moodStatFloor = 1` là tắt. |

Trần bão hòa: với `defReductionCap = 0.85`, R chạm trần khi `DEF ≥ 0.85/0.15 × (defPerLevel·L + defFlat) ≈ 5.67 × (3L + 35)`, với L là level **hunter đang đánh**: ≈ 400 DEF ở Lv10, ≈ 710 ở Lv30, ≈ 1 900 ở Lv100. Tái sinh đưa level về thấp, nên hunter Lv30 ở Torment I (DEF quái tới ~830) đã có quái chạm trần; khi đó tăng thêm `monsterDefMul` không đổi gì (quái vẫn nhận `(1 − cap) × ATK × G`). Cần design chọn: chấp nhận, hoặc nâng trần / tính DEF quái theo độ khó khác đi.

## 8. Data schema

### 8.1 Pipeline **[CHỐT]**

```
Google Sheets / XLSX (nguồn, team design sửa)
        │  tool: sheets → JSON (validate schema, kiểm tra ID tham chiếu)
        ▼
config/*.json  (build artifact, có version)
        │
        ▼
client load lúc khởi động → bất biến khi chạy
```

- Mỗi bảng có schema (zod hoặc JSON Schema). Build lỗi nếu thiếu cột, sai kiểu hoặc ID tham chiếu không tồn tại.
- Text không nằm trong bảng gameplay: chỉ lưu `nameKey`/`descKey`, text nằm ở bảng `loc` (một cột mỗi ngôn ngữ).
- Danh sách theo level dùng mảng (`[v1, v2, …]`), độ dài phải bằng `maxLevel`.

### 8.2 Bảng gameplay

Kiểu: `id` string, `ref<X>` = id của bảng X, `int[]`/`float[]` = mảng theo level.

| Bảng | Trường chính |
|---|---|
| `class` | id, nameKey, jobTree: ref<job>[9], statRanges: {stat: [[min,max] × 3 grade]}, attackSpeed, growthPerLevel {hp, atk, def} |
| `job` | id, classId, tier, nameKey, unlockLevel, unlockReincarnation |
| `stat_grade` | grade (Normal/High/Highest), point (0/1/2), rollChance |
| `hunter_tier` | tier, minPoints, maxPoints (GDD §4.2) |
| `invitation` | id, tierChances {Legendary…Normal}, cost |
| `personality` | id, nameKey, weight, modifiers: [{target, op, value}] |
| `skill` | id, classId, jobTierMin, maxLevel, cooldown, castType, target, keepTime[], value1[], value2[], studyLevel[], studyCost[], descKey |
| `trait` | id, classId, jobTier, maxLevel, value1Base, value1PerLevel, value2Base, value2PerLevel, pointCost, descKey |
| `gear` | id, slot, classId (hoặc any), level, tier, mainStat, mainValue, secondValue, enhanceCurve[], craftBuilding, materials: [{matId, count}] × quality, priceByQuality[5], setId?, gearSkillId? |
| `gear_option` | id, stat, op, plusRange[min,max], minusRange[min,max], allowedSlots, unique (bool) |
| `gear_set` | id, nameKey, pieces: ref<gear>[], bonus: [{count: 2/4/6, effect, value}] |
| `gear_skill` | id, nameKey, trigger, cooldown, effect, values[] |
| `enhance` | level, successRate, failPenalty (0 hoặc −1 từ +10), cost |
| `material` | id, nameKey, rating, price, zoneIds[], composeTo? |
| `monster` | id, nameKey, race, level, hp, atk, def, exp, gold, drops: [{matId, chance}], zoneIds[] |
| `zone` | id, nameKey, difficultyId, monsterPool: [{monsterId, weight}], waypointNodes[] |
| `difficulty` | id, order, unlock: {hunterCount, reincarnation} (GDD §8), monsterMultiplier |
| `building` | id, nameKey, category (service/craft/buff/core), maxCount, maxLevel, size, buildCost[], upgradeCost: [{gold, mats}] per level, capacity[], output[], requires: {townHallLevel} |
| `service` | buildingId, need (hp/satiety/mood/stamina), restoreAmount[], price[], stockPerCycle[], cycleSec |
| `consumable` | id, nameKey, effect, keepTime[], value[], cooldown, price[], craftMaterials |
| `rune` | id, effect, grades, valueByGrade[], dropChance[] |
| `relic` | id, nameKey, maxLevel, value[], upgradeCost[] |
| `growth_property` | id, stat, valuePerLevel, maxLevel, cost[] |
| `exp_curve` | level, expByReincarnation[6] |
| `bounty`, `raid`, `journey`, `trading_request` | Theo GDD §9; tạo schema khi đặc tả mode chi tiết. |
| `formula_params` | key → number (hệ số công thức combat, ngưỡng AI, tốc độ giảm nhu cầu) |
| `loc` | key, vi, en, … |

### 8.3 Quan hệ ID chính

```
class ─< job
class ─< skill, trait
gear >─ gear_set, gear_skill ; gear ─< materials >─ material
monster >─ zone >─ difficulty ; monster.drops >─ material
building ─< service ; building (craft) ─< gear / consumable
hunter(runtime) → class, job, personality[], gear instances
```

### 8.4 Dùng `data_tables/` thế nào

Các bảng đã trích là **tham chiếu khoảng giá trị và nhịp tiến trình**, ví dụ: biên độ HP/ATK class, độ dốc đường EXP, số món mỗi slot, đường cong giá. Khi điền bảng mới:

1. Đặt tên, nội dung và ID riêng.
2. Chỉnh lại số liệu theo công thức của game mình (vì công thức gốc không có, copy nguyên số cũng không đảm bảo cân bằng).
3. Ghi nguồn tham chiếu của từng bảng trong sheet `_notes`.

## 9. Save và offline progress

- **Save:** toàn bộ `world` serialize JSON + `schemaVersion` + `configVersion`, lưu IndexedDB mỗi 30 s và khi app ẩn. Có migration theo `schemaVersion`.
- **Offline progress [CHỐT]:** không mô phỏng từng tick. Ước lượng theo tốc độ trung bình đo được trong 10 phút gần nhất (gold/s, EXP/s, vật liệu/s theo từng hunter), nhân với thời gian vắng, trần **8 giờ [ĐỀ XUẤT]**. Hiển thị popup tổng kết.
- Journey chạy offline theo thời gian thực (GDD §9), tính kết quả lúc mở game.

## 10. Hiệu năng

| Hạng mục | Giới hạn **[ĐỀ XUẤT]** |
|---|---|
| Hunter tối đa | 60 |
| Quái đồng thời | 300 |
| AI decide/tick | ≤ 15 hunter (chia lô theo id) |
| A*/tick | ≤ 10 |
| Draw call | Instancing cho sprite cùng atlas |
| Truy vấn mục tiêu | Spatial hash theo ô 4×4 đơn vị |

## 11. Telemetry và debug

- Overlay debug: state AI, goal và điểm utility của hunter đang chọn, path, needs.
- Log sự kiện kinh tế (nguồn và đích của gold) để cân bằng.
- Chế độ headless: chạy core 24 giờ game trong vài giây, xuất CSV (gold, level, thời gian trong từng state) để tuning. Hiện có `tools/headless.ts [phút] [seed] [phút/snapshot]`: in timeline vàng Town, số món trong shop, kho, bag, yêu cầu, vàng hunter (tb/max), level tb và sổ thu/chi vàng Town theo từng khoảng (chưa xuất CSV).

## 12. Lộ trình triển khai

| Mốc | Nội dung | Xong khi |
|---|---|---|
| M0 | Skeleton: core loop, config loader, save, debug overlay | Load config, chạy tick, save/load được |
| M1 | 1 Town + 1 zone, waypoint/road, 5 class, needs, AI cơ bản (Hunt/Return/4 dịch vụ) | Hunter tự săn và tự quay về đúng ngưỡng |
| M2 | Shop, craft, gear + quality + enhance, BuyGear/SellMaterials | Vòng săn → bán → craft → mua chạy kín |
| M3 | Skill, trait, level, chuyển nghề, reincarnation, difficulty | Mở được difficulty Normal theo điều kiện GDD §8 |
| M4 | Bounty, Trading Post, Journey, offline progress | QA checklist GDD §13 đạt |
| M5 | UI hoàn chỉnh, localization, tuning bằng headless | Bản chơi thử nội bộ |
| M6 | Online: account, cloud save, IAP; sau đó Raid, PvP, Guild | Theo đặc tả riêng |

## 13. Việc còn mở

- Công thức kinh tế: **TBD**. Công thức combat: có mô hình §7.1 (**[ĐỀ XUẤT]**, chờ design duyệt số).
- Bố cục map (Town, zone, waypoint): cần thiết kế riêng hoặc dùng làm tham chiếu dữ liệu scene khi có.
- Danh sách personality, tên class/job/item/quái của game: do team design đặt.
- Nền tảng phát hành (web, mobile wrapper) và hướng màn hình: chưa chốt (GDD §2).
