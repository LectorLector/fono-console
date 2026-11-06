# Phase 5: customization, player and animation, widgets, completing the lab

Repo: /home/claude/fono-console. Read AGENTS.md first. Key files: see docs/plans/phase4.md (header).
The same rules apply as in phase 4:
- Low-saturation hardware look.
- Lit keys.
- No new dependencies.
- ASCII-only EQ APO config.
- Append CSS at the end of web/style.css.
- After a task run: `go vet ./... && go build -o /tmp/fono-linux .`, plus `node --check` on every JS file you touched.
- The demo backend lives in web/js/mock.js. Any new /api endpoint must also be mocked there so the GitHub Pages demo works.
- Put new code in NEW files where possible: web/js/look.js, web/js/widgets-dash.js, web/js/lab2.js, and so on. Keep edits to app.js small (imports plus hook-up).
- Avoid real brand names and copies of real product designs.

## Task 1: Look system (web/js/look.js + Go endpoint)

### 1.1 Palettes
`PALETTES` holds 10 presets. Each preset is `{id, name, dark:{bg,panel,ink,accent,lamp}, light:{...}}`. They are inspired by vintage gear, but every name is generic:
- 香檳金面板 (champagne + blue lamp)
- 藍色電表 (deep black + cyan-blue meter glow)
- 白色極簡 (off-white, Rams-like, orange accent)
- 銀色卡座 (silver + amber)
- 軍綠器材 (olive)
- 牛血紅 (oxblood)
- 海軍藍
- 奶油色收音機
- 碳黑 (carbon + red)
- 薄荷 (mint, light).

### 1.2 Custom palette editor
- Colour inputs for background, panel, text, accent, and meter lamp colour.
- From these, derive every token on `<html>`: --bg --bg-2 --panel --panel-2 --raised --line --line-2 --ink --ink-2 --ink-3 --accent --accent-2 --accent-ink --lit-glow --lcd --lcd-ink, plus a new `--lamp` used by meters.
- Show a contrast warning if text against panel is below WCAG 4.5:1.
- "自訂" is stored in `S.ui.palette = {id:'custom', dark:{...}}`.
- `id:''` means the skin's own colours. Skins still work; a palette overrides the colours only.

### 1.3 Textures
`S.ui.texture` becomes `{kind, amount}`, with amount from 0 to 1.
- Migrate the old boolean: `true` → `{kind:'grain', amount:.5}` and `false` → `{kind:'none'}`.
- Kinds: none, grain, brushed (brushed metal), wood, leather, felt, linen, paper, carbon, crackle (old lacquer).
- Build each kind as an inline SVG data URI using feTurbulence/feDisplacementMap/feColorMatrix, tileable at 256px.
- Apply it as a `--tex` image on .panel, .rail and .topbar, with opacity from amount, using a ::before overlay with mix-blend-mode: overlay or soft-light.
- Show a texture picker as swatches, each previewing the texture, plus an amount slider.

### 1.4 Wallpaper
`S.ui.wall = {src:'' | 'builtin:<file>' | 'user:<name>', fit:'cover'|'tile'|'pixel', dim:.35, blur:0, panelAlpha:1}`.
- Draw it behind `.app`: a fixed layer with the image, then a dim overlay, then the panels.
- When `panelAlpha < 1`, panels use `color-mix(in srgb, var(--panel) <alpha>, transparent)` and `backdrop-filter: blur()`.
- `fit:'pixel'` sets `image-rendering: pixelated`.
- Built-in list: a `web/wall/index.json` array of `{file, name, credit}`, served from the embedded web/. Load it with fetch.

#### Go: /api/wallpaper
- GET returns the list of user wallpapers as `[{name,size}]`.
- POST takes a multipart field `file`:
  - max 8 MB;
  - check the content by magic bytes, PNG/JPEG/WebP/GIF only;
  - store it in `<config dir>/wallpapers/` with a sanitized name.
- GET `/api/wallpaper/<name>` serves the file.
- DELETE `/api/wallpaper/<name>` removes it.
- Keep a path traversal guard everywhere.
- mock.js stores uploads as object URLs in memory.

### 1.5 Settings UI
In appearancePanel, add sections 配色, 材質, 桌布 (thumbnail grid of built-in and user wallpapers, plus upload/delete buttons and the dim, blur and panelAlpha sliders).
- Theme export/import carries palette, texture and wall. User wallpaper files are not embedded; on import, a missing one is ignored with a toast.

## Task 2: Built-in wallpapers (tools/wallpapers.py → web/wall/)
- Python + Pillow + numpy, no network.
- Draw original reinterpretations by code. Low-res pixel art goes in as PNG; print styles as JPG with quality 82; keep each file under 250 KB.
- Write `web/wall/index.json`.
- Subjects. Public-domain works are reinterpreted, not copied; the credit field names the original.
  1. Pixel: swirling night sky over a village with a cypress (after van Gogh, *The Starry Night*, 1889).
  2. Woodblock print style, 3–4 flat colours plus paper texture: a great wave with a small mountain (after Hokusai, c.1831).
  3. Pixel: harbour at sunrise, orange sun, blue haze (after Monet, *Impression, Sunrise*, 1872).
  4. Linocut: a figure on a rock above a sea of fog (after Friedrich, 1818).
  5. Pixel: a red mountain under a mackerel sky (after Hokusai, *Fine Wind, Clear Morning*).
  6. Pixel: a night city with lit windows.
  7. Linocut: a listening room with speakers and a turntable.
  8. Pixel: rain on a window at dusk.
  9. Risograph style, two inks: a mountain lake.
  10. Plain dark felt with a subtle pattern, a "quiet" default.
- Sizes: pixel art at 320×180 (or 480×270), print styles at 1600×900.
- View every output image (the Read tool) and fix any that look bad or unrecognisable. Report which ones you are unsure of.

## Task 3: Player (app.js buildPlay/renderMedia/renderMeters + new web/js/player.js)

### 3.1 VU duplication and the meter panel
- When `S.ui.play==='vu'`, the right-hand 輸出電平 panel switches to a **spectrum + correlation** view instead of the same needles:
  - spectrum: 31 bars from an AnalyserNode is not possible (no audio access), so build pseudo-bands from RT.meter channel peaks with a smooth fall;
  - add a phase-correlation lamp from the L/R peak difference.
- Better: 'vu' uses big **analogue needles** with a lamp-lit face, and the side panel shows **LED bar meters with peak hold**. Implement this one.

### 3.2 Meter look, all needles
Draw a backlit face:
- radial gradient using `--lamp`, warm;
- inner bezel shadow (inset);
- glass reflection streak;
- needle drop shadow (SVG filter or a duplicate offset needle at low opacity);
- red peak LED that lights for 800 ms when the level goes above 0 dB;
- small screw heads.

Meter styles, set by `S.ui.meter` (= 'needle' | 'led' | 'nixie'):
- needle: the backlit dial above;
- led: segmented bars with peak hold;
- nixie: a numeric dB display in warm orange glow digits (draw the font yourself, no font files).
Add a picker in appearance.

### 3.3 Vinyl
`S.ui.vinyl = {color, deck}`.
- Colours:
  - black;
  - red/blue/green/yellow/clear translucent (`color-mix` + `backdrop` visible platter);
  - marble (conic and radial gradients);
  - splatter (random dots seeded by track title);
  - picture disc (album art over the whole record);
  - 'auto' (dominant colour sampled from the album art, with a canvas sample size of 16).
- Deck styles: 木紋 plinth, 銀色 direct-drive style (silver plinth, strobe dots on the platter edge, a pitch slider), 透明壓克力, 極簡白.
  - Each is a CSS variant of `.deck-stage` via `data-deck`.
  - A dust cover (translucent lid) is drawn on top.

### 3.4 Animations
These matter; use CSS transitions or keyframes and respect `prefers-reduced-motion`.
- New track, or playback starting from stopped:
  1. the record slides out of the sleeve onto the platter (≈700 ms);
  2. the platter starts spinning, ramping up ≈600 ms;
  3. the tonearm lifts, swings in and lowers (≈900 ms).
- On pause: the arm lifts and the platter slows down.
- On a track change within the same album, skip the record swap and only swing the arm.
- Dust cover: it is open while changing records and closes once playing (optional toggle `S.ui.lid`).
- Cassette:
  - New track: the cassette drops into the deck door, the door closes, the reels start.
  - Eject: the door opens.

### 3.5 Cassette
- The album cover goes in the label window: a J-card strip at the top of the shell, with cover art left and title/artist right.
- Reels spin in proportion to playback. Tape pack radius: the left reel shrinks and the right one grows with progress t.
- The tape window shows the moving tape.
- Shell colour options:
  - clear;
  - black;
  - white;
  - auto colour from the cover.
- Transport row in cassette mode: piano-key style buttons (REW, PLAY, FF, STOP/EJECT, PAUSE).
  - Mechanical look: a key dips when pressed and the PLAY key stays latched while playing.
  - Map them: REW → prev, FF → next, PLAY/PAUSE → toggle, STOP → toggle when playing.
- Small counter digits (000–999) driven by position.

### 3.6 Library
- Check library.js: opening and closing an album should animate like pulling a record from a shelf (sleeve tilts out, record slides, track list unfolds).
- Closing (收起) must animate in reverse. Currently it just removes the class; add a reverse animation.

## Task 4: Free layout, widgets, custom pages (web/js/dash.js)

### 4.1 Edit mode
A topbar button 「編輯版面」 toggles `html.edit-layout`.
- Every top-level `.panel` in the current page gets:
  - a grip handle for drag-reordering within its container (pointer events, no library);
  - a hide (×) button;
  - a size toggle (normal/wide).
- Store per page in `S.ui.layout[page] = {order:[panelKey...], hidden:[...], wide:[...]}`. A panel key is `data-pk`: give every top-level panel in the build* functions a stable data-pk.
- Apply the layout after each build*. Add 「還原預設版面」 to reset it.

### 4.2 Rail
- In edit mode, rail buttons can be reordered and hidden. The settings page cannot be hidden.
- A 「＋ 新增分頁」 button creates a custom page, stored in `S.ui.pages = [{id:'c1', name, icon, widgets:[{type, x,y,w,h, cfg}]}]`.
- Custom page names can be renamed (double click) and deleted.

### 4.3 Custom pages
- A 12-column CSS grid with row height 80px.
- Widgets are draggable and resizable (corner handle) in edit mode.
- 「＋ 新增小工具」 opens a catalog.

### 4.4 Widget catalog
Reuse existing functions or state when possible.
- **Media and controls**:
  - now playing (cover, title, transport);
  - mini turntable;
  - VU pair (uses the meter style);
  - LED meters for all channels;
  - listening mode keys;
  - quick toggles (fx, room correction, reverb, Hafler);
  - master volume knob (if there is no system volume API, control the EQ preamp and label it so);
  - EQ curve mini (read-only, click → fx page);
  - output device switcher (uses the existing device list API);
  - Bluetooth battery.
- **Clock and timers**:
  - clock (analogue or flip style);
  - sleep timer that pauses media after N minutes via mediaCmd('toggle') if playing.
- **Utility tools** (pure calculators, cfg persisted):
  - SPL / headroom calculator: amp watts per channel + speaker sensitivity dB/W/m + distance + number of speakers → max SPL at the seat, with a note on headroom;
  - amp/speaker matching: amp power at impedance, speaker impedance, damping factor estimate. These are the "晶體管/擴大機參數" calculators, explained in plain zh-TW;
  - distance ↔ delay ↔ wavelength converter at 343 m/s, with temperature input;
  - dB ↔ voltage/power ratio converter;
  - room mode quick calc (reuses S.dims);
  - test tone generator: WebAudio sine, pink noise or sweep, with level warning; starts at −30 dBFS with a stop button.
- **Notes**: a sticky-note text widget.

### 4.5 Rendering and resilience
- Widgets register through `registerWidget({type, name, sub, minW, minH, render(el, cfg, ctx) → {update?(), destroy?()}})`.
- Call update from the existing tick loop at most every animation frame. Widgets on hidden pages don't update.
- Keep everything working when features are off: a widget whose feature is disabled shows a hint to enable it.

## Task 5: Completing the lab + new modules (web/js/lab2.js, art.js, lab.js)

### 5.1 Room scan
- After import, show a top-view floor plan (canvas) of the room rectangle.
- The user drags markers for seat, FL, FR, SL, SR. Store them in `S.room.pos = {seat:[x,y], FL:[x,y,z]...}`, in metres, with ear height 1.1 m by default.
- The floor plan is also usable without a scan file (typed dimensions). Positions feed 5.2 and 5.3.

### 5.2 Reflections
- Using S.dims plus positions, compute first-order mirror points for each speaker → seat: side walls, ceiling, floor, front and back wall.
- Show them on the floor plan as dots labelled 「吸音板放這裡」, each with its extra path length and predicted delay.
- Match them to the measured ETC peaks: within ±0.3 ms, label the peak with the surface name.
- Add a speaker selector for the measured IR, choosing any measured channel.

### 5.3 Room modes at the seat
- For each axial/tangential mode below 200 Hz, compute the pressure at the seat and at each speaker position: cos products.
- Show which modes the seat sits in a null/peak of. Suggest a seat move along the room length that minimises the variance of the modal response at 30–120 Hz: search a 5 cm grid, ±60 cm.

### 5.4 ART
1. Robust design: solve one filter set jointly over three temperature variants of the measured responses (scale frequency by 1±0.01, i.e. stack the equations), selectable by `S.room.art.robust` (default on).
2. A report graph: predicted modal decay per 1/3-octave band before/after, as a bar pair chart, plus the existing table.
3. 「ART＋一般校正」: above `fc×1.5` the normal per-speaker correction still applies. Make sure speakerStage keeps corr filters above that frequency for role 'art' (currently it skips them): apply only the corr filters whose fc > art.fc*1.5. Add a config test case in the scratchpad tests if available; otherwise in a new `research/art/cfg-check.mjs`.

### 5.5 New modules
Add them to FEATURES with lab flags where noted.
- **目標曲線編辑器** (core, default on with fir):
  - Draggable nodes on a log-frequency graph from 20 Hz to 20 kHz, −12..+12 dB.
  - Presets: 平直, 房間曲線 (−1 dB/oct above 1 kHz, +4 dB shelf under 120 Hz), 暖, 亮.
  - Stored in `S.room.target = [[f,dB],...]`.
  - measure.js auto-EQ uses the target instead of only lfRise. Read how lfRise is used and generalise it; keep lfRise as the default target's shelf.
- **衰減分析** (core, in the measure page, a new tab 衰減):
  - From the measured IR, compute the Schroeder integral → EDT, T20 and T30 per octave band (63–8k), using simple 2nd-order bandpass biquads applied forward-backward.
  - Draw a waterfall (CSD): 30 slices over 0–300 ms, 20 Hz–1 kHz, log f, using canvas with an isometric offset.
- **麥克風配對** (lab):
  - Mic A (reference) and mic B each measure the same speaker at the same spot; the difference curve, smoothed 1/6 oct, is saved as `S.mic.cal[B deviceId] = [[f,dB]...]` and applied in measurements made with mic B.
  - Also import a `.txt` calibration file (UMIK-style: lines "f dB", ignore lines starting with `"` or `*`).
  - Find where measure.js computes the response and subtract the cal there.
- **等響度補償** (lab, fx page):
  - ISO 226:2003 equal-loudness difference between a reference level (83 dB) and a listening level the user sets with a slider (60–83 dB).
  - Turned into a low shelf + high shelf pair in the EQ APO config. eapo.js fx stage, ASCII only.
  - Add it to the config tests.

## Task 6: Onboarding, channels, tours, docs

### 6.1 Wizard
- Add a step 「喇叭配置」 after 'dev'. Options:
  - 只有耳機 (sets features room-related off, hides the room/measure pages);
  - 2.0 立體聲;
  - 4.0 前後兩對 (current default).
  - Store `S.room.layout = 'hp'|'2.0'|'4.0'`.
- With 2.0:
  - room modes stereo only;
  - quad/Hafler keys hidden;
  - eapo.js routes only FL/FR (rear channels muted);
  - measurement wizard and ART only list FL/FR; ART requires 4.0 and shows a hint otherwise.
- Add a step 「外觀」 with skin, palette, wallpaper and player style thumbnails.
- The last step offers 「開始功能導覽」 and 「開啟教學網站」.

### 6.2 Tour
Add steps for 編輯版面 and custom pages.

### 6.3 Tutorial site (docs/guide.js)
Add a flow 「自訂外觀與版面」 (palette, texture, wallpaper, edit layout, add a custom page with widgets) and update the 'look' flow. Refresh docs/app with scripts/build-docs.sh (or copy web/ → docs/app/ if the script needs bash only).

### 6.4 Docs
Update README features, ROADMAP check-boxes, docs/tutorial.zh-TW.md (new sections), and bump appVersion to 2.6.0.
