# Eating Peas

Game web nhiều người chơi: 6 người ngồi quanh bàn, xiên và ăn pea khi mafia đọc báo. Hết lúc đọc báo, mafia rung báo 0.4s để cảnh báo rồi nhìn lên (25% số lần rung báo là giả, mafia đọc tiếp), hoặc 30% số lần nhìn lên luôn không cảnh báo. Nhìn lên thấy người đang hành động thì lên đạn, chĩa súng rồi bắn 1 người đang xiên hoặc đang ăn (nhiều người thì chọn ngẫu nhiên), rồi đọc báo tiếp.

Điều khiển: nút POKE (giữ `F`) xiên liên tục, mỗi lần 0.4s (hạ tay, đâm, đưa tay về), dính 1–2 pea, nĩa giữ tối đa 15 pea. Ăn đủ 70 pea (mỗi đĩa có 84) thì thắng. Nút EAT (`E`) ăn hết pea trên nĩa trong 0.6s. Hành động đã bắt đầu thì chạy hết. Đầu ván đếm ngược 3 giây; trong pha `countdown` và `raising` (mafia chưa đọc báo lại) nút bị khóa.

Trận đấu: chủ phòng chọn 1–5 trận trong phòng chờ. Một trận kết thúc khi có người ăn đủ 70 pea hoặc chỉ còn 1 người sống. Điểm trận = số pea đã ăn; người còn sống lúc hết trận được thưởng `min(20, floor(pea / 2))` (`survivorBonus` trong `js/rules.js`). Người không ăn pea nào thì thưởng bằng 0, nên ngồi im chờ người khác bị bắn không có điểm. Điểm một trận tối đa khoảng 90 (70 pea + 20). Hết mỗi trận hiện bảng điểm 7 giây kèm thanh đếm ngược rồi tự sang trận tiếp; hết trận cuối thì giữ bảng chung cuộc tới khi chủ phòng bấm về phòng chờ.

## Chạy

ES module không load được qua `file://`, cần một static server:

```sh
python3 serve.py        # cổng 8765, mở http://localhost:8765
```

`serve.py` giống `python3 -m http.server` nhưng gửi `Cache-Control: no-store`, để trình duyệt không giữ bản JS cũ sau khi sửa code (giữ bản cũ của một module trong khi module import nó đã là bản mới sẽ làm trang dừng với lỗi import).

`http://localhost:8765/?autoplay` vào thẳng ván offline với 5 bot.

## Bật chế độ online (Supabase)

1. Supabase Dashboard > SQL Editor > New query: dán toàn bộ `supabase/schema.sql` > Run. Chạy lại khi file này thay đổi (các phòng đang chơi bị xóa).
2. `js/config.js` chứa `Project URL` và `anon public` key (lấy từ `.env`). Anon key chỉ gọi được các RPC `peas_*`.
3. Deploy thư mục lên host tĩnh bất kỳ (Vercel, Netlify, GitHub Pages), gửi link `?room=MÃPHÒNG` cho bạn bè.

Online cần ít nhất 2 người, không có bot. Mỗi tab trình duyệt là một người chơi; tải lại trang vẫn là người chơi cũ (secret lưu trong `sessionStorage`).

## Kiến trúc mạng (online)

Server là Postgres của Supabase (`supabase/schema.sql`). Client không quyết định kết quả nào, chỉ gửi lệnh và vẽ lại sự kiện server gửi về.

- Bảng `peas.rooms`, `peas.members`, `peas.events` nằm trong schema `peas`, không cấp quyền cho `anon`. Client chỉ gọi được 5 RPC `security definer`: `peas_join`, `peas_tick`, `peas_act`, `peas_start`, `peas_lobby`.
- Danh tính: mỗi tab sinh một secret ngẫu nhiên; server dùng `md5(secret)` làm id công khai. Client khác chỉ thấy id, nên không gửi lệnh thay người khác được.
- `peas_act('poke' | 'eat')`: server lấy giờ của chính nó làm lúc bắt đầu, kiểm tra luật (còn sống, không bị khóa, nĩa chưa đầy, hành động trước đã xong), tự tung số pea dính lên nĩa (1–2) và cộng điểm khi hành động xong. Lệnh tới sớm hơn lúc hành động trước xong ≤ 0.25s được xếp hàng (1 lệnh), để độ trễ mạng không làm hỏng việc giữ F liên tục.
- Không có process chạy liên tục. Mỗi client gọi `peas_tick` mỗi 250ms; `peas.advance` xử lý các mốc đã tới hạn theo thứ tự thời gian (hành động xong, mafia đổi pha, hết bảng điểm). Xét ai bị bắn dùng thời điểm đã lưu (`st_at`, `st_end` so với lúc mafia nhìn lên), không phụ thuộc lúc tick tới.
- Pha `warning` (rung báo) bắt đầu lúc server xử lý và gửi đi ngay, kéo dài `cfg.warn` = 0.6s (offline 0.4s, thêm 0.2s bù độ trễ mạng). Với xác suất `cfg.instant` = 0.3, hết `reading` server chuyển thẳng sang `watching` tại lúc `reading` hết hạn và xét bắn luôn. Thời lượng `reading`, `watching`, `raising` không gửi cho client, nên không đọc trước được lúc mafia rung báo hay nhìn lên.
- Mỗi thay đổi ghi vào `peas.events` với `seq` tăng dần và gửi qua Realtime Broadcast (`realtime.send`, topic `peas:<mã phòng>`). `peas_tick` trả lại các sự kiện có `seq` lớn hơn client đã có, nên Realtime mất gói thì client vẫn nhận đủ, chậm hơn tối đa 250ms. Client xếp sự kiện theo `seq` và bỏ bản trùng (`ServerNet.ingest` trong `js/net.js`).
- Hành động của chính mình hiện ngay khi bấm (không chờ server); server từ chối thì hủy trên màn hình. Server tính hành động bắt đầu lúc nhận lệnh, nên với ping 100ms, tay trên màn hình về chỗ cũ sớm hơn server khoảng 50ms.
- Không tick quá 6s ở phòng chờ: bị xóa khỏi phòng. Đang chơi không tick quá 15s: rời trận (gục xuống, không có điểm thưởng). Host là người vào phòng sớm nhất còn kết nối; host chỉ có quyền Start và Back to lobby.
- Luật và thời gian nằm trong bảng `peas.cfg`, khớp `js/rules.js`. Sửa trực tiếp được trong SQL Editor, ví dụ `update peas.cfg set warn = 0.7;`.

Không chặn được: script tự thả F khi thấy cảnh báo (cảnh báo phải gửi cho mọi người).

## Kiến trúc offline

`LocalNet` trong `js/net.js`: host chạy trên chính trình duyệt (vòng pha mafia, bot, xét bắn, tính điểm trong `hostTick` của `js/main.js`).

## Test

```sh
cd tests && npm install
npm run db       # 49 test logic server trên PGlite (Postgres chạy trong Node), điều khiển được thời gian
npm run online   # 4 người chơi (mỗi người một tiến trình Chrome) cùng phòng trên server giả lập (PGlite + REST + WebSocket Realtime), cần python3 serve.py
REAL=1 npm run online   # như trên nhưng với Supabase thật trong js/config.js
```

## File

| File | Nội dung |
|---|---|
| `js/rules.js` | Thời gian xiên/ăn, sức chứa nĩa, tỉ lệ số pea mỗi lần xiên, số pea để thắng, thời gian cảnh báo |
| `supabase/schema.sql` | Server online: bảng, luật, RPC `peas_*` |
| `js/net.js` | `LocalNet` (offline) và `ServerNet` (gọi RPC, nhận sự kiện Realtime, xếp theo `seq`) |
| `js/main.js` | State ván chơi, logic host offline, bot, input, áp dụng sự kiện server, HUD |
| `tests/` | `db.test.mjs` (logic server), `online.test.mjs` + `mock-supabase.mjs` (client nhiều tab) |
| `js/scene.js` | Scene Three.js: phòng kho, bàn, nhân vật, mafia, hiệu ứng bắn |
| `js/textures.js` | Toàn bộ texture vẽ bằng canvas (không có file ảnh) |
| `js/audio.js` | `asset/gunshot.mp3` và `asset/gunreload.mp3` (tự cắt im lặng hai đầu khi load) qua reverb phòng; tiếng xiên pea tổng hợp bằng WebAudio |

## Thay model 3D

Model hiện dựng từ box/sphere/cylinder. Muốn giống ảnh hơn nữa thì thay bằng file `.glb` low-poly (Blender, hoặc Mixamo cho mafia có animation): load bằng `GLTFLoader` trong `Character` và `Mafia` ở `js/scene.js`, giữ nguyên các group `body`, `head`, `fork` (kèm 15 mesh `forkPeas`), `paper`, `gun` vì logic animation điều khiển các group đó.
