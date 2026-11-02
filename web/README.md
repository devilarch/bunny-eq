# Bunny EQ — browser app

Static site, no build step, no backend. `eq.js` holds the wire format and the peaking-filter maths
(unit tested with `node --test`), `app.js` holds WebHID, canvas and preset logic.

```sh
python3 -m http.server 8765     # http://localhost:8765
node --test                     # 6 tests, no device needed
```

Requires Chrome or Edge: WebHID. The dongle keeps playing audio while the page holds the HID
interface, because only interface 3 is claimed.

## Device protocol

Same as `../README.md`: register in byte 1, action in byte 4 (`0x57` write, `0x52` read, `0x53`
save), five payload bytes after it. The HID report ID is `0x4B` and its payload is 10 bytes, so
WebHID calls `device.sendReport(0x4B, frame.subarray(1))` and replies arrive as `inputreport`
events with `reportId === 0x4B` and a 10-byte `data`. Frames are 400 ms apart.

**Apply vs save.** Register writes take effect immediately and leave the audio untouched.
Register `0x53` commits RAM to flash and makes the dongle re-enumerate, so macOS falls back to the
laptop speakers for a second or two. The app therefore applies live and keeps the tuning in memory
until *Save to flash* is pressed; that button is the only thing that interrupts playback. Unsaved
tunings are lost when the dongle is unplugged.

Mic gain is register `0x65`: one signed byte, value = dB × 2, −15…+15 dB in 0.5 dB steps. It is
read on connect alongside the EQ and written the same way as a band, with the same save rule.

## Community presets

Tanchjim's own service, `https://angelapi.tanchjim.com` (the app uses `angelapihk.tanchjim.com`
abroad). It sends `access-control-allow-origin: *`, so the browser calls it directly. No auth.

`POST /api/v1/eqManage/<endpoint>` with JSON:

```json
{
  "deviceName": "BUNNY",
  "eqPointNum": 5,
  "currentDeviceName": "TANCHJIM BUNNY DSP",
  "page": 1,
  "pageSize": 50,
  "sortType": 0
}
```

| endpoint | extra fields | what it returns |
| --- | --- | --- |
| `getExcellentEqList` | — | 2,788 community tunings, paged |
| `getTanchjimEqList` | — | the 5 official tunings |
| `searchEqList` | `currentIndex: 1`, `searchValue` | name search; `currentIndex: 0` always returns 0 results |

A tuning is `eqData` = 15 numbers, `"gain freq q"` per band (gain in dB, Q ×1 not ×1000), plus
`iirStr` = 5 filter types (`0` = peaking), `eqName` / `eqNameEn`, `memberName`, `likeCnt`,
`downloadCnt`.

If the service is unreachable the app falls back to `official.json`, a copy of the five official
tunings. Own presets live in `localStorage` (`bunny.mine`), the first community page is cached for
10 minutes (`bunny.cache.community`).

## Deploy

Static: import the repo on Vercel, set **Root Directory** to `web`, framework preset **Other**,
no build command, output `.` (or just `vercel --prod` from inside `web/`). Any static host works.
