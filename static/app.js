import { Stack3D } from './stack3d.js';

// 動き方は2通り。サーバー版(server.py が api/ を返す)と、export-static で書き出した静的版(data/ の JSON を読むだけ)。
// どちらも相対 URL だけを使う(GitHub Pages の /<repo>/ 配下でも動くように)。
const STATIC = document.querySelector('meta[name=echo3d-mode]')?.content === 'static';
const getJSON = async (u) => { const r = await fetch(u); const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; };
const api = {
  samples: () => getJSON(STATIC ? 'data/samples.json' : 'api/samples'),
  runs: () => getJSON(STATIC ? 'data/runs.json' : 'api/runs'),
  run: (id) => getJSON(STATIC ? `data/runs/${enc(id)}/meta.json` : `api/runs/${enc(id)}`),
  slices: (id) => STATIC ? `data/runs/${enc(id)}/slices.json` : `api/runs/${enc(id)}/slices`,
  file: (id, f) => (STATIC ? `data/runs/${enc(id)}/` : `runs/${enc(id)}/`) + f.split('/').map(enc).join('/'),
  download: (id, f) => STATIC ? api.file(id, f) : api.file(id, f) + '?download=1',
};

const $ = (id) => document.getElementById(id);
const radio = (name) => document.querySelector(`input[name=${name}]:checked`).value;
const enc = encodeURIComponent;
let samples = [], selectedSample = null, currentRun = null, es = null, nv = null, nvRun = null;

// ------------------------------------------------------------ 入力フォーム
function syncForm() {
  const type = radio('type'), src = radio('source');
  document.querySelectorAll('.still-only').forEach(e => e.classList.toggle('hidden', type !== 'still'));
  document.querySelectorAll('.video-only').forEach(e => e.classList.toggle('hidden', type !== 'video'));
  $('src-path').classList.toggle('hidden', src !== 'path');
  $('src-upload').classList.toggle('hidden', src !== 'upload');
  $('src-sample').classList.toggle('hidden', src !== 'sample');
  $('files').accept = type === 'video' ? 'video/*,.mp4,.mov,.m4v,.avi' : 'image/*';
  $('files').multiple = type === 'still';
  $('path').placeholder = type === 'video' ? '/Users/.../video_000042_xxx.mp4' : '/Users/.../01_raw_xxx/22_MSK_-30~30';
  $('angles').placeholder = type === 'video' ? '0~35' : '-30~30(空欄ならフォルダ名から)';
  $('voxel').disabled = $('voxel_auto').checked;
}
document.querySelectorAll('input[name=type], input[name=source]').forEach(e => e.addEventListener('change', () => {
  if (radio('source') !== 'sample') { selectedSample = null; markSample(); }
  syncForm();
}));
$('voxel_auto').addEventListener('change', syncForm);
$('files').addEventListener('change', () => {
  const fs = [...$('files').files];
  $('upinfo').textContent = fs.length ? `${fs.length} 個 (${(fs.reduce((a, f) => a + f.size, 0) / 1e6).toFixed(1)} MB)` : '';
});
$('choose').addEventListener('click', async () => {
  $('choose').disabled = true;
  try {
    const r = await getJSON(`api/choose?kind=${radio('type') === 'video' ? 'file' : 'folder'}`);
    if (r.path) $('path').value = r.path;
  } finally { $('choose').disabled = false; }
});

function markSample() {
  document.querySelectorAll('#samples button').forEach(b => b.classList.toggle('active', b.dataset.id === selectedSample?.id));
  document.querySelector('input[name=source][value=sample]').disabled = !selectedSample;
}

function pickSample(s) {
  if (STATIC) {                       // 静的版: サンプルの再構成結果を開く
    selectedSample = s; markSample();
    if (s.run) openRun(s.run, true);
    return;
  }
  selectedSample = s;
  document.querySelector(`input[name=type][value=${s.type}]`).checked = true;
  const sr = document.querySelector('input[name=source][value=sample]');
  sr.disabled = false; sr.checked = true;
  $('angles').value = s.angles || '';
  $('pivot').value = s.pivot ?? '';
  $('voxel').value = s.voxel ?? 0.3;
  $('voxel_auto').checked = false;
  $('mode').value = s.mode || 'decorr';
  $('step').value = ''; $('depth').value = ''; $('drop_air').checked = false;
  $('name').value = '';
  $('sampleinfo').textContent = `${s.title}: ${s.note} (samples/${s.path})`;
  markSample();
  syncForm();
}

async function loadSamples() {
  samples = await api.samples();
  $('samples').innerHTML = '';
  for (const s of samples) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.id = s.id; b.textContent = s.title; b.title = s.note;
    b.addEventListener('click', () => pickSample(s));
    $('samples').appendChild(b);
  }
}

async function upload(type) {
  const fs = [...$('files').files];
  if (!fs.length) throw new Error('ファイルを選んでください');
  if (type === 'video' && fs.length !== 1) throw new Error('動画は1本だけ選んでください');
  const uid = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let n = 0;
  for (const f of fs) {
    $('runmsg').textContent = `アップロード中 ${++n} / ${fs.length}`;
    const r = await fetch(`api/upload/${uid}/${enc(f.name)}?mtime=${f.lastModified}`, { method: 'PUT', body: f });
    if (!r.ok) throw new Error(`アップロード失敗: ${f.name}`);
  }
  return uid;
}

$('run').addEventListener('click', async () => {
  const type = radio('type'), source = radio('source');
  const p = {
    type, source, name: $('name').value.trim(), angles: $('angles').value.trim(), step: $('step').value,
    mode: $('mode').value, pivot: $('pivot').value, voxel: $('voxel').value, voxel_auto: $('voxel_auto').checked,
    depth: $('depth').value, drop_air: $('drop_air').checked,
  };
  if (type === 'video' && !p.angles) { $('runmsg').textContent = '動画は角度の範囲が要る(例 0~35)'; return; }
  $('run').disabled = true;
  try {
    if (source === 'path') p.path = $('path').value.trim();
    if (source === 'sample') p.sample = selectedSample.id;
    if (source === 'upload') p.upload_id = await upload(type);
    const r = await fetch('api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    $('runmsg').textContent = `実行中: ${j.id}`;
    follow(j.id, true);
    refreshRuns();
  } catch (e) {
    $('runmsg').textContent = 'エラー: ' + e.message;
  } finally { $('run').disabled = false; }
});

// ------------------------------------------------------------ ログと実行一覧
async function follow(id, openWhenDone) {
  es?.close();
  $('log').textContent = '';
  if (STATIC) {
    try { const r = await fetch(api.file(id, 'log.txt')); $('log').textContent = r.ok ? await r.text() : ''; } catch { /* ログが無い */ }
    return;
  }
  es = new EventSource(`api/runs/${enc(id)}/events`);
  es.onmessage = (ev) => {
    const line = JSON.parse(ev.data);
    const atEnd = $('log').scrollTop + $('log').clientHeight >= $('log').scrollHeight - 4;
    $('log').textContent += line + '\n';
    if (atEnd) $('log').scrollTop = $('log').scrollHeight;
  };
  es.addEventListener('done', (ev) => {
    es.close(); es = null;
    const st = JSON.parse(ev.data);
    if (openWhenDone) {
      $('runmsg').textContent = st === 'done' ? `完了: ${id}` : `失敗: ${id}`;
      refreshRuns();
      openRun(id, false);
    }
  });
  es.onerror = () => { es?.close(); es = null; };
}

async function refreshRuns() {
  const runs = await api.runs();
  $('runs').innerHTML = '';
  const label = { done: '完了', error: '失敗', running: '実行中', queued: '待ち', interrupted: '中断' };
  for (const r of runs) {
    const li = document.createElement('li');
    li.dataset.id = r.id;
    li.classList.toggle('active', r.id === currentRun);
    li.innerHTML = `<span></span><span class="st ${r.state}">${r.type === 'video' ? '動画' : '静止画'} ${label[r.state] || r.state}</span>`;
    li.firstChild.textContent = r.title || r.id;
    li.title = r.id;
    li.addEventListener('click', () => openRun(r.id, true));
    $('runs').appendChild(li);
  }
}
$('refresh').addEventListener('click', refreshRuns);
$('importbtn').addEventListener('click', async () => {
  $('importbtn').disabled = true;
  try {
    const r = await fetch('api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                           body: JSON.stringify({ path: $('importpath').value }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    $('importmsg').textContent = `読み込んだ: ${j.id}`;
    await refreshRuns();
    openRun(j.id, true);
  } catch (e) { $('importmsg').textContent = 'エラー: ' + e.message; }
  finally { $('importbtn').disabled = false; }
});

// ------------------------------------------------------------ 結果
const stack = new Stack3D($('c3'), $('c3label'));
window.stack = stack;

async function openRun(id, showLog) {
  currentRun = id;
  document.querySelectorAll('#runs li').forEach(li => li.classList.toggle('active', li.dataset.id === id));
  if (showLog) follow(id, false);
  const m = await api.run(id);
  $('rtitle').textContent = m.title || id;
  const p = m.params || {}, ri = m.run_info;
  const ok = m.files && m.files['volume.nrrd'];
  $('rinfo').textContent = ri
    ? `${p.type === 'video' ? '動画' : '静止画'}  角度 ${ri.angles_deg[0].toFixed(1)}〜${ri.angles_deg.at(-1).toFixed(1)}° (${ri.angles_deg.length} 枚)  ` +
      `ボクセル ${ri.voxel_mm} mm  大きさ ${ri.volume_shape_ZYX.join('×')} (深さ×振り×横幅)  表示深さ ${ri.depth_cm} cm  ` +
      `${ri.px_per_cm.toFixed(2)} px/cm  pivot ${ri.pivot_cm} cm`
    : `状態: ${m.state}${m.error ? '  ' + m.error : ''}`;
  for (const [a, f] of [['dl-vol', 'volume.nrrd'], ['dl-disp', 'volume_display.nrrd']]) {
    $(a).href = api.download(id, f);
    if (STATIC) $(a).setAttribute('download', `${id}_${f}`);
    $(a).classList.toggle('disabled', !(m.files && m.files[f]));
  }
  const t = Date.now();
  $('img-fan').src = m.files?.['view_fan_plane.png'] ? api.file(id, 'view_fan_plane.png') + `?t=${t}` : '';
  $('img-depth').src = m.files?.['view_depth_slices.png'] ? api.file(id, 'view_depth_slices.png') + `?t=${t}` : '';
  if (!ok) { stack.clear(); return; }
  try {
    await stack.load({ slices: api.slices(id), file: (f) => api.file(id, f) });
    $('prog').max = stack.slices.length;
    autoWindow();
    buildLabelList();
    if (activeTab() === 'nv') await loadNiivue();
    stack.play();
  } catch (e) {
    $('c3label').textContent = '読み込み失敗: ' + e.message;
    console.error(e);
  }
}

// ------------------------------------------------------------ アニメーションとレンダの操作
stack.onchange = () => {
  $('prog').value = stack.k;
  $('progtxt').textContent = `${stack.k} / ${stack.slices.length}`;
  $('play').textContent = stack.playing ? '一時停止' : '再生';
};
$('play').addEventListener('click', () => stack.playing ? stack.pause() : stack.play());
// 値は pause() より先に読む。pause() の onchange がスライダーを今の位置に書き戻すので、後で読むと動かした先が消える
$('prog').addEventListener('input', () => { const k = +$('prog').value; stack.pause(); stack.setProgress(k); });
$('speed').addEventListener('input', () => stack.speed = +$('speed').value);
$('vmode').addEventListener('change', () => stack.setMode($('vmode').value));
function readParams() {
  return {
    shade: $('shade').checked, laz: +$('laz').value, lel: +$('lel').value, spec: $('spec').value / 100,
    lo: $('tlo').value / 100, hi: $('thi').value / 100, gamma: $('tgam').value / 100, opacity: $('top').value / 100, bright: $('tbri').value / 100,
    denoise: +$('denoise').value, invert: $('invert').checked,
    colorMode: $('cmode').value, structOp: $('sop').value / 100, bgOp: $('bgop').value / 100, cx: $('cx').value / 100, cy: $('cy').value / 100, cz: $('cz').value / 100,
  };
}
for (const id of ['shade', 'laz', 'lel', 'spec', 'tlo', 'thi', 'tgam', 'top', 'tbri', 'cx', 'cy', 'cz', 'cmode', 'sop', 'bgop'])
  $(id).addEventListener('input', () => { stack.set(readParams()); drawTF(); });
// 構造の一覧(ラベルがある実行だけ)。チェックで表示を切り替える
function buildLabelList() {
  const L = stack.labels;
  $('labelrow').hidden = !L;
  const box = $('labellist'); box.textContent = '';
  if (!L) return;
  for (const l of L.meta.labels) {
    const lab = document.createElement('label');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true; cb.dataset.id = l.id;
    const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = l.color;
    lab.append(cb, sw, document.createTextNode(l.name));
    cb.addEventListener('change', () => {
      const show = Object.fromEntries([...box.querySelectorAll('input')].map(c => [c.dataset.id, c.checked]));
      stack.set({ show });
    });
    box.append(lab);
  }
  stack.set(readParams());
}
// 平滑化や反転を変えたら、表示する値の分布が変わるので窓も合わせ直す
function autoWindow() {
  const w = stack.autoWindow(); if (!w) return;
  $('tlo').value = Math.round(w.lo * 100); $('thi').value = Math.max(Math.round(w.hi * 100), +$('tlo').value + 1);
  stack.set(readParams()); drawTF();
}
for (const id of ['denoise', 'invert']) $(id).addEventListener('change', () => { stack.set(readParams()); autoWindow(); });
$('autowin').addEventListener('click', autoWindow);
$('gsmooth').addEventListener('change', () => stack.set({ smooth: +$('gsmooth').value }));
stack.set(readParams());

function drawTF() {
  const c = $('tf'), g = c.getContext('2d'), W = c.width, H = c.height;
  g.fillStyle = '#0b0c0f'; g.fillRect(0, 0, W, H);
  const h = stack.histogram;
  if (h) {
    const mx = Math.log1p(Math.max(...h));
    g.fillStyle = '#3b4250';
    for (let i = 0; i < 256; i++) {
      const y = Math.log1p(h[i]) / mx * (H - 4);
      g.fillRect(i * W / 256, H - y, Math.ceil(W / 256), y);
    }
  }
  const p = stack.params;
  g.strokeStyle = '#ffb347'; g.lineWidth = 2; g.beginPath();
  for (let i = 0; i <= W; i++) {
    const v = i / W, x = Math.min(Math.max((v - p.lo) / Math.max(p.hi - p.lo, 1e-3), 0), 1);
    const a = p.opacity * Math.pow(x, p.gamma);
    const y = H - 2 - a * (H - 6);
    i ? g.lineTo(i, y) : g.moveTo(i, y);
  }
  g.stroke();
  g.fillStyle = '#9aa3ae'; g.font = '10px sans-serif';
  g.fillText('不透明度', 4, 11); g.fillText('輝度 →', W - 40, H - 4);
}

// ------------------------------------------------------------ NiiVue
async function ensureNiivue() {
  if (nv) return nv;
  const { Niivue } = await import('@niivue/niivue');
  nv = new Niivue({ backColor: [0, 0, 0, 1], show3Dcrosshair: true, multiplanarShowRender: 1, isColorbar: false,
                    dragAndDropEnabled: false, crosshairColor: [1, 0.8, 0.2, 1] });
  window.nv = nv;
  nv.onLocationChange = (d) => { $('nvloc').textContent = d.string || ''; };
  await nv.attachToCanvas($('gl'));
  applyNvLayout();
  return nv;
}
function applyNvLayout() {
  if (!nv) return;
  const v = $('nvlayout').value;
  nv.setSliceType(v === 'render' ? nv.sliceTypeRender : v === 'axial' ? nv.sliceTypeAxial : nv.sliceTypeMultiplanar);
}
async function loadNiivue() {
  if (!currentRun) return;
  await ensureNiivue();
  if (nvRun === currentRun) return;
  nvRun = currentRun;
  await nv.loadVolumes([{ url: api.file(currentRun, 'volume_display.nrrd'), colormap: 'gray' }]);
  nv.setVolumeRenderIllumination($('nvillum').value / 100);
  applyNvWindow();
}
function applyNvWindow() {
  if (!nv?.volumes?.length) return;
  nv.volumes[0].cal_min = +$('nvlo').value;
  nv.volumes[0].cal_max = Math.max(+$('nvhi').value, +$('nvlo').value + 1);
  nv.updateGLVolume();
}
$('nvlayout').addEventListener('change', applyNvLayout);
$('nvillum').addEventListener('change', () => nv?.setVolumeRenderIllumination($('nvillum').value / 100));
$('nvlo').addEventListener('input', applyNvWindow);
$('nvhi').addEventListener('input', applyNvWindow);

// ------------------------------------------------------------ タブ
function activeTab() { return document.querySelector('.tab.active').dataset.tab; }
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', async () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('hidden', p.id !== 'tab-' + b.dataset.tab));
  if (b.dataset.tab === 'nv') await loadNiivue();
  if (b.dataset.tab === 'anim') stack.resize();
}));

// ------------------------------------------------------------ 起動
if (STATIC) {          // 静的版: 再構成の入力は使えない
  $('staticnote').classList.remove('hidden');
  document.querySelectorAll('#left .card').forEach(c => {
    if (c.querySelector('#run') || c.querySelector('input[name=type]')) c.classList.add('hidden');
  });
  $('refresh').classList.add('hidden');
  $('importrow').classList.add('hidden');
  document.querySelector('header .sub').textContent += '(公開版: 閲覧のみ)';
}
syncForm();
await loadSamples();
await refreshRuns();
const first = document.querySelector('#runs li');
const q = new URLSearchParams(location.search).get('run');
if (q) openRun(q, true); else if (first) openRun(first.dataset.id, true);
