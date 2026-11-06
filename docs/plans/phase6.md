# Phase 6 (v2.9.0): better bass cancellation, subwoofers, latency, export, diagnosis

Repo: /home/claude/fono-console. Read AGENTS.md first. The UI is bilingual: new zh-TW strings need English entries in `web/i18n/en.json`, and `node tests/run.mjs` must pass. Put DSP and maths changes in pure modules with tests in `tests/`, and show before/after numbers. EQ APO config must be ASCII only. The demo backend is `web/js/mock.js` plus `demoroom.js`.

Run these checks after every task:
`go vet ./... && go test ./... && node tests/run.mjs`, plus the relevant part of `node tests/ui-sweep.mjs` (demo server `/tmp/fono-linux --demo --no-window` on :47811).

## Task A1: Subwoofer layouts and bass management
- Layouts become `'hp' | '2.0' | '2.1' | '2.2' | '4.0' | '4.1' | '4.2'`.
- Speaker ids:
  - SW1 maps to the multichannel card's LFE output.
  - SW2 maps to C. This is the default and can be changed in the channel map, which also gets SW1/SW2 entries.
  - activeSpk(s) returns the real set.
- Bass management in eapo.js for `.1` and `.2` layouts:
  - Crossover `S.room.sub = {xover:80, slope:24, gain:0, delay:0, invert:false, mono:true}`.
  - The mains get a high-pass (LR4, option to keep full range: `mainsFull:false`).
  - Each sub gets an LR4 low-pass of the mono sum `(L+R)/2`, with per-sub gain, delay and polarity.
  - In `.2` layouts the two subs get the same signal unless ART drives them.
  - ASCII config; extend tests/cfg-check over all layouts × modes.
- Setup wizard 喇叭配置 offers the new layouts as cards; the Settings layout panel too.
- Measurement wizard and channel lists include SW1/SW2. Auto-alignment computes sub delay/polarity relative to the mains from the measured arrival and phase around the crossover:
  - choose the polarity and delay (±10 ms search, 0.1 ms steps) that maximise the summed magnitude at the seat over 0.5–2× xover;
  - show the result and apply it.
- Room page: a sub strip with gain, delay, polarity and xover controls.

## Task A2: Better active bass cancellation (art.js, wizard.js ART panel, lab2/acoustics if useful)
Keep the internal id `art`. The user-facing name stays as it is now; don't rename.

1. **Any source set.**
   - solveART takes the list of "main" sources, which play the music bass (FL/FR, or the subs when the user selects "subs play the bass"), and the list of "helper" sources, which absorb (SL/SR, SW1, SW2).
   - Support 2.1, 2.2, 4.0, 4.1 and 4.2:
     - in 2.2 the two subs cancel each other's modes, with mains high-passed;
     - in 2.1 one sub is solved jointly with the mains below fc.
   - A layout without any helper shows the requirement hint in both languages.
2. **Automatic regularisation.** Choose λ (and the effort cap) per frequency band by leave-one-out cross-validation over the measured positions, picking from a small grid. Report the chosen values.
3. **Headroom and driver protection.**
   - Per-source maximum boost from the measured response: no boost below each speaker's −10 dB point or where SNR < 20 dB.
   - Global preamp so that the summed worst-case gain ≤ 0 dBFS.
   - Show "需要的前級衰減 X dB".
4. **Pre-ringing control.** Option to limit the energy before the main peak in the helper FIRs: a time window/taper on the anti-causal part, so pre-ringing is −30 dB below the peak. Report its level.
5. **Seat-area weighting.** The position weights default to the 15-point grid pattern, centre heavier; editable.
6. **Verification loop.**
   - After applying, 「驗證量測」 re-measures 3 or 5 positions with ART on.
   - Compute the measured modal decay (band T60 via acoustics.js) before and after, and show measured versus predicted bars, plus an honest verdict text: improved / no change / worse, with a suggestion such as fewer positions, lower fc or a larger λ.
   - Store the report in S.room.art.verify.
7. **Guided measurement UX.**
   - Show the position grid on the floor plan, if room positions exist, or as a simple 3×5 diagram, with the next position highlighted.
   - Per-position quality check (SNR, consistency with neighbours); one bad position can be redone without restarting.
8. **Explanation panel** in the ART tab (bilingual; collapsible 「這是什麼？」):
   - what it does in plain words;
   - what you need;
   - what to expect, based on the simulation numbers and that real rooms vary;
   - limits: temperature, moving furniture, only below ~150 Hz, needs a quiet room;
   - how to undo.

Tests:
- With demoroom data, CV prediction before and after the improvements (must not get worse).
- A 2.2 sub-only case.
- The headroom rule.
- The pre-ringing level.

## Task B: Low-latency mode, WAV export, sample-rate alignment
1. **低延遲模式 (`S.ui.lowLatency`).**
   - Topbar key and quick toggle.
   - When on, eapo.js omits every Convolution (FIR phase, ART, convolution reverb) and keeps only IIR/PEQ correction, gains and delays.
   - Show the latency in each mode: FIR latency vs ~0 ms.
   - The sub crossover still applies.
2. **Export.**
   - 「匯出濾波器」 buttons in the FIR tab and the ART tab write WAV IRs per channel (32-bit float, mono, at 44.1/48/96 kHz).
   - They also write a combined per-channel correction IR (PEQ + FIR + ART, rendered by impulse response of the chain) and a README.txt explaining channel names, sample rates and how to load the files into CamillaDSP, Roon (convolution, stereo/multichannel zip), HQPlayer and EQ APO.
   - Download them as one .zip built in the browser. Write a tiny store-only zip writer, no deps.
3. **取樣率對齊.**
   - The bridge reports the default device's mix format (sample rate, bits) and the current track's sample rate where known; YouTube Music/Spotify are usually 44.1 kHz.
   - Settings shows a hint when they differ, plus a button that opens the Windows sound panel (`control mmsys.cpl`).
   - Do NOT attempt exclusive mode. Explain in the tooltip why exclusive mode bypasses Equalizer APO.

## Task C: Room diagnosis report + seat heatmap (lab2.js / acoustics.js)
1. **Diagnosis report.** A 「房間診斷」 panel in the measure page (core feature `diag`, default on) that turns the measurements into a ranked, plain-language list (bilingual). Each item has severity, a short explanation and a concrete action.
   - What it checks:
     - left/right level and arrival mismatch;
     - polarity errors;
     - strongest modal peaks/dips and whether the seat is near a node;
     - early reflections stronger than −10 dB within 6 ms, with a mirror-point location;
     - SNR or noise problems;
     - sub/mains integration around the crossover;
     - decay much longer at some bands;
     - correction limits hit.
   - Rule-based, no model.
   - Exportable as a PNG/HTML report.
2. **Seat heatmap.**
   - On the floor plan, compute the predicted low-frequency response variance (30–120 Hz) at every point (5 cm grid) from the modal model, using the current speaker/sub positions and room dims.
   - Draw it as a colour map, with the best area outlined and the current seat marked. CPU only; it must take < 200 ms. Use a Web Worker if needed.
   - Drag the seat to see the value update live.

## Task D: Docs and intro
- README (both languages), docs/tutorial.*.md, the site feature cards and a guide flow for: subwoofer setup, the improved bass-cancellation flow with verification, low-latency mode, export, and the diagnosis report.
- ROADMAP update.
- Bump appVersion to 2.9.0.
