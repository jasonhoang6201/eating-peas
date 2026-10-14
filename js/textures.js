import * as THREE from 'three';

// Mọi texture vẽ bằng canvas 2D lúc khởi động. Dùng NearestFilter để giữ pixel thô.
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

const TEX_SCALE = 2;

function make(w, h, draw, repeat, grain = 14) {
  // Canvas vật lý lớn gấp TEX_SCALE lần; hàm draw vẫn vẽ theo tọa độ logic w x h.
  const c = document.createElement('canvas');
  c.width = w * TEX_SCALE; c.height = h * TEX_SCALE;
  const g = c.getContext('2d');
  g.scale(TEX_SCALE, TEX_SCALE);
  draw(g, w, h);
  if (grain) addGrain(g, c.width, c.height, grain);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  return t;
}

// Nhiễu ±amount trên từng pixel vật lý, cùng giá trị cho 3 kênh (giữ màu, chỉ đổi độ sáng).
function addGrain(g, w, h, amount) {
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 2 * amount;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}

function speckle(g, w, h, r, n, colors, size = 2) {
  // texture vẽ ở TEX_SCALE lần nên chấm nhỏ hơn và nhiều gấp 3 để giữ mật độ mà không thành đốm to
  for (let i = 0; i < n * 3; i++) {
    g.fillStyle = colors[(r() * colors.length) | 0];
    const s = 0.3 + r() * size * 0.45;
    g.fillRect(r() * w, r() * h, s, s);
  }
}

function blotches(g, w, h, r, n, rgb, maxA, maxR) {
  for (let i = 0; i < n; i++) {
    const x = r() * w, y = r() * h, rad = maxR * (0.3 + r());
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, `rgba(${rgb},${maxA * r()})`);
    gr.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = gr;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
}

function drips(g, w, h, r, n, rgb) {
  for (let i = 0; i < n; i++) {
    const x = r() * w, y0 = r() * h * 0.4, len = h * (0.2 + r() * 0.6), wd = 1 + r() * 4;
    const gr = g.createLinearGradient(0, y0, 0, y0 + len);
    gr.addColorStop(0, `rgba(${rgb},${0.15 + r() * 0.35})`);
    gr.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = gr;
    g.fillRect(x, y0, wd, len);
  }
}

export function splatShape(g, cx, cy, size, r, rgb = '105,6,8', a = 0.92) {
  g.fillStyle = `rgba(${rgb},${a})`;
  g.strokeStyle = g.fillStyle;
  g.beginPath(); g.arc(cx, cy, size * 0.45, 0, Math.PI * 2); g.fill();
  for (let i = 0; i < 18; i++) {
    const ang = r() * Math.PI * 2, d = size * (0.3 + r() * 0.9), s = size * (0.04 + r() * 0.14);
    g.lineWidth = s * 1.2;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(ang) * d, cy + Math.sin(ang) * d); g.stroke();
    g.beginPath(); g.arc(cx + Math.cos(ang) * d, cy + Math.sin(ang) * d, s, 0, Math.PI * 2); g.fill();
  }
  // vệt máu đậm hơn ở giữa
  g.fillStyle = `rgba(60,0,2,${a * 0.6})`;
  g.beginPath(); g.arc(cx + size * 0.05, cy - size * 0.04, size * 0.25, 0, Math.PI * 2); g.fill();
}

export const wall = () => make(256, 256, (g, w, h) => {
  const r = rng(11);
  g.fillStyle = '#5e584e'; g.fillRect(0, 0, w, h);
  blotches(g, w, h, r, 60, '25,22,18', 0.6, 50);
  blotches(g, w, h, r, 25, '120,95,65', 0.35, 40);
  drips(g, w, h, r, 40, '30,24,18');
  speckle(g, w, h, r, 2500, ['#4a453d', '#6b655a', '#38342e', '#77705f']);
  g.strokeStyle = 'rgba(20,18,15,0.6)'; g.lineWidth = 1;
  for (let i = 0; i < 8; i++) {
    let x = r() * w, y = r() * h;
    g.beginPath(); g.moveTo(x, y);
    for (let k = 0; k < 6; k++) { x += (r() - 0.5) * 30; y += r() * 20; g.lineTo(x, y); }
    g.stroke();
  }
}, [3, 1.5]);

export const floor = () => make(256, 256, (g, w, h) => {
  const r = rng(23);
  g.fillStyle = '#35312c'; g.fillRect(0, 0, w, h);
  blotches(g, w, h, r, 50, '15,13,11', 0.7, 45);
  speckle(g, w, h, r, 3000, ['#2a2723', '#423d36', '#1f1d1a']);
  g.strokeStyle = 'rgba(10,9,8,0.7)';
  for (let i = 0; i <= 4; i++) {
    g.beginPath(); g.moveTo(i * 64, 0); g.lineTo(i * 64, h); g.stroke();
    g.beginPath(); g.moveTo(0, i * 64); g.lineTo(w, i * 64); g.stroke();
  }
}, [6, 6]);

export const table = () => make(256, 512, (g, w, h) => {
  const r = rng(37);
  // xám đá ngả xanh: khác hẳn dải đỏ/nâu của áo và da, đĩa trắng nổi lên trên nền tối
  // texture xanh hơn màu đích vì đèn treo vàng ấm kéo màu về phía đỏ
  g.fillStyle = '#304257'; g.fillRect(0, 0, w, h);
  blotches(g, w, h, r, 40, '16,20,26', 0.5, 50);
  speckle(g, w, h, r, 3000, ['#2c3d50', '#384b61', '#273748']);
  g.strokeStyle = 'rgba(110,125,140,0.18)';
  for (let i = 0; i < 60; i++) {
    const x = r() * w, y = r() * h;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 60, y + (r() - 0.5) * 20); g.stroke();
  }
  // vết máu cũ đã khô: vũng tròn méo sẫm màu và vệt quệt
  for (let i = 0; i < 9; i++) {
    g.fillStyle = `rgba(${60 + r() * 30},4,6,${0.55 + r() * 0.3})`;
    g.strokeStyle = g.fillStyle;
    poolShape(g, (r() * 1e6) | 0, r() * w, r() * h, 12 + r() * 30, false);
  }
  for (let i = 0; i < 6; i++) {
    g.strokeStyle = `rgba(90,8,10,${0.3 + r() * 0.4})`;
    g.lineWidth = 3 + r() * 8;
    const x = r() * w, y = r() * h;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 80, y + (r() - 0.5) * 120); g.stroke();
  }
});

export const newspaper = () => make(256, 320, (g, w, h) => {
  const r = rng(51);
  // giấy báo cũ: nền ngả vàng nâu, tối hơn màu kem để không bị đổi sang trắng lạnh trong bảng màu
  g.fillStyle = '#bcab88'; g.fillRect(0, 0, w, h);
  blotches(g, w, h, r, 22, '110,85,45', 0.4, 60);
  g.fillStyle = 'rgba(46,40,30,0.82)'; // mực đã phai
  g.font = 'bold 30px Georgia, serif'; g.textAlign = 'center';
  g.fillText('The Daily Pea', w / 2, 34);
  g.fillRect(10, 42, w - 20, 3); g.fillRect(10, 48, w - 20, 1);
  g.font = 'bold 22px Georgia, serif';
  g.fillText('MOB BOSS EATS ALONE', w / 2, 74);
  // ảnh minh họa: cụm hình người tối màu
  g.fillStyle = '#7d6c4e'; g.fillRect(14, 86, 140, 96);
  g.fillStyle = '#2a2824';
  for (let i = 0; i < 4; i++) {
    const x = 30 + i * 32;
    g.fillRect(x, 120, 18, 62);
    g.beginPath(); g.arc(x + 9, 112, 9, 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = '#3a3833';
  const col = (x, y0, y1, wd) => {
    for (let y = y0; y < y1; y += 6) g.fillRect(x, y, wd * (0.7 + r() * 0.3), 2);
  };
  col(164, 88, 182, 80);
  col(14, 192, 310, 72); col(94, 192, 310, 72); col(174, 192, 310, 70);
  // vết ố nước: mảng nâu loang đè lên cả chữ
  blotches(g, w, h, r, 8, '90,62,30', 0.35, 45);
  // 2 vòng cà phê: vành đậm, lòng nhạt
  for (const [cx, cy, rad] of [[196, 250, 26], [60, 130, 18]]) {
    g.fillStyle = 'rgba(95,60,25,0.18)';
    g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(80,48,18,0.55)'; g.lineWidth = 2.5;
    g.beginPath(); g.arc(cx, cy, rad, 0.3, Math.PI * 2 - 0.4); g.stroke();
  }
  // nếp gấp ngang ở 1/3 và 2/3 chiều cao: vệt tối mảnh kèm vệt sáng sát bên
  for (const y of [h / 3, (2 * h) / 3]) {
    g.fillStyle = 'rgba(60,45,25,0.45)'; g.fillRect(0, y, w, 2);
    g.fillStyle = 'rgba(200,185,150,0.25)'; g.fillRect(0, y + 2, w, 1);
  }
  // mép giấy ngả nâu đậm hơn phần giữa
  const edge = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.65);
  edge.addColorStop(0, 'rgba(70,50,20,0)');
  edge.addColorStop(1, 'rgba(70,50,20,0.55)');
  g.fillStyle = edge; g.fillRect(0, 0, w, h);
  speckle(g, w, h, r, 700, ['rgba(70,55,35,0.5)', 'rgba(120,95,60,0.4)']);
});

export const canLabel = () => make(256, 128, (g, w, h) => {
  const r = rng(63);
  g.fillStyle = '#b8bab4'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#efeadb'; g.fillRect(0, 14, w, h - 28);
  g.fillStyle = '#4c7a2c'; g.fillRect(0, 84, w, 30);
  for (let side = 0; side < 2; side++) {
    const x = side * 128 + 64;
    g.fillStyle = '#a0221d'; g.font = 'italic bold 22px Georgia, serif'; g.textAlign = 'center';
    g.fillText("Marshol's", x, 48);
    g.fillStyle = '#f1ead2'; g.font = 'bold 22px Arial, sans-serif';
    g.fillText('PEAS', x, 108);
    g.fillStyle = '#2f5a1a'; g.font = 'bold 9px Arial'; g.fillText('CONDENSED', x, 66);
  }
  blotches(g, w, h, r, 10, '60,50,30', 0.4, 30);
  blotches(g, w, h, r, 4, '110,10,10', 0.6, 14);
});

export const canTop = () => make(64, 64, (g, w, h) => {
  g.fillStyle = '#8f918c'; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#5d5f5a'; g.lineWidth = 2;
  for (let i = 1; i < 5; i++) { g.beginPath(); g.arc(32, 32, i * 6, 0, Math.PI * 2); g.stroke(); }
});

export const jersey = (color, num, sleeve = false) => make(128, 128, (g, w, h) => {
  const r = rng(num.charCodeAt(0) * 7 + (sleeve ? 3 : 1));
  g.fillStyle = color; g.fillRect(0, 0, w, h);
  speckle(g, w, h, r, 900, ['rgba(0,0,0,0.18)', 'rgba(255,255,255,0.06)']);
  blotches(g, w, h, r, 6, '10,5,5', 0.5, 40);
  g.fillStyle = '#eee9de'; g.strokeStyle = '#1a1a1a'; g.lineWidth = 4;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = sleeve ? 'bold 46px Arial Black, Arial' : 'bold 70px Arial Black, Arial';
  g.strokeText(num, w / 2, h / 2 + 4); g.fillText(num, w / 2, h / 2 + 4);
  if (sleeve) { g.fillRect(0, 10, w, 6); g.fillRect(0, 20, w, 6); }
  blotches(g, w, h, r, 3, '100,5,5', 0.6, 20);
});

export const cloth = (color) => make(64, 64, (g, w, h) => {
  const r = rng(color.length * 13 + color.charCodeAt(1));
  g.fillStyle = color; g.fillRect(0, 0, w, h);
  speckle(g, w, h, r, 400, ['rgba(0,0,0,0.2)', 'rgba(255,255,255,0.05)']);
  blotches(g, w, h, r, 4, '0,0,0', 0.4, 20);
});

export const felt = () => make(64, 64, (g, w, h) => {
  const r = rng(77);
  g.fillStyle = '#4c5634'; g.fillRect(0, 0, w, h);
  speckle(g, w, h, r, 500, ['#3c4528', '#5a6640', '#333b22']);
});

export const plate = () => make(128, 128, (g, w, h) => {
  const r = rng(88);
  g.fillStyle = '#e9e7df'; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#c9c6bb'; g.lineWidth = 2;
  g.beginPath(); g.arc(64, 64, 42, 0, Math.PI * 2); g.stroke();
  // hoa văn xanh dương ở vành đĩa
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2, x = 64 + Math.cos(a) * 54, y = 64 + Math.sin(a) * 54;
    g.fillStyle = '#3d58a8';
    for (let k = 0; k < 5; k++) {
      const b = (k / 5) * Math.PI * 2;
      g.beginPath(); g.arc(x + Math.cos(b) * 3, y + Math.sin(b) * 3, 2, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = '#6a8f3a'; g.fillRect(x - 1 + Math.cos(a + 0.3) * 6, y + Math.sin(a + 0.3) * 6, 3, 2);
  }
  blotches(g, w, h, r, 6, '120,110,90', 0.25, 20);
});

export const cardboard = (seed) => make(64, 64, (g, w, h) => {
  const r = rng(seed);
  g.fillStyle = '#7d6342'; g.fillRect(0, 0, w, h);
  speckle(g, w, h, r, 300, ['#6c5537', '#8d7250']);
  blotches(g, w, h, r, 5, '40,30,20', 0.5, 20);
  g.fillStyle = 'rgba(200,180,140,0.6)'; g.fillRect(0, 28, w, 8);
  g.fillStyle = '#2b2219'; g.fillRect(8, 44, 20 + r() * 20, 3); g.fillRect(8, 50, 14 + r() * 20, 3);
});

export const splat = (seed) => {
  const t = make(128, 128, (g) => splatShape(g, 64, 64, 46, rng(seed)), null, 0);
  return t;
};

export const glow = () => make(64, 64, (g) => {
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,250,210,1)');
  gr.addColorStop(0.3, 'rgba(255,180,60,0.9)');
  gr.addColorStop(1, 'rgba(255,120,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
}, null, 0);

export const label = (text, color) => make(256, 64, (g, w, h) => {
  g.font = 'bold 34px Rubik, Arial, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.85)';
  g.strokeText(text, w / 2, h / 2); g.fillStyle = color; g.fillText(text, w / 2, h / 2);
}, null, 0);

// Texture mặt quấn quanh SphereGeometry: u=0.25 (x=128) là chính diện (+z), u=0.75 là gáy,
// v=0.5 (y=128) là xích đạo. Mắt hơi trên xích đạo, miệng ở y≈162.
export const face = ({ skin, seed = 1, heavy = false, stubble = false, hair = null }) => make(512, 256, (g, w, h) => {
  const r = rng(seed * 97 + 5);
  const cx = 128, ey = 118;
  g.fillStyle = skin; g.fillRect(0, 0, w, h);
  blotches(g, w, h, r, 30, '120,60,45', 0.12, 30);
  blotches(g, w, h, r, 12, '255,230,210', 0.1, 30);
  // vùng bóng dưới cằm và sau gáy
  const sh = g.createLinearGradient(0, 180, 0, 256);
  sh.addColorStop(0, 'rgba(60,30,20,0)'); sh.addColorStop(1, 'rgba(60,30,20,0.5)');
  g.fillStyle = sh; g.fillRect(0, 180, w, 76);

  if (hair) {
    g.fillStyle = hair;
    g.fillRect(0, 0, w, 52);
    for (const [x0, x1] of [[214, 512], [0, 42]]) {
      g.beginPath(); g.moveTo(x0, 0);
      for (let x = x0; x <= x1; x += 6) g.lineTo(x, 112 + r() * 14);
      g.lineTo(x1, 0); g.fill();
    }
    speckle(g, w, 120, r, 120, ['rgba(0,0,0,0.3)', 'rgba(255,255,255,0.06)']);
  }
  if (stubble) {
    const sg = g.createRadialGradient(cx, 178, 10, cx, 178, 70);
    sg.addColorStop(0, 'rgba(60,60,70,0.35)'); sg.addColorStop(1, 'rgba(60,60,70,0)');
    g.fillStyle = sg; g.fillRect(cx - 80, 140, 160, 116);
    for (let i = 0; i < 500; i++) {
      const a = r() * Math.PI, d = 30 + r() * 40;
      g.fillStyle = 'rgba(40,35,40,0.35)';
      g.fillRect(cx + Math.cos(a) * d * 1.1, 150 + Math.sin(a) * d * 0.8, 0.8, 0.8);
    }
  }
  for (const s of [-1, 1]) {
    const ex = cx + s * 26;
    // hốc mắt tối
    const so = g.createRadialGradient(ex, ey, 2, ex, ey, 22);
    so.addColorStop(0, 'rgba(70,35,25,0.55)'); so.addColorStop(1, 'rgba(70,35,25,0)');
    g.fillStyle = so; g.fillRect(ex - 24, ey - 24, 48, 48);
    g.fillStyle = '#ddd3c2';
    g.beginPath(); g.ellipse(ex, ey + 1, 8.5, heavy ? 3.2 : 4.2, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#2b1d15';
    g.beginPath(); g.arc(ex + s * -1, ey + 1, 3.6, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.8)'; g.fillRect(ex, ey - 1, 1.2, 1.2);
    // mí trên
    g.strokeStyle = 'rgba(40,20,15,0.9)'; g.lineWidth = 1.6;
    g.beginPath(); g.ellipse(ex, ey + 1, 9, heavy ? 3.4 : 4.6, 0, Math.PI * 1.05, Math.PI * 1.95); g.stroke();
    // lông mày: mafia nhíu xuống phía giữa
    g.strokeStyle = '#2a1c14'; g.lineWidth = heavy ? 5 : 3; g.lineCap = 'round';
    g.beginPath();
    g.moveTo(cx + s * 12, ey - (heavy ? 7 : 11));
    g.quadraticCurveTo(cx + s * 26, ey - (heavy ? 14 : 16), cx + s * 40, ey - (heavy ? 15 : 12));
    g.stroke();
    // má ửng
    const ck = g.createRadialGradient(cx + s * 40, ey + 28, 2, cx + s * 40, ey + 28, 22);
    ck.addColorStop(0, 'rgba(190,85,70,0.22)'); ck.addColorStop(1, 'rgba(190,85,70,0)');
    g.fillStyle = ck; g.fillRect(cx + s * 40 - 22, ey + 6, 44, 44);
    // lỗ mũi
    g.fillStyle = 'rgba(60,25,20,0.7)';
    g.beginPath(); g.ellipse(cx + s * 5, ey + 32, 2.6, 1.6, 0, 0, Math.PI * 2); g.fill();
  }
  // nếp mũi-má
  g.strokeStyle = 'rgba(90,45,35,0.35)'; g.lineWidth = 1.5;
  for (const s of [-1, 1]) {
    g.beginPath(); g.moveTo(cx + s * 12, ey + 30); g.quadraticCurveTo(cx + s * 22, ey + 42, cx + s * 20, ey + 52); g.stroke();
  }
  // môi
  const my = 162;
  g.fillStyle = '#9a5a4c';
  g.beginPath(); g.ellipse(cx, my + 3, 15, 4.5, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#8a4a40';
  g.beginPath(); g.ellipse(cx, my - 1, 14, 3.2, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#3a1712'; g.lineWidth = 1.8;
  g.beginPath(); g.moveTo(cx - 16, my + (heavy ? 4 : 1)); g.quadraticCurveTo(cx, my - (heavy ? 1 : 0), cx + 16, my + (heavy ? 4 : 1)); g.stroke();
  // rãnh cằm
  g.strokeStyle = 'rgba(80,40,30,0.3)'; g.lineWidth = 1.2;
  g.beginPath(); g.arc(cx, my + 22, 9, Math.PI * 1.15, Math.PI * 1.85); g.stroke();
}, null, 8);

// Áo đấu quấn quanh thân lathe (phiStart=0): u=0.5 (x=256) là lưng, u=0.25/0.75 là hai bên.
// v=1 (đỉnh canvas) là cổ áo.
export const jerseyWrap = (color, num) => make(512, 256, (g, w, h) => {
  const r = rng(num.charCodeAt(0) * 13 + num.charCodeAt(1));
  g.fillStyle = color; g.fillRect(0, 0, w, h);
  speckle(g, w, h, r, 1500, ['rgba(0,0,0,0.15)', 'rgba(255,255,255,0.05)']);
  // nếp vải
  for (let i = 0; i < 26; i++) {
    const x = r() * w, y = 40 + r() * 200;
    g.strokeStyle = `rgba(0,0,0,${0.1 + r() * 0.15})`; g.lineWidth = 2 + r() * 4;
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + 20, y + 10 * (r() - 0.5), x + 30 + r() * 40, y + 20 * (r() - 0.5)); g.stroke();
  }
  g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(0, 0, w, 10);
  g.fillStyle = '#eee9de'; g.fillRect(0, 12, w, 4);
  g.fillRect(0, 226, w, 5); g.fillRect(0, 236, w, 5);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 5; g.strokeStyle = '#1a1a1a'; g.fillStyle = '#eee9de';
  g.font = 'bold 96px Arial Black, Arial';
  g.strokeText(num, 256, 108); g.fillText(num, 256, 108);
  g.font = 'bold 48px Arial Black, Arial';
  for (const x of [128, 384]) { g.strokeText(num, x, 130); g.fillText(num, x, 130); }
  blotches(g, w, h, r, 10, '10,5,5', 0.45, 50);
  blotches(g, w, h, r, 4, '100,5,5', 0.5, 25);
});

// Vest mafia quấn quanh thân lathe (phiStart=π): u=0.5 (x=256) là ngực.
export const suitWrap = () => make(512, 256, (g, w, h) => {
  const r = rng(404);
  g.fillStyle = '#272b32'; g.fillRect(0, 0, w, h);
  speckle(g, w, h, r, 1500, ['rgba(0,0,0,0.25)', 'rgba(255,255,255,0.04)']);
  for (let i = 0; i < 20; i++) {
    const x = r() * w, y = r() * h;
    g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + 30, y + 18 * (r() - 0.5)); g.stroke();
  }
  // áo sơ mi chữ V và cà vạt
  g.fillStyle = '#d6d1c4';
  g.beginPath(); g.moveTo(206, 0); g.lineTo(306, 0); g.lineTo(256, 120); g.fill();
  g.fillStyle = '#4a1216';
  g.beginPath(); g.moveTo(248, 4); g.lineTo(264, 4); g.lineTo(268, 100); g.lineTo(256, 118); g.lineTo(244, 100); g.fill();
  // ve áo
  g.strokeStyle = '#15171b'; g.lineWidth = 6;
  g.beginPath(); g.moveTo(200, 0); g.lineTo(256, 130); g.lineTo(312, 0); g.stroke();
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(256, 130); g.lineTo(256, 256); g.stroke();
  g.fillStyle = '#0d0e10';
  for (const y of [160, 200]) { g.beginPath(); g.arc(262, y, 4, 0, Math.PI * 2); g.fill(); }
  blotches(g, w, h, r, 8, '0,0,0', 0.4, 40);
});

// Mặt mafia: mắt híp hõm sâu dưới bóng gờ mày, mày nhíu dốc xuống giữa, nếp nhíu dọc giữa hai mày,
// nếp nhăn trán, bọng mắt, rãnh mũi-má sâu, miệng trễ, râu dày, sẹo trên má trái.
export const mafiaFace = (skin) => make(512, 256, (g, w, h) => {
  const r = rng(666);
  const cx = 128, ey = 118, my = 164;
  g.fillStyle = skin; g.fillRect(0, 0, w, h);
  blotches(g, w, h, r, 40, '70,45,40', 0.18, 30);
  blotches(g, w, h, r, 10, '130,90,90', 0.12, 25);
  const sh = g.createLinearGradient(0, 175, 0, 256);
  sh.addColorStop(0, 'rgba(40,25,20,0)'); sh.addColorStop(1, 'rgba(40,25,20,0.6)');
  g.fillStyle = sh; g.fillRect(0, 175, w, 81);
  // râu dày ở cằm và quai hàm
  for (let i = 0; i < 2200; i++) {
    const a = r() * Math.PI, d = 26 + r() * 52;
    g.fillStyle = `rgba(35,32,38,${0.25 + r() * 0.25})`;
    g.fillRect(cx + Math.cos(a) * d * 1.25, 140 + Math.sin(a) * d * 0.9, 0.9, 0.9);
  }
  // bóng gờ mày phủ ngang hai mắt
  // gradient tròn bị ép dẹt theo chiều dọc thành hình elip, không có cạnh cắt
  g.save();
  g.translate(cx, ey); g.scale(1, 0.32);
  const band = g.createRadialGradient(0, 0, 10, 0, 0, 62);
  band.addColorStop(0, 'rgba(25,12,8,0.6)'); band.addColorStop(1, 'rgba(25,12,8,0)');
  g.fillStyle = band; g.fillRect(-62, -62, 124, 124);
  g.restore();
  // nếp nhăn trán
  g.strokeStyle = 'rgba(60,35,30,0.28)'; g.lineWidth = 1;
  for (const y of [ey - 36, ey - 46, ey - 56]) {
    g.beginPath(); g.moveTo(cx - 40, y);
    for (let x = -40; x <= 40; x += 8) g.lineTo(cx + x, y + Math.sin(x * 0.15 + y) * 2);
    g.stroke();
  }
  for (const s of [-1, 1]) {
    const ex = cx + s * 26;
    g.fillStyle = 'rgba(15,6,4,0.8)';
    g.beginPath(); g.ellipse(ex, ey + 1, 11, 6, 0, 0, Math.PI * 2); g.fill();
    // mắt híp: khe hẹp, lòng trắng ngả vàng, con ngươi nhỏ nhìn thẳng
    g.fillStyle = '#c9b996';
    g.beginPath(); g.ellipse(ex, ey + 2, 8, 2.2, s * -0.12, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#120a06';
    g.beginPath(); g.arc(ex - s * 1.5, ey + 2, 2.4, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,240,220,0.9)'; g.fillRect(ex - s * 1.5 + 0.6, ey + 0.8, 1, 1);
    // bọng mắt
    g.strokeStyle = 'rgba(50,25,20,0.55)'; g.lineWidth = 1.5;
    g.beginPath(); g.ellipse(ex, ey + 8, 9, 3.5, 0, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
    // lông mày dày, đầu trong thấp, đuôi ngoài cao
    g.fillStyle = '#1c1310';
    g.beginPath();
    g.moveTo(cx + s * 7, ey - 3);
    g.lineTo(cx + s * 44, ey - 17);
    g.lineTo(cx + s * 42, ey - 10);
    g.lineTo(cx + s * 9, ey + 3);
    g.fill();
    // rãnh mũi-má sâu kéo xuống tận cằm
    g.strokeStyle = 'rgba(50,22,18,0.6)'; g.lineWidth = 2.4;
    g.beginPath(); g.moveTo(cx + s * 13, ey + 28); g.quadraticCurveTo(cx + s * 30, ey + 46, cx + s * 26, ey + 70); g.stroke();
    // lỗ mũi to
    g.fillStyle = 'rgba(40,15,12,0.85)';
    g.beginPath(); g.ellipse(cx + s * 8, ey + 33, 3.6, 2.2, 0, 0, Math.PI * 2); g.fill();
  }
  // nếp nhíu dọc giữa hai mày
  g.strokeStyle = 'rgba(40,18,14,0.75)'; g.lineWidth = 1.8;
  for (const s of [-1, 1]) { g.beginPath(); g.moveTo(cx + s * 4, ey - 24); g.lineTo(cx + s * 3, ey - 6); g.stroke(); }
  // miệng: môi mỏng, hai khóe trễ xuống
  g.fillStyle = '#6e3d36';
  g.beginPath(); g.ellipse(cx, my + 2, 18, 3.5, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#220c09'; g.lineWidth = 2.4;
  g.beginPath(); g.moveTo(cx - 22, my + 8); g.quadraticCurveTo(cx, my - 4, cx + 22, my + 8); g.stroke();
  g.strokeStyle = 'rgba(40,18,14,0.5)'; g.lineWidth = 1.6;
  for (const s of [-1, 1]) { g.beginPath(); g.moveTo(cx + s * 22, my + 8); g.lineTo(cx + s * 26, my + 18); g.stroke(); }
  g.beginPath(); g.arc(cx, my + 26, 12, Math.PI * 1.15, Math.PI * 1.85); g.stroke();
  // sẹo chéo trên má trái
  g.strokeStyle = 'rgba(170,110,105,0.8)'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(cx - 52, ey + 6); g.lineTo(cx - 34, ey + 40); g.stroke();
  g.strokeStyle = 'rgba(90,40,35,0.6)'; g.lineWidth = 0.8;
  for (let i = 0; i < 6; i++) { const y = ey + 10 + i * 5.5, x = cx - 50 + i * 3; g.beginPath(); g.moveTo(x - 3, y + 1); g.lineTo(x + 3, y - 1); g.stroke(); }
}, null, 8);

// Hình vũng máu: các vòng tròn chồng nhau quanh tâm + giọt vệ tinh và vệt bắn ra ngoài.
function poolShape(g, seed, cx, cy, size, splash) {
  const r = rng(seed);
  for (let i = 0; i < 10; i++) {
    const a = r() * Math.PI * 2, d = size * 0.22 * r();
    g.beginPath(); g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, size * (0.18 + r() * 0.17), 0, Math.PI * 2); g.fill();
  }
  for (let i = 0; i < (splash ? 10 : 6); i++) {
    const a = r() * Math.PI * 2, d = size * (0.4 + r() * (splash ? 0.3 : 0.15)), s = size * (0.015 + r() * 0.04);
    if (splash) {
      g.lineWidth = s * 0.7; g.lineCap = 'round';
      g.beginPath(); g.moveTo(cx + Math.cos(a) * size * 0.3, cy + Math.sin(a) * size * 0.3);
      g.lineTo(cx + Math.cos(a) * d, cy + Math.sin(a) * d); g.stroke();
    }
    g.beginPath(); g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, s * 1.4, 0, Math.PI * 2); g.fill();
  }
}

// map: màu máu đỏ thẫm, giữa sẫm hơn (lớp dày); bump: cùng hình nhưng làm mờ biên,
// để mép vũng cong lên như mặt khum của chất lỏng và bắt ánh đèn.
export const bloodPool = (seed, splash = false) => {
  const map = make(128, 128, (g) => {
    g.fillStyle = '#6a0408'; g.strokeStyle = '#6a0408';
    poolShape(g, seed, 64, 64, 60, splash);
    g.globalCompositeOperation = 'source-atop';
    const gr = g.createRadialGradient(64, 64, 4, 64, 64, 40);
    gr.addColorStop(0, 'rgba(25,0,2,0.85)'); gr.addColorStop(1, 'rgba(25,0,2,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  }, null, 0);
  const bump = make(128, 128, (g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, 128, 128);
    g.filter = 'blur(2px)';
    g.fillStyle = '#fff'; g.strokeStyle = '#fff';
    poolShape(g, seed, 64, 64, 60, splash);
  }, null, 0);
  bump.colorSpace = THREE.NoColorSpace;
  return { map, bump };
};
