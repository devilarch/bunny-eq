#!/usr/bin/env python3
"""Read/write the 5-band EQ on a Tanchjim Bunny DSP (KTMicro UAC dongle).

Protocol (11-byte frames over the interrupt OUT endpoint of USB interface 3):
  4B <reg> 00 00 00 57 <5 payload bytes>   write register
  4B <reg> 00 00 00 52 00 00 00 00 00      read register (reply mirrors it)
  4B 00 00 00 00 53 00 00 00 00 00         save to flash

Bands 0-4 live in register pairs 0x26+2i / 0x27+2i:
  0x26+2i payload: 00 <gain lo> <gain hi> <freq lo> <freq hi>
                  gain = dB*10, freq = Hz, both 16-bit little-endian
  0x27+2i payload: 00 <Q lo> <Q hi> <type> 00
                  Q = Q*1000, type = 0 (device default) / 2 (peaking) etc.
"""
import argparse
import sys
import time

import hid

VID, PID = 0x31B2, 0x1112
DELAY = 0.45  # app waits 400 ms between frames
GAIN_REG, Q_REG = 0x26, 0x27


def frame(reg, action, payload=b"\0" * 5):
    return bytes([0x4B, reg, 0, 0, 0, action]) + payload.ljust(5, b"\0")[:5]


def u16(v):
    return int(v).to_bytes(2, "little")


def s16(v):
    return (int(v) & 0xFFFF).to_bytes(2, "little")


def enc_band(gain, freq):
    return b"\0" + s16(round(gain * 10)) + u16(freq)


def enc_q(q, band_type):
    return b"\0" + u16(round(q * 1000)) + bytes([band_type, 0])


def dec_band(payload):
    return (int.from_bytes(payload[1:3], "little", signed=True) / 10,
            int.from_bytes(payload[3:5], "little"))


def dec_q(payload):
    return int.from_bytes(payload[1:3], "little") / 1000, payload[3]


class Bunny:
    def __init__(self, vid=VID, pid=PID):
        self.vid, self.pid = vid, pid
        self._open()

    def _open(self):
        for _ in range(10):
            paths = hid.enumerate(self.vid, self.pid)
            if paths:
                self.dev = hid.device()
                self.dev.open_path(paths[0]["path"])
                self.dev.set_nonblocking(0)
                return
            time.sleep(0.5)
        sys.exit(f"no HID device {self.vid:04x}:{self.pid:04x} - is the Bunny plugged in?")

    def reopen(self):
        """Save resets the dongle, so the old handle is dead."""
        self.dev.close()
        time.sleep(1)
        self._open()

    def send(self, data):
        self.dev.write(bytes([0]) + data)
        time.sleep(DELAY)
        try:
            return bytes(self.dev.read(64, 3000) or b"")
        except OSError:
            return b""

    def reg(self, reg):
        reply = self.send(frame(reg, 0x52))
        return reply if len(reply) >= 11 and reply[1] == reg else None

    def write_reg(self, reg, payload):
        return self.send(frame(reg, 0x57, payload))

    def get(self):
        bands = []
        for i in range(5):
            g = self.reg(GAIN_REG + 2 * i)
            q = self.reg(Q_REG + 2 * i)
            if g is None or q is None:
                sys.exit("short reply from device")
            gain, freq = dec_band(g[6:11])
            qv, band_type = dec_q(q[6:11])
            bands.append((gain, freq, qv, band_type))
        return bands

    def set(self, bands, types, save):
        for i, ((gain, freq, q, _), band_type) in enumerate(zip(bands, types)):
            self.write_reg(GAIN_REG + 2 * i, enc_band(gain, freq))
            self.write_reg(Q_REG + 2 * i, enc_q(q, band_type))
        if save:
            self.send(frame(0x00, 0x53))
            self.reopen()

    def close(self):
        self.dev.close()


def parse_bands(values):
    if len(values) != 15:
        sys.exit("need 15 numbers: gain freq q, five times")
    bands = []
    for i in range(5):
        gain, freq, q = values[3 * i:3 * i + 3]
        if not -24 <= gain <= 24:
            sys.exit(f"band {i + 1}: gain {gain} dB outside -24..24")
        if not 20 <= freq <= 20000:
            sys.exit(f"band {i + 1}: freq {freq} Hz outside 20..20000")
        if not 0.1 <= q <= 10:
            sys.exit(f"band {i + 1}: Q {q} outside 0.1..10")
        bands.append((gain, int(freq), q, 0))
    return bands


def show(bands):
    for i, (gain, freq, q, band_type) in enumerate(bands):
        print(f"band {i + 1}: {gain:+6.1f} dB  {freq:5d} Hz  Q {q:.3f}  type {band_type}")


def selftest():
    assert frame(0x26, 0x52) == bytes.fromhex("4b 26 00 00 00 52 00 00 00 00 00")
    assert enc_band(2.5, 60) == bytes.fromhex("00 19 00 3c 00")
    assert enc_band(-3.2, 20000) == bytes.fromhex("00 e0 ff 20 4e")
    assert enc_q(0.8, 0) == bytes.fromhex("00 20 03 00 00")
    assert dec_band(bytes.fromhex("00 19 00 3c 00")) == (2.5, 60)
    assert dec_q(bytes.fromhex("00 20 03 00 00")) == (0.8, 0)
    print("selftest ok")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--device", default=f"{VID:04x}:{PID:04x}", help="VID:PID")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("get", help="print the EQ")
    p = sub.add_parser("set", help="write the EQ (and save to flash)")
    p.add_argument("values", nargs=15, type=float,
                   help="gain freq q, five times (e.g. 0 60 0.8  0 250 1.0 ...)")
    p.add_argument("--types", default="00000",
                   help="filter type per band: 0 default, 2 peaking, 3 high-shelf")
    p.add_argument("--no-save", action="store_true", help="skip the flash save")
    p = sub.add_parser("raw", help="send a hex frame and print the reply")
    p.add_argument("hex", help="11 bytes, e.g. '4b 26 00 00 00 52 00 00 00 00 00'")
    sub.add_parser("selftest", help="check the encoding offline, no device needed")
    a = ap.parse_args()

    if a.cmd == "selftest":
        selftest()
        return

    vid, pid = (int(x, 16) for x in a.device.split(":"))
    dev = Bunny(vid, pid)
    try:
        if a.cmd == "get":
            show(dev.get())
        elif a.cmd == "set":
            types = [int(c) for c in a.types]
            if len(types) != 5 or not all(0 <= t <= 9 for t in types):
                sys.exit("--types needs five digits 0-9, e.g. 22222")
            dev.set(parse_bands(a.values), types, not a.no_save)
            show(dev.get())
        else:
            data = bytes.fromhex(a.hex)
            if len(data) != 11:
                sys.exit("frame must be 11 bytes")
            print(dev.send(data).hex(" "))
    finally:
        dev.close()


if __name__ == "__main__":
    main()
