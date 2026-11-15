// Settings panels for: update check, correction profiles (+ A/B key), backup / restore / reset, bug-report bundle.
// Pure logic lives in profiles.js / backup.js / bugreport.js (unit-tested); this file is the DOM glue.
// E (from app.js): { S (getter), RT, changed(), saveNow(), afterCorrectionChange(), genConfig() }
import { h, toast, api, post, dialog, saveFile } from './ui.js';
import { toggle } from './widgets.js';
import { getLang, t as tl } from './i18n.js';
import * as applog from './applog.js';
import { makeProfile, applyProfile, validateProfile, layoutMismatch, renameProfile, deleteProfile, exportProfiles, importProfiles, abToggle, abNext, MAX_PROFILES } from './profiles.js';
import { buildBackup, validateBackup, restoredState, resetState, replaceState } from './backup.js';
import { buildBundle } from './bugreport.js';

const ph = (tag, title, en) => h('div', { class: 'ph' }, h('span', { class: 'tag' }, tag), h('h2', {}, title), en ? h('span', { class: 'en' }, en) : '', h('span', { class: 'rule' }));
const today = () => new Date().toISOString().slice(0, 10);
const readText = f => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => no(r.error); r.readAsText(f); });
const fileInput = (accept, onFile) => { const i = h('input', { type: 'file', accept, hidden: '' }); i.onchange = () => { const f = i.files[0]; i.value = ''; if (f) onFile(f); }; return i; };

// ================================================================ update check
const updRenderers = new Set();
/** Ask the server (cached for 24 h unless force). Never throws; sets RT.update / RT.updateErr, the rail badge and re-renders the panel. */
export async function checkUpdate(E, force = false) {
  E.RT.updateBusy = true; updRenderers.forEach(f => f());
  try { E.RT.update = await api('/api/update/check' + (force ? '?force=1' : '')); E.RT.updateErr = ''; }
  catch (e) { E.RT.updateErr = e.body?.error || e.message || 'error'; }
  E.RT.updateBusy = false; markUpdate(E); updRenderers.forEach(f => f());
  return E.RT.update;
}
/** Small dot on the settings rail button while a newer version exists that the user has not looked at yet. */
export function markUpdate(E) {
  const u = E.RT.update;
  document.documentElement.toggleAttribute('data-update', !!(u?.newer && u.latest !== E.S.ui.updateSeen));
}
export function updatePanel(E) {
  const box = h('div', { class: 'panel', 'data-pk': 'update' }, ph('U', '軟體更新', 'Updates'));
  const body = h('div', { class: 'upd-body' });
  const tg = toggle({ label: '自動檢查更新', sub: '開啟程式時查詢 GitHub 最新版（一天最多一次）；不會自動下載', value: E.S.ui.updateCheck !== false, onInput: v => { E.S.ui.updateCheck = v; E.changed(); } });
  const btn = h('button', { class: 'btn', type: 'button', id: 'updCheckBtn', onclick: async () => { const r = await checkUpdate(E, true); if (E.RT.updateErr) toast('無法連線到 GitHub，請稍後再試', true); else if (!r?.newer) toast('目前已是最新版'); } }, '立即檢查');
  const render = () => {
    const u = E.RT.update, cur = u?.current || E.RT.sys?.version || '';
    btn.disabled = !!E.RT.updateBusy;
    body.innerHTML = '';
    const msg = E.RT.updateBusy ? '檢查中…' : E.RT.updateErr ? '無法連線到 GitHub，請稍後再試' : !u ? '尚未檢查' : u.newer ? '' : `目前版本 ${cur} 已是最新`;
    if (msg) body.append(h('p', { class: 'hint' }, msg, u && !u.newer && u.stale ? h('span', { class: 'upd-note' }, '離線，顯示上次的結果') : '', u && u.demo ? h('span', { class: 'upd-note' }, '示範資料') : ''));
    if (u?.newer && !E.RT.updateBusy) {
      body.append(h('div', { class: 'banner upd-banner', role: 'status' },
        h('div', {}, h('b', {}, '有新版本'), h('span', { class: 'mono', 'data-i18n-skip': '' }, ` ${cur} → ${u.latest}`)),
        u.notes ? h('pre', { class: 'upd-notes', 'data-i18n-skip': '' }, u.notes) : '',
        h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
          h('button', { class: 'btn primary', type: 'button', id: 'updOpenBtn', onclick: () => post('/api/open', { url: u.url }).catch(() => toast('無法開啟瀏覽器', true)) }, '開啟發佈頁面'))));
      if (E.S.page === 'settings' && E.S.ui.updateSeen !== u.latest) {   // looking at the banner clears the rail badge
        E.S.ui.updateSeen = u.latest; E.save(); markUpdate(E);
      }
    }
  };
  for (const f of updRenderers) if (!f.box.isConnected) updRenderers.delete(f);
  render.box = box; updRenderers.add(render);
  box.append(tg.el, h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px' }, btn), body,
    h('p', { class: 'hint' }, '只會向 api.github.com 查詢版本號（附上程式版本當 User-Agent），不會送出任何設定或錄音；更新要自己到發佈頁面下載。'));
  render();
  return box;
}

// ================================================================ correction profiles
const LAYOUT_NAME = { hp: '耳機', '2.0': '2.0', '2.1': '2.1', '2.2': '2.2', '4.0': '4.0', '4.1': '4.1', '4.2': '4.2' };
/** Short toast text for what applyProfile reported. */
const warnText = w => ({ layout: '設定檔是為另一種版面存的，版面沒有改變', 'fir-stale': 'FIR 檔案已不是存檔時那一份，FIR 維持原狀', 'art-stale': 'ART 檔案已不是存檔時那一份，ART 維持原狀', 'phase-stale': '左右相位 FIR 已不是存檔時那一份，維持原狀' }[w] || w);

export function loadProfile(E, p, { confirmed = false } = {}) {
  const S = E.S;
  if (!confirmed && layoutMismatch(S, p)) return 'confirm';
  const r = applyProfile(S, p);
  if (!r.applied) { toast('設定檔內容無效，沒有載入', true); return 'invalid'; }
  E.afterCorrectionChange();
  toast(`已載入「${p.name}」`);
  for (const w of r.warnings) if (w !== 'layout') toast(warnText(w), true);
  return 'ok';
}

export function profilesPanel(E) {
  const box = h('div', { class: 'panel', 'data-pk': 'profiles' }, ph('P', '校正設定檔', 'Correction profiles'));
  const list = h('div', { class: 'prof-list' }), abBox = h('div', { class: 'prof-ab' });
  const name = h('input', { type: 'text', id: 'profName', placeholder: '設定檔名稱', maxlength: 60, 'data-i18n-skip': '' });
  const incFx = h('input', { type: 'checkbox', id: 'profFx' });
  const rerender = () => { renderList(); renderAB(); E.refreshAB?.(); };
  const save = () => {
    const S = E.S; if (S.profiles.length >= MAX_PROFILES) { toast('設定檔已達上限', true); return; }
    S.profiles.push(makeProfile(S, name.value || tl(`設定檔 ${S.profiles.length + 1}`), { includeFx: incFx.checked }));
    name.value = ''; E.changed(); rerender(); toast('已儲存目前的校正設定');
  };
  const doLoad = async p => {
    let st = loadProfile(E, p);
    if (st === 'confirm') {
      const ok = await dialog({ title: '版面不同', body: `「${p.name}」是為 ${LAYOUT_NAME[p.data.layout] || p.data.layout} 版面儲存的，目前是 ${LAYOUT_NAME[E.S.room.layout] || E.S.room.layout}。載入只會套用校正數值，不會更改版面或裝置。`, choices: [{ label: '仍然載入', value: true, kind: 'primary' }] });
      if (ok) st = loadProfile(E, p, { confirmed: true }); else return;
    }
    rerender();
  };
  const doRename = async p => {
    const r = await dialog({ title: '重新命名', body: '', input: { value: p.name, max: 60 }, choices: [{ label: '儲存', value: true, kind: 'primary' }] });
    if (r && r.text) { renameProfile(E.S, p.id, r.text); E.changed(); rerender(); }
  };
  const doDelete = async p => {
    if (await dialog({ title: '刪除設定檔', body: `要刪除「${p.name}」嗎？這個動作不能復原。`, choices: [{ label: '刪除', value: true, kind: 'danger' }] })) { deleteProfile(E.S, p.id); E.changed(); rerender(); }
  };
  const dl = (ps, fname) => { saveFile(fname, JSON.stringify(exportProfiles(ps, 'Fono Console ' + (E.RT.sys?.version || '')), null, 2), 'application/json'); toast('已匯出設定檔'); };
  const imp = fileInput('.json,application/json', async f => {
    let j; try { j = JSON.parse(await readText(f)); } catch { toast('這不是有效的 JSON 檔', true); return; }
    const r = importProfiles(E.S, j);
    if (!r.ok) { toast(r.error === 'newer-version' ? '這個檔案來自較新的版本，請先更新程式' : '檔案裡沒有可用的校正設定檔', true); return; }
    E.S.profiles.push(...r.profiles); E.changed(); rerender();
    toast(r.skipped.length ? `已匯入 ${r.profiles.length} 個設定檔，略過 ${r.skipped.length} 個無效的` : `已匯入 ${r.profiles.length} 個設定檔`, !!r.skipped.length);
  });
  function renderList() {
    list.innerHTML = '';
    const ps = E.S.profiles;
    if (!ps.length) list.append(h('p', { class: 'hint' }, '還沒有設定檔。把現在調好的房間矯正存起來，之後可以隨時切回來。'));
    for (const p of ps) {
      const bad = !validateProfile(p).ok;
      list.append(h('div', { class: 'prof-row' + (bad ? ' bad' : ''), 'data-id': p.id },
        h('div', { class: 'prof-name' }, h('b', { 'data-i18n-skip': '' }, p.name), h('small', {}, h('span', { 'data-i18n-skip': '' }, `${LAYOUT_NAME[p.data?.layout] || '?'} · ${String(p.created || '').slice(0, 10)}`), p.data?.fx ? h('span', { class: 'prof-tag' }, '含音效') : '', bad ? h('span', { class: 'prof-tag warn' }, '內容無效') : '')),
        h('div', { class: 'prof-btns' },
          h('button', { class: 'btn', type: 'button', disabled: bad ? '' : null, onclick: () => doLoad(p) }, '載入'),
          h('button', { class: 'btn ghost', type: 'button', onclick: () => doRename(p) }, '重新命名'),
          h('button', { class: 'btn ghost', type: 'button', disabled: bad ? '' : null, onclick: () => dl([p], `fono-profile-${p.name.replace(/[^\w一-鿿-]+/g, '_')}.json`) }, '匯出'),
          h('button', { class: 'btn ghost', type: 'button', onclick: () => doDelete(p) }, '刪除'))));
    }
  }
  function renderAB() {
    abBox.innerHTML = '';
    const ps = E.S.profiles.filter(p => validateProfile(p).ok), ab = E.S.ui.ab;
    const sel = (key, label) => {
      const s = h('select', { id: 'ab' + key.toUpperCase() }, h('option', { value: '' }, '—'), ...ps.map(p => h('option', { value: p.id, selected: ab[key] === p.id ? '' : null, 'data-i18n-skip': '' }, p.name)));
      s.onchange = () => { ab[key] = s.value; ab.cur = ''; E.changed(); E.refreshAB?.(); };
      return h('label', { class: 'field' }, h('span', {}, label), s);
    };
    abBox.append(h('div', { class: 'ab-grid' }, sel('a', '快速切換 A'), sel('b', '快速切換 B')),
      h('p', { class: 'hint' }, ps.length < 2 ? '存好兩個設定檔後，可以在這裡選 A、B；頂端列會出現「A/B」鍵，一按就在兩者之間切換，方便對聽。' : '頂端列的「A/B」鍵會在這兩個設定檔之間切換（只有版面相同時才會切換）。'));
  }
  box.append(
    h('div', { class: 'prof-save' }, name, h('label', { class: 'chk' }, incFx, h('span', {}, '包含音效（EQ、混響…）')), h('button', { class: 'btn primary', type: 'button', id: 'profSave', onclick: save }, '另存目前設定')),
    list, abBox,
    h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px' },
      h('button', { class: 'btn', type: 'button', onclick: () => E.S.profiles.length ? dl(E.S.profiles, `fono-profiles-${today()}.json`) : toast('沒有可以匯出的設定檔', true) }, '匯出全部'),
      h('button', { class: 'btn', type: 'button', onclick: () => imp.click() }, '匯入'), imp),
    h('p', { class: 'hint' }, '設定檔記下每顆喇叭的增益、延遲、極性與矯正濾波器、重低音、FIR／ART、左右對稱與目標曲線。載入時不會更改裝置選擇或喇叭版面。'));
  rerender();
  return box;
}

/** The A/B key in the top bar. Returns the element; call .refresh() whenever profiles or the A/B choice change. */
export function abKey(E) {
  const k = h('button', { class: 'll-key ab-key', id: 'abKey', type: 'button', 'aria-pressed': 'false', hidden: '' }, h('b', {}, 'A/B'), h('small', { 'data-i18n-skip': '' }, ''));
  k.refresh = () => {
    const nx = abNext(E.S), ab = E.S.ui.ab, cur = ab.cur ? E.S.profiles.find(p => p.id === ab[ab.cur]) : null;
    k.hidden = !nx; k.classList.toggle('on', ab.cur === 'b'); k.setAttribute('aria-pressed', ab.cur === 'b' ? 'true' : 'false');
    k.querySelector('small').textContent = cur ? cur.name : '—';
    k.title = nx ? tl('在兩個校正設定檔之間切換') + ': ' + nx.profile.name : '';
  };
  k.onclick = () => {
    const r = abToggle(E.S);
    if (!r.ok) { toast(r.why === 'layout' ? '設定檔的版面和目前不同，沒有切換' : '請先在設定頁選好 A、B 兩個設定檔', true); return; }
    E.afterCorrectionChange();
    for (const w of r.warnings) if (w !== 'layout') toast(warnText(w), true);
    toast(`${r.which.toUpperCase()}：${r.name}`);
  };
  k.refresh();
  return k;
}

// ================================================================ backup / restore / reset
export function backupPanel(E) {
  const box = h('div', { class: 'panel', 'data-pk': 'backup' }, ph('K', '備份與重設', 'Backup & reset'));
  const doBackup = async () => {
    await E.saveNow();
    let j; try { j = await api('/api/backup'); } catch { j = buildBackup(E.S, E.RT.sys?.version || ''); }
    saveFile(`fono-backup-${today()}.json`, JSON.stringify(j, null, 2), 'application/json');
    toast('已下載備份檔（不含任何權杖或密鑰）');
  };
  const doRestore = async f => {
    let j; try { j = JSON.parse(await readText(f)); } catch { toast('這不是有效的 JSON 檔', true); return; }
    const v = validateBackup(j);
    if (!v.ok) { toast({ 'not-backup': '這不是 Fono Console 的備份檔', 'newer-version': '這個備份來自較新的版本，請先更新程式', 'no-settings': '備份檔裡沒有設定', 'bad-settings': '備份檔的內容不正確' }[v.error] || '備份檔無法使用', true); return; }
    const n = Array.isArray(v.settings.profiles) ? v.settings.profiles.length : 0;
    const ok = await dialog({ title: '還原設定', body: h('div', {}, h('p', { class: 'dlg-text' }, '還原會用備份檔取代目前的全部設定（包含裝置選擇與校正設定檔），然後重新載入。備份檔沒有的項目會用預設值。建議先按「備份全部設定」留一份現在的。'),
      h('p', { class: 'hint mono', 'data-i18n-skip': '' }, `${j.created || ''} · ${j.appVersion || ''} · ${n} profiles`)), choices: [{ label: '還原並重新載入', value: true, kind: 'danger' }] });
    if (!ok) return;
    replaceState(E.S, restoredState(j)); await E.saveNow(); location.reload();
  };
  const doReset = async () => {
    const c = await dialog({ title: '重設為預設', body: '把所有設定（外觀、房間矯正、音效、校正設定檔…）改回預設值。請選擇要不要保留裝置：', choices: [{ label: '保留裝置與精靈進度', value: 'keep', kind: 'primary' }, { label: '全部重設', value: 'all', kind: 'danger' }] });
    if (!c) return;
    replaceState(E.S, resetState(E.S, { keepDevices: c === 'keep' })); await E.saveNow(); location.reload();
  };
  const rest = fileInput('.json,application/json', doRestore);
  box.append(h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
    h('button', { class: 'btn primary', type: 'button', id: 'backupBtn', onclick: doBackup }, '備份全部設定'),
    h('button', { class: 'btn', type: 'button', id: 'restoreBtn', onclick: () => rest.click() }, '還原'), rest,
    h('button', { class: 'btn ghost', type: 'button', id: 'resetBtn', onclick: doReset }, '重設為預設')),
    h('p', { class: 'hint' }, '備份檔只有介面與校正設定，不含 Spotify 權杖、密鑰或錄音；Spotify 要在新電腦上重新連接。'));
  return box;
}

// ================================================================ bug-report bundle
export async function gatherBundle(E) {
  const S = E.S, RT = E.RT;
  const [sys, serverLog] = await Promise.all([
    api('/api/system').catch(() => RT.sys || {}),
    fetch('/api/log', { cache: 'no-store' }).then(r => (r.ok ? r.text() : '')).catch(() => '')]);
  const env = { userAgent: navigator.userAgent, language: navigator.language, uiLang: getLang(), screen: `${screen.width}x${screen.height}@${devicePixelRatio}`, cores: navigator.hardwareConcurrency, memoryGB: navigator.deviceMemory, mockBackend: !!window.__fonoDemo };
  return buildBundle({ version: sys.version || RT.sys?.version || '', S, sys, devices: RT.devices || [], configText: RT.lastConfig || E.genConfig(), clientLog: applog.text(), serverLog, eapoStatus: { lastWriteOk: RT.eapo?.ok, lastError: RT.eapo?.err || '', defaultDevice: RT.defDev ? 'set' : '' }, env });
}
export function bugReportPanel(E) {
  const box = h('div', { class: 'panel', 'data-pk': 'bugreport' }, ph('B', '問題回報', 'Bug report'));
  const go = async () => {
    let b; try { b = await gatherBundle(E); } catch (e) { toast('無法產生回報包：' + e.message, true); return; }
    const en = getLang() === 'en', kb = n => (n < 1024 ? n + ' B' : (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB');
    const list = h('ul', { class: 'bug-files', 'data-i18n-skip': '' }, ...b.files.map(f => h('li', {}, h('code', {}, f.name), h('span', { class: 'sz' }, kb(f.bytes)), h('span', {}, en ? f.en : f.zh))));
    const ok = await dialog({ title: '問題回報包的內容', body: h('div', {}, h('p', { class: 'dlg-text' }, '下載到你的電腦，不會自動上傳。請先確認內容，再附到 GitHub issue。裝置 ID 已雜湊，沒有權杖或錄音。'), list), choices: [{ label: '下載 zip', value: true, kind: 'primary' }] });
    if (!ok) return;
    saveFile(b.zipName, b.zip(), 'application/zip'); toast('已下載問題回報包');
  };
  box.append(h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, h('button', { class: 'btn primary', type: 'button', id: 'bugBtn', onclick: go }, '產生問題回報包'),
    h('button', { class: 'btn ghost', type: 'button', onclick: () => post('/api/open', { url: 'https://github.com/LectorLector/fono-console/issues/new/choose' }).catch(() => {}) }, '開啟 GitHub 問題頁')),
    h('p', { class: 'hint' }, '遇到問題時按這裡：產生一個 zip（系統資訊、設定、紀錄、量測摘要），按下之前會先列出裡面有什麼。'));
  return box;
}
