"""Feasibility study: ART-style multi-speaker bass correction in a small bedroom.

Modal model of a rectangular room; 2 front + 2 rear speakers; compare
  none   : front pair, no correction
  eq     : conventional per-channel EQ on the front pair (magnitude only)
  cabs   : CABS (rear = inverted, delayed by L/c)
  mimo   : least-squares FIR for all 4 speakers over 9 mic positions (ART-like)
Metrics on 16 *validation* positions and in a *perturbed* room."""
import numpy as np

c = 343.0
fs = 1024.0
N = 4096                      # 4 s at 1024 Hz -> 0.25 Hz bins
f = np.fft.rfftfreq(N, 1 / fs)
w = 2 * np.pi * f
rng = np.random.default_rng(1)

def modes(L, fmax=320):
    out = []
    for nx in range(0, 12):
        for ny in range(0, 12):
            for nz in range(0, 8):
                fn = c / 2 * np.sqrt((nx / L[0]) ** 2 + (ny / L[1]) ** 2 + (nz / L[2]) ** 2)
                if fn < fmax:
                    out.append((nx, ny, nz, fn))
    return out

def psi(m, L, p):
    nx, ny, nz, _ = m
    return np.cos(nx * np.pi * p[0] / L[0]) * np.cos(ny * np.pi * p[1] / L[1]) * np.cos(nz * np.pi * p[2] / L[2])

def tf(L, src, rcv, t60=0.45):
    """Pressure at rcv for unit volume acceleration at src (arbitrary scale)."""
    d = 6.91 / t60
    H = np.zeros_like(f, dtype=complex)
    for m in modes(L):
        eps = np.prod([1 if n == 0 else 2 for n in m[:3]])
        wn = 2 * np.pi * m[3]
        H += eps * psi(m, L, src) * psi(m, L, rcv) / (wn ** 2 - w ** 2 + 2j * d * w + 1e-9)
    return H * w ** 2   # radiation ~ acceleration: flat-ish above the modal region

def hp(fc, order):    # speaker roll-off (Butterworth high-pass magnitude/phase)
    s = 1j * f / fc
    if order == 4:
        return s ** 4 / ((s ** 2 + 0.7654 * s + 1) * (s ** 2 + 1.8478 * s + 1))
    return s ** 2 / (s ** 2 + 1.4142 * s + 1)

ROOM = np.array([3.6, 3.0, 2.6])
SPK = {'FL': (0.35, 0.95, 1.0), 'FR': (0.35, 2.05, 1.0), 'SL': (3.3, 0.6, 2.0), 'SR': (3.3, 2.4, 2.0)}
SEAT = np.array([1.6, 1.5, 1.1])
ROLL = {'FL': hp(55, 4), 'FR': hp(55, 4), 'SL': hp(60, 4), 'SR': hp(60, 4)}
NAMES = list(SPK)

def positions(n, spread, seed):
    r = np.random.default_rng(seed)
    if n == 9:
        g = [(dx, dy, dz) for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (0,)]
        return [SEAT + np.array(v) * spread for v in g]
    return [SEAT + r.uniform(-1, 1, 3) * np.array([spread, spread, 0.6 * spread]) for _ in range(n)]

def matrix(L, pts, shift=0.0, t60=0.45):
    """H[m, i, k]: mic m, speaker i, bin k."""
    H = np.zeros((len(pts), 4, len(f)), dtype=complex)
    for m, p in enumerate(pts):
        for i, nm in enumerate(NAMES):
            s = np.array(SPK[nm]) + shift
            H[m, i] = tf(L, s, p, t60) * ROLL[nm]
    return H

band = (f >= 25) & (f <= 160)
TRAIN = positions(9, 0.15, 0)
VAL = positions(16, 0.25, 7)
Htr = matrix(ROOM, TRAIN)
Hva = matrix(ROOM, VAL)
# a room that is 3 % off and speakers 5 cm off: what real measurements vs. reality look like
Hpert = matrix(ROOM * np.array([1.03, 0.98, 1.02]), VAL, shift=0.05, t60=0.5)

# common target: delayed version of a smooth response (front pair's direct sound, no room)
ref = np.sqrt(np.mean(np.abs(Htr[:, 0] + Htr[:, 1]) ** 2, axis=0))     # rms level of front pair
lvl = np.exp(np.mean(np.log(ref[band] + 1e-12)))
tau = 0.040                                                            # modelling delay (s)
target = lvl * hp(38, 4) * np.exp(-1j * w * tau)                       # flat down to the speakers' own roll-off

def lowpass_blend(W, fc=160):
    """Apply the filters only below fc; above it every speaker plays as before (front=1, rear=0)."""
    t = 1 / (1 + (f / fc) ** 8)
    base = np.array([1, 1, 0, 0])[:, None]
    return W * t + base * (1 - t)

def to_fir(W, taps=2048):
    """Make the per-bin solution a causal FIR (what Equalizer APO would actually run)."""
    h = np.fft.irfft(W, N, axis=-1)[:, :taps]
    win = np.ones(taps); k = taps // 8; win[-k:] = 0.5 + 0.5 * np.cos(np.pi * np.arange(k) / k)
    return np.fft.rfft(h * win, N, axis=-1)

def strategy(name):
    if name == 'none':
        return np.tile(np.array([1, 1, 0, 0])[:, None], (1, len(f))).astype(complex)
    if name == 'eq':      # magnitude-only correction of the front pair, cuts mostly (+6 dB max)
        mag = np.sqrt(np.mean(np.abs(Htr[:, 0] + Htr[:, 1]) ** 2, axis=0))
        g = np.abs(target) / (mag + 1e-12)
        g = np.clip(g, 10 ** (-15 / 20), 10 ** (6 / 20))
        g = np.where(band, g, 1)
        # minimum phase via cepstrum
        lg = np.log(np.concatenate([g, g[-2:0:-1]]))
        cep = np.fft.ifft(lg).real; cep[1:N // 2] *= 2; cep[N // 2 + 1:] = 0
        G = np.exp(np.fft.fft(cep))[:len(f)]
        return lowpass_blend(np.vstack([G, G, 0 * G, 0 * G]))
    if name == 'cabs':
        dly = np.exp(-1j * w * ROOM[0] / c)
        return lowpass_blend(np.vstack([np.ones_like(f), np.ones_like(f), -dly, -dly]).astype(complex), fc=110)
    if name == 'mimo':
        W = np.zeros((4, len(f)), dtype=complex)
        cap = 10 ** (8 / 20)                                       # max +8 dB per speaker (headroom)
        for k in np.where((f > 0) & (f <= 200))[0]:
            A = Htr[:, :, k]                                       # 9 mics x 4 speakers
            d = target[k] * np.ones(len(TRAIN))
            AA, Ad = A.conj().T @ A, A.conj().T @ d
            beta = 1e-3 * np.real(np.trace(AA)) / 4 + 1e-15
            for _ in range(40):                                    # raise regularisation until effort fits
                x = np.linalg.solve(AA + beta * np.eye(4), Ad)
                if np.max(np.abs(x)) <= cap: break
                beta *= 2
            W[:, k] = x
        W = to_fir(lowpass_blend(W))
        return W
    raise ValueError

def metrics(H, W):
    P = np.einsum('mik,ik->mk', H, W)                         # pressure at each mic
    db = 20 * np.log10(np.abs(P[:, band]) + 1e-12)
    tdb = 20 * np.log10(np.abs(target[band]))
    spread = np.mean(np.std(db, axis=0))                     # dB, across positions
    dev = np.mean(np.abs(db - tdb))                          # dB, vs target
    # modal ringing: energy remaining 150 ms after the direct sound, bass band only
    lp = np.abs(hp(30, 4) / (1 + (1j * f / 150) ** 4))   # smooth 30-150 Hz band
    ir = np.fft.irfft(P * lp, N, axis=-1)
    e = ir ** 2
    t0 = np.argmax(np.abs(ir), axis=-1)
    late = np.array([e[m, t0[m] + int(0.15 * fs):].sum() / e[m].sum() for m in range(len(P))])
    t30 = []
    for m in range(len(P)):                                   # Schroeder decay, time to -30 dB
        sch = np.cumsum(e[m][::-1])[::-1]; sch /= sch[0]
        idx = np.argmax(10 * np.log10(sch + 1e-20) < -30)
        t30.append((idx - t0[m]) / fs)
    return spread, dev, 10 * np.log10(np.mean(late)), np.mean(t30) * 1000

if __name__ == '__main__':
    print(f"room {ROOM} m, modes below 160 Hz: {sum(1 for m in modes(ROOM) if m[3] < 160)}")
    print(f"{'':6s} {'spatial spread':>15s} {'dev from target':>16s} {'late energy':>12s} {'decay -30dB':>12s}")
    for test, H in (('training positions', Htr), ('validation positions (same room)', Hva), ('validation positions, room/speakers 3-5 % off', Hpert)):
        print('--', test)
        for s in ('none', 'eq', 'cabs', 'mimo'):
            sp, dv, late, t30 = metrics(H, strategy(s))
            print(f"{s:6s} {sp:12.1f} dB {dv:13.1f} dB {late:9.1f} dB {t30:9.0f} ms")
