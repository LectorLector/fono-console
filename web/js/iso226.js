// ISO 226:2003 equal-loudness contours and the shelf pair used for loudness compensation.
import { chainDb } from './dsp.js';

// Standard Table 1 (20 Hz - 12.5 kHz): frequencies, exponent af, magnitude Lu (dB), threshold Tf (dB SPL).
export const ISO_F = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500];
const AF = [0.532, 0.506, 0.480, 0.455, 0.432, 0.409, 0.387, 0.367, 0.349, 0.330, 0.315, 0.301, 0.288, 0.276, 0.267, 0.259, 0.253, 0.250, 0.246, 0.244, 0.243, 0.243, 0.243, 0.242, 0.242, 0.245, 0.254, 0.271, 0.301];
const LU = [-31.6, -27.2, -23.0, -19.1, -15.9, -13.0, -10.3, -8.1, -6.2, -4.5, -3.1, -2.0, -1.1, -0.4, 0.0, 0.3, 0.5, 0.0, -2.7, -4.1, -1.0, 1.7, 2.5, 1.2, -2.1, -7.1, -11.2, -10.7, -3.1];
const TF = [78.5, 68.7, 59.5, 51.1, 44.0, 37.5, 31.5, 26.5, 22.1, 17.9, 14.4, 11.4, 8.6, 6.2, 4.4, 3.0, 2.2, 2.4, 3.5, 1.7, -1.3, -4.2, -6.0, -5.4, -1.5, 6.0, 12.6, 13.9, 12.3];

/** Parameters at an arbitrary frequency: log-f linear interpolation of the tabulated values. */
function params(f) {
  const x = Math.min(ISO_F[ISO_F.length - 1], Math.max(ISO_F[0], f));
  let i = 0; while (i < ISO_F.length - 2 && ISO_F[i + 1] <= x) i++;
  const t = Math.log(x / ISO_F[i]) / Math.log(ISO_F[i + 1] / ISO_F[i]);
  const L = a => a[i] + (a[i + 1] - a[i]) * t;
  return [L(AF), L(LU), L(TF)];
}

/** Sound pressure level (dB SPL) of a pure tone at f that is as loud as a 1 kHz tone of `phon` phon. */
export function isoSpl(f, phon) {
  const [af, lu, tf] = params(f);
  const Af = 4.47e-3 * (Math.pow(10, 0.025 * phon) - 1.15) + Math.pow(0.4 * Math.pow(10, (tf + lu) / 10 - 9), af);
  return (10 / af) * Math.log10(Af) - lu + 94;
}

/** Contour relative to 1 kHz: extra dB needed at f for equal loudness at `phon`. */
export const isoRel = (f, phon) => isoSpl(f, phon) - isoSpl(1000, phon);

/** Compensation (dB) to keep the tonal balance of the `ref` phon level when listening at `listen` phon. */
export const loudDiff = (f, listen, ref = 83) => isoRel(f, listen) - isoRel(f, ref);

const GRID = Array.from({ length: 80 }, (_, i) => 20 * Math.pow(12500 / 20, i / 79));

/**
 * Fit a low shelf (LSC) and a high shelf (HSC), Q = 0.7071, to loudDiff on 20 Hz - 12.5 kHz (LSC fc 40-400 Hz, HSC fc 3-10 kHz, gains capped at +-cap dB). The HSC corner is limited to 10 kHz on purpose: allowing 12 kHz only lowers the fit error from 1.05 to 1.03 dB at 60 phon but doubles the boost the shelf needs (6.3 vs 3.7 dB) - tested, not worth it.
 * Coordinate descent on (fcL, gL, fcH, gH) with a log-spaced error weight; gains capped at +-cap.
 */
export function fitLoudness(listen, { ref = 83, cap = 12 } = {}) {
  const target = GRID.map(f => loudDiff(f, listen, ref));
  const mk = p => [{ type: 'LSC', fc: p[0], gain: p[1], q: 0.7071 }, { type: 'HSC', fc: p[2], gain: p[3], q: 0.7071 }];
  const err = p => { const fl = mk(p); let s = 0; for (let i = 0; i < GRID.length; i++) { const e = chainDb(fl, GRID[i]) - target[i]; s += e * e; } return Math.sqrt(s / GRID.length); };
  const lim = p => [Math.min(400, Math.max(40, p[0])), Math.max(-cap, Math.min(cap, p[1])), Math.min(10000, Math.max(3000, p[2])), Math.max(-cap, Math.min(cap, p[3]))];
  let p = [120, Math.max(-cap, Math.min(cap, target[10])), 6000, Math.max(-cap, Math.min(cap, target[GRID.length - 1]))], best = err(lim(p));
  p = lim(p);
  for (let step = 1; step > 0.01; step *= 0.7) {
    for (let it = 0; it < 30; it++) {
      let moved = false;
      for (let j = 0; j < 4; j++) for (const dir of [1, -1]) {
        const q = p.slice(); q[j] = (j === 0 || j === 2) ? q[j] * Math.pow(2, dir * step / 3) : q[j] + dir * step;
        const e = err(lim(q));
        if (e < best - 1e-9) { best = e; p = lim(q); moved = true; }
      }
      if (!moved) break;
    }
  }
  const r = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
  const filters = mk(p).map(f => ({ ...f, fc: r(f.fc, 0), gain: r(f.gain, 1), q: 0.7071 })).filter(f => Math.abs(f.gain) >= 0.1);
  return { filters, rms: best, grid: GRID, target };
}

const cache = new Map();
/** Filters for state.fx.loud = {on, level}; [] when off or at/above the reference level. */
export function loudFilters(loud) {
  if (!loud || !loud.on) return [];
  const lv = Math.max(60, Math.min(83, +loud.level || 83));
  if (lv >= 83) return [];
  if (!cache.has(lv)) cache.set(lv, fitLoudness(lv).filters);
  return cache.get(lv);
}
