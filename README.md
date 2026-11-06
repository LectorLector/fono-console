<p align="center"><img src="web/icon.svg" width="96" alt=""></p>

<h1 align="center">Fono Console</h1>
<p align="center"><b>Room correction, phase correction, headphone EQ and a vinyl-shelf music library for Windows, on top of Equalizer APO.</b><br>
聲場控制台：一鍵房間量測與矯正、FIR 相位校正、耳機 AutoEq、Spotify／YouTube Music 唱片架。</p>

<p align="center">
<a href="https://LectorLector.github.io/fono-console/">Live demo &amp; guide · 互動教學</a> ·
<a href="https://github.com/LectorLector/fono-console/releases">Download · 下載</a> ·
<a href="ROADMAP.md">Roadmap</a> ·
<a href="docs/tutorial.zh-TW.md">中文教學（純文字版）</a>
</p>

![Fono Console](docs/img/screenshot.png)

## Why

Windows has excellent free DSP (Equalizer APO) and excellent free measurement software (REW), but getting from "I have speakers and a mic" to "my room is corrected and stays corrected" still takes an afternoon of reading forums. Fono Console does that path in one window:

- **One-click room correction**: routes each speaker on its own, plays a log sweep with a loop-back timing reference, then works out arrival time, polarity and room modes. It fits cut-only peaking filters up to the Schroeder frequency, with 1/3/5-position averaging. No REW needed, though REW is supported.
- **ART-style active bass control (experimental)**: measure four speakers at 15 positions; per-speaker FIRs solved by regularised least squares let the rear pair absorb the bass modes the front pair excites. In a simulated bedroom, modal decay at 40–63 Hz is cut by about 25–45%. The prediction table includes a ±6 °C temperature-drift case. Study: [research/art](research/art/README.md).
- **FIR phase correction**: linear-phase all-pass FIR that removes the speaker's excess phase (crossover and port roll-off), computed from a measurement or from a crossover model. Latency is identical at every sample rate.
- **Speaker layout**: the wizard asks whether you have headphones only, a 2.0 pair or front + rear pairs (4.0). Pages and keys that do not apply are hidden (nothing is deleted), the 2.0 config mutes the rear channels, and measurement, FIR and ART only list the speakers you have. Change it later in Settings.
- **Multichannel listening modes**: stereo, quad-A (delayed ambience), quad-B (bass reinforcement) and Hafler difference surround. The Windows default device follows the mode.
- **Measurement guard**: a sweep that records no signal (amp off, wrong input) stops with a plain explanation instead of fitting noise.
- **Target curve editor**: drag nodes on a log-frequency graph (flat, room curve, warm, bright) and the auto-EQ follows it; the old bass-rise knob is the default shelf.
- **Decay analysis**: EDT, T20 and T30 per octave band from the measured impulse response, plus a waterfall (CSD) plot.
- **Mic pairing and calibration files**: pair two microphones on the same speaker so they read alike, or import a UMIK-style `.txt` calibration file.
- **Equal-loudness compensation (experimental)**: an ISO 226 low/high shelf pair that restores bass and treble when you listen quietly.
- **Lab modules (experimental)**: ART (robust over +-1 % temperature variants, with a decay report), room scan import with a draggable floor plan, first-reflection mirror points matched to measured peaks, and room-mode pressure at your seat with a seat-move suggestion.
- **Headphones**:
  - A profile per device.
  - AutoEq database search, bass/treble, crossfeed.
  - Bluetooth battery level and the hands-free (mono) switch.
  - A stereo DAC can switch between speakers and headphones.
- **Library**: Spotify and YouTube Music searched together. Albums and playlists are record sleeves that slide open, and switching sources pauses the other player.
- **Looks**:
  - Four panel skins (mixing desk, walnut hi-fi, aluminium deck, graphite studio), light/dark and any accent colour.
  - Ten colour palettes plus a custom five-colour palette with a contrast warning.
  - Panel textures (grain, brushed metal, wood, leather, felt, linen, paper, carbon, crackle) and wallpapers: built-in pixel-art and woodblock tributes to public-domain paintings, or upload your own, with dim, blur and panel transparency.
  - Theme export / import.
- **Player**: turntable (ten vinyl colours, four decks, dust lid), cassette deck (shell colours), big VU, big cover and minimal layouts. Needle, LED and nixie meters, and the animations follow the music.
- **Widgets and custom pages**: "Edit layout" lets you drag, resize and hide every panel and reorder or hide rail pages. Add your own pages on a 12-column grid and fill them with widgets (now playing, mini turntable, VU, quick switches, clock, sleep timer, SPL / amp-speaker / delay / room-mode calculators, test tone, notes). Layouts export and import.
- **Tours**: the in-app tour and the tutorial site cover the new pieces, including a "Customise look and layout" flow. A first-run wizard step picks skin, palette, wallpaper and player style for you.
- **Setup wizard**: asks what you want to do, installs Equalizer APO (official installer bundled), picks devices, takes over `config.txt` with a backup, and installs and wires up YouTube Music (hash-verified) and Spotify.

Everything runs locally: the server listens on `127.0.0.1` only, and tokens and settings stay in `%APPDATA%\FonoConsole`.

## Get started · 開始使用

1. Download `FonoConsole-x.y.z.zip` from Releases and unzip it.
2. Run `FonoConsole.exe`. The setup wizard opens on first launch.
3. Reboot once if you added devices in Equalizer APO's Device Selector.
4. Follow the guide for what you want to do: room, headphones, library…

The [interactive guide](https://LectorLector.github.io/fono-console/) runs the real interface in your browser with a simulated backend, and each tutorial plays itself step by step. The same guide is built into the app (Settings → 教學網站) and works offline.

A command-line version of the wizard is included: `scripts\setup.cmd` (`-Step 3,9` runs only some steps).

## Build

Go 1.24+, no third-party Go modules, and no Node/npm: the UI is plain ES modules embedded with `go:embed`.

```sh
scripts/build.sh                 # cross-compile from Linux/macOS → dist/FonoConsole.exe
scripts\build.ps1                # on Windows
go run . --demo                  # any OS: simulated devices and media at http://127.0.0.1:47811
scripts/package.sh 2.6.0         # release zip with the bundled Equalizer APO installer
```

Tags `v*` build a release, and pushes to `docs/` or `web/` deploy the guide to GitHub Pages (`.github/workflows`).

### Architecture

```
FonoConsole.exe (Go)
 ├─ 127.0.0.1:47811   HTTP + server-sent events; UI opens in an Edge/Chrome app window
 │   ├─ /               web/ (embedded UI)          /guide/  docs/ (embedded guide + live demo)
 │   ├─ /api/eapo/*     writes fono_console.txt, IR and FIR wav files for Equalizer APO
 │   ├─ /api/setup/*    setup wizard: installers (hash-verified), YouTube Music API, Chrome policy
 │   ├─ /api/spotify/*  PKCE OAuth + Web API proxy        /api/ytm/*  YouTube Music desktop API
 │   ├─ /api/autoeq/*   AutoEq index and profiles (cached) /api/rew/*  REW API proxy
 └─ assets/bridge.ps1   resident PowerShell: media sessions (SMTC), Core Audio meters,
                        default device, device list, Bluetooth battery/connection
web/js/   eapo.js (config generator) · measure.js (sweep, deconvolution, auto-EQ) · fir.js
          (excess phase, FIR design) · library.js · headphones.js · setup.js · mock.js (demo backend)
```

## Contributing

Issues and pull requests are welcome, especially:

- measurement data from real rooms (before/after)
- testing with other sound cards and mics
- translations
- the items in the [roadmap](ROADMAP.md): binaural headphone measurement, virtual speakers, parametric EQ editor

## Credits & licenses

MIT © Fono Console contributors. Equalizer APO (GPLv2) is bundled unmodified, and YouTube Music desktop (MIT) is downloaded and verified by the wizard. AutoEq (MIT) data is read on demand. REW is not redistributable and is only linked. Details: [THIRD_PARTY.md](THIRD_PARTY.md). Spotify and YouTube are trademarks of their owners; this project is not affiliated with them.
