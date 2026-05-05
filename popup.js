import Fuse from "./fuse.js";

const $ = (id) => document.getElementById(id);
const codeInput = $("codeInput");

let aircraftFuse = null;

async function initAircraftTypeFuse() {
  const res = await fetch("aircraft_types.json");
  const data = await res.json();

  const preparedData = [];

  Object.keys(data).forEach((key) => {
    const entry = data[key];
    if (entry && entry.m) {
      entry.m.split("/").forEach((name) => {
        preparedData.push({
          resultType: "type",
          icaotype: entry.icao,
          model: name.trim(),
          manufacturer: ""
        });
      });
    }
  });

  aircraftFuse = new Fuse(preparedData, {
    keys: [
      { name: "icaotype", weight: 0.7 },
      { name: "model", weight: 0.3 }
    ],
    threshold: 0.4,
    includeScore: true
  });
}

function escapeHtml(s) {
  return (s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isoToFlagEmoji(code) {
  if (!/^[A-Z]{2}$/.test(code)) return "";
  return [...code]
    .map(c => String.fromCodePoint(127397 + c.charCodeAt(0)))
    .join("");
}

function countryToIso(country) {
  const raw = String(country || "").trim();
  if (!raw) return "";

  const aliases = {
    "UNITED STATES": "US",
    "UNITED STATES OF AMERICA": "US",
    "UNITED KINGDOM": "GB",
    "RUSSIA": "RU",
    "SOUTH KOREA": "KR",
    "NORTH KOREA": "KP",
    "IRAN": "IR",
    "VIETNAM": "VN",
    "LAOS": "LA",
    "SYRIA": "SY",
    "TANZANIA": "TZ",
    "BOLIVIA": "BO",
    "VENEZUELA": "VE",
    "MOLDOVA": "MD",
    "MACAO": "MO",
    "HONG KONG": "HK",
    "CZECH REPUBLIC": "CZ",
    "IVORY COAST": "CI",
    "CÔTE D'IVOIRE": "CI"
  };

  const key = raw.toUpperCase();
  if (aliases[key]) return aliases[key];

  try {
    const dn = new Intl.DisplayNames(["en"], { type: "region" });

    for (let a = 65; a <= 90; a++) {
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        if (dn.of(code)?.toUpperCase() === key) return code;
      }
    }
  } catch {}

  return "";
}

function countryLabel(country) {
  const iso = countryToIso(country);
  const flag = isoToFlagEmoji(iso);
  return `${flag ? flag + " " : ""}${country || ""}`;
}

async function loadCountryFilter() {
  if (!countryFilter) return;

  const res = await send({ type: "countries" });
  if (!res?.ok) return;

  countryFilter.innerHTML = `<option value="">All countries</option>`;

  for (const country of res.countries || []) {
    const opt = document.createElement("option");
    opt.value = country;
    opt.textContent = country;
    countryFilter.appendChild(opt);
  }
}

async function doIataSearch(q) {
  setStatus("Searching IATA…");

  const res = await send({ type: "iata_query", q });

  if (!res?.ok) {
    setStatus(res?.error || "IATA search failed.", true);
    return;
  }

  renderResults(res.items || []);
}

/* =========================
   RENDER RESULTS
========================= */
function renderResults(items) {
  const el = $("results");
  if (!el) return;

  el.innerHTML = "";

  if (!items || items.length === 0) {
    el.innerHTML = `<div class="muted">No matches.</div>`;
    return;
  }

  for (const it of items) {

    /* =========================
       REGISTRATION RESULT
    ========================= */
    if (it.resultType === "registration") {
      el.insertAdjacentHTML("beforeend", `
        <div class="result-card">
          <div class="result-icao">${escapeHtml(it.reg)}</div>
          <div class="result-model">
            ${escapeHtml(it.manufacturer || "")} ${escapeHtml(it.model || "")}
          </div>
          <div class="result-manufacturer">
            ${escapeHtml(it.ownop || "Unknown")}
          </div>
        </div>
      `);
      continue;
    }

    /* =========================
       AIRCRAFT TYPE RESULT
    ========================= */
if (it.resultType === "type") {
  el.insertAdjacentHTML("beforeend", `
    <div class="result-row">
      <span class="r-icao">${escapeHtml(it.icaotype)}</span>
      <span class="r-model">${escapeHtml(it.model || "")}</span>
      <span class="r-make">${escapeHtml(it.manufacturer || "")}</span>
    </div>
  `);
  continue;
}

    /* =========================
       CALLSIGN RESULT
    ========================= */
el.insertAdjacentHTML("beforeend", `
  <div class="callsign-card">
    <div class="card-topline">
      <div class="code-group">
        ${it.designator ? `<span class="code-pill icao-pill">ICAO ${escapeHtml(it.designator)}</span>` : ""}
        ${it.iata ? `<span class="code-pill iata-pill">IATA ${escapeHtml(it.iata)}</span>` : ""}
      </div>
      ${it.status ? `<span class="status-pill ${escapeHtml(it.status)}">${escapeHtml(it.status)}</span>` : ""}
    </div>

    <div class="label">${it.type === "FR24" || it.type === "FR24_IATA" ? "AIRLINE NAME" : "CALLSIGN"}</div>
    <div class="callsign-main${it.type === "FR24" || it.type === "FR24_IATA" ? " fr24-name" : ""}">${escapeHtml(it.telephony || "(no telephony)")}</div>

<div class="meta-row">
  <span class="meta-item">${escapeHtml(it.company || "Unknown")}</span>
  <span class="meta-sep">•</span>
  <span class="meta-item">${escapeHtml(countryLabel(it.country))}</span>
</div>

${it.comments ? `
  <div class="comments">
    <div class="comment-header">NOTE</div>
    <div class="comment-body">
      ${escapeHtml(it.comments)}
    </div>
  </div>
` : ""}
  </div>
`);
  }
}

function setStatus(msg, isError = false) {
  const el = $("status");
  if (!el) return;
  el.innerHTML = isError
    ? `<span class="error">${escapeHtml(msg)}</span>`
    : escapeHtml(msg);
}

async function send(msg) {
  return new Promise((resolve) =>
    chrome.runtime.sendMessage(msg, resolve)
  );
}

/* =========================
   SEARCH FUNCTIONS
========================= */

async function doAirlineSearch(q) {
  if (!q) return;

  setStatus("Searching airline…");

  const country = countryFilter?.value || "";
const res = await send({ type: "query", q, country });

  if (!res?.ok) {
    setStatus(res?.error || "Search failed.", true);
    return;
  }

  renderResults(res.items);
}

async function doRegSearch(q) {
  if (!q) return;

  setStatus("Searching registration…");

  const res = await send({ type: "reg_query", q });

  renderResults(res?.items || []);
}

async function doTypeSearch(q) {
  if (!q) return;

  setStatus("Searching aircraft type…");

  if (!aircraftFuse) {
    renderResults([]);
    return;
  }

  const results = aircraftFuse.search(q);

  const items = results.slice(0, 15).map((r) => r.item);

  renderResults(items);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* =========================
   EVENT LISTENERS
========================= */

const airlineInput = $("callsignInput");
const regInput = $("regInput");
const typeInput = $("typeInput");
const refreshBtn = $("refreshBtn");
const countryFilter = $("countryFilter");

/* Airline Search */
if (airlineInput) {
  airlineInput.addEventListener("input", debounce(() => {
    if (regInput) regInput.value = "";
    if (typeInput) typeInput.value = "";
    doAirlineSearch(airlineInput.value.trim());
  }, 250));
}

/* Registration Search */
if (regInput) {
  let lastRegQuery = "";

  regInput.addEventListener("input", debounce(async () => {

    const q = regInput.value.trim();

    if (airlineInput) airlineInput.value = "";
    if (typeInput) typeInput.value = "";

    if (q.length < 3) {
      renderResults([]);
      return;
    }

    lastRegQuery = q;
    setStatus("Searching registration…");

    const res = await send({ type: "reg_query", q });

    if (regInput.value.trim() !== lastRegQuery) return;

    renderResults(res?.items || []);

  }, 350));
}

/* Aircraft Type Search */
if (typeInput) {
  typeInput.addEventListener("input", debounce(() => {

    if (airlineInput) airlineInput.value = "";
    if (regInput) regInput.value = "";

    const q = typeInput.value.trim();
    if (!q) {
      renderResults([]);
      return;
    }

    doTypeSearch(q);

  }, 250));
}

if (countryFilter) {
  countryFilter.addEventListener("change", () => {
    const q = airlineInput?.value?.trim();
    if (q) doAirlineSearch(q);
  });
}

if (codeInput) {
  codeInput.addEventListener("input", debounce(() => {
    if (airlineInput) airlineInput.value = "";
    if (regInput) regInput.value = "";
    if (typeInput) typeInput.value = "";

    let q = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");

    // enforce max 2 chars
    if (q.length > 2) q = q.slice(0, 2);

    codeInput.value = q;

    if (q.length < 2) {
      renderResults([]);
      return;
    }

    doIataSearch(q);
  }, 150));
}

/* Refresh */
if (refreshBtn) {
  refreshBtn.addEventListener("click", async () => {
    setStatus("Refreshing database…");
    const res = await send({ type: "refresh" });
    setStatus(res?.ok ? "Database refreshed." : "Refresh failed.", !res?.ok);
  });
}

/* =========================
   INIT
========================= */

(async function init() {
  setStatus("Initializing...");
  await send({ type: "ensure" });
await initAircraftTypeFuse();
await loadCountryFilter();
setStatus("Ready.");
})();