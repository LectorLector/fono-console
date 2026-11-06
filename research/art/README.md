# ART-style multi-speaker bass correction: feasibility study

**Question.** Can a 2 front + 2 rear speaker system in a small bedroom shorten bass ringing (modal decay) across the listening area, the way Dirac Live ART does? Which open-source pieces can we reuse, and what must we build?

## Method
- Modal model of a rectangular room, 3.6 × 3.0 × 2.6 m, T60 0.45 s (`sim.py`). The front pair sits on a desk near the front wall; the rear pair is high, near the back wall. Each speaker has a 4th-order roll-off at 55–60 Hz.
- Strategies:
  - none
  - CABS (Celestinos & Nielsen: rear pair inverted and delayed by L/c)
  - front-only mixed-phase multipoint correction
  - all-four-speaker least-squares FIR (MIMO), designed per frequency bin with Tikhonov regularisation, raised until no speaker needs more than +12 dB. The target is the speakers' natural response plus a 40 ms modelling delay, i.e. no room ringing. Filters are made causal 2048-tap FIRs and only act below ~160 Hz.
- Evaluation is always on **16 positions not used for the design** (±25 cm around the head). Three cases:
  - the exact room
  - a realistic error case: 1 % size / speed of sound (≈ 6 °C), speakers moved 2 cm, T60 +10 %
  - a pessimistic error case: 3 %, 5 cm
- Metric: T60 per 1/3-octave band (causal Butterworth band-pass, Schroeder integral −5…−25 dB), median over positions; plus mean |dB| deviation from target, 25–160 Hz.

## Results (`robust.py`)

| T60 (ms), realistic error | 40 Hz | 50 | 63 | 80 | 100 | 125 | dev (dB) |
|---|---|---|---|---|---|---|---|
| none | 504 | 504 | 501 | 504 | 519 | 517 | 11.7 |
| CABS (textbook delays) | 478 | 501 | 524 | 521 | 535 | 519 | 9.6 |
| front-only, 9 points | 524 | 475 | 458 | 564 | 584 | 520 | 8.5 |
| all-4, 9 points ±15 cm | 333 | 331 | 434 | 438 | 492 | 498 | 6.8 |
| **all-4, 15 points ±25 cm** | **293** | **299** | **406** | **450** | **470** | **483** | **6.8** |

- Using all four speakers, designed from 15 points spread over ±25 cm (including height), cuts decay by **~40 % at 40–50 Hz, ~20 % at 63 Hz and 7–11 % at 80–125 Hz**, while flattening the response.
- CABS with textbook delays does little here: its geometry (fronts near the wall at ¼ and ¾ width, rears at the back wall) is not met.
- Front-only correction **makes ringing worse** once the room drifts. Correcting with one pair of speakers cannot remove energy from the room, only reshape it at the measured points.
- A narrow measurement area (9 points, ±15 cm) is fragile. Under the pessimistic error it is worse than doing nothing above 63 Hz. The wider 15-point design still improves at 40–63 Hz there (393/362/457 vs 501/505/521).
- Capping effort at +6 dB instead of +12 dB loses most of the 40 Hz gain. Amplifier and driver headroom matter.

**Caveats.** This is an idealised rectangular room with point sources and a noise-free measurement. Real gains will be smaller. The method must be verified in the real room by measuring band T60 / waterfall before and after.

## What to reuse vs. build
| Piece | Reuse | Notes |
|---|---|---|
| Sweep, deconvolution, timing reference | Fono's own `measure.js` | Already measures per-speaker IRs with a loop-back timing chirp, which MIMO needs for consistent phase across speakers. |
| MIMO solver | build (this study → `web/js/art.js`) | No maintained open-source tool solves multi-speaker decay-control FIRs. The Rust `autoeq`/RoomEQ crate (GPL-3) does multi-sub alignment and DBA; it is a useful cross-check. |
| Mixed-phase single-channel correction above the bass band | Fono `fir.js`; optional [DRC-FIR](https://drc-fir.sourceforge.net/) (GPL, last release 3.2.3, 2019) | DRC's frequency-dependent windowing and psychoacoustic target are the reference design. |
| Real-time convolution and routing | Equalizer APO (`Copy`, `Convolution`) | CamillaDSP (GPL-3/MPL-2) is a cross-platform alternative if Equalizer APO is ever a limit. |
| Validation | build: band T60 + waterfall in Fono | Needed to prove the effect in each user's room. |

## Implementation plan
1. Measurement: 15 positions (3 × 3 grid ±25 cm at ear height + 6 points ±15 cm higher/lower). Each speaker is swept on its own and the timing reference is kept. Room temperature is noted.
2. Solver (`art.js`): the code above, ported. Per-bin regularised LS with an effort cap (+12 dB default) and a modelling delay of 30–40 ms. Output: FIR per speaker at 44.1/48/96/192 kHz.
3. Routing in Equalizer APO:
   - Mono bass `XB = 0.5 L + 0.5 R`, copied to the four speakers and convolved with their filters.
   - Mains high-passed (LR4) at the hand-over frequency (~100–150 Hz).
   - The solver's target includes the crossover so the sum stays flat.
4. Report: band T60 and deviation before/after at the measured points, plus a "re-measure" reminder when temperature changes by more than 5 °C.
