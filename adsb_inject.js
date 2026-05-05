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
function injectTelephony(callsignEl, telephonies, items = []) {
  removeInjection();

  if (!Array.isArray(telephonies) || !telephonies.length) return;

  const fr24Telephonies = new Set(
    items
      .filter(it => it.type === "FR24" || it.type === "FR24_IATA")
      .map(it => it.telephony)
      .filter(Boolean)
  );

  const container = document.createElement("div");
  container.id = "telephonyInjected";
  container.style.marginTop = "6px";

  for (const t of telephonies) {
    const isFr24 = fr24Telephonies.has(t);

    const line = document.createElement("div");
    line.style.fontSize = isFr24 ? "13px" : "16px";
    line.style.fontWeight = "700";
    line.style.color = isFr24 ? "#9ca3af" : "#4da3ff";

    if (isFr24) {
      line.textContent = t;
      const badge = document.createElement("span");
      badge.textContent = " airline name";
      badge.style.fontWeight = "400";
      badge.style.fontSize = "11px";
      badge.style.color = "#6b7280";
      line.appendChild(badge);
    } else {
      line.textContent = t;
    }

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
        if (!res) return resolve({ telephonies: [], items: [] });
        resolve({
          telephonies: res.telephonies || (res.telephony ? [res.telephony] : []),
          items: res.items || []
        });
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
let matchedItems = [];

const ident = callsign.replace(/[0-9].*$/, "");

// exact special identifiers first: BMBR, BDOG, POLR, NASA
({ telephonies, items: matchedItems } = await queryTelephonyExact(ident, "exactIdentifier"));

// ICAO fallback
if (!telephonies.length) {
  const icaoCode = callsign.slice(0, 3);
  ({ telephonies, items: matchedItems } = await queryTelephonyExact(icaoCode, "exact3ld"));
}

// IATA fallback
if (!telephonies.length) {
  const iataCode = callsign.slice(0, 2);
  ({ telephonies, items: matchedItems } = await queryTelephonyExact(iataCode, "exactIata"));
}

if (!telephonies.length) return;

telephonies = [...new Set(telephonies)];

injectTelephony(callsignEl, telephonies, matchedItems);
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