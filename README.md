# Tanchjim Bunny DSP — EQ protocol

Reverse-engineered from the Tanchjim Android app (`com.tanchjim.android`, classes `DSPCommand`,
`CommandProcessingCenter`, `UsbConnectProvider`) and verified against a real unit.

Device: `VID 0x31B2 / PID 0x1112`, USB string "TANCHJIM BUNNY DSP", chip vendor KTMicro.

## USB layout

| Interface | Class | Endpoints |
|---|---|---|
| 0 | AudioControl | 0 |
| 1, 2 | AudioStreaming | 0 |
| 3 | HID | interrupt IN + interrupt OUT |

EQ traffic does **not** use USB Audio class requests. It goes over interface 3:

- Host → device: HID output report ID `0x4B`, 10-byte payload.
- Device → host: HID input report ID `0x4B`, 10-byte payload.
- WebHID: `device.sendReport(0x4B, payload10)`.
- `hidapi`: `dev.write(b"\x4b" + payload10)`. `bunny.py`'s `b"\x00" + frame11` also
  works because the firmware ignores a stray report ID; `0x4B` is the declared one.
- The app waits 400 ms between frames and 5 s for each reply.

The HID report descriptor declares two more vendor reports, `0x54` (unused) and a consumer-control
report ID `1` for volume/play/mute. Ignore anything that is not report `0x4B`.

The app also has a fallback for frames of 8 bytes or less: vendor control transfer
`bmRequestType 0x43` (write) / `0xC3` (read), `bRequest 0xA0` / `0xA1`, `wIndex 0x09A0`, `wValue 0`.
Not used for EQ, since EQ frames are 11 bytes.

## Frame format

```
4B <reg> 00 00 00 <action> <5 payload bytes>
```

| Byte | Meaning |
|---|---|
| 0 | HID report ID `0x4B` (`'K'`) |
| 1 | register address |
| 2–4 | zero |
| 5 | action: `0x52` `'R'` read, `0x57` `'W'` write, `0x53` `'S'` save |
| 6–10 | payload |

- Read: `4B 26 00 00 00 52 00 00 00 00 00` → reply mirrors the request with the payload filled in.
- Write: `4B 26 00 00 00 57 <payload>` → reply `4B 26 00 00 00 57 00 03 00 00 00` (status ack).
- Save: `4B 00 00 00 00 53 00 00 00 00 00` → commits RAM to flash. **The dongle resets/re-enumerates
  on save, so the HID handle dies**; the app disconnects right after (and so does the tool).

## EQ registers

Five bands. Band `i` (0–4) uses two registers:

| Register | Contents (payload bytes 6–10) |
|---|---|
| `0x26 + 2i` | `00 gain_lo gain_hi freq_lo freq_hi` |
| `0x27 + 2i` | `00 q_lo q_hi type 00` |

All 16-bit values are **little-endian**:

| Value | Encoding | Range on this unit |
|---|---|---|
| gain | dB × 10, signed 16-bit two's complement | ±24 dB checked by tool |
| freq | Hz, unsigned 16-bit | 20–20000 Hz |
| Q | Q × 1000, unsigned 16-bit | 0.1–10 |
| type | filter type, one byte | 0–9 |

Example, band 1 = +2.5 dB @ 60 Hz, Q 0.8, type 0:

```
write 4B 26 00 00 00 57 00 19 00 3C 00      19 00 = 0x0019 = 25 → 2.5 dB
                                             3C 00 = 0x003C = 60 Hz
write 4B 27 00 00 00 57 00 20 03 00 00      20 03 = 0x0320 = 800 → Q 0.8
save  4B 00 00 00 00 53 00 00 00 00 00
```

### Filter type byte

The app encodes filter types as `DISABLE→1, LOW_SHELF→1, PEAKING→2, HIGH_SHELF→3,
LOW_PASS→4, HIGH_PASS→5`, and decodes `0→disable, 1→low shelf, 2→peaking, 3→high shelf,
4→low pass, 5→high pass`. The device accepts `0`, which is what this unit ships with and what
the app falls back to for presets that carry no filter metadata. The app's custom-EQ UI usually
writes `2` (peaking) for all five bands.

### Frequency quirk

For three older products (`ZERO`, `ONE`, `TANYA`) the app stores frequency divided by 2 and doubles
it on read (`DSPProductType.isValidName`). BUNNY is not in that list, so frequency is stored as-is.

## Other register seen

`0x65` — microphone gain ("digital ADC"). One byte in payload byte 1, value = **dB × 2**, negative
values as `v*2 + 256`. Range on this unit is −15…+15 dB in 0.5 dB steps.

```
read:  4B 65 00 00 00 52 00 00 00 00 00   ->  4B 65 00 00 00 52 00 02 00 00 00   (= 1 dB)
write: 4B 65 00 00 00 57 00 06 00 00 00   (= +3 dB)
```

Written with the same 0x57 action and committed with the 0x53 save. Read on this unit returned
`02` → 1 dB. Not used by the EQ path.

## Tool

```sh
python3 -m venv .venv && .venv/bin/pip install hidapi

.venv/bin/python bunny.py get
.venv/bin/python bunny.py set 2.5 60 0.8  0 250 1.0  1.5 2500 1.1  0 6000 1.5  1.8 13000 0.9
.venv/bin/python bunny.py set 0 60 1 0 250 1 0 2500 1 0 6000 1 0 13000 1 --types 22222
.venv/bin/python bunny.py raw "4b 26 00 00 00 52 00 00 00 00 00"
.venv/bin/python bunny.py selftest        # encoding checks, no device needed
```

`set` takes gain/freq/Q five times, writes all ten registers (400 ms apart like the app), saves to
flash, then reopens the dongle and prints the readback. `--no-save` skips the flash commit.
`--device VID:PID` targets a different KTMicro unit.

EQ as found on this unit (band frequency anchors are what the device/firmware reports):

```
band 1: +2.5 dB     60 Hz  Q 0.800  type 0
band 2: +0.0 dB    250 Hz  Q 1.000  type 0
band 3: +1.5 dB   2500 Hz  Q 1.100  type 0
band 4: +0.0 dB   6000 Hz  Q 1.500  type 0
band 5: +1.8 dB  13000 Hz  Q 0.900  type 0
```

## Browser app

`web/` is a static WebHID app: same frames over the HID interface, but no Python and no install.
Chrome or Edge only, since Safari and Firefox have no WebHID.

```sh
cd web && python3 -m http.server 8765    # then open http://localhost:8765
```

See `web/README.md` for the community preset API and Vercel deployment.

## Files

- `app.apk` — Tanchjim app as downloaded from tanchjim.com (not in the repo).
- `jadx-out/` — decompiled sources (`DSPCommand.java` is the protocol core; not in the repo).
- `bunny.py` — the tool.
- `web/` — static browser version (`eq.js` is the same wire format, tested with `node --test`).
