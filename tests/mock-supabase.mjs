// Server giả lập Supabase cho test client: PGlite chạy supabase/schema.sql, cùng 2 endpoint mà game dùng:
// - POST /rest/v1/rpc/<fn>: gọi public.<fn>(...) với tham số tên, giống PostgREST;
// - WebSocket /realtime/v1/websocket: giao thức Phoenix của realtime-js (phx_join, heartbeat, broadcast).
// realtime.send ghi vào bảng realtime.sent; sau mỗi RPC, server đọc các dòng mới và gửi tới client
// đã join topic tương ứng. net.delay/net.drop giả lập độ trễ và mất gói trên đường Realtime.
import { PGlite } from '@electric-sql/pglite';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';

const STUB = `
  create role anon; create role authenticated; create role authenticator;
  create schema realtime;
  create table realtime.sent (id serial primary key, payload jsonb, event text, topic text, private boolean);
  create function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
    language sql as $$ insert into realtime.sent (payload, event, topic, private) values (payload, event, topic, private) $$;
`;

export async function startMock(port) {
  const db = new PGlite();
  await db.exec(STUB);
  await db.exec(readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
  const net = { delay: [0, 0], drop: 0, rpcDelay: [0, 0], calls: {} };
  let sentId = 0;
  const subs = new Set(); // { ws, topic }

  const jitter = ([a, b]) => a + Math.random() * (b - a);
  async function pump() {
    const { rows } = await db.query(`select id, payload, event, topic from realtime.sent where id > $1 order by id`, [sentId]);
    for (const r of rows) {
      sentId = r.id;
      for (const s of subs) {
        if (s.topic !== `realtime:${r.topic}` || Math.random() < net.drop) continue;
        const msg = JSON.stringify({ topic: s.topic, event: 'broadcast', payload: { type: 'broadcast', event: r.event, payload: r.payload }, ref: null });
        setTimeout(() => s.ws.readyState === 1 && s.ws.send(msg), jitter(net.delay));
      }
    }
  }

  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const m = req.url.match(/^\/rest\/v1\/rpc\/(peas_[a-z]+)/);
    if (!m || req.method !== 'POST') { res.writeHead(404, cors); return res.end(); }
    let body = '';
    for await (const c of req) body += c;
    const args = JSON.parse(body || '{}');
    const keys = Object.keys(args);
    net.calls[m[1]] = (net.calls[m[1]] || 0) + 1;
    await new Promise((r) => setTimeout(r, jitter(net.rpcDelay) / 2));
    try {
      const sql = `select public.${m[1]}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
      const { rows } = await db.query(sql, keys.map((k) => args[k]));
      await pump();
      await new Promise((r) => setTimeout(r, jitter(net.rpcDelay) / 2));
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows[0].r));
    } catch (e) {
      res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: e.message, code: e.code }));
    }
  });

  const wss = new WebSocketServer({ server, path: '/realtime/v1/websocket' });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      const reply = (payload) => ws.send(JSON.stringify({ topic: msg.topic, event: 'phx_reply', payload, ref: msg.ref, join_ref: msg.join_ref }));
      if (msg.event === 'phx_join') {
        subs.add({ ws, topic: msg.topic });
        reply({ status: 'ok', response: { postgres_changes: [] } });
      } else if (msg.event === 'phx_leave') {
        for (const s of subs) if (s.ws === ws && s.topic === msg.topic) subs.delete(s);
        reply({ status: 'ok', response: {} });
      } else {
        reply({ status: 'ok', response: {} });
      }
    });
    ws.on('close', () => { for (const s of subs) if (s.ws === ws) subs.delete(s); });
  });

  await new Promise((r) => server.listen(port, r));
  return {
    db, net, url: `http://localhost:${port}`,
    close: () => new Promise((r) => { wss.close(); server.close(r); }),
  };
}
