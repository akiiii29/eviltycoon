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
| `systems/progression` | Chuyển nghề, reincarnation qua Cổng Tái Sinh (§5.13: gửi tới cổng khi tự tái sinh bật, đếm thời gian trong cổng, `reincarnate()`), unlock difficulty. EXP/level nằm ở `progress.ts`. |
| `systems/spawn` | Sinh quái theo zone và difficulty hiện tại. |
| `save/` | `serialize`/`deserialize`, migration (§9), storage IndexedDB/memory. |
| `commands` | Lệnh của người chơi/debug (Move, Activities, craft, reincarnate, đổi difficulty, yêu cầu vật liệu…). Xếp hàng, áp dụng đầu `step()` kế tiếp; handler trả lý do khi từ chối. |
| `events` | Event bus một chiều sim → UI/render (hit, kill, levelUp, purchase…) để chơi VFX/âm thanh/toast. Sim không bao giờ đọc lại. |
| `config/` | Schema DSL (`schema.ts`), `TABLE_SPECS` + kiểm tra chéo + index (`load.ts`), kiểu (`types.ts`). |

Bounty: `systems/bounty` (§5.9). Thuế: `systems/tax` (§5.10) — thuế trên vàng rơi từ quái, thu ngay lúc kill. Journey: `systems/journey` (§5.11). Town Hall, xây/nâng building, ô đất, tự đầu tư: `systems/town` (§5.12). Invitation (M5) — xem §12.

### 3.2 Vòng lặp **[CHỐT]**

- Fixed-step simulation: **10 tick/giây** (`dt = 100 ms`). Render nội suy vị trí giữa 2 tick.
- Thứ tự system mỗi tick (`DEFAULT_SYSTEMS` trong `src/core/simulation.ts`):
  `commands → arrivals → townAura → ai → movement → combat → skills → potionUse → urgentBackstop → services → economy → mounts → compose → consumables → supplies → academy → training → crafting → town → bounty → journey → needs → progression → runes → relics → spawn`, rồi `tick += 1`, `timeMs += dt`, lưu RNG state vào world.
  - `commands`: lệnh enqueue giữa 2 tick được áp dụng đầu `step()`, trước mọi system.
  - `potionUse` (§5.14) uống thuốc trước `urgentBackstop`, để đòn đánh làm HP tụt được trả lời bằng thuốc trước khi luật rút lui bắn; `consumables` bán thuốc ở cửa; `supplies` sản xuất vật tư/thuốc sau Trạm Thu Mua, trước craft.
  - `townAura` (§5.15) chép aura của Monument lên hunter trước mọi system đọc chỉ số; `training` chạy phiên Training Ground cạnh `academy`.
  - `urgentBackstop` chạy lại backstop khẩn cấp của AI (§5.2) **sau combat và skills**, để đòn đánh làm nhu cầu tụt dưới ngưỡng được xử lý ngay trong tick đó (không chờ tick sau).
  - Không có pha `cleanup` riêng: combat xóa quái chết cuối pass của nó. Không có pha `emit events`: event được ghi vào buffer khi phát sinh, client lấy bằng `drainEvents()`.
  - EXP/level-up xảy ra trong combat/skills (`gainExp`); `progression` chạy sau đó trong cùng tick (chuyển nghề ngay; tái sinh thì chỉ gửi hunter tới Cổng Tái Sinh, `reincarnated` phát khi hết thời gian trong cổng, §5.13).
- Tốc độ game x1/x2/x4: chạy nhiều tick trong một frame, không đổi `dt`.
- Mỗi system chỉ ghi vào phần state của nó, đọc phần còn lại. Không dùng singleton toàn cục.

## 4. Mô hình thực thể

### 4.1 Hunter (runtime)

Theo `interface Hunter` trong `src/core/world.ts` (world v6; hàng chờ / thư mời ở world v14, xem cuối mục).

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `id` | string | |
| `classId`, `jobTier`, `jobId?`, `jobBranch?` | ref, int, ref, string | Cây nghề 9 job mỗi class (`job.json`, §5.16): bậc 0–2 một job, bậc 3 ba nhánh (a/b/c), bậc 4 = bậc thầy của từng nhánh. `jobId` = job hiện tại (thiếu / sai bậc = job đầu tiên của `jobTier`, `progressionStats.jobOf`); `jobBranch` = nhánh người chơi chọn (`hunter.chooseJob`), giữ qua tái sinh. v16. |
| `learnPlan?` | `{kind: skill/trait/growth, id}` | v16: kế hoạch học do người chơi đặt (`hunter.learn`, §5.16). |
| `growth?`, `runes?`, `mount?` | map growthId → level, list `{runeId, grade}` / null, ref | v16 (§5.16): growth property (cộng phẳng vào chỉ số gốc), ô rune (≤ `runeSlots`), thú cưỡi. Giữ qua tái sinh. |
| `tier` | `normal`/`rare`/`superior`/`heroic`/`legendary` | Khách thường: theo điểm G = N_high + 2 × N_highest (GDD §4.2, `tierFromPoints`). Thư mời: tier roll trước, grade roll theo tier (dưới). |
| `statGrades` | map stat → `normal`/`high`/`highest` | Roll lúc sinh hunter. |
| `stats` | hp, atk, def, eva, crit, atkSpeed | Chỉ số gốc = roll + cộng theo level (`levelHpGain/AtkGain/DefGain`), **chưa** gồm gear/job/trait/buff; giá trị hiệu dụng lấy qua `formulas.hunterStats()`. |
| `rollStats` | như `stats` | Roll gốc ở level 1; reincarnation đặt lại `stats = rollStats`. |
| `level`, `exp`, `reincarnation` | int | |
| `needs` | hp, satiety, mood, stamina (0..max) | |
| `gold` | int | Tiền riêng của hunter; dùng để mua đồ, dịch vụ, cường hóa, học. |
| `equipment` | slot → GearInstance | 3 slot hiện tại: `weapon`, `armor`, `accessory` (GDD §6 có 7). |
| `bag` | map materialId → số lượng | Sức chứa = `formula.bagCapacity` (tổng số đơn vị). |
| `potions`, `potionCdMs`, `lastZoneId` | map consumableId → số, ms, zone | v11, optional (§5.14): thuốc đang mang (≤ `potionCarryMax`), hồi uống, vùng của goal hunt cuối (chọn bậc thuốc/vật tư). |
| `skills`, `skillCdMs`, `buffs` | map skillId → level, map → ms còn lại, list buff | |
| `traits`, `traitPoints` | map traitId → level, int | |
| `personalities` | list ref | Số lượng = `formula.personalitiesPerHunter`; hệ số chỉnh hành vi (§5.5); đổi bằng `hunter.rerollPersonality`. |
| `ai` | `{goal, phase: travel/act, path, decideInMs, targetMonsterId, moveTo, forced}` | `forced` = goal do lệnh người chơi. |
| `position`, `nodeId`, `insideBuildingId` | | Zone hiện tại suy ra từ `nodeId` (node field có `zoneId`). |
| `attackCdMs`, `deadMs`, `kills`, `arrivedAtMs` | | `deadMs > 0` = đang chết, đếm tới hồi sinh. |

#### Hàng chờ, thư mời, Donate / Banish (EHT; world v14) **[ĐÃ LÀM — số liệu ĐỀ XUẤT]**

Code: `src/core/systems/arrivals.ts` (`advanceArrivals`, dùng chung cho tick và offline), `hunterFactory.ts` (`rollHunterOfTier`, `rollInvitationTier`, `rollPersonalities`), lệnh trong `commands.ts`, bảng `config/invitation.json`. Test `tests/hunters-m5.test.ts`.

- **Hàng chờ (EHT "Waiting Slot")** — `town.queue: QueueEntry[]` (`{uid, source: visitor/invite/auto, invitationId?, tier?, queuedAtMs}`), tối đa `queueMax` (30; EHT ~100). Thứ tự mỗi lần `advanceArrivals(ms)`:
  1. Town còn slot (`townHunterCount < hunterSlots`; hunter đi journey/trong cổng giữ slot) → người đầu hàng chờ vào ngay (event `hunterArrived {fromQueue: true}`).
  2. Còn slot và hàng chờ rỗng → khách mới mỗi `arrivalIntervalSec` như trước v14 (`arrivalTimerMs`, về 0 khi đầy). Town đầy → một khách **vào hàng chờ** mỗi `queueArrivalIntervalSec` (300 s, `queueTimerMs`) tới khi đủ `queueMax`; timer nghỉ ở 0 khi hàng đầy.
  3. **Mời tự động** (EHT: ≤ 2 hunter, 60 phút): khi `townHunterCount ≤ autoInviteMaxHunters` (2) và còn slot hoặc chỗ trong hàng, mỗi `autoInviteIntervalSec` (3600 s, `autoInviteTimerMs`) có một hunter miễn phí theo tỉ lệ tier của dòng invitation `autoInvite` (event `hunterInvited {paid: 'free'}`). Hiện khách thường đã lấp slot mỗi 20 s nên đây là lưới an toàn.
  - Mục trong hàng chờ là bản ghi nhẹ: hunter chỉ được roll (RNG của sim) **lúc vào Town**, nên Town đầy không rút RNG và `uid` dùng bộ đếm riêng (`q<stats.queueJoined>`), không đụng `world.nextId` — nhịp `tools/pacing.ts` (Town luôn đầy) giống hệt trước v14.
  - Offline (§9) chạy đúng hàm này cho cả khoảng vắng (slot không tự trống khi offline, nên thường chỉ là hàng chờ đầy dần).
- **Thư mời** (`town.invite {invitationId}`): dùng 1 vé (`town.tickets[id]`) nếu có, không thì trả `gold` vàng Town (ra khỏi nền kinh tế), cần Town Hall ≥ `townHallLevel`; dòng không có `gold` chỉ dùng vé. Roll tier theo `tierChances` (trọng số), rồi **roll grade theo tier**: liệt kê mọi tổ hợp grade (3^5 = 243), giữ các tổ hợp có `tierFromPoints(G)` đúng tier, chọn một theo xác suất tự nhiên (tích `rollChance`) — 1 lần rút, đúng phân bố tự nhiên có điều kiện. **Legendary** cần G ≥ 14 nhưng 5 chỉ số cho tối đa 10: lấy tổ hợp điểm cao nhất (mọi chỉ số `highest`), giữ tier legendary và roll mỗi chỉ số ở nửa trên khoảng `highest`. Còn slot → vào ngay (trước hàng chờ); Town đầy → vào hàng chờ trước mọi khách thường, sau các thư mời trước đó; Town và hàng chờ cùng đầy → từ chối. Vé chưa có nguồn gameplay (chỉ `debug.grantTicket`).
  - Bảng `invitation.json` (đề xuất). Tham chiếu EHT (thường ~60 %, hiếm ~37 %, superior ~3 %, heroic ~0,5 %, legendary ~0,05 %) đã được nâng lên vì khách thường của ta roll grade độc lập theo `stat_grade` (0,61/0,33/0,06) đã cho ≈ 31,3 % normal, 67,3 % rare, 1,4 % superior, 0,00008 % heroic, legendary 0 — thư mời phải tốt hơn khách miễn phí:

    | id | normal | rare | superior | heroic | legendary | giá | Town Hall |
    |---|---|---|---|---|---|---|---|
    | `inv.common` (autoInvite) | 25 | 65 | 9 | 0,9 | 0,1 | 500 | — |
    | `inv.silver` | 5 | 60 | 30 | 4,5 | 0,5 | 4 000 | 4 |
    | `inv.gold` | 0 | 35 | 50 | 13 | 2 | 25 000 | 7 |
    | `inv.royal` | 0 | 0 | 60 | 35 | 5 | chỉ vé | — |

- **Donate** (`hunter.donate {hunterId, gold}`, EHT Manage → Donate): số nguyên dương ≤ vàng Town, chuyển sang `hunter.gold`; hunter đi journey/trong cổng bị từ chối.
- **Banish** (`hunter.banish {hunterId}`): đồ đang mặc → kho đồ Town (`reclaimGear`, event `gearReclaimed`, có thể bị bày bán lại/rã ngay theo §5.8), vàng/túi/thuốc đi theo hunter; hunter rời `world.hunters` (event `hunterBanished` rồi `hunterLeft`), slot trống → đầu hàng chờ vào trong cùng tick.
- **Đổi tính cách** (`hunter.rerollPersonality {hunterId}`): `personalityRerollGold` (2 000) vàng Town, roll lại cả bộ như lúc sinh.
- Lệnh sai bị từ chối bằng `commandRejected` (`unknown invitation`, `no ticket`, `town hall level too low`, `not enough gold`, `town and queue are full`, `invalid gold`, `unknown hunter`, đang journey/cổng). Debug overlay: khối "Hàng chờ" (hàng chờ, timer, nút mời theo từng thư + `+vé`), mỗi hunter có nút `+100g` / `tính cách` / `đuổi`. `tools/headless.ts` in hàng chờ, vé, thống kê mời/đuổi/tặng và log; env `HEADLESS_INVITE="inv.common@30,..."`.
- 🟡 Chưa giải quyết: heroic và legendary có grade giống hệt nhau (khác nhau chỉ ở roll nửa trên) cho tới khi có thêm chỉ số hoặc đổi ngưỡng `tierFromPoints` (test `simulation.test.ts` đang ghim ngưỡng 2/6/10/14); `tier` hiện chỉ để hiển thị; chưa có nguồn vé; chưa có UI ngoài debug.

### 4.2 GearInstance

Thiết kế đầy đủ: `{ gearId, quality (Common..Mythic), enhanceLevel, tier, options: [{optionId, value}], setId?, gearSkillId?, runes[] }`.

Đã làm (M2): `GearInstance = { uid, gearId, qualityId, enhance, difficultyId?, gradeId?, options? }`; món đang bán là `ShopItem` thêm `price`, `listPrice`, `listedAtMs` (world v5). `difficultyId` (world v10) = **tier** của món = độ khó lúc chế (§5.8; thiếu = tier gốc). `gradeId` + `options: [{id, value}]` (world v13) = grade và dòng option roll lúc chế (thiếu cả hai = grade đầu, không option: đồ cũ, đồ journey). Rune chưa làm.

**8 slot (M5, world v13) [ĐÃ LÀM — số liệu ĐỀ XUẤT]** (`GEAR_SLOTS`, thứ tự này dùng cho hòa điểm và thu hồi): `weapon` (ATK) · nhóm giáp `head`/`body`/`gloves`/`shoes` (DEF) · phụ kiện `necklace`/`ring`/`belt` (HP). Lò Rèn chế vũ khí + giáp, Kim Hoàn chế phụ kiện. GDD §6 ghi 7 slot; chọn 8 theo danh sách EHT (vũ khí + 4 giáp + 3 phụ kiện) để bộ 2/4/6 món đủ chỗ.
- **Cân bằng theo slot**: mỗi bậc (level) cũ của giáp/phụ kiện tách thành các món cùng level, chia theo tỉ phần: thân 0,4, mũ/găng/giày 0,2 mỗi món; dây chuyền 0,4, nhẫn/đai 0,3 mỗi món. `mainValue`, `basePrice`, `craftSec` (tối thiểu 4 s) nhân tỉ phần; NL chia theo tỉ phần (dư lớn nhất, mỗi món ≥ 1 đơn vị, nên tổng NL nhích lên ở bậc thấp); tinh chất tier × `essenceMul` (= tỉ phần, `max(1, …)` mỗi món). Tổng chỉ số chính của một bộ đủ món ở một level = món cũ (vũ khí giữ nguyên) → sức mạnh theo level như trước, option/set cộng thêm. `gear.a.*` (thân) và `gear.r.*` (dây chuyền) giữ id cũ; món mới `gear.head/glove/shoe/ring/belt.<bậc>`.
- **Grade + option** (`config/gear_grade.json`, `config/gear_option.json`, `src/core/gear.ts` `rollGearOptions`): grade C/B/A/S/SS/SSS (id `gr.c`…`gr.sss`, tên hiển thị Thô/Khá/Tinh/Quý/Huyền/Tuyệt; tỉ lệ 0,5/0,27/0,13/0,07/0,025/0,005) cho 0/1/2/3/4/5 dòng; SS+ có 1 dòng unique; dòng thường là âm với `negChance` (0,35 → 0,15); giá trị đều trong [min, max) × `valueMul` của grade (dòng âm không nhân), làm tròn 0,1; không trùng option trong một món; `slots` giới hạn slot. Giá niêm yết × `priceMult` của grade (1 … 1,32). RNG của sim, thứ tự cố định: chất lượng → grade → mỗi dòng (loại nếu `negChance` > 0, option, giá trị). Stat của option: `atkPct/defPct/hpPct/atkSpeedPct/crit/eva` (combat) và `lifesteal` (% sát thương gây ra hồi HP, không tính phần thừa), `goldPct`/`expPct` (vàng/EXP mỗi kill), `dropPct` (tỉ lệ rơi NL ×), `needSavePct` (giảm tiêu hao satiety/stamina/mood theo thời gian và satiety mỗi đòn; âm = tốn hơn). Unique có thể cho gear skill thay vì stat.
- **Áp dụng** (`formulas.hunterStats`): option + bonus set là một nhóm % riêng, cộng trong nhóm, kẹp `[gearPctFloor, gearPctCap]` (−30 / 40, được âm), nhân với nhóm trait/buff/aura; crit/eva cộng điểm (trần crit 0,5 / né 0,4 / interval 0,25 vẫn áp dụng ở `critChance`/`dodgeChance`/`minAttackInterval`); `needSavePct` kẹp ±`gearNeedSaveCap` (30). Không có option thì phép tính trùng từng bit với trước. `statsCache` chụp thêm từng dòng option (id, value); set suy ra từ gearId. Hook kinh tế (`gear.gearBonus`/`gearPctMul`): `combat.grantKill` (vàng/EXP nhân cùng hệ số tính cách, rơi NL nhân cùng hệ số bounty), `combat.damageMonster` (hút máu), `needs` và satiety mỗi đòn (`needDrainMul`).
- **Set** (`config/gear_set.json`, `gear.setId`): đếm số slot đang mặc món của set, bonus 2/4/6 món cộng dồn (stat hoặc gear skill). 3 set theo bậc: Tim Hồng (bậc drake/ember L30–31: 2 món ATK +3 %, 4 món HP +4 %, 6 món crit +2), Triều Cường (tide/sigil L60–61: DEF +4 % / ATK +4 % / hút máu 1 %), Vô Tinh (star L80–81: HP +5 % / ATK +5 % / gear skill Sao Rơi).
- **Gear skill** (`config/gear_skill.json`, `skills.procGearSkills`): sau mỗi đòn đánh thường, mỗi gear skill hết hồi roll `chance` (một lượt RNG; không có gear skill thì không thêm lượt nào) rồi cast `skillId` ở `skillLevel` qua đường cast của skill (mọi class); hồi chiêu lưu trong `skillCdMs[gearSkillId]`, buff có `sourceId` riêng (không thay buff đã học); stat `gearSkillProcs`. 3 skill: Bùng Than (fireball L1, 8 %, hồi 6 s), Da Đá (bulwark L1, 5 %, 30 s), Sao Rơi (snipe L1, 10 %, 5 s). Mô hình duel của AI cộng DPS proc kỳ vọng (`gearSkillRate` = 1 / (interval / chance + cooldown)).
- **AI**: xem §5.4 (`gearScore`: option + phần chia đều của bonus set, kẹp ±`gearExtraMaxFrac` 0,6 × chỉ số chính). Bonus set chia đều cho số món đang mặc (không tính bonus ngưỡng biên): với cách tính biên, hunter L64–85 vẫn giữ 2–4 món bộ L30 lúc 8–9 giờ (gear lag 25–27 so với 22 trước M5).
- **Kho đồ Town** `gearStorageMax` 24 → 64 (thu hồi giờ là 8 món / hunter).
- **Số đo** (trước = `feat/m5` `19c10ca` → sau, `tools/pacing.ts 900` và `tools/headless.ts 960 <seed> 120`, seed 1–5): Lv20 62–76 → 59–75 phút, Lv50 3,78–4,65 → 4,25–4,57 giờ, tái sinh đầu 10,58–11,32 → 10,20–11,55 giờ, 0 chết; 16 giờ: craft 410–445 → 757–891, mua 371–395 → 707–827, rã 38–51 → 14–25, bày bán lại 11–14 → 36–49, cường hóa 864–1.426 → 1.756–2.447 lần (tỉ lệ thành công 0,62–0,69 → 0,68–0,71), gear skill proc 451–1.103, kill 18,8–20,7k → 16,1–18,9k, Lv tb 62–78 → 53–69, vàng hunter tb 2,2–8,1k → 1,8–2,8k, tái sinh 8/8 → 7–8/8. Option + set cộng ~+8–13 % `hunterPower` so với cùng đồ bỏ option (probe seed 1); chỉ số chính theo level như trước. Thời gian chạy pacing +60 % (187–209 → 293–370 s). Sau khi merge nhánh tiến trình (world v16), pacing seed 1–5: Lv20 61–76 phút, Lv50 4,30–4,55 giờ, tái sinh đầu 9,87–11,42 giờ, 0 chết.
- **Migration v12 → v13** (`MIGRATIONS[12]`): `armor` → `body`, `accessory` → `necklace` trên hunter, đội journey, hunter trong Cổng Tái Sinh và goal `enhance` đang chờ; món giữ nguyên (không grade/option). Shop/kho/job chỉ giữ gearId nên không đổi. Giáp/phụ kiện cũ giờ chỉ còn 0,4 phần chỉ số: hunter từ save cũ yếu đi ở DEF/HP cho đến khi mua các slot mới. Save v13–v15 ghi bởi bản có `MIGRATIONS[12]` là placeholder: lúc load `fillMissingGearSlots` áp cùng phép đổi (idempotent).

- Chỉ số chính (`formulas.gearMainValue`): `mainValue(gear) × statMult(quality) × gearStatMul(tier) × (1 + enhance × enhanceStatPerLevel)` — enhance cộng tuyến tính theo % của giá trị gốc. Phí cường hóa **không** nhân theo tier (cả `economy.enhanceCost` lẫn `ai/utility.expectedEnhanceCost`).
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
| `learn(skill/trait/growth)` | `bestLearn`: kế hoạch của người chơi (`learnPlan`) trước khi làm được ngay (đủ vàng/điểm); không có thì skill rẻ nhất học được khi vàng dư ≥ phí × `enhanceGoldReserveMul` (level 1 giữ lại vàng khởi điểm), rồi trait theo thứ tự ưu tiên, rồi growth property rẻ nhất khi vàng trừ tiền để dành đồ ≥ giá × `growthReserveMul` (§5.16). Kế hoạch vàng chặn skill/growth tự động, kế hoạch trait chặn trait tự động | skill `1.15`, trait `1.2`, growth `learnGrowthScore` 1,1, × `econMul` |
| `buyMount(mount)` | Ở Town, Shop đã xây, `bestMount`: thú nhanh nhất mua được (level, nhanh hơn thú đang có) khi vàng trừ tiền để dành đồ ≥ giá × `mountReserveMul` (§5.16) | `mountBuyScore` 1,12 × `econMul` |
| `wander` | Ở Town (fallback) | `max(wanderScore, 0.5 × (1 − needsOk))`; rảnh trong Town hồi nhu cầu chậm miễn phí (`townIdleRegenPerSec`) nên hunter hết tiền không bị kẹt |
| `reincarnate` | Không chấm điểm: `progression` gán (bắt buộc, như lệnh) cho hunter đủ điều kiện tái sinh ở Town khi `autoReincarnate` bật, hoặc lệnh `hunter.reincarnate` | Đi tới node Cổng Tái Sinh rồi vào cổng (§5.13) |
| `train` | Ở Town, Training Ground có level ≥ 1, level < level cao nhất Town − `trainLevelGap`, vàng ≥ giá × `trainGoldReserveMul` + tiền để dành đồ (`bestTraining`, §5.15) | `trainScore × econMul` |
| `buyPotion(consumableId)` | Ở Town, Infirmary bán thuốc (Town Hall ≥ `potionTownHallLevel`), còn chỗ trong túi thuốc, `potionSpendFrac` × vàng mua được ≥ 1 (§5.14) | `potionBuyScore × econMul` |
| `dead` | Gán khi chết, không chấm điểm | |

Dịch vụ hết vật tư (§5.14) không được chấm. `train` chỉ được thêm khi khả dụng (Town chưa có Training Ground rút RNG như trước).

**Nhu cầu khẩn cấp** (backstop cứng, ép `returnTown`) **[ĐỀ XUẤT]**: nhu cầu < `urgentHpFrac`/`urgentSatietyFrac`/`urgentMoodFrac`/`urgentStaminaFrac` (hiện 25% / 10% / 10% / 10%), mỗi ngưỡng × `personality(urgent.<need>)` (ví dụ liều lĩnh ×0.5 HP); với HP, ngưỡng = max(ngưỡng theo tính cách, sàn rút lui) — xem **Rút lui** bên dưới. **[CHỐT]** `applyUrgentBackstop` chỉ bắn khi hunter còn sống, ở field (node có zone), không ở trong building và chưa có goal `returnTown`; nó **ghi đè cả lệnh của người chơi** (`forced`). Chạy ở đầu pass AI và chạy lại trong `urgentBackstopSystem` ngay sau combat + skills (§3.2).
**Nhu cầu mềm** (`softNeedFrac`, hiện 40%): kéo `needsOk` xuống, tức giảm điểm `hunt` và tăng `returnTown`; với HP, cả dải khẩn cấp→mềm dời lên đúng phần sàn rút lui vượt ngưỡng khẩn cấp. Ở field, ngưỡng mềm cũng nhân hệ số personality (tối đa `softNeedFrac`) để hunter liều lĩnh đánh tiếp; ở Town thì không, để hunter vừa hồi sinh vẫn đi chữa trước.

Điểm goal ở Town (`shop`, `sell`, `enhance`, `learn`, dịch vụ, nghỉ) dùng hệ số trong `formula_params.json` (`shopBaseScore`, `enhanceBaseScore`, `learnSkillScore`, `serviceLowBase`…), xem chú thích trong `src/core/config/types.ts`.

**Rút lui** **[ĐỀ XUẤT]** (`src/core/ai/utility.ts`). Hunter chết chủ yếu lúc rút khỏi vùng khi quái đang đánh, không phải ở các vùng dưới trên đường về; rút giữa hai trận gần như không mất máu. Đo lại (headless 12 giờ, 30 seed, `tools/combat-report.ts`): > 80% cái chết bắt đầu bằng quyết định về Town khi **≥ 3 quái** đang đánh hunter (tb 5,3 quái) — bị vây, không phải phương sai của một trận đơn.

```
zoneDanger(z)   = crowd(z) × Σ_w (monsterDps, dmgPerKill) / Σ_w        (duel §5.3, chỉ số `planStats` = steady × mood hiện tại; crowd = hệ số đông §5.3, theo trạng thái vùng lúc đó)
tripHome        = Σ_vùng trên đường về (độ dài đường trong vùng / moveSpeed) × zoneDanger.dps
                  (mỗi đoạn tính nửa cho vùng của mỗi đầu; node Town không có vùng → 0)
engaged         = Σ_{quái đang nhắm hunter, còn sống, cùng vùng hunter đứng} expectedHit(quái → hunter)
sàn rút lui     = min(retreatHpCap, (retreatTripMul × tripHome + retreatBurstMul × engaged) / HP tối đa)   (0 ở Town)
ranh giới kill  : không quái nào đang đánh hunter, chọn mục tiêu mới →
                  về ngay nếu HP − retreatKillMul × dmgPerKill/HP tối đa < max(ngưỡng khẩn cấp HP, sàn rút lui)
chọn vùng khác  : needsOk tính với ngưỡng = max(ngưỡng khẩn cấp HP, sàn rút lui ở entryNode) + retreatKillMul × dmgPerKill/HP tối đa
                  → không đi tới vùng mà phải quay về ngay ở ranh giới kill đầu tiên (ở entryNode chưa có quái nào đánh: engaged = 0)
đường về        : trong vùng, nếu đi thẳng tới node thứ hai của path không xa hơn đi qua node gần nhất thì bỏ node gần nhất
                  (`systems/ai.ts` skipNodeBehind) — trước đây hunter rút lui thường đi **sâu vào** vùng 1–2 s tới node gần nhất
```

- `engaged` ≈ "mỗi quái đang bám thêm một đòn" (quái chậm hơn hunter, rời tầm đánh sau ≤ 1 đòn); `retreatBurstMul` 1,5 phủ crit. Bị vây 5–9 quái thì sàn lên `retreatHpCap` ngay lập tức thay vì chỉ sau khi HP đã mất.
- `retreatTripMul` = 2,5 (trước 3). Độ nhạy (pacing 900 phút, seed 1–10, cùng các tham số khác): `retreatTripMul` 1,5 / 2 / 2,5 / 3 → tổng chết 4 / 1 / 0 / 1, chuyến về tới Town dưới 10% HP 150 / 37 / 11 / 5 (trên ~30.000 chuyến). Trước khi có `engaged` và sửa đường về: 2 / 2,5 / 3 → 141 / 62 / 9 chết (seed 1–5). Sàn **không** nhân hệ số tính cách: Liều lĩnh vẫn đánh tới 12,5% ở vùng dễ, nhưng không bắt đầu một chuyến về chết người.
- Ranh giới kill không áp dụng cho lệnh Move của người chơi (`ai.forced`); backstop khẩn cấp (kèm sàn) vẫn áp dụng.
- Backstop chạy mỗi tick nên sàn chỉ được tính khi HP nằm giữa ngưỡng khẩn cấp theo tính cách và `retreatHpCap`; độ dài đường theo vùng được cache theo NavGraph.
- `retreatHpCap` = 0 và `retreatKillMul` = 0 tắt hẳn rút lui (hành vi như trước); `retreatBurstMul` = 0 tắt riêng phần `engaged`.

### 5.3 Chấm điểm vùng săn

Tỷ lệ sức mạnh tính **từ chính công thức combat** (§7.1), không còn `recommendedPower` trong config:

```
duel(h, m)    = hunterDps = E[hit(ATK)]/atkSpeed + Σ skill E[hit(ATK×mult)]/cooldown
                monsterDps = E[hit(ATK quái)]/attackSpeed quái;  ttk = HP quái / hunterDps
                dmgPerKill = monsterDps × ttk
ρ             = max(zoneCrowdMinRho, số quái còn sống trong zone / n)   (n = hunter có goal săn zone đó, kể cả mình;
                zone chưa ai vào tính là đầy = monsterCap)
crowd         = zoneCrowdMul × √ρ                       (formulas.crowdFactor / zoneOccupancy; hiệu chỉnh thực nghiệm)
killsPerLife  = HP hunter / (crowd × Σ_w dmgPerKill / Σ_w)   (w = trọng số spawn; AI dùng `planStats`: bỏ buff, **có** mood hiện tại lên ATK/DEF; journey/offline dùng steady không mood)
ratio         = √(killsPerLife / zoneRefKills)          (1 = đánh được zoneRefKills con trên một thanh HP)
zoneFit       = 0 nếu ratio < zoneFitMin; ramp zoneFitRampLow→1 tới zoneFitBest; 1 tới zoneFitEasy;
                rồi giảm zoneFitDecay mỗi 1.0 ratio, sàn zoneFitFloor (quá dễ, ít EXP)
share         = min(1, ttk / (n × respawnSec))          (n = số hunter đang săn zone đó, kể cả mình)
fit           = zoneFit × (zoneShareFloor + (1 − zoneShareFloor) × share)
tie-break     = trong các zone "thoải mái" (ratio ≥ zoneFitBest), zone khó nhất giữ nguyên điểm,
                mỗi bậc dễ hơn bị trừ zoneTierBonus (> decisionNoise) → hunter vượt mọi zone chọn zone khó nhất
```

**Hệ số đông** (thay `zoneCrowdRespawnSec / respawnSec`, vốn chỉ có hai mức 0,5 / 1): đo HP mất mỗi kill / duel theo (zone, số hunter) trên 10 seed × 15 giờ cho thấy mọi zone nằm trên **một đường cong theo ρ** = quái còn sống / hunter: một hunter một mình trong zone đầy (ρ ≈ 10–12) kéo thêm quái, mất ≈ 1,8–2,1× duel; nhiều hunter chia aggro và cùng đánh một con (ρ ≈ 3 → ≈ 1,1×; ρ ≈ 0,25 → ≈ 0,3×). Tốc hồi quái, monsterCap, aggroRange tác động qua ρ. `zoneCrowdMul` 0,62 khớp ±10% trên khoảng ρ 0,1–12. Journey không có zone thật nên `zonePower` vẫn dùng hệ số tĩnh `zoneCrowdRespawnSec / respawnSec` và mốc riêng `journeyRefKills` (= 8, giá trị `zoneRefKills` lúc đặt mục tiêu journey), nên sức mạnh đội không đổi.

Độ chính xác (HP mất mỗi kill đo / dự đoán của AI, pacing 900 phút seed 1–10, tham số hiện tại): Đồng Cỏ 1,20, Phế Tích 1,15, Đầm Sương 1,04, Vách Tro 1,05, Sông Băng 1,07, Thành Cổ Chìm 1,07, Vực Thẳm 1,01 (trước: ≈ 1,0 / 0,5–1,5 tùy seed / 1,2–1,6 / 0,9–1,35 / 1,05–1,4 / 0,9–1,2 / 1,0–1,2; chia theo số hunter thì trước đây 0,05–2,1 trong cùng một zone). Theo (zone, n) với ≥ 300 kill: hầu hết trong ±20%; lệch còn lại ở zone hồi 6 s đầu game (Phế Tích n = 2–3: 1,26; Đồng Cỏ n = 1: 1,21).

Căn bậc hai làm ratio tuyến tính theo chỉ số: hunter gấp đôi DPS **và** gấp đôi HP hiệu dụng có ratio ×2, nên ngưỡng 0.7 / 1.1 / 2 vẫn đọc được. Test `tests/formulas.test.ts` đối chiếu `duel()` với combat mô phỏng 1-đấu-1 (sai số ≤ 15%) và đối chiếu HP mất mỗi kill trong mô phỏng đầy đủ với dự đoán.

Ngưỡng là **[ĐỀ XUẤT]** (`formula_params.json`). Yêu cầu vật liệu (§5.7) chỉ đổi **lựa chọn vùng**: sau `fit` ở trên, mỗi vùng khả dụng (fit > 0) nhân `(1 + requestZoneBonus × tỉ lệ giá trị rơi đang được yêu cầu) / max(hệ số đó của các vùng khả dụng)`, nên điểm săn cao nhất không bao giờ tăng so với khi không có yêu cầu và vùng hunter không sống nổi không bao giờ được cộng. Chief dùng lệnh Move để ghi đè: goal `Hunt(zoneChỉĐịnh)` được giữ cho đến khi xong hoặc có nhu cầu khẩn cấp.

### 5.4 Mua đồ và cường hóa

**Mua đồ** (`bestShopPurchase`, thực hiện ở `economy.doShop`):

- `gain = (gearScore(mới) − slotValue(cũ)) / max(slotValue(cũ), 1)` — so gear cùng slot theo **đơn vị chỉ số chính**, **chưa** có trọng số theo class.
- **Giá trị gear (M5, `formulas.gearScore`)**: `gearMainValue + clamp(Δln P(option + gear skill + phần chia đều của bonus set, = bonus đạt được / số món đang mặc) / mainStatWorth, ±gearExtraMaxFrac × chính)`, với `P = √(DPS × HP hiệu dụng)` (cùng mô hình với powerRatio, §5.3). `mainStatWorth` = ∂ln P / ∂(1 điểm chỉ số chính thô): ATK/HP `0,5 / tổng thô`, DEF `0,5 × (DEF/thô) / (DEF + defPerLevel·L + defFlat)`. Δln P của stat combat tính từ chỉ số steady của hunter (atk/hp/speed % → 0,5 × %, def % theo giảm sát thương, crit/né theo trần thật); stat không combat theo hệ số `gearWorthLifesteal/GoldPct/ExpPct/DropPct/NeedSavePct` (Δln P mỗi điểm). Món không option, không set → đúng `gearMainValue` (quy tắc cũ giữ nguyên). Vì gain vẫn tương đối theo slot nên `minUpgradeGain`, `enhanceVsUpgradeMul`, `craftMinSellChance` giữ nghĩa. `slotValue` = gearScore của món đang mặc (memo theo object chỉ số steady + slot).
- Món **chưa roll** (đang chế, công thức lý thuyết trong để dành, người hưởng lợi auto-craft): `expectedGearScore` = giá trị chính + phần chia đều của bonus set, **không** cộng option kỳ vọng (một nửa số món không có dòng nào; cộng trung bình làm hunter để dành / Town chế lại cùng bậc để "đánh bạc" option). Cường hóa: `step`/`loss` vẫn theo chỉ số chính, `expectedRelGain` chia cho `slotValue` (đã có option/set).
- Chỉ mua khi `gain ≥ minUpgradeGain`, level hunter ≥ level gear và `giá ≤ gold × spendRatio × personality(spendRatio)` **[ĐỀ XUẤT]**. Nhiều món đạt: `min(gain, 1)` cao nhất, hòa thì giá thấp hơn, rồi `uid`.
- Đồ cũ bị bỏ (không bán lại, không vào kho). HP hiện tại không được hồi khi max HP tăng.

**Cường hóa theo kỳ vọng** (`bestEnhance` trong `ai/utility.ts`; thực thi và luật thành/bại ở §4.2). Với mỗi slot có gear, `p = successRate` của bước kế, `step` = chỉ số chính tăng thêm nếu thành công, `loss` = chỉ số mất nếu thất bại (chỉ khi `dropOnFail` và `enhance > 0`):

```
khả dụng      : p ≥ enhanceMinSuccess
                và expectedGain ≥ enhanceMinNetFrac × p × step         (cổng kỳ vọng; bước có drop: p ≥ 1 / (2 − enhanceMinNetFrac))
                và gold ≥ phí × enhanceReserveMul(p) [+ hold]
enhanceReserveMul(p) = enhanceGoldReserveMul / p^enhanceRiskExp      (bước rủi ro cần nhiều vàng dư hơn)
hold          = enhanceSavings(hunter).hold, bỏ qua nếu (expectedRelGain / phí) ≥ enhanceVsUpgradeMul × relGainPerGold của món đang để dành
chọn slot     : expectedGain / phí lớn nhất (chỉ số kỳ vọng ĐÃ trừ loss trên mỗi vàng); hòa → thứ tự GEAR_SLOTS
expectedGain  = p × step − (1 − p) × loss;  expectedRelGain = expectedGain / max(giá trị hiện tại, 1)
điểm goal     = (enhanceBaseScore + enhanceGainWeight × expectedRelGain) × econMul      (§5.2)
```

**Để dành mua đồ** (`savingsTarget` / `enhanceSavings`, `ai/utility.ts`). "Nâng cấp" của một slot = gear cùng slot, level ≤ level hunter, giá trị ≥ hiện tại × (1 + `minUpgradeGain`); `spend = spendRatio × personality(spendRatio)`:

- **cụ thể** (món đang bán — giá hiện tại đã giảm, chất lượng thật — hoặc đang chế — giá trị Rare, giá `basePrice × aiTypicalQualityMult`): hold = `upgradeSavingsConcreteFrac` (1) × giá / spend, tức đủ để ngân sách shop mua được;
- nếu không có món cụ thể: gear mà Lò Rèn/Kim Hoàn chế được (§5.12) với giả định chất lượng `aiTypicalQualityMult` → hold = `upgradeSavingsFrac` (0,5) × giá / spend (trước đây 0,3: hunter giữ ≈ 0,34 × basePrice, dưới ngưỡng `craftAffordFrac` nên auto-craft không tính họ là người mua);
- trong mỗi loại chọn món rẻ nhất; `relGainPerGold = ((giá trị − hiện tại) / max(hiện tại, 1)) / giá`;
- hold **theo hunter**: món có hold lớn nhất trên mọi slot (cường hóa slot không có nâng cấp cũng không tiêu tiền đang giữ cho slot khác);
- được tiêu vào hold chỉ khi lần cường hóa đáng giá hơn món đang để dành `enhanceVsUpgradeMul` (6) lần trên mỗi vàng (phần cường hóa mất khi thay đồ). Với bảng gear hiện tại bậc kế tiếp gần như luôn thắng, nên trên thực tế hunter chỉ cường hóa đồ chưa có nâng cấp (bậc cao nhất chế được / đang dùng) hoặc khi vàng đã vượt hold.

**Cổng kỳ vọng** `enhanceMinNetFrac` (−0,25): không thử bước có drop mà kỳ vọng âm quá ¼ bước thành công (p < 0,444: +8 trở đi; với Lò Cường Hóa L5 +0,08 thì +8 lại được thử). Ở 0 hunter +6 không còn chỗ tiêu vàng sau 12 giờ (vàng hunter 16 giờ cao hơn 5/5 seed), nên chọn −0,25.

**Số đo** (headless 16 giờ seed 1–5, Dễ, thuế 10%; trước = `958da52` → sau, cùng với §5.12): mua đồ 142–150 → **207–213** lúc 12 giờ (16 giờ 151–161 → 213–223), craft 161–178 → 232–255, bỏ 16–25 → 19–36 (tỷ lệ bỏ 10–14% → 8–14%); hunter mặc đồ trễ level trung bình 21,6–25,3 → 15,2–18,1 level lúc 12 giờ; số lần cường hóa 16 giờ 1.403–1.740 → 307–444, tỷ lệ thành công 0,61–0,65 → 0,65–0,73 (12 giờ 0,72–0,83; bảng theo bước: trước ~27% số lần thử ở bước p ≤ 0,5, +7 … +10; sau +7 còn 2–11 lần / 16 giờ, không còn +8 trở lên). Hệ quả: phí cường hóa (vàng bị đốt lớn nhất) giảm mạnh nên **vàng hunter cao hơn**: tb 12 giờ 4,9–6,5k → 7,9–12,4k, 16 giờ 7,1–12,0k → 7,2–16,1k (xem TODO §1).

### 5.5 Tính cách là hệ số (modifier)

Mỗi personality là một bộ hệ số nhân vào needs, utility, phần thưởng hoặc tỉ lệ cường hóa (`personalityFactor` = tích các `mul` + tổng các `add`; không có modifier = 1, kết quả giống hệt bit). `kind` (positive/negative/neutral) chỉ để hiển thị. Target hợp lệ: `PERSONALITY_TARGETS` (`config/types.ts`; `config:check` báo target lạ):

| Target | Đọc ở |
|---|---|
| `goal.hunt`, `goal.service.<need>` | utility săn / dịch vụ (ai/utility.scoreGoals) |
| `spendRatio` | ngân sách mua đồ / cường hóa / auto-craft |
| `decay.<need>` | giảm nhu cầu (needs, combat, thuế mood) |
| `urgent.<need>` | ngưỡng khẩn cấp; `urgent.hp` = ngưỡng rút lui (`retreatHpFloor` cố ý không nhân) |
| `moveSpeed` | tốc di chuyển |
| `gain.gold` (M5) | vàng mỗi kill trước thuế (`combat.grantKill`, làm tròn) |
| `gain.exp` (M5) | EXP mỗi kill (không áp cho journey) |
| `enhance.success` (M5) | tỉ lệ thành công cường hóa (`economy.doEnhance` và ước lượng AI `expectedEnhanceCost`), kẹp ≤ 1 |

Danh sách (`config/personality.json`, 21 dòng, mỗi hunter `personalitiesPerHunter` = 2; số liệu **[ĐỀ XUẤT]**):

| Loại | Personality (trọng số) → hiệu ứng |
|---|---|
| Tích cực | Chạy nhanh (10) moveSpeed ×1,15 · Vui vẻ (20) decay.mood ×0,7 · Tay hên (10) gain.gold ×1,15 · Ham học (10) gain.exp ×1,08 · Tay vững (10) enhance.success ×1,1 · Ăn ít (10) decay.satiety ×0,75 · Bền bỉ (10) decay.stamina ×0,75 · Hăng hái (10) goal.hunt ×1,1 |
| Tiêu cực | Nhút nhát (20) goal.hunt ×0,7 · Ham ăn (20) decay.satiety ×1,3 · Hay buồn ngủ (20) decay.stamina ×1,3 · Liều lĩnh (12) urgent.hp ×0,5 + goal.hunt ×1,15 ("không bao giờ rút") · Hay hoảng (10) urgent.hp ×1,5 ("rút sớm") · Xui xẻo (10) gain.gold ×0,88 · Lơ đãng (10) gain.exp ×0,94 · Vụng về (10) enhance.success ×0,9 · U sầu (10) decay.mood ×1,3 |
| Trung tính | Bình thường (30) · Tiết kiệm (20) spendRatio ×0,5 · Hào phóng (10) spendRatio ×1,3 · Ham nhà (10) goal.hunt ×0,9 + goal.service.mood ×1,3 |

Cặp tích cực/tiêu cực cùng target có trọng số bằng nhau và gần trung hòa về trung bình (gain.gold ≈ ×1,015, gain.exp ≈ ×1,01). Nhịp `tools/pacing.ts 900` seed 1–5 (trước → sau): Lv20 60–73 → 62–76 phút, Lv50 4,02–4,70 → 3,78–4,72 giờ (seed 3 xuống 3,78), tái sinh đầu 10,62–11,93 → 10,68–11,58 giờ (mục tiêu 8–14), hunter đã tái sinh lúc 15 giờ 40/40 → 39/40 (seed 5: 7/8), 0 chết — trong nhiễu seed. Phần hàng chờ/thư mời một mình (trước khi đổi personality) cho kết quả giống hệt từng byte. Đổi tính cách: `hunter.rerollPersonality` (§4.1).

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
- **Bỏ món**: tuổi bỏ = `shopScrapAgeSec` = `ceil((1 − floor) × 100 / pct)` bước × `shopStaleSec` + `shopFloorHoldSec` (không dùng `shopScrapSec` nữa) → giá luôn chạm sàn và được chào ở giá sàn `shopFloorHoldSec` giây trước khi bị bỏ. Món bị bỏ được **rã** (world v10, xem dưới): event/stat `gearDismantled`; chỉ khi rã không trả lại gì (`dismantleReturnFrac` 0) mới là `gearScrapped` như trước (hai stat loại trừ nhau theo từng món). `shopFloorHoldSec` < 0 = không bao giờ bỏ. Mặc định 600 s / 10% / 0,5 / 600 s → 100→50% trong 3.000 s, bỏ lúc 3.600 s. `config:check` kiểm tra `shopStaleSec` ≥ 1, `shopMarkdownPct` trong (0, 100], `shopMarkdownFloor` trong [0,01; 1] và từ chối key cũ `shopScrapSec`.
- **Chọn công thức auto-craft** (`pickRecipe`): trong các công thức có đủ NL và vàng Town ≥ giá craft + `autoCraftReserve`, chọn cái có nhiều người hưởng lợi nhất (`recipeBeneficiaries`), rồi gear level cao hơn, rồi gearId; 0 người → không chế.
- **Người hưởng lợi**: hunter level ≥ gear.level − `craftLevelAhead`; với mỗi chất lượng q, bản q được tính nếu là nâng cấp ≥ `minUpgradeGain` (công thức như AI mua đồ) **và** ngân sách shop ≥ `craftAffordFrac × round(basePrice × q.priceMult)`; hunter được tính khi tổng `craftChance` (chuẩn hóa) của các bản đó ≥ `craftMinSellChance` (0,65 = Uncommon trở lên phải bán được; 0,35 = chỉ cần Rare, gần quy tắc cũ — trùng hẳn khi `craftAffordFrac` = 0). Ngưỡng so với tỷ lệ cộng dồn của `craftChance`, nên đổi `gear_quality.json` thì phải xem lại.
- ✅ **Đã sửa (world v10, xem "Tier đồ theo độ khó, thu hồi, rã đồ" bên dưới).** Phân tích trước khi sửa: **sau tái sinh shop gần trống là do cấu trúc, không phải do chọn công thức** (census mỗi 30–60 phút: seed 1 12,5–16 giờ với tham số trung gian của pass 2; seed 2 12–16 giờ với tham số cuối — 12 giờ còn 3 công thức có người mua và 4 món bán, 13 giờ 1, 14–16 giờ 0): hunter giữ đồ khi tái sinh (`progression.reincarnate`), đồ L50–80 +5/+6 vượt mọi thứ đeo được ở level thấp, và món nâng cấp kế tiếp của mọi slot là đồ star (L80/81) — chỉ mua được khi lên lại L80. Ngay trước tái sinh (L89–99, đồ tide/void +5/+6) chỉ bản Rare+ của đồ star là nâng cấp ≥ 12% (tổng `craftChance` 0,35 < `craftMinSellChance` 0,65), nên auto-craft đúng là không chế (65% sẽ thành đồ bỏ). Không có công thức nào có người mua ⇒ không thay đổi cách chọn craft nào lấp shop mà không thành đồ bỏ. Buy-back cũng không giúp (không ai cần đồ thấp). Muốn shop có ích sau tái sinh cần quyết định design: tái sinh tháo/giảm đồ, giới hạn đồ đang mặc theo level, hoặc hunter mới thay hunter đã max (TODO §1).
- **M5 (8 slot, option)**: mọi so sánh giá trị ở đây (người hưởng lợi, đồ đã có, `storedGearBuyers`) dùng `gearScore` / `expectedGearScore` của từng hunter (§5.4), giống quy tắc mua của AI; món vừa chế roll grade + option (§4.2), giá × `priceMult` của grade; thu hồi/bày bán lại giữ grade + option.
- **Đồ đã có**: món cùng slot, level ≤ công thức đang bán (chất lượng thật) hoặc đang chế (chất lượng tham chiếu Rare) tính theo **số bản**: hunter vẫn được nâng cấp so với món tốt nhất trong số đó luôn được tính; hunter mà món có sẵn đã phục vụ chỉ được tính phần vượt quá số bản.

#### Tier đồ theo độ khó, thu hồi, rã đồ (world v10) **[ĐÃ LÀM — số liệu ĐỀ XUẤT]**

Code: `src/core/systems/gearTier.ts` (tier, tinh chất, tự tăng độ khó), `src/core/systems/crafting.ts` (craft theo tier, kho đồ, thu hồi, rã), một lệnh gọi `reclaimGear(ctx, h)` trong `progression.reincarnate`. Ý tưởng lấy từ EHT (đồ chế ở độ khó cao mạnh hơn, "Reclaim Equipment", rã đồ thường lấy lại NL); tên và số là của game này.

- **Tier = độ khó lúc chế.** Mỗi món ghi `difficultyId`; chỉ số chính × `gearStatMul`, giá niêm yết và vàng craft × `gearPriceMul` của độ khó đó (`difficulty.json`; độ khó đầu tiên là tier gốc ×1, `config:check` bắt buộc; `gearStatMul` không giảm theo `order`). Đề xuất: Thường 1,6 · Khó 2,5 · Chuyên Gia 4 · Ác Mộng 6,5 · Dày Vò I/II/III 10/15/22 (giá cùng hệ số). Tên hiển thị có tiền tố tier (`gearPrefixKey`: Tôi Luyện, Mài Sắc, Khắc Ấn, Rèn Ác Mộng, Phẫn Nộ I–III). Với `enhanceStatPerLevel` 0,06, bản Rare +0 tier Thường (×1,6) hơn bản Rare +6 tier gốc (×1,36) 18% (> `minUpgradeGain`), nên đồ cũ hết giá trị khi tier mới có hàng.
- **Công thức theo tier** (`recipeMaterials`): NL của `gear.json` + `max(1, round(gear.level × craftEssencePerLevel))` (0,05 → 1–4) **tinh chất** của tier (`essenceId`, 7 vật liệu `mat.ess.*`, giá 40…4.800). Tinh chất **chỉ** rơi từ quái sinh ở độ khó đó (`essenceDropChance` 0,03 mỗi kill vào túi; Dễ không có nên không thêm lượt RNG — đời đầu chạy y như trước). Trạm Thu Mua tự yêu cầu tinh chất như NL thường (`trading.autoMaterialDemand` dùng tier cao nhất có người muốn, `crafting.demandTier`).
- **Tier được chế** (`craftTiers`): tier gốc + các độ khó đã mở có `order` ≤ độ khó hiện tại. Auto-craft (`pickCraft`) chấm mọi cặp (công thức, tier) có đủ NL: nhiều người hưởng lợi hơn → tier cao hơn → gear level cao hơn → gearId; người hưởng lợi tính theo giá trị và giá của tier đó. Lệnh `town.craft` có `difficultyId` tùy chọn (mặc định tier gốc). Job ghi tier lúc bắt đầu (đổi độ khó giữa chừng không đổi món). Giới hạn level của Lò Rèn/Kim Hoàn (`gearCraftable`) là trục riêng, không đổi.
- **Tự tăng độ khó** (`town.autoDifficulty`, mặc định bật; lệnh `town.setAutoDifficulty`): khi độ khó kế tiếp (theo `order`) đã mở và có ≥ `max(unlockHunters, ceil(diffAutoAdvanceFrac × số hunter))` hunter (cả hunter đang journey) có số lần tái sinh ≥ `unlockReincarnation` của nó, Town lên một bậc (event `difficultyChanged`). Không bao giờ tự hạ. `diffAutoAdvanceFrac` 0,5 → 8 hunter cần 4 người tái sinh (Thường mở từ 3). `town.setDifficulty` thủ công tắt chế độ tự động.
- **Thu hồi khi tái sinh** (`reclaimGear`): mọi món đang mặc vào **kho đồ Town** (`town.gearStorage`, giữ chất lượng/cường hóa/tier; món không có tier nhận tier gốc), event `gearReclaimed`, stat `gearReclaimed`. Chạy trong `reincarnate()`, tức lúc hunter ra khỏi Cổng Tái Sinh (`leavePortal`, §5.13), kể cả khi cổng hết giờ lúc offline; bỏ qua nếu context không có Town. Lệnh `hunter.reclaimGear` (hunter ở Town, không journey, có đồ; HP kẹp theo max mới).
- **Kho đồ → shop**: khi auto-craft bật và shop còn chỗ (tính cả job đang chạy), mỗi tick bày bán lại **một** món có nhiều người mua nhất (`storedGearBuyers` ≥ 1: level ≥ gear level, ngân sách ≥ `craftAffordFrac` × giá, hơn ≥ `minUpgradeGain` so với max(slot, món cùng slot đang bán mà họ đeo được)), trước khi chọn craft. Món không ai dùng được ở lại kho. Giá = `round(basePrice × priceMult × gearPriceMul × (1 + enhance × enhanceStatPerLevel))`, sau đó giảm giá/rã như món mới (stat/event `gearRelisted`). Lệnh `town.listGear`, `town.dismantleGear`. Kho tối đa `gearStorageMax` 24 món; vượt thì rã món cũ nhất.
- **Rã đồ** (`dismantleItem`): trả `floor(count × dismantleReturnFrac)` (0,5) mỗi NL của công thức ở tier của món (cả tinh chất) vào kho Town, không RNG; event `gearDismantled` (`source` shop/storage/command, `materials`), stat `gearDismantled`. Chưa rã đồ craft chất lượng thấp ngay khi chế xong (chúng vẫn được bán như thường).
- **Phí cường hóa** không theo tier (để nguyên cả hai nơi tính).
- **Số liệu** (headless 16 giờ `tools/headless.ts 960 <seed> 120`, seed 1–5, đã có Cổng Tái Sinh §5.13; trước = `fix/economy-and-formulas` `8b84566` → sau): shop 12 giờ 1–7 → 5–10 món, **14 giờ 0–3 → 7–18**, **16 giờ 0 → 9–19**; mua đồ 227–255 → 347–394; craft 262–299 → 404–442; bỏ 30–45 món → 0 bỏ, rã 41–56; bày bán lại đồ thu hồi 5–12; vàng Town 16 giờ 2,9–14,7k → 15,4–57,6k; vàng hunter tb 16 giờ 8,3–25,5k → 2,0–5,8k (tiền đi vào mua lại đồ); độ khó lên Thường lúc 13–14 giờ (seed 3: 14–16 giờ); Lv tb 16 giờ 26–58 → 39–59; chết 0 → 0; kho NL 16 giờ ~50 → 129–211 đơn vị (NL rã của đồ L60–80, dùng lại khi hunter lên lại level đó). Với `dismantleReturnFrac` 0 timeline trước tái sinh trùng từng byte với trước khi sửa (seed 1, đo trước khi merge cổng). Nhịp (`tools/pacing.ts 900`, seed 1–5): Lv20 62–79 phút (không đổi), Lv50 4,23–4,53 → 4,00–4,73 giờ, tái sinh đầu 12,48–13,72 → 12,07–13,37 giờ (rã đồ trả NL nên kinh tế đời đầu đổi chút; trong mục tiêu 60–80 phút / 4–6 giờ / 8–14 giờ), chết trong 15 giờ 0 → 0.

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
- **Cái giá của thuế cao**: mỗi kill **có bị thu** (tax > 0) làm người giết mất `taxMoodPerKill × max(0, rate − taxMoodFreeRate) × personality(decay.mood)` mood. Mood tác động qua việc hunter phải về Tavern sớm/nhiều hơn (tốn thời gian và vàng ở Town, săn ít hơn) và, dưới `moodPenaltyFrac`, giảm ATK/DEF (§7.1 Mood). Tại/dưới `taxMoodFreeRate` (= mặc định 10%) không mất gì nên mặc định không đổi nhịp.
- **Event/stat**: `taxCollected { hunterId, gold }` mỗi kill bị thu (không hiện trong log overlay), stat `taxCollected`. Debug overlay: dòng thuế (tỉ lệ, đã thu, mood/kill) và nút −5% / +5%. `tools/headless.ts` in cột `tax` trong sổ Town (trừ khỏi phần dư `fees`) và cộng lại vào `hunter kill` (vàng kill trước thuế).
- **Mặc định**: `taxRate` 0,1, `taxMinRate` 0, `taxMaxRate` 0,5, `taxMoodFreeRate` 0,1, `taxMoodPerKill` 10.
- **Số đo** (headless 12 giờ, seed 1–5, trước → sau với 10%): vàng Town lúc 12 giờ 23,0–26,5k → 21,5–26,9k; vàng hunter tb 6,0–6,7k → 5,9–7,6k, max 7,6–12,5k → 9,0–14,3k; Lv tb 82,1–85,9 → 79,6–85,3; shop 3–11 → 5–8 món; chết tổng 11 → 7 (seed 6–10: 4 → 11; 10 seed 15 → 18). Trung bình 10 seed: Lv 84,8 → 84,8, vàng hunter tb 7,0k → 7,2k — trong nhiễu. Thu 27,9–34,4k / 12 giờ (≈ 9% vàng kill; vàng kill chỉ ≈ 1/3 thu nhập hunter, phần lớn là tiền bán NL). `taxRate` 0 cho kết quả giống từng byte với trước. Thuế cao (seed 1–2): 30% → vàng Town 29,5/33,3k, vàng hunter tb 5,7/4,6k, Lv 83,0/78,8, lượt dịch vụ +9/+13%, kill −2/−3%; 50% → 28,5/39,3k, 5,6/3,9k, Lv 80,8/77,3, dịch vụ +19/+15%, kill −3%. (`taxMoodPerKill` 2 thì ở 50% không đo được khác biệt dịch vụ/level, nên chọn 10.)
- **Lưu ý**: khi vàng Town đang trên mục tiêu ngân khố (§5.7), thu thêm bị quy tắc ngân khố bù lại (Town giữ ít phí hơn, phần còn lại bị đốt), nên ở 10% thuế thực chất là **chỗ tiêu vàng hunter**, không làm Town giàu hơn. Thuế chỉ thành thu nhập thật của Town khi Town dưới mục tiêu — tức khi có chỗ tiêu vàng Town ra khỏi nền kinh tế (xây/nâng building). Khi đó tăng `taxRate`/`town.setTaxRate` là đòn bẩy.

### 5.11 Journey (GDD §9) **[ĐÃ LÀM — số liệu ĐỀ XUẤT]**

Code: `src/core/systems/journey.ts` (system `journey` chạy sau `bounty`, trước `needs`), `formulas.ts` (`zonePower`, `teamPower`, `journeySuccessChance`), lệnh trong `commands.ts`, bảng `config/journey.json`, tham số `journey*` ở cuối `formula_params.json`. World v9: `world.journeys` (theo thứ tự xuất phát), stat `journeysStarted` / `journeysSucceeded` / `journeysFailed` / `journeysRecalled` / `journeyGold`.

- **"3 NPC" = 3 slot hunter mỗi chuyến**: người chơi gửi một đội 1..`journeyTeamMax` (3) hunter **của Town** (không phải NPC riêng); tối đa `journeyMaxActive` (2) chuyến cùng lúc. Cách hiểu này dùng lại toàn bộ chỉ số/đồ/level của hunter làm "sức mạnh đội" và tạo đánh đổi: hunter đi xa thì không săn, không mua đồ.
- **Lệnh** `journey.start { journeyId, hunterIds }`. Từ chối (`commandRejected`): điểm đến lạ, đội rỗng / > `journeyTeamMax` / không phải mảng, trùng hunter, hunter lạ, đang đi chuyến khác, đã chết, đang trong building, **không ở Town** (node có zone — gọi về Town bằng Move trước), đã đủ `journeyMaxActive`, vàng Town < `cost`. `journey.recall { journeyUid }` gọi đội về ngay: không thưởng, không hoàn `cost`.
- **Vắng mặt**: lúc xuất phát hunter được **chuyển ra khỏi** `world.hunters` vào `journey.hunters` (AI reset, buff xóa, quái đang nhắm thì bỏ). Vì vậy không system nào (AI, di chuyển, combat, nhu cầu, tái sinh, AI chấm vùng/bounty) đụng tới họ: nhu cầu, level, vị trí **đóng băng**. Họ vẫn giữ slot (`townHunterCount` cho arrivals và `debug.spawnHunter`), vẫn được tính khi mở khóa độ khó (`allHunters`). Mọi lệnh theo hunter (Move, Activities, tái sinh, debug hồi/xóa) bị từ chối với lý do `hunter is on a journey`.
- **Sức mạnh đội** (từ chính mô hình combat §5.3/§7.1, không có chỉ số mới):
  ```
  zonePower(h)   = √(killsPerLife(h, vùng của điểm đến, độ khó Town lúc xuất phát) / zoneRefKills)   (= powerRatio của AI, chỉ số steady)
  teamPower      = Σ zonePower(thành viên)
  successChance  = clamp(journeySuccessAtRec × (teamPower / recommendedPower)^journeySuccessExp, journeySuccessMin, journeySuccessMax)
  ```
  powerRatio tuyến tính theo chỉ số nên n hunter giống nhau = n× (như một hunter có n× DPS và n× HP). `recommendedPower` 3,5 = "ba hunter mỗi người thoải mái ở vùng đó" → 0,75. Mặc định 0,75 / mũ 2 / [0,05; 0,95]: ½ đề xuất → 19 %, 0,8× → 48 %, 1,13× → 95 %. Sức mạnh và tỉ lệ được **chụp lúc xuất phát** (lưu trong journey).
- **Thời gian**: `remainingMs` giảm theo thời gian game mỗi tick; khi tắt game giảm theo **thời gian thực** (xem §9). Về 0 thì **roll kết quả bằng RNG của sim** (`rng.next() < successChance`, rồi khi thành công mỗi dòng `rare` một lần `rng.chance`). Không có chuyến nào thì system không rút RNG, không phát event: headless/hash world giống từng byte với trước (đã kiểm: hash world + event mỗi phút 90 phút seed 1–2; output `tools/headless.ts` 120 phút chỉ khác thêm 5 khóa stat).
- **Thưởng** (bảng `journey`): thành công → `gold` vào Town, `exp` mỗi thành viên (qua `gainExp`, có trần level; cả hai × `rewardMul` của độ khó lúc xuất phát), `materials` đi theo **luật yêu cầu của Trạm Thu Mua** §5.7 (`routeRewardMaterials`, không rút RNG): phần được yêu cầu (`materialDemand` lúc về: tự động + người chơi; yêu cầu người chơi bị trừ như khi bán) vào kho, phần còn lại Town **bán xuất khẩu ngay** với `surplusPrice` (cộng vào `rewards.gold`/`journeyGold`, không cần ngân sách dư vì Town không trả gì; ghi ở `rewards.exported`) — kho không bao giờ giữ NL không ai yêu cầu, giống NL hunter bán, `rare` (gear + chất lượng + tỉ lệ): trúng thì bày lên shop như đồ vừa chế; shop đầy thì Town bán ngay với giá sàn `round(giá × shopMarkdownFloor)`. Thất bại → chỉ `round(exp × failRewardFrac)`, HP về ≤ `failHpFrac` × max. Cả hai trường hợp satiety/mood/stamina về ≤ `journeyReturnNeedFrac` (0,5) × max nên đội về sẽ đi dịch vụ. Thành viên về **quảng trường**, AI mới, nối vào cuối `world.hunters`.
- **Tái sinh**: hunter đang đi không tái sinh (không nằm trong `world.hunters`); EXP thưởng có thể đưa lên max level, rồi khi đã về Town `progression` gửi họ tới Cổng Tái Sinh (§5.13). Lệnh tái sinh thủ công bị từ chối khi đang đi.
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
  | training / bank / monument / fountain / library (M5, xây được) | xem §5.15 | |

  Trần tier áp ở `startCraft` (lý do `gear tier locked by building level`), `pickRecipe`, yêu cầu NL tự động (không mua NL cho công thức chưa chế được) và `upgradeSavings` của AI (không để dành cho đồ chưa ai chế được).
- **Ô đất**: 10 building cũ giữ chỗ và cửa cũ; Town Hall ở ô trong (`d.townhall`); 6 ô trống `plot.ne`/`plot.se`/`plot.sw` mở ở Town Hall 2/4/6 và (M5, §5.15) `plot.e`/`plot.nw.outer`/`plot.se.outer` ở Town Hall 3/5/7 — đủ cho Nhà Kho + 5 building M5.
- **Lệnh**: `town.build { buildingId, plotId }`, `town.upgrade { buildingInstanceId }` (id = id ô), `town.cancelUpgrade { buildingInstanceId }` (hoàn đủ vàng + NL; hủy xây lần đầu thì trả ô), `town.setAutoInvest { on }`. Từ chối (`commandRejected`): `unknown building`, `unknown plot`, `plot occupied`, `already built`, `plot locked by Town Hall level`, `building locked by Town Hall level`, `unknown building instance`, `upgrade in progress`, `max level`, `locked by Town Hall level`, `construction slots full` (`buildMaxConcurrent` 2), `missing materials`, `not enough town gold`, `no upgrade in progress`. Lệnh người chơi cần đủ NL trong kho (không nhập).
- **Thanh toán**: vàng (× `buildCostMul`) và NL trong kho trả **ngay khi bắt đầu** và **rời khỏi nền kinh tế** (event `buildingStarted { gold, materials, importGold }`); building vẫn chạy ở level cũ tới khi xong (`sec × buildTimeMul`, event `buildingCompleted`).
- **Tự đầu tư** (`town.autoInvest`, mặc định bật; mỗi `townInvestIntervalSec` 10 s theo `world.tick`, không rút RNG):
  1. **Bước gấp**: Lò Rèn/Kim Hoàn có trần < gear.level của một công thức với gear.level ≤ level hunter cao nhất (kể cả hunter đang Journey) + `craftLevelAhead` + `investCraftLeadLevels` (4) → nâng building đó, hoặc nâng Town Hall nếu Town Hall đang chặn — bước Town Hall nhìn xa thêm `investTownHallLeadLevels` (6) level, vì nó phải xong trước khi lò được bắt đầu (trước đây chuỗi Town Hall → Lò Rèn → Kim Hoàn chỉ bắt đầu khi hunter đã gần tới bậc). Được tiêu tới sàn `investUrgentReserveMul` (2, trước 5) × `autoCraftReserve`; thiếu NL quá `investUrgentImportSec` (300 s) thì nhập. Nhiều bước gấp: ưu tiên bước đã đủ NL, rồi kế hoạch đang chờ, rồi thứ tự — bước của lò trước bước Town Hall (lò nâng trần ngay).
  2. **Bước thường** (theo giá trị, `investValue` / `investPriority`): trong mọi nâng cấp/xây hợp lệ (xây vào ô trống đầu tiên) mà vàng Town − giá ≥ `investTargetMul` (1) × `townGoldTarget` (§5.7), chọn `investValue / giá` lớn nhất (× `investReadyMul` 2 nếu đã đủ NL trong kho; hòa → thứ tự config; giá trị 0 → không bao giờ chọn). `investValue = investValue<Loại> × hiệu ứng tăng thêm` đọc từ mảng theo level của chính building: dịch vụ `restorePerSec`, shop `capacity`, Trạm Thu Mua `surplusPriceMul`, lò chế `maxGearLevel` (tỉ lệ tăng); Học Viện `1 − studyGoldMul[mới]/studyGoldMul[cũ]`; Lò Cường Hóa `enhanceBonus` cộng thêm; Kho `requestCopies` thêm / `requestMaxCopies`; Town Hall `1 / level mới`. Trọng số mặc định: dịch vụ 1, shop 1,5, Lò Cường Hóa 10, Học Viện 15, Trạm Thu Mua 4, Kho 0,5, Town Hall 0,3, lò chế 0,2 (nâng lò chế chủ yếu đi qua bước gấp); building M5: §5.15. Kế hoạch thường đã chọn được **giữ** cho tới khi xong/không còn hợp lệ, kể cả khi vàng Town tạm dưới mục tiêu (trước đây kế hoạch bị xóa mỗi lần vàng dao động quanh mục tiêu nên đồng hồ nhập NL không bao giờ chạy, và vì "ưu tiên đủ NL tuyệt đối" Học Viện/Trạm Thu Mua — cần NL vùng đã bỏ — gần như không bao giờ được nâng).
  3. Kế hoạch lưu ở `town.investPlan`. **Trạm Thu Mua yêu cầu NL** của mọi bước gấp và của kế hoạch thường (`investMaterialNeed`, cộng vào yêu cầu tự động §5.7, kể cả khi tắt auto-craft) → kho có mục đích và AI ưu tiên vùng rơi NL đó. NL nâng cấp lấy từ vùng hunter đang săn lúc cần (Lò Rèn L2 quặng/lõi … L8 hư không/bóng; building khác dùng NL vùng giữa/cuối) để không kẹt ở vùng đã bỏ. Thiếu NL quá `investImportSec` (900 s) thì **nhập** phần thiếu với giá `investImportPriceMul` (2) × giá NL (vàng cũng rời nền kinh tế).
- **Save v9 không có building** (bản chỉ có Journey, v8 khi đó là pass-through): `deserialize` điền các trường building bằng chính migration v7 → v8 nếu `town.buildings` thiếu (`fillMissingBuildings`), không đổi version.
- **Hủy** hoàn toàn bộ vàng (kể cả vàng nhập NL) và chỉ trả lại NL đã lấy từ kho (`upgrade.materials`); NL nhập (`importedUnits`) không thành NL miễn phí.
- **Migration v7 → v8**: mọi `startBuilding` ở level thấp nhất giữ nguyên cách chơi của save: Lò Rèn/Kim Hoàn đủ cao cho mọi công thức gear.level ≤ max(level hunter + `craftLevelAhead`, đồ đang mặc / bán / chế), Town Hall ≥ building cao nhất; còn lại level 1.
- **Debug/tool**: overlay có khối "Công trình" (level/max, trần tier, tiến độ nâng, giá kế tiếp, nút nâng/hủy, ô trống với nút xây, nút tự đầu tư và kế hoạch). `tools/headless.ts` in `build invest` (vàng, nhập, NL, số xong, level từng building) mỗi mốc và trừ vào phần dư `fees`; `tools/pacing.ts` in trần tier + level building mỗi mốc và tổng đầu tư cuối run.
- **Số đo pass 2** (headless 16 giờ / pacing 15 giờ seed 1–5, Dễ, thuế 10%; trước = `958da52` → sau, cùng thay đổi §5.4):
  - Trần tier trễ: số phút có công thức gear.level ≤ level hunter cao nhất mà lò chưa chế được 104–164 → **0–18** phút / 16 giờ (seed 1–3: 0; seed 4/5: chỉ đầu game ~1,3–2 giờ khi vàng Town < 1,5k); cuối game (8–12 giờ) không còn trễ ở cả 5 seed (trước: seed 1 trần 61 khi max L67, Town Hall 8 chờ 9.000 + sàn 9.000).
  - Học Viện lúc 8 giờ 1–3 → 2–3, lúc 12 giờ 1–4 → 3–5; Trạm Thu Mua 8 giờ 1 → 1–3, 12 giờ 1–2 → 2–4. Đầu tư 16 giờ 163–203k → 197–244k.
  - Vàng Town thấp nhất trong cửa sổ 4–8 giờ giảm (sàn bước gấp 2 × thay vì 5 ×; xem TODO §1).
  - Nhịp: Lv20 đầu tiên 67–89 → 73–92 phút, Lv50 4,72–5,13 → 4,67–5,03 giờ, tái sinh đầu 12,53–13,65 → 12,53–13,55 giờ.
- **Số đo** (headless/pacing seed 1–5, Dễ, có thuế 10%; trước = `23c50f7` → sau):
  - Nhịp: Lv20 đầu tiên 68–88 → 67–89 phút; Lv50 4,57–5,02 → 4,72–5,13 giờ; tái sinh đầu 13,15–14,45 → **12,53–13,65 giờ** (cả 5 seed trong 8–14 giờ). Trần tier theo sau level hunter cao nhất: thường trong vài level, nhưng có lúc trễ tới ~10 level (seed 1/3: trần 61 khi max L67–68 lúc 8 giờ, 71 khi max L81 lúc 10 giờ; hunter trung vị thường vẫn dưới trần). Nguyên nhân (đã kiểm, đã sửa ở pass 2 trên): chuỗi Town Hall → Lò Rèn → Kim Hoàn chạy nối tiếp và chỉ bắt đầu khi hunter đã cách bậc 6 level, mỗi bước cần giá (9–13k) + sàn 5 × `autoCraftReserve` (9k cuối game), Town Hall 8 chờ đủ 900 s để nhập NL hư không.
  - Lúc 12 giờ: vàng Town 21,5–26,9k → **13,4–22,8k** (4 giờ: 8,1–9,2k → 2,9–5,4k; 8 giờ: 11,9–25,6k → 5,6–17,4k); vàng hunter tb 5,9–7,6k → 4,9–6,5k; Lv tb 79,6–85,3 → 83,3–87,1; shop 5–8 → 3–6 món; chết (12 giờ) 7 → 17 (seed 6–10: 11 → 7; 10 seed 18 → 24).
  - **Đầu tư**: 160–198k vàng / 15 giờ (nhập 3–7k), ≈ 12–18k (0–4 giờ), 48–61k (4–8 giờ), 65–79k (8–12 giờ). Lò Rèn/Kim Hoàn/Town Hall max (8) lúc ~10–11 giờ; dịch vụ/shop/lò/học viện 1–5. Phần phí bị quy tắc ngân khố + 20% phí cố định "đốt" 8–12 giờ 149–171k → 102–124k: phần lớn số vàng trước đây bị đốt giờ đi vào building. Bounty tự động đặt ít hơn (12 giờ: 54–72 → 23–37) vì vàng Town ít khi trên mục tiêu.
  - Không thuế (`taxRate` 0, bản trước khi ưu tiên bước gấp đủ NL): vàng Town 12 giờ 23,0–26,5k → 19,2–25,5k, tái sinh đầu 13,05–14,33 → 12,75–13,40 giờ, đầu tư 144–199k / 15 giờ.
- **Quy tắc ngân khố vẫn giữ**: bước thường chỉ tiêu phần trên mục tiêu, và khi Lò Rèn/Kim Hoàn/Town Hall đã max (~10–11 giờ) vàng Town lại lên gần mục tiêu, nên quy tắc vẫn là lực kéo cuối game. Muốn bỏ nó cần thêm chỗ tiêu cuối game (building M5 trên ô trống, cấp cao hơn).

### 5.13 Cổng Tái Sinh (EHT) **[ĐÃ LÀM — số liệu ĐỀ XUẤT]**

Như EHT: tái sinh diễn ra ở **Reincarnation Portal** gần chỗ hunter mới xuất hiện; hunter đi tới cổng, ở trong đó khoảng 5 phút, rồi ra với một bậc tái sinh hơn và level 1.

- **Map**: node loại mới `portal` (`t.portal` (2, −3), ngoài các ô đất, lá nối một cạnh không phải road với `t.square` — nơi hunter mới đến). Tối đa một node `portal` (kiểm ở `validateMap`); không có thì `config.index.portalNode` = quảng trường. Node portal **không bao giờ** là kết quả của `nav.nearest` không lọc (đích đến, không phải chỗ "đứng"; node gần cổng nhất là quảng trường nên hunter ra khỏi cổng bắt đầu đường đi từ đó — test kiểm) và không nằm trong tập dạo (`wander` chỉ road/square), nên thêm nó không đổi đường đi nào khác: pacing tới lần tái sinh đầu giống hệt trước khi có cổng.
- **Kích hoạt** (`progression.ts`): mỗi tick, hunter còn sống, ngoài building, ở Town, đủ điều kiện (`reincarnateBlocker`: max level, chưa tới `maxReincarnation`), `town.autoReincarnate` bật và chưa có goal `reincarnate` → `sendToPortal` = `setGoal({ type: 'reincarnate' }, forced)` (như lệnh: AI không chấm lại; backstop khẩn cấp chỉ chạy ngoài field nên không cắt ngang). Lệnh `hunter.reincarnate` cùng kiểm tra (controllable, ở Town, `reincarnateBlocker`) rồi gửi đi như vậy; không còn tái sinh tức thì. Không thêm ứng viên vào `scoreGoals` (chấm điểm rút RNG theo từng ứng viên).
- **Vào cổng** (`enterPortal`, AI gọi khi goal `reincarnate` tới pha act): kiểm tra lại điều kiện (không đủ nữa → bỏ goal, không vào); đủ thì hunter được **chuyển ra khỏi** `world.hunters` vào `world.portal: PortalStay[]` (`{ hunter, durationMs, remainingMs, enteredAtMs }`, AI reset, buff xóa, quái đang nhắm thì bỏ), event `portalEntered`. Giống journey (§5.11): không system nào đụng tới (nhu cầu đóng băng), vẫn giữ slot (`townHunterCount`) và **được đếm** trong `allHunters` (mở khóa độ khó, level tham chiếu của Town). Lệnh tới hunter trong cổng bị từ chối (`hunter is in the reincarnation portal`).
- **Thời gian**: `reincarnationSec` (300 s game) **[ĐỀ XUẤT]**. `advancePortal(ctx, ms)` đếm ngược — mỗi tick từ system `progression` (thời gian game; tick vào cổng cũng trừ một lần), và một lần với khoảng thời gian thực khi mở lại game / tab hiện lại (§9). Về 0: hunter được đặt lại ở node portal, AI mới, `reincarnate()` chạy (thân hàm không đổi: level 1, EXP 0, job 0, `stats = rollStats`, điểm trait, HP đầy, event `reincarnated`), rồi quay về `world.hunters`. `reincarnate()` từ chối (config đổi từ lúc save) thì hunter vẫn ra, không bị kẹt. Không rút RNG.
- **Save**: world v12 (`world.portal`; migration v11 → v12 thêm mảng rỗng). Đang ở trong cổng lúc save → load tiếp tục đúng như không save.
- **Nhịp** (`tools/pacing.ts 900 1`): mọi mốc tới Lv100 đầu (12,38 giờ) **giống hệt** trước khi có cổng; tái sinh đầu 12,40 → 12,48 giờ (đi bộ + 5 phút trong cổng), vẫn trong 8–14 giờ; 7/8 hunter đã tái sinh lúc 13 và 14 giờ, 8/8 lúc 15 giờ (như trước).
- Debug overlay: dòng "Cổng Tái Sinh" (hunter, thời gian còn), số hunter trong cổng cạnh số hunter, goal "đi tới Cổng Tái Sinh". Render: vòng tím ở node portal.

### 5.14 Vật tư dịch vụ, thuốc, phí hồi sinh (EHT) **[ĐÃ LÀM — số liệu ĐỀ XUẤT]**

Như EHT: Infirmary/Restaurant/Tavern/Inn bán hàng làm từ nguyên liệu; Town hết hàng thì hunter không hồi được và nhịp săn chậm lại. Code: `src/core/systems/supplies.ts` (kho vật tư, sản xuất, yêu cầu NL), `src/core/systems/consumables.ts` (thuốc, phí hồi sinh), nối vào `services.ts`, `trading.ts` (`baseMaterialNeed`/`autoMaterialDemand`/`sellOrder`), `economy.ts` (`doSell` theo `sellOrder`), `combat.ts` (chết/hồi sinh), `ai/utility.ts` (`potionDrinkLine`, goal `buyPotion`, bỏ dịch vụ hết hàng), `systems/ai.ts` (đích của `buyPotion`). Config: `config/consumable.json` (`TABLE_SPECS.consumable`), `building.json` (`supplyCap[]`, `potionCap[]`), tham số `supply*`/`potion*`/`revive*` ở cuối `formula_params.json`.

- **Bảng `consumable`** (công thức kho): `{ id, nameKey?, kind: supply|potion, buildingId, minLevel, materials[], units, craftSec, heal?, price? }`. Mỗi (`kind`, `buildingId`) là một **dòng kho** (`town.supply["supply:<bld>"]`, `"potion:<bld>"`: `{ stock: {recipeId → n}, job, stockoutMs }`), các hàng của dòng là bậc theo `minLevel` (phải có bậc `minLevel` 1). `config:check`: hàng supply chỉ thuộc dịch vụ có `supplyCap`, hàng potion thuộc building có `potionCap` (tối đa một — Infirmary) và cần `heal` + `price`; building có cap phải có công thức.
- **Bậc** = vùng: mỗi bậc dùng NL của một vùng (dịch vụ: NL chính của vùng — gel/quặng/sậy/tro/băng/muối/hư không, Tavern và thuốc: NL phụ). Bậc của một hunter (`hunterTier`) = bậc cao nhất có NL rơi ở vùng nó đang săn (goal `hunt`, hoặc vùng của goal hunt cuối `lastZoneId` khi ở Town); không có thì theo level. Theo vùng chứ không theo level vì sau tái sinh level và vùng tách nhau (bản đầu theo level trung vị: sau tái sinh Infirmary/Inn hết hàng 84–240 phút / 4 giờ vì NL yêu cầu là của vùng không ai săn).
- **Dịch vụ**: 1 đơn vị = 1 lượt phục vụ (vào cửa trả tiền, lấy 1 đơn vị bậc thấp nhất còn hàng; đơn vị mọi bậc thay nhau được). Cap = `supplyCap[level]` (30 → 54). Game mới và save migrate bắt đầu **đầy**. Hết hàng: AI không chấm dịch vụ đó (`serviceInStock`), hunter tới cửa bị từ chối không mất tiền (event `serviceStockout`, stat `serviceStockouts`), rồi quyết định lại — nghỉ trong Town vẫn hồi miễn phí `townIdleRegenPerSec` nên không bao giờ kẹt (chậm: HP 1%/s thay vì 60–96 điểm/s). Thời gian dòng dịch vụ rỗng khi building đang chạy được đếm (`stockoutMs`, `stats.supplyStockoutMs`).
- **Sản xuất** (system `supplies`, sau `consumables`, trước `academy`/`crafting` — NL thiết yếu được ưu tiên trước craft): mỗi dòng một mẻ một lúc (`craftSec`), NL lấy khỏi kho lúc bắt đầu; dòng rảnh tìm công thức mỗi giây. Mục tiêu: dịch vụ = bậc **thiết yếu** (bậc nhiều hunter dùng nhất) tới cap; thuốc = mỗi bậc min(cap, số hunter của bậc × `potionCarryMax`), tổng ≤ `potionCap[level]`. Chọn: công thức thiếu nhiều nhất có đủ NL; dòng dịch vụ không có thì bậc khác (cao trước) **chỉ** bằng NL kho vượt nhu cầu craft/đầu tư (`baseMaterialNeed`), để lúc hết hàng không ăn NL của công thức đồ. Không tốn vàng Town (Town đã trả lúc mua NL).
- **Yêu cầu NL thiết yếu** (`supplyMaterialNeed`, cộng vào `autoMaterialDemand`, **kể cả khi tắt auto-craft**): mọi công thức còn thiếu, tối đa `supplyRequestBatches` (3) mẻ. **Ưu tiên**: Trạm Thu Mua trả tiền NL thiết yếu trước (`sellOrder`) khi vàng Town không đủ cho cả túi; NL thiết yếu cũng kéo hunter về vùng của nó như mọi yêu cầu (§5.3).
- **Thuốc HP** (Infirmary, mở khi Town Hall ≥ `potionTownHallLevel` 6): goal `buyPotion` (Town, `bestPotionPurchase`): bậc của mình, hết hàng thì bậc ngay dưới; số lượng = min(chỗ trống tới `potionCarryMax` 2, hàng, ⌊`potionSpendFrac` 0,2 × vàng / giá⌋) ≥ 1; điểm `potionBuyScore` 1,05 × `econMul`. Giá = round(`price` × (1 + `potionPriceLevelPct` 2 / 100 × max(0, level − minLevel))) — 36 → 660 theo bậc, cộng 2%/level trong bậc (giá ×3 so với bản đầu, xem số đo). Hunter mang `potions` (world v11).
- **Uống** (system `potionUse`, giữa `skills` và `urgentBackstop`): ở field, có thuốc, hết hồi (`potionCooldownSec` 8 s), HP < `potionDrinkLine` → bậc cao nhất đang mang hồi `heal` (0,35) × HP tối đa. `potionDrinkLine` = max(`potionUseHpFrac` 0,5, ranh giới kill max(ngưỡng HP khẩn cấp, sàn rút lui) + 1 kill, giữa dải HP mềm của `needsOk`), trần 0,95 — luôn ≥ mọi đường rút lui (§5.2), nên thuốc được dùng **trước** khi luật rút lui bắn; luật rút lui không đổi (HP đã hồi thì nó tự qua). Test: ở mọi HP mà `shouldRetreatBeforeNextKill` đúng thì HP < đường uống. Headless đếm chuyến rút lui HP khi còn thuốc (`hpRetreatWithPotion`).
- **Phí hồi sinh**: round(`reviveFeeBase` 20 + `reviveFeePerLevel` 15 × (level − 1)) trả lúc hồi sinh, chỉ từ vàng **trên** giá Infirmary của hunter (luôn còn tiền chữa); không trả đủ → trả phần có được và nằm chết `reviveBrokeDelayMul` 4 × `reviveSec` (stat `reviveBroke`). Event `hunterRevived` có `fee`, `townGold`.
- **Vàng đi đâu (quyết định)**: tiền thuốc và phí hồi sinh đi qua `economy.feeTownCut` như phí Lò Cường Hóa/Học Viện (§5.7): Town giữ `feeTownShare` khi vàng Town ≤ mục tiêu ngân khố, ít hơn khi trên; phần còn lại **rời nền kinh tế**. Như vậy đây là chỗ tiêu vàng hunter thật (nếu chỉ chuyển cho Town thì Town lại trả cho hunter qua mua NL xuất khẩu). Vật tư dịch vụ không phải chỗ tiêu vàng hunter (Town trả hunter giá đủ cho NL thiết yếu rồi thu lại ở giá dịch vụ) mà là chỗ tiêu NL kho.
- **Save**: world v11 = `MIGRATIONS[10]`: mọi dòng dịch vụ đầy theo level building, bậc theo level trung vị; dòng thuốc rỗng; hunter (cả đang journey) không có thuốc; stat mới = 0; chỉ điền trường thiếu. `Hunter.potions`/`potionCdMs`/`lastZoneId` là optional (code đọc bằng `??`). Offline không mô phỏng săn/dịch vụ nên không có xử lý offline.
- **Debug/tool**: overlay hiện goal "mua <thuốc>". `tools/headless.ts` in mỗi mốc: phút hết hàng từng dịch vụ (inf/rest/tav/inn), lượt phục vụ/sản xuất/từ chối, thuốc mua/uống, vàng thuốc (phần Town), rút lui HP khi còn thuốc, phí hồi sinh (phần Town) — tiền thuốc/hồi sinh là dòng riêng trong sổ, không nằm trong `fees`; cuối run in từng dòng kho.

- **Số đo** (code cuối, seed 1–5, Dễ; trước = `fix/economy-and-formulas` `18e84f5` → sau; headless 16 giờ `tools/headless.ts 960 <seed> 240`, nhịp `tools/pacing.ts 900 <seed>`):
  - **Vàng hunter theo cùng giai đoạn** (kiếp 1, nội suy theo Lv tb, snapshot mỗi 60 phút — so theo giờ bị lệch vì tiến trình nhanh hơn): Lv tb 70 → tb 6,6k (5,0–8,0k) → **4,5k** (3,6–5,4k); Lv tb 80 → 8,4k (7,1–9,6k) → **5,2k** (4,3–5,9k); Lv tb 85 → 10,4k (8,0–12,2k) → **6,0k** (5,4–7,0k), tức −32…−42%. Tách hiệu ứng: chỉ vật tư (thuốc tắt, `potionTownHallLevel=100`) → 6,1k / 7,9k / 9,6k (−5…−8%); thuốc ở giá cũ (÷3) → 6,8k / 9,5k / 10,2k (**tăng** +3…+13%: tiến trình nhanh hơn kéo thu nhập lên nhiều hơn tiền thuốc) — vì vậy giá ×3.
  - Theo giờ (lẫn với tái sinh sớm hơn): vàng hunter tb / max lúc 12 giờ 6,6–12,4k / 13,9–25,4k → 0,9–9,8k / 2,4–19,5k; vàng Town 16 giờ 14,6–54,6k → 17,2–34,5k.
  - Nhịp: Lv20 đầu tiên 61–77 → 60–73 phút; Lv50 4,17–4,48 → 4,02–4,70 giờ; tái sinh đầu 11,97–12,98 → **10,62–11,93 giờ** (vẫn trong 8–14 giờ: thuốc sau Town Hall 6 tăng tốc đoạn Lv50 → 100). Chết 0 → 0 (headless và pacing).
  - Hết hàng dịch vụ: **0 phút** ở mọi cửa sổ 4 giờ, 0 lượt bị từ chối (bản bậc theo level trung vị: 84–240 phút / 4 giờ ở Infirmary/Inn sau tái sinh). Lượt dịch vụ 16 giờ 4.841–5.046 → ~4.460–4.690 (thuốc thay một phần chuyến về chữa); vật tư dùng ~4.600–4.800 đơn vị / 16 giờ.
  - Kho Town: 12 giờ 67–141 → 86–238; 16 giờ 155–291 → 156–253 NL.
  - Thuốc: mở ở Town Hall 6 (~4–5 giờ); ~510–780 mua / 4 giờ sau khi mở (≈ như ở giá cũ: phần lớn bị chặn bởi túi 2 thuốc chứ không bởi giá); hunter chi 177–500k vàng / cửa sổ 4 giờ. Rút lui HP khi còn thuốc 1–26 / 4 giờ trên ~600–750 lần uống.
  - Phí hồi sinh: 0 (không ai chết trong 16 giờ ở cả hai bản) — chỉ được kiểm bằng test.
  - Sweep (pacing seed 1–3 trừ khi ghi khác; **trước** khi merge combat caps/mood, giá cũ): mở thuốc ở Town Hall 2 (heal 0,35, mang 2; seed 1–5) → Lv50 3,58–3,80 giờ (bản đầu heal 0,6, mang 3: 3,38–4,17 giờ, tái sinh 8,4–10,6 giờ); mang 1 → 3,82–3,97; `potionSpendFrac` 0,05 → 3,88–4,13; Town Hall 5 → 3,98–4,12; Town Hall 6 → 3,95–4,48 (= không có thuốc). Chọn 6 (baseline Lv50 sát mép 4 giờ).
- Còn mở: thuốc satiety/stamina/buff và Alchemist riêng chưa làm (thuốc HP ở Infirmary); offline không mua/uống thuốc, không tiêu vật tư; chưa có UI kho vật tư; `potionTownHallLevel` 6 được chọn theo nhịp Lv50 (baseline sát mép 4 giờ).

### 5.15 Building đặc biệt M5 (GDD §5: Training Ground, Bank, Courage Headstone, Fountain of Life, Library of Wisdom) **[ĐÃ LÀM — số liệu ĐỀ XUẤT]**

Năm loại building mới trên hệ ô đất §5.12 (Town Hall chặn, có level, `upgradeCost`, mảng hiệu ứng theo level). Tên GDD là tên của EHT nên config dùng **tên tự đặt**, id chung: `bld.training` (Sân Luyện Võ / Drill Yard, kind `training`), `bld.bank` (Quỹ Tín Dụng / Strongroom, `bank`), `bld.monument` (Bia Dũng Khí / Valor Stele, `monument`), `bld.fountain` (Giếng Hồi Sức / Wellspring, `fountain`), `bld.library` (Tàng Thư Các / Lore Archive, `library`). Mỗi kind tùy chọn, tối đa 1 (`config:check`). Không có sẵn trong game mới: Town tự xây (bước thường của tự đầu tư) hoặc lệnh `town.build`.

Code: `src/core/systems/training.ts` (offer, system `training`), `src/core/systems/monument.ts` (system `townAura`), hàm hiệu ứng `bankFloorMul`/`fountainRegenMul`/`fountainReviveMul`/`libraryExpMul`/`kindValue` trong `systems/town.ts`; nối vào `ai/utility.ts` (`bestTraining`, goal `train`), `systems/ai.ts` (đích), `services.ts` (bỏ qua hunter trong building không phải dịch vụ), `needs.ts` (hồi miễn phí), `consumables.ts` (thời gian chết), `combat.ts` (EXP kill), `formulas.ts` (aura trong `hunterStats`), `statsCache.ts` (snapshot `h.aura`). Thứ tự system: `arrivals → townAura → ai → …`, `academy → training → crafting` (§3.2). Tham số `investValue<Kind>`, `train*` ở cuối `formula_params.json`.

| Loại | Town Hall | Hiệu ứng (L1 → L5) | Giá xây → L5 |
|---|---|---|---|
| Training Ground | 2 | `trainExpFrac` 0,08 → 0,16 × `expToNext(level)` mỗi phiên; `trainLevelGap` 8 → 4 | 800 → 9.000 |
| Bank | 3 | `investFloorMul` 0,9 → 0,5 × sàn bước thường | 1.500 → 12.000 |
| Fountain | 4 | `townRegenMul` ×2 → ×4 hồi miễn phí khi rảnh ở Town; `reviveSecMul` 0,8 → 0,4 × thời gian chết | 2.500 → 14.000 |
| Monument | 6 | aura `auraAtkPct`/`auraDefPct` +2 → +6 % ATK và DEF mọi hunter | 6.000 → 19.000 |
| Library | 7 | `killExpPct` +3 → +8 % EXP kill | 8.000 → 21.000 |

Ô đất: thêm 3 ô có cửa riêng (lá nối một cạnh không phải road): `plot.e` (cửa `d.plot.e` (17, −4) ← `t.e`, Town Hall 3), `plot.nw.outer` (`d.plot.nw.outer` (−17, 17) ← `t.nw`, Town Hall 5), `plot.se.outer` (`d.plot.se.outer` (18, −14) ← `t.se`, Town Hall 7) — tổng 6 ô trống cho 6 loại xây được (Nhà Kho + 5). Cửa mới không đổi đường đi nào: pacing seed 1 / headless seed 2 với mọi `investValue` mới = 0 giống từng dòng với trước (chỉ thêm stat mới = 0).

- **Training Ground + goal `train`** (catch-up + chỗ tiêu vàng hunter). Một phiên: tại cửa hunter trả round(`trainGoldPerExp` 0,5 × EXP) và nhận EXP = round(`trainExpFrac[lv]` × `expToNext(level)`) qua `progress.gainExp` (theo đường cong EXP đang dùng; Library **không** nhân EXP mua), rồi ở trong `trainSessionSec` 20 s (nhu cầu đóng băng như dịch vụ; `Hunter.trainMs`), ra không goal. **Trần**: chỉ khi level < level cao nhất của Town (`allHunters`, gồm journey/cổng) − `trainLevelGap[lv]` — hunter đầu bảng không bao giờ luyện được, nên các mốc nhịp (theo hunter đầu) không đổi do Training Ground. Vàng qua `economy.feeTownCut` (như phí Lò Cường Hóa/Học Viện: Town giữ phần của nó, còn lại rời nền kinh tế). AI (`bestTraining`): offer có, và vàng ≥ giá × `trainGoldReserveMul` 3 + tiền để dành đồ (`enhanceSavingsHold`) (level 1 giữ vàng khởi điểm); điểm `trainScore` 1 × `econMul`. Ứng viên chỉ được thêm khi khả dụng → Town chưa có Training Ground rút RNG y như trước. Giá ∝ `expToNext`: ≈ 1,3–3 × vàng kill cho cùng lượng EXP (vàng/EXP của quái 0,17–0,4). Event `trained { exp, price, townGold, level }`, stat `trainSessions`/`trainGold`/`trainExp`.
- **Bank — chọn "đổi vàng dư thành tốc độ đầu tư", không lãi**: lãi suất là vàng mới (vàng Town không có chỗ tiêu ngoài building), nên Bank **không tạo vàng**: `investFloorMul[lv]` nhân sàn của bước thường (`investTargetMul × townGoldTarget`), tức Town được đầu tư sâu hơn vào chính vàng của nó (tín dụng). Sàn bước gấp, mục tiêu ngân khố của Trạm Thu Mua / phí (§5.7) không đổi. Lệnh người chơi không có sàn nên Bank chỉ có tác dụng khi tự đầu tư bật.
- **Monument (aura)**: aura vĩnh viễn theo level, danh mục nhân riêng trong `hunterStats` (`× (1 + aura%/100)`, áp cả `steady` và live → AI chấm vùng/rút lui thấy nó; không bị trần trait/buff). `hunterStats(config, h)` không có world nên system `townAura` (ngay sau `arrivals`) chép `Hunter.aura` lên mọi hunter trong `world.hunters` mỗi tick (xóa field khi không có monument; hunter đi journey/cổng giữ giá trị lúc đi, đồng bộ lại tick đầu về). `statsCache` snapshot `h.aura` (test với `TH_VERIFY_CACHES=1`).
- **Fountain**: `townRegenMul[lv]` nhân `townIdleRegenPerSec` (hunter rảnh trong Town, kể cả hunter hết tiền) và `reviveSecMul[lv]` nhân thời gian chết (cả phần × `reviveBrokeDelayMul`). Hiệu ứng chính đo được là hồi miễn phí (0 chết / 16 giờ nên phần hồi sinh chỉ kiểm bằng test).
- **Library**: EXP kill × (1 + `killExpPct[lv]`/100) ở `combat.grantKill` (không áp cho training/journey); stat `libraryExp` (EXP thêm). Không có Library: × 1 đúng từng bit.
- **Tự đầu tư**: `investValue` có nhánh cho 5 kind (công thức ở comment `town.investValue`): training `trainExpFrac` và fountain `townRegenMul` theo tỉ lệ tăng, **lần xây đầu = 1** (relStep từ level 0 trả giá trị tuyệt đối, không so được); bank `1 − mul[mới]/mul[cũ]`; monument (ATK% + DEF%)/2 thêm / 100; library % thêm / 100. Trọng số `investValueTraining` 0,2, `investValueBank` 3, `investValueMonument` 40, `investValueFountain` 0,3, `investValueLibrary` 40 → giá trị/vàng lúc xây ≈ 13–25 × 10⁻⁵ (ngang bậc giữa của dịch vụ/shop/Học Viện), nâng cấp 0,3–11 × 10⁻⁵. Trọng số 0 tắt kind đó (test).
- **Save**: world v15 = `MIGRATIONS[14]` (stat mới = 0; `Hunter.aura`/`trainMs` optional, aura đồng bộ lại ở tick đầu). `MIGRATIONS[12]` là chỗ của nhánh gear (v13), `[13]` là hàng chờ hunter (v14, §4.1).
- **Debug/tool**: overlay hiện goal "luyện tập (Ns)"; renderer có màu cho 5 kind. `tools/headless.ts` in mỗi mốc `train` (phiên, EXP, vàng hunter trả và phần Town — dòng riêng trong sổ, không nằm trong `fees`), `minLv`, `libExp`.
- **Số đo** (seed 1–5, Dễ; trước = `8125fe3` → sau; headless 16 giờ `tools/headless.ts 960 <seed> 240`, nhịp `tools/pacing.ts 900 <seed>`):
  - **Nhịp**: Lv20 đầu tiên 60–73 phút và Lv50 4,02–4,70 giờ **giống hệt** ở 4/5 seed (seed 5: 4,70 → 4,62 giờ; mọi building M5 xây sau 4 giờ); tái sinh đầu 10,62–11,93 → 10,65–11,75 giờ (theo seed +0,03 / +0,23 / +0,05 / +0,50 / −0,40), trong 8–14 giờ. Chết 0 → 0.
  - **Thời điểm xây**: Training Ground L1 giữa 4–8 giờ; lúc 12 giờ Training 2–3, Bank 2, Fountain 1, Monument 1–2 (4/5 seed), Library 0–1; lúc 16 giờ Training 3–4, Bank 3–5, Fountain 2–3, Monument 1–2, Library 1–2. Đầu tư 15 giờ (pacing) 260–295k → 261–302k; headless cửa sổ 12–16 giờ 74–118k → 115–153k sau khi Lò Rèn/Kim Hoàn/Town Hall max. Nhưng phí bị "đốt" (`burned`) 12–16 giờ 131–175k → 105–134k: vàng Town nằm dưới mục tiêu ngân khố nên `feeTownCut` giữ lại nhiều phí hơn; burned + đầu tư 12–16 giờ 213–249k → 219–271k (theo seed −3 / +58 / −6 / −27 / +10k). Tức building M5 chủ yếu **chuyển** phần phí trước đây bị đốt vào building, không phải thêm nhiều vàng rời nền kinh tế.
  - **Vàng Town** 16 giờ 17,2–34,5k → **10,6–18,2k** (quy tắc ngân khố ít giữ vàng hơn); `townMin` 12–16 giờ 5,9–9,9k → 1,7–5,1k; hết hàng dịch vụ 0 phút ở mọi cửa sổ (trước cũng 0).
  - **Bank** (tắt riêng bằng `investValueBank=0`, cùng code): đầu tư 8–16 giờ 169–200k → 203–226k (+26 / +31 / +34 / +24 / +9k theo seed); trừ giá chính Bank ở level đạt được (L3–L5: 10–30,5k) còn −4 / +12 / +15 / +14 / −10k (dương 3/5 seed); vàng Town 16 giờ 16,1–21,1k → 10,6–18,2k. Phí bị đốt 12–16 giờ giảm 16–32k (vàng Town thấp hơn → `feeTownCut` giữ nhiều hơn), nên burned + đầu tư 12–16 giờ −22…+8k: Bank **không** tăng tổng vàng rời nền kinh tế, chỉ đổi phí bị đốt thành building. Không có vàng mới. Giữ hay đổi thiết kế: chờ design.
  - **Training Ground**: trước tái sinh gần như không dùng (level dồn sát nhau, tiền để dành đồ chặn); sau tái sinh đầu 100–820 phiên / 4 giờ (8–12 giờ), vàng hunter chi 3,6–18,6k / cửa sổ — chỗ tiêu nhỏ (thuốc 177–500k). Chênh level cuối 16 giờ (max − min) 22–32 → 15–32. Vàng hunter tb 16 giờ 3,7–9,3k → 3,3–7,9k.
  - **Library**: +22–39k EXP kill / cửa sổ 12–16 giờ (≈ 3–5 % EXP kiếp 2). **Fountain**: lượt dịch vụ 12–16 giờ 1.179–1.308 → 1.115–1.195 (−2…−9 %, cùng với hunter ở trong Training Ground không tiêu nhu cầu).
  - Lv tb 16 giờ 61–82 → 59–80 (kiếp 2 hơi chậm hơn: tái sinh đầu muộn hơn ở 3 seed và vàng Town đi vào building M5 thay vì nâng dịch vụ sớm).
- Còn mở: chỉ Bank có đo tắt riêng; 4 building còn lại đo chung; chưa UI ngoài debug overlay (xây bằng `town.build` / tự đầu tư); Training Ground là chỗ tiêu vàng nhỏ vì giá ∝ `expToNext` (rẻ ở level thấp, nơi phần lớn phiên diễn ra) — nếu cần sink lớn hơn thì tăng `trainGoldPerExp`; phần hồi sinh của Fountain chưa đo được (0 chết); Monument/Library (Town Hall 6/7) chỉ lên 1–2 trong 16 giờ nên ảnh hưởng tới kiếp 2+ chưa đo (cần chạy > 16 giờ); offline không chạy phiên luyện tập (đóng băng như dịch vụ).

### 5.16 Chiều sâu tiến trình M5: cây nghề, lệnh học, `exp_curve`, ghép NL, rune, relic, thú cưỡi, growth property (world v16) **[ĐÃ LÀM — số liệu ĐỀ XUẤT]**

Code: `src/core/progressionStats.ts` (đầu vào thuần config + hunter của `hunterStats`/`moveSpeed`/`gainExp`: `jobOf`, `jobStatMult`, `growthFlat`, `runeTotal`, `mountMul`, `expRequired`, `relicValue`), `systems/progression.ts` (chuyển nghề, `autoPickJob`, `chooseJob`), `systems/academy.ts` (growth, kế hoạch học), `systems/compose.ts`, `systems/runes.ts`, `systems/relics.ts`, `systems/mounts.ts`; `formulas.ts` chỉ đổi phần job/growth/rune trong `computeHunterStats` và × thú cưỡi trong `moveSpeed`; `statsCache.ts` chụp thêm `jobId`, cấp growth, ô rune. Config: `job.json` (45 hàng), `exp_curve.json`, `rune.json`, `relic.json`, `mount.json`, `growth_property.json`, `material.composeTo`, tham số cuối `formula_params.json` (`runeSlots` … `relicAutoGoldMul`). Test: `tests/m5-progression.test.ts`, ca đột biến trong `tests/statsCache.test.ts`.

- **Cây nghề (9 job mỗi class = 1 + 1 + 1 + 3 + 3)**: bậc 0 (Lv1, ×1), bậc 1 (Lv20, ×1,15), bậc 2 (Lv50, ×1,35) giữ nguyên như M3 → nhịp tới Lv70 không đổi; **bậc 3 (Lv70) rẽ 3 nhánh** a = thủ (hp ×1,08, atk ×0,93, def ×1,05), b = công (0,94 / 1,08 / 0,97), c = khéo (0,97 / 0,97 / 1 + 4 crit + 4 eva), `statMult` 1,45; **bậc 4 (Lv80, cần ≥ 1 lần tái sinh)** = bậc thầy của nhánh (`statMult` 1,6, độ lệch đậm hơn, nhánh c +6/+6). Hàng có `branch`, `parentId`, `unlockReincarnation`, `statBias {hp,atk,def}`, `crit`, `eva` (tùy chọn); `config:check`: một job bậc 0, bậc liền nhau, cha cùng class và đúng bậc − 1 (thiếu `parentId` thì cha là job duy nhất bậc dưới), các con cùng cha cần `branch` khác nhau. Chỉ số: hp/atk/def = (gốc + growth) × `statMult` × `statBias` × (1 + tái sinh × `reincStatBonus`). Cân bằng: sức mạnh AI (`zonePower`, Lv85, citadel) của 3 nhánh lệch nhau ≤ 2% (vanguard bậc 3: 1,285 / 1,270 / 1,260, bậc 2 = 1,164; bậc 4: 1,459 / 1,434 / 1,422) — test giữ ±5% quanh job không lệch.
- **Chọn nhánh**: AI (`autoPickJob`, không RNG): điểm = Σ (bias − 1) × trọng số stat (1 + điểm grade của roll: high 1, highest 2; crit/eva tính chung), + 1 atk nếu liều lĩnh (`urgent.hp` < 1) hoặc `goal.hunt` > 1, + 1 hp/def nếu nhút nhát, + 1 khéo nếu nhanh (`moveSpeed` > 1); hòa → thứ tự config. Lệnh `hunter.chooseJob { hunterId, jobId }` (job có nhánh, hoặc job sau của nhánh): lưu `jobBranch` (giữ qua tái sinh), đổi nghề ngay nếu là job kế tiếp và đã mở; đã vào nhánh khác → từ chối tới lần tái sinh sau. Tái sinh: `jobTier` 0, xóa `jobId`.
- **Lệnh học** `hunter.learn { hunterId, kind: skill|trait|growth, id }` (+ `hunter.cancelLearn`): từ chối (`commandRejected`) khi không bao giờ làm được: id lạ, class khác, đã max, hunter đi journey/trong cổng. Còn lại lưu `learnPlan` (chờ level/bậc nghề/vàng/điểm); hunter ở Town, Học Viện đã xây và làm được ngay → goal `learn` ép. `bestLearn` đưa kế hoạch lên trước khi làm được (vàng ≥ phí, không cần dự trữ); trong lúc chờ AI không tiêu loại tiền của kế hoạch (kế hoạch vàng chặn skill/growth tự động, trait vẫn học; kế hoạch trait ngược lại). Học xong một cấp → xóa kế hoạch; `progression` xóa kế hoạch không còn hợp lệ. Shop/cường hóa không giữ vàng cho kế hoạch (còn mở).
- **`exp_curve`**: `exp_curve.json` 99 hàng `{level, exp[6]}` (tái sinh 0..5; `config:check` cần ≥ maxLevel − 1 hàng và ≥ maxReincarnation + 1 cột, để test hạ trần được). Cột 0 = đúng công thức M3 round(30 × L^1,15) (test kiểm) → kiếp 1 giữ nhịp; cột r = cột 0 × [1; 1,15; 1,4; 1,7; 1,8; 2,0]. Lý do: tái sinh cộng +10% chỉ số gốc/lần, giữ skill/trait/rune/growth/thú cưỡi, mở bậc 4, độ khó cao trả EXP × `rewardMul`; với đường cũ kiếp 2/3/4 chỉ còn ~7 / 5 / 3,5 giờ (pacing 2100 phút seed 1–2). Đích: mỗi kiếp sau ngắn hơn kiếp trước một chút nhưng không sụp. Ngoài bảng (không có hàng) dùng công thức `expBase`/`expExponent`. `progress.gainExp` và Training Ground (§5.15, `trainExpFrac × expRequired`) cùng dùng `expRequired(level, reincarnation)`.
- **Ghép NL** (`material.composeTo { materialId, count }`, một bước, Trạm Thu Mua phải đã xây): mỗi NL thường ghép thành NL kế tiếp theo giá, N = ⌈1,5 × giá đích / giá nguồn⌉ (2–3) → ghép luôn lỗ giá trị, chỉ đáng khi thiếu. Tinh chất tier không ghép (giữ cổng độ khó §5.8; `config:check` kiểm, kèm vòng lặp). Lệnh `town.compose { materialId: nguồn, count: số đơn vị tạo }`; tự động mỗi `composeIntervalSec` (60 s): với mỗi NL yêu cầu tự động còn thiếu (`autoMaterialDemand`), dùng kho của NL ghép được thành nó, chỉ phần vượt nhu cầu craft/đầu tư/vật tư của chính NL nguồn (`baseMaterialNeed` + `supplyMaterialNeed`). Không RNG, không tốn vàng. (30 s → 60 s: ở 30 s test ngân khố seed 1 chạm một mẫu 0,01 × mục tiêu sau bước gấp Town Hall 7 — đổi quỹ đạo, không phải vàng của ghép.)
- **Rune** (`rune.json`: 6 loại atkPct / defPct / hpPct / crit / eva / atkSpeedPct, 5 grade, giá trị 1–8 (%) hoặc 1–6 điểm, `minMonsterLevel` 10, `dropChance` mỗi kill 0,0005 / 0,0002 / 0,00006 / 0,00002 / 0,000005): **một lần rút RNG mỗi kill** khi có rune đủ điều kiện (vùng dưới level 10 không rút → giờ đầu không đổi luồng RNG), × (1 + `runeDropPct` của relic). Vào kho rune Town (`town.runes`, tốt nhất trước, tối đa `runeStashMax` 30, thừa thì bỏ cái kém nhất). Gắn vào **hunter** (không vào đồ: đồ bị thu hồi khi tái sinh và đang được viết lại ở nhánh gear) — `runeSlots` 2 ô, giữ qua tái sinh; `town.autoRune` (bật) cho hunter đang ở Town lấy rune tốt nhất vào ô trống hoặc thay rune grade thấp hơn; lệnh `hunter.socketRune {slot, stashIndex}` / `hunter.unsocketRune` / `town.setAutoRune`. Chỉ số: nhóm trait (cùng trần `traitPctCap`).
- **Relic** (`relic.json`: Minh Triết `expPct` 3–15%, Vận May `runeDropPct` 20–100%, Bảo Trợ `growthCostPct` 5–25%; 5 cấp, 5k–80k vàng Town + 10 NL mỗi cấp, vàng rời nền kinh tế): hiệu ứng không phải chỉ số, đọc ở nơi có World (`relicValue`), nên `hunterStats` vẫn chỉ phụ thuộc hunter. Lệnh `town.upgradeRelic`; `town.autoRelic` (**tắt** mặc định) mua cấp rẻ nhất mỗi 60 s khi vàng Town ≥ `relicAutoGoldMul` 2 × mục tiêu ngân khố + giá.
- **Thú cưỡi** (`mount.json`: ngựa lùn ×1,08 Lv25 1.500, hươu ×1,16 Lv55 8.000, rồng đất ×1,25 Lv85 30.000): mua ở Shop bằng vàng hunter (goal `buyMount`, lệnh `hunter.buyMount`), Town nhận `feeTownCut`, phần còn lại là chỗ tiêu vàng; `moveSpeed` × `moveSpeedMul`; chỉ mua thú nhanh hơn; giữ qua tái sinh.
- **Growth property** (`growth_property.json`: hp +30, atk +2, def +2 mỗi cấp, 10 cấp, giá 800 → 30.000 (atk/def × 1,2), × (1 − `growthCostPct`)): học ở Học Viện (goal `learn` kind `growth`), vàng như skill (Town nhận phần phí), cộng phẳng vào chỉ số gốc trước hệ số nghề/tái sinh, giữ qua tái sinh. AI mua sau skill và trait, chỉ khi vàng trừ tiền để dành đồ ≥ giá × `growthReserveMul` 3.
- **Save**: world v16 = `MIGRATIONS[15]`: mọi hunter (Town, journey, cổng) có `jobId` của bậc hiện tại; `town.runes` [], `relics` {}, `autoRune` bật, `autoRelic` tắt; stat mới 0; chỉ điền trường thiếu. Trường mới của Hunter/Town đều optional (đọc bằng `??`).
- **Số đo** (seed 1–5; trước = `feat/m5` (hàng chờ + building đặc biệt), sau = nhánh này; `tools/pacing.ts 900 <seed>`, `tools/headless.ts 960 <seed> 240`):
  - Nhịp: Lv20 62–76 → 70–79 phút; Lv50 3,78–4,65 → 4,32–4,53 giờ; tái sinh đầu 10,58–11,32 → 10,42–11,07 giờ (trong 8–14 giờ). Chết 0 → 0. Trên nền cũ `8125fe3` (trước hàng chờ/building đặc biệt): Lv20 60–73 → 62–75, Lv50 4,02–4,70 → 4,28–4,48, tái sinh đầu 10,62–11,93 → 10,08–11,15. Kiểm đồng nhất: tắt rune/bậc 3/thú cưỡi/growth/ghép thì `pacing.ts 900 1` **giống từng byte** với `8125fe3` (refactor job/EXP/cache không đổi hành vi). Lv20 dịch lên vài phút — **chưa tách nguyên nhân** (luồng RNG của rune từ vùng level ≥ 10, ghép NL tự động cũng chạy trước Lv20); seed 4 = 79 phút, sát mép 80 — cần theo dõi.
  - Kiếp sau (`pacing.ts 2100` seed 1–2, nền `8125fe3`): độ dài kiếp 2 / 3 / 4 ~7 / 5 / 3,5 giờ → ~7–8 / 6–7 / 6 giờ (kiếp 5 ~4 giờ seed 2); trên nền cũ từ ~28 giờ mọi hunter kẹt Lv1 (xem TODO), với nhánh này tới 35 giờ vẫn lên level.
  - Headless 16 giờ (sau): kill 18.755–20.943 (trước 18.840–20.740); 0 chết; 8/8 tái sinh; rune rơi 80–92 / 16 giờ; growth 43–69 cấp; thú cưỡi 3–5; ghép 402–538 đơn vị NL; vàng Town 16 giờ 8,8–23,7k → 9,4–28,0k. Vàng hunter tb lúc 8 giờ (kiếp 1, Lv tb 69–76) 3,5–6,8k → 3,2–5,6k (growth/thú cưỡi là chỗ tiêu vàng hunter); 16 giờ 2,2–8,1k → 3,0–7,4k.
- Còn mở: skill riêng theo nhánh chưa có (skill vẫn theo class + `jobTierMin`); rune chưa gắn vào đồ; Shop/cường hóa không để dành vàng cho kế hoạch học; relic tự động tắt (chưa tune với đầu tư Town); chưa có UI ngoài lệnh; số liệu thú cưỡi/growth/rune là đề xuất.

## 6. Di chuyển và pathfinding

- Map là **waypoint graph**: node (vị trí, zoneId, loại: square/road/door/gate/field/portal — `portal` = Cổng Tái Sinh, §5.13) và cạnh (khoảng cách).
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
- Mỗi đòn quái đánh hunter (kể cả bị né, như EHT): giảm Mood `moodPerHitTaken` × personality; mỗi đòn hunter đánh: giảm Satiety (GDD §4.2).

### 7.1 Mô hình combat **[ĐỀ XUẤT]**

Hằng số ở `formula_params.json`; phương trình và ý đồ ghi ở đầu mỗi hàm trong `formulas.ts`. Hunter và quái dùng cùng công thức (quái có `level` trong `monster.json`).

| Công thức | Phương trình | Ý đồ |
|---|---|---|
| Giảm sát thương theo DEF | `raw = DEF / (DEF + defPerLevel·L_tấn công + defFlat)`; `R = raw` khi `raw ≤ defSoftKnee`, trên đó `R = cap − (cap − knee)·exp(−(raw − knee)/(cap − knee))` (`cap = defReductionCap`) | Hyperbol: tăng dần, lợi ích giảm dần, không bao giờ 100%. DEF "nửa giá trị" tăng theo level **người đánh**, nên DEF giữ ý nghĩa suốt 100 level; hunter vượt cấp zone thì quái zone đó gần như không làm gì được. Trần **mềm**: trên knee cong mượt (cùng giá trị, cùng độ dốc) về phía trần và không bao giờ chạm. |
| Chênh level | `G = max(levelGapMin, 1 − levelGapStep × max(0, L_mục tiêu − L_tấn công − levelGapGrace))` | Chỉ phạt kẻ đánh thấp hơn mục tiêu quá `levelGapGrace` level (không thưởng khi cao hơn). Quái zone thấp không giết được hunter đang đi ngang về Town; hunter vào zone trên level gây ít sát thương → ratio thấp → AI chờ đủ level. |
| Một đòn | `hit = max(minDamage, ATK × (1 − R) × G)` | Không bao giờ 0/âm; DEF cực lớn vẫn còn `(1 − cap) × ATK`. |
| Crit | `P = min(critChanceCap, CRIT/100)`; `mult = base + critOverflowMult × max(0, CRIT/100 − critChanceCap)` | Theo EHT: trần 50% (`critChanceCap` 0,5), sát thương crit ×1,5 cho cả hunter (`critMultiplier`) và quái (`monsterCritMultiplier`, trước 2). `critOverflowMult` = 0: điểm crit vượt trần **bỏ phí** (trước 1: chuyển thành sát thương crit), để ×1,5 là trần thật; hunter hiện tối đa ≈ 49 điểm (gốc ≤ 9 + trait 10 + buff 30) nên gần như không chạm. |
| Né | `P = dodgeCap × EVA / (EVA + dodgeHalf)` | Lợi ích giảm dần, bằng nửa trần tại `dodgeHalf`, không chạm trần. `dodgeCap` 0,4 (EHT: né tối đa 40%; trước 0,6). |
| Kỳ vọng một đòn | `E = hit × (1 − P_né) × (1 + P_crit × (mult − 1))` | Dùng cho AI (§5.3). Thứ tự RNG trong combat: né trước, crit chỉ khi trúng. |
| Cộng dồn % | `(base × job × (1 + reinc × reincStatBonus) + gear) × (1 + min(traitPctCap, Σtrait%)/100) × (1 + min(buffPctCap, Σbuff%)/100)` | Cộng trong cùng nhóm (trait / buff skill), nhân giữa các nhóm, mỗi nhóm có trần. Crit/EVA là điểm cộng thẳng, trần nằm ở hàm xác suất. Tốc đánh: `interval ÷ (cùng hệ số)`, sàn `minAttackInterval` 0,25 s (EHT; trước 0,35). |
| Mood | `× moodStatMult` lên ATK/DEF: 1 khi mood ≥ `moodPenaltyFrac` (0,5), giảm tuyến tính tới `moodStatFloor` (0,6) ở mood 0 | GDD §4.2 / EHT ("chỉ số khác co giãn theo thanh Mood"). **Bật.** Mood giảm `moodPerHitTaken` mỗi lần quái tấn công (kể cả bị né) và theo thuế (§5.10); không giảm theo thời gian (`moodDecayPerSec` 0). AI dùng `planStats` (steady × mood hiện tại) cho chấm vùng (§5.3) và rút lui (§5.2), nên hunter mood thấp tự thấy vùng nguy hiểm hơn, về sớm hơn hoặc xuống vùng dễ hơn. `moodStatFloor = 1` là tắt. |

Trần theo EHT + Mood **[ĐỀ XUẤT, đã làm]**: `critChanceCap` 0,6 → 0,5, `critOverflowMult` 1 → 0, `monsterCritMultiplier` 2 → 1,5, `dodgeCap` 0,6 → 0,4, `minAttackInterval` 0,35 → 0,25, `moodStatFloor` 1 → 0,6. Trên cùng hunter (snapshot 5 mốc 1–14 giờ, seed 1–10, chỉ số steady): DPS hunter **không đổi** (crit tb ≈ 3, EVA ≈ 3, interval ≈ 1,0 s — không ai chạm trần), DPS quái lên hunter −5,6% (crit quái ×1,5 thay ×2 bù hơn phần né giảm). Mood lúc săn: tb 0,66, 27% thời gian dưới 0,5; hệ số mood tb 0,976 lên ATK/DEF. Pacing 900 phút seed 1–10 (trước → sau, cùng code sau merge gear-tier/portal; town tự lên Normal ≈ 13–14 giờ): Lv20 61–89 → 55–77 phút, Lv50 4,08–4,65 → 4,17–4,65 giờ, tái sinh đầu 12,27–13,85 → 11,77–13,53 giờ, chết 1 → 0, về tới Town dưới 10% HP 8 → 15 / ~30.000 chuyến; seed 11–20: chết 0 → 0, dưới 10% HP 8 → 6. Độ chính xác HP mất mỗi kill (đo/dự đoán, seed 1–10): 0,99–1,09 mọi vùng (trước 0,99–1,12). Độ nhạy `moodStatFloor` (AI theo mood, trước merge): 0,85 / 0,7 / 0,5 và (0,6 với `moodPenaltyFrac` 0,7) → chết 0 ở mọi mức, hệ số mood tb 0,991 / 0,982 / 0,970 / 0,933; trước khi AI tính mood, bật ở 0,85 làm chết tăng ~1,5×.

Trần mềm **[ĐỀ XUẤT, đã làm]**: trước đây trần cứng `min(0.85, raw)` bão hòa khi `DEF ≥ 5.67 × (3L + 35)` (L = level người đánh: ≈ 400 DEF ở Lv10, ≈ 710 ở Lv30), nên hunter Lv30 tái sinh ở Torment I (DEF Vực Thẳm 676–832) đánh quái đã chạm trần và tăng `monsterDefMul` không đổi gì. Nay `defSoftKnee` = 0,7: dưới 0,7 công thức giữ nguyên (ở Dễ, hunter đánh quái tối đa raw ≈ 0,63, nên sát thương hunter gây ra **không đổi**; chỉ quái thấp hơn hunter ≥ ~50 level — đã bị phạt chênh level 0,3 — đánh hunter mạnh hơn một chút: 15% → ~20% ATK); trên 0,7 R tiến dần tới 0,85 (raw 0,85 → R 0,795; raw 0,95 → 0,828; giới hạn ≈ 0,83). Với hunter Lv30 ở Torment I: Vực Thẳm R 0,79–0,80 (trước 0,84–0,85), Torment II (×20) 0,81 — DEF quái vẫn có tác dụng. `defSoftKnee ≥ defReductionCap` = trần cứng cũ. Pacing ở Dễ không đổi đáng kể (đo cùng các thay đổi §5.2/§5.3).

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

Bảng dưới là **thiết kế đích**. Đã có trong `game/config/` (trường thật xem `TABLE_SPECS`): `class` (statRanges, attackSpeed; **không** có growthPerLevel — mức tăng mỗi level là `levelHpGain/AtkGain/DefGain` chung trong `formula_params`), `job` (thêm `statMult`), `stat_grade`, `personality` (thêm `kind?`; target kiểm theo `PERSONALITY_TARGETS`, §5.5), `skill` (kind strike/aoe/buff, `value[]`, `studyLevel[]`, `studyGold[]`…), `trait`, `gear` (slot, level, mainStat, mainValue, craftBuilding, craftSec, materials, basePrice), `gear_quality` (statMult, priceMult, craftChance), `enhance` (`level, successRate, costFrac, dropOnFail`), `material` (price; gồm 7 tinh chất tier `mat.ess.*`), `monster`, `zone`, `difficulty` (unlockHunters, unlockReincarnation, monsterHp/Atk/DefMul, rewardMul; tier đồ §5.8: gearStatMul, gearPriceMul, gearPrefixKey, essenceId, essenceDropChance — đều tùy chọn, thiếu = 1 / không có), `building` (dịch vụ có need/restorePerSec/price), `map_node`, `map_edge`, `journey` (§5.11: durationSec, zoneId, recommendedPower, cost, gold, exp, materials, rare, failHpFrac, failRewardFrac), `invitation` (§4.1: tierChances, gold?, townHallLevel?, autoInvite?), M5 §5.16: `job` (branch?, parentId?, unlockReincarnation?, statBias?, crit?, eva?), `material.composeTo?`, `exp_curve`, `rune`, `relic`, `mount`, `growth_property`, `formula_params`, `loc`, `meta`. Các bảng khác chưa làm.

| Bảng | Trường chính |
|---|---|
| `class` | id, nameKey, jobTree: ref<job>[9], statRanges: {stat: [[min,max] × 3 grade]}, attackSpeed, growthPerLevel {hp, atk, def} |
| `job` | id, classId, tier, nameKey, unlockLevel, unlockReincarnation?, statMult, branch?, parentId?, statBias?, crit?, eva? (§5.16: 9 job mỗi class) |
| `stat_grade` | grade (Normal/High/Highest), point (0/1/2), rollChance |
| `hunter_tier` | tier, minPoints, maxPoints (GDD §4.2). Chưa thành bảng: ngưỡng nằm trong `tierFromPoints` (2/6/10/14) |
| `invitation` | id, nameKey, tierChances {normal…legendary}, gold? (thiếu = chỉ vé), townHallLevel?, autoInvite? (§4.1). Đã làm |
| `personality` | id, nameKey, kind?, weight, modifiers: [{target, op, value}] (§5.5). Đã làm |
| `skill` | id, classId, jobTierMin, maxLevel, cooldown, castType, target, keepTime[], value1[], value2[], studyLevel[], studyCost[], descKey |
| `trait` | id, classId, jobTier, maxLevel, value1Base, value1PerLevel, value2Base, value2PerLevel, pointCost, descKey |
| `gear` | id, nameKey, slot (8 slot, §4.2), level, mainStat, mainValue, craftBuilding, craftSec, materials: [{materialId, count}], basePrice, essenceMul?, setId? (đã làm, world v13); thiết kế đích còn classId, secondValue, enhanceCurve[], gearSkillId? theo món |
| `gear_option` | id, nameKey, kind (positive/negative/unique), stat? (GearStat) hoặc gearSkillId?, min, max, weight, slots? (đã làm, §4.2) |
| `gear_set` | id, nameKey, bonuses: [{pieces 2/4/6, stat + value \| gearSkillId}] — món thuộc set qua `gear.setId` (đã làm, §4.2) |
| `gear_skill` | id, nameKey, trigger (attack), chance, cooldownSec, skillId, skillLevel (đã làm, §4.2) |
| `gear_grade` | id, nameKey, chance, options (0..5), uniques, negChance, valueMul, priceMult (đã làm, §4.2; grade đầu = không option, đồ cũ) |
| `enhance` | level, successRate, costFrac (phí = basePrice × costFrac), dropOnFail (thất bại −1 level) |
| `material` | id, nameKey, rating, price, zoneIds[], composeTo? |
| `monster` | id, nameKey, race, level, hp, atk, def, exp, gold, drops: [{matId, chance}], zoneIds[] |
| `zone` | id, nameKey, difficultyId, monsterPool: [{monsterId, weight}], waypointNodes[] |
| `difficulty` | id, order, unlock: {hunterCount, reincarnation} (GDD §8), monsterMultiplier |
| `building` | id, nameKey, kind, maxLevel, requires: {townHallLevel}, upgradeCost: [{gold, materials, sec}] × maxLevel (phần tử 0 = giá xây), mảng hiệu ứng theo level theo kind (§5.12). Đã làm; chưa có maxCount (= 1), size |
| `building_plot` | id, doorNode, townHallLevel, startBuilding?, startLevel?, x, y, w, h (§5.12). Đã làm |
| `service` | buildingId, need (hp/satiety/mood/stamina), restoreAmount[], price[], stockPerCycle[], cycleSec |
| `consumable` | id, nameKey?, kind (supply/potion), buildingId, minLevel, materials[], units, craftSec, heal?, price? (§5.14). Đã làm; thiết kế đích còn effect/keepTime[]/cooldown theo hàng (hiện cooldown chung `potionCooldownSec`, chỉ thuốc HP) |
| `rune` | id, nameKey, stat (ModStat), minMonsterLevel, valueByGrade[], dropChance[] (theo grade; §5.16) |
| `relic` | id, nameKey, effect (expPct/runeDropPct/growthCostPct), maxLevel, value[], upgradeCost[{gold, materials}] (§5.16) |
| `mount` | id, nameKey, moveSpeedMul, price, minLevel (§5.16) |
| `growth_property` | id, nameKey, stat (hp/atk/def), valuePerLevel, maxLevel, cost[] (§5.16) |
| `exp_curve` | level, exp[maxReincarnation + 1] (§5.16) |
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
| v9 → v10 | Tier đồ theo độ khó, thu hồi, rã đồ (§5.8) | Mọi món đang có — đang mặc (cả hunter đang đi journey), đang bán, đang chế — nhận tier gốc (`difficultyId` = độ khó đầu tiên, ×1) nếu chưa có; `town.gearStorage = []`, `town.autoDifficulty = true` (chỉ tự **tăng**); stat `gearDismantled`/`gearReclaimed`/`gearRelisted` = 0. `MIGRATIONS[9]`. |
| v10 → v11 | Vật tư dịch vụ, thuốc, phí hồi sinh (§5.14) | `town.supply`: mọi dòng dịch vụ đầy theo level building (bậc theo level hunter trung vị), dòng thuốc rỗng; hunter (cả đang journey) `potions = {}`, `potionCdMs = 0`; stat `supply*`/`potion*`/`revive*` = 0; chỉ điền trường thiếu. `MIGRATIONS[10]`. |
| v11 → v12 | Cổng Tái Sinh | `portal = []` (giữ mảng nếu đã có), §5.13. |
| v12 → v13 | (nhánh M5 khác) | Dành chỗ; ở nhánh này `MIGRATIONS[12]` không đổi gì — lead đánh số lại khi merge. |
| v13 → v14 | Hàng chờ, thư mời, Donate/Banish (§4.1) | `town.queue = []`, `queueTimerMs = autoInviteTimerMs = 0`, `tickets = {}`; stat `queueJoined/queueEntered/invites/inviteGold/autoInvites/donatedGold/banished/personalityRerolls` = 0; chỉ điền trường thiếu (`fillMissingHunterQueue`). `MIGRATIONS[13]`. |
| v14 → v15 | Building đặc biệt M5 (§5.15) | Stat `trainSessions`/`trainGold`/`trainExp`/`libraryExp` = 0 (chỉ điền trường thiếu). `Hunter.aura`/`trainMs` optional: aura đồng bộ lại từ level building ở tick đầu. `MIGRATIONS[14]`. |

- **Offline progress [CHỐT, theo EHT]:** khi tắt game **không săn**: không EXP, vàng, kill, vật liệu, không hồi nhu cầu, không lên level/tái sinh theo ước lượng; timer săn/boss không chạy. Như EHT, chỉ những thứ chạy theo **đồng hồ thời gian thực** tiếp tục. (Trước đây có ước lượng theo tốc độ đo được + mô hình tăng trưởng, trần 8 giờ; đã gỡ hẳn cùng các khóa `offline*` trong `formula_params` và `tools/offline-accuracy.ts`.) **[ĐÃ LÀM]**
  - **Code** `src/core/offline.ts` (thuần, tất định, không DOM): `advanceOfflineWallClock(ctx, offlineWallClockMs(savedAt, now))` gọi qua `Simulation.runBetweenTicks` (RNG sống của sim, ghi lại vào `world.rng`; **không** tăng `tick`/`timeMs`). Khoảng = `now − savedAt` thô, **không trần** (không còn gì để ngoại suy); `savedAt` ≤ 0/không hữu hạn (save cũ) hoặc đồng hồ lùi → 0. Theo thứ tự:
    1. **Journey** (`advanceJourneys(ctx, ms, true)`, §5.11): chuyến xong được roll ngay, đội về quảng trường (event `journeyCompleted { offline: true }`). Đội về không săn phần còn lại của khoảng vắng.
    2. **Cổng Tái Sinh** (`progression.advancePortal`, §5.13): hunter hết thời gian trong cổng ra ở node portal, đã tái sinh, level 1. Hunter đủ điều kiện nhưng chưa vào cổng lúc save thì không đi khi game tắt (không có di chuyển offline).
    3. **Công trình đang xây/nâng** (`town.advanceBuildingTimers`, cùng logic hoàn thành như system `town`: level, stat, event `buildingCompleted`) — đã trả tiền lúc bắt đầu; tự đầu tư **không** bắt đầu bước mới khi offline.
    4. **Hunter mới đến, hàng chờ, mời tự động** — `arrivals.advanceArrivals(ctx, ms)`, đúng hàm tick dùng (§4.1): hàng chờ vào slot trống trước; một khách mỗi `arrivalIntervalSec` khi còn slot (journey/cổng giữ slot; timer về 0 khi đầy); Town đầy → một khách vào hàng chờ mỗi `queueArrivalIntervalSec` tới `queueMax` (không rút RNG); ≤ `autoInviteMaxHunters` hunter → mời tự động mỗi `autoInviteIntervalSec`.
  - Kết quả `OfflineReport { awayMs, journeys, reincarnations, buildings, arrivals, queued }` (`queued` = số khách vào hàng chờ, v14); `offlineHasNews` = có ít nhất một mục trong journeys/reincarnations/buildings/arrivals (vào hàng chờ thôi không phải tin; popup có hiện nếu có tin khác).
  - **Client** (`src/client/main.ts`, `offlinePopup.ts`): lúc boot load → `advanceOfflineWallClock` → nếu có tin thì **save ngay** (reload trước autosave không chạy lại timer đã xong) và popup: thời gian vắng (ghi rõ hunter không săn khi tắt game), hunter mới đến, hành trình xong (thành công/thất bại, thưởng), tái sinh xong trong cổng, công trình xong. Không có gì xong → không popup. Nút Load của debug chỉ load, không chạy offline. **Tab bị ẩn** (rAF dừng nên sim dừng): khi hiện lại các timer trên chạy thêm đúng thời gian ẩn (cùng hàm), popup nếu có tin.
  - **Save cũ**: envelope trước đây có `offline` (mẫu đo tốc độ). `deserialize` bỏ qua trường này (hợp lệ hay hỏng đều load được) và `serialize(world, savedAt)` không ghi nữa; không đổi schema.
- Journey lúc đang chơi đếm theo **thời gian game** (x2/x4 rút ngắn, pause dừng); khi tắt game theo thời gian thực như trên. Cổng Tái Sinh cũng vậy.
- `Simulation.advance` chạy tối đa 600 tick mỗi lần gọi để tránh dồn tick sau khi tab bị ẩn (thời gian ẩn chỉ chạy các timer thời gian thực, như offline).

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

**Memo chỉ số hiệu dụng (đã làm).** `hunterStats` gọi qua `memoHunterStats` (`src/core/statsCache.ts`); phần tính giữ nguyên trong `computeHunterStats` (formulas.ts), chữ ký công khai không đổi. Cũng là dữ liệu dẫn xuất (WeakMap theo object hunter, không nằm trong World/save).

- Mỗi hunter giữ 1 entry cho chỉ số steady và 1 cho live, kèm snapshot **giá trị** mọi input mà `hunterStats` đọc: object config + formula, mọi trường `h.stats`, classId, jobTier, reincarnation, level, gearId/qualityId/enhance của từng slot, cấp trait, M5 `jobId` / cấp growth / ô rune (§5.16); live thêm stat/value từng buff và `needs.mood`. Mỗi lần gọi so snapshot với hunter hiện tại, khác là tính lại. Không khoá theo tick/id: lên cấp, thêm buff, mood giảm, đổi đồ giữa tick đều miss, nên kết quả trùng với tính mỗi lần (vd. `progression` đọc max HP trước/sau khi lên cấp trong cùng tick).
- Kết quả bị `Object.freeze` và dùng chung giữa các caller; ghi vào sẽ throw.
- **Khi `hunterStats` đọc thêm trường mới của hunter, phải thêm trường đó vào `matches`/`capture`.** `setStatsCacheVerify(true)` hoặc env `TH_VERIFY_CACHES=1` tính lại ở mỗi lần hit và throw nếu lệch (`tests/statsCache.test.ts` chạy 10 phút sim ở chế độ này).
- `crafting.countUpgrades`: bảng roll theo quality (xác suất, giá trị, ngân sách tối thiểu) chỉ phụ thuộc config, cache theo (config, formula, gear).
- Đã kiểm: output headless 720 phút seed 1–3 và hash world + event từng phút giống từng byte trước/sau (seed 1 cả khi bật verify); toàn bộ test chạy ở chế độ verify. 240 phút seed 1, CPU của vòng sim (min 7 lần xen kẽ): 13,2 → 10,5 giây (−20%); `hunterStats` (gồm `needMax`) từ ~20% còn ~10% thời gian `step`.
- Cả hai cache khoá theo object `config`/`config.formula`: sửa giá trị config tại chỗ (vd. qua `window.sim` trong console) sẽ không được thấy; muốn đổi config thì tạo object config mới (`loadConfig`).
- Đã thử và bỏ: index id → vị trí cho `findHunter`/`findMonster` (Array.find trên ≤ ~100 quái chỉ ~0,1% thời gian; dựng lại Map sau mỗi lần `filter` quái chết làm chậm hơn), memo `personalityFactor` (tra Map theo chuỗi `urgent.<need>` ghép mới mỗi lần chậm hơn vòng lặp gốc).
- Còn nóng (đo 240 phút seed 1, % thời gian `step`): `applyUrgentBackstop` → `backstopHpFloor` → `retreatHpFloor`/`tripHomeDamage`/`zoneDanger` (~22%): mỗi tick, 2 lần cho mỗi hunter ngoài field trong dải HP, dựng `dangerCache` mới và chạy lại `duel` cho mọi loại quái của các vùng trên đường về. Hướng làm: memo `ZoneDanger` theo hunter, khoá theo object chỉ số steady (memo trên trả cùng object khi input không đổi) + maxHp + độ khó + `h.skills`/level (input của `duel`). Chưa làm vì đang có thay đổi song song ở code retreat/combat. Tiếp theo: `crafting.pickRecipe`/`autoMaterialDemand` (~7%, `recipeBeneficiaries` duyệt hunter 2 lần, có thể gộp 1 lượt), `monsterActs` (~5% self).

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
| M4 | Town & chế độ chơi: Trading Post theo yêu cầu ✅, Bounty ✅, offline progress ✅ (EHT), Journey ✅, Cổng Tái Sinh ✅; Town Hall, xây/nâng cấp/đặt building, slot building, cấp building giới hạn tier đồ, tự đầu tư ✅ (§5.12), thuế ✅ | QA checklist GDD §13 đạt; vàng/NL Town có chỗ tiêu ra khỏi nền kinh tế |
| M5 | Chiều sâu hunter & trang bị: Invitation + `hunter_tier` (GDD §4.1–4.2), Donate/Banish; đủ 9 bậc nghề ✅ (§5.16) và 7 slot đồ (GDD §6; đã làm 8 slot, §4.2); nâng tier đồ (Dark Stone), `gear_option` / `gear_set` / `gear_skill` (đã làm, §4.2); `consumable` (potion, Alchemist) + goal BuyPotion; Training Ground + goal Train; Bank, Courage Headstone, Fountain of Life, Library of Wisdom; `rune`, `relic`, thú cưỡi, `growth_property`, ghép NL (`material.composeTo`), `exp_curve` theo lần tái sinh ✅ (§5.16); ~~bật Mood ảnh hưởng chỉ số (GDD §4.2)~~ (đã bật, §7.1); lệnh người chơi học skill/trait ✅ (§5.16) | Mọi bảng §8 (trừ `raid`) có code dùng; cân bằng lại bằng headless |
| M6 | Client & nội dung: UI hoàn chỉnh (GDD §10), sprite/scene pixel-art và camera pan/zoom/chọn bằng click (GDD §11), UI cho yêu cầu vật liệu/bounty/building, vi/en, tutorial, headless xuất CSV; thay toàn bộ dữ liệu trích từ game thương mại (TODO §7), chốt nền tảng (GDD §2) và bố cục map | Bản chơi thử nội bộ, không còn dữ liệu sao chép |
| M7 | Online: account, cloud save, IAP; Raid, PvP, Guild, World Boss, Tower Defense, chat, ranking | Theo đặc tả riêng |

Hiện trạng: M0–M3 xong; M4 đã có Trading Post theo yêu cầu (§5.7), Bounty (§5.9), thuế (§5.10), Journey (§5.11), Town Hall/building (§5.12), offline progress kiểu EHT (§9: chỉ timer thời gian thực), Cổng Tái Sinh (§5.13), tier đồ theo độ khó + thu hồi + rã đồ (§5.8); M5 một phần: vật tư/thuốc/phí hồi sinh (§5.14), hàng chờ + thư mời + Donate/Banish + tính cách mở rộng (§4.1, §5.5) ; building đặc biệt (§5.15) — world v15 (v13 dành cho nhánh khác). QA nghiệm thu: `docs/QA_M4.md` (dựng từ TECH_SPEC, chờ đối chiếu GDD §13).

### 12.1 Bảng phủ (chống bỏ sót)

Mọi hệ thống nhắc trong GDD hoặc có bảng ở §8 phải nằm trong một mốc ở bảng trên. Khi thêm hệ thống/bảng mới vào GDD hoặc §8, thêm luôn một dòng ở đây. GDD không nằm trong repo: bảng này dựng từ các tham chiếu GDD trong TECH_SPEC/TODO; cần đối chiếu lại với GDD gốc.

| Hệ thống (nguồn) | Mốc | Trạng thái |
|---|---|---|
| Class, job, stat grade, personality, skill, trait (§8) | M1–M3 | ✅ (job: 9 job mỗi class, §5.16) |
| Gear, gear_quality, enhance, material, monster, zone, difficulty, service (§8) | M1–M3 | ✅ (gear: 8 slot từ M5, §4.2) |
| Needs, AI utility, combat, death/revive, reincarnation (GDD §4, §8) | M1–M3 | ✅ |
| Trading Post / yêu cầu vật liệu (GDD §5, §9) | M4 | ✅ |
| Bounty (GDD §9) | M4 | ✅ |
| Offline progress (§9) | M4 | ✅ theo EHT: chỉ journey, Cổng Tái Sinh, công trình, hunter mới đến chạy theo thời gian thực; không săn offline |
| Cổng Tái Sinh (EHT, §5.13) | M4 | ✅ (node `portal`, `reincarnationSec` 300 s, chạy cả offline) |
| Journey (GDD §9, bảng `journey`) | M4 | ✅ (§5.11; chưa có AI/tự gửi, chưa có UI ngoài debug) |
| Town Hall, xây/nâng/đặt building, slot, cấp shop giới hạn tier (GDD §5, bảng `building`, `building_plot`) | M4 | ✅ (§5.12; building M5 dùng 6 ô trống, §5.15) |
| Thuế (§3.1, §5.10) | M4 | ✅ |
| QA checklist (GDD §13) | M4 | 🟡 `docs/QA_M4.md` dựng từ TECH_SPEC: 59 mục, 0 ❌, 5 ⚠️, 1 ⏭️ (tự động: `tests/m4-acceptance.test.ts`; tay: trình duyệt); phải đối chiếu lại với GDD §13 gốc |
| Invitation, `hunter_tier`, Donate/Banish (GDD §4.1–4.2); hàng chờ + mời tự động (EHT Waiting Slot) | M5 | ✅ §4.1 (world v14; `invitation.json`; tier roll → grade roll theo tier; `hunter_tier` vẫn là ngưỡng trong code, legendary chỉ đạt qua thư mời; chưa có nguồn vé, chưa UI) |
| Personality tích cực/tiêu cực/trung tính, target gain.gold/gain.exp/enhance.success, đổi tính cách (§5.5) | M5 | ✅ (21 personality, số liệu đề xuất) |
| 9 bậc nghề, 7 slot đồ (GDD §6) | M5 | ✅ cây nghề 9 job (1+1+1+3 nhánh+3, §5.16); 8 slot đồ (§4.2, world v13: vũ khí, mũ/thân/găng/giày, dây chuyền/nhẫn/đai) |
| Tier đồ theo độ khó (tinh chất, `difficulty.gearStatMul`), tự tăng độ khó, thu hồi đồ khi tái sinh + kho đồ Town, rã đồ (EHT; §5.8) | M4 | ✅ (world v10; số liệu đề xuất) |
| Nâng tier đồ có sẵn, `gear_option`, `gear_set`, `gear_skill` | M5 | 🟡 `gear_grade`/`gear_option`/`gear_set`/`gear_skill` ✅ (§4.2, §5.4; số liệu đề xuất); nâng tier đồ có sẵn (Dark Stone) ⚪ |
| `consumable`, potion, Alchemist, goal BuyPotion; vật tư dịch vụ, phí hồi sinh | M5 | 🟡 §5.14: vật tư 4 dịch vụ + thuốc HP ở Infirmary (thay Alchemist), goal `buyPotion`, phí hồi sinh; chưa có thuốc satiety/stamina, chưa UI |
| Training Ground + goal Train; Bank, Courage Headstone, Fountain of Life, Library of Wisdom | M5 | ✅ §5.15 (tên tự đặt; số liệu đề xuất; chưa UI ngoài debug) |
| `rune`, `relic`, thú cưỡi, `growth_property` | M5 | ✅ (§5.16; rune gắn vào hunter, relic tự động tắt) |
| Ghép NL (`composeTo`), `exp_curve` | M5 | ✅ (§5.16) |
| Mood ảnh hưởng chỉ số (GDD §4.2) | M5 | ✅ (`moodStatFloor` 0,6; AI chấm vùng/rút lui bằng `planStats`, §7.1) |
| Lệnh học skill/trait (GDD §10 menu Learn) | M5 | ✅ (`hunter.learn` kế hoạch học, cả growth; §5.16) |
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
