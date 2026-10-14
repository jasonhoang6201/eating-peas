import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const uid = () => Math.random().toString(36).slice(2, 10);

// Offline: host chạy trên chính trình duyệt này.
// send(): chạy handler cục bộ ngay. broadcast(): gửi cho client khác (offline không có ai).
export class LocalNet {
  constructor() {
    this.selfId = uid();
    this.handlers = {};
  }
  on(type, fn) { (this.handlers[type] ||= []).push(fn); }
  emit(type, payload) { for (const fn of this.handlers[type] || []) fn(payload); }
  send(type, payload) { this.broadcast(type, payload); this.emit(type, payload); }
  broadcast() {}
  async join(_room, name) {
    this.emit('presence', [{ id: this.selfId, name, joinedAt: Date.now() }]);
  }
  leave() {}
}

export const onlineAvailable = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

// Secret riêng của tab này: server tính id công khai từ secret (peas.pid), client khác chỉ thấy id.
// Lưu trong sessionStorage nên tải lại trang vẫn là người chơi cũ, còn mỗi tab mới là một người chơi khác.
function tabSecret() {
  const make = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 40);
  try {
    let s = sessionStorage.getItem('peas-secret');
    if (!s) { s = make(); sessionStorage.setItem('peas-secret', s); }
    return s;
  } catch { return make(); }
}

const TICK_MS = 250;

// Online: server là Postgres trên Supabase (supabase/schema.sql). Client không tự quyết định gì,
// chỉ gọi RPC peas_* và nhận sự kiện { seq, type, data }.
// Sự kiện tới qua 2 đường: Realtime Broadcast (topic 'peas:<mã>') và kết quả peas_tick gọi mỗi TICK_MS.
// ingest() xếp theo seq, bỏ bản trùng và giữ lại sự kiện tới sớm cho tới khi đủ các seq trước nó.
// Sự kiện phát ra cho main.js: snapshot, members, start, mafia, act, shot, left, end, lobby, net.
export class ServerNet extends LocalNet {
  constructor() {
    super();
    this.selfId = null;
    this.secret = tabSecret();
    this.seq = null;     // seq của sự kiện cuối đã xử lý; null tới khi có snapshot
    this.pending = new Map();
    this.ticking = false;
  }

  async join(room, name) {
    this.room = room;
    this.name = name;
    const { createClient } = await import('@supabase/supabase-js');
    this.client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    // đăng ký Realtime trước khi join, để không lỡ sự kiện phát ra giữa lúc join và lúc subscribe
    this.ch = this.client.channel(`peas:${room}`);
    this.ch.on('broadcast', { event: 'ev' }, ({ payload }) => this.ingest([payload]));
    await new Promise((resolve) => {
      // Realtime lỗi thì vẫn chơi được nhờ peas_tick, chỉ chậm hơn
      const t = setTimeout(resolve, 4000);
      this.ch.subscribe((status) => {
        if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(t); resolve(); }
      });
    });
    await this.rejoin();
    // Không báo rời phòng khi đóng tab: tải lại trang cũng phát ra pagehide, và người tải lại phải giữ được chỗ.
    // Server tự loại người không tick quá cfg.seen_lobby giây (phòng chờ) hoặc cfg.seen_play giây (trong trận).
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  async rpc(fn, args) {
    const { data, error } = await this.client.rpc(fn, { p_code: this.room, p_secret: this.secret, ...args });
    if (error) throw new Error(error.message);
    return data;
  }

  async rejoin() {
    const snap = await this.rpc('peas_join', { p_name: this.name });
    this.applySnap(snap);
  }

  applySnap(s) {
    this.selfId = s.self;
    this.seq = s.seq;
    for (const k of this.pending.keys()) if (k <= s.seq) this.pending.delete(k);
    this.emit('snapshot', s);
    this.flush();
  }

  ingest(list) {
    for (const e of list) if (this.seq === null || e.seq > this.seq) this.pending.set(e.seq, e);
    this.flush();
  }

  flush() {
    if (this.seq === null) return;
    while (this.pending.has(this.seq + 1)) {
      const e = this.pending.get(this.seq + 1);
      this.pending.delete(this.seq + 1);
      this.seq = e.seq;
      this.emit(e.type, e.data);
    }
  }

  // Gọi định kỳ và gọi thêm đúng lúc biết trước pha sắp đổi (hết countdown, hết warning).
  async tick() {
    if (this.ticking || this.seq === null) return;
    this.ticking = true;
    try {
      const r = await this.rpc('peas_tick', { p_since: this.seq });
      this.emit('net', { ok: true });
      if (r.gone) await this.rejoin();
      else if (r.snapshot) this.applySnap(r.snapshot);
      else this.ingest(r.events);
    } catch (err) {
      this.emit('net', { ok: false, error: err.message });
    } finally {
      this.ticking = false;
    }
  }

  tickAt(ms) {
    clearTimeout(this.soon);
    this.soon = setTimeout(() => this.tick(), Math.max(0, ms) + 30);
  }

  act(kind) { return this.rpc('peas_act', { p_kind: kind }); }
  start(rounds) { return this.rpc('peas_start', { p_rounds: rounds }); }
  lobby() { return this.rpc('peas_lobby', {}); }

  leave() {
    clearInterval(this.timer);
    clearTimeout(this.soon);
    this.ch?.unsubscribe();
  }
}
