// Settings panel. It only reads/writes chrome.storage.sync; content.js reacts.
// Everything is read-modify-write on the ONE `settings` object, so no field ever
// clobbers another. SETTINGS_KEY + the defaults are duplicated in content.js —
// keep them in sync.
const SETTINGS_KEY = "settings";
const DEFAULT_SETTINGS = { masterEnabled: true };
// The seven switches (Phase 1). Six hides ON, startOnSubscriptions OFF — an
// absent field reads as its default, so this equals LearnTube 1.0 exactly.
const DEFAULT_TOGGLES = {
  hideShorts: true,
  hideWatchSuggestions: true,
  hideComments: true,
  hideEndCards: true,
  simplifyMasthead: true,
  replaceHome: true,
  showFeed: true, // the Library's "Show feed" (Peek) button — off = no button at all
  startOnSubscriptions: false,
};

const master = document.getElementById("master-toggle");
const toggleInputs = Array.prototype.slice.call(
  document.querySelectorAll("input[data-toggle]")
);
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
  renderBlocked(settings.blockedCreators || {});
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
