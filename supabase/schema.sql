-- Eating Peas: server cho chế độ online, chạy trong Postgres của Supabase.
-- Cách chạy: Supabase Dashboard > SQL Editor > dán toàn bộ file > Run. Chạy lại được nhiều lần:
-- file xóa và tạo lại schema peas, nên các phòng đang chơi bị xóa.
--
-- Client chỉ gọi được các hàm public.peas_* (RPC). Bảng nằm trong schema peas, không mở cho anon,
-- nên client không đọc hay sửa thẳng được số pea, thời điểm mafia nhìn lên hay secret của người khác.
-- Mọi thay đổi trạng thái đi qua peas.advance (xử lý sự kiện theo thứ tự thời gian tới thời điểm hiện tại)
-- và được ghi vào peas.events, đồng thời gửi tới client qua realtime.send (Broadcast, topic 'peas:<mã phòng>').
--
-- Không có process chạy liên tục: client gọi peas_tick vài lần mỗi giây, mỗi lần gọi peas.advance xử lý
-- các mốc đã tới hạn (đổi pha mafia, xiên/ăn xong, hết bảng điểm). Kết quả chỉ phụ thuộc thời điểm đã lưu,
-- không phụ thuộc lúc tick tới, trừ pha warning: pha này bắt đầu lúc được xử lý và gửi đi ngay,
-- để người chơi luôn có đủ cfg.warn giây kể từ lúc server gửi cảnh báo.

drop schema if exists peas cascade;
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'peas\_%' loop
    execute 'drop function ' || f.sig;
  end loop;
end $$;

create schema peas;
revoke all on schema peas from public;

-- Hằng số luật chơi, khớp js/rules.js. warn dài hơn bản offline (0.4) để bù độ trễ mạng.
-- Sửa trực tiếp được, ví dụ: update peas.cfg set warn = 0.7;
create table peas.cfg (
  id int primary key default 1 check (id = 1),
  seats int not null default 6,
  plate int not null default 120,       -- số pea trên mỗi đĩa
  win int not null default 100,         -- ăn đủ số này thì thắng trận
  fork_max int not null default 15,
  poke float8 not null default 0.4,     -- giây cho một lần xiên
  eat float8 not null default 0.6,      -- giây cho một lần ăn
  countdown float8 not null default 3,
  warn float8 not null default 0.6,     -- giây mafia hạ báo trước khi nhìn
  fake float8 not null default 0.25,    -- xác suất hạ báo rồi đọc tiếp
  after_shot float8 not null default 3.9,
  look_down float8 not null default 0.4,-- giây từ lúc thôi nhìn tới lúc đọc báo lại (không bắn ai)
  read_min float8 not null default 2.5, read_max float8 not null default 7,
  fake_min float8 not null default 1.2, fake_max float8 not null default 3,
  watch_min float8 not null default 1.6, watch_max float8 not null default 3.2,
  speed_span float8 not null default 150, -- thời gian đọc báo nhân max(0.5, 1 - giây đã chơi / speed_span)
  rounds_max int not null default 5,
  bonus_rate float8 not null default 0.5,
  bonus_max int not null default 20,
  board float8 not null default 7,      -- giây hiện bảng điểm giữa hai trận
  end_peas float8 not null default 1.2, -- giây chờ trước khi hiện bảng điểm khi có người ăn đủ
  end_shot float8 not null default 4.2, -- ... khi trận kết thúc vì bị bắn (chờ hết animation bắn)
  queue_ahead float8 not null default 0.25, -- lệnh mới tới sớm hơn lúc hành động hiện tại xong tối đa bấy nhiêu giây thì xếp hàng
  seen_lobby float8 not null default 6, -- không tick quá bấy nhiêu giây: mất khỏi danh sách phòng
  seen_play float8 not null default 15, -- ... đang trong trận: rời trận (đủ để tải lại trang trên mạng chậm)
  max_members int not null default 16
);
insert into peas.cfg default values;

create table peas.rooms (
  code text primary key,
  status text not null default 'lobby' check (status in ('lobby', 'play', 'ending', 'over')),
  rounds int not null default 1,
  round int not null default 0,
  phase text not null default 'reading', -- countdown | reading | warning | watching | raising
  phase_at timestamptz,
  phase_end timestamptz,                 -- bí mật khi phase = reading: không gửi cho client
  started_at timestamptz,
  result jsonb,                          -- payload sự kiện end, chốt lúc trận kết thúc
  show_at timestamptz,                   -- ending -> over (gửi end)
  next_at timestamptz,                   -- over -> trận tiếp theo; null ở trận cuối
  seq bigint not null default 0,         -- số thứ tự sự kiện cuối cùng
  members_sig text not null default '',
  touched_at timestamptz not null default now()
);

-- id = peas.pid(secret). Client giữ secret, các client khác chỉ thấy id.
-- seat null: không thuộc trận hiện tại (đang ở phòng chờ hoặc khán giả).
-- st: idle | poking | eating | dead | left. Hành động hiện tại chạy [st_at, st_end), gain = số pea sẽ dính lên nĩa.
-- q_kind/q_end/q_gain: một hành động xếp hàng, bắt đầu đúng lúc st_end.
create table peas.members (
  room text not null references peas.rooms (code) on delete cascade,
  id text not null,
  name text not null,
  joined_at timestamptz not null,
  seen_at timestamptz not null,
  seat int,
  alive boolean not null default false,
  st text not null default 'idle',
  st_at timestamptz,
  st_end timestamptz,
  gain int not null default 0,
  q_kind text,
  q_end timestamptz,
  q_gain int not null default 0,
  fork int not null default 0,
  peas int not null default 0,
  total int not null default 0,          -- điểm cộng dồn qua các trận
  primary key (room, id)
);

create table peas.events (
  room text not null references peas.rooms (code) on delete cascade,
  seq bigint not null,
  type text not null,
  data jsonb not null,
  at timestamptz not null,
  primary key (room, seq)
);

alter table peas.cfg enable row level security;
alter table peas.rooms enable row level security;
alter table peas.members enable row level security;
alter table peas.events enable row level security;

-- ---------- tiện ích ----------

-- Giờ server. Script test đặt peas.now để điều khiển thời gian; request qua API (session_user = authenticator) luôn dùng giờ thật.
create function peas.now() returns timestamptz language sql volatile set search_path = '' as $$
  select coalesce(
    case when session_user <> 'authenticator' then nullif(current_setting('peas.now', true), '')::timestamptz end,
    clock_timestamp())
$$;

create function peas.sec(x float8) returns interval language sql immutable set search_path = '' as $$
  select x * interval '1 second'
$$;

-- số giây từ b tới a
create function peas.el(a timestamptz, b timestamptz) returns float8 language sql immutable set search_path = '' as $$
  select extract(epoch from a - b)::float8
$$;

create function peas.rnd(a float8, b float8) returns float8 language sql volatile set search_path = '' as $$
  select a + random() * (b - a)
$$;

create function peas.pid(p_secret text) returns text language plpgsql immutable set search_path = '' as $$
begin
  if p_secret is null or p_secret !~ '^[A-Za-z0-9_-]{20,64}$' then
    raise exception 'Bad session';
  end if;
  return left(md5('peas:' || p_secret), 16);
end $$;

create function peas.cfg() returns peas.cfg language sql stable set search_path = '' as $$
  select * from peas.cfg where id = 1
$$;

-- Ghi sự kiện với seq kế tiếp và gửi qua Realtime. Client sắp xếp theo seq và bỏ bản trùng,
-- vì cùng sự kiện tới qua cả Realtime lẫn kết quả peas_tick.
create function peas.emit(p_code text, p_type text, p_data jsonb) returns void language plpgsql set search_path = '' as $$
declare s bigint;
begin
  update peas.rooms set seq = seq + 1 where code = p_code returning seq into s;
  insert into peas.events (room, seq, type, data, at) values (p_code, s, p_type, p_data, peas.now());
  perform realtime.send(jsonb_build_object('seq', s, 'type', p_type, 'data', p_data), 'ev', 'peas:' || p_code, false);
end $$;

-- Danh sách người đang kết nối, xếp theo lúc vào phòng. Người đầu tiên là host.
create function peas.members_json(p_code text, p_now timestamptz) returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name,
    'joinedAt', (extract(epoch from m.joined_at) * 1000)::bigint) order by m.joined_at, m.id), '[]'::jsonb)
  from peas.members m
  where m.room = p_code and m.seen_at > p_now - peas.sec((peas.cfg()).seen_lobby)
$$;

create function peas.host(p_code text, p_now timestamptz) returns text language sql stable set search_path = '' as $$
  select peas.members_json(p_code, p_now) -> 0 ->> 'id'
$$;

-- Gửi 'members' khi danh sách hoặc host thay đổi.
create function peas.sync_members(p_code text, p_now timestamptz) returns void language plpgsql set search_path = '' as $$
declare list jsonb := peas.members_json(p_code, p_now); sig text;
begin
  sig := md5(list::text);
  if sig is distinct from (select members_sig from peas.rooms where code = p_code) then
    update peas.rooms set members_sig = sig where code = p_code;
    perform peas.emit(p_code, 'members', jsonb_build_object('list', list, 'host', list -> 0 ->> 'id'));
  end if;
end $$;

-- ---------- vòng đời trận ----------

-- dur chỉ gửi cho countdown và warning. Thời lượng reading, watching, raising không gửi,
-- nên client không biết trước khi nào mafia hạ báo.
create function peas.set_phase(p_code text, p_phase text, p_at timestamptz, p_dur float8, p_now timestamptz)
returns void language plpgsql set search_path = '' as $$
begin
  update peas.rooms set phase = p_phase, phase_at = p_at, phase_end = p_at + peas.sec(p_dur) where code = p_code;
  perform peas.emit(p_code, 'mafia', jsonb_build_object('phase', p_phase, 'el', greatest(0, peas.el(p_now, p_at)),
    'dur', case when p_phase in ('countdown', 'warning') then p_dur end));
end $$;

-- Trận kết thúc khi có người còn sống ăn đủ cfg.win, hoặc còn ≤ 1 người sống.
-- Chốt điểm tại p_at: điểm = pea đã ăn, người còn sống thêm min(bonus_max, floor(pea × bonus_rate)).
create function peas.check_end(p_code text, p_at timestamptz) returns boolean language plpgsql set search_path = '' as $$
declare c peas.cfg := peas.cfg(); n_in int; n_alive int; w text; why text; delay float8; scores jsonb;
begin
  if (select status from peas.rooms where code = p_code) <> 'play' then return false; end if;
  select count(*), count(*) filter (where alive) into n_in, n_alive
    from peas.members where room = p_code and seat is not null;
  select id into w from peas.members
    where room = p_code and seat is not null and alive and peas >= c.win order by peas desc, id limit 1;
  if w is not null then why := 'peas'; delay := c.end_peas;
  elsif n_alive = 0 then why := 'all'; delay := c.end_shot;
  elsif n_alive = 1 and n_in > 1 then
    why := 'last'; delay := c.end_shot;
    select id into w from peas.members where room = p_code and seat is not null and alive;
  else return false;
  end if;

  with b as (
    select id, peas, case when alive then least(c.bonus_max, floor(peas * c.bonus_rate)::int) else 0 end as bonus
    from peas.members where room = p_code and seat is not null
  ), u as (
    update peas.members m set total = m.total + b.peas + b.bonus from b
    where m.room = p_code and m.id = b.id
    returning m.id, b.peas, b.bonus, m.total
  )
  select jsonb_object_agg(id, jsonb_build_object('peas', peas, 'bonus', bonus, 'total', total)) into scores from u;

  update peas.rooms set status = 'ending', show_at = p_at + peas.sec(delay),
    result = jsonb_build_object('winner', w, 'reason', why, 'scores', scores)
  where code = p_code;
  return true;
end $$;

-- Hành động đang chạy của nạn nhân bị hủy. Sự kiện gửi kèm fork/peas của server, vì client có thể đã
-- áp dụng kết quả hành động đó trên màn hình trước khi nhận sự kiện.
create function peas.shoot(p_code text, p_id text, p_at timestamptz, p_now timestamptz) returns void
language plpgsql set search_path = '' as $$
declare m peas.members;
begin
  update peas.members set alive = false, st = 'dead', st_end = null, gain = 0, q_kind = null, q_end = null, q_gain = 0
    where room = p_code and id = p_id returning * into m;
  perform peas.emit(p_code, 'shot', jsonb_build_object('id', p_id, 'fork', m.fork, 'peas', m.peas));
  perform peas.set_phase(p_code, 'raising', p_at, (peas.cfg()).after_shot, p_now);
  perform peas.check_end(p_code, p_at);
end $$;

-- Mafia nhìn lên tại p_at: chọn ngẫu nhiên 1 người đang xiên hoặc ăn và bắn.
-- peas.advance xử lý mọi lần xiên/ăn kết thúc ≤ p_at trước khi gọi hàm này,
-- nên hành động kết thúc đúng tại p_at không bị tính.
create function peas.judge(p_code text, p_at timestamptz, p_now timestamptz) returns void
language plpgsql set search_path = '' as $$
declare v text;
begin
  select id into v from peas.members
    where room = p_code and seat is not null and alive and st in ('poking', 'eating') order by random() limit 1;
  if v is not null then perform peas.shoot(p_code, v, p_at, p_now); end if;
end $$;

create function peas.next_phase(p_code text, p_now timestamptz) returns void language plpgsql set search_path = '' as $$
declare c peas.cfg := peas.cfg(); r peas.rooms; et timestamptz; sp float8;
begin
  select * into r from peas.rooms where code = p_code;
  et := r.phase_end;
  sp := greatest(0.5, 1 - peas.el(et, r.started_at) / c.speed_span);
  case r.phase
    when 'reading' then
      -- bắt đầu cảnh báo lúc xử lý (p_now), không phải lúc reading hết hạn
      perform peas.set_phase(p_code, 'warning', p_now, c.warn, p_now);
    when 'warning' then
      if random() < c.fake then
        perform peas.set_phase(p_code, 'reading', et, peas.rnd(c.fake_min, c.fake_max) * sp, p_now);
      else
        perform peas.set_phase(p_code, 'watching', et, peas.rnd(c.watch_min, c.watch_max), p_now);
        perform peas.judge(p_code, et, p_now);
      end if;
    when 'watching' then
      perform peas.set_phase(p_code, 'raising', et, c.look_down, p_now);
    else -- countdown, raising
      perform peas.set_phase(p_code, 'reading', et, peas.rnd(c.read_min, c.read_max) * sp, p_now);
  end case;
end $$;

-- Hành động hiện tại của p_id xong tại st_end: poke thêm gain pea lên nĩa, eat chuyển hết pea trên nĩa vào peas.
-- Có hành động xếp hàng thì bắt đầu nó ngay tại st_end.
create function peas.finish(p_code text, p_id text) returns void language plpgsql set search_path = '' as $$
declare m peas.members; nf int; np int;
begin
  select * into m from peas.members where room = p_code and id = p_id;
  if m.st = 'poking' then nf := m.fork + m.gain; np := m.peas;
  else nf := 0; np := m.peas + m.fork;
  end if;
  if m.q_kind is not null then
    update peas.members set fork = nf, peas = np, st = m.q_kind, st_at = m.st_end, st_end = m.q_end,
      gain = m.q_gain, q_kind = null, q_end = null, q_gain = 0
    where room = p_code and id = p_id;
  else
    update peas.members set fork = nf, peas = np, st = 'idle', st_at = m.st_end, st_end = null, gain = 0
    where room = p_code and id = p_id;
  end if;
  perform peas.check_end(p_code, m.st_end);
end $$;

create function peas.to_lobby(p_code text) returns void language plpgsql set search_path = '' as $$
begin
  update peas.members set seat = null, alive = false, st = 'idle', st_end = null, gain = 0,
    q_kind = null, q_end = null, q_gain = 0, fork = 0, peas = 0
  where room = p_code;
  update peas.rooms set status = 'lobby', round = 0, result = null, show_at = null, next_at = null where code = p_code;
  perform peas.emit(p_code, 'lobby', '{}'::jsonb);
end $$;

-- Bắt đầu trận kế tiếp với những người có ghế và còn kết nối. Còn dưới 2 người thì về phòng chờ.
create function peas.start_round(p_code text, p_now timestamptz) returns void language plpgsql set search_path = '' as $$
declare c peas.cfg := peas.cfg(); r peas.rooms;
begin
  update peas.members set seat = null, alive = false, st = 'idle'
    where room = p_code and seat is not null and seen_at <= p_now - peas.sec(c.seen_play);
  if (select count(*) from peas.members where room = p_code and seat is not null) < 2 then
    perform peas.to_lobby(p_code);
    return;
  end if;
  update peas.members set alive = true, st = 'idle', st_at = p_now, st_end = null, gain = 0,
    q_kind = null, q_end = null, q_gain = 0, fork = 0, peas = 0
  where room = p_code and seat is not null;
  update peas.rooms set status = 'play', round = round + 1, phase = 'countdown', phase_at = p_now,
    phase_end = p_now + peas.sec(c.countdown), started_at = p_now, result = null, show_at = null, next_at = null
  where code = p_code returning * into r;
  delete from peas.events where room = p_code and at < p_now - interval '10 minutes';
  perform peas.emit(p_code, 'start', jsonb_build_object(
    'players', (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'seat', seat, 'bot', false) order by seat)
                from peas.members where room = p_code and seat is not null),
    'total', (select jsonb_object_agg(id, total) from peas.members where room = p_code and seat is not null),
    'rounds', r.rounds, 'round', r.round));
  perform peas.emit(p_code, 'mafia', jsonb_build_object('phase', 'countdown', 'el', 0, 'dur', c.countdown));
end $$;

-- Xử lý mọi mốc thời gian ≤ p_now theo thứ tự: lần xiên/ăn kết thúc sớm nhất, đổi pha mafia,
-- hết thời gian chờ bảng điểm. Trùng thời điểm thì xử lý hành động kết thúc trước đổi pha.
create function peas.advance(p_code text, p_now timestamptz) returns void language plpgsql set search_path = '' as $$
declare c peas.cfg := peas.cfg(); r peas.rooms; m peas.members; n int := 0;
begin
  -- không thuộc trận và mất kết nối: xóa khỏi phòng
  delete from peas.members where room = p_code and seat is null and seen_at <= p_now - peas.sec(c.seen_lobby);
  -- đang chơi và mất kết nối quá seen_play giây: rời trận (không bị bắn, không có điểm thưởng)
  if (select status from peas.rooms where code = p_code) = 'play' then
    for m in select * from peas.members where room = p_code and seat is not null and alive
             and seen_at <= p_now - peas.sec(c.seen_play) order by id loop
      update peas.members set alive = false, st = 'left', st_end = null, gain = 0, q_kind = null, q_end = null, q_gain = 0
        where room = p_code and id = m.id;
      perform peas.emit(p_code, 'left', jsonb_build_object('id', m.id, 'fork', m.fork, 'peas', m.peas));
      perform peas.check_end(p_code, p_now);
    end loop;
  end if;

  loop
    n := n + 1;
    if n > 2000 then raise exception 'peas.advance: too many steps'; end if;
    select * into r from peas.rooms where code = p_code;
    if r.status = 'play' then
      select * into m from peas.members where room = p_code and seat is not null and alive and st in ('poking', 'eating')
        order by st_end, id limit 1;
      if m.id is not null and m.st_end <= p_now and m.st_end <= r.phase_end then
        perform peas.finish(p_code, m.id);
        continue;
      end if;
      if r.phase_end <= p_now then
        perform peas.next_phase(p_code, p_now);
        continue;
      end if;
    elsif r.status = 'ending' and r.show_at <= p_now then
      update peas.rooms set status = 'over',
        next_at = case when round < rounds then show_at + peas.sec(c.board) end
      where code = p_code;
      perform peas.emit(p_code, 'end', r.result);
      continue;
    elsif r.status = 'over' and r.next_at <= p_now then
      perform peas.start_round(p_code, p_now);
      continue;
    end if;
    exit;
  end loop;

  perform peas.sync_members(p_code, p_now);
end $$;

-- Trạng thái đầy đủ cho client mới vào hoặc client bị thiếu sự kiện.
-- Người đang xiên/ăn: fork/peas là giá trị sau khi hành động xong (giống sự kiện act).
create function peas.snapshot(p_code text, p_now timestamptz, p_self text) returns jsonb
language plpgsql stable set search_path = '' as $$
declare r peas.rooms;
begin
  select * into r from peas.rooms where code = p_code;
  return jsonb_build_object(
    'seq', r.seq, 'self', p_self, 'host', peas.host(p_code, p_now), 'members', peas.members_json(p_code, p_now),
    'status', r.status, 'rounds', r.rounds, 'round', r.round,
    'mafia', jsonb_build_object('phase', r.phase, 'el', greatest(0, peas.el(p_now, r.phase_at)),
      'dur', case when r.phase in ('countdown', 'warning') then peas.el(r.phase_end, r.phase_at) end),
    'players', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'name', name, 'seat', seat, 'bot', false, 'alive', alive,
        'st', case when st in ('poking', 'eating', 'idle') then st else 'dead' end,
        'el', greatest(0, peas.el(p_now, st_at)),
        'fork', case st when 'poking' then fork + gain when 'eating' then 0 else fork end,
        'peas', case st when 'eating' then peas + fork else peas end) order by seat)
      from peas.members where room = p_code and seat is not null), '[]'::jsonb),
    'total', coalesce((select jsonb_object_agg(id, total) from peas.members where room = p_code and seat is not null), '{}'::jsonb),
    'result', case when r.status = 'over' then r.result end,
    'nextIn', case when r.status = 'over' then peas.el(r.next_at, p_now) end);
end $$;

-- Khóa dòng phòng (các RPC cùng phòng chạy tuần tự), ghi nhận người gọi còn kết nối, rồi xử lý các mốc tới hạn.
-- Trả về id của người gọi, null nếu phòng không tồn tại hoặc người gọi không ở trong phòng.
create function peas.enter(p_code text, p_secret text, p_now timestamptz) returns text
language plpgsql set search_path = '' as $$
declare me text := peas.pid(p_secret);
begin
  perform 1 from peas.rooms where code = p_code for update;
  if not found then return null; end if;
  update peas.members set seen_at = p_now where room = p_code and id = me;
  if not found then return null; end if;
  update peas.rooms set touched_at = p_now where code = p_code;
  perform peas.advance(p_code, p_now);
  return me;
end $$;

-- ---------- RPC cho client ----------

create function public.peas_join(p_code text, p_secret text, p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t timestamptz := peas.now(); me text := peas.pid(p_secret); c peas.cfg := peas.cfg(); rst text; nm text;
begin
  if p_code is null or p_code !~ '^[A-Z0-9]{1,8}$' then raise exception 'Bad room code'; end if;
  nm := btrim(left(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]<>]', '', 'g'), 12));
  if nm = '' then nm := 'Guest'; end if;

  delete from peas.rooms where touched_at < t - interval '1 hour';
  insert into peas.rooms (code, touched_at) values (p_code, t) on conflict do nothing;
  select status into rst from peas.rooms where code = p_code for update;
  if not exists (select 1 from peas.members where room = p_code and id = me)
     and jsonb_array_length(peas.members_json(p_code, t)) >= c.max_members then
    raise exception 'Room is full';
  end if;
  insert into peas.members (room, id, name, joined_at, seen_at) values (p_code, me, nm, t, t)
    on conflict (room, id) do update set seen_at = t,
      name = case when rst = 'lobby' then excluded.name else peas.members.name end;
  update peas.rooms set touched_at = t where code = p_code;
  perform peas.advance(p_code, t);
  return peas.snapshot(p_code, t, me);
end $$;

-- Trả về các sự kiện có seq > p_since. Không có đủ sự kiện (client tụt quá xa hoặc đã bị dọn) thì trả snapshot.
create function public.peas_tick(p_code text, p_secret text, p_since bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t timestamptz := peas.now(); me text; s bigint; lo bigint;
begin
  me := peas.enter(p_code, p_secret, t);
  if me is null then return jsonb_build_object('gone', true); end if;
  select seq into s from peas.rooms where code = p_code;
  select min(seq) into lo from peas.events where room = p_code;
  if p_since is null or p_since > s or s - p_since > 300 or (p_since < s and lo > p_since + 1) then
    return jsonb_build_object('snapshot', peas.snapshot(p_code, t, me));
  end if;
  return jsonb_build_object('seq', s, 'events', coalesce((
    select jsonb_agg(jsonb_build_object('seq', seq, 'type', type, 'data', data) order by seq)
    from peas.events where room = p_code and seq > p_since), '[]'::jsonb));
end $$;

-- p_kind: 'poke' | 'eat'. Hành động bắt đầu lúc server nhận lệnh. Nếu hành động trước còn chạy nhưng
-- xong trong vòng cfg.queue_ahead giây, lệnh mới được xếp hàng và bắt đầu đúng lúc hành động trước xong.
-- Bắt đầu hành động trong pha watching thì bị bắn ngay.
-- Kết quả: { ok, in (giây tới lúc bắt đầu), gain, fork, peas } với fork/peas là giá trị sau khi hành động xong;
-- bị từ chối: { ok: false, reason, alive, fork, peas }.
create function public.peas_act(p_code text, p_secret text, p_kind text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t timestamptz := peas.now(); c peas.cfg := peas.cfg(); me text; r peas.rooms; m peas.members;
  busy boolean; t0 timestamptz; fa int; pa int; left_ int; g int; nst text; rf int; rp int; why text;
begin
  if p_kind not in ('poke', 'eat') then raise exception 'Bad action'; end if;
  me := peas.enter(p_code, p_secret, t);
  if me is null then return jsonb_build_object('ok', false, 'reason', 'gone'); end if;
  select * into r from peas.rooms where code = p_code;
  select * into m from peas.members where room = p_code and id = me;

  busy := m.st in ('poking', 'eating');
  -- trạng thái sau khi hành động hiện tại (nếu có) xong
  fa := case when m.st = 'poking' then m.fork + m.gain when m.st = 'eating' then 0 else m.fork end;
  pa := case when m.st = 'eating' then m.peas + m.fork else m.peas end;
  left_ := c.plate - pa - fa;

  if r.status <> 'play' then why := 'not_playing';
  elsif m.seat is null then why := 'spectator';
  elsif not m.alive then why := 'dead';
  elsif r.phase in ('countdown', 'raising') then why := 'locked';
  elsif busy and (m.q_kind is not null or peas.el(m.st_end, t) > c.queue_ahead) then why := 'busy';
  elsif p_kind = 'poke' and fa >= c.fork_max then why := 'full';
  elsif p_kind = 'poke' and left_ <= 0 then why := 'empty';
  elsif p_kind = 'eat' and fa <= 0 then why := 'nothing';
  end if;
  if why is not null then
    return jsonb_build_object('ok', false, 'reason', why, 'alive', m.alive, 'fork', fa, 'peas', pa);
  end if;

  t0 := case when busy then m.st_end else t end;
  if p_kind = 'poke' then
    nst := 'poking';
    g := least(case when random() < 0.6 then 1 else 2 end, c.fork_max - fa, left_);
    rf := fa + g; rp := pa;
  else
    nst := 'eating'; g := 0; rf := 0; rp := pa + fa;
  end if;

  if busy then
    update peas.members set q_kind = nst, q_end = t0 + peas.sec(case when nst = 'poking' then c.poke else c.eat end), q_gain = g
      where room = p_code and id = me;
  else
    update peas.members set st = nst, st_at = t, st_end = t + peas.sec(case when nst = 'poking' then c.poke else c.eat end), gain = g
      where room = p_code and id = me;
  end if;
  perform peas.emit(p_code, 'act', jsonb_build_object('id', me, 'st', nst, 'in', peas.el(t0, t),
    'dur', case when nst = 'poking' then c.poke else c.eat end, 'fork', rf, 'peas', rp));
  if r.phase = 'watching' then perform peas.judge(p_code, t, t); end if;

  return jsonb_build_object('ok', true, 'in', peas.el(t0, t), 'gain', g, 'fork', rf, 'peas', rp);
end $$;

create function public.peas_start(p_code text, p_secret text, p_rounds int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t timestamptz := peas.now(); c peas.cfg := peas.cfg(); me text;
begin
  me := peas.enter(p_code, p_secret, t);
  if me is null then raise exception 'Not in room'; end if;
  if peas.host(p_code, t) is distinct from me then raise exception 'Only the host can start'; end if;
  if (select status from peas.rooms where code = p_code) <> 'lobby' then raise exception 'Already playing'; end if;
  if jsonb_array_length(peas.members_json(p_code, t)) < 2 then raise exception 'Need at least 2 players'; end if;

  update peas.members set seat = null, total = 0 where room = p_code;
  -- cfg.seats người vào sớm nhất được ngồi, xếp ghế ngẫu nhiên; người còn lại là khán giả
  with picked as (
    select id from peas.members
    where room = p_code and seen_at > t - peas.sec(c.seen_lobby)
    order by joined_at, id limit c.seats
  ), s as (select id, (row_number() over (order by random()) - 1)::int as seat from picked)
  update peas.members m set seat = s.seat from s where m.room = p_code and m.id = s.id;
  update peas.rooms set rounds = least(c.rounds_max, greatest(1, coalesce(p_rounds, 1))), round = 0 where code = p_code;
  perform peas.start_round(p_code, t);
  return jsonb_build_object('ok', true);
end $$;

-- Host đưa cả phòng về phòng chờ sau bảng chung cuộc.
create function public.peas_lobby(p_code text, p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t timestamptz := peas.now(); me text; r peas.rooms;
begin
  me := peas.enter(p_code, p_secret, t);
  if me is null then raise exception 'Not in room'; end if;
  if peas.host(p_code, t) is distinct from me then raise exception 'Only the host can do this'; end if;
  select * into r from peas.rooms where code = p_code;
  if r.status <> 'over' or r.next_at is not null then raise exception 'Match not finished'; end if;
  perform peas.to_lobby(p_code);
  return jsonb_build_object('ok', true);
end $$;

revoke all on all functions in schema peas from public;
revoke all on function public.peas_join(text, text, text), public.peas_tick(text, text, bigint),
  public.peas_act(text, text, text), public.peas_start(text, text, int), public.peas_lobby(text, text)
  from public;
grant execute on function public.peas_join(text, text, text), public.peas_tick(text, text, bigint),
  public.peas_act(text, text, text), public.peas_start(text, text, int), public.peas_lobby(text, text)
  to anon, authenticated;
