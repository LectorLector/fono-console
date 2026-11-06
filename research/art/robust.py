import numpy as np, sim
from sim import f, N, ROOM, matrix, positions, target, band, lowpass_blend, to_fir, hp
from study import band_t30, BANDS

VAL = positions(16, 0.25, 7)
real = {'exact room': matrix(ROOM, VAL),
        'realistic error (1 %, 2 cm, T60 +10 %)': matrix(ROOM * np.array([1.01, 0.99, 1.01]), VAL, shift=0.02, t60=0.5),
        'pessimistic error (3 %, 5 cm)': matrix(ROOM * np.array([1.03, 0.98, 1.02]), VAL, shift=0.05, t60=0.5)}

def design(Hrows, use, cap_db=12, reg=1e-3):
    W = np.zeros((4, len(f)), dtype=complex); cap = 10 ** (cap_db / 20); idx = [i for i, u in enumerate(use) if u]
    for k in np.where((f > 0) & (f <= 200))[0]:
        A = Hrows[:, idx, k]; d = target[k] * np.ones(len(A))
        AA, Ad = A.conj().T @ A, A.conj().T @ d
        beta = reg * np.real(np.trace(AA)) / len(idx) + 1e-15
        for _ in range(40):
            x = np.linalg.solve(AA + beta * np.eye(len(idx)), Ad)
            if np.max(np.abs(x)) <= cap: break
            beta *= 2
        W[idx, k] = x
    return to_fir(lowpass_blend(W))

def dev(H, W):
    P = np.einsum('mik,ik->mk', H, W)
    return np.mean(np.abs(20 * np.log10(np.abs(P[:, band]) + 1e-12) - 20 * np.log10(np.abs(target[band]))))

# measured data the user would actually have: 9 points (+-15 cm) or 15 points (+-25 cm, incl. height)
H9 = matrix(ROOM, positions(9, 0.15, 0))
P15 = positions(9, 0.25, 0) + positions(6, 0.25, 3)
H15 = matrix(ROOM, P15)
# robust: same 15 measured points, plus the same points in +-1 % rooms (stands in for temperature drift)
Hrob = np.concatenate([H15, matrix(ROOM * 1.01, P15, t60=0.42), matrix(ROOM * 0.99, P15, t60=0.5)])

cases = {'none': sim.strategy('none'), 'cabs': sim.strategy('cabs'),
         'front-only, 9 pts': design(H9, [1, 1, 0, 0]),
         'all-4, 9 pts': design(H9, [1, 1, 1, 1]),
         'all-4, 15 pts wider': design(H15, [1, 1, 1, 1]),
         'all-4, 15 pts robust': design(Hrob, [1, 1, 1, 1]),
         'all-4, 15 pts robust, +6': design(Hrob, [1, 1, 1, 1], cap_db=6)}
for title, H in real.items():
    print(f'== {title}  (T60 ms per 1/3 oct, median of 16 unseen positions; dev = |dB| from target)')
    print(f"{'':28s}" + ''.join(f'{b:>6d}' for b in BANDS) + '   dev')
    for name, W in cases.items():
        print(f'{name:28s}' + ''.join(f'{t:6.0f}' for t in band_t30(H, W)) + f'{dev(H, W):6.1f}')
