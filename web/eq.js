// Bunny DSP wire format and EQ maths. No DOM, no device - testable in node.

export const DEVICE_FILTER = { vendorId: 0x31b2, productId: 0x1112 };
export const REPORT_ID = 0x4b;
export const GAIN_REG = 0x26;
export const Q_REG = 0x27;
export const MIC_REG = 0x65;
export const BANDS = 5;

const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
const s16 = (v) => u16(v < 0 ? v + 0x10000 : v);

export function frame(reg, action, payload = []) {
  const out = new Uint8Array(11);
  out.set([0x4b, reg, 0, 0, 0, action]);
  payload.slice(0, 5).forEach((b, i) => { out[6 + i] = b & 0xff; });
  return out;
}

export const readFrame = (reg) => frame(reg, 0x52);
export const saveFrame = () => frame(0x00, 0x53);

// WebHID sends report 0x4B with a 10-byte payload; the frame above carries the report ID in byte 0.
export const payloadOf = (f) => f.subarray(1);

export function bandFrames(band, i) {
  return [
    frame(GAIN_REG + 2 * i, 0x57,
      [0, ...s16(Math.round(band.gain * 10)), ...u16(Math.round(band.freq))]),
    frame(Q_REG + 2 * i, 0x57,
      [0, ...u16(Math.round(band.q * 1000)), (band.type | 0) & 0x0f, 0]),
  ];
}

// Input is the 10-byte report payload: [0] reg, [4] action, [5..9] values.
export function decodeBand(r) {
  return {
    gain: (((r[6] | (r[7] << 8)) << 16) >> 16) / 10,
    freq: r[8] | (r[9] << 8),
  };
}

export function decodeQ(r) {
  return { q: (r[6] | (r[7] << 8)) / 1000, type: r[8] };
}

// Digital ADC / mic gain: one signed byte in payload byte 6, in half-dB steps.
export function decodeMic(r) {
  const v = r[6];
  return (v > 127 ? v - 256 : v) / 2;
}

export const micWriteFrame = (db) => frame(MIC_REG, 0x57, [0, (Math.round(db * 2) & 0xff), 0, 0, 0]);

// "gain freq q" x5, plus optional "type" x5 (iirStr).
export function parseEq(eqData, iirStr = "") {
  const n = String(eqData).trim().split(/\s+/).map(Number);
  if (n.length < 15 || n.some(Number.isNaN)) throw new Error("bad EQ data");
  const types = String(iirStr || "").trim().split(/\s+/).filter(Boolean).map(Number);
  return Array.from({ length: BANDS }, (_, i) => ({
    gain: n[3 * i],
    freq: Math.round(n[3 * i + 1]),
    q: n[3 * i + 2],
    type: Number.isFinite(types[i]) ? types[i] : 0,
  }));
}

export function formatEq(bands) {
  return bands.map((b) => `${b.gain} ${b.freq} ${b.q}`).join(" ");
}

export function formatTypes(bands) {
  return bands.map((b) => b.type || 0).join(" ");
}

// RBJ peaking biquad magnitude, summed across bands.
export function responseAt(bands, f, fs = 48000) {
  let db = 0;
  for (const b of bands) db += peakingDb(f, b.freq, b.gain, b.q, fs);
  return db;
}

function peakingDb(f, f0, gain, q, fs) {
  const A = Math.pow(10, gain / 40);
  const w0 = (2 * Math.PI * f0) / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const cw0 = Math.cos(w0);
  const b0 = 1 + alpha * A, b1 = -2 * cw0, b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A, a1 = -2 * cw0, a2 = 1 - alpha / A;
  const w = (2 * Math.PI * f) / fs;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const numRe = b0 + b1 * c1 + b2 * c2, numIm = -(b1 * s1 + b2 * s2);
  const denRe = a0 + a1 * c1 + a2 * c2, denIm = -(a1 * s1 + a2 * s2);
  return 20 * Math.log10(Math.hypot(numRe, numIm) / Math.hypot(denRe, denIm));
}
