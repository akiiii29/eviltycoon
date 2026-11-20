# QA checklist M4 — nghiệm thu

Tiêu chí xong của M4 (TECH_SPEC §12) là "QA checklist GDD §13 đạt", nhưng **GDD không có trong repo**. Checklist này dựng từ TECH_SPEC (§5.7–§5.12, §9, §12, §12.1) và TODO. **Phải đối chiếu lại với GDD §13 gốc khi có**: thêm mục còn thiếu, sửa mục lệch luật.

- Commit kiểm: nhánh `fix/economy-and-formulas` @ `958da52` cộng các thay đổi của lượt QA này.
- Ngày chạy: 2026-11-20/21. Máy: Windows 10, Node 22, trình duyệt pane của Claude desktop (Chromium).
- Cách kiểm:
  - **A** = test tự động. `tests/m4-acceptance.test.ts` (mới, ~3–6 s) chạy kịch bản liên hệ thống. Test đơn vị có sẵn được ghi theo tên file.
  - **M** = kiểm tay trong trình duyệt: `npm run dev -- --port 5199 --strictPort`, dùng nút của debug overlay và `window.sim` trong console.
- Kết quả: ✅ đạt · ❌ lỗi · ⚠️ đạt nhưng có ghi chú · ⏭️ chưa chạy.

## 0. Toàn cục

| ID | Mục | Cách kiểm | KQ |
|---|---|---|---|
| QA-INV | Mọi world M4 giữ bất biến: vàng Town/hunter/kho là số nguyên ≥ 0; needs hữu hạn trong [0, max]; level trong [1, maxLevel]; không hunter trùng id hoặc vừa đi xa vừa ở field; số hunter (kể cả đi xa) ≤ slot; ký quỹ bounty = thưởng − phần đã trả; số bounty/journey/công trình đang chạy ≤ giới hạn; building ≤ maxLevel và ≤ Town Hall; shop ≤ sức chứa; thuế trong [min, max] | A: `violations()` trong `m4-acceptance`, chạy mỗi phút game của phiên 20 phút, sau offline và sau migration | ✅ |
| QA-LOOP | Một phiên 20 phút có đủ mọi hệ thống M4. Seed 4, 6 hunter cộng hunter tự đến, thuế 20%, 2 bounty, Town Hall 1→3, hủy nâng shop, xây Nhà Kho, 2 chuyến journey (1 bị gọi về), bật tự đầu tư lúc 10 phút. Chỉ bị từ chối đúng 2 lệnh cố ý sai | A: `QA-LOOP` (6 test) | ✅ |
| QA-SAVE | Save → load giữa lúc journey đang đi, bounty đang chạy, thuế khác mặc định; chạy tiếp giống từng byte (world và event) với bản không save | A: `QA-SAVE` | ✅ |
| QA-CMD | Mỗi lệnh M4 khi sai trả `commandRejected` với lý do (hợp đồng với UI) | A: `QA-CMD` (14 trường hợp). Thêm `bounty`/`tax`/`journey`/`town`/`trading.test.ts` | ✅ |
| QA-DET | Tất định: cùng seed và cùng lệnh cho cùng kết quả | A: `QA-SAVE`, `bounty`/`tax`/`journey`/`town.test.ts` (determinism) | ✅ |

## 1. Trạm Thu Mua theo yêu cầu (§5.7)

| ID | Mục | Cách kiểm | KQ |
|---|---|---|---|
| TP-1 | Yêu cầu tự động = NL thiếu cho min(wanters, requestMaxCopies) lần chế. Tắt auto-craft thì không có | A: `trading.test.ts` (automatic requests) | ✅ |
| TP-2 | Lệnh `town.requestMaterial` đặt lại số; 0 = hủy; từ chối NL lạ và số sai | A: `trading.test.ts`, `QA-CMD` | ✅ |
| TP-3 | Bán: phần được yêu cầu vào kho; phần vượt bị bỏ, hoặc Town mua "để xuất" khi vàng trên sàn; 2 hunter cùng tick không lấp trùng | A: `trading.test.ts` | ✅ |
| TP-4 | Yêu cầu của người chơi giảm dần khi hunter bán; Town vẫn chế và bán trong phiên thật | A: `QA-LOOP` (trading post) | ✅ |
| TP-5 | AI ưu tiên vùng rơi NL được yêu cầu nhưng không bao giờ kéo hunter vào vùng không sống nổi | A: `trading.test.ts` (AI) | ✅ |
| TP-6 | Ngân khố: phần phí Town nhận giảm khi vàng trên mục tiêu | A: `trading.test.ts`, `balance-treasury.test.ts` | ✅ |
| TP-7 | UI đặt yêu cầu | — (M6; overlay không có nút) | ⏭️ |

## 2. Bounty (§5.9)

| ID | Mục | Cách kiểm | KQ |
|---|---|---|---|
| BO-1 | Đặt bounty: ký quỹ trừ ngay khỏi vàng Town | A: `bounty.test.ts`. M: nút "+Đồng Cỏ" làm vàng Town 502 → 402, bounty 10 kill / 100g | ✅ |
| BO-2 | Từ chối: mục tiêu lạ, số sai, thưởng < kill, thiếu vàng, quá `bountyMaxActive` | A: `bounty.test.ts`, `QA-CMD`. M: bounty thứ 4 bị từ chối "too many bounties" (max 3) | ✅ |
| BO-3 | Trả theo từng kill, tổng đúng bằng thưởng; ký quỹ còn lại = thưởng − phần đã trả | A: `bounty.test.ts`, QA-INV. M: 7/10 kill thì ký quỹ còn 30 | ✅ |
| BO-4 | Hoàn thành: vương quốc trả Town round(thưởng × 0,25) | A: `QA-LOOP`. M: log "bounty b103 xong · vương quốc trả Town +25g" | ✅ |
| BO-5 | Hủy hoàn phần ký quỹ còn lại | A: `QA-LOOP`. M: nút hủy b104 thì vàng Town +100 (đúng ký quỹ), log "bị hủy · hoàn 100g" | ✅ |
| BO-6 | Bounty tự động: đặt khi vàng Town trên mục tiêu; hết hạn thì hoàn tiền; nút bật/tắt | A: `bounty.test.ts`; `QA-LOOP` (Town giàu có bounty tự động). M: nút "bounty tự động: BẬT → TẮT" đổi `town.autoBounty` | ✅ |
| BO-7 | Torment tăng tỉ lệ rơi của mục tiêu, không đổi số lần rút RNG | A: `bounty.test.ts` (chưa đo trong mô phỏng dài) | ⚠️ |
| BO-8 | UI đặt bounty | M: overlay mới có nút đặt bounty vùng (10 kill / 100g) cho từng vùng, chỉ để debug. UI thật là việc của M6 | ⚠️ |

## 3. Thuế (§5.10)

| ID | Mục | Cách kiểm | KQ |
|---|---|---|---|
| TX-1 | Thuế = floor(vàng kill × rate) chuyển sang Town lúc kill; stat = tổng event | A: `tax.test.ts`, `QA-LOOP` | ✅ |
| TX-2 | Lệnh `town.setTaxRate` kẹp trong [taxMinRate, taxMaxRate] và từ chối giá trị sai | A: `tax.test.ts`, `QA-CMD` | ✅ |
| TX-3 | Nút −5% / +5%: 10 → 20 → 15%. Lên tới 50% thì nút + bị disable; xuống 0% thì nút − bị disable. Dòng "Thuế …% · đã thu …g" cập nhật, log "thuế → x%" | M | ✅ |
| TX-4 | Trên 10%, mỗi kill bị thu làm mất mood | A: `tax.test.ts` | ✅ |
| TX-5 | Save cũ không có `taxRate` load ở mặc định | A: `tax.test.ts`, `QA-MIG` | ✅ |

Ghi chú TX-3: bấm 2 lần trong một khung 200 ms (trước khi overlay vẽ lại) thì gửi 2 lệnh cùng giá trị và log "thuế → 0%" hai lần. Không sai luật, `setTaxRate` cùng giá trị vẫn phát event.

## 4. Journey (§5.11)

| ID | Mục | Cách kiểm | KQ |
|---|---|---|---|
| JO-1 | `journey.start` từ chối: đích lạ, đội rỗng hoặc > 3, trùng, hunter chết, trong nhà, **không ở Town**, đang đi, quá 2 chuyến, thiếu vàng | A: `journey.test.ts`, `QA-CMD` | ✅ |
| JO-2 | Xuất phát: trừ `cost`; thành viên rời `world.hunters` nhưng giữ slot; needs đóng băng | A: `journey.test.ts`. M: "gửi đội chọn" (h81, h82) trừ 100g, còn 6 hunter ở field. Needs của thành viên giống hệt sau vài giây | ✅ |
| JO-3 | Sức mạnh đội và % xem trước trong overlay khớp lúc gửi | M: xem trước "đội chọn 1.44 → 13%", log "sức 1.44 · 13%" | ✅ |
| JO-4 | Hết giờ thì roll kết quả. Thất bại: ¼ EXP, HP thấp, satiety/mood/stamina ≤ 50%. Đội về quảng trường và đi dịch vụ | A: `journey.test.ts`, `QA-LOOP`. M: Lối Rêu Cũ thất bại, +250 EXP/người, satiety 50, cả hai chọn goal service | ✅ |
| JO-5 | Thành công: vàng Town, EXP, NL vào kho, đồ hiếm lên shop (shop đầy thì bán giá sàn) | A: `journey.test.ts` | ✅ |
| JO-6 | Gọi về ngay: không thưởng, không hoàn `cost` | A: `journey.test.ts`, `QA-LOOP`. M: gọi về Đèo Than Hồng, h83 về field, log "bị gọi về" | ✅ |
| JO-7 | Lệnh theo hunter (Move, tái sinh, debug) bị từ chối khi hunter đang đi | A: `journey.test.ts` | ✅ |
| JO-8 | Journey chạy offline theo thời gian thực và roll lúc load | A: `journey.test.ts`, `QA-OFFLINE`. M: xem §6 | ✅ |
| JO-9 | Nút "gửi 3 mạnh nhất" khi không ai ở Town | M: trước khi sửa, nút vẫn bấm được và chỉ nhận "team must have 1..3 hunters". **Đã sửa:** nút bị disable khi không có ai ở Town | ✅ (đã sửa) |

## 5. Town Hall và building (§5.12)

| ID | Mục | Cách kiểm | KQ |
|---|---|---|---|
| BU-1 | Game mới: mọi building có sẵn ở Lv1 trên ô của nó, kể cả Town Hall | A: `town.test.ts`; QA-MIG (danh sách ô) | ✅ |
| BU-2 | Nâng cấp trả vàng + NL kho ngay; giữ level cũ tới khi xong; xong thì Lv+1 | A: `town.test.ts`, `QA-LOOP`. M: nâng Town Hall trừ 400g và quặng ×4, "→ Lv2 3%", 60 s sau thành Lv2 | ✅ |
| BU-3 | Từ chối: thiếu NL ("missing materials"), thiếu vàng, bị Town Hall khóa, đủ slot xây, max level, ô bị khóa | A: `town.test.ts`, `QA-LOOP`, `QA-CMD`. M: nâng khi kho trống thì "missing materials"; building khác hiện "locked by Town Hall level" | ✅ |
| BU-4 | Hủy hoàn đủ vàng + NL đã lấy từ kho; hủy xây lần đầu thì trả ô | A: `town.test.ts`, `QA-LOOP`. M: hủy → +400g, quặng ×4 trở lại, vẫn Lv1 | ✅ |
| BU-5 | Xây loại mới (Nhà Kho) trên ô mở bằng Town Hall | A: `QA-LOOP` (TH3 → Nhà Kho ở `plot.ne`). M: chưa xây trong trình duyệt (cần TH3) | ✅ (A) |
| BU-6 | Hiệu ứng theo level: trần tier đồ, sức chứa shop, dịch vụ, Lò, Học Viện, Trạm, Nhà Kho | A: `town.test.ts` (per-level effects) | ✅ |
| BU-7 | Tự đầu tư: tiêu vàng trên mục tiêu, bước gấp khi hunter sắp chạm trần tier, nhập NL sau 15 phút | A: `town.test.ts`, `QA-LOOP` (bật lúc 10 phút thì có `buildingStarted` auto) | ✅ |
| BU-8 | Log overlay cho building | M: trước khi sửa, log chỉ hiện "buildingStarted" / "buildingCancelled", không có tên. **Đã sửa:** dòng đọc được (tên, level, vàng, NL, hoàn) | ✅ (đã sửa) |
| BU-9 | Thời gian xây không chạy khi offline | A: `QA-OFFLINE`. M: upgrade còn 119,9 s trước và sau khi vắng 30 phút. Giới hạn đã biết (TODO §4), không phải lỗi | ⚠️ |

## 6. Offline progress (§9)

| ID | Mục | Cách kiểm | KQ |
|---|---|---|---|
| OF-1 | Vắng ≥ 60 s và có ≥ 120 s mẫu thì cộng theo tốc độ; popup tổng kết | A: `offline.test.ts`, `QA-OFFLINE`. M: lùi `savedAt` 2 giờ trong IndexedDB rồi reload. Popup "Vắng 2 giờ 0 phút · Vàng +2623 · Kill +1228", NL vào kho, từng hunter Lv3 → Lv9… | ✅ |
| OF-2 | Trần 8 giờ | A: `offline.test.ts`, `QA-OFFLINE` (vắng 20 giờ thì creditedMs = 8 giờ) | ✅ |
| OF-3 | Đồng hồ lùi hoặc save không có thời gian thì không cộng | A: `offline.test.ts`, `QA-OFFLINE` | ✅ |
| OF-4 | Load lần hai không cộng dồn (save ngay sau khi áp dụng) | A: `offline.test.ts`. M: reload ngay sau popup thì không có popup, kill/level giữ nguyên | ✅ |
| OF-5 | Journey xong trong lúc vắng được roll lúc load và hiện trong popup | A: `QA-OFFLINE`. M: gửi h84 đi Lối Rêu Cũ, lùi 30 phút, reload. Popup có mục "Hành trình: Lối Rêu Cũ (h84): THẤT BẠI · EXP +250/người", `journeys` rỗng, h84 ở quảng trường | ✅ |
| OF-6 | NL offline chỉ vào kho tới mức Trạm Thu Mua yêu cầu | A: `offline.test.ts`, `QA-OFFLINE` | ✅ |
| OF-7 | Vàng hunter offline | M: mọi hunter "vàng +0" trong cả 3 popup. Đúng spec (gold ròng sàn 0: đầu game hunter tiêu hết vào dịch vụ/đồ), nhưng người chơi dễ thấy vô lý. Cần design xem lại | ⚠️ |
| OF-8 | Hunter vừa về từ journey (< 120 s mẫu) không được cộng | M: h81/h82 không có trong popup. Đúng spec (cần đủ cửa sổ đo) | ⚠️ |

## 7. Save và migration v0 → v9 (§9)

| ID | Mục | Cách kiểm | KQ |
|---|---|---|---|
| SV-1 | Save có mỗi version v0…v8, cộng v9 làm trước khi có building, load lên v9 với đủ trường M4 (journeys, bounties, autoBounty, buildings đúng ô, autoInvest, requests, thuế mặc định), giữ bất biến và nhận lệnh M4 (thuế, bounty, yêu cầu NL, nâng Town Hall, gửi journey) | A: `QA-MIG` (10 trường hợp, world giữa game bị bỏ bớt trường theo bảng migration TECH_SPEC §9) | ✅ |
| SV-2 | Từng migration điền đúng giá trị (node quảng trường, rollStats, level building giữ cách chơi…) | A: `save.test.ts`, `journey.test.ts` (v9) | ✅ |
| SV-3 | Từ chối JSON hỏng, file lạ, schema mới hơn | A: `save.test.ts` | ✅ |
| SV-4 | Save cũ tạo tay trong trình duyệt | M: save hiện tại hạ về v6 (bỏ trường bounty/building/journey/thuế), lùi 1 giờ, reload. Load thành v9, 11 building Lv1, bounty rỗng, auto-bounty bật, popup offline vẫn chạy (mẫu trong envelope còn) | ✅ |

## 8. Polish đi kèm (TODO §2, §5)

| ID | Mục | Cách kiểm | KQ |
|---|---|---|---|
| PO-1 | Log `skillCast` không spam: gộp 1 dòng / 5 s game ("kỹ năng ×N (M mục tiêu, 5s): h1 ×a, h2 ×b, +k hunter") | A: `tests/client.test.ts`. M: log hiện dòng gộp | ✅ |
| PO-2 | Mỗi vùng một màu nền riêng; quái chưa có màu thì không còn đỏ báo lỗi | A: `client.test.ts`. M: ảnh chụp có 7 vùng 7 màu | ✅ |
| PO-3 | Lệnh tái sinh thủ công chỉ khi ở Town (từ chối "hunter is not in town"); nút trong overlay bị disable ở field | A: `progression.test.ts`, `QA-CMD` | ✅ |
| PO-4 | Test Học Viện: thêm bản chặt (mọi hunter đủ vàng ở Town đều học trong 1 phút, seed 1/3/7). Bản chạy tự do vẫn "≥ một nửa", lý do ghi trong test | A: `academy.test.ts` | ✅ |

## Lỗi tìm thấy

| # | Lỗi | Xử lý |
|---|---|---|
| 1 | Overlay: log building chỉ có tên event, không có nội dung | Đã sửa (`debugOverlay.ts`) |
| 2 | Overlay: nút "gửi 3 mạnh nhất" bấm được khi không ai ở Town và luôn bị từ chối | Đã sửa (disable) |
| 3 | Renderer: 10/13 loại quái không có màu nên vẽ đỏ `0xff0000`, trông như lỗi | Đã sửa (`render.ts`) |
| 4 | Overlay không có cách đặt bounty (checklist cần) | Thêm nút debug đặt bounty theo vùng |
| — | Không tìm thấy lỗi luật/logic trong core M4 | — |

## Ghi chú / việc mở (không phải lỗi)

- Offline không đếm thời gian xây (BU-9), không craft/mua/tái sinh. Vàng hunter offline sàn 0 nên đầu game hiện "+0" (OF-7).
- Kiểm tay trong pane bị ẩn: `requestAnimationFrame` dừng nên sim đứng. Phần offline có journey được chạy bằng `sim.step()` trong console. Đây không phải lỗi game.
- Dòng log gộp `skillCast` mang tick đầu cửa sổ nhưng được chèn lúc đóng cửa sổ (5 s sau), nên có thể nằm trên dòng có tick lớn hơn.
- Chưa kiểm trong trình duyệt: xây Nhà Kho (cần Town Hall 3), Torment, journey thành công (đội Lv thấp chỉ 13%), tái sinh thủ công (cần max level). Các mục này có test tự động.
- Phải đối chiếu lại toàn bộ checklist với GDD §13 khi có file GDD.
