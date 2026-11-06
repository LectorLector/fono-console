import numpy as np, sim
from sim import f, fs, N, Htr, Hva, Hpert, target, band, TRAIN, hp, lowpass_blend, to_fir

def eq_cuts():
    mag = np.sqrt(np.mean(np.abs(Htr[:, 0] + Htr[:, 1]) ** 2, axis=0))
    g = np.clip(np.abs(target) / (mag + 1e-12), 10 ** (-15 / 20), 1.0); g = np.where(band, g, 1)
    lg = np.log(np.concatenate([g, g[-2:0:-1]])); cep = np.fft.ifft(lg).real; cep[1:N // 2] *= 2; cep[N // 2 + 1:] = 0
    G = np.exp(np.fft.fft(cep))[:len(f)]
    return lowpass_blend(np.vstack([G, G, 0 * G, 0 * G]))

def mimo(use, cap_db, reg=1e-3, tgt=target):
    W = np.zeros((4, len(f)), dtype=complex); cap = 10 ** (cap_db / 20)
    idx = [i for i, u in enumerate(use) if u]
    for k in np.where((f > 0) & (f <= 200))[0]:
        A = Htr[:, idx, k]; d = tgt[k] * np.ones(len(TRAIN))
        AA, Ad = A.conj().T @ A, A.conj().T @ d
        beta = reg * np.real(np.trace(AA)) / len(idx) + 1e-15
        for _ in range(40):
            x = np.linalg.solve(AA + beta * np.eye(len(idx)), Ad)
            if np.max(np.abs(x)) <= cap: break
            beta *= 2
        W[idx, k] = x
    return to_fir(lowpass_blend(W))

BANDS = [40, 50, 63, 80, 100, 125]
def lp4(fc):
    s = 1j * f / fc
    return 1 / ((s ** 2 + 0.7654 * s + 1) * (s ** 2 + 1.8478 * s + 1))

def band_t30(H, W):
    """Causal 1/3-octave band-pass (analog Butterworth), Schroeder integral from the peak,
    slope between -5 and -25 dB extrapolated to T60."""
    P = np.einsum('mik,ik->mk', H, W); out = []
    stop = N - int(0.6 * fs)            # ignore the end of the buffer (FIR wrap guard)
    for fc in BANDS:
        bp = hp(fc / 2 ** (1 / 6), 4) * lp4(fc * 2 ** (1 / 6))
        ir = np.fft.irfft(P * bp, N, axis=-1); vals = []
        for m in range(len(P)):
            env = ir[m][:stop] ** 2; t0 = int(np.argmax(env)); e = env[t0:]
            sch = np.cumsum(e[::-1])[::-1]; sch = 10 * np.log10(sch / sch[0] + 1e-30)
            i5 = int(np.argmax(sch < -5)); i25 = int(np.argmax(sch < -25))
            vals.append(3 * (i25 - i5) / fs if i25 > i5 else np.nan)
        out.append(np.nanmedian(vals) * 1000)
    return out

def dev(H, W):
    P = np.einsum('mik,ik->mk', H, W)
    return np.mean(np.abs(20 * np.log10(np.abs(P[:, band]) + 1e-12) - 20 * np.log10(np.abs(target[band]))))

cases = {'none': sim.strategy('none'), 'eq (cuts)': eq_cuts(), 'cabs': sim.strategy('cabs'),
         'front-only MP, +8': mimo([1, 1, 0, 0], 8), 'all-4 MIMO, +8': mimo([1, 1, 1, 1], 8),
         'all-4 MIMO, +12': mimo([1, 1, 1, 1], 12), 'all-4 MIMO, +12, reg 1e-4': mimo([1, 1, 1, 1], 12, 1e-4)}
for title, H in (('VALIDATION', Hva), ('PERTURBED ROOM', Hpert)):
    print(f'== {title}: T60 (ms) per 1/3-octave band, median over positions; dev = mean |dB| from target 25-160 Hz')
    print(f"{'':28s}" + ''.join(f'{b:>7d}' for b in BANDS) + '    dev')
    for name, W in cases.items():
        print(f'{name:28s}' + ''.join(f'{t:7.0f}' for t in band_t30(H, W)) + f'{dev(H, W):7.1f}')
