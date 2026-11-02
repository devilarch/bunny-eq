import test from "node:test";
import assert from "node:assert/strict";
import * as eq from "../eq.js";

const hex = (u8) => Buffer.from(u8).toString("hex").match(/../g).join(" ");

test("frames match the app's wire bytes", () => {
  assert.equal(hex(eq.readFrame(0x26)), "4b 26 00 00 00 52 00 00 00 00 00");
  assert.equal(hex(eq.saveFrame()), "4b 00 00 00 00 53 00 00 00 00 00");
});

test("band 1 at +2.5 dB / 60 Hz / Q 0.8", () => {
  const [gain, q] = eq.bandFrames({ gain: 2.5, freq: 60, q: 0.8, type: 0 }, 0);
  assert.equal(hex(gain), "4b 26 00 00 00 57 00 19 00 3c 00");
  assert.equal(hex(q), "4b 27 00 00 00 57 00 20 03 00 00");
});

test("negative gain is two's complement", () => {
  const [gain] = eq.bandFrames({ gain: -3.2, freq: 20000, q: 1, type: 0 }, 0);
  assert.equal(hex(gain), "4b 26 00 00 00 57 00 e0 ff 20 4e");
});

test("decodes a real reply payload", () => {
  const reply = Uint8Array.from(Buffer.from("26000000 520019003c00".replace(/ /g, ""), "hex"));
  assert.deepEqual(eq.decodeBand(reply), { gain: 2.5, freq: 60 });
  const q = Uint8Array.from(Buffer.from("27000000520020030000", "hex"));
  assert.deepEqual(eq.decodeQ(q), { q: 0.8, type: 0 });
});

test("payload strips the HID report id", () => {
  assert.equal(eq.REPORT_ID, 0x4b);
  const p = eq.payloadOf(eq.readFrame(0x26));
  assert.equal(p.length, 10);
  assert.equal(Buffer.from(p).toString("hex"), "26000000520000000000");
});

test("mic gain uses register 0x65 in half-dB steps", () => {
  assert.equal(hex(eq.micWriteFrame(3)), "4b 65 00 00 00 57 00 06 00 00 00");
  assert.equal(hex(eq.micWriteFrame(-4.5)), "4b 65 00 00 00 57 00 f7 00 00 00");
  assert.equal(eq.decodeMic(Uint8Array.from(Buffer.from("65000000520002000000", "hex"))), 1);
  assert.equal(eq.decodeMic(Uint8Array.from(Buffer.from("650000005200f7000000", "hex"))), -4.5);
});

test("official preset round-trips", () => {
  const bands = eq.parseEq("-6.5 30 0.2 -5.7 200 0.5 -0.5 800 0.5 -4 1600 0.8 -5.5 7500 1.2", "0 0 0 0 0");
  assert.equal(bands.length, 5);
  assert.deepEqual(bands[0], { gain: -6.5, freq: 30, q: 0.2, type: 0 });
  assert.equal(eq.formatEq(bands), "-6.5 30 0.2 -5.7 200 0.5 -0.5 800 0.5 -4 1600 0.8 -5.5 7500 1.2");
});

test("curve peaks at the band centre and is flat elsewhere", () => {
  const bands = [{ gain: 6, freq: 1000, q: 1, type: 0 }];
  assert.ok(Math.abs(eq.responseAt(bands, 1000) - 6) < 0.01);
  assert.ok(Math.abs(eq.responseAt(bands, 40)) < 0.1);
  assert.equal(eq.responseAt([{ gain: 0, freq: 1000, q: 1, type: 0 }], 1000), 0);
});
