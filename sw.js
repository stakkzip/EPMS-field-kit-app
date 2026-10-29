/* EPMS Field Manuals service worker.
   - App files: cached on install, served from the phone (bump SHELL_VERSION when app code changes).
   - Library data (library.json, pages.json, firmware.json): try the internet first with a short
     timeout, fall back to the phone's copy. Responses served from the phone carry X-From-Cache: 1.
   - Manuals: served from the phone when saved, otherwise from the internet. The app decides what
     gets saved (cache "manuals"). */
const SHELL_VERSION = "shell-2d436dcaed";
const DATA_CACHE = "data";
const MANUALS_CACHE = "manuals";
const VENDOR_CACHE = "vendor-v1";
const SHELL = [
  "./", "./index.html", "./app.js", "./search-worker.js", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png",
  "./vendor/pdfjs/pdf.min.mjs", "./vendor/pdfjs/pdf.worker.min.mjs",
  "./vendor/pdfjs/standard_fonts/FoxitDingbats.pfb",
  "./vendor/pdfjs/standard_fonts/FoxitFixed.pfb",
  "./vendor/pdfjs/standard_fonts/FoxitFixedBold.pfb",
  "./vendor/pdfjs/standard_fonts/FoxitFixedBoldItalic.pfb",
  "./vendor/pdfjs/standard_fonts/FoxitFixedItalic.pfb",
  "./vendor/pdfjs/standard_fonts/FoxitSerif.pfb",
  "./vendor/pdfjs/standard_fonts/FoxitSerifBold.pfb",
  "./vendor/pdfjs/standard_fonts/FoxitSerifBoldItalic.pfb",
  "./vendor/pdfjs/standard_fonts/FoxitSerifItalic.pfb",
  "./vendor/pdfjs/standard_fonts/FoxitSymbol.pfb",
  "./vendor/pdfjs/standard_fonts/LiberationSans-Bold.ttf",
  "./vendor/pdfjs/standard_fonts/LiberationSans-BoldItalic.ttf",
  "./vendor/pdfjs/standard_fonts/LiberationSans-Italic.ttf",
  "./vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf",
  "./vendor/pdfjs/wasm/jbig2.wasm",
  "./vendor/pdfjs/wasm/jbig2_nowasm_fallback.js",
  "./vendor/pdfjs/wasm/openjpeg.wasm",
  "./vendor/pdfjs/wasm/openjpeg_nowasm_fallback.js",
  "./vendor/pdfjs/wasm/qcms_bg.wasm",
  "./vendor/pdfjs/iccs/CGATS001Compat-v2-micro.icc"
];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL_VERSION);
    await c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })));
    // Seed library data so search works on first offline open.
    const d = await caches.open(DATA_CACHE);
    for (const u of ["./data/library.json", "./data/pages.json", "./data/firmware.json"]) {
      try { const r = await fetch(u, { cache: "no-cache" }); if (r.ok) await d.put(u, r); } catch (_) {}
    }
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL_VERSION, DATA_CACHE, MANUALS_CACHE, VENDOR_CACHE]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

function withTimeout(p, ms) {
  return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout")), ms); p.then(v => { clearTimeout(t); res(v); }, err => { clearTimeout(t); rej(err); }); });
}

async function fromCacheMarked(req, cacheName) {
  const hit = await caches.open(cacheName).then(c => c.match(req, { ignoreSearch: true }));
  if (!hit) return null;
  const h = new Headers(hit.headers); h.set("X-From-Cache", "1");
  return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: h });
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  const path = url.pathname;

  if (path.includes("/data/") && path.endsWith(".json")) {
    e.respondWith((async () => {
      try {
        const r = await withTimeout(fetch(e.request, { cache: "no-cache" }), NETWORK_TIMEOUT_MS);
        if (r.ok) { const c = await caches.open(DATA_CACHE); await c.put(url.pathname.replace(/^.*\/data\//, "./data/"), r.clone()); return r; }
        throw new Error("HTTP " + r.status);
      } catch (_) {
        const key = url.pathname.replace(/^.*\/data\//, "./data/");
        return (await fromCacheMarked(new Request(new URL(key, self.registration.scope)), DATA_CACHE)) ||
               new Response(JSON.stringify({ offline: true }), { status: 503, headers: { "Content-Type": "application/json", "X-From-Cache": "1" } });
      }
    })());
    return;
  }

  if (path.includes("/manuals/")) {
    e.respondWith((async () => {
      const hit = await caches.open(MANUALS_CACHE).then(c => c.match(e.request, { ignoreSearch: true }));
      return hit || fetch(e.request);
    })());
    return;
  }

  if (path.includes("/vendor/")) {
    e.respondWith((async () => {
      const hit = await caches.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok) (await caches.open(VENDOR_CACHE)).put(e.request, r.clone());
      return r;
    })());
    return;
  }

  // App shell: phone first, then internet.
  e.respondWith((async () => {
    const hit = await caches.match(e.request, { ignoreSearch: true }) ||
                (e.request.mode === "navigate" ? await caches.match("./index.html") : null);
    return hit || fetch(e.request);
  })());
});
