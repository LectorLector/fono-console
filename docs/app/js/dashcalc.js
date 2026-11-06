// Pure formulas behind the calculator widgets (no DOM, testable with node).
const L10 = Math.log10;

/** Speed of sound in air, m/s, at temperature T (deg C). */
export const soundSpeed = T => 331.3 + 0.606 * T;

/**
 * Peak SPL and headroom at the seat (free field).
 * P: amp watts per channel into the speaker, sens: dB SPL @ 1 W / 1 m, d: metres, N: speakers (incoherent sum),
 * avg: wanted average level (dB SPL), crest: peak-to-average of the music (dB).
 */
export function splCalc({ P, sens, d, N, avg, crest }) {
  const max = sens + 10 * L10(P) - 20 * L10(d) + 10 * L10(N);
  const pAvg = 10 ** ((avg - sens + 20 * L10(d) - 10 * L10(N)) / 10);
  const pPeak = pAvg * 10 ** (crest / 10);
  return { max, pAvg, pPeak, headroom: max - (avg + crest) };
}

/**
 * Amp / speaker matching.
 * p8: rated watts into 8 ohm, z: speaker impedance, df: amp damping factor spec (at 8 ohm),
 * len: one-way cable length (m), mm2: cable cross-section.
 */
export function matchCalc({ p8, z, df, len, mm2 }) {
  const zout = 8 / df;
  const rc = 0.0172 * 2 * len / mm2;               // copper, go and return
  const dfEff = z / (zout + rc);
  const lossDb = 20 * L10(z / (z + zout + rc));
  const ideal = p8 * 8 / z;
  const bound = z < 8;                              // below 8 ohm the supply, not the voltage, decides
  const pz = bound ? Math.min(ideal, 2 * p8) : ideal;
  return { zout, rc, dfEff, lossDb, ideal, pz, bound, current: Math.sqrt(pz / z) };
}

export const msFromM = (d, T) => d / soundSpeed(T) * 1000;
export const mFromMs = (ms, T) => ms / 1000 * soundSpeed(T);
export const waveLen = (f, T) => soundSpeed(T) / f;
export const freqFromLen = (l, T) => soundSpeed(T) / l;

export const dbFromV = r => 20 * L10(r);
export const dbFromP = r => 10 * L10(r);
export const vFromDb = db => 10 ** (db / 20);
export const pFromDb = db => 10 ** (db / 10);
