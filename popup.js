// Settings panel. It only reads/writes chrome.storage.sync; content.js reacts.
// Everything is read-modify-write on the ONE `settings` object, so no field ever
// clobbers another. SETTINGS_KEY + the defaults are duplicated in content.js —
// keep them in sync.
const SETTINGS_KEY = "settings";
const DEFAULT_SETTINGS = { masterEnabled: true };
// The nine switches. The six hides + showFeed ON, startOnSubscriptions OFF,
// speedButtons ON — an absent field reads as its default, so this equals
// LearnTube 1.0 exactly (plus the feed button and speed control).
const DEFAULT_TOGGLES = {
  hideShorts: true,
  hideWatchSuggestions: true,
  hideComments: true,
  hideEndCards: true,
  simplifyMasthead: true,
  replaceHome: true,
  showFeed: true, // the Library's "Show feed" (Peek) button — off = no button at all
  startOnSubscriptions: false,
  speedButtons: true, // Patch 2: the "−  1.00×  +" control on every watch page
};
// Patch 2: how much one press of − / + moves the speed. A NUMBER, so it rides
// settings.speedStep directly (like peekView), not settings.toggles. Anything
// off this list reads as the default. Kept in sync with content.js.
const SPEED_STEPS = [0.25, 0.5, 1];
const DEFAULT_SPEED_STEP = 0.25;

function readSpeedStep(settings) {
  const n = settings && Number(settings.speedStep);
  return SPEED_STEPS.indexOf(n) >= 0 ? n : DEFAULT_SPEED_STEP;
}

// Patch 3: the two speed hotkeys. Plain settings fields holding one e.key each
// (the key FACE, so the box below can show back exactly what was pressed).
// Kept in sync with content.js.
const DEFAULT_SPEED_KEY_DOWN = "[";
const DEFAULT_SPEED_KEY_UP = "]";

// May this key face be a shortcut at all? Asked before a binding is WRITTEN and
// again when one is READ, so a value the UI would refuse can't slip in by hand-
// editing storage. Tab and Enter would cost the watch page something with no way
// back from inside it (focus navigation; every keyboard activation of a link or
// button), and F1-F24 belong to the browser. Kept in sync with content.js.
function isBindableKey(key) {
  if (typeof key !== "string" || key.length < 1 || key.length > 20) return false;
  if (key === "Tab" || key === "Enter") return false;
  return !/^F([1-9]|1[0-9]|2[0-4])$/.test(key);
}

function readSpeedKey(settings, field, fallback) {
  const k = settings && settings[field];
  return isBindableKey(k) ? k : fallback;
}

// What to print on the cap. A space would be an invisible label, so it gets a
// name; everything else is shown as the layout produced it.
function keyFace(key) {
  return key === " " ? "Space" : key;
}

// Which modifier states let a press count as a key the user meant. Meta never
// does; ctrl / alt never do EXCEPT as AltGr, which is not a modifier but part of
// the character (AltGr sets altKey everywhere, and ctrlKey too on Windows).
// Duplicated in content.js — keep the two in sync.
function speedKeyModifiersOk(e) {
  if (e.metaKey) return false;
  const altGraph =
    typeof e.getModifierState === "function" && e.getModifierState("AltGraph");
  if (altGraph) return true;
  return !e.ctrlKey && !e.altKey;
}

const master = document.getElementById("master-toggle");
const toggleInputs = Array.prototype.slice.call(
  document.querySelectorAll("input[data-toggle]")
);
const speedStepSelect = document.getElementById("speed-step");
// [element, settings field, default] for each capture box.
const speedKeyCaps = [
  [document.getElementById("speed-key-down"), "speedKeyDown", DEFAULT_SPEED_KEY_DOWN],
  [document.getElementById("speed-key-up"), "speedKeyUp", DEFAULT_SPEED_KEY_UP],
];
// The box currently listening for a key, if any (only ever one).
let capturingCap = null;
const blockedList = document.getElementById("blocked-list");
const blockedEmpty = document.getElementById("blocked-empty");

// Read-modify-write the whole settings object (never clobbers other fields).
function writeSettings(mutate) {
  chrome.storage.sync.get({ [SETTINGS_KEY]: DEFAULT_SETTINGS }, (res) => {
    const settings = Object.assign({}, DEFAULT_SETTINGS, res[SETTINGS_KEY]);
    mutate(settings);
    chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
  });
}

function renderFrom(settings) {
  master.checked = !!settings.masterEnabled;
  const t = Object.assign({}, DEFAULT_TOGGLES, settings.toggles || {});
  toggleInputs.forEach((input) => {
    input.checked = t[input.dataset.toggle] !== false;
  });
  speedStepSelect.value = String(readSpeedStep(settings));
  renderSpeedKeys(settings);
  renderBlocked(settings.blockedCreators || {});
}

// Paint both caps from settings. A box mid-capture keeps its "press a key…"
// prompt — a storage write from another surface must not steal the prompt away
// from a user who is standing on the key.
function renderSpeedKeys(settings) {
  speedKeyCaps.forEach(([el, field, fallback]) => {
    if (!el || el === capturingCap) return;
    const face = el.querySelector(".keycap-face");
    const key = readSpeedKey(settings, field, fallback);
    face.textContent = keyFace(key); // key face -> textContent, never innerHTML
    el.setAttribute(
      "aria-label",
      (field === "speedKeyUp" ? "Speed up" : "Speed down") +
        " key: " +
        keyFace(key) +
        ". Click, then press a key to change it."
    );
  });
}

function startCapture(el) {
  if (capturingCap && capturingCap !== el) stopCapture();
  capturingCap = el;
  el.classList.add("is-capturing");
  el.querySelector(".keycap-face").textContent = "press a key…";
}

// Leave capture mode and repaint from storage (so a cancel restores the real
// key, and a save shows the one just written).
function stopCapture() {
  const el = capturingCap;
  capturingCap = null;
  if (el) el.classList.remove("is-capturing");
  chrome.storage.sync.get({ [SETTINGS_KEY]: DEFAULT_SETTINGS }, (res) => {
    renderSpeedKeys(res[SETTINGS_KEY] || DEFAULT_SETTINGS);
  });
}

// The Blocked list (Phase 3): each key as plain text + a ✕ that unblocks it.
function renderBlocked(blocked) {
  blockedList.textContent = "";
  const keys = Object.keys(blocked || {});
  keys.sort((a, b) => (blocked[b] || 0) - (blocked[a] || 0)); // newest first
  blockedEmpty.style.display = keys.length ? "none" : "";
  keys.forEach((key) => {
    const row = document.createElement("div");
    row.className = "blocked-row";
    const label = document.createElement("span");
    label.className = "blocked-key";
    label.textContent = key; // channel key -> textContent, never innerHTML
    row.appendChild(label);
    const x = document.createElement("button");
    x.className = "blocked-x";
    x.type = "button";
    x.dataset.unblock = key; // key in dataset only
    x.textContent = "✕";
    x.setAttribute("aria-label", "Unblock " + key);
    row.appendChild(x);
    blockedList.appendChild(row);
  });
}

chrome.storage.sync.get({ [SETTINGS_KEY]: DEFAULT_SETTINGS }, (res) => {
  renderFrom(res[SETTINGS_KEY] || DEFAULT_SETTINGS);
});

master.addEventListener("change", () => {
  writeSettings((s) => {
    s.masterEnabled = master.checked;
  });
});

toggleInputs.forEach((input) => {
  input.addEventListener("change", () => {
    writeSettings((s) => {
      s.toggles = Object.assign({}, DEFAULT_TOGGLES, s.toggles || {});
      s.toggles[input.dataset.toggle] = input.checked;
    });
  });
});

// Patch 2: the speed step — a number on the settings object, not a switch.
speedStepSelect.addEventListener("change", () => {
  const step = Number(speedStepSelect.value);
  writeSettings((s) => {
    s.speedStep = SPEED_STEPS.indexOf(step) >= 0 ? step : DEFAULT_SPEED_STEP;
  });
});

// Patch 3: the speed hotkeys. Click a box to arm it, then the next real key is
// the shortcut. Escape cancels, Backspace/Delete puts the default back.
speedKeyCaps.forEach(([el]) => {
  if (!el) return;
  el.addEventListener("click", () => {
    if (capturingCap === el) stopCapture();
    else startCapture(el);
  });
});

// One document listener, because the armed box owns the whole keyboard while it
// is armed (including Tab and Enter — otherwise arming a box and pressing Tab
// would bind nothing and move focus instead).
document.addEventListener(
  "keydown",
  (e) => {
    if (!capturingCap) return;
    e.preventDefault();
    e.stopPropagation();
    // Mid-IME composition: the key is "Process", not a face anybody could press
    // again. Wait it out (parity with content.js, which ignores the same thing).
    if (e.isComposing || e.keyCode === 229) return;
    const key = e.key;
    // A bare modifier press is the user reaching for a combination — wait for
    // the key it modifies rather than binding "Shift".
    if (
      key === "Shift" ||
      key === "Control" ||
      key === "Alt" ||
      key === "Meta" ||
      key === "AltGraph"
    )
      return;
    // Same modifier rule as content.js, AltGr included: on QWERTZ/AZERTY the
    // bracket keys ARE AltGr presses, and a box that refused them could never
    // bind the very defaults those keyboards ship with. (Kept in sync there.)
    if (!speedKeyModifiersOk(e)) return;
    // A key we refuse to bind leaves the box ARMED, exactly like the modifier
    // refusal — the user just presses another one. Space and YouTube's own
    // player keys stay bindable: taking one of those over is a deliberate
    // choice, and suppress-on-fire is the designed behaviour.
    if (key !== "Escape" && key !== "Backspace" && key !== "Delete" && !isBindableKey(key))
      return;
    if (key === "Escape") {
      stopCapture();
      return;
    }
    const cap = capturingCap;
    const field = cap === speedKeyCaps[1][0] ? "speedKeyUp" : "speedKeyDown";
    const other = field === "speedKeyUp" ? "speedKeyDown" : "speedKeyUp";
    const fallback =
      field === "speedKeyUp" ? DEFAULT_SPEED_KEY_UP : DEFAULT_SPEED_KEY_DOWN;
    const otherFallback =
      field === "speedKeyUp" ? DEFAULT_SPEED_KEY_DOWN : DEFAULT_SPEED_KEY_UP;
    // Backspace / Delete put this box's default back; anything else binds the
    // key that was pressed. Both go through the SAME collision rule below — a
    // reset that landed on the other box's key would otherwise leave two boxes
    // holding one key, and content.js would silently let "up" win.
    const next = key === "Backspace" || key === "Delete" ? fallback : key;
    writeSettings((s) => {
      // Taking the key the OTHER shortcut holds SWAPS them. A swap is the only
      // outcome that leaves both boxes bound and needs no error message.
      if (readSpeedKey(s, other, otherFallback) === next)
        s[other] = readSpeedKey(s, field, fallback);
      s[field] = next;
    });
    stopCapture();
  },
  true
);

// Clicking anywhere else disarms (the click that armed it is the one exception).
document.addEventListener("click", (e) => {
  if (!capturingCap) return;
  if (capturingCap.contains(e.target)) return;
  stopCapture();
});

// Unblock: read-modify-write settings.blockedCreators (delete the key).
blockedList.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-unblock]");
  if (!btn) return;
  const key = btn.dataset.unblock;
  writeSettings((s) => {
    if (s.blockedCreators && typeof s.blockedCreators === "object") {
      delete s.blockedCreators[key];
    }
  });
});

// Keep the popup honest if settings change elsewhere (another tab, content.js).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes[SETTINGS_KEY]) {
    renderFrom(changes[SETTINGS_KEY].newValue || DEFAULT_SETTINGS);
  }
});
