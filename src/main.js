import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import daisyUrl from "../assets/daisy.png";
import { listen } from "@tauri-apps/api/event";

async function preloadFonts() {
  const list = ["Montserrat", "Oswald", "Poiret One", "Lobster", "Lora", "Comfortaa", "Caveat", "Press Start 2P"];
  await Promise.all(list.map((f) => document.fonts.load(`48px "${f}"`)));
  if (typeof renderTextLayer === "function") renderTextLayer();
}
preloadFonts();

const $ = (id) => document.getElementById(id);
const canvas = $("preview");
const ctx = canvas.getContext("2d");
const textCanvas = $("text-layer");
const textCtx = textCanvas.getContext("2d");
const dz = $("dropzone");

const S = { loaded: false, busy: false, b: 0, c: 0, s: 0, scale: 100, ox: 0, oy: 0, rot: 0, fitW: 512, fitH: 512 };

const sliders = [
  { key: "b", input: $("b-slider"), badge: $("b-val") },
  { key: "c", input: $("c-slider"), badge: $("c-val") },
  { key: "s", input: $("s-slider"), badge: $("s-val") },
];

const fmt = (v) => (v > 0 ? "+" : "") + v + "%";
const paint = (el) => {
  const min = Number(el.min || 0), max = Number(el.max || 100), val = Number(el.value);
  el.style.setProperty("--p", ((val - min) / (max - min)) * 100 + "%");
};
function syncSliders() {
  for (const sl of sliders) {
    sl.input.value = S[sl.key];
    sl.badge.textContent = fmt(S[sl.key]);
    paint(sl.input);
  }
}
for (const sl of sliders) {
  sl.input.addEventListener("input", () => {
    S[sl.key] = Number(sl.input.value);
    sl.badge.textContent = fmt(S[sl.key]);
    paint(sl.input);
    scheduleRender();
  });
}

const statusEl = $("status-text");
let base = { text: "Drop an image", color: "var(--fg-muted)" };
let top = null, topTimer = null;
function paintStatus() {
  const st = top || base;
  statusEl.textContent = st.text;
  statusEl.style.color = st.color;
}
function setStatus(text, color = "var(--fg-muted)", kind = "top", timeout = 5000) {
  if (kind === "base") { base = { text, color }; paintStatus(); return; }
  top = { text, color };
  clearTimeout(topTimer);
  topTimer = setTimeout(() => { top = null; paintStatus(); }, timeout);
  paintStatus();
}
const idleStatus = () =>
  setStatus(S.loaded ? "Ready to save" : "Drop an image", "var(--fg-muted)", "base");

const params = (withText = true) => ({
  brightness: S.b, contrast: S.c, saturation: S.s,
  scale: S.scale, offset_x: S.ox, offset_y: S.oy, rotation: S.rot,
  text_overlay: withText ? getTextPngBase64() : null,
});

let rendering = false, pending = false;
function scheduleRender() {
  if (!S.loaded) return;
  pending = true;
  if (!rendering) pump();
}
async function pump() {
  rendering = true;
  while (pending) {
    pending = false;
    try {
      const buf = await invoke("render_preview", { p: params(false) });
      ctx.putImageData(new ImageData(new Uint8ClampedArray(buf), 512, 512), 0, 0);
    } catch (e) { setStatus("Preview: " + e, "var(--danger)"); }
  }
  rendering = false;
}

const ER = { size: 24, opacity: 100, hardness: 80 };
let eraserCount = 0;
let spaceHeld = false;
const brushEl = $("brush-cursor");

const toolSliders = [
  { input: $("er-size"), badge: $("er-size-val"), fmt: (v) => v + " px", onChange: (v) => { ER.size = Number(v); updateBrushSize(); } },
  { input: $("er-op"), badge: $("er-op-val"), fmt: (v) => v + "%", onChange: (v) => { ER.opacity = Number(v); } },
  { input: $("er-hard"), badge: $("er-hard-val"), fmt: (v) => v + "%", onChange: (v) => { ER.hardness = Number(v); } },
  { input: $("txt-size"), badge: $("txt-size-val"), fmt: (v) => v + " px", onChange: (v) => { const it = getActiveText(); if (it) { it.size = Number(v); if (editingItemId === it.id) updateInlineEditorStyle(it); renderTextLayer(); } } },
  { input: $("txt-op"), badge: $("txt-op-val"), fmt: (v) => v + "%", onChange: (v) => { const it = getActiveText(); if (it) { it.opacity = Number(v); if (editingItemId === it.id) updateInlineEditorStyle(it); renderTextLayer(); } } },
  { input: $("txt-rot"), badge: $("txt-rot-val"), fmt: (v) => (Number(v) > 0 ? "+" : "") + v + "°", onChange: (v) => { const it = getActiveText(); if (it) { it.rot = Number(v); if (editingItemId === it.id) updateInlineEditorStyle(it); renderTextLayer(); } } },
];
for (const sl of toolSliders) {
  paint(sl.input);
  sl.input.addEventListener("input", () => {
    sl.badge.textContent = sl.fmt(sl.input.value);
    paint(sl.input);
    sl.onChange(sl.input.value);
  });
}

function updateEraserBtns() {
  const on = S.loaded && eraserCount > 0;
  $("er-undo-btn").disabled = !on;
  $("er-reset-btn").disabled = !on;
}
function hideBrush() { brushEl.hidden = true; }
function updateBrushSize() {
  const r = canvas.getBoundingClientRect();
  if (!r.width) return;
  const px = Math.max(4, ER.size * (r.width / 512));
  brushEl.style.width = px + "px";
  brushEl.style.height = px + "px";
}
function syncCursorMode() {
  const erOn = S.loaded && activeTool === "eraser" && !spaceHeld;
  canvas.classList.toggle("eraser-mode", erOn);
  if (!erOn) hideBrush();
}

let activeTool = "adjust";
$("tool-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tool]");
  if (!b) return;
  activeTool = b.dataset.tool;
  for (const btn of $("tool-tabs").children) btn.classList.toggle("active", btn === b);
  $("tab-adjust").hidden = activeTool !== "adjust";
  $("tab-eraser").hidden = activeTool !== "eraser";
  $("tab-text").hidden = activeTool !== "text";
  dz.classList.toggle("text-tool-active", activeTool === "text");
  syncCursorMode();
  if (activeTool !== "text") closeInlineEditor();
  if (activeTool === "text" && S.loaded && TXT.items.length === 0) {
    addTextItem("", 256, 430, true);
  }
  syncTextControls();
  renderTextLayer();
});

$("txt-style-btn").addEventListener("click", () => {
  const it = getActiveText();
  if (!it) return;
  const order = ["pill-light", "pill-dark", "plain"];
  const curIdx = order.indexOf(it.style);
  it.style = order[(curIdx + 1) % order.length];

  // Auto color switch (Telegram style)
  if (it.style === "pill-light") {
    if (it.color.toLowerCase() === "#ffffff") it.color = "#000000";
  } else {
    if (it.color.toLowerCase() === "#000000") it.color = "#ffffff";
  }

  syncTextControls();
  if (editingItemId === it.id) updateInlineEditorStyle(it);
  renderTextLayer();
});



function setUiEnabled(on) {
  for (const sl of sliders) {
    sl.input.disabled = !on;
    sl.badge.classList.toggle("dim", !on);
  }
  for (const sl of toolSliders) {
    sl.input.disabled = !on;
    sl.badge.classList.toggle("dim", !on);
  }
  for (const id of ["txt-add-btn", "txt-del-btn", "txt-font", "txt-color"]) {
    $(id).disabled = !on;
  }
  updateEraserBtns();
  syncCursorMode();
  for (const el of document.querySelectorAll("#txt-swatches button")) el.disabled = !on;
  $("txt-style-btn").disabled = !on;
  $("txt-weight-btn").disabled = !on;
  $("save-btn").disabled = !on;
  $("export-btn").disabled = !on;
}

async function loadPath(path) {
  try {
    const info = await invoke("load_image", { path });
    S.fitW = info.fit_w || 512; S.fitH = info.fit_h || 512;
    eraserCount = 0; updateEraserBtns(); TXT.items = []; TXT.selectedId = null; syncTextControls(); renderTextLayer();
    S.loaded = true; S.scale = 100; S.ox = 0; S.oy = 0; S.rot = 0;
    $("hint").hidden = true; canvas.hidden = false; textCanvas.hidden = false; $("clear-btn").hidden = false;
    setUiEnabled(true);
    if (activeTool === "text" && TXT.items.length === 0) {
      addTextItem("", 256, 430, true);
    } else {
      syncTextControls();
    }
    MODEL.hasNobg = false;
    refreshRemove();
    idleStatus();
    scheduleRender();
  } catch (e) { setStatus(String(e), "var(--danger)"); }
}

async function doClear() {
  if (MODEL.running) { rmGen++; MODEL.running = false; stopProcTimer(); invoke("cancel_remove").catch(() => {}); }
  MODEL.hasNobg = false;
  await invoke("clear_image");
  S.loaded = false; S.b = S.c = S.s = 0; S.scale = 100; S.ox = S.oy = 0; S.rot = 0;
  syncSliders();
  closeInlineEditor(); TXT.items = []; TXT.selectedId = null; syncTextControls(); renderTextLayer();
  ctx.clearRect(0, 0, 512, 512);
  canvas.hidden = true; textCanvas.hidden = true; $("clear-btn").hidden = true; $("hint").hidden = false;
  setUiEnabled(false);
  refreshRemove();
  top = null; clearTimeout(topTimer);
  idleStatus();
}
$("clear-btn").addEventListener("pointerdown", (e) => e.stopPropagation());
$("clear-btn").addEventListener("click", (e) => { e.stopPropagation(); doClear(); });

dz.addEventListener("click", async () => {
  if (S.loaded) return;
  const path = await open({
    multiple: false,
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tiff", "heic", "heif"] }],
  });
  if (path) loadPath(path);
});

const OK_EXT = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tiff", ".heic", ".heif"];
getCurrentWebview().onDragDropEvent((ev) => {
  const t = ev.payload.type;
  if (t === "enter" || t === "over") dz.classList.add("dragover");
  else if (t === "leave") dz.classList.remove("dragover");
  else if (t === "drop") {
    dz.classList.remove("dragover");
    const p = (ev.payload.paths || []).find((p) => OK_EXT.some((x) => p.toLowerCase().endsWith(x)));
    if (p) loadPath(p);
  }
});

function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * 512, ((e.clientY - r.top) / r.height) * 512];
}
function canvasToImageNorm(cx, cy) {
  const dx = cx - (256 + S.ox);
  const dy = cy - (256 + S.oy);
  const th = (S.rot * Math.PI) / 180;
  const c = Math.cos(th), s = Math.sin(th);
  const ux = dx * c + dy * s;
  const uy = -dx * s + dy * c;
  const sc = S.scale / 100;
  return [0.5 + ux / (S.fitW * sc), 0.5 + uy / (S.fitH * sc)];
}

const strokeCov = new Float32Array(512 * 512);
let baseAlpha = null;
let liveImgData = null;

function distSegSq(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const lenSq = vx * vx + vy * vy;
  if (lenSq <= 1e-12) return wx * wx + wy * wy;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / lenSq));
  const dx = px - (ax + t * vx), dy = py - (ay + t * vy);
  return dx * dx + dy * dy;
}

function paintLiveSegment(ax, ay, bx, by) {
  const r = Math.max(0.5, ER.size / 2);
  const rSq = r * r;
  const inner = Math.min(r * (ER.hardness / 100), Math.max(0, r - 1));
  const span = Math.max(1e-6, r - inner);
  const op = ER.opacity / 100;

  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - 1));
  const x1 = Math.min(511, Math.ceil(Math.max(ax, bx) + r + 1));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r - 1));
  const y1 = Math.min(511, Math.ceil(Math.max(ay, by) + r + 1));
  if (x0 > x1 || y0 > y1) return;

  const data = liveImgData.data;
  for (let py = y0; py <= y1; py++) {
    const fy = py + 0.5;
    for (let px = x0; px <= x1; px++) {
      const fx = px + 0.5;
      const d2 = distSegSq(fx, fy, ax, ay, bx, by);
      if (d2 >= rSq) continue;
      const d = Math.sqrt(d2);
      let cov = 1;
      if (d > inner) {
        const t = Math.max(0, Math.min(1, (d - inner) / span));
        cov = 0.5 * (1 + Math.cos(t * Math.PI));
      }
      const idx = py * 512 + px;
      if (cov > strokeCov[idx]) {
        strokeCov[idx] = cov;
        data[idx * 4 + 3] = Math.round(baseAlpha[idx] * (1 - op * cov));
      }
    }
  }
  ctx.putImageData(liveImgData, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
}

function positionBrush(e) {
  if (!S.loaded || activeTool !== "eraser" || spaceHeld) { hideBrush(); return; }
  const dr = dz.getBoundingClientRect();
  updateBrushSize();
  brushEl.style.left = (e.clientX - dr.left) + "px";
  brushEl.style.top = (e.clientY - dr.top) + "px";
  brushEl.hidden = false;
}

let drag = null;
canvas.addEventListener("pointerdown", (e) => {
  if (!S.loaded || e.button !== 0) return;
  if (e.altKey) {
    drag = { rot: true, base: S.rot, a0: angleAt(e) };
  } else if (activeTool === "eraser" && !spaceHeld) {
    const pt = canvasPoint(e);
    strokeCov.fill(0);
    liveImgData = ctx.getImageData(0, 0, 512, 512);
    baseAlpha = new Uint8Array(512 * 512);
    for (let i = 0; i < 512 * 512; i++) baseAlpha[i] = liveImgData.data[i * 4 + 3];
    drag = { erase: true, canvasPts: [pt], normPts: [canvasToImageNorm(pt[0], pt[1])] };
    paintLiveSegment(pt[0], pt[1], pt[0], pt[1]);
  } else {
    drag = { sx: e.clientX, sy: e.clientY, bx: S.ox, by: S.oy };
  }
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  positionBrush(e);
  if (!drag) return;
  if (drag.erase) {
    const pt = canvasPoint(e);
    const last = drag.canvasPts[drag.canvasPts.length - 1];
    if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) < 1.5) return;
    drag.canvasPts.push(pt);
    drag.normPts.push(canvasToImageNorm(pt[0], pt[1]));
    paintLiveSegment(last[0], last[1], pt[0], pt[1]);
    return;
  }
  if (drag.rot) {
    S.rot = normAngle(drag.base + (angleAt(e) - drag.a0));
    scheduleRender();
    return;
  }
  const k = 512 / canvas.getBoundingClientRect().width;
  S.ox = clampOff(drag.bx + Math.round((e.clientX - drag.sx) * k));
  S.oy = clampOff(drag.by + Math.round((e.clientY - drag.sy) * k));
  scheduleRender();
});
async function finishEraseStroke(d) {
  const stroke = {
    points: d.normPts,
    radius: (ER.size / 2) / (S.fitW * (S.scale / 100)),
    opacity: ER.opacity / 100,
    hardness: ER.hardness / 100,
  };
  try {
    eraserCount = await invoke("erase_stroke", { stroke });
    updateEraserBtns();
    scheduleRender();
  } catch (err) { setStatus("Eraser: " + err, "var(--danger)"); }
}
canvas.addEventListener("pointerup", () => {
  if (drag && drag.erase) finishEraseStroke(drag);
  drag = null;
});
canvas.addEventListener("pointercancel", () => { drag = null; });
canvas.addEventListener("pointerleave", () => { if (!drag) hideBrush(); });

async function doEraseUndo() {
  if (!S.loaded || eraserCount <= 0) return;
  try {
    eraserCount = await invoke("erase_undo");
    updateEraserBtns();
    scheduleRender();
  } catch (err) { setStatus("Undo: " + err, "var(--danger)"); }
}
async function doEraseReset() {
  if (!S.loaded || eraserCount <= 0) return;
  try {
    eraserCount = await invoke("erase_reset");
    updateEraserBtns();
    scheduleRender();
    setStatus("Eraser reset", "var(--fg-dim)");
  } catch (err) { setStatus("Reset: " + err, "var(--danger)"); }
}
$("er-undo-btn").addEventListener("click", doEraseUndo);
$("er-reset-btn").addEventListener("click", doEraseReset);

document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && document.activeElement?.tagName !== "INPUT") {
    if (!spaceHeld) { spaceHeld = true; syncCursorMode(); }
    if (activeTool === "eraser" && S.loaded) e.preventDefault();
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
    if (document.activeElement?.tagName !== "INPUT" && S.loaded && eraserCount > 0) {
      e.preventDefault();
      doEraseUndo();
    }
  }
});
document.addEventListener("keyup", (e) => {
  if (e.code === "Space") { spaceHeld = false; syncCursorMode(); }
});
canvas.addEventListener("wheel", (e) => {
  if (!S.loaded) return;
  e.preventDefault();
  const dy = e.deltaY;
  if (e.altKey) {
    S.rot = normAngle(S.rot + (dy > 0 ? 5 : -5));
  } else if (e.ctrlKey || e.metaKey) {
    S.scale = Math.max(50, Math.min(200, S.scale * (1 - dy * 0.01)));
  } else {
    const step = Math.abs(dy) >= 50 ? (dy > 0 ? -5 : 5) : Math.max(-3, Math.min(3, -dy * 0.15));
    S.scale = Math.max(50, Math.min(200, S.scale + step));
  }
  scheduleRender();
}, { passive: false });
canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (!S.loaded) return;
  S.ox = 0; S.oy = 0; S.rot = 0; scheduleRender();
});
dz.addEventListener("mouseenter", () => dz.classList.add("hover"));
dz.addEventListener("mouseleave", () => dz.classList.remove("hover"));

$("reset-btn").addEventListener("click", () => {
  S.b = S.c = S.s = 0; syncSliders(); scheduleRender();
});

async function withBusy(fn) {
  if (S.busy) return;
  S.busy = true; $("save-btn").disabled = true; $("export-btn").disabled = true;
  try { await fn(); } finally {
    S.busy = false;
    if (S.loaded) { $("save-btn").disabled = false; $("export-btn").disabled = false; }
  }
}
$("save-btn").addEventListener("click", () => withBusy(async () => {
  try { setStatus("Saved: " + (await invoke("save_sticker", { p: params() })), "var(--ok)"); }
  catch (e) { setStatus("Save failed: " + e, "var(--danger)"); }
}));
$("export-btn").addEventListener("click", () => withBusy(async () => {
  try { setStatus("Exported: " + (await invoke("export_original", { p: params() })), "var(--ok)"); }
  catch (e) { setStatus("Export failed: " + e, "var(--danger)"); }
}));

(async () => {
  try {
    const st = await invoke("initial_state");
    document.documentElement.dataset.theme = st.theme === "light" ? "light" : "dark";
    S.b = st.brightness; S.c = st.contrast; S.s = st.saturation;
    syncSliders();
    setStatus("Drop an image · v" + st.version, "var(--fg-muted)", "base");
  } catch { setStatus("IPC failed", "var(--danger)", "base"); }
  setUiEnabled(false);
})();


const CFG = { output_dir: "", theme: "dark", version: "2.0.0" };
$("about-daisy").src = daisyUrl;
invoke("initial_state").then((st) => {
  Object.assign(CFG, st);
  $("out-dir").value = CFG.output_dir;
  $("about-title").textContent = "Styx " + CFG.version;
  syncThemeSeg();
});

function openModal(id) {
  const ov = $(id);
  ov.hidden = false;
  requestAnimationFrame(() => ov.classList.add("open"));
}
function closeModal(id) {
  const ov = $(id);
  ov.classList.remove("open");
  setTimeout(() => { ov.hidden = true; }, 160);
}
function syncThemeSeg() {
  for (const b of $("theme-seg").children) {
    b.classList.toggle("active", b.dataset.themeVal === CFG.theme);
  }
}
async function applyTheme(t) {
  CFG.theme = t;
  document.documentElement.dataset.theme = t;
  syncThemeSeg();
  try { await invoke("set_theme", { theme: t }); }
  catch (e) { setStatus("Config: " + e, "var(--danger)"); }
}
async function applyDir(p) {
  CFG.output_dir = p;
  $("out-dir").value = p;
  try {
    await invoke("set_output_dir", { path: p });
    setStatus(p ? "Output folder set" : "Output folder reset", "var(--ok)");
  } catch (e) { setStatus("Config: " + e, "var(--danger)"); }
}
$("theme-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-theme-val]");
  if (b) applyTheme(b.dataset.themeVal);
});
$("browse-dir").addEventListener("click", async () => {
  const p = await open({ directory: true, multiple: false });
  if (p) applyDir(p);
});
$("reset-dir").addEventListener("click", () => applyDir(""));
function openSettings() {
  $("out-dir").value = CFG.output_dir;
  syncThemeSeg();
  openModal("settings-overlay");
}
$("settings-btn").addEventListener("click", openSettings);
$("about-btn").addEventListener("click", () => openModal("about-overlay"));
for (const b of document.querySelectorAll(".m-close")) {
  b.addEventListener("click", () => closeModal(b.dataset.close));
}
for (const ov of document.querySelectorAll(".overlay")) {
  ov.addEventListener("pointerdown", (e) => { if (e.target === ov) closeModal(ov.id); });
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    for (const ov of document.querySelectorAll(".overlay")) if (!ov.hidden) closeModal(ov.id);
  }
});
for (const a of document.querySelectorAll("a[data-url]")) {
  a.addEventListener("click", () => openUrl(a.dataset.url).catch(() => {}));
}


const MODEL = { present: false, downloading: false, running: false, hasNobg: false };
let rmGen = 0;
const removeLabel = (t) => { $("remove-btn").querySelector("span").textContent = t; };
function refreshRemove() {
  const b = $("remove-btn");
  b.classList.remove("btn-danger", "btn-ok");
  if (MODEL.running) {
    b.disabled = false; b.classList.add("btn-danger"); removeLabel("Cancel");
  } else if (!S.loaded || !MODEL.present) {
    b.disabled = true; removeLabel("Remove background");
  } else if (MODEL.hasNobg) {
    b.disabled = false; b.classList.add("btn-ok"); removeLabel("Restore background");
  } else {
    b.disabled = false; removeLabel("Remove background");
  }
}
const setSpin = (on) => { $("status-spin").hidden = !on; };
let procTimer = null, procSec = 0;
function startProcTimer() {
  procSec = 0;
  setStatus("Removing background… 0s", "var(--accent)", "base");
  setSpin(true);
  procTimer = setInterval(() => {
    procSec += 1;
    setStatus("Removing background… " + procSec + "s", "var(--accent)", "base");
  }, 1000);
}
function stopProcTimer() {
  clearInterval(procTimer); procTimer = null; setSpin(false);
}

listen("model://progress", (ev) => {
  const { pct, received, total } = ev.payload;
  $("dl-bar").hidden = false;
  $("dl-fill").style.width = pct + "%";
  const mb = (n) => (n / 1048576).toFixed(0);
  $("dl-note").textContent = total
    ? "Downloading… " + pct + "% (" + mb(received) + "/" + mb(total) + " MB)"
    : "Downloading… " + mb(received) + " MB";
});

async function refreshModel() {
  const st = await invoke("model_status");
  MODEL.present = st.present;
  $("dl-row").hidden = st.present;
  refreshRemove();
}
$("dl-btn").addEventListener("click", async () => {
  if (MODEL.downloading) return;
  MODEL.downloading = true;
  $("dl-btn").disabled = true;
  $("dl-cancel").hidden = false;
  $("dl-note").textContent = "Starting download…";
  try {
    await invoke("download_model");
    $("dl-note").textContent = "Model ready";
    setStatus("Model ready", "var(--ok)");
    await refreshModel();
  } catch (e) {
    $("dl-note").textContent = String(e) === "cancelled" ? "Cancelled" : "Download failed: " + e;
    $("dl-bar").hidden = true;
    $("dl-fill").style.width = "0";
  } finally {
    MODEL.downloading = false;
    $("dl-btn").disabled = false;
    $("dl-cancel").hidden = true;
  }
});
$("dl-cancel").addEventListener("click", () => invoke("cancel_download").catch(() => {}));

$("remove-btn").addEventListener("click", async () => {
  if (MODEL.running) {
    rmGen++;
    MODEL.running = false;
    stopProcTimer();
    refreshRemove();
    idleStatus();
    setStatus("Cancelled", "var(--fg-dim)");
    invoke("cancel_remove").catch(() => {});
    return;
  }
  if (!S.loaded || !MODEL.present) return;
  if (MODEL.hasNobg) {
    try {
      await invoke("restore_bg");
      MODEL.hasNobg = false;
      refreshRemove();
      scheduleRender();
      idleStatus();
      setStatus("Background restored", "var(--fg-dim)");
    } catch (e) { setStatus("Restore failed: " + e, "var(--danger)"); }
    return;
  }
  MODEL.running = true;
  const myGen = ++rmGen;
  refreshRemove();
  startProcTimer();
  try {
    await invoke("remove_bg");
    if (myGen !== rmGen) return;
    MODEL.hasNobg = true;
    scheduleRender();
    idleStatus();
    setStatus("Background removed", "var(--ok)");
  } catch (e) {
    if (myGen !== rmGen) return;
    idleStatus();
    setStatus(String(e) === "cancelled" ? "Cancelled" : "Error: " + e,
      String(e) === "cancelled" ? "var(--fg-dim)" : "var(--danger)");
  } finally {
    if (myGen !== rmGen) return;
    MODEL.running = false;
    stopProcTimer();
    refreshRemove();
  }
});

(async () => { await refreshModel(); })();

// ---- free rotation: trackpad two-finger rotate + Alt+drag ----
const normAngle = (a) => ((a + 180) % 360 + 360) % 360 - 180;
function angleAt(e) {
  const r = canvas.getBoundingClientRect();
  return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI;
}
let gestBase = 0;
let gestActive = false, gestScale = 100;
canvas.addEventListener("gesturestart", (e) => {
  e.preventDefault(); gestBase = S.rot; gestScale = S.scale; gestActive = true;
});
canvas.addEventListener("gesturechange", (e) => {
  e.preventDefault();
  if (!gestActive) return;
  if (e.rotation) S.rot = normAngle(gestBase + e.rotation);
  if (e.scale) S.scale = Math.max(50, Math.min(200, gestScale * e.scale));
  scheduleRender();
});
canvas.addEventListener("gestureend", (e) => { e.preventDefault(); gestActive = false; });
canvas.addEventListener("gesturecancel", (e) => { e.preventDefault(); gestActive = false; });

// Image center must stay on the 512 canvas: offsets clamped to +-256.
const clampOff = (v) => Math.max(-256, Math.min(256, v));

// ---- Help modal ----
$("help-btn").addEventListener("click", () => openModal("help-overlay"));
for (const b of document.querySelectorAll("#help-overlay .m-close")) {
  b.addEventListener("click", () => closeModal(b.dataset.close));
}
$("help-overlay").addEventListener("pointerdown", (e) => {
  if (e.target === $("help-overlay")) closeModal("help-overlay");
});


// ---- native macOS menu bar -> modals ----
listen("menu://action", (ev) => {
  const a = ev.payload;
  if (a === "about") openModal("about-overlay");
  else if (a === "settings") openSettings();
  else if (a === "help") openModal("help-overlay");
});
// ---- TEXT TOOL ENGINE ----
const TXT = {
  items: [],
  selectedId: null,
};
let textNextId = 1;

const FONT_META = {
  "Montserrat": { weights: [300, 400, 700, 900], def: 700 },
  "Oswald": { weights: [300, 400, 700], def: 700 },
  "Lora": { weights: [400, 700], def: 700 },
  "Comfortaa": { weights: [300, 400, 700], def: 700 },
  "Caveat": { weights: [400, 700], def: 700 },
  "Poiret One": { weights: [400], def: 400 },
  "Lobster": { weights: [400], def: 400 },
  "Press Start 2P": { weights: [400], def: 400 },
};
const WEIGHT_UI = {
  300: { label: "L", cls: "wt-light", title: "Weight: Light (click to cycle)" },
  400: { label: "R", cls: "wt-reg", title: "Weight: Regular (click to cycle)" },
  700: { label: "B", cls: "wt-bold", title: "Weight: Bold (click to cycle)" },
  900: { label: "B+", cls: "wt-black", title: "Weight: Black (click to cycle)" },
};

function getActiveText() {
  return TXT.items.find((it) => it.id === TXT.selectedId) || null;
}

function syncTextControls() {
  const item = getActiveText();
  const has = !!item;
  $("txt-font").disabled = !S.loaded || !has;
  $("txt-size").disabled = !S.loaded || !has;
  $("txt-op").disabled = !S.loaded || !has;
  $("txt-rot").disabled = !S.loaded || !has;
  $("txt-del-btn").disabled = !S.loaded || !has;
  $("txt-add-btn").disabled = !S.loaded;
  $("txt-style-btn").disabled = !S.loaded || !has;
  $("txt-color").disabled = !S.loaded || !has;
  if (!has) $("txt-weight-btn").disabled = true;

  if (item) {
    $("txt-font").value = item.font;
    $("txt-size").value = item.size;
    $("txt-size-val").textContent = item.size + " px";
    paint($("txt-size"));

    const op = item.opacity ?? 100;
    $("txt-op").value = op;
    $("txt-op-val").textContent = op + "%";
    paint($("txt-op"));

    const rdeg = Math.round(item.rot || 0);
    $("txt-rot").value = rdeg;
    $("txt-rot-val").textContent = (rdeg > 0 ? "+" : "") + rdeg + "°";
    $("txt-rot-val").classList.toggle("dim", rdeg === 0);
    paint($("txt-rot"));

    const btn = $("txt-style-btn");
    btn.className = "tg-style-btn";
    if (item.style === "pill-dark") {
      btn.classList.add("st-dark");
      btn.title = "Style: Dark fill (click to switch)";
    } else if (item.style === "pill-light") {
      btn.classList.add("st-light");
      btn.title = "Style: Light fill (click to switch)";
    } else {
      btn.classList.add("st-plain");
      btn.title = "Style: Plain (click to switch)";
    }

    $("txt-color").value = item.color;

    const meta = FONT_META[item.font] || { weights: [400], def: 400 };
    const w = meta.weights.includes(item.weight) ? item.weight : meta.def;
    item.weight = w;
    const wUi = WEIGHT_UI[w] || WEIGHT_UI[400];
    const wBtn = $("txt-weight-btn");
    wBtn.textContent = wUi.label;
    wBtn.className = "tg-style-btn " + wUi.cls;
    wBtn.disabled = !S.loaded || meta.weights.length <= 1;
    wBtn.title = meta.weights.length <= 1 ? "Single weight font" : wUi.title;
  }
}
const inlineEditor = $("sticker-inline-editor");
let editingItemId = null;

function placeCaretAtEnd(el) {
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function updateInlineEditorStyle(item) {
  if (!item) return;
  const dr = dz.getBoundingClientRect();
  const k = dr.width / 512;
  const x = item.x * k;
  const y = item.y * k;
  const sz = item.size * k;

  const mctx = document.createElement("canvas").getContext("2d");
  const w = item.weight || 400;
  mctx.font = `${w} ${sz}px '${item.font}', sans-serif`;
  const lines = (item.text && item.text.trim() ? item.text : "Type text…").split("\n");
  let maxW = 0;
  for (const ln of lines) {
    const w = mctx.measureText(ln).width;
    if (w > maxW) maxW = w;
  }
  const padX = Math.round(sz * 0.28);
  const padY = Math.round(sz * 0.14);
  const snugW = Math.max(48, Math.ceil(maxW + padX * 2 + 8));

  inlineEditor.style.left = x + "px";
  inlineEditor.style.top = y + "px";
  inlineEditor.style.width = snugW + "px";
  inlineEditor.style.maxWidth = (dr.width * 0.94) + "px";
  inlineEditor.style.transform = `translate(-50%, -50%) rotate(${item.rot || 0}deg)`;
  inlineEditor.style.font = `${w} ${sz}px '${item.font}', sans-serif`;
  inlineEditor.style.padding = `${padY}px ${padX}px`;

  const op = (item.opacity ?? 100) / 100;
  if (item.style === "pill-dark") {
    inlineEditor.style.opacity = "1";
    inlineEditor.style.background = `rgba(0,0,0,${op.toFixed(2)})`;
    inlineEditor.style.borderRadius = (sz * 0.22) + "px";
    inlineEditor.style.color = item.color.toLowerCase() === "#000000" ? "#ffffff" : item.color;
    inlineEditor.style.webkitTextStroke = "none";
    inlineEditor.style.textShadow = "none";
    inlineEditor.style.boxShadow = "none";
  } else if (item.style === "pill-light") {
    inlineEditor.style.opacity = "1";
    inlineEditor.style.background = `rgba(255,255,255,${op.toFixed(2)})`;
    inlineEditor.style.borderRadius = (sz * 0.22) + "px";
    inlineEditor.style.color = item.color.toLowerCase() === "#ffffff" ? "#000000" : item.color;
    inlineEditor.style.webkitTextStroke = "none";
    inlineEditor.style.textShadow = "none";
    inlineEditor.style.boxShadow = `0 2px 10px rgba(0,0,0,${(0.25 * op).toFixed(2)})`;
  } else {
    inlineEditor.style.opacity = String(op);
    inlineEditor.style.background = "transparent";
    inlineEditor.style.borderRadius = "0";
    inlineEditor.style.boxShadow = "none";
    inlineEditor.style.webkitTextStroke = "none";
    inlineEditor.style.color = item.color;
    inlineEditor.style.textShadow = "none";
  }
}

function openInlineEditor(item) {
  if (!item || !S.loaded) return;
  editingItemId = item.id;
  TXT.selectedId = item.id;
  inlineEditor.innerText = item.text;
  updateInlineEditorStyle(item);
  inlineEditor.hidden = false;
  renderTextLayer();
  requestAnimationFrame(() => placeCaretAtEnd(inlineEditor));
}

function closeInlineEditor() {
  if (editingItemId == null) return;
  const it = TXT.items.find((x) => x.id === editingItemId);
  if (it) {
    it.text = inlineEditor.innerText.replace(/\r\n/g, "\n").trim();
    if (!it.text) {
      TXT.items = TXT.items.filter((x) => x.id !== it.id);
      TXT.selectedId = TXT.items.length ? TXT.items[TXT.items.length - 1].id : null;
    }
  }
  editingItemId = null;
  inlineEditor.hidden = true;
  syncTextControls();
  renderTextLayer();
}

inlineEditor.addEventListener("input", () => {
  const it = getActiveText();
  if (it) {
    const raw = inlineEditor.innerText.replace(/\r\n/g, "\n");
    it.text = raw.trim() ? raw : "";
    if (!it.text && inlineEditor.innerHTML) inlineEditor.innerHTML = "";
    updateInlineEditorStyle(it);
    renderTextLayer();
  }
});

inlineEditor.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeInlineEditor();
});

function measureTextBlock(c, item) {
  c.save();
  c.font = `${item.weight || 400} ${item.size}px '${item.font}', sans-serif`;
  const sample = item.text && item.text.trim() ? item.text : (editingItemId === item.id ? "Type text…" : " ");
  const lines = sample.split("\n");
  const lineH = item.size * 1.18;
  let maxW = 0;
  for (const ln of lines) {
    const w = c.measureText(ln).width;
    if (w > maxW) maxW = w;
  }
  c.restore();
  const padX = Math.round(item.size * 0.28);
  const padY = Math.round(item.size * 0.14);
  const boxW = Math.max(40, maxW + padX * 2);
  const boxH = Math.max(lineH, lines.length * lineH + padY * 2);
  return { lines, lineH, boxW, boxH };
}

function drawRoundRect(c, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rad, y);
  c.arcTo(x + w, y, x + w, y + h, rad);
  c.arcTo(x + w, y + h, x, y + h, rad);
  c.arcTo(x, y + h, x, y, rad);
  c.arcTo(x, y, x + w, y, rad);
  c.closePath();
}

function drawTextBlock(c, item, interactive) {
  const { lines, lineH, boxW, boxH } = measureTextBlock(c, item);
  const hw = boxW / 2;
  const hh = boxH / 2;
  const isEditing = interactive && editingItemId === item.id;

  c.save();
  c.translate(item.x, item.y);
  c.rotate(((item.rot || 0) * Math.PI) / 180);

  if (!isEditing) {
    c.font = `${item.weight || 400} ${item.size}px '${item.font}', sans-serif`;
    c.textAlign = "center";
    c.textBaseline = "middle";

    const op = (item.opacity ?? 100) / 100;
    let textColor = item.color;
    if (item.style === "pill-dark") {
      c.save();
      drawRoundRect(c, -hw, -hh, boxW, boxH, item.size * 0.22);
      c.fillStyle = `rgba(0,0,0,${op.toFixed(2)})`;
      c.fill();
      c.restore();
      if (textColor.toLowerCase() === "#000000") textColor = "#ffffff";
    } else if (item.style === "pill-light") {
      c.save();
      c.shadowColor = `rgba(0,0,0,${(0.25 * op).toFixed(2)})`;
      c.shadowBlur = 10;
      c.shadowOffsetY = 2;
      drawRoundRect(c, -hw, -hh, boxW, boxH, item.size * 0.22);
      c.fillStyle = `rgba(255,255,255,${op.toFixed(2)})`;
      c.fill();
      c.restore();
      if (textColor.toLowerCase() === "#ffffff") textColor = "#000000";
    }

    c.save();
    if (item.style === "plain") c.globalAlpha = op;
    const totalH = (lines.length - 1) * lineH;
    for (let i = 0; i < lines.length; i++) {
      const ly = -totalH / 2 + i * lineH;
      const ln = lines[i];
      c.fillStyle = textColor;
      c.fillText(ln, 0, ly);
    }
    c.restore();
  }

  if (interactive && activeTool === "text" && item.id === TXT.selectedId) {
    const pad = 4;
    const fx = -hw - pad;
    const fy = -hh - pad;
    const fw = boxW + pad * 2;
    const fh = boxH + pad * 2;
    const stemY = fy - 22;

    c.save();
    c.strokeStyle = "rgba(255,255,255,0.9)";
    c.lineWidth = 1.5;
    c.shadowColor = "rgba(0,0,0,0.55)";
    c.shadowBlur = 3;
    c.setLineDash([5, 4]);
    c.strokeRect(fx, fy, fw, fh);
    c.setLineDash([]);

    c.beginPath();
    c.moveTo(0, fy);
    c.lineTo(0, stemY);
    c.stroke();

    const drawHandle = (hx, hy, r, fill) => {
      c.beginPath();
      c.arc(hx, hy, r, 0, Math.PI * 2);
      c.fillStyle = fill;
      c.fill();
      c.strokeStyle = "#ffffff";
      c.lineWidth = 1.5;
      c.stroke();
    };

    drawHandle(0, stemY, 6, "#6366f1");
    drawHandle(fx, fy, 5, "#6366f1");
    drawHandle(fx + fw, fy, 5, "#6366f1");
    drawHandle(fx + fw, fy + fh, 5, "#6366f1");
    drawHandle(fx, fy + fh, 5, "#6366f1");
    c.restore();
  }

  c.restore();
}

function addTextItem(text = "TEXT", x = 256, y = 256, edit = false) {
  closeInlineEditor();
  const font = "Montserrat";
  const meta = FONT_META[font] || { weights: [400], def: 400 };
  const item = {
    id: textNextId++,
    text,
    x,
    y,
    font,
    weight: meta.def,
    opacity: 100,
    size: 48,
    rot: 0,
    style: "pill-light",
    color: "#000000",
  };
  TXT.items.push(item);
  TXT.selectedId = item.id;
  syncTextControls();
  document.fonts.load(`${item.weight} ${item.size}px "${item.font}"`).then(() => renderTextLayer());
  renderTextLayer();
  if (edit) openInlineEditor(item);
  return item;
}

function deleteActiveText() {
  const item = getActiveText();
  if (!item) return;
  if (editingItemId === item.id) {
    editingItemId = null;
    inlineEditor.hidden = true;
  }
  TXT.items = TXT.items.filter((x) => x.id !== item.id);
  TXT.selectedId = TXT.items.length ? TXT.items[TXT.items.length - 1].id : null;
  syncTextControls();
  renderTextLayer();
}

function hitTestTextFull(cx, cy) {
  if (!S.loaded || activeTool !== "text") return null;
  for (let i = TXT.items.length - 1; i >= 0; i--) {
    const item = TXT.items[i];
    const { boxW, boxH } = measureTextBlock(textCtx, item);
    const pad = 4;
    const hw = boxW / 2 + pad;
    const hh = boxH / 2 + pad;
    const rad = (-(item.rot || 0) * Math.PI) / 180;
    const dx = cx - item.x;
    const dy = cy - item.y;
    const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
    const ly = dx * Math.sin(rad) + dy * Math.cos(rad);

    if (item.id === TXT.selectedId) {
      if (Math.hypot(lx, ly - (-hh - 22)) <= 13) return { item, part: "rot" };
      for (const [hx, hy] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
        if (Math.hypot(lx - hx, ly - hy) <= 12) return { item, part: "scale" };
      }
    }
    if (Math.abs(lx) <= hw && Math.abs(ly) <= hh) return { item, part: "move" };
  }
  return null;
}

function hitTestText(cx, cy) {
  const hit = hitTestTextFull(cx, cy);
  return hit ? hit.item : null;
}

let textDrag = null;

function renderTextLayer() {
  textCtx.clearRect(0, 0, 512, 512);
  if (!S.loaded) return;
  for (const item of TXT.items) drawTextBlock(textCtx, item, true);
}

function getTextPngBase64() {
  closeInlineEditor();
  if (!TXT.items.length) return null;
  const off = document.createElement("canvas");
  off.width = 512; off.height = 512;
  const octx = off.getContext("2d");
  for (const item of TXT.items) drawTextBlock(octx, item, false);
  return off.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}

$("txt-font").addEventListener("change", async (e) => {
  const item = getActiveText();
  if (!item) return;
  item.font = e.target.value;
  const meta = FONT_META[item.font] || { weights: [400], def: 400 };
  if (!meta.weights.includes(item.weight)) {
    item.weight = meta.def;
  }
  syncTextControls();
  await document.fonts.load(`${item.weight} ${item.size}px "${item.font}"`);
  if (editingItemId === item.id) updateInlineEditorStyle(item);
  renderTextLayer();
});
$("txt-weight-btn").addEventListener("click", async () => {
  const item = getActiveText();
  if (!item) return;
  const meta = FONT_META[item.font] || { weights: [400], def: 400 };
  if (meta.weights.length <= 1) return;
  const idx = meta.weights.indexOf(item.weight);
  item.weight = meta.weights[(idx + 1) % meta.weights.length];
  syncTextControls();
  await document.fonts.load(`${item.weight} ${item.size}px "${item.font}"`);
  if (editingItemId === item.id) updateInlineEditorStyle(item);
  renderTextLayer();
});
$("txt-add-btn").addEventListener("click", () => addTextItem("", 256, 256, true));
$("txt-del-btn").addEventListener("click", deleteActiveText);
$("txt-color").addEventListener("input", (e) => {
  const item = getActiveText();
  if (!item) return;
  item.color = e.target.value;
  if (editingItemId === item.id) updateInlineEditorStyle(item);
  renderTextLayer();
});

textCanvas.addEventListener("pointerdown", (e) => {
  if (!S.loaded || activeTool !== "text" || e.button !== 0) return;
  const [cx, cy] = canvasPoint(e);
  const target = hitTestTextFull(cx, cy);
  if (!target) {
    closeInlineEditor();
    return;
  }
  if (editingItemId != null && editingItemId !== target.item.id) {
    closeInlineEditor();
  }
  TXT.selectedId = target.item.id;
  syncTextControls();
  renderTextLayer();

  if (target.part === "rot") {
    const a0 = (Math.atan2(cy - target.item.y, cx - target.item.x) * 180) / Math.PI;
    textDrag = { item: target.item, mode: "rot", moved: false, baseRot: target.item.rot || 0, a0 };
  } else if (target.part === "scale") {
    const baseDist = Math.hypot(cx - target.item.x, cy - target.item.y) || 1;
    textDrag = { item: target.item, mode: "scale", moved: false, baseSize: target.item.size, baseDist };
  } else {
    textDrag = { item: target.item, mode: "move", moved: false, dx: cx - target.item.x, dy: cy - target.item.y };
  }
  textCanvas.setPointerCapture?.(e.pointerId);
});

textCanvas.addEventListener("pointermove", (e) => {
  const [cx, cy] = canvasPoint(e);

  if (!textDrag) {
    const target = hitTestTextFull(cx, cy);
    if (!target) {
      textCanvas.style.cursor = "default";
    } else if (target.part === "rot") {
      textCanvas.style.cursor = "crosshair";
    } else if (target.part === "scale") {
      textCanvas.style.cursor = "nwse-resize";
    } else {
      textCanvas.style.cursor = "grab";
    }
    return;
  }

  textDrag.moved = true;
  if (editingItemId === textDrag.item.id) closeInlineEditor();

  if (textDrag.mode === "rot") {
    textCanvas.style.cursor = "crosshair";
    const curA = (Math.atan2(cy - textDrag.item.y, cx - textDrag.item.x) * 180) / Math.PI;
    textDrag.item.rot = normAngle(textDrag.baseRot + (curA - textDrag.a0));
    syncTextControls();
    renderTextLayer();
  } else if (textDrag.mode === "scale") {
    textCanvas.style.cursor = "nwse-resize";
    const curDist = Math.hypot(cx - textDrag.item.x, cy - textDrag.item.y);
    const ratio = curDist / (textDrag.baseDist || 1);
    const newSize = Math.max(16, Math.min(120, Math.round(textDrag.baseSize * ratio)));
    textDrag.item.size = newSize;
    syncTextControls();
    renderTextLayer();
  } else {
    textCanvas.style.cursor = "grabbing";
    textDrag.item.x = Math.max(10, Math.min(502, Math.round(cx - textDrag.dx)));
    textDrag.item.y = Math.max(10, Math.min(502, Math.round(cy - textDrag.dy)));
    renderTextLayer();
  }
});

textCanvas.addEventListener("pointerup", () => {
  if (textDrag && !textDrag.moved && textDrag.mode === "move") {
    openInlineEditor(textDrag.item);
  }
  textDrag = null;
  textCanvas.style.cursor = "default";
});

textCanvas.addEventListener("pointercancel", () => { textDrag = null; });
textCanvas.addEventListener("contextmenu", (e) => {
  if (!S.loaded || activeTool !== "text") return;
  const [cx, cy] = canvasPoint(e);
  const hit = hitTestText(cx, cy);
  if (hit) {
    e.preventDefault();
    hit.rot = 0;
    renderTextLayer();
  }
});

let textGestBase = 0;
textCanvas.addEventListener("gesturestart", (e) => {
  if (!S.loaded || activeTool !== "text") return;
  const item = getActiveText();
  if (item) { e.preventDefault(); textGestBase = item.rot || 0; }
});
textCanvas.addEventListener("gesturechange", (e) => {
  if (!S.loaded || activeTool !== "text") return;
  const item = getActiveText();
  if (item && e.rotation != null) {
    e.preventDefault();
    item.rot = normAngle(textGestBase + e.rotation);
    renderTextLayer();
  }
});
textCanvas.addEventListener("wheel", (e) => {
  if (!S.loaded || activeTool !== "text") return;
  const item = getActiveText();
  if (!item) return;
  e.preventDefault();
  if (e.altKey) {
    item.rot = normAngle((item.rot || 0) + (e.deltaY > 0 ? 5 : -5));
  } else {
    const step = e.deltaY > 0 ? -2 : 2;
    item.size = Math.max(16, Math.min(120, item.size + step));
    $("txt-size").value = item.size;
    $("txt-size-val").textContent = item.size + " px";
    paint($("txt-size"));
  }
  renderTextLayer();
}, { passive: false });

textCanvas.addEventListener("dblclick", (e) => {
  if (!S.loaded || activeTool !== "text") return;
  const [cx, cy] = canvasPoint(e);
  const hit = hitTestText(cx, cy);
  if (hit) openInlineEditor(hit);
});


$("txt-rot-val").addEventListener("click", () => {
  const it = getActiveText();
  if (it) {
    it.rot = 0;
    syncTextControls();
    if (editingItemId === it.id) updateInlineEditorStyle(it);
    renderTextLayer();
  }
});
