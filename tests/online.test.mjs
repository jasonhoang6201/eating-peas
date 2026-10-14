// Test client online end-to-end: nhiều người chơi (mỗi người một tiến trình Chrome) chơi cùng một phòng.
// Mặc định chạy với server giả lập (mock-supabase.mjs: PGlite + REST RPC + WebSocket Realtime),
// có kiểm tra chéo trạng thái từng tab với database. Cần static server: python3 serve.py (cổng 8765).
//
// Chạy: cd tests && npm run online
//       REAL=1 npm run online   -> chạy với Supabase thật trong js/config.js (bỏ các bước cần sửa database)
import puppeteer from 'puppeteer-core';
import { startMock } from './mock-supabase.mjs';

const REAL = !!process.env.REAL;
const SITE = process.env.SITE || 'http://localhost:8765';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOM = REAL ? 'T' + Math.random().toString(36).slice(2, 7).toUpperCase() : 'R1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = REAL ? null : await startMock(8790);
const db = mock?.db;
// nhiều tab render WebGL bằng CPU nên reload một tab có thể mất > 15s: nới seen_play để test không bị loại oan
if (db) await db.query(`update peas.cfg set read_min = 1.5, read_max = 3, fake = 0, seen_play = 60`);
// độ trễ đo được với Supabase thật (region của project): RPC đi-về ~145ms, Realtime server -> client ~80ms
const LATENCY = { drop: 0, delay: [60, 100], rpcDelay: [120, 170] };
if (mock) Object.assign(mock.net, LATENCY);

// Mỗi người chơi một tiến trình Chrome riêng (như mỗi người một máy). Các tab trong cùng một Chrome dùng chung
// một GPU process render WebGL bằng CPU theo lượt: với 5 tab, tải lại một trang mất ~9s thay vì ~1s.
const launch = () => puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
const browsers = [];
const errors = [];
const rejected = [];
const pages = [];

async function open(name) {
  const browser = await launch();
  browsers.push(browser);
  const page = await browser.newPage();
  await page.setViewport({ width: 480, height: 320 });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|GL Driver|WebGL/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
  // HTTP lỗi: favicon không có là bình thường; RPC bị từ chối (400) ghi lại để in ra cuối bài test
  page.on('response', async (r) => {
    if (r.status() < 400 || r.url().endsWith('favicon.ico')) return;
    if (r.url().includes('/rpc/')) rejected.push(`${name} ${r.url().split('/rpc/')[1]}: ${(await r.text().catch(() => '')).slice(0, 80)}`);
    else errors.push(`${name} HTTP ${r.status()} ${r.url()}`);
  });
  if (mock) {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.url().endsWith('/js/config.js')) {
        return req.respond({ contentType: 'text/javascript', body: `export const SUPABASE_URL = '${mock.url}'; export const SUPABASE_ANON_KEY = 'test';` });
      }
      req.continue();
    });
  }
  await page.goto(`${SITE}/?room=${ROOM}`);
  await page.$eval('#name', (e, n) => { e.value = n; }, name);
  await page.click('#btnOnline');
  await page.waitForFunction(() => __G.selfId && __G.phase !== 'boot', { timeout: 15000 });
  const p = { name, page };
  p.id = await page.evaluate(() => __G.selfId);
  pages.push(p);
  return p;
}

const view = (p) => p.page.evaluate(() => ({
  phase: __G.phase, self: __G.selfId, host: __G.hostId, round: __G.match.round, rounds: __G.match.rounds,
  mafia: __G.mafia.phase,
  members: __G.presence.map((m) => m.name),
  players: Object.fromEntries(Object.values(__G.players).map((q) => [q.id, { alive: q.alive, st: q.st, fork: q.fork, peas: q.peas, name: q.name }])),
  start: !document.getElementById('btnStart').hidden,
  wait: !document.getElementById('waitNote').hidden,
  overlay: !document.getElementById('overlay').hidden,
  again: !document.getElementById('btnAgain').hidden,
  waitAgain: !document.getElementById('waitAgain').hidden,
  spectate: document.getElementById('spectate').hidden ? null : document.getElementById('spectate').textContent,
  board: [...document.querySelectorAll('#board tr')].map((r) => [...r.cells].map((c) => c.textContent).join('|')),
  tag: document.getElementById('roundTag').textContent,
}));

const key = (p, type, code) => p.page.evaluate((type, code) => dispatchEvent(new KeyboardEvent(type, { code })), type, code);

// Tự chơi trong tab: giữ F khi mafia đang đọc báo, nĩa đủ `want` pea thì ăn.
// Chỉ bắt đầu hành động trong 1.2s đầu của pha reading: reading dài ít nhất 2.5s × 0.5, nên hành động
// (≤ 0.6s, cộng độ trễ mạng) luôn xong trước cảnh báo. Không có giới hạn này thì một lần ăn bắt đầu
// ngay trước khi cảnh báo tới máy (trong khoảng độ trễ mạng) sẽ bị bắn.
// careless = true: xiên/ăn bất kể mafia đang làm gì, nên sớm muộn cũng bị bắn.
async function autoplay(p, careless = false) {
  await p.page.evaluate((careless) => {
    clearInterval(window.__bot);
    const fire = (type, code) => dispatchEvent(new KeyboardEvent(type, { code }));
    let want = 4 + ((Math.random() * 8) | 0), holding = false;
    window.__bot = setInterval(() => {
      const me = __G.players[__G.selfId];
      if (__G.phase !== 'play' || !me || !me.alive) { if (holding) { fire('keyup', 'KeyF'); holding = false; } return; }
      const safe = careless || (__G.mafia.phase === 'reading' && performance.now() - __G.mafia.at < 1200);
      if (!safe) { if (holding) { fire('keyup', 'KeyF'); holding = false; } return; }
      if (me.fork >= want && me.st === 'idle') {
        if (holding) { fire('keyup', 'KeyF'); holding = false; }
        fire('keydown', 'KeyE'); want = 4 + ((Math.random() * 8) | 0);
      } else if (!holding && me.fork < want) { fire('keydown', 'KeyF'); holding = true; }
    }, 40);
  }, careless);
}
// Người chơi còn sống theo tab đầu tiên còn mở.
async function alive() {
  const v = await view(pages.find((p) => !p.closed));
  return pages.filter((p) => v.players[p.id]?.alive);
}
const stopBot = (p) => p.page.evaluate(() => { clearInterval(window.__bot); dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyF' })); });

// ---------- runner ----------
let passed = 0, failed = 0;
const fails = [];
function ok(c, msg) { if (!c) throw new Error(msg); }
function eq(a, b, msg) { const ja = JSON.stringify(a), jb = JSON.stringify(b); if (ja !== jb) throw new Error(`${msg}: got ${ja}, want ${jb}`); }
async function test(name, fn, { real = true } = {}) {
  if (REAL && !real) { console.log('  skip', name); return; }
  try { await fn(); passed++; console.log('  ok  ', name); }
  catch (e) { failed++; fails.push(name); console.log('  FAIL', name, '\n       ', e.message); }
}
// Chờ mafia vừa bắt đầu đọc báo (chạy chưa tới 0.3s), để hành động 0.6s chắc chắn xong trước cảnh báo.
async function freshReading(p) {
  await until(() => p.page.evaluate(() => __G.mafia.phase === 'reading' && performance.now() - __G.mafia.at < 300), 20000, 'chờ reading');
}
async function until(fn, ms = 10000, msg = 'timeout') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(msg);
    await sleep(100);
  }
}
const dbMembers = async () => Object.fromEntries((await db.query(`select id, alive, st, fork, peas, total from peas.members where room = $1 and seat is not null`, [ROOM])).rows.map((r) => [r.id, r]));

// Mọi tab thấy cùng số pea/nĩa/sống chết của mọi người chơi, và (với mock) khớp database.
// Gọi lúc không ai thao tác ít nhất 1.5s, để mọi hành động đã xong.
async function checkConsistent(label) {
  const views = await Promise.all(pages.filter((p) => !p.closed).map(view));
  const ref = views[0].players;
  for (const v of views) {
    for (const [id, q] of Object.entries(v.players)) {
      eq([q.alive, q.fork, q.peas], [ref[id].alive, ref[id].fork, ref[id].peas], `${label}: tab ${v.self} thấy ${q.name}`);
    }
  }
  if (db) {
    const m = await dbMembers();
    for (const [id, q] of Object.entries(ref)) eq([q.alive, q.fork, q.peas], [m[id].alive, m[id].fork, m[id].peas], `${label}: ${q.name} so với database`);
  }
  return ref;
}

// ---------- kịch bản ----------
let A, B, C, D;

await test('3 tab vào cùng phòng: danh sách giống nhau, người vào đầu là host, chỉ host thấy Start', async () => {
  A = await open('Alice'); await sleep(200);
  B = await open('Bob'); await sleep(200);
  C = await open('Cara');
  await until(async () => (await Promise.all([A, B, C].map(view))).every((v) => v.members.length === 3), 8000, 'members');
  const [va, vb, vc] = await Promise.all([A, B, C].map(view));
  eq(va.members, ['Alice', 'Bob', 'Cara'], 'thứ tự');
  eq([va.host, vb.host, vc.host], [A.id, A.id, A.id], 'host');
  eq([va.start, vb.start, vc.start], [true, false, false], 'nút Start');
  eq([vb.wait, vc.wait], [true, true], 'Waiting for host');
  ok(await A.page.$eval('#fillWrap', (e) => e.hidden), 'online không có bot');
});

await test('người không phải host gọi start bị server từ chối', async () => {
  const err = await B.page.evaluate(() => __G.net.start(2).then(() => null, (e) => e.message));
  ok(err?.includes('Only the host'), err);
});

await test('host bắt đầu 2 trận: mọi tab vào trận, ROUND 1/2, đếm ngược, nút bị khóa trong countdown', async () => {
  await A.page.select('#rounds', '2');
  await A.page.click('#btnStart');
  await until(async () => (await Promise.all([A, B, C].map(view))).every((v) => v.phase === 'play'), 5000, 'start');
  const vs = await Promise.all([A, B, C].map(view));
  for (const v of vs) { eq(v.tag, 'ROUND 1/2', 'tag'); eq(v.mafia, 'countdown', 'mafia'); eq(Object.keys(v.players).length, 3, 'số người'); }
  await key(A, 'keydown', 'KeyF'); await sleep(300); await key(A, 'keyup', 'KeyF');
  eq((await view(A)).players[A.id].st, 'idle', 'không xiên được trong countdown');
  await until(async () => (await view(A)).mafia === 'reading', 5000, 'reading');
});

await test('xiên và ăn: số liệu mọi tab khớp nhau và khớp server', async () => {
  for (const p of [A, B, C]) await autoplay(p);
  await sleep(9000);
  for (const p of [A, B, C]) await stopBot(p);
  await sleep(1500);
  const ref = await checkConsistent('sau 9s');
  const total = Object.values(ref).reduce((s, q) => s + q.peas + q.fork, 0);
  ok(total > 10, `có pea được ăn/xiên (${total})`);
});

await test('gian lận: gửi 20 lệnh poke cùng lúc chỉ được chấp nhận tối đa 2 (1 chạy + 1 xếp hàng)', async () => {
  const [X] = await alive();
  await freshReading(X);
  const r = await X.page.evaluate(() => Promise.all([...Array(20)].map(() => __G.net.act('poke'))));
  const acc = r.filter((x) => x.ok).length;
  ok(acc >= 1 && acc <= 2, `chấp nhận ${acc}`);
  ok(r.filter((x) => !x.ok).every((x) => ['busy', 'locked', 'full'].includes(x.reason)), JSON.stringify(r.map((x) => x.reason)));
});

await test('gian lận: sửa số pea trên trình duyệt không đổi được số liệu của server', async () => {
  await A.page.evaluate(() => { __G.players[__G.selfId].peas = 99; __G.players[__G.selfId].fork = 15; });
  await sleep(1500);
  if (db) {
    const m = await dbMembers();
    ok(m[A.id].peas < 99, `server peas ${m[A.id].peas}`);
  }
  const vb = await view(B);
  ok(vb.players[A.id].peas < 99, 'tab khác không thấy số giả');
  // trả lại số đúng để không ảnh hưởng các test sau
  const q = vb.players[A.id];
  await A.page.evaluate((f, pe) => { __G.players[__G.selfId].peas = pe; __G.players[__G.selfId].fork = f; }, q.fork, q.peas);
}, { real: true });

let V; // người bị bắn trong test này
await test('người cứ xiên khi mafia nhìn lên thì bị bắn; mọi tab thấy người đó chết, số pea khớp server', async () => {
  const live = await alive();
  ok(live.length >= 3, `cần ≥ 3 người sống, còn ${live.length}`);
  V = live.find((p) => p !== A);
  await autoplay(V, true);
  await until(async () => !(await view(A)).players[V.id].alive, 40000, `${V.name} chưa bị bắn`);
  await stopBot(V);
  // chữ hiện sau animation bắn (SHOT_FIRE 1.8s tính theo frame) và REVEAL_MS 1.4s
  await until(async () => (await view(V)).spectate === "You're out.", 15000, "You're out.");
  await sleep(1000);
  const vs = await Promise.all([A, B, C].map(view));
  const r = vs[0].players[V.id];
  for (const v of vs) eq([v.players[V.id].alive, v.players[V.id].peas, v.players[V.id].fork], [false, r.peas, r.fork], 'mọi tab thấy cùng số liệu người chết');
  if (db) {
    const m = (await dbMembers())[V.id];
    eq([m.st, m.peas, m.fork], ['dead', r.peas, r.fork], 'database');
  }
  const err = await V.page.evaluate(() => __G.net.act('poke'));
  eq(err.reason, 'dead', 'người chết gửi lệnh');
});

await test('tab vào giữa trận là khán giả và thấy đúng trạng thái', async () => {
  D = await open('Dan');
  await until(async () => (await view(D)).phase === 'play', 5000, 'D vào trận');
  const v = await view(D);
  eq(v.spectate, 'Spectating', 'khán giả');
  eq(v.players[V.id].alive, false, 'thấy người bị bắn đã chết');
  eq(Object.keys(v.players).length, 3, 'thấy 3 người chơi');
});

await test('tải lại trang giữa trận: vẫn là người chơi cũ, giữ số pea', async () => {
  await sleep(1000);
  const before = (await view(C)).players[C.id];
  const t0 = Date.now();
  await C.page.reload();
  const tLoad = Date.now() - t0;
  await C.page.click('#btnOnline');
  await until(async () => (await view(C)).phase === 'play', 30000, 'C vào lại');
  const ms = Date.now() - t0;
  console.log(`        tải lại ${tLoad}ms, vào lại phòng ${ms - tLoad}ms`);
  ok(ms < 12000, `quá chậm (${ms}ms): server loại người chơi không tick quá 15s`);
  const v = await view(C);
  eq(v.self, C.id, 'cùng id');
  eq([v.players[C.id].alive, v.players[C.id].peas], [before.alive, before.peas], 'giữ trạng thái');
  eq(v.spectate, null, 'không phải khán giả');
});

await test('hết trận: mọi tab hiện cùng bảng điểm, 7s sau tự sang ROUND 2/2 với điểm cộng dồn', async () => {
  if (db) {
    await db.query(`update peas.members set peas = 99, fork = 3 where room = $1 and id = $2`, [ROOM, A.id]);
    await A.page.evaluate(() => { const p = __G.players[__G.selfId]; p.fork = 3; });
    await freshReading(A);
    await key(A, 'keydown', 'KeyE');
  } else {
    // mạng thật: những người còn sống trừ 1 người xiên liều tới khi bị bắn, trận kết thúc vì còn 1 người
    for (const p of (await alive()).slice(1)) await autoplay(p, true);
  }
  await until(async () => (await Promise.all([A, B, C, D].map(view))).every((v) => v.overlay), REAL ? 120000 : 8000, 'bảng điểm');
  for (const p of [A, B, C]) await stopBot(p);
  const boards = (await Promise.all([A, B, C, D].map(view))).map((v) => v.board.map((r) => r.slice(r.indexOf('|'))).join(';'));
  ok(boards.every((b) => b === boards[0]), `bảng điểm khác nhau:\n${boards.join('\n')}`);
  if (db) ok(boards[0].includes('Alice|102|+20|122'), boards[0]);
  await until(async () => (await Promise.all([A, B, C].map(view))).every((v) => v.phase === 'play' && v.tag === 'ROUND 2/2'), 20000, 'round 2');
  // HUD cập nhật ở frame kế tiếp sau sự kiện start
  await until(async () => (await view(V)).spectate === null, 3000, 'người bị bắn ở trận 1 vẫn thấy You\'re out.');
  eq((await view(V)).players[V.id].alive, true, 'người bị bắn ở trận 1 sống lại ở trận 2');
  eq((await view(D)).spectate, 'Spectating', 'D vẫn là khán giả');
});

await test('mạng xấu (mất 40% gói Realtime, trễ 0–400ms, RPC trễ 50–250ms): các tab vẫn khớp nhau và khớp server', async () => {
  Object.assign(mock.net, { drop: 0.4, delay: [0, 400], rpcDelay: [50, 250] });
  for (const p of [A, B, C]) await autoplay(p);
  await sleep(12000);
  for (const p of [A, B, C]) await stopBot(p);
  Object.assign(mock.net, LATENCY);
  await sleep(2000);
  if ((await view(A)).phase === 'play') await checkConsistent('mạng xấu');
}, { real: false });

await test('trận cuối: bảng chung cuộc, chỉ host thấy Back to lobby, bấm thì mọi tab về phòng chờ', async () => {
  if (db && (await view(A)).phase === 'play') {
    const alive = (await view(A)).players;
    const id = Object.keys(alive).find((k) => alive[k].alive);
    const p = pages.find((x) => x.id === id);
    await db.query(`update peas.members set peas = 99, fork = 3 where room = $1 and id = $2`, [ROOM, id]);
    await p.page.evaluate(() => { __G.players[__G.selfId].fork = 3; });
    await freshReading(p);
    await key(p, 'keydown', 'KeyE');
  } else if (!db) for (const p of (await alive()).slice(1)) await autoplay(p, true);
  await until(async () => (await Promise.all([A, B, C, D].map(view))).every((v) => v.overlay), REAL ? 120000 : 10000, 'bảng chung cuộc');
  for (const p of [A, B, C]) await stopBot(p);
  const vs = await Promise.all([A, B, C, D].map(view));
  eq(vs.map((v) => v.again), [true, false, false, false], 'Back to lobby');
  eq(vs.slice(1).map((v) => v.waitAgain), [true, true, true], 'Waiting for host');
  await sleep(8000);
  eq((await view(A)).overlay, true, 'trận cuối không tự sang trận mới');
  await A.page.click('#btnAgain');
  await until(async () => (await Promise.all([A, B, C, D].map(view))).every((v) => v.phase === 'lobby'), 5000, 'về lobby');
  eq((await view(B)).members.length, 4, '4 người trong phòng chờ');
});

await test('host đóng tab ở phòng chờ: người vào kế tiếp thành host và thấy nút Start', async () => {
  await A.page.close(); A.closed = true;
  await until(async () => (await view(B)).host === B.id, 12000, 'host mới');
  const v = await view(B);
  ok(v.start, 'B thấy Start');
  eq(v.members, ['Bob', 'Cara', 'Dan'], 'danh sách');
});

await test('không có lỗi JavaScript trên mọi tab', async () => {
  eq(errors, [], 'errors');
});

console.log(`\n${passed} passed, ${failed} failed${REAL ? ' (Supabase thật)' : ' (mock)'}`);
if (mock) console.log('RPC calls:', mock.net.calls);
console.log('RPC bị từ chối (400):', rejected);
if (failed) console.log('Failed:', fails.join(' | '));
await Promise.all(browsers.map((b) => b.close()));
await mock?.close();
process.exit(failed ? 1 : 0);
