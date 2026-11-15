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
  vec3 t0 = (vec3(0.0) - o) * inv, t1 = (vec3(1.0) - o) * inv;
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
    float v = texture(uVol, p).r;
    float a = tf(v);
    if (a > 0.001) {
      a = 1.0 - pow(1.0 - min(a, 0.999), 0.5);              // 1ボクセルあたりの不透明度を半ボクセル刻みに直す
      vec3 c = vec3(v * uBright);
      if (uShade > 0.5) {
        vec3 g = vec3(texture(uGrad, p + vec3(e.x, 0, 0)).r - texture(uGrad, p - vec3(e.x, 0, 0)).r,
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

function tex3d(data, nx, ny, nz) {
  const t = new THREE.Data3DTexture(data, nx, ny, nz);
  t.format = THREE.RedFormat;
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
    this.params = { shade: true, laz: -35, lel: 40, spec: 0.35, smooth: 1, lo: 0.40, hi: 0.95, gamma: 1.5, opacity: 0.35, bright: 1.3 };
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
      const th = s.angle * Math.PI / 180;
      const c = [pt(0, rTop, th), pt(Wcm, rTop, th), pt(0, rBot, th), pt(Wcm, rBot, th)];
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
      mesh.userData = { angle: s.angle, edge };
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
    this.volTex = tex3d(vol.data, nx, ny, nz);
    this.gradTex = null;
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG, side: THREE.BackSide, transparent: true, depthWrite: false,
      uniforms: {
        uVol: { value: this.volTex }, uGrad: { value: this.volTex }, uCam: { value: new THREE.Vector3() },
        uDims: { value: new THREE.Vector3(nx, ny, nz) }, uLight: { value: new THREE.Vector3(0, 0, 1) },
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
    this.setSmooth(this.params.smooth);
    this.histogram = new Float32Array(256);
    for (let i = 0; i < vol.data.length; i++) if (vol.data[i]) this.histogram[vol.data[i]]++;

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

  setSmooth(r) {
    this.params.smooth = r;
    if (!this.vol || !this.volume) return;
    this.gradTex?.dispose();
    const { nx, ny, nz, data } = this.vol;
    this.gradTex = r ? tex3d(boxBlur(data, nx, ny, nz, r), nx, ny, nz) : null;
    this.volume.material.uniforms.uGrad.value = this.gradTex || this.volTex;
    this.dirty = true;
  }

  set(p) {
    Object.assign(this.params, p);
    if ('smooth' in p) this.setSmooth(p.smooth);
    this.applyParams();
  }

  applyParams() {
    if (!this.volume) return;
    const u = this.volume.material.uniforms, p = this.params;
    u.uLo.value = p.lo; u.uHi.value = Math.max(p.hi, p.lo + 0.01); u.uGamma.value = p.gamma;
    u.uOpacity.value = p.opacity; u.uBright.value = p.bright; u.uShade.value = p.shade ? 1 : 0; u.uSpec.value = p.spec;
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
      const a = k > 0 && k <= N ? this.slices[k - 1].userData.angle : null;
      this.label.textContent = N ? `断面 ${k} / ${N}` + (a !== null ? `  角度 ${a.toFixed(1)}°` : '') +
        (this.info && this.info.total > N ? `  (全 ${this.info.total} 枚から等間隔に表示)` : '') +
        (this.fade > 0.5 ? `  ボリュームレンダ${this.params.shade ? '(陰影あり)' : '(陰影なし)'}` : '') : '';
    }
  }
}
