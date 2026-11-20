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

Đường dẫn tính từ `game/src/core/`.

| Module | Trách nhiệm |
|---|---|
| `world` | Chứa toàn bộ state: town, hunters, monsters, kho/shop/craft, clock, RNG state. Serializable 100%; `WORLD_SCHEMA_VERSION` (§9). |
| `simulation` | `createWorld`, `Simulation.step()` (thứ tự system §3.2), `advance()` theo thời gian thực. |
| `formulas` | Mọi công thức: chỉ số hiệu dụng, combat (§7.1), chấm điểm vùng (§5.3), giá trị gear/cường hóa (§4.2). |
| `ai/utility` | Hàm thuần chấm điểm goal (§5.2), mua đồ, cường hóa, học (§5.4). |
| `hunterFactory`, `progress` | Roll hunter mới (class, stat grade, tier, personality); `gainExp` (level-up, cộng chỉ số theo `formula_params`, trait point). |
| `pathfinding` | `NavGraph`: waypoint graph + A* có cache (§6). |
| `systems/arrivals` | Hunter mới ghé Town theo thời gian tới khi đủ slot (chưa có invitation). |
| `systems/ai` | Ra quyết định (§5) và backstop khẩn cấp (`urgentBackstopSystem`). |
| `systems/movement` | Đi theo path trên waypoint graph, steering tự do trong zone. |
| `systems/combat` | Target, đòn đánh thường, damage, nhận thưởng kill (EXP/vàng/drop), chết/hồi sinh, xóa quái chết. |
| `systems/skills` | Đếm buff/cooldown, auto-cast tối đa 1 skill/hunter/tick (sau combat). |
| `systems/services` | Dịch vụ Town (Heal/Eat/Fun/Rest), giá `servicePrice`. |
| `systems/economy` | Hành động tại cửa: bán ở Trạm Thu Mua, mua ở Shop, cường hóa ở Forge. |
| `systems/trading` | Yêu cầu vật liệu của Trạm Thu Mua, giá mua (§5.7). |
| `systems/academy` | Học skill (vàng) / trait (trait point). |
| `systems/journey` | Journey (§5.11): gửi đội tối đa 3 hunter đi xa, đếm thời gian (cả offline), roll kết quả, thưởng/hậu quả, đưa đội về Town. |
| `systems/crafting` | Auto-craft/craft thủ công, xếp hàng shop, giảm giá và hủy món tồn. |
| `systems/needs` | Giảm nhu cầu theo thời gian, hồi chậm miễn phí khi rảnh trong Town; kẹp HP ≤ max. |
| `systems/progression` | Chuyển nghề, reincarnation (tự động khi bật), unlock difficulty. EXP/level nằm ở `progress.ts`. |
| `systems/spawn` | Sinh quái theo zone và difficulty hiện tại. |
| `save/` | `serialize`/`deserialize`, migration (§9), storage IndexedDB/memory. |
| `commands` | Lệnh của người chơi/debug (Move, Activities, craft, reincarnate, đổi difficulty, yêu cầu vật liệu…). Xếp hàng, áp dụng đầu `step()` kế tiếp; handler trả lý do khi từ chối. |
| `events` | Event bus một chiều sim → UI/render (hit, kill, levelUp, purchase…) để chơi VFX/âm thanh/toast. Sim không bao giờ đọc lại. |
| `config/` | Schema DSL (`schema.ts`), `TABLE_SPECS` + kiểm tra chéo + index (`load.ts`), kiểu (`types.ts`). |

Bounty: `systems/bounty` (§5.9). Thuế: `systems/tax` (§5.10) — thuế trên vàng rơi từ quái, thu ngay lúc kill. Journey: `systems/journey` (§5.11). Town Hall, xây/nâng building, ô đất, tự đầu tư: `systems/town` (§5.12). Invitation (M5) — xem §12.

### 3.2 Vòng lặp **[CHỐT]**

- Fixed-step simulation: **10 tick/giây** (`dt = 100 ms`). Render nội suy vị trí giữa 2 tick.
- Thứ tự system mỗi tick (`DEFAULT_SYSTEMS` trong `src/core/simulation.ts`):
  `commands → arrivals → ai → movement → combat → skills → urgentBackstop → services → economy → academy → crafting → town → bounty → journey → needs → progression → spawn`, rồi `tick += 1`, `timeMs += dt`, lưu RNG state vào world.
  - `commands`: lệnh enqueue giữa 2 tick được áp dụng đầu `step()`, trước mọi system.
  - `urgentBackstop` chạy lại backstop khẩn cấp của AI (§5.2) **sau combat và skills**, để đòn đánh làm nhu cầu tụt dưới ngưỡng được xử lý ngay trong tick đó (không chờ tick sau).
  - Không có pha `cleanup` riêng: combat xóa quái chết cuối pass của nó. Không có pha `emit events`: event được ghi vào buffer khi phát sinh, client lấy bằng `drainEvents()`.
  - EXP/level-up xảy ra trong combat/skills (`gainExp`); `progression` chạy sau đó trong cùng tick nên một hunter có thể vừa `jobChanged` vừa `reincarnated` trong một tick (vô hại; UI có thể hiện 2 thông báo).
- Tốc độ game x1/x2/x4: chạy nhiều tick trong một frame, không đổi `dt`.
- Mỗi system chỉ ghi vào phần state của nó, đọc phần còn lại. Không dùng singleton toàn cục.

## 4. Mô hình thực thể

### 4.1 Hunter (runtime)

Theo `interface Hunter` trong `src/core/world.ts` (world v6).

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `id` | string | |
| `classId`, `jobTier` | ref, int | Bậc nghề theo `job.json` (thiết kế: 9 bậc; config hiện có 3 bậc 0..2 mỗi class). |
| `tier` | `normal`/`rare`/`superior`/`heroic`/`legendary` | Theo điểm G = N_high + 2 × N_highest (GDD §4.2, `tierFromPoints`). |
| `statGrades` | map stat → `normal`/`high`/`highest` | Roll lúc sinh hunter. |
| `stats` | hp, atk, def, eva, crit, atkSpeed | Chỉ số gốc = roll + cộng theo level (`levelHpGain/AtkGain/DefGain`), **chưa** gồm gear/job/trait/buff; giá trị hiệu dụng lấy qua `formulas.hunterStats()`. |
| `rollStats` | như `stats` | Roll gốc ở level 1; reincarnation đặt lại `stats = rollStats`. |
| `level`, `exp`, `reincarnation` | int | |
| `needs` | hp, satiety, mood, stamina (0..max) | |
| `gold` | int | Tiền riêng của hunter; dùng để mua đồ, dịch vụ, cường hóa, học. |
| `equipment` | slot → GearInstance | 3 slot hiện tại: `weapon`, `armor`, `accessory` (GDD §6 có 7). |
| `bag` | map materialId → số lượng | Sức chứa = `formula.bagCapacity` (tổng số đơn vị). Chưa có potion. |
| `skills`, `skillCdMs`, `buffs` | map skillId → level, map → ms còn lại, list buff | |
| `traits`, `traitPoints` | map traitId → level, int | |
| `personalities` | list ref | Số lượng = `formula.personalitiesPerHunter`; hệ số chỉnh hành vi (§5.5). |
| `ai` | `{goal, phase: travel/act, path, decideInMs, targetMonsterId, moveTo, forced}` | `forced` = goal do lệnh người chơi. |
| `position`, `nodeId`, `insideBuildingId` | | Zone hiện tại suy ra từ `nodeId` (node field có `zoneId`). |
| `attackCdMs`, `deadMs`, `kills`, `arrivedAtMs` | | `deadMs > 0` = đang chết, đếm tới hồi sinh. |

### 4.2 GearInstance

Thiết kế đầy đủ: `{ gearId, quality (Common..Mythic), enhanceLevel, tier, options: [{optionId, value}], setId?, gearSkillId?, runes[] }`.

Đã làm (M2): `GearInstance = { uid, gearId, qualityId, enhance }`; món đang bán là `ShopItem` thêm `price`, `listPrice`, `listedAtMs` (world v5). Options, set, gear skill, rune chưa làm.

- Chỉ số chính (`formulas.gearMainValue`): `mainValue(gear) × statMult(quality) × (1 + enhance × enhanceStatPerLevel)` — enhance cộng tuyến tính theo % của giá trị gốc.
- Cường hóa (`systems/economy.ts`, `doEnhance`): bước lên `+n` dùng dòng `enhance[n−1]` trong `enhance.json` (`successRate`, `costFrac`, `dropOnFail`). Phí = `round(basePrice × costFrac)`, hunter trả đủ, Town nhận `round(phí × feeTownShare)`, phần còn lại ra khỏi nền kinh tế (gold sink). Thành công → `enhance + 1`; thất bại và `dropOnFail` và `enhance > 0` → `enhance − 1`. AI chọn khi nào cường hóa theo kỳ vọng (§5.4).

## 5. AI hunter

### 5.1 Mô hình **[CHỐT]**

**Utility AI kết hợp state machine:**

- *State machine* lo phần **thực thi** một mục tiêu: `Idle → Travel → Act → Done`.
- *Utility* lo phần **chọn mục tiêu**: mỗi lần cần quyết định, chấm điểm tất cả goal khả dụng rồi chọn điểm cao nhất (có nhiễu nhỏ để hunter không đồng bộ).
- Quyết định lại khi: xong goal, có ngưỡng khẩn cấp bị vượt, có command của người chơi, hoặc mỗi **3 s** khi đang săn **[ĐỀ XUẤT]**.
- Trong code (`systems/ai.ts`): state machine là `ai.phase` = `travel` (đi theo `path`) → `act` (làm goal tại đích); `goal = null` là Idle, quyết định ngay ở tick sau. Định kỳ quyết định lại mỗi `decisionIntervalSec` chỉ khi đang `act` với goal `hunt`/`wander` và goal không bị ép (`forced`). Nhiễu: cộng `rng.range(0, decisionNoise)` vào từng điểm. Goal sell/shop/enhance/learn/service do system tương ứng thực hiện tại cửa rồi xóa goal.

### 5.2 Danh sách goal

Theo `scoreGoals` trong `src/core/ai/utility.ts`. Điểm không chuẩn hóa về 0..1: goal kinh tế cố ý > 1 để thắng `Hunt` (fit ≤ 1) khi khả dụng. `needsOk` = 0 khi có nhu cầu khẩn cấp, 1 khi mọi nhu cầu ≥ ngưỡng mềm, tuyến tính ở giữa (nhu cầu tệ nhất quyết định). `econMul = max(needsOk, 0.5)`.

| Goal (`Goal.type`) | Điều kiện khả dụng | Điểm |
|---|---|---|
| `hunt(zone)` | `fit > 0` (§5.3) | `fit × needsOk × personality(goal.hunt) × hệ số yêu cầu vật liệu (§5.3)`, `+ huntStickiness` nếu đang săn đúng zone đó |
| `returnTown` | Đang ở field | `max(1 − needsOk, bagScore)`; `bagScore = 1.2` khi bag ≥ `bagReturnFrac` và Trạm Thu Mua sẽ mua hoặc nhận bỏ ít nhất 1 đơn vị |
| `service(building)` — Heal/Eat/Fun/Rest | Ở Town, nhu cầu < 98%, đủ vàng cho `servicePrice` | `frac < softNeedFrac ? 0.6 + 0.4 × (1 − frac) : 0.5 × (1 − frac)`, × `personality(goal.service.<need>)` |
| `sell` | Trạm Thu Mua sẽ trả tiền cho ít nhất 1 đơn vị trong bag (xem §5.7), hoặc bag ≥ `bagReturnFrac` và có NL không được yêu cầu (đi bỏ) | `(0.4 + bagFill) × econMul` |
| `shop(item)` | `bestShopPurchase` (§5.4) | `(1.1 + 0.5 × min(gain, 1)) × econMul` |
| `enhance(slot)` | `bestEnhance` (§5.4) | `(enhanceBaseScore + enhanceGainWeight × expectedRelGain) × econMul` |
| `learn(skill/trait)` | `bestLearn`: skill rẻ nhất học được khi vàng dư ≥ phí × `enhanceGoldReserveMul` (level 1 giữ lại vàng khởi điểm); không có thì trait theo thứ tự ưu tiên | skill `1.15 × econMul`, trait `1.2 × econMul` |
| `wander` | Ở Town (fallback) | `max(wanderScore, 0.5 × (1 − needsOk))`; rảnh trong Town hồi nhu cầu chậm miễn phí (`townIdleRegenPerSec`) nên hunter hết tiền không bị kẹt |
| `dead` | Gán khi chết, không chấm điểm | |

Chưa làm: `BuyPotion` (chưa có potion), `Train` (chưa có Training Ground).

**Nhu cầu khẩn cấp** (backstop cứng, ép `returnTown`) **[ĐỀ XUẤT]**: nhu cầu < `urgentHpFrac`/`urgentSatietyFrac`/`urgentMoodFrac`/`urgentStaminaFrac` (hiện 25% / 10% / 10% / 10%), mỗi ngưỡng × `personality(urgent.<need>)` (ví dụ liều lĩnh ×0.5 HP); với HP, ngưỡng = max(ngưỡng theo tính cách, sàn rút lui) — xem **Rút lui** bên dưới. **[CHỐT]** `applyUrgentBackstop` chỉ bắn khi hunter còn sống, ở field (node có zone), không ở trong building và chưa có goal `returnTown`; nó **ghi đè cả lệnh của người chơi** (`forced`). Chạy ở đầu pass AI và chạy lại trong `urgentBackstopSystem` ngay sau combat + skills (§3.2).
**Nhu cầu mềm** (`softNeedFrac`, hiện 40%): kéo `needsOk` xuống, tức giảm điểm `hunt` và tăng `returnTown`; với HP, cả dải khẩn cấp→mềm dời lên đúng phần sàn rút lui vượt ngưỡng khẩn cấp. Ở field, ngưỡng mềm cũng nhân hệ số personality (tối đa `softNeedFrac`) để hunter liều lĩnh đánh tiếp; ở Town thì không, để hunter vừa hồi sinh vẫn đi chữa trước.

Điểm goal ở Town (`shop`, `sell`, `enhance`, `learn`, dịch vụ, nghỉ) dùng hệ số trong `formula_params.json` (`shopBaseScore`, `enhanceBaseScore`, `learnSkillScore`, `serviceLowBase`…), xem chú thích trong `src/core/config/types.ts`.

**Rút lui** **[ĐỀ XUẤT]** (`src/core/ai/utility.ts`). Hunter chết chủ yếu lúc rút khỏi vùng khi quái đang đánh, không phải ở các vùng dưới trên đường về; rút giữa hai trận gần như không mất máu.

```
zoneDanger(z)   = zoneCrowd × Σ_w (monsterDps, dmgPerKill) / Σ_w        (duel §5.3, chỉ số steady)
tripHome        = Σ_vùng trên đường về (độ dài đường trong vùng / moveSpeed) × zoneDanger.dps
                  (mỗi đoạn tính nửa cho vùng của mỗi đầu; node Town không có vùng → 0)
sàn rút lui     = min(retreatHpCap, retreatTripMul × tripHome / HP tối đa)   (0 ở Town)
ranh giới kill  : không quái nào đang đánh hunter, chọn mục tiêu mới →
                  về ngay nếu HP − retreatKillMul × dmgPerKill/HP tối đa < max(ngưỡng khẩn cấp HP, sàn rút lui)
chọn vùng khác  : needsOk tính với ngưỡng = max(ngưỡng khẩn cấp HP, sàn rút lui ở entryNode) + retreatKillMul × dmgPerKill/HP tối đa
                  → không đi tới vùng mà phải quay về ngay ở ranh giới kill đầu tiên
```

- `retreatTripMul` = 3 phủ phương sai đo được (HP mất / dự đoán: p50 ≈ 1, p90 ≈ 1,9, p99 ≈ 2,7). Sàn **không** nhân hệ số tính cách: Liều lĩnh vẫn đánh tới 12,5% ở vùng dễ, nhưng không bắt đầu một chuyến về chết người.
- Ranh giới kill không áp dụng cho lệnh Move của người chơi (`ai.forced`); backstop khẩn cấp (kèm sàn) vẫn áp dụng.
- Backstop chạy mỗi tick nên sàn chỉ được tính khi HP nằm giữa ngưỡng khẩn cấp theo tính cách và `retreatHpCap`; độ dài đường theo vùng được cache theo NavGraph.
- `retreatHpCap` = 0 và `retreatKillMul` = 0 tắt hẳn rút lui (hành vi như trước).

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

### 5.4 Mua đồ và cường hóa

**Mua đồ** (`bestShopPurchase`, thực hiện ở `economy.doShop`):

- `gain = (gearMainValue(mới) − slotValue(cũ)) / max(slotValue(cũ), 1)` — so chỉ số chính của gear cùng slot, **chưa** có trọng số theo class.
- Chỉ mua khi `gain ≥ minUpgradeGain`, level hunter ≥ level gear và `giá ≤ gold × spendRatio × personality(spendRatio)` **[ĐỀ XUẤT]**. Nhiều món đạt: `min(gain, 1)` cao nhất, hòa thì giá thấp hơn, rồi `uid`.
- Đồ cũ bị bỏ (không bán lại, không vào kho). HP hiện tại không được hồi khi max HP tăng.

**Cường hóa theo kỳ vọng** (`bestEnhance` trong `ai/utility.ts`; thực thi và luật thành/bại ở §4.2). Với mỗi slot có gear, `p = successRate` của bước kế, `step` = chỉ số chính tăng thêm nếu thành công, `loss` = chỉ số mất nếu thất bại (chỉ khi `dropOnFail` và `enhance > 0`):

```
khả dụng      : p ≥ ENHANCE_MIN_SUCCESS
                và gold ≥ phí × enhanceReserveMul(p) + upgradeSavings(slot)
enhanceReserveMul(p) = enhanceGoldReserveMul / p^ENHANCE_RISK_EXP      (bước rủi ro cần nhiều vàng dư hơn)
upgradeSavings(slot) = khi có gear cùng slot đeo được với giá trị (chất lượng điển hình) ≥ hiện tại × (1 + minUpgradeGain):
                       UPGRADE_SAVINGS_FRAC × basePrice × TYPICAL_QUALITY_MULT / (spendRatio × personality) nhỏ nhất; ngược lại 0
                       (không đánh bóng món sắp thay, giữ vàng cho lần mua)
chọn slot     : p × step / phí lớn nhất (chỉ số kỳ vọng trên mỗi vàng); hòa → thứ tự GEAR_SLOTS
expectedGain  = p × step − (1 − p) × loss;  expectedRelGain = expectedGain / max(giá trị hiện tại, 1)
điểm goal     = (ENHANCE_BASE_SCORE + ENHANCE_GAIN_WEIGHT × expectedRelGain) × econMul      (§5.2)
```

Lưu ý: chọn slot dùng kỳ vọng **không** trừ `loss`, còn điểm goal dùng `expectedGain` đã trừ `loss`. Các hằng `ENHANCE_*`, `UPGRADE_SAVINGS_FRAC`, `TYPICAL_QUALITY_MULT` đang là hằng số trong `ai/utility.ts`, **chưa** nằm trong `formula_params.json` (trái với mục tiêu data-driven §1; nên chuyển khi design chốt).

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
- **Đòn bẩy phụ**: `servicePriceLevelPct` + `servicePriceLatePct`/`servicePriceLateLevel` (giá dịch vụ = `round(base × (1 + pct/100 × (level − 1) + latePct/100 × max(0, level − lateLevel)))`, một hàm `servicePrice` dùng chung cho system, AI và lệnh; phần dốc chỉ từ `lateLevel` để không đổi nhịp đầu game), `tradeSaleTax` (mặc định 0; Town trả đúng số hunter nhận nên chỉ là chuyển giao, không đốt vàng), `craftAffordFrac`. Giá giảm khi kho dư không cần nữa vì kho chỉ nhận phần được yêu cầu.
- **Ngân khố Town** (`trading.ts` `townGoldTarget`/`townFeeShare`): mục tiêu = `max(feeTownTargetMin, feeTownTargetMul × autoCraftReserve)`. Khi vàng Town ≤ mục tiêu, Town nhận `feeTownShare` của phí Lò Cường Hóa / Học Viện; trên mục tiêu, nhận `feeTownShare × mục tiêu / vàng Town` (phần còn lại rời nền kinh tế). Đây là lực kéo vàng Town về một dải: trên sàn surplus Trạm đã mua hết NL vượt yêu cầu, nên nếu không có quy tắc này mọi khoản thu (phí + dịch vụ + shop) vượt chi mua NL đều dồn lại. Đặt cả hai khóa = 0 để quay về tỉ lệ cố định. Sổ thu/chi để tuning: `tools/headless.ts` (in thêm vàng rơi từ quái, tiền cường hóa/học, vàng bị đốt, tổng vàng, vàng Town thấp nhất; `HEADLESS_FP="key=value,..."` ghi đè hệ số).

### 5.8 Shop: auto-craft và giảm giá (GDD §6) **[ĐÃ LÀM]**

Code: `src/core/systems/crafting.ts`, tham số trong `formula_params.json`.

- **Giảm giá**: món chưa bán cứ mỗi `shopStaleSec` giảm `shopMarkdownPct`% giá niêm yết, không dưới `round(listPrice × shopMarkdownFloor)`. Giá tính lại từ tuổi món mỗi tick (idempotent, an toàn với save).
- **Bỏ món**: tuổi bỏ = `shopScrapAgeSec` = `ceil((1 − floor) × 100 / pct)` bước × `shopStaleSec` + `shopFloorHoldSec` (không dùng `shopScrapSec` nữa) → giá luôn chạm sàn và được chào ở giá sàn `shopFloorHoldSec` giây trước khi bị bỏ (không hoàn tiền, event/stat `gearScrapped`). `shopFloorHoldSec` < 0 = không bao giờ bỏ. Mặc định 600 s / 10% / 0,5 / 600 s → 100→50% trong 3.000 s, bỏ lúc 3.600 s. `config:check` kiểm tra `shopStaleSec` ≥ 1, `shopMarkdownPct` trong (0, 100], `shopMarkdownFloor` trong [0,01; 1] và từ chối key cũ `shopScrapSec`.
- **Chọn công thức auto-craft** (`pickRecipe`): trong các công thức có đủ NL và vàng Town ≥ giá craft + `autoCraftReserve`, chọn cái có nhiều người hưởng lợi nhất (`recipeBeneficiaries`), rồi gear level cao hơn, rồi gearId; 0 người → không chế.
- **Người hưởng lợi**: hunter level ≥ gear.level − `craftLevelAhead`; với mỗi chất lượng q, bản q được tính nếu là nâng cấp ≥ `minUpgradeGain` (công thức như AI mua đồ) **và** ngân sách shop ≥ `craftAffordFrac × round(basePrice × q.priceMult)`; hunter được tính khi tổng `craftChance` (chuẩn hóa) của các bản đó ≥ `craftMinSellChance` (0,65 = Uncommon trở lên phải bán được; 0,35 = chỉ cần Rare, gần quy tắc cũ — trùng hẳn khi `craftAffordFrac` = 0). Ngưỡng so với tỷ lệ cộng dồn của `craftChance`, nên đổi `gear_quality.json` thì phải xem lại.
- **Đồ đã có**: món cùng slot, level ≤ công thức đang bán (chất lượng thật) hoặc đang chế (chất lượng tham chiếu Rare) tính theo **số bản**: hunter vẫn được nâng cấp so với món tốt nhất trong số đó luôn được tính; hunter mà món có sẵn đã phục vụ chỉ được tính phần vượt quá số bản.

### 5.9 Bounty (GDD §9) **[ĐÃ LÀM — số liệu ĐỀ XUẤT]**

Code: `src/core/systems/bounty.ts` (hook duy nhất trong combat: `grantKill` gọi `bountyOnKill`), lệnh trong `commands.ts`, tham số `bounty*` ở cuối `formula_params.json`. World v7: `town.bounties` (theo thứ tự đặt), `town.autoBounty`, stat `bountiesPosted` / `bountiesCompleted` / `bountyGoldPaid` / `bountyKingdomGold`.

- **Đặt bounty** (`town.postBounty { targetKind: 'monster' | 'zone', targetId, kills, reward }`): mục tiêu là một loại quái (giết ở đâu cũng tính) hoặc một vùng (mọi kill trong vùng). Từ chối: quái lạ / quái không sinh ở vùng nào, vùng lạ, `targetKind` sai, `kills` không phải số nguyên 1..`bountyMaxKills`, `reward` không nguyên hoặc < `kills` (≥ 1 vàng/kill), `reward` > vàng Town, đã có `bountyMaxActive` bounty. `town.cancelBounty { bountyId }` hủy và hoàn phần ký quỹ còn lại; `town.setAutoBounty { on }`.
- **Ký quỹ**: `reward` rời vàng Town ngay khi đặt và nằm trên bounty (`escrow`), nên vàng Town + ký quỹ + vàng hunter bảo toàn trong lúc chạy.
- **Thưởng theo kill**: kill thứ k của mục tiêu trả cho người giết `floor(reward·k/kills) − floor(reward·(k−1)/kills)` (tổng đúng bằng `reward`). Một kill chỉ tính cho bounty khớp **đầu tiên** (không trả đôi).
- **Hoàn thành** — "Town nhận vàng" nghĩa là: vương quốc trả Town `round(reward × bountyCompletionFrac)` (0,25) — vàng mới, nhỏ hơn `reward`, nên mỗi bounty là khoản chi ròng `(1 − 0,25) × reward` của Town chảy sang hunter. Event `bountyCompleted { kingdomGold }`.
- **Torment**: kill mục tiêu bounty có quái sinh ở độ khó `order ≥ bountyTormentFromOrder` (5 = Torment 1) tung tỉ lệ rơi `min(1, chance × (1 + bountyTormentDropBonus × tier))`, `tier = order − bountyTormentFromOrder + 1` (0,25 → T1 ×1,25, T3 ×1,75). Dùng độ khó lúc quái sinh (`m.difficultyId`). Số lần rút RNG không đổi.
- **AI** (§5.3): trong `huntZoneMuls`, hệ số thô của mỗi vùng khả dụng nhân thêm `1 + bountyZoneBonus × tỉ lệ trọng số spawn là mục tiêu` (1 cho bounty vùng) **trước** bước chia cho max, nên điểm săn cao nhất không bao giờ tăng và vùng fit = 0 không bao giờ được cộng.
- **Bounty tự động** (`town.autoBounty`, mặc định bật; một cái một lúc): mỗi `bountyAutoIntervalSec` (60 s, theo `world.tick`), nếu vàng Town > `bountyAutoGoldMul × townGoldTarget` (§5.7) thì đặt bounty `bountyAutoKills` (30) kill với thưởng `round(bountyAutoRewardFrac × (vàng − mục tiêu))` (0,1) lên loại quái mà hunter đang săn (goal `hunt`) có giá trị NL rơi đang được yêu cầu cao nhất (hòa: vùng nhiều hunter hơn, trọng số spawn cao hơn, thứ tự config); bỏ qua mục tiêu đã có bounty. Hết `bountyAutoExpireSec` (1.800 s) thì hết hạn và hoàn ký quỹ (`bountyCancelled { reason: 'expired' }`). Bounty của người chơi không hết hạn. Không rút RNG; tắt auto-bounty thì mô phỏng giống từng byte như trước khi có bounty.
- **Event**: `bountyPosted`, `bountyProgress` (mỗi kill, kèm vàng trả), `bountyCompleted`, `bountyCancelled`. Debug overlay hiện bounty đang chạy (tiến độ, ký quỹ, nút hủy) và nút bật/tắt tự động; `tools/headless.ts` in sổ bounty mỗi mốc (đặt / xong / ký quỹ / hoàn / trả / vương quốc / đang giữ), tính ký quỹ vào `total`, và in bounty đang chạy cuối run.
- **Số đo** (headless 12 giờ, seed 1–5, trước → sau, `bountyAutoRewardFrac` 0,1): vàng Town lúc 12 giờ 22,3–27,6k → 23,0–26,5k; vàng hunter tb 5,5–6,8k → 6,0–6,7k; shop 6–9 → 3–11 món; Lv tb 83,1–86,6 → 82,1–85,9; chết (tổng 5 seed) 6 → 11, nhưng seed 6–10 là 9 → 4, tức 15 → 15 trên 10 seed (`bountyZoneBonus` 0: 5 trên seed 1–5); 45–61 bounty xong / 12 giờ, trả hunter 21–33k, vương quốc 4,7–7,9k. Các khác biệt nằm trong nhiễu giữa các seed (mỗi seed chạy 1 lần, phân kỳ hỗn loạn); tắt auto-bounty thì timeline và hunter cuối run giống từng dòng với trước. Với 0,2: vàng hunter tb lúc 12 giờ 5,9–7,8k (4/5 seed cao hơn), nên chọn 0,1. Bounty **không** kéo vàng Town xuống thấp hơn đáng kể: quy tắc ngân khố (§5.7) bù lại (Town nghèo hơn → giữ nhiều phí hơn), nên tác dụng thực là chuyển phần phí lẽ ra bị đốt sang hunter + một chút vàng vương quốc. Torment cần 5 lần tái sinh (~13 giờ+), headless 12 giờ không tới; chỉ có unit test.

### 5.10 Thuế Town (M4) **[ĐÃ LÀM — số liệu ĐỀ XUẤT]**

Code: `src/core/systems/tax.ts` (hook duy nhất: `combat.grantKill` gọi `grantKillGold` thay cho `h.gold += gold`, nên kill bằng skill cũng bị thu), lệnh `town.setTaxRate { rate }` trong `commands.ts`, tham số `tax*` ở cuối `formula_params.json`. **Không tăng schema**: `town.taxRate` và stat `taxCollected` là field tùy chọn (thiếu = `taxRate` của config / 0), save cũ load bình thường.

- **Thu gì**: chỉ **vàng rơi từ quái**, ngay lúc kill. Đây là nguồn vàng duy nhất đi vào nền kinh tế từ bên ngoài (ngoài vàng vương quốc trả khi xong bounty, vốn đã vào Town). Tiền bán NL ở Trạm Thu Mua (đã có `tradeSaleTax`) và thưởng bounty (trả từ ký quỹ của Town) đều là vàng của Town, đánh thuế chỉ là Town tự trả mình ít đi. Thu lúc kill: không cần lưu "nợ thuế" trên hunter, không phụ thuộc lúc về Town, không rút RNG.
- **Công thức**: `tax = floor(vàng kill × rate)`, hunter nhận phần còn lại, vàng Town + tax (tổng vàng không đổi; vàng vẫn là số nguyên). Kill < `1 / rate` vàng không mất gì (ở 10%: quái < 10 vàng, tức đầu game gần như miễn thuế). `rate = town.taxRate ?? taxRate`, kẹp trong [`taxMinRate`, `taxMaxRate`].
- **Lệnh** `town.setTaxRate { rate }`: từ chối không phải số hữu hạn (`invalid rate`), < `taxMinRate` (`rate below minimum`), > `taxMaxRate` (`rate above maximum`). Event `taxRateChanged`. `config:check` yêu cầu `taxMinRate ≤ taxRate ≤ taxMaxRate` trong [0, 1].
- **Cái giá của thuế cao**: mỗi kill **có bị thu** (tax > 0) làm người giết mất `taxMoodPerKill × max(0, rate − taxMoodFreeRate) × personality(decay.mood)` mood. Mood chỉ tác động qua việc hunter phải về Tavern sớm/nhiều hơn (`moodDecayPerSec` = 0, `moodStatFloor` = 1), tức tốn thời gian và vàng ở Town, săn ít hơn. Tại/dưới `taxMoodFreeRate` (= mặc định 10%) không mất gì nên mặc định không đổi nhịp.
- **Event/stat**: `taxCollected { hunterId, gold }` mỗi kill bị thu (không hiện trong log overlay), stat `taxCollected`. Debug overlay: dòng thuế (tỉ lệ, đã thu, mood/kill) và nút −5% / +5%. `tools/headless.ts` in cột `tax` trong sổ Town (trừ khỏi phần dư `fees`) và cộng lại vào `hunter kill` (vàng kill trước thuế).
- **Mặc định**: `taxRate` 0,1, `taxMinRate` 0, `taxMaxRate` 0,5, `taxMoodFreeRate` 0,1, `taxMoodPerKill` 10.
- **Số đo** (headless 12 giờ, seed 1–5, trước → sau với 10%): vàng Town lúc 12 giờ 23,0–26,5k → 21,5–26,9k; vàng hunter tb 6,0–6,7k → 5,9–7,6k, max 7,6–12,5k → 9,0–14,3k; Lv tb 82,1–85,9 → 79,6–85,3; shop 3–11 → 5–8 món; chết tổng 11 → 7 (seed 6–10: 4 → 11; 10 seed 15 → 18). Trung bình 10 seed: Lv 84,8 → 84,8, vàng hunter tb 7,0k → 7,2k — trong nhiễu. Thu 27,9–34,4k / 12 giờ (≈ 9% vàng kill; vàng kill chỉ ≈ 1/3 thu nhập hunter, phần lớn là tiền bán NL). `taxRate` 0 cho kết quả giống từng byte với trước. Thuế cao (seed 1–2): 30% → vàng Town 29,5/33,3k, vàng hunter tb 5,7/4,6k, Lv 83,0/78,8, lượt dịch vụ +9/+13%, kill −2/−3%; 50% → 28,5/39,3k, 5,6/3,9k, Lv 80,8/77,3, dịch vụ +19/+15%, kill −3%. (`taxMoodPerKill` 2 thì ở 50% không đo được khác biệt dịch vụ/level, nên chọn 10.)
- **Lưu ý**: khi vàng Town đang trên mục tiêu ngân khố (§5.7), thu thêm bị quy tắc ngân khố bù lại (Town giữ ít phí hơn, phần còn lại bị đốt), nên ở 10% thuế thực chất là **chỗ tiêu vàng hunter**, không làm Town giàu hơn. Thuế chỉ thành thu nhập thật của Town khi Town dưới mục tiêu — tức khi có chỗ tiêu vàng Town ra khỏi nền kinh tế (xây/nâng building). Khi đó tăng `taxRate`/`town.setTaxRate` là đòn bẩy.

### 5.11 Journey (GDD §9) **[ĐÃ LÀM — số liệu ĐỀ XUẤT]**

Code: `src/core/systems/journey.ts` (system `journey` chạy sau `bounty`, trước `needs`), `formulas.ts` (`zonePower`, `teamPower`, `journeySuccessChance`), lệnh trong `commands.ts`, bảng `config/journey.json`, tham số `journey*` ở cuối `formula_params.json`. World v9: `world.journeys` (theo thứ tự xuất phát), stat `journeysStarted` / `journeysSucceeded` / `journeysFailed` / `journeysRecalled` / `journeyGold`.

- **"3 NPC" = 3 slot hunter mỗi chuyến**: người chơi gửi một đội 1..`journeyTeamMax` (3) hunter **của Town** (không phải NPC riêng); tối đa `journeyMaxActive` (2) chuyến cùng lúc. Cách hiểu này dùng lại toàn bộ chỉ số/đồ/level của hunter làm "sức mạnh đội" và tạo đánh đổi: hunter đi xa thì không săn, không mua đồ.
- **Lệnh** `journey.start { journeyId, hunterIds }`. Từ chối (`commandRejected`): điểm đến lạ, đội rỗng / > `journeyTeamMax` / không phải mảng, trùng hunter, hunter lạ, đang đi chuyến khác, đã chết, đang trong building, **không ở Town** (node có zone — gọi về Town bằng Move trước), đã đủ `journeyMaxActive`, vàng Town < `cost`. `journey.recall { journeyUid }` gọi đội về ngay: không thưởng, không hoàn `cost`.
- **Vắng mặt**: lúc xuất phát hunter được **chuyển ra khỏi** `world.hunters` vào `journey.hunters` (AI reset, buff xóa, quái đang nhắm thì bỏ). Vì vậy không system nào (AI, di chuyển, combat, nhu cầu, tái sinh, AI chấm vùng/bounty, offline theo tốc độ) đụng tới họ: nhu cầu, level, vị trí **đóng băng**. Họ vẫn giữ slot (`townHunterCount` cho arrivals và `debug.spawnHunter`), vẫn được tính khi mở khóa độ khó (`allHunters`). Mọi lệnh theo hunter (Move, Activities, tái sinh, debug hồi/xóa) bị từ chối với lý do `hunter is on a journey`.
- **Sức mạnh đội** (từ chính mô hình combat §5.3/§7.1, không có chỉ số mới):
  ```
  zonePower(h)   = √(killsPerLife(h, vùng của điểm đến, độ khó Town lúc xuất phát) / zoneRefKills)   (= powerRatio của AI, chỉ số steady)
  teamPower      = Σ zonePower(thành viên)
  successChance  = clamp(journeySuccessAtRec × (teamPower / recommendedPower)^journeySuccessExp, journeySuccessMin, journeySuccessMax)
  ```
  powerRatio tuyến tính theo chỉ số nên n hunter giống nhau = n× (như một hunter có n× DPS và n× HP). `recommendedPower` 3,5 = "ba hunter mỗi người thoải mái ở vùng đó" → 0,75. Mặc định 0,75 / mũ 2 / [0,05; 0,95]: ½ đề xuất → 19 %, 0,8× → 48 %, 1,13× → 95 %. Sức mạnh và tỉ lệ được **chụp lúc xuất phát** (lưu trong journey).
- **Thời gian**: `remainingMs` giảm theo thời gian game mỗi tick; khi tắt game giảm theo **thời gian thực** (xem §9). Về 0 thì **roll kết quả bằng RNG của sim** (`rng.next() < successChance`, rồi khi thành công mỗi dòng `rare` một lần `rng.chance`). Không có chuyến nào thì system không rút RNG, không phát event: headless/hash world giống từng byte với trước (đã kiểm: hash world + event mỗi phút 90 phút seed 1–2; output `tools/headless.ts` 120 phút chỉ khác thêm 5 khóa stat).
- **Thưởng** (bảng `journey`): thành công → `gold` vào Town, `exp` mỗi thành viên (qua `gainExp`, có trần level; cả hai × `rewardMul` của độ khó lúc xuất phát), `materials` đi theo **luật yêu cầu của Trạm Thu Mua** §5.7 (`routeRewardMaterials`, không rút RNG): phần được yêu cầu (`materialDemand` lúc về: tự động + người chơi; yêu cầu người chơi bị trừ như khi bán) vào kho, phần còn lại Town **bán xuất khẩu ngay** với `surplusPrice` (cộng vào `rewards.gold`/`journeyGold`, không cần ngân sách dư vì Town không trả gì; ghi ở `rewards.exported`) — kho không bao giờ giữ NL không ai yêu cầu, giống NL hunter bán, `rare` (gear + chất lượng + tỉ lệ): trúng thì bày lên shop như đồ vừa chế; shop đầy thì Town bán ngay với giá sàn `round(giá × shopMarkdownFloor)`. Thất bại → chỉ `round(exp × failRewardFrac)`, HP về ≤ `failHpFrac` × max. Cả hai trường hợp satiety/mood/stamina về ≤ `journeyReturnNeedFrac` (0,5) × max nên đội về sẽ đi dịch vụ. Thành viên về **quảng trường**, AI mới, nối vào cuối `world.hunters`.
- **Tái sinh**: hunter đang đi không tái sinh (không nằm trong `world.hunters`); EXP thưởng có thể đưa lên max level, rồi `progression` tự tái sinh khi đã về Town. Lệnh tái sinh thủ công bị từ chối khi đang đi.
- **Event**: `journeyStarted` (sức mạnh, tỉ lệ, phí), `journeyCompleted { success, successChance, rewards: { gold, exp, materials, items }, offline }`, `journeyRecalled`. Debug overlay: khối "Hành trình" (chuyến đang chạy: thời gian còn, sức mạnh, %, nút gọi về; mỗi điểm đến: đề xuất, thời gian, phí, thưởng, xem trước % cho đội đã chọn bằng nút "+đội" ở từng hunter hoặc đội 3 mạnh nhất ở Town, nút gửi). `tools/headless.ts` với `HEADLESS_JOURNEY="journeyId@phút[xN],..."` gửi 3 hunter mạnh nhất đang ở Town (`bestJourneyTeam`) và in nhật ký chuyến + chuyến đang chạy.
- **Số đo** (headless 600 phút seed 1, `journey.mossway@20x4, emberglow@150x3, saltdeep@420x2`): đội Lv5–7 vào Lối Rêu Cũ sức 2,9–3,8 (53–87 %), Lv10 4,7 (95 %); Đèo Than Hồng xuất phát được lúc 230 phút (cần 3 hunter cùng ở Town) với đội Lv39–46 sức 6–8 (95 %); Vực Muối Lặng đội Lv58–63 sức 3,5 (72 %), Lv65–69 4,1 (95 %). Thưởng EXP đặt ≈ 1–1,2× EXP săn cùng thời gian ở mốc level đó (bù việc không săn; **ước lượng** từ nhịp level ghi ở TODO §3, chưa đo trực tiếp), vàng là tiền mới vào Town (lớn hơn `cost`). Chưa tune kỹ; cần design chốt.

### 5.12 Town Hall và building (GDD §5) **[ĐÃ LÀM — số liệu ĐỀ XUẤT]**

Code: `src/core/systems/town.ts` (system `town` chạy sau `crafting`, trước `bounty`), effect nối vào `services.ts`, `crafting.ts`, `trading.ts`, `academy.ts`, `economy.ts` (cường hóa), `ai/utility.ts`, `systems/ai.ts` (cửa building). Config: `building.json` (loại building, mảng theo level), `building_plot.json` (ô đất), tham số `townInvest*`/`invest*`/`build*` ở cuối `formula_params.json`. World v8: `town.buildings`, `town.autoInvest`, `town.investPlan`, stat `buildingsBuilt`/`buildingUpgrades`/`investGold`/`investMaterials`/`investImportGold`.

- **Mô hình**: `building` = **loại** (không còn vị trí); mảng theo level dài `maxLevel` (§8.1), phần tử i = level i+1. `upgradeCost[i] = {gold, materials, sec}` là giá để lên level i+1 (`upgradeCost[0]` = giá xây). `building_plot` = ô cố định trên map với **node cửa riêng** (`doorNode`), `townHallLevel` mở ô, `startBuilding`/`startLevel` = building có sẵn trong game mới. `world.town.buildings[]` = building đang đứng trên ô (id = id ô, theo thứ tự ô trong config), `level` (0 = đang xây lần đầu, chưa dùng được), `upgrade` đang chạy. **Mỗi loại tối đa 1 bản** nên các system vẫn gọi building theo id loại.
- **Nav graph không đổi lúc chạy**: mọi ô (kể cả ô trống) đã có node cửa nối sẵn trong `map_node`/`map_edge`; cửa của ô chỉ thành đích đến (`buildingDoor`) khi building trên đó có level ≥ 1. AI bỏ qua dịch vụ/Trạm/Shop/Lò/Học Viện chưa xây. (Thay cho "graph cập nhật khi đặt/xóa building" ở §6.)
- **Town Hall** (`kind: townHall`, đúng 1, phải có sẵn): level của mọi building khác ≤ level Town Hall; mở ô (`plot.townHallLevel`) và loại (`requires.townHallLevel`).
- **Hiệu ứng theo level** (level 1 = đúng số liệu trước khi có building, nên game mới chơi như cũ):

  | Loại | Trường | Giá trị L1 → max |
  |---|---|---|
  | service (4) | `restorePerSec[]`, `price[]` (giá gốc trước `servicePrice`) | ×1 → ×1,6 tốc hồi; giá ×1 → ×1,32 |
  | craft (Lò Rèn, Kim Hoàn) | `maxGearLevel[]` — **tier đồ chế được** (gear.level ≤ trần) | 15, 23, 31, 41, 51, 61, 71, 81 |
  | shop | `capacity[]` | 12 → 20 |
  | forge (Lò Cường Hóa) | `enhanceBonus[]` cộng vào successRate (AI dùng cùng tỉ lệ) | 0 → +0,08 |
  | academy | `studyGoldMul[]` nhân giá học skill | 1 → 0,8 |
  | tradingPost | `surplusPriceMul[]` nhân `tradeSurplusPriceFrac` | 1 → 1,3 |
  | storehouse (mới, xây được, cần Town Hall 3) | `requestCopies[]` cộng vào số bản yêu cầu NL tự động | +1 → +3 |

  Trần tier áp ở `startCraft` (lý do `gear tier locked by building level`), `pickRecipe`, yêu cầu NL tự động (không mua NL cho công thức chưa chế được) và `upgradeSavings` của AI (không để dành cho đồ chưa ai chế được).
- **Ô đất**: 10 building cũ giữ chỗ và cửa cũ; Town Hall ở ô trong (`d.townhall`); 3 ô trống `plot.ne`/`plot.se`/`plot.sw` mở ở Town Hall 2/4/6.
- **Lệnh**: `town.build { buildingId, plotId }`, `town.upgrade { buildingInstanceId }` (id = id ô), `town.cancelUpgrade { buildingInstanceId }` (hoàn đủ vàng + NL; hủy xây lần đầu thì trả ô), `town.setAutoInvest { on }`. Từ chối (`commandRejected`): `unknown building`, `unknown plot`, `plot occupied`, `already built`, `plot locked by Town Hall level`, `building locked by Town Hall level`, `unknown building instance`, `upgrade in progress`, `max level`, `locked by Town Hall level`, `construction slots full` (`buildMaxConcurrent` 2), `missing materials`, `not enough town gold`, `no upgrade in progress`. Lệnh người chơi cần đủ NL trong kho (không nhập).
- **Thanh toán**: vàng (× `buildCostMul`) và NL trong kho trả **ngay khi bắt đầu** và **rời khỏi nền kinh tế** (event `buildingStarted { gold, materials, importGold }`); building vẫn chạy ở level cũ tới khi xong (`sec × buildTimeMul`, event `buildingCompleted`).
- **Tự đầu tư** (`town.autoInvest`, mặc định bật; mỗi `townInvestIntervalSec` 10 s theo `world.tick`, không rút RNG):
  1. **Bước gấp**: Lò Rèn/Kim Hoàn có trần < gear.level của một công thức với gear.level ≤ level hunter cao nhất (kể cả hunter đang Journey) + `craftLevelAhead` + `investCraftLeadLevels` (4) → nâng building đó, hoặc nâng Town Hall nếu Town Hall đang chặn. Được tiêu tới sàn `investUrgentReserveMul` (5) × `autoCraftReserve`. Nhiều bước gấp: ưu tiên bước đã đủ NL, rồi kế hoạch đang chờ, rồi thứ tự config.
  2. **Bước thường**: bước rẻ nhất (ưu tiên bước đã đủ NL) trong mọi nâng cấp/xây hợp lệ (xây vào ô trống đầu tiên), chỉ khi vàng Town − giá ≥ `investTargetMul` (1) × `townGoldTarget` (§5.7).
  3. Kế hoạch lưu ở `town.investPlan`. **Trạm Thu Mua yêu cầu NL** của mọi bước gấp và của kế hoạch thường (`investMaterialNeed`, cộng vào yêu cầu tự động §5.7, kể cả khi tắt auto-craft) → kho có mục đích và AI ưu tiên vùng rơi NL đó. NL nâng cấp lấy từ vùng hunter đang săn lúc cần (Lò Rèn L2 quặng/lõi … L8 hư không/bóng; building khác dùng NL vùng giữa/cuối) để không kẹt ở vùng đã bỏ. Thiếu NL quá `investImportSec` (900 s) thì **nhập** phần thiếu với giá `investImportPriceMul` (2) × giá NL (vàng cũng rời nền kinh tế).
- **Save v9 không có building** (bản chỉ có Journey, v8 khi đó là pass-through): `deserialize` điền các trường building bằng chính migration v7 → v8 nếu `town.buildings` thiếu (`fillMissingBuildings`), không đổi version.
- **Hủy** hoàn toàn bộ vàng (kể cả vàng nhập NL) và chỉ trả lại NL đã lấy từ kho (`upgrade.materials`); NL nhập (`importedUnits`) không thành NL miễn phí.
- **Migration v7 → v8**: mọi `startBuilding` ở level thấp nhất giữ nguyên cách chơi của save: Lò Rèn/Kim Hoàn đủ cao cho mọi công thức gear.level ≤ max(level hunter + `craftLevelAhead`, đồ đang mặc / bán / chế), Town Hall ≥ building cao nhất; còn lại level 1.
- **Debug/tool**: overlay có khối "Công trình" (level/max, trần tier, tiến độ nâng, giá kế tiếp, nút nâng/hủy, ô trống với nút xây, nút tự đầu tư và kế hoạch). `tools/headless.ts` in `build invest` (vàng, nhập, NL, số xong, level từng building) mỗi mốc và trừ vào phần dư `fees`; `tools/pacing.ts` in trần tier + level building mỗi mốc và tổng đầu tư cuối run.
- **Số đo** (headless/pacing seed 1–5, Dễ, có thuế 10%; trước = `23c50f7` → sau):
  - Nhịp: Lv20 đầu tiên 68–88 → 67–89 phút; Lv50 4,57–5,02 → 4,72–5,13 giờ; tái sinh đầu 13,15–14,45 → **12,53–13,65 giờ** (cả 5 seed trong 8–14 giờ). Trần tier theo sau level hunter cao nhất: thường trong vài level, nhưng có lúc trễ tới ~10 level (seed 1/3: trần 61 khi max L67–68 lúc 8 giờ, 71 khi max L81 lúc 10 giờ; hunter trung vị thường vẫn dưới trần). Nguyên nhân chưa kiểm chứng: sàn bước gấp (`investUrgentReserveMul` × `autoCraftReserve`) cộng 3 bước ~13k (Town Hall + 2 lò) cuối game.
  - Lúc 12 giờ: vàng Town 21,5–26,9k → **13,4–22,8k** (4 giờ: 8,1–9,2k → 2,9–5,4k; 8 giờ: 11,9–25,6k → 5,6–17,4k); vàng hunter tb 5,9–7,6k → 4,9–6,5k; Lv tb 79,6–85,3 → 83,3–87,1; shop 5–8 → 3–6 món; chết (12 giờ) 7 → 17 (seed 6–10: 11 → 7; 10 seed 18 → 24).
  - **Đầu tư**: 160–198k vàng / 15 giờ (nhập 3–7k), ≈ 12–18k (0–4 giờ), 48–61k (4–8 giờ), 65–79k (8–12 giờ). Lò Rèn/Kim Hoàn/Town Hall max (8) lúc ~10–11 giờ; dịch vụ/shop/lò/học viện 1–5. Phần phí bị quy tắc ngân khố + 20% phí cố định "đốt" 8–12 giờ 149–171k → 102–124k: phần lớn số vàng trước đây bị đốt giờ đi vào building. Bounty tự động đặt ít hơn (12 giờ: 54–72 → 23–37) vì vàng Town ít khi trên mục tiêu.
  - Không thuế (`taxRate` 0, bản trước khi ưu tiên bước gấp đủ NL): vàng Town 12 giờ 23,0–26,5k → 19,2–25,5k, tái sinh đầu 13,05–14,33 → 12,75–13,40 giờ, đầu tư 144–199k / 15 giờ.
- **Quy tắc ngân khố vẫn giữ**: bước thường chỉ tiêu phần trên mục tiêu, và khi Lò Rèn/Kim Hoàn/Town Hall đã max (~10–11 giờ) vàng Town lại lên gần mục tiêu, nên quy tắc vẫn là lực kéo cuối game. Muốn bỏ nó cần thêm chỗ tiêu cuối game (building M5 trên ô trống, cấp cao hơn).

## 6. Di chuyển và pathfinding

- Map là **waypoint graph**: node (vị trí, zoneId, loại: road/field/building-door) và cạnh (khoảng cách).
- Đường đi: A* trên graph, cost = khoảng cách / hệ số tốc độ của cạnh. Cạnh trên **Road** có hệ số > 1 **[ĐỀ XUẤT 1.5]**.
- Building có node cửa; khi đặt hoặc xóa building, graph cập nhật cạnh nối và cache path bị xóa.
- Cache path theo cặp (node đầu, node cuối), mất hiệu lực khi graph đổi.
- Trong field: đi tới node gần quái, sau đó steering tự do trong bán kính.
- Trên ~60 hunter: giới hạn 10 truy vấn A*/tick, còn lại xếp hàng.
- Hiện trạng (`pathfinding.ts`): graph dựng một lần từ `map_node`/`map_edge`, hệ số road = `roadSpeedMul`; cache path theo cặp node không bao giờ bị xóa: building đặt trên ô có sẵn node cửa (§5.12), graph không đổi lúc chạy. Chưa có giới hạn A*/tick (chưa cần ở quy mô hiện tại).

## 7. Combat

- Hunter chọn mục tiêu là quái gần nhất trong tầm nhìn; ưu tiên quái đang đánh mình.
- Đòn đánh thường lặp theo chu kỳ `ATK SPD` (số nhỏ = nhanh, GDD §4.2).
- Skill: auto-cast khi hết cooldown và có mục tiêu hợp lệ; ưu tiên theo thứ tự trong config. Code: `systems/skills.ts` chạy ngay sau combat, tối đa 1 skill/hunter/tick, loại `strike`/`aoe`/`buff`; damage đi qua `combat.damageMonster` (cùng mitigation/crit/thưởng kill).
- Chết: HP về 0, goal `dead` trong `reviveSec`, rồi hồi sinh ở node quảng trường với `reviveHpFrac` HP và AI mới.
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
- Hiện trạng: chưa có tool sheets → JSON; `game/config/*.json` đang sửa tay. Validate bằng schema DSL tự viết (`config/schema.ts`, không dùng zod) theo `TABLE_SPECS` + kiểm tra chéo bảng (map, ref) trong `config/load.ts`; `REQUIRED_FORMULA_KEYS` bắt buộc trong `formula_params`. Chạy `npm run config:check`; client và test gọi `loadConfig` nên config lỗi không chạy được. Version config ở `meta.json` (lưu vào save là `configVersion`).

### 8.2 Bảng gameplay

Kiểu: `id` string, `ref<X>` = id của bảng X, `int[]`/`float[]` = mảng theo level.

Bảng dưới là **thiết kế đích**. Đã có trong `game/config/` (trường thật xem `TABLE_SPECS`): `class` (statRanges, attackSpeed; **không** có growthPerLevel — mức tăng mỗi level là `levelHpGain/AtkGain/DefGain` chung trong `formula_params`), `job` (thêm `statMult`), `stat_grade`, `personality`, `skill` (kind strike/aoe/buff, `value[]`, `studyLevel[]`, `studyGold[]`…), `trait`, `gear` (slot, level, mainStat, mainValue, craftBuilding, craftSec, materials, basePrice), `gear_quality` (statMult, priceMult, craftChance), `enhance` (`level, successRate, costFrac, dropOnFail`), `material` (price), `monster`, `zone`, `difficulty` (unlockHunters, unlockReincarnation, monsterHp/Atk/DefMul, rewardMul), `building` (dịch vụ có need/restorePerSec/price), `map_node`, `map_edge`, `journey` (§5.11: durationSec, zoneId, recommendedPower, cost, gold, exp, materials, rare, failHpFrac, failRewardFrac), `formula_params`, `loc`, `meta`. Các bảng khác chưa làm.

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
| `enhance` | level, successRate, costFrac (phí = basePrice × costFrac), dropOnFail (thất bại −1 level) |
| `material` | id, nameKey, rating, price, zoneIds[], composeTo? |
| `monster` | id, nameKey, race, level, hp, atk, def, exp, gold, drops: [{matId, chance}], zoneIds[] |
| `zone` | id, nameKey, difficultyId, monsterPool: [{monsterId, weight}], waypointNodes[] |
| `difficulty` | id, order, unlock: {hunterCount, reincarnation} (GDD §8), monsterMultiplier |
| `building` | id, nameKey, kind, maxLevel, requires: {townHallLevel}, upgradeCost: [{gold, materials, sec}] × maxLevel (phần tử 0 = giá xây), mảng hiệu ứng theo level theo kind (§5.12). Đã làm; chưa có maxCount (= 1), size |
| `building_plot` | id, doorNode, townHallLevel, startBuilding?, startLevel?, x, y, w, h (§5.12). Đã làm |
| `service` | buildingId, need (hp/satiety/mood/stamina), restoreAmount[], price[], stockPerCycle[], cycleSec |
| `consumable` | id, nameKey, effect, keepTime[], value[], cooldown, price[], craftMaterials |
| `rune` | id, effect, grades, valueByGrade[], dropChance[] |
| `relic` | id, nameKey, maxLevel, value[], upgradeCost[] |
| `growth_property` | id, stat, valuePerLevel, maxLevel, cost[] |
| `exp_curve` | level, expByReincarnation[6] |
| `journey` | id, nameKey, durationSec, zoneId (đối thủ để tính sức mạnh đội), recommendedPower, cost, gold, exp, materials: [{materialId, count}], rare: [{gearId, qualityId, chance}], failHpFrac, failRewardFrac (§5.11) |
| `raid`, `trading_request` | Theo GDD §9; tạo schema khi đặc tả mode chi tiết. Bounty không có bảng riêng: tham số `bounty*` trong `formula_params` (§5.9). |
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
- **Code** (`src/core/save/`): file save = `{ format: 'town-hunter-save', schemaVersion, configVersion, savedAt, world }`. `deserialize(text, config)` từ chối JSON hỏng, file lạ và schema mới hơn build; chạy lần lượt `MIGRATIONS[v]` (v → v+1) tới `WORLD_SCHEMA_VERSION`; trả `migratedFrom` và `configChanged` (save làm với config version khác). **[CHỐT]** Migration nhận **config hiện tại** (`Migration = (world, config) => world`), nên giá trị suy từ config (node xuất phát, mức tăng level) là của config đang chạy, không phải config lúc save. Không sửa migration đã phát hành; đổi shape World thì bump `WORLD_SCHEMA_VERSION` và thêm migration + test trong `tests/save.test.ts`.

| Migration | Mốc | Nội dung |
|---|---|---|
| v0 → v1 | prototype → M0 | Thêm `town.arrivalTimerMs = 0` (và `town.gold = 0` nếu thiếu), `hunter.reincarnation = 0`. |
| v1 → v2 | M0 → M1 | Đặt hunter tại node quảng trường của config (`config.index.squareNode`, như lúc hồi sinh/arrival; fallback `t.square` (0,0) nếu không có), AI mới, `insideBuildingId/attackCdMs/deadMs/kills`; `monsters = []`, `zones = {}`, `stats` mới. |
| v2 → v3 | M1 → M2 | `equipment`/`bag` rỗng; Town `storage`, `shop`, `crafting`, `autoCraft = true`; stat kinh tế = 0 (giữ giá trị có sẵn). |
| v3 → v4 | M2 → M3 | `rollStats` ước lượng = `stats` trừ `(level − 1) × levelHpGain/AtkGain/DefGain` của config, kẹp trong khoảng roll của class (`statRanges`); skill/trait/buff rỗng; quái và Town dùng `diff.easy`; `autoReincarnate = true`; stat M3 = 0. |
| v4 → v5 | lượt cân bằng | Món trong shop thêm `listPrice = price`, `listedAtMs = world.timeMs` (giảm giá/hủy theo tuổi). |
| v5 → v6 | Trạm Thu Mua theo yêu cầu | `town.requests = {}`, stat `materialsDiscarded`/`gearScrapped` = 0. Kho cũ giữ nguyên. |
| v6 → v7 | Bounty | `town.bounties = []`, `town.autoBounty = true`, stat bounty = 0. |
| v7 → v8 | Town Hall/building | `town.buildings` = mọi `startBuilding` của `building_plot` ở level giữ nguyên cách chơi (Lò Rèn/Kim Hoàn đủ cho công thức ≤ level hunter + `craftLevelAhead` và đồ đang có, Town Hall ≥ building cao nhất, còn lại 1), `autoInvest = true`, `investPlan = null`, stat building = 0 (§5.12). |
| v8 → v9 | Journey | `journeys = []` (giữ mảng nếu đã có), stat `journey*` = 0. Chỉ điền trường thiếu nên đúng ở cả hai phía migration building. |

- **Offline progress [CHỐT]:** không mô phỏng từng tick. Ước lượng theo tốc độ trung bình đo được trong 10 phút gần nhất (gold/s, EXP/s, vật liệu/s theo từng hunter), nhân với thời gian vắng, trần **8 giờ [ĐỀ XUẤT]**. Hiển thị popup tổng kết. **[ĐÃ LÀM]**
  - **Vì sao không fast-forward:** 12 giờ game headless mất ~17 s (máy rảnh; ~100 ms/phút game khi máy bận), nên 8 giờ sẽ chặn lúc load ~11–48 s. Hybrid (chạy thật N phút đầu) chỉ chính xác phần đầu mà vẫn tốn ~25–100 ms/phút, nên không làm.
  - **Code** `src/core/offline.ts` (thuần, tất định, không DOM). Trong lúc chơi client gọi `recordSample` mỗi frame; cứ `offlineSampleSec` (30) giây game lấy một mẫu (mỗi hunter: EXP trong kiếp hiện tại = Σ expToNext dưới level + exp, gold, kills, số lần tái sinh; Town: gold, kho), giữ các mẫu trong `offlineWindowMin` (10) phút game cuối. `measureRates` cộng các cặp mẫu liên tiếp cùng *epoch* (hunter: cùng kiếp; vật liệu: chỉ phần tăng của kho). Mẫu nằm trong **envelope save** (`SaveFile.offline`, `serialize(world, savedAt, tracker)`, `LoadResult.offline`), không nằm trong World nên **không bump schema** (vẫn v6). Save cũ/mẫu hỏng → `offline = null` → không cộng gì.
  - **Khoảng vắng** (`offlineGap`): `now − savedAt` (wall-clock). `savedAt` ≤ 0/không hữu hạn (save cũ) → không cộng; đồng hồ lùi → không cộng; < `offlineMinAwaySec` (60) → bỏ qua; trần `offlineMaxHours` (8). Thời gian tính = trần × `offlineEfficiency` (1 [ĐỀ XUẤT]). Mỗi rate cần ≥ `offlineMinWindowSec` (120) giây đo, nếu không hunter/Town đó không được gì.
  - **Áp dụng** (`applyOffline`): EXP qua `gainExp` (trần level, tăng chỉ số, điểm trait; đổi nghề do progression làm ở các tick sau; **tái sinh offline** khi `town.autoReincarnate` và chưa tới `maxReincarnation` — dùng chính `progression.reincarnate`, hunter đặt về quảng trường Town; báo cáo giữ EXP từng kiếp `lives` để `applyOffline` chạy lại đúng đường đã ước lượng (`levelAfter` khớp); tắt tự tái sinh / đã tới trần thì EXP ở max level mất như khi chơi). Gold: thay đổi ròng đo được của từng hunter và Town, **sàn 0** (offline không ai tiêu, không ai nghèo đi). Kill cộng vào `hunter.kills`, `stats.kills`. Vật liệu: tốc độ vào kho từng loại nhưng **chỉ tới `materialDemand` hiện tại** (luật Trạm Thu Mua: chỉ mua cái được yêu cầu; yêu cầu của người chơi bị trừ như khi bán, `stats.materialsSold` tăng); tiền mua đã nằm trong gold ròng của Town nên không trừ thêm. Needs/HP đầy (theo max sau khi lên level), buff xóa, hunter đang chết hồi sinh ở tick sau. **Không** tăng `timeMs`/`tick`/RNG (tuổi món trong shop, timer spawn giữ nguyên). Sau khi áp dụng tăng `epoch` để bước nhảy không bao giờ thành tốc độ đo (load hai lần không cộng dồn).
  - **Client** (`src/client/main.ts`, `offlinePopup.ts`): lúc boot load → ước lượng → áp dụng → **save ngay** (reload trước autosave không cộng lại) → popup (thời gian vắng, có trần; vàng, kill, vật liệu; hành trình xong; công trình xong; hunter mới đến; từng hunter Lv trước → [tái sinh ×n →] sau, vàng, kill). Popup hiện cả khi ước lượng bị bỏ qua mà có timer xong. Nút Load của debug chỉ load, không cộng offline. Tab bị ẩn (rAF dừng nên sim dừng) cũng được cộng thời gian ẩn khi hiện lại.
  - **Mô hình tăng trưởng** (`offlineGrowthModel` 1, mặc định; 0 = tốc độ phẳng như trước): tốc độ phẳng hụt nặng khi game đang tăng tốc (hunter vượt vùng → sang vùng khó hơn, EXP/kill ×3–5). Nên mỗi hunter có rate được **chiếu trên bản sao** (world không đổi) theo bước `offlineModelStepSec` (300 s), **tất cả cùng lúc** để độ đông vùng đi theo họ: mỗi bước hunter chọn vùng như AI (`zoneScores`, max fit; độ đông = vùng của các hunter khác ở bước trước), tốc độ kill mô hình `v = offlineHuntDuty / (TTK + offlineTripSec / killsPerLife)` (`zoneEstimate`; một chuyến về Town hồi máu mỗi thanh HP — hunter vừa sang vùng khó về hồi thường xuyên), nguồn quái của vùng (1 con / `respawnSec`) chia theo tỉ lệ `v` (không quá `v`), EXP = kill × EXP trung bình của vùng (như combat cộng). Nhân với **hiệu chỉnh riêng từng hunter** = rate đo / rate mô hình lúc rời đi, kẹp [`offlineModelCalMin` 0,25; `offlineModelCalMax` 4] (ở max level EXP không đo được → dùng hiệu chỉnh kill), rồi `gainExp` + nghề theo `unlockLevel` trên bản sao, tái sinh như dưới. `offlineEfficiency` nhân thời gian chiếu. Gear/skill/Town **đóng băng** (offline không chế/mua/cường hóa), nên bước nhảy do đồ mới (Lò Rèn mở tier 23 rồi chế đồ ~70–110 phút) không đoán được. Vàng hunter/Town và NL vẫn theo tốc độ phẳng (vàng là số ròng, chi tiêu làm nhiễu). `offlineHuntDuty` 0,8 / `offlineTripSec` 120 chọn bằng quét nhỏ trên seed 2 (30/60 phút), kiểm lại seed 1–3 và seed 4 không dùng để chọn.
  - **Độ chính xác** (`npx vite-node tools/offline-accuracy.ts [seeds] [warm] [gap]`: chơi `warm` phút, ước lượng 60 phút tiếp, rồi chạy thật 60 phút; level tính cả tái sinh = +maxLevel; efficiency 1). Sai số kill / tổng level tăng thêm của hunter có mặt:

    | Chơi trước | Trước (phẳng) seed 1 / 2 / 3 | Sau (mô hình) seed 1 / 2 / 3 | Seed 4 (kiểm, sau) |
    |---|---|---|---|
    | 30 phút | kill +13 / +20 / −14 %; level −15 / −26 / −25 % | kill +18 / +28 / −7 %; level −2 / +8 / −16 % | kill 0 %, level −20 % |
    | 60 phút | kill −28 / −46 / −12 %; level −54 / −72 / −21 % | kill −19 / −26 / −4 %; level −45 / −39 / −14 % | kill −1 %, level −7 % |
    | 150 phút | kill −4 / −16 / −21 %; level +16 / 0 / −39 % | kill +12 / −15 / −11 %; level +18 / −7 / −19 % | kill +28 %, level +14 % |
    | 240 phút | kill 0 / −9 / +11 %; level −6 / −20 / 0 % | kill +3 / −17 / +12 %; level 0 / −18 / +2 % | kill +12 %, level +10 % |

    Ô trong ±25 % (seed 1–3): level 8/12 → 10/12, kill 10/12 → 10/12, cả hai 8/12 → 9/12 — cải thiện chủ yếu ở độ lớn sai số tệ nhất (level 60 phút −72 % → −45 %), không phải số ô. **Chưa đạt ±25 % ở mọi ô**: sau 60 phút level vẫn −39…−45 % ở seed 1–2 (đội vào Đầm Lầy nhờ đồ tier 23 chế lúc ~75 phút — đồ đóng băng nên mô hình không thấy), kill seed 2 +28 % (30 phút) / −26 % (60 phút), seed 4 kill +28 % ở 150 phút. Quét `offlineHuntDuty` 0,3–0,8 chỉ đổi qua lại giữa ô 30 và ô 60 phút của seed 2, nên không tune thêm. Phiên bản không có chuyến hồi máu/duty (TTK thô, độ đông theo mục tiêu hiện tại) vượt tới +105 % kill ở 30 phút. Gold vẫn không so được (thực tế tiêu vào đồ). Thời gian ước lượng 8 giờ (~100 bước × 8 hunter): 23–28 ms (seed 1, 12–13 giờ chơi, máy bận). **Tái sinh** (seed 1, chơi 720 / 780 phút, khoảng vắng 120 phút): số lần tái sinh ước lượng 1 / thực 4 và 6 / 6; kill −34 % / +24 %, level (tính cả tái sinh) −45 % / +14 % — mới đo một seed. Vàng ước lượng ở giai đoạn này cao gấp nhiều lần vàng ròng thực (123k / 11k: tốc độ ròng phẳng không trừ chi tiêu cuối game).
- **Timer chạy offline theo thời gian thực** (`advanceOfflineWallClock(ctx, offlineWallClockMs(savedAt, now))`, gọi qua `Simulation.runBetweenTicks` **sau** `applyOffline`; khoảng thô, không trần `offlineMaxHours`, không × efficiency, không cần rate/`offlineMinAwaySec`; save không có thời gian / đồng hồ lùi → 0) **[ĐÃ LÀM]**: (1) journey như dưới; (2) **công trình đang xây/nâng** (`town.advanceBuildingTimers`, cùng logic hoàn thành như system `town`: level, stat, event `buildingCompleted`) — đã trả tiền lúc bắt đầu nên hoàn thành không phải ngoại suy, giống journey; tự đầu tư **không** bắt đầu bước mới khi offline; (3) **hunter mới đến** theo luật `arrivals` (một người mỗi `arrivalIntervalSec` khi Town còn slot, journey giữ slot; timer về 0 khi đầy) — người mới không nhận gì cho phần còn lại của khoảng vắng. Kết quả vào `OfflineReport.journeys` / `buildings` / `arrivals` và popup.
- **Journey chạy offline theo thời gian thực** (GDD §9, §5.11) **[ĐÃ LÀM]**: không ước lượng theo tốc độ. Lúc mở game (và khi tab hiện lại) client gọi `advanceJourneys(ctx, offlineJourneyMs(savedAt, now), true)` qua `Simulation.runBetweenTicks` (RNG sống của sim, ghi lại vào `world.rng`, không tăng tick/time) **sau** `applyOffline` — nên thành viên đang đi không nhận EXP/vàng theo tốc độ và không được hồi nhu cầu. Khoảng dùng là khoảng thô: **không** trần `offlineMaxHours`, không × `offlineEfficiency`, không cần `offlineMinAwaySec` hay rate (trần chỉ để giới hạn ngoại suy); save không có thời gian / đồng hồ lùi → 0. Chuyến xong trong khoảng vắng được roll ngay lúc load, nằm trong `OfflineReport.journeys` và popup (thành công/thất bại, thưởng); popup hiện cả khi ước lượng bị bỏ qua (`noRates`/`tooShort`) mà có chuyến xong. Đội về không săn phần còn lại của khoảng vắng (đơn giản hóa). Mẫu đo tốc độ lấy vàng Town **trừ** `stats.journeyGold`, nên thưởng journey không bị ngoại suy thành tốc độ vàng (phí `cost` vẫn nằm trong vàng ròng: chỉ làm ước lượng thấp đi, sàn 0; NL thưởng có thể tính vào tốc độ vào kho nhưng bị kẹp bởi `materialDemand`). Lúc đang chơi journey đếm theo **thời gian game** (x2/x4 rút ngắn, pause dừng).
- `Simulation.advance` chạy tối đa 600 tick mỗi lần gọi để tránh dồn tick sau khi tab bị ẩn (phần thời gian ẩn được cộng bằng offline progress).

## 10. Hiệu năng

| Hạng mục | Giới hạn **[ĐỀ XUẤT]** |
|---|---|
| Hunter tối đa | 60 |
| Quái đồng thời | 300 |
| AI decide/tick | ≤ 15 hunter (chia lô theo id) |
| A*/tick | ≤ 10 |
| Draw call | Instancing cho sprite cùng atlas |
| Truy vấn mục tiêu | Spatial hash theo ô 4×4 đơn vị (`src/core/spatial.ts`, đã làm) |

**Spatial hash (đã làm).** `SpatialHash` là lưới đều ô 4×4 (`SPATIAL_CELL_SIZE`), id là chỉ số của thực thể trong mảng `world.hunters`/`world.monsters`. Đây là dữ liệu dẫn xuất: không nằm trong `World` hay save (không cần migration), mỗi system tự dựng lại trong tick khi cần.

- `combat`: sau bước hồi sinh, dựng lưới các hunter có thể bị nhắm (còn sống, không ở trong nhà) cùng tập vùng của họ; quái tìm aggro bằng truy vấn bán kính `aggroRange` thay vì quét mọi hunter, và bỏ qua hẳn nếu vùng của quái không có hunter nào.
- `skills`: skill AoE truy vấn lưới quái (dựng lười ở lần AoE đầu tiên của tick).
- `spawn`: đếm quái theo vùng một lượt thay vì quét toàn bộ mảng quái cho từng vùng.
- **Tất định:** truy vấn trả về tập ứng viên (bao trùm) theo thứ tự chỉ số tăng dần; caller vẫn kiểm tra điều kiện và khoảng cách gốc, nên thứ tự duyệt, tie-break và các lần roll RNG giống hệt quét tuyến tính. Đã kiểm: output headless 720 phút seed 1–3 và hash toàn bộ world/event từng phút giống từng byte trước/sau.
- Khi số phần tử ít hơn số ô cần xét, `candidates()` quét bounding box trên danh sách phần tử (rẻ hơn tra từng ô); kết quả cùng hợp đồng.
- Chưa dùng: `huntAct` (hunter chọn quái gần nhất, ưu tiên −1000 cho quái đang đánh mình nên không giới hạn được bán kính; chỉ chạy khi mất mục tiêu, ~1,5% thời gian).

## 11. Telemetry và debug

- Overlay debug: state AI, goal và điểm utility của hunter đang chọn, path, needs.
- Log sự kiện kinh tế (nguồn và đích của gold) để cân bằng.
- Chế độ headless: chạy core 24 giờ game trong vài giây, xuất CSV (gold, level, thời gian trong từng state) để tuning. Hiện có `tools/headless.ts [phút] [seed] [phút/snapshot]`: in timeline vàng Town, số món trong shop, kho, bag, yêu cầu, vàng hunter (tb/max), level tb và sổ thu/chi vàng Town theo từng khoảng (chưa xuất CSV).

## 12. Lộ trình triển khai

| Mốc | Nội dung | Xong khi |
|---|---|---|
| M0 ✅ | Skeleton: core loop, config loader, save, debug overlay | Load config, chạy tick, save/load được |
| M1 ✅ | 1 Town + 1 zone, waypoint/road, 5 class, needs, AI cơ bản (Hunt/Return/4 dịch vụ) | Hunter tự săn và tự quay về đúng ngưỡng |
| M2 ✅ | Shop, craft, gear + quality + enhance, BuyGear/SellMaterials | Vòng săn → bán → craft → mua chạy kín |
| M3 ✅ | Skill, trait, level, chuyển nghề, reincarnation, difficulty | Mở được difficulty Normal theo điều kiện GDD §8 |
| M4 | Town & chế độ chơi: Trading Post theo yêu cầu ✅, Bounty ✅, offline progress ✅, Journey ✅; Town Hall, xây/nâng cấp/đặt building, slot building, cấp building giới hạn tier đồ, tự đầu tư ✅ (§5.12), thuế ✅ | QA checklist GDD §13 đạt; vàng/NL Town có chỗ tiêu ra khỏi nền kinh tế |
| M5 | Chiều sâu hunter & trang bị: Invitation + `hunter_tier` (GDD §4.1–4.2), Donate/Banish; đủ 9 bậc nghề (hiện 3) và 7 slot đồ (GDD §6, hiện 3); nâng tier đồ (Dark Stone), `gear_option` / `gear_set` / `gear_skill`; `consumable` (potion, Alchemist) + goal BuyPotion; Training Ground + goal Train; Bank, Courage Headstone, Fountain of Life, Library of Wisdom; `rune`, `relic`, thú cưỡi, `growth_property`; ghép NL (`material.composeTo`); `exp_curve` theo lần tái sinh; bật Mood ảnh hưởng chỉ số (GDD §4.2); lệnh người chơi học skill/trait | Mọi bảng §8 (trừ `raid`) có code dùng; cân bằng lại bằng headless |
| M6 | Client & nội dung: UI hoàn chỉnh (GDD §10), sprite/scene pixel-art và camera pan/zoom/chọn bằng click (GDD §11), UI cho yêu cầu vật liệu/bounty/building, vi/en, tutorial, headless xuất CSV; thay toàn bộ dữ liệu trích từ game thương mại (TODO §7), chốt nền tảng (GDD §2) và bố cục map | Bản chơi thử nội bộ, không còn dữ liệu sao chép |
| M7 | Online: account, cloud save, IAP; Raid, PvP, Guild, World Boss, Tower Defense, chat, ranking | Theo đặc tả riêng |

Hiện trạng: M0–M3 xong; M4 đã có Trading Post theo yêu cầu (§5.7), Bounty (§5.9), thuế (§5.10), Journey (§5.11), Town Hall/building (§5.12), offline progress (§9) — world v9. Còn QA checklist GDD §13.

### 12.1 Bảng phủ (chống bỏ sót)

Mọi hệ thống nhắc trong GDD hoặc có bảng ở §8 phải nằm trong một mốc ở bảng trên. Khi thêm hệ thống/bảng mới vào GDD hoặc §8, thêm luôn một dòng ở đây. GDD không nằm trong repo: bảng này dựng từ các tham chiếu GDD trong TECH_SPEC/TODO; cần đối chiếu lại với GDD gốc.

| Hệ thống (nguồn) | Mốc | Trạng thái |
|---|---|---|
| Class, job, stat grade, personality, skill, trait (§8) | M1–M3 | ✅ (job: 3/9 bậc → M5) |
| Gear, gear_quality, enhance, material, monster, zone, difficulty, service (§8) | M1–M3 | ✅ (gear: 3/7 slot → M5) |
| Needs, AI utility, combat, death/revive, reincarnation (GDD §4, §8) | M1–M3 | ✅ |
| Trading Post / yêu cầu vật liệu (GDD §5, §9) | M4 | ✅ |
| Bounty (GDD §9) | M4 | ✅ |
| Offline progress (§9) | M4 | ✅ |
| Journey (GDD §9, bảng `journey`) | M4 | ✅ (§5.11; chưa có AI/tự gửi, chưa có UI ngoài debug) |
| Town Hall, xây/nâng/đặt building, slot, cấp shop giới hạn tier (GDD §5, bảng `building`, `building_plot`) | M4 | ✅ (§5.12; building M5 dùng ô trống) |
| Thuế (§3.1, §5.10) | M4 | ✅ |
| QA checklist (GDD §13) | M4 | ⚪ |
| Invitation, `hunter_tier`, Donate/Banish (GDD §4.1–4.2) | M5 | ⚪ (tier hunter đã có) |
| 9 bậc nghề, 7 slot đồ (GDD §6) | M5 | ⚪ |
| Nâng tier đồ, `gear_option`, `gear_set`, `gear_skill` | M5 | ⚪ |
| `consumable`, potion, Alchemist, goal BuyPotion | M5 | ⚪ |
| Training Ground + goal Train; Bank, Courage Headstone, Fountain of Life, Library of Wisdom | M5 | ⚪ |
| `rune`, `relic`, thú cưỡi, `growth_property` | M5 | ⚪ |
| Ghép NL (`composeTo`), `exp_curve` | M5 | ⚪ |
| Mood ảnh hưởng chỉ số (GDD §4.2) | M5 | 🟡 code có, đang tắt |
| Lệnh học skill/trait (GDD §10 menu Learn) | M5 | ⚪ |
| UI hoàn chỉnh, menu lệnh (GDD §10) | M6 | ⚪ |
| Đồ họa pixel-art, camera (GDD §11) | M6 | ⚪ |
| Localization, tutorial, headless CSV (§11) | M6 | ⚪ |
| Thay dữ liệu trích / IP (TODO §7), nền tảng (GDD §2), bố cục map | M6 | ⚪ |
| Online, Raid (bảng `raid`), PvP, Guild, World Boss, Tower Defense, chat, ranking | M7 | ⚪ |

## 13. Việc còn mở

- Công thức kinh tế: **TBD**. Công thức combat: có mô hình §7.1 (**[ĐỀ XUẤT]**, chờ design duyệt số).
- Bố cục map (Town, zone, waypoint): cần thiết kế riêng hoặc dùng làm tham chiếu dữ liệu scene khi có.
- Danh sách personality, tên class/job/item/quái của game: do team design đặt.
- Nền tảng phát hành (web, mobile wrapper) và hướng màn hình: chưa chốt (GDD §2).
