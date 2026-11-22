// 「元動画＋色分け」: 元動画(H.264 に直したもの)を <video> で流し、上の canvas に、そのフレームが入った Y 断面のラベルの輪郭を描く。
// 対応表 video_overlay.json は 03_code/to_web_video_overlay.py が作る(frames.t = 動画の時刻、frames.k = 体積の Y の添字、掃引の外は -1)。
// 体積のボクセル (x, z) の端は元の画面の (crop_x[0] + x*src_px_per_vox, crop_y[0] + z*src_px_per_vox)。

export class VideoOverlay {
  constructor(el) {
    this.el = el;                       // { stage, video, canvas, play, prev, next, seek, band, time, status, legend, fill, width }
    this.map = null; this.labels = null; this.dims = null;
    this.cache = new Map(); this.hide = new Set();
    this.frame = -1; this.active = false;
    const v = el.video;
    v.muted = true; v.playsInline = true; v.preload = 'metadata';
    const tick = (now, meta) => { this.draw(meta.mediaTime); v.requestVideoFrameCallback(tick); };
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) v.requestVideoFrameCallback(tick);
    else v.addEventListener('timeupdate', () => this.draw(v.currentTime));
    v.addEventListener('seeked', () => this.draw(v.currentTime));
    v.addEventListener('loadeddata', () => { this.resize(); this.draw(v.currentTime); });
    v.addEventListener('play', () => { el.play.textContent = '一時停止'; });
    v.addEventListener('pause', () => { el.play.textContent = '再生'; });
    v.addEventListener('timeupdate', () => { if (!this.dragging) el.seek.value = v.currentTime; });
    el.play.addEventListener('click', () => v.paused ? v.play() : v.pause());
    el.prev.addEventListener('click', () => this.step(-1));
    el.next.addEventListener('click', () => this.step(1));
    el.seek.addEventListener('input', () => { this.dragging = true; v.pause(); v.currentTime = +el.seek.value; });
    el.seek.addEventListener('change', () => { this.dragging = false; });
    el.band.addEventListener('click', (e) => {
      const r = el.band.getBoundingClientRect();
      v.pause(); v.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (v.duration || 0);
    });
    el.fill.addEventListener('change', () => this.redraw());
    el.width.addEventListener('change', () => this.redraw());
    el.size.addEventListener('change', () => { this.resize(); this.redraw(); });
    window.addEventListener('resize', () => { if (this.active) { this.resize(); this.redraw(); } });
  }

  async load(jsonUrl, videoUrl) {
    this.clear();
    const token = this.token = Symbol();
    const r = await fetch(jsonUrl);
    if (!r.ok) throw new Error(`video_overlay.json: HTTP ${r.status}`);
    const map = await r.json();
    if (token !== this.token) return;
    this.map = map;
    this.t = Float64Array.from(map.frames.t);
    this.el.video.src = videoUrl;
    this.el.seek.max = this.t.at(-1);
    this.el.seek.step = 'any';
    this.drawBand();
    this.resize();
  }

  clear() {
    this.token = null; this.map = null; this.frame = -1; this.cache.clear();
    this.el.video.pause(); this.el.video.removeAttribute('src'); this.el.video.load();
    const g = this.el.canvas.getContext('2d'); g.clearRect(0, 0, this.el.canvas.width, this.el.canvas.height);
    this.el.status.textContent = ''; this.el.time.textContent = '';
  }

  setActive(on) {
    this.active = on;
    if (on) { this.el.video.preload = 'auto'; this.resize(); this.redraw(); } else this.el.video.pause();
  }

  // labels = { meta: {labels:[{id,name,color}]}, data }、dims = { nx, ny, nz }(静的版で間引かれていれば小さい)
  setLabels(labels, dims) {
    if (labels === this.labels) return;
    this.labels = labels; this.dims = dims; this.cache.clear();
    this.buildLegend();
    this.redraw();
  }

  buildLegend() {
    const box = this.el.legend; box.textContent = '';
    if (!this.labels) { box.textContent = '色分け(ラベル)がまだ読めていない'; return; }
    for (const l of this.labels.meta.labels) {
      const lab = document.createElement('label');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !this.hide.has(l.id);
      const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = l.color;
      lab.append(cb, sw, document.createTextNode(l.name));
      lab.dataset.id = l.id;
      cb.addEventListener('change', () => { cb.checked ? this.hide.delete(l.id) : this.hide.add(l.id); this.redraw(); });
      box.append(lab);
    }
  }

  // 表示の大きさ: 動画の縦横比のまま、選んだ高さに合わせる(幅が足りなければ幅に合わせる)
  resize() {
    const { stage, canvas } = this.el, sz = this.map?.src_size || [1640, 2360];
    const wantH = +this.el.size.value, maxW = stage.parentElement.clientWidth || 600;
    let w = wantH * sz[0] / sz[1];
    if (w > maxW) w = maxW;
    const h = w * sz[1] / sz[0];
    stage.style.width = `${Math.round(w)}px`; stage.style.height = `${Math.round(h)}px`;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }

  frameAt(time) {
    const t = this.t; if (!t) return -1;
    let lo = 0, hi = t.length;                  // time + 2ms 以下で最後のフレーム
    while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] <= time + 0.002) lo = m + 1; else hi = m; }
    return Math.max(0, lo - 1);
  }

  step(d) {
    const v = this.el.video; v.pause();
    const i = Math.min(Math.max(this.frameAt(v.currentTime) + d, 0), this.t.length - 1);
    v.currentTime = this.t[i] + Math.min(0.004, ((this.t[i + 1] ?? this.t[i] + 0.017) - this.t[i]) / 2);
  }

  redraw() { this.frame = -1; this.draw(this.el.video.currentTime); }

  drawBand() {
    const c = this.el.band, g = c.getContext('2d'), m = this.map;
    const W = c.width = c.clientWidth * (window.devicePixelRatio || 1) || 600, H = c.height = 10 * (window.devicePixelRatio || 1);
    g.clearRect(0, 0, W, H);
    if (!m) return;
    const T = this.t.at(-1) || 1;
    g.fillStyle = '#8a6d3b'; g.fillRect(0, 0, W, H);
    const [a, b] = m.sweep_video_s;
    g.fillStyle = '#2e9d5b'; g.fillRect(a / T * W, 0, (b - a) / T * W, H);
  }

  draw(time) {
    if (!this.map || !this.active) return;
    const i = this.frameAt(time);
    if (i === this.frame) return;
    this.frame = i;
    const m = this.map, k = m.frames.k[i], { canvas } = this.el, g = canvas.getContext('2d');
    g.clearRect(0, 0, canvas.width, canvas.height);
    const S = canvas.width / m.src_size[0], dpr = window.devicePixelRatio || 1;
    const [a, b] = m.sweep_video_s;
    this.el.time.textContent = `${time.toFixed(2)} / ${this.t.at(-1).toFixed(2)} 秒  コマ ${i + 1} / ${this.t.length}`;
    if (k < 0) {
      const where = time < a ? '前' : '後';
      const mv = m.frames.moving[i] ? 'Y 軸は掃引とは別に動いている' : 'Y 軸は止まっている(静止・プローブの持ち替え)';
      this.el.status.textContent = `掃引の${where}(掃引は ${a.toFixed(1)}〜${b.toFixed(1)} 秒)。${mv}。この区間は体積に入っていないので線を出さない`;
      this.el.status.className = 'vo-status out';
      // 掃引の外は、エコー画像の範囲を橙の破線で囲み、左上に札を出す
      g.save(); g.strokeStyle = '#ffb347'; g.lineWidth = 3 * dpr; g.setLineDash([10 * dpr, 6 * dpr]);
      g.strokeRect(m.crop_x[0] * S + 2 * dpr, m.crop_y[0] * S + 2 * dpr, (m.crop_x[1] - m.crop_x[0]) * S - 4 * dpr, (m.crop_y[1] - m.crop_y[0]) * S - 4 * dpr);
      g.restore();
      this.badge(g, `掃引の${where}: 体積に入っていない区間なので線なし`, '#ffb347', dpr, m.crop_y[0] * S);
      return;
    }
    const ny0 = m.shape_ZYX[1];
    this.el.status.textContent = `掃引中  Y ${(k * m.voxel_mm).toFixed(1)} mm (断面 ${k + 1} / ${ny0})`;
    this.el.status.className = 'vo-status';
    if (!this.labels) { this.badge(g, 'ラベルを読み込み中', '#9fe3ff', dpr, m.crop_y[0] * S); return; }
    const sl = this.slice(k);
    const pp = m.src_px_per_vox * S, f = sl.f;
    // 格子点 (i, j)(間引いた格子のボクセル中心)→ 画面: 元の格子のボクセル中心は i*f、ボクセルの端を整数とする座標では i*f + 0.5
    const ox = m.crop_x[0] * S, oy = m.crop_y[0] * S;
    if (this.el.fill.checked) {
      g.save(); g.imageSmoothingEnabled = false; g.globalAlpha = 0.15;
      g.drawImage(this.fillCanvas(sl), ox + (0.5 - f / 2) * pp, oy + (0.5 - f / 2) * pp, sl.nx * f * pp, sl.nz * f * pp);
      g.restore();
    }
    g.lineWidth = +this.el.width.value * dpr; g.lineCap = 'round'; g.lineJoin = 'round';
    for (const c of sl.contours) {
      if (this.hide.has(c.id)) continue;
      g.strokeStyle = c.color; g.beginPath();
      const s = c.segs;
      for (let q = 0; q < s.length; q += 4) {
        g.moveTo(ox + (s[q] * f + 0.5) * pp, oy + (s[q + 1] * f + 0.5) * pp);
        g.lineTo(ox + (s[q + 2] * f + 0.5) * pp, oy + (s[q + 3] * f + 0.5) * pp);
      }
      g.stroke();
    }
    const present = new Set(sl.contours.map(c => c.id));
    this.el.legend.querySelectorAll('label').forEach(l => l.classList.toggle('absent', !present.has(+l.dataset.id)));
  }

  badge(g, text, color, dpr, top = 0) {
    g.font = `${13 * dpr}px -apple-system, "Hiragino Sans", sans-serif`;
    const w = g.measureText(text).width + 12 * dpr;
    g.fillStyle = 'rgba(0,0,0,.7)'; g.fillRect(8 * dpr, top + 8 * dpr, w, 22 * dpr);
    g.fillStyle = color; g.fillText(text, 14 * dpr, top + 24 * dpr);
  }

  // Y の添字 k(元の格子)の断面: 間引いた格子での輪郭(マーチングスクエア、3×3 でならした 0/1 の 0.5 の線)
  slice(k) {
    const hit = this.cache.get(k); if (hit) return hit;
    const { nx, ny, nz } = this.dims, d = this.labels.data, m = this.map;
    const f = Math.max(1, Math.round(m.shape_ZYX[2] / nx));
    const kl = Math.min(Math.round(k / f), ny - 1);
    const lab = new Uint8Array(nx * nz);
    for (let z = 0; z < nz; z++) { const o = (z * ny + kl) * nx; lab.set(d.subarray(o, o + nx), z * nx); }
    const ids = new Set(); for (let q = 0; q < lab.length; q++) if (lab[q]) ids.add(lab[q]);
    const contours = [];
    const color = Object.fromEntries(this.labels.meta.labels.map(l => [l.id, l.color]));
    const a = new Float32Array(nx * nz), t = new Float32Array(nx * nz);
    for (const id of [...ids].sort((p, q) => p - q)) {
      for (let q = 0; q < lab.length; q++) a[q] = lab[q] === id ? 1 : 0;
      // 3×3 の平均(横 → 縦)
      for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
        const o = z * nx + x; let s = a[o], n = 1;
        if (x > 0) { s += a[o - 1]; n++; } if (x < nx - 1) { s += a[o + 1]; n++; } t[o] = s / n;
      }
      for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
        const o = z * nx + x; let s = t[o], n = 1;
        if (z > 0) { s += t[o - nx]; n++; } if (z < nz - 1) { s += t[o + nx]; n++; } a[o] = s / n;
      }
      contours.push({ id, color: color[id] || '#ffffff', segs: marching(a, nx, nz, 0.5) });
    }
    const out = { k, f, nx, nz, lab, contours };
    if (this.cache.size > 400) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(k, out);
    return out;
  }

  fillCanvas(sl) {
    if (sl.fillCv) return sl.fillCv;
    const c = document.createElement('canvas'); c.width = sl.nx; c.height = sl.nz;
    const g = c.getContext('2d'), im = g.createImageData(sl.nx, sl.nz);
    const rgb = Object.fromEntries(this.labels.meta.labels.map(l => [l.id, hex(l.color)]));
    for (let q = 0; q < sl.lab.length; q++) {
      const id = sl.lab[q]; if (!id || this.hide.has(id)) continue;
      const [r, gg, b] = rgb[id] || [255, 255, 255];
      im.data[q * 4] = r; im.data[q * 4 + 1] = gg; im.data[q * 4 + 2] = b; im.data[q * 4 + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    sl.fillCv = c;
    return c;
  }
}

function hex(c) { const n = parseInt(c.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

// マーチングスクエア: 格子点 (x, z) の値 a の level の線を、線分の端点 [x0, z0, x1, z1, ...] で返す
function marching(a, nx, nz, level) {
  const out = [];
  const lerp = (p, q) => (level - p) / (q - p);
  for (let z = 0; z < nz - 1; z++) {
    for (let x = 0; x < nx - 1; x++) {
      const o = z * nx + x;
      const v0 = a[o], v1 = a[o + 1], v2 = a[o + nx + 1], v3 = a[o + nx];   // 左上, 右上, 右下, 左下
      const c = (v0 > level ? 1 : 0) | (v1 > level ? 2 : 0) | (v2 > level ? 4 : 0) | (v3 > level ? 8 : 0);
      if (c === 0 || c === 15) continue;
      const T = [x + lerp(v0, v1), z], R = [x + 1, z + lerp(v1, v2)], B = [x + lerp(v3, v2), z + 1], L = [x, z + lerp(v0, v3)];
      const seg = (p, q) => out.push(p[0], p[1], q[0], q[1]);
      switch (c) {
        case 1: case 14: seg(L, T); break;
        case 2: case 13: seg(T, R); break;
        case 3: case 12: seg(L, R); break;
        case 4: case 11: seg(R, B); break;
        case 6: case 9: seg(T, B); break;
        case 7: case 8: seg(L, B); break;
        case 5: seg(L, T); seg(R, B); break;
        case 10: seg(T, R); seg(L, B); break;
      }
    }
  }
  return Float32Array.from(out);
}
