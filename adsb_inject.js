console.log("[CALLSIGN EXT] Injection loaded", location.href);

let lastCallsign = "";
let observerStarted = false;

/* ===============================
   Callsign detection (improved)
================================= */
function looksLikeCallsign(cs) {
  // DAL123, DAL, BAW97W, AFR42X, etc
  return /^[A-Z]{2,5}[A-Z0-9]{0,5}$/.test(cs);
}

/* ===============================
   Inject telephony line
================================= */
function injectTelephony(callsignEl, telephonies) {
  removeInjection();

  if (!Array.isArray(telephonies) || !telephonies.length) return;

  const container = document.createElement("div");
  container.id = "telephonyInjected";
  container.style.marginTop = "6px";

  for (const t of telephonies) {
    const line = document.createElement("div");
    line.style.fontSize = "16px";
    line.style.fontWeight = "700";
    line.style.color = "#4da3ff";
    line.textContent = t;

    container.appendChild(line);
  }

  callsignEl.parentElement.appendChild(container);
}

function removeInjection() {
  const old = document.getElementById("telephonyInjected");
  if (old) old.remove();
}

/* ===============================
   Query background DB
================================= */
async function queryTelephonyExact(code, mode) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: mode, code },
      (res) => {
        if (!res) return resolve([]);
        if (res.telephonies) return resolve(res.telephonies);
        if (res.telephony) return resolve([res.telephony]);
        resolve([]);
      }
    );
  });
}

/* ===============================
   Main lookup
================================= */
async function lookupAndInject() {
  const callsignEl = document.getElementById("selected_callsign");
  if (!callsignEl) return;

  const callsign = (callsignEl.textContent || "")
    .trim()
    .toUpperCase();

  if (!looksLikeCallsign(callsign)) {
    removeInjection();
    return;
  }

  if (callsign === lastCallsign) return;
  lastCallsign = callsign;

  removeInjection();

let telephonies = [];

const ident = callsign.replace(/[0-9].*$/, "");

// exact special identifiers first: BMBR, BDOG, POLR, NASA
telephonies = await queryTelephonyExact(ident, "exactIdentifier");

// ICAO fallback
if (!telephonies.length) {
  const icaoCode = callsign.slice(0, 3);
  telephonies = await queryTelephonyExact(icaoCode, "exact3ld");
}

// IATA fallback
if (!telephonies.length) {
  const iataCode = callsign.slice(0, 2);
  telephonies = await queryTelephonyExact(iataCode, "exactIata");
}

if (!telephonies.length) return;

telephonies = [...new Set(telephonies)];

injectTelephony(callsignEl, telephonies);
}

/* ===============================
   Observe ADS-B panel changes
================================= */
function startObserver() {
  if (observerStarted) return;
  observerStarted = true;

  const container =
    document.getElementById("infoblock-container") || document.body;

  const observer = new MutationObserver(() => {
    lookupAndInject();
  });

  observer.observe(container, {
    childList: true,
    subtree: true,
    characterData: true
  });

  lookupAndInject();
}

/* ===============================
   Wait for panel to exist
================================= */
const wait = setInterval(() => {
  if (
    document.getElementById("infoblock-container") &&
    document.getElementById("selected_callsign")
  ) {
    clearInterval(wait);
    startObserver();
  }
}, 200);