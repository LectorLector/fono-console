// Subwoofer alignment: pure maths, no DOM. Given the measured impulse responses of the mains and the subwoofer(s) at the
// listening position(s), find the sub delay and polarity that make the acoustic sum through the LR4 crossover largest.
//
// Every measurement is {ir, sr, irPeak, arrivalMs} as produced by measure.js analyseRecording(): ir[i] happened at
// arrivalMs/1000 + (i - irPeak)/sr seconds relative to the FL timing reference, so the complex response keeps its absolute phase.

/** Complex response of an RBJ biquad (Q = 0.7071) at hz. kind 'LP' | 'HP'. */
function biquad(kind, fc, hz, sr) {
  const w0 = 2 * Math.PI * fc / sr, c = Math.cos(w0), al = Math.sin(w0) / (2 * Math.SQRT1_2);
  const b0 = kind === 'LP' ? (1 - c) / 2 : (1 + c) / 2, b1 = kind === 'LP' ? 1 - c : -(1 + c), b2 = b0;
  const a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
  const w = 2 * Math.PI * hz / sr, c1 = Math.cos(w), s1 = -Math.sin(w), c2 = Math.cos(2 * w), s2 = -Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2, ni = b1 * s1 + b2 * s2, dr = a0 + a1 * c1 + a2 * c2, di = a1 * s1 + a2 * s2, d = dr * dr + di * di;
  return [(nr * dr + ni * di) / d, (ni * dr - nr * di) / d];
}
const cmul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];

/** LR4 (two cascaded Butterworth sections) response, complex. */
export function lr4(kind, fc, hz, sr = 48000) { const b = biquad(kind, fc, hz, sr); return cmul(b, b); }

/** Complex spectrum of one measurement at the given frequencies (direct DFT, absolute time kept). */
export function responseAt(m, freqs, windowMs = 400) {
  const sr = m.sr, n = Math.min(m.ir.length, Math.round(windowMs / 1000 * sr)), fade = Math.round(n * 0.2);
  const t0 = (m.arrivalMs || 0) / 1000 - (m.irPeak || 0) / sr;
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = m.ir[i] * (i > n - fade ? 0.5 + 0.5 * Math.cos(Math.PI * (i - (n - fade)) / fade) : 1);
  return freqs.map(f => {
    const om = 2 * Math.PI * f, ph0 = -om * t0, dr = Math.cos(-om / sr), di = Math.sin(-om / sr);
    let cr = Math.cos(ph0), ci = Math.sin(ph0), re = 0, im = 0;
    for (let i = 0; i < n; i++) {
      re += w[i] * cr; im += w[i] * ci;
      const t = cr * dr - ci * di; ci = cr * di + ci * dr; cr = t;
      if ((i & 4095) === 4095) { const g = 1 / Math.hypot(cr, ci); cr *= g; ci *= g; }   // keep the phasor on the unit circle
    }
    return [re, im];
  });
}

const logGrid = (lo, hi, n) => Array.from({ length: n }, (_, i) => lo * Math.pow(hi / lo, i / (n - 1)));

/**
 * Align subwoofers to the mains.
 *  mains: [{list: [meas per position], gainDb, delayMs}]   (the speakers that play the music bass: normally FL and FR)
 *  subs:  [{list: [meas per position], gainDb, delayMs}]   (delayMs is ignored: the search finds it)
 *  Both play the same mono signal. The mains go through an LR4 high-pass at xover (unless mainsFull), the subs through an LR4 low-pass.
 * Search: polarity +/- and delay -maxMs..+maxMs in stepMs steps, maximising the mean |sum| over `lo`..`hi` x xover (and over all positions).
 * A negative delay means "the mains are late" (they have to be delayed instead). Several subs are aligned one after the other,
 * each against the mains plus the subs that are already aligned.
 * Returns {subs:[{delayMs, invert, score, scoreBefore}], shiftMs, f, before:{db}, after:{db}, gainDb}.
 */
export function alignSubs({ mains, subs, xover = 80, mainsFull = false, lo = 0.5, hi = 2, maxMs = 10, stepMs = 0.1, windowMs = 400, positions }) {
  const sr = mains[0].list[0].sr;
  const P = Math.min(positions || Infinity, ...mains.map(x => x.list.length), ...subs.map(x => x.list.length));
  const nSteps = Math.round(maxMs / stepMs);
  const prep = freqs => {
    const gain = db => Math.pow(10, (db || 0) / 20);
    const M = [], S = subs.map(() => []);
    for (let p = 0; p < P; p++) {
      const m = freqs.map(() => [0, 0]);
      for (const sp of mains) {
        const H = responseAt(sp.list[p], freqs, windowMs), g = gain(sp.gainDb);
        freqs.forEach((f, i) => {
          const hp = mainsFull ? [1, 0] : lr4('HP', xover, f, sr), ph = -2 * Math.PI * f * (sp.delayMs || 0) / 1000;
          const v = cmul(cmul(H[i], hp), [Math.cos(ph) * g, Math.sin(ph) * g]);
          m[i][0] += v[0]; m[i][1] += v[1];
        });
      }
      M.push(m);
      subs.forEach((sb, j) => {
        const H = responseAt(sb.list[p], freqs, windowMs), g = gain(sb.gainDb);
        S[j].push(freqs.map((f, i) => { const v = cmul(H[i], lr4('LP', xover, f, sr)); return [v[0] * g, v[1] * g]; }));
      });
    }
    return { M, S };
  };
  // mean |ref + pol * e^{-j w tau} * sub| over positions and frequencies
  const score = (freqs, R, Sj, tauMs, pol) => {
    let acc = 0;
    for (let p = 0; p < P; p++) for (let i = 0; i < freqs.length; i++) {
      const ph = -2 * Math.PI * freqs[i] * tauMs / 1000, c = Math.cos(ph) * pol, s = Math.sin(ph) * pol, v = Sj[p][i];
      acc += Math.hypot(R[p][i][0] + v[0] * c - v[1] * s, R[p][i][1] + v[0] * s + v[1] * c);
    }
    return acc / (P * freqs.length);
  };
  const band = logGrid(xover * lo, xover * hi, 49);
  const { M, S } = prep(band);
  const order = [0]; for (let k = 1; k <= nSteps; k++) order.push(k, -k);   // ties resolve toward the smallest delay
  const R = M.map(m => m.map(v => [...v])), res = [];
  subs.forEach((_, j) => {
    const before = score(band, R, S[j], 0, 1);
    let best = { delayMs: 0, invert: false, score: -1 };
    for (const pol of [1, -1]) for (const k of order) {
      const tau = k * stepMs, sc = score(band, R, S[j], tau, pol);
      if (sc > best.score + 1e-9) best = { delayMs: Math.round(tau * 1e6) / 1e6, invert: pol < 0, score: sc };
    }
    res.push({ ...best, scoreBefore: before });
    for (let p = 0; p < P; p++) for (let i = 0; i < band.length; i++) {   // fold the aligned sub into the reference for the next one
      const ph = -2 * Math.PI * band[i] * best.delayMs / 1000, c = Math.cos(ph) * (best.invert ? -1 : 1), s = Math.sin(ph) * (best.invert ? -1 : 1), v = S[j][p][i];
      R[p][i][0] += v[0] * c - v[1] * s; R[p][i][1] += v[0] * s + v[1] * c;
    }
  });
  const shiftMs = Math.round(-Math.min(0, ...res.map(r => r.delayMs)) * 1e6) / 1e6 + 0;
  // curves for the report: summed response (mean power over positions) with the subs at delay 0 / normal polarity versus aligned
  const gridF = logGrid(20, 250, 64), W = prep(gridF);
  const curve = tauOf => gridF.map((f, i) => {
    let e = 0;
    for (let p = 0; p < P; p++) {
      let re = W.M[p][i][0], im = W.M[p][i][1];
      subs.forEach((_, j) => {
        const t = tauOf(j), ph = -2 * Math.PI * f * t.delayMs / 1000, sg = t.invert ? -1 : 1, v = W.S[j][p][i];
        re += sg * (v[0] * Math.cos(ph) - v[1] * Math.sin(ph)); im += sg * (v[0] * Math.sin(ph) + v[1] * Math.cos(ph));
      });
      e += re * re + im * im;
    }
    return 10 * Math.log10(e / P + 1e-24);
  });
  const before = curve(() => ({ delayMs: 0, invert: false })), after = curve(j => res[j]);
  const inBand = gridF.map((f, i) => f >= xover * lo && f <= xover * hi ? i : -1).filter(i => i >= 0);
  const mean = a => inBand.reduce((s, i) => s + a[i], 0) / Math.max(1, inBand.length);
  return { subs: res, shiftMs, f: gridF, before: { db: before }, after: { db: after }, gainDb: mean(after) - mean(before), xover, band: [xover * lo, xover * hi] };
}
