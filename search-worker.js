/* Offline full-text search over manual pages. Runs in a Web Worker.
   Ranking, in two passes:
   1. BM25 word matching (with prefix and one-typo matching) picks the top candidate pages.
   2. Each candidate is graded on how well it answers the question:
      - question type: for "IP address", "baud rate", "Modbus ID", etc., does the page contain an
        actual value of that kind right next to the words asked about? ("Answer found")
      - closeness: do all the search words appear together in one passage?
      - coverage: does the page contain every search word?
   Each result gets a grade: answer / strong / partial. */
let PAGES = [], DOCS = [], INDEX = new Map(), LEN = [], AVG = 1, VOCAB = [], BOOST = [];
const STOP = new Set("a an and are as at be by can do does for from how i if in is it my of on or the this to what when where which why with you your".split(" "));
const COMMS = /\b(modbus|baud|parity|ethernet|ip address|subnet|gateway|bacnet|rs-?485|protocol|tcp|unit id|slave id|device id|dhcp|snmp|ntp|ptp|irig)\b/i;
const TROUBLE = /\b(troubleshoot\w*|error|alarm|fault|led|diagnos\w*|reset|not respond\w*|no communication)\b/i;

function tokens(text, forIndex) {
  const out = [];
  const m = text.toLowerCase().match(/[a-z0-9]+(?:[.\-_/][a-z0-9]+)*/g) || [];
  for (const t of m) {
    if (t.length > 40) continue;
    out.push(t);
    if (/[.\-_/]/.test(t)) {
      const parts = t.split(/[.\-_/]/).filter(Boolean);
      if (forIndex) { for (const p of parts) out.push(p); }
      out.push(parts.join(""));
    }
  }
  return out;
}

function build(data) {
  PAGES = data.pages; DOCS = data.docs;
  INDEX = new Map(); LEN = new Array(PAGES.length); BOOST = new Array(PAGES.length);
  let total = 0;
  for (let i = 0; i < PAGES.length; i++) {
    const text = PAGES[i][2];
    const toks = tokens(text, true);
    LEN[i] = toks.length || 1; total += LEN[i];
    BOOST[i] = 1 + (COMMS.test(text) ? 0.15 : 0) + (TROUBLE.test(text) ? 0.15 : 0);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, c] of tf) {
      let p = INDEX.get(t);
      if (!p) INDEX.set(t, p = []);
      p.push(i, c);
    }
  }
  AVG = total / Math.max(1, PAGES.length);
  VOCAB = [...INDEX.keys()].sort();
}

function within1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function lowerBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; }

/* Words techs use interchangeably. Each side also finds the other. */
const SYNONYMS = [
  ["subnet", "netmask"], ["mask", "netmask"], ["gateway", "router"],
  ["password", "passcode", "pin"], ["username", "user", "login"], ["login", "logon"],
  ["reset", "factory", "defaults", "restore"], ["default", "factory", "preset"],
  ["slave", "unit", "node"], ["termination", "terminating", "terminator", "eol"],
  ["firmware", "fw", "software"], ["upgrade", "update"], ["led", "leds", "indicator"],
  ["ct", "cts"], ["pt", "vt", "pts"], ["breaker", "cb"], ["setup", "configuration", "config", "settings"]
];
const SYN = new Map();
for (const group of SYNONYMS) for (const w of group) SYN.set(w, [...(SYN.get(w) || []), ...group.filter(x => x !== w)]);

/* Each query word expands to a list of [indexTerm, weight]. */
function expand(q, isLast) {
  const out = [];
  if (INDEX.has(q)) out.push([q, 1]);
  for (const s of SYN.get(q) || []) if (INDEX.has(s)) out.push([s, 0.8]);
  if (q.length >= 3 && (isLast || !INDEX.has(q))) {
    let k = lowerBound(VOCAB, q), n = 0;
    const w = INDEX.has(q) ? 0.25 : 0.6;   // completions count for less when the word itself exists
    for (; k < VOCAB.length && VOCAB[k].startsWith(q) && n < 60; k++) if (VOCAB[k] !== q) { out.push([VOCAB[k], w]); n++; }
  }
  if (!out.length && q.length >= 5) {
    for (const v of VOCAB) if (within1(q, v)) { out.push([v, 0.5]); if (out.length > 20) break; }
  }
  return out;
}

function snippet(text, words, W = 220, focus = -1) {
  const lower = text.toLowerCase();
  const hits = [];
  const isWordChar = (c) => !!c && /[a-z0-9]/.test(c);
  for (const w of words) {
    let k = -1;
    while ((k = lower.indexOf(w, k + 1)) !== -1 && hits.length < 400) {
      if (w.length <= 3 && (isWordChar(lower[k - 1]) || isWordChar(lower[k + w.length]))) continue;   // "ip" shouldn't light up inside "multiple"
      hits.push([k, w.length]);
    }
  }
  hits.sort((a, b) => a[0] - b[0]);
  let best = 0, bestCount = -1;
  for (let i = 0; i < hits.length; i++) {
    const seen = new Set(); let j = i;
    while (j < hits.length && hits[j][0] - hits[i][0] < W) { seen.add(lower.substr(hits[j][0], hits[j][1])); j++; }
    if (seen.size > bestCount) { bestCount = seen.size; best = hits[i][0]; }
  }
  if (focus >= 0) best = Math.max(0, focus - Math.floor(W / 3));
  let start = Math.max(0, best - 60);
  if (start > 0) { const sp = text.indexOf(" ", start); if (sp !== -1 && sp - start < 20) start = sp + 1; }
  const end = Math.min(text.length, start + W + 60);
  const piece = text.slice(start, end).replace(/\n/g, " ");
  const marks = hits.filter(h => h[0] >= start && h[0] + h[1] <= end).map(h => [h[0] - start, h[1]]);
  return { pre: start > 0, post: end < text.length, text: piece, marks };
}

/* ---------- question types ----------
   ask: words in the question that signal the type. value: what an answer looks like on the page.
   near: words that should sit close to the value on the page. */
const IP = String.raw`(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}`;
const BAUD = String.raw`(?:1200|2400|4800|9600|19200|38400|57600|76800|115200)`;
/* value: what an answer looks like on the page; group 1, when present, is the part to show. */
const INTENTS = [
  { id: "subnet", label: "Subnet mask", ask: /\b(subnet|netmask|mask)\b/, value: /\b(255\.(?:255|254|252|248|240|224|192|128|0)\.\d{1,3}\.\d{1,3})\b/g, near: /subnet|mask|netmask/ },
  { id: "gateway", label: "Gateway", ask: /\bgateway\b/, value: new RegExp(String.raw`\b(${IP})\b`, "g"), near: /gateway/ },
  { id: "ip", label: "IP address", ask: /\bip\b|\bip[- ]?address/, value: new RegExp(String.raw`\b(${IP})\b`, "g"), near: /\bip\b|ip address|ip-address/ },
  { id: "baud", label: "Baud rate", ask: /\bbaud\b/, value: new RegExp(String.raw`\b(${BAUD}(?:\s*(?:bps|baud))?(?:\s*(?:-|–|to|,|/|and|or)\s*${BAUD}(?:\s*(?:bps|baud))?)*)\b`, "gi"), near: /baud/ },
  { id: "parity", label: "Parity", ask: /\bparity\b/, value: /\bparity\b[^.\n]{0,40}?\b(even|odd|none|no parity)\b/gi, near: /parity/ },
  { id: "modbusid", label: "Modbus address", ask: /\b(modbus|slave|unit|device|node)\s*(id|address|addr)\b|\baddress range\b/, value: /\b(1\s*(?:-|–|to|\.\.)\s*24[67])\b|\b(?:slave|unit|device|modbus)\s*(?:id|address)\s*(?:is|=|:|of|to)?\s*(\d{1,3})\b/gi, near: /modbus|slave|unit id|device address|address/ },
  { id: "port", label: "Port", ask: /\bport\b/, value: /\b(?:tcp\s*)?port\s*(?:number|no\.?)?\s*(?:is|=|:)?\s*(502|47808|161|162|80|443|\d{3,5})\b/gi, near: /port/ },
  { id: "password", label: "Default login", ask: /\b(password|passcode|login|credentials|username|pin)\b/, value: /\b((?:user\s?name|password|passcode|pin)\s*(?:is|=|:)\s*["“']?(?!(?:from|and|the|to|field|must|be|for|a|an|of|that|this|not|blank)\b)[A-Za-z0-9!@#$%^&*._-]{3,}["”']?)/gi, near: /password|login|username|user name|default/ }
];
function detectIntents(q) {
  const ql = q.toLowerCase();
  // "ip address" questions shouldn't also trigger "gateway" or "subnet" unless asked.
  return INTENTS.filter(it => it.ask.test(ql));
}

/* Smallest stretch of text (in characters) that contains every search word, or Infinity. */
function minSpan(lower, words) {
  const occ = [];
  words.forEach((w, wi) => { let k = -1, n = 0; while ((k = lower.indexOf(w, k + 1)) !== -1 && n++ < 60) occ.push([k, wi]); });
  if (!occ.length) return Infinity;
  occ.sort((a, b) => a[0] - b[0]);
  const need = new Set(words.map((_, i) => i)).size, have = new Map(); let best = Infinity, lo = 0;
  for (let hi = 0; hi < occ.length; hi++) {
    have.set(occ[hi][1], (have.get(occ[hi][1]) || 0) + 1);
    while (have.size === need) {
      best = Math.min(best, occ[hi][0] - occ[lo][0]);
      const w = occ[lo][1]; const c = have.get(w) - 1; if (c) have.set(w, c); else have.delete(w); lo++;
    }
  }
  return best;
}

/* Look for an answer-shaped value close to the words asked about.
   quality: +1 the asked-about word sits just before the value, +1 "default"/"factory" is nearby,
   +1 the other words of the question are nearby. 2 or more counts as "Answer found". */
function looksLikeSectionNumber(v) { const o = v.split(".").map(Number); return o[0] < 10 && o.every(x => x <= 30); }
function findAnswer(text, lower, intents, nearWords) {
  let best = null;
  for (const it of intents) {
    it.value.lastIndex = 0; let m;
    while ((m = it.value.exec(text))) {
      const val = (m.slice(1).find(Boolean) || m[0]).replace(/\s+/g, " ").trim();
      const pos = m.index + Math.max(0, m[0].indexOf(val.split(" ")[0]));
      if ((it.id === "ip" || it.id === "gateway") && (/^(0\.0\.0\.0|255\.)/.test(val) || looksLikeSectionNumber(val))) continue;
      const before = lower.slice(Math.max(0, pos - 90), pos), around = lower.slice(Math.max(0, pos - 160), pos + val.length + 60);
      if (!it.near.test(around)) continue;
      let quality = 0;
      if (it.near.test(before)) quality++;
      if (/default|factory|preset|set to|is set|out of the box|shipped/.test(around)) quality++;
      if (nearWords.length && nearWords.every(w => around.includes(w))) quality++;
      if (/https?:\/\/$/.test(before)) quality++;                                   // a login address like http://192.168...
      if (/example|e\.g\.|for instance|such as|sample/.test(around)) quality--;      // illustrations, not settings
      if (!best || quality > best.quality) best = { label: it.label, value: val, pos, quality };
      if (best.quality >= 3) return best;
    }
  }
  return best;
}

let ALIASES = [];  // [{id, forms: ["pxm3000", ...]}]
function setAliases(devs) {
  ALIASES = devs.map(d => {
    const forms = new Set();
    for (const name of [d.name, d.id, ...(d.aliases || [])]) {
      const t = tokens(name, false).filter(w => !STOP.has(w));
      if (t.length) forms.add(t.join(" "));
      forms.add(name.toLowerCase().replace(/[^a-z0-9]/g, ""));
    }
    return { id: d.id, forms: [...forms].filter(f => f.length >= 3) };
  });
}
function namedDevice(q) {
  const joined = " " + tokens(q, false).join(" ") + " ", squashed = q.toLowerCase().replace(/[^a-z0-9]/g, "");
  let best = null, bestLen = 0;
  for (const a of ALIASES) for (const f of a.forms) {
    const hit = f.includes(" ") ? joined.includes(" " + f + " ") : (joined.includes(" " + f + " ") || (f.length >= 6 && squashed.includes(f)));
    if (hit && f.length > bestLen) { best = a.id; bestLen = f.length; }
  }
  return best;
}

function search(q, device, opts = {}) {
  const named = device ? null : namedDevice(q);
  const prefer = named || (device ? null : opts.hint || null);   // hint = device from the previous chat turn
  const prefBoost = named ? 2.5 : 1.6;
  const words = tokens(q, false).filter(w => !STOP.has(w));
  if (!words.length) return { results: [], words: [] };
  const N = PAGES.length, k1 = 1.2, b = 0.75;
  const scores = new Map(), matched = new Map(), used = new Set();
  words.forEach((w, wi) => {
    for (const [term, weight] of expand(w, wi === words.length - 1)) {
      used.add(term);
      const post = INDEX.get(term); const df = post.length / 2;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (let i = 0; i < post.length; i += 2) {
        const p = post[i];
        if (device && DOCS[PAGES[p][0]][0] !== device) continue;
        const tf = post[i + 1];
        const s = weight * idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * LEN[p] / AVG));
        scores.set(p, (scores.get(p) || 0) + s);
        let m = matched.get(p); if (!m) matched.set(p, m = new Set()); m.add(wi);
      }
    }
  });
  // Pass 1: word matching. Coverage counts only the question words, not the device name,
  // and a device named in the question pushes other devices' manuals well down.
  const devWords = new Set(prefer ? (ALIASES.find(a => a.id === prefer)?.forms || []).flatMap(f => f.split(" ")) : []);
  const qIdx = words.map((w, i) => devWords.has(w) ? -1 : i).filter(i => i >= 0);
  let ranked = [...scores].map(([p, s]) => {
    const m = matched.get(p);
    const cover = qIdx.length ? qIdx.filter(i => m.has(i)).length / qIdx.length : m.size / words.length;
    const isPref = prefer && DOCS[PAGES[p][0]][0] === prefer;
    const pref = isPref ? prefBoost : (named ? 0.3 : 1);
    return { p, s: s * cover * cover * BOOST[p] * pref, cover };
  }).sort((a, b) => b.s - a.s).slice(0, 80);

  // Pass 2: does the page answer the question?
  const intents = detectIntents(q);
  const content = words.filter(w => !devWords.has(w));                      // words about the question, not the device name
  const nearWords = content.filter(w => !/^(ip|address|default|value|setting|settings|set)$/.test(w)).slice(0, 4);
  for (const r of ranked) {
    const text = PAGES[r.p][2], lower = text.toLowerCase();
    const forms = content.map(w => [w, ...(SYN.get(w) || [])]).map(fs => fs.find(f => lower.includes(f)) || fs[0]);
    const span = forms.length > 1 ? minSpan(lower, forms) : (forms.length ? 0 : Infinity);
    r.close = span === Infinity ? 0 : Math.max(0, 1 - span / 500);             // 1 = words right next to each other
    r.answer = intents.length ? findAnswer(text, lower, intents, nearWords) : null;
    const answerBoost = r.answer && r.answer.quality >= 2 ? 1 + 0.6 * r.answer.quality : 1;   // up to 2.8x for a default value right next to the words asked about
    r.final = r.s * (1 + 0.8 * r.close) * answerBoost;
    if (r.answer && r.answer.quality < 2) r.answer = null;
    r.grade = r.answer ? "answer" : (r.cover === 1 && r.close > 0.5) ? "strong" : r.cover === 1 ? "match" : "partial";
  }
  // Order: the named device's pages first, then pages where a value was found, then by score.
  const isPrefDev = (r) => prefer && DOCS[PAGES[r.p][0]][0] === prefer ? 1 : 0;
  ranked.sort((a, b) => (named ? isPrefDev(b) - isPrefDev(a) : 0) || ((b.grade === "answer") - (a.grade === "answer")) || (b.final - a.final));
  ranked = ranked.slice(0, opts.limit || 40);
  const hl = [...new Set([...words, ...used])].filter(w => w.length > 1).sort((a, b) => b.length - a.length).slice(0, 30);
  return {
    words: hl,
    total: scores.size,
    prefer, named,
    intents: intents.map(i => i.label),
    namedMissing: !!named && !ranked.some(r => DOCS[PAGES[r.p][0]][0] === named),
    results: ranked.map(({ p, final, grade, answer }) => {
      const [di, page, text] = PAGES[p];
      const marks = answer ? [...hl, answer.value.toLowerCase()] : hl;
      const r = { device: DOCS[di][0], file: DOCS[di][1], page, score: +final.toFixed(3), grade,
                  snip: snippet(text, marks, opts.snipLen || 220, answer ? answer.pos : -1) };
      if (answer && grade === "answer") r.answer = { label: answer.label, value: answer.value };
      if (opts.full) r.text = text.length > 3500 ? text.slice(0, 3500) : text;
      return r;
    })
  };
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "load") {
      const t0 = performance.now();
      const r = await fetch(m.url, { cache: "no-cache" }).catch(() => fetch(m.url));
      if (!r.ok) throw new Error("Search data not available (" + r.status + ")");
      const data = await r.json();
      build(data);
      setAliases(m.devices || []);
      self.postMessage({ type: "ready", id: m.id, pages: PAGES.length, version: data.version, ms: Math.round(performance.now() - t0) });
    } else if (m.type === "search") {
      self.postMessage({ type: "results", id: m.id, q: m.q, ...search(m.q, m.device) });
    } else if (m.type === "ask") {
      self.postMessage({ type: "passages", id: m.id, q: m.q, ...search(m.q, null, { hint: m.hint, full: true, limit: 6, snipLen: 420 }) });
    }
  } catch (err) {
    self.postMessage({ type: "error", id: m.id, message: String(err && err.message || err) });
  }
};
