// Test logic server (supabase/schema.sql) trên PGlite: Postgres chạy trong Node, không cần Supabase.
// Thời gian điều khiển bằng setting peas.now (peas.now() đọc setting này khi không chạy qua API).
// realtime.send được thay bằng hàm ghi vào bảng realtime.sent.
//
// Chạy: cd tests && npm install && npm run db
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
const STUB = `
  create role anon; create role authenticated; create role authenticator;
  create schema realtime;
  create table realtime.sent (id serial primary key, payload jsonb, event text, topic text, private boolean);
  create function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
    language sql as $$ insert into realtime.sent (payload, event, topic, private) values (payload, event, topic, private) $$;
`;

let db, T0, clock;
const sec = (s) => new Date(T0 + Math.round(s * 1000)).toISOString();

async function fresh(cfg = {}) {
  offline.clear();
  db = new PGlite();
  await db.exec(STUB);
  await db.exec(schema);
  T0 = Date.parse('2026-01-01T00:00:00Z');
  await setClock(0);
  // mặc định cho test: thời lượng cố định, không rung báo giả, không nhìn luôn
  await setCfg({ instant: 0, fake: 0, read_min: 5, read_max: 5, watch_min: 2, watch_max: 2, ...cfg });
}
async function setClock(s) { clock = Math.round(s * 1000) / 1000; await db.query(`select set_config('peas.now', $1, false)`, [sec(s)]); }
// Mặc định mọi người chơi đều còn kết nối: mỗi lần tua đồng hồ, seen_at của mọi người được cập nhật
// (giống client tick đều đặn) nhưng không gọi peas.advance. Người trong `offline` thì không được cập nhật.
const offline = new Set();
async function wait(s) {
  await setClock(clock + s);
  await db.query(`update peas.members set seen_at = $1 where seen_at > $1::timestamptz - interval '1 hour' and not (id = any($2))`, [sec(clock), [...offline]]);
}
async function setCfg(o) {
  for (const [k, v] of Object.entries(o)) await db.query(`update peas.cfg set ${k} = $1`, [v]);
}
async function rpc(fn, ...args) {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await db.query(`select public.${fn}(${ph}) as r`, args);
  return rows[0].r;
}
async function rpcErr(fn, ...args) {
  try { await rpc(fn, ...args); } catch (e) { return e.message; }
  return null;
}
const one = async (q, a = []) => (await db.query(q, a)).rows[0];
const all = async (q, a = []) => (await db.query(q, a)).rows;
const room = (code = 'R1') => one(`select * from peas.rooms where code = $1`, [code]);
const mem = (id, code = 'R1') => one(`select * from peas.members where room = $1 and id = $2`, [code, id]);
const events = (code = 'R1', since = 0) => all(`select seq, type, data from peas.events where room = $1 and seq > $2 order by seq`, [code, since]).then((r) => r.map((e) => ({ seq: Number(e.seq), type: e.type, data: e.data })));
const lastSeq = async (code = 'R1') => Number((await room(code)).seq);

const SECRETS = [...Array(10)].map((_, i) => `secret${i}`.padEnd(24, 'x'));
const pid = async (secret) => (await one(`select peas.pid($1) as id`, [secret])).id;

// Người chơi i: join/act/tick bằng secret thứ i.
const P = (i, code = 'R1') => ({
  secret: SECRETS[i],
  join: (name = `P${i}`) => rpc('peas_join', code, SECRETS[i], name),
  act: (k) => rpc('peas_act', code, SECRETS[i], k),
  tick: (since = 0) => rpc('peas_tick', code, SECRETS[i], since),
  start: (n = 1) => rpc('peas_start', code, SECRETS[i], n),
  lobby: () => rpc('peas_lobby', code, SECRETS[i]),
  id: () => pid(SECRETS[i]),
});

// Vào phòng n người (mỗi người cách nhau 0.01s để thứ tự vào phòng cố định), host bắt đầu, qua hết countdown.
async function setup(n = 2, rounds = 1, cfg = {}) {
  await fresh(cfg);
  const ps = [...Array(n)].map((_, i) => P(i));
  for (const p of ps) { await p.join(); await wait(0.01); }
  await ps[0].start(rounds);
  await wait(3);
  await ps[0].tick();
  return ps;
}

// ---------- mini test runner ----------
let passed = 0, failed = 0;
const fails = [];
// so sánh giá trị JSON, không phụ thuộc thứ tự key (jsonb trả key theo thứ tự riêng)
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
function eq(a, b, msg) {
  const ja = canon(a), jb = canon(b);
  if (ja !== jb) throw new Error(`${msg ?? 'eq'}: got ${ja}, want ${jb}`);
}
function ok(c, msg) { if (!c) throw new Error(msg ?? 'assert'); }
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ', name); }
  catch (e) { failed++; fails.push(name); console.log('  FAIL', name, '\n       ', e.message); }
}

// ---------- phòng, người chơi, host ----------

await test('join tạo phòng, trả snapshot lobby, host là người vào đầu tiên', async () => {
  await fresh();
  const s = await P(0).join('Alice');
  eq(s.status, 'lobby'); eq(s.self, await P(0).id()); eq(s.host, s.self);
  eq(s.members.map((m) => m.name), ['Alice']);
  await wait(0.1);
  const s2 = await P(1).join('Bob');
  eq(s2.host, s.self, 'host vẫn là người vào trước');
  eq(s2.members.map((m) => m.name), ['Alice', 'Bob']);
  const ev = (await events()).filter((e) => e.type === 'members');
  eq(ev.length, 2, 'mỗi lần danh sách đổi gửi 1 sự kiện members');
  eq(ev[1].data.list.length, 2);
});

await test('join lại với cùng secret không tạo người mới và không gửi members thừa', async () => {
  await fresh();
  await P(0).join('Alice'); await wait(1);
  const n = await lastSeq();
  const s = await P(0).join('Alice');
  eq(s.members.length, 1);
  eq(await lastSeq(), n, 'không có sự kiện mới');
});

await test('tên: cắt 12 ký tự, bỏ ký tự điều khiển và < >, rỗng thành Guest', async () => {
  await fresh();
  eq((await P(0).join('<b>Very\nLongNameHere123</b>')).members[0].name, 'bVeryLongNam');
  eq((await P(1).join('   ')).members[1].name, 'Guest');
});

await test('mã phòng sai định dạng và secret sai định dạng bị từ chối', async () => {
  await fresh();
  ok((await rpcErr('peas_join', 'ab', SECRETS[0], 'x'))?.includes('Bad room code'));
  ok((await rpcErr('peas_join', 'TOOLONGCODE', SECRETS[0], 'x'))?.includes('Bad room code'));
  ok((await rpcErr('peas_join', 'R1', 'short', 'x'))?.includes('Bad session'));
  ok((await rpcErr('peas_join', 'R1', "x'; drop table peas.rooms;--xxxxxx", 'x'))?.includes('Bad session'));
});

await test('phòng đầy (max_members) từ chối người mới, người cũ vẫn vào lại được', async () => {
  await fresh();
  await setCfg({ max_members: 2 });
  await P(0).join(); await P(1).join();
  ok((await rpcErr('peas_join', 'R1', SECRETS[2], 'x'))?.includes('Room is full'));
  eq((await P(1).join()).members.length, 2);
});

await test('mất kết nối ở phòng chờ quá seen_lobby giây thì bị xóa, host chuyển cho người kế tiếp', async () => {
  await fresh();
  const [a, b] = [P(0), P(1)];
  await a.join(); await wait(0.1); await b.join();
  offline.add(await a.id());
  for (let i = 0; i < 7; i++) { await wait(1); await b.tick(); }
  const s = await b.tick(0);
  const last = (await events()).filter((e) => e.type === 'members').at(-1);
  eq(last.data.list.map((m) => m.id), [await b.id()]);
  eq(last.data.host, await b.id());
  eq(await mem(await a.id()), undefined, 'a bị xóa');
  ok(s.events, 'tick trả events');
});

await test('tick của người không còn trong phòng trả gone; phòng không tồn tại cũng gone', async () => {
  await fresh();
  await P(0).join();
  eq(await P(1).tick(), { gone: true });
  eq(await rpc('peas_tick', 'NOPE', SECRETS[0], 0), { gone: true });
});

await test('phòng không ai đụng tới quá 1 giờ bị xóa khi có người join phòng khác', async () => {
  await fresh();
  await P(0, 'OLD').join();
  await wait(3601);
  await P(1, 'NEW').join();
  eq(await room('OLD'), undefined);
  ok(await room('NEW'));
});

// ---------- bắt đầu trận ----------

await test('start: chỉ host, cần ≥ 2 người, không start khi đang chơi', async () => {
  await fresh();
  await P(0).join();
  ok((await rpcErr('peas_start', 'R1', SECRETS[0], 1))?.includes('Need at least 2'));
  await wait(0.1); await P(1).join();
  ok((await rpcErr('peas_start', 'R1', SECRETS[1], 1))?.includes('Only the host'));
  eq(await P(0).start(3), { ok: true });
  ok((await rpcErr('peas_start', 'R1', SECRETS[0], 1))?.includes('Already playing'));
  const r = await room();
  eq([r.status, r.round, r.rounds, r.phase], ['play', 1, 3, 'countdown']);
});

await test('start: số trận kẹp vào 1..rounds_max', async () => {
  await fresh();
  await P(0).join(); await P(1).join();
  await P(0).start(99);
  eq((await room()).rounds, 5);
});

await test('start: 8 người thì 6 người vào sớm nhất được ngồi ghế 0..5, 2 người còn lại là khán giả', async () => {
  await fresh();
  for (let i = 0; i < 8; i++) { await P(i).join(); await wait(0.01); }
  await P(0).start(1);
  const ms = await all(`select id, seat from peas.members order by joined_at`);
  eq(ms.slice(0, 6).map((m) => m.seat).sort(), [0, 1, 2, 3, 4, 5]);
  eq(ms.slice(6).map((m) => m.seat), [null, null]);
  const st = (await events()).find((e) => e.type === 'start');
  eq(st.data.players.length, 6);
  eq(st.data.round, 1);
  eq(await P(7).act('poke').then((r) => r.reason), 'spectator');
});

await test('countdown: khóa hành động 3 giây, sau đó đọc báo', async () => {
  await fresh();
  await P(0).join(); await P(1).join();
  await P(0).start(1);
  eq((await P(0).act('poke')).reason, 'locked');
  await wait(2.99); eq((await P(0).act('poke')).reason, 'locked');
  await wait(0.02);
  const r = await P(0).act('poke');
  eq(r.ok, true);
  eq((await room()).phase, 'reading');
});

// ---------- xiên, ăn ----------

await test('poke: mất 0.4s, thêm 1–2 pea lên nĩa đúng như gain trả về', async () => {
  const [a] = await setup();
  const r = await a.act('poke');
  ok(r.gain === 1 || r.gain === 2, 'gain 1..2');
  eq(r.fork, r.gain); eq(r.in, 0);
  const id = await a.id();
  eq((await mem(id)).fork, 0, 'chưa xong thì chưa cộng');
  await wait(0.39); await a.tick(); eq((await mem(id)).fork, 0);
  await wait(0.01); await a.tick(); eq((await mem(id)).fork, r.gain);
  eq((await mem(id)).st, 'idle');
});

await test('poke khi đang bận (còn > queue_ahead giây) bị từ chối busy', async () => {
  const [a] = await setup();
  await a.act('poke');
  await wait(0.1);
  const r = await a.act('poke');
  eq([r.ok, r.reason], [false, 'busy']);
});

await test('poke tới sớm ≤ queue_ahead giây: xếp hàng, bắt đầu đúng lúc lần trước xong, chỉ 1 lệnh trong hàng', async () => {
  const [a] = await setup();
  const r1 = await a.act('poke');
  await wait(0.2);
  const r2 = await a.act('poke');
  eq(r2.ok, true); ok(Math.abs(r2.in - 0.2) < 1e-6, `in = ${r2.in}`);
  eq(r2.fork, r1.gain + r2.gain);
  eq((await a.act('poke')).reason, 'busy', 'hàng chỉ giữ 1 lệnh');
  const id = await a.id();
  await wait(0.2); await a.tick();
  const m = await mem(id);
  eq([m.st, m.fork], ['poking', r1.gain], 'lần 2 đang chạy');
  await wait(0.4); await a.tick();
  eq((await mem(id)).fork, r1.gain + r2.gain);
  eq((await mem(id)).st, 'idle');
});

await test('xếp hàng eat sau poke: ăn cả pea của lần poke đang chạy', async () => {
  const [a] = await setup();
  const r1 = await a.act('poke');
  await wait(0.3);
  const r2 = await a.act('eat');
  eq(r2.ok, true); eq(r2.peas, r1.gain); eq(r2.fork, 0);
  await wait(0.8); await a.tick();
  const m = await mem(await a.id());
  eq([m.fork, m.peas, m.st], [0, r1.gain, 'idle']);
});

await test('eat khi nĩa trống: nothing; eat chuyển hết pea trên nĩa vào peas sau 0.6s', async () => {
  const [a] = await setup();
  eq((await a.act('eat')).reason, 'nothing');
  let fork = 0;
  for (let i = 0; i < 3; i++) { fork += (await a.act('poke')).gain; await wait(0.4); }
  const r = await a.act('eat');
  eq([r.fork, r.peas], [0, fork]);
  await wait(0.59); await a.tick();
  eq((await mem(await a.id())).peas, 0);
  await wait(0.01); await a.tick();
  eq((await mem(await a.id())).peas, fork);
});

await test('nĩa đầy fork_max: poke bị từ chối full, gain không vượt quá chỗ còn trống', async () => {
  const [a] = await setup();
  const id = await a.id();
  await db.query(`update peas.members set fork = 14 where id = $1`, [id]);
  const r = await a.act('poke');
  eq(r.gain, 1, 'còn 1 chỗ');
  await wait(0.4);
  eq((await a.act('poke')).reason, 'full');
  eq((await mem(id)).fork, 15);
});

await test('đĩa hết pea: poke bị từ chối empty, gain không vượt số pea còn trên đĩa', async () => {
  const [a] = await setup(2, 1, { win: 999 });
  const id = await a.id();
  await db.query(`update peas.members set peas = 83, fork = 0 where id = $1`, [id]);
  eq((await a.act('poke')).gain, 1);
  await wait(0.4);
  eq((await a.act('poke')).reason, 'empty');
});

await test('lệnh không hợp lệ (kind lạ) bị lỗi', async () => {
  await setup();
  ok((await rpcErr('peas_act', 'R1', SECRETS[0], 'teleport'))?.includes('Bad action'));
});

await test('người đã chết không hành động được', async () => {
  const [a, b] = await setup(3);
  await wait(5); await b.tick(); await wait(0.6); await b.tick();
  await a.act('poke'); // bị bắn ngay vì đang watching
  await wait(3.9); await b.tick();
  eq((await room()).phase, 'reading');
  eq((await a.act('poke')).reason, 'dead');
});

// ---------- mafia ----------

await test('pha reading -> warning bắt đầu lúc được xử lý, không phải lúc hết hạn; warning gửi dur', async () => {
  const [a] = await setup();
  await wait(5.3); // reading 5s, quá hạn 0.3s
  await a.tick();
  const r = await room();
  eq(r.phase, 'warning');
  eq(new Date(r.phase_at).toISOString(), sec(clock), 'phase_at = lúc xử lý');
  const w = (await events()).filter((e) => e.type === 'mafia').at(-1);
  eq(w.data, { phase: 'warning', el: 0, dur: 0.6 });
});

await test('không sự kiện hay snapshot nào để lộ thời lượng reading/watching/raising', async () => {
  const [a, b] = await setup(2, 1, { read_min: 2, read_max: 9, fake: 0.5 });
  for (let i = 0; i < 300; i++) { await wait(0.1); await a.tick(); if (i % 25 === 0) await b.tick(0); }
  const ms = (await events()).filter((e) => e.type === 'mafia');
  ok(ms.length > 10, `có ${ms.length} lần đổi pha`);
  for (const e of ms) {
    if (['reading', 'watching', 'raising'].includes(e.data.phase)) eq(e.data.dur, null, `dur của ${e.data.phase}`);
  }
  const s = (await b.tick(-5)).snapshot ?? (await rpc('peas_join', 'R1', SECRETS[1], 'P1'));
  if (s.mafia.phase !== 'countdown' && s.mafia.phase !== 'warning') eq(s.mafia.dur, null);
  ok(!JSON.stringify(s).includes('phase_end'));
});

await test('watching: người đang xiên lúc mafia nhìn lên bị bắn, người ngồi im không bị', async () => {
  const [a, b] = await setup(3);
  await wait(5); await a.tick();               // warning tại t
  await wait(0.5); await a.act('poke');        // a xiên lúc t+0.5, kéo dài qua t+0.6
  await wait(0.1); await b.tick();             // t+0.6: watching
  const id = await a.id();
  const m = await mem(id);
  eq([m.alive, m.st], [false, 'dead']);
  const ev = (await events()).map((e) => e.type);
  ok(ev.includes('shot'));
  eq((await events()).find((e) => e.type === 'shot').data.id, id);
  eq((await room()).phase, 'raising');
  eq((await mem(await b.id())).alive, true);
});

await test('hành động kết thúc đúng lúc mafia nhìn lên thì không bị bắn', async () => {
  const [a, b] = await setup(3);
  await wait(5); await a.tick();               // warning tại t, watching tại t+0.6
  await wait(0.2); await a.act('poke');        // xiên [t+0.2, t+0.6)
  await wait(1); await b.tick();               // tick trễ: xử lý lười tới t+1.2
  eq((await mem(await a.id())).alive, true);
  ok(!(await events()).some((e) => e.type === 'shot'));
});

await test('hành động xếp hàng kéo dài qua lúc mafia nhìn lên thì bị bắn', async () => {
  const [a, b] = await setup(3);
  await wait(5); await a.tick();               // warning t
  await wait(0.0); await a.act('poke');        // [t, t+0.4)
  await wait(0.2); await a.act('poke');        // xếp hàng [t+0.4, t+0.8)
  await wait(1); await b.tick();               // watching t+0.6 lúc lệnh 2 đang chạy
  eq((await mem(await a.id())).alive, false);
});

await test('tick trễ nhiều giây: các mốc xử lý theo đúng thứ tự thời gian, kết quả như tick đều', async () => {
  const [a, b] = await setup(3);
  await wait(5); await a.tick();               // warning t
  await wait(0.5); await a.act('poke');        // a dính lúc t+0.6
  await wait(20); await b.tick();              // không ai tick suốt 20s
  const ev = (await events()).map((e) => e.type + (e.data.phase ? ':' + e.data.phase : ''));
  const i = ev.indexOf('mafia:watching');
  eq(ev.slice(i, i + 3), ['mafia:watching', 'shot', 'mafia:raising']);
  ok(ev.slice(i + 3).includes('mafia:reading'), 'đọc báo lại sau khi bắn');
  const seqs = (await events()).map((e) => e.seq);
  eq(seqs, seqs.map((_, k) => k + 1), 'seq liên tục từ 1');
});

await test('bắt đầu hành động trong pha watching thì bị bắn ngay, sau đó raising khóa người khác', async () => {
  const [a, b, c] = await setup(3);
  await wait(5); await a.tick(); await wait(0.6); await a.tick();
  eq((await room()).phase, 'watching');
  const r = await b.act('poke');
  eq(r.ok, true);
  eq((await mem(await b.id())).alive, false);
  eq((await room()).phase, 'raising');
  eq((await c.act('poke')).reason, 'locked');
  await wait(3.9); await a.tick();
  eq((await room()).phase, 'reading');
  eq((await c.act('poke')).ok, true);
});

await test('bị bắn giữa lúc ăn: pea trên nĩa không được cộng, sự kiện shot gửi fork/peas của server', async () => {
  const [a, b] = await setup(3);
  const ia = await a.id();
  await db.query(`update peas.members set fork = 7, peas = 20 where id = $1`, [ia]);
  await wait(5); await b.tick();
  await wait(0.3); await a.act('eat');          // ăn [t+0.3, t+0.9) qua lúc nhìn lên t+0.6
  await wait(1); await b.tick();
  const m = await mem(ia);
  eq([m.alive, m.fork, m.peas], [false, 7, 20]);
  eq((await events()).find((e) => e.type === 'shot').data, { id: ia, fork: 7, peas: 20 });
});

await test('nhiều người cùng dính: chỉ bắn đúng 1 người mỗi lần mafia nhìn lên', async () => {
  for (let k = 0; k < 5; k++) {
    const ps = await setup(4);
    await wait(5); await ps[0].tick();
    await wait(0.5);
    for (const p of ps.slice(0, 3)) await p.act('poke');
    await wait(0.2); await ps[3].tick();
    eq((await events()).filter((e) => e.type === 'shot').length, 1);
    eq((await all(`select count(*)::int n from peas.members where not alive`))[0].n, 1);
  }
});

await test('không ai dính: watching -> raising (look_down) -> reading', async () => {
  const [a] = await setup();
  await wait(5); await a.tick(); await wait(0.6); await a.tick();
  await wait(2); await a.tick();
  eq((await room()).phase, 'raising');
  await wait(0.4); await a.tick();
  eq((await room()).phase, 'reading');
});

await test('rung báo giả (fake = 1): warning -> reading, không bắn ai dù đang xiên', async () => {
  const [a] = await setup(2, 1, { fake: 1 });
  await wait(5); await a.tick();
  await wait(0.5); await a.act('poke');
  await wait(0.2); await a.tick();
  eq((await room()).phase, 'reading');
  eq((await mem(await a.id())).alive, true);
});

await test('nhìn luôn (instant = 1): reading -> watching tại lúc reading hết hạn, không warning, bắn người đang xiên', async () => {
  const [a, b] = await setup(2, 1, { instant: 1 });
  const read = await room();
  await wait(4.8); await a.act('poke');        // reading hết hạn ở giây 5, lần xiên còn chạy tới 5.2
  await wait(0.3); await b.tick();
  const r = await room();
  eq(r.phase, 'raising');
  eq(+new Date(r.phase_at), +new Date(read.phase_end), 'bắn tại lúc reading hết hạn');
  ok(!(await events()).some((e) => e.type === 'mafia' && e.data.phase === 'warning'));
  eq([(await mem(await a.id())).alive, (await mem(await b.id())).alive], [false, true]);
});

await test('mafia đọc báo nhanh dần: sau speed_span giây, thời lượng reading còn một nửa', async () => {
  const [a] = await setup(2, 1, { read_min: 4, read_max: 4, speed_span: 10, watch_min: 0.5, watch_max: 0.5, look_down: 0.1 });
  const reads = [];
  for (let i = 0; i < 400; i++) {
    await wait(0.05); await a.tick();
    const r = await room();
    if (r.phase === 'reading' && !reads.some((x) => x.at === +new Date(r.phase_at))) reads.push({ at: +new Date(r.phase_at), d: (new Date(r.phase_end) - new Date(r.phase_at)) / 1000 });
  }
  // reading đầu tiên bắt đầu lúc hết countdown (giây 3): 4 × (1 - 3/10) = 2.8
  ok(Math.abs(reads[0].d - 2.8) < 1e-6, `đầu trận ${reads[0].d}`);
  ok(Math.abs(reads.at(-1).d - 2) < 1e-6, `cuối ${reads.at(-1).d}`);
});

// ---------- kết thúc trận, điểm ----------

async function feed(id, peas) { await db.query(`update peas.members set peas = $2 where id = $1`, [id, peas]); }

await test('ăn đủ 70 pea: ending, chặn hành động, end_peas giây sau gửi end với điểm đúng', async () => {
  const [a, b, c] = await setup(3);
  const [ia, ib, ic] = [await a.id(), await b.id(), await c.id()];
  await feed(ia, 65); await feed(ib, 30);
  await db.query(`update peas.members set fork = 6 where id = $1`, [ia]);
  await a.act('eat');
  await wait(0.6); await b.tick();
  const r = await room();
  eq(r.status, 'ending');
  eq((await b.act('poke')).reason, 'not_playing');
  ok(!(await events()).some((e) => e.type === 'end'));
  await wait(1.2); await b.tick();
  const end = (await events()).find((e) => e.type === 'end').data;
  eq([end.winner, end.reason], [ia, 'peas']);
  eq(end.scores[ia], { peas: 71, bonus: 20, total: 91 });
  eq(end.scores[ib], { peas: 30, bonus: 15, total: 45 });
  eq(end.scores[ic], { peas: 0, bonus: 0, total: 0 });
  eq((await room()).status, 'over');
});

await test('còn 1 người sống: reason last, người chết không có thưởng', async () => {
  const [a, b] = await setup(2);
  const [ia, ib] = [await a.id(), await b.id()];
  await feed(ia, 40); await feed(ib, 50);
  await wait(5); await a.tick(); await wait(0.5); await b.act('poke'); await wait(0.1); await a.tick();
  eq((await room()).status, 'ending');
  await wait(4.2); await a.tick();
  const end = (await events()).find((e) => e.type === 'end').data;
  eq([end.winner, end.reason], [ia, 'last']);
  eq(end.scores[ib], { peas: 50, bonus: 0, total: 50 });
  eq(end.scores[ia], { peas: 40, bonus: 20, total: 60 });
});

await test('nhiều trận: bảng điểm board giây rồi tự sang trận sau, điểm cộng dồn, trận cuối không có next', async () => {
  const [a, b] = await setup(2, 2);
  const ia = await a.id();
  await feed(ia, 70); await db.query(`update peas.members set fork = 1 where id = $1`, [ia]);
  await a.act('eat'); await wait(0.6); await a.tick(); await wait(1.2); await a.tick();
  const r1 = await room();
  eq(r1.status, 'over'); ok(r1.next_at);
  await wait(6.9); await b.tick(); eq((await room()).status, 'over');
  await wait(0.1); await b.tick();
  const r2 = await room();
  eq([r2.status, r2.round, r2.phase], ['play', 2, 'countdown']);
  const st = (await events()).filter((e) => e.type === 'start').at(-1).data;
  eq(st.round, 2); eq(st.total[ia], 91);
  const m = await mem(ia);
  eq([m.peas, m.fork, m.alive, m.st], [0, 0, true, 'idle']);
  // trận 2 (cuối)
  await wait(3); await a.tick();
  await feed(ia, 70); await db.query(`update peas.members set fork = 2 where id = $1`, [ia]);
  await a.act('eat'); await wait(0.6); await a.tick(); await wait(1.2); await a.tick();
  const r3 = await room();
  eq([r3.status, r3.next_at], ['over', null]);
  eq((await events()).filter((e) => e.type === 'end').at(-1).data.scores[ia].total, 91 + 92);
  await wait(60); await a.tick(); await b.tick();
  eq((await room()).status, 'over', 'trận cuối giữ bảng điểm');
});

await test('peas_lobby: chỉ host, chỉ sau trận cuối; về phòng chờ xóa ghế và trạng thái trận', async () => {
  const [a, b] = await setup(2, 1);
  ok((await rpcErr('peas_lobby', 'R1', SECRETS[0]))?.includes('not finished'));
  await feed(await a.id(), 70); await db.query(`update peas.members set fork = 1`);
  await a.act('eat'); await wait(0.6); await a.tick(); await wait(1.2); await a.tick();
  ok((await rpcErr('peas_lobby', 'R1', SECRETS[1]))?.includes('Only the host'));
  eq(await a.lobby(), { ok: true });
  eq((await room()).status, 'lobby');
  eq((await all(`select count(*)::int n from peas.members where seat is not null or peas > 0 or alive`))[0].n, 0);
  eq((await events()).at(-1).type, 'lobby');
  eq(await a.start(1), { ok: true }, 'chơi lại được');
  eq((await events()).filter((e) => e.type === 'start').at(-1).data.total[await a.id()], 0, 'điểm cộng dồn reset');
});

// ---------- mất kết nối, vào giữa trận ----------

await test('người chơi mất kết nối quá seen_play giây: left, trận còn 1 người thì kết thúc', async () => {
  const [a, b] = await setup(2);
  offline.add(await b.id());
  for (let i = 0; i < 16; i++) { await wait(1); await a.tick(); }
  const ev = await events();
  eq(ev.find((e) => e.type === 'left').data.id, await b.id());
  eq((await mem(await b.id())).st, 'left');
  eq((await room()).status, 'ending');
});

await test('người rời trận được vào lại: tick lại trả state, trận sau được ngồi lại', async () => {
  const [a, b, c] = await setup(3, 2);
  const ib = await b.id();
  offline.add(ib);
  for (let i = 0; i < 16; i++) { await wait(1); await a.tick(); await c.tick(); }
  eq((await mem(ib)).st, 'left');
  offline.delete(ib);
  const s = await b.join();
  eq(s.status, 'play');
  eq(s.players.find((p) => p.id === ib).st, 'dead');
  // a ăn đủ -> trận 2: b còn kết nối nên có ghế
  await feed(await a.id(), 70); await db.query(`update peas.members set fork = 1 where id = $1`, [await a.id()]);
  await a.act('eat');
  for (let i = 0; i < 12; i++) { await wait(1); await a.tick(); await b.tick(); await c.tick(); }
  const st = (await events()).filter((e) => e.type === 'start').at(-1).data;
  eq(st.round, 2);
  ok(st.players.some((p) => p.id === ib));
});

await test('vào giữa trận: là khán giả, snapshot có người chơi, pha mafia, không có ghế', async () => {
  const [a, b] = await setup(2);
  await a.act('poke');
  await wait(0.1);
  const s = await P(5).join('Late');
  eq(s.status, 'play');
  eq(s.players.length, 2);
  ok(!s.players.some((p) => p.id === s.self));
  const pa = s.players.find((p) => p.id === (/* a */ s.players[0].id));
  ok(pa);
  eq(s.mafia.phase, 'reading'); eq(s.mafia.dur, null);
  eq((await P(5).act('poke')).reason, 'spectator');
});

await test('refresh trang (join lại cùng secret) giữa trận: vẫn là người chơi đó, giữ pea', async () => {
  const [a, b] = await setup(2);
  const r = await a.act('poke'); await wait(0.4); await a.tick();
  const s = await a.join('NewName');
  const me = s.players.find((p) => p.id === s.self);
  eq([me.fork, me.alive], [r.gain, true]);
  eq(me.name, 'P0', 'không đổi tên giữa trận');
  eq((await a.act('poke')).ok, true);
});

await test('2 người chơi, 1 người rời giữa bảng điểm: trận sau còn < 2 người thì về phòng chờ', async () => {
  const [a, b] = await setup(2, 3);
  await feed(await a.id(), 70); await db.query(`update peas.members set fork = 1 where id = $1`, [await a.id()]);
  await a.act('eat'); await wait(0.6); await a.tick(); await wait(1.2); await a.tick();
  eq((await room()).status, 'over');
  offline.add(await b.id());
  await wait(16); await a.tick(); // tới lúc sang trận sau, b đã mất kết nối > seen_play giây
  eq((await room()).status, 'lobby');
  eq((await events()).at(-2).type === 'lobby' || (await events()).at(-1).type === 'lobby', true);
});

// ---------- tick, snapshot, sự kiện ----------

await test('tick(since) trả đúng các sự kiện sau since; since quá cũ/không hợp lệ thì trả snapshot', async () => {
  const [a] = await setup();
  const n = await lastSeq();
  await a.act('poke');
  const t = await a.tick(n);
  eq(t.events.map((e) => e.type), ['act']);
  eq(t.seq, n + 1);
  ok((await a.tick(n + 50)).snapshot, 'since > seq');
  ok((await a.tick(null)).snapshot, 'since null');
  await db.query(`delete from peas.events where seq <= 3`);
  ok((await a.tick(1)).snapshot, 'sự kiện đã bị dọn');
  eq((await a.tick(n)).events.length, 1, 'since mới vẫn trả events');
});

await test('mọi sự kiện cũng được gửi qua realtime.send với topic peas:<mã>, public, đúng seq', async () => {
  await setup();
  const sent = await all(`select payload, event, topic, private from realtime.sent order by id`);
  const ev = await events();
  eq(sent.length, ev.length);
  eq(sent.map((s) => s.payload.seq), ev.map((e) => e.seq));
  ok(sent.every((s) => s.topic === 'peas:R1' && s.event === 'ev' && s.private === false));
});

await test('sự kiện act gửi kết quả sau khi xong, không có secret', async () => {
  const [a] = await setup();
  const r = await a.act('poke');
  const e = (await events()).at(-1);
  eq(e.type, 'act');
  eq(e.data, { id: await a.id(), st: 'poking', in: 0, dur: 0.4, fork: r.fork, peas: 0 });
  ok(!JSON.stringify(await events()).includes(SECRETS[0]));
});

// ---------- quyền truy cập ----------

await test('role anon không đọc/sửa được bảng peas, không gọi được hàm nội bộ, chỉ gọi được peas_*', async () => {
  await setup();
  await db.exec(`set role anon`);
  const deny = async (q) => { try { await db.query(q); return 'allowed'; } catch (e) { return e.message; } };
  ok((await deny(`select * from peas.members`)).includes('permission denied'));
  ok((await deny(`update peas.members set peas = 100`)).includes('permission denied'));
  ok((await deny(`select peas.advance('R1', now())`)).includes('permission denied'));
  ok((await deny(`select peas.shoot('R1', 'x', now(), now())`)).includes('permission denied'));
  const r = await db.query(`select public.peas_tick('R1', $1, 0) as r`, [SECRETS[0]]);
  ok(r.rows[0].r.events, 'peas_tick gọi được');
  await db.exec(`reset role`);
});

await test('chạy lại schema.sql trên database đã có dữ liệu không lỗi', async () => {
  await setup();
  await db.exec(schema);
  eq((await all(`select count(*)::int n from peas.rooms`))[0].n, 0);
});

// ---------- mô phỏng ngẫu nhiên: bất biến ----------

await test('mô phỏng 30 trận ngẫu nhiên: các bất biến luôn đúng', async () => {
  for (let g = 0; g < 30; g++) {
    const n = 2 + (g % 5);
    const ps = await setup(n, 1, { instant: 0.3, fake: 0.25, read_min: 1, read_max: 4 });
    const ids = await Promise.all(ps.map((p) => p.id()));
    let steps = 0;
    while ((await room()).status === 'play' && steps < 4000) {
      steps++;
      await wait(0.05 + Math.random() * 0.1);
      const i = (Math.random() * n) | 0;
      const roll = Math.random();
      if (roll < 0.5) await ps[i].act(Math.random() < 0.75 ? 'poke' : 'eat');
      else await ps[i].tick();
      for (const p of ps) if (Math.random() < 0.3) await p.tick();
      const ms = await all(`select * from peas.members where seat is not null`);
      for (const m of ms) {
        ok(m.fork >= 0 && m.fork <= 15, `fork ${m.fork}`);
        ok(m.peas + m.fork + m.gain + m.q_gain <= 84, 'không vượt số pea trên đĩa');
        ok(!(m.q_kind && !['poking', 'eating'].includes(m.st)), 'hàng đợi chỉ tồn tại khi đang bận');
        if (!m.alive) ok(['dead', 'left'].includes(m.st), `chết mà st ${m.st}`);
      }
    }
    ok(steps < 4000, 'trận phải kết thúc');
    for (let k = 0; k < 60; k++) { await wait(0.1); await ps[0].tick(); }
    const ev = await events();
    eq(ev.map((e) => e.seq), ev.map((_, k) => k + 1), 'seq liên tục');
    const shots = ev.filter((e) => e.type === 'shot').length;
    eq(shots, (await all(`select count(*)::int n from peas.members where st = 'dead'`))[0].n, 'mỗi shot giết đúng 1 người');
    // giữa hai shot phải có watching: không bắn 2 lần trong 1 lần nhìn
    let watching = 0;
    for (const e of ev) {
      if (e.type === 'mafia' && e.data.phase === 'watching') watching++;
      if (e.type === 'shot') { ok(watching >= 1, 'shot sau watching'); watching--; }
    }
    const end = ev.find((e) => e.type === 'end');
    ok(end, 'có end');
    const ms = await all(`select * from peas.members where seat is not null`);
    for (const m of ms) {
      const sc = end.data.scores[m.id];
      eq(sc.peas, m.peas, 'điểm peas khớp');
      eq(sc.total, sc.peas + sc.bonus);
      eq(sc.bonus, m.alive ? Math.min(20, Math.floor(m.peas * 0.5)) : 0);
    }
    eq(ev.filter((e) => e.type === 'end').length, 1, 'chỉ 1 end');
    ok(ids.includes(end.data.winner) || end.data.winner === null);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('Failed:', fails.join(' | ')); process.exit(1); }
