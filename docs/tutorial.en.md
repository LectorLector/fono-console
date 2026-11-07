# Fono Console Tutorial

[English](tutorial.en.md) | [繁體中文](tutorial.zh-TW.md)

This tutorial starts from zero: install the software, measure the room, correct it, listen to music, set up headphones. You do not need to know REW or Equalizer APO syntax. Page names such as `05 Measure` follow the app's English interface (switch the language in Settings).

---

## 0. Three things to understand first

**Equalizer APO is the engine; Fono Console is the steering wheel.**

- Equalizer APO sits in the Windows audio stack, so all sound passes through it.
- Fono Console only generates its configuration file (`fono_console.txt`), so the effects stay in place after you close Fono Console.

**Correction mainly fixes the bass.**

- Below roughly 300 Hz a room produces standing waves: some frequencies boom, others nearly vanish. This is a much bigger effect than the differences between speakers, and it is where EQ helps most.
- The treble is better handled with speaker placement and absorption.
- Fono Console only corrects below the Schroeder frequency, and it **only cuts peaks and never fills dips**. A dip is caused by waves cancelling each other; adding energy will not fill it and only makes the amplifier clip.

**Two output devices, two jobs.** The setup asks about both:

| Name | Purpose | Example |
|---|---|---|
| Multichannel sound card | Quad modes: front L/R + rear SL/SR, each pair on its own amplifier | USB 7.1 sound card (CM6206 etc.) |
| Stereo DAC | Stereo mode: front pair only, on a better-sounding DAC | Any USB DAC |

With only one card, enter the same card for both.

**Reading the interface:**

| Element | How to read it | How to use it |
|---|---|---|
| Toggle key (`ON` / `OFF`) | Lit and reading ON = on; dark and reading OFF = off | Click to toggle |
| Knob | The small dark box below shows the current value | Drag up/down; hold Shift for fine steps; double-click to reset |
| Fader | The dark box above shows the value; the lit line in the middle is 0 dB | Drag up/down; double-click to reset |
| Segmented key (e.g. Stereo / Quad A / Quad B) | The lit segment is the current choice | Click one |
| Three lamps at the top | Green = fine, yellow = needs attention, grey = not connected | — |

---

## 1. Installation (about 10 minutes)

1. Put `FonoConsole.exe` and the `scripts` folder together.
2. Double-click `scripts\setup.cmd`. Each step explains itself and then asks: press Enter for the default, type `n` to skip.

   | Step | What it does | What you do |
   |---|---|---|
   | 1 Install | Copies to `%LOCALAPPDATA%\Programs\FonoConsole` and creates shortcuts | Nothing |
   | 2 Equalizer APO | Detects whether it is installed; opens the download page if not | In the installer's Device Selector, **tick the speaker outputs, not the microphones** |
   | 3 Devices | Lists all playback devices and marks whether EQ APO is on them | Type the numbers; you can name the four speakers |
   | 4 config.txt | Backs up the original, replaces it with a single `Include: fono_console.txt`, and makes it writable for your account | Click Yes in the UAC prompt |
   | 5 REW | Detects the install location (skippable) | Nothing |
   | 6 Spotify | Explains how to create a developer app | Paste the Client ID |
   | 7 YouTube Music | Downloads the desktop app from GitHub, **verifies the SHA-256**, enables the API server | Sign in once after installing |
   | 8 Chrome | Optional: stop background running, enable memory saver | Off by default |
   | 9 Save | Writes `%APPDATA%\FonoConsole\settings.json` | Nothing |

3. If you added devices in step 2, **reboot**.
4. To redo one step only: `scripts\setup.cmd -Step 6` (several steps: `-Step 3,9`).

### 1.1 Spotify developer app (step 6 in detail)

Only the library (search, open albums, playlists) needs this step. Playback control, cover art and progress do not.

1. Go to <https://developer.spotify.com/dashboard>, sign in and press **Create app**.
2. Set the Redirect URI to `http://127.0.0.1:47811/api/spotify/callback`. It must be 127.0.0.1; Spotify does not accept localhost.
3. Tick **Web API** and press Save. Open Settings, copy the Client ID and paste it back into the script.
4. Open Fono Console → `07 Settings` → **Connect Spotify**.

> Spotify's 2026 development-mode limits:
>
> - The app owner needs Premium.
> - Only accounts you add under User Management can sign in.
> - Tracks of other people's playlists are not visible; playlists you created or collaborate on are.

### 1.2 YouTube Music (step 7 in detail)

- Fono Console does not scrape web pages. It connects through the API server built into the open-source YouTube Music desktop app (pear-desktop), which accepts local connections only.
- The first time you search the library, YouTube Music shows an authorisation window. Press Allow.

---

## 2. Before measuring

- **Microphone position**: at the main listening position, at ear height. Use a stand or a stack of books; do not hold it.
- **Which input**: ideally plug it into the same sound card you are measuring, so timing stays synchronised. A laptop's built-in microphone is not recommended.
- **Environment**: switch off air conditioning and fans, close windows. `05 Measure` → `Mic noise floor` tells you whether the signal-to-noise ratio is sufficient; if the curve jumps around, set "Averaging" to 1 s or 10 s (power average) or to peak hold to catch occasional noise, and press Reset to start over.
- **Pink noise**: while pink noise plays on `Mic noise floor`, the RTA switches to 10 s averaging by itself (your own averaging choice returns when it stops), shows "Averaging x / 10 s" and then a settled level for 500 Hz–2 kHz and for the full band. "Pink-noise level matching" below plays pink noise from one speaker at a time (1.5 s to settle, 10 s power average) and works out each speaker's gain difference relative to FL and its half-to-half difference (re-measure above 1 dB); "Apply suggested gains" writes the channel gains (shifted so none is above 0 dB, limited to ±12 dB). Mains use 500 Hz–2 kHz; a subwoofer is compared with the mains on the overlap band half an octave either side of the crossover. Demo mode uses a simulated microphone.
- **Microphone level**: Windows Sound settings → Recording → Properties → Levels, set to 70–90, and turn off "Microphone boost" and all effects.
- **Amplifier volume**: set it to a fairly loud level for normal listening. The sweep level can be changed in the wizard (default −12 dBFS).
- **Fix placement before EQ**:
  - Keep speakers at least 50 cm from the rear wall.
  - Form an equilateral triangle between the two speakers and yourself, symmetrical left/right.
  - `05 Measure` → `Room modes`: enter the room dimensions to see which frequencies will be a problem.
- **Check the wiring**: on `01 Play`, turn the mode knob to "Channel ID" and use pink noise to confirm which speaker each jack drives.

---

## 3. One-click calibration

`05 Measure` → `One-click` → **Start one-click calibration**

1. **Prepare**: pick the output device (multichannel card) and input device (microphone), the channels to measure and the number of microphone positions. One position is fastest; for 3–5 positions, move the microphone within 30 cm around your head for a more robust result.
2. **Pre-run checks** (skippable): a 1.5 s quick sweep on FL sets the sweep level from the recording peak (target peak −12…−6 dBFS, output never above −3 dBFS), then 5 s of silence is recorded as the room noise. If the room is too noisy (air conditioner, fans) you get a warning and can switch them off and check again. Bands where the SNR is below 15 dB get no auto-EQ filters.
3. **Measure**: about 10 seconds per channel and position × the "sweeps" setting (1 / 2 / 4, default 2). The sweeps are aligned and averaged coherently, so noise falls with the count; an estimated time is shown before you start, and the log lists each measurement's repeatability (standard deviation between sweeps; above 1.5 dB it is flagged and a re-measure is suggested).
   - Fono Console routes the sound to a single speaker at a time, mutes the other channels and temporarily disables all effects.
   - The right channel also carries a reference signal that serves as the timing reference.
4. **Read the result**:

   ![Result](img/measure.png)

   | Column | Meaning |
   |---|---|
   | Filters | Number of peaking EQ filters fitted automatically |
   | Mode error | Mean deviation from the target curve (dB), shown as "before → after" |
   | Arrival | Time for sound to travel from the speaker to the microphone (relative) |
   | Suggested delay | Delay needed so all speakers arrive together; **only computed once all four are measured** |
   | Suggested gain | Level matching between channels; the rear pair gets another −6 dB in Quad A mode |
   | Polarity | Inverted polarity is flagged; check the wiring first |
   | SNR | Results below 15 dB are unreliable; measure again. Below the table you see the bands that got no EQ because of room noise |
   | Repeatability | Spread between the sweeps of one position (dB); above 1.5 dB means the room changed while measuring |

5. **Apply**: choose separately whether to apply EQ, delay, gain and automatic polarity inversion.
6. **Verify**: measure again (averaged too) and compare the curves before and after. You can also A/B compare in real time with the "Room correction" switch on `01 Play`.

**Bass rise** (default +2 dB) lifts the target curve slightly at low frequencies, which sounds more natural. Set it to 0 if you prefer clean, flat bass.

---

## 4. FIR phase correction

`05 Measure` → `FIR phase`

**Why it matters:**

- A speaker's crossover and low-frequency roll-off make some frequencies arrive late: the bass is often several milliseconds behind the treble, which dulls drum transients.
- Ordinary EQ changes the phase as well.
- An FIR filter can correct phase without touching the frequency response.

**Two modes:**

| Mode | Who it is for |
|---|---|
| Crossover model | You do not have a good measurement microphone. Enter the crossover frequency (it is in the manual; two-way bookshelf speakers are usually at 2–3.5 kHz), the low-frequency roll-off frequency and order (about 4th order for ported designs) |
| Measured | You have already run one-click calibration and trust your microphone |

**Adjusting and applying:**

- **Correction range**: default 200 Hz – 12 kHz. Extending lower corrects more bass phase, but increases latency and the risk of pre-ringing.
- **Latency**: fixed at about 85 ms at every sample rate. Channels without an FIR automatically get the same delay to stay in sync. The price is slightly off lip-sync in video; turn it off for gaming.
- The plot below: the grey line is the speaker's original group delay (how many milliseconds the bass arrives late), the bright line is the corrected one, which should lie flat at 0 inside the correction range.

   ![FIR](img/fir.png)

- Press **Build and apply FIR**: this generates four WAV sets for 44.1 / 48 / 96 / 192 kHz, and Equalizer APO picks the one matching the current sample rate.

---

## 4.5 ART active bass control (experimental)

Bass problems in a small room are not only "some frequencies are too loud" but also "the boom lasts too long" (modal ringing). Ordinary EQ can flatten the peak but cannot shorten the decay. ART lets a set of "helper" speakers play a precisely calculated signal that absorbs the standing waves the main speakers excite. The helpers can be the rear pair (4.x layouts) or the subwoofers (2.1, 2.2, 4.1, 4.2; setup in 4.7). A 2.0 layout or headphones-only has no helper speakers, and the ART tab tells you what is missing.

**Before you start:** turn on **ART active bass correction (experimental)** in `Settings → Feature modules`. It is experimental and off by default. At the top of the tab is a collapsible **What is this?** panel that explains in plain words what it does, what you need, what to expect, the limits and how to undo it. Read it once.

### Flow

1. **Guided measurement:** `Measure → One-click`. Set "Number of mic positions" to **9 points (ART)** or **15 points (ART)** and select every speaker of your layout under "Speakers to measure" (including SW1 / SW2).
   - Before each point the wizard shows a 3 × 5 position map: the top three rows are the horizontal plane (up = front), the bottom two rows are 15 cm up and 15 cm down, and the lit cell is the next position. The first point is at head position; the others are 25 cm front/back and left/right, and 15 cm up/down.
   - After each position a **quality check** runs: the signal-to-noise ratio must be at least 20 dB, and the bass level must be within 9 dB RMS of the neighbouring positions (within 0.3 m). If it fails you see "Position N / M: the quality of this point is poor…", and **Redo this point** repeats only that one without starting over. If you know it is fine, press **Accept and continue**.
   - Do not run the air conditioning, touch the volume knob or move the speakers during the measurement.
2. **Settings:** open the **ART bass** tab.
   - **Who plays the bass** (shown only when the layout has subwoofers): "Front main speakers" (default) or "Subwoofer".
   - **Handover frequency** (default 120 Hz): below it the taking-part speakers work together. Higher, and a temperature change can easily make things worse.
   - **Max push** (default +12 dB) and **Bass floor** (default 35 Hz).
   - **Temperature-robust design:** also looks after the three rooms at ±1% temperature.
   - **Automatic regularisation** (on by default): for each band, leave-one-out cross-validation picks λ (how smooth the filter is) and the drive limit from a small grid, and the chosen values are listed under the result. Turn it off to use fixed values.
   - **Protect the speakers** (on by default): no extra drive below each speaker's −10 dB point or where the signal-to-noise ratio is too low, so small drivers are not overdriven.
   - **Limit pre-ringing** (off by default): keeps the energy before the main peak of the helper FIRs below −30 dB. When on, the result lists each speaker's pre-ringing level "before → after" in dB.
   - **Position weights** (expand with 9 or 15 points): the default is heavier in the centre and lighter outside; edit any point (0 = ignore it completely), and "Restore default weights" goes back.
3. Press **Calculate (N points)** and read the prediction table (see "Reading the prediction" below).
4. The details under the result list the automatically chosen λ and drive limit and the **preamp attenuation needed (X dB)**: it keeps the worst case of each speaker's "direct path plus bass filter" within 0 dBFS. It is applied automatically, so the overall volume is a little lower.
5. If you are happy, press **Apply ART**; the mode switches to "ART bass". Use `Room` to switch back to other modes and compare.
6. **Verify:** in the "Verification measurement" section choose 3 points or 5 points and press **Verification measurement**. Put the microphone back at point N as instructed, and when it is steady press **Measure this point**. The result shows:
   - a **verdict**: Improved / No clear change / Worse / Not enough data, with how much the measured decay changed (and what was predicted);
   - three rows of decay time per band (before correction, predicted, measured) and a side-by-side bar chart;
   - if the result falls short, suggestions that fit the case: check mic position and temperature, keep "Automatic regularisation" on, lower the handover frequency (for example below 100 Hz), or use 9 points and make sure each is steady.

### Reading the prediction

- "Predicted: inside measured area": each point is predicted with filters computed from the **other** points (no peeking at the answer).
- "Predicted: 6 °C room-temperature difference": how the same filters behave when the mode frequencies shift by 1%; closest to everyday use.
- Green is improvement, red is degradation.

### Honest expectations

- In the simulated bedroom (3.6 × 3.0 × 2.6 m), predicting each left-out position from the others, decay at 40–63 Hz is shortened by about 25–50%, with little change above 80 Hz. **These are simulation numbers, not a promise.** Real rooms differ in wall materials, furniture and speaker placement; the effect can be smaller, or even negative.
- So trust the verdict of the **Verification measurement**, not the prediction table alone. If it says "Worse" or "No clear change", switch the mode back to "Stereo" or "Quad" in `Room` to turn ART off at once; the filter files are kept.
- The demo site has no real microphone. Its verification result is simulated from the prediction plus a small temperature change and noise, is tagged "Simulated", and only demonstrates the flow.

### Limits

- Only below about 150 Hz; higher up, a small move of your head makes it counter-productive.
- Temperature shifts the standing-wave frequencies (about 1% per 6 °C) and the effect shrinks with them; so do moving large furniture and opening or closing doors and windows. Measure again after changes.
- It needs a quiet room to measure; noise makes the filters learn the wrong thing.
- It does not extend the bass or fill deep nulls, and drive is not increased below each driver's low-frequency limit.
- In ART mode a subwoofer that has no ART filter stays silent.

Theory, simulations and limits: [research/art](../research/art/README.md).

## 4.6 Speaker layout (headphones / 2.0 / 2.1 / 2.2 / 4.0 / 4.1 / 4.2)

After "Choose output devices", the setup wizard asks how your speakers are connected and collapses everything you do not use (nothing is deleted). You can change it any time in `07 Settings → Speaker layout`. The numbers read "main speakers . subwoofers": 2 = front pair, 4 = front + rear pairs; the digit after the dot is the number of subwoofers.

| Layout | What changes |
|---|---|
| Headphones only | The "Room" and "Measure" pages are hidden; headphone features stay on |
| 2.0 stereo | Listening mode is fixed to stereo; Quad and Hafler keys are hidden; rear channels are muted; measurement and FIR list only FL/FR; the ART tab says what helper speakers it needs |
| 2.1 with sub | Front pair plus one subwoofer (SW1, on LFE); mains high-passed and the sub low-passed; ART can use the sub as its helper |
| 2.2 with two subs | Front pair plus two subwoofers (SW1 on LFE, SW2 on C by default) |
| 4.0 front + rear pairs | Everything (default) |
| 4.1 with sub | 4.0 plus one subwoofer: all four speakers are high-passed and the bass goes to the sub |
| 4.2 with two subs | 4.0 plus two subwoofers that get the same bass signal |

Changing the layout resets "Speakers to measure" to every speaker of the new layout (measure the newly added ones). "Set everything up for me" does not change the layout you chose.

---

## 4.7 Subwoofer setup

The 2.1, 2.2, 4.1 and 4.2 layouts add one or two subwoofers. The console handles bass management (who plays the bass) and time alignment (the sub and the mains reach your ears together). **It does not set the level for you: set it by ear or by measuring.**

### Wiring and channels

1. Pick the layout in `Settings → Speaker layout` (or click a card in the setup wizard's "Speaker layout" step).
2. Wiring: **SW1 goes to the multichannel sound card's LFE output, and SW2 defaults to C.** Windows must be set to 5.1 or 7.1 for LFE to carry sound. If your card is wired differently, change "SW1 → EQ APO channel" and "SW2 → EQ APO channel" in `Settings → Channel mapping`.
3. Bass management runs on the multichannel card only. If you listen through the stereo DAC (Stereo mode on a separate DAC), the DAC gets the full-range front pair.

### Bass management (the "Subwoofer" panel on the Room page)

Go to `04 Room`; the "Subwoofer" panel has:

| Control | What it does |
|---|---|
| Crossover | 40–200 Hz, default 80 Hz. The mains get an LR4 (24 dB/oct) high-pass; the subs get an LR4 low-pass of (L+R)/2 |
| Sub gain | −24 to +6 dB, shared by all subs |
| Delay | 0–40 ms, shared by all subs |
| Polarity | Inverts the polarity of all subs |
| Subs take a mono sum | Shown only in 2.2. On (default), both subs get the same signal; off, SW1 gets L and SW2 gets R |
| Mains stay full range | The mains are not high-passed and overlap the subs |

This gain / delay / polarity is added on top of each sub's own channel strip ("Sub 1", "Sub 2"), which sit at the top of the Room page and have gain, delay, polarity and correction like the other speakers.

### Measure and align automatically

1. `Measure → One-click`: select FL, FR (and SL, SR in 4.x) plus SW1 (and SW2 in 2.2) under "Speakers to measure", and measure as usual. A subwoofer only plays bass, so do not set the sweep level too high, and make sure it is connected to its amplifier.
2. Besides the per-channel table, the result page has a **Subwoofer alignment** block:
   - the table lists each sub's **suggested delay**, **polarity** (normal 0° or inverted 180°) and **sum score (before → after)**;
   - method: using the measured complex responses (arrival time and phase included), the sub delay (±10 ms in 0.1 ms steps) and polarity are searched between 0.5 and 2 times the crossover frequency so the summed amplitude at the seat is largest; two subs are aligned one after the other;
   - if the sub arrives earlier than the mains, all the other speakers get a little more delay and the sub starts from 0; the text tells you by how many milliseconds;
   - on the plot the bright line is the predicted result after alignment and the grey line is delay 0, normal polarity.
3. The **Apply sub alignment** switch is on by default; press **Apply** and the delay and polarity are written to the channel strips. The Room page's "Subwoofer" panel then shows "Last auto alignment: …".
4. **Level:** set "Sub gain" by ear, or apply and measure again to compare. The alignment is a prediction computed from your measurement, not a guarantee; confirm it with a verification measurement or the diagnosis in 4.8.

### Checking afterwards

After measuring, `Measure → Room diagnosis` has an item "Subwoofer and mains blend well / poorly at N Hz". When it is poor, it suggests raising or lowering the sub gain, changing the delay or trying the inverted polarity (see 4.8).

---

## 4.8 Room diagnosis and seat heatmap

The `Measure → Room diagnosis` tab turns the measurements into a **plain-language list ranked by severity**. It is a core feature and on by default (you can switch "Room diagnosis" off in `Settings → Feature modules`).

### How to use it

1. Before any measurement the list only has the items computed from the room size and seat position (such as the seat's bass unevenness, and how bass peaks and dips relate to the room modes). After one "One-click" run it adds left/right balance, polarity, reflections, decay and EQ-limit checks.
2. Small chips at the top count each severity: **Severe**, **Moderate**, **Minor** and **Normal**. Each item has a severity lamp, a title, a plain explanation and a "Suggestion": exactly what to do (for example "Add 0.4 ms of delay to FL" or "Put an absorber on the reflection point: 1.2 m from the front wall, 0.5 m from the left wall, 1.1 m high").
3. It updates by itself when you change the room size, seat or speaker positions; you can also press **Diagnose again**.
4. **Export report (HTML)** saves a self-contained HTML file with the findings, the measured curves and the seat heatmap. Open it in any browser; use the browser's print function for a PDF.

### What it checks

- level difference and arrival-time difference between left and right (does the image lean?);
- whether any speaker's polarity is reversed;
- the most prominent peak and deepest dip at 30–200 Hz, and whether your ear is at an antinode or a node of that room mode;
- the seat's bass unevenness and how far moving it forward or back would help;
- early reflections above −10 dB within 6 ms, with the reflection point worked out by the mirror-image method;
- signal-to-noise ratio and recording clipping;
- how the subwoofer and mains blend around the crossover (when there is a sub);
- whether decay time differs much between bands;
- whether the auto-EQ used up its filters or hit its cut limit.

All of this is fixed rules with no model guessing; the numbers come from your measurements and the room-mode model. Seat-move suggestions are **predictions, not measurements**: measure again after you move.

### Seat bass heatmap

The **Seat bass heatmap** (a floor plan) below the diagnosis predicts the **30–120 Hz** bass unevenness at every point from the room size and the current speaker positions (the subwoofers' positions when there are subs):

- The warmer the colour, the larger the unevenness; the ends of the colour bar show the value range.
- A bright outline marks the **best area** (within 0.5 dB of the best point), and the black dot is the current seat ("Ear").
- A line underneath reads "Current seat X dB RMS · best point Y dB RMS (Z cm away)".
- Drag "Ear" to watch the number change live; dragging a speaker recomputes the whole map.
- The "Bass unevenness heatmap" switch turns it off. The same heatmap is on the Lab floor plan.

**Limits:** the model is a modal model of a rectangular room, so the room size and positions must be entered correctly (in the `Room modes` tab, which you turn on under Feature modules). Within 25 cm of a wall the heatmap does not cover the seat. It tells you where the bass is more even, nothing about the treble or reflections.

---

## 4.9 Customising look and layout

1. `07 Settings → Appearance`:
   - **Palettes**: ten presets and one custom palette (pick background, panel, text, accent and lamp colours; a contrast warning appears if it is too low).
   - **Textures**: surface texture for panels, side rail and top bar (grain, brushed metal, wood, leather, felt, linen, paper, carbon fibre, crackle varnish), with adjustable strength.
   - **Wallpapers**: built-in pixel-art and woodblock-style landscapes, or upload an image up to 8 MB; dim, blur and panel transparency are adjustable.
   - **Player page**: turntable, cassette deck, big VU meter, big cover, minimal; vinyl comes in ten colours, cassette shells are selectable; meters can be needle, LED or nixie.
   - "Export theme / Import theme" shares the whole look.
2. **Edit layout** at the top right: every panel can be dragged, resized or hidden; rail pages can be reordered or hidden. Press `Esc` or "Done" to finish.
3. While editing, the rail shows **+ Add page**: create a custom page, press "+ Add widget" and choose from the catalogue: now playing, mini turntable, VU meter, quick switches, clock, sleep timer, SPL / amp-speaker match / distance-delay / room-mode calculators, test tone, notes.
4. `Settings → Layout & widgets` exports, imports or resets the whole layout.

---

## 5. Listening modes

Switch with the mode knob on `01 Play`:

| Mode | Description |
|---|---|
| Stereo | Only the stereo DAC and the front speakers; the purest |
| Quad A | Front normal, rear −6 dB and delayed 15 ms, like a larger space |
| Quad B | Front and rear at equal level; good for background music and parties |
| Ambience (Hafler) | The rear plays only the left-minus-right difference signal: the reverberation and space in the recording come from behind, vocals stay in front |
| Channel ID / Measure routing | For wiring checks and measurement |

Switching modes also switches the Windows default output device. If you do not want that, turn off "Auto-switch default output" in `07 Settings`.

---

## 6. Headphones and Bluetooth

![Headphones page](img/headphones.png)

`06 Headphones`: every non-speaker output (wired headphones, Bluetooth headphones, USB amp) has its own profile. Whichever device Windows switches to, its profile is applied.

- **A stereo DAC can drive headphones too**: if your DAC has a headphone jack, it appears in the list with an extra "this DAC is connected to: speakers / headphones" switch on top. Equalizer APO cannot tell whether speakers or headphones are plugged in, so when you plug in headphones, switch to "Headphones" and the DAC uses the headphone profile with no room correction; switch back when you return to speakers.
- A multichannel sound card is only for speakers and does not appear here.

1. If it says "Equalizer APO is not installed on this device", press **Open Device Selector**, tick it, then reboot.
2. **AutoEq**: search by headphone model (data comes from the AutoEq project, target curve Harman) and click to apply.
3. **Bass / Treble**: fine-tune to taste.
4. **Crossfeed**: mixes in a little delayed, low-passed sound from the opposite channel, imitating how both ears hear both speakers. It is less fatiguing over long sessions and moves the image from inside your head to the front.

**Bluetooth list:** only connected headphones show battery level and the hands-free switch; paired but disconnected devices sit in a grey list below with their last connection date.

**Bluetooth notes:**

- Codecs (AAC, aptX, LDAC) are negotiated between Windows and the headphones; software cannot choose.
- Whenever an app opens the microphone (Discord, conferencing software), Bluetooth switches to "hands-free" profile: mono, low quality. If you do not use the headset microphone, disable hands-free for that headset on this page.

---

## 7. Library

`02 Library`: choose the source at the top (All / Spotify / YouTube Music) and type (Tracks / Albums / Playlists).

- Results appear as record sleeves. Click a sleeve and the record slides out with the tracks below.
- Press **Play all**, or click any track to start from there.
- The other player is paused automatically before playback, so the two sources switch seamlessly.
- The page also lists "Other players": browsers, foobar2000, MusicBee and anything else supporting Windows media controls can be controlled here too.

---

## 8. FAQ

**No sound, or effects have no effect**
Check the Equalizer APO status in `07 Settings`. If the device does not have EQ APO, run Device Selector, tick it and reboot.

**Changing settings does nothing**
Usually permissions. In `07 Settings` press **Grant write access**, or rerun `setup.cmd -Step 4`.

**Measurement picks up no signal, or the SNR is low**
See "Microphone level" in section 2.

**Rear speakers are silent**
Windows Sound settings → the device → Configure → choose **7.1 surround** (not 5.1 or stereo). On most USB 7.1 cards the "rear" jack is SL/SR; if yours differs, change it in `07 Settings` → Channel mapping.

**Delay sounds wrong**
Delay is only applied once all four speakers have been measured. You can also use "Channel ID" to check that front and rear are not swapped.

**I want to undo everything**

- Rename `C:\Program Files\EqualizerAPO\config\config.backup-*.txt` back to `config.txt`.
- Settings → Apps → uninstall "Fono Console". The settings stay in `%APPDATA%\FonoConsole`; delete them by hand if you wish.
- Chrome policy: run `setup.cmd -UndoChrome`.

**Chrome or another app opens many processes**
Chromium runs one process per tab, per extension, plus GPU and network services, so 20 or more is normal. What really affects memory is the number of extensions and background persistence. Step 8 of the setup script can switch off background running and enable memory saver.

---

## 8.5 Lab and advanced measurement

Turn these on in `Settings → Feature modules`. Core features are on by default; experimental ones are off.

- **Target curve editor** (Measure page): drag nodes, pick a preset (flat, room curve, warm, bright), and the auto-EQ follows it.
- **Decay analysis** (Measure page, "Decay" tab): EDT, T20 and T30 per octave band, plus a 20 Hz–1 kHz waterfall.
- **Mic pairing**: place two microphones at the same point, measure the same speaker, and store the difference curve; you can also import a UMIK-style `.txt` calibration file. Each microphone first records 10 s of silence (keep quiet during the countdown), then 1 / 2 / 4 / 8 sweeps (default 4); the sweeps are aligned on the main peak and averaged coherently, and the page shows "repeatability ±x dB" (a warning above 1 dB between 100 Hz and 10 kHz). Bands with a signal-to-noise ratio below 15 dB count as unreliable: they are greyed in the graph and the stored calibration is 0 dB there, with a 1/3-octave crossfade at the edges. Press Cancel to stop a measurement.
- **Early reflections** and **room scan**: enter or import room dimensions, drag the seat and speakers on the floor plan to see where absorbers belong, which room modes your seat sits on a node of, and how far to move.
- **Equal-loudness compensation** (Effects page): restores bass and treble per ISO 226 when listening quietly.
- **ART**: robust fitting (covers three room variants at ±1% temperature), before/after prediction report plots, and combining ART with ordinary correction.
- **No-signal guard**: if the sweep is not recorded during measurement, it stops and tells you whether the amplifier, input selection or volume is the problem.

---

## 9. Advanced: using REW

REW offers waterfall plots, RT60 and finer analysis.

1. In REW enable the API: Preferences → API → Start server.
2. In Fono Console go to `05 Measure` → `REW`: it reads REW's measurements and EQ filters and applies them to any channel in one click.

The Equalizer APO configuration Fono Console generates is `config\fono_console.txt`. You can open it directly; it uses standard Equalizer APO syntax throughout.
