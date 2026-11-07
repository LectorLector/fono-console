// 粉紅噪音音量比對: pink noise to one speaker at a time (the measurement routing of the wizard), mic level averaged 10 s, gain offsets relative to FL.
import { h, toast } from './ui.js';
import * as audio from './audio.js';
import { activeSpk, subSpk } from './eapo.js';
import { soloRoute, soloRestore, soloBegin, soloEnd } from './wizard.js';
import { bandLevelDb, bandsFor, summariseRun, computeOffsets } from './pink.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SPK_NAME = { FL: '前左', FR: '前右', SL: '後左', SR: '後右', SW1: '重低音 1', SW2: '重低音 2' };
const SPREAD_WARN = 1;   // dB: first half vs second half of the 10 s above this = the room or the noise was not steady

/**
 * ctx: app context ({S, applyEapo, syncAll, changed}); io: {getFrame() -> {bins, sr, n} | null, micOn() -> bool}.
 * Returns the panel element. Bands: mains 500 Hz-2 kHz, subwoofers 30-80 Hz for their own level, and sub-vs-mains matching on the
 * overlap band (crossover +- half an octave), see pink.js.
 */
export function buildPinkMatch(ctx, io) {
  const st = { busy: false, cancel: false, res: null, ref: 'FL', msg: '', frac: 0 };
  const startB = h('button', { class: 'btn primary', id: 'pmStart' }, '開始比對');
  const cancelB = h('button', { class: 'btn', id: 'pmCancel', disabled: '' }, '取消');
  const applyB = h('button', { class: 'btn', id: 'pmApply', disabled: '' }, '套用建議增益');
  const prog = h('div', { class: 'mic-prog', id: 'pmProg' });
  const table = h('div', { id: 'pmTable' });

  const showProg = () => {
    prog.innerHTML = '';
    if (!st.msg) return;
    prog.append(h('div', { class: 'mic-prog-row' }, h('span', {}, st.msg)), h('div', { class: 'mic-prog-bar' }, h('i', { style: `width:${Math.round(st.frac * 100)}%` })));
  };
  const showTable = () => {
    table.innerHTML = '';
    const R = st.res; if (!R) return;
    const S = ctx.S, rows = Object.keys(R).map(k => {
      const r = R[k], sub = r.cmp === 'x', warn = r.spread > SPREAD_WARN;
      return h('tr', {}, h('td', {}, k + '（' + SPK_NAME[k] + '）'), h('td', {}, sub ? '30–80 Hz；比對 ' + bandsFor(true, S.room.sub?.xover || 80).x.map(Math.round).join('–') + ' Hz' : '500 Hz–2 kHz'),
        h('td', {}, r.level.toFixed(1) + ' dB'), h('td', { style: warn ? 'color:var(--warn,var(--bad));font-weight:600' : '' }, r.spread.toFixed(2) + ' dB' + (warn ? '　偏大，建議重測' : '')),
        h('td', {}, k === st.ref ? '基準' : (r.offset > 0 ? '+' : '') + r.offset.toFixed(1) + ' dB'), h('td', {}, r.current.toFixed(1) + ' dB'), h('td', {}, h('b', {}, r.suggested.toFixed(1) + ' dB')));
    });
    table.append(h('table', { class: 'modes-table', id: 'pmTbl' }, h('tr', {}, ...['喇叭', '頻段', '平均音量', '前後半段差', '相對 FL', '目前增益', '建議增益'].map(t => h('th', {}, t))), ...rows));
  };
  const sync = () => {
    startB.disabled = st.busy ? '' : null; cancelB.disabled = st.busy ? null : ''; applyB.disabled = !st.busy && st.res ? null : '';
    showProg(); showTable();
  };

  async function wait(sec, tick) {   // sleep in 100 ms steps; polls the cancel flag
    const t0 = performance.now();
    for (;;) {
      const el = (performance.now() - t0) / 1000;
      if (st.cancel) { const e = new Error('已取消'); e.cancelled = true; throw e; }
      tick && tick(Math.min(el, sec));
      if (el >= sec) return;
      await sleep(100);
    }
  }

  async function run() {
    if (st.busy) return;
    if (!io.micOn()) { toast('請先按「開始量測」開啟麥克風', true); return; }
    if (!soloBegin()) { toast('一鍵校正量測進行中', true); return; }
    const S = ctx.S, T = (window.__fonoDemo && window.__fonoPinkTiming) || { settle: 1.5, avg: 10 };   // demo only: the UI sweep shortens the waits
    const keys = activeSpk(S), subs = subSpk(S), xo = S.room.sub?.xover || 80, wasOn = audio.noiseOn();
    if (!keys.length) { soloEnd(); toast('這個配置沒有喇叭可量', true); return; }
    st.busy = true; st.cancel = false; st.res = null; st.ref = keys.includes('FL') ? 'FL' : keys[0]; sync();
    const runs = {}, per = T.settle + T.avg;
    try {
      audio.noiseStart('L', -20);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i], tot = keys.length * per, base = i * per, sub = subs.includes(k), b = bandsFor(sub, xo);
        st.msg = `${k}（${SPK_NAME[k]}）：切換路由…`; st.frac = base / tot; sync();
        await soloRoute(k);
        await wait(T.settle, el => { st.msg = `${k}（${SPK_NAME[k]}）：等待穩定 ${el.toFixed(1)} / ${T.settle} 秒`; st.frac = (base + el) / tot; showProg(); });
        const frames = [], t0 = performance.now();
        for (;;) {
          const el = (performance.now() - t0) / 1000, f = io.getFrame();
          if (f) frames.push({ own: bandLevelDb(f.bins, f.sr, f.n, b.own[0], b.own[1]), x: bandLevelDb(f.bins, f.sr, f.n, b.x[0], b.x[1]) });
          st.msg = `${k}（${SPK_NAME[k]}）：平均中 ${Math.min(el, T.avg).toFixed(1)} / ${T.avg} 秒`; st.frac = (base + T.settle + Math.min(el, T.avg)) / tot; showProg();
          if (el >= T.avg) break;
          if (st.cancel) { const e = new Error('已取消'); e.cancelled = true; throw e; }
          await sleep(100);
        }
        if (frames.length < 5) throw new Error('沒有收到麥克風資料');
        runs[k] = summariseRun(frames);
      }
      const gains = Object.fromEntries(keys.map(k => [k, S.room.ch[k].gain]));
      st.res = computeOffsets(runs, { ref: st.ref, gains, subs });
      st.msg = '完成：看一下「前後半段差」，沒問題就按「套用建議增益」。'; st.frac = 1;
    } catch (e) {
      st.msg = ''; if (e.cancelled) toast('已取消，路由已還原'); else toast('比對失敗：' + e.message, true);
    } finally {
      if (!wasOn) audio.noiseStop();
      try { await soloRestore(); } catch {}
      soloEnd(); st.busy = false; sync();
    }
  }
  startB.onclick = run;
  cancelB.onclick = () => { st.cancel = true; };
  applyB.onclick = () => {
    if (!st.res) return;
    for (const k in st.res) if (ctx.S.room.ch[k]) ctx.S.room.ch[k].gain = st.res[k].suggested;
    ctx.changed(); ctx.syncAll();
    for (const k in st.res) st.res[k].current = ctx.S.room.ch[k].gain, st.res[k].offset = 0;
    st.msg = '已套用建議增益。想確認的話再比對一次，相對 FL 應該接近 0 dB。'; st.frac = 1; sync();
    toast('已套用建議增益');
  };

  sync();
  return h('div', { class: 'panel', id: 'pinkMatch', style: 'margin-top:14px' },
    h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'D'), h('h2', {}, '粉紅噪音音量比對'), h('span', { class: 'en' }, 'Level match'), h('span', { class: 'rule' })),
    h('div', { class: 'graph-tools' }, startB, cancelB, applyB),
    prog, table,
    h('p', { class: 'hint' }, '先在上面按「開始量測」開啟麥克風，把麥克風放在聆聽位置。每顆喇叭依序單獨播粉紅噪音（等 1.5 秒穩定），用功率平均 10 秒的麥克風音量，再算出相對於 FL 的增益差。主喇叭用 500 Hz–2 kHz；重低音自己的音量看 30–80 Hz，但和主喇叭比較時改用分頻點上下各半個八度的重疊頻段（分頻 80 Hz 就是 57–113 Hz），因為兩者在那裡都有聲音。「前後半段差」是 10 秒的前半和後半兩段音量的差（重複誤差），超過 1 dB 表示環境或噪音不穩，請重測。建議增益 = 目前增益 + 差值，整組往下移到最大值不超過 0 dB（調小較大聲的，不推高其他聲道），並限制在 ±12 dB 內；按「取消」或出錯都會還原原本的路由。'));
}
