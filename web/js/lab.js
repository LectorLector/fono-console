// Lab (experimental) panels: room scan import + early reflection analysis.
import { h } from './widgets.js';
import { toast, setupCanvas, css } from './ui.js';

// ---------------------------------------------------------------- room scan
export function bboxFromObj(text) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('v ')) continue;
    const p = line.trim().split(/\s+/);
    const v = [parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3])];
    if (v.some(x => !isFinite(x))) continue;
    n++;
    for (let i = 0; i < 3; i++) { if (v[i] < mn[i]) mn[i] = v[i]; if (v[i] > mx[i]) mx[i] = v[i]; }
  }
  if (!n) throw new Error('OBJ 裡沒有頂點');
  return { ext: [0, 1, 2].map(i => mx[i] - mn[i]), up: null };
}

export function bboxFromGltfJson(j) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  let n = 0;
  for (const mesh of j.meshes || []) for (const pr of mesh.primitives || []) {
    const acc = (j.accessors || [])[pr.attributes?.POSITION];
    if (!acc || !acc.min || !acc.max) continue;
    n++;
    for (let i = 0; i < 3; i++) { if (acc.min[i] < mn[i]) mn[i] = acc.min[i]; if (acc.max[i] > mx[i]) mx[i] = acc.max[i]; }
  }
  if (!n) throw new Error('檔案裡找不到頂點範圍（POSITION min/max）');
  return { ext: [0, 1, 2].map(i => mx[i] - mn[i]), up: 'y' };
}

export function bboxFromGlb(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 20 || dv.getUint32(0, true) !== 0x46546C67) throw new Error('不是有效的 GLB 檔');
  let off = 12;
  while (off + 8 <= buf.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    if (type === 0x4E4F534A) return bboxFromGltfJson(JSON.parse(new TextDecoder().decode(new Uint8Array(buf, off + 8, len))));
    off += 8 + len;
  }
  throw new Error('GLB 缺少 JSON 區塊');
}

/** ext = [x,y,z] extents -> {L,W,H} in metres. */
export function dimsFromExtents(ext, up) {
  let [x, y, z] = ext;
  const mx = Math.max(x, y, z);
  const k = mx > 1500 ? 1000 : mx > 20 ? 100 : 1;   // millimetres / centimetres / metres
  x /= k; y /= k; z /= k;
  let H, a, b;
  if (up === 'y') { H = y; a = x; b = z; }
  else if (z < 3.5 && y > z) { H = z; a = x; b = y; }   // OBJ: z-up guess
  else { H = y; a = x; b = z; }
  return { L: Math.max(a, b), W: Math.min(a, b), H };
}

export function roomScanPanel(ctx) {
  const out = h('div', { class: 'hint' }, '尚未選擇檔案。');
  let found = null;
  const apply = h('button', { class: 'btn primary', type: 'button', disabled: '' }, '套用到房間尺寸');
  const file = h('input', { type: 'file', accept: '.obj,.glb,.gltf', style: 'display:none' });
  file.onchange = async () => {
    const f = file.files[0]; if (!f) return;
    try {
      const name = f.name.toLowerCase();
      let r;
      if (name.endsWith('.obj')) r = bboxFromObj(await f.text());
      else if (name.endsWith('.glb')) r = bboxFromGlb(await f.arrayBuffer());
      else r = bboxFromGltfJson(JSON.parse(await f.text()));
      found = dimsFromExtents(r.ext, r.up);
      out.textContent = `長 ${found.L.toFixed(2)} m × 寬 ${found.W.toFixed(2)} m × 高 ${found.H.toFixed(2)} m`;
      apply.disabled = false;
    } catch (e) { found = null; apply.disabled = true; out.textContent = ''; toast(f.name + '：' + e.message, true); }
    file.value = '';
  };
  apply.onclick = () => {
    if (!found) return;
    const S = ctx.S, d = S.dims;
    d.L = +found.L.toFixed(2); d.W = +found.W.toFixed(2); d.H = +found.H.toFixed(2);
    ctx.saveState(); ctx.dimsChanged?.();
    toast('已套用房間尺寸');
  };
  return h('div', { class: 'panel', id: 'scanPanel' },
    h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'S'), h('h2', {}, '房間掃描匯入'), h('span', { class: 'lab-tag' }, '實驗'), h('span', { class: 'rule' })),
    h('p', { class: 'hint', style: 'margin-top:0' }, 'iPhone Pro (LiDAR) 可用 3D 掃描 App 匯出 GLB/OBJ；Android 可用支援網格匯出的掃描 App；也可以直接用捲尺量。'),
    h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
      h('button', { class: 'btn', type: 'button', onclick: () => file.click() }, '選擇 .obj / .glb / .gltf'), file, apply),
    h('div', { style: 'margin-top:10px' }, out));
}

// ---------------------------------------------------------------- reflections
const guess = m => m < 0.6 ? '桌面或喇叭附近的反射' : m < 2 ? '側牆／天花板' : '後牆或遠處';

export function analyse(m) {
  const { ir, sr } = m;
  // direct sound = strongest sample in the first 30 ms (more robust than trusting irPeak alone)
  let pk = 0, pv = 0; const lim = Math.min(ir.length, Math.round(0.03 * sr) + (m.irPeak | 0));
  for (let i = 0; i < lim; i++) { const a = Math.abs(ir[i]); if (a > pv) { pv = a; pk = i; } }
  const w = Math.max(1, Math.round(0.00025 * sr)), n = ir.length;
  const sq = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) sq[i + 1] = sq[i] + ir[i] * ir[i];
  const etc = new Float64Array(n);
  for (let i = 0; i < n; i++) { const a = Math.max(0, i - (w >> 1)), b = Math.min(n, a + w); etc[i] = (sq[b] - sq[a]) / (b - a); }
  let ref = 0;
  for (let i = Math.max(0, pk - w); i <= Math.min(n - 1, pk + w); i++) ref = Math.max(ref, etc[i]);
  ref = ref || 1e-30;
  const db = i => 10 * Math.log10(etc[i] / ref + 1e-30);
  const lo = pk + Math.round(0.0006 * sr), hi = Math.min(n - 2, pk + Math.round(0.025 * sr)), gap = Math.round(0.0004 * sr);
  const cand = [];
  for (let i = Math.max(1, lo); i <= hi; i++) if (etc[i] >= etc[i - 1] && etc[i] > etc[i + 1] && db(i) > -25) cand.push(i);
  cand.sort((a, b) => etc[b] - etc[a]);
  const pick = [];
  for (const i of cand) { if (pick.length >= 6) break; if (pick.every(j => Math.abs(j - i) >= gap)) pick.push(i); }
  pick.sort((a, b) => a - b);
  // The ETC is a 0.25 ms moving average, so its maximum sits somewhere on a plateau as wide as the window (up to ~0.15 ms off).
  // Refine each pick to the strongest sample inside that window so the delay is accurate to about one sample.
  const refine = i => { let b = i, bv = -1; for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) { const v = Math.abs(ir[j]); if (v > bv) { bv = v; b = j; } } return b; };
  const rows = pick.map(i => { const j = refine(i), ms = (j - pk) / sr * 1000, path = ms / 1000 * 343; return { ms, path, db: db(i) }; });
  return { etc, db, pk, sr, rows };
}

export function reflectionPanel(ctx, getResults) {
  const body = h('div', {});
  const draw = () => {
    body.innerHTML = '';
    const res = getResults() || {};
    const m = Object.values(res).map(l => l && l[0]).find(x => x && x.ir && x.ir.length);
    if (!m) { body.append(h('p', { class: 'hint' }, '先做一次一鍵校正')); return; }
    const a = analyse(m);
    const cv = h('canvas', { class: 'curve', style: 'height:140px;width:100%' });
    const tb = h('table', { class: 'modes-table' },
      h('tr', {}, h('th', {}, '延遲'), h('th', {}, '多走的路'), h('th', {}, '強度'), h('th', {}, '可能來源')),
      ...(a.rows.length ? a.rows.map(r => h('tr', {}, h('td', {}, r.ms.toFixed(2) + ' ms'), h('td', {}, Math.round(r.path * 100) + ' cm'), h('td', {}, r.db.toFixed(1) + ' dB'), h('td', {}, guess(r.path))))
        : [h('tr', {}, h('td', { colspan: '4' }, '沒有明顯的早期反射。'))]));
    body.append(cv, h('div', { style: 'margin-top:10px;max-height:300px;overflow:auto' }, tb));
    requestAnimationFrame(() => {
      const c = setupCanvas(cv); if (!c) return;
      const { g, w, h: H } = c, T = 30, mn = -60, pad = 24;
      const X = ms => pad + ms / T * (w - pad - 6), Y = d => 6 + (0 - Math.max(mn, d)) / -mn * (H - 22);
      g.lineWidth = 1; g.strokeStyle = css('--line') || '#444'; g.fillStyle = css('--ink-3') || '#888'; g.font = '10px sans-serif';
      for (let ms = 0; ms <= T; ms += 5) { g.beginPath(); g.moveTo(X(ms), 6); g.lineTo(X(ms), H - 16); g.stroke(); g.fillText(ms + '', X(ms) - 4, H - 4); }
      for (let d = 0; d >= mn; d -= 20) { g.beginPath(); g.moveTo(pad, Y(d)); g.lineTo(w - 6, Y(d)); g.stroke(); g.fillText(d + '', 0, Y(d) + 3); }
      g.strokeStyle = css('--accent') || '#c2a47e'; g.lineWidth = 1.5; g.beginPath();
      const i0 = Math.max(0, a.pk - Math.round(0.002 * a.sr)), i1 = Math.min(a.etc.length - 1, a.pk + Math.round(T / 1000 * a.sr));
      for (let i = i0, first = true; i <= i1; i += 1) { const ms = (i - a.pk) / a.sr * 1000; const x = X(Math.max(0, ms)), y = Y(a.db(i)); if (ms < 0) continue; first ? (g.moveTo(x, y), first = false) : g.lineTo(x, y); }
      g.stroke();
      g.fillStyle = css('--warn') || '#c9a04a';
      for (const r of a.rows) { g.beginPath(); g.arc(X(r.ms), Y(r.db), 3, 0, 7); g.fill(); }
    });
  };
  const btn = h('button', { class: 'btn', type: 'button', onclick: draw }, '重新分析');
  const root = h('div', { class: 'panel', id: 'reflPanel' },
    h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'R'), h('h2', {}, '早期反射分析'), h('span', { class: 'lab-tag' }, '實驗'), h('span', { class: 'rule' })),
    h('p', { class: 'hint', style: 'margin-top:0' }, '從量測找出桌面、牆面反射的距離與強度（0.6–25 ms，高於直達聲 −25 dB）。'), btn, h('div', { style: 'height:10px' }), body);
  root.refresh = draw; draw();
  return root;
}
