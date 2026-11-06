#!/usr/bin/env python3
"""Procedural built-in wallpapers for fono-console. Pillow + numpy only.
Usage: python3 tools/wallpapers.py [name ...]   (default: all)
Outputs to web/wall/ and writes index.json."""
import json, math, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'web', 'wall')
OUT = os.path.normpath(OUT)
rng = np.random.default_rng(7)

def H(s):
    s = s.lstrip('#'); return tuple(int(s[i:i+2], 16) for i in (0, 2, 4))

BAYER = np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]) / 16.0 + 1 / 32

def dither_grad(arr, y0, y1, cols, x0=0, x1=None, bias=0.0):
    """Fill arr rows y0..y1 with vertical ordered-dither gradient through cols."""
    h, w, _ = arr.shape
    x1 = w if x1 is None else x1
    cols = [np.array(H(c) if isinstance(c, str) else c) for c in cols]
    n = len(cols)
    for y in range(max(0, y0), min(h, y1)):
        t = (y - y0) / max(1, (y1 - y0 - 1)) * (n - 1) + bias
        t = min(max(t, 0), n - 1 - 1e-6)
        i = int(t); f = t - i
        xs = np.arange(x0, x1)
        up = f > BAYER[y % 4][xs % 4]
        row = np.where(up[:, None], cols[i + 1], cols[i])
        arr[y, x0:x1] = row

def disc(d, cx, cy, r, c):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=c)

def save_png(img, name):
    p = os.path.join(OUT, name); img.save(p, optimize=True); return p

def save_jpg(img, name, q=82):
    p = os.path.join(OUT, name); img.save(p, quality=q, optimize=True, progressive=True); return p

def ncolors(img):
    return len(np.unique(np.array(img).reshape(-1, 3), axis=0))

# ---------- smooth value noise ----------
def vnoise(h, w, scale, seed=0):
    r = np.random.default_rng(seed)
    gh, gw = int(h / scale) + 3, int(w / scale) + 3
    g = r.random((gh, gw))
    img = Image.fromarray((g * 255).astype(np.uint8)).resize((gw * int(scale), gh * int(scale)), Image.BICUBIC)
    a = np.array(img, dtype=float)[:h, :w] / 255
    return a

# =====================================================================
# 1. Starry (pixel)  320x180
# =====================================================================
def starry():
    W, Hh = 320, 180
    arr = np.zeros((Hh, W, 3), np.uint8)
    sky = ['070b24', '0e1740', '15245a', '1f3578', '2d4c98', '4468b0', '6a8fc8', '9bb8dc']
    S = [np.array(H(c)) for c in sky]
    yy, xx = np.mgrid[0:Hh, 0:W].astype(float)
    swirls = [(150, 50, 1.0, 46), (222, 42, -0.9, 32), (88, 66, 0.7, 26)]
    base = 1.5 + yy / 150 * 2.2
    amp = np.full_like(base, 0.9)
    band = np.sin((yy + 7 * np.sin(xx / 17.0) + 4 * np.sin(xx / 7.0 + yy / 9)) / 2.6)
    # milky-way wave ribbon
    rib = np.exp(-(((yy - (70 + 18 * np.sin(xx / 38.0 + 0.5) - xx * 0.06)) / 9.0) ** 2))
    base += rib * 1.4
    amp += rib * 0.5
    for cx, cy, s, R in swirls:
        dx, dy = xx - cx, (yy - cy) * 1.15
        r = np.hypot(dx, dy); th = np.arctan2(dy, dx)
        infl = np.exp(-((r / R) ** 2))
        ph = r / 3.1 - s * th * 1.0 * 2
        b = np.sin(ph)
        band = band * (1 - infl) + b * infl
        base += infl * (2.6 * np.exp(-((r / (R * 0.4)) ** 2)) + 0.5)
        amp += infl * 0.9
    idx = base + amp * band * 1.1
    idx = idx + (BAYER[yy.astype(int) % 4, xx.astype(int) % 4] - 0.5) * 0.9
    idx = np.clip(np.floor(idx + 0.5), 0, len(S) - 1).astype(int)
    arr[:] = np.array(S)[idx]
    img = Image.fromarray(arr); d = ImageDraw.Draw(img)
    # moon (crescent)
    mc = (284, 30)
    disc(d, *mc, 11, H('c8861e')); disc(d, *mc, 9, H('f0c040')); disc(d, mc[0] - 5, mc[1] - 3, 8, H('2d4c98'))
    for rr, c in ((15, '9a6a22'), ):
        pass
    # stars with halos
    stars = [(24, 20), (66, 36), (112, 22), (176, 16), (252, 18), (238, 62), (130, 78), (70, 94), (190, 80), (300, 78), (20, 70)]
    halo = [H('f6e68a'), H('e8c64a'), H('d0a238'), H('9a8a50')]
    for sx, sy in stars:
        for k, rr in ((3, 7), (2, 5), (1, 3)):
            pass
        for r_, c in ((6, '5a6aa0'), (5, '8f8fa0'), (4, 'd0a238')):
            for a in range(0, 360, 20):
                px = sx + round(math.cos(math.radians(a)) * r_); py = sy + round(math.sin(math.radians(a)) * r_)
                if (px + py) % 2 == 0 and 0 <= px < W and 0 <= py < Hh:
                    img.putpixel((px, py), H(c))
        disc(d, sx, sy, 2, H('e8c64a')); d.rectangle([sx - 1, sy - 1, sx + 1, sy + 1], fill=H('fff4b0'))
        d.point((sx, sy), fill=H('ffffff'))
    # distant hills
    hills = []
    for x in range(W):
        yv = 126 + 6 * math.sin(x / 31.0) + 4 * math.sin(x / 13.0 + 1)
        hills.append(yv)
    d.polygon([(0, Hh)] + [(x, hills[x]) for x in range(W)] + [(W - 1, Hh)], fill=H('1d2f66'))
    for x in range(W):
        for k in range(3):
            y = int(hills[x]) + k * 3 + (x % 5 == 0)
            if (x + k) % 3 == 0 and y < Hh: img.putpixel((x, y), H('2d4c98'))
    # village ground
    gro = [140 + 4 * math.sin(x / 23.0 + 2) + 3 * math.sin(x / 9.0) for x in range(W)]
    d.polygon([(0, Hh)] + [(x, gro[x]) for x in range(W)] + [(W - 1, Hh)], fill=H('0c1230'))
    def house(x, y, w, h, roof=H('141a3c'), wall=H('1a2350'), lit=True):
        d.rectangle([x, y, x + w - 1, y + h - 1], fill=wall)
        d.polygon([(x - 1, y), (x + w // 2, y - max(3, w // 2)), (x + w, y)], fill=roof)
        if lit:
            for wx in range(x + 2, x + w - 2, 4):
                d.rectangle([wx, y + 2, wx + 1, y + 4], fill=H('f0c040' if (wx + y) % 3 else 'c28a3a'))
    for hx, hy, hw, hh in [(112, 140, 9, 9), (124, 142, 12, 8), (139, 139, 8, 10), (152, 141, 11, 9), (166, 143, 9, 7),
                           (196, 142, 12, 9), (212, 140, 9, 10), (226, 143, 13, 8), (244, 141, 9, 9), (258, 144, 11, 7),
                           (276, 142, 10, 9), (292, 144, 12, 8), (98, 144, 8, 7), (84, 146, 10, 7)]:
        house(hx, hy, hw, hh, lit=(hx % 3 != 0))
    # church spire
    d.rectangle([176, 138, 183, 160], fill=H('1a2350'))
    d.polygon([(175, 138), (180, 112), (184, 138)], fill=H('141a3c'))
    d.rectangle([179, 146, 180, 150], fill=H('f0c040'))
    d.line([(180, 106), (180, 112)], fill=H('141a3c'))
    d.rectangle([0, 158, W, Hh], fill=H('070a1c'))
    # lower ground dither
    for y in range(156, Hh):
        for x in range(W):
            if (x + y) % 2 == 0 and y < 162: img.putpixel((x, y), H('0c1230'))
    # cypress
    cy0, cy1 = 28, Hh
    cols = [H('040a08'), H('0a1a12'), H('15301f'), H('21452c')]
    for y in range(cy0, cy1):
        t = (y - cy0) / (cy1 - cy0)
        half = 3 + 15 * math.sin(min(1, t * 1.15) * math.pi * 0.62) ** 1.2 if t < 0.88 else 14 + (t - 0.88) * 30
        cx = 50 + 5 * math.sin(y / 11.0) * (1 - t * 0.4) + (1 - t) * -5
        half += 2.2 * math.sin(y / 3.7)
        d.line([(cx - half, y), (cx + half, y)], fill=cols[0])
    for i in range(520):
        y = int(rng.uniform(cy0 + 6, cy1 - 4)); t = (y - cy0) / (cy1 - cy0)
        cx = 50 + 5 * math.sin(y / 11.0) * (1 - t * 0.4) + (1 - t) * -5
        half = 3 + 15 * math.sin(min(1, t * 1.15) * math.pi * 0.62) ** 1.2 if t < 0.88 else 14
        x = cx + rng.uniform(-half * 0.8, half * 0.8)
        L = int(rng.integers(3, 8)); c = cols[int(rng.integers(1, 4))]
        for k in range(L):
            d.point((int(x + k * 0.7 * (1 if x > cx else -1) * 0.6), int(y - k)), fill=c)
    return img

# =====================================================================
# 3. Harbour sunrise (pixel) 320x180
# =====================================================================
def harbour():
    W, Hh = 320, 180
    arr = np.zeros((Hh, W, 3), np.uint8)
    hz = 96
    dither_grad(arr, 0, hz, ['5d7a9a', '7f98b0', 'a2b0bc', 'c4b8b0', 'e0b8a0', 'f0b890'])
    dither_grad(arr, hz, Hh, ['9aa4b0', '7a8aa0', '5a7090', '40587a', '2f4666', '24384f'])
    img = Image.fromarray(arr); d = ImageDraw.Draw(img)
    sx, sy = 205, 78
    # sun glow rings
    for r, c in ((26, 'e8b898'), (20, 'f0b080'), (15, 'f4a468')):
        for a in range(0, 360, 2):
            pass
    # dithered glow
    yy, xx = np.mgrid[0:hz, 0:W]
    rr = np.hypot(xx - sx, (yy - sy) * 1.1)
    glow = np.exp(-(rr / 30) ** 2)
    a2 = np.array(img)
    for y in range(hz):
        for x in range(W):
            if glow[y, x] > BAYER[y % 4, x % 4] * 0.9 + 0.05:
                a2[y, x] = H('f4c090')
    img = Image.fromarray(a2); d = ImageDraw.Draw(img)
    disc(d, sx, sy, 8, H('ff7a1a')); disc(d, sx, sy, 6, H('ff9428'))
    d.ellipse([sx - 3, sy - 4, sx + 1, sy], fill=H('ffb050'))
    # far ships/haze silhouettes
    hazec = H('7e8fa6')
    d.polygon([(0, hz), (0, 88), (22, 86), (30, 80), (31, 86), (60, 87), (70, 91), (90, hz)], fill=hazec)
    d.line([(30, 70), (30, 86)], fill=hazec); d.line([(36, 74), (36, 86)], fill=hazec)
    d.polygon([(240, hz), (246, 88), (270, 87), (275, 84), (276, 78), (277, 84), (300, 86), (320, 90), (320, hz)], fill=hazec)
    d.line([(262, 70), (262, 87)], fill=hazec); d.line([(268, 74), (268, 86)], fill=hazec)
    d.rectangle([300, 76, 302, 88], fill=hazec)
    # smoke / cloud strokes
    for x0, y0, L in ((60, 30, 40), (120, 20, 55), (235, 26, 50), (270, 44, 40), (30, 52, 36), (150, 44, 30)):
        for k in range(3):
            d.line([(x0 + k * 3, y0 + k * 4), (x0 + L - k * 5, y0 + k * 4)], fill=H('a2b0bc' if k % 2 == 0 else '8aa0b8'))
    # sun reflection broken strokes on water
    for y in range(hz + 2, Hh - 4, 2):
        t = (y - hz) / (Hh - hz)
        w = int(2 + 12 * (1 - t) * (0.6 + 0.4 * math.sin(y * 1.7)))
        n = 3 if t < 0.5 else 2
        for k in range(n):
            xo = int(sx + rng.integers(-w, w + 1) - 4 + 8 * math.sin(y * 0.9 + k))
            L = int(rng.integers(3, 8 + int(10 * (1 - t))))
            c = H('ff9a40') if t < 0.35 else (H('f0a870') if t < 0.65 else H('c88060'))
            d.line([(xo, y), (xo + L, y)], fill=c)
    # water ripple strokes
    for y in range(hz + 4, Hh, 3):
        for k in range(14):
            x = int(rng.integers(0, W)); L = int(rng.integers(3, 12))
            c = H('7a8aa0') if (y // 3) % 2 else H('40587a')
            d.line([(x, y), (x + L, y)], fill=c)
    # boats
    def boat(x, y, s=1, lean=0):
        hull = H('1c2c44'); d.polygon([(x, y), (x + 16 * s, y), (x + 13 * s, y + 3 * s), (x + 3 * s, y + 3 * s)], fill=hull)
        d.line([(x + 8 * s, y), (x + 8 * s + lean, y - 12 * s)], fill=hull)
        d.polygon([(x + 9 * s, y - 1), (x + 9 * s + lean, y - 11 * s), (x + 14 * s, y - 1)], fill=H('2a3c58'))
        for k in range(8 * s):
            if k % 2 == 0: d.point((x + 2 + k * 2, y + 4 * s), fill=H('2f4666'))
    boat(58, 128, 2, 1)
    boat(120, 112, 1, 0)
    boat(262, 120, 1, 1)
    d.polygon([(230, 150), (306, 150), (292, 158), (244, 158)], fill=H('17283c'))
    d.line([(268, 150), (268, 118)], fill=H('17283c')); d.line([(268, 122), (292, 148)], fill=H('17283c'))
    for k in range(10):
        d.line([(238 + k * 7, 160 + (k % 2)), (241 + k * 7, 160 + (k % 2))], fill=H('2f4666'))
    return img

# =====================================================================
# 5. Red Fuji (pixel) 320x180
# =====================================================================
def redfuji():
    W, Hh = 320, 180
    arr = np.zeros((Hh, W, 3), np.uint8)
    dither_grad(arr, 0, 150, ['1c4a7a', '2a5f94', '3e78aa', '5c92bc', '86b0cc', 'b0c8d4'])
    img = Image.fromarray(arr); d = ImageDraw.Draw(img)
    # mackerel clouds
    cc = [H('e8eef0'), H('c8dce4'), H('a8c4d4')]
    for row in range(16):
        y0 = 5 + row * 5
        dens = 0.85 * (1 - row / 17) ** 0.8
        for col in range(0, W, 6):
            if rng.random() > dens: continue
            xo = col + (row % 2) * 3 + int(rng.integers(-1, 2))
            yo = y0 + int(2 * math.sin(col / 23.0 + row * 0.5))
            w = int(rng.integers(3, 8))
            d.ellipse([xo, yo, xo + w, yo + 2], fill=cc[0 if (col // 6 + row) % 3 else 1])
            d.line([(xo + 1, yo + 3), (xo + w - 1, yo + 3)], fill=cc[2])
    # Fuji
    cx, top, base = 160, 52, 132
    def prof(y):  # half-width at y
        t = (y - top) / (base - top)
        return 8 + 130 * (t ** 1.55) if t >= 0 else 0
    red = [H('7a2a22'), H('9c3a2c'), H('b8482e'), H('d0603a')]
    for y in range(top, base + 1):
        hw = prof(y)
        x0, x1 = int(cx - hw), int(cx + hw)
        for x in range(x0, x1 + 1):
            u = (x - cx) / max(hw, 1)  # -1..1, light from left
            shade = 2.6 - (u + 1) * 1.3 + (math.sin(y * 0.9 + x * 0.12) * 0.25)
            shade += (BAYER[y % 4, x % 4] - 0.5) * 0.9
            k = int(min(3, max(0, round(shade))))
            img.putpixel((x, y), red[k])
    # snow cap with jagged runs
    for y in range(top, top + 22):
        hw = prof(y); lim = 6 + 2.0 * (y - top) * 0.55
        for x in range(int(cx - hw), int(cx + hw) + 1):
            edge = lim + 3.5 * math.sin(x * 0.55) + 2.5 * math.sin(x * 1.3 + y * .2)
            if (y - top) < edge * 0.9 and (y - top) < (hw * 0.9) and abs(x - cx) < hw:
                if y - top < edge * 0.9 - 2 or (x + y) % 2 == 0:
                    img.putpixel((x, y), H('f4f2ea') if x < cx + 6 else H('d8dcdc'))
    # snow gullies
    for gx in (-14, -6, 4, 12, 22):
        for y in range(top + 20, top + 40):
            x = int(cx + gx * (1 + (y - top - 20) * 0.04) + 0.3 * (y - top - 20) * (1 if gx > 0 else -1))
            img.putpixel((x, y), H('e8e4dc'))
    # dark streaks on slopes (Red Fuji tradition)
    for k in range(34):
        y = int(rng.integers(top + 30, base - 6)); hw = prof(y)
        x = int(cx + rng.uniform(-0.9, 0.9) * hw)
        L = int(rng.integers(5, 18))
        for j in range(L):
            xx = x + int(j * 0.1 * (x - cx) / max(hw, 1) * 3); yy = y + j
            if yy < base and abs(xx - cx) < prof(yy):
                img.putpixel((xx, yy), H('4a1a1c'))
    # foothills / forest
    ridge = [124 + 6 * math.sin(x / 19.0) + 5 * math.sin(x / 8.0 + 1) - 0.014 * abs(x - 160) ** 1.1 * -1 for x in range(W)]
    d.polygon([(0, Hh)] + [(x, ridge[x] + 3) for x in range(W)] + [(W - 1, Hh)], fill=H('1f3f3c'))
    for x in range(W):
        for y in range(int(ridge[x]) + 3, Hh):
            if y < ridge[x] + 12 and (x + y) % 2 == 0 and y - ridge[x] < 6:
                img.putpixel((x, y), H('2c5a4c'))
    d.polygon([(0, Hh)] + [(x, 148 + 4 * math.sin(x / 15.0 + 1) + 3 * math.sin(x / 6.0)) for x in range(W)] + [(W - 1, Hh)], fill=H('14302c'))
    for y in range(148, Hh):
        for x in range(0, W):
            if (x * 7 + y * 13) % 11 == 0: img.putpixel((x, y), H('1f3f3c'))
    d.rectangle([0, 168, W, Hh], fill=H('0e2220'))
    # pine tips
    for tx in range(6, W, 11):
        ty = int(150 + 4 * math.sin(tx / 15.0 + 1) + 3 * math.sin(tx / 6.0)) + int(rng.integers(0, 6))
        h_ = int(rng.integers(8, 14))
        d.polygon([(tx - 3, ty), (tx, ty - h_), (tx + 3, ty)], fill=H('0e2220'))
    # lake edge glimmer
    return img


def quant(arr, pal, amp=16):
    """Map float RGB array to palette with ordered dither."""
    pal = np.array([H(c) for c in pal], float)
    h, w, _ = arr.shape
    yy, xx = np.mgrid[0:h, 0:w]
    a = arr + (BAYER[yy % 4, xx % 4] - 0.5)[..., None] * amp
    dist = ((a[:, :, None, :] - pal[None, None]) ** 2).sum(-1)
    return Image.fromarray(pal[dist.argmin(-1)].astype(np.uint8))

# =====================================================================
# 6. Night city (pixel)
# =====================================================================
def city():
    W, Hh = 320, 180
    arr = np.zeros((Hh, W, 3), np.uint8)
    hz = 128
    dither_grad(arr, 0, hz, ['090c1e', '0f1530', '172042', '22305a', '35466e', '56608a', '8a7a9a'])
    arr[hz:hz + 10] = H('0c1124')
    img = Image.fromarray(arr); d = ImageDraw.Draw(img)
    for _ in range(46):
        x = int(rng.integers(0, W)); y = int(rng.integers(0, 70))
        img.putpixel((x, y), H('c8d0e8' if rng.random() < .3 else '6a76a0'))
    disc(d, 70, 30, 6, H('e8e4d0')); disc(d, 73, 28, 5, H('1a2548'))
    d.ellipse([64, 24, 76, 36], outline=None)
    img_moon = None
    # redraw moon as crescent properly
    disc(d, 70, 30, 6, H('e8e4d0')); disc(d, 74, 28, 5, H('141b3a'))
    def layer(base, hmin, hmax, wmin, wmax, wall, win_on, lit_p, seed, edge=None, win_off=None):
        r = np.random.default_rng(seed)
        wall = H(wall); edge = H(edge) if edge else None
        x = -4; items = []
        while x < W:
            w = int(r.integers(wmin, wmax)); h = int(r.integers(hmin, hmax))
            items.append((x, w, h)); x += w + int(r.integers(0, 3))
        for x, w, h in items:
            top = base - h
            d.rectangle([x, top, x + w - 1, base], fill=wall)
            if edge: d.line([(x, top), (x + w - 1, top)], fill=edge)
            if r.random() < .25: d.rectangle([x + w // 2 - 1, top - 4, x + w // 2, top], fill=wall)
            if r.random() < .2:
                d.line([(x + w // 2, top), (x + w // 2, top - 10)], fill=wall)
                if win_on and 0 <= x + w // 2 < W: img.putpixel((x + w // 2, top - 11), H('d04a3a'))
            if win_on:
                for wy in range(top + 3, base - 2, 4):
                    for wx in range(max(x + 2, 0), min(x + w - 2, W - 2), 3):
                        if r.random() < lit_p:
                            c = win_on[int(r.integers(0, len(win_on)))]
                            img.putpixel((wx, wy), H(c)); img.putpixel((wx + 1, wy), H(c))
                        elif win_off:
                            img.putpixel((wx, wy), H(win_off)); img.putpixel((wx + 1, wy), H(win_off))
        return items
    layer(hz + 2, 20, 62, 10, 22, '3a4670', None, 0, 11, edge='4a5882')
    layer(hz + 2, 14, 50, 9, 20, '222c4e', ['d8b060'], 0.07, 12, edge='2e3a62', win_off='2a3558')
    near = layer(hz + 6, 10, 44, 10, 24, '121830', ['f0c060', 'f0c060', 'e89a48', '9ad0d8'], 0.28, 13, edge='1c2442', win_off='18203c')
    # ground / river
    d.rectangle([0, hz + 6, W, Hh], fill=H('0c1124'))
    dither_grad(arr, 0, 0, ['000000', '000000'])
    water = np.array(img)
    for y in range(hz + 6, Hh):
        t = (y - hz - 6) / (Hh - hz - 6)
        for x in range(W):
            if (x * 3 + y * 5) % 17 == 0 and t < .9:
                water[y, x] = H('1a2444')
    img = Image.fromarray(water); d = ImageDraw.Draw(img)
    # reflections of lights (broken vertical dashes)
    for _ in range(95):
        x = int(rng.integers(0, W)); y = int(rng.integers(hz + 10, Hh - 2))
        L = int(rng.integers(1, 4))
        c = H(['f0c060', 'e89a48', '9ad0d8', '6a76a0'][int(rng.integers(0, 4))])
        if rng.random() < .55: d.line([(x, y), (x + L, y)], fill=c)
    # embankment railing + lamps
    d.line([(0, hz + 10), (W, hz + 10)], fill=H('2a3558'))
    for lx in range(14, W, 52):
        d.line([(lx, hz + 10), (lx, hz - 4)], fill=H('1a2240'))
        d.rectangle([lx - 1, hz - 6, lx + 1, hz - 4], fill=H('f0d080'))
        for k in range(1, 5):
            for dx in (-k, k):
                if (k + dx) % 2 == 0: img.putpixel((lx + dx, hz - 3 + k * 2), H('4a4a5a'))
    # bridge far right
    for bx in range(190, 320, 10):
        d.line([(bx, hz - 3), (bx + 5, hz - 7)], fill=H('2e3a62'))
    return img

# =====================================================================
# 8. Rain on window at dusk (pixel)
# =====================================================================
def rain():
    W, Hh = 320, 180
    yy, xx = np.mgrid[0:Hh, 0:W].astype(float)
    # dusk sky gradient float
    t = np.clip(yy / 120, 0, 1)[..., None]
    top = np.array(H('1a1e44'), float); mid = np.array(H('5a3c78'), float); hor = np.array(H('d88a6a'), float)
    bg = np.where(t < .6, top + (mid - top) * (t / .6), mid + (hor - mid) * ((t - .6) / .4))
    bg = np.where(yy[..., None] > 118, np.array(H('2a2040'), float), bg)
    # blurred city silhouette
    im = Image.fromarray(np.clip(bg, 0, 255).astype(np.uint8)); d = ImageDraw.Draw(im)
    x = 0
    while x < W:
        w = int(rng.integers(10, 26)); h = int(rng.integers(16, 58))
        d.rectangle([x, 118 - h, x + w, 180], fill=H('221a3a')); x += w + int(rng.integers(0, 4))
    # bokeh lights
    glow = np.zeros((Hh, W, 3), float)
    lights = []
    for _ in range(46):
        lx = rng.uniform(0, W); ly = rng.uniform(78, 150); r = rng.uniform(3, 8)
        c = [(255, 190, 110), (255, 150, 90), (140, 200, 230), (240, 120, 130), (255, 220, 150)][int(rng.integers(0, 5))]
        lights.append((lx, ly, r, c))
    g = np.array(im, float)
    for lx, ly, r, c in lights:
        m = np.exp(-(((xx - lx) ** 2 + (yy - ly) ** 2) / (r * r)) ** 1.6)
        g += m[..., None] * np.array(c) * 0.55
    g = np.clip(g, 0, 255)
    pal = ['0e1030', '161a40', '1e2250', '2a2858', '36305e', '463a68', '5a4474', '70507a', '8a6078', 'a87078',
           'c88a78', 'e0a078', 'f0c088', 'f8dca0', '8cb4d0', 'c8e0ec', 'f09088', '221a3a', '2a2040']
    img = quant(g, pal, amp=22)
    d = ImageDraw.Draw(img)
    # window frame
    fr, fr2 = H('0c0c18'), H('1a1a2c')
    d.rectangle([0, 0, 7, Hh], fill=fr); d.rectangle([W - 8, 0, W, Hh], fill=fr)
    d.rectangle([0, 0, W, 5], fill=fr); d.rectangle([0, 164, W, Hh], fill=fr)
    d.rectangle([158, 0, 162, Hh], fill=fr); d.line([(163, 0), (163, Hh)], fill=fr2); d.line([(7, 6), (7, 163)], fill=fr2)
    d.rectangle([0, 170, W, Hh], fill=H('06060e')); d.line([(0, 164), (W, 164)], fill=fr2)
    # fog condensation lower glass
    for y in range(120, 164):
        for x in range(8, W - 8):
            if BAYER[y % 4, x % 4] < (y - 120) / 44 * 0.28 and not (158 <= x <= 163):
                img.putpixel((x, y), H('70507a' if (x + y) % 2 else '5a4474'))
    # rain streaks
    for _ in range(140):
        x = int(rng.integers(8, W - 8)); y = int(rng.integers(6, 150)); L = int(rng.integers(8, 26))
        for k in range(L):
            xx_, yy_ = x + k // 9, y + k
            if 8 <= xx_ < W - 8 and 6 <= yy_ < 164 and not (158 <= xx_ <= 163):
                if k % 2 == 0: img.putpixel((xx_, yy_), H('8a6078' if rng.random() < .5 else '8cb4d0'))
    # drops
    for _ in range(95):
        x = int(rng.integers(10, W - 10)); y = int(rng.integers(8, 160))
        if 156 <= x <= 165: continue
        sz = int(rng.integers(1, 3))
        d.ellipse([x, y, x + sz + 1, y + sz + 2], fill=H('1e2250'))
        img.putpixel((x, y + 1), H('f8dca0')); 
        if sz == 2: img.putpixel((x + 1, y), H('c8e0ec'))
        img.putpixel((x + sz, y + sz + 2), H('f0c088'))
        if rng.random() < .35:
            L = int(rng.integers(5, 18))
            for k in range(L):
                if y + sz + 3 + k < 164: img.putpixel((x + 1, y + sz + 3 + k), H('463a68' if k % 2 else '5a4474'))
    return img


# =====================================================================
# print-style helpers
# =====================================================================
class Print:
    def __init__(self, paper, w=1600, h=900, ss=2, seed=1, tex=0.035):
        self.w, self.h, self.ss = w, h, ss
        r = np.random.default_rng(seed); self.r = r
        base = np.array(paper, float)
        n = vnoise(h, w, 90, seed) * 0.6 + vnoise(h, w, 24, seed + 1) * 0.4
        fine = np.array(Image.fromarray((r.random((h // 2, w // 2)) * 255).astype(np.uint8)).resize((w, h), Image.BILINEAR), float) / 255
        self.tex = ((n - .5) * 0.9 + (fine - .5) * 0.8) * tex * 255 / 8
        self.arr = np.ones((h, w, 3)) * base
        self.arr += (n - .5)[..., None] * 10 + (fine - .5)[..., None] * 7
        self.fine = fine; self.n = n
        self.grain_i = np.array(Image.fromarray((r.random((h // 2, w // 2)) * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC), float) / 255
        self.hole = np.array(Image.fromarray((r.random((h // 2, w // 2)) * 255).astype(np.uint8)).resize((w, h), Image.NEAREST), float) / 255
    def newmask(self):
        im = Image.new('L', (self.w * self.ss, self.h * self.ss), 0)
        return im, SD(ImageDraw.Draw(im), self.ss)
    def ink(self, mask_im, col, alpha=1.0, grain=0.14, holes=0.012, mode='over', off=(0, 0)):
        m = np.array(mask_im.resize((self.w, self.h), Image.BOX), float) / 255
        if off != (0, 0):
            m = np.roll(m, (off[1], off[0]), (0, 1))
        a = m * alpha * (1 - grain * self.grain_i * 1.4 - 0.02)
        a *= np.where(self.hole < holes, 0.35, 1.0) if holes else 1
        col = np.array(col, float)
        if mode == 'over':
            self.arr = self.arr * (1 - a[..., None]) + col * a[..., None]
        else:  # multiply ('mul')
            self.arr = self.arr * (1 - a[..., None] * (1 - col / 255))
    def finish(self, extra=0):
        a = np.clip(self.arr, 0, 255).astype(np.uint8)
        return Image.fromarray(a)

class SD:
    def __init__(self, d, ss): self.d, self.ss = d, ss
    def P(self, pts): return [(x * self.ss, y * self.ss) for x, y in pts]
    def poly(self, pts, v=255): self.d.polygon(self.P(pts), fill=v)
    def line(self, pts, w=3, v=255):
        pp = self.P(pts); self.d.line(pp, fill=v, width=max(1, int(w * self.ss)), joint='curve')
        r = w * self.ss / 2
        for x, y in (pp[0], pp[-1]): self.d.ellipse([x - r, y - r, x + r, y + r], fill=v)
    def circle(self, x, y, r, v=255):
        s = self.ss; self.d.ellipse([(x - r) * s, (y - r) * s, (x + r) * s, (y + r) * s], fill=v)
    def ellipse(self, x, y, rx, ry, v=255):
        s = self.ss; self.d.ellipse([(x - rx) * s, (y - ry) * s, (x + rx) * s, (y + ry) * s], fill=v)
    def rect(self, x0, y0, x1, y1, v=255):
        s = self.ss; self.d.rectangle([x0 * s, y0 * s, x1 * s, y1 * s], fill=v)

def catmull(pts, n=14, closed=False):
    pts = [np.array(p, float) for p in pts]
    if closed: pts = pts[-1:] + pts + pts[:2]
    else: pts = [pts[0]] + pts + [pts[-1]]
    out = []
    for i in range(1, len(pts) - 2):
        p0, p1, p2, p3 = pts[i - 1], pts[i], pts[i + 1], pts[i + 2]
        for t in np.linspace(0, 1, n, endpoint=False):
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    if not closed: out.append(pts[-2])
    return [tuple(p) for p in out]

def claw(sd, x, y, a0, length, width, curl, v=255, n=40):
    """tapered curling finger. a0 degrees (screen coords), curl = total turn in degrees (+ = clockwise)."""
    L, R = [], []; px, py = x, y; step = length / n
    for i in range(n + 1):
        t = i / n
        a = math.radians(a0 + curl * t ** 1.4)
        w = width * (1 - t) ** 0.8 * (1 + 0.5 * math.sin(t * math.pi)) / 2
        nx, ny = -math.sin(a), math.cos(a)
        L.append((px + nx * w, py + ny * w)); R.append((px - nx * w, py - ny * w))
        px += math.cos(a) * step; py += math.sin(a) * step
    sd.poly(L + R[::-1], v)
    return px, py

def blur_mask(im, r): return im.filter(ImageFilter.GaussianBlur(r))

# =====================================================================
# 2. Great Wave (woodblock) 1600x900
# =====================================================================
def wave():
    P = Print((232, 222, 196), seed=3)
    INK = (22, 44, 86); MID = (58, 100, 146); PALE = (166, 192, 196); RED = (176, 62, 44)
    r = P.r
    # sky bokashi: pale blue band at top fading, + cloud strips
    yy = np.linspace(0, 1, P.h)[:, None] * np.ones((1, P.w))
    sky = np.clip(1 - yy / 0.55, 0, 1) ** 1.6
    P.arr = P.arr * (1 - sky[..., None] * 0.55) + np.array(PALE) * sky[..., None] * 0.55
    im, d = P.newmask()
    for k in range(7):
        y = 70 + k * 36
        for j in range(5):
            x0 = r.uniform(-100, 1500); L = r.uniform(180, 520)
            d.line([(x0, y + 8 * math.sin(j + k)), (x0 + L, y + 6 * math.sin(j * 1.7 + k))], w=r.uniform(4, 11), v=int(r.uniform(90, 170)))
    P.ink(im, PALE, alpha=.7)
    # Fuji (small) behind
    im, d = P.newmask()
    fx, fy = 1050, 604
    d.poly([(fx - 190, fy + 6)] + catmull([(fx - 150, fy - 10), (fx - 80, fy - 62), (fx - 30, fy - 110), (fx - 10, fy - 128), (fx + 12, fy - 128), (fx + 34, fy - 112), (fx + 90, fy - 62), (fx + 160, fy - 8)], 8) + [(fx + 190, fy + 6)])
    P.ink(im, MID)
    im, d = P.newmask()   # snow cap
    cap = [(fx - 62, fy - 82), (fx - 40, fy - 92), (fx - 26, fy - 78), (fx - 12, fy - 92), (fx + 2, fy - 76), (fx + 18, fy - 90), (fx + 30, fy - 78), (fx + 52, fy - 88), (fx + 72, fy - 70),
           (fx + 90, fy - 62), (fx + 34, fy - 112), (fx + 12, fy - 128), (fx - 10, fy - 128), (fx - 30, fy - 110)]
    d.poly(cap)
    P.ink(im, (240, 234, 216), alpha=1)
    im, d = P.newmask()
    for i in range(7): d.line([(fx - 120 + i * 40, fy), (fx - 80 + i * 40, fy - 20)], w=3)
    P.ink(im, PALE, alpha=.8)
    # sea base
    im, d = P.newmask()
    d.poly([(0, 640), (500, 620)] + [(x, 620 + 8 * math.sin(x / 70)) for x in range(500, 1650, 40)] + [(1600, 900), (0, 900)])
    P.ink(im, MID)
    # sea rows: scalloped indigo lines
    im, d = P.newmask()
    for row in range(14):
        y = 650 + row * 20 + (row ** 1.3) * 2
        amp = 5 + row * 0.9; per = 55 + row * 8
        pts = [(x, y + amp * math.sin(x / per * 2 * math.pi + row * 1.3) * (0.6 + 0.4 * math.sin(x / 200 + row))) for x in range(-20, 1640, 12)]
        d.line(pts, w=2 + row * 0.25)
    P.ink(im, INK, alpha=.85)
    im, d = P.newmask()
    for row in range(10):
        y = 676 + row * 24
        pts = [(x, y + 6 * math.sin(x / 40 + row * 2.2) + 3) for x in range(-20, 1640, 12)]
        d.line(pts, w=3)
    P.ink(im, PALE, alpha=.55)
    # ---------------- the big wave ----------------
    back = catmull([(-20, 600), (60, 560), (170, 470), (270, 360), (340, 270), (410, 190), (480, 140), (560, 108), (650, 106), (730, 138), (792, 190), (840, 258)], 16)
    under = catmull([(840, 258), (792, 292), (732, 288), (672, 278), (622, 292), (586, 340), (570, 410), (574, 490), (594, 562), (612, 630)], 16)
    body = back + under[1:] + [(612, 650), (-400, 650), (-400, 600)]
    im, d = P.newmask(); d.poly(body); body_m = im.copy()
    P.ink(im, MID)
    hollow = under + catmull([(612, 630), (650, 580), (700, 520), (750, 450), (795, 370), (825, 310), (840, 258)], 12)[1:]
    im, d = P.newmask(); d.poly(hollow); hm = im.copy()
    P.ink(im, INK)
    im, d = P.newmask()
    for k in range(8):
        pts = catmull([(806 - k * 9, 296 + k * 8), (750 - k * 8, 322 + k * 12), (690 - k * 7, 360 + k * 14), (650 - k * 6, 430 + k * 14), (632 - k * 4, 510 + k * 10), (630, 590)], 10)
        d.line(pts, w=2 + (k % 3), v=255)
    P.ink(Image.composite(im, Image.new('L', im.size, 0), hm), MID, alpha=.85)
    bm = np.array(body_m.resize((P.w // 2, P.h // 2), Image.BOX).filter(ImageFilter.GaussianBlur(30)), float) / 255
    hmm = np.array(hm.resize((P.w // 2, P.h // 2))) > 0
    for lv in (0.22, 0.30, 0.38, 0.46):
        band = (np.abs(bm - lv) < 0.0075).astype(np.uint8) * 255
        band[hmm] = 0
        band[int(P.h / 2 * 0.62):] = 0
        im = Image.fromarray(band).resize((P.w * P.ss, P.h * P.ss), Image.BILINEAR)
        P.ink(im, INK, alpha=.7)
    # fine hatch strokes on the back of the wave following the wave direction
    im, d = P.newmask()
    for k in range(70):
        x = r.uniform(40, 520); y = 300 + (x - 40) * 0.55 * 0 + r.uniform(0, 280)
        if y < 600 and not (x > 400 and y < 300):
            d.line([(x, y), (x + r.uniform(30, 80), y - r.uniform(14, 40))], w=r.uniform(2, 3.5))
    P.ink(Image.composite(im, Image.new('L', im.size, 0), body_m), INK, alpha=.5)
    # foam: crest lip band
    lipc = catmull([(300, 292), (355, 220), (420, 164), (490, 126), (565, 104), (650, 104), (730, 136), (790, 188), (840, 256)], 20)
    im, d = P.newmask()
    up = []; lo = []
    for i, (x, y) in enumerate(lipc):
        t = i / (len(lipc) - 1)
        w = 22 + 34 * math.sin(math.pi * min(1, t * 1.05)) ** .8 + 10 * math.sin(i * 0.9)
        up.append((x - 3, y - 6)); lo.append((x + w * 0.55, y + w))
    d.poly(up + lo[::-1])
    for i in range(0, len(lipc), 4):
        x, y = lipc[i]
        d.ellipse(x + 10, y + 34 + 8 * math.sin(i), 20 + 6 * (i % 3), 17 + 5 * (i % 2))
    fingers = [(405, 178, 40), (455, 146, 38), (510, 122, 32), (570, 108, 28), (632, 106, 26), (690, 120, 30), (742, 150, 36), (790, 192, 42), (830, 240, 50)]
    for k, (fx_, fy_, a0) in enumerate(fingers):
        claw(d, fx_, fy_ + 30, a0 + 15, 120 + 20 * math.sin(k * 1.7), 34, 105 + 15 * (k % 2))
    for fx_, fy_ in [(380, 215), (330, 262)]:
        claw(d, fx_, fy_ + 14, 60, 70, 24, 80)
    P.ink(im, (240, 234, 216))
    # foam outline in indigo (thin) via edge of mask
    arr = np.array(im.resize((P.w, P.h), Image.BOX), float) / 255
    ed = np.array(Image.fromarray((arr * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2.2)), float) / 255
    edge = np.clip(1 - np.abs(ed - 0.5) * 6, 0, 1) * (arr > 0.0)
    ew = Image.fromarray((np.clip(1 - np.abs(ed - 0.5) * 7, 0, 1) * 255).astype(np.uint8)).resize((P.w * P.ss, P.h * P.ss), Image.BILINEAR)
    P.ink(ew, INK, alpha=.9)
    # spray dots
    im, d = P.newmask()
    for _ in range(190):
        a = r.uniform(0, 1); i = int(a * (len(lipc) - 1)); x, y = lipc[i]
        dist = r.uniform(30, 150) * (0.5 + a * .8); ang = r.uniform(-0.4, 1.6)
        sx, sy = x + dist * math.cos(ang) * 1.2, y + dist * math.sin(ang) * 0.9 + 25
        rr = r.uniform(1.5, 5.5) * (1.2 - dist / 220)
        if rr > 1: d.circle(sx, sy, rr)
    P.ink(im, (240, 234, 216))
    # body outline
    im, d = P.newmask()
    d.line(back, w=5); d.line(under, w=5)
    P.ink(im, INK)
    # foam on sea: right-hand secondary wave
    im, d = P.newmask()
    sec = catmull([(1110, 660), (1200, 610), (1250, 600), (1330, 560), (1410, 548), (1490, 566), (1560, 600), (1620, 640)], 14)
    d.poly(sec + [(1620, 760), (1110, 760)])
    P.ink(im, MID)
    im2, d2 = P.newmask(); d2.line(sec, w=5); P.ink(im2, INK)
    im, d = P.newmask()
    for i in range(0, len(sec) - 1, 3):
        x, y = sec[i]; d.circle(x + 6, y + 10, 8 + 3 * (i % 3))
        if i % 2 == 0: claw(d, x + 4, y + 4, 30, 40, 16, 120)
    P.ink(im, (240, 234, 216))
    # re-lay sea lines over the secondary wave's lower part
    im, d = P.newmask()
    for row in range(14):
        y = 650 + row * 20 + (row ** 1.3) * 2
        amp = 5 + row * 0.9; per = 55 + row * 8
        d.line([(x, y + amp * math.sin(x / per * 2 * math.pi + row * 1.3) * (0.6 + 0.4 * math.sin(x / 200 + row))) for x in range(1080, 1640, 12)], w=2 + row * 0.25)
    im.paste(0, (0, 0, im.width, 700 * P.ss))
    P.ink(im, INK, alpha=.85)
    im, d = P.newmask()
    for row in range(10):
        y = 676 + row * 24
        d.line([(x, y + 6 * math.sin(x / 40 + row * 2.2) + 3) for x in range(1080, 1640, 12)], w=3)
    im.paste(0, (0, 0, im.width, 700 * P.ss))
    P.ink(im, PALE, alpha=.55)
    # small boat in trough
    im, d = P.newmask()
    bx, by = 850, 612
    if False: d.poly(catmull([(bx - 70, by - 6), (bx - 20, by + 12), (bx + 40, by + 8), (bx + 80, by - 10)], 8) + [(bx + 70, by - 18), (bx - 60, by - 16)])
    P.ink(im, INK)
    # seal
    im, d = P.newmask()
    d.rect(1470, 70, 1506, 130); P.ink(im, RED, alpha=.9)
    im, d = P.newmask()
    d.rect(1480, 80, 1496, 86, 255); d.rect(1480, 96, 1496, 102, 255); d.rect(1486, 80, 1490, 120, 255)
    P.ink(im, (232, 222, 196), alpha=.9)
    # title cartouche (blank block)
    im, d = P.newmask()
    d.rect(60, 60, 180, 220); P.ink(im, (226, 214, 184), alpha=.0)
    return P.finish()

REG_WAVE = wave

# =====================================================================
# 4. Wanderer above the fog (linocut) 1600x900
# =====================================================================
def wanderer():
    P = Print((224, 216, 196), seed=5)
    INK = (22, 26, 34); SLATE = (104, 122, 138)
    r = P.r
    def fogy(x): return 548 + 16 * math.sin(x / 95.0) + 9 * math.sin(x / 33.0 + 1) + 0.012 * (x - 800) ** 2 / 100
    # sky: carved horizontal lines, thick at top fading toward horizon
    im, d = P.newmask()
    y = 0
    while y < 580:
        t = min(y / 560, 1.0)
        th = 15 * (1 - t) ** 1.1 + 1.2
        sp = 22
        x = -20
        while x < 1640:
            L = r.uniform(120, 420)
            if r.random() < 0.08 + 0.3 * t: x += L * 0.4; continue
            pts = [(xx, y + 2.5 * math.sin(xx / 70.0 + y * .3)) for xx in np.arange(x, x + L, 20)]
            glow = math.exp(-(((x + L / 2 - 1010) / 380) ** 2) - (((y - 470) / 160) ** 2))
            ww = th * (1 - 0.8 * glow)
            if ww > 0.8: d.line(pts, w=ww)
            x += L + r.uniform(4, 30)
        y += sp
    clip, cd = P.newmask()
    cd.poly([(-10, -10), (1610, -10)] + [(x, fogy(x)) for x in range(1610, -20, -20)])
    sky = Image.composite(im, Image.new('L', im.size, 0), clip)
    P.ink(sky, INK, holes=.012, grain=.08)
    # sun disc glimmer (paper) + ray lines already by glow
    # distant mountains (slate)
    def mountain(cx, base, w, h, seed, jag=14):
        rr = np.random.default_rng(seed)
        pts = [(cx - w, base)]
        n = 14
        for k in range(1, n):
            u = k / n; hh = h * (1 - abs(2 * u - 1) ** 1.25)
            pts.append((cx - w + 2 * w * u, base - hh + rr.uniform(-jag, jag) * (1 - abs(2 * u - 1))))
        pts.append((cx + w, base)); return pts
    im, d = P.newmask()
    for cx, bs, w, h, sd in [(1380, 600, 330, 190, 1), (1010, 600, 240, 120, 2), (1540, 600, 200, 250, 3), (150, 600, 300, 120, 4), (420, 600, 190, 80, 5)]:
        d.poly(mountain(cx, bs, w, h, sd))
    P.ink(im, SLATE)
    im2, d2 = P.newmask()   # hatch on right-facing sides
    for cx, bs, w, h, sd in [(1380, 600, 330, 190, 1), (1540, 600, 200, 250, 3), (150, 600, 300, 120, 4)]:
        for k in range(26):
            x0 = cx + r.uniform(-w * .1, w * .8); y0 = bs - r.uniform(10, h * .75)
            d2.line([(x0, y0), (x0 + 30, y0 + 18)], w=2.5)
    P.ink(Image.composite(im2, Image.new('L', im2.size, 0), im), INK, alpha=.55)
    # fog: paper wash covering lower mountains + billow lines
    im, d = P.newmask()
    d.poly([(x, fogy(x) + 40 + 14 * math.sin(x / 60.0)) for x in range(-20, 1640, 20)] + [(1640, 900), (-20, 900)])
    P.ink(im, (226, 218, 198), alpha=1.0, grain=0, holes=0)
    im, d = P.newmask()
    for k in range(16):
        y0 = 600 + k * 20 + k * k * 1.2
        for seg in range(7):
            xs = r.uniform(-100, 1500); L = r.uniform(160, 460)
            pts = [(xx, y0 + (7 + k * .8) * math.sin(xx / (60 + k * 6.0) + k * 1.7 + seg)) for xx in np.arange(xs, xs + L, 14)]
            d.line(pts, w=2 + k * 0.28)
    P.ink(im, SLATE, alpha=.85)
    # fog-island pinnacles
    im, d = P.newmask()
    for cx, bs, w, h, sd in [(1180, 640, 120, 70, 8), (1360, 650, 90, 54, 9), (300, 640, 130, 80, 10), (900, 660, 90, 36, 11)]:
        d.poly(mountain(cx, bs, w, h, sd, jag=6))
    P.ink(im, INK, holes=.02)
    # paper fog veil around base of pinnacles
    im, d = P.newmask()
    for cx, by in [(1180, 650), (1360, 656), (300, 650), (900, 664)]:
        for k in range(6): d.ellipse(cx + (k - 3) * 36, by + 8 * (k % 2), 60, 11)
    P.ink(im, (226, 218, 198), grain=0, holes=0)
    # foreground rock (ink) with carved cracks
    rock = catmull([(-20, 880), (-20, 700), (120, 700), (250, 690), (340, 660), (420, 640), (520, 625), (600, 612), (680, 604), (760, 616), (840, 640), (900, 690), (940, 760), (1000, 900)], 10)
    im, d = P.newmask(); d.poly(rock + [(1000, 920), (-20, 920)])
    P.ink(im, INK, holes=.015, grain=.08)
    rm = im.copy()
    im, d = P.newmask()
    for k in range(60):
        x0 = r.uniform(60, 960); y0 = r.uniform(700, 900)
        ln = r.uniform(30, 90); a = r.uniform(-0.5, 0.35) + (0.35 if x0 > 600 else 0)
        d.line([(x0, y0), (x0 + ln * math.cos(a), y0 + ln * math.sin(a) * 0.5), (x0 + ln * 1.5, y0 + ln * .3 + r.uniform(-8, 8))], w=r.uniform(2, 4.5))
    for k in range(18):
        x0 = r.uniform(340, 820); y0 = 618 + r.uniform(8, 60)
        d.line([(x0, y0), (x0 + r.uniform(30, 70), y0 + r.uniform(-6, 6))], w=r.uniform(2, 3.5))
    P.ink(Image.composite(im, Image.new('L', im.size, 0), rm), (224, 216, 196), alpha=.8, holes=0)
    # figure standing on the rock, seen from behind
    im, d = P.newmask()
    fx, fy = 640, 608   # feet
    d.poly(catmull([(fx - 26, fy), (fx - 24, fy - 70), (fx - 30, fy - 120), (fx - 26, fy - 168), (fx - 20, fy - 196), (fx - 12, fy - 214), (fx, fy - 218), (fx + 12, fy - 214), (fx + 20, fy - 196), (fx + 26, fy - 168), (fx + 28, fy - 120), (fx + 26, fy - 70), (fx + 24, fy)], 10))
    # coat flare
    d.poly([(fx - 34, fy - 2), (fx - 26, fy - 100), (fx + 26, fy - 100), (fx + 36, fy - 2)])
    # head + hair swept
    d.circle(fx, fy - 232, 15)
    d.poly(catmull([(fx - 17, fy - 232), (fx - 16, fy - 250), (fx - 4, fy - 260), (fx + 12, fy - 258), (fx + 19, fy - 246), (fx + 20, fy - 232)], 8))
    d.rect(fx - 8, fy - 222, fx + 8, fy - 205)
    # shoulders / arm with cane
    d.poly([(fx - 28, fy - 196), (fx + 28, fy - 196), (fx + 34, fy - 150), (fx - 34, fy - 150)])
    d.poly([(fx + 24, fy - 190), (fx + 46, fy - 150), (fx + 62, fy - 132), (fx + 54, fy - 124), (fx + 36, fy - 140), (fx + 20, fy - 160)])
    d.line([(fx + 58, fy - 130), (fx + 66, fy + 8)], w=5)
    d.line([(fx + 62, fy - 124), (fx + 70, fy + 12)], w=0)
    # legs
    d.rect(fx - 22, fy - 10, fx - 4, fy + 6); d.rect(fx + 4, fy - 10, fx + 22, fy + 6)
    P.ink(im, INK, holes=0, grain=0.05)
    # highlight line on coat (carved)
    im, d = P.newmask()
    d.line([(fx - 12, fy - 180), (fx - 16, fy - 110), (fx - 20, fy - 40)], w=2.5)
    d.line([(fx + 12, fy - 150), (fx + 14, fy - 80)], w=2)
    P.ink(im, (224, 216, 196), alpha=.5, holes=0)
    return P.finish().filter(ImageFilter.GaussianBlur(0.9))

# =====================================================================
# 7. Listening room (linocut) 1600x900
# =====================================================================
def room():
    P = Print((222, 212, 190), seed=9)
    INK = (28, 24, 26); WARM = (196, 120, 62); SLATE = (90, 104, 116)
    r = P.r
    # wall (warm tone) and floor
    im, d = P.newmask(); d.rect(0, 0, 1600, 640); P.ink(im, (214, 196, 160), alpha=.55, grain=.2)
    # carved horizontal wall lines
    im, d = P.newmask()
    for y in range(20, 640, 22):
        x = -20
        while x < 1620:
            L = r.uniform(200, 600)
            d.line([(x, y + 1.5 * math.sin(x / 90.0)), (x + L, y + 1.5 * math.sin((x + L) / 90.0))], w=1.8)
            x += L + r.uniform(10, 50)
    P.ink(im, INK, alpha=.35, holes=.02)
    # floor planks in perspective
    im, d = P.newmask(); d.rect(0, 640, 1600, 900); P.ink(im, INK, alpha=.88, holes=.02)
    im, d = P.newmask()
    vx, vy = 800, 180
    for k in range(-14, 15):
        xb = 800 + k * 150
        d.line([(vx + (xb - vx) * 0.0 + (xb - vx) * (640 - vy) / (900 - vy), 640), (xb, 900)], w=2.5)
    for k in range(5):
        y = 640 + (k + 1) ** 1.9 * 11
        d.line([(0, y), (1600, y)], w=2.2)
    P.ink(im, (222, 212, 190), alpha=.5, holes=0)
    # rug (warm, centered under turntable area)
    im, d = P.newmask(); d.poly([(520, 760), (1080, 760), (1180, 870), (420, 870)]); P.ink(im, WARM, alpha=.85)
    im, d = P.newmask()
    for k in range(7): d.line([(520 - k * 14 + 40, 770 + k * 14), (1080 + k * 14 - 40, 770 + k * 14)], w=2.5)
    P.ink(im, (222, 212, 190), alpha=.8, holes=0)
    # window / lamp glow on the wall: arched window at far left
    # speakers
    def speaker(cx, base, flip=1):
        w, h = 190, 400
        x0, x1, y0 = cx - w / 2, cx + w / 2, base - h
        im, d = P.newmask()
        d.rect(x0, y0, x1, base)
        P.ink(im, INK, holes=.02)
        im, d = P.newmask()
        d.rect(x0 + 8, y0 + 8, x1 - 8, base - 8)       # baffle slightly lighter outline
        P.ink(im, (60, 52, 50), alpha=.9)
        im, d = P.newmask()
        d.circle(cx, y0 + 110, 38); d.circle(cx, y0 + 270, 62)
        P.ink(im, (222, 212, 190))
        im, d = P.newmask()
        d.circle(cx, y0 + 110, 28); d.circle(cx, y0 + 270, 46)
        P.ink(im, INK)
        im, d = P.newmask()
        d.circle(cx, y0 + 110, 12); d.circle(cx, y0 + 270, 18)
        P.ink(im, (222, 212, 190), alpha=.8)
        im, d = P.newmask()
        for k in range(1, 7): d.line([(cx - 36 + k * 3, y0 + 270 - 46 + k * 12), (cx + 36 - k * 3, y0 + 270 - 46 + k * 12)], w=1.5)
        # corner highlights
        d.line([(x0 + 14, y0 + 14), (x0 + 14, base - 14)], w=2)
        P.ink(im, (222, 212, 190), alpha=.4, holes=0)
        # stand feet + shadow
        im, d = P.newmask(); d.poly([(x0 + 10, base), (x1 - 10, base), (x1 + 40, base + 24), (x0 + 40, base + 24)]); P.ink(im, INK, alpha=.7)
    speaker(250, 700); speaker(1350, 700)
    # low sideboard + turntable
    im, d = P.newmask(); d.rect(560, 640, 1040, 700); d.rect(572, 700, 600, 770); d.rect(1000, 700, 1028, 770); P.ink(im, INK, holes=.02)
    im, d = P.newmask(); d.rect(566, 646, 1034, 652); P.ink(im, (222, 212, 190), alpha=.5, holes=0)
    im, d = P.newmask()
    d.rect(590, 574, 1010, 642)       # plinth
    P.ink(im, (74, 54, 44), holes=.02)
    im, d = P.newmask(); d.ellipse(790, 598, 130, 24); P.ink(im, INK)
    im, d = P.newmask(); d.ellipse(790, 592, 118, 20); P.ink(im, (222, 212, 190), alpha=.95)
    im, d = P.newmask(); d.ellipse(790, 592, 104, 17); P.ink(im, INK)
    im, d = P.newmask()
    for k in range(4): d.ellipse(790, 592, 88 - k * 16, 14 - k * 2.6, 255 if k % 2 == 0 else 0)
    P.ink(im, (60, 56, 56), alpha=.9, holes=0)
    im, d = P.newmask(); d.ellipse(790, 592, 22, 4); P.ink(im, WARM)
    # tonearm
    im, d = P.newmask()
    d.line([(962, 590), (962, 560)], w=10); d.line([(962, 562), (900, 596), (850, 594)], w=4); d.rect(838, 588, 856, 600)
    d.circle(962, 590, 12)
    P.ink(im, (222, 212, 190), alpha=.95, holes=0)
    im, d = P.newmask(); d.line([(962, 562), (900, 596), (850, 594)], w=1.5); P.ink(im, INK, holes=0)
    # lamp on sideboard right with warm glow
    im, d = P.newmask(); d.ellipse(1105, 500, 150, 120)
    P.ink(blur_mask(im, 50), WARM, alpha=.28, grain=0, holes=0)
    im, d = P.newmask()
    d.line([(1105, 640), (1105, 530)], w=7); d.poly([(1070, 530), (1140, 530), (1122, 484), (1088, 484)])
    P.ink(im, INK)
    im, d = P.newmask(); d.poly([(1078, 526), (1132, 526), (1119, 490), (1091, 490)]); P.ink(im, WARM, alpha=.95)
    # records leaning on shelf at left of sideboard + plant
    im, d = P.newmask()
    for k in range(9): d.rect(430 + k * 14, 600, 438 + k * 14 + (k % 3), 700)
    P.ink(im, INK)
    im, d = P.newmask()
    for k in range(9): d.rect(433 + k * 14, 604, 436 + k * 14, 696 if k % 2 else 680)
    P.ink(im, SLATE, alpha=.8)
    # framed picture on wall (abstract)
    im, d = P.newmask(); d.rect(690, 150, 910, 330); P.ink(im, INK)
    im, d = P.newmask(); d.rect(702, 162, 898, 318); P.ink(im, (222, 212, 190), alpha=.92)
    im, d = P.newmask(); d.circle(800, 236, 46); d.rect(724, 286, 876, 300); P.ink(im, WARM, alpha=.9)
    im, d = P.newmask(); d.poly([(702, 318), (780, 250), (840, 300), (898, 270), (898, 318)]); P.ink(im, SLATE, alpha=.85)
    return P.finish()

REG_EXTRA = None

# =====================================================================
# 9. Risograph two-ink mountain lake 1600x900
# =====================================================================
def halftone(w, h, tint, cell=9, ang=45):
    yy, xx = np.mgrid[0:h, 0:w].astype(float)
    a = math.radians(ang)
    u = (xx * math.cos(a) + yy * math.sin(a)) * 2 * math.pi / cell
    v = (-xx * math.sin(a) + yy * math.cos(a)) * 2 * math.pi / cell
    scr = (np.cos(u) + np.cos(v)) / 4 + .5          # 0..1, dot centres at 1
    return (tint > (1 - scr) * 0.98).astype(float) if np.ndim(tint) else (tint > (1 - scr)).astype(float)

def riso():
    P = Print((238, 232, 218), seed=11)
    A = (44, 108, 126); B = (230, 126, 98)
    r = P.r; W, Hh = P.w, P.h
    hz = 580
    xs = np.arange(0, W + 20, 10)
    def ridge(seed, base, amp, f):
        rr = np.random.default_rng(seed); ph = rr.uniform(0, 6, 4)
        return [base - amp * (0.55 * abs(math.sin(x / f + ph[0])) ** 1.3 + 0.3 * math.sin(x / (f * .43) + ph[1]) + .25 * math.sin(x / (f * .17) + ph[2])) for x in xs]
    far = ridge(1, hz - 80, 190, 210); mid = ridge(2, hz - 20, 150, 170); near = ridge(3, hz + 6, 95, 140)
    def poly_mask(top, bottom=hz, ss_scale=True):
        im, d = P.newmask(); d.poly([(x, y) for x, y in zip(xs, top)] + [(W + 20, bottom), (0, bottom)]); return im
    # coral: sun + sky haze tint + sun reflection (offset for misregistration)
    im, d = P.newmask(); d.circle(1060, 330, 128)
    P.ink(im, B, alpha=.95, grain=.25, holes=.02, mode='mul', off=(4, 3))
    yy = np.linspace(0, 1, Hh)[:, None] * np.ones((1, W))
    sky_t = np.clip((yy * Hh - 120) / (hz - 120), 0, 1) ** 1.4 * 0.62
    ht = halftone(W, Hh, sky_t, cell=11, ang=15); ht[hz:] = 0
    sunm = np.array(im.resize((W, Hh)), float) / 255
    ht = ht * (1 - (sunm > .5))
    P.ink(Image.fromarray((ht * 255).astype(np.uint8)).resize((W * P.ss, Hh * P.ss), Image.NEAREST), B, alpha=.9, grain=.25, holes=.02, mode='mul', off=(4, 3))
    # far range: teal halftone .38
    m = np.array(poly_mask(far).resize((W, Hh), Image.BOX), float) / 255
    h1 = halftone(W, Hh, 0.38, cell=10, ang=45) * (m > .5)
    P.ink(Image.fromarray((h1 * 255).astype(np.uint8)).resize((W * P.ss, Hh * P.ss), Image.NEAREST), A, alpha=.92, mode='mul', grain=.2)
    m2 = np.array(poly_mask(mid).resize((W, Hh), Image.BOX), float) / 255
    # coral band in mid range (second colour)
    gt = np.clip(1 - np.abs(yy * Hh - 470) / 130, 0, 1) * 0.55
    h2 = halftone(W, Hh, 0.62, cell=10, ang=45) * (m2 > .5)
    P.ink(Image.fromarray((h2 * 255).astype(np.uint8)).resize((W * P.ss, Hh * P.ss), Image.NEAREST), A, alpha=.95, mode='mul', grain=.2)
    h2b = halftone(W, Hh, gt, cell=12, ang=75) * (m2 > .5)
    P.ink(Image.fromarray((h2b * 255).astype(np.uint8)).resize((W * P.ss, Hh * P.ss), Image.NEAREST), B, alpha=.85, mode='mul', grain=.2, off=(4, 3))
    # near range solid teal with carved pine lines
    nm = poly_mask(near)
    P.ink(nm, A, alpha=.96, mode='mul', grain=.18, holes=.015)
    im, d = P.newmask()
    for k in range(60):
        x = r.uniform(0, W); i_ = int(x / 10); y0 = near[min(i_, len(near) - 1)]
        d.line([(x, y0 + 8), (x - 6 + r.uniform(-3, 3), y0 + r.uniform(30, 60))], w=2)
    P.ink(Image.composite(im, Image.new('L', im.size, 0), nm), (238, 232, 218), alpha=.35, grain=0, holes=0)
    # lake: reflections as horizontal bands
    lake_t = 0.42
    im, d = P.newmask()
    for y in range(hz + 6, Hh, 10):
        t = (y - hz) / (Hh - hz)
        refl = ridge(2, hz + 20, -150 * (1 - t) ** 0.6, 170)   # mirrored mid range
        for x in range(0, W, 60):
            pass
        L = 1
    # mirrored silhouettes
    for ridge_pts, tint, ang in ((far, 0.30, 45), (mid, 0.50, 45)):
        mm = np.zeros((Hh, W))
        mi = np.array(poly_mask(ridge_pts).resize((W, Hh), Image.BOX), float) / 255
        flip = np.zeros_like(mi)
        for y in range(hz, Hh):
            sy = int(hz - (y - hz) * 0.8)
            if sy > 0: flip[y] = mi[sy]
        stripes = (np.arange(Hh)[:, None] % 9 < 6).astype(float)
        wob = np.roll(flip, 0, 1)
        fade = np.clip(1 - (np.arange(Hh)[:, None] - hz) / 230, 0, 1) * tint * .8
        hh = halftone(W, Hh, fade, cell=10, ang=ang) * (flip > .5) * stripes
        P.ink(Image.fromarray((hh * 255).astype(np.uint8)).resize((W * P.ss, Hh * P.ss), Image.NEAREST), A, alpha=.9, mode='mul', grain=.2)
    # coral sun reflection strokes
    im, d = P.newmask()
    for y in range(hz + 10, 860, 12):
        t = (y - hz) / (Hh - hz)
        wd = 110 * (1 - t * .55) * r.uniform(.45, 1)
        d.line([(1060 - wd / 2 + r.uniform(-12, 12), y), (1060 + wd / 2 + r.uniform(-12, 12), y)], w=4.5 - 2 * t)
    P.ink(im, B, alpha=.95, mode='mul', grain=.25, off=(4, 3))
    # shoreline ripple lines
    im, d = P.newmask()
    for k in range(18):
        y = hz + 30 + k * 17 + k * k * .4; x = r.uniform(-80, 1500); L = r.uniform(80, 300)
        d.line([(x, y), (x + L, y)], w=2.5)
    P.ink(im, A, alpha=.7, mode='mul')
    # birds
    im, d = P.newmask()
    for bx, by in [(700, 250), (740, 224), (780, 262), (690, 296)]:
        d.line([(bx - 14, by - 6), (bx, by), (bx + 14, by - 8)], w=3)
    P.ink(im, A, alpha=.9, mode='mul')
    return P.finish().filter(ImageFilter.GaussianBlur(1.1))

# =====================================================================
# 10. Dark felt 1600x900
# =====================================================================
def felt():
    W, Hh = 1600, 900
    r = np.random.default_rng(21)
    base = np.array([38, 40, 44], float)
    n1 = vnoise(Hh, W, 140, 1) - .5
    n2 = vnoise(Hh, W, 18, 2) - .5
    fib = np.zeros((Hh, W))
    im = Image.new('L', (W, Hh), 128); d = ImageDraw.Draw(im)
    for _ in range(9000):
        x, y = r.uniform(0, W), r.uniform(0, Hh); a = r.uniform(0, math.pi); L = r.uniform(6, 22)
        d.line([(x, y), (x + L * math.cos(a), y + L * math.sin(a))], fill=int(128 + r.choice([-16, 16])), width=1)
    fib = (np.array(im.filter(ImageFilter.GaussianBlur(0.7)), float) - 128)
    fine = (np.array(Image.fromarray((r.random((Hh // 2, W // 2)) * 255).astype(np.uint8)).resize((W, Hh), Image.BILINEAR), float) / 255 - .5)
    # quilted diamond lattice (very subtle) with tufts
    yy, xx = np.mgrid[0:Hh, 0:W].astype(float)
    cell = 150
    u = (xx + yy) / (cell * 1.414); v = (xx - yy) / (cell * 1.414)
    du = np.abs((u % 1) - .5); dv = np.abs((v % 1) - .5)
    seam = np.exp(-(np.minimum(0.5 - du, 0.5 - dv) / 0.012) ** 2)
    puff = (1 - np.maximum(du, dv) * 1.6)
    lat = -9 * seam + 5 * puff
    tuft = np.zeros_like(lat)
    for i in range(-2, 16):
        for j in range(-2, 12):
            cx = i * cell * 1.0 + (cell / 2 if j % 2 else 0); cy = j * cell * 0.5 * 1.0
    arr = base[None, None, :] + (n1 * 14 + n2 * 9 + fib * .35 + fine * 10 + lat)[..., None] * np.array([1, 1, 1.05])
    # vignette
    vg = 1 - 0.28 * (((xx - W / 2) / (W / 2)) ** 2 + ((yy - Hh / 2) / (Hh / 2)) ** 2) / 2
    arr *= vg[..., None]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))

REG = {'starry': starry, 'harbour': harbour, 'redfuji': redfuji, 'city': city, 'rain': rain, 'wave': wave, 'wanderer': wanderer, 'room': room, 'riso': riso, 'felt': felt}

SCR = '/tmp/claude-0/-home-claude/9f9327f3-0a5c-5436-b403-f9fa5999d03e/scratchpad'
FILES = {'starry': 'starry.png', 'harbour': 'harbour.png', 'redfuji': 'redfuji.png', 'city': 'city.png', 'rain': 'rain.png', 'wave': 'wave.jpg', 'wanderer': 'wanderer.jpg', 'room': 'room.jpg', 'riso': 'riso.jpg', 'felt': 'felt.jpg'}
def run(names):
    os.makedirs(OUT, exist_ok=True)
    for n in names:
        img = REG[n]()
        f = FILES[n]
        if f.endswith('.png'):
            save_png(img, f)
            if os.path.isdir(SCR):
                img.resize((img.width * 4, img.height * 4), Image.NEAREST).save(os.path.join(SCR, n + '_4x.png'))
            print(f, img.size, ncolors(img), 'colours', os.path.getsize(os.path.join(OUT, f)))
        else:
            save_jpg(img, f); print(f, img.size, os.path.getsize(os.path.join(OUT, f)))
if __name__ == '__main__':
    run(sys.argv[1:] or list(REG))
