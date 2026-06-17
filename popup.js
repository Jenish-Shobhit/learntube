// Settings panel. It only reads/writes chrome.storage.sync; content.js reacts.
const SETTINGS_KEY = "settings";
const DEFAULT_SETTINGS = { masterEnabled: true };
const toggle = document.getElementById("master-toggle");

chrome.storage.sync.get({ [SETTINGS_KEY]: DEFAULT_SETTINGS }, (res) => {
  const settings = res[SETTINGS_KEY] || DEFAULT_SETTINGS;
  toggle.checked = !!settings.masterEnabled;
});

toggle.addEventListener("change", () => {
  // Read-modify-write so later settings fields aren't clobbered.
  chrome.storage.sync.get({ [SETTINGS_KEY]: DEFAULT_SETTINGS }, (res) => {
    const settings = Object.assign({}, DEFAULT_SETTINGS, res[SETTINGS_KEY]);
    settings.masterEnabled = toggle.checked;
    chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
  });
});
