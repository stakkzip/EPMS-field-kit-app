/* EPMS Field Manuals: offline search, saved manuals, PDF viewer, firmware status, sync. */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
const MANUALS_CACHE = "manuals";
const STALE_DAYS = 14, OLD_DAYS = 30;
const DAY = 864e5;

let LIB = null, FW = null, worker = null, workerReady = false, reqId = 0;
let saved = new Map();                                   // file -> sha of the copy on this phone
let savedDevices = new Set(store.get("savedDevices", []));
let keepAll = store.get("keepAll", false);      // "Save all" was tapped: also save manuals added later
let busy = false;

/* ---------- helpers ---------- */
function toast(msg, ms = 2600) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => t.hidden = true, ms); }
function fmtMB(b) { return b >= 1e6 ? (b / 1e6).toFixed(b >= 1e8 ? 0 : 1) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB"; }
function ago(t) {
  if (!t) return "never";
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  if (s < 90) return "just now"; if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " hr ago"; const d = Math.round(s / 86400); return d + (d === 1 ? " day ago" : " days ago");
}
function fmtDate(t) { try { return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); } catch { return t; } }
const devById = (id) => LIB?.devices.find(d => d.id === id);
function docInfo(file) { for (const d of LIB?.devices || []) for (const x of d.docs) if (x.file === file) return { dev: d, doc: x }; return null; }
const revTag = (x) => x?.rev ? `<span class="rev${/^undated/i.test(x.rev) ? " undated" : ""}">${esc(x.rev)}</span>` : "";
const manualURL = (file) => new URL("manuals/" + encodeURIComponent(file), location.href).href;

async function getJSON(path) {
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(path + " " + r.status);
  const data = await r.json();
  if (data && data.offline) throw new Error("offline");
  return { data, cached: r.headers.get("X-From-Cache") === "1" };
}

/* ---------- tabs ---------- */
function show(v) {
  document.querySelectorAll("main > section").forEach(s => s.hidden = s.id !== "v-" + v);
  document.querySelectorAll("nav button").forEach(b => b.setAttribute("aria-selected", b.dataset.v === v));
  store.set("tab", v);
  document.body.classList.toggle("asking", v === "ask"); $("#composer").hidden = v !== "ask";
  if (v === "ask") renderChat();
  if (v === "firmware") { store.set("fwSeen", new Date().toISOString()); renderFwBadge(); }
  window.scrollTo(0, 0);
}
document.querySelectorAll("nav button").forEach(b => b.onclick = () => show(b.dataset.v));

/* ---------- sync status ---------- */
function renderSync() {
  const el = $("#sync"), txt = $("#syncText");
  const last = store.get("lastSync", null), age = last ? (Date.now() - new Date(last)) / DAY : Infinity;
  el.className = "sync" + (navigator.onLine && age < 1 ? " on" : age > OLD_DAYS ? " old" : age > STALE_DAYS ? " stale" : "");
  const lib = LIB ? ` · library ${fmtDate(LIB.built)}` : "";
  txt.textContent = (navigator.onLine ? "Synced " + ago(last) : "Offline · synced " + ago(last)) + lib;
}
setInterval(renderSync, 60000);
window.addEventListener("online", () => { renderSync(); sync(false); });
let lastCheck = 0;
function checkForUpdates(minMinutes) {
  if (!navigator.onLine || Date.now() - lastCheck < minMinutes * 60000) return;
  lastCheck = Date.now(); sync(false);
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { renderSync(); checkForUpdates(15); } });
window.addEventListener("pageshow", (e) => { if (e.persisted) checkForUpdates(15); });
setInterval(() => { if (document.visibilityState === "visible") checkForUpdates(30); }, 5 * 60000);
window.addEventListener("offline", renderSync);
$("#syncBtn").onclick = () => sync(true);

/* ---------- banners ---------- */
function renderBanners() {
  const out = [];
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (isIOS && !standalone) out.push(`<div class="banner warn"><b>Add this app to your Home Screen</b><span class="small">On iPhone, saved manuals are only kept reliably when the app is on the Home Screen. Tap the Share button, then <b>Add to Home Screen</b>, and open it from there.</span></div>`);
  if (LIB && saved.size === 0) {
    const total = LIB.devices.flatMap(d => d.docs).reduce((a, d) => a + (d.bytes || 0), 0);
    out.push(`<div class="banner"><b>Save manuals for no-signal areas</b><span class="small">Nothing is saved on this phone yet. Save every manual (${fmtMB(total)}) now while you have signal, or pick devices in the Manuals tab.</span><div class="row"><button class="btn primary" data-act="saveall" type="button">Save all manuals</button><button class="btn" data-act="pick" type="button">Pick devices</button></div></div>`);
  }
  const last = store.get("lastSync", null), age = last ? (Date.now() - new Date(last)) / DAY : Infinity;
  if (last && age > STALE_DAYS) out.push(`<div class="banner ${age > OLD_DAYS ? "bad" : "warn"}"><b>Library last updated ${ago(last)}</b><span class="small">Manuals and firmware info may be out of date. Connect to Wi-Fi or signal and tap Sync.</span></div>`);
  const outdated = [...saved].filter(([f, sha]) => { const i = docInfo(f); return i && i.doc.sha && i.doc.sha !== sha; }).length;
  if (outdated && navigator.onLine) out.push(`<div class="banner"><b>${outdated} saved manual${outdated > 1 ? "s have" : " has"} a newer version</b><div class="row"><button class="btn primary" data-act="update" type="button">Update now</button></div></div>`);
  $("#banners").innerHTML = out.join("");
  $("#banners").querySelectorAll("[data-act]").forEach(b => b.onclick = () => {
    const a = b.dataset.act;
    if (a === "saveall") saveAllManuals();
    if (a === "pick") show("library");
    if (a === "update") saveDevices([...savedDevices]);
  });
}

/* ---------- saved manuals ---------- */
async function reconcileSaved() {
  saved = new Map(Object.entries(store.get("savedManuals", {})));
  if (!("caches" in window)) return;
  const c = await caches.open(MANUALS_CACHE);
  for (const f of [...saved.keys()]) if (!(await c.match(manualURL(f)))) saved.delete(f);
  store.set("savedManuals", Object.fromEntries(saved));
}
function devState(d) {
  if (!d.docs.length) return "empty";
  const have = d.docs.filter(x => saved.has(x.file));
  if (!have.length) return "none";
  if (have.length < d.docs.length) return "part";
  return have.some(x => x.sha && saved.get(x.file) !== x.sha) ? "update" : "saved";
}
async function saveDoc(c, x, force) {
  const url = manualURL(x.file);
  if (!force && saved.get(x.file) === x.sha && await c.match(url)) return 0;
  await c.delete(url);   // so the service worker can't hand back the old copy
  const r = await fetch(url + "?v=" + (x.sha || Date.now()), { cache: "no-store" });
  if (!r.ok) throw new Error(x.file + " (" + r.status + ")");
  await c.put(url, r);
  saved.set(x.file, x.sha || ""); store.set("savedManuals", Object.fromEntries(saved));
  return x.bytes || 0;
}
async function saveDevices(ids) {
  if (busy) return; if (!("caches" in window)) { toast("This browser can't save manuals offline."); return; }
  if (!navigator.onLine) { toast("Connect to the internet to save manuals."); return; }
  busy = true; renderLibrary();
  try { await navigator.storage?.persist?.(); } catch {}
  const c = await caches.open(MANUALS_CACHE);
  ids.forEach(id => savedDevices.add(id)); store.set("savedDevices", [...savedDevices]);
  const docs = ids.flatMap(id => devById(id)?.docs || []).filter(x => !(saved.get(x.file) === x.sha));
  const total = docs.reduce((a, x) => a + (x.bytes || 0), 0); let done = 0, fails = 0;
  for (const x of docs) {
    $("#dlStatus").textContent = `Saving ${fmtMB(done)} of ${fmtMB(total)}…`;
    try { await saveDoc(c, x, true); } catch { fails++; }
    done += x.bytes || 0; renderLibrary();
  }
  busy = false;
  $("#dlStatus").textContent = fails ? `${fails} manual${fails > 1 ? "s" : ""} didn't download. Tap Save all to retry.` : "";
  if (docs.length) toast(fails ? "Some manuals didn't save. Check your connection." : `Saved ${docs.length} manual${docs.length > 1 ? "s" : ""} to this phone`);
  renderLibrary(); renderBanners(); rerunSearch();
}
async function removeDevices(ids) {
  if (busy) return;
  if (keepAll) { keepAll = false; store.set("keepAll", false); }   // removing anything ends "keep everything"
  const c = await caches.open(MANUALS_CACHE);
  for (const id of ids) {
    savedDevices.delete(id);
    for (const x of devById(id)?.docs || []) { await c.delete(manualURL(x.file)); saved.delete(x.file); }
  }
  store.set("savedDevices", [...savedDevices]); store.set("savedManuals", Object.fromEntries(saved));
  renderLibrary(); renderBanners(); rerunSearch();
}
function saveAllManuals() { keepAll = true; store.set("keepAll", true); saveDevices(LIB.devices.map(d => d.id)); }
$("#saveAll").onclick = saveAllManuals;
let removeArmed = 0;
$("#removeAll").onclick = () => {
  if (Date.now() - removeArmed > 4000) { removeArmed = Date.now(); toast("Tap Remove all again to delete every saved manual from this phone."); return; }
  removeArmed = 0; removeDevices(LIB.devices.map(d => d.id));
};

function renderLibrary() {
  if (!LIB) return;
  const all = LIB.devices.flatMap(d => d.docs);
  const total = all.reduce((a, x) => a + (x.bytes || 0), 0);
  const have = all.filter(x => saved.has(x.file)), haveB = have.reduce((a, x) => a + (x.bytes || 0), 0);
  $("#libSummary").innerHTML = `<b>${have.length} of ${all.length}</b> manuals saved · ${fmtMB(haveB)} of ${fmtMB(total)}`;
  $("#libVersion").textContent = "Library " + fmtDate(LIB.built) + (keepAll ? " · new manuals save automatically" : "");
  $("#libMeter").style.width = (total ? haveB / total * 100 : 0) + "%";
  $("#saveAll").disabled = busy || have.length === all.length; $("#removeAll").disabled = busy || !have.length;
  const label = { saved: "Saved", part: "Partly saved", none: "Not saved", update: "Update ready", empty: "No manuals" };
  const cls = { saved: "saved", part: "part", none: "none", update: "part", empty: "none" };
  const cats = [...new Set([...(LIB.categories || []), ...LIB.devices.map(d => d.category)])];
  $("#lib").innerHTML = cats.map(cat => {
    const devs = LIB.devices.filter(d => d.category === cat);
    if (!devs.length) return cat === "Breakers" ? `<div class="cat"><span class="label">${esc(cat)}</span><div class="empty small">No breaker manuals yet. Add them to the library on the Mac and they'll show up here after the next sync.</div></div>` : "";
    return `<div class="cat"><span class="label">${esc(cat)}</span>${devs.map(d => {
      const st = devState(d), size = d.docs.reduce((a, x) => a + (x.bytes || 0), 0);
      const btn = st === "empty" ? "" : (st === "saved" ? `<button class="btn" data-rm="${d.id}" type="button" ${busy ? "disabled" : ""}>Remove</button>` : `<button class="btn primary" data-sv="${d.id}" type="button" ${busy ? "disabled" : ""}>${st === "update" ? "Update" : "Save"} · ${fmtMB(size)}</button>`);
      return `<div class="devcard"><div class="dhead"><div><h3>${esc(d.name)}</h3><div class="small muted">${esc(d.maker)} · ${esc(d.kind)}</div></div><span class="state ${cls[st]}">${label[st]}</span></div>
        ${d.docs.length ? `<div class="docs">${d.docs.map(x => `<button class="doc" data-open="${esc(x.file)}" type="button"><span class="t">${esc(x.title)} <span class="small muted">· ${esc(x.type)}</span>${revTag(x)}</span><span class="m">${x.pages || "?"} p · ${fmtMB(x.bytes || 0)}${saved.has(x.file) ? " ✓" : ""}</span></button>`).join("")}</div>` : `<div class="small muted">No manuals added for this device yet.</div>`}
        ${btn ? `<div class="row">${btn}</div>` : ""}</div>`;
    }).join("")}</div>`;
  }).join("");
  $("#lib").querySelectorAll("[data-sv]").forEach(b => b.onclick = () => saveDevices([b.dataset.sv]));
  $("#lib").querySelectorAll("[data-rm]").forEach(b => b.onclick = () => removeDevices([b.dataset.rm]));
  $("#lib").querySelectorAll("[data-open]").forEach(b => b.onclick = () => openViewer(b.dataset.open, 1, []));
}

/* ---------- search ---------- */
const TIPS = ["modbus address", "baud rate parity", "factory reset", "default ip address", "rs485 termination", "led error codes", "time sync ntp", "ct ratio"];
function startWorker() {
  if (worker) worker.terminate();
  workerReady = false; $("#qInfo").textContent = "Loading search…";
  worker = new Worker("search-worker.js");
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "ready") { workerReady = true; $("#qInfo").textContent = `${m.pages.toLocaleString()} pages searchable`; rerunSearch(); }
    else if (m.type === "results" && m.id === reqId) renderResults(m);
    else if (m.type === "passages" && askWaiters.has(m.id)) { askWaiters.get(m.id)(m); askWaiters.delete(m.id); }
    else if (m.type === "error") $("#qInfo").textContent = navigator.onLine ? "Search couldn't load. Tap Sync." : "Search data isn't on this phone yet. Open the app once with signal.";
  };
  worker.postMessage({ type: "load", url: new URL("data/pages.json", location.href).href, devices: LIB?.devices || [], id: 0 });
}
function renderDevFilter() {
  const sel = $("#qDev"), cur = sel.value;
  sel.innerHTML = `<option value="">All devices</option>` + (LIB?.devices || []).filter(d => d.docs.length).map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join("");
  sel.value = cur;
}
function runSearch() {
  const q = $("#q").value.trim();
  if (!q) { renderTips(); $("#results").innerHTML = ""; return; }
  $("#tips").innerHTML = "";
  if (!workerReady) return;
  worker.postMessage({ type: "search", q, device: $("#qDev").value, id: ++reqId });
}
function rerunSearch() { if ($("#q").value.trim()) runSearch(); else renderTips(); }
let qTimer; $("#q").addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(runSearch, 140); });
$("#q").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(qTimer); runSearch(); rememberQuery(); $("#q").blur(); } });
$("#qDev").onchange = runSearch;
function rememberQuery() { const q = $("#q").value.trim(); if (q.length < 2) return; const r = store.get("recent", []).filter(x => x !== q); r.unshift(q); store.set("recent", r.slice(0, 6)); }
function renderTips() {
  const recent = store.get("recent", []);
  const chips = (arr) => arr.map(t => `<button type="button" data-q="${esc(t)}">${esc(t)}</button>`).join("");
  $("#tips").innerHTML = (recent.length ? `<span class="label" style="width:100%">Recent</span>${chips(recent)}` : "") + `<span class="label" style="width:100%;margin-top:6px">Try</span>${chips(TIPS)}`;
  $("#tips").querySelectorAll("[data-q]").forEach(b => b.onclick = () => { $("#q").value = b.dataset.q; runSearch(); });
}
let lastWords = [];
function markSnip(s) {
  let out = "", at = 0;
  for (const [i, n] of s.marks.sort((a, b) => a[0] - b[0])) { if (i < at) continue; out += esc(s.text.slice(at, i)) + "<mark>" + esc(s.text.slice(i, i + n)) + "</mark>"; at = i + n; }
  return (s.pre ? "… " : "") + out + esc(s.text.slice(at)) + (s.post ? " …" : "");
}
const GRADE = { answer: ["Value found", "g-answer"], strong: ["Strong match", "g-strong"], match: ["Match", "g-match"], partial: ["Partial match", "g-partial"] };
const gradeChip = (g) => GRADE[g] ? `<span class="grade ${GRADE[g][1]}">${GRADE[g][0]}</span>` : "";
function answerCard(r, devName, docTitle, rev) {
  return `<div class="anscard"><span class="label">${esc(r.answer.label)}</span><span class="ansval">${esc(r.answer.value)}</span>
    <span class="small muted">${esc(devName)} · ${esc(docTitle)} · p. ${r.page}${rev ? " · " + esc(rev) : ""}. Check the page, and use the client's point list for site values.</span></div>`;
}
function missingNote(m) {
  const d = devById(m.named);
  if (!m.namedMissing || !d) return "";
  return `<div class="banner warn small">${d.docs.length ? `Nothing in the ${esc(d.name)} manuals matched. These results are from other devices.` : `There are no ${esc(d.name)} manuals in the library yet. These results are from other devices.`}</div>`;
}
function renderResults(m) {
  lastWords = m.words;
  const R = $("#results");
  if (!m.results.length) { R.innerHTML = `<div class="empty">No matches for “${esc(m.q)}”. Try fewer or different words, or a register number.</div>`; $("#qInfo").textContent = ""; return; }
  const pref = m.prefer && devById(m.prefer);
  $("#qInfo").textContent = `${m.total.toLocaleString()} pages match` + (pref && !m.namedMissing ? ` · ${pref.name} first` : "");
  const top = m.results[0], topInfo = docInfo(top.file);
  const head = missingNote(m) + (top.answer && !m.namedMissing ? answerCard(top, topInfo?.dev.name || top.device, topInfo?.doc.title || top.file, topInfo?.doc.rev) : "");
  R.innerHTML = head + m.results.map((r, i) => {
    const info = docInfo(r.file), d = info?.dev;
    const off = !saved.has(r.file) && !navigator.onLine;
    return `<button class="hit" data-i="${i}" type="button"><div class="hmeta"><span class="dev">${esc(d?.name || r.device)}</span><span class="muted">${esc(info?.doc.title || r.file)}</span><span class="pg">p. ${r.page}</span></div>
      <div class="row" style="gap:6px">${gradeChip(r.grade)}${revTag(info?.doc)}${r.answer ? `<span class="small"><b>${esc(r.answer.label)}:</b> <span class="mono">${esc(r.answer.value)}</span></span>` : ""}</div>
      <div class="snip">${markSnip(r.snip)}</div>${off ? `<span class="notsaved">Not saved on this phone</span>` : ""}</button>`;
  }).join("");
  R.querySelectorAll(".hit").forEach(b => b.onclick = () => { rememberQuery(); const r = m.results[+b.dataset.i]; openViewer(r.file, r.page, m.words); });
}

/* ---------- viewer ---------- */
let pdfjs = null, vDoc = null, vFile = null, vPage = 1, vZoom = 1, vWords = [], renderTask = null, docCache = new Map();
async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import("./vendor/pdfjs/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("vendor/pdfjs/pdf.worker.min.mjs", location.href).href;
  return pdfjs;
}
function vMessage(html) { $("#vMsg").innerHTML = html; $("#vMsg").hidden = !html; $("#pageWrap").hidden = !!html; }
async function openViewer(file, page, words) {
  const info = docInfo(file);
  $("#vTitle").textContent = (info ? info.dev.name + " · " + info.doc.title : file);
  $("#vRev").textContent = info?.doc.rev || ""; $("#vRev").hidden = !info?.doc.rev;
  $("#viewer").hidden = false; document.body.style.overflow = "hidden";
  if (!history.state?.viewer) history.pushState({ viewer: 1 }, "");
  vWords = words || []; vZoom = 1; vMessage("Opening…");
  try {
    if (vFile !== file) {
      vDoc = docCache.get(file);
      if (!vDoc) {
        const lib = await loadPdfjs();
        let r;
        try { r = await fetch(manualURL(file)); } catch { r = null; }
        if (!r || !r.ok) {
          vMessage(`This manual isn't saved on this phone.<br><br>Connect to signal or Wi-Fi and open it again, or save ${esc(info?.dev.name || "it")} from the Manuals tab so it works offline.`);
          return;
        }
        const buf = await r.clone().arrayBuffer();
        if (!saved.has(file) && "caches" in window && info) {  // opened online: keep a copy for later
          try { await (await caches.open(MANUALS_CACHE)).put(manualURL(file), r); saved.set(file, info.doc.sha || ""); store.set("savedManuals", Object.fromEntries(saved)); } catch {}
        }
        vDoc = await lib.getDocument({
          data: new Uint8Array(buf),
          standardFontDataUrl: new URL("vendor/pdfjs/standard_fonts/", location.href).href,
          wasmUrl: new URL("vendor/pdfjs/wasm/", location.href).href,
          iccUrl: new URL("vendor/pdfjs/iccs/", location.href).href,
          isEvalSupported: false
        }).promise;
        docCache.set(file, vDoc);
        if (docCache.size > 3) { const [k, v] = docCache.entries().next().value; if (k !== file) { v.destroy(); docCache.delete(k); } }
      }
      vFile = file;
    }
    $("#pgCount").textContent = "of " + vDoc.numPages;
    await renderPage(Math.min(Math.max(1, page), vDoc.numPages), true);
  } catch (err) {
    vMessage("This manual couldn't be opened. " + esc(err?.message || ""));
  }
}
async function renderPage(n, scrollToHit) {
  vPage = n; $("#pgIn").value = n;
  $("#vPrev").disabled = n <= 1; $("#vNext").disabled = n >= vDoc.numPages;
  const page = await vDoc.getPage(n);
  const stage = $("#stage"), base = page.getViewport({ scale: 1 });
  const fit = Math.max(200, stage.clientWidth - 16) / base.width;
  const vp = page.getViewport({ scale: fit * vZoom });
  let dpr = Math.min(window.devicePixelRatio || 1, 3);
  while (vp.width * vp.height * dpr * dpr > 14e6 && dpr > 1) dpr -= 0.25;   // iOS canvas size limit
  const cv = $("#cv"), ctx = cv.getContext("2d");
  if (renderTask) { try { renderTask.cancel(); } catch {} }
  cv.width = Math.floor(vp.width * dpr); cv.height = Math.floor(vp.height * dpr);
  cv.style.width = Math.floor(vp.width) + "px"; cv.style.height = Math.floor(vp.height) + "px";
  const wrap = $("#pageWrap"); wrap.style.width = Math.floor(vp.width) + "px";
  wrap.querySelectorAll(".hl").forEach(h => h.remove());
  vMessage("");
  renderTask = page.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
  try { await renderTask.promise; } catch (e) { if (e?.name === "RenderingCancelledException") return; throw e; }
  let first = null;
  if (vWords.length) {
    const tc = await page.getTextContent();
    const words = vWords.filter(w => w.length > 1);
    for (const it of tc.items) {
      const s = (it.str || "").toLowerCase(); if (!s.trim()) continue;
      const tx = pdfjs.Util.transform(vp.transform, it.transform);
      const h = Math.hypot(tx[2], tx[3]), w = it.width * vp.scale, x = tx[4], y = tx[5] - h;
      for (const word of words) {
        let k = -1;
        while ((k = s.indexOf(word, k + 1)) !== -1) {
          const el = document.createElement("div"); el.className = "hl";
          el.style.left = (x + w * k / s.length) + "px"; el.style.top = (y - h * 0.1) + "px";
          el.style.width = Math.max(4, w * word.length / s.length) + "px"; el.style.height = (h * 1.25) + "px";
          wrap.appendChild(el); if (!first || y < first) first = y;
        }
      }
    }
  }
  if (scrollToHit) stage.scrollTo({ top: first != null ? Math.max(0, first - 80) : 0, left: 0 });
}
function closeViewer() { $("#viewer").hidden = true; document.body.style.overflow = ""; if (renderTask) try { renderTask.cancel(); } catch {} }
$("#vBack").onclick = () => history.state?.viewer ? history.back() : closeViewer();
window.addEventListener("popstate", () => { if (!$("#viewer").hidden) closeViewer(); });
$("#vPrev").onclick = () => vPage > 1 && renderPage(vPage - 1, true);
$("#vNext").onclick = () => vDoc && vPage < vDoc.numPages && renderPage(vPage + 1, true);
$("#pgIn").addEventListener("change", () => { const n = parseInt($("#pgIn").value, 10); if (vDoc && n >= 1 && n <= vDoc.numPages) renderPage(n, true); else $("#pgIn").value = vPage; });
$("#zIn").onclick = () => { vZoom = Math.min(4, vZoom * 1.4); renderPage(vPage, false); };
$("#zOut").onclick = () => { vZoom = Math.max(0.5, vZoom / 1.4); renderPage(vPage, false); };
$("#zFit").onclick = () => { vZoom = 1; renderPage(vPage, false); };
document.addEventListener("keydown", (e) => {
  if ($("#viewer").hidden || e.target.tagName === "INPUT") return;
  if (e.key === "ArrowRight") $("#vNext").click(); else if (e.key === "ArrowLeft") $("#vPrev").click(); else if (e.key === "Escape") $("#vBack").click();
});
let rz; window.addEventListener("resize", () => { if ($("#viewer").hidden || !vDoc) return; clearTimeout(rz); rz = setTimeout(() => renderPage(vPage, false), 200); });

/* ---------- firmware ---------- */
const FW_LABEL = { new: "New firmware listed", review: "Download page changed: check it", ok: "No change", error: "Couldn't check", manual: "Check by hand", none: "Not tracked yet" };
function fwNewCount() {
  if (!FW?.devices) return 0;
  const seen = store.get("fwSeen", "1970-01-01");
  return Object.values(FW.devices).filter(x => (x.status === "new" || x.status === "review") && x.changed_on && x.changed_on > seen).length
       + (FW.advisories || []).filter(a => a.first_seen && a.first_seen > seen).length;
}
function renderFwBadge() { const n = fwNewCount(); $("#fwBadge").hidden = !n; $("#fwBadge").textContent = n; }
function renderFirmware() {
  renderFwBadge();
  if (!FW || !FW.checked) {
    $("#fwHead").innerHTML = `<div class="empty">No firmware report on this phone yet. It arrives with the next sync after the Mac runs its weekly check.</div>`;
    $("#fwList").innerHTML = ""; $("#advList").innerHTML = ""; return;
  }
  const age = (Date.now() - new Date(FW.checked)) / DAY;
  $("#fwHead").innerHTML = `<div class="banner ${age > OLD_DAYS ? "bad" : age > STALE_DAYS ? "warn" : ""}"><span><b>Last checked ${ago(FW.checked)}</b> <span class="small muted">(${fmtDate(FW.checked)})</span></span>
    <span class="small">${age > STALE_DAYS ? "This report is old. The weekly check may have stopped running on the Mac, or this phone hasn't synced." : "A new firmware listing means it exists, not that it's approved. Updates go through the client before anyone installs them."}</span></div>`;
  const order = { new: 0, review: 1, error: 2, manual: 3, ok: 4, none: 5 };
  const rows = LIB.devices.map(d => ({ d, f: FW.devices?.[d.id] || { status: "none" } })).sort((a, b) => order[a.f.status] - order[b.f.status]);
  $("#fwList").innerHTML = rows.map(({ d, f }) => `<div class="fw ${f.status}"><span class="bar"></span><div class="body">
      <div class="row" style="justify-content:space-between"><h3>${esc(d.name)}</h3><span class="small" style="font-weight:700">${FW_LABEL[f.status] || esc(f.status)}</span></div>
      ${f.latest ? `<div class="ver">Latest listed: ${esc(f.latest)}${f.previous && f.previous !== f.latest ? ` <span class="muted">(was ${esc(f.previous)})</span>` : ""}</div>` : ""}
      ${f.changed_on ? `<div class="small muted">Changed ${fmtDate(f.changed_on)}</div>` : ""}
      ${f.note ? `<div class="small">${esc(f.note)}</div>` : ""}
      ${f.url ? `<a class="small" href="${esc(f.url)}" target="_blank" rel="noopener">Open download page${navigator.onLine ? "" : " (needs internet)"}</a>` : ""}
    </div></div>`).join("");
  const adv = FW.advisories || [];
  $("#advList").innerHTML = adv.length ? adv.map(a => `<div class="adv"><b class="small">${esc(a.vendors?.join(", ") || "")}</b><span>${esc(a.title)}</span><span class="small muted">${a.published ? fmtDate(a.published) : ""} ${a.id ? "· " + esc(a.id) : ""}</span>${a.url ? `<a class="small" href="${esc(a.url)}" target="_blank" rel="noopener">Read advisory</a>` : ""}</div>`).join("")
    : `<div class="empty small">No recent CISA advisories for these manufacturers.</div>`;
}

/* ---------- sync ---------- */
let syncing = false;
async function sync(manual) {
  if (syncing) return; syncing = true; lastCheck = Date.now(); $("#syncBtn").disabled = true; $("#syncBtn").textContent = "Syncing…";
  let gotNetwork = false;
  try {
    const lib = await getJSON("data/library.json");
    gotNetwork = !lib.cached;
    const oldVersion = store.get("libVersion", null);
    LIB = lib.data;
    if (LIB.version !== oldVersion || !worker) {
      startWorker();
      store.set("libVersion", LIB.version);
      if (oldVersion && gotNetwork) toast("Library updated");
    }
    if (gotNetwork) {
      // Bring the phone up to date: new or changed manuals for saved devices, and with "Save all"
      // on, every device, including ones added since. Also retries downloads that failed before.
      const wanted = keepAll ? LIB.devices.map(d => d.id) : [...savedDevices];
      const todo = wanted.filter(id => ["update", "part", ...(keepAll ? ["none"] : [])].includes(devState(devById(id) || { docs: [] })));
      if (todo.length) setTimeout(() => saveDevices(todo), 0);
    }
  } catch (e) {
    if (!LIB) $("#results").innerHTML = `<div class="empty">The library isn't on this phone yet. Open the app once with signal or Wi-Fi.</div>`;
  }
  try { const fw = await getJSON("data/firmware.json"); FW = fw.data; gotNetwork = gotNetwork || !fw.cached; } catch {}
  if (gotNetwork) store.set("lastSync", new Date().toISOString());
  else if (manual) toast("No connection. Using what's saved on this phone.");
  syncing = false; $("#syncBtn").disabled = false; $("#syncBtn").textContent = "Sync";
  renderSync(); renderDevFilter(); renderLibrary(); renderFirmware(); renderBanners();
}

/* ---------- ask (chat) ----------
   Answers come only from searching the manuals stored on this phone. Nothing is sent anywhere. */
const askWaiters = new Map();
let chat = store.get("chat", []);          // [{role:"u"|"b", text, mode, sources, words}]
let lastDevice = store.get("chatDevice", null), askBusy = false;
const ASK_TIPS = ["How do I set the Modbus address on a PXM 3000?", "WAGO 750-362 I/O LED is flashing red", "Ekip Com Modbus TCP IP address setup", "How do I reset a PXG 900 to factory defaults?", "SER-3200 time sync options"];

function workerAsk(q, hint) {
  return new Promise((resolve, reject) => {
    if (!workerReady) return reject(new Error("Search is still loading. Try again in a moment."));
    const id = ++reqId; askWaiters.set(id, resolve);
    worker.postMessage({ type: "ask", q, hint, id });
    setTimeout(() => { if (askWaiters.delete(id)) reject(new Error("Search timed out. Try again.")); }, 10000);
  });
}
function srcInfo(r, n) {
  const info = docInfo(r.file);
  return { n, device: r.device, devName: info?.dev.name || r.device, title: info?.doc.title || r.file, rev: info?.doc.rev || "", file: r.file, page: r.page, snip: r.snip, grade: r.grade, answer: r.answer };
}
function srcCard(sv) {
  return `<button class="src" type="button" data-file="${esc(sv.file)}" data-page="${sv.page}">
    <div class="hmeta"><span class="dev">${esc(sv.devName)}</span><span class="muted">${esc(sv.title)}</span><span class="pg">p. ${sv.page}</span></div>
    <div class="row" style="gap:6px">${gradeChip(sv.grade)}${sv.rev ? `<span class="rev${/^undated/i.test(sv.rev) ? " undated" : ""}">${esc(sv.rev)}</span>` : ""}</div>
    ${sv.snip ? `<div class="snip">${markSnip(sv.snip)}</div>` : ""}
    ${!saved.has(sv.file) && !navigator.onLine ? `<span class="notsaved">Not saved on this phone</span>` : ""}</button>`;
}
function renderChat() {
  const C = $("#chat");
  $("#askTips").innerHTML = chat.length ? "" : `<span class="label" style="width:100%">Try asking</span>` + ASK_TIPS.map(t => `<button type="button" data-q="${esc(t)}">${esc(t)}</button>`).join("");
  $("#askTips").querySelectorAll("[data-q]").forEach(b => b.onclick = () => { $("#askIn").value = b.dataset.q; sendAsk(); });
  C.innerHTML = chat.map((m, i) => {
    if (m.role === "u") return `<div class="msg-u">${esc(m.text)}</div>`;
    if (m.pending) return `<div class="msg-b"><span class="typing">${esc(m.text)}</span></div>`;
    return `<div class="msg-b" data-i="${i}">${m.sources?.length ? `<div class="mode quote">From the manuals</div>` : ""}
      ${m.missing ? `<div class="banner warn small">${esc(m.missing)}</div>` : ""}
      ${m.found ? answerCard(m.found, m.found.devName, m.found.title, m.found.rev) : ""}
      ${m.text ? `<div class="answer"><p>${esc(m.text)}</p></div>` : ""}
      ${m.sources?.length ? `<div class="srcs">${m.sources.map(srcCard).join("")}</div>` : ""}</div>`;
  }).join("");
  C.querySelectorAll(".msg-b[data-i]").forEach(el => {
    const m = chat[+el.dataset.i];
    el.querySelectorAll(".src").forEach(b => b.onclick = () => openViewer(b.dataset.file, +b.dataset.page, m.words || []));
  });
}
function saveChat() { store.set("chat", chat.filter(m => !m.pending).slice(-30)); }
function scrollChatEnd() { requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" })); }

async function sendAsk() {
  const q = $("#askIn").value.trim();
  if (!q || askBusy) return;
  askBusy = true; $("#askBtn").disabled = true; $("#askIn").value = ""; autoGrow();
  chat.push({ role: "u", text: q }); const pending = { role: "b", pending: true, text: "Looking through the manuals…" }; chat.push(pending);
  renderChat(); scrollChatEnd();
  let reply;
  try {
    const res = await workerAsk(q, lastDevice);
    const found = res.results || [];
    if (!found.length) {
      reply = { role: "b", text: "I couldn't find that in the manuals. Try different words, the device name, or a register number." };
    } else {
      lastDevice = (!res.namedMissing && res.named) || found[0].device; store.set("chatDevice", lastDevice);
      const sources = found.slice(0, 3).map((r, i) => srcInfo(r, i + 1));
      const nd = devById(res.named), devName = res.namedMissing ? null : devById(res.named || res.prefer)?.name;
      const missing = res.namedMissing && nd ? (nd.docs.length ? `Nothing in the ${nd.name} manuals matched. These pages are from other devices.` : `There are no ${nd.name} manuals in the library yet. These pages are from other devices.`) : "";
      const found0 = !res.namedMissing && sources[0].answer ? sources[0] : null;
      reply = { role: "b", missing, found: found0,
                text: found0 ? "Other pages that may help:" : `Closest matches${devName ? " in the " + devName + " manuals" : ""}. Tap one to open the page.`,
                sources: found0 ? sources : sources, words: res.words };
    }
  } catch (e) {
    reply = { role: "b", text: e.message || "Something went wrong. Try again." };
  }
  chat.splice(chat.indexOf(pending), 1, reply);
  saveChat(); renderChat(); scrollChatEnd();
  askBusy = false; $("#askBtn").disabled = false;
}
function autoGrow() { const t = $("#askIn"); t.style.height = "auto"; t.style.height = Math.min(140, t.scrollHeight) + "px"; }
$("#askIn").addEventListener("input", autoGrow);
$("#askIn").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendAsk(); } });
$("#askForm").addEventListener("submit", (e) => { e.preventDefault(); sendAsk(); });
$("#newChat").onclick = () => { chat = []; lastDevice = null; store.set("chatDevice", null); saveChat(); renderChat(); };

/* ---------- boot ---------- */
(async function boot() {
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("sw.js"); } catch (e) { console.warn("Offline mode unavailable", e); }
  }
  try { localStorage.removeItem("crewCode"); } catch {}
  // Old chats may hold AI answers from the test version; start fresh.
  chat = chat.filter(m => m.role === "u" || (m.mode !== "ai" && !m.code)); saveChat();
  await reconcileSaved();
  renderTips();
  show(store.get("tab", "search"));
  await sync(false);
})();
