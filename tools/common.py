"""Shared helpers for the data build: compact polyline encoding.

Coordinates are quantised to 1e-5 degrees (about 1 m) and written as
zig-zag varints of the delta from the previous point, so a map-sized
polyline set costs roughly 2-3 bytes per vertex before gzip.
"""
import gzip
import struct

Q = 1e5  # quantisation factor


class Writer:
    def __init__(self):
        self.buf = bytearray()

    def u8(self, v):
        self.buf.append(v & 0xFF)

    def u16(self, v):
        self.buf += struct.pack('<H', v)

    def u32(self, v):
        self.buf += struct.pack('<I', v)

    def uvar(self, v):
        assert v >= 0
        while v >= 0x80:
            self.buf.append((v & 0x7F) | 0x80)
            v >>= 7
        self.buf.append(v)

    def svar(self, v):
        self.uvar(v << 1 if v >= 0 else ((-v) << 1) - 1)

    def line(self, coords):
        """Write one polyline: count, then delta-encoded quantised coords."""
        pts = []
        for x, y in ((c[0], c[1]) for c in coords):
            q = (round(x * Q), round(y * Q))
            if not pts or pts[-1] != q:
                pts.append(q)
        self.uvar(len(pts))
        px, py = 0, 0
        for x, y in pts:
            self.svar(x - px)
            self.svar(y - py)
            px, py = x, y

    def save(self, path, compress=True):
        data = bytes(self.buf)
        if compress:
            data = gzip.compress(data, 9, mtime=0)
        with open(path, 'wb') as f:
            f.write(data)
        return len(data)
