# Phase 4 — "works like a bought product": onboarding, modules & lab, player & looks

Repo: /home/claude/fono-console (Go server + plain ES-module UI in web/, no npm). UI text is Traditional Chinese.
Key files:
- web/index.html — shell; web/style.css — all styles (append new rules at the END; tokens: --bg --bg-2 --panel --panel-2 --raised --line --line-2 --ink --ink-2 --ink-3 --accent --accent-2 --accent-ink --lit-glow --lcd --lcd-ink --good --warn --bad --r --font-ui --font-disp --font-mono --bev-hi --bev-lo).
- web/js/app.js — main UI: buildPlay(), buildSettings(), appearancePanel(), featuresPanel(), FEATURES list, applyFeatures(), applyLook(), SKINS, goto(page), ctx().
- web/js/widgets.js — h(tag, attrs, ...kids), knob(), fader(), toggle({label, sub, value, onInput}), keys({options:[{id,label}], value, onInput}) -> {el,set}.
- web/js/ui.js — $, toast, api, post, drawGraph, css.
- web/js/setup.js — first-run wizard (openSetup(ctx)); GOALS map goals -> features.
- web/js/state.js — defaultState(): S.ui = { skin, accent, play, setupDone, features: {lib,hp,fir,rew,noise,modes,reverb,art} }, S.dims = {L,W,H,rt60}.
- web/js/wizard.js — measurement wizard; W.results[ch] = [{ir: Float64Array, sr, irPeak, arrivalMs, ...}] per position.
- web/js/mock.js — simulated backend used by the static demo (docs/app, GitHub Pages).
- docs/guide.js — tutorial site tours (FLOWS); docs/index.html.

Rules for every task:
- Keep the existing look: low-saturation hardware panels, no decorative diagonals/quarter circles, lit ON/OFF keys.
- No new dependencies, no external network at runtime except what already exists.
- After editing run the checks of your task and report pass/fail.

## Task 1 — Modules: core vs lab
1. app.js FEATURES: add a `lab: true` flag to experimental entries (art) and add two new lab entries:
   `{ id: 'scan', name: '房間掃描匯入（實驗）', sub: '從手機 3D 掃描檔讀出房間長寬高', lab: true }`
   `{ id: 'refl', name: '早期反射分析（實驗）', sub: '從量測找出桌面、牆面反射的距離與強度', lab: true }`
   state.js features defaults: scan: false, refl: false.
2. featuresPanel(): two groups — 「核心功能」 and 「實驗室」 (lab badge `實驗` small tag next to the name). Short hint under 實驗室: 「實驗功能：可能不完整，隨時可以關掉。」
3. New file web/js/lab.js exporting:
   - `roomScanPanel(ctx)`: panel with a file input accepting .obj,.glb,.gltf. Parse:
     OBJ: lines starting with `v ` → min/max of x,y,z. GLB: header (magic 0x46546C67), JSON chunk, read every accessor used as attributes.POSITION in meshes and use its `min`/`max` (glTF requires them), apply no node transforms. GLTF (.gltf JSON) same via accessors.
     Dimensions = bounding-box extents sorted: largest horizontal → L, other horizontal → W, vertical (y-up for glTF, z-up guess for OBJ if z extent < 3.5 and y extent > z) → H. Show the three numbers (2 decimals, metres; if all extents > 20 assume centimetres and divide by 100) and a button 「套用到房間尺寸」 that sets S.dims.L/W/H, saves state (ctx.saveState()), toast.
     Hint text: iPhone Pro (LiDAR) 可用 3D 掃描 App 匯出 GLB/OBJ；Android 可用支援網格匯出的掃描 App；也可以直接用捲尺量。
   - `reflectionPanel(ctx, getResults)`: from the first available measurement (getResults() returns W.results), take the IR (`ir`, `sr`, `irPeak`), compute the energy-time curve (squared IR, 0.25 ms moving average), find the direct peak at irPeak, then the 6 largest local maxima between 0.6 ms and 25 ms after it that are > -25 dB relative to the direct peak and ≥ 0.4 ms apart. For each: delay ms, extra path = delay*343 m (show cm), level dB, and a guess label: extra path < 0.6 m → 「桌面或喇叭附近的反射」, < 2 m → 「側牆／天花板」, else 「後牆或遠處」. Render a table + small canvas plot of the ETC (dB, 0–30 ms) using drawGraph-like simple canvas drawing (own code fine). If no results: hint 「先做一次一鍵校正」.
     Export also `demoReflections()` helper is NOT needed.
4. Hook-up: in app.js buildMeasure(): add a tab 'refl' 「早期反射」 (after 'modes'), pane content = reflectionPanel(ctx(), () => window.__fonoWizardResults?.() || {}). In wizard.js export nothing new but set `window.__fonoWizardResults = () => W.results` inside buildMeasureWizard. Add 'refl' to applyFeatures ids array in the same order as the tabs. In the room-modes tab (where S.dims inputs are) append roomScanPanel(ctx()) below, hidden by applyFeatures when features.scan is false (give it id `scanPanel` and hide via the same hide() helper).
Checks: `cd /home/claude/fono-console && go vet ./... && go build -o /tmp/fono-linux .` and `node --check web/js/lab.js`.

## Task 2 — In-app feature tour (onboarding)
1. New file web/js/tour.js exporting `startTour(ctx)`: an overlay inside the app (fixed, pointer-events none except its card) with a highlight ring (same look as docs/guide.css .ring: accent border + glow + dim outside via huge box-shadow) and a caption card with 「上一步／下一步／結束」 buttons. Steps (selector, text), navigate pages with ctx.goto(page) when needed:
   1 `#rail button[data-page="play"]` 播放：唱盤、封面、VU 表，右上可換樣式。
   2 `.play-layout` 播放頁樣式：唱盤／VU／封面。
   3 `#rail button[data-page="lib"]` 曲庫：Spotify 與 YouTube Music 一起搜尋。
   4 `#rail button[data-page="fx"]` 音效：EQ、混響、寬度。
   5 `#rail button[data-page="room"]` 房間：聆聽模式與每顆喇叭。
   6 `#rail button[data-page="measure"]` 量測：一鍵校正、FIR、ART。
   7 `#rail button[data-page="hp"]` 耳機：AutoEq、交叉饋送、藍牙。
   8 `#rail button[data-page="settings"]` 設定：外觀、功能模組與實驗室、設定精靈。
   9 `#helpBtn` 隨時按這裡重看導覽或開教學網站。
   Skip steps whose element is hidden (feature off). Esc closes. Store nothing.
2. index.html topbar: add a small button `<button class="help-btn" id="helpBtn" type="button" aria-label="說明">?</button>` before the theme switch. Clicking opens a small menu: 「功能導覽」 (startTour), 「教學網站」 (opens /guide/ in new tab), 「設定精靈」 (openSetup).
3. setup.js: on the 「開始使用」 button of the last step, after closing, call startTour(C) instead of goto('measure') (import from './tour.js').
4. CSS: .help-btn (round 26px, panel-2 bg, line-2 border), .tour-ring, .tour-card (panel bg, 1px line-2, shadow, max-width 320px), .help-menu.
Checks: node --check web/js/tour.js web/js/setup.js web/js/app.js; go build.

## Task 3 — Player styles & custom themes
1. Two more player layouts (S.ui.play): 'cassette' and 'minimal'. Add to the layout keys on the play page (layoutK in buildPlay) and to appearancePanel's playK options: 卡帶, 極簡.
   - cassette: inside .deck-stage add `<div class="cassette">` (hidden unless #page-play[data-play="cassette"]): a cassette shell drawn with CSS (rounded rect, label area showing current title/artist from #trTitle/#trArtist text — update it in renderMedia), two reels (circles with spokes) that rotate with the same `.playing` state as the record (reuse spin keyframes; add class toggle where the record gets `playing`), a window strip. Low saturation, matte, no gloss.
   - minimal: hide sleeve/record/arm/rpm; show `.minimal` block: large title (font-ui 800, 40px), artist, and a slim horizontal level bar pair (L/R) driven in renderMeters from RT.meterPeak[0..1] (map dB -60..0 to 0..100%).
2. Custom theme export/import in appearancePanel: buttons 「匯出主題」 (downloads JSON {skin, accent, theme, play} via a Blob link) and 「匯入主題」 (file input, validates keys, applies via S.ui + S.theme, applyLook(), saveState).
3. Texture toggle: S.ui.texture (default true). When false add class `no-texture` on <html>, which removes background-image on .panel/.rail/.topbar/body::before (CSS). Toggle in appearancePanel 「材質紋理」.
Checks: node --check web/js/app.js; go build; then run `node /tmp/claude-0/-home-claude/9f9327f3-0a5c-5436-b403-f9fa5999d03e/scratchpad/all.js` only if the demo server is running (skip otherwise).

## Task 4 — 「一鍵全自動設定」 in the wizard
In setup.js step 'goal' add a primary button 「幫我全部自動設定」 that runs, with a progress list shown in the modal body:
1. applyGoals() (already exists);
2. if /api/setup/status says eapo not installed → post('/api/setup/eapo-install') and show 「請完成 Equalizer APO 安裝（勾選喇叭輸出），完成後再按一次」 and stop;
3. auto-pick devices if empty: multichannel = first device whose iface/name matches /7\.1|5\.1|USB Sound|CM6206|Multichannel|多聲道/i; stereo DAC = first other device with eapo true that is not HDMI/monitor (/HDMI|NVIDIA|AMD|Intel\(R\) Display|顯示器|Monitor/i excluded); write C.S.dev.cm / C.S.dev.spark, saveState, changed();
4. post('/api/eapo/takeover'), post('/api/eapo/fixperm') (ignore errors, report them);
5. if goals include lib and ytm not installed → post('/api/setup/ytm-install') (don't wait for it);
6. jump to the 'done' step listing what was done and what still needs the user (Spotify Client ID, reboot if devices were added).
Checks: node --check web/js/setup.js; go build.
