import * as eq from "./eq.js";

const API = "https://angelapi.tanchjim.com/api/v1/eqManage/";
const DEV = eq.DEVICE_FILTER;
const API_BASE = { deviceName: "BUNNY", eqPointNum: 5, currentDeviceName: "TANCHJIM BUNNY DSP" };
const PAGE = 50;
const FRAME_GAP = 400;
const CACHE_TTL = 10 * 60 * 1000;
const FMIN = 20, FMAX = 20000, DB = 15;

const $ = (s) => document.querySelector(s);
const canvas = $("#curve");
const listEl = $("#list");
const msgEl = $("#msg");
const statusEl = $("#status");

const state = {
  bands: eq.parseEq("-4 30 0.3 -6 200 0.5 -0.3 800 0.5 -4 1700 0.6 -6 7500 0.9"),
  device: null,
  tab: "community",
  items: [],
  page: 1,
  query: "",
  busy: false,
  drag: -1,
  hasMore: true,
  mic: 1,
  dirty: false,
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const msg = (t) => { msgEl.textContent = t; };

const xOf = (f, w) => (Math.log10(f / FMIN) / Math.log10(FMAX / FMIN)) * w;
const fOf = (x, w) => FMIN * Math.pow(FMAX / FMIN, x / w);
const yOf = (db, h) => h / 2 - (db / DB) * (h / 2);

/* ---------- drawing ---------- */

function draw() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = "10px ui-monospace, monospace";

  for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    const x = Math.round(xOf(f, w)) + 0.5;
    ctx.strokeStyle = "#20232a";
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    ctx.fillStyle = "#5d6470";
    ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 4, h - 5);
  }
  for (let db = -12; db <= 12; db += 6) {
    const y = Math.round(yOf(db, h)) + 0.5;
    ctx.strokeStyle = db === 0 ? "#333741" : "#20232a";
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    if (db !== 0) { ctx.fillStyle = "#5d6470"; ctx.fillText(`${db > 0 ? "+" : ""}${db}`, 5, y - 4); }
  }

  const pts = [];
  for (let i = 0; i <= 300; i++) {
    const f = FMIN * Math.pow(FMAX / FMIN, i / 300);
    pts.push([xOf(f, w), yOf(clamp(eq.responseAt(state.bands, f), -DB, DB), h)]);
  }

  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.lineTo(w, yOf(0, h)); ctx.lineTo(0, yOf(0, h)); ctx.closePath();
  const fill = ctx.createLinearGradient(0, 0, 0, h);
  fill.addColorStop(0, "rgba(231,194,125,.20)");
  fill.addColorStop(1, "rgba(231,194,125,.02)");
  ctx.fillStyle = fill; ctx.fill();

  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.strokeStyle = "#e7c27d"; ctx.lineWidth = 2; ctx.stroke();

  for (const b of state.bands) {
    ctx.beginPath();
    ctx.arc(xOf(b.freq, w), yOf(clamp(b.gain, -DB, DB), h), 5.5, 0, Math.PI * 2);
    ctx.fillStyle = "#e7c27d"; ctx.fill();
    ctx.strokeStyle = "#111216"; ctx.lineWidth = 2; ctx.stroke();
  }
}

canvas.addEventListener("pointerdown", (e) => {
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  let best = -1, dist = 22;
  state.bands.forEach((b, i) => {
    const d = Math.hypot(xOf(b.freq, r.width) - x, yOf(clamp(b.gain, -DB, DB), r.height) - y);
    if (d < dist) { dist = d; best = i; }
  });
  if (best < 0) return;
  state.drag = best;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener("pointermove", (e) => {
  if (state.drag < 0) return;
  const r = canvas.getBoundingClientRect();
  const b = state.bands[state.drag];
  b.freq = Math.round(clamp(fOf(e.clientX - r.left, r.width), FMIN, FMAX));
  b.gain = Math.round(clamp((0.5 - (e.clientY - r.top) / r.height) * 2 * DB, -DB, DB) * 10) / 10;
  syncInputs();
  draw();
});

const endDrag = () => { state.drag = -1; };
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

/* ---------- band inputs ---------- */

function renderBands() {
  const box = $("#bands");
  box.innerHTML = "";
  state.bands.forEach((b, i) => {
    const row = document.createElement("div");
    row.className = "band";
    row.innerHTML = `<span class="tag">${i + 1}</span>
      <label>Gain<input type="number" step="0.1" value="${b.gain}"><span>dB</span></label>
      <label>Freq<input type="number" step="1" value="${b.freq}"><span>Hz</span></label>
      <label>Q<input type="number" step="0.05" value="${b.q}"></label>`;
    const [gain, freq, q] = row.querySelectorAll("input");
    gain.addEventListener("input", () => { b.gain = clamp(Number(gain.value) || 0, -DB, DB); draw(); });
    freq.addEventListener("input", () => { b.freq = Math.round(clamp(Number(freq.value) || FMIN, FMIN, FMAX)); draw(); });
    q.addEventListener("input", () => { b.q = clamp(Number(q.value) || 0.1, 0.1, 10); draw(); });
    box.append(row);
  });
}

function syncInputs() {
  document.querySelectorAll(".band").forEach((row, i) => {
    const b = state.bands[i];
    if (!b) return;
    const [g, f, q] = row.querySelectorAll("input");
    g.value = b.gain; f.value = b.freq; q.value = b.q;
  });
}

function syncMic() {
  $("#mic").value = state.mic;
  $("#micval").textContent = `${state.mic} dB`;
}

/* ---------- device ---------- */

let waiter = null;
const attached = new WeakSet();

function onReport(e) {
  if (e.reportId !== eq.REPORT_ID) return;
  if (waiter) waiter(new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength));
}

function paint() {
  const on = !!state.device;
  statusEl.textContent = on ? "Connected" : "Not connected";
  statusEl.classList.toggle("on", on);
  $("#connect").textContent = on ? "Reconnect" : "Connect";
  $("#apply").disabled = !on || state.busy;
  $("#flash").disabled = !on || state.busy || !state.dirty;
  $("#flash").classList.toggle("dirty", state.dirty);
  $("#mic").disabled = !on || state.busy;
  $("#save").disabled = state.busy;
}

function setBusy(on, text) {
  state.busy = on;
  $("#connect").disabled = on;
  $("#apply").disabled = on || !state.device;
  $("#flash").disabled = on || !state.device || !state.dirty;
  $("#mic").disabled = on || !state.device;
  $("#save").disabled = on;
  if (text) msg(text);
}

async function useDevice(d) {
  if (!d.opened) await d.open();
  if (!attached.has(d)) {
    attached.add(d);
    d.addEventListener("inputreport", onReport);
    d.addEventListener("disconnect", () => {
      if (state.device === d) { state.device = null; paint(); msg("Earbuds disconnected"); }
    });
  }
  state.device = d;
  paint();
  await readDevice();
}

const send = (frame) => state.device.sendReport(eq.REPORT_ID, eq.payloadOf(frame));

function readReg(reg) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiter = null; reject(new Error("no reply from the earbuds")); }, 2500);
    waiter = (b) => {
      if (b.length < 10 || b[0] !== reg || b[4] !== 0x52) return;
      clearTimeout(timer);
      waiter = null;
      resolve(b);
    };
    send(eq.readFrame(reg)).catch((err) => {
      clearTimeout(timer);
      waiter = null;
      reject(err);
    });
  });
}

async function readDevice() {
  if (!state.device) return;
  setBusy(true, "Reading EQ…");
  try {
    const bands = [];
    for (let i = 0; i < 5; i++) {
      const g = await readReg(eq.GAIN_REG + 2 * i);
      await delay(200);
      const q = await readReg(eq.Q_REG + 2 * i);
      await delay(200);
      const a = eq.decodeBand(g), b = eq.decodeQ(q);
      bands.push({ gain: a.gain, freq: a.freq, q: b.q, type: b.type });
      msg(`Reading band ${i + 1}/5`);
    }
    state.bands = bands;
    try {
      await delay(200);
      state.mic = eq.decodeMic(await readReg(eq.MIC_REG));
      syncMic();
    } catch {
      // Some units do not expose the mic gain register; not fatal.
    }
    renderBands();
    state.dirty = false;
    draw();
    msg("EQ and mic gain read from the earbuds");
  } catch (e) {
    msg(e.message || String(e));
  } finally {
    setBusy(false);
  }
}

async function connect() {
  if (!navigator.hid) { msg("This browser has no WebHID — use Chrome or Edge"); return; }
  try {
    const devices = await navigator.hid.requestDevice({ filters: [DEV] });
    if (devices.length) await useDevice(devices[0]);
  } catch (e) {
    msg(e.message || String(e));
  }
}

async function reconnect() {
  for (let i = 0; i < 24; i++) {
    const devices = await navigator.hid.getDevices();
    const d = devices.find((x) => x.vendorId === DEV.vendorId && x.productId === DEV.productId);
    if (d) { await useDevice(d); return; }
    await delay(250);
  }
  throw new Error("the dongle did not come back — replug it");
}

async function apply() {
  if (!state.device) { msg("Connect first"); return; }
  if (state.busy) return;
  setBusy(true, "Writing band 1/5…");
  try {
    for (let i = 0; i < 5; i++) {
      const [g, q] = eq.bandFrames(state.bands[i], i);
      await send(g);
      await delay(FRAME_GAP);
      await send(q);
      await delay(FRAME_GAP);
      msg(`Writing band ${i + 1}/5`);
    }
    state.dirty = true;
    msg("Applied live — press Save to flash to keep it after unplugging");
  } catch (e) {
    msg(e.message || String(e));
  } finally {
    setBusy(false);
    paint();
  }
}

async function saveFlash() {
  if (!state.device) { msg("Connect first"); return; }
  if (state.busy) return;
  setBusy(true, "Saving… the dongle restarts for a moment");
  try {
    await send(eq.saveFrame());
    state.dirty = false;
    await delay(1500);
    await reconnect();
    msg("Saved to flash");
  } catch (e) {
    msg(e.message || String(e));
  } finally {
    setBusy(false);
    paint();
  }
}

async function writeMic(db) {
  if (!state.device) { msg("Mic gain is read from the earbuds once connected"); return; }
  if (state.busy) return;
  setBusy(true, `Setting mic gain to ${db} dB…`);
  try {
    await send(eq.micWriteFrame(db));
    state.dirty = true;
    msg(`Mic gain ${db} dB — press Save to flash to keep it`);
  } catch (e) {
    msg(e.message || String(e));
  } finally {
    setBusy(false);
    paint();
  }
}

/* ---------- presets ---------- */

async function api(path, body = {}) {
  const res = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...API_BASE, ...body }),
  });
  if (!res.ok) throw new Error(`preset service returned ${res.status}`);
  const json = await res.json();
  if (json.code !== 0) throw new Error(json.msg || "preset service error");
  return json.data;
}

const nameOf = (it) => it.eqNameEn || it.eqName || it.name || "Untitled";
const authorOf = (it) => it.memberName || (it.member && it.member.name) || "";

function readCache(tab) {
  try {
    const c = JSON.parse(localStorage.getItem(`bunny.cache.${tab}`));
    if (c && Date.now() - c.at < CACHE_TTL && Array.isArray(c.items) && c.items.length) return c.items;
  } catch { /* ignore */ }
  return null;
}

function writeCache(tab, items) {
  try { localStorage.setItem(`bunny.cache.${tab}`, JSON.stringify({ at: Date.now(), items })); } catch { /* ignore */ }
}

async function loadPresets({ reset = false } = {}) {
  if (state.tab === "mine") { state.items = mine(); renderList(); return; }
  if (reset) {
    state.page = 1;
    state.items = [];
    state.hasMore = true;
    const cached = !state.query && readCache(state.tab);
    if (cached) { state.items = cached; renderList(); }
  }
  setBusy(true, "Loading presets…");
  try {
    const data = state.query
      ? await api("searchEqList", { page: state.page, pageSize: PAGE, sortType: 0, currentIndex: 1, searchValue: state.query })
      : state.tab === "official"
        ? await api("getTanchjimEqList", { page: 1, pageSize: PAGE, sortType: 0 })
        : await api("getExcellentEqList", { page: state.page, pageSize: PAGE, sortType: 0 });
    const content = data.content || [];
    state.items = reset ? content : state.items.concat(content);
    state.hasMore = state.tab === "official" ? false : content.length >= PAGE;
    if (reset && !state.query && state.tab === "community") writeCache("community", state.items);
    renderList();
    msg("");
  } catch (e) {
    msg(e.message || String(e));
    if (!state.items.length) {
      try {
        state.items = await (await fetch("official.json")).json();
        renderList();
        msg("Community service unreachable — showing official presets");
      } catch { /* nothing to show */ }
    }
  } finally {
    setBusy(false);
  }
}

function renderList() {
  listEl.innerHTML = "";
  if (!state.items.length) {
    listEl.innerHTML = `<p class="empty">${state.tab === "mine"
      ? "Nothing saved yet — tune the curve, then press Save preset."
      : "No presets found."}</p>`;
    $("#more").hidden = true;
    return;
  }
  for (const it of state.items) {
    const name = nameOf(it);
    const meta = [authorOf(it), it.eqData ? `♥ ${it.likeCnt ?? 0}` : "saved locally"].filter(Boolean).join(" · ");
    const row = document.createElement("div");
    row.className = "preset";
    row.innerHTML = `<span class="ptext"><span class="pname"></span><span class="pmeta"></span></span>`;
    row.querySelector(".pname").textContent = name;
    row.querySelector(".pmeta").textContent = meta;
    row.addEventListener("click", () => loadPreset(it, name));
    if (state.tab === "mine") {
      const del = document.createElement("button");
      del.className = "rowbtn danger";
      del.textContent = "Delete";
      del.addEventListener("click", (ev) => { ev.stopPropagation(); removeMine(it.name); });
      row.append(del);
    } else {
      const use = document.createElement("button");
      use.className = "rowbtn";
      use.textContent = "Apply";
      use.title = "Write this tuning to the earbuds";
      use.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (loadPreset(it, name)) apply();
      });
      row.append(use);
    }
    listEl.append(row);
  }
  $("#more").hidden = !state.hasMore || state.tab !== "community";
}

function loadPreset(it, name) {
  if (state.busy) return false;
  try {
    state.bands = eq.parseEq(it.eqData || it.eq, it.iirStr ?? it.iir ?? "");
    renderBands();
    draw();
    msg(`“${name}” loaded — press Apply to write it`);
    return true;
  } catch {
    msg("Could not read that preset");
    return false;
  }
}

function mine() {
  try { return JSON.parse(localStorage.getItem("bunny.mine")) || []; } catch { return []; }
}

function saveMine() {
  const name = prompt("Name this preset", "My tuning");
  if (!name) return;
  const items = mine().filter((x) => x.name !== name);
  items.unshift({ name, eq: eq.formatEq(state.bands), iir: eq.formatTypes(state.bands), at: Date.now() });
  localStorage.setItem("bunny.mine", JSON.stringify(items));
  if (state.tab === "mine") { state.items = items; renderList(); }
  msg(`Saved “${name}”`);
}

function removeMine(name) {
  localStorage.setItem("bunny.mine", JSON.stringify(mine().filter((x) => x.name !== name)));
  state.items = mine();
  renderList();
}

/* ---------- wiring ---------- */

$("#connect").addEventListener("click", connect);
$("#apply").addEventListener("click", apply);
$("#flash").addEventListener("click", saveFlash);
$("#save").addEventListener("click", saveMine);

$("#mic").addEventListener("input", () => {
  state.mic = Number($("#mic").value);
  syncMic();
});
$("#mic").addEventListener("change", () => { if (state.device) writeMic(state.mic); });

document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === btn));
    state.tab = btn.dataset.tab;
    state.query = "";
    $("#search").value = "";
    $("#search").hidden = state.tab !== "community";
    loadPresets({ reset: true });
  });
});

let searchTimer;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = e.target.value.trim();
    loadPresets({ reset: true });
  }, 450);
});

$("#more").addEventListener("click", () => {
  state.page += 1;
  loadPresets();
});

if (!navigator.hid) {
  statusEl.textContent = "Needs Chrome or Edge";
  $("#connect").disabled = true;
}

renderBands();
syncMic();
paint();
draw();
new ResizeObserver(draw).observe(canvas);
loadPresets({ reset: true });

// Already-granted device: pick it up without asking again.
if (navigator.hid) {
  navigator.hid.getDevices()
    .then((devices) => {
      const d = devices.find((x) => x.vendorId === DEV.vendorId && x.productId === DEV.productId);
      if (d) useDevice(d);
    })
    .catch(() => {});
}
