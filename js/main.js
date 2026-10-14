import { World } from './scene.js';
import { LocalNet, ServerNet, onlineAvailable } from './net.js';
import * as SFX from './audio.js';
import { RULES, BOT_NAMES, pokeYield, survivorBonus } from './rules.js';

const $ = (id) => document.getElementById(id);
const now = () => performance.now();
const rand = (a, b) => a + Math.random() * (b - a);
const shuffle = (arr) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

const world = new World($('view'));

// players[id] = { id, name, seat, bot, st, stAt, fork, peas, alive }
// st: idle | poking (đang xiên, POKE giây) | eating (đang ăn, EAT giây) | dead
// fork: số pea đang dính trên nĩa (0..FORK_MAX); peas: số pea đã ăn.
// Mafia nhìn lên lúc đang poking hoặc eating thì bị bắn.
const G = {
  net: null,
  online: false, // true: server (supabase/schema.sql) quyết định mọi thứ, client chỉ gửi lệnh và vẽ
  selfId: null,
  hostId: null,
  presence: [],
  phase: 'boot', // boot | lobby | play | over
  players: {},
  mafia: { phase: 'reading', at: now(), dur: 1e9 },
  holdPoke: false,
  ending: false,
  startedAt: 0,
  lastSnap: 0,
  // match: rounds = tổng số trận, round = trận hiện tại (bắt đầu từ 1), total[id] = điểm cộng dồn tới trước trận này,
  // roster = danh sách ghế dùng lại cho mọi trận. nextAt: lúc bảng điểm hết giờ và host gửi trận tiếp theo.
  match: { rounds: 1, round: 1, total: {}, roster: [] },
  nextAt: 0,
};
const isHost = () => G.selfId && G.selfId === G.hostId;
const me = () => G.players[G.selfId];

// ---------- mạng ----------

function wire(net) {
  net.on('presence', onPresence);
  net.on('start', (d) => startGame(d.players, d));
  net.on('pstate', onPState);
  net.on('mafia', onMafia);
  net.on('shot', (d) => killPlayer(d.id));
  net.on('end', (d) => endGame(d));
  net.on('lobby', toLobby);
  net.on('snap', applySnap);
}

// Online: không có host chạy logic. Host chỉ là người được bấm Start và Back to lobby.
function wireOnline(net) {
  net.on('snapshot', applyServerSnap);
  net.on('members', (d) => setMembers(d.list, d.host));
  net.on('start', (d) => startGame(d.players, d));
  net.on('mafia', onMafia);
  net.on('act', onAct);
  net.on('shot', (d) => { syncDead(d); killPlayer(d.id); });
  net.on('left', (d) => { syncDead(d); markOut(d.id); });
  net.on('end', (d) => endGame(d));
  net.on('lobby', toLobby);
}

// el: số giây pha này đã chạy trên server trước khi sự kiện tới (server xử lý trễ). dur chỉ có ở countdown và warning.
function onMafia(d) {
  if (G.mafia.phase === 'countdown' && d.phase !== 'countdown') G.goUntil = now() + 700;
  const el = d.el || 0;
  G.mafia = { phase: d.phase, at: now() - el * 1000, dur: d.dur ?? 1e9 };
  // biết trước lúc pha đổi thì tick đúng lúc đó, để thấy mafia nhìn lên sớm nhất có thể
  if (G.online && d.dur != null) G.net.tickAt((d.dur - el) * 1000);
}

function setMembers(list, host) {
  G.presence = list;
  G.hostId = host;
  renderLobby();
  if (G.phase === 'over' && G.match.round >= G.match.rounds) {
    $('btnAgain').hidden = !isHost();
    $('waitAgain').hidden = isHost();
  }
}

// Người chơi khác bắt đầu xiên/ăn. Kết quả (fork, peas sau khi xong) có sẵn trong sự kiện;
// runActs áp dụng nó khi hết dur. in > 0: lệnh được server xếp hàng sau hành động hiện tại.
function onAct(d) {
  const p = G.players[d.id];
  if (!p || !p.alive || d.id === G.selfId) return;
  p.acts.push({ st: d.st, at: now() + d.in * 1000, dur: d.dur, fork: d.fork, peas: d.peas });
}

function runActs(p, t) {
  for (;;) {
    if ((p.st === 'poking' || p.st === 'eating') && t >= p.endAt) {
      if (p.res) { p.fork = p.res.fork; p.peas = p.res.peas; }
      p.st = 'idle'; p.stAt = p.endAt; p.res = null;
    }
    const a = p.acts[0];
    if (p.st !== 'idle' || !a || t < a.at) return;
    p.acts.shift();
    p.st = a.st; p.stAt = Math.max(a.at, p.stAt); p.endAt = p.stAt + a.dur * 1000; p.res = a;
  }
}

// Hành động đang chạy của người bị loại bị hủy trên server; màn hình có thể đã cộng kết quả của nó.
function syncDead(d) {
  const p = G.players[d.id];
  if (!p || !p.alive || d.peas == null) return;
  p.fork = d.fork; p.peas = d.peas; p.res = null; p.acts = [];
}

// Rời trận vì mất kết nối: gục xuống ngay, không có phát súng.
function markOut(id) {
  const p = G.players[id];
  if (!p || !p.alive) return;
  p.alive = false;
  p.st = 'dead';
  p.revealAt = 0;
  if (id === G.selfId) G.holdPoke = false;
  world.killInstant(id);
}

// Snapshot từ server: lúc vào phòng, lúc tải lại trang, hoặc khi client thiếu sự kiện.
function applyServerSnap(s) {
  G.selfId = s.self;
  setMembers(s.members, s.host);
  if (s.status === 'lobby') {
    if (G.phase !== 'lobby') toLobby();
    return;
  }
  if ((G.phase !== 'play' && G.phase !== 'over') || G.match.round !== s.round) {
    startGame(s.players, s);
  }
  for (const sp of s.players) {
    const p = G.players[sp.id];
    if (!p) continue;
    if (!sp.alive) { markOut(sp.id); continue; }
    // hành động của chính mình đang chạy theo dự đoán cục bộ thì giữ nguyên
    if (sp.id === G.selfId && (p.st === 'poking' || p.st === 'eating')) continue;
    p.acts = [];
    if (sp.st === 'poking' || sp.st === 'eating') {
      p.st = sp.st;
      p.stAt = now() - sp.el * 1000;
      p.endAt = p.stAt + (sp.st === 'poking' ? RULES.POKE : RULES.EAT) * 1000;
      p.res = { fork: sp.fork, peas: sp.peas };
    } else {
      p.st = 'idle'; p.res = null; p.fork = sp.fork; p.peas = sp.peas;
    }
  }
  const m = s.mafia;
  G.mafia = { phase: m.phase, at: now() - m.el * 1000, dur: m.dur ?? 1e9 };
  if (s.status === 'over' && s.result && G.phase !== 'over') endGame(s.result, s.nextIn);
}

function onPresence(list) {
  G.presence = list
    .filter(Boolean)
    .sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1));
  const prevHost = G.hostId;
  G.hostId = G.presence[0]?.id ?? G.selfId;
  // host cũ rời phòng giữa ván: host mới tiếp quản vòng đọc báo của mafia
  if (G.phase === 'play' && prevHost && prevHost !== G.hostId && isHost()) setMafia('reading', 3);
  renderLobby();
}

function onPState(d) {
  const p = G.players[d.id];
  if (!p || !p.alive) return;
  if (p.st !== d.st) {
    // thời điểm kết thúc lần xiên/ăn gần nhất, để host biết hành động đó có kéo dài qua lúc mafia nhìn lên không
    if (p.st === 'poking' || p.st === 'eating') p.endedAt = now();
    p.st = d.st;
    p.stAt = now();
  }
  p.fork = d.fork;
  p.peas = d.peas;
}

function applySnap(d) {
  if (isHost()) return;
  if (G.phase !== 'play') {
    // vào phòng giữa ván: xem với tư cách khán giả
    startGame(d.ps, d.match);
    for (const sp of d.ps) if (!sp.alive) {
      G.players[sp.id].alive = false;
      G.players[sp.id].st = 'dead';
      world.killInstant(sp.id);
    }
  }
  for (const sp of d.ps) {
    const p = G.players[sp.id];
    if (!p) continue;
    if (!sp.alive && p.alive) { killPlayer(sp.id); continue; }
    if (sp.id === G.selfId || !p.alive) continue;
    if (p.st !== sp.st) { p.st = sp.st; p.stAt = now(); }
    p.fork = sp.fork;
    p.peas = sp.peas;
  }
  if (G.mafia.phase !== d.m.phase) G.mafia = { phase: d.m.phase, at: now() - d.m.el * 1000, dur: d.m.dur };
}

// ---------- vòng đời ván chơi ----------

function hostStart() {
  const rounds = Math.min(RULES.ROUNDS_MAX, Math.max(1, Number($('rounds').value) || 1));
  if (G.online) {
    $('roomNote').textContent = '';
    G.net.start(rounds).catch((err) => { $('roomNote').textContent = err.message; });
    return;
  }
  const humans = G.presence.slice(0, RULES.SEATS);
  const seats = shuffle([...Array(RULES.SEATS).keys()]);
  const list = humans.map((h, i) => ({ id: h.id, name: h.name, seat: seats[i], bot: false }));
  if ($('fillBots').checked || list.length < 2) {
    const names = shuffle([...BOT_NAMES]);
    for (let i = list.length; i < RULES.SEATS; i++) {
      list.push({ id: `bot-${i}-${Math.random().toString(36).slice(2, 6)}`, name: names[i], seat: seats[i], bot: true });
    }
  }
  G.net.send('start', { players: list, rounds, round: 1, total: {} });
}

// Trận tiếp theo dùng lại danh sách ghế và mang theo điểm cộng dồn do host tính.
function hostNextRound() {
  const m = G.match;
  G.net.send('start', { players: m.roster, rounds: m.rounds, round: m.round + 1, total: m.total });
}

function startGame(list, match) {
  G.match = { rounds: match.rounds, round: match.round, total: { ...match.total }, roster: list };
  G.nextAt = 0;
  G.players = {};
  for (const d of list) {
    G.players[d.id] = {
      id: d.id, name: d.name, seat: d.seat, bot: d.bot,
      st: 'idle', stAt: now(), fork: 0, peas: 0, alive: true,
      react: rand(150, 700), nextAt: null, noticeAt: null, greedy: null, want: 0,
      // online: acts = hàng đợi hành động của người khác, endAt/res = lúc xong và kết quả hành động hiện tại
      acts: [], endAt: 0, res: null,
    };
  }
  G.phase = 'play';
  G.ending = false;
  G.holdPoke = false;
  G.startedAt = now();
  G.mafia = { phase: 'countdown', at: now(), dur: RULES.COUNTDOWN };
  G.goUntil = 0;
  world.setPlayers(list, G.selfId);
  $('lobby').hidden = true;
  $('overlay').hidden = true;
  $('hud').hidden = false;
  $('dead').hidden = true;
  $('hurt').classList.remove('on');
  $('view').classList.remove('stun');
  $('roundTag').textContent = `ROUND ${G.match.round}/${G.match.rounds}`;
  if (isHost()) setMafia('countdown', RULES.COUNTDOWN);
}

function killPlayer(id) {
  const p = G.players[id];
  if (!p || !p.alive) return;
  p.alive = false;
  p.st = 'dead';
  p.stAt = now();
  if (id === G.selfId) G.holdPoke = false;
  // HUD chỉ hiện người này đã chết sau revealAt (đặt lúc nổ súng + REVEAL_MS).
  p.revealAt = Infinity;
  world.shoot(id, () => SFX.rack(), () => {
    SFX.bang();
    flash();
    const view = $('view');
    view.classList.remove('stun'); void view.offsetWidth; view.classList.add('stun');
    p.revealAt = now() + REVEAL_MS;
    if (id === G.selfId) {
      setTimeout(() => {
        if (G.players[id] !== p) return; // ván đã reset trong lúc chờ
        $('dead').hidden = false;
        const hurt = $('hurt');
        hurt.classList.remove('on'); void hurt.offsetWidth; hurt.classList.add('on');
      }, REVEAL_MS);
    }
  });
}

// Thời gian choáng sau tiếng súng; hết khoảng này HUD mới cho biết ai bị bắn.
const REVEAL_MS = 1400;
const shownDead = (p) => !p.alive && !(now() < p.revealAt);

// d.scores[id] = { peas, bonus, total }: host tính lúc phát hiện trận kết thúc (checkEnd), total đã cộng trận này.
// Còn trận thì hiện bảng điểm RULES.BOARD giây (thanh đếm ngược), hết giờ host gửi trận tiếp theo.
// Trận cuối thì giữ bảng điểm tới khi chủ phòng bấm về phòng chờ.
// left: số giây còn lại của bảng điểm (vào phòng lúc đang hiện bảng điểm thì ít hơn RULES.BOARD).
function endGame(d, left = RULES.BOARD) {
  G.phase = 'over';
  const m = G.match;
  for (const [id, sc] of Object.entries(d.scores)) m.total[id] = sc.total;
  const final = m.round >= m.rounds;
  const w = d.winner && G.players[d.winner];
  const why = d.reason === 'peas' ? `${w.name} ate ${RULES.WIN} peas.`
    : d.reason === 'last' ? `${w.name} is the last one alive.` : 'Nobody survived.';

  const rows = Object.values(G.players)
    .map((p) => ({ p, sc: d.scores[p.id] }))
    .sort((a, b) => b.sc.total - a.sc.total || b.sc.peas + b.sc.bonus - (a.sc.peas + a.sc.bonus));
  const top = rows[0];
  $('overTitle').textContent = final ? 'FINAL' : `ROUND ${m.round}/${m.rounds}`;
  $('overSub').textContent = final ? `${top.p.name} wins with ${top.sc.total} pts. ${why}` : why;
  $('board').innerHTML = rows.map(({ p, sc }, i) => {
    const cls = [p.id === G.selfId ? 'self' : '', p.alive ? '' : 'out'].join(' ');
    const bonus = p.alive ? `+${sc.bonus}` : '✖';
    return `<tr class="${cls}"><td>${i + 1}</td><td>${esc(p.name)}</td><td>${sc.peas}</td><td>${bonus}</td><td><b>${sc.total}</b></td></tr>`;
  }).join('');

  $('boardTimer').hidden = final;
  if (!final) {
    G.nextAt = now() + left * 1000;
    const fill = $('boardFill');
    fill.style.animation = 'none'; void fill.offsetWidth;
    fill.style.animation = `drain ${RULES.BOARD}s linear forwards`;
    fill.style.animationDelay = `${left - RULES.BOARD}s`;
  }
  // ẩn nút và số đếm ngược phía sau bảng điểm; startGame bật lại HUD ở trận sau
  $('hud').hidden = true;
  $('count').hidden = true;
  $('count').textContent = '';
  $('btnAgain').hidden = !final || !isHost();
  $('waitAgain').hidden = !final || isHost();
  $('overlay').hidden = false;
}

function toLobby() {
  G.phase = 'lobby';
  G.nextAt = 0;
  G.players = {};
  G.mafia = { phase: 'reading', at: now(), dur: 1e9 };
  world.setPlayers([], G.selfId);
  $('overlay').hidden = true;
  $('hud').hidden = true;
  $('dead').hidden = true;
  $('hurt').classList.remove('on');
  $('view').classList.remove('stun');
  $('lobby').hidden = false;
  renderLobby();
}

// ---------- logic chỉ chạy trên host ----------

function setMafia(phase, dur) { G.net.send('mafia', { phase, dur }); }

function nextMafiaPhase() {
  // càng về cuối ván mafia đọc báo càng ngắn
  const speed = Math.max(0.5, 1 - (now() - G.startedAt) / 1000 / 150);
  switch (G.mafia.phase) {
    case 'reading': return setMafia('warning', RULES.WARN);
    case 'warning':
      return Math.random() < RULES.FAKE
        ? setMafia('reading', rand(1.2, 3) * speed)
        : setMafia('watching', rand(1.6, 3.2));
    case 'watching': return setMafia('raising', 0.4);
    default: return setMafia('reading', rand(2.5, 7) * speed);
  }
}

// Pha watching: bị bắt nếu đang poking/eating, hoặc lần xiên/ăn gần nhất kết thúc sau lúc mafia nhìn lên
// (m.at), tức là hành động vẫn còn chạy tại thời điểm mafia quay lại. Kiểm tra từ frame đầu của watching,
// không có khoảng ân hạn. Frame đầu tiên có người bị bắt: chọn ngẫu nhiên 1 người, bắn đúng 1 phát,
// giữ súng AFTER_SHOT giây (pha raising) rồi đọc báo tiếp.
const activeAt = (p, since) => p.st === 'poking' || p.st === 'eating' || p.endedAt > since;

function hostTick(t) {
  const m = G.mafia;
  const el = (t - m.at) / 1000;
  if (m.phase === 'watching') {
    const caught = Object.values(G.players).filter((p) => p.alive && activeAt(p, m.at));
    if (caught.length) {
      const victim = caught[(Math.random() * caught.length) | 0];
      G.net.send('shot', { id: victim.id });
      setMafia('raising', RULES.AFTER_SHOT);
    }
  }
  if (el >= G.mafia.dur && G.mafia === m) nextMafiaPhase();

  botTick(t);
  checkEnd();

  if (t - G.lastSnap > 1000) {
    G.lastSnap = t;
    const mm = G.mafia;
    G.net.broadcast('snap', {
      ps: Object.values(G.players).map(({ id, name, seat, bot, st, fork, peas, alive }) => ({ id, name, seat, bot, st, fork, peas, alive })),
      m: { phase: mm.phase, el: (t - mm.at) / 1000, dur: mm.dur },
      match: { rounds: G.match.rounds, round: G.match.round, total: G.match.total },
    });
  }
}

function botSet(p, st, fork, peas = p.peas) { G.net.send('pstate', { id: p.id, st, fork, peas }); }

// Bot xiên liên tục tới khi nĩa có `want` pea (ngẫu nhiên 5..FORK_MAX) rồi ăn.
// Khi mafia hạ báo, bot chỉ nhận ra sau `react` ms (150–700ms, nhân 0.7–1.3); trước lúc đó vẫn bắt đầu
// hành động mới như bình thường, nên bot phản ứng chậm có thể bị bắn. 10% số lần bot tham, bỏ qua cảnh báo.
function botTick(t) {
  const ph = G.mafia.phase;
  const alert = ph === 'warning' || ph === 'watching';
  for (const p of Object.values(G.players)) {
    if (!p.bot || !p.alive) continue;
    const el = (t - p.stAt) / 1000;
    if (p.st === 'poking') {
      if (el >= RULES.POKE) botSet(p, 'idle', Math.min(RULES.FORK_MAX, p.fork + pokeYield(), plateLeft(p) + p.fork));
      continue;
    }
    if (p.st === 'eating') {
      if (el >= RULES.EAT) botSet(p, 'idle', 0, p.peas + p.fork);
      continue;
    }
    if (alert) {
      p.greedy ??= Math.random() < 0.1;
      p.noticeAt ??= t + p.react * rand(0.7, 1.3);
    } else {
      p.greedy = null;
      p.noticeAt = null;
    }
    const blind = ph === 'reading' || p.greedy || (alert && t < p.noticeAt);
    if (!blind) { p.nextAt = null; continue; }
    p.want ||= 5 + ((Math.random() * (RULES.FORK_MAX - 4)) | 0);
    p.nextAt ??= t + rand(60, 350);
    if (t < p.nextAt) continue;
    p.nextAt = null;
    if (p.fork >= p.want || (p.fork > 0 && plateLeft(p) === 0)) { p.want = 0; botSet(p, 'eating', p.fork); }
    else if (plateLeft(p) > 0) botSet(p, 'poking', p.fork);
  }
}

const plateLeft = (p) => Math.max(0, RULES.PLATE - p.peas - p.fork);

function checkEnd() {
  if (G.ending) return;
  const ps = Object.values(G.players);
  const alive = ps.filter((p) => p.alive);
  const winner = alive.find((p) => p.peas >= RULES.WIN);
  let res = null;
  if (winner) res = { winner: winner.id, reason: 'peas' };
  else if (alive.length === 0) res = { winner: null, reason: 'all' };
  else if (alive.length === 1 && ps.length > 1) res = { winner: alive[0].id, reason: 'last' };
  if (res) {
    G.ending = true;
    // Chốt điểm ngay lúc phát hiện: pea ăn thêm trong lúc chờ gửi 'end' không được tính.
    const scores = {};
    for (const p of ps) {
      const bonus = p.alive ? survivorBonus(p.peas) : 0;
      scores[p.id] = { peas: p.peas, bonus, total: (G.match.total[p.id] || 0) + p.peas + bonus };
    }
    res.scores = scores;
    // chờ lên đạn + ngắm (SHOT_FIRE = 1.8s) và hết cú choáng (1.6s) để mọi người thấy ai bị bắn
    setTimeout(() => G.net.send('end', res), res.reason === 'peas' ? 1200 : 4200);
  }
}

// ---------- input của người chơi ----------
// Nút POKE (giữ F hoặc giữ nút): xiên liên tục, mỗi lần POKE giây, tới khi nĩa đầy hoặc thả tay.
// Nút EAT (E): ăn hết pea trên nĩa, EAT giây. Hành động đã bắt đầu thì chạy hết, không hủy được.

function setSelf(st, fork, peas) {
  const p = me();
  G.net.send('pstate', { id: p.id, st, fork: fork ?? p.fork, peas: peas ?? p.peas });
}

// Khóa nút khi đang đếm ngược đầu ván (countdown) và khi mafia chưa đọc báo lại (raising: vừa bắn xong,
// hoặc vừa nhìn xong mà không bắt được ai). Hành động đã bắt đầu trước đó vẫn chạy hết.
const locked = () => G.mafia.phase === 'countdown' || G.mafia.phase === 'raising';
// online: wait = hành động trước đã xong trên màn hình nhưng chưa có kết quả từ server;
// blockUntil = vừa bị server từ chối, chờ một chút rồi mới gửi lệnh tiếp.
const ready = (p) => p && p.alive && p.st === 'idle' && !locked() && !p.wait && !(now() < p.blockUntil);
function canPoke(p) { return ready(p) && p.fork < RULES.FORK_MAX && plateLeft(p) > 0; }
function canEat(p) { return ready(p) && p.fork > 0; }

// Online: hành động bắt đầu ngay trên màn hình (không chờ server), lệnh gửi song song.
// Server quyết định kết quả (số pea dính lên nĩa) và có thể từ chối; khi đó hủy hành động trên màn hình.
function startOnline(p, st) {
  const t = now();
  const req = p.req = (p.req || 0) + 1;
  p.st = st; p.stAt = t; p.res = null;
  p.endAt = t + (st === 'poking' ? RULES.POKE : RULES.EAT) * 1000;
  G.net.act(st === 'poking' ? 'poke' : 'eat').then((r) => onActReply(p, req, st, r), () => onActReply(p, req, st, null));
}

function onActReply(p, req, st, r) {
  if (G.players[p.id] !== p || !p.alive || p.req !== req) return;
  if (r?.ok) {
    if (st === 'poking') SFX.poke(r.gain, Math.max(0, RULES.POKE * RULES.POKE_HIT - (now() - p.stAt) / 1000));
    if (p.st === st) p.res = { fork: r.fork, peas: r.peas };
    else { p.fork = r.fork; p.peas = r.peas; p.wait = false; } // trên màn hình đã xong trước khi server trả lời
    return;
  }
  p.st = 'idle'; p.stAt = now(); p.res = null; p.wait = false;
  if (r) { p.fork = r.fork; p.peas = r.peas; }
  p.blockUntil = now() + 300;
}

function startPoke() {
  const p = me();
  if (G.phase !== 'play' || !canPoke(p)) return;
  if (G.online) return startOnline(p, 'poking');
  setSelf('poking');
  p.pending = Math.min(pokeYield(), RULES.FORK_MAX - p.fork, plateLeft(p));
  SFX.poke(p.pending, RULES.POKE * RULES.POKE_HIT);
}

function startEat() {
  const p = me();
  if (G.phase !== 'play' || !canEat(p)) return;
  if (G.online) return startOnline(p, 'eating');
  setSelf('eating');
}

function pokeDown() { SFX.init(); G.holdPoke = true; startPoke(); }
function pokeUp() { G.holdPoke = false; }

function selfTick(t) {
  const p = me();
  if (!p || !p.alive) return;
  if (G.online) {
    if ((p.st === 'poking' || p.st === 'eating') && t >= p.endAt) {
      p.st = 'idle'; p.stAt = p.endAt;
      if (p.res) { p.fork = p.res.fork; p.peas = p.res.peas; p.res = null; } else p.wait = true;
    }
    if (p.st === 'idle' && G.holdPoke) startPoke();
    return;
  }
  const el = (t - p.stAt) / 1000;
  if (p.st === 'poking' && el >= RULES.POKE) {
    setSelf('idle', p.fork + p.pending);
    if (G.holdPoke) startPoke();
  } else if (p.st === 'eating' && el >= RULES.EAT) setSelf('idle', 0, p.peas + p.fork);
  // giữ F trong lúc bị khóa: tự xiên tiếp ngay khi mafia đọc báo lại
  else if (p.st === 'idle' && G.holdPoke) startPoke();
}

const btnPoke = $('btnPoke'), btnEat = $('btnEat');
btnPoke.addEventListener('pointerdown', (e) => { e.preventDefault(); btnPoke.setPointerCapture(e.pointerId); pokeDown(); });
btnPoke.addEventListener('pointerup', pokeUp);
btnPoke.addEventListener('pointercancel', pokeUp);
btnEat.addEventListener('pointerdown', (e) => { e.preventDefault(); SFX.init(); startEat(); });
addEventListener('blur', pokeUp);
addEventListener('keydown', (e) => {
  if (e.repeat || e.target.tagName === 'INPUT') return;
  if (e.code === 'KeyF') { e.preventDefault(); pokeDown(); }
  else if (e.code === 'KeyE') { e.preventDefault(); SFX.init(); startEat(); }
});
addEventListener('keyup', (e) => { if (e.code === 'KeyF') pokeUp(); });

// ---------- UI ----------

function flash() {
  const el = $('flash');
  el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
}

// Đếm ngược giữa màn hình: "3", "2", "1" theo thời gian đã trôi của pha countdown, rồi "GO!" 0.7s.
function renderCount(t) {
  const m = G.mafia;
  const txt = m.phase === 'countdown' ? String(Math.max(1, Math.ceil(m.dur - (t - m.at) / 1000)))
    : t < G.goUntil ? 'GO!' : '';
  const el = $('count');
  if (el.textContent === txt) return;
  el.textContent = txt;
  el.hidden = !txt;
  el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
}

function renderHud(t) {
  renderCount(t);
  const rows = Object.values(G.players).sort((a, b) => a.seat - b.seat).map((p) => {
    const dead = shownDead(p);
    const cls = [p.id === G.selfId ? 'self' : '', dead ? 'out' : ''].join(' ');
    // số pea đã ăn hiện bằng thanh tiến độ tới RULES.WIN, không hiện số
    const bar = dead ? '<b>✖</b>' : `<s><u style="width:${Math.min(100, (p.peas / RULES.WIN) * 100).toFixed(1)}%"></u></s>`;
    return `<li class="${cls}"><span>${esc(p.name)}${p.bot ? ' <i>bot</i>' : ''}</span>${bar}</li>`;
  }).join('');
  if ($('score').dataset.v !== rows) { $('score').innerHTML = rows; $('score').dataset.v = rows; }

  const p = me();
  const playing = p && !shownDead(p);
  $('controls').hidden = !playing;
  $('spectate').hidden = playing;
  $('spectate').textContent = p ? 'You\'re out.' : 'Spectating';
  // vừa bị bắn nhưng chưa tới revealAt: giữ nguyên HUD như trước phát súng
  if (!playing || !p.alive) return;

  const el = (t - p.stAt) / 1000;
  const full = p.fork >= RULES.FORK_MAX;
  $('forkBox').classList.toggle('full', full);
  $('forkFill').style.transform = `scaleX(${p.fork / RULES.FORK_MAX})`;
  $('forkLabel').textContent = full ? 'FULL' : 'FORK';
  btnPoke.disabled = !canPoke(p) && p.st !== 'poking';
  btnEat.disabled = !canEat(p) && p.st !== 'eating';
  btnPoke.classList.toggle('busy', p.st === 'poking');
  btnEat.classList.toggle('busy', p.st === 'eating');
  const prog = p.st === 'poking' ? el / RULES.POKE : p.st === 'eating' ? el / RULES.EAT : 0;
  $('prog').style.transform = `scaleX(${Math.min(1, prog)})`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderLobby() {
  if (G.phase !== 'lobby') return;
  $('join').hidden = true;
  $('roomView').hidden = false;
  $('plist').innerHTML = G.presence.map((p, i) =>
    `<li>${esc(p.name)}${p.id === G.hostId ? ' <i>host</i>' : ''}${p.id === G.selfId ? ' <i>you</i>' : ''}${i >= RULES.SEATS ? ' <i>spectator</i>' : ''}</li>`).join('');
  $('btnStart').hidden = !isHost();
  $('fillWrap').hidden = !isHost() || G.online;
  $('roundsWrap').hidden = !isHost();
  $('waitNote').hidden = isHost();
}

async function join(online) {
  SFX.init();
  const name = ($('name').value.trim() || 'Guest').slice(0, 12);
  const room = ($('room').value.trim() || 'PEAS').toUpperCase().slice(0, 8);
  localStorage.setItem('peas-name', name);
  const net = online ? new ServerNet() : new LocalNet();
  G.net = net;
  G.online = online;
  G.selfId = net.selfId; // online: null tới khi có snapshot đầu tiên
  if (online) wireOnline(net); else wire(net);
  G.phase = 'lobby';
  $('roomCode').textContent = online ? room : 'OFFLINE';
  $('netNote').textContent = online ? 'Connecting…' : '';
  // tag tên trên đầu nhân vật vẽ bằng canvas, font phải load xong trước khi vẽ
  await document.fonts.load('bold 34px Rubik').catch(() => {});
  try {
    await net.join(room, name);
    if (online) history.replaceState(null, '', `?room=${room}`);
  } catch (err) {
    $('netNote').textContent = `Can't connect: ${err.message}`;
    G.phase = 'boot';
    net.leave();
    return;
  }
  $('netNote').textContent = '';
  renderLobby();
}

$('name').value = localStorage.getItem('peas-name') || '';
$('room').value = new URLSearchParams(location.search).get('room') || Math.random().toString(36).slice(2, 6).toUpperCase();
if (!onlineAvailable()) {
  $('btnOnline').disabled = true;
  $('netNote').textContent = 'Online not set up (js/config.js). Offline only.';
}
$('btnOnline').onclick = () => join(true);
$('btnOffline').onclick = () => join(false);
$('btnStart').onclick = () => hostStart();
$('btnAgain').onclick = () => (G.online ? G.net.lobby().catch(() => {}) : G.net.send('lobby', {}));
$('btnCopy').onclick = () => navigator.clipboard?.writeText(location.href);

window.__G = G; // dùng cho script test (tests/*.mjs)
if (new URLSearchParams(location.search).has('autoplay')) {
  window.__world = world; // dùng cho script chụp ảnh kiểm tra
  join(false).then(hostStart);
}

// ---------- vòng lặp ----------

let last = now();
function frame() {
  const t = now();
  const dt = Math.min(0.05, (t - last) / 1000);
  last = t;
  if (G.phase === 'play') {
    selfTick(t);
    if (G.online) {
      for (const p of Object.values(G.players)) if (p.id !== G.selfId && p.alive) runActs(p, t);
    } else if (isHost()) hostTick(t);
    renderHud(t);
  } else if (!G.online && G.phase === 'over' && G.nextAt && t >= G.nextAt && isHost()) {
    // mọi client đặt nextAt khi nhận 'end', nên host rời phòng lúc đang hiện bảng điểm thì host mới vẫn gửi trận tiếp
    G.nextAt = 0;
    hostNextRound();
  }
  world.update(dt, G, t);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
