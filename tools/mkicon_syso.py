#!/usr/bin/env python3
"""Make a Windows resource object (.syso) with an icon, for `go build` (amd64).
Usage: mkicon_syso.py icon.ico out.syso   (no dependencies)"""
import struct, sys

def build(ico_path, out_path):
    ico = open(ico_path, 'rb').read()
    _, typ, n = struct.unpack_from('<HHH', ico, 0)
    assert typ == 1, 'not an .ico'
    imgs = []
    for i in range(n):
        w, h, cc, _r, planes, bits, size, off = struct.unpack_from('<BBBBHHII', ico, 6 + 16 * i)
        imgs.append(((w, h, cc, planes, bits, size), ico[off:off + size]))
    grp = struct.pack('<HHH', 0, 1, n) + b''.join(
        struct.pack('<BBBBHHIH', w, h, cc, 0, planes, bits, size, i + 1) for i, ((w, h, cc, planes, bits, size), _) in enumerate(imgs))

    # layout: root dir | type dirs | name dirs | lang dirs | data entries | blobs
    D = lambda k: 16 + 8 * k
    types = [(3, [(i + 1, d) for i, (_, d) in enumerate(imgs)]), (14, [(1, grp)])]
    off_root = 0
    off_type = off_root + D(len(types))
    name_dirs, cur = [], off_type
    for _, items in types:
        name_dirs.append(cur); cur += D(len(items))
    lang_dirs = []
    for _, items in types:
        lst = []
        for _ in items: lst.append(cur); cur += D(1)
        lang_dirs.append(lst)
    data_entries = []
    for _, items in types:
        lst = []
        for _ in items: lst.append(cur); cur += 16
        data_entries.append(lst)
    blobs = []
    for _, items in types:
        lst = []
        for _, blob in items:
            cur = (cur + 7) & ~7; lst.append(cur); cur += len(blob)
        blobs.append(lst)
    sec = bytearray(cur)
    def dirhdr(at, k): struct.pack_into('<IIHHHH', sec, at, 0, 0, 0, 0, 0, k)
    dirhdr(off_root, len(types))
    for t, (tid, items) in enumerate(types):
        struct.pack_into('<II', sec, off_root + 16 + 8 * t, tid, 0x80000000 | name_dirs[t])
        dirhdr(name_dirs[t], len(items))
        for i, (nid, blob) in enumerate(items):
            struct.pack_into('<II', sec, name_dirs[t] + 16 + 8 * i, nid, 0x80000000 | lang_dirs[t][i])
            dirhdr(lang_dirs[t][i], 1)
            struct.pack_into('<II', sec, lang_dirs[t][i] + 16, 0x0409, data_entries[t][i])
            struct.pack_into('<IIII', sec, data_entries[t][i], blobs[t][i], len(blob), 0, 0)
            sec[blobs[t][i]:blobs[t][i] + len(blob)] = blob
    relocs = [de for lst in data_entries for de in lst]   # OffsetToData fields need the section RVA added

    data_off = 20 + 40
    rel_off = data_off + len(sec)
    sym_off = rel_off + 10 * len(relocs)
    out = bytearray()
    out += struct.pack('<HHIIIHH', 0x8664, 1, 0, sym_off, 1, 0, 0)
    out += struct.pack('<8sIIIIIIHHI', b'.rsrc', 0, 0, len(sec), data_off, rel_off, 0, len(relocs), 0, 0x40000040)
    out += sec
    for r in relocs: out += struct.pack('<IIH', r, 0, 3)          # IMAGE_REL_AMD64_ADDR32NB
    out += struct.pack('<8sIhHBB', b'.rsrc', 0, 1, 0, 3, 0)       # section symbol
    out += struct.pack('<I', 4)                                   # empty string table
    open(out_path, 'wb').write(out)

if __name__ == '__main__':
    build(sys.argv[1], sys.argv[2])
