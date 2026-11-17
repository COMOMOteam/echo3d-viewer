// 再構成アニメーションと陰影つきボリュームレンダ (three.js)。
// 座標: 再構成の物理座標 (X=プローブの横幅, Y=振り方向, Z=回転中心からの深さ方向, 単位 cm) を
// three.js の世界座標 (x, y, z) = (X, -Z, Y) に置く(深さが画面の下向き)。
// 角度θの断面の画素 (列 u, 行 i) は r=(i-z0)/px として X=u/px, Y=(P+r)sinθ, Z=(P+r)cosθ (echo3d.reconstruct と同じ)。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const VERT = /* glsl */`
out vec3 vLocal;
void main() {
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */`
precision highp float;
precision highp sampler3D;
in vec3 vLocal;
out vec4 outColor;
uniform sampler3D uVol;
uniform sampler3D uGrad;
uniform float uInvert;       // 1 なら明暗を反転して描く(扇の内側だけ)。黒い管や液体が塊として見える
uniform sampler3D uLab;      // 構造の番号(0 = なし)。最近傍で引く
uniform sampler3D uMaskG;    // 表示中の構造をまとめた 0/1 を少しならしたもの(構造の面の向きを取る)
uniform vec3 uPal[16];
uniform float uShow[16];
uniform float uColorMode, uStructOp, uBgOp;
uniform vec3 uClip0, uClip1; // 表示する範囲(テクスチャ座標)。外は切り取る
uniform vec3 uCam;      // カメラ位置(テクスチャ座標 [0,1]^3)
uniform vec3 uDims;     // ボクセル数
uniform vec3 uLight;    // 光の向き(ボクセル空間, 正規化)
uniform float uLo, uHi, uGamma, uOpacity, uBright, uShade, uSpec, uFade;

float tf(float v) {
  float x = clamp((v - uLo) / max(uHi - uLo, 1e-3), 0.0, 1.0);
  return uOpacity * pow(x, uGamma);
}
vec2 hitBox(vec3 o, vec3 d) {
  vec3 inv = 1.0 / d;
  vec3 t0 = (uClip0 - o) * inv, t1 = (uClip1 - o) * inv;
  vec3 tn = min(t0, t1), tx = max(t0, t1);
  return vec2(max(max(tn.x, tn.y), tn.z), min(min(tx.x, tx.y), tx.z));
}
void main() {
  vec3 o = uCam;
  vec3 d = normalize(vLocal - o);
  vec2 t = hitBox(o, d);
  if (t.x > t.y) discard;
  t.x = max(t.x, 0.0);
  float dt = 0.5 / length(d * uDims);                     // 半ボクセルずつ進む
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  vec3 vd = normalize(d * uDims);                          // 視線(ボクセル空間)
  vec3 e = 1.0 / uDims;
  vec4 acc = vec4(0.0);
  float tt = t.x + dt * jitter;
  for (int i = 0; i < 4096; i++) {
    if (tt > t.y || acc.a > 0.98) break;
    vec3 p = o + d * tt;
    vec2 vm = texture(uVol, p).rg;                         // r=輝度, g=扇の内側なら 1
    float v = uInvert > 0.5 ? (1.0 - vm.r) * step(0.5, vm.g) : vm.r;
    float a = tf(v);
    vec3 c = vec3(v * uBright);
    bool st = false;
    if (uColorMode > 0.5) {
      // 構造の色: 表示中の構造は色を付けて一定の不透明度で、それ以外の組織はグレーを薄くして背景に置く
      int id = int(texture(uLab, p).r * 255.0 + 0.5);
      float mg = texture(uMaskG, p).r;                  // 表示中の構造をならした 0〜1。境目でなめらかに落ちる
      if (id > 0 && id < 16 && uShow[id] > 0.5 && mg > 0.05) {
        st = true; a = uStructOp * smoothstep(0.2, 0.8, mg); c = uPal[id] * (0.6 + 0.6 * v) * uBright / 1.3;
      } else {
        a *= uBgOp;
      }
    }
    if (a > 0.001) {
      a = 1.0 - pow(1.0 - min(a, 0.999), 0.5);              // 1ボクセルあたりの不透明度を半ボクセル刻みに直す
      if (uShade > 0.5) {
        // 法線は輝度の勾配から取る(構造の色では構造の面から)。反転しても面の向きは同じ(両面照明なので符号は効かない)
        vec3 g = st ? vec3(texture(uMaskG, p + vec3(e.x, 0, 0)).r - texture(uMaskG, p - vec3(e.x, 0, 0)).r,
                           texture(uMaskG, p + vec3(0, e.y, 0)).r - texture(uMaskG, p - vec3(0, e.y, 0)).r,
                           texture(uMaskG, p + vec3(0, 0, e.z)).r - texture(uMaskG, p - vec3(0, 0, e.z)).r)
                    : vec3(texture(uGrad, p + vec3(e.x, 0, 0)).r - texture(uGrad, p - vec3(e.x, 0, 0)).r,
                           texture(uGrad, p + vec3(0, e.y, 0)).r - texture(uGrad, p - vec3(0, e.y, 0)).r,
                           texture(uGrad, p + vec3(0, 0, e.z)).r - texture(uGrad, p - vec3(0, 0, e.z)).r);
        float gl = length(g);
        if (gl > 0.003) {
          vec3 n = -g / gl;                                  // 明るい側から暗い側へ向く面の法線
          if (dot(n, vd) > 0.0) n = -n;                      // 視線側へ向ける(両面照明)
          float diff = max(dot(n, uLight), 0.0);
          vec3 h = normalize(uLight - vd);
          float sp = pow(max(dot(n, h), 0.0), 24.0);
          c = c * (0.3 + 0.9 * diff) + vec3(uSpec * sp * min(gl * 12.0, 1.0));
        } else {
          c *= 0.6;
        }
      }
      acc.rgb += (1.0 - acc.a) * a * c;
      acc.a += (1.0 - acc.a) * a;
    }
    tt += dt;
  }
  if (acc.a < 0.002) discard;
  outColor = vec4(acc.rgb / acc.a, acc.a * uFade);
}`;

// 物理 (X,Y,Z) → 世界 (X,-Z,Y)
const PHYS2WORLD = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1);

function parseNrrd(buf) {
  const b = new Uint8Array(buf);
  let i = 0;
  while (i < b.length - 1 && !(b[i] === 10 && b[i + 1] === 10)) i++;
  const head = new TextDecoder().decode(b.subarray(0, i));
  const m = head.match(/sizes:\s*(\d+)\s+(\d+)\s+(\d+)/);
  if (!m || !/type:\s*uint8/.test(head) || !/encoding:\s*raw/.test(head)) throw new Error('NRRD の形式が想定外: ' + head);
  const [nx, ny, nz] = m.slice(1, 4).map(Number);
  return { nx, ny, nz, data: b.slice(i + 2, i + 2 + nx * ny * nz) };
}

function boxBlur(src, nx, ny, nz, r) {
  if (!r) return src;
  let a = Float32Array.from(src), out = new Float32Array(a.length);
  const dims = [nx, ny, nz], strides = [1, nx, nx * ny];
  for (let ax = 0; ax < 3; ax++) {
    const n = dims[ax], s = strides[ax];
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const idx = x + nx * (y + ny * z);
      const c = ax === 0 ? x : ax === 1 ? y : z;
      let sum = 0, cnt = 0;
      for (let k = Math.max(c - r, 0); k <= Math.min(c + r, n - 1); k++) { sum += a[idx + (k - c) * s]; cnt++; }
      out[idx] = sum / cnt;
    }
    [a, out] = [out, a];
  }
  const res = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) res[i] = a[i];
  return res;
}

// SRAD を Worker で回す(画面を止めない)。1ボクセルごとに配列を作らない書き方で、旧版より大幅に速い
const SRAD_WORKER_SRC = `
function boxMean(src, nx, ny, nz, r) {
  let a = src, out = new Float32Array(src.length);
  const dims = [nx, ny, nz], strides = [1, nx, nx * ny], cum = new Float64Array(Math.max(nx, ny, nz) + 1);
  for (let ax = 0; ax < 3; ax++) {
    const n = dims[ax], s = strides[ax];
    const o1 = ax === 0 ? [ny, nz, nx, nx * ny] : ax === 1 ? [nx, nz, 1, nx * ny] : [nx, ny, 1, nx];
    for (let j = 0; j < o1[1]; j++) for (let i = 0; i < o1[0]; i++) {
      const base = i * o1[2] + j * o1[3];
      for (let k = 0; k < n; k++) cum[k + 1] = cum[k] + a[base + k * s];
      for (let k = 0; k < n; k++) { const lo = k - r < 0 ? 0 : k - r, hi = k + r > n - 1 ? n - 1 : k + r; out[base + k * s] = (cum[hi + 1] - cum[lo]) / (hi - lo + 1); }
    }
    if (ax === 0) { a = out; out = new Float32Array(src.length); } else { const t = a; a = out; out = t; }
  }
  return a;
}
onmessage = (e) => {
  const { data, nx, ny, nz, iters, id } = e.data, lam = 0.5, N = data.length, P = nx * ny;
  const valid = new Uint8Array(N), I = new Float32Array(N), c = new Float32Array(N), J = new Float32Array(N);
  for (let i = 0; i < N; i++) { valid[i] = data[i] ? 1 : 0; I[i] = data[i] ? data[i] / 255 : 1e-3; }
  const s = Float32Array.from(I), s2 = new Float32Array(N), vv = new Float32Array(N);
  for (let i = 0; i < N; i++) { s2[i] = I[i] * I[i]; vv[i] = valid[i]; }
  const m = boxMean(s, nx, ny, nz, 2), mm = boxMean(s2, nx, ny, nz, 2), w = boxMean(vv, nx, ny, nz, 2);
  const cvs = [];
  for (let i = 0; i < N; i += 7) if (w[i] > 0.999) cvs.push(Math.sqrt(Math.max(mm[i] - m[i] * m[i], 0)) / Math.max(m[i], 1e-3));
  cvs.sort((a, b) => a - b);
  const q0i = cvs.length ? cvs[cvs.length >> 1] : 0.3;
  for (let t = 0; t < iters; t++) {
    const q0 = q0i * Math.exp(-t * lam / 36), q02 = q0 * q0;
    for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
      if (!valid[i]) { c[i] = 0; continue; }
      const Ii = I[i]; let G2 = 0, L = 0, n, d;
      n = (x < nx - 1 && valid[i + 1]) ? I[i + 1] : Ii; d = n - Ii; G2 += d * d; L += d;
      n = (x > 0 && valid[i - 1]) ? I[i - 1] : Ii; d = n - Ii; G2 += d * d; L += d;
      n = (y < ny - 1 && valid[i + nx]) ? I[i + nx] : Ii; d = n - Ii; G2 += d * d; L += d;
      n = (y > 0 && valid[i - nx]) ? I[i - nx] : Ii; d = n - Ii; G2 += d * d; L += d;
      n = (z < nz - 1 && valid[i + P]) ? I[i + P] : Ii; d = n - Ii; G2 += d * d; L += d;
      n = (z > 0 && valid[i - P]) ? I[i - P] : Ii; d = n - Ii; G2 += d * d; L += d;
      G2 /= Ii * Ii; L /= Ii;
      const l6 = L / 6, q2 = Math.max((G2 / 6 - l6 * l6) / ((1 + l6) * (1 + l6)), 0);
      const cc = 1 / (1 + (q2 - q02) / (q02 * (1 + q02)));
      c[i] = cc < 0 ? 0 : cc > 1 ? 1 : cc;
    }
    for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
      if (!valid[i]) { J[i] = 1e-3; continue; }
      const Ii = I[i], ci = c[i]; let D = 0;
      if (x < nx - 1 && valid[i + 1]) D += c[i + 1] * (I[i + 1] - Ii);
      if (x > 0 && valid[i - 1]) D += ci * (I[i - 1] - Ii);
      if (y < ny - 1 && valid[i + nx]) D += c[i + nx] * (I[i + nx] - Ii);
      if (y > 0 && valid[i - nx]) D += ci * (I[i - nx] - Ii);
      if (z < nz - 1 && valid[i + P]) D += c[i + P] * (I[i + P] - Ii);
      if (z > 0 && valid[i - P]) D += ci * (I[i - P] - Ii);
      J[i] = Ii + lam / 6 * D;
    }
    I.set(J);
    postMessage({ id, progress: (t + 1) / iters });
  }
  const out = new Uint8Array(N);
  for (let i = 0; i < N; i++) { const v = Math.round(I[i] * 255); out[i] = valid[i] ? (v < 1 ? 1 : v > 255 ? 255 : v) : 0; }
  postMessage({ id, out }, [out.buffer]);
};`;
let sradWorker = null;
function sradAsync(data, nx, ny, nz, iters, onProgress) {
  if (!iters) return Promise.resolve(data);
  if (!sradWorker) sradWorker = new Worker(URL.createObjectURL(new Blob([SRAD_WORKER_SRC], { type: 'text/javascript' })));
  const id = Math.random();
  return new Promise((resolve) => {
    const h = (e) => {
      if (e.data.id !== id) return;
      if (e.data.out) { sradWorker.removeEventListener('message', h); resolve(e.data.out); }
      else onProgress?.(e.data.progress);
    };
    sradWorker.addEventListener('message', h);
    sradWorker.postMessage({ data: data.slice(), nx, ny, nz, iters, id });
  });
}

// 半径 r の箱平均を3軸に順にかける(端は窓を縮めて平均)。累積和で O(N)
function boxMeanF(src, nx, ny, nz, r) {
  let a = src, out = new Float32Array(src.length);
  const dims = [nx, ny, nz], strides = [1, nx, nx * ny], cum = new Float64Array(Math.max(nx, ny, nz) + 1);
  for (let ax = 0; ax < 3; ax++) {
    const n = dims[ax], s = strides[ax];
    const o1 = ax === 0 ? [ny, nz, nx, nx * ny] : ax === 1 ? [nx, nz, 1, nx * ny] : [nx, ny, 1, nx];
    for (let j = 0; j < o1[1]; j++) for (let i = 0; i < o1[0]; i++) {
      const base = i * o1[2] + j * o1[3];
      for (let k = 0; k < n; k++) cum[k + 1] = cum[k] + a[base + k * s];
      for (let k = 0; k < n; k++) {
        const lo = Math.max(k - r, 0), hi = Math.min(k + r, n - 1);
        out[base + k * s] = (cum[hi + 1] - cum[lo]) / (hi - lo + 1);
      }
    }
    if (ax === 0) { a = out; out = new Float32Array(src.length); } else { [a, out] = [out, a]; }
  }
  return a;
}

// 輝度と扇の内側の印を2チャンネルに詰める(反転表示で扇の外を描かないため)
function withMask(data) {
  const out = new Uint8Array(data.length * 2);
  for (let i = 0; i < data.length; i++) { out[2 * i] = data[i]; out[2 * i + 1] = data[i] ? 255 : 0; }
  return out;
}

function tex3d(data, nx, ny, nz, format = THREE.RedFormat) {
  const t = new THREE.Data3DTexture(data, nx, ny, nz);
  t.format = format;
  t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

export class Stack3D {
  constructor(canvas, label) {
    this.canvas = canvas;
    this.label = label;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 1);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.addEventListener('change', () => this.dirty = true);
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.group.matrix.copy(PHYS2WORLD);
    this.scene.add(this.group);
    this.slices = [];
    this.k = 0; this.kf = 0; this.playing = false; this.speed = 8; this.mode = 'anim'; this.fade = 0;
    this.params = { shade: true, laz: -35, lel: 40, spec: 0.35, smooth: 1, lo: 0.40, hi: 0.95, gamma: 1.5, opacity: 0.35, bright: 1.3,
                    denoise: 0, invert: false, cx: 0, cy: 0, cz: 0,
                    colorMode: 'labels', structOp: 0.1, bgOp: 0.15, show: null };
    this.onchange = () => {};
    this.dirty = true;
    this.last = performance.now();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
    const loop = (t) => { this.tick((t - this.last) / 1000); this.last = t; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  resize() {
    const p = this.canvas.parentElement;
    const w = p.clientWidth, h = p.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  clear() {
    for (const o of [...this.group.children]) {
      this.group.remove(o);
      o.traverse?.(c => { c.geometry?.dispose(); if (c.material) { c.material.map?.dispose(); c.material.dispose(); } });
    }
    this.slices = []; this.volume = null; this.k = 0; this.kf = 0; this.playing = false; this.fade = 0;
    this.dirty = true;
  }

  // src = { slices: 断面一覧 JSON の URL, file: (実行フォルダ内の相対パス) => URL }
  async load(src) {
    this.clear();
    const token = this.token = Symbol();
    const r = await fetch(src.slices);
    const info = await r.json();
    if (!r.ok || info.error) throw new Error(info.error || `HTTP ${r.status}`);
    const vr = await fetch(src.file('volume_display.nrrd'));
    if (!vr.ok) throw new Error(`volume_display.nrrd: HTTP ${vr.status}`);
    const vbuf = await vr.arrayBuffer();
    if (token !== this.token) return;
    this.info = info;
    const vol = parseNrrd(vbuf);
    this.vol = vol;
    const VOX = info.voxel_mm / 10, P = info.pivot_cm || 0, px = info.px_per_cm, z0 = info.zero_row || 0;
    const Wpx = info.crop_x[1] - info.crop_x[0], Hpx = info.crop_y[1] - info.crop_y[0];
    const Wcm = Wpx / px, rTop = -z0 / px, rBot = (Hpx - z0) / px;
    const pt = (u, r, th) => new THREE.Vector3(u, (P + r) * Math.sin(th), (P + r) * Math.cos(th));

    // 断面
    const loader = new THREE.TextureLoader();
    const texs = await Promise.all(info.slices.map(s => loader.loadAsync(src.file(s.file))));
    if (token !== this.token) return;
    info.slices.forEach((s, i) => {
      const th = (s.angle || 0) * Math.PI / 180;
      const yl = s.y_mm !== undefined ? s.y_mm / 10 : null;   // 平行移動: 断面は Y = y_mm の面
      const pl = (u, r) => new THREE.Vector3(u, yl, r);
      const c = yl !== null ? [pl(0, rTop), pl(Wcm, rTop), pl(0, rBot), pl(Wcm, rBot)]
                            : [pt(0, rTop, th), pt(Wcm, rTop, th), pt(0, rBot, th), pt(Wcm, rBot, th)];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(c.flatMap(v => [v.x, v.y, v.z]), 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 0, 0, 1, 0], 2));
      geo.setIndex([0, 2, 1, 2, 3, 1]);
      texs[i].colorSpace = THREE.SRGBColorSpace;
      // 重ねは最大値の合成(MaxEquation)。加算だと画面上で重なる枚数だけ明るさが足されて白く飛ぶ(動画は90枚)。
      // 最大値なら何枚重なっても元の画像の明るさを超えず、描く順にもよらない
      const mat = new THREE.MeshBasicMaterial({ map: texs[i], transparent: true, blending: THREE.CustomBlending,
                                                blendEquation: THREE.MaxEquation, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);
      const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([c[0], c[1], c[3], c[2]]),
                                      new THREE.LineBasicMaterial({ color: 0xffd54a, depthTest: false, transparent: true }));
      mesh.add(edge);
      mesh.renderOrder = 1;
      mesh.userData = { angle: s.angle, y_mm: s.y_mm, edge };
      this.group.add(mesh);
      this.slices.push(mesh);
    });

    // 回転軸(赤)
    const axis = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.2, 0, 0), new THREE.Vector3(Wcm + 0.2, 0, 0)]),
                                new THREE.LineBasicMaterial({ color: 0xff5050 }));
    this.group.add(axis);

    // ボリューム(レイマーチ)
    const [nz, ny, nx] = info.volume_shape_ZYX;
    if (nx !== vol.nx || ny !== vol.ny || nz !== vol.nz) throw new Error('run_info と NRRD の大きさが合わない');
    const Y0 = info.y_origin_mm / 10, Zmin = P + info.z_origin_mm / 10;
    const size = new THREE.Vector3(nx * VOX, ny * VOX, nz * VOX);
    const min = new THREE.Vector3(-VOX / 2, Y0 - VOX / 2, Zmin - VOX / 2);
    this.volTex = null;
    this.gradTex = null;
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG, side: THREE.BackSide, transparent: true, depthWrite: false,
      uniforms: {
        uVol: { value: this.volTex }, uGrad: { value: this.volTex }, uCam: { value: new THREE.Vector3() },
        uDims: { value: new THREE.Vector3(nx, ny, nz) }, uLight: { value: new THREE.Vector3(0, 0, 1) },
        uLab: { value: null }, uMaskG: { value: null }, uPal: { value: Array.from({ length: 16 }, () => new THREE.Vector3(1, 1, 1)) },
        uShow: { value: new Array(16).fill(1) }, uColorMode: { value: 0 }, uStructOp: { value: 0.1 }, uBgOp: { value: 0.15 },
        uInvert: { value: 0 }, uClip0: { value: new THREE.Vector3(0, 0, 0) }, uClip1: { value: new THREE.Vector3(1, 1, 1) },
        uLo: { value: 0.3 }, uHi: { value: 0.9 }, uGamma: { value: 1.5 }, uOpacity: { value: 0.45 }, uBright: { value: 1.3 },
        uShade: { value: 1 }, uSpec: { value: 0.35 }, uFade: { value: 0 },
      },
    });
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5), mat);
    box.scale.copy(size);
    box.position.copy(min);
    box.renderOrder = 2;
    this.group.add(box);
    this.volume = box;
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5)),
                                           new THREE.LineBasicMaterial({ color: 0x3a4250 }));
    outline.scale.copy(size); outline.position.copy(min);
    this.group.add(outline);
    await this.setDenoise(this.params.denoise);
    if (token !== this.token) return;
    // 構造のラベル(あれば): labels.json に番号・名前・色、labels.nrrd に番号のボリューム
    this.labels = null;
    const uu = mat.uniforms;
    uu.uLab.value = this.volTex; uu.uMaskG.value = this.gradTex;
    try {
      const lj = await fetch(src.file('labels.json'));
      if (lj.ok) {
        const meta = await lj.json();
        const lb = await fetch(src.file('labels.nrrd'));
        if (lb.ok && token === this.token) {
          const lv = parseNrrd(await lb.arrayBuffer());
          if (lv.nx === nx && lv.ny === ny && lv.nz === nz) {
            this.labels = { meta, data: lv.data };
            const lt = tex3d(lv.data, nx, ny, nz); lt.minFilter = lt.magFilter = THREE.NearestFilter; lt.needsUpdate = true;
            uu.uLab.value = this.labTex = lt;
            meta.labels.forEach(l => { if (l.id < 16) uu.uPal.value[l.id].set(...new THREE.Color(l.color).toArray()); });
            this.params.show = Object.fromEntries(meta.labels.map(l => [l.id, true]));
            this.updateMask();
          }
        }
      }
    } catch (e) { console.warn('ラベルを読めなかった', e); }

    // カメラ: 扇の面(Y-Z)を斜め前から見る
    const cPhys = min.clone().addScaledVector(size, 0.5);
    const center = cPhys.clone().applyMatrix4(PHYS2WORLD);
    const R = size.length();
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(R * 0.95, R * 0.35, R * 0.7));
    this.camera.near = R / 100; this.camera.far = R * 50;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.applyParams();
    this.setProgress(0);
    this.dirty = true;
    return info;
  }

  // 平滑化(SRAD)の回数を変えてボリュームを作り直す。回数はボクセル 0.3 mm のときの値で、ボクセルの大きさに合わせて
  // (0.3 / ボクセル)^2 倍する(拡散で均される距離が mm で揃うように)
  // 強さ n はボクセル単位の回数(ボクセルが細かいほど mm で見た平滑化は弱い。細い線を消しすぎないため)
  async setDenoise(n) {
    this.params.denoise = n;
    if (!this.vol || !this.volume) return;
    const { nx, ny, nz, data } = this.vol;
    const token = this.denoiseToken = Symbol();
    this.busy = n ? '斑点を平滑化しています 0%' : null;
    this.dirty = true;
    const out = await sradAsync(data, nx, ny, nz, n, (p) => { if (token === this.denoiseToken) { this.busy = `斑点を平滑化しています ${Math.round(p * 100)}%`; this.dirty = true; } });
    if (token !== this.denoiseToken || !this.volume) return;
    this.busy = null;
    this.disp = out;
    this.volTex?.dispose();
    this.volTex = tex3d(withMask(this.disp), nx, ny, nz, THREE.RGFormat);
    this.volume.material.uniforms.uVol.value = this.volTex;
    this.updateHistogram();
    this.setSmooth(this.params.smooth);
    this.onchange();
    this.onDenoised?.();
  }

  // 表示している値(反転なら 1-輝度)の、扇の内側だけのヒストグラム
  updateHistogram() {
    const d = this.disp, h = this.histogram = new Float32Array(256);
    for (let i = 0; i < d.length; i++) if (d[i]) h[this.params.invert ? 255 - d[i] : d[i]]++;
  }

  // 不透明度カーブの下限と上限を、表示している値の分位点から決める(データごとに手で合わせなくて済むように)
  autoWindow() {
    const h = this.histogram; if (!h) return null;
    const tot = h.reduce((a, b) => a + b, 0), q = (p) => { let s = 0; for (let i = 0; i < 256; i++) { s += h[i]; if (s >= p * tot) return i / 255; } return 1; };
    return this.params.invert ? { lo: q(0.9), hi: q(0.995) } : { lo: q(0.6), hi: q(0.995) };
  }

  // 表示中の構造をまとめた 0/1 を 3×3×3 でならし、構造の面の向き(陰影)に使う
  updateMask() {
    if (!this.labels || !this.volume) return;
    const { nx, ny, nz } = this.vol, d = this.labels.data, sh = this.params.show || {};
    const m = new Uint8Array(d.length);
    for (let i = 0; i < d.length; i++) m[i] = d[i] && sh[d[i]] ? 255 : 0;
    this.maskTex?.dispose();
    this.maskTex = tex3d(boxBlur(m, nx, ny, nz, 2), nx, ny, nz);     // 5×5×5 でならす(段々の面をなめらかに)
    const u = this.volume.material.uniforms;
    u.uMaskG.value = this.maskTex;
    for (let k = 0; k < 16; k++) u.uShow.value[k] = sh[k] ? 1 : 0;
    this.dirty = true;
  }

  setSmooth(r) {
    this.params.smooth = r;
    if (!this.vol || !this.volume) return;
    this.gradTex?.dispose();
    const { nx, ny, nz } = this.vol, data = this.disp;
    this.gradTex = tex3d(r ? boxBlur(data, nx, ny, nz, r) : data, nx, ny, nz);
    this.volume.material.uniforms.uGrad.value = this.gradTex;
    this.dirty = true;
  }

  set(p) {
    if ('show' in p && p.show) { this.params.show = p.show; this.updateMask(); delete p.show; }
    const dn = 'denoise' in p && p.denoise !== this.params.denoise, inv = 'invert' in p && p.invert !== this.params.invert;
    Object.assign(this.params, p);
    if (dn) this.setDenoise(p.denoise);
    else if ('smooth' in p) this.setSmooth(p.smooth);
    if (inv) this.updateHistogram();
    this.applyParams();
  }

  applyParams() {
    if (!this.volume) return;
    const u = this.volume.material.uniforms, p = this.params;
    u.uLo.value = p.lo; u.uHi.value = Math.max(p.hi, p.lo + 0.01); u.uGamma.value = p.gamma;
    u.uOpacity.value = p.opacity; u.uBright.value = p.bright; u.uShade.value = p.shade ? 1 : 0; u.uSpec.value = p.spec;
    u.uColorMode.value = p.colorMode === 'labels' && this.labels ? 1 : 0; u.uStructOp.value = p.structOp; u.uBgOp.value = p.bgOp;
    u.uInvert.value = p.invert ? 1 : 0; u.uClip0.value.set(p.cx, p.cy, p.cz);
    this.dirty = true;
    this.onchange();
  }

  setMode(m) { this.mode = m; this.dirty = true; }
  setProgress(k) {
    this.k = Math.max(0, Math.min(k, this.slices.length));
    this.kf = this.k;
    if (this.k < this.slices.length) this.fade = 0;
    this.dirty = true;
    this.onchange();
  }
  play() {
    if (!this.slices.length) return;
    if (this.k >= this.slices.length) this.setProgress(0);
    this.playing = true; this.onchange();
  }
  pause() { this.playing = false; this.onchange(); }

  tick(dt) {
    dt = Math.min(dt, 0.1);
    const N = this.slices.length;
    if (this.playing) {
      this.kf += this.speed * dt;
      const k = Math.min(Math.floor(this.kf), N);
      if (k !== this.k) { this.k = k; this.onchange(); }
      if (this.k >= N) { this.playing = false; this.onchange(); }
      this.dirty = true;
    }
    const wantFade = (this.mode === 'volume' || (this.mode === 'anim' && N && this.k >= N)) ? 1 : 0;
    if (this.fade !== wantFade) {
      this.fade = this.mode === 'volume' ? 1 : Math.max(0, Math.min(1, this.fade + (wantFade ? dt / 1.2 : -1)));
      this.dirty = true;
    }
    if (this.dirty) this.render();
  }

  render() {
    this.dirty = false;
    const N = this.slices.length, k = this.k;
    this.slices.forEach((m, i) => {
      const cur = i === k - 1 && k < N;
      m.visible = this.mode !== 'volume' && i < k;
      const base = this.mode === 'anim' ? 0.6 * (1 - 0.9 * this.fade) : 0.6;   // 置き済みの断面は暗めに、いま置いた1枚は元の明るさ
      if (cur) m.material.color.set(0xbfefff); else m.material.color.setScalar(base);
      m.userData.edge.visible = cur;
    });
    if (this.volume) {
      this.volume.visible = this.fade > 0.001;
      const u = this.volume.material.uniforms;
      u.uFade.value = this.fade;
      this.scene.updateMatrixWorld();
      u.uCam.value.copy(this.camera.position);
      this.volume.worldToLocal(u.uCam.value);
      const az = this.params.laz * Math.PI / 180, el = this.params.lel * Math.PI / 180;
      const L = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)); // カメラ座標(+z が手前)
      L.applyQuaternion(this.camera.quaternion);                          // 世界
      L.applyMatrix4(new THREE.Matrix4().copy(PHYS2WORLD).transpose());   // 物理 = ボクセル空間
      u.uLight.value.copy(L.normalize());
    }
    this.renderer.render(this.scene, this.camera);
    if (this.label) {
      const ud = k > 0 && k <= N ? this.slices[k - 1].userData : null;
      const a = ud && ud.angle !== undefined ? ud.angle : null, ym = ud && ud.y_mm !== undefined ? ud.y_mm : null;
      this.label.textContent = N ? `断面 ${k} / ${N}` + (a !== null ? `  角度 ${a.toFixed(1)}°` : '') + (ym !== null ? `  Y ${ym.toFixed(1)} mm` : '') +
        (this.info && this.info.total > N ? `  (全 ${this.info.total} 枚から等間隔に表示)` : '') +
        (this.fade > 0.5 ? `  ボリュームレンダ${this.params.shade ? '(陰影あり)' : '(陰影なし)'}` : '') + (this.busy ? `  [${this.busy}]` : '') : '';
    }
  }
}
