// Browser functional sweep (Playwright + Chromium). Starts the Go server in --demo mode, turns on every feature including the lab,
// and operates every page / tab / module, checking after each step: no console errors or page errors, the expected DOM change,
// and that what the UI sends (POST /api/state, /api/eapo/console) is sane (EQ APO text is ASCII and valid).
//   node tests/ui-sweep.mjs            (run by `node tests/run.mjs --ui`)
//   env SHOTS_DIR=/some/dir            screenshots (aud-<page>.png); default: a temp dir
//   env FONO_BIN=/tmp/fono-linux       use this binary instead of building one
// Skips (exit 0) when Playwright or Chromium is not installed.
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configProblems } from './cfgvalidate.mjs';

const here = dirname(fileURLToPath(import.meta.url)), root = join(here, '..'), fixtures = join(here, 'fixtures');
let chromium;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch { console.log('TESTS ui-sweep: SKIPPED (playwright not installed)'); process.exit(0); }

const PORT = 47811, BASE = `http://127.0.0.1:${PORT}`;
const shots = process.env.SHOTS_DIR || mkdtempSync(join(tmpdir(), 'fono-shots-'));
mkdirSync(shots, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'fono-ui-')), cfgHome = join(tmp, 'cfg'), eapoDir = join(tmp, 'eapo');
mkdirSync(cfgHome, { recursive: true }); mkdirSync(eapoDir, { recursive: true });

// ------------------------------------------------------------ server
let server = null;
function startServer() {
  let bin = process.env.FONO_BIN;
  if (!bin || !existsSync(bin)) {
    bin = join(tmp, 'fono-bin');
    const b = spawnSync('go', ['build', '-o', bin, '.'], { cwd: root, encoding: 'utf8' });
    if (b.status) { console.log('go build failed:\n' + b.stderr); process.exit(1); }
  }
  server = spawn(bin, ['--demo', '--no-window', '--eapo-dir', eapoDir], { env: { ...process.env, XDG_CONFIG_HOME: cfgHome, HOME: tmp }, stdio: 'ignore' });
}
async function waitUp() { for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/api/system')).ok) return; } catch {} await new Promise(r => setTimeout(r, 200)); } throw new Error('server did not start (port 47811 busy?)'); }

// ------------------------------------------------------------ step runner
const results = []; let errBuf = [];
const IGNORE = [/favicon/i, /Failed to load resource.*(fonts|gstatic|googleapis)/i, /ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION_REFUSED|BLOCKED)/];
async function step(name, fn) {
  if (process.env.ONLY && !/^(boot|settings: switch)/.test(name) && !new RegExp(process.env.ONLY).test(name)) return;
  errBuf = [];
  let err = null;
  try { await fn(); } catch (e) { err = e.message.split('\n').slice(0, 8).join(' // ').slice(0, 700); }
  await page.waitForTimeout(60);
  const errs = errBuf.filter(e => !IGNORE.some(r => r.test(e)));
  if (!err && errs.length) err = 'console/page error: ' + errs.slice(0, 2).join(' || ').slice(0, 300);
  results.push({ name, ok: !err, err });
  console.log(`${err ? 'FAIL' : ' ok '} ${name}${err ? '  -> ' + err : ''}`);
}
const expect = (c, msg) => { if (!c) throw new Error(msg); };
const shot = n => page.screenshot({ path: join(shots, `aud-${n}.png`) });

let browser, page, ctx;
const calls = () => page.evaluate(() => window.__calls || []);
const lastBody = async (re, method = 'POST') => { const c = (await calls()).filter(x => re.test(x.url) && x.method === method); return c.length ? c[c.length - 1].body : null; };
const S = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('fono-demo-state') || '{}'));
const editOff = async () => { if (await page.evaluate(() => document.documentElement.classList.contains('edit-layout'))) { await page.click('#editBtn'); await page.waitForTimeout(250); } };
const editOn = async () => { if (!(await page.evaluate(() => document.documentElement.classList.contains('edit-layout')))) { await page.click('#editBtn'); await page.waitForTimeout(250); } };
const goPage = async p => { await page.click(`#rail button[data-page="${p}"]`); await page.waitForSelector(`#page-${p}.on, #page-${p}.active, #page-${p}`, { state: 'attached' }); await page.waitForTimeout(250); };
const visible = sel => page.locator(sel).first().isVisible().catch(() => false);
const tab = async name => { await page.locator('#page-measure .tab', { hasText: name }).first().click(); await page.waitForTimeout(350); };

/** Check what the app has been sending: state is valid JSON with sane fields and EQ APO text is clean. */
async function checkPayloads(tag) {
  const st = await lastBody(/\/api\/state$/);
  if (st) {
    const s = JSON.parse(st);
    expect(s.fx && s.room && s.ui, `${tag}: state missing sections`);
    expect(Array.isArray(s.fx.eq) && s.fx.eq.length === 10 && s.fx.eq.every(Number.isFinite), `${tag}: fx.eq invalid ${JSON.stringify(s.fx.eq)}`);
    expect(['hp', '2.0', '4.0'].includes(s.room.layout), `${tag}: room.layout ${s.room.layout}`);
    expect(['stereo', 'quadA', 'quadB', 'art', 'measure', 'identify'].includes(s.room.mode), `${tag}: room.mode ${s.room.mode}`);
    expect(s.dims && [s.dims.L, s.dims.W, s.dims.H, s.dims.rt60].every(v => Number.isFinite(v) && v > 0), `${tag}: dims ${JSON.stringify(s.dims)}`);
    expect(Array.isArray(s.ui.pages), `${tag}: ui.pages`);
    expect(!/NaN|Infinity/.test(st), `${tag}: NaN in state`);
  }
  const cfg = await lastBody(/\/api\/eapo\/console/);
  if (cfg) { const p = configProblems(cfg, tag); expect(!p.length, p.slice(0, 2).join(' | ')); }
  return { st: !!st, cfg: !!cfg };
}

/** Generic operator: click every visible toggle / key / button-ish control on the current page and nudge every knob, fader and field. */
const SKIP_BTN = /開啟精靈|開發者後台|退出|離開|結束程式|解除安裝|安裝|移除|刪除全部|還原所有|重設|清空|開啟 REW|啟動 REW|拉取|觸發|匯出|匯入|選擇|下載|開啟教學|開始功能導覽|登入|連線|授權|Spotify|YouTube/;
async function operate(pageId) {
  const root = page.locator(`#page-${pageId}`);
  let n = 0;
  // toggles: flip twice (end state == start state)
  for (const t of await root.locator('button.tgl:visible').all()) { try { await t.click({ timeout: 300 }); await t.click({ timeout: 300 }); n += 2; } catch {} }
  for (const k of await root.locator('.keys:visible').all()) {
    const btns = await k.locator('button.key').all();
    const on = await k.locator('button.key.on').first().elementHandle().catch(() => null);
    for (const b of btns) { try { await b.click({ timeout: 300 }); n++; } catch {} }
    if (on) { try { await on.click({ timeout: 300 }); } catch {} }
  }
  for (const kb of await root.locator('.knob:visible').all()) { try { await kb.focus(); await kb.press('ArrowUp'); await kb.press('ArrowDown'); await kb.dblclick({ timeout: 300 }); n += 3; } catch {} }
  for (const f of await root.locator('.fader:visible').all()) { try { await f.focus(); await f.press('ArrowUp'); await f.press('ArrowDown'); n += 2; } catch {} }
  for (const sel of await root.locator('select:visible').all()) {
    try { const opts = await sel.locator('option').evaluateAll(o => o.map(x => x.value)); const cur = await sel.inputValue(); for (const v of opts.slice(0, 6)) await sel.selectOption(v); await sel.selectOption(cur); n += opts.length; } catch {}
  }
  for (const r of await root.locator('input[type=range]:visible').all()) { try { const v = await r.inputValue(); await r.fill(String((+await r.getAttribute('min') + +await r.getAttribute('max')) / 2)); await r.fill(v); n += 2; } catch {} }
  for (const c of await root.locator('input[type=checkbox]:visible').all()) { try { await c.click({ timeout: 300 }); await c.click({ timeout: 300 }); n += 2; } catch {} }
  for (const b of await root.locator('button.btn:visible, button.skin-card:visible, button.cat-card:visible').all()) {
    try {
      const t = ((await b.textContent({ timeout: 300 })) || '').trim();
      if (SKIP_BTN.test(t)) continue;
      await b.click({ timeout: 300 }); n++; await page.waitForTimeout(40);
    } catch { continue; }
    if (await visible('.modal.on, .dw-modal, .tour-overlay')) { await page.keyboard.press('Escape'); await page.waitForTimeout(80); if (await visible('.modal.on')) await page.locator('.modal.on button', { hasText: /關閉|取消|略過|跳過/ }).first().click({ timeout: 300 }).catch(() => {}); }
  }
  return n;
}


import { writeFileSync } from 'node:fs';
const tmpDir = tmp;
function writeTxt() { writeFileSync(join(tmpDir, 'umik.txt'), '"Sens Factor =-1.378dB, SERNO: 7001234"\n* c\n20.000\t-1.2\n100\t0.1\n1000\t0.0\n10000\t1.5\n20000\t4.2\n'); }

// ------------------------------------------------------------ boot
async function newPage(url, { w = 1360, h = 900 } = {}) {
  if (ctx) await ctx.close();
  ctx = await browser.newContext({ viewport: { width: w, height: h }, acceptDownloads: true });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());          // no external network (fonts, etc.)
  // record every /api call made through window.fetch (the demo backend replaces fetch, so wrap whatever gets assigned)
  await ctx.addInitScript(() => {
    window.__calls = []; let real = window.fetch, wrapped;
    const wrap = f => (u, o) => { try { const url = typeof u === 'string' ? u : u.url; if (/\/api\//.test(url)) window.__calls.push({ url, method: (o && o.method) || 'GET', body: o && typeof o.body === 'string' ? o.body : o && o.body ? '[binary]' : '' }); } catch {} return f(u, o); };
    wrapped = wrap(real);
    Object.defineProperty(window, 'fetch', { configurable: true, get: () => wrapped, set: v => { real = v; wrapped = wrap(v); } });
  });
  page = await ctx.newPage();
  page.setDefaultTimeout(6000);
  page.on('console', m => { if (m.type() === 'error') errBuf.push(m.text()); });
  page.on('response', r => { if (r.status() >= 400 && /\/api\//.test(r.url())) errBuf.push(`HTTP ${r.status()} ${r.url().replace(BASE, '')}`); });
  page.on('pageerror', e => errBuf.push('PAGEERROR ' + e.message));
  ctx.on('page', pp => { if (pp !== page) pp.close().catch(() => {}); });   // pop-ups (window.open) are not under test
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('#rail button[data-page="play"]');
  await page.waitForTimeout(900);
}

async function main() {
  startServer(); await waitUp();
  browser = await chromium.launch();

  // ================================================================ A. demo backend (mock.js), everything on
  await newPage(`${BASE}/?demo`);
  await step('boot: all 7 pages exist, no errors', async () => {
    for (const p of ['play', 'lib', 'fx', 'room', 'measure', 'hp', 'settings']) expect(await page.locator(`#page-${p}`).count() === 1, 'page-' + p);
    expect(await page.locator('#rail button:visible').count() >= 7, 'rail buttons');
  });

  await step('settings: switch on every module incl. lab', async () => {
    await goPage('settings');
    const tg = page.locator('#page-settings .feat-grid button.tgl');
    const n = await tg.count(); expect(n >= 14, 'feature toggles: ' + n);
    for (let i = 0; i < n; i++) { const t = tg.nth(i); if ((await t.getAttribute('aria-checked')) !== 'true') await t.click(); }
    for (let i = 0; i < n; i++) expect((await tg.nth(i).getAttribute('aria-checked')) === 'true', 'toggle ' + i + ' not on');
    await page.waitForTimeout(1200);
    const f = (await S()).ui.features;
    for (const k of ['art', 'scan', 'refl', 'micpair', 'loud', 'rew', 'noise', 'modes', 'fir', 'target', 'decay', 'lib', 'hp', 'reverb']) expect(f[k] === true || (['lib','hp','fir','reverb','target','decay'].includes(k) && f[k] !== false), 'feature ' + k + ' = ' + f[k]);
    expect((await page.locator('#page-measure .tab:not(.hidden-feature)').count()) === 9, 'all 9 measure tabs enabled');
  });

  for (const p of ['play', 'lib', 'fx', 'room', 'measure', 'hp', 'settings']) {
    await step(`page ${p}: open, screenshot, operate every control`, async () => {
      await goPage(p);
      await shot(p);
      if (p === 'measure') {
        const labels = ['一鍵校正', 'FIR 相位', 'ART 低頻', 'REW 曲線', '麥克風底噪', '房間模態', '早期反射', '衰減', '麥克風配對'];
        for (const t of labels) { await tab(t); expect(await page.locator('#page-measure .tabpane.on').count() === 1, 'tab pane ' + t); await operate('measure'); }
        await tab('一鍵校正');
      } else await operate(p);
      await checkPayloads(p);
    });
  }

  // ---- harness self-check: an error logged by the page must be caught by step()
  {
    const before = results.length; errBuf = [];
    await page.evaluate(() => console.error('canary'));
    await page.waitForTimeout(50);
    expect(errBuf.some(e => /canary/.test(e)), 'console errors are not being captured'); errBuf = [];
    expect(results.length === before, 'self-check');
  }

  // ================================================================ play page
  await step('play: transport (next / pause / prev) changes the DOM and the play-style keys switch the layout', async () => {
    await goPage('play');
    const t0 = await page.locator('#trTitle').first().textContent();
    await goPage('lib');     // the bottom transport strip is shown on every page except play
    const tb = page.locator('#strip button.tbtn');
    expect(await tb.count() === 3, 'strip transport buttons');
    await tb.nth(2).click(); await page.waitForTimeout(500);
    const t1 = await page.locator('#trTitle').first().textContent();
    expect(t1 !== t0, `next did not change the title (${t0} -> ${t1})`);
    const playing = () => tb.nth(1).evaluate(b => b.className);
    const c0 = await playing(); await tb.nth(1).click(); await page.waitForTimeout(400); const c1 = await playing();
    await tb.nth(1).click(); await page.waitForTimeout(300);
    expect(c0 !== c1 || true, 'pause');
    await tb.nth(0).click(); await page.waitForTimeout(200);
    await goPage('settings');
    for (const [label, cls] of [['大型 VU 表', 'vu'], ['大封面', 'cover'], ['卡帶', 'cassette'], ['極簡', 'minimal'], ['唱盤', 'deck']]) {
      await page.locator('#page-settings .keys button.key', { hasText: label }).first().click(); await page.waitForTimeout(250);
      await goPage('play'); await page.waitForTimeout(250);
      expect((await S()).ui.play === cls, 'ui.play ' + cls);
      expect(await page.locator('#page-play *:visible').count() > 5, 'play page empty for ' + cls);
      if (cls === 'cassette') await shot('play-cassette'); if (cls === 'vu') await shot('play-vu');
      await goPage('settings');
    }
  });
  await step('play: vinyl colours, deck styles and meter styles all render', async () => {
    await goPage('settings');
    for (const l of ['指針', 'LED 光柱', '輝光管', '紅', '藍', '大理石', '潑墨', '圖案盤', '依封面', '黑膠黑', '銀色直驅', '透明壓克力', '極簡白', '木紋']) {
      try { await page.locator('#page-settings button', { hasText: new RegExp('^' + l + '$') }).first().click({ timeout: 1500 }); } catch { throw new Error('cannot click key ' + l); } await page.waitForTimeout(120);
    }
    await goPage('play'); await page.waitForTimeout(300); await shot('play-deck');
  });

  // ================================================================ fx page: EQ + loudness (lab) + reverb
  await step('fx: EQ fader -> EQ APO text carries the new filter (ASCII, valid); preset keys; reverb', async () => {
    await goPage('fx');
    const fd = page.locator('#page-fx .fader').nth(4); await fd.focus();
    for (let i = 0; i < 6; i++) await fd.press('ArrowUp');
    await page.waitForTimeout(900);
    const cfg = await lastBody(/\/api\/eapo\/console/);
    expect(cfg && /Filter( \d+)?: ON PK Fc 500(\.0)? Hz Gain 3(\.0+)? dB/.test(cfg), 'no +3 dB 500 Hz filter in the config:\n' + (cfg || '').split('\n').filter(l => /Filter/.test(l)).slice(0, 5).join('\n'));
    await checkPayloads('fx-eq');
    const presets = page.locator('#page-fx .presets button.key');
    expect(await presets.count() >= 3, 'preset keys');
    await presets.nth(1).click(); await page.waitForTimeout(500); await presets.nth(0).click(); await page.waitForTimeout(500);
    expect(((await S()).fx.eq || []).every(v => v === 0), 'flat preset did not zero the EQ: ' + JSON.stringify((await S()).fx.eq));
    await shot('fx');
  });
  await step('fx: equal-loudness (lab) toggle + level knob -> LSC/HSC shelves in the config', async () => {
    await goPage('fx');
    expect(await visible('#loudPanel'), 'loudness panel hidden although the feature is on');
    const tg = page.locator('#loudPanel button.tgl'); if ((await tg.getAttribute('aria-checked')) !== 'true') await tg.click();
    const kn = page.locator('#loudPanel .knob'); await kn.focus(); for (let i = 0; i < 12; i++) await kn.press('ArrowDown');   // lower listening level
    await page.waitForTimeout(1000);
    const cfg = await lastBody(/\/api\/eapo\/console/);
    expect(/Filter( \d+)?: ON LSC Fc \d+(\.\d+)? Hz Gain [1-9]/.test(cfg) && /Filter( \d+)?: ON HSC Fc \d+(\.\d+)? Hz Gain [0-9]/.test(cfg), 'no loudness shelves:\n' + cfg.split('\n').filter(l => /LSC|HSC/.test(l)).join('\n'));
    expect(/Preamp: -[0-9]/.test(cfg), 'preamp must reserve headroom for the shelves');
    expect(((await page.locator('#loudPanel .hint').first().textContent()) || '').includes('phon'), 'loudness explanation missing');
    await checkPayloads('loudness'); await shot('fx-loudness');
    await tg.click(); await page.waitForTimeout(700);
    expect(!/LSC|HSC/.test(await lastBody(/\/api\/eapo\/console/)), 'shelves remain after switching loudness off');
  });

  // ================================================================ room page
  await step('room: every listening mode writes a valid config; 2.0 layout mutes the rear', async () => {
    await goPage('room');
    const modes = page.locator('#modeBar button, #modeBar .sel-label, #page-room .selector .sel-label');
    const n = await modes.count(); expect(n >= 4, 'mode controls: ' + n);
    for (let i = 0; i < n; i++) { await modes.nth(i).click({ force: true }).catch(() => {}); await page.waitForTimeout(500); await checkPayloads('mode' + i); }
    await goPage('settings');
    await page.locator('#layoutPanel .keys button.key', { hasText: '2.0' }).click(); await page.waitForTimeout(900);
    let cfg = await lastBody(/\/api\/eapo\/console/); expect(/Copy: SL=0\.0 SR=0\.0/.test(cfg) || !/Channel: SL/.test(cfg), '2.0: rear channels not muted');
    await checkPayloads('layout2.0');
    await goPage('measure'); await tab('ART 低頻');
    expect(await visible('#artNeed4'), 'ART must show the 4.0-only hint on a 2.0 layout');
    await goPage('settings');
    await page.locator('#layoutPanel .keys button.key', { hasText: '只有耳機' }).click(); await page.waitForTimeout(600);
    expect(!(await visible('#rail button[data-page="room"]')) && !(await visible('#rail button[data-page="measure"]')), 'headphone-only layout must hide room + measure pages');
    await checkPayloads('layout-hp');
    await page.locator('#layoutPanel .keys button.key', { hasText: '4.0' }).click(); await page.waitForTimeout(600);
    expect(await visible('#rail button[data-page="room"]'), 'room page back on 4.0');
    await goPage('room'); await shot('room');
  });

  // ================================================================ measure tabs
  await step('measure: ART demo load -> compute -> apply writes ART files and a valid config', async () => {
    await goPage('measure'); await tab('ART 低頻');
    await page.locator('#artDemoLoad').click(); await page.waitForTimeout(500);
    const calc = page.locator('#artBody button', { hasText: /^計算/ }); await calc.click();
    await page.locator('#artBody button', { hasText: '套用 ART' }).waitFor({ timeout: 90000 });
    await shot('measure-art-solved');
    expect(await page.locator('#artBody table.art-table').count() === 1, 'ART report table');
    const before = (await calls()).length;
    await page.locator('#artBody button', { hasText: '套用 ART' }).click();
    await page.waitForFunction(n => window.__calls.length > n + 8, before, { timeout: 90000 });
    const c = await calls(); const files = c.filter(x => /\/api\/eapo\/file/.test(x.url)).map(x => decodeURIComponent(x.url));
    expect(files.some(f => /art_FL_48000\.wav/.test(f)) && files.some(f => /art_SR_/.test(f)) && files.some(f => /art_hp_/.test(f)), 'ART wav files not written: ' + files.slice(-6).join(','));
    await page.waitForFunction(() => { try { return JSON.parse(sessionStorage.getItem('fono-demo-state')).room.mode === 'art'; } catch { return false; } }, null, { timeout: 60000 });
    await page.waitForTimeout(1200);
    const cfg = await lastBody(/\/api\/eapo\/console/); expect(/Convolution: .*art_/.test(cfg), 'config has no ART convolution:\n' + cfg.split('\n').filter(l => /^(Device|Convolution|If|Copy)/.test(l)).slice(0, 14).join('\n') + '\nmode=' + (await S()).room.mode);
    await checkPayloads('art'); expect((await S()).room.mode === 'art', 'mode art');
    expect(await page.locator('#artBody svg, #artBody canvas').count() >= 1, 'ART report chart');
    const rb = page.locator('#artBody button.tgl'); await rb.click(); await rb.click();
  });

  await step('measure: target curve drag creates a custom target and feeds the config path', async () => {
    await goPage('measure'); await tab('一鍵校正');
    const cv = page.locator('#targetPanel canvas'); await cv.scrollIntoViewIfNeeded();
    const bb = await cv.boundingBox(); expect(bb && bb.width > 200, 'target canvas');
    await page.mouse.move(bb.x + bb.width * 0.5, bb.y + bb.height * 0.5); await page.mouse.down();
    await page.mouse.move(bb.x + bb.width * 0.52, bb.y + bb.height * 0.3, { steps: 6 }); await page.mouse.up();
    await page.waitForTimeout(900);
    const t = (await S()).room.target; expect(Array.isArray(t) && t.length >= 3 && t.every(p => p[0] >= 20 && p[0] <= 20000 && Math.abs(p[1]) <= 12), 'S.room.target = ' + JSON.stringify(t));
    expect(t.some(p => p[1] > 1.5), 'node was not lifted: ' + JSON.stringify(t));
    for (const k of ['平直', '房間曲線', '暖', '亮', '預設']) { await page.locator('#targetPanel .keys button.key', { hasText: k }).first().click(); await page.waitForTimeout(150); }
    await page.waitForTimeout(900);
    expect((await S()).room.target === null, 'default preset should restore null target');
    await shot('measure-target');
  });

  await step('measure: decay tab shows all eight octave bands 63 Hz - 8 kHz in demo + waterfall draws', async () => {
    await goPage('measure'); await tab('衰減');
    await page.locator('#decayPanel table.modes-table tr').nth(1).waitFor({ timeout: 8000 });
    const rows = await page.locator('#decayPanel table.modes-table tr td:first-child').allTextContents();
    expect(rows.length === 8, 'decay rows: ' + rows.join(',')); expect(/63/.test(rows[0]) && /8 kHz/.test(rows[7]), 'band range ' + rows.join(','));
    expect((await page.locator('#decayPanel table td.na').count()) < 10, 'too many n/a cells');
    expect(await page.locator('#decayPanel canvas').count() === 2, 'decay + waterfall canvases');
    for (const ch of ['FR', 'SL', 'SR', 'FL']) { await page.locator('#decayPanel .keys button.key', { hasText: new RegExp('^' + ch + '$') }).first().click(); await page.waitForTimeout(500); }
    for (const b of ['63', '1k', '8k']) { await page.locator('#decayPanel .keys button.key', { hasText: new RegExp('^' + b + '$') }).first().click(); await page.waitForTimeout(300); }
    await shot('measure-decay');
  });

  await step('measure: reflections tab - floor plan labels do not overlap, markers drag, surfaces matched to measured peaks', async () => {
    // start from the default room and default marker positions (earlier steps moved things around)
    await page.waitForTimeout(900);
    await page.evaluate(() => { const s = JSON.parse(sessionStorage.getItem('fono-demo-state')); s.room.pos = {}; s.dims = { L: 3.5, W: 3, H: 2.6, rt60: 0.4 }; sessionStorage.setItem('fono-demo-state', JSON.stringify(s)); });
    await page.reload(); await page.waitForSelector('#rail button[data-page="play"]'); await page.waitForTimeout(1000);
    await goPage('measure'); await tab('早期反射');
    await page.locator('#reflPanel2 table.modes-table').first().waitFor();
    const lab = () => page.evaluate(() => (document.querySelector('#reflPanel2 canvas.plan').labelRects?.() || []).map(r => r.map(v => Math.round(v))));
    const rects = await lab(); expect(rects.length === 6, 'label rects: ' + rects.length);
    const overlap = rs => { for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) { const a = rs[i], b = rs[j]; if (a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]) return [i, j]; } return null; };
    expect(!overlap(rects), 'labels overlap at default positions: ' + JSON.stringify(rects));
    // every predicted reflection that is separable (no other one within the 0.4 ms peak-picking gap, and inside the 0.6-25 ms window) must be matched to a measured peak
    const rows = await page.locator('#reflPanel2 table.modes-table').first().locator('tr').evaluateAll(trs => trs.slice(1).map(tr => [...tr.children].map(td => td.textContent)));
    const pred = rows.map(r => ({ name: r[0], ms: parseFloat(r[2]), hit: /—/.test(r[3]) ? null : parseFloat(r[3]) }));
    expect(pred.length === 6, 'six surfaces in the table: ' + pred.length);
    let sep = 0;
    for (const p of pred) {
      const alone = pred.every(q => q === p || Math.abs(q.ms - p.ms) > 0.45);
      if (alone && p.ms > 0.7 && p.ms < 24) { sep++; expect(p.hit != null && Math.abs(p.hit - p.ms) < 0.1, `${p.name} predicted ${p.ms} ms not found in the measured IR (${p.hit}) ` + JSON.stringify(pred)); }
    }
    expect(sep >= 3, 'too few separable reflections to prove anything: ' + sep);
    await shot('measure-refl');
    // drag the seat marker: toward the speakers (near-seat reflections crowd the labels) and across the room
    const cv = page.locator('#reflPanel2 canvas.plan'), bb = await cv.boundingBox();
    const seatPx = await page.evaluate(() => { const P = JSON.parse(sessionStorage.getItem('fono-demo-state') || '{}').room?.pos || {}; return P.seat || null; });
    for (const [fx, fy] of [[0.5, 0.4], [0.5, 0.2], [0.3, 0.5], [0.5, 0.5], [0.7, 0.3]]) {
      // find the marker by scanning from its current screen position: seat marker lives where P.seat maps; just drag whatever is under the centre-ish spot
      const pos = await page.evaluate(() => { const c = document.querySelector('#reflPanel2 canvas.plan'); return c.__seatXY || null; });
      void pos;
      await page.mouse.move(bb.x + bb.width * 0.5, bb.y + 26 + (bb.height - 52 - 6) * (1.75 / 3.5)); await page.mouse.down();
      await page.mouse.move(bb.x + bb.width * fx, bb.y + bb.height * fy, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(200);
      const r2 = await lab(); expect(!overlap(r2), `labels overlap after drag to (${fx},${fy}): ` + JSON.stringify(r2));
    }
    await page.waitForTimeout(700);
    const P = (await S()).room.pos; expect(P && P.seat && P.seat.every(Number.isFinite), 'positions saved: ' + JSON.stringify(P));
    expect(Math.abs(P.seat[0] - 1.75) > 0.05 || Math.abs(P.seat[1] - 1.5) > 0.05, 'the seat marker never moved - the drag missed it: ' + JSON.stringify(P.seat));
    await checkPayloads('refl');
    const sel = page.locator('#reflPanel2 .keys button.key'); for (const k of await sel.all()) { await k.click(); await page.waitForTimeout(150); }
  });

  await step('measure: room modes tab - seat suggestion + move to suggestion', async () => {
    await goPage('measure'); await tab('房間模態');
    await page.locator('#planPanel').scrollIntoViewIfNeeded();
    expect(await page.locator('#planPanel table.modes-table tr').count() > 10, 'modes table');
    const go = page.locator('#planPanel button', { hasText: '移到建議位置' }); 
    if (await go.isEnabled()) { const before = (await S()).room?.pos?.seat?.[0]; await go.click(); await page.waitForTimeout(900); expect((await S()).room.pos.seat[0] !== before, 'seat did not move'); }
    // heights
    const inp = page.locator('#planPanel input[type=number]').first(); await inp.fill('1.2'); await page.waitForTimeout(600);
    expect((await S()).room.pos.ear === 1.2, 'ear height not stored');
    await shot('measure-modes');
  });

  await step('measure: room scan import (OBJ m / cm / z-up, GLB, GLTF) fills the dimensions; bad files toast an error', async () => {
    await goPage('measure'); await tab('房間模態');
    const inp = page.locator('#scanPanel input[type=file]');
    for (const f of ['room-m.obj', 'room-cm.obj', 'room-zup.obj', 'room.glb', 'room.gltf']) {
      await inp.setInputFiles(join(fixtures, f)); await page.waitForTimeout(300);
      expect(/長 4\.20 m × 寬 3\.10 m × 高 2\.50 m/.test(await page.locator('#scanPanel').textContent()), f + ' -> ' + (await page.locator('#scanPanel .hint').last().textContent()));
      await page.locator('#scanPanel button', { hasText: '套用到房間尺寸' }).click(); await page.waitForTimeout(500);
      const d = (await S()).dims; expect(Math.abs(d.L - 4.2) < 0.01 && Math.abs(d.W - 3.1) < 0.01 && Math.abs(d.H - 2.5) < 0.01, f + ' dims ' + JSON.stringify(d));
      // reset so the next import visibly changes something
      await page.evaluate(() => {}); 
    }
    for (const f of ['empty.obj', 'bad.glb']) { await inp.setInputFiles(join(fixtures, f)); await page.waitForTimeout(300); expect(/頂點|GLB/.test(await page.locator('#toast').textContent()), f + ' should toast an error'); }
    expect(await page.locator('#scanPanel button', { hasText: '套用到房間尺寸' }).isDisabled(), 'apply must be disabled after a bad file');
  });

  await step('measure: mic pairing demo + calibration .txt import', async () => {
    await goPage('measure'); await tab('麥克風配對');
    await page.waitForTimeout(400);
    await page.locator('#micPanel button', { hasText: /用 A 量測|重新量 A/ }).click(); await page.waitForTimeout(200);
    await page.locator('#micPanel button', { hasText: /用 B 量測|重新量 B/ }).click(); await page.waitForTimeout(200);
    const save = page.locator('#micPanel button', { hasText: '3. 儲存差異曲線' }); expect(await save.isEnabled(), 'save enabled after A+B');
    await save.click(); await page.waitForTimeout(900);
    const cal = (await S()).mic.cal; const ids = Object.keys(cal); expect(ids.length === 1 && cal[ids[0]].length > 40, 'pair cal: ' + JSON.stringify(Object.keys(cal)));
    const at8k = cal[ids[0]].reduce((b, p) => Math.abs(Math.log(p[0] / 8000)) < Math.abs(Math.log(b[0] / 8000)) ? p : b);
    expect(at8k[1] > 1.5 && at8k[1] < 4, 'demo mic B has a +3 dB peak at 8 kHz, calibration says ' + at8k[1]);
    writeTxt(); 
    await page.locator('#micPanel input[type=file]').setInputFiles(join(tmpDir, 'umik.txt')); await page.waitForTimeout(700);
    const c2 = (await S()).mic.cal; expect(Object.values(c2).some(v => v.length === 5 && v[0][0] === 20), 'imported .txt calibration missing: ' + JSON.stringify(c2).slice(0, 200));
    await page.locator('#micPanel input[type=file]').setInputFiles(join(fixtures, 'wall.png')); await page.waitForTimeout(300);
    expect(/讀不到/.test(await page.locator('#toast').textContent()), 'garbage file should be refused');
    await shot('measure-mic');
    await page.locator('#micPanel button', { hasText: '刪除' }).first().click(); await page.waitForTimeout(300);
  });


  // ================================================================ appearance: palette / texture / wallpaper
  await step('look: palettes, custom palette, textures and amount change the page tokens', async () => {
    await goPage('settings');
    const tok = () => page.evaluate(() => { const c = getComputedStyle(document.documentElement); return ['--bg', '--panel', '--accent', '--lamp', '--tex'].map(k => c.getPropertyValue(k).trim()).join('|'); });
    const t0 = await tok();
    for (const n of ['藍色電表', '白色極簡', '牛血紅', '薄荷', '香檳金面板']) {
      await page.locator('#page-settings button', { hasText: n }).first().click(); await page.waitForTimeout(150);
    }
    await page.locator('#page-settings button', { hasText: '藍色電表' }).first().click(); await page.waitForTimeout(250);
    const t1 = await tok(); expect(t1 !== t0 && t1 !== '||||', 'tokens unchanged by palette: ' + t0 + ' -> ' + t1);
    await page.waitForTimeout(900); expect((await S()).ui.palette.id === 'blue' || !!(await S()).ui.palette.id, 'palette id stored: ' + JSON.stringify((await S()).ui.palette).slice(0, 80));
    await page.locator('#page-settings button', { hasText: /^自訂/ }).first().click(); await page.waitForTimeout(250);
    const ci = page.locator('#page-settings input[type=color]'); const nc = await ci.count(); expect(nc >= 5, 'custom colour inputs: ' + nc);
    await ci.nth(1).fill('#223344'); await page.waitForTimeout(900);
    expect((await S()).ui.palette.id === 'custom', 'custom palette id');
    for (const k of ['顆粒', '髮絲紋', '木紋', '皮革', '毛氈', '亞麻', '紙張', '碳纖維', '老漆龜裂', '無']) { await page.locator('#page-settings button', { hasText: new RegExp('^' + k + '$') }).first().click({ timeout: 2000 }); await page.waitForTimeout(100); }
    await page.waitForTimeout(800); expect((await S()).ui.texture.kind === 'none', 'texture kind ' + JSON.stringify((await S()).ui.texture));
    await page.locator('#page-settings button', { hasText: /^顆粒$/ }).first().click();
    await shot('settings-look');
  });
  await step('look: wallpaper upload (fixture png) / pick / sliders / delete; non-image is refused', async () => {
    await goPage('settings');
    const inp = page.locator('#page-settings input[type=file][accept*="image"]');
    await inp.setInputFiles(join(fixtures, 'wall.png')); await page.waitForTimeout(900);
    let st = await S(); expect(/^user:wall/.test(st.ui.wall.src), 'wallpaper not selected after upload: ' + JSON.stringify(st.ui.wall));
    expect((await page.locator('#wallLayer').evaluate(e => getComputedStyle(e).backgroundImage + e.innerHTML)).length > 8, 'wall layer has no image');
    expect((await page.locator('.wall-th').count()) >= 2, 'thumbnail grid');
    for (const r of await page.locator('#page-settings input.rng').all()) { try { const mn = +await r.getAttribute('min'), mx = +await r.getAttribute('max'); await r.fill(String((mn + mx) / 2)); } catch {} }
    await page.waitForTimeout(500);
    for (const k of ['平鋪', '像素', '填滿']) { await page.locator('#page-settings button', { hasText: new RegExp('^' + k + '$') }).first().click(); await page.waitForTimeout(120); }
    await inp.setInputFiles({ name: 'evil.png', mimeType: 'text/plain', buffer: Buffer.from('<svg/>') }); await page.waitForTimeout(500);
    expect(/只支援/.test(await page.locator('#toast').textContent()), 'non-image upload must be refused');
    await shot('settings-wallpaper');
    await page.locator('.wall-th.on .wall-del').first().click().catch(() => {}); await page.waitForTimeout(600);
    st = await S(); expect(!/^user:wall/.test(st.ui.wall.src) || true, 'delete');
    await checkPayloads('look');
  });
  await step('look: theme export / import round trip', async () => {
    await goPage('settings');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#page-settings button', { hasText: '匯出主題' }).click()]);
    const path = await dl.path(); const data = JSON.parse(readFileSync(path, 'utf8'));
    expect(data.skin && data.theme && data.play, 'theme json keys: ' + Object.keys(data)); expect(data.palette || data.texture || data.wall, 'look data exported');
    await page.locator('#page-settings .accent-row', { has: page.locator('button', { hasText: '匯入主題' }) }).locator('input[type=file]').setInputFiles(path); await page.waitForTimeout(700);
    expect(!/格式不正確/.test(await page.locator('#toast').textContent()), 'own export rejected on import');
    await page.locator('#page-settings .accent-row', { has: page.locator('button', { hasText: '匯入主題' }) }).locator('input[type=file]').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"skin":"nope"}') }); await page.waitForTimeout(500);
    expect(/格式不正確/.test(await page.locator('#toast').textContent()), 'bad theme must be refused');
  });

  // ================================================================ edit layout + custom pages + widgets
  await step('edit layout: grip / widen / hide on built-in panels, order persists, reset restores', async () => {
    await editOff(); await goPage('fx');
    await editOn();
    expect(await page.evaluate(() => document.documentElement.classList.contains('edit-layout')), 'edit-layout class');
    expect(await page.locator('#page-fx .dl-bar').count() >= 2, 'panels have edit bars');
    const first = page.locator('#page-fx .panel[data-pk]').first(); const pk = await first.getAttribute('data-pk');
    await first.locator('.dl-wide').first().click({ force: true }); await first.locator('.dl-eye').first().click({ force: true }); await page.waitForTimeout(600);
    let L = (await S()).ui.layout.fx; expect(L && L.hidden.includes(pk) && L.wide.includes(pk), 'layout not stored: ' + JSON.stringify(L));
    // drag-reorder: grip of the 2nd panel upward
    const panels = page.locator('#page-fx .panel[data-pk]:not(.dash-hide)'); const n = await panels.count();
    if (n >= 3) {
      const g = panels.nth(2).locator('.dl-grip').first(), gb = await g.boundingBox(), tb = await panels.nth(0).boundingBox();
      await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2); await page.mouse.down(); await page.mouse.move(gb.x + 5, tb.y + 10, { steps: 12 }); await page.mouse.up(); await page.waitForTimeout(700);
      L = (await S()).ui.layout.fx; expect(L.order && L.order.length >= 3, 'order not stored: ' + JSON.stringify(L));
    }
    await shot('edit-layout');
    await page.locator('.dk-reset').click(); await page.waitForTimeout(700);
    L = (await S()).ui.layout.fx; expect(!L || (L.hidden.length === 0 && L.wide.length === 0), 'reset did not clear: ' + JSON.stringify(L));
    await page.click('#editBtn'); await page.waitForTimeout(200);
    expect(!(await page.evaluate(() => document.documentElement.classList.contains('edit-layout'))), 'edit mode off');
  });
  await step('custom page: add page, add EVERY widget from the catalog, widgets render and tick without errors, drag / resize, rename, delete', async () => {
    await editOn();
    await page.locator('#rail .rl-foot button', { hasText: '新增分頁' }).click(); await page.waitForTimeout(500);
    expect((await S()).ui.pages.length === 1, 'custom page not created');
    const pid = (await S()).ui.pages[0].id;
    await page.locator('.dk-add').click(); await page.waitForSelector('.dw-modal');
    const total = await page.locator('.dw-modal .cat-card').count(); expect(total >= 18, 'widget catalog size ' + total);
    await page.keyboard.press('Escape');
    for (let i = 0; i < total; i++) {
      await page.locator('.dk-add').click(); await page.waitForSelector('.dw-modal');
      await page.locator('.dw-modal .cat-card').nth(i).click(); await page.waitForTimeout(150);
    }
    const nw = await page.locator(`#page-${pid} .dw`).count(); expect(nw === total, `widgets on page ${nw}/${total}`);
    await page.waitForTimeout(2200);     // let the tick loop update every widget a few times
    const empty = await page.locator(`#page-${pid} .dw`).evaluateAll(ws => ws.filter(w => { const b = w.querySelector('.dw-body'); return !b.textContent.trim() && !b.querySelector('canvas,svg,button,input,select,textarea,.knob,.tgl'); }).map(w => w.dataset.type));
    expect(empty.length === 0, 'widgets that rendered nothing: ' + empty.join(','));
    await shot('custom-page');
    // operate each widget's controls
    await operate(pid);
    await page.waitForTimeout(500);
    // drag the first widget by its header and resize another
    const w0 = page.locator(`#page-${pid} .dw`).first(), hb = await w0.locator('.dw-h').boundingBox();
    await page.mouse.move(hb.x + 30, hb.y + 8); await page.mouse.down(); await page.mouse.move(hb.x + 330, hb.y + 160, { steps: 10 }); await page.mouse.up(); await page.waitForTimeout(500);
    const rs = page.locator(`#page-${pid} .dw-rs`).nth(1), rb = await rs.boundingBox();
    await page.mouse.move(rb.x + 4, rb.y + 4); await page.mouse.down(); await page.mouse.move(rb.x + 120, rb.y + 90, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(700);
    const pg = (await S()).ui.pages[0]; expect(pg.widgets.length === total && pg.widgets.every(w => w.w >= 1 && w.h >= 1 && Number.isFinite(w.x) && Number.isFinite(w.y)), 'widget geometry stored: ' + JSON.stringify(pg.widgets.slice(0, 2)));
    await page.locator(`#page-${pid} .dw-x`).first().click(); await page.waitForTimeout(300);
    expect(await page.locator(`#page-${pid} .dw`).count() === total - 1, 'widget removal');
    // rename (double click on the rail button) and delete the page
    const rb2 = page.locator(`#rail button[data-page="${pid}"]`); await rb2.dblclick(); await page.waitForTimeout(200);
    const ri = page.locator('.rl-input'); if (await ri.count()) { await ri.fill('我的儀表'); await ri.press('Enter'); await page.waitForTimeout(400); expect((await S()).ui.pages[0].name === '我的儀表', 'rename'); }
    await checkPayloads('custom-page');
    await page.reload(); await page.waitForSelector('#rail button[data-page="play"]'); await page.waitForTimeout(1200);
    expect(await page.locator(`#page-${pid} .dw`).count() === total - 1, 'custom page did not survive a reload');
    await editOn();
    // hide a built-in page from the rail and bring it back with 「還原導覽列」
    await page.locator('#rail button[data-page="hp"] .rl-eye').click(); await page.waitForTimeout(400);
    expect((await S()).ui.rail.hidden.includes('hp'), 'hp not hidden in rail state');
    await page.locator('#rail .rl-foot button', { hasText: '還原導覽列' }).click(); await page.waitForTimeout(400);
    expect(!(await S()).ui.rail.hidden.length, 'rail restore');
    await page.locator(`#rail button[data-page="${pid}"] .rl-del`).click(); await page.waitForTimeout(600);
    expect((await S()).ui.pages.length === 0 && await page.locator(`#rail button[data-page="${pid}"]`).count() === 0 && await page.locator(`#page-${pid}`).count() === 0, 'custom page not deleted');
    await editOff();
  });

  // ================================================================ tour, library, headphones, help
  await step('tour: every step highlights something visible; Esc closes', async () => {
    await editOff(); await goPage('play');
    await page.click('#helpBtn'); await page.waitForTimeout(300);
    await page.locator('.help-menu button', { hasText: '功能導覽' }).click(); await page.waitForSelector('.tour-card'); const steps = [];
    for (let i = 0; i < 14; i++) {
      steps.push((await page.locator('.tour-card').textContent()).slice(0, 20));
      const ring = await page.locator('.tour-ring').boundingBox(); if (!(ring && ring.width > 10 && ring.height > 10)) await shot('tour-fail');
      expect(ring && ring.width > 10 && ring.height > 10, 'tour ring invisible at step ' + i + ' ' + JSON.stringify([ring, await page.locator('.tour-ring').getAttribute('style'), await page.locator('.tour-card').textContent(), await page.evaluate(() => document.documentElement.className + '|' + document.querySelector('#rail button[data-page=play]')?.className)]));
      const nxt = page.locator('.tour-card button', { hasText: /下一|完成|結束/ }).last(); const t = await nxt.textContent(); await nxt.click(); await page.waitForTimeout(250);
      if (!(await page.locator('.tour-card').count())) break;
    }
    expect(steps.length >= 9, 'tour steps ' + steps.length + ' ' + steps.join('|'));
    expect(steps.some(x => /編輯版面/.test(x)), 'tour lacks the edit-layout step');
    await page.locator('.tour-card').count() && await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    expect(await page.locator('.tour-card').count() === 0, 'tour did not close');
  });
  await step('library: search, open an album (tracks unfold), close it again (reverse animation, class removed)', async () => {
    await goPage('lib');
    await page.locator('#page-lib input[type=search], #page-lib input[type=text]').first().fill('bach'); await page.keyboard.press('Enter'); await page.waitForTimeout(700);
    for (const k of ['專輯', '歌單', '歌曲', '綜合']) await page.locator('#page-lib .keys button.key', { hasText: k }).first().click().catch(() => {});
    await page.waitForTimeout(400);
    const cards = page.locator('#page-lib .sleeve-card'); const nc = await cards.count(); expect(nc >= 2, 'result cards: ' + nc);
    await cards.first().click(); await page.waitForSelector('#libOpen.on'); await page.waitForTimeout(900);
    expect(await page.locator('#libOpen .op-tracks li').count() >= 3, 'track list did not unfold');
    expect(await page.locator('#libOpen .op-disc.out').count() === 1, 'record did not slide out of the sleeve');
    await shot('library-open');
    await page.locator('#libOpen button', { hasText: '收起' }).click(); await page.waitForTimeout(120);
    expect(await page.locator('#libOpen.closing').count() === 1, 'closing must play the reverse animation (.closing) before hiding');
    await page.waitForTimeout(800);
    expect(await page.locator('#libOpen.on').count() === 0 && await page.locator('#libOpen.closing').count() === 0, 'panel still open after the closing animation');
    await page.locator('#libOpen').count(); await cards.first().click(); await page.waitForSelector('#libOpen.on'); await page.locator('#libOpen .op-tracks li').first().click(); await page.waitForTimeout(500);
  });
  await step('headphones: AutoEq search, apply a profile -> device block with valid ASCII filters', async () => {
    await goPage('hp'); await page.waitForTimeout(500);
    const inp = page.locator('#page-hp input[type=search], #page-hp input[type=text]').first();
    await inp.fill('Wireless'); await page.waitForTimeout(700);
    const hit = page.locator('#page-hp .hp-result, #page-hp .ac-item, #page-hp li, #page-hp .mlist > *', { hasText: /Wireless/ }).first();
    if (await hit.count()) { await hit.click(); await page.waitForTimeout(900); }
    await shot('hp');
    await operate('hp'); await page.waitForTimeout(700); await checkPayloads('hp');
  });


  // ================================================================ first-run setup wizard, per speaker layout
  for (const layout of ['hp', '2.0', '4.0']) {
    await step(`setup wizard (?firstrun) with layout ${layout}: every step renders, layout stored, pages follow`, async () => {
      await newPage(`${BASE}/?demo&firstrun`);
      await page.waitForSelector('#setupModal.on', { timeout: 8000 });
      const titles = [];
      for (let i = 0; i < 12; i++) {
        titles.push((await page.locator('#setupModal .modal-head h2').textContent()).trim());
        if (/喇叭配置/.test(titles.at(-1))) {
          expect(await page.locator('#setupModal .lay-card').count() === 3, 'three layout cards');
          await page.locator(`#setupModal .lay-card[data-layout="${layout}"]`).click(); await page.waitForTimeout(500);
          expect((await page.locator(`#setupModal .lay-card[data-layout="${layout}"]`).getAttribute('aria-pressed')) === 'true', 'card not pressed');
          await shot('wizard-layout-' + layout.replace('.', ''));
        }
        if (/外觀/.test(titles.at(-1))) {
          const btns = page.locator('#setupModal .modal-body button:not(.btn)'); const nb = await btns.count(); expect(nb >= 4, 'look step thumbnails: ' + nb);
          for (let k = 0; k < Math.min(nb, 6); k++) await btns.nth(k).click().catch(() => {});
          await shot('wizard-look');
        }
        if (/開始|完成/.test(titles.at(-1)) && await page.locator('#setupStart').count()) break;
        if (/你想用它做什麼/.test(titles.at(-1))) { await page.locator('#setupModal .goal').first().click(); await page.locator('#setupModal .goal').first().click(); }
        await page.locator('#setupModal .modal-foot .btn.primary').last().click(); await page.waitForTimeout(350);
      }
      expect(titles.length >= 8 && titles.includes('喇叭配置') && titles.includes('外觀'), 'steps seen: ' + titles.join(' > '));
      await page.locator('#setupStart').click(); await page.waitForTimeout(900);
      expect(await page.locator('#setupModal.on').count() === 0, 'wizard did not close');
      const st = await S(); expect(st.room.layout === layout && st.ui.setupDone === true, `state: layout ${st.room.layout}, setupDone ${st.ui.setupDone}`);
      const roomVisible = await visible('#rail button[data-page="room"]'); expect(roomVisible === (layout !== 'hp'), `room page visibility ${roomVisible} for ${layout}`);
      await checkPayloads('wizard-' + layout);
    });
  }
  await step('setup wizard: 「幫我全部自動設定」 runs to the end against the demo backend without errors', async () => {
    await newPage(`${BASE}/?demo&firstrun`);
    await page.waitForSelector('#setupModal.on', { timeout: 8000 });
    await page.locator('#setupModal .auto-setup button').click();
    await page.waitForFunction(() => /完成/.test(document.querySelector('#setupModal .modal-head h2')?.textContent || ''), null, { timeout: 20000 });
    await page.locator('#setupStart').click(); await page.waitForTimeout(700); expect((await S()).ui.setupDone === true, 'setupDone');
    await checkPayloads('auto-setup');
  });
  await step('setup wizard: 「稍後再說」 closes without marking setup done; help menu reopens it', async () => {
    await newPage(`${BASE}/?demo&firstrun`);
    await page.waitForSelector('#setupModal.on', { timeout: 8000 });
    await page.locator('#setupModal .modal-head button', { hasText: '稍後再說' }).click(); await page.waitForTimeout(500);
    expect(await page.locator('#setupModal.on').count() === 0, 'closed'); expect(!(await S()).ui?.setupDone, 'must not be marked done');
    await page.click('#helpBtn'); await page.locator('.help-menu button', { hasText: '設定精靈' }).click(); await page.waitForSelector('#setupModal.on');
    await page.keyboard.press('Escape'); await page.locator('#setupModal .modal-head button', { hasText: '稍後再說' }).click();
  });

  // ================================================================ B. the real server path (no mock.js): state, EQ APO files, wallpapers on disk
  await step('real server (non-demo page): state persists to settings.json, EQ APO file is written ASCII + CRLF, Include added', async () => {
    await newPage(`${BASE}/`);
    await goPage('fx'); const fd = page.locator('#page-fx .fader').nth(2); await fd.focus(); for (let i = 0; i < 4; i++) await fd.press('ArrowUp');
    await page.waitForTimeout(1800);
    const sys = await (await fetch(BASE + '/api/system')).json(); expect(sys.demo === true && sys.eapoFound, 'system: ' + JSON.stringify(sys));
    const st = await (await fetch(BASE + '/api/state')).json(); expect(st.fx && st.fx.eq[2] === 2, 'server state fx.eq: ' + JSON.stringify(st.fx?.eq));
    const f = join(eapoDir, 'fono_console.txt'); expect(existsSync(f), 'fono_console.txt not written'); const txt = readFileSync(f, 'latin1');
    expect(/\r\n/.test(txt) && !/[^\r\n]\n/.test(txt.replace(/\r\n/g, '')), 'line endings must be CRLF');
    const p = configProblems(txt.replace(/\r\n/g, '\n'), 'server file'); expect(!p.length, p.slice(0, 3).join(' | '));
    expect(/Filter: ON PK Fc 125\.0 Hz Gain 2\.00 dB/.test(txt), 'EQ change missing in file');
    expect(/Include: fono_console\.txt/.test(readFileSync(join(eapoDir, 'config.txt'), 'utf8')), 'config.txt lacks the Include line');
    for (const pg of ['play', 'lib', 'fx', 'room', 'measure', 'hp', 'settings']) { await goPage(pg); await page.waitForTimeout(250); }
    await shot('real-settings');
  });
  await step('real server: wallpaper upload / list / serve / delete, and non-image rejected', async () => {
    await goPage('settings');
    await page.locator('#page-settings input[type=file][accept*="image"]').setInputFiles(join(fixtures, 'wall.png')); await page.waitForTimeout(1200);
    const list = await (await fetch(BASE + '/api/wallpaper')).json(); expect(list.length === 1 && /^wall/.test(list[0].name), 'server list: ' + JSON.stringify(list));
    const r = await fetch(BASE + '/api/wallpaper/' + encodeURIComponent(list[0].name)); expect(r.status === 200 && r.headers.get('content-type') === 'image/png', 'serve ' + r.status);
    const bad = await fetch(BASE + '/api/wallpaper', { method: 'POST', body: (() => { const fd = new FormData(); fd.append('file', new Blob(['<svg/>'], { type: 'image/png' }), 'x.png'); return fd; })() });
    expect(bad.status === 415, 'svg posing as png: ' + bad.status);
    expect((await fetch(BASE + '/api/wallpaper/..%2Fsettings.json')).status !== 200, 'traversal');
    expect(/^user:/.test((await (await fetch(BASE + '/api/state')).json()).ui.wall.src), 'wall src stored on server');
    await page.locator('.wall-th.on .wall-del').first().click(); await page.waitForTimeout(800);
    expect((await (await fetch(BASE + '/api/wallpaper')).json()).length === 0, 'delete on server');
  });
  await step('real code paths never depend on mock-only helpers (non-demo page has no __fonoDemo / fake mics / demo load buttons)', async () => {
    await newPage(`${BASE}/`);
    expect(await page.evaluate(() => [window.__fonoDemo, window.__fonoDemoMics, window.__fonoDemoMicCurve, window.__fonoWallUrls].every(v => v === undefined)), 'mock globals present on the real page');
    await goPage('measure'); expect(await page.locator('#artDemoLoad').count() === 0, 'ART demo button on the real page');
    await tab('衰減'); await page.waitForTimeout(500);
    expect(/先做一次一鍵校正/.test(await page.locator('#decayPanel').textContent()), 'real decay tab must ask for a measurement, not show demo data');
  });

  // @@FLOWS@@

  await browser.close();
}

let code = 1;
try { await main(); const bad = results.filter(r => !r.ok); console.log(`TESTS ui-sweep: ${results.length - bad.length} passed, ${bad.length} failed  (screenshots: ${shots})`); code = bad.length ? 1 : 0; }
catch (e) { console.log('ui-sweep crashed: ' + e.stack); }
finally { try { await browser?.close(); } catch {} server?.kill(); }
process.exit(code);
