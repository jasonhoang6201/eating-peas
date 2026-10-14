// Đo độ trễ tới Supabase thật (js/config.js): thời gian đi-về của một RPC, và thời gian từ lúc gửi peas_act
// tới lúc sự kiện act tới qua Realtime. Tạo một phòng tạm, server tự xóa sau 1 giờ.
// Chạy: npm run latency
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const s = readFileSync('../js/config.js', 'utf8');
const url = s.match(/SUPABASE_URL = '([^']+)'/)[1], key = s.match(/SUPABASE_ANON_KEY = '([^']+)'/)[1];
const c = createClient(url, key, { auth: { persistSession: false } });
const room = 'L' + Math.random().toString(36).slice(2, 6).toUpperCase();
const sec = (i) => `lat${i}${Math.random().toString(36).slice(2)}`.padEnd(24, 'x');
const S = [sec(0), sec(1)];
const ch = c.channel(`peas:${room}`);
const acts = [];
ch.on('broadcast', { event: 'ev' }, ({ payload }) => { if (payload.type === 'act') acts.push(performance.now()); });
await new Promise((r) => ch.subscribe((st) => st === 'SUBSCRIBED' && r()));
const rpc = async (fn, a) => { const { data, error } = await c.rpc(fn, { p_code: room, ...a }); if (error) throw error; return data; };
await rpc('peas_join', { p_secret: S[0], p_name: 'a' }); await new Promise((r) => setTimeout(r, 50));
await rpc('peas_join', { p_secret: S[1], p_name: 'b' });
await rpc('peas_start', { p_secret: S[0], p_rounds: 1 });
await new Promise((r) => setTimeout(r, 3300));
const rtt = [], rt = [];
const sent = [];
for (let i = 0; i < 15; i++) {
  const t0 = performance.now();
  await rpc('peas_tick', { p_secret: S[0], p_since: 0 });
  rtt.push(performance.now() - t0);
  const t1 = performance.now();
  const a = await rpc('peas_act', { p_secret: S[1], p_kind: 'poke' });
  if (a.ok) sent.push(t1);
  await new Promise((r) => setTimeout(r, 500));
}
await new Promise((r) => setTimeout(r, 2000));
sent.forEach((t, k) => rt.push(acts[k] - t));
const st = (a) => { const b = a.filter((x) => !isNaN(x)).sort((x, y) => x - y); return `min ${b[0]?.toFixed(0)} med ${b[b.length >> 1]?.toFixed(0)} max ${b.at(-1)?.toFixed(0)} (n=${b.length}/${a.length})`; };
console.log('RPC round-trip ms:', st(rtt));
console.log('gửi act -> nhận qua Realtime ms:', st(rt));
process.exit(0);
