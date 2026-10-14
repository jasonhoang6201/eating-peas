// Âm thanh: tiếng súng (asset/gunshot.mp3), tiếng lên đạn (asset/gunreload.mp3) và tiếng xiên pea (tổng hợp bằng WebAudio).
let ctx = null;
let master = null;

export function init() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  ctx = new AudioContext();
  master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(ctx.destination);
  loadShot();
}

let shotBuf = null;
let reloadBuf = null;

async function loadSample(url, tail) {
  try {
    const res = await fetch(url);
    return trimSilence(await ctx.decodeAudioData(await res.arrayBuffer()), tail);
  } catch (err) {
    console.warn(`Failed to load ${url}`, err);
    return null;
  }
}

async function loadShot() {
  [shotBuf, reloadBuf] = await Promise.all([loadSample('asset/gunshot.mp3'), loadSample('asset/gunreload.mp3', 'last')]);
}

// Cắt im lặng ở hai đầu bản ghi:
// - đầu: mẫu đầu tiên vượt 5% biên độ đỉnh, lùi lại 2ms để không mất xung đầu;
// - cuối, tail = 'gap' (mặc định, dùng cho gunshot): điểm RMS (cửa sổ 10ms) xuống dưới -50dB và giữ như vậy
//   100ms liên tục. Dừng ở điểm này nên tiếng click lẻ ở cuối file (nằm sau đoạn im lặng) bị loại.
// - cuối, tail = 'last' (dùng cho gunreload): cửa sổ cuối cùng còn trên -50dB, quét từ cuối file ngược lên.
//   File reload có khoảng lặng 0.54s giữa tiếng lắp băng đạn và tiếng kéo khóa nòng, cách 'gap' sẽ cắt mất đoạn sau.
// Thêm fade-out 30ms ở cuối để không bị tiếng tách khi cắt.
function trimSilence(buf, tail = 'gap') {
  const sr = buf.sampleRate;
  const chans = [...Array(buf.numberOfChannels).keys()].map((c) => buf.getChannelData(c));
  const amp = (i) => Math.max(...chans.map((d) => Math.abs(d[i])));
  let peak = 0;
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, amp(i));
  let start = 0;
  while (start < buf.length && amp(start) < peak * 0.05) start++;
  start = Math.max(0, start - Math.round(sr * 0.002));

  const win = Math.round(sr * 0.01);
  const floor = peak * 10 ** (-50 / 20);
  let end = buf.length, quiet = 0;
  const rms = (i) => { let sum = 0; for (let k = i; k < i + win; k++) sum += amp(k) ** 2; return Math.sqrt(sum / win); };
  if (tail === 'last') {
    let i = buf.length - win;
    while (i > start && rms(i) < floor) i -= win;
    end = Math.min(buf.length, i + 2 * win);
  } else for (let i = start; i + win < buf.length; i += win) {
    if (rms(i) < floor) {
      if (++quiet === 10) { end = i - 9 * win; break; }
    } else quiet = 0;
  }

  const len = end - start;
  const out = ctx.createBuffer(buf.numberOfChannels, len, sr);
  const fade = Math.round(sr * 0.03);
  chans.forEach((d, c) => {
    const o = out.getChannelData(c);
    for (let i = 0; i < len; i++) o[i] = d[start + i] * Math.min(1, (len - i) / fade);
  });
  return out;
}

// Reverb phòng kho bê tông nhỏ (ConvolverNode). Impulse response tự sinh, mỗi kênh:
// - 6 phản xạ sớm rời rạc trong 7–45ms (tường, trần, bàn gần người nghe), lệch nhau giữa 2 kênh cho rộng stereo;
// - đuôi nhiễu suy giảm hàm mũ (hằng số 0.45s, dài 1.8s), qua lowpass một cực mà hệ số giảm dần
//   theo thời gian, nên đuôi càng về sau càng trầm như tiếng vang trong phòng thật.
let roomVerb = null;
function roomReverb() {
  if (roomVerb) return roomVerb;
  const sr = ctx.sampleRate, len = Math.ceil(sr * 1.8);
  const ir = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    let y = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const a = 0.9 - 0.7 * Math.min(1, t / 1.2);
      y += a * ((Math.random() * 2 - 1) - y);
      d[i] = y * Math.exp(-t / 0.45) * 0.45;
    }
    [7, 13, 19, 27, 34, 45].forEach((ms, k) => {
      const i = Math.round(sr * (ms + ch * 1.7) / 1000);
      d[i] += (k % 2 ? -1 : 1) * 0.7 * Math.exp(-k * 0.35);
    });
  }
  const conv = ctx.createConvolver();
  conv.buffer = ir;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 120;
  roomVerb = ctx.createGain();
  roomVerb.gain.value = 0.55;
  roomVerb.connect(conv).connect(hp).connect(master);
  return roomVerb;
}

function noiseBuffer(sec) {
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * sec), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

export function bang() {
  if (!ctx || !shotBuf) return;
  const src = ctx.createBufferSource();
  src.buffer = shotBuf;
  const dry = ctx.createGain(); dry.gain.value = 0.9;
  src.connect(dry).connect(master);
  src.connect(roomReverb());
  src.start();
}

// Tiếng lên đạn từ asset/gunreload.mp3, đi qua cùng reverb phòng với tiếng súng.
export function rack() {
  if (!ctx || !reloadBuf) return;
  const src = ctx.createBufferSource();
  src.buffer = reloadBuf;
  const dry = ctx.createGain(); dry.gain.value = 0.9;
  src.connect(dry).connect(master);
  src.connect(roomReverb());
  src.start();
}

// Tiếng xiên pea, phát sau `delay` giây (lúc răng nĩa chạm đĩa trong animation):
// - răng nĩa gõ vào đĩa sứ: 2 sine 3.1kHz và 4.9kHz tắt dần trong 70ms;
// - pea bị đâm thủng: nhiễu qua lowpass 1.2kHz dài 40ms, chỉ khi có pea dính lên (n > 0).
// Mỗi lần xiên lệch tần số ngẫu nhiên ±4% để các lần liên tiếp không nghe giống hệt nhau.
export function poke(n, delay = 0) {
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const detune = 0.96 + Math.random() * 0.08;
  for (const [f0, gain] of [[3100, 0.12], [4900, 0.06]]) {
    const o = ctx.createOscillator();
    o.frequency.value = f0 * detune;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    o.connect(g).connect(master);
    o.start(t); o.stop(t + 0.08);
  }
  if (n > 0) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(0.05);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1200 * detune;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    src.connect(f).connect(g).connect(master);
    src.start(t);
  }
}

// Độ dài (giây) của tiếng súng sau khi cắt im lặng; null khi chưa load xong. Dùng để kiểm tra.
export const shotDuration = () => shotBuf?.duration ?? null;
export const reloadDuration = () => reloadBuf?.duration ?? null;
