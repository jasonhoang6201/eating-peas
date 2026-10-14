import * as THREE from 'three';

// Các bộ phận cơ thể người dựng từ geometry của three.js, dùng chung cho người chơi và mafia.
const UP = new THREE.Vector3(0, 1, 0);
const lam = (o) => new THREE.MeshLambertMaterial(o);
const mesh = (geo, mat) => new THREE.Mesh(geo, mat);
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

// Cylinder cao 1 đơn vị, kéo dãn và xoay để nối điểm a tới b.
export function stretch(m, a, b) {
  tmpA.copy(b).sub(a);
  const len = tmpA.length();
  m.position.copy(a).addScaledVector(tmpA, 0.5);
  m.quaternion.setFromUnitVectors(UP, tmpA.normalize());
  m.scale.set(1, len, 1);
}

// profile: [[bán kính, y], ...] từ dưới lên. depth < 1 làm dẹt theo trục z (ngực-lưng).
// phiStart = 0: đường nối texture ở chính diện; phiStart = π: đường nối ở lưng.
export function lathe(profile, mat, depth, phiStart = 0) {
  const geo = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 32, phiStart);
  geo.scale(1, 1, depth);
  geo.computeVertexNormals();
  return mesh(geo, mat);
}

// Đầu: hình cầu nắn thành sọ + quai hàm thon + cằm nhô, thêm gờ mày, mũi, tai.
// Group trả về nhìn theo +z, gốc ở tâm sọ.
// brute: gờ mày to và thấp, mũi to bè, quai hàm vuông (dùng cho mafia).
export function head({ r, faceMat, skinMat, jowls = false, brute = false }) {
  const g = new THREE.Group();
  const geo = new THREE.SphereGeometry(r, 40, 30);
  const p = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).divideScalar(r);
    let { x, y, z } = v;
    y *= brute ? 1.04 : 1.12;
    x *= brute ? 0.96 : 0.86;
    if (y < 0) {
      const k = -y;
      x *= 1 - (brute ? 0.02 : jowls ? 0.08 : 0.24) * k;
      if (z > 0) z += 0.1 * k * z;          // cằm nhô ra trước
      else z *= 1 - 0.3 * k;                // gáy thu vào phía cổ
    } else if (z < 0) {
      z *= 1.06;                            // ụ chẩm
    }
    p.setXYZ(i, x * r, y * r, z * r);
  }
  geo.computeVertexNormals();
  g.add(mesh(geo, faceMat));

  const brow = mesh(new THREE.CapsuleGeometry(r * (brute ? 0.15 : 0.11), r * 0.8, 4, 10), skinMat);
  brow.rotation.z = Math.PI / 2;
  brow.position.set(0, r * (brute ? 0.24 : 0.3), r * (brute ? 0.8 : 0.78));
  brow.scale.set(1, 1, brute ? 0.7 : 0.55);
  const bridge = mesh(new THREE.CapsuleGeometry(r * 0.075, r * 0.3, 4, 10), skinMat);
  bridge.position.set(0, r * 0.05, r * 0.9);
  bridge.rotation.x = -0.3;
  const tip = mesh(new THREE.SphereGeometry(r * 0.12, 14, 10), skinMat);
  tip.position.set(0, -r * 0.14, r * 0.99);
  tip.scale.set(brute ? 1.5 : 1.15, 0.85, brute ? 1.1 : 1);
  g.add(brow, bridge, tip);
  for (const s of [-1, 1]) {
    const nostril = mesh(new THREE.SphereGeometry(r * 0.07, 10, 8), skinMat);
    nostril.position.set(s * r * (brute ? 0.13 : 0.09), -r * 0.18, r * 0.92);
    if (brute) nostril.scale.setScalar(1.4);
    const ear = mesh(new THREE.SphereGeometry(r * 0.22, 14, 10), skinMat);
    ear.position.set(s * r * 0.86, r * 0.02, -r * 0.05);
    ear.scale.set(0.32, 1, 0.65);
    ear.rotation.y = s * 0.3;
    g.add(nostril, ear);
    if (jowls) {
      const j = mesh(new THREE.SphereGeometry(r * 0.26, 16, 12), skinMat);
      j.position.set(s * r * 0.4, -r * 0.5, r * 0.42);
      j.scale.set(0.85, 1.1, 0.8);
      g.add(j);
    }
  }
  return g;
}

// Bàn tay: lòng bàn tay + 4 ngón cong + ngón cái. Trục +y của group là hướng cẳng tay.
// Đốt ngón tay: capsule nối điểm a tới b (tọa độ trong group bàn tay).
function seg(g, mat, a, b, r) {
  const d = tmpA.copy(b).sub(a);
  const m = mesh(new THREE.CapsuleGeometry(r, Math.max(0.001, d.length()), 3, 8), mat);
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(UP, d.normalize());
  g.add(m);
}

// Bàn tay TRÁI, tọa độ chưa nhân scale s: cổ tay ở gốc, +y từ cổ tay tới khớp ngón, ngón cái phía +x,
// lòng bàn tay hướng +z. Tay phải dùng mirror = true (lật trục x).
// pose:
// - 'fist': nắm chặt quanh một cán trục x, tâm cán ở FIST_C, bán kính lỗ hole. 4 ngón đi từ khớp ngón
//   vòng qua phía trên, ra trước rồi xuống dưới cán (0°→190° quanh tâm cán), ngón cái vòng ra ngoài đè lên ngón trỏ, ngón giữa.
// - 'pinch': kẹp tờ giấy nằm trong mặt phẳng z = PINCH_Z: 4 ngón duỗi phía sau (-z), ngón cái phía trước (+z).
// - 'relaxed': ngón co nhẹ, dùng cho tay để trên bàn.
export const PINCH_HOLD = new THREE.Vector3(0, 0.11, 0.007);
export function fistCenter(hole) { return new THREE.Vector3(0, 0.055, 0.02 + hole); }

export function hand(mat, s = 1, { pose = 'relaxed', mirror = false, hole = 0.012 } = {}) {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  inner.scale.set(mirror ? -s : s, s, s);
  g.add(inner);
  const palm = mesh(new THREE.SphereGeometry(1, 14, 10), mat);
  palm.scale.set(0.046, 0.05, 0.024);
  palm.position.set(0, 0.04, -0.002);
  inner.add(palm);
  const v = (x, y, z) => new THREE.Vector3(x, y, z);
  const FX = [0.03, 0.01, -0.01, -0.03]; // trỏ, giữa, áp út, út

  if (pose === 'fist') {
    const C = fistCenter(hole), r = 0.0105, R = hole + r;
    const P = (x, deg) => { const t = (deg * Math.PI) / 180; return v(x, C.y + R * Math.cos(t), C.z + R * Math.sin(t)); };
    FX.forEach((x, i) => {
      const k = v(x, 0.088 - (i === 3 ? 0.008 : 0), 0.004);
      const p1 = P(x, 15), p2 = P(x, 100), p3 = P(x, 185 - i * 8);
      seg(inner, mat, k, p1, r);
      seg(inner, mat, p1, p2, r * 0.95);
      seg(inner, mat, p2, p3, r * 0.9);
    });
    // ngón cái: gốc ở cạnh lòng bàn tay, vòng ra trước, đầu ngón đè lên đốt giữa ngón trỏ và ngón giữa
    const front = C.z + R + 2 * r;
    seg(inner, mat, v(0.042, 0.025, 0.01), v(0.04, 0.05, front - 0.006), 0.012);
    seg(inner, mat, v(0.04, 0.05, front - 0.006), v(0.012, 0.062, front), 0.011);
  } else if (pose === 'pinch') {
    FX.forEach((x, i) => {
      const len = i === 3 ? 0.85 : 1;
      seg(inner, mat, v(x, 0.088, -0.006), v(x, 0.088 + 0.04 * len, -0.006), 0.0105);
      seg(inner, mat, v(x, 0.088 + 0.04 * len, -0.006), v(x, 0.088 + 0.07 * len, -0.002), 0.0098);
    });
    seg(inner, mat, v(0.044, 0.03, 0.008), v(0.032, 0.075, 0.02), 0.012);
    seg(inner, mat, v(0.032, 0.075, 0.02), v(0.016, 0.108, 0.02), 0.011);
  } else {
    FX.forEach((x) => {
      const f = new THREE.Group();
      f.position.set(x, 0.08, 0);
      f.rotation.x = 1.1;
      const p1 = mesh(new THREE.CapsuleGeometry(0.011, 0.028, 3, 6), mat);
      p1.position.y = 0.018;
      const p2 = mesh(new THREE.CapsuleGeometry(0.01, 0.022, 3, 6), mat);
      p2.position.set(0, 0.04, 0.014);
      p2.rotation.x = 1.0;
      f.add(p1, p2);
      inner.add(f);
    });
    const thumb = mesh(new THREE.CapsuleGeometry(0.012, 0.035, 3, 6), mat);
    thumb.position.set(0.04, 0.04, 0.02);
    thumb.rotation.set(0.6, 0, -0.7);
    inner.add(thumb);
  }
  return g;
}

const basis = new THREE.Matrix4();
const tmpC = new THREE.Vector3();
const tmpD = new THREE.Vector3();

// Tay 2 đoạn (cánh tay + cẳng tay) giải bằng IK 2 xương.
// solve(vai, cổ tay, pole, opts): khuỷu tay nằm trong mặt phẳng chứa vai-cổ tay và hướng pole.
// Hướng bàn tay (hệ tọa độ cha):
// - opts.quat: đặt thẳng (dùng khi hướng bàn tay do đồ vật quyết định, như kẹp báo hoặc cầm súng);
// - opts.thumb: nắm cán theo hướng này (ngón cái chỉ về phía đó). Trục +y bàn tay lấy theo cẳng tay sau khi
//   bỏ thành phần song song với thumb; lòng bàn tay quay về phía còn lại.
// - không có: bàn tay nối thẳng theo cẳng tay.
// Sau khi solve, grip là tâm cán trong nắm tay (pose 'fist').
export class Arm {
  constructor(parent, { upper, fore, rU, rF, mat, handMat, handScale = 1, pose = 'relaxed', mirror = false, hole = 0.012 }) {
    this.a = upper; this.b = fore;
    this.handScale = handScale;
    this.mirror = mirror;
    this.fistC = fistCenter(hole).multiplyScalar(handScale);
    this.grip = new THREE.Vector3();
    this.mU = mesh(new THREE.CylinderGeometry(rU * 0.9, rU, 1, 14), mat);
    this.mF = mesh(new THREE.CylinderGeometry(rF * 0.75, rF, 1, 14), mat);
    this.jS = mesh(new THREE.SphereGeometry(rU * 1.05, 14, 10), mat);
    this.jE = mesh(new THREE.SphereGeometry(rU * 0.9, 12, 8), mat);
    this.cuff = mesh(new THREE.CylinderGeometry(rF * 0.8, rF * 0.8, 0.03, 12), mat);
    this.hand = hand(handMat, handScale, { pose, mirror, hole });
    this.elbow = new THREE.Vector3();
    this.end = new THREE.Vector3();
    parent.add(this.mU, this.mF, this.jS, this.jE, this.cuff, this.hand);
  }

  // Quaternion bàn tay để nắm cán hướng thumb, với cẳng tay hướng fdir.
  // Tay trái (model gốc): x = thumb, z = lòng bàn tay = thumb × y. Tay phải (mirror): x = -thumb, z = y × thumb.
  gripQuat(fdir, thumb, out = new THREE.Quaternion()) {
    const t = tmpC.copy(thumb).normalize();
    const y = tmpD.copy(fdir).addScaledVector(t, -fdir.dot(t)).normalize();
    const z = new THREE.Vector3().crossVectors(this.mirror ? y : t, this.mirror ? t : y);
    const x = this.mirror ? t.clone().negate() : t.clone();
    basis.makeBasis(x, y, z);
    return out.setFromRotationMatrix(basis);
  }

  solve(S, T, pole, opts = {}) {
    const { a, b } = this;
    const dir = tmpB.copy(T).sub(S);
    const reach = Math.min(dir.length(), (a + b) * 0.999);
    dir.normalize();
    const cosA = Math.max(-1, Math.min(1, (a * a + reach * reach - b * b) / (2 * a * reach)));
    const sinA = Math.sqrt(1 - cosA * cosA);
    const perp = pole.clone().addScaledVector(dir, -pole.dot(dir)).normalize();
    this.elbow.copy(S).addScaledVector(dir, a * cosA).addScaledVector(perp, a * sinA);
    this.end.copy(S).addScaledVector(dir, reach);
    stretch(this.mU, S, this.elbow);
    stretch(this.mF, this.elbow, this.end);
    this.jS.position.copy(S);
    this.jE.position.copy(this.elbow);
    const fdir = this.end.clone().sub(this.elbow).normalize();
    this.hand.position.copy(this.end);
    if (opts.quat) this.hand.quaternion.copy(opts.quat);
    else if (opts.thumb) this.gripQuat(fdir, opts.thumb, this.hand.quaternion);
    else this.hand.quaternion.setFromUnitVectors(UP, fdir);
    this.grip.copy(this.fistC).applyQuaternion(this.hand.quaternion).add(this.end);
    this.cuff.position.copy(this.end).addScaledVector(fdir, -0.01);
    this.cuff.quaternion.setFromUnitVectors(UP, fdir);
    return this.end;
  }
}

// Mũ, tọa độ theo tâm đầu bán kính 0.19.
export function hat(type, feltMat) {
  const g = new THREE.Group();
  const add = (geo, mat, x, y, z) => { const m = mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
  if (type === 'campaign') {
    add(new THREE.CylinderGeometry(0.34, 0.34, 0.018, 32), feltMat, 0, 0.1, 0);
    add(new THREE.CylinderGeometry(0.17, 0.185, 0.05, 24), lam({ color: 0x23261a }), 0, 0.13, 0);
    const crown = add(new THREE.ConeGeometry(0.2, 0.28, 4), feltMat, 0, 0.25, 0);
    crown.rotation.y = Math.PI / 4;
  } else if (type === 'top') {
    const m = lam({ color: 0x1c1c1f });
    add(new THREE.CylinderGeometry(0.28, 0.28, 0.015, 32), m, 0, 0.12, 0).scale.set(1, 1, 0.9);
    add(new THREE.CylinderGeometry(0.18, 0.17, 0.36, 28), m, 0, 0.31, 0);
    add(new THREE.CylinderGeometry(0.182, 0.18, 0.05, 28), lam({ color: 0x3a3a3e }), 0, 0.155, 0);
  } else if (type === 'bowler') {
    const m = lam({ color: 0x2b2722 });
    add(new THREE.CylinderGeometry(0.26, 0.26, 0.015, 32), m, 0, 0.1, 0).scale.set(1, 1, 1.1);
    add(new THREE.SphereGeometry(0.2, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), m, 0, 0.1, 0).scale.set(1, 1.05, 1.1);
    add(new THREE.CylinderGeometry(0.202, 0.202, 0.04, 28), lam({ color: 0x151310 }), 0, 0.12, 0).scale.set(1, 1, 1.1);
  } else if (type === 'cap') {
    const m = lam({ color: 0x55575a });
    add(new THREE.SphereGeometry(0.215, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), m, 0, 0.08, -0.01).scale.set(1, 0.5, 1.12);
    const visor = add(new THREE.CylinderGeometry(0.13, 0.13, 0.012, 20, 1, false, -Math.PI / 2, Math.PI), m, 0, 0.09, 0.17);
    visor.rotation.x = 0.15;
  } else { // beanie
    const m = lam({ color: 0x3c4448 });
    add(new THREE.SphereGeometry(0.205, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.55), m, 0, 0.0, -0.005).scale.set(0.92, 1.18, 1.05);
    const rim = add(new THREE.TorusGeometry(0.188, 0.028, 8, 28), m, 0, 0.03, 0);
    rim.rotation.x = Math.PI / 2; rim.scale.set(0.93, 1.05, 1);
  }
  return g;
}

// Kính gọng tròn nhỏ, tròng tối. Tọa độ theo tâm đầu bán kính r, khớp vị trí mắt trên texture mặt.
export function glasses(r) {
  const g = new THREE.Group();
  const frame = lam({ color: 0x1a1a1a });
  const lens = new THREE.MeshPhongMaterial({ color: 0x050607, shininess: 140, specular: 0x888888, transparent: true, opacity: 0.94 });
  for (const s of [-1, 1]) {
    const rim = mesh(new THREE.TorusGeometry(r * 0.13, r * 0.018, 6, 20), frame);
    rim.position.set(s * r * 0.28, r * 0.07, r * 1.0);
    const glass = mesh(new THREE.CircleGeometry(r * 0.125, 20), lens);
    glass.position.copy(rim.position);
    const arm = mesh(new THREE.CylinderGeometry(r * 0.015, r * 0.015, r * 0.95, 6), frame);
    arm.rotation.x = Math.PI / 2;
    arm.position.set(s * r * 0.78, r * 0.07, r * 0.5);
    arm.rotation.y = s * 0.35;
    g.add(rim, glass, arm);
  }
  const bridge = mesh(new THREE.CylinderGeometry(r * 0.015, r * 0.015, r * 0.3, 6), frame);
  bridge.rotation.z = Math.PI / 2;
  bridge.position.set(0, r * 0.09, r * 1.03);
  g.add(bridge);
  return g;
}
