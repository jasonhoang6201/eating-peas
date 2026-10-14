import * as THREE from 'three';
import * as TX from './textures.js';
import { RULES } from './rules.js';
import { head, hat, lathe, glasses, Arm, PINCH_HOLD } from './human.js';

const UP = new THREE.Vector3(0, 1, 0);
const BULB = new THREE.Color(0xfff1c8);
const lam = (o) => new THREE.MeshLambertMaterial(o);
const mesh = (geo, mat) => new THREE.Mesh(geo, mat);
const box = (w, h, d, mat) => mesh(new THREE.BoxGeometry(w, h, d), mat);
const cyl = (rt, rb, h, seg, mat) => mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
const sph = (r, ws, hs, mat) => mesh(new THREE.SphereGeometry(r, ws, hs), mat);
const smooth = (k) => k * k * (3 - 2 * k);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const damp = (dt, rate) => 1 - Math.exp(-dt * rate);
const v3 = (x, y, z) => new THREE.Vector3(x, y, z);

// không dùng áo xanh lá (bị đổi sang màu pea) và áo xám/xanh navy (bị đổi sang dải xám đá của mặt bàn)
export const JERSEY = ['#8a2a2c', '#5b2c63', '#a0703a', '#7c2f3c', '#cdbb98', '#6e5a2a'];
const NUMBERS = ['03', '17', '08', '21', '05', '99'];

// Ghế 0-2 bên trái (x<0), 3-5 bên phải; z từ đầu bàn phía mafia về phía camera.
export function seatInfo(i) {
  const left = i < 3, zs = [-1.6, 0, 1.6];
  return { x: left ? -1.35 : 1.35, z: zs[i % 3], rotY: left ? Math.PI / 2 : -Math.PI / 2 };
}

const MAT = {};
function materials() {
  if (MAT.ready) return MAT;
  Object.assign(MAT, {
    ready: true,
    skin: lam({ color: 0xd4a68c }),
    glove: lam({ color: 0xe6e2d6 }),
    metal: lam({ color: 0xb6b9bd }),
    darkMetal: lam({ color: 0x2c2d2f }),
    pea: lam({ color: 0x6cbf3c }),
    felt: lam({ map: TX.felt() }),
    plateTop: lam({ map: TX.plate() }),
    plateSide: lam({ color: 0xdedbd2 }),
    canLabel: lam({ map: TX.canLabel() }),
    canTop: lam({ map: TX.canTop() }),
    blood: lam({ color: 0x6e0508 }),
    bloodWet: new THREE.MeshPhongMaterial({ color: 0x5a0306, shininess: 120, specular: 0x6a4a4a }),
  });
  return MAT;
}

// Rest / plate / mouth: tọa độ tay phải trong hệ tọa độ thân người (body).
const HAND_REST = v3(0.16, 0.72, 0.52); // nắm tay giơ cao ngang ngực, răng nĩa lơ lửng trên gò pea
const HAND_PLATE = v3(0.1, 0.44, 0.7);
const HAND_MOUTH = v3(0.08, 0.74, 0.45);
// góc quay quanh trục x của nĩa: 0 = răng chĩa lên, π/2 = chĩa tới trước, π = chĩa xuống
const FORK_REST = 3.0, FORK_PLATE = 3.05, FORK_MOUTH = -1.0;
const HATS = ['campaign', 'top', 'bowler', 'campaign', 'cap', 'beanie'];
const SKINS = ['#d6a88e', '#c99a7c', '#e0b9a0', '#b8876a', '#d2a084', '#c8a28a'];
const HAIR = ['#2a1e16', '#4a3524', null, '#1a1612', '#6a5236', '#2e2a26'];
const POLE_R = v3(1, -1, -0.4);
const POLE_L = v3(-1, -1, -0.4);

class Character {
  constructor(world, p, isSelf) {
    const M = materials();
    const s = seatInfo(p.seat);
    this.id = p.id;
    this.plate = world.plates[p.seat];
    const root = this.root = new THREE.Group();
    root.position.set(s.x, 0, s.z);
    root.rotation.y = s.rotY;

    const color = JERSEY[p.seat];
    const shirt = lam({ map: TX.jerseyWrap(color, NUMBERS[p.seat]) });
    const sleeve = lam({ map: TX.cloth(color) });
    const pants = lam({ map: TX.cloth('#2a2d38') });
    const skin = lam({ color: SKINS[p.seat] });
    const faceMat = lam({ map: TX.face({ skin: SKINS[p.seat], seed: p.seat + 1, stubble: p.seat % 2 === 0, hair: HAIR[p.seat] }) });

    for (const x of [-0.12, 0.12]) {
      const thigh = mesh(new THREE.CapsuleGeometry(0.095, 0.32, 6, 12), pants);
      thigh.rotation.x = Math.PI / 2;
      thigh.position.set(x, 0.64, 0.16);
      root.add(thigh);
    }

    const body = this.body = new THREE.Group();
    body.position.set(0, 0.72, -0.05);
    root.add(body);

    // phiStart = 0: đường nối texture ở ngực, số áo ở lưng (phía camera nhìn thấy).
    body.add(lathe([
      [0, 0], [0.22, 0], [0.25, 0.1], [0.24, 0.28], [0.27, 0.44], [0.3, 0.55],
      [0.3, 0.62], [0.24, 0.7], [0.14, 0.74], [0.08, 0.76], [0, 0.76],
    ], shirt, 0.66));
    const neck = cyl(0.062, 0.072, 0.18, 16, skin);
    neck.position.set(0, 0.82, 0.01);
    body.add(neck);

    const headG = this.head = new THREE.Group();
    headG.position.set(0, 0.97, 0.03);
    body.add(headG);
    headG.add(head({ r: 0.19, faceMat, skinMat: skin }));
    const hatG = hat(HATS[p.seat], M.felt);
    // mũ chóp, bowler và lưỡi trai có phần đáy hẹp hơn vành nên phải hạ xuống để ôm sát sọ
    hatG.position.y = { top: -0.045, bowler: -0.035, cap: -0.02 }[HATS[p.seat]] ?? 0;
    headG.add(hatG);
    this.wound = sph(0.06, 12, 8, M.blood);
    this.wound.position.set(0.07, 0.07, 0.15);
    this.wound.visible = false;
    headG.add(this.wound);

    const armOpts = { upper: 0.38, fore: 0.36, rU: 0.068, rF: 0.056, mat: sleeve, handMat: M.glove, handScale: 1.15 };
    this.shoulderR = v3(0.29, 0.6, 0);
    // tay phải nắm cán nĩa (cán dày 1.2cm, lỗ nắm bán kính 1cm trước khi nhân handScale), tay trái thả lỏng trên bàn
    this.armR = new Arm(body, { ...armOpts, pose: 'fist', mirror: true, hole: 0.01 });
    const armL = new Arm(body, armOpts);
    armL.solve(v3(-0.29, 0.6, 0), v3(-0.18, 0.12, 0.5), POLE_L);

    // Nĩa: trục +y của group hướng từ tay tới đầu răng nĩa. Nĩa to cỡ nĩa xiên thịt (răng cách nhau 3.4cm)
    // để nhìn từ camera vẫn thấy pea. Răng dài 13cm, mỗi răng xâu 4 pea; pea thứ i nằm ở răng i % 4,
    // tầng floor(i / 4) (tầng 0 gần đầu răng).
    const fork = this.fork = new THREE.Group();
    const handle = box(0.022, 0.2, 0.012, M.metal); handle.position.y = 0.1;
    const neckF = box(0.125, 0.025, 0.012, M.metal); neckF.position.y = 0.21;
    fork.add(handle, neckF);
    const TINE_X = [-0.051, -0.017, 0.017, 0.051];
    for (const x of TINE_X) {
      const tine = box(0.007, 0.13, 0.007, M.metal);
      tine.position.set(x, 0.285, 0);
      fork.add(tine);
    }
    this.forkPeas = [...Array(RULES.FORK_MAX)].map((_, i) => {
      const pea = sph(0.016, 10, 8, M.pea);
      pea.position.set(TINE_X[i % 4], 0.33 - Math.floor(i / 4) * 0.03, 0);
      pea.visible = false;
      fork.add(pea);
      return pea;
    });
    body.add(fork);

    // Tên nằm ở layer TAG_LAYER: RetroPost vẽ layer này sau bước đổi bảng màu, nên giữ đúng màu.
    // Người đang chơi: chữ vàng. Người khác và bot: chữ trắng. Cùng cỡ chữ.
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({
      map: TX.label(p.name, isSelf ? '#ffd54a' : '#ffffff'),
      depthTest: false, transparent: true, fog: false,
    }));
    tag.scale.set(0.63, 0.1575, 1);
    tag.position.set(0, 2.15, 0);
    tag.renderOrder = 10;
    tag.layers.set(TAG_LAYER);
    root.add(tag);
    this.tag = tag;

    world.scene.add(root);
    this.hand = HAND_REST.clone();
    this.forkA = FORK_REST;
    this.lean = 0;
    this.deadT = -1;
  }

  headWorld(out) { return this.head.getWorldPosition(out); }

  kill() {
    this.deadT = 0;
    this.wound.visible = true;
  }

  update(dt, p, t) {
    if (!p) return;
    const el = (t - p.stAt) / 1000;
    let target = HAND_REST, a = FORK_REST, onFork = p.fork, nod = 0, lean = 0;

    if (this.deadT >= 0) {
      // Ngã sấp mặt xuống đĩa trong 0.25s.
      this.deadT += dt;
      const k = smooth(clamp01(this.deadT / 0.25));
      this.body.rotation.x = k * 1.22;
      this.head.rotation.z = k * 0.4;
      this.head.rotation.x = k * 0.25;
      target = v3(0.34, 0.1, 0.6); a = 1.7;
      this.tag.material.opacity = 0.35;
    } else if (p.st === 'poking') {
      // Mỗi lần xiên tay đi hết một vòng theo thời gian k (0..1):
      // 0–35% hạ từ HAND_REST xuống trên đĩa, 35–60% đâm xuống rồi rút lên (chạm đĩa ở POKE_HIT = 47%),
      // 60–100% đưa tay về lại HAND_REST.
      const k = clamp01(el / RULES.POKE);
      const down = smooth(clamp01(k / 0.35)) * (1 - smooth(clamp01((k - 0.6) / 0.4)));
      target = HAND_REST.clone().lerp(HAND_PLATE, down);
      target.y += 0.04 * down - 0.1 * Math.sin(Math.PI * clamp01((k - 0.35) / 0.25));
      a = FORK_REST + (FORK_PLATE - FORK_REST) * down;
      lean = 0.18 * down; nod = 0.25 * down;
    } else if (p.st === 'eating') {
      const k = clamp01(el / RULES.EAT);
      const ph = smooth(clamp01(k / 0.6));
      target = HAND_REST.clone().lerp(HAND_MOUTH, ph);
      a = FORK_REST + (FORK_MOUTH - FORK_REST) * ph;
      if (k > 0.7) onFork = 0;
      nod = 0.12 * ph + (k > 0.6 ? 0.06 * Math.sin(k * 40) : 0);
    }

    const f = damp(dt, 20);
    this.hand.lerp(target, f);
    this.forkA += (a - this.forkA) * f;
    if (this.deadT < 0) {
      this.lean += (lean - this.lean) * f;
      this.body.rotation.x = this.lean;
      this.head.rotation.x += (nod - this.head.rotation.x) * f;
    }
    // nắm ngược: ngón cái chỉ về đầu cán (ngược hướng răng nĩa), răng nĩa chĩa ra phía ngón út
    const axis = v3(0, Math.cos(this.forkA), Math.sin(this.forkA));
    this.armR.solve(this.shoulderR, this.hand, POLE_R, { thumb: axis.clone().negate() });
    this.fork.rotation.x = this.forkA;
    // cán nĩa bắt đầu ở gốc group; lùi gốc 10cm theo trục nĩa để nắm tay ôm giữa cán (cán 20cm),
    // nửa cán thò lên trên nắm tay, nửa còn lại và răng nĩa ở dưới
    this.fork.position.copy(this.armR.grip).addScaledVector(axis, -0.1);
    this.forkPeas.forEach((pea, i) => { pea.visible = i < onFork; });
    this.plate.peas.count = Math.max(0, RULES.PLATE - p.peas - p.fork);
  }

  dispose(scene) { scene.remove(this.root); }
}

const TAG_LAYER = 1;
const GUN_GRIP = v3(0, -0.16, -0.05);
const RACK_PULL = 0.9; // giây tới tiếng kéo khóa nòng trong file reload (sau khi cắt 40ms im lặng đầu)
export const SHOT_FIRE = 1.8; // giây từ lệnh shot tới lúc nổ súng
const PAPER_UP = v3(0, 2.32, 0.6);
const RACK_HAND = v3(0.82, 1.78, 0.5);
const PAPER_DOWN = v3(-0.05, 1.45, 0.68);

class Mafia {
  constructor(scene) {
    const M = materials();
    const root = this.root = new THREE.Group();
    root.position.set(0, 0, -3.35);
    root.scale.setScalar(1.2);
    scene.add(root);

    const suit = lam({ map: TX.cloth('#272b32') });
    const suitBody = lam({ map: TX.suitWrap() });
    const skinHex = '#a88b7c'; // da ngả xám như ảnh mẫu
    const skin = lam({ color: skinHex });
    const faceMat = lam({ map: TX.mafiaFace(skinHex) });
    const shoe = lam({ color: 0x141414 });

    for (const x of [-0.21, 0.21]) {
      const leg = cyl(0.15, 0.13, 1.0, 16, suit); leg.position.set(x, 0.5, 0);
      const foot = sph(1, 14, 10, shoe); foot.scale.set(0.11, 0.07, 0.2); foot.position.set(x, 0.06, 0.07);
      root.add(leg, foot);
    }
    // phiStart = π: đường nối texture ở lưng, sơ mi và cà vạt ở ngực.
    const torso = lathe([
      [0, 0], [0.4, 0], [0.5, 0.15], [0.57, 0.36], [0.56, 0.56], [0.52, 0.74],
      [0.55, 0.88], [0.5, 0.98], [0.32, 1.07], [0.17, 1.13], [0, 1.14],
    ], suitBody, 0.72, Math.PI);
    torso.position.y = 0.98;
    root.add(torso);
    // cổ to gần bằng đầu, đầu lún xuống vai
    const neck = cyl(0.21, 0.27, 0.2, 20, skin); neck.position.y = 2.1;
    root.add(neck);

    const headG = this.head = new THREE.Group();
    headG.position.set(0, 2.33, 0.05);
    root.add(headG);
    headG.add(head({ r: 0.29, faceMat, skinMat: skin, jowls: true, brute: true }));
    headG.add(glasses(0.29));

    this.shL = v3(-0.5, 1.95, 0);
    this.shR = v3(0.5, 1.95, 0);
    const armOpts = { upper: 0.48, fore: 0.44, rU: 0.13, rF: 0.105, mat: suit, handMat: skin, handScale: 1.7 };
    // tay trái kẹp mép trái tờ báo, tay phải nắm báng súng (báng dày 8cm: lỗ nắm 2.4cm x handScale 1.7)
    this.armL = new Arm(root, { ...armOpts, pose: 'pinch' });
    this.armR = new Arm(root, { ...armOpts, pose: 'fist', mirror: true, hole: 0.024 });
    this.handRPos = v3(0.62, 1.22, 0.22); // vị trí tâm báng súng trong tay
    this.handScale = armOpts.handScale;

    // Tờ báo gập đôi thành hình chữ V, mỗi nửa dùng nửa texture.
    const paperTex = TX.newspaper();
    const paper = this.paper = new THREE.Group();
    for (const side of [-1, 1]) {
      const tex = paperTex.clone();
      tex.repeat.set(0.5, 1);
      tex.offset.set(side < 0 ? 0 : 0.5, 0);
      tex.needsUpdate = true;
      const half = mesh(new THREE.PlaneGeometry(0.42, 1.0), lam({ map: tex, side: THREE.DoubleSide }));
      half.position.set(side * 0.2, 0, 0.03);
      half.rotation.y = -side * 0.18;
      paper.add(half);
    }
    paper.position.copy(PAPER_UP);
    root.add(paper);
    this.paperHalfL = paper.children[0];
    this.paperHalfL.updateMatrix();

    // Súng lục đen cỡ lớn (kiểu Desert Eagle), to gấp ~1.5 lần bản cũ, nòng hướng theo +z của group để dùng lookAt.
    // Thép đen dùng Phong có specular để cạnh súng bắt ánh đèn; rãnh kéo khóa nòng màu xám sáng hơn như ảnh mẫu.
    const gun = this.gun = new THREE.Group();
    const steel = new THREE.MeshPhongMaterial({ color: 0x1c1d20, shininess: 70, specular: 0x5a5c62 });
    const steelLite = new THREE.MeshPhongMaterial({ color: 0x55585e, shininess: 40, specular: 0x666666 });
    const gripMat = lam({ color: 0x18181a });
    const slide = box(0.1, 0.11, 0.52, steel); slide.position.set(0, 0.03, 0.14);
    const frame = box(0.09, 0.06, 0.42, steel); frame.position.set(0, -0.05, 0.12);
    const muzzle = cyl(0.03, 0.03, 0.03, 16, steel); muzzle.rotation.x = Math.PI / 2; muzzle.position.set(0, 0.03, 0.41);
    const bore = cyl(0.016, 0.016, 0.01, 12, lam({ color: 0x000000 })); bore.rotation.x = Math.PI / 2; bore.position.set(0, 0.03, 0.427);
    const grip = box(0.07, 0.26, 0.08, gripMat); grip.position.set(0, -0.19, -0.06); grip.rotation.x = 0.2;
    const guard = mesh(new THREE.TorusGeometry(0.05, 0.01, 8, 16, Math.PI), steel);
    guard.rotation.set(Math.PI, Math.PI / 2, 0); guard.position.set(0, -0.08, 0.04);
    const trigger = box(0.012, 0.05, 0.015, steelLite); trigger.position.set(0, -0.1, 0.03); trigger.rotation.x = 0.3;
    const hammer = box(0.03, 0.04, 0.03, steel); hammer.position.set(0, 0.07, -0.13);
    const sightF = box(0.014, 0.025, 0.02, steel); sightF.position.set(0, 0.095, 0.38);
    const sightR = box(0.05, 0.025, 0.02, steel); sightR.position.set(0, 0.095, -0.09);
    // khóa nòng (thân trên, rãnh kéo, đầu ngắm) nằm trong group riêng để animation lên đạn kéo lùi được
    const slideG = this.slideG = new THREE.Group();
    slideG.add(slide, sightF, sightR);
    for (let i = 0; i < 8; i++) {
      const groove = box(0.102, 0.075, 0.008, steelLite);
      groove.position.set(0, 0.035, -0.1 + i * 0.016);
      slideG.add(groove);
    }
    gun.add(slideG, frame, muzzle, bore, grip, guard, trigger, hammer);
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: TX.glow(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }));
    this.flash.position.set(0, 0.03, 0.52);
    this.flash.scale.set(0.7, 0.7, 1);
    this.flash.visible = false;
    this.flashLight = new THREE.PointLight(0xffb060, 0, 8, 2);
    this.flashLight.position.set(0, 0.03, 0.55);
    gun.add(this.flash, this.flashLight);
    root.add(gun);

    this.pk = 0; this.gk = 0; this.flashT = 0;
    this.shots = [];
    this.tmp = new THREE.Vector3();
  }

  // Trình tự một phát bắn (giây tính từ lúc host gửi lệnh shot):
  // 0      gọi onRack (phát asset/gunreload.mp3 đã cắt im lặng, dài ~1.1s), súng đưa ra mép phải tờ báo;
  //        trong file: 0.12 và 0.25 là tiếng lắp băng đạn, 0.85–1.06 là tiếng kéo và thả khóa nòng,
  //        nên khóa nòng lùi 7cm ở RACK_PULL (0.9) rồi bật về ở RACK_PULL + 0.12;
  // 1.15   tay và đầu quay dần về nạn nhân, tới 1.6 thì súng chĩa thẳng vào đầu;
  // 1.8    nổ súng (onFire), giữ súng chĩa vào nạn nhân tới 3.8 rồi bỏ shot khỏi hàng đợi.
  queueShot(target, onRack, onFire) { this.shots.push({ target, t: 0, racked: false, fired: false, onRack, onFire }); }

  update(dt, m, t) {
    const el = (t - m.at) / 1000;
    let pk = 0, gk = 0;
    if (m.phase === 'warning') pk = 0.42;
    else if (m.phase === 'watching') { pk = 1; gk = 1; }

    const shot = this.shots[0];
    if (shot) {
      pk = 1; gk = 1;
      shot.t += dt;
      if (!shot.racked) { shot.racked = true; shot.onRack(); }
      if (!shot.fired && shot.t >= SHOT_FIRE) { shot.fired = true; this.flashT = 0.08; shot.onFire(); }
      if (shot.t >= SHOT_FIRE + 2.0) this.shots.shift();
    }
    // aimK: 0 = tư thế cầm súng bình thường, 1 = chĩa thẳng vào nạn nhân
    const aimK = shot ? smooth(clamp01((shot.t - 1.15) / 0.45)) : 0;
    const rackK = shot ? clamp01((shot.t - RACK_PULL + 0.06) / 0.06) * (1 - clamp01((shot.t - RACK_PULL - 0.1) / 0.03)) : 0;
    this.slideG.position.z = -0.07 * rackK;
    this.pk += (pk - this.pk) * damp(dt, m.phase === 'warning' ? 9 : 7);
    this.gk += (gk - this.gk) * damp(dt, 8);

    const paper = this.paper;
    paper.position.lerpVectors(PAPER_UP, PAPER_DOWN, this.pk);
    paper.rotation.x = 0.12 - 0.7 * this.pk;
    paper.rotation.z = m.phase === 'warning' ? Math.sin(t * 0.05) * 0.04 : 0;
    if (m.phase === 'reading') {
      paper.position.y += Math.sin(t * 0.0013) * 0.012;
      paper.rotation.y = Math.max(0, Math.sin(t * 0.0007)) ** 20 * 0.25; // thỉnh thoảng lật trang
    } else paper.rotation.y = 0;
    paper.updateMatrix();

    // Kẹp báo: điểm kẹp cách mép trái nửa tờ 4cm. Ngón tay duỗi vào trong tờ báo (+x của nửa tờ),
    // ngón cái ở mặt sau phía mafia đọc (-z), 4 ngón ở mặt trước phía camera. Cổ tay = điểm kẹp lùi PINCH_HOLD.
    const half = this.paperHalfL;
    const halfQ = paper.quaternion.clone().multiply(half.quaternion);
    const hy = v3(1, 0, 0).applyQuaternion(halfQ), hz = v3(0, 0, -1).applyQuaternion(halfQ);
    const handQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(hy, hz), hy, hz));
    const hold = v3(-0.17, -0.12, 0).applyMatrix4(half.matrix).applyMatrix4(paper.matrix);
    const wristL = hold.sub(PINCH_HOLD.clone().multiplyScalar(this.handScale).applyQuaternion(handQ));
    this.armL.solve(this.shL, wristL, v3(-1, -0.6, -0.5), { quat: handQ });

    const handR = new THREE.Vector3().lerpVectors(v3(0.6, 1.15, 0.2), v3(0.45, 1.7, 0.66), this.gk);
    // lúc lên đạn: đưa súng ra ngoài mép phải tờ báo, ngang vai, để mọi người thấy khóa nòng bị kéo
    const rackPose = shot ? smooth(clamp01(shot.t / 0.12)) : 0;
    if (rackPose > 0) handR.lerp(RACK_HAND, rackPose);
    if (aimK > 0) {
      const local = this.root.worldToLocal(shot.target.clone());
      handR.lerp(local.sub(this.shR).normalize().multiplyScalar(0.82).add(this.shR), aimK);
    }
    this.handRPos.lerp(handR, damp(dt, 25));
    const G = this.handRPos;
    const aimDir = v3(0, -0.9 + 0.9 * this.gk, 0.5).lerp(v3(0.15, 0.55, 0.35), rackPose);
    const aimAt = this.root.localToWorld(G.clone().add(aimDir));
    if (aimK > 0) aimAt.lerp(shot.target, aimK);
    // Súng: quay nòng về aimAt rồi đặt sao cho tâm báng (GUN_GRIP) nằm ở G.
    // lookAt hai lần vì dời vị trí làm hướng ngắm lệch đi một chút.
    for (let i = 0; i < 2; i++) {
      this.gun.lookAt(aimAt);
      this.gun.position.copy(G).sub(GUN_GRIP.clone().applyQuaternion(this.gun.quaternion));
    }
    // Bàn tay phải theo súng: ngón cái chỉ lên đỉnh báng (trục báng nghiêng 0.2 rad), lòng bàn tay áp vào
    // mặt phải báng nên hướng sang trái súng (-x); 4 ngón vòng qua mặt trước báng, dưới cò súng.
    const gq = this.gun.quaternion;
    const thumbUp = v3(0, Math.cos(0.2), Math.sin(0.2)).applyQuaternion(gq);
    const n = v3(-1, 0, 0).applyQuaternion(gq);
    const gx = thumbUp.negate(), gy = new THREE.Vector3().crossVectors(n, gx);
    const gunHandQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(gx, gy, n));
    const wristR = G.clone().sub(this.armR.fistC.clone().applyQuaternion(gunHandQ));
    this.armR.solve(this.shR, wristR, v3(1, -0.8, -0.4), { quat: gunHandQ });

    if (m.phase === 'watching') this.head.rotation.set(0.2, Math.sin(el * 1.8) * 0.55, 0);
    else this.head.rotation.set(0.3, 0, 0);
    if (aimK > 0) {
      const q = this.head.quaternion.clone();
      this.head.lookAt(shot.target);
      this.head.quaternion.copy(q.slerp(this.head.quaternion, aimK));
    }

    this.flashT -= dt;
    this.flash.visible = this.flashT > 0;
    this.flashLight.intensity = this.flashT > 0 ? 60 : 0;
  }
}

// Bảng màu giới hạn lấy theo Buckshot Roulette: đen ngả đỏ, dải nâu đỏ, đỏ máu, hồng nhạt, kem, xanh olive,
// thêm 3 màu xanh pea (tối, vừa, sáng) để pea có khối sáng tối, không bị gộp vào màu olive.
const PALETTE = [
  '#080404', '#170a09', '#271211', '#3a1a18', '#522523', '#6c312d', '#8a1d1b', '#8c4c43',
  '#ad7a6c', '#cfae98', '#ece0c8', '#262b1d', '#3e4630', '#5a6342', '#7d8158', '#3d2b22',
  '#4a6a26', '#6f8f3e', '#9cc25a',
  // xám đá lạnh cho mặt bàn (6 mức, 2 mức sáng nhất cho vùng ngay dưới đèn treo),
  // trắng lạnh và xanh dương cho đĩa sứ hoa văn xanh
  '#1d2228', '#2c343d', '#3f4955', '#5a6674', '#727c88', '#8c949c', '#e4e8e8', '#4660a8',
].map((h) => new THREE.Color(h));

// Hậu kỳ kiểu Buckshot Roulette:
// 1. Scene vẽ vào render target nhỏ (cao TARGET_H pixel), phóng ra màn hình bằng NearestFilter: pixel to, cạnh sắc.
// 2. Mỗi pixel thấp: chuyển linear sang sRGB, tăng độ sáng/tương phản, làm tối 4 góc.
// 3. Cộng nhiễu Bayer 4x4 theo lưới pixel thấp rồi chọn màu gần nhất trong PALETTE (ordered dither).
const TARGET_H = 1000;
class RetroPost {
  constructor() {
    this.rt = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter,
    });
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.rt.texture },
        lowRes: { value: new THREE.Vector2(1, 1) },
        palette: { value: PALETTE },
        spread: { value: 0.05 },
        exposure: { value: 1.15 },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        uniform sampler2D tDiffuse; uniform vec2 lowRes; uniform vec3 palette[${PALETTE.length}];
        uniform float spread; uniform float exposure; varying vec2 vUv;
        float bayer2(vec2 a){ a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
        float bayer4(vec2 a){ return bayer2(0.5 * a) * 0.25 + bayer2(a); }
        vec3 toSRGB(vec3 c){
          c = max(c, 0.0);
          return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
        }
        void main(){
          vec2 px = floor(vUv * lowRes);
          vec2 uv = (px + 0.5) / lowRes;
          vec3 c = toSRGB(texture2D(tDiffuse, uv).rgb * exposure);
          c = clamp((c - 0.4) * 1.15 + 0.4, 0.0, 1.0);
          float vig = 1.0 - smoothstep(0.35, 0.85, length(uv - 0.5));
          c *= mix(0.45, 1.0, vig);
          c += (bayer4(px) - 0.5) * spread;
          // màu gần nhất theo khoảng cách RGB (không trọng số, để màu xám ấm rơi về dải nâu đỏ)
          vec3 best = palette[0]; float bd = 1e9;
          for (int i = 0; i < ${PALETTE.length}; i++) {
            vec3 d = c - palette[i];
            float dist = dot(d, d);
            if (dist < bd) { bd = dist; best = palette[i]; }
          }
          gl_FragColor = vec4(best, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.quad.frustumCulled = false;
    this.qScene = new THREE.Scene();
    this.qScene.add(this.quad);
    this.qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  setSize(renderer) {
    const v = renderer.getDrawingBufferSize(new THREE.Vector2());
    const scale = Math.max(1, v.y / TARGET_H);
    const w = Math.round(v.x / scale), h = Math.round(v.y / scale);
    this.rt.setSize(w, h);
    this.mat.uniforms.lowRes.value.set(w, h);
  }
  // camera mặc định chỉ thấy layer 0; tên người chơi (TAG_LAYER) vẽ thẳng lên màn hình sau quad,
  // không qua bảng màu và không pixel hóa
  render(renderer, scene, camera) {
    renderer.setRenderTarget(this.rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(this.qScene, this.qCam);
    // gỡ background tạm thời: nếu không, lượt vẽ này tô màu nền đè lên ảnh vừa vẽ
    const bg = scene.background;
    scene.background = null;
    renderer.autoClear = false;
    camera.layers.set(TAG_LAYER);
    renderer.render(scene, camera);
    camera.layers.set(0);
    renderer.autoClear = true;
    scene.background = bg;
  }
}

export class World {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
    this.post = new RetroPost();
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x050404);
    this.scene.fog = new THREE.Fog(0x050404, 5.2, 12.5);
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.05, 40);
    this.camBase = v3(0, 2.5, 4.6);
    this.camLook = v3(0, 1.45, -2.0);
    this.stunT = -1; // giây đã trôi từ lúc choáng; -1 = không choáng
    this.tmpLook = new THREE.Vector3();

    // Nguồn sáng chính là đèn treo trên bàn (decay 2, tắt dần ngoài ~4m), tường và kệ chìm trong tối.
    this.scene.add(new THREE.AmbientLight(0x4a4c5a, 0.54));
    const lamp = this.lamp = new THREE.PointLight(0xffd29a, 43.2, 9, 2);
    lamp.position.set(0, 3.3, -0.4);
    this.lampBase = 43.2;
    this.flickerT = 0;
    const back = new THREE.PointLight(0x8a9ad0, 4.5, 7.5, 2);
    back.position.set(1.8, 3.2, -4.6);
    const fill = new THREE.DirectionalLight(0xb0b8c8, 0.33);
    fill.position.set(-2, 4, 6);
    const boss = new THREE.PointLight(0xffd8b0, 14, 5, 2);
    boss.position.set(0.4, 3.0, -2.0);
    // spot trắng lạnh thẳng xuống mặt bàn, góc 34°, phủ 6 đĩa: đĩa và pea sáng hơn phần còn lại của phòng,
    // ánh lạnh giữ mặt bàn ở dải xám đá thay vì bị đèn treo vàng kéo về nâu đỏ
    const tableSpot = new THREE.SpotLight(0xdde8f4, 8, 7, 0.6, 0.5, 1.5);
    tableSpot.position.set(0, 3.6, 0.2);
    tableSpot.target.position.set(0, 0.8, 0.2);
    this.scene.add(lamp, back, fill, boss, tableSpot, tableSpot.target);

    this.plates = [];
    this.chars = [];
    this.fx = [];
    this.buildRoom();
    this.buildTable();
    this.mafia = new Mafia(this.scene);

    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    this.post.setSize(this.renderer);
    this.camera.aspect = w / h;
    // màn hình dọc (điện thoại) cần FOV rộng hơn để thấy cả bàn
    this.camera.fov = w / h < 1 ? 70 : 48;
    this.camera.updateProjectionMatrix();
  }

  buildRoom() {
    const S = this.scene;
    const wallM = lam({ map: TX.wall() });
    const floorM = lam({ map: TX.floor() });
    const floor = mesh(new THREE.PlaneGeometry(14, 14), floorM);
    floor.rotation.x = -Math.PI / 2;
    const back = mesh(new THREE.PlaneGeometry(12, 5), wallM);
    back.position.set(0, 2.5, -5.4);
    const left = mesh(new THREE.PlaneGeometry(12, 5), wallM);
    left.position.set(-4.6, 2.5, 0); left.rotation.y = Math.PI / 2;
    const right = left.clone();
    right.position.x = 4.6; right.rotation.y = -Math.PI / 2;
    const ceil = mesh(new THREE.PlaneGeometry(12, 14), lam({ color: 0x1a1816 }));
    ceil.rotation.x = Math.PI / 2; ceil.position.y = 4.8;
    S.add(floor, back, left, right, ceil);

    const pipeM = lam({ color: 0x4a4038 });
    for (const y of [3.9, 4.2]) {
      const pipe = cyl(0.06, 0.06, 12, 6, pipeM);
      pipe.rotation.z = Math.PI / 2; pipe.position.set(0, y, -5.3);
      S.add(pipe);
    }

    this.shelf(-3.9, -1.5);
    this.shelf(1.6, 3.9);

    // ghế xếp chồng ở góc phải như trong ảnh
    const chairM = lam({ color: 0x3b3a37 });
    for (let i = 0; i < 3; i++) {
      const c = this.chair(chairM);
      c.position.set(3.1 + i * 0.1, i * 0.25, -3.6 + i * 0.15);
      c.rotation.set(0.1 * i, -0.8 + i * 0.3, (i - 1) * 0.15);
      S.add(c);
    }

    // đèn treo trên bàn
    const cord = cyl(0.01, 0.01, 1.3, 4, lam({ color: 0x111111 }));
    cord.position.set(0, 4.15, -0.4);
    const shade = mesh(new THREE.ConeGeometry(0.35, 0.25, 10, 1, true), lam({ color: 0x2f3a2c, side: THREE.DoubleSide }));
    shade.position.set(0, 3.45, -0.4);
    const bulb = this.bulb = sph(0.08, 12, 8, new THREE.MeshBasicMaterial({ color: 0xfff1c8 }));
    bulb.position.set(0, 3.33, -0.4);
    S.add(cord, shade, bulb);
  }

  chair(mat) {
    const g = new THREE.Group();
    const seat = box(0.48, 0.05, 0.46, mat); seat.position.y = 0.5;
    const backr = box(0.48, 0.45, 0.05, mat); backr.position.set(0, 0.78, -0.21);
    g.add(seat, backr);
    for (const x of [-0.21, 0.21]) for (const z of [-0.2, 0.2]) {
      const leg = box(0.04, 0.5, 0.04, mat); leg.position.set(x, 0.25, z); g.add(leg);
    }
    return g;
  }

  can(standing = true) {
    const M = materials();
    const c = mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.27, 20), [M.canLabel, M.canTop, M.canTop]);
    c.position.y = standing ? 0.135 : 0.11;
    const g = new THREE.Group(); g.add(c);
    return g;
  }

  shelf(x0, x1) {
    const r = TX.rng(Math.round(x0 * 100) + 500);
    const frameM = lam({ color: 0x3a3936 });
    const boardM = lam({ color: 0x4d4a44 });
    const w = x1 - x0, cx = (x0 + x1) / 2, z = -5.0;
    for (const x of [x0, x1]) for (const dz of [-0.25, 0.25]) {
      const post = box(0.05, 3.2, 0.05, frameM); post.position.set(x, 1.6, z + dz); this.scene.add(post);
    }
    const boxes = [1, 2, 3, 4].map((s) => lam({ map: TX.cardboard(s * 17) }));
    for (const y of [0.25, 1.0, 1.75, 2.5, 3.15]) {
      const b = box(w, 0.04, 0.6, boardM); b.position.set(cx, y, z); this.scene.add(b);
      let x = x0 + 0.1;
      while (x < x1 - 0.3 && y < 3) {
        if (r() < 0.45) {
          const bw = 0.4 + r() * 0.35, bh = 0.35 + r() * 0.3;
          const bx = box(bw, bh, 0.45, boxes[(r() * 4) | 0]);
          bx.position.set(x + bw / 2, y + 0.02 + bh / 2, z); bx.rotation.y = (r() - 0.5) * 0.15;
          this.scene.add(bx); x += bw + 0.05;
        } else {
          const n = 2 + ((r() * 3) | 0);
          for (let i = 0; i < n; i++) {
            const c = this.can(); c.position.set(x + 0.12 + i * 0.23, y + 0.02, z + (r() - 0.5) * 0.2);
            this.scene.add(c);
          }
          x += n * 0.23 + 0.1;
        }
      }
    }
  }

  buildTable() {
    const M = materials();
    const S = this.scene;
    const tableTop = lam({ map: TX.table() });
    const tableSide = lam({ color: 0x55564f });
    const top = mesh(new THREE.BoxGeometry(2.0, 0.06, 5.4), [tableSide, tableSide, tableTop, tableSide, tableSide, tableSide]);
    top.position.set(0, 0.77, 0);
    S.add(top);
    for (const x of [-0.92, 0.92]) for (const z of [-2.6, 2.6]) {
      const leg = box(0.07, 0.74, 0.07, M.darkMetal); leg.position.set(x, 0.37, z); S.add(leg);
    }

    const chairM = lam({ color: 0x2f2e2c });
    const peaGeo = new THREE.SphereGeometry(0.026, 14, 10);
    const tmp = new THREE.Object3D();
    for (let i = 0; i < RULES.SEATS; i++) {
      const s = seatInfo(i);
      const seat = new THREE.Group();
      seat.position.set(s.x, 0, s.z); seat.rotation.y = s.rotY;
      const chair = this.chair(chairM); chair.position.z = -0.12; chair.scale.setScalar(1.15);
      seat.add(chair);

      const plate = new THREE.Group();
      plate.position.set(0, 0.8, 0.74);
      plate.add(mesh(new THREE.CylinderGeometry(0.25, 0.19, 0.03, 32), [M.plateSide, M.plateTop, M.plateSide]));
      const peas = new THREE.InstancedMesh(peaGeo, M.pea, RULES.PLATE);
      // Đĩa đầy: pea xếp thành gò, bán kính 0.2, giữa cao 8cm (y = 0.04 + h, h = 0.08 * (1 - (d / 0.2)^2)).
      // Sắp xếp theo độ cao tăng dần: InstancedMesh chỉ vẽ instance 0..count-1 nên pea trên đỉnh mất trước.
      const r = TX.rng(i * 31 + 7);
      const pts = [...Array(RULES.PLATE)].map(() => {
        const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 0.2;
        return v3(Math.cos(a) * d, 0.04 + r() * 0.08 * (1 - (d / 0.2) ** 2), Math.sin(a) * d);
      }).sort((p, q) => p.y - q.y);
      pts.forEach((pt, k) => { tmp.position.copy(pt); tmp.updateMatrix(); peas.setMatrixAt(k, tmp.matrix); });
      plate.add(peas);
      seat.add(plate);
      S.add(seat);
      this.plates.push({ group: plate, peas });
    }

    // lon pea trên bàn, một lon đổ ra
    const c1 = this.can(); c1.position.set(-0.2, 0.8, 0.75);
    const c2 = this.can(false); c2.position.set(0.25, 0.8, 0.25);
    c2.children[0].rotation.z = Math.PI / 2; c2.rotation.y = 0.6;
    const c3 = this.can(); c3.position.set(0.3, 0.8, -1.0);
    S.add(c1, c2, c3);
    const spill = new THREE.InstancedMesh(peaGeo, M.pea, 22);
    const r = TX.rng(99);
    for (let k = 0; k < 22; k++) {
      tmp.position.set(0.35 + r() * 0.4, 0.826, 0.4 + r() * 0.45);
      tmp.updateMatrix(); spill.setMatrixAt(k, tmp.matrix);
    }
    S.add(spill);
  }

  setPlayers(list, selfId) {
    for (const c of this.chars) c.dispose(this.scene);
    for (const f of this.fx) this.scene.remove(f.obj);
    this.fx = [];
    this.chars = list.map((p) => new Character(this, p, p.id === selfId));
    for (const pl of this.plates) pl.peas.count = RULES.PLATE;
  }

  charOf(id) { return this.chars.find((c) => c.id === id); }

  // Vũng máu: Phong shininess cao + bump map mép vũng, nên đèn treo tạo vệt phản chiếu như chất lỏng.
  // grow > 0: vũng loang từ 15% lên kích thước đầy đủ trong grow giây (ease-out).
  splatAt(pos, size, { grow = 0, splash = false, normal = null } = {}) {
    const seed = (Math.random() * 1e6) | 0;
    const { map, bump } = TX.bloodPool(seed, splash);
    const m = mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshPhongMaterial({
      map, bumpMap: bump, bumpScale: 5, shininess: 160, specular: 0x9a6a6a,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 - this.fx.length * 0.01,
    }));
    if (normal) m.lookAt(pos.clone().add(normal));
    else m.rotation.x = -Math.PI / 2;
    m.rotateZ(Math.random() * Math.PI * 2);
    m.position.copy(pos);
    if (grow) m.scale.setScalar(0.15);
    this.scene.add(m);
    this.fx.push({ obj: m, life: Infinity, grow, t: 0 });
  }

  // Mafia lên đạn, chĩa súng vào nạn nhân rồi bắn (mốc thời gian ở Mafia.queueShot).
  // onRack chạy lúc bắt đầu lên đạn, onFire chạy đúng lúc nổ súng.
  shoot(id, onRack, onFire) {
    const c = this.charOf(id);
    if (!c) { onRack?.(); onFire?.(); return; }
    const target = c.headWorld(new THREE.Vector3());
    this.mafia.queueShot(target, () => onRack?.(), () => {
      c.kill();
      // mọi client bị choáng như nhau, nên lúc bắn không ai biết ai bị bắn
      this.stun();
      const plate = c.plate.group.getWorldPosition(new THREE.Vector3());
      // vũng dưới đầu loang trong 4s, vết bắn tóe quanh đĩa
      // dời vũng về phía giữa bàn (hướng x của tâm bàn) để không bị đầu người chết che hết
      const inward = v3(-Math.sign(plate.x) * 0.25, 0, 0);
      this.splatAt(plate.clone().add(inward).setY(0.806), 1.4, { grow: 5 });
      this.splatAt(plate.clone().add(v3((Math.random() - 0.5) * 0.4, 0, (Math.random() - 0.5) * 0.4)).setY(0.805), 0.7, { splash: true });
      // đạn xuyên ra sau đầu: máu bắn lên sàn phía sau ghế theo hướng viên đạn
      const dir = target.clone().sub(this.mafia.gun.getWorldPosition(new THREE.Vector3())).setY(0).normalize();
      this.splatAt(target.clone().addScaledVector(dir, 1.3).setY(0.012), 1.1, { splash: true });
      const geo = new THREE.SphereGeometry(0.014, 8, 6);
      const mat = materials().bloodWet;
      for (let i = 0; i < 40; i++) {
        const d = mesh(geo, mat);
        d.position.copy(target);
        const spread = v3((Math.random() - 0.5) * 2.4, Math.random() * 2.4, (Math.random() - 0.5) * 2.4);
        const vel = spread.addScaledVector(dir, 1.5 + Math.random() * 2);
        this.scene.add(d);
        this.fx.push({ obj: d, vel, life: 2 });
      }
      onFire?.();
    });
  }

  // Mốc choáng: hất xuống gầm bàn bên phải, lảo đảo sang trái qua bàn, phải, trái, rồi ngẩng về.
  // Biên độ trái/phải nhân hệ số ngẫu nhiên 0.8–1.2 để mỗi phát súng lắc hơi khác nhau.
  stun() {
    const r = () => 0.8 + Math.random() * 0.4;
    const base = this.camLook;
    this.stunKeys = [
      { t: 0, look: base, roll: 0, drop: 0, side: 0 },
      { t: 0.3, look: v3(1.25 * r(), 0.05, 2.1), roll: -0.28, drop: 0.35, side: 0.15 },
      { t: 0.65, look: v3(-1.3 * r(), 0.3, 0.4), roll: 0.22 * r(), drop: 0.25, side: -0.12 },
      { t: 0.95, look: v3(0.9 * r(), 0.6, -0.3), roll: -0.14, drop: 0.15, side: 0.08 },
      { t: 1.25, look: v3(-0.5 * r(), 1.0, -1.2), roll: 0.07, drop: 0.06, side: -0.03 },
      { t: 1.6, look: base, roll: 0, drop: 0, side: 0 },
    ];
    this.stunT = 0;
  }

  killInstant(id) {
    const c = this.charOf(id);
    if (c) { c.kill(); c.deadT = 1; }
  }

  update(dt, G, t) {
    for (const c of this.chars) c.update(dt, G.players[c.id], t);
    this.mafia.update(dt, G.mafia, t);

    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      if (f.grow) {
        f.t += dt;
        const k = 1 - (1 - Math.min(1, f.t / f.grow)) ** 3;
        f.obj.scale.setScalar(0.15 + 0.85 * k);
        if (k >= 1) f.grow = 0;
        continue;
      }
      if (!f.vel) continue;
      f.life -= dt;
      f.vel.y -= 9.8 * dt;
      const p = f.obj.position.addScaledVector(f.vel, dt);
      // giọt kéo dài theo hướng bay
      const speed = f.vel.length();
      f.obj.quaternion.setFromUnitVectors(UP, f.vel.clone().normalize());
      f.obj.scale.set(1, 1 + speed * 0.5, 1);
      const onTable = p.y < 0.81 && Math.abs(p.x) < 1 && Math.abs(p.z) < 2.7;
      if (onTable || p.y < 0.01) {
        if (this.fx.length < 260) this.splatAt(v3(p.x, onTable ? 0.807 : 0.013, p.z), 0.05 + Math.random() * 0.1);
        f.life = 0;
      }
      if (f.life <= 0) { this.scene.remove(f.obj); this.fx.splice(this.fx.indexOf(f), 1); }
    }

    // đèn treo thỉnh thoảng chập chờn 0.1–0.4s
    if (this.flickerT <= 0 && Math.random() < 0.003) this.flickerT = 0.1 + Math.random() * 0.3;
    this.flickerT -= dt;
    const fl = this.flickerT > 0 ? 0.25 + Math.random() * 0.6 : 1;
    this.lamp.intensity = this.lampBase * fl;
    this.bulb.material.color.setScalar(fl).multiply(BULB);

    // Choáng khi có tiếng súng: camera đi qua các mốc trong STUN_KEYS (hướng nhìn, độ nghiêng, độ hạ thấp).
    // Đoạn đầu (0.3s) ease-out bậc hai: bắt đầu nhanh rồi chậm dần khi tới gầm bàn, đủ chậm để thấy đang quay.
    // Các đoạn sau smoothstep (lảo đảo chậm dần), không phải dao động sin.
    let look = this.camLook, roll = 0, drop = 0, side = 0, tremor = 0;
    if (this.stunT >= 0) {
      this.stunT += dt;
      const e = this.stunT, K = this.stunKeys;
      const n = K.findIndex((key) => key.t > e);
      if (n < 0) this.stunT = -1;
      else {
        const a = K[n - 1], b = K[n];
        const u = (e - a.t) / (b.t - a.t);
        const w = n === 1 ? 1 - (1 - u) ** 2 : smooth(u);
        look = this.tmpLook.copy(a.look).lerp(b.look, w);
        roll = a.roll + (b.roll - a.roll) * w;
        drop = a.drop + (b.drop - a.drop) * w;
        side = a.side + (b.side - a.side) * w;
        tremor = e < 1.3 ? 0.01 : 0;
      }
    }
    const jit = () => (Math.random() - 0.5) * 2 * tremor;
    this.camera.position.set(
      this.camBase.x + Math.sin(t * 0.0004) * 0.05 + side + jit(),
      this.camBase.y + Math.sin(t * 0.0006) * 0.03 - drop + jit(),
      this.camBase.z,
    );
    this.camera.lookAt(look);
    this.camera.rotateZ(roll);
    this.post.render(this.renderer, this.scene, this.camera);
  }
}
