import * as pdfjsLib from "./lib/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.mjs");
// background.js (MV3-safe: NO DOMParser)
// Pulls from:
// 1) Chapter 3 Section 1 (Encode) - base 3LD list
// 2) chap0_cam (Changes/Additions/Modifications) - deltas/adds/mods
// 3) Chapter 3 Section 4 (US Special Telephony/Call Signs)

const URL_ENCODE = "https://www.faa.gov/air_traffic/publications/atpubs/cnt_html/chap3_section_1.html";
const URL_CAM    = "https://www.faa.gov/air_traffic/publications/atpubs/cnt_html/chap0_cam.html";
const URL_USSPEC = "https://www.faa.gov/air_traffic/publications/atpubs/cnt_html/chap3_section_4.html";
const URL_NOTICES = "https://www.faa.gov/air_traffic/publications/at_notices/?documentID=1044118";

const DB_NAME = "atc_callsigns_db";
const DB_VERSION = 11;
const STORE = "entries";
const META_KEY = "meta_lastUpdated";

const STORE_TYPES = "aircraft_types";
const STORE_REGS  = "aircraft_regs";

async function ensureAircraftLoaded() {
  const db = await openDb();

  const count = await new Promise(res => {
    const tx = db.transaction(STORE_TYPES, "readonly");
    const req = tx.objectStore(STORE_TYPES).count();
    req.onsuccess = () => res(req.result);
  });

  db.close();

  if (count === 0) {
    console.log("Loading aircraft.json into IndexedDB...");
    await loadAircraftJsonOptimized();
  }
}
/** ---------- IndexedDB ---------- **/

async function extractTextFromPdfBytes(uint8) {
  const loadingTask = pdfjsLib.getDocument({ data: uint8 });
  const pdf = await loadingTask.promise;

  let full = "";
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    full += "\n" + content.items.map(it => it.str || "").join(" ");
  }
  return full;
}

function openDb() {
  return new Promise((resolve, reject) => {

    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onblocked = () => {
      console.warn("DB upgrade blocked — closing old connections");
    };

    req.onupgradeneeded = () => {

      const db = req.result;

      for (const name of Array.from(db.objectStoreNames)) {
        db.deleteObjectStore(name);
      }

      const cs = db.createObjectStore(STORE, { keyPath: "key" });
      cs.createIndex("designator", "designator");
      cs.createIndex("identifier", "identifier");
      cs.createIndex("telephony", "telephony");
      cs.createIndex("company", "company");
      cs.createIndex("country", "country");

      const types = db.createObjectStore(STORE_TYPES, { keyPath: "icao" });
      types.createIndex("icaotype", "icaotype");
      types.createIndex("model", "model");
      types.createIndex("manufacturer", "manufacturer");

      const regs = db.createObjectStore(STORE_REGS, { keyPath: "reg" });
      regs.createIndex("icaotype", "icaotype");
    };

    req.onsuccess = () => {

      const db = req.result;

      db.onversionchange = () => {
        db.close();
        console.warn("DB closed due to version change");
      };

      resolve(db);
    };

    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function clearStore(db) {
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).clear();
  await txDone(tx);
}

async function bulkPut(db, items) {
  const tx = db.transaction(STORE, "readwrite");
  const os = tx.objectStore(STORE);
  for (const it of items) os.put(it);
  await txDone(tx);
}

async function getByKey(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function getAll(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function fetchPdfBytes(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`PDF fetch failed ${r.status}: ${url}`);
  const buf = await r.arrayBuffer();
  return new Uint8Array(buf);
}

/** ---------- Text + fuzzy ---------- **/
function cleanText(s) {
  return (s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function soundKey(s) {
  s = cleanText(s).replace(/[0-9]/g, "");
  if (!s) return "";
  return s.split(" ").map(soundexWord).join("-");
}
function soundexWord(w) {
  if (!w) return "";
  const first = w[0];
  const map = {
    B:"1",F:"1",P:"1",V:"1",
    C:"2",G:"2",J:"2",K:"2",Q:"2",S:"2",X:"2",Z:"2",
    D:"3",T:"3",
    L:"4",
    M:"5",N:"5",
    R:"6"
  };
  let out = first;
  let prev = map[first] || "";
  for (let i = 1; i < w.length; i++) {
    const ch = w[i];
    const code = map[ch] || "";
    if (code && code !== prev) out += code;
    prev = code;
  }
  return (out + "000").slice(0, 4);
}

function levenshtein(a, b) {
  a = cleanText(a); b = cleanText(b);
  const n = a.length, m = b.length;
  if (!n) return m;
  if (!m) return n;

  const dp = new Array(m + 1);
  for (let j = 0; j <= m; j++) dp[j] = j;

  for (let i = 1; i <= n; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[m];
}

function scoreCandidate(queryRaw, item) {
  const q = cleanText(queryRaw);
  const qKey = soundKey(q);

  const t = item.telephony || "";
  const c = item.company || "";
  const d = item.designator || "";
  const id = item.identifier || "";

  const levT = t ? levenshtein(q, t) : 99;
  const levC = c ? levenshtein(q, c) : 99;
  const levD = d ? levenshtein(q, d) : 99;
  const levI = id ? levenshtein(q, id) : 99;
  const iata = item.iata || "";
const levIata = iata ? levenshtein(q, iata) : 99;

  let score = 0;
  score = Math.max(score, 100 - Math.min(90, levT * 9));
  score = Math.max(score, 85 - Math.min(70, levC * 6));
  score = Math.max(score, 75 - Math.min(60, levD * 10));
  score = Math.max(score, 75 - Math.min(60, levI * 10));
  
score = Math.max(score, 75 - Math.min(60, levIata * 10));
  const tKey = soundKey(t);
  const cKey = soundKey(c);

  if (qKey && tKey && qKey === tKey) score += 18;
  if (qKey && cKey && qKey === cKey) score += 10;

  const qNoSpace = q.replaceAll(" ", "");
  if (t.replaceAll(" ", "").includes(qNoSpace)) score += 18;
  if (c.replaceAll(" ", "").includes(qNoSpace)) score += 8;

  // ✅ NEW: strong boost for starts-with on short queries like "SKY"
  if (q.length <= 4) {
    if (t.replaceAll(" ", "").startsWith(qNoSpace)) score += 25;
    if (c.replaceAll(" ", "").startsWith(qNoSpace)) score += 12;
  }

  if (score > 130) score = 130;
  return score;
}

async function loadAircraftJsonOptimized() {
  const response = await fetch(chrome.runtime.getURL("aircraft.json"));
  const text = await response.text();

  const lines = text.split("\n").filter(Boolean);

  const typeMap = new Map();
  const regBatch = [];

  for (const line of lines) {
    const r = JSON.parse(line);

    if (r.reg && r.icaotype) {
  regBatch.push({
    reg: r.reg.toUpperCase(),
    icaotype: r.icaotype.toUpperCase(),
    manufacturer: (r.manufacturer || "").trim(),
    model: (r.model || "").trim(),
    ownop: (r.ownop || "").trim()
  });
}

  if (r.icaotype && r.model) {

  const key = r.icaotype.toUpperCase();
  const model = r.model.trim();
  const manufacturer = (r.manufacturer || "").trim();

  if (!model) continue;
  if (model.includes("/")) continue;

  const existing = typeMap.get(key);

  const upperModel = model.toUpperCase();

  const hasSpace = model.includes(" ");
  const hasLetters = /[A-Z]/i.test(model);
  const isPureNumericVariant = /^[0-9]+[A-Z]?$/.test(model);
  const looksDescriptive =
    hasSpace &&
    hasLetters &&
    !isPureNumericVariant &&
    model.length > 5;

  if (!existing) {
    typeMap.set(key, {
      icao: key,
      icaotype: key,
      manufacturer,
      model
    });
    continue;
  }

  // Strong preference for descriptive names
  const existingScore =
    existing.model.includes(" ") ? 2 : 0 +
    existing.model.length > 5 ? 1 : 0;

  const newScore =
    looksDescriptive ? 3 :
    hasSpace ? 2 :
    model.length > 5 ? 1 : 0;

  if (newScore > existingScore) {
    typeMap.set(key, {
      icao: key,
      icaotype: key,
      manufacturer,
      model
    });
  }
}
  }

  const db = await openDb();

  // Clear existing
  await new Promise((res, rej) => {
    const tx = db.transaction([STORE_TYPES, STORE_REGS], "readwrite");
    tx.objectStore(STORE_TYPES).clear();
    tx.objectStore(STORE_REGS).clear();
    tx.oncomplete = res;
    tx.onerror = rej;
  });

  // Bulk insert
  await new Promise((res, rej) => {
    const tx = db.transaction([STORE_TYPES, STORE_REGS], "readwrite");

    const typeStore = tx.objectStore(STORE_TYPES);
    const regStore  = tx.objectStore(STORE_REGS);

    for (const t of typeMap.values()) typeStore.put(t);
    for (const r of regBatch) regStore.put(r);

    tx.oncomplete = res;
    tx.onerror = rej;
  });

  db.close();
  console.log("Aircraft loaded:", typeMap.size, "types,", regBatch.length, "registrations");
}


async function loadWikipediaCallsigns() {
  const res = await fetch(chrome.runtime.getURL("airline-callsigns.clean.json"));
  if (!res.ok) throw new Error("Failed to load airline-callsigns.clean.json");

  const data = await res.json();
  const rows = Array.isArray(data) ? data : (data.all || []);

  const out = [];

  for (const r of rows) {
    const icao = cleanText(r.icao || "");
    const iata = cleanText(r.iata || "");
    const telephony = cleanText(r.callsign || r.telephony || "");
const company = String(r.airline || r.company || "").trim();
const country = String(r.country || "").trim();
const status = String(r.status || "").toLowerCase();
const comments = String(r.comments || "").trim();
const identifier = cleanText(r.identifier || "");

if (identifier && telephony && !icao) {
  out.push({
    key: `US:${identifier}`,
    type: "US",
    identifier,
    telephony,
    company,
    country,
    status,
    comments,
    source: "Manual / US Special"
  });
}

    if (!telephony) continue;

    if (/^[A-Z0-9]{3}$/.test(icao)) {
      out.push({
        key: `3LD:${icao}`,
        type: "WIKI",
        designator: icao,
        identifier: iata,
        iata,
        telephony,
        company,
        country,
          status,
  comments,
        source: "Wikipedia Airline Codes"
      });
    }

    if (/^[A-Z0-9]{2}$/.test(iata)) {
      out.push({
        key: `IATA:${iata}:${icao || company}`,
        type: "WIKI_IATA",
        designator: icao,
        identifier: iata,
        iata,
        telephony,
        company,
        country,
          status,
  comments,
        source: "Wikipedia Airline Codes"
      });
    }
  }

  return dedupeByKey(out);
}

async function loadFr24Callsigns(existingItems = []) {
  const res = await fetch(chrome.runtime.getURL("fr24.json"));
  if (!res.ok) throw new Error("Failed to load fr24.json");

  const data = await res.json();
  const rows = Array.isArray(data) ? data : (data.all || []);

  const existingCallsigns = new Set(
    existingItems
      .map(x => cleanText(x.telephony || x.callsign || ""))
      .filter(Boolean)
  );

  const out = [];

  for (const r of rows) {
    const icao = cleanText(r.icao || "");
    const iata = cleanText(r.iata || "");
    const telephony = cleanText(r.callsign || r.telephony || "");
    const company = String(r.airline || r.company || "").trim();
    const country = String(r.country || "").trim();
    const status = String(r.status || "active").toLowerCase();
    const comments = String(r.comments || "Imported from Flightradar24 airline list").trim();

    if (!telephony) continue;

if (existingCallsigns.has(telephony) && icao) continue;

    if (/^[A-Z0-9]{3}$/.test(icao)) {
      out.push({
        key: `FR24:3LD:${icao}`,
        type: "FR24",
        designator: icao,
        identifier: iata,
        iata,
        telephony,
        company,
        country,
        status,
        comments,
        source: "Flightradar24"
      });
    }

    if (/^[A-Z0-9]{2}$/.test(iata)) {
      out.push({
        key: `FR24:IATA:${iata}:${icao || company || telephony}`,
        type: "FR24_IATA",
        designator: icao,
        identifier: iata,
        iata,
        telephony,
        company,
        country,
        status,
        comments,
        source: "Flightradar24"
      });
    }
  }

  return dedupeByKey(out);
}

function statusRank(status) {
  const s = String(status || "").toLowerCase();
  if (s === "active") return 0;
  if (s === "unknown") return 1;
  if (s === "inactive" || s === "defunct") return 2;
  return 1;
}

/** ---------- HTML parsing (no DOM) ---------- **/
function decodeEntities(s) {
  return (s || "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function stripTags(html) {
  return decodeEntities(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function dedupeResults(items) {
  const seen = new Set();
  const out = [];

  for (const it of items) {
    const key = [
      it.designator,
      it.iata,
      it.identifier,
      cleanText(it.telephony),
      cleanText(it.company)
    ].join("|");

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }

  return out;
}

function parse3LDFromHtml(html, sourceLabel) {
  const out = [];

  // Prefer table row parsing
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html))) {
    const row = rowMatch[1];
    const cells = [];
    const cellRe = /<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(row))) {
      const txt = stripTags(cellMatch[2]).replace(/\s+/g, " ").trim();
      if (txt) cells.push(txt);
    }
    if (cells.length >= 4) {
      const maybe3 = cleanText(cells[cells.length - 1]);
      if (/^[A-Z0-9]{3}$/.test(maybe3)) {
        const telephony = cleanText(cells[cells.length - 2]);
        const country = cells[cells.length - 3].trim();
        const company = cells.slice(0, cells.length - 3).join(" ").trim();
        if (company.toUpperCase() === "COMPANY") continue;

        out.push({
          key: `3LD:${maybe3}`,
          type: "3LD",
          designator: maybe3,
          telephony,
          company,
          country,
          source: sourceLabel
        });
      }
    }
  }

  if (out.length > 100) return dedupeByKey(out);

  const text = stripTags(html);
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length - 3; i++) {
    const code = cleanText(lines[i + 3]);
    if (/^[A-Z0-9]{3}$/.test(code)) {
      const company = lines[i];
      const country = lines[i + 1];
      const telephony = cleanText(lines[i + 2]);
      out.push({
        key: `3LD:${code}`,
        type: "3LD",
        designator: code,
        telephony,
        company,
        country,
        source: sourceLabel
      });
    }
  }
  return dedupeByKey(out);
}

function parseUSSpecialFromHtml(html, sourceLabel) {
  const out = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html))) {
    const row = rowMatch[1];
    const cells = [];
    const cellRe = /<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(row))) {
      const txt = stripTags(cellMatch[2]).replace(/\s+/g, " ").trim();
      if (txt) cells.push(txt);
    }
    if (cells.length >= 3) {
      const telephony = cleanText(cells[0]);
      const identifier = cleanText(cells[1]);
      const company = cells[2].trim();
      const expiration = (cells[3] || "").trim();

      if (telephony === "TELEPHONY CALL SIGN" || identifier === "IDENTIFIER") continue;

      if (identifier && telephony) {
        out.push({
          key: `US:${identifier}`,
          type: "US",
          identifier,
          telephony,
          company,
          country: "UNITED STATES",
          expiration,
          source: sourceLabel
        });
      }
    }
  }
  return dedupeByKey(out);
}

function parseNotices3LD(html) {
  const out = [];
  const text = stripTags(html).replace(/\s+/g, " ");

  const re = /DESIGNATOR\s*\(3LD\)\s*[“"]([A-Z0-9]{3})[”"]\s*AND\s*ASSOCIATED\s*CALL\s*SIGN\s*[“"]([^”"]+)[”"]/gi;

  let m;
  while ((m = re.exec(text))) {
    const designator = cleanText(m[1]);
    const telephony = cleanText(m[2]);

    if (!/^[A-Z0-9]{3}$/.test(designator) || !telephony) continue;

    out.push({
      key: `3LD:${designator}`,
      type: "3LD",
      designator,
      telephony,
      company: "",
      country: "UNITED STATES",
      source: "FAA Notices"
    });
  }

  return dedupeByKey(out);
}

function dedupeByKey(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it?.key || seen.has(it.key)) continue;
    seen.add(it.key);
    out.push(it);
  }
  return out;
}

/** ---------- Refresh ---------- **/
async function refreshDatabase() {
  const [enc, cam, us, notices] = await Promise.all([
    fetch(URL_ENCODE, { cache: "no-store" }).then(r => r.ok ? r.text() : Promise.reject(new Error(`Encode fetch ${r.status}`))),
    fetch(URL_CAM,    { cache: "no-store" }).then(r => r.ok ? r.text() : Promise.reject(new Error(`CAM fetch ${r.status}`))),
    fetch(URL_USSPEC, { cache: "no-store" }).then(r => r.ok ? r.text() : Promise.reject(new Error(`US Special fetch ${r.status}`))),
    fetch(URL_NOTICES,{ cache: "no-store" }).then(r => r.ok ? r.text() : Promise.reject(new Error(`Notices fetch ${r.status}`)))
  ]);

const a = parse3LDFromHtml(enc, "FAA Encode");
const b = parse3LDFromHtml(cam, "FAA CAM");
const c = parseUSSpecialFromHtml(us, "FAA US Special");
const d = parseNotices3LD(notices);
const wiki = await loadWikipediaCallsigns();

const base = dedupeByKey([...a, ...b, ...c, ...d, ...wiki]);

// FR24 only fills callsigns that do NOT already exist
const fr24 = await loadFr24Callsigns(base);

const merged = dedupeByKey([...base, ...fr24]);

  if (!merged.length) throw new Error("Parsed 0 entries from FAA pages.");

  const db = await openDb();
  await clearStore(db);
  await bulkPut(db, merged);
  db.close();

  await chrome.storage.local.set({ [META_KEY]: Date.now() });
  return merged.length;
}

/** ---------- Messaging ---------- **/
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {




      if (msg?.type === "ensure") {
        const meta = await chrome.storage.local.get([META_KEY]);
        if (!meta[META_KEY]) {
  await refreshDatabase();
}

await ensureAircraftLoaded(); // ALWAYS check aircraft separately
        sendResponse({ ok: true, ready: !!meta[META_KEY] });
        return;
      }

      if (msg?.type === "meta") {
        const meta = await chrome.storage.local.get([META_KEY]);
        sendResponse({ ok: true, lastUpdated: meta[META_KEY] || null });
        return;
      }

      if (msg?.type === "refresh") {
        const count = await refreshDatabase();
        sendResponse({ ok: true, count });
        return;
      }

if (msg?.type === "exactIdentifier") {
  const meta = await chrome.storage.local.get([META_KEY]);
  if (!meta[META_KEY]) {
    await refreshDatabase();
  }

  const code = cleanText(String(msg.code || ""));

  if (!code) {
    sendResponse({ ok: true, telephonies: [] });
    return;
  }

  const db = await openDb();
  const all = await getAll(db);
  db.close();

  const matches = all.filter(it =>
    String(it.identifier || "").toUpperCase() === code
  );

  sendResponse({
    ok: true,
    telephonies: matches.map(m => m.telephony).filter(Boolean),
    items: matches
  });

  return;
}      

if (msg?.type === "exactIata") {
  const meta = await chrome.storage.local.get([META_KEY]);
  if (!meta[META_KEY]) {
    await refreshDatabase();
  }

  const code = cleanText(String(msg.code || "")).slice(0, 2);

  if (!/^[A-Z0-9]{2}$/.test(code)) {
    sendResponse({ ok: true, telephonies: [] });
    return;
  }

  const db = await openDb();
  const all = await getAll(db);
  db.close();

const matches = all
  .filter(it =>
    String(it.iata || "").toUpperCase() === code
  )
  .sort((a, b) =>
    statusRank(a.status) - statusRank(b.status)
  );

  sendResponse({
    ok: true,
    telephonies: matches.map(m => m.telephony).filter(Boolean),
    items: matches
  });

  return;
}
if (msg?.type === "countries") {
  const meta = await chrome.storage.local.get([META_KEY]);
  if (!meta[META_KEY]) {
    await refreshDatabase();
  }

  const db = await openDb();
  const all = await getAll(db);
  db.close();

  const countryMap = new Map();

  for (const x of all) {
    const raw = String(x.country || "").trim();
    if (!raw) continue;

    const key = raw.toUpperCase();

    const pretty = raw
      .toLowerCase()
      .replace(/\b\w/g, c => c.toUpperCase());

    if (!countryMap.has(key)) {
      countryMap.set(key, pretty);
    }
  }

  const countries = [...countryMap.values()]
    .sort((a, b) => a.localeCompare(b));

  sendResponse({ ok: true, countries });
  return;
}

if (msg?.type === "exact3ld") {
  const meta = await chrome.storage.local.get([META_KEY]);
  if (!meta[META_KEY]) await refreshDatabase();

  const code = cleanText(String(msg.code || "")).slice(0, 3);

  if (!/^[A-Z0-9]{3}$/.test(code)) {
    sendResponse({ ok: true, telephony: null, telephonies: [] });
    return;
  }

  const db = await openDb();
  const all = await getAll(db);
  db.close();

  const matches = all.filter(it =>
    String(it.designator || "").toUpperCase() === code
  );

  sendResponse({
    ok: true,
    telephony: matches[0]?.telephony || null,
    telephonies: [...new Set(matches.map(m => m.telephony).filter(Boolean))],
    items: matches
  });

  return;
}



if (msg?.type === "reg_query") {

  const qRaw = msg.q || "";
  const q = cleanText(qRaw);
  if (!q) {
    sendResponse({ ok: true, items: [] });
    return;
  }

  const db = await openDb();
  const tx = db.transaction(STORE_REGS, "readonly");
  const store = tx.objectStore(STORE_REGS);

  const allRegs = await new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = reject;
  });

  db.close();

  const qNorm = q.replaceAll("-", "");

  const scored = allRegs.map(r => {

    const regNorm = r.reg.replaceAll("-", "");
    let score = 0;

    if (regNorm === qNorm) score = 1000;
    else if (regNorm.startsWith(qNorm)) score = 900;
    else if (regNorm.endsWith(qNorm)) score = 850;
    else if (regNorm.includes(qNorm)) score = 800;
    else {
      const lev = levenshtein(qNorm, regNorm);
      if (lev <= 2) score = 600 - (lev * 50);
    }

    return { ...r, score };

  })
  .filter(r => r.score > 0)
  .sort((a,b)=>b.score-a.score)
  .slice(0, 12);

  sendResponse({
    ok: true,
    items: scored.map(r => ({
      resultType: "registration",
      reg: r.reg,
      icaotype: r.icaotype,
      manufacturer: r.manufacturer,
      model: r.model,
      ownop: r.ownop
    }))
  });

  return;
}

if (msg?.type === "code_query") {
  const q = cleanText(String(msg.q || ""));

  if (!q) {
    sendResponse({ ok: true, items: [] });
    return;
  }

  const db = await openDb();
  const all = await getAll(db);
  db.close();

  const items = all
    .filter(it => {
      const icao = String(it.designator || "").toUpperCase();
      const iata = String(it.iata || it.identifier || "").toUpperCase();

      return icao === q || iata === q || icao.startsWith(q) || iata.startsWith(q);
    })
    .slice(0, 30);

  sendResponse({ ok: true, items });
  return;
}

if (msg?.type === "iata_query") {
  const q = cleanText(String(msg.q || "")).slice(0, 2);

  if (!/^[A-Z0-9]{2}$/.test(q)) {
    sendResponse({ ok: true, items: [] });
    return;
  }

  const db = await openDb();
  const all = await getAll(db);
  db.close();

const matches = all
  .filter(it =>
    String(it.iata || "").toUpperCase() === q
  )
  .sort((a, b) =>
    statusRank(a.status) - statusRank(b.status)
  );

  sendResponse({
    ok: true,
    items: matches.slice(0, 20)
  });

  return;
}

if (msg?.type === "query") {
  const meta = await chrome.storage.local.get([META_KEY]);
  if (!meta[META_KEY]) await refreshDatabase();

  const qRaw = String(msg.q || "").trim();
  if (!qRaw) {
    sendResponse({ ok: true, mode: "empty", items: [] });
    return;
  }

  const q = cleanText(qRaw);
  const qUpper = q.toUpperCase();
  const countryFilter = String(msg.country || "").trim().toUpperCase();

  let db;

  try {
    db = await openDb();
    const all = await getAll(db);

    const exactItems = all.filter(it => (
      String(it.designator || "").toUpperCase() === qUpper ||
      String(it.iata || "").toUpperCase() === qUpper ||
      String(it.identifier || "").toUpperCase() === qUpper ||
      cleanText(it.telephony || "") === qUpper ||
      cleanText(it.company || "") === qUpper
    ));

    const exactKeys = new Set(exactItems.map(x => x.key));

    const scored = all
      .filter(it => !exactKeys.has(it.key))
      .filter(it => {
        if (!countryFilter) return true;
        return String(it.country || "").trim().toUpperCase() === countryFilter;
      })
      .map(it => ({ ...it, score: scoreCandidate(qRaw, it) }))
      .filter(it => it.score >= 60)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);

    const aircraftResults = [];

    const items = dedupeResults([
      ...exactItems,
      ...scored,
      ...aircraftResults
    ]).slice(0, 12);

    sendResponse({
      ok: true,
      mode: exactItems.length ? "exact_plus_fuzzy" : "fuzzy",
      items
    });

  } catch (err) {
    console.error("QUERY ERROR:", err);
    sendResponse({ ok: false, error: err.message });
  } finally {
    if (db) db.close();
  }

  return;
}


sendResponse({ ok: false, error: "Unknown message type." });

} catch (e) {
  sendResponse({ ok: false, error: e?.message || String(e) });
}
})();

return true;
});

(async () => {
  try {
    console.log("Initializing aircraft database...");
    await ensureAircraftLoaded();
    console.log("Aircraft DB ready.");
  } catch (e) {
    console.error("Aircraft init failed:", e);
  }
})();