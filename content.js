/// Runs at document_start on every youtube.com page.
// The master switch is a single class on <html>, and the CSS does as much of
// the rework as CSS can. <html> is never replaced during YouTube's SPA
// navigation, so the class (and therefore the rework) survives moving between
// pages. Everything CSS cannot do lives here too: the /shorts route redirect,
// the injected Library / course / focus-strip DOM, the playlist scrape, the
// Block row inside YouTube's own menu, and all chrome.storage state.

// All durable state lives in a single chrome.storage.sync object under
// SETTINGS_KEY. masterEnabled is the master on/off switch. Future steps add
// more fields to this object (block toggles, topics, stars, …) without
// reshaping it. Default is master ON.
const SETTINGS_KEY = "settings";
const DEFAULT_SETTINGS = { masterEnabled: true };
// Legacy key from the old "Subscriptions — List View" build; migrated once.
const LEGACY_KEY = "listModeEnabled";

// Live copy of the master-enabled state, read by every JS gate the CSS class
// can't cover (the Shorts redirect, the scrape, every stamp pass), so toggling
// the switch off stops all of them too. apply() keeps it in sync.
let reworkEnabled = false;

function apply(enabled) {
  reworkEnabled = !!enabled;
  // Session S: the route stamp is OURS, so it lives and dies with the master
  // switch (master-off = plain YouTube, no data-ytr-* left on <html>). Synced
  // here, in the same synchronous block as the class, so the class can never be
  // on for a frame without its gate. (Declaration-hoisted — defined at §Session
  // S near the top.)
  syncRouteStamp();
  document.documentElement.classList.toggle("yt-rework", reworkEnabled);
}

// --- v1.1 "The Switchboard" — the nine switches, Peek, Block -----------------
// All durable state still rides the ONE synced `settings` object (zero new
// top-level keys). Phase 1 adds `settings.toggles` (the switches); Phase 2
// adds `settings.peekView` ("grid"|"list", the remembered Peek view); Phase 3
// adds `settings.blockedCreators` ({ "<channelKey>": ts }). Every field is
// ABSENT on a v1.0 install and reads as its default, so an untouched upgrade
// behaves byte-identically — zero migration.
//
// Phase 1 defaults = v1.0 exactly: the six hide-switches ON, startOnSubscriptions
// OFF. applyToggles stamps a data-ytr-show-* attr on <html> when a hide is turned
// OFF (presence = the user opted OUT of that hide); CSS §8/§9/§12 gate their
// display:none on :not([data-ytr-show-*]). Three switches ALSO gate JS the CSS
// can't: hideShorts (the /shorts redirect), hideWatchSuggestions (the centered
// player), replaceHome (mounting the Library). startOnSubscriptions is JS-only
// (a first-landing redirect fired once from the hard-load seed, never on SPA nav).
const DEFAULT_TOGGLES = {
  hideShorts: true,
  hideWatchSuggestions: true,
  hideComments: true,
  hideEndCards: true,
  simplifyMasthead: true,
  replaceHome: true,
  showFeed: true, // the Library's "Show feed" (Peek) button — off = no button at all
  startOnSubscriptions: false,
  // Patch 2 (v1.2.7): the "−  1.00×  +" speed control on EVERY watch page.
  // Default ON — it replaces the old course-only speed pill, so leaving it out
  // would silently remove a shipped affordance.
  speedButtons: true,
};

// Live mirror, seeded from settings.toggles (merged over the defaults so every
// field is a real boolean). The JS gates read from here; onChanged keeps it fresh.
let togglesCache = Object.assign({}, DEFAULT_TOGGLES);

// Phase 2 (Peek) session + view state; Phase 3 (Block) synced mirror. Declared
// here so they exist before any async callback (seed / onChanged) runs.
let peekOn = false; // session-only — resets when you leave the Library
let peekView = "grid"; // mirror of settings.peekView (remembered)
let blockedCache = {}; // mirror of settings.blockedCreators

// Merge stored toggles over the defaults so an absent field reads as its default.
function readToggles(settings) {
  const t = settings && settings.toggles;
  return Object.assign({}, DEFAULT_TOGGLES, t && typeof t === "object" ? t : {});
}

// Stamp the six data-ytr-show-* attrs on <html>: presence = the user opted OUT
// of that hide (switch off). startOnSubscriptions has no CSS, so no attr here.
function applyToggles() {
  const t = togglesCache;
  const h = document.documentElement;
  h.toggleAttribute("data-ytr-show-shorts", t.hideShorts === false);
  h.toggleAttribute("data-ytr-show-suggestions", t.hideWatchSuggestions === false);
  h.toggleAttribute("data-ytr-show-comments", t.hideComments === false);
  h.toggleAttribute("data-ytr-show-endcards", t.hideEndCards === false);
  h.toggleAttribute("data-ytr-show-masthead", t.simplifyMasthead === false);
  h.toggleAttribute("data-ytr-show-home", t.replaceHome === false);
}

// --- Bounded-retry utility ---------------------------------------------------
// YouTube hydrates pages late and lazy-loads rows, so several per-nav jobs
// (mount the Learning shell, decorate Subscriptions, scrape a playlist) must
// re-run for a short window after each navigation. But a SINGLE navigation
// fires multiple channels (patched pushState/replaceState + popstate +
// yt-navigate-finish), which would otherwise stack 2-3 overlapping retry loops
// per nav — each doing full-page querySelectorAll sweeps. Wrapping a job here
// gives it a generation token: every fresh trigger supersedes any loop still
// running, so at most ONE loop per job is ever active. `job()` returns true when
// satisfied (stop early); otherwise it keeps ticking until `duration` elapses.
// `job()` returns: true (satisfied -> stop now), "idle" (nothing changed this
// tick -> eligible for settle), or anything else / false (made progress or work
// still pending -> keep ticking). When `settleTicks` is given, the loop stops
// after that many CONSECUTIVE "idle" ticks instead of ticking the whole window
// (#5: a settled DOM no longer burns the full ~13 ticks). Omit settleTicks to
// keep the plain true/false behavior.
function makeBoundedRetry(job, interval, duration, settleTicks) {
  let generation = 0;
  let scheduled = false;
  // #4 (coalesce): a single SPA navigation fires up to three channels (patched
  // pushState/replaceState + popstate + yt-navigate-finish). Each used to run
  // job()'s first tick SYNCHRONOUSLY before the generation guard (which only
  // stops a loop's FUTURE ticks) could supersede it, so the full sweep ran 2-3×
  // per nav. Defer the loop start to a microtask and collapse a same-task burst
  // of triggers into ONE start. queueMicrotask (not rAF) so background tabs,
  // where rAF is throttled, still run their cross-tab updates.
  const start = () => {
    scheduled = false;
    const mine = ++generation; // supersede any loop still running
    const deadline = Date.now() + duration;
    let idle = 0; // per-loop (resets every trigger): consecutive no-change ticks
    const tick = () => {
      if (mine !== generation) return; // a newer trigger superseded this loop
      const r = job();
      if (r === true) return; // satisfied -> stop early
      if (settleTicks) {
        idle = r === "idle" ? idle + 1 : 0;
        if (idle >= settleTicks) return; // DOM stable for settleTicks -> stop
      }
      if (Date.now() > deadline) return; // window elapsed
      setTimeout(tick, interval);
    };
    tick();
  };
  return function trigger() {
    if (scheduled) return; // a start is already queued for this task -> coalesce
    scheduled = true;
    queueMicrotask(start);
  };
}

// --- Shorts route redirect ---------------------------------------------------
// The one thing CSS can't do: change the URL. When the rework is on, any landing
// on a /shorts/* route is bounced to the home route. Step 2 already hides the
// Shorts surfaces; this closes the route itself.

function isShortsPath(pathname) {
  return pathname === "/shorts" || pathname.startsWith("/shorts/");
}

function redirectShorts() {
  if (!reworkEnabled) return;
  if (togglesCache.hideShorts === false) return; // S1 off -> /shorts links open
  if (isShortsPath(location.pathname)) {
    // Replace (not push) so Back doesn't bounce the user into the Short again.
    location.replace(location.origin + "/");
  }
}

// SPA navigations: YouTube routes through the History API and fires
// yt-navigate-finish. Patch push/replaceState to emit an event we can hear, then
// listen for that, popstate, and YouTube's own navigation event. The redirect is
// idempotent (no-op once off /shorts), so overlapping channels are harmless.
["pushState", "replaceState"].forEach((fn) => {
  const orig = history[fn];
  history[fn] = function () {
    const ret = orig.apply(this, arguments);
    window.dispatchEvent(new Event("yt-rework:locationchange"));
    return ret;
  };
});
window.addEventListener("yt-rework:locationchange", redirectShorts);
window.addEventListener("popstate", redirectShorts);
window.addEventListener("yt-navigate-finish", redirectShorts);

// --- Session S: the route stamp — /results is native from the first paint -----
// Owner decree (v1.2.1, hardened here): the search results page is 100%
// YouTube's own. The JS side is gated by onSearchRoute(); the CSS side needs
// the same gate and CSS cannot read location — so <html> carries
// data-ytr-route="search" while (and ONLY while) we are on /results, and every
// doc-wide rule that could match a search row is written
// `html…:not([data-ytr-route="search"])` (§8a, §8b, §17).
//
// WHAT MAKES AN SPA HOP INTO SEARCH NATIVE FROM ITS FIRST FRAME: NOT the
// patched pushState/replaceState above — that patch lives in this content
// script's ISOLATED world, so YouTube's own main-world History API calls
// never run through it, and yt-rework:locationchange never fires for a real
// YouTube SPA nav. (It still fires for any pushState/replaceState LearnTube
// itself makes, which is why the listener stays wired.) The real carriers are
// yt-navigate-finish and popstate: both fire after location.pathname has
// already updated to "/results", and live probing (two trials) measured
// YouTube inserting the first search result row 12-24ms AFTER
// yt-navigate-finish — so the stamp, applied from that listener, is on
// <html> well before any row exists. (yt-navigate-start is NOT usable here:
// it fires BEFORE the History API updates, so the pathname it sees is still
// the old one. It is not listened for here.) Whichever of yt-navigate-finish
// / popstate fires first does the stamping; and — just as important — the
// attribute is REMOVED the moment we leave, so every other surface gets its
// rules back intact.
//
// The stamp is OURS, so it obeys the master switch: apply() syncs it in the
// same block as the .yt-rework class, and master-off leaves plain YouTube with
// no data-ytr-* on <html>. Nothing paints under our rules before apply() runs,
// because our rules all hang off that class.
//
// ACCEPTED CONSEQUENCE of the decree: blocked channels DO appear in search
// results. That is the trade the owner chose — search is native.
//
// THE ONE EXCEPTION (v1.2.4, owner order): Shorts. The Hide-Shorts switch now
// reaches /results as well — "that's what the toggle button is for". It is done
// PURELY in CSS (§14e), whose rules are the mirror image of the §8 gate: they
// require data-ytr-route="search" to be PRESENT, and they ride the same
// data-ytr-show-shorts opt-out attr as §8. No JS runs, and no DOM is mutated,
// on /results because of it — the decree's real promise is intact.
function onSearchRoute() {
  return location.pathname === "/results";
}

function syncRouteStamp() {
  const el = document.documentElement;
  if (reworkEnabled && onSearchRoute())
    el.setAttribute("data-ytr-route", "search");
  else el.removeAttribute("data-ytr-route");
}
window.addEventListener("yt-rework:locationchange", syncRouteStamp);
window.addEventListener("popstate", syncRouteStamp);
window.addEventListener("yt-navigate-finish", syncRouteStamp);

// --- Learning home shell (injected UI) ---------------------------------------
// The one thing CSS can't do besides routing: CREATE new DOM. Step 3 hid
// YouTube's home feed; this mounts a single root in its place. Step 5 makes it
// data-driven: real topics + playlists, created/edited inline and persisted in
// chrome.storage.sync under settings.topics.
// All of its appearance lives in CSS section 10, gated on html.yt-rework; JS
// here only injects/renders/removes the node and keeps it mounted across SPA nav.
const LEARNING_ROOT_ID = "yt-rework-learning";

// Live mirror of settings.topics. Seeded from storage on first read and kept in
// sync by the storage.onChanged listener. Render reads from here.
let topicsCache = [];
// True once topicsCache reflects REAL stored topics (not the initial empty
// placeholder). pruneOrphanProgress guards on it so the local-progress seed —
// which can resolve before the sync-settings seed — never mistakes "topics not
// loaded yet" for "no topics" and wipes the whole progress map.
let topicsSeeded = false;

// --- Step 13: drag-to-reorder state (Step 21: topic cards only) ---------------
// One drag is in flight at a time. Since Step 21 removed the Desk's playlist
// rows (module management lives in the course view), only topic CARDS drag.
// `justDragged` is a one-shot guard so any click the browser synthesizes right
// after a drop can't open the course / fire a card action.
let dragState = null; // { el } — the dragged .ytr-card
let justDragged = false;

// --- Step 21: Library add-tile state ------------------------------------------
// The dashed "+ New topic" tile that closes the grid. Collapsed by default;
// clicking expands it into an inline name input + Create. Pure view state —
// reset on teardown and after a successful create.
let addTileOpen = false;

// --- Step 14: course view state ----------------------------------------------
// The Learning root has two renders of the SAME node: the Library
// (currentTopicId null) and a single topic's COURSE view (currentTopicId set).
// There is no real URL for a course, so the open course is module-level state,
// not a route. It is reset on master-off / leaving home / SPA nav (see
// mountLearningHome / removeLearningHome), so a re-mount always lands on the
// Library.
let currentTopicId = null;

// --- Step 23: "‹ Back to <topic>" arrival hint --------------------------------
// The focus strip's Back link navigates home like any other anchor — YouTube
// may SPA-route it or hard-load (we never fight the router) — so the
// open-the-course hint rides per-tab sessionStorage, which survives BOTH paths
// and dies with the tab (never synced, never persisted). Set on the Back
// click, consumed one-shot by the next mountLearningHome on the home route.
// A stale/deleted topic id falls back to the Library — fail-quiet by design.
const OPEN_COURSE_HINT = "ytr-open-course";

function armOpenCourseHint(topicId) {
  try {
    if (topicId) sessionStorage.setItem(OPEN_COURSE_HINT, topicId);
  } catch (_) {
    // storage unavailable -> Back simply lands on the Library
  }
}

function takeOpenCourseHint() {
  try {
    const id = sessionStorage.getItem(OPEN_COURSE_HINT);
    if (id) sessionStorage.removeItem(OPEN_COURSE_HINT);
    return id || null;
  } catch (_) {
    return null;
  }
}

// --- Topic store (read-modify-write on the shared settings object) -----------
// Every mutation goes through here so masterEnabled (and other future fields) is
// never clobbered. We don't re-render here — storage.onChanged drives the render
// so synced tabs stay consistent.
function mutateTopics(fn, done) {
  chrome.storage.sync.get({ [SETTINGS_KEY]: DEFAULT_SETTINGS }, (res) => {
    const settings = Object.assign({}, DEFAULT_SETTINGS, res[SETTINGS_KEY]);
    settings.topics = Array.isArray(settings.topics)
      ? settings.topics.slice()
      : [];
    fn(settings);
    chrome.storage.sync.set({ [SETTINGS_KEY]: settings }, () => {
      // Surface (but tolerate) a write failure; storage stays source of truth.
      const failed = !!chrome.runtime.lastError;
      if (failed) {
        console.warn("[yt-rework] topics write failed:", chrome.runtime.lastError);
      }
      // Optional completion hook (used by adoptScrapedTopicNames' in-flight
      // latch); runs on success or failure so the latch always clears. Passes
      // whether the write actually landed (sync quota etc.) — lastError is only
      // readable here, so callers showing a confirmation depend on this flag.
      if (done) done(!failed);
    });
  });
}

function newTopicId() {
  return "t_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
}

// --- Step 15: save a single video into a topic ------------------------------
// Topics gain a parallel `videos: [{ id }]` array (do NOT reshape `playlists`;
// absent on older topics -> treated as []). Read-modify-write via mutateTopics
// so masterEnabled / stars / playlists are never clobbered; de-duped by id.
function addVideoToTopic(topicId, videoId) {
  if (!topicId || !videoId) return;
  mutateTopics((s) => {
    const t = s.topics.find((x) => x.id === topicId);
    if (!t) return;
    if (!Array.isArray(t.videos)) t.videos = [];
    if (!t.videos.some((v) => v && v.id === videoId)) {
      t.videos.push({ id: videoId });
    }
  });
}

// --- The ONE playlist->topic writer ------------------------------------------
// Session M extracted these two out of handleAction so every surface that can
// file a playlist — the course view's "add playlist" row (addPlaylistToTopic),
// the first-run empty state (createTopicWithPlaylist), and the
// playlist page's "＋ Add to LearnTube" button (both, via the panel) — goes
// through the SAME mutation. Both are read-modify-write via mutateTopics
// (masterEnabled / stars / videos are never clobbered) and both de-dupe by
// playlist id. Neither re-renders: storage.onChanged drives every surface.
// The optional `done(ok)` hook reports whether the topic was actually found and
// written: a topic DELETED in another synced tab is a silent no-op inside `fn`,
// and a caller that shows a confirmation (Session M's "Added ✓") must not claim
// success for a write that never happened. Callers that don't care omit it.
function addPlaylistToTopic(topicId, listId, done) {
  if (!topicId || !listId) {
    if (done) done(false);
    return;
  }
  let ok = false;
  mutateTopics(
    (s) => {
      const t = s.topics.find((x) => x.id === topicId);
      if (!t) return; // gone (deleted elsewhere) -> write nothing, report false
      t.playlists = Array.isArray(t.playlists) ? t.playlists : [];
      if (!t.playlists.some((p) => p && p.id === listId))
        t.playlists.push({ id: listId });
      ok = true; // present (already-there counts: the end state is what we want)
    },
    (wrote) => {
      // Session Q: filing a playlist is the moment we can go get its lectures.
      // Hanging it off the ONE writer means every add surface (Library paste,
      // the playlist-page button, Save-to-topic from Subscriptions) inherits it
      // for free — and hydratePlaylistInBackground self-de-dupes, so re-filing
      // an already-hydrated list costs nothing.
      if (ok && wrote) hydratePlaylistInBackground(listId);
      if (done) done(ok && wrote);
    }
  );
}

// Create a NEW topic around a playlist. An empty `name` is deliberate, not a
// bug: the topic then ADOPTS the playlist's real scraped title (Step 21 /
// adoptScrapedTopicNames) — "never an invented one".
// `done(ok)` as above — a creation can only fail on a missing id, but the two
// writers keep the same shape so callers can treat them identically.
function createTopicWithPlaylist(name, listId, done) {
  if (!listId) {
    if (done) done(false);
    return;
  }
  const clean = (name || "").trim();
  mutateTopics(
    (s) => {
      s.topics.push({
        id: newTopicId(),
        name: clean, // "" -> adopted from the scraped playlist title
        playlists: [{ id: listId }],
        videos: [],
      });
    },
    (wrote) => {
      // Session Q: same head start on the create-a-topic path — and here it also
      // fetches the playlist TITLE the empty-named topic is waiting to adopt
      // (Step 21 / adoptScrapedTopicNames runs off the progress onChanged), so a
      // pasted playlist names its own topic without a visit.
      if (wrote) hydratePlaylistInBackground(listId);
      if (done) done(wrote);
    }
  );
}

// --- Playlist id parsing -----------------------------------------------------
// Accept a full URL (playlist?list=… or watch?v=…&list=…), a bare "list=ID"
// fragment, or a bare id. Returns the cleaned id, or null if nothing usable.
// No network validation (locked: no YouTube Data API) — we trust the parsed id.
function sanitizePlaylistId(id) {
  const cleaned = (id || "").trim();
  return /^[A-Za-z0-9_-]{2,}$/.test(cleaned) ? cleaned : null;
}

function parsePlaylistId(raw) {
  const s = (raw || "").trim();
  if (!s) return null;
  try {
    const url = new URL(s);
    const list = url.searchParams.get("list");
    if (list) return sanitizePlaylistId(list);
  } catch (_) {
    // not a URL — fall through to bare-id handling
  }
  const m = s.match(/[?&]?list=([^&\s]+)/);
  if (m) return sanitizePlaylistId(m[1]);
  return sanitizePlaylistId(s);
}

// --- Step 6: playlist progress scraping --------------------------------------
// Watched-state is scraped from YouTube's own resume-playback progress overlay
// (locked decision: no manual check-off, no Data API). When the user views a
// playlist page we read each video renderer's #progress overlay, decide
// watched/not, and cache it in chrome.storage.LOCAL (not sync — progress is
// large, device-local, re-derivable cache; the 8KB sync item cap would blow).
// Schema (Step 19): progress[list] = { updatedAt, title, videos: [{ id,
// title?, duration?, watched, ratio }] } — title/duration are OPTIONAL (absent
// on pre-Step-19 scrapes and on rows whose read failed; backfilled on the next
// playlist open, never blanked once known).
// The Learning home joins this cache against settings.topics at render time to
// show a real per-topic bar + a resume link to the next unwatched video.
const PROGRESS_KEY = "progress";
const WATCHED_RATIO = 0.95; // YouTube marks "watched" near the end; tolerate credits.

// Both playlist layouts: dedicated playlist page + watch-page side panel.
const PLAYLIST_VIDEO_SELECTORS = [
  "ytd-playlist-video-renderer",
  "ytd-playlist-panel-video-renderer",
];

// Live mirror of storage.local.progress; seeded on load, kept fresh by onChanged.
let progressCache = {};

function currentListId() {
  try {
    return new URL(location.href).searchParams.get("list");
  } catch (_) {
    return null;
  }
}

function videoIdFromHref(href) {
  if (!href) return null;
  try {
    const u = new URL(href, location.origin);
    const v = u.searchParams.get("v");
    if (v) return v;
  } catch (_) {
    // fall through to regex
  }
  const m = href.match(/[?&]v=([^&]+)/);
  return m ? m[1] : null;
}

// Read the played fraction (0..1) from a renderer's resume-playback overlay.
// Tries old Polymer + new Wiz layouts, then a class-substring fallback, then a
// measured-width fallback. No overlay => 0 (never started). Fails quiet on drift.
function progressRatioFor(renderer) {
  const bar =
    renderer.querySelector(
      "ytd-thumbnail-overlay-resume-playback-renderer #progress"
    ) ||
    renderer.querySelector(
      "yt-thumbnail-overlay-progress-bar-view-model #progress"
    ) ||
    renderer.querySelector(
      "#progress.ytd-thumbnail-overlay-resume-playback-renderer"
    ) ||
    renderer.querySelector('[class*="ProgressBarSegment"]');
  if (!bar) return 0;
  const w = bar.style && bar.style.width;
  if (w && w.endsWith("%")) {
    const n = parseFloat(w);
    return isFinite(n) ? Math.max(0, Math.min(1, n / 100)) : 0;
  }
  const parent = bar.parentElement;
  if (parent && parent.offsetWidth > 0) {
    return Math.max(0, Math.min(1, bar.offsetWidth / parent.offsetWidth));
  }
  return 0;
}

// --- Step 19: real lecture titles + durations --------------------------------
// "Real titles or nothing" (locked): each scraped video also captures its real
// on-page title and duration label, stored as OPTIONAL fields —
//   progress[list].videos[] = { id, title?, duration?, watched, ratio }
// A missed read stores nothing (field omitted, never a placeholder), and the
// merge below never blanks a known value. The Continue row, the course view's
// lecture checklist and the focus strip all render these real scraped fields —
// a record without them falls back to the honest "open once" line, never a
// fabricated "Lecture N".

// Read a playlist row's real on-page video title. Drift-tolerant across both
// layouts and both class generations: a#video-title (dedicated /playlist page),
// #video-title (watch-panel <span>), then the Wiz lockup title (kebab +
// camelCase forms, same dual-form rule as CSS section 6). Returns null when
// nothing usable — never a fabricated label.
function playlistVideoTitleFor(renderer) {
  const el =
    renderer.querySelector("a#video-title") ||
    renderer.querySelector("#video-title") ||
    renderer.querySelector(
      ":is(.yt-lockup-metadata-view-model__title, .ytLockupMetadataViewModelTitle)"
    );
  const t = el && el.textContent ? el.textContent.replace(/\s+/g, " ").trim() : "";
  return t || null;
}

// Shared duration-overlay reader for playlist rows: old Polymer overlay + Wiz
// badge-shape fallbacks (the Step-16 selector chain; Session O removed its
// other caller when the search decorate pass went).
// Returns the trimmed label text or "" — parsing/validation is the caller's job.
function durationLabelTextFor(renderer) {
  const el =
    renderer.querySelector(
      "ytd-thumbnail-overlay-time-status-renderer #text"
    ) ||
    renderer.querySelector(
      'ytd-thumbnail-overlay-time-status-renderer [class*="time-status"]'
    ) ||
    renderer.querySelector(".badge-shape__text") ||
    renderer.querySelector('[class*="thumbnailBadge"] [class*="text"]');
  return el && el.textContent ? el.textContent.trim() : "";
}

// Read a playlist row's duration label ("12:34"), validated by the Step-16
// parseDurationToSeconds machinery: only a real time label is returned —
// live/upcoming/non-time badges parse to null and the field is never stored.
function playlistVideoDurationFor(renderer) {
  const label = durationLabelTextFor(renderer);
  return parseDurationToSeconds(label) !== null ? label : null;
}

// --- Session S: the row's ABSOLUTE position in the playlist -------------------
// The bug this kills: Next/Previous/Up next stepping to the wrong lecture.
// writePlaylistProgress keeps PRIOR order and APPENDS anything new, which is
// only "playlist order" when every scrape starts at row 1. It doesn't: the
// Session-Q hydration sees just the first ~15 rows, and the watch-page side
// panel is virtualised around the CURRENT video. Open lecture 40 first and the
// stored list becomes [1..15, 35..50, 16..34] — permanently scrambled, and 7→8
// then lands anywhere.
// Both playlist layouts render the row's real 1-based index in an #index
// element — but only ONE of them is canonical. The watch-side panel
// (ytd-playlist-panel-video-renderer) RE-NUMBERS itself when the user turns
// shuffle on: its #index then reads 1,2,3… in shuffled order. Harvesting those
// would store a shuffle as the course's real order and durably re-sort the
// record — the exact scrambling this field exists to prevent, made permanent.
// So `order` is read from the dedicated /playlist page's rows ONLY
// (ytd-playlist-video-renderer, whose numbering is the playlist itself); the
// other canonical source is the SSR payload in playlistVideosFromData. A watch-
// page scrape therefore contributes progress but never a position, and the
// merge's field-preserving rule keeps whatever order was already stored.
// Fail-quiet: an unreadable index stores no field (never a guessed position).
function playlistVideoOrderFor(renderer) {
  if (renderer.tagName !== "YTD-PLAYLIST-VIDEO-RENDERER") return null;
  const el = renderer.querySelector("#index");
  const n = parseInt((el && el.textContent ? el.textContent : "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Field-level equality for two video lists, EXCLUDING updatedAt (which always
// differs). Lets writePlaylistProgress skip an identical re-write.
function sameProgressVideos(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      !!x.watched !== !!y.watched ||
      x.ratio !== y.ratio ||
      (x.title || "") !== (y.title || "") ||
      (x.duration || "") !== (y.duration || "") ||
      (x.order || 0) !== (y.order || 0) // Session S: an order-only fix must write
    )
      return false;
  }
  return true;
}

// Merge a fresh scrape into stored progress by video id, NEVER shrinking the
// known list: a virtualised watch-side panel may expose fewer rows than a
// dedicated-page scrape already cached, and collapsing the count would inflate %.
function writePlaylistProgress(listId, freshVideos, title) {
  chrome.storage.local.get({ [PROGRESS_KEY]: {} }, (res) => {
    const progress = res[PROGRESS_KEY] || {};
    const prevRec = progress[listId] || {};
    const prev = Array.isArray(prevRec.videos) ? prevRec.videos : [];
    const freshById = new Map(freshVideos.map((v) => [v.id, v]));
    let merged = [];
    const used = new Set();
    // Keep prior order; refresh each from the new scrape if re-seen.
    // Field-preserving (Step 19): fresh watched/ratio always win, but a tick
    // that missed a known title/duration (overlay or title not hydrated yet,
    // virtualised panel) never blanks the stored value — the same rule the
    // playlist title gets below.
    prev.forEach((p) => {
      const f = freshById.get(p.id);
      if (f) {
        const v = Object.assign({}, f);
        if (!v.title && p.title) v.title = p.title;
        if (!v.duration && p.duration) v.duration = p.duration;
        // K1 — MONOTONIC auto-progress invariant: a scrape may only ADD
        // completion, never remove it. YouTube's resume overlay reads 0 on the
        // now-playing row and on the virtualised watch-side panel
        // (ytd-playlist-panel-video-renderer), so re-opening an earlier lecture
        // re-scrapes an already-watched video at ratio 0 and, taking f
        // wholesale, would reset its stored watched:true — the count collapses
        // ("1 of 85"). Keep watched sticky and let ratio only rise; only an
        // explicit manual un-tick (K2, via mutateVideoDone) may clear
        // watched-equivalent completion.
        v.watched = !!f.watched || !!p.watched;
        v.ratio = Math.max(f.ratio || 0, p.ratio || 0);
        // K2 — the manual done-tick rides the same record. A scrape never
        // produces a `done` field, so preserve the stored one exactly (true OR
        // false — an explicit un-tick must be durable across re-scrapes), the
        // same field-preserving rule as title/duration above.
        if (!("done" in v) && "done" in p) v.done = p.done;
        // Session S: same field-preserving rule for the playlist position — a
        // tick that couldn't read the #index keeps the stored one.
        if (!v.order && p.order) v.order = p.order;
        merged.push(v);
      } else {
        merged.push(p);
      }
      used.add(p.id);
    });
    // Append newly-seen videos in scrape order.
    freshVideos.forEach((f) => {
      if (!used.has(f.id)) merged.push(f);
    });
    // Session S: restore TRUE playlist order. Appending kept insertion order,
    // which is only the course's order when every scrape started at row 1 — a
    // virtualised watch-side panel or the Session-Q SSR prefix breaks that and
    // Next/Previous/Up next then step through a scrambled list.
    // PARTIAL-TOLERANT: a row whose video was deleted or made private can never
    // be re-scraped, so "sort only when EVERY row has an order" would disable
    // the heal on that record forever. Instead, rows that HAVE an order sort by
    // it, and an order-less row rides along immediately behind the ordered row
    // it currently follows (leading order-less rows stay at the front). Stable
    // by construction — the original index is the tiebreak — so nothing is ever
    // "wrongly moved": an order-less row only ever travels with its neighbour.
    // Records with no order anywhere are untouched and self-heal the next time
    // their /playlist page is opened.
    if (merged.length > 1 && merged.some((v) => typeof v.order === "number")) {
      let anchor = 0; // < any real 1-based order, so leading strays sort first
      merged = merged
        .map((v, i) => {
          if (typeof v.order === "number") anchor = v.order;
          return { v, key: anchor, i };
        })
        .sort((a, b) => a.key - b.key || a.i - b.i)
        .map((x) => x.v);
    }
    // Keep a human-readable title once we scrape one, so the Learning home can
    // show real playlist names instead of raw "PL…" ids. Never blank a known
    // title (a tick that missed the header keeps the prior one).
    const newTitle = (title && title.trim()) || prevRec.title || "";
    // Dirty-check (Step 25 churn-reduction): an unchanged scrape — same title +
    // same videos — writes NOTHING, so the idle re-scrape ticks across the 4s
    // bounded-retry window (the DOM is usually settled after the first couple)
    // don't each fire the progress onChanged fan-out (renderLearningHome +
    // adoptScrapedTopicNames + roomTick) in every open tab. updatedAt is
    // excluded from the compare (it always differs) and is never read anywhere.
    if (
      (prevRec.title || "") === newTitle &&
      sameProgressVideos(prev, merged)
    )
      return;
    progress[listId] = {
      updatedAt: Date.now(),
      title: newTitle,
      videos: merged,
    };
    chrome.storage.local.set({ [PROGRESS_KEY]: progress }, () => {
      if (chrome.runtime.lastError) {
        console.warn(
          "[yt-rework] progress write failed:",
          chrome.runtime.lastError
        );
      }
    });
  });
}

// --- K2: manual done-tick writer ---------------------------------------------
// Flip the manual `done` flag for ONE {listId, videoId} and persist to the same
// storage.local `progress` record the scrape uses (device-local, like the rest
// of progress — a synced settings.doneVideos set is the cross-device
// alternative; local is implemented per the brief unless the owner says
// otherwise). Mirrors writePlaylistProgress's shape so the same `progress`
// onChanged fan-out (renderLearningHome + roomTickWithRetry) re-renders every
// tab. `done` is stored as an explicit boolean (never deleted) so an un-tick of
// a watched lecture is a durable override — the K1 escape hatch (see
// isLectureComplete). No-op when the lecture isn't scraped yet (nothing to tick).
function mutateVideoDone(listId, videoId, done) {
  chrome.storage.local.get({ [PROGRESS_KEY]: {} }, (res) => {
    const progress = res[PROGRESS_KEY] || {};
    const rec = progress[listId];
    if (!rec || !Array.isArray(rec.videos)) return;
    const v = rec.videos.find((x) => x.id === videoId);
    if (!v) return;
    if (!!v.done === !!done && "done" in v) return; // no change -> skip the write
    v.done = !!done;
    rec.updatedAt = Date.now();
    progress[listId] = rec;
    chrome.storage.local.set({ [PROGRESS_KEY]: progress }, () => {
      if (chrome.runtime.lastError) {
        console.warn(
          "[yt-rework] done write failed:",
          chrome.runtime.lastError
        );
      }
    });
  });
}

// Drop progress records for playlists no longer referenced by ANY topic. The
// delete-topic path only edits settings.topics — it never
// touches storage.local.progress — so a deleted topic's scraped record would
// linger forever. This bounds the map to the user's current topic set. Called
// after every topicsCache refresh (sync onChanged) and once from each hard-load
// seed (gated on topicsSeeded so an early local seed can't wipe everything).
function pruneOrphanProgress() {
  if (!topicsSeeded) return; // topics not loaded yet — never prune blind
  const live = new Set();
  topicsCache.forEach((t) => {
    (Array.isArray(t.playlists) ? t.playlists : []).forEach((pl) => {
      if (pl && pl.id) live.add(pl.id);
    });
  });
  const orphans = Object.keys(progressCache).filter((id) => !live.has(id));
  if (orphans.length === 0) return; // nothing to prune -> no write, no fan-out
  const pruned = {};
  Object.keys(progressCache).forEach((id) => {
    if (live.has(id)) pruned[id] = progressCache[id];
  });
  progressCache = pruned; // optimistic mirror; onChanged confirms
  chrome.storage.local.set({ [PROGRESS_KEY]: pruned }, () => {
    if (chrome.runtime.lastError) {
      console.warn(
        "[yt-rework] progress prune failed:",
        chrome.runtime.lastError
      );
    }
  });
}

// Best-effort playlist title for the currently-viewed playlist. Drift-tolerant:
// tries the dedicated-page + watch-panel headers, then document.title on the
// dedicated /playlist route ("Title - YouTube"). Returns null when nothing
// usable is found — writePlaylistProgress then keeps any prior title. Because
// the Learning home links every playlist to /playlist?list=… (where the title
// renders reliably), a single open is enough to capture a real name.
function scrapePlaylistTitle() {
  const selectors = [
    "ytd-playlist-sidebar-primary-info-renderer #title yt-formatted-string",
    "ytd-playlist-sidebar-primary-info-renderer #title",
    "ytd-playlist-header-renderer #title yt-formatted-string",
    "yt-page-header-view-model h1",
    ".page-header-view-model-wiz__page-header-title h1",
    "ytd-playlist-panel-renderer #header-description #title",
    "ytd-playlist-panel-renderer .title.ytd-playlist-panel-renderer",
  ];
  for (let i = 0; i < selectors.length; i++) {
    const el = document.querySelector(selectors[i]);
    const t = el && el.textContent ? el.textContent.trim() : "";
    if (t) return t;
  }
  if (location.pathname.indexOf("/playlist") === 0) {
    const dt = (document.title || "")
      .replace(/^\(\d+\)\s*/, "") // strip a "(3) " unread/notification prefix
      .replace(/\s*[-–—]\s*YouTube\s*$/, "")
      .trim();
    if (dt) return dt;
  }
  return null;
}

function scrapePlaylistPage() {
  if (!reworkEnabled) return;
  const listId = currentListId();
  if (!listId) return;

  const renderers = [];
  PLAYLIST_VIDEO_SELECTORS.forEach((sel) =>
    document.querySelectorAll(sel).forEach((r) => renderers.push(r))
  );
  if (renderers.length === 0) return; // not hydrated yet — retry handles it

  const seen = new Set();
  const videos = [];
  renderers.forEach((r) => {
    const a =
      r.querySelector("a#thumbnail[href]") ||
      r.querySelector("a#wc-endpoint[href]") ||
      r.querySelector("a[href*='watch']");
    const id = videoIdFromHref(a && a.getAttribute("href"));
    if (!id || seen.has(id)) return; // de-dupe, keep first (playlist order)
    seen.add(id);
    const ratio = progressRatioFor(r);
    const video = { id, watched: ratio >= WATCHED_RATIO, ratio };
    // Step 19: real title + duration, only when actually read off the page
    // (field omitted otherwise — the merge keeps any previously-stored value;
    // the bounded retry's later ticks fill in late-hydrating reads).
    const vTitle = playlistVideoTitleFor(r);
    if (vTitle) video.title = vTitle;
    const vDuration = playlistVideoDurationFor(r);
    if (vDuration) video.duration = vDuration;
    // Session S: the row's real 1-based playlist position, so the merge can
    // restore true course order however partial this scrape is. Canonical rows
    // only (see playlistVideoOrderFor) — the watch-side panel contributes none.
    const vOrder = playlistVideoOrderFor(r);
    if (vOrder) video.order = vOrder;
    videos.push(video);
  });
  if (videos.length === 0) return;

  writePlaylistProgress(listId, videos, scrapePlaylistTitle());
}

// Playlist DOM hydrates late and lazy-loads rows; re-scrape across a bounded
// window so late overlays/items are captured (each tick merges, never shrinks).
// Mount-timing only — not a persistent MutationObserver. Guarded so the multiple
// nav channels firing per navigation share ONE loop (see makeBoundedRetry).
const scrapePlaylistPageWithRetry = makeBoundedRetry(
  () => {
    if (onSearchRoute()) return true; // the decree: no LearnTube work on search
    if (!currentListId()) return true; // not on a playlist -> nothing to do
    scrapePlaylistPage();
    return false; // keep ticking to capture late/lazy-loaded rows
  },
  250,
  4000
);

window.addEventListener("yt-rework:locationchange", scrapePlaylistPageWithRetry);
window.addEventListener("popstate", scrapePlaylistPageWithRetry);
window.addEventListener("yt-navigate-finish", scrapePlaylistPageWithRetry);

// --- Session Q: background hydration on add ----------------------------------
// The bug this kills: "once a playlist is added, we have to open it once to get
// all the features." Step 6 only ever ran on a page the USER visited, so a
// freshly-filed playlist was an id and nothing else — no title, no lectures, no
// count, no Continue, no Next/Previous — until someone manually opened
// /playlist?list=…. Here we do that visit invisibly: fetch the playlist page
// SAME-ORIGIN from the content script (we already run on www.youtube.com, so no
// CORS and no host_permissions) and parse the `ytInitialData` blob every YouTube
// page embeds. The result goes through writePlaylistProgress — the SAME writer
// the DOM scrape uses — so the K1 monotonic merge, the done-flag preservation
// and the never-blank-a-known-title rule all apply unchanged, and the existing
// storage.local `progress` onChanged fan-out (renderLearningHome +
// roomTickWithRetry) lights up every open surface.
//
// WHAT THIS CAN AND CANNOT SEE (measured against live logged-in /playlist SSR,
// 2026-08-16 — the first cut of this code was written against a shape that no
// longer exists and silently found nothing, so these are facts, not guesses):
//   • Rows are `lockupViewModel`, NOT `playlistVideoRenderer`. The legacy key is
//     kept as a cheap fallback branch (logged-out / older builds may still ship
//     it), collected in the SAME walk.
//   • WATCH PROGRESS IS NOT IN THE PAYLOAD AT ALL. Zero occurrences of
//     thumbnailOverlayResumePlaybackRenderer / percentDurationWatched in a ~1MB
//     logged-in page. So hydration seeds id / title / duration / ORDER only,
//     always at ratio 0 — it can never tick a ✓. That is safe precisely because
//     the K1 merge is monotonic: a 0 can only ever be raised by the real DOM
//     scrape, never lower a stored watched:true.
// This is therefore a HEAD START (names, counts, ordering, Next/Previous), and
// the real playlist visit remains the pass that supplies completion.
//
// ponytail: the SSR payload carries only the FIRST ~10-17 rows; the rest sit
// behind `continuationItemRenderer`. Long courses hydrate to that prefix and the
// DOM scrape on a real visit remains the completing pass — deliberately NOT
// implementing innertube /browse continuation calls (an unversioned private API,
// an INNERTUBE key to scrape, and a request shape that breaks quietly; a lazy
// senior dev does not sign up to maintain that for the tail of a playlist).
// ponytail: one fetch per list id per document, and at most PLAYLIST_FETCH_MAX
// backfills per document — no retry, no queue, no polling. A failed fetch is
// simply the pre-Session-Q behavior (open it once), which is the honest floor.
const PLAYLIST_FETCH_MAX = 3;

// Q-3: how long a list that fetched fine but yielded ZERO usable rows (private,
// deleted, a mix, or shape drift) is left alone by the backfill. Without this the
// permanently-unhydratable list parks at the head of the queue and re-downloads
// ~800KB on EVERY page load, forever, while the lists behind it never get a turn.
const HYDRATE_RETRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// List ids fetched (or in flight) in THIS document — the whole de-dupe.
const hydratedLists = new Set();

// Pull the `var ytInitialData = {…};` blob out of a fetched page. Brace-matched
// (string- and escape-aware) rather than regexed, so a "}" inside a title can't
// truncate it. Tries the first few occurrences of the name — earlier ones can be
// a mention rather than the assignment. Returns the parsed object or null; every
// failure path is silent and lands us back on the old behavior.
function extractYtInitialData(html) {
  let from = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const key = html.indexOf("ytInitialData", from);
    if (key < 0) return null;
    from = key + 13;
    const eq = html.indexOf("=", key);
    const start = eq < 0 ? -1 : html.indexOf("{", eq);
    // The brace must follow the "=" almost immediately ("= {"), else this
    // occurrence was a mention and the "{" belongs to some other object.
    if (start < 0 || start - eq > 4) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < html.length; i++) {
      const c = html[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(html.slice(start, i + 1));
          } catch (_) {
            break; // malformed -> try the next occurrence
          }
        }
      }
    }
  }
  return null;
}

// Collect every object stored under any of `keys` in a ytInitialData tree, in
// document order, as { key, value } pairs. Shape-agnostic on purpose: YouTube
// reshuffles the wrapper chain (twoColumnBrowseResults → tabs → sectionList →
// itemSection → …) far more often than it renames a renderer, so we walk instead
// of pinning a path — which is exactly what lets one walk pick up BOTH the
// current `lockupViewModel` rows and the legacy `playlistVideoRenderer` ones in
// their true interleaved order. Bounded on depth and on matches found.
function collectRenderers(node, keys, out, depth) {
  if (!node || typeof node !== "object" || depth > 30 || out.length >= 500)
    return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++)
      collectRenderers(node[i], keys, out, depth + 1);
    return;
  }
  for (const k in node) {
    const v = node[k];
    if (keys.indexOf(k) >= 0 && v && typeof v === "object")
      out.push({ key: k, value: v });
    else collectRenderers(v, keys, out, depth + 1);
  }
}

// Flatten a YouTube text node ({simpleText} or {runs:[{text}]}) to a clean
// string, or null. "Real titles or nothing" — never a fabricated label.
function ytTextOf(node) {
  if (!node || typeof node !== "object") return null;
  if (typeof node.simpleText === "string") {
    const s = node.simpleText.replace(/\s+/g, " ").trim();
    if (s) return s;
  }
  if (!Array.isArray(node.runs)) return null;
  const t = node.runs
    .map((r) => (r && typeof r.text === "string" ? r.text : ""))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return t || null;
}

// The watched fraction carried by a LEGACY row's resume-playback overlay (0..1).
// Retained only for the playlistVideoRenderer fallback — the current
// lockupViewModel payload has no progress field of any kind (see the header
// note), so on today's YouTube this function is simply never reached with data.
function resumeRatioOf(renderer) {
  const ovs = Array.isArray(renderer.thumbnailOverlays)
    ? renderer.thumbnailOverlays
    : [];
  for (let i = 0; i < ovs.length; i++) {
    const p = ovs[i] && ovs[i].thumbnailOverlayResumePlaybackRenderer;
    const pct = p && p.percentDurationWatched;
    if (typeof pct === "number" && isFinite(pct))
      return Math.max(0, Math.min(1, pct / 100));
  }
  return 0;
}

// Only a real time label ("9:52", "1:02:03") becomes a duration — the same
// parseDurationToSeconds gate the DOM path uses, which is what keeps a "LIVE" /
// "NEW" / "4K" badge from being stored as a length.
function durationOrNull(label) {
  const s = typeof label === "string" ? label.replace(/\s+/g, " ").trim() : "";
  return s && parseDurationToSeconds(s) !== null ? s : null;
}

// The duration badge of a lockup row. The real path (verified live) is
// contentImage.thumbnailViewModel.overlays[] → thumbnailBottomOverlayViewModel
// .badges[] → thumbnailBadgeViewModel.text. The badges array is NOT
// duration-only, so every candidate is validated and the first real time label
// wins; nothing usable => null (field omitted, never a placeholder).
function lockupDurationOf(lockup) {
  const overlays =
    lockup.contentImage &&
    lockup.contentImage.thumbnailViewModel &&
    Array.isArray(lockup.contentImage.thumbnailViewModel.overlays)
      ? lockup.contentImage.thumbnailViewModel.overlays
      : [];
  for (let i = 0; i < overlays.length; i++) {
    const bottom = overlays[i] && overlays[i].thumbnailBottomOverlayViewModel;
    const badges = bottom && Array.isArray(bottom.badges) ? bottom.badges : [];
    for (let j = 0; j < badges.length; j++) {
      const b = badges[j] && badges[j].thumbnailBadgeViewModel;
      const d = durationOrNull(b && b.text);
      if (d) return d;
    }
  }
  return null;
}

// One lockupViewModel -> the Step-19 progress record shape. Video rows only
// (contentType gate — a playlist page can carry non-video lockups). No progress
// field exists in this payload, so ratio is always 0 / watched false; the K1
// monotonic merge guarantees that can never un-tick anything already known.
function videoFromLockup(lockup) {
  if (lockup.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO") return null;
  const id = typeof lockup.contentId === "string" ? lockup.contentId : null;
  if (!id) return null;
  const video = { id, watched: false, ratio: 0 };
  const meta = lockup.metadata && lockup.metadata.lockupMetadataViewModel;
  const raw = meta && meta.title && meta.title.content;
  const title =
    typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (title) video.title = title; // omitted when unreadable — never fabricated
  const dur = lockupDurationOf(lockup);
  if (dur) video.duration = dur;
  return video;
}

// One LEGACY playlistVideoRenderer -> the same record shape. Kept because a
// logged-out or older-build response may still ship this key; it is the only
// branch that can carry a real watched ratio.
function videoFromPlaylistRenderer(r) {
  const id = r && typeof r.videoId === "string" ? r.videoId : null;
  if (!id) return null;
  const ratio = resumeRatioOf(r);
  const video = { id, watched: ratio >= WATCHED_RATIO, ratio };
  const title = ytTextOf(r.title);
  if (title) video.title = title;
  const dur = durationOrNull(ytTextOf(r.lengthText));
  if (dur) video.duration = dur;
  return video;
}

// The two row shapes, collected in ONE walk so their document order is the
// playlist's order.
const PLAYLIST_ROW_KEYS = ["lockupViewModel", "playlistVideoRenderer"];

// Parse a fetched playlist page's ytInitialData into the progress video list.
// Returns [] on any drift — the caller then writes nothing.
function playlistVideosFromData(data) {
  const rows = [];
  collectRenderers(data, PLAYLIST_ROW_KEYS, rows, 0);
  const seen = new Set();
  const videos = [];
  rows.forEach((row) => {
    const v =
      row.key === "lockupViewModel"
        ? videoFromLockup(row.value)
        : videoFromPlaylistRenderer(row.value);
    if (!v || seen.has(v.id)) return; // de-dupe, keep first (playlist order)
    seen.add(v.id);
    // Session S: the SSR payload is the playlist read from the TOP, so document
    // order here IS absolute order — 1-based, matching the #index the DOM scrape
    // reads. (Only the first ~15 rows ship; those 15 are rows 1..15.)
    v.order = videos.length + 1;
    videos.push(v);
  });
  return videos;
}

// The playlist's own title, for the Library card + the Step-21 topic-name
// adoption. Metadata first, header renderers as drift cover, null otherwise
// (writePlaylistProgress then keeps whatever it had).
function playlistTitleFromData(data) {
  const meta = data && data.metadata && data.metadata.playlistMetadataRenderer;
  if (meta && typeof meta.title === "string" && meta.title.trim())
    return meta.title.trim();
  const heads = [];
  collectRenderers(data, ["playlistHeaderRenderer"], heads, 0);
  const ht = heads.length ? ytTextOf(heads[0].value.title) : null;
  if (ht) return ht;
  // The current SSR ships the name via the page header instead.
  const pages = [];
  collectRenderers(data, ["pageHeaderRenderer"], pages, 0);
  const pt =
    pages.length && typeof pages[0].value.pageTitle === "string"
      ? pages[0].value.pageTitle.trim()
      : "";
  return pt || null;
}

// Fetch + parse + merge. Fire-and-forget: no return value, no callback, and
// every failure (offline, a 404 on a private list, shape drift, a JSON that
// won't parse) resolves to "wrote nothing" — the user is exactly where they were
// before, one playlist visit away from full data.
// Search decree (v1.2.2): the CLAIM is synchronous, only the network kickoff is
// idle-deferred. Claiming before the deferral is what keeps the backfill queue's
// "one fetch per list id per document" true — a caller that picks the next id
// while a deferred kickoff is still pending must see this id as already taken,
// or a janky page burns the 3-per-document budget re-picking the same list.
// Side effect, deliberate: the add-a-playlist call sites (~315 / ~346) become
// idle-deferred too. That is desirable — an add on a busy page shouldn't fire an
// ~800KB fetch mid-interaction, and nothing waits on the result.
function hydratePlaylistInBackground(listId) {
  if (!reworkEnabled || !listId || hydratedLists.has(listId)) return;
  hydratedLists.add(listId); // claim it SYNCHRONOUSLY — no double-fetch
  runWhenIdle(() => {
    // Accept: text/html is explicit insurance — fetch's default "*/*" invites
    // YouTube to answer with an SPA JSON payload that carries no ytInitialData.
    fetch(playlistUrl(listId), {
      credentials: "same-origin",
      headers: { Accept: "text/html" },
    })
      .then((res) => (res && res.ok ? res.text() : null))
      .then((html) => absorbPlaylistHtml(listId, html))
      .catch(() => {
        /* fail-quiet: the old "open it once" behavior remains. Deliberately NOT
           marked failed — a transient offline blip should retry on the next
           load, unlike a structural zero-row result. */
      });
  });
}

// The main-thread half of a hydration — a brace-match + JSON.parse over a ~180KB
// slice of a ~800KB document, plus the storage fan-out — split out so it can be
// scheduled. Same fail-quiet contract as before: a throw in here writes nothing
// and leaves the user exactly one playlist visit away from full data.
//
// Search decree: a fetch started on a quiet page can land while the user is
// mid-search, so the parse WAITS OUT /results the same way the backfill stepper
// does. Bounded by ABSORB_DEFER_MAX: if the user simply lives on search, the
// absorb is dropped. That costs nothing durable — the id stays claimed for this
// document only, so the next hard load re-queues the list.
const ABSORB_DEFER_MAX = 40; // ~2 min consecutive on /results -> drop this absorb
function absorbPlaylistHtml(listId, html, deferrals) {
  if (onSearchRoute()) {
    const n = (deferrals || 0) + 1;
    if (n > ABSORB_DEFER_MAX) return; // give up quietly; next hard load retries
    setTimeout(
      () => runWhenIdle(() => absorbPlaylistHtml(listId, html, n)),
      BACKFILL_DEFER_MS
    );
    return;
  }
  try {
    const data = html ? extractYtInitialData(html) : null;
    const videos = data ? playlistVideosFromData(data) : [];
    if (videos.length === 0) {
      // Q-3: the fetch itself worked (or the page was unreadable) and there is
      // still nothing to store — a private/deleted list, a mix, or shape drift.
      // Remember that so the backfill queue steps PAST it instead of re-pulling
      // ~800KB for it on every single page load until the shape comes back.
      markHydrateFailed(listId);
      return;
    }
    writePlaylistProgress(listId, videos, playlistTitleFromData(data));
  } catch {
    /* fail-quiet — see above */
  }
}

// Q-3: stamp a "don't bother again for a while" marker onto the list's own
// progress record. Piggybacking the existing record (rather than a new storage
// key) means it inherits pruneOrphanProgress for free — delete the topic and the
// marker goes with it — and needs no new cache/seed. A later successful write
// (this hydration or the real DOM scrape) rebuilds the record wholesale and
// drops the marker, which is exactly the intended reset.
function markHydrateFailed(listId) {
  chrome.storage.local.get({ [PROGRESS_KEY]: {} }, (res) => {
    const progress = res[PROGRESS_KEY] || {};
    const prev = progress[listId] || {};
    if (Array.isArray(prev.videos) && prev.videos.length > 0) return; // has data
    progress[listId] = {
      updatedAt: Date.now(),
      title: prev.title || "",
      videos: [],
      hydrateFailed: Date.now(),
    };
    chrome.storage.local.set({ [PROGRESS_KEY]: progress }, () => {
      if (chrome.runtime.lastError) {
        console.warn(
          "[yt-rework] hydrate marker write failed:",
          chrome.runtime.lastError
        );
      }
    });
  });
}

// --- The one-shot backfill ----------------------------------------------------
// Playlists filed BEFORE this shipped (or whose add-time fetch failed) still
// have no scrape. Once both caches are seeded, top up a few of them. The queue is
// recomputed at each step from the LIVE caches, so a sibling tab whose write has
// already landed AND reached us (via the progress onChanged that refreshes
// progressCache) drops that id from our remaining steps. That is a best-effort
// damper, NOT a guarantee: two tabs seeding at the same moment will both pick the
// same head id and both fetch it. Bounded at 3 per document, so the worst case is
// a handful of duplicate requests, not a storm.
let progressSeeded = false;
let backfillRan = false;

// Set when the S7 first-landing branch fires location.replace() — this document
// is on its way out and must not start fetches it will never use.
let documentDoomed = false;

// Q-3: list ids that can never hydrate from a /playlist fetch. RD* are
// auto-generated radio/mix "playlists" (server-built per session, no stable page),
// WL is Watch Later and LL is Liked Videos — private system lists whose SSR ships
// no rows to an unauthenticated-style document fetch. Skipping them by shape
// costs one regex and saves the queue from burning its budget on certain misses.
function isNonHydratableListId(id) {
  return /^RD/.test(id) || id === "WL" || id === "LL";
}

function listIdsMissingScrape() {
  const now = Date.now();
  const out = [];
  topicsCache.forEach((t) => {
    (Array.isArray(t.playlists) ? t.playlists : []).forEach((pl) => {
      if (!pl || !pl.id || hydratedLists.has(pl.id) || out.includes(pl.id))
        return;
      if (isNonHydratableListId(pl.id)) return;
      const rec = progressCache[pl.id];
      if (rec && Array.isArray(rec.videos) && rec.videos.length > 0) return;
      // Q-3: a list that already came back empty is off the queue until the
      // cooldown lapses — otherwise it parks at the head forever and everything
      // behind it starves.
      if (
        rec &&
        typeof rec.hydrateFailed === "number" &&
        now - rec.hydrateFailed < HYDRATE_RETRY_MS
      )
        return;
      out.push(pl.id);
    });
  });
  return out;
}

// ponytail: PLAYLIST_FETCH_MAX (3) per document, one every 1.5s after a 2s
// settle — a deliberate trickle, not a sync. A user with 20 stale playlists tops
// up over a few page loads; nobody's first paint pays for a burst of fetches.
//
// Search decree (v1.2.2): /results must cost LearnTube nothing. A hydration
// fetch is ~800KB of bandwidth plus a main-thread parse of the blob — invisible
// on the Library, rude while search results are streaming. So the queue WAITS
// OUT a search page. The check lives inside `step` (not around the scheduling)
// so the queue resumes by itself the moment the user leaves /results.
// The cap counts CONSECUTIVE deferrals (the counter resets the moment a step
// runs off-search), so it means "~2 minutes parked on search without leaving",
// not "40 search visits this session" — a YouTube SPA document lives for hours
// and would otherwise accumulate its way to a permanent stop. Hitting the cap
// stops the queue for the life of THIS document (backfillRan is never re-armed);
// the next hard load re-queues it.
const BACKFILL_DEFER_MS = 3000;
const BACKFILL_DEFER_MAX = 40; // ~2 min CONSECUTIVE on /results -> give up
// (onSearchRoute lives with the route stamp near the top — one search gate.)
// Run fn when the main thread is free-ish. The timeout keeps it a deferral
// rather than a maybe — but it is a scheduling hint, not a guarantee: fn is
// queued as a task once the 2s timeout expires, and under continuous long tasks
// it can land later than that.
function runWhenIdle(fn) {
  if (typeof requestIdleCallback === "function")
    requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 0);
}
function backfillMissingPlaylistScrapes() {
  if (backfillRan || !reworkEnabled || !topicsSeeded || !progressSeeded) return;
  if (documentDoomed) return; // S7 redirect in flight — don't fetch for a corpse
  backfillRan = true;
  let deferrals = 0;
  const step = (n) => {
    // documentDoomed re-checked per step, not just at entry: an S7 redirect can
    // be decided AFTER the queue started, and a doomed document must not fetch.
    if (n >= PLAYLIST_FETCH_MAX || documentDoomed) return;
    if (onSearchRoute()) {
      if (++deferrals > BACKFILL_DEFER_MAX) return; // give up; next hard load retries
      setTimeout(() => step(n), BACKFILL_DEFER_MS); // same n — no budget burned
      return;
    }
    deferrals = 0; // off search again -> the cap means CONSECUTIVE, not lifetime
    const id = listIdsMissingScrape()[0];
    if (!id) return; // nothing left -> stop early, no empty timers
    hydratePlaylistInBackground(id); // claims synchronously, idles its own fetch
    setTimeout(() => step(n + 1), 1500);
  };
  setTimeout(() => step(0), 2000);
}

// --- K2: the ONE "complete" helper -------------------------------------------
// A lecture is complete if the scrape marked it watched OR the user manually
// ticked it (done === true). A manual UN-tick (done === false) is the single
// thing that clears a watched-derived completion — the K1 escape hatch: a
// scrape can no longer clear `watched` (the merge is monotonic), so the un-tick
// is the only way to correct a lecture YouTube wrongly counted as ≥95% watched.
// `done` absent → the auto scrape decides. This is `watched || done` for the
// common case; done:false is the override. EVERY count / Continue / ✓ mark
// routes through here so they always agree.
function isLectureComplete(v) {
  if (!v) return false;
  if (v.done === true) return true;
  if (v.done === false) return false;
  return !!v.watched;
}

// Join the progress cache against a topic's playlists: percentage = watched /
// total known, and the first unwatched video (in playlist order) for resume.
function topicProgress(topic) {
  const playlists = Array.isArray(topic.playlists) ? topic.playlists : [];
  let total = 0;
  let watched = 0;
  let next = null; // { videoId, listId }
  playlists.forEach((pl) => {
    const rec = progressCache[pl.id];
    const vids = rec && Array.isArray(rec.videos) ? rec.videos : [];
    vids.forEach((v) => {
      total += 1;
      if (isLectureComplete(v)) watched += 1;
      else if (!next) next = { videoId: v.id, listId: pl.id };
    });
  });
  const pct = total > 0 ? Math.round((watched / total) * 100) : 0;
  return { pct, watched, total, next };
}

function resumeUrl(next) {
  return (
    "https://www.youtube.com/watch?v=" +
    encodeURIComponent(next.videoId) +
    "&list=" +
    encodeURIComponent(next.listId)
  );
}

// The dedicated playlist page. Opening it is what triggers the Step-6 scrape,
// so the "open playlist" link doubles as "start/refresh tracking".
function playlistUrl(id) {
  return "https://www.youtube.com/playlist?list=" + encodeURIComponent(id);
}

// Per-playlist watched-state from the local cache: title (if scraped) + counts.
// (No pct / next here: the one caller, renderModule, renders "N of M" and the
// module title only — the course view's own progress bar and Resume link come
// from topicProgress.)
function playlistProgress(plId) {
  const rec = progressCache[plId];
  const vids = rec && Array.isArray(rec.videos) ? rec.videos : [];
  let watched = 0;
  vids.forEach((v) => {
    if (isLectureComplete(v)) watched += 1;
  });
  return {
    title: (rec && rec.title) || "",
    total: vids.length,
    watched,
  };
}

// --- Step 21: the Library (home redesign) -------------------------------------
// The quiet CONTINUE row resumes ONE lecture across ALL topics, chosen by a
// deterministic rule (doc §4 — unchanged since spec-12):
//   Pass 1 — resume what's underway: the first PARTIALLY-watched lecture
//            (ratio > 0 && !watched), scanned topic→playlist→video in order.
//   Pass 2 — else start the next unwatched lecture of the first topic that has
//            one (reusing topicProgress(t).next).
// Same data => same lecture (document-order tie-break; no time/random input).
// Step 21: the context also surfaces the lecture's REAL scraped title (Step 19)
// and the playlist's scraped title — null/"" when not scraped yet, NEVER a
// fabricated label. Returns null when nothing is resumable.
function nextLectureAcrossTopics() {
  const ctx = (topic, listId, video) => {
    const rec = progressCache[listId];
    return {
      topicId: topic.id,
      topicName: topicDisplayName(topic),
      listId,
      videoId: video ? video.id : null,
      title: (video && video.title) || null, // real scraped title or nothing
      listTitle: (rec && rec.title) || "",
    };
  };
  // Pass 1: an in-progress lecture beats a fresh one in any later topic.
  for (let i = 0; i < topicsCache.length; i++) {
    const t = topicsCache[i];
    const pls = Array.isArray(t.playlists) ? t.playlists : [];
    for (let j = 0; j < pls.length; j++) {
      const rec = progressCache[pls[j].id];
      const vids = rec && Array.isArray(rec.videos) ? rec.videos : [];
      for (let k = 0; k < vids.length; k++) {
        const v = vids[k];
        if (!isLectureComplete(v) && v.ratio > 0) return ctx(t, pls[j].id, v);
      }
    }
  }
  // Pass 2: otherwise the first unwatched lecture of the first topic with one.
  for (let i = 0; i < topicsCache.length; i++) {
    const t = topicsCache[i];
    const p = topicProgress(t);
    if (p.next) {
      const rec = progressCache[p.next.listId];
      const vids = rec && Array.isArray(rec.videos) ? rec.videos : [];
      const v = vids.find((x) => x.id === p.next.videoId) || {
        id: p.next.videoId,
      };
      return ctx(t, p.next.listId, v);
    }
  }
  return null;
}

// A topic's display name. Topics created from the empty state's pasted
// playlist start unnamed (name "") and ADOPT the playlist's real scraped title
// (locked: "never an invented one"); until that scrape lands, the honest raw
// playlist id shows. The "Untitled topic" fallback is unreachable through the
// normal flows (creation always supplies a name or a playlist).
function topicDisplayName(t) {
  if (t.name) return t.name;
  const pls = Array.isArray(t.playlists) ? t.playlists : [];
  if (pls.length > 0) {
    const rec = progressCache[pls[0].id];
    if (rec && rec.title) return rec.title;
    return pls[0].id; // honest raw id until the first scrape names it
  }
  return "Untitled topic";
}

// Persist the adopted name: once an unnamed topic's first playlist has a
// scraped title, write it into settings.topics so the name is durable, synced,
// and renameable. Guarded so it only writes while something is adoptable —
// after one write every such topic is named, so this can't loop.
// In-flight latch (#8): adopt reads the in-memory topicsCache, but the sync
// write only propagates back (clearing `adoptable`) one onChanged later. A
// scrape burst that fires several adopt calls before that echo would otherwise
// each see the stale empty name and re-issue the same write (sync caps at ~120
// write-ops/min). The latch lets only ONE adoption write be in flight; it's
// cleared on the write callback. (#1 already collapses the scrape to ~1 write
// per open, so this is mostly belt-and-suspenders.)
let adoptInProgress = false;
function adoptScrapedTopicNames() {
  if (adoptInProgress) return; // a name write is already in flight
  const adoptable = topicsCache.some((t) => {
    if (t.name || !Array.isArray(t.playlists) || t.playlists.length === 0)
      return false;
    const rec = progressCache[t.playlists[0].id];
    return !!(rec && rec.title);
  });
  if (!adoptable) return;
  adoptInProgress = true;
  mutateTopics(
    (s) => {
      s.topics.forEach((t) => {
        if (t.name) return;
        const pls = Array.isArray(t.playlists) ? t.playlists : [];
        if (pls.length === 0) return;
        const rec = progressCache[pls[0].id];
        if (rec && rec.title) t.name = rec.title;
      });
    },
    () => {
      adoptInProgress = false;
    }
  );
}

// The Library header's one-line overview: "N topics · X of Y lectures".
// Same topicProgress the cards use, so Σ cards = header by construction.
function overallSummary() {
  const n = topicsCache.length;
  let total = 0;
  let watched = 0;
  topicsCache.forEach((t) => {
    const p = topicProgress(t);
    total += p.total;
    watched += p.watched;
  });
  const tw = n === 1 ? "topic" : "topics";
  return n + " " + tw + " · " + watched + " of " + total + " lectures";
}

// --- Render -----------------------------------------------------------------
// Build the panel from topicsCache. ALL user-supplied strings (topic names,
// playlist ids) go through textContent / created nodes — never interpolated into
// innerHTML — so a topic named "<img onerror=…>" can't execute.

function makeEl(tag, opts) {
  const el = document.createElement(tag);
  if (opts) {
    if (opts.className) el.className = opts.className;
    if (opts.text != null) el.textContent = opts.text;
    if (opts.attrs)
      for (const k in opts.attrs) el.setAttribute(k, opts.attrs[k]);
  }
  return el;
}

// Step 13: the drag handle (the mockup's ⋮⋮ grip). The HANDLE — not the whole
// card — is the draggable element, so the card's links and controls keep their
// native behavior. Step 21: only topic cards drag (the Desk's playlist rows are
// gone), so `kind` is always "topic". The glyph is a static literal.
function makeGrip(kind) {
  const grip = makeEl("span", {
    className: "ytr-grip",
    text: "⋮⋮", // ⋮⋮
    attrs: { "data-drag": kind, draggable: "true", "aria-hidden": "true" },
  });
  return grip;
}

function makeInputRow(inputClass, placeholder, action, btnLabel) {
  const row = makeEl("div", { className: inputClass + "-row" });
  const input = makeEl("input", {
    className: "ytr-input " + inputClass,
    attrs: { type: "text", placeholder },
  });
  input.dataset.action = action + "-key"; // Enter handled via keydown
  const btn = makeEl("button", { className: "ytr-btn", text: btnLabel });
  btn.dataset.action = action;
  const err = makeEl("span", { className: "ytr-err" });
  err.dataset.role = "err";
  row.append(input, btn, err);
  return row;
}

// Step 21: the card's hover ··· menu (rename / delete). Built lazily on first
// open, removed on close. The buttons reuse the existing rename-topic /
// delete-topic actions (the menu sits inside the card, so topicIdOf resolves).
function buildCardMenu() {
  const menu = makeEl("div", {
    className: "ytr-card-menu",
    attrs: { role: "menu" },
  });
  const rename = makeEl("button", {
    className: "ytr-card-menu-item",
    text: "Rename",
    attrs: { type: "button", role: "menuitem" },
  });
  rename.dataset.action = "rename-topic";
  const del = makeEl("button", {
    className: "ytr-card-menu-item",
    text: "Delete",
    attrs: { type: "button", role: "menuitem" },
  });
  del.dataset.action = "delete-topic";
  menu.append(rename, del);
  return menu;
}

// Close any open card menu; returns how many were open (so a dismissing click
// can be swallowed instead of also firing the card's open-course).
function closeCardMenus() {
  const root = document.getElementById(LEARNING_ROOT_ID);
  if (!root) return 0;
  const open = root.querySelectorAll(".ytr-card-ovf.is-open");
  open.forEach((w) => {
    w.classList.remove("is-open");
    const m = w.querySelector(".ytr-card-menu");
    if (m) m.remove();
  });
  return open.length;
}

// One topic as the Library's ONE card layout (doc §03): name · slim progress
// bar · "N of M lectures" · a Resume/Start deep-link. The WHOLE card opens the
// course view (data-action on the card itself; inner links/controls win via
// closest()). The hover ··· holds rename/delete. No rings, no playlist rows,
// no inputs — module management lives in the course view.
function renderTopicCard(topic) {
  const prog = topicProgress(topic);
  const complete = prog.total > 0 && !prog.next;
  const name = topicDisplayName(topic);

  const card = makeEl("div", {
    className: "ytr-card" + (complete ? " is-complete" : ""),
    attrs: { "data-topic-id": topic.id, "data-action": "open-course" },
  });

  // Top row: drag grip + name + the ··· overflow.
  const top = makeEl("div", { className: "ytr-card-top" });
  top.append(makeGrip("topic")); // Step 13: drag-to-reorder this card in the grid
  top.append(makeEl("div", { className: "ytr-card-name", text: name }));
  const ovf = makeEl("span", { className: "ytr-card-ovf" });
  const ovfBtn = makeEl("button", {
    className: "ytr-card-ovf-btn",
    text: "···",
    attrs: {
      type: "button",
      "aria-label": "Topic actions",
      "aria-haspopup": "menu",
    },
  });
  ovfBtn.dataset.action = "card-menu";
  ovf.append(ovfBtn);
  top.append(ovf);
  card.append(top);

  // Spacer keeps every card the same shape (mock .card-sp).
  card.append(makeEl("div", { className: "ytr-card-sp" }));

  // One slim progress bar — accent fill width is a number, never innerHTML.
  const bar = makeEl("div", { className: "ytr-bar" });
  const fill = makeEl("i");
  fill.style.width = prog.pct + "%";
  bar.append(fill);
  card.append(bar);

  // Stat line: honest count + one way in (Resume / Start at 0 watched).
  const stat = makeEl("div", { className: "ytr-card-stat" });
  stat.append(
    makeEl("span", {
      className: "ytr-card-count",
      text:
        prog.total > 0
          ? prog.watched + " of " + prog.total + " lectures"
          : "No lectures yet",
    })
  );
  if (prog.next) {
    const go = makeEl("a", {
      className: "ytr-card-go",
      text: prog.watched === 0 ? "Start ›" : "Resume ›",
    });
    go.href = resumeUrl(prog.next); // a URL only — never innerHTML
    stat.append(go);
  } else if (complete) {
    stat.append(
      makeEl("span", { className: "ytr-card-go is-done", text: "Completed" })
    );
  }
  card.append(stat);

  return card;
}

// The dashed "+ New topic" tile that ALWAYS closes the grid (the grid never
// empties into a void). Collapsed: a quiet + label. Expanded (addTileOpen):
// the inline name input + Create, reusing the add-topic action.
function renderAddTile() {
  const tile = makeEl("div", {
    className: "ytr-card ytr-add-tile" + (addTileOpen ? " is-open" : ""),
  });
  if (addTileOpen) {
    tile.append(
      makeInputRow("ytr-add-topic", "Topic name", "add-topic", "Create")
    );
  } else {
    tile.dataset.action = "add-tile";
    tile.setAttribute("role", "button");
    tile.append(makeEl("span", { className: "ytr-add-tile-plus", text: "+" }));
    tile.append(makeEl("span", { text: "New topic" }));
  }
  return tile;
}

// The quiet Continue row (doc §03 Library): ▷ glyph · eyebrow "Continue" · the
// global next lecture's REAL title · "Topic · Playlist title" · "Resume ›".
// The WHOLE row is one <a href=resumeUrl>. Returns null (row hidden) when
// nothing is in progress and nothing remains. A legacy scrape without a title
// simply omits the title line — never "Lecture N", never an id fragment.
function renderContinue() {
  const lecture = nextLectureAcrossTopics();
  if (!lecture) return null;

  const row = makeEl("a", { className: "ytr-continue" });
  row.href = resumeUrl({
    videoId: lecture.videoId,
    listId: lecture.listId,
  }); // a URL only — never innerHTML

  row.append(
    makeEl("span", {
      className: "ytr-cont-play",
      text: "▷",
      attrs: { "aria-hidden": "true" },
    })
  );

  const main = makeEl("span", { className: "ytr-cont-main" });
  main.append(makeEl("span", { className: "ytr-cont-eyebrow", text: "Continue" }));
  if (lecture.title) {
    main.append(
      makeEl("span", { className: "ytr-cont-title", text: lecture.title })
    );
  }
  main.append(
    makeEl("span", {
      className: "ytr-cont-sub",
      text:
        lecture.topicName +
        (lecture.listTitle ? " · " + lecture.listTitle : ""),
    })
  );
  row.append(main);

  row.append(makeEl("span", { className: "ytr-cont-go", text: "Resume ›" }));
  return row;
}

// Phase 2: the Peek controls — the "Show feed" pill (tooltip: the plain
// sentence) plus, while peeking, a List | Grid segmented switcher. K5 moved
// them out of the Library header into the bottom .ytr-feed-bar (renderFeedBar),
// just above where the feed reveals. They live only on the Library, so they
// exist only while S6 (replaceHome) is on —
// exactly the spec's "the Peek pill exists only while this switch is ON". Static
// glyphs/labels via textContent; the pill's id lets setPeek re-sync aria-pressed.
function renderPeekControls() {
  const wrap = makeEl("div", { className: "ytr-peek-controls" });
  // K5: "◉ Peek" -> "Show feed" — a plainly named, STATIC label (no glyph, no
  // show/hide text flip). Same id / class / data-action / aria-pressed /
  // tooltip / accent-soft pressed state as before, so setPeek and the delegated
  // handler are unchanged.
  const pill = makeEl("button", {
    className: "ytr-peek-pill" + (peekOn ? " is-on" : ""),
    text: "Show feed",
    attrs: {
      type: "button",
      id: "ytr-peek-pill",
      "aria-pressed": peekOn ? "true" : "false",
      title: "See what YouTube would have shown you",
    },
  });
  pill.dataset.action = "peek-toggle";
  wrap.append(pill);
  // The List | Grid switcher — shown only while the reveal is open, ordered
  // AFTER the pill (mock: [Show feed] [List|Grid]).
  if (peekOn) {
    const seg = makeEl("div", {
      className: "ytr-peek-seg",
      attrs: { role: "group", "aria-label": "Feed layout" },
    });
    ["list", "grid"].forEach((v) => {
      const b = makeEl("button", {
        className: "ytr-peek-seg-btn" + (peekView === v ? " is-on" : ""),
        text: v === "list" ? "List" : "Grid",
        attrs: {
          type: "button",
          "aria-pressed": peekView === v ? "true" : "false",
        },
      });
      b.dataset.action = "peek-view";
      b.dataset.view = v;
      seg.append(b);
    });
    wrap.append(seg);
  }
  return wrap;
}

// K5: the bottom feed-bar (hairline top border) that holds the Peek controls,
// sitting directly ABOVE where the revealed native feed renders. Rendered on
// BOTH render paths so the pill exists even on the zero-topics empty state
// (Session-G B2 lock) — just at the bottom now instead of a top header row.
function renderFeedBar() {
  const bar = makeEl("div", { className: "ytr-feed-bar" });
  bar.append(renderPeekControls());
  return bar;
}

// Build THE LIBRARY (Step 21): header ("Library" + reconciling counts) → the
// quiet Continue row → the one card grid, always closed by the "+ New topic"
// add-tile. Zero topics falls to the guided first-run empty state (▷ glyph +
// one paste-a-playlist input) — never an empty grid.
function renderLearningInto(root) {
  // Clear and rebuild from cache.
  root.textContent = "";

  // Step 14: if a course is open AND its topic still exists, render the course
  // view instead of the Library. A deleted/missing topic falls back to the
  // Library (and we clear the stale id), so the view can never be orphaned.
  if (currentTopicId) {
    const openTopic = topicsCache.find((t) => t.id === currentTopicId);
    if (openTopic) {
      renderCourseInto(root, openTopic);
      return;
    }
    currentTopicId = null;
  }

  if (topicsCache.length === 0) {
    // Guided first-run empty state: one mark, one sentence, one input. The Add
    // creates the first topic CONTAINING the pasted playlist (name adopted
    // from the scraped playlist title later — never invented).
    const empty = makeEl("div", { className: "ytr-empty" });
    empty.append(
      makeEl("div", {
        className: "ytr-empty-glyph",
        text: "▷",
        attrs: { "aria-hidden": "true" },
      })
    );
    empty.append(
      makeEl("div", {
        className: "ytr-empty-title",
        text: "Begin your first course",
      })
    );
    empty.append(
      makeEl("div", {
        className: "ytr-empty-sub",
        text: "Paste a YouTube playlist and LearnTube turns it into a course you can track, resume, and finish.",
      })
    );
    const addrow = makeEl("div", { className: "ytr-empty-add" });
    addrow.append(
      makeInputRow(
        "ytr-add-pl",
        "Paste a YouTube playlist link",
        "create-from-playlist",
        "Add"
      )
    );
    empty.append(addrow);
    root.append(empty);
    // K5 / Session-G lock: the feed-bar (with the "Show feed" pill) exists on
    // the empty state too — now at the bottom, above where the feed reveals.
    // Gated by the "Show feed button" switch (showFeed): off = no bar at all.
    if (togglesCache.showFeed !== false) root.append(renderFeedBar());
    return;
  }

  // K5: slim header — "Library" + the reconciling counts on ONE baseline row.
  const head = makeEl("div", { className: "ytr-head" });
  head.append(makeEl("h1", { className: "ytr-title", text: "Library" }));
  head.append(makeEl("span", { className: "ytr-stats", text: overallSummary() }));
  root.append(head);

  // K5: the HERO Continue card — hidden when nothing resolves (null); the page
  // then leads with topics.
  const cont = renderContinue();
  if (cont) root.append(cont);

  // K5: a quiet uppercase "TOPICS" shelf label above the card grid.
  root.append(makeEl("div", { className: "ytr-shelf-label", text: "Topics" }));

  // The one card grid, always closed by the add-tile.
  const grid = makeEl("div", { className: "ytr-grid" });
  topicsCache.forEach((t) => grid.append(renderTopicCard(t)));
  grid.append(renderAddTile());
  root.append(grid);

  // K5: the feed controls now live in a bottom feed-bar, above the feed.
  // Gated by the "Show feed button" switch (showFeed): off = no bar at all.
  if (togglesCache.showFeed !== false) root.append(renderFeedBar());
}

// --- Step 14/22: the course view ----------------------------------------------
// An alternate render of the SAME root: a topic opened into its playlists as
// clearly separated MODULES, each a lecture checklist. Rebuilt in Step 22 to
// the v2 contract: every lecture row is mark + REAL scraped title + duration
// (Step 19 unlock) and the whole row deep-links — no "Lecture N", no id
// fragments, no per-lecture note inputs (doc §05: notes removed; Premium
// Listen/Download removed — killed non-goals). A module whose videos lack
// scraped titles shows the calm "open once" line instead of fake rows.
// Watched marks come straight from the scraped ratio. Every dynamic string
// via textContent; every id only ever a link href.

// Switch the panel into this topic's course and re-render in place.
function openCourse(topicId) {
  // Opening a course takes over the study surface — that IS leaving the Library,
  // so dismiss the session-only Peek reveal (else CSS §9 keeps the native
  // algorithm grid revealed as a sibling below the course view, with no in-view
  // pill to turn it off). Matches "Peek resets when you leave the Library".
  if (peekOn) setPeek(false);
  currentTopicId = topicId;
  renderLearningHome();
}

// Return to the Library.
function closeCourse() {
  currentTopicId = null;
  renderLearningHome();
}

// One lecture row: the WHOLE row is one deep-link (watch?v=…&list=…) — an
// honest mark (✓ done ≥.95 / partial dot / empty) + the REAL scraped title +
// its duration label. Real titles only: callers never pass a title-less video
// (a module without titles shows the calm open-once line instead). No notes,
// no id strings (doc §COURSE / §05).
function renderLecture(video, listId, opts) {
  const complete = isLectureComplete(video);
  // The focus strip reuses this row verbatim but its rows are plain links
  // handled by onRoomClick (no toggle branch), so it asks for a display-only
  // mark; the course view gets the real toggle button.
  const staticMark = !!(opts && opts.static);
  const row = makeEl("a", {
    className: "ytr-lec" + (complete ? " is-done" : ""),
  });
  row.href = resumeUrl({ videoId: video.id, listId }); // a URL only — never innerHTML

  // K2: in the course view the mark is a real toggle <button> (manual done-tick).
  // It sits INSIDE the row <a>; per the delegation contract (onLearningClick) the
  // button is the closest [data-action] and the row <a> is its ANCESTOR, so
  // btn.contains(link) is false — the click toggles WITHOUT navigating the row,
  // and Enter/Space on the focused button fire a native click the delegate
  // catches. All chrome is rebuilt in CSS via the all:unset idiom.
  let mark;
  if (staticMark) {
    mark = makeEl("span", {
      className: "ytr-lec-mark",
      attrs: { "aria-hidden": "true" },
    });
  } else {
    mark = makeEl("button", {
      className: "ytr-lec-mark",
      attrs: {
        type: "button",
        "aria-pressed": complete ? "true" : "false",
        "aria-label":
          (complete ? "Mark not done: " : "Mark done: ") +
          (video.title || "lecture"),
      },
    });
    mark.dataset.action = "toggle-done";
    mark.dataset.listId = listId;
    mark.dataset.videoId = video.id;
  }
  if (complete) {
    mark.classList.add("is-done");
    mark.textContent = "✓";
  } else if (video.ratio > 0) {
    mark.classList.add("is-partial");
  }
  row.append(mark);

  row.append(makeEl("span", { className: "ytr-lec-title", text: video.title }));

  // The Step-19 scraped duration label ("14:02") — shown as-is, omitted when
  // the scrape missed it. Never computed or fabricated.
  if (video.duration) {
    row.append(
      makeEl("span", { className: "ytr-lec-dur", text: video.duration })
    );
  }
  return row;
}

// One module = one playlist, clearly separated (hairline top rule in CSS —
// "2+ playlists = clean modules, never a merged blur"). Header: real scraped
// playlist title (else the honest raw id) · "N of M · Open ↗" (opening the
// playlist on YouTube is what triggers the Step-6/19 scrape). Below it the
// lecture checklist — but ONLY rows with real scraped titles: an un-scraped
// playlist, or a legacy (pre-Step-19) scrape that stored ids without titles,
// shows the calm open-once line instead of fake rows.
function renderModule(pl) {
  const p = playlistProgress(pl.id);
  const section = makeEl("section", {
    className: "ytr-module",
    attrs: { "data-pl-id": pl.id },
  });

  const head = makeEl("div", { className: "ytr-module-head" });
  head.append(
    makeEl("div", {
      className: "ytr-module-name",
      text: p.title || pl.id, // honest raw id until the scrape names it
    })
  );
  const meta = makeEl("div", { className: "ytr-module-meta" });
  if (p.total > 0) {
    meta.append(
      makeEl("span", {
        className: "ytr-module-count",
        text: p.watched + " of " + p.total + " · ",
      })
    );
  }
  const openPl = makeEl("a", { className: "ytr-module-open", text: "Open ↗" });
  openPl.href = playlistUrl(pl.id); // opening triggers the scrape
  openPl.target = "_blank";
  openPl.rel = "noopener";
  meta.append(openPl);
  head.append(meta);
  section.append(head);

  const rec = progressCache[pl.id];
  const vids = rec && Array.isArray(rec.videos) ? rec.videos : [];
  const titled = vids.filter((v) => v.title); // real titles only — never a fake row
  if (titled.length === 0) {
    section.append(
      makeEl("div", {
        className: "ytr-module-empty",
        text: "Open this playlist once to load its lectures.",
      })
    );
  } else {
    const list = makeEl("div", { className: "ytr-lec-list" });
    titled.forEach((v) => list.append(renderLecture(v, pl.id)));
    section.append(list);
  }
  return section;
}

// The next lecture's REAL scraped title, for the Resume hint. Returns "" when
// the scrape has no title for it (legacy pre-19 cache) — the hint is then
// simply omitted, never fabricated.
function nextLectureTitle(next) {
  if (!next) return "";
  const rec = progressCache[next.listId];
  const vids = rec && Array.isArray(rec.videos) ? rec.videos : [];
  const v = vids.find((x) => x.id === next.videoId);
  return (v && v.title) || "";
}

// Build the whole course view into the root for one topic (Step 22 contract):
// "‹ Library" back · name · "N of M lectures completed" · slim progress bar
// (no ring) · ONE primary "▷ Resume" with a real-title hint beneath (a calm
// non-link "Completed" when done) · the playlists as modules · the inline
// add-module row. No Premium buttons, no note inputs.
function renderCourseInto(root, topic) {
  const prog = topicProgress(topic);
  const complete = prog.total > 0 && !prog.next;
  // The course root carries the topic id so the delegated handlers (add-playlist
  // inside the course, etc.) resolve via topicIdOf just like a Library card.
  const course = makeEl("div", {
    className: "ytr-course",
    attrs: { "data-topic-id": topic.id },
  });

  // --- Back to the Library (its own quiet row above the header) -----------
  const backRow = makeEl("div", { className: "ytr-course-back-row" });
  const back = makeEl("button", { className: "ytr-back", text: "‹ Library" });
  back.dataset.action = "close-course";
  backRow.append(back);
  course.append(backRow);

  // --- Header: name / count / slim bar left · Resume + hint right ---------
  const head = makeEl("div", { className: "ytr-course-head" });

  const idblock = makeEl("div", { className: "ytr-course-id" });
  idblock.append(
    makeEl("h1", {
      className: "ytr-course-name",
      text: topicDisplayName(topic),
    })
  );
  idblock.append(
    makeEl("div", {
      className: "ytr-course-count",
      text:
        prog.total > 0
          ? prog.watched + " of " + prog.total + " lectures completed"
          : "No lectures tracked yet",
    })
  );
  // The slim progress bar (the Library's .ytr-bar — no ring). Width is a
  // number, never innerHTML.
  const bar = makeEl("div", { className: "ytr-bar ytr-course-bar" });
  const fill = makeEl("i");
  fill.style.width = prog.pct + "%";
  bar.append(fill);
  idblock.append(bar);
  head.append(idblock);

  // ONE primary Resume — deep-links the deterministic next lecture of THIS
  // topic (§4: the first non-watched, partial or fresh, in playlist→video
  // order — the same lecture the Library's card links). The hint beneath
  // names it by its REAL scraped title (omitted if the scrape has none).
  // When nothing is resumable, a calm non-link "Completed" replaces it.
  if (prog.next) {
    const wrap = makeEl("div", { className: "ytr-resume-wrap" });
    const resume = makeEl("a", {
      className: "ytr-resume-btn",
      text: "▷ Resume",
    });
    resume.href = resumeUrl(prog.next);
    wrap.append(resume);
    const hint = nextLectureTitle(prog.next);
    if (hint) {
      wrap.append(makeEl("div", { className: "ytr-resume-hint", text: hint }));
    }
    head.append(wrap);
  } else if (complete) {
    const wrap = makeEl("div", { className: "ytr-resume-wrap" });
    wrap.append(
      makeEl("span", {
        className: "ytr-resume-btn is-disabled",
        text: "Completed",
      })
    );
    head.append(wrap);
  }

  course.append(head);

  // --- Modules ------------------------------------------------------------
  const playlists = Array.isArray(topic.playlists) ? topic.playlists : [];
  if (playlists.length === 0) {
    const empty = makeEl("div", { className: "ytr-course-empty" });
    empty.append(
      makeEl("div", {
        className: "ytr-empty-title",
        text: "No modules yet",
      })
    );
    empty.append(
      makeEl("div", {
        className: "ytr-empty-sub",
        text: "Add a YouTube playlist below — it becomes a module in this course.",
      })
    );
    course.append(empty);
  } else {
    const modules = makeEl("div", { className: "ytr-modules" });
    playlists.forEach((pl) => modules.append(renderModule(pl)));
    course.append(modules);
  }

  // Add-playlist input (scoped to this topic via the course root's data-topic-id).
  course.append(
    makeInputRow(
      "ytr-add-pl",
      "Paste a YouTube playlist link to add a module",
      "add-playlist",
      "Add"
    )
  );

  root.append(course);
}

// Re-render the already-mounted root in place (if present). Called by onChanged.
function renderLearningHome() {
  const root = document.getElementById(LEARNING_ROOT_ID);
  if (root) renderLearningInto(root);
}

// --- Event handling (delegated on the root) ----------------------------------
// One set of listeners on the root, attached once at mount, so re-renders never
// accumulate handlers.
function topicIdOf(el) {
  const t = el.closest("[data-topic-id]");
  return t ? t.getAttribute("data-topic-id") : null;
}

function rowInput(el) {
  // The input that shares the same -row container as the clicked button.
  const row = el.closest("div");
  return row ? row.querySelector("input.ytr-input") : null;
}

function showErr(el, msg) {
  const row = el.closest("div");
  const err = row && row.querySelector('[data-role="err"]');
  if (err) err.textContent = msg || "";
}

function handleAction(action, el) {
  if (action === "add-topic") {
    const input = rowInput(el);
    const name = input ? input.value.trim() : "";
    if (!name) {
      showErr(el, "Enter a name");
      return;
    }
    addTileOpen = false; // collapse the tile; storage.onChanged re-renders
    mutateTopics((s) => {
      s.topics.push({ id: newTopicId(), name, playlists: [] });
    });
    if (input) input.value = "";
    return;
  }

  // Step 21: expand the "+ New topic" tile into its inline input.
  if (action === "add-tile") {
    if (addTileOpen) return; // already expanded
    addTileOpen = true;
    renderLearningHome();
    const root = document.getElementById(LEARNING_ROOT_ID);
    const input = root && root.querySelector(".ytr-add-tile input.ytr-input");
    if (input) input.focus();
    return;
  }

  // Step 21: first-run empty state — the pasted playlist BECOMES the first
  // topic (name "" until the scrape adopts the playlist's real title).
  if (action === "create-from-playlist") {
    const input = rowInput(el);
    const id = parsePlaylistId(input ? input.value : "");
    if (!id) {
      showErr(el, "Couldn't read a playlist id");
      return;
    }
    // "" name -> adopted from the scraped playlist title, never invented.
    createTopicWithPlaylist("", id); // the ONE writer (shared with Session M)
    if (input) input.value = "";
    showErr(el, "");
    return;
  }

  // Step 21: the card's ··· menu (rename / delete), built lazily.
  if (action === "card-menu") {
    const wrap = el.closest(".ytr-card-ovf");
    if (!wrap) return;
    const wasOpen = wrap.classList.contains("is-open");
    closeCardMenus();
    if (!wasOpen) {
      wrap.appendChild(buildCardMenu());
      wrap.classList.add("is-open");
    }
    return;
  }

  // Step 14: Back from a course → the Library (no topic id needed).
  if (action === "close-course") {
    closeCourse();
    return;
  }

  // K2: toggle a lecture's manual done-tick. The button rides inside the row
  // <a> (delegation contract cancels the row nav for us). Flip complete via the
  // ONE helper so watched-derived and manual completion agree, then persist —
  // the progress onChanged re-renders every surface (counts / Continue / ✓).
  if (action === "toggle-done") {
    const listId = el.dataset.listId;
    const videoId = el.dataset.videoId;
    if (!listId || !videoId) return;
    const rec = progressCache[listId];
    const vids = rec && Array.isArray(rec.videos) ? rec.videos : [];
    const v = vids.find((x) => x.id === videoId);
    if (!v) return; // not scraped yet -> nothing to tick
    mutateVideoDone(listId, videoId, !isLectureComplete(v));
    return;
  }

  // Phase 2: toggle the Peek reveal (session-only). Re-render so the List | Grid
  // switcher appears/disappears; kick the home decorate pass when revealing.
  if (action === "peek-toggle") {
    setPeek(!peekOn);
    renderLearningHome();
    // Always re-run the home pass: peek-ON decorates the revealed feed, peek-OFF
    // lets the retry shed the K3 re-decoration observer (feed now hidden).
    decorateHomeWithRetry();
    return;
  }

  // Phase 2: flip the remembered Peek view (List | Grid). setPeekView persists it
  // and re-decorates; re-render marks the active segment.
  if (action === "peek-view") {
    setPeekView(el.dataset.view);
    renderLearningHome();
    return;
  }

  const topicId = topicIdOf(el);
  if (!topicId) return;

  // Step 14/21: open a topic's course view (the whole card carries the action).
  if (action === "open-course") {
    openCourse(topicId);
    return;
  }

  if (action === "add-playlist") {
    const input = rowInput(el);
    const id = parsePlaylistId(input ? input.value : "");
    if (!id) {
      showErr(el, "Couldn't read a playlist id");
      return;
    }
    addPlaylistToTopic(topicId, id); // the ONE writer (shared with Session M)
    if (input) input.value = "";
    showErr(el, "");
    return;
  }

  // (No "remove-playlist" action: nothing in the Library or the course view
  // renders a per-module remove control, so a playlist leaves a topic only by
  // deleting the topic. The branch that once handled it was dead code.)

  if (action === "rename-topic") {
    closeCardMenus(); // a cancelled prompt must not leave the menu open
    const current = (topicsCache.find((x) => x.id === topicId) || {}).name || "";
    const next = window.prompt("Rename topic", current);
    if (next == null) return; // cancelled
    const trimmed = next.trim();
    if (!trimmed) return;
    mutateTopics((s) => {
      const t = s.topics.find((x) => x.id === topicId);
      if (t) t.name = trimmed;
    });
    return;
  }

  if (action === "delete-topic") {
    closeCardMenus();
    mutateTopics((s) => {
      s.topics = s.topics.filter((x) => x.id !== topicId);
    });
    return;
  }
}

function onLearningClick(e) {
  // Step 13 click-through guard: swallow the click the browser may synthesize
  // immediately after a drop so a drag never opens the course / a deep-link.
  // Reset on the tick after dragend, so normal clicks still work.
  if (justDragged) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  // Step 21: an open card menu is dismissed by any click outside its own ···
  // wrap — and that click is ONLY a dismissal (it must not also open a course
  // or follow a link).
  if (!e.target.closest(".ytr-card-ovf")) {
    if (closeCardMenus() > 0) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
  }
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  // Step 21: the whole card carries open-course, but a real deep-link inside
  // it (Resume/Start) wins — let native navigation proceed.
  const link = e.target.closest("a[href]");
  if (link && btn.contains(link)) return;
  const action = btn.dataset.action;
  if (action && action.indexOf("-key") === -1) {
    e.preventDefault();
    handleAction(action, btn);
  }
}

function onLearningKeydown(e) {
  // Step 21: Escape collapses the expanded "+ New topic" tile.
  if (e.key === "Escape" && addTileOpen && e.target.closest(".ytr-add-tile")) {
    addTileOpen = false;
    renderLearningHome();
    return;
  }
  if (e.key !== "Enter") return;
  const input = e.target.closest("input.ytr-input");
  if (!input) return;
  const action = (input.dataset.action || "").replace(/-key$/, "");
  if (action) {
    e.preventDefault();
    handleAction(action, input);
  }
}

// (No focus-out handler: onLearningFocusOut saved the per-lecture notes, and
// notes are a killed non-goal — removed from the course view in Step 22 and
// from the watch rail in Step 23. Nothing on these surfaces persists on blur.)

// --- Step 13: drag-to-reorder (delegated on the Learning root) ----------------
// Native HTML5 DnD — CSS can't reorder by drag. The ⋮⋮ grip is the draggable
// element (not the whole card), so links/controls keep native behavior. These
// listeners are attached once on the root in mountLearningHome and survive every
// in-place re-render (same pattern as onLearningClick). On drop we persist the
// new order via mutateTopics; storage.onChanged drives the re-render — the DOM is
// never hand-reordered, so the cache stays the single source of truth.
// Step 21: TOPIC CARDS ONLY — the Desk's playlist rows are gone (module
// management lives in the course view), so the playlist drag scope went with
// them.

function clearDropMarkers() {
  const root = document.getElementById(LEARNING_ROOT_ID);
  if (!root) return;
  root
    .querySelectorAll(".ytr-drop-before, .ytr-drop-after")
    .forEach((n) => n.classList.remove("ytr-drop-before", "ytr-drop-after"));
}

function onLearningDragStart(e) {
  const grip = e.target.closest(".ytr-grip");
  if (!grip) return; // only the grip starts a reorder drag
  const kind = grip.getAttribute("data-drag");
  if (kind !== "topic") return; // Step 21: only topic cards drag
  const card = grip.closest(".ytr-card");
  if (!card) return;
  dragState = { el: card };
  justDragged = false;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    // Some browsers refuse to start a drag unless data is set.
    try {
      e.dataTransfer.setData("text/plain", kind);
    } catch (_) {}
  }
  // Defer the ghost class a tick so the drag image is the solid element.
  const moved = dragState.el;
  setTimeout(() => {
    if (dragState && dragState.el === moved) moved.classList.add("is-dragging");
  }, 0);
}

// Whether to drop before/after a candidate, by comparing the pointer to its
// vertical midpoint. Step 21: the card grid is the only drop surface left
// (dropCandidate rejects anything outside .ytr-grid).
function beforeOrAfter(e, el) {
  const r = el.getBoundingClientRect();
  return e.clientY < r.top + r.height / 2 ? "before" : "after";
}

// The sibling card under the pointer that the dragged card could drop next to.
// Returns null over an invalid target (self, the add-tile, outside the grid).
function dropCandidate(e) {
  if (!dragState) return null;
  const card = e.target.closest(".ytr-card");
  if (
    !card ||
    card === dragState.el ||
    !card.closest(".ytr-grid") ||
    !card.getAttribute("data-topic-id") // the add-tile is not a drop target
  ) {
    return null;
  }
  return { el: card, place: beforeOrAfter(e, card) };
}

function onLearningDragOver(e) {
  if (!dragState) return;
  const cand = dropCandidate(e);
  e.preventDefault(); // required to allow a drop to fire
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  clearDropMarkers();
  if (cand) {
    cand.el.classList.add(
      cand.place === "before" ? "ytr-drop-before" : "ytr-drop-after"
    );
  }
}

function onLearningDrop(e) {
  if (!dragState) return;
  e.preventDefault();
  const cand = dropCandidate(e);
  const state = dragState;
  clearDropMarkers();
  if (!cand) return; // dropped on nothing valid → no write
  const movedId = state.el.getAttribute("data-topic-id");
  const targetId = cand.el.getAttribute("data-topic-id");
  if (!movedId || !targetId || movedId === targetId) return; // drop-on-self
  justDragged = true;
  reorderPersist(movedId, targetId, cand.place);
}

function onLearningDragEnd() {
  if (dragState && dragState.el) dragState.el.classList.remove("is-dragging");
  clearDropMarkers();
  dragState = null;
  // Keep justDragged true through any synthetic post-drop click, then clear on
  // the next tick so normal clicks work immediately afterward.
  setTimeout(() => {
    justDragged = false;
  }, 0);
}

// Persist a card reorder. mutateTopics is read-modify-write that never clobbers
// masterEnabled/stars/other settings fields; we only reorder settings.topics.
function reorderPersist(movedId, targetId, place) {
  mutateTopics((s) => {
    spliceById(s.topics, movedId, targetId, place);
  });
}

// Move `movedId` to just before/after `targetId`, computing the destination by
// id AFTER removing the source so a downward drag doesn't skew the index.
function spliceById(arr, movedId, targetId, place) {
  if (!Array.isArray(arr)) return;
  const from = arr.findIndex((x) => x.id === movedId);
  if (from < 0) return;
  const [moved] = arr.splice(from, 1);
  let to = arr.findIndex((x) => x.id === targetId);
  if (to < 0) {
    arr.splice(from, 0, moved); // target vanished → restore original spot
    return;
  }
  if (place === "after") to += 1;
  if (to < 0) to = 0;
  if (to > arr.length) to = arr.length;
  arr.splice(to, 0, moved);
}

function homeBrowse() {
  return document.querySelector('ytd-browse[page-subtype="home"]');
}

function learningMountTarget(browse) {
  return (
    browse.querySelector("#primary") ||
    browse.querySelector("#contents") ||
    browse
  );
}

function removeLearningHome() {
  const existing = document.getElementById(LEARNING_ROOT_ID);
  if (existing) existing.remove();
  // Step 14/21: tearing down the shell (master off / left home) resets the open
  // course and the add-tile, so the next mount always lands on the Library.
  currentTopicId = null;
  addTileOpen = false;
  // Phase 2: Peek is session-only — leaving the Library (nav-away / master-off /
  // S6-off all tear the shell down here) resets the reveal.
  if (peekOn) setPeek(false);
}

function mountLearningHome() {
  // Master off, not on the home route, or S6 (replaceHome) off → ensure no stray
  // root remains. S6 off = fully native Home (D2·A): no Library mounts, and the
  // native feed returns because §9's hide is gated on :not([data-ytr-show-home]).
  const browse = homeBrowse();
  if (!reworkEnabled || !browse || togglesCache.replaceHome === false) {
    removeLearningHome();
    return;
  }
  // Step 23: a "‹ Back to <topic>" arrival — consume the one-shot hint, then
  // apply it AFTER the stale-remount reset below (which nulls currentTopicId)
  // so the course survives a re-mount. A deleted topic id is cleared by
  // renderLearningInto — Library fallback.
  const hinted = takeOpenCourseHint();
  // Already mounted in the right place → just apply any hint (idempotent).
  const existing = document.getElementById(LEARNING_ROOT_ID);
  const target = learningMountTarget(browse);
  if (existing && existing.parentElement === target) {
    if (hinted) {
      currentTopicId = hinted;
      renderLearningHome(); // the shell YouTube kept mounted across the hop
    }
    return;
  }
  if (existing) {
    existing.remove(); // mounted somewhere stale → re-mount fresh
    currentTopicId = null; // a fresh shell starts on the Library (Step 14/21)
    addTileOpen = false;
  }
  if (hinted) currentTopicId = hinted; // Back arrival: open the course fresh

  const root = document.createElement("div");
  root.id = LEARNING_ROOT_ID;
  // Delegated listeners attached once per root (re-renders reuse the node).
  root.addEventListener("click", onLearningClick);
  root.addEventListener("keydown", onLearningKeydown);
  // Step 13: drag-to-reorder topic cards (handle-driven DnD).
  root.addEventListener("dragstart", onLearningDragStart);
  root.addEventListener("dragover", onLearningDragOver);
  root.addEventListener("drop", onLearningDrop);
  root.addEventListener("dragend", onLearningDragEnd);
  renderLearningInto(root); // data-driven contents from topicsCache
  target.prepend(root); // top of the content column, where the feed began

  // One orchestrated entrance on first mount only. The class drives the CSS
  // stagger; remove it after the run so later data-driven re-renders (finishing
  // a video, adding a topic) don't replay the animation on every change.
  root.classList.add("ytr-animate");
  setTimeout(() => root.classList.remove("ytr-animate"), 1100);
}

// YouTube hydrates ytd-browse asynchronously, so on a cold/hard load the home
// browse element may not exist when our nav listeners fire. Run a short bounded
// retry that stops as soon as the root is mounted (or the window elapses). This
// is mount-timing only — not a persistent observer.
const mountLearningHomeWithRetry = makeBoundedRetry(
  () => {
    mountLearningHome();
    // Mounted -> stop early; S6 off -> nothing to mount, also stop.
    return (
      togglesCache.replaceHome === false ||
      !!document.getElementById(LEARNING_ROOT_ID)
    );
  },
  150,
  3000
);

window.addEventListener("yt-rework:locationchange", mountLearningHome);
window.addEventListener("popstate", mountLearningHome);
window.addEventListener("yt-navigate-finish", mountLearningHome);

// --- Subscriptions decorator -------------------------------------------------
// The two-line card LAYOUT (channel name above, title below) is PURE CSS
// (section 6), keyed directly on YouTube's own classes — no JS reshaping, so it
// can't silently break when a JS selector drifts. This decorator only does the
// things CSS can't: (1) stamp each row's video id (data-ytr-vid) so CSS dims
// videos you've opened / hides archived ones, (2) stamp the channel key + inject
// the star control AND (Step 15) our own overflow control onto the byline line,
// and (3) mount the injected Subscriptions header ("Subscriptions" title +
// VIP toggle — no unread count; read-dimming is the only state signal). The
// video-id stamp is one-shot (MAILROW_FLAG); the
// channel/star/overflow work is retried every tick until the late-hydrating
// byline exists, then left alone.
const MAILROW_FLAG = "data-ytr-mailrow";

function subsBrowse() {
  return document.querySelector('ytd-browse[page-subtype="subscriptions"]');
}

// Returns true when the page is "settled" — nothing changed this tick AND no
// work is still pending (every visible row has its chan stamped + byline
// controls, the header is mounted). The bounded retry uses that to stop early
// (#5) without ever skipping a late-hydrating byline / channel link.
function decorateSubscriptions() {
  if (!reworkEnabled) return true; // master off -> nothing to do (settled)
  const browse = subsBrowse();
  if (!browse) return true; // off-page; the retry handles teardown

  let changed = false;
  let pending = false;
  const rows = browse.querySelectorAll(
    "ytd-rich-item-renderer, yt-lockup-view-model"
  );
  if (rows.length === 0) pending = true; // feed not hydrated yet
  rows.forEach((row) => {
    // Video id (for read dimming / archive hiding) — stamp once.
    if (!row.getAttribute(MAILROW_FLAG)) {
      const vid = subsRowVideoId(row);
      if (vid) row.setAttribute("data-ytr-vid", vid);
      row.setAttribute(MAILROW_FLAG, "1");
      changed = true;
    }
    // Channel key — retried each tick until the channel link hydrates.
    if (!row.getAttribute("data-ytr-chan")) {
      const chan = subsRowChannelKey(row);
      if (chan) {
        row.setAttribute("data-ytr-chan", chan);
        changed = true;
      } else {
        pending = true; // link not hydrated yet -> retry next tick
      }
    }
    // Star + overflow controls — injected onto the byline once it exists.
    const byline = subsRowByline(row);
    if (!byline) {
      pending = true; // byline hydrates late -> controls still to inject
    } else {
      if (!byline.querySelector(".ytr-stars")) {
        byline.appendChild(buildStarControl());
        changed = true;
      }
      if (!byline.querySelector(".ytr-ovf")) {
        byline.appendChild(buildOverflowControl());
        changed = true;
      }
    }
  });

  // Delegated click listener, attached once (capture phase: beat YouTube's row
  // navigation so rating / saving / archiving never opens the video).
  if (!browse.dataset.ytrSubsWired) {
    browse.addEventListener("click", onSubsClick, true);
    browse.dataset.ytrSubsWired = "1";
  }

  if (!document.getElementById(SUBS_HEADER_ID)) {
    mountSubsHeader(browse); // "Subscriptions" title + VIP toggle
    if (document.getElementById(SUBS_HEADER_ID)) changed = true;
    else pending = true; // mount target not hydrated yet -> retry
  }
  refreshSubsReadState(browse); // re-apply read dimming to all stamped rows
  refreshSubsStars(browse); // fill the star glyphs from the live ratings cache
  refreshSubsArchived(browse); // hide archived rows
  return !changed && !pending;
}

// Subscriptions hydrates late and lazy-loads more rows on scroll. Run a bounded
// retry on mount/nav (mount-timing only, not a persistent observer); the flag
// makes re-runs cheap no-ops on already-stamped rows.
const decorateSubscriptionsWithRetry = makeBoundedRetry(
  () => {
    // Session S: YouTube keeps the previous ytd-browse in the document (hidden)
    // while /results is showing, so this pass could still walk hundreds of rows
    // there. On search we do nothing at all — the next navigation re-fires it.
    if (onSearchRoute()) return true;
    if (!subsBrowse()) {
      // Left Subscriptions (or never on it): tear down injected inbox chrome so
      // the header / VIP filter / open menu can't leak to the new page.
      if (document.getElementById(SUBS_HEADER_ID) || vipFilterOn) {
        removeSubsHeader();
        setVipFilter(false);
        closeOverflowMenus();
      }
      return true; // nothing more to do
    }
    // "idle" when settled so the retry can stop ~900ms after the DOM stabilizes
    // instead of ticking the full window; false while rows still hydrate.
    return decorateSubscriptions() ? "idle" : false;
  },
  300,
  4000,
  3
);

window.addEventListener(
  "yt-rework:locationchange",
  decorateSubscriptionsWithRetry
);
window.addEventListener("popstate", decorateSubscriptionsWithRetry);
window.addEventListener("yt-navigate-finish", decorateSubscriptionsWithRetry);

// --- Step 16: Find — search is YouTube's own ---------------------------------
// Session O (v1.2.1): LearnTube no longer touches /results. The entire search
// decorate pass is GONE — the Lectures lens + its injected toolbar, the
// duration/short-clip stamping, the per-row wiring, the search MutationObserver
// and every §14 restyle. Search stayed slow under it and native search is the
// product decision: /results renders YouTube's own cards, at YouTube's own speed.
//
// Session S finishes the job: the last touchpoints are gone too. LearnTube now
// makes ZERO DOM mutations on /results — no block stamp, no Shorts-section
// stamp, no searchRoot(), and no injected row inside YouTube's own ⋮ menu — and
// its doc-wide CSS is gated off by the route stamp (data-ytr-route="search").
// Accepted, by decree: blocked channels and Shorts shelves appear in search
// results, and the ⋮ menu there offers no Block.

// --- K3: re-decorate rows YouTube appends on scroll --------------------------
// decorateHome runs only on nav-bounded retries that settle ~1s after the feed
// stabilizes, so rows YouTube appends as you scroll (the home rich-grid) would
// never be decorated — and a continuation row from a BLOCKED channel must get
// its data-ytr-blocked stamp or it renders in full. A debounced
// MutationObserver on the surface's
// stable root re-runs the (idempotent) sync decorator whenever the subtree
// changes. Guard against our own stamps re-triggering it by disconnecting
// for the duration of the decorate pass. shouldObserve() re-checks the surface
// is still active before re-attaching, so master-off / leaving the surface stop
// it cleanly. The decorate fn is the plain sync decorator (never the retry).
function makeDecorateObserver(getContainer, decorate, shouldObserve) {
  let observer = null;
  let timer = null;
  const observeNow = () => {
    const c = getContainer();
    if (observer && c && shouldObserve())
      observer.observe(c, { childList: true, subtree: true });
  };
  const run = () => {
    timer = null;
    if (observer) observer.disconnect(); // don't observe our own writes
    decorate(); // sync + idempotent
    observeNow(); // resume only if the surface is still active
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(run, 150); // ~150ms debounce (coalesce bursts)
  };
  return {
    connect() {
      if (!observer) observer = new MutationObserver(schedule);
      observeNow();
    },
    disconnect() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (observer) observer.disconnect();
    },
  };
}

// Session O: home is the ONLY surface with a decorate observer. Search
// deliberately has none — see the Step 16 note above.
const homeDecorateObserver = makeDecorateObserver(
  homeBrowse,
  decorateHome,
  () =>
    reworkEnabled &&
    !!homeBrowse() &&
    (peekOn || togglesCache.replaceHome === false)
);

// Parse a duration label ("12:34", "1:02:03", "0:48") to integer seconds.
// Returns null for empty / non-numeric (live, upcoming, mixes, playlists, or a
// non-time badge) — a null duration is simply never stored on the scraped
// lecture record, so a row with an unreadable badge just has no duration.
function parseDurationToSeconds(text) {
  const s = (text || "").trim();
  if (!s || !/^\d{1,2}(:\d{2}){1,2}$/.test(s)) return null;
  const parts = s.split(":").map((n) => parseInt(n, 10));
  if (parts.some((n) => Number.isNaN(n))) return null;
  let secs = 0;
  for (const p of parts) secs = secs * 60 + p;
  return secs;
}

// --- Phase 2: Peek — the algorithm on request (display-only) ------------------
// A session-only reveal on the Library header. setPeek flips data-ytr-peek on
// <html> (the setVipFilter recipe): CSS §9 stops hiding the home grid while the
// attribute is present, so the native feed shows BELOW the Library. Two views —
// Grid (native thumbnails, untouched) and List (§6's two-line Subscriptions
// restyle re-scoped to the home rows) — flipped by data-ytr-peek-view, which is
// remembered in settings.peekView. Peek is session-only: leaving the Library
// (removeLearningHome) / master-off / S6-off all reset it. NEVER reorders the
// feed and never signals the algorithm — pure CSS reveal + display-only decorate.
function setPeek(on) {
  peekOn = !!on && reworkEnabled;
  document.documentElement.toggleAttribute("data-ytr-peek", peekOn);
  // (Session L: nothing to purge on peek-off any more — the ··· overflow chip
  // the home rows used to carry is gone; Block rides YouTube's own ⋮ menu, so
  // Peek adds no injected per-row control at all.)
  const pill = document.getElementById("ytr-peek-pill");
  if (pill) pill.setAttribute("aria-pressed", peekOn ? "true" : "false");
}

// Persist the remembered Peek view (read-modify-write settings.peekView, never
// clobbering masterEnabled / topics / stars / toggles / blockedCreators).
function mutatePeekView(view) {
  chrome.storage.sync.get({ [SETTINGS_KEY]: DEFAULT_SETTINGS }, (res) => {
    const settings = Object.assign({}, DEFAULT_SETTINGS, res[SETTINGS_KEY]);
    settings.peekView = view === "list" ? "list" : "grid";
    chrome.storage.sync.set({ [SETTINGS_KEY]: settings }, () => {
      if (chrome.runtime.lastError) {
        console.warn("[yt-rework] peekView write failed:", chrome.runtime.lastError);
      }
    });
  });
}

function setPeekView(view) {
  peekView = view === "list" ? "list" : "grid";
  document.documentElement.setAttribute("data-ytr-peek-view", peekView);
  mutatePeekView(peekView); // remembered for next time (onChanged re-fills mirrors)
  // Switching view re-runs the decorate pass (List needs the read-dimming stamps;
  // Grid leaves the native cards untouched).
  if (peekOn) decorateHomeWithRetry();
}

// --- The home decorate pass (Peek reveal + Block stamps) ---------------------
// Runs whenever the native home feed is visible: while peeking (S6 on) OR when
// S6 is off (fully native Home). Two jobs the CSS can't do:
//  (1) Block (B2): stamp data-ytr-blocked on every row whose channel is blocked
//      — so blocked creators leave the feed everywhere it renders (native + both
//      Peek views). Runs in BOTH modes.
//  (2) Peek: stamp the row's video id in BOTH views; the read-dimming it feeds
//      is applied List-only (grid stays native).
// Reuses the Subscriptions helpers (subsRowVideoId / subsRowChannelKey) — Home
// and Subscriptions are the same row elements. Session L: no ··· chip is
// injected here any more (Block rides YouTube's own ⋮ menu), so the native
// per-row menu is left exactly as YouTube shipped it.
// Display-only; never reorders. Returns true when settled.
function decorateHome() {
  if (!reworkEnabled) return true; // master off -> plain YouTube (settled)
  const browse = homeBrowse();
  if (!browse) return true; // off-page; the retry handles teardown
  const nativeFeed = togglesCache.replaceHome === false;
  const listView = peekOn && peekView === "list";
  if (!peekOn && !nativeFeed) return true; // Library shown, feed hidden -> nothing

  let changed = false;
  let pending = false;
  const rows = browse.querySelectorAll("ytd-rich-item-renderer");
  if (rows.length === 0) pending = true; // feed not hydrated yet
  rows.forEach((row) => {
    // Channel key — needed for the block stamp; retried until the link hydrates.
    let ck = row.getAttribute("data-ytr-chan");
    if (!ck) {
      ck = subsRowChannelKey(row);
      if (ck) {
        row.setAttribute("data-ytr-chan", ck);
        changed = true;
      } else {
        pending = true;
      }
    }
    // (1) Block stamp — both modes. Only count a real transition as "changed"
    // so a page full of stable rows can settle (toggleAttribute's return value
    // is "present after", which would read as changed every tick).
    const shouldBlock = !!(ck && blockedCache[ck]);
    if (shouldBlock !== row.hasAttribute("data-ytr-blocked")) {
      row.toggleAttribute("data-ytr-blocked", shouldBlock);
      changed = true;
    }
    // (2) Peek extras — the video id is stamped in BOTH views; read-dimming
    // stays List-only so Grid thumbnails/layout stay native (the §16·12 dim rule
    // is List-scoped anyway).
    if (peekOn) {
      if (!row.getAttribute("data-ytr-vid")) {
        const vid = subsRowVideoId(row);
        if (vid) {
          row.setAttribute("data-ytr-vid", vid);
          changed = true;
        }
      }
      if (listView) applyReadState(row, row.getAttribute("data-ytr-vid"));
    }
  });

  return !changed && !pending;
}

const decorateHomeWithRetry = makeBoundedRetry(
  () => {
    // Session S: same as the Subscriptions pass — the hidden home browse
    // survives a navigation to /results, and nothing of ours may run there.
    if (onSearchRoute()) {
      homeDecorateObserver.disconnect();
      return true;
    }
    if (!homeBrowse()) {
      homeDecorateObserver.disconnect(); // K3: off home -> stop watching
      return true; // removeLearningHome resets Peek
    }
    const done = decorateHome();
    // K3: watch for late feed rows ONLY while the feed is actually decorated —
    // peeking OR the S6-off native feed. When the Library is shown (feed hidden)
    // or master is off, shed the observer.
    if (reworkEnabled && (peekOn || togglesCache.replaceHome === false))
      homeDecorateObserver.connect();
    else homeDecorateObserver.disconnect();
    return done ? "idle" : false;
  },
  300,
  4000,
  3
);

window.addEventListener("yt-rework:locationchange", decorateHomeWithRetry);
window.addEventListener("popstate", decorateHomeWithRetry);
window.addEventListener("yt-navigate-finish", decorateHomeWithRetry);

// --- Phase 3: Block — silence a channel everywhere recommendations render -----
// The blocklist is synced (small, bounded, user-authored — wanted on every
// device) inside settings.blockedCreators ({ "<channelKey>": ts }). mutateBlocked
// is the read-modify-write twin of mutateStars (never clobbers masterEnabled /
// topics / stars / toggles / peekView). A blocked channel's videos are hidden by
// CSS on search + both Peek views + the native home feed (S6 off) — display-only,
// no reorder. Subscriptions is deliberately untouched (you chose those).
function mutateBlocked(fn) {
  chrome.storage.sync.get({ [SETTINGS_KEY]: DEFAULT_SETTINGS }, (res) => {
    const settings = Object.assign({}, DEFAULT_SETTINGS, res[SETTINGS_KEY]);
    settings.blockedCreators =
      settings.blockedCreators && typeof settings.blockedCreators === "object"
        ? Object.assign({}, settings.blockedCreators)
        : {};
    fn(settings.blockedCreators);
    chrome.storage.sync.set({ [SETTINGS_KEY]: settings }, () => {
      if (chrome.runtime.lastError) {
        console.warn("[yt-rework] blocked write failed:", chrome.runtime.lastError);
      }
    });
  });
}

function blockCreator(key) {
  if (!key || blockedCache[key]) return;
  blockedCache[key] = Date.now(); // optimistic mirror
  mutateBlocked((b) => {
    if (!b[key]) b[key] = Date.now();
  });
  // Hide the rows present now, then re-hide across the reflow window: a
  // single-channel search RE-FETCHES and replaces its result rows ~1-2s after a
  // result is removed (blocking the channel result triggers it), so the fresh
  // rows return unstamped and a one-shot restamp misses them (verified live).
  // onChanged covers other tabs.
  reapplyBlockedSweep();
}

// (Unblock has no content.js entry point: the popup's ✕ does its own
// read-modify-write on settings.blockedCreators via writeSettings, and every
// YouTube tab's blockedChanged onChanged diff -> restampBlocked() reflects it
// live. Kept as one path, not two, so there's no orphaned helper to drift.)

// Re-stamp data-ytr-blocked wherever recommendations render (home rows, the
// watch sidebar, grid shelves) from the live blockedCache. Called after a
// block/unblock and from the blockedChanged onChanged diff — CSS hides the
// stamped rows.
// Session S: /results is NOT one of those surfaces any more. This pass was the
// last thing LearnTube ran on search — a document-wide querySelectorAll plus a
// channel-key resolve per row, twelve times per navigation, over a result list
// that streams in. It now early-returns there: zero queries, zero mutations,
// zero stamps on search. (Rows stamped BEFORE navigating into search keep their
// attribute; §17 is gated off by the route stamp, so it is inert — un-stamping
// them would itself be the mutation pass we are removing.)
// Never a Block row, never a block stamp — whatever tag the row is rendered as.
// v1.1 spelled the playlist rule as "one tag we omit" (ytd-playlist-video-
// renderer). Current builds render PLAYLIST rows as yt-lockup-view-model too
// (confirmed live 2026-08-16 — the menu inspected there WAS a playlist row's),
// the very same tag search and home use, so a tag-level exclusion no longer
// holds the line. The rule is a CONTEXT now: inside a playlist listing or the
// watch-page queue, a row is somebody's course material and is left alone.
const BLOCK_CONTEXT_EXCLUDE_SELECTOR = [
  "ytd-playlist-video-renderer",
  "ytd-playlist-video-list-renderer",
  "yt-playlist-video-list-view-model",
  "ytd-playlist-panel-renderer", // the watch-page queue
  'ytd-browse[page-subtype="playlist"]',
].join(",");

function restampBlocked() {
  if (onSearchRoute()) return; // the decree: search is native, we touch nothing
  // Gate the stamp on the master switch: with the rework off a stray sweep tick
  // (or a cross-tab onChanged) must CLEAR data-ytr-blocked, never re-add it —
  // master-off is plain YouTube, no leftover data-ytr-* attribute.
  const on = reworkEnabled;
  const hb = homeBrowse();
  if (hb) {
    hb.querySelectorAll("ytd-rich-item-renderer").forEach((row) => {
      // Session P: blockRowChannelKey, the SAME resolver the injected Block row
      // is built from — offer and hide must never disagree about a row's key.
      const ck = row.getAttribute("data-ytr-chan") || blockRowChannelKey(row);
      row.toggleAttribute("data-ytr-blocked", on && !!(ck && blockedCache[ck]));
    });
  }
  // Session L: Block is now offered from YouTube's OWN ⋮, which also rides the
  // watch-page related sidebar (ytd-compact-video-renderer) and the grid shelves
  // (ytd-grid-video-renderer). "Offered" has to mean "takes visible effect", so
  // stamp those too — document-wide, because they render outside ytd-search and
  // outside the home browse. Display-only (§17 hides), never reorders.
  // ytd-playlist-video-renderer is deliberately NOT here: a playlist is often
  // the user's own course, and blocking must never hide their own lectures.
  // Skip rows inside Subscriptions (you chose those — §17's promise) and inside
  // a channel's own page (navigating there is deliberate; emptying it helps
  // nobody) — current builds render neither surface with these tags, but the
  // stamp must not depend on that staying true.
  // Session P: yt-lockup-view-model joins them. BLOCK_ROW_SELECTOR offers Block
  // on a lockup ANYWHERE (search, home, watch sidebar, shelves), but the stamp
  // used to reach lockups only under ytd-search — so on every other surface the
  // menu promised something that visibly did nothing. Same closest() exclusions,
  // and the same blockRowChannelKey resolver the offer itself uses.
  document
    .querySelectorAll(
      "ytd-compact-video-renderer, ytd-grid-video-renderer, yt-lockup-view-model"
    )
    .forEach((row) => {
      // Excluded contexts don't just skip — they UN-stamp. §17 hides wherever
      // the attr lands, and YouTube may recycle a stamped node into a playlist
      // or subs subtree across SPA navs; clearing here makes "a block never
      // hides your own lectures" hold by construction, not by trust.
      if (
        row.closest('ytd-browse[page-subtype="subscriptions"], ytd-browse[page-subtype="channels"]') ||
        row.closest(BLOCK_CONTEXT_EXCLUDE_SELECTOR)
      ) {
        row.removeAttribute("data-ytr-blocked");
        return;
      }
      const ck = row.getAttribute("data-ytr-chan") || blockRowChannelKey(row);
      row.toggleAttribute("data-ytr-blocked", on && !!(ck && blockedCache[ck]));
    });
}

// Re-stamp NOW and again on a fixed cadence for ~3s. A single-channel search
// re-fetches and REPLACES its result rows ~1-2s after a result is removed
// (verified live), so the fresh rows return unstamped; a plain restamp misses
// them. The cadence outlasts that reflow regardless of its exact timing (it
// does NOT settle early like the decorate retries). Cheap + idempotent;
// display-only, never reorders. Runs off-page as harmless no-ops.
//
// Session S: it never runs on /results at all (see the guard below) — search is
// native. Ceiling on the surfaces it DOES cover: a blocked channel's rows that
// YouTube appends as a scroll CONTINUATION more than ~5s after the navigation
// are not stamped until the next navigation. Accepted: the first screenful
// (which is what anyone actually sees) is covered.
let blockedSweepTimer = null;
function reapplyBlockedSweep() {
  // Session S: on /results the sweep does not even start its interval — a
  // 400ms×12 cadence over a streaming result list was the "the page loads a
  // lot" cost. Any cadence already running is stopped on the way in.
  if (onSearchRoute()) {
    if (blockedSweepTimer) {
      clearInterval(blockedSweepTimer);
      blockedSweepTimer = null;
    }
    return;
  }
  restampBlocked();
  if (blockedSweepTimer) clearInterval(blockedSweepTimer);
  let ticks = 0;
  blockedSweepTimer = setInterval(() => {
    restampBlocked();
    if (++ticks >= 12) {
      // ~4.8s at 400ms — outlasts the reflow AND the initial lazy-load settle
      clearInterval(blockedSweepTimer);
      blockedSweepTimer = null;
    }
  }, 400);
}

// Session L: the watch sidebar / grid shelves have no decorate pass of their own
// (they carry no LearnTube chrome — only the block stamp), so run the sweep on
// every navigation. Its ~4.8s cadence also covers those rows hydrating late.
window.addEventListener("yt-rework:locationchange", reapplyBlockedSweep);
window.addEventListener("popstate", reapplyBlockedSweep);
window.addEventListener("yt-navigate-finish", reapplyBlockedSweep);

// --- Session L: Block from YouTube's OWN ⋮ menu -------------------------------
// v1.1 hid YouTube's native per-row 3-dot menu on search (§14f) and Peek
// (§16·11) and floated our own "···" chip in its place. On the native cards that
// chip read as a stray dark pill, and it cost people the menu they already knew.
// Session L reverses the trade: the native ⋮ is BACK everywhere it was hidden
// (both CSS gates are gone, along with the chip on those surfaces) and Block is
// injected as ONE extra row INSIDE YouTube's own dropdown — separator, then
// "🚫 Block this channel", styled from YouTube's own --yt-spec-* tokens so it
// reads as a native row in dark and light.
//
// Three small parts, each fail-quiet — the native menu must NEVER break because
// of us, so every step feature-detects and does nothing when the DOM has drifted:
//   (1) rememberMenuTrigger — a capture-phase document click listener that
//       remembers the last VIDEO ROW whose *button* was clicked. A ⋮ trigger is
//       a <button> / yt-icon-button / button-view-model and is never inside an
//       <a href>, so "a button click inside a row, not on a link" is a
//       drift-proof stand-in for "this row's menu is about to open". EVERY click
//       either sets the record or clears it, so a masthead / avatar / sidebar
//       menu opened next can never inherit a stale row.
//   (2) A debounced MutationObserver on ytd-popup-container (YouTube renders the
//       ONE shared menu popup there and re-uses it for every row) that notices
//       the dropdown open / re-render and runs the injection.
//   (3) injectNativeBlockItem — idempotent: it re-uses an already-injected row
//       (just re-pointing it at the new channel) instead of stacking duplicates
//       when the shared popup re-opens.
// Clicking the row calls blockCreator() — the SAME synced settings.blockedCreators
// path the v1.1 chip used, so the popup's Blocked list and its ✕ unblock are
// untouched.
//
// Session S narrows the contract by one route: NOT on /results. Both (1) and (3)
// early-return there, so on search YouTube's ⋮ menu is byte-for-byte its own —
// the decree again, and the last DOM write LearnTube had left on that page.
// Blocking from anywhere else still works exactly as before.

// Session P: the pipeline above was written against ONE menu generation — the
// Polymer `tp-yt-iron-dropdown > ytd-menu-popup-renderer` dropdown. Current
// YouTube builds render a video row's ⋮ as the Wiz sheet instead
// (`yt-sheet-view-model` / `yt-contextual-sheet-layout` > `yt-list-view-model` >
// `yt-list-item-view-model`), still parented in ytd-popup-container. On that
// generation openNativeMenu() found no iron-dropdown, returned null, and the
// injection bailed on its FIRST line — silently, every time. Both generations
// are now supported end to end (detect / inject / style / close).
//
// Every bail is still fail-quiet for the USER, but no longer invisible to us:
// blockDebug() logs one console.debug line per bail so a live test says exactly
// where it stopped. It de-dupes consecutive identical reasons — the observer
// re-runs the injection on every popup mutation, and an undeduped "no open
// menu" would bury the console.
//
// DELIBERATELY UNGATED and at console.debug level: this trail is the owner's
// explicit ask after a silent bail cost them a release, and Chrome hides the
// debug level unless you turn Verbose on — so it is invisible to a normal user
// and one filter-click away for us. `localStorage.ytrDebug = "1"` promotes the
// same lines to console.log for a session where Verbose is inconvenient.
let lastBlockDebug = "";
function blockDebug(reason) {
  if (reason === lastBlockDebug) return;
  lastBlockDebug = reason;
  try {
    let loud = false;
    try {
      loud = localStorage.getItem("ytrDebug") === "1";
    } catch (_) {
      // storage blocked (some embeds) -> stay on the quiet path
    }
    (loud ? console.log : console.debug)("[LearnTube] block-menu:", reason);
  } catch (_) {
    // a console-less context must never break the menu
  }
}

const NATIVE_BLOCK_ITEM_CLASS = "ytr-native-block";
const NATIVE_BLOCK_SEP_CLASS = "ytr-native-block-sep";
const NATIVE_BLOCK_WIZ_CLASS = "ytr-native-block--wiz";

// Every element YouTube uses as a "video row" across the surfaces that ship a
// per-row ⋮ (search results, home/subscriptions lockups + rich items, watch-page
// related, grids, playlists, channel results). closest() picks the innermost, so
// a lockup nested in a rich item resolves to the lockup — both carry the same
// channel link, so either resolves the same key.
const BLOCK_ROW_SELECTOR = [
  "ytd-video-renderer",
  "ytd-rich-item-renderer",
  "yt-lockup-view-model",
  "ytd-compact-video-renderer",
  "ytd-grid-video-renderer",
  "ytd-channel-renderer",
].join(",");
// DELIBERATELY ABSENT: ytd-playlist-video-renderer. A playlist is very often the
// user's OWN course (the Library is built from playlists), so offering "block
// this channel" on a lecture row invites hiding your own material. No Block row
// inside playlist rows, and §17 never stamps/hides them either.
// Session P: that tag-level exclusion is no longer enough — see
// BLOCK_CONTEXT_EXCLUDE_SELECTOR above, which enforces the playlist rule by
// CONTEXT now that playlist rows render as lockups too.

// Anything YouTube renders a ⋮ trigger as, across builds.
const BLOCK_TRIGGER_SELECTOR =
  'button, yt-icon-button, button-view-model, ytd-menu-renderer, tp-yt-paper-icon-button, [role="button"]';

// …except the Subscribe / bell button on a channel result, which opens the
// NOTIFICATION-PREFERENCES menu (All / Personalized / None / Unsubscribe) out of
// the same shared popup. That is not the designed placement, so a click on it
// counts as "not a ⋮ trigger" and clears the record.
const BLOCK_TRIGGER_EXCLUDE_SELECTOR =
  "ytd-subscribe-button-renderer, yt-subscribe-button-view-model, subscribe-button-view-model, #subscribe-button, ytd-subscription-notification-toggle-button-renderer, ytd-subscription-notification-toggle-button-renderer-next";

// The row whose ⋮ was clicked last, and when. The age window keeps a record from
// outliving its menu; document.contains() keeps it from outliving its DOM node.
let lastMenuRow = null;
let lastMenuAt = 0;
const MENU_TRIGGER_MAX_AGE_MS = 4000;

// The channel key for a row about to get a Block offer. subsRowChannelKey covers
// every row that links its channel with a root-relative href — which is most of
// them, both generations. Session P adds ONE fallback for the lockup rows search
// and home now ship: scan every anchor in the row through normalizeChannelKey
// (which resolves ABSOLUTE hrefs too, via new URL()), and take the first that
// yields a key. /watch, /playlist and /shorts links all normalize to null, so
// the fallback can only ever return a real channel.
// Injection and the click-time re-verify MUST use this same function, or the
// fail-closed comparison in onNativeBlockActivate would reject its own key.
//
// The fallback is scoped to the row's BYLINE / metadata area, never the whole
// row: a search result's description snippet can contain a channel mention that
// links to somebody ELSE, and blocking the channel a video merely talks about
// would be a wrong-channel block — the exact failure the fail-closed re-verify
// exists to prevent. Scoped out, it can't happen in the first place.
const BLOCK_META_SCOPE_SELECTOR = [
  ".yt-lockup-metadata-view-model__metadata",
  ".ytLockupMetadataViewModelMetadata",
  ".yt-content-metadata-view-model-wiz",
  "#channel-info",
  "#byline-container",
  "ytd-channel-name",
  "#avatar-link",
  ".yt-lockup-view-model__content-image",
].join(",");

function blockRowChannelKey(row) {
  if (!row) return null;
  // Byline/metadata FIRST — it is the row's own channel by construction, and it
  // resolves absolute hrefs (via normalizeChannelKey's new URL()) that
  // subsRowChannelKey's ^="/@" prefix selectors would miss on a lockup.
  const scopes = row.querySelectorAll(BLOCK_META_SCOPE_SELECTOR);
  for (let i = 0; i < scopes.length; i++) {
    const anchors = scopes[i].querySelectorAll("a[href]");
    for (let j = 0; j < anchors.length; j++) {
      const ck = normalizeChannelKey(anchors[j].getAttribute("href"));
      if (ck) return ck; // /watch, /playlist, /shorts all normalize to null
    }
  }
  // ponytail: only if the row ships none of those containers do we fall back to
  // the row-wide scan — which CAN, on a build we haven't seen, pick a channel
  // mentioned in a description snippet. The fail-closed re-verify in
  // onNativeBlockActivate still guarantees the row blocks what its label was
  // built from; it just can't guarantee the byline is what it read.
  return subsRowChannelKey(row);
}

function rememberMenuTrigger(e) {
  // Session S: on /results we arm nothing. Blocking from search is now a dead
  // affordance (restampBlocked early-returns and §17 is gated off by the route
  // stamp), so a Block row there would promise something it cannot deliver —
  // and this listener plus the injection were the LAST LearnTube DOM writes on
  // search. Clearing the record here also means a menu opened on /results can
  // never inherit a row armed before the navigation. removeNativeBlockItem()
  // also evicts a stale row left in the SHARED dropdown by a menu dismissed
  // without a click (e.g. Escape) before navigating here — removing our OWN
  // node is the accepted cleanup exception on /results.
  if (onSearchRoute()) {
    removeNativeBlockItem();
    lastMenuRow = null;
    lastMenuAt = 0;
    return;
  }
  const t = e.target;
  if (!t || !t.closest) return;
  // Our OWN injected row lives in the popup, not in a video row — leaving early
  // matters: this listener is capture-phase, so the removeNativeBlockItem below
  // would delete the item before its own (bubble-phase) handler ever ran.
  if (t.closest("." + NATIVE_BLOCK_ITEM_CLASS)) return;
  // Belt (1) against a wrong-channel window: the shared popup keeps showing the
  // PREVIOUS row's menu (with our row still pointing at the previous channel)
  // until the debounced re-inject catches up. Strip it synchronously on every
  // click, so the worst case is a menu with no Block row for ~30ms — never a
  // Block row aimed at the wrong channel.
  removeNativeBlockItem();
  const row = t.closest(BLOCK_ROW_SELECTOR);
  const isTrigger =
    !!row &&
    !row.closest(BLOCK_CONTEXT_EXCLUDE_SELECTOR) && // never a playlist/queue row
    !t.closest("a[href]") &&
    !t.closest(BLOCK_TRIGGER_EXCLUDE_SELECTOR) &&
    !!t.closest(BLOCK_TRIGGER_SELECTOR);
  // Set OR clear on every click: a click that isn't a row's menu trigger must
  // invalidate the previous one, or the next popup (avatar, masthead, a chip's
  // menu) would resolve to a channel it has nothing to do with.
  lastMenuRow = isTrigger ? row : null;
  lastMenuAt = isTrigger ? Date.now() : 0;
  if (row) {
    lastBlockDebug = ""; // a new attempt starts a fresh de-dupe window
    blockDebug(
      isTrigger
        ? "armed row <" +
            row.tagName.toLowerCase() +
            "> chan=" +
            (blockRowChannelKey(row) || "none")
        : "click inside <" +
            row.tagName.toLowerCase() +
            "> was not a menu trigger (link / excluded / no button)"
    );
    // Session P belt: three direct passes after a trigger click. The observer
    // normally beats them to it (both generations mount inside the container it
    // watches), but a mutation burst that lands entirely inside its 30ms debounce
    // window, or a menu that hydrates its items a beat after the sheet, would
    // otherwise leave the row out. Idempotent (same guarded injection), bounded.
    if (isTrigger) [60, 200, 500].forEach((ms) => setTimeout(tryInjectNativeBlockItem, ms));
  }
}
document.addEventListener("click", rememberMenuTrigger, true);

function popupContainer() {
  return document.querySelector("ytd-popup-container");
}

// Is this dropdown actually open? Prefer Polymer's own `opened` property — the
// authority, and it never reads true for a dropdown that is closing or was never
// opened. Only where the property is missing (a build that drifted) do we fall
// back to sniffing the attributes/style YouTube happens to set.
function isDropdownOpen(d) {
  if (typeof d.opened === "boolean") return d.opened;
  if (d.getAttribute("aria-hidden") === "true") return false;
  if (d.style && d.style.display === "none") return false;
  return true;
}

// Second opinion on "open", independent of any Polymer property: real geometry
// plus computed style. A dropdown that is detached, collapsed or faded out fails
// this even if its `opened` flag lags — the one signal that can't drift with a
// rename.
function isElementVisible(el) {
  if (!el || !el.getBoundingClientRect) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return false;
  const cs = getComputedStyle(el);
  return (
    cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0"
  );
}

// Menus we must never touch, in BOTH generations: the bell / Subscribed
// notification-preferences menu rides the same shared popup but isn't a row's ⋮.
// (Its Wiz form has no stable tag of its own, so the trigger-side exclusion —
// a Subscribe/bell click clears lastMenuRow — plus the "no resolvable channel"
// bail are what actually cover it there. Both are load-bearing; see §L belts.)
const NATIVE_MENU_EXCLUDE_SELECTOR =
  "ytd-notification-preference-toggle-renderer, ytd-subscription-notification-toggle-button-renderer, yt-notification-preference-sheet-view-model";

// The currently OPEN shared menu popup as { drop, list, gen }, or null.
//
// ONE container path, two menu bodies. Live DOM inspection (2026-08-16 build,
// logged-in profile) settled the question the first Session-P pass guessed at:
// the Wiz sheet is HYBRID — it still rides a classic tp-yt-iron-dropdown inside
// ytd-popup-container:
//   ytd-popup-container > tp-yt-iron-dropdown > div
//     > yt-sheet-view-model.ytSheetViewModelContextual
//       > yt-contextual-sheet-layout > div.ytContextualSheetLayoutContentContainer
//         > yt-list-view-model > yt-list-item-view-model ×5
// So the dropdown (with Polymer `opened` / `close()`) stays the single unit of
// "is a menu open", and only the BODY is feature-detected:
//   gen "legacy" — ytd-menu-popup-renderer > #items
//   gen "wiz"    — yt-contextual-sheet-layout > yt-list-view-model with
//                  yt-list-item-view-model children. The contextual-sheet-layout
//                  marker is load-bearing: the Save-to-playlist / Share DIALOGS
//                  also render yt-list-view-model inside a sheet, and requiring
//                  the CONTEXTUAL layout is what keeps our row out of them.
// The list we append to is the ITEMS' OWN PARENT, not yt-list-view-model itself:
// the Wiz list wraps its rows in an inner container, and appending a sibling of
// that container would land our row outside the menu's own layout.
function openNativeMenu() {
  const pc = popupContainer();
  if (!pc) return null;
  const drops = pc.querySelectorAll("tp-yt-iron-dropdown");
  for (let i = 0; i < drops.length; i++) {
    const d = drops[i];
    // Two independent discriminators, because one dropdown can be open while
    // another sits collapsed: Polymer's own `opened`, then real geometry.
    if (!isDropdownOpen(d)) continue;
    if (!isElementVisible(d)) continue;
    if (d.querySelector(NATIVE_MENU_EXCLUDE_SELECTOR)) continue;
    const menu = d.querySelector("ytd-menu-popup-renderer");
    if (menu) {
      const list =
        menu.querySelector("#items") || menu.querySelector("tp-yt-paper-listbox");
      if (list) return { drop: d, list: list, gen: "legacy" };
    }
    const sheet = d.querySelector("yt-contextual-sheet-layout");
    if (sheet) {
      const items = sheet.querySelectorAll("yt-list-item-view-model");
      const list = items.length ? items[items.length - 1].parentElement : null;
      if (list) return { drop: d, list: list, gen: "wiz" };
    }
  }
  return null;
}

// The dropdown our row currently lives in (null when we have no row injected).
// Identity, not a timer, is what keeps a live row alive: see injectNativeBlockItem.
let nativeBlockDrop = null;

// Drop our row (and its separator) from wherever it currently sits.
function removeNativeBlockItem() {
  document
    .querySelectorAll("." + NATIVE_BLOCK_ITEM_CLASS + ", ." + NATIVE_BLOCK_SEP_CLASS)
    .forEach((n) => n.remove());
  nativeBlockDrop = null;
}

// Close the shared dropdown the way Polymer does. If this build doesn't expose
// close() on an OPEN dropdown, fall back ONCE to an Escape keydown (YouTube's
// overlay manager listens for it) rather than leaving the menu hanging open.
function closeNativeMenu() {
  const pc = popupContainer();
  if (!pc) return;
  let closed = false;
  pc.querySelectorAll("tp-yt-iron-dropdown").forEach((d) => {
    // Only an OPEN dropdown counts: closing an already-closed one used to set
    // the latch and made the Escape belt unreachable on a build without close().
    if (!isDropdownOpen(d)) return;
    if (typeof d.close === "function") {
      try {
        d.close();
        closed = true;
      } catch (_) {
        // a build that throws here just falls through to the Escape belt
      }
    }
  });
  if (closed) return;
  // Live-verified 2026-08-16: BOTH generations ride tp-yt-iron-dropdown and its
  // close() works, so this path is the drifted-build case only. Escape is what
  // YouTube's own overlay manager listens for; composed:true so a listener bound
  // inside a shadow root still sees it, keyup too since some handlers pair them.
  // ponytail: no scrim-click belt — the live DOM has NO backdrop element at all
  // while the menu is open (zero matches for tp-yt-iron-overlay-backdrop or any
  // scrim class), so a belt aimed at one could only ever click the wrong node.
  // If a future build has neither close() nor an Escape handler, the menu simply
  // stays open after Block — the block itself already applied, and the next
  // click anywhere dismisses it.
  const esc = (type) =>
    new KeyboardEvent(type, {
      key: "Escape",
      code: "Escape",
      keyCode: 27,
      which: 27,
      bubbles: true,
      composed: true,
      cancelable: true,
    });
  document.dispatchEvent(esc("keydown"));
  document.dispatchEvent(esc("keyup"));
}

function onNativeBlockActivate(e) {
  e.preventDefault();
  e.stopPropagation();
  const item = e.currentTarget;
  const ck = item && item.dataset ? item.dataset.ytrChan : null;
  // Belt (2) against a wrong-channel window: re-resolve the remembered row NOW
  // and refuse to act unless it still yields the exact key this row was built
  // for. Blocking is destructive-ish (the creator disappears from every feed),
  // so a stale or drifted pointer must fail closed, not block the wrong channel.
  const live = lastMenuRow && document.contains(lastMenuRow)
    ? blockRowChannelKey(lastMenuRow)
    : null;
  if (!ck || live !== ck) {
    blockDebug("activate: refused — row re-verify gave " + live + ", row was built for " + ck);
    closeNativeMenu();
    removeNativeBlockItem();
    return;
  }
  // The EXISTING store: settings.blockedCreators via blockCreator (which also
  // updates blockedCache and runs the re-stamp sweep that hides the rows).
  blockCreator(ck);
  closeNativeMenu();
  removeNativeBlockItem();
}

// gen is "legacy" (Polymer menu rows) or "wiz" (yt-list-item-view-model rows).
// The two generations use different row metrics and, in Wiz, a leading icon
// slot — so the built row carries a gen class and §17b dresses each to match
// whichever menu it lands in. Structure only: still no innerHTML, and the
// channel key still rides in dataset, never in markup.
function buildNativeBlockItem(ck, gen) {
  const wiz = gen === "wiz";
  const sep = document.createElement("div");
  sep.className = NATIVE_BLOCK_SEP_CLASS;
  if (wiz) sep.classList.add(NATIVE_BLOCK_WIZ_CLASS);
  const item = document.createElement("div");
  item.className = NATIVE_BLOCK_ITEM_CLASS;
  if (wiz) item.classList.add(NATIVE_BLOCK_WIZ_CLASS);
  item.setAttribute("role", "menuitem");
  item.setAttribute("tabindex", "0");
  item.dataset.ytrChan = ck; // channel key rides as data, never as markup
  if (wiz) {
    // Wiz rows lead with a 24px icon and align their text off it; a bare
    // emoji-prefixed string would sit a gutter to the left of every sibling.
    const icon = document.createElement("span");
    icon.className = "ytr-native-block-icon";
    icon.textContent = "🚫";
    icon.setAttribute("aria-hidden", "true"); // decorative — the label carries it
    item.appendChild(icon);
  }
  const label = document.createElement("span");
  label.className = "ytr-native-block-label";
  label.textContent = wiz ? "Block this channel" : "🚫 Block this channel";
  item.appendChild(label);
  item.addEventListener("click", onNativeBlockActivate);
  item.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") onNativeBlockActivate(ev);
  });
  return { sep: sep, item: item };
}

// Append our row to the open native menu. Silent no-op whenever anything is
// missing: no open menu, an unrecognised menu shape, no resolvable channel, or
// the channel is already blocked.
//
// The observer re-runs this on EVERY popup-container mutation — the dropdown
// rewrites its inline style on scroll/resize, a toast lands, YouTube re-renders.
// So freshness gates only NEW injections: once our row is in a dropdown that is
// still open (nativeBlockDrop identity), it stays, even past the 4s window, or a
// menu the user is still reading would silently lose the row mid-hover. The row
// is instead evicted by rememberMenuTrigger the moment the user clicks anything
// else — which is also what re-points it at a different row.
function injectNativeBlockItem() {
  const open = openNativeMenu();
  if (!open) {
    blockDebug(
      "no open menu found (no visible tp-yt-iron-dropdown holding a menu-popup-renderer or a contextual sheet)"
    );
    return;
  }
  const list = open.list;
  // DOCUMENT-wide, not list-scoped: a Wiz menu that re-renders can append a
  // SECOND yt-list-view-model group, so our row from the previous render sits in
  // a sibling list this pass would never see — and we'd inject a duplicate.
  // Looking up (and dropping) our row wherever it is in the document makes
  // "exactly one Block row exists" true by construction.
  const existing = document.querySelector("." + NATIVE_BLOCK_ITEM_CLASS);
  const dropOurs = () => removeNativeBlockItem();
  if (!reworkEnabled) {
    blockDebug("master switch is off — plain YouTube, no row");
    return dropOurs();
  }
  // Our row is already live in THIS still-open dropdown -> leave it alone.
  if (existing && nativeBlockDrop === open.drop) {
    // Keep it last, and in the CURRENT list — YouTube may have appended items of
    // its own after ours, or re-rendered the menu into a fresh list group that
    // our row is no longer part of. appendChild moves it either way.
    if (existing.parentElement !== list || existing.nextElementSibling) {
      const sep = document.querySelector("." + NATIVE_BLOCK_SEP_CLASS);
      if (sep) list.appendChild(sep);
      list.appendChild(existing);
    }
    return;
  }
  // Feature-detect the menu shape: a real YouTube menu ships item renderers. If
  // none is present the build has drifted (or this is some other popup) — leave
  // it completely alone.
  if (
    !list.querySelector(
      "ytd-menu-service-item-renderer, ytd-menu-navigation-item-renderer, yt-list-item-view-model"
    )
  ) {
    blockDebug("menu shape unrecognised (" + open.gen + ") — no item rows in the list");
    return dropOurs();
  }

  const row = lastMenuRow;
  const fresh =
    !!row &&
    document.contains(row) &&
    Date.now() - lastMenuAt < MENU_TRIGGER_MAX_AGE_MS;
  if (!fresh) {
    blockDebug(
      "no fresh row remembered — this menu wasn't opened from a video row's ⋮"
    );
    return dropOurs();
  }
  const ck = blockRowChannelKey(row);
  // No channel resolvable (menu opened from a non-video context, or the row's
  // channel link hasn't hydrated) -> don't inject. Already blocked -> nothing to
  // offer (the popup's Blocked list owns the unblock).
  if (!ck) {
    blockDebug("no channel link found in <" + row.tagName.toLowerCase() + ">");
    return dropOurs();
  }
  if (blockedCache[ck]) {
    blockDebug(ck + " is already blocked — nothing to offer");
    return dropOurs();
  }

  dropOurs(); // a stale row from a previous dropdown, if any
  const built = buildNativeBlockItem(ck, open.gen);
  list.appendChild(built.sep);
  list.appendChild(built.item);
  nativeBlockDrop = open.drop;
  blockDebug("injected into the " + open.gen + " menu for " + ck);
}

// The one guarded entry point: the observer and the post-click timers both go
// through it, so an injection failure can never surface as a broken native menu.
function tryInjectNativeBlockItem() {
  // Session S: search is native, all of it — including YouTube's own ⋮ menu.
  // The one gate that covers every caller (the popup observer, the three
  // post-click belt timers and the master-on rewire). removeNativeBlockItem()
  // evicts a stale row left in the shared dropdown from before the navigation
  // here — removing our OWN node is the accepted cleanup exception on /results.
  if (onSearchRoute()) {
    removeNativeBlockItem();
    return;
  }
  try {
    injectNativeBlockItem();
  } catch (err) {
    blockDebug("threw: " + (err && err.message));
  }
}

// Watch the shared popup container for the menu opening / re-rendering. Debounced
// (a single open bursts many mutations) and self-healing: our own appendChild
// re-triggers it, but the next pass finds `existing` and returns, so it settles
// in one extra tick — no loop.
let nativeMenuObserver = null;
let nativeMenuTimer = null;

function wireNativeBlockMenu() {
  if (nativeMenuObserver) return true; // already wired for this document
  // Master off -> plain YouTube, so don't even watch the popup. The
  // masterChanged branch re-triggers this retry when the switch comes back on.
  if (!reworkEnabled) return true;
  const pc = popupContainer();
  if (!pc) {
    blockDebug("ytd-popup-container not hydrated yet — will retry");
    return false; // -> retry
  }
  nativeMenuObserver = new MutationObserver(() => {
    if (nativeMenuTimer) return;
    nativeMenuTimer = setTimeout(() => {
      nativeMenuTimer = null;
      tryInjectNativeBlockItem();
    }, 30);
  });
  nativeMenuObserver.observe(pc, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-hidden", "hidden", "style"],
  });
  return true;
}

// Master off: stop WATCHING, not just stop injecting. The observer fires on
// every popup mutation for the whole session otherwise — real work for a switch
// the user turned off. wireNativeBlockMenu is idempotent, so the master-on
// branch simply re-wires (its `if (nativeMenuObserver) return true` guard is
// what makes the re-wire free when it was never torn down).
function unwireNativeBlockMenu() {
  if (nativeMenuObserver) {
    nativeMenuObserver.disconnect();
    nativeMenuObserver = null;
  }
  if (nativeMenuTimer) {
    clearTimeout(nativeMenuTimer);
    nativeMenuTimer = null;
  }
}

// ytd-popup-container is an app-level singleton that hydrates a beat after the
// content script runs, so hunt for it on a bounded retry (and again on nav, in
// case a hard reload replaced the app root).
const wireNativeBlockMenuWithRetry = makeBoundedRetry(
  wireNativeBlockMenu,
  400,
  15000
);
window.addEventListener("yt-rework:locationchange", wireNativeBlockMenuWithRetry);
window.addEventListener("yt-navigate-finish", wireNativeBlockMenuWithRetry);

// --- Session M: Add-to-LearnTube from the playlist page -----------------------
// Until now a playlist could only be filed from the Library (paste a link) or
// from the Subscriptions inbox (··· -> Save to topic). But the place you decide
// "this is a course" is the playlist page itself — and opening it is ALSO what
// triggers the Step-6 progress scrape, so filing it here means the bars are
// already populated. Session M injects ONE button into YouTube's own playlist
// header, next to "Play all":
//
//   ＋ Add to LearnTube      -> opens a small anchored panel: "Add to which
//                               topic?", a row per topic, + New topic…
//   ✓ In your Library        -> already filed; the panel shows WHICH topic(s)
//                               and offers the topics it is NOT in yet.
//
// Every add routes through addPlaylistToTopic / createTopicWithPlaylist — the
// SAME writers the Library's paste flow uses (extracted for this, not cloned),
// so de-dupe, the unnamed-topic title adoption and the storage fan-out are
// identical by construction. Nothing here re-renders: mutateTopics ->
// storage.onChanged -> topicsChanged -> refreshPlaylistAddButton (+ the
// Library's own re-render in every other open tab).
//
// This lives in NATIVE chrome, so like Session L's injected menu row it is
// written to fail SILENT: every step feature-detects, and anything unrecognised
// means we simply don't inject. The native header must never break because of
// us. Master off -> the button and panel are removed outright.

const PLAYLIST_ADD_ID = "ytr-pl-add";
const PLAYLIST_ADD_WRAP_CLASS = "ytr-pl-add-wrap";

// Both header generations YouTube currently ships, most specific first:
//   (a) the newer page-header-view-model builds — the action row is a
//       yt-flexible-actions-view-model holding Play all / Shuffle / ⋮;
//   (b) the classic ytd-playlist-header-renderer (+ its old sidebar twin),
//       whose buttons live in #top-level-buttons-computed / .metadata-action-bar.
// The last entries are deliberate coarse fallbacks: appending to the header
// root still puts our button IN the header, just on its own line. Same
// drift-tolerance rule as scrapePlaylistTitle above.
const PLAYLIST_ACTION_ROW_SELECTORS = [
  "yt-page-header-view-model yt-flexible-actions-view-model .yt-flexible-actions-view-model-wiz__action-row",
  "yt-page-header-view-model yt-flexible-actions-view-model",
  "yt-page-header-view-model .page-header-view-model-wiz__page-header-headline-buttons",
  "ytd-playlist-header-renderer #top-level-buttons-computed",
  "ytd-playlist-header-renderer .metadata-action-bar",
  "ytd-playlist-header-renderer #play-buttons",
  "ytd-playlist-sidebar-primary-info-renderer #play-buttons",
  "yt-page-header-view-model",
  "ytd-playlist-header-renderer",
  "ytd-playlist-sidebar-primary-info-renderer",
];

// The id this page files under — run through the SAME sanitizer the Library's
// paste flow uses (parsePlaylistId ends in sanitizePlaylistId), so the key the
// button compares against is provably identical to the key stored in
// settings.topics. Null when the route has no usable list id.
function currentPlaylistKey() {
  return sanitizePlaylistId(currentListId());
}

// The dedicated playlist route only (the watch-page side panel keeps its own
// header and is NOT a place to file a course from).
function isPlaylistPage() {
  return location.pathname === "/playlist" && !!currentPlaylistKey();
}

// ytd-page-manager keeps PREVIOUS ytd-browse instances around with [hidden],
// and channel pages use the very same yt-page-header-view-model tag — so the
// coarse fallback selectors can match a stale, invisible header. Mounting there
// fails STICKILY (an invisible button that the fast path then idles on forever),
// so a candidate inside a hidden browse, or with no layout box at all, is
// rejected and the next selector is tried.
function isVisibleHeaderCandidate(el) {
  if (!el || el.closest("ytd-browse[hidden], [hidden]")) return false;
  if (el.offsetParent !== null || el.getClientRects().length) return true;
  // A display:contents host (the wiz custom elements often are) generates no
  // layout box of its own yet still renders its children — don't reject it.
  return getComputedStyle(el).display === "contents";
}

function playlistActionRow() {
  for (let i = 0; i < PLAYLIST_ACTION_ROW_SELECTORS.length; i++) {
    const nodes = document.querySelectorAll(PLAYLIST_ACTION_ROW_SELECTORS[i]);
    for (let j = 0; j < nodes.length; j++) {
      if (isVisibleHeaderCandidate(nodes[j])) return nodes[j];
    }
  }
  return null;
}

// Every topic that already holds this playlist. De-dupe is by playlist id
// ACROSS all topics — that is what decides the ✓ state of the button.
function topicsWithPlaylist(listId) {
  return topicsCache.filter((t) =>
    (Array.isArray(t.playlists) ? t.playlists : []).some(
      (p) => p && p.id === listId
    )
  );
}

function playlistAddWrap() {
  return document.getElementById(PLAYLIST_ADD_ID);
}

// --- the anchored panel ------------------------------------------------------
// Built fresh on every open (topics change under us), removed on close. The two
// dismiss listeners are attached only while it is open and always torn down in
// closePlaylistPanel, so nothing survives a navigation.

function closePlaylistPanel(focusBtn) {
  const wrap = playlistAddWrap();
  const panel = wrap && wrap.querySelector(".ytr-pl-panel");
  if (panel) panel.remove();
  document.removeEventListener("mousedown", onPlaylistPanelOutside, true);
  document.removeEventListener("keydown", onPlaylistPanelKeydown, true);
  const btn = wrap && wrap.querySelector(".ytr-pl-add-btn");
  if (btn) {
    btn.setAttribute("aria-expanded", "false");
    if (focusBtn) btn.focus();
  }
}

function onPlaylistPanelOutside(e) {
  const wrap = playlistAddWrap();
  if (!wrap) return closePlaylistPanel(false);
  if (wrap.contains(e.target)) return; // inside our button/panel -> not a dismiss
  closePlaylistPanel(false);
}

function onPlaylistPanelKeydown(e) {
  if (e.key !== "Escape") return;
  const wrap = playlistAddWrap();
  if (!wrap || !wrap.querySelector(".ytr-pl-panel")) return;
  e.stopPropagation(); // ours to handle — don't also close a YouTube overlay
  closePlaylistPanel(true);
}

// A 2s confirmation next to the button. One at a time (the pending timer is
// cleared), and it never blocks — the write already went out.
let playlistToastTimer = null;
function showPlaylistAddToast(text) {
  const wrap = playlistAddWrap();
  if (!wrap) return;
  const old = wrap.querySelector(".ytr-pl-toast");
  if (old) old.remove();
  if (playlistToastTimer) clearTimeout(playlistToastTimer);
  const toast = document.createElement("div");
  toast.className = "ytr-pl-toast";
  toast.setAttribute("role", "status");
  toast.textContent = text;
  wrap.appendChild(toast);
  playlistToastTimer = setTimeout(() => {
    playlistToastTimer = null;
    toast.remove();
  }, 2000);
}

// Shared tail of both add paths: close, confirm, and re-scrape the playlist that
// is ALREADY open so its progress lands without a reload (the retry merges into
// the same record the Library reads).
function afterPlaylistAdded() {
  closePlaylistPanel(false);
  showPlaylistAddToast("Added ✓");
  scrapePlaylistPageWithRetry();
}

function buildPlaylistPanelRow(cls, mark, label) {
  const node = document.createElement(cls === "item" ? "button" : "div");
  node.className = "ytr-pl-row" + (cls === "item" ? " ytr-pl-item" : " ytr-pl-in");
  if (cls === "item") node.type = "button";
  if (mark) {
    const m = document.createElement("span");
    m.className = "ytr-pl-row-mark";
    m.textContent = mark;
    node.appendChild(m);
  }
  const t = document.createElement("span");
  t.className = "ytr-pl-row-label";
  t.textContent = label; // user data -> textContent, never innerHTML
  node.appendChild(t);
  return node;
}

function buildPlaylistPanel(listId) {
  const panel = document.createElement("div");
  panel.className = "ytr-pl-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Add this playlist to a topic");

  const inTopics = topicsWithPlaylist(listId);
  const inIds = inTopics.map((t) => t.id);
  const others = topicsCache.filter((t) => inIds.indexOf(t.id) === -1);

  const title = document.createElement("div");
  title.className = "ytr-pl-panel-title";
  title.textContent = inTopics.length
    ? "Already in your Library"
    : "Add to which topic?";
  panel.appendChild(title);

  // Where it already is — read-only rows, so a second add is impossible.
  inTopics.forEach((t) => {
    panel.appendChild(buildPlaylistPanelRow("in", "✓", topicDisplayName(t)));
  });

  if (inTopics.length && others.length) {
    const sub = document.createElement("div");
    sub.className = "ytr-pl-panel-sub";
    sub.textContent = "Also add to";
    panel.appendChild(sub);
  }

  others.forEach((t) => {
    const row = buildPlaylistPanelRow("item", "", topicDisplayName(t));
    row.dataset.ytrTopic = t.id; // ids ride as data, never as markup
    row.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      // The Library's own writer — and we only confirm on a write that really
      // landed: the topic may have been deleted in another synced tab between
      // this panel being built and the click.
      addPlaylistToTopic(t.id, listId, (ok) => {
        if (ok) afterPlaylistAdded();
        else rebuildPlaylistPanel(); // topic vanished -> show the live truth
      });
    });
    panel.appendChild(row);
  });

  // --- + New topic… ---------------------------------------------------------
  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.className = "ytr-pl-row ytr-pl-item ytr-pl-new-btn";
  newBtn.textContent = "+ New topic…";

  const form = document.createElement("div");
  form.className = "ytr-pl-new";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "ytr-pl-input";
  input.placeholder = "Topic name";
  input.setAttribute("aria-label", "New topic name");
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "ytr-pl-ok";
  ok.textContent = "Add";
  form.appendChild(input);
  form.appendChild(ok);

  const confirmNew = (ev) => {
    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    // A blank name is allowed and meaningful: the new topic then adopts the
    // playlist's real scraped title, exactly like the first-run paste flow.
    createTopicWithPlaylist(input.value, listId, (ok) => {
      if (ok) afterPlaylistAdded();
      else rebuildPlaylistPanel();
    });
  };
  ok.addEventListener("click", confirmNew);
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation(); // typing must not reach YouTube's global shortcuts
    if (ev.key === "Enter") confirmNew(ev);
  });

  // With no topics at all there is nothing to choose from — go straight to the
  // input (locked in the design: one less click on a first-run install).
  const bare = topicsCache.length === 0;
  if (!bare) {
    newBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      newBtn.remove();
      form.classList.add("is-open");
      input.focus();
    });
    panel.appendChild(newBtn);
  } else {
    form.classList.add("is-open");
  }
  panel.appendChild(form);
  return { panel: panel, input: bare ? input : null };
}

function openPlaylistPanel() {
  const wrap = playlistAddWrap();
  const listId = currentPlaylistKey();
  if (!wrap || !listId) return;
  if (wrap.querySelector(".ytr-pl-panel")) return closePlaylistPanel(true); // toggle
  const built = buildPlaylistPanel(listId);
  wrap.appendChild(built.panel);
  const btn = wrap.querySelector(".ytr-pl-add-btn");
  if (btn) btn.setAttribute("aria-expanded", "true");
  // Attached on mousedown (not click): the click that OPENED the panel has
  // already delivered its mousedown, so this can never close it immediately.
  document.addEventListener("mousedown", onPlaylistPanelOutside, true);
  document.addEventListener("keydown", onPlaylistPanelKeydown, true);
  if (built.input) built.input.focus();
}

// Re-render an OPEN panel from the live topicsCache (a topic deleted / added /
// renamed in another synced tab, or a write that found nothing to write). Never
// fires while the new-topic input is showing — that would eat what the user is
// typing; that path re-reads the truth when they confirm anyway. No-op when no
// panel is open, so the onChanged branch can call it unconditionally.
function rebuildPlaylistPanel() {
  const wrap = playlistAddWrap();
  const panel = wrap && wrap.querySelector(".ytr-pl-panel");
  if (!panel) return;
  if (panel.querySelector(".ytr-pl-new.is-open")) return; // mid-typing -> leave it
  const listId = currentPlaylistKey();
  if (!listId) return closePlaylistPanel(false);
  const built = buildPlaylistPanel(listId);
  panel.replaceWith(built.panel);
  if (built.input) built.input.focus();
}

// --- the button --------------------------------------------------------------

// Label + ✓ state from the live topics cache. Called on mount, on every retry
// tick, and from the topicsChanged branch of storage.onChanged (so a filing in
// ANOTHER tab flips this one too).
function refreshPlaylistAddButton() {
  const wrap = playlistAddWrap();
  if (!wrap) return;
  const btn = wrap.querySelector(".ytr-pl-add-btn");
  const label = btn && btn.querySelector(".ytr-pl-add-label");
  const listId = currentPlaylistKey();
  if (!btn || !label || !listId) return;
  const saved = topicsWithPlaylist(listId).length > 0;
  label.textContent = saved ? "✓ In your Library" : "＋ Add to LearnTube";
  btn.classList.toggle("is-saved", saved);
  btn.setAttribute(
    "aria-label",
    saved ? "In your LearnTube Library" : "Add this playlist to LearnTube"
  );
}

function mountPlaylistAdd() {
  const row = playlistActionRow();
  if (!row) return false; // header not hydrated yet -> the retry ticks again
  const listId = currentPlaylistKey();
  if (!listId) return false; // no usable id -> nothing to file, don't inject
  const wrap = document.createElement("span");
  wrap.id = PLAYLIST_ADD_ID;
  wrap.className = PLAYLIST_ADD_WRAP_CLASS;
  // The playlist this mounted wrap belongs to. On a build that REUSES the header
  // node across an SPA hop (list=A -> list=B), the wrap survives — and an open
  // panel's handlers still close over A. The tick compares this stamp against
  // the live route and closes the stale panel before it can file the wrong id.
  wrap.dataset.ytrList = listId;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ytr-pl-add-btn";
  btn.setAttribute("aria-haspopup", "dialog");
  btn.setAttribute("aria-expanded", "false");
  const label = document.createElement("span");
  label.className = "ytr-pl-add-label";
  label.textContent = "＋ Add to LearnTube";
  btn.appendChild(label);
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openPlaylistPanel();
  });

  wrap.appendChild(btn);
  row.appendChild(wrap);
  refreshPlaylistAddButton();
  return true;
}

// Full teardown: the panel's document listeners first (closePlaylistPanel), then
// every wrap — including a stray one YouTube may have cloned into a re-rendered
// header. Safe to call on any route.
function removePlaylistAdd() {
  closePlaylistPanel(false);
  if (playlistToastTimer) {
    clearTimeout(playlistToastTimer); // no timer left pointing at a dead node
    playlistToastTimer = null;
  }
  document
    .querySelectorAll("." + PLAYLIST_ADD_WRAP_CLASS)
    .forEach((n) => n.remove());
}

// One tick of the per-nav job. Off-route or master-off -> tear down and stop.
// On-route it keeps ticking for the whole window (cheap: one getElementById)
// so a header YouTube re-renders mid-hydration gets the button back — the same
// disappearing-bar problem the Subscriptions header hit in Step 15.
function playlistAddTick() {
  if (!isPlaylistPage() || !reworkEnabled) {
    removePlaylistAdd();
    return true; // nothing to do on this route
  }
  const wrap = playlistAddWrap();
  // Fast path — but only for a SINGLE, live, correctly-keyed wrap. A second wrap
  // (a header YouTube cloned) or a wrap keyed to the playlist we just navigated
  // AWAY from must fall through to the rebuild below, or we'd idle forever on a
  // duplicate / file the previous list id.
  const many = document.querySelectorAll("." + PLAYLIST_ADD_WRAP_CLASS).length > 1;
  if (wrap && document.contains(wrap) && !many) {
    if (wrap.dataset.ytrList !== currentPlaylistKey()) {
      // Same header node, new playlist: drop the panel built for the old id
      // (its click handlers close over it) and re-key the button.
      closePlaylistPanel(false);
      wrap.dataset.ytrList = currentPlaylistKey();
    }
    refreshPlaylistAddButton();
    return "idle";
  }
  // Idempotent by construction: a wrap without an id (impossible today, but a
  // clone would qualify) is cleared before we mount the single owned one. The
  // close() first sheds the panel's document listeners — if YouTube re-rendered
  // the header out from under an OPEN panel, they'd otherwise outlive it.
  closePlaylistPanel(false);
  document
    .querySelectorAll("." + PLAYLIST_ADD_WRAP_CLASS)
    .forEach((n) => n.remove());
  return mountPlaylistAdd() ? false : "idle";
}

const mountPlaylistAddWithRetry = makeBoundedRetry(playlistAddTick, 300, 10000);
window.addEventListener("yt-rework:locationchange", mountPlaylistAddWithRetry);
window.addEventListener("popstate", mountPlaylistAddWithRetry);
window.addEventListener("yt-navigate-finish", mountPlaylistAddWithRetry);

// --- Inbox read state (dim opened videos) ------------------------------------
// A video is "read" the moment it is OPENED (locked decision) — detected by
// reading the /watch route's v= id, not by intercepting clicks. Read state is a
// per-video-id map persisted in chrome.storage.LOCAL (large, device-local,
// re-derivable; the 8KB sync item cap would blow). CSS section 11 dims read
// rows like read mail (the only read-state UI — kept minimal, no count banner).
// JS reads ids, persists/looks up state, and stamps data-ytr-read.
const READ_KEY = "read";
// Opportunistic upper bound on the read map (#6). It only grows (a video stays
// "read" forever), so trim the oldest opens past this cap. Display-only: losing
// the oldest mark just un-dims a long-untouched row — harmless, re-derived on
// the next open.
const READ_CAP = 5000;

// Live mirror of storage.local.read ({ "<videoId>": openedAtEpochMs }); seeded
// on load, kept fresh by the onChanged listener.
let readCache = {};

// Resolve a Subscriptions row's video id from its title/thumbnail link. Reuses
// videoIdFromHref (strips &list=/&t= etc.). Fail-quiet: null -> row not tracked.
function subsRowVideoId(row) {
  const a =
    row.querySelector("a#video-title-link[href]") ||
    row.querySelector("a#thumbnail[href]") ||
    row.querySelector('a[href*="watch"]'); // covers both Polymer + Wiz lockups
  return videoIdFromHref(a && a.getAttribute("href"));
}

// Reflect readCache onto one row's data-ytr-read attribute (CSS dims read rows).
function applyReadState(row, vid) {
  if (vid && readCache[vid]) row.setAttribute("data-ytr-read", "1");
  else row.removeAttribute("data-ytr-read");
}

// Re-apply read state to every id-stamped row against the current DOM, so
// already-decorated rows reflect readCache changes. No-op off Subscriptions.
function refreshSubsReadState(browse) {
  browse = browse || subsBrowse();
  if (!browse) return;
  browse
    .querySelectorAll("[data-ytr-vid]")
    .forEach((row) => applyReadState(row, row.getAttribute("data-ytr-vid")));
}

// --- Step 15: archived-row hiding ---------------------------------------------
// Reflect archivedCache onto one row's data-ytr-archived attribute. CSS
// section 13 display:none's stamped rows (they leave the inbox).
function applyArchivedState(row, vid) {
  if (vid && archivedCache[vid]) row.setAttribute("data-ytr-archived", "1");
  else row.removeAttribute("data-ytr-archived");
}

// Re-stamp every id-stamped row against archivedCache. No-op off Subscriptions.
function refreshSubsArchived(browse) {
  browse = browse || subsBrowse();
  if (!browse) return;
  browse
    .querySelectorAll("[data-ytr-vid]")
    .forEach((row) => applyArchivedState(row, row.getAttribute("data-ytr-vid")));
}

// Mark the currently-open watch video read (the locked trigger: opening = read).
// Rides the nav channels: clicking a Subscriptions row SPA-navigates to /watch
// and fires yt-navigate-finish; navigating back re-decorates the now-read row.
function markCurrentWatchRead() {
  if (!reworkEnabled) return;
  const vid = currentWatchVideoId(); // same /watch gate + v= read, one place
  if (!vid || readCache[vid]) return; // off-page, unknown, or already read
  readCache[vid] = Date.now(); // optimistic local update
  chrome.storage.local.get({ [READ_KEY]: {} }, (res) => {
    const read = res[READ_KEY] || {};
    if (read[vid]) return; // another tab beat us; keep its timestamp
    read[vid] = Date.now();
    // Opportunistic cap (#6): drop the oldest opens once over the bound so the
    // map can't grow without limit. onChanged then trims readCache to match.
    const ids = Object.keys(read);
    if (ids.length > READ_CAP) {
      ids.sort((a, b) => read[a] - read[b]); // oldest first
      for (let i = 0; i < ids.length - READ_CAP; i++) delete read[ids[i]];
    }
    chrome.storage.local.set({ [READ_KEY]: read }, () => {
      if (chrome.runtime.lastError) {
        console.warn(
          "[yt-rework] read write failed:",
          chrome.runtime.lastError
        );
      }
    });
  });
  // Refresh a Subscriptions DOM in THIS tab if present (rare on /watch); other
  // tabs are covered by the storage.onChanged path.
  refreshSubsReadState();
}

window.addEventListener("yt-rework:locationchange", markCurrentWatchRead);
window.addEventListener("popstate", markCurrentWatchRead);
window.addEventListener("yt-navigate-finish", markCurrentWatchRead);

// --- Step 23: The Lecture — centered player + the focus strip -----------------
// On EVERY /watch page (master on), JS stamps data-ytr-room on <html> (the
// data-ytr-vip pattern) and CSS section 15a — keyed on the stamp, master-gated
// — collapses #secondary and centers the player column. Section 8 hides the
// side column's suggestions site-wide anyway, so the native layout would pin
// the player against a dead right column; the stamp no longer requires a topic
// match (it did until the off-topic fix). On a watch page opened WITHIN A
// TOPIC (resolveCourseContext matches), additionally, below the player sits
// ONE quiet focus strip (#yt-rework-focus-strip, mounted at the top of #below):
// "‹ Back to <topic>" (returns to that topic's Course view on home via the
// sessionStorage OPEN_COURSE_HINT), an honest "Lecture N of M" position
// (scrape order — never a fabricated name; omitted when unknown), a Speed pill
// cycling the live <video>'s playbackRate, a "Next lecture →" deep-link and
// (Session O) its quiet sibling "← Previous lecture" — (Session R) both are
// plain positional neighbors in the SAME scrape order, so the course can be
// walked both ways; §4 first-unwatched now lives only in the Library
// Continue row and the Course Resume button. Nothing else: no second lecture
// rail, no notes, no Listen/Offline (killed non-goals — the Course page is the
// structured view; the watch page stays focused on the video). No Data API:
// watched-state is the Step-6 resume-bar scrape (storage.local.progress).
const FOCUS_STRIP_ID = "yt-rework-focus-strip";

// --- Patch 2 (v1.2.7): the playback-speed control ----------------------------
// Owner's ask: the speed control used to exist ONLY inside the course focus
// strip (a pill that cycled 1 → 1.25 → 1.5 → 2). It is now "−  1.00×  +" on
// EVERY /watch page, with a configurable step and a ceiling of 4× — past
// YouTube's own menu cap of 2×, which is a limit of THEIR menu, not of the
// media element (live-probed 2026-08-16: `video.playbackRate = 4` is accepted
// and reads back 4 with no clamp).
//
// One builder (makeSpeedGroup) feeds two mounts, so the control is one widget
// with one look: inside the strip's right cluster when a course strip exists,
// and in its own #yt-rework-speed-bar (same slot at the top of #below, same
// styling) on every other watch page. Never two at once — roomTick owns that.
//
// WHAT THE LIVE PROBES ESTABLISHED (2026-08-16), because the whole design below
// follows from it:
//  · The element accepts 4× and never clamps it.
//  · But an element write is INVISIBLE to YouTube's own player controller —
//    with the element at 4×, movie_player.getPlaybackRate() still reads 1. The
//    controller therefore RE-ASSERTS its own rate on every media (re)load: SPA
//    nav (~1.5-1.9s after, and slower on a cold load), ad end, quality switch,
//    a seek after a stall. That API is main-world only; a content script in the
//    isolated world cannot read or set it. The element and its events are all
//    we have, so "put ours back after each media load" is the only mechanism
//    available — hence the LOAD windows below rather than one nav stopwatch.
//  · YouTube already persists the user's OWN (menu-chosen) speed across videos.
//    So when the user reaches for the native menu we ADOPT their number and get
//    out of the way; we only fight the controller's reset, never the user.
const SPEED_BAR_ID = "yt-rework-speed-bar";
const SPEED_MIN = 0.25;
const SPEED_MAX = 4;
const SPEED_STEPS = [0.25, 0.5, 1]; // the popup's choices
const DEFAULT_SPEED_STEP = 0.25;
// How long after landing on a fresh v= a rate change to something other than
// our target is read as the controller re-asserting itself — a reset to put
// back — rather than the user choosing. Sized off the measurement: the
// re-assert lands ~1.5-1.9s after an SPA nav, later on a cold load.
const SPEED_WINDOW_MS = 2500;
// The same, keyed on a MEDIA LOAD (loadeddata / canplay: ad end, quality
// switch, a seek after a stall). A controller re-assert rides the load itself,
// so this window is deliberately tight — every extra millisecond is a
// millisecond in which the user's own menu pick would be wrongly put back.
const SPEED_LOAD_MS = 800;
const SPEED_MAX_REAPPLIES = 6; // fuse: a bounded number of put-backs per window
// Patch 3 (v1.2.10): the keyboard shortcuts. Defaults are [ and ] — checked
// against YouTube's own player keys (space/k, j/l, f, m, c, i, t, o, w, 0-9,
// arrows, shift+,/. , +/- for caption size): the brackets are free.
const DEFAULT_SPEED_KEY_DOWN = "[";
const DEFAULT_SPEED_KEY_UP = "]";

let speedStep = DEFAULT_SPEED_STEP; // mirror of settings.speedStep (synced)
// Mirrors of settings.speedKeyDown / .speedKeyUp. We store and compare e.KEY
// (the character the layout actually produced), not e.code: the popup shows the
// key face back to the user, and a face is exactly what e.key gives on every
// layout — e.code would print "BracketRight" to a user whose keyboard has no
// bracket there. The cost is that a shifted face is a different shortcut ("[" is
// not "{"), which is the honest reading of "the key I pressed".
let speedKeyDown = DEFAULT_SPEED_KEY_DOWN;
let speedKeyUp = DEFAULT_SPEED_KEY_UP;
// THE SESSION RATE. Per document, never persisted (a 4× that outlived the tab
// it was chosen in would be a trap) — but it SURVIVES leaving /watch, so a
// detour to search or the Library and back keeps the speed the user chose.
// It is hard-reset to 1× at exactly one moment: the transition into
// switch-off / master-off (the owner-required "no orphan 4×").
let speedTarget = 1;
// Do WE own the rate the element is currently running at? Set when a write of
// ours lands, cleared the moment the user's own menu is adopted (or on a
// restore). Everything that puts the rate BACK to 1× is gated on this, so a
// speed the user chose natively is never touched by us.
let speedOwned = false;
// Has the user chosen a speed THROUGH OUR CONTROL this session? Set only by a
// press of − / + / the readout, cleared when their native menu is adopted and
// on the hard disarm. This is the licence to DEFEND a rate at all: until they
// press one of our buttons we have no opinion, so the controller applying the
// speed YouTube remembered for them (measured: ~1.5s after a nav) is simply
// adopted and shown — never fought. Defending the initial 1× would have forced
// a 1× on a user whose own persisted speed was 2×, which nobody asked for.
let speedChosen = false;
// The exact value of our most recent write, so a ratechange can be matched to
// it BY VALUE. A boolean "we are writing" flag swallowed YouTube's interleaved
// write too and left the readout lying.
let speedSelfValue = null;
let speedSelfTimer = 0; // fallback clear, in case a write fires no ratechange
let speedLoadUntil = 0; // end of the current put-back window
let speedReapplies = 0; // put-backs used in this window (loop fuse)
let speedVid = null; // the v= the target was last (re)applied for
// Were we armed (master on + switch on + on /watch) last tick? The restore to
// 1× is a ONE-SHOT on the armed→disarmed edge, never an every-tick write.
let speedArmed = false;

// settings.speedStep: a NUMBER off the fixed list (not a boolean, so it rides
// the settings object directly like peekView, not settings.toggles). Anything
// else — absent, stale, hand-edited — reads as the default.
function readSpeedStep(settings) {
  const n = settings && Number(settings.speedStep);
  return SPEED_STEPS.indexOf(n) >= 0 ? n : DEFAULT_SPEED_STEP;
}

// May this key face be a shortcut at all? ONE predicate, asked by the popup
// before it writes a binding AND here before we honour one, so a value that
// could never be bound through the UI can't arrive by hand-editing storage or a
// sync from an older build either. Tab and Enter are the two that would cost the
// page something with no way back from inside it — every keyboard activation of
// a link or button goes through Enter, and Tab is focus navigation — and F1-F24
// belong to the browser. (Escape / Backspace / Delete drive the capture box
// itself, so the UI never offers them; nothing else is off limits.)
// Kept in sync with popup.js.
function isBindableKey(key) {
  if (typeof key !== "string" || key.length < 1 || key.length > 20) return false;
  if (key === "Tab" || key === "Enter") return false;
  return !/^F([1-9]|1[0-9]|2[0-4])$/.test(key);
}

// settings.speedKeyDown / .speedKeyUp: a single e.key string, riding the
// settings object like speedStep. Anything else — absent, empty, hand-edited to
// a non-string, an implausibly long name, or a key we refuse to bind — reads as
// the default.
function readSpeedKey(settings, field, fallback) {
  const k = settings && settings[field];
  return isBindableKey(k) ? k : fallback;
}

// Read BOTH hotkeys into their mirrors. One key can only mean one thing: the
// keydown handler tests "up" first, so a duplicate would silently swallow
// "down". The popup can't produce that state (it swaps instead), but corrupt or
// hand-edited storage can — so down falls back to its default, and if that still
// collides (the user bound UP to "[") down is left unbound rather than dead
// weight pretending to be a shortcut.
function syncSpeedKeys(settings) {
  speedKeyUp = readSpeedKey(settings, "speedKeyUp", DEFAULT_SPEED_KEY_UP);
  speedKeyDown = readSpeedKey(settings, "speedKeyDown", DEFAULT_SPEED_KEY_DOWN);
  if (speedKeyDown === speedKeyUp) speedKeyDown = DEFAULT_SPEED_KEY_DOWN;
  if (speedKeyDown === speedKeyUp) speedKeyDown = null;
}

// Snap to 2dp and hold the rails. 0.25 and 1.0 steps both land on clean values;
// the rounding only guards float drift (0.25 × 3 = 0.7500000000000001).
//
// The floor is Math.max's job ALONE. An early `n <= 0 -> 1` here made − jump
// UPWARDS off the floor (0.25 − 0.25 = 0 → 1×), oscillate 1↔0.5 on the 0.5
// step, and kill − outright on the 1.0 step. Only a non-number falls back to 1.
function clampSpeed(rate) {
  const n = Number(rate);
  if (!isFinite(n)) return 1;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(n * 100) / 100));
}

// B1 (Session G): the "Up next ▾" fold — session-only view state, collapsed by
// default. A module let so roomTick's bounded-retry re-renders don't collapse
// an open list; keyed to the watch video id so navigating to another lecture
// starts folded again, and reset on strip teardown (nav-away / master off).
// This deliberately REOPENS the Step-23 "no second watch-page lecture rail"
// non-goal, scoped to exactly this on-demand titles-only list.
let upNextOpen = false;
let upNextVid = null;

// The <video> the player is using right now. Re-read each interaction (the
// player can swap the element across SPA nav / ad breaks). The player's own
// .html5-main-video class is asked for FIRST: "the first <video> in the
// document" is only the player until YouTube ships a hover-preview element
// ahead of it, and the speed engine gates every write on identity with this
// function — a wrong answer would make it silently inert, not merely wrong.
function roomVideoEl() {
  return (
    document.querySelector("video.html5-main-video") ||
    document.querySelector("video")
  );
}

// The v= id of the current /watch page (id only — never a fabricated title).
function currentWatchVideoId() {
  if (location.pathname !== "/watch") return null;
  try {
    return new URL(location.href).searchParams.get("v");
  } catch (_) {
    return null;
  }
}

// "Within a topic": resolve the owning topic + the list id we should deep-link
// within. By list= first (the playlist the lecture was opened from); else fall
// back to scanning each topic's scraped playlists for the current video id (a
// lecture opened without list= but tracked in a course). Null => inject nothing.
function resolveCourseContext() {
  if (location.pathname !== "/watch") return null;
  const vid = currentWatchVideoId();
  const list = currentListId();

  if (list) {
    const t = topicsCache.find(
      (topic) =>
        Array.isArray(topic.playlists) &&
        topic.playlists.some((pl) => pl.id === list)
    );
    if (t) return { topic: t, listId: list };
  }

  if (vid) {
    for (let i = 0; i < topicsCache.length; i++) {
      const topic = topicsCache[i];
      const pls = Array.isArray(topic.playlists) ? topic.playlists : [];
      for (let j = 0; j < pls.length; j++) {
        const rec = progressCache[pls[j].id];
        const vids = rec && Array.isArray(rec.videos) ? rec.videos : [];
        if (vids.some((v) => v.id === vid)) {
          return { topic, listId: pls[j].id };
        }
      }
    }
  }
  return null;
}

// --- The strip's positional walk (Session R, finished in Session S) ----------
// Purely POSITIONAL by owner decree: 7→8→9 on Next, 9→8 on Previous, watched or
// not, and the Up next list is the same walk from the same index. Either side
// is null at the course edge (no disabled ghosts in the strip), and BOTH are
// null when the current video isn't in the scraped lists, where "before/after"
// is undefined. Crosses playlist boundaries inside the topic exactly as the
// position count does, carrying that row's own list id — no cross-TOPIC hop,
// ever. (The §4 deterministic "first non-watched" still drives the Library
// Continue row and the Course Resume button via topicProgress — that is their
// whole point, and they are untouched here.)
//
// Session S: ONE walk, ONE index resolution, for all three strip surfaces —
// the position label, the Previous/Next pills and the Up next list. Three
// separate walks (each with its own findIndex) is exactly how they drifted
// apart. courseRows() is topic → playlist → video in stored order, which is now
// the playlist's REAL order (writePlaylistProgress sorts by the scraped
// `order`), not insertion order.
//
// TITLELESS ROWS ARE NOT IN THE WALK. "Real titles or nothing" is the strip's
// standing rule (a "Lecture N" placeholder is forbidden), so the Up next list
// always dropped them — and a row the walk's own list refuses to show must not
// be a step the pills take either, or the first Up-next entry stops being the
// Next pill's target. Filtering ONCE, here, is what keeps the position label,
// the pills and the list counting the same rows: Next simply walks outward to
// the nearest titled lecture. (A row is titleless only until a scrape reads its
// title; the merge never blanks a known one.)
function courseRows(ctx) {
  const rows = [];
  const pls = Array.isArray(ctx.topic.playlists) ? ctx.topic.playlists : [];
  pls.forEach((pl) => {
    const rec = progressCache[pl.id];
    const vids = rec && Array.isArray(rec.videos) ? rec.videos : [];
    vids.forEach((v) => {
      if (v.title) rows.push({ video: v, listId: pl.id });
    });
  });
  return rows;
}

// Where the current video sits in that walk. A video can legitimately appear in
// TWO of a topic's playlists (a course and its "highlights" list, a re-used
// intro); matching on videoId ALONE then resolves the FIRST copy and the pills
// step through the wrong module. The URL's ?list= says which copy the user is
// actually watching, so match BOTH when it is there, and fall back to the
// videoId alone when the lecture was opened without a list. -1 => not in the
// scraped lists, and every caller then renders nothing rather than a guess.
function courseIndexOf(rows) {
  const cur = currentWatchVideoId();
  if (!cur) return -1;
  const list = currentListId();
  if (list) {
    const exact = rows.findIndex(
      (r) => r.video.id === cur && r.listId === list
    );
    if (exact >= 0) return exact;
  }
  return rows.findIndex((r) => r.video.id === cur);
}

function courseAdjacentLectures(ctx) {
  const rows = courseRows(ctx);
  const i = courseIndexOf(rows);
  if (i < 0) return { prev: null, next: null };
  const at = (n) =>
    rows[n] ? { videoId: rows[n].video.id, listId: rows[n].listId } : null;
  return { prev: at(i - 1), next: at(i + 1) };
}

// The current lecture's honest position across the course: 1-based index +
// total, in the same walk. Null when the current video isn't in the scraped
// lists (un-scraped module) — the label is then omitted, never fabricated.
function lecturePositionInCourse(ctx) {
  const rows = courseRows(ctx);
  const i = courseIndexOf(rows);
  return i < 0 ? null : { n: i + 1, total: rows.length };
}

// B1 (Session G): the lectures AFTER the current one, in course order — the
// same walk and the same index the Next pill uses, so the first row of the Up
// next list IS courseAdjacentLectures().next. Purely positional: watched or
// not, done or not, it lists what comes next. Session S: the "real titles or
// nothing" filter that used to live HERE (and only here — which is exactly how
// this list and the Next pill could disagree) now lives in courseRows, for
// every consumer at once. Display-only: reads the cache, never reorders.
function upcomingLectures(ctx) {
  const rows = courseRows(ctx);
  const i = courseIndexOf(rows);
  if (i < 0) return [];
  return rows.slice(i + 1);
}

// --- The room stamp (the data-ytr-vip pattern) --------------------------------
// CSS section 15a keys the #secondary collapse + player centering on
// html.yt-rework[data-ytr-room]; JS only flips the attribute. Guarded so the
// bounded retry's repeat ticks don't spam resize events: the player sizes its
// <video> in px from the column it sits in, so ONE nudge per actual change
// makes it re-measure the now-wider (or restored) column.
let roomActive = false;

function setRoomActive(on) {
  // S2 (hideWatchSuggestions) off -> native two-column watch page returns, so
  // the centered "room" retires with it (they are one decision).
  const next = !!on && reworkEnabled && togglesCache.hideWatchSuggestions !== false;
  if (next === roomActive) return;
  roomActive = next;
  document.documentElement.toggleAttribute("data-ytr-room", roomActive);
  window.dispatchEvent(new Event("resize"));
}

// Readout label: always two decimals ("1.00×", "1.25×", "4.00×") so the number
// never changes width as it steps (the bar is tabular-nums; this keeps it from
// jittering between 1× and 1.25×).
function speedLabel(rate) {
  return clampSpeed(rate).toFixed(2) + "×";
}

// True when the control should be on screen AND owning the rate.
function speedControlOn() {
  return (
    reworkEnabled &&
    togglesCache.speedButtons !== false &&
    location.pathname === "/watch"
  );
}

// Write a rate to the live <video> (re-read every time — the player swaps the
// element across SPA nav / ad breaks). Returns false when there is no video
// yet, which tells the caller to keep the retry window open. speedSelfValue
// records WHAT we wrote, so the ratechange handler can match the echo by value
// (a bare "we are writing" flag also swallowed YouTube's interleaved write and
// left the readout lying about the real rate). A timer clears it in case a
// write fires no ratechange at all.
function applySpeed(rate) {
  const v = roomVideoEl();
  if (!v) return false;
  if (Math.abs(v.playbackRate - rate) < 1e-6) return true; // already there
  speedSelfValue = rate;
  clearTimeout(speedSelfTimer);
  speedSelfTimer = setTimeout(() => {
    speedSelfValue = null;
  }, 600);
  try {
    v.playbackRate = rate;
  } catch (_) {
    speedSelfValue = null; // rejected (out of the UA's range) — stay honest
    return false;
  }
  return true;
}

// Write the SESSION rate and take ownership of it. Ownership is what licenses
// us to put the rate back to 1× later, so it is claimed narrowly: only when the
// write actually MOVED the rate, and only away from 1×. If the element already
// sits at our target — YouTube carrying the user's own menu choice forward, say
// — we have changed nothing and own nothing, so switch-off leaves it alone.
function applySpeedTarget() {
  const v = roomVideoEl();
  if (!v) return false;
  const moved = Math.abs(v.playbackRate - speedTarget) >= 1e-6;
  const ok = applySpeed(speedTarget);
  if (ok && moved && speedTarget !== 1) speedOwned = true;
  return ok;
}

// Repaint every mounted readout (both mounts share the class, and there is only
// ever one of them live). The aria-label carries the live number too — a static
// one would leave a screen reader with a button that never says its own value.
function renderSpeedReadouts() {
  const label = speedLabel(speedTarget);
  document.querySelectorAll(".ytr-speed-now").forEach((b) => {
    b.textContent = label;
    b.setAttribute("aria-label", label + ", click for normal speed");
  });
}

// Open a put-back window: for the next SPEED_WINDOW_MS, a rate change to
// anything but our target is the player controller re-asserting itself.
// Open a put-back window of `ms`. Never SHORTENS one already open (a canplay
// 300ms into a nav must not cut the nav's longer window down to its own).
function openSpeedWindow(ms) {
  const until = Date.now() + ms;
  if (until > speedLoadUntil) speedLoadUntil = until;
  speedReapplies = 0;
}

// The user pressed − / + / the number. THIS is the only thing that gives us a
// speed to defend.
function setSpeed(rate) {
  speedTarget = clampSpeed(rate);
  speedChosen = true;
  speedReapplies = 0;
  if (!applySpeedTarget()) {
    // No <video> yet (early on a hard load): open a window and let the room
    // retry land it as soon as the player exists.
    openSpeedWindow(SPEED_WINDOW_MS);
    roomTickWithRetry();
  } else {
    // The write landed — but the controller cannot SEE an element write, so it
    // may re-assert its own rate a beat later (a mid-video quality switch, an
    // ad ending) with no load event we were already inside a window for.
    // Without this the very next re-assert would be read as the user's native
    // menu and adopted, quietly throwing away the speed they just chose. The
    // short window is the right one: a re-assert follows immediately, while a
    // real menu pick can come at any time after.
    openSpeedWindow(SPEED_LOAD_MS);
  }
  renderSpeedReadouts();
}

// Somebody ELSE moved the rate. Three questions, in order:
//
//  1. Have we been given a speed to defend at all (speedChosen)? Until the user
//     presses one of OUR buttons, no — the rate belongs to YouTube, which
//     remembers the user's own menu choice across videos and re-applies it a
//     beat after each nav. We adopt it and show it. (Defending the initial 1×
//     here is exactly how a user with a persisted 2× got forced to 1×.)
//  2. Are we inside a put-back window? Then the controller is re-asserting its
//     own rate — it cannot see element writes — and ours goes back.
//  3. Otherwise it is the user reaching for YouTube's native menu: adopt their
//     number, hand ownership AND the licence back, and stop touching it (their
//     choice then rides YouTube's own persistence to the next video).
//
// Loop-guards: (1) a change matching OUR last write by value is our own echo;
// (2) a change already equal to the target is a no-op; (3) put-backs are fused
// at SPEED_MAX_REAPPLIES per window; (4) when the control is off — switch or
// master or off /watch — this handler touches NOTHING and returns, so a native
// speed can never be adopted into state we would later "restore".
function onSpeedRateChange(e) {
  const v = e.target;
  if (!v || v !== roomVideoEl()) return; // a shelf preview's <video> is not ours
  const r = v.playbackRate;
  if (speedSelfValue !== null && Math.abs(r - speedSelfValue) < 1e-6) {
    speedSelfValue = null; // our own write, landed
    clearTimeout(speedSelfTimer);
    renderSpeedReadouts();
    return;
  }
  if (!speedControlOn()) return; // off = hands off, entirely
  if (Math.abs(r - speedTarget) < 1e-6) {
    renderSpeedReadouts();
    return;
  }
  if (
    speedChosen &&
    Date.now() < speedLoadUntil &&
    speedReapplies < SPEED_MAX_REAPPLIES
  ) {
    speedReapplies++;
    applySpeedTarget();
    return;
  }
  // Adopt: either we have no chosen speed (the controller's own rate is the
  // truth) or this is the user's native menu outside every window.
  speedTarget = clampSpeed(r);
  speedOwned = false;
  speedChosen = false;
  renderSpeedReadouts();
}

// Capture-phase on the document: `ratechange` doesn't bubble, and the <video>
// is swapped by the player, so listening on the element is not durable.
document.addEventListener("ratechange", onSpeedRateChange, true);

// Every media (re)load is a moment the controller re-asserts its rate: the SPA
// nav's new video, the end of an ad, a quality switch, a seek after a stall.
// Keying the put-back on the load EVENT (not on a stopwatch started at nav) is
// what covers the mid-video cases a wall-clock window would miss — and the
// window it opens is the SHORT one, because a re-assert rides the load itself
// while a user's menu pick can come at any time after it.
function onSpeedMediaLoad(e) {
  if (!e.target || e.target !== roomVideoEl()) return;
  if (!speedControlOn()) return;
  if (!speedChosen) return; // nothing of ours to defend — leave the rate alone
  openSpeedWindow(SPEED_LOAD_MS);
  applySpeedTarget();
}
document.addEventListener("loadeddata", onSpeedMediaLoad, true);
document.addEventListener("canplay", onSpeedMediaLoad, true);

// The armed→disarmed edge (off /watch, the switch off, master off). ONE write,
// and only when the rate on the element is OURS — a speed the user chose in
// YouTube's own menu is never yanked back to 1×. `hard` (switch/master off) is
// the single moment the session rate and the licence to defend it are cleared;
// leaving /watch keeps them, so a detour to search or the Library and back
// resumes at the chosen speed.
//
// Returns true when the disarm SETTLED. Ownership is released only once the
// restoring write actually lands: if there is no video to write to (the player
// is gone, or a miniplayer element answers instead), we stay the owner and the
// caller retries on its next tick — releasing early would strand a 3× element
// with nothing left that is allowed to bring it back.
function disarmSpeed(hard) {
  let settled = true;
  if (speedOwned) {
    if (applySpeed(1)) speedOwned = false;
    else settled = false;
  }
  speedLoadUntil = 0;
  speedReapplies = 0;
  speedVid = null;
  if (hard) {
    speedTarget = 1;
    speedChosen = false;
  }
  return settled;
}

// The widget: − | readout | +. All three are real <button>s (the readout resets
// to 1×); labels are static literals via textContent, no innerHTML anywhere.
function makeSpeedGroup() {
  const g = makeEl("div", { className: "ytr-speed" });
  g.append(
    makeEl("button", {
      className: "ytr-speed-btn",
      text: "−",
      attrs: {
        type: "button",
        "data-speed-action": "down",
        title: "Slower",
        "aria-label": "Slower",
      },
    })
  );
  g.append(
    makeEl("button", {
      className: "ytr-speed-now",
      text: speedLabel(speedTarget),
      attrs: {
        type: "button",
        "data-speed-action": "reset",
        title: "Back to normal speed",
        // Kept live by renderSpeedReadouts — a screen reader must hear the
        // current speed, not just "reset".
        "aria-label": speedLabel(speedTarget) + ", click for normal speed",
      },
    })
  );
  g.append(
    makeEl("button", {
      className: "ytr-speed-btn",
      text: "+",
      attrs: {
        type: "button",
        "data-speed-action": "up",
        title: "Faster",
        "aria-label": "Faster",
      },
    })
  );
  return g;
}

// Shared delegated click: used by the standalone bar's own handler AND by the
// strip's existing onRoomClick (one contract, one behaviour). Returns true when
// it handled the event.
function handleSpeedClick(e) {
  const t = e.target;
  if (!t || !t.closest) return false;
  const btn = t.closest("[data-speed-action]");
  if (!btn) return false;
  e.preventDefault();
  e.stopPropagation();
  const act = btn.getAttribute("data-speed-action");
  if (act === "reset") setSpeed(1);
  else setSpeed(speedTarget + (act === "up" ? speedStep : -speedStep));
  return true;
}

function onSpeedClick(e) {
  handleSpeedClick(e);
}

// Patch 3 (v1.2.10): the same two steps from the keyboard. A THIRD caller of
// setSpeed — never a write to playbackRate — so speedChosen / speedTarget /
// speedOwned mean exactly what a button press means and the put-back engine
// defends a key-chosen speed identically.
//
// Is this element one the user is typing into? Checked on the composed source
// AND on document.activeElement, because a keydown inside an OPEN shadow root is
// retargeted to its host by the time it reaches the document. (A field inside a
// CLOSED root is invisible to both checks — nothing on today's YouTube uses one,
// and there is no API that would let us see it if it did.)
function isSpeedTypingTarget(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return !!(
    el.closest && el.closest("input, textarea, select, [contenteditable]")
  );
}

// One document-level CAPTURE listener: YouTube's own key handling sits on the
// document too, so capture is what lets us swallow the key before it acts. We
// swallow ONLY when a shortcut actually fires — every other key, and every key
// while the gates are shut, passes through untouched.
//
// Auto-repeat is deliberately allowed: holding + is a stream of real user
// choices, and each one re-opening the put-back window is correct (the window is
// a wall-clock deadline, not a timer that restarts work).
//
// AltGr is NOT a modifier here, it is part of the key face: on QWERTZ/AZERTY the
// default [ and ] ARE AltGr presses, so bailing on e.altKey would have shipped
// two dead defaults to every such keyboard. AltGr sets altKey everywhere and
// ctrlKey as well on Windows, so when getModifierState("AltGraph") is true both
// of those are the composition itself and the press goes through; plain
// ctrl / meta / alt still bail.
function speedKeyModifiersOk(e) {
  if (e.metaKey) return false;
  const altGraph =
    typeof e.getModifierState === "function" && e.getModifierState("AltGraph");
  if (altGraph) return true;
  return !e.ctrlKey && !e.altKey;
}

function onSpeedKeyDown(e) {
  if (!e || !speedKeyModifiersOk(e)) return; // modifier = not ours
  if (e.isComposing || e.keyCode === 229) return; // mid-IME composition
  const up = e.key === speedKeyUp;
  const down = e.key === speedKeyDown;
  if (!up && !down) return;
  if (!speedControlOn()) return; // master off / switch off / off /watch
  const path = typeof e.composedPath === "function" ? e.composedPath() : null;
  const src = (path && path[0]) || e.target;
  if (isSpeedTypingTarget(src) || isSpeedTypingTarget(document.activeElement))
    return; // the search box, a comment field, a rename input — leave it alone
  e.preventDefault();
  e.stopPropagation();
  setSpeed(speedTarget + (up ? speedStep : -speedStep));
}
document.addEventListener("keydown", onSpeedKeyDown, true);

// The standalone mount — same slot as the focus strip (top of #below), used on
// every watch page that has no course strip. Only ever mounted when the strip
// is absent, so the two can never fight over #below's first child.
function mountSpeedBar() {
  if (document.getElementById(SPEED_BAR_ID)) return true; // idempotent
  const host = focusStripMountTarget();
  if (!host) return false;
  const bar = makeEl("div");
  bar.id = SPEED_BAR_ID;
  bar.addEventListener("click", onSpeedClick, true);
  bar.append(makeSpeedGroup());
  host.insertBefore(bar, host.firstChild);
  return true;
}

function removeSpeedBar() {
  const el = document.getElementById(SPEED_BAR_ID);
  if (el) el.remove();
}

function removeFocusStrip() {
  const el = document.getElementById(FOCUS_STRIP_ID);
  if (el) el.remove();
  // Strip teardown resets the Up next fold (B1 — session-only, never persisted).
  upNextOpen = false;
  upNextVid = null;
}

// The strip sits at the top of #below (under the player, above the native
// title/metadata). #below hydrates late on hard loads, hence the bounded
// retry. The fallback softens DOM drift (strip just won't mount — fail-quiet;
// the 15a center rule keys on #secondary/#primary and still applies).
function focusStripMountTarget() {
  return (
    document.querySelector("ytd-watch-flexy #below") ||
    document.querySelector("#below") ||
    null
  );
}

function mountFocusStrip() {
  if (document.getElementById(FOCUS_STRIP_ID)) return true; // idempotent
  const host = focusStripMountTarget();
  if (!host) return false;
  const strip = document.createElement("div");
  strip.id = FOCUS_STRIP_ID;
  // One delegated capture-phase handler, wired once at creation (contents are
  // rebuilt in place, never the node).
  strip.addEventListener("click", onRoomClick, true);
  host.insertBefore(strip, host.firstChild);
  return true;
}

// (Re)build the strip from the current context. B1 (Session G): the strip is
// now a COLUMN of [row, Up next list] — the row holds Back · position · Speed
// · Up next ▾ · Previous · Next; pressing Up next unfolds a quiet titles-only
// list of the coming lectures under the row (collapsed by default; state survives
// the re-render ticks via the module let). Wipes + rebuilds children
// (idempotent contents). Every dynamic string via textContent; every id only
// ever a link href / dataset value — never innerHTML.
function renderFocusStrip(ctx) {
  const strip = document.getElementById(FOCUS_STRIP_ID);
  if (!strip || !ctx) return;
  strip.dataset.topicId = ctx.topic.id; // for the Back handler — dataset only

  while (strip.firstChild) strip.removeChild(strip.firstChild);

  const row = makeEl("div", { className: "ytr-fs-row" });

  // Left: "‹ Back to <topic>" + the honest position (omitted when unknown).
  const left = makeEl("div", { className: "ytr-fs-left" });
  const back = makeEl("a", {
    className: "ytr-fs-back",
    text: "‹ Back to " + topicDisplayName(ctx.topic),
    attrs: { "data-room-back": "1" },
  });
  back.href = "/"; // home — the Course view opens via the armed hint
  left.append(back);
  const where = lecturePositionInCourse(ctx);
  if (where) {
    left.append(
      makeEl("span", {
        className: "ytr-fs-where",
        text: "Lecture " + where.n + " of " + where.total,
      })
    );
  }
  row.append(left);

  // Right: Speed (the real playbackRate) · Up next ▾ (only when something
  // titled comes after this video — real titles or nothing) · ← Previous
  // lecture (Session O: a deep-link; absent on the first lecture) · Next
  // lecture (a deep-link; simply absent on the last lecture).
  const right = makeEl("div", { className: "ytr-fs-right" });
  // Patch 2: the old cycle pill is gone — the strip now carries the SAME
  // "−  1.00×  +" group the rest of the watch pages get (one widget, one look),
  // and it obeys the same switch.
  if (togglesCache.speedButtons !== false) right.append(makeSpeedGroup());
  const upcoming = upcomingLectures(ctx);
  if (upcoming.length > 0) {
    right.append(
      makeEl("button", {
        className: "ytr-pill" + (upNextOpen ? " is-open" : ""),
        text: "Up next ▾",
        attrs: {
          type: "button",
          "data-room-action": "upnext",
          "aria-expanded": upNextOpen ? "true" : "false",
          title: "Show the coming lectures",
        },
      })
    );
  }
  // Session O: "← Previous lecture" — the quiet sibling of Next (the plain
  // .ytr-pill recipe; Next keeps the accent-soft fill so it stays the primary
  // action), sitting immediately left of it. Same resumeUrl builder, so the
  // &list= course context rides along and tracking continues. Each is absent at
  // its end of the course (no disabled ghosts in the strip).
  //
  // Session R — the old asymmetry (positional Previous vs §4-deterministic
  // Next) is GONE by owner decree: both pills now just step one row, 7→8→9 and
  // back. The Library Continue row and the Course Resume button keep §4
  // (first non-watched, via topicProgress) — that is their whole point.
  const { prev, next } = courseAdjacentLectures(ctx);
  if (prev) {
    const prevLink = makeEl("a", {
      className: "ytr-pill",
      text: "← Previous lecture",
      attrs: { title: "Go to the previous lecture in course order" },
    });
    prevLink.href = resumeUrl(prev); // a URL only — never innerHTML
    right.append(prevLink);
  }
  if (next) {
    const go = makeEl("a", {
      className: "ytr-pill ytr-pill-next",
      text: "Next lecture →",
      attrs: { title: "Go to the next lecture in course order" },
    });
    go.href = resumeUrl(next); // a URL only — never innerHTML
    right.append(go);
  }
  row.append(right);
  strip.append(row);

  // The unfolded titles-only list — the course view's .ytr-lec rows reused
  // verbatim (renderLecture: whole-row deep-link, watched mark, REAL scraped
  // title, duration omitted when missing). Capped by CSS (~6 rows, scroll).
  if (upNextOpen && upcoming.length > 0) {
    const list = makeEl("div", { className: "ytr-fs-upnext" });
    upcoming.forEach((u) =>
      list.append(renderLecture(u.video, u.listId, { static: true }))
    );
    strip.append(list);
  }
}

// Delegated capture-phase click for the strip's three live pieces. Back lets
// the native <a href="/"> proceed (YouTube's router — or a hard load — does
// the navigation; we only arm the open-course hint). Up next (Session G)
// toggles the lecture list. Speed re-reads the live <video> each click (the
// player can swap the element across SPA nav).
function onRoomClick(e) {
  const t = e.target;
  if (!t || !t.closest) return;

  // Patch 2: the speed group lives inside the strip's right cluster here, and
  // in its own bar elsewhere — one shared handler for both.
  if (handleSpeedClick(e)) return;

  const back = t.closest("[data-room-back]");
  if (back) {
    const strip = document.getElementById(FOCUS_STRIP_ID);
    armOpenCourseHint(strip && strip.dataset.topicId);
    return; // no preventDefault — the navigation IS the action
  }

  // B1 (Session G): fold / unfold the Up next list. Re-render the strip from
  // the freshly-resolved context so the list and the pill's open state stay
  // one render (the module let survives the tick re-renders).
  const up = t.closest('[data-room-action="upnext"]');
  if (up) {
    e.preventDefault();
    e.stopPropagation();
    upNextOpen = !upNextOpen;
    const ctx = resolveCourseContext();
    if (ctx) renderFocusStrip(ctx);
    return;
  }

}

// One tick: clear the stamp + strip off /watch / master-off; stamp the room on
// ANY /watch page (centered player everywhere — the off-topic right column is
// dead anyway, section 8 hides its suggestions); mount + render the strip only
// when the video resolves to a topic. Returns true to STOP the bounded retry
// (settled), false to keep ticking for late #below hydration.
function roomTick() {
  if (!reworkEnabled) {
    setRoomActive(false);
    removeFocusStrip();
    removeSpeedBar();
    // Master off: the one-shot restore + the hard clear of the session rate,
    // fired only on the armed→disarmed EDGE. (An every-tick applySpeed(1) here
    // spent the whole retry window slamming a natively-chosen speed back down.)
    // Stays armed if the restore couldn't land, so the next tick re-tries it.
    if (speedArmed && disarmSpeed(true)) speedArmed = false;
    return !speedArmed; // unsettled (still armed) -> keep ticking, not stop
  }
  const onWatch = location.pathname === "/watch";
  setRoomActive(onWatch);
  const speedOn = togglesCache.speedButtons !== false;
  if (!onWatch || !speedOn) {
    if (!onWatch) removeFocusStrip();
    removeSpeedBar();
    // Switch off is a HARD disarm (the owner-required reset to 1×); merely
    // leaving /watch is soft — the session rate survives the detour.
    if (speedArmed && disarmSpeed(!speedOn)) speedArmed = false;
    if (!onWatch) return !speedArmed; // unsettled -> keep retrying, not stop
  }

  // Patch 2: the speed pass runs on EVERY watch page, course or not. A new v=
  // opens a put-back window — the controller re-asserts its own rate as each
  // video loads, and the session's chosen speed has to win it back (the retry's
  // ticks plus the loadeddata/canplay listeners are what cover it).
  const vid = currentWatchVideoId();
  if (speedOn) {
    if (!speedArmed || vid !== speedVid) {
      speedArmed = true;
      speedVid = vid;
      openSpeedWindow(SPEED_WINDOW_MS);
      // With nothing of ours chosen, the truth is whatever the player is doing:
      // read it, so a bar mounting onto a video already running at the user's
      // remembered 2× says 2.00× instead of lying with a default 1.00×. A read,
      // never a write.
      if (!speedChosen) {
        const v = roomVideoEl();
        if (v) speedTarget = clampSpeed(v.playbackRate);
      }
    }
    // Only ever re-assert a speed the user actually chose through our control.
    // Without that gate this line defended the default 1× and stamped it over
    // the speed YouTube had remembered for them.
    if (speedChosen && Date.now() < speedLoadUntil) applySpeedTarget();
  }

  const ctx = resolveCourseContext();
  if (!ctx) {
    removeFocusStrip();
    // Not in a topic -> centered player, no strip, but still the speed control.
    if (!speedOn) return true;
    if (!mountSpeedBar()) return false; // #below not hydrated yet
    renderSpeedReadouts();
    // Keep ticking only while the put-back window is open.
    return Date.now() >= speedLoadUntil;
  }
  removeSpeedBar(); // on a course page the group rides INSIDE the strip
  // B1 (Session G): a NEW lecture page starts with the Up next list folded
  // (collapsed by default); the retry's repeat ticks for the SAME video keep
  // whatever the user chose (the module let is only reset on a vid change).
  // (`vid` is resolved once above, for the speed pass — same value, one read.)
  if (vid !== upNextVid) {
    upNextVid = vid;
    upNextOpen = false;
  }
  if (!mountFocusStrip()) return false; // #below not hydrated yet
  renderFocusStrip(ctx);
  return false; // keep ticking: progress / DOM may still settle
}

const roomTickWithRetry = makeBoundedRetry(roomTick, 300, 4000);

window.addEventListener("yt-rework:locationchange", roomTickWithRetry);
window.addEventListener("popstate", roomTickWithRetry);
window.addEventListener("yt-navigate-finish", roomTickWithRetry);

// --- Step 24: cancel autoplay-next when the end wall is hidden ----------------
// CSS section 8g-2 hides the post-video recommendation surfaces, INCLUDING the
// autonav countdown card. That card is also the only Cancel affordance: hiding
// it alone would leave the player's autonav timer running invisibly and carry
// the user off to a recommended video with no warning — worse than native. So
// whenever we hide it, we also cancel it, and the two must stay one decision.
//
// Cancel, not "disable autoplay": the per-video cancel button is the player's
// own sanctioned path and leaves the user's global autoplay preference alone.
// Live-verified the button is mounted DURING playback, already matched at
// t=0ms of the retry window — it is display:none under 8g-2, and a hidden
// element still takes a programmatic .click() — so the bounded retry below is
// headroom for a slow tick, not load-bearing for a late mount.
const AUTONAV_CANCEL_SELECTORS = [
  ".ytp-autonav-endscreen-upnext-cancel-button",
  ".ytp-autonav-endscreen-cancel-button",
  ".ytp-upnext-cancel",
];

const CANCEL_AUTONAV_INTERVAL = 250;
const CANCEL_AUTONAV_DURATION = 3000;
// makeBoundedRetry doesn't expose tick count, so track attempts ourselves
// (reset whenever the retry (re)starts) to know when we're on the LAST tick.
const CANCEL_AUTONAV_MAX_TICKS =
  Math.floor(CANCEL_AUTONAV_DURATION / CANCEL_AUTONAV_INTERVAL) + 1;
let cancelAutonavAttempts = 0;

// True only when we are actually hiding the end wall on a watch page: master on
// + S4 on (hideEndCards) + /watch. Same three conditions the CSS gate encodes,
// so cancel and hide can never disagree.
function autonavCancelArmed() {
  return (
    reworkEnabled &&
    togglesCache.hideEndCards !== false &&
    location.pathname === "/watch"
  );
}

// One tick: click the cancel control if it has mounted. Returns true to STOP.
function cancelAutonavTick() {
  if (!autonavCancelArmed()) return true; // switched off mid-window -> stand down
  cancelAutonavAttempts++;
  const player = document.getElementById("movie_player") || document;
  for (const sel of AUTONAV_CANCEL_SELECTORS) {
    const btn = player.querySelector(sel);
    if (btn) {
      btn.click();
      return true;
    }
  }
  // Belt: no cancel control this generation. Turn autonav OFF at the chrome
  // toggle, but ONLY while it reads as on — so this is a no-op once autoplay is
  // already off, and never toggles it back ON. Unlike the per-video cancel this
  // PERSISTS the user's autoplay preference; accepted as the fallback for a
  // study tool, where "nothing plays itself" is the whole point. Gated to the
  // FINAL retry tick (so a late-mounting cancel button always wins) AND to
  // `ended-mode` on the player (so a spurious `ended` from a preview/pre-roll
  // can't flip the user's global pref).
  const isFinalTick = cancelAutonavAttempts >= CANCEL_AUTONAV_MAX_TICKS;
  const inEndedMode = player.classList && player.classList.contains("ended-mode");
  if (isFinalTick && inEndedMode) {
    const toggle = document.querySelector(
      '.ytp-autonav-toggle-button[aria-checked="true"]'
    );
    if (toggle) {
      toggle.click();
      return true;
    }
  }
  return false; // keep ticking until the window elapses
}

// ~3s window: long enough for the endscreen to mount, short enough that a
// video ending in a background tab costs a handful of querySelectors. Bounded,
// never a standing poll; a fresh `ended` supersedes any loop still running.
const cancelAutonavWithRetry = makeBoundedRetry(
  cancelAutonavTick,
  CANCEL_AUTONAV_INTERVAL,
  CANCEL_AUTONAV_DURATION
);

// `ended` does not bubble, so it is heard in the CAPTURE phase on the document:
// one listener, wired once at load, that catches whichever <video> the player
// is using. This is why nothing here needs re-arming per SPA navigation — the
// player swaps its media element freely and the gates are re-read on every
// event, so flipping S4 or the master switch takes effect on the next video
// end with no listener churn. Off /watch (e.g. a preview on /results) the gate
// returns false and we never touch the player.
document.addEventListener(
  "ended",
  (ev) => {
    const t = ev.target;
    if (!t || t.tagName !== "VIDEO") return;
    if (!autonavCancelArmed()) return;
    cancelAutonavAttempts = 0; // fresh retry window -> fresh tick count
    cancelAutonavWithRetry();
  },
  true
);

// --- Step 15: archived inbox rows --------------------------------------------
// "Archive" clears a row from the inbox (the doc's replacement for YouTube's
// mystery 3-dot menu). Archived state is a per-video-id map persisted in
// chrome.storage.LOCAL (like `read`/`progress`/`notes`: device-local, growable,
// re-derivable-only-by-hand; the 8KB sync item cap would blow). CSS section 13
// `display:none`s rows stamped data-ytr-archived; the count excludes them.
const ARCHIVED_KEY = "archived";

// Live mirror of storage.local.archived ({ "<videoId>": archivedAtMs }); seeded
// on load, kept fresh by the onChanged listener.
let archivedCache = {};

// Read-modify-write the archived map alone (never touches read/progress/notes).
function mutateArchived(fn) {
  chrome.storage.local.get({ [ARCHIVED_KEY]: {} }, (res) => {
    const archived = res[ARCHIVED_KEY] || {};
    fn(archived);
    chrome.storage.local.set({ [ARCHIVED_KEY]: archived }, () => {
      if (chrome.runtime.lastError) {
        console.warn(
          "[yt-rework] archived write failed:",
          chrome.runtime.lastError
        );
      }
    });
  });
}

// Archive a video id: optimistic local mirror + persist + reflect onto the DOM.
function archiveVideo(videoId) {
  if (!videoId || archivedCache[videoId]) return;
  archivedCache[videoId] = Date.now();
  mutateArchived((archived) => {
    if (!archived[videoId]) archived[videoId] = Date.now();
  });
  refreshSubsArchived(); // hides the row now; onChanged covers other tabs
}

// (Step 23: the per-lecture notes code path — NOTES_KEY, notesCache,
// mutateNotes, saveNote — is GONE with its last consumer, the Step-17 watch
// rail. Notes were a killed non-goal, doc §05: "Removed everywhere — Course
// and Lecture." Any old `notes` data left in chrome.storage.local is orphaned
// and harmless: nothing reads or writes it.)

// --- Creator stars (display-only marker) -------------------------------------
// A 1-5 star rating per CREATOR, shown beside the bold channel name. Purely a
// VISUAL marker: it does NOT reorder the feed or touch YouTube's algorithm.
// Ratings are small, bounded, user-authored -> stored in the SYNCED settings
// object under `settings.stars` ({ "<channelKey>": 1..5 }), so they ride along
// to every device via the browser's own account sync (no server / database).
// CSS section 6i styles the glyphs; JS resolves each row's channel key, persists
// /looks up the rating, injects the buttons, and toggles their filled state.

// Live mirror of settings.stars; seeded on load + kept fresh by onChanged.
let starsCache = {};
// Step 25: setChannelStars refreshes the glyphs synchronously for instant
// feedback; this latch lets the acting tab's own onChanged echo skip the
// redundant second refresh (other tabs, latch unset, still refresh). Cleared on
// consumption so a missed echo just costs one self-healing refresh next nav.
let starsSelfWrite = false;

// Normalize a channel link href into a stable per-creator key: prefer the
// "@handle", then the canonical /channel/UC… id, then legacy /c//user/ paths.
function normalizeChannelKey(href) {
  if (!href) return null;
  let path = href;
  try {
    path = new URL(href, location.origin).pathname;
  } catch (_) {
    // not a URL — use the raw href as a path
  }
  let m = path.match(/^\/(@[^/?#]+)/);
  if (m) return m[1].toLowerCase();
  m = path.match(/^\/channel\/(UC[\w-]+)/);
  if (m) return m[1];
  m = path.match(/^\/(?:c|user)\/([^/?#]+)/);
  if (m) return "c/" + m[1].toLowerCase();
  return null;
}

// Resolve a row's channel key from its byline/avatar channel link. Fail-quiet:
// null -> row not star-trackable (still fully readable).
function subsRowChannelKey(row) {
  const a =
    row.querySelector('a[href^="/@"]') ||
    row.querySelector('a[href*="/channel/"]') ||
    row.querySelector('a[href^="/c/"]') ||
    row.querySelector('a[href^="/user/"]');
  return normalizeChannelKey(a && a.getAttribute("href"));
}

// The byline element (channel · views · time) — where the star control mounts so
// it trails the bold channel name on the same line. Both class-name forms.
function subsRowByline(row) {
  return (
    row.querySelector(".yt-lockup-metadata-view-model__metadata") ||
    row.querySelector(".ytLockupMetadataViewModelMetadata")
  );
}

// Build the five-button star control (no innerHTML -> no XSS). Filled state is
// applied later by refreshSubsStars via the .is-filled class.
function buildStarControl() {
  const wrap = document.createElement("span");
  wrap.className = "ytr-stars";
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", "Rate this creator (1-5 stars)");
  for (let i = 1; i <= 5; i++) {
    const b = document.createElement("button");
    b.className = "ytr-star";
    b.type = "button";
    b.dataset.star = String(i);
    b.textContent = "★"; // ★ glyph; CSS dims the unfilled ones
    b.setAttribute("aria-label", i + (i > 1 ? " stars" : " star"));
    wrap.appendChild(b);
  }
  return wrap;
}

// --- Step 15: per-row overflow control (Save to topic / Archive) -------------
// Replaces YouTube's mystery 3-dot menu (hidden by CSS 6j) with our own action
// that fits the inbox language. Injected onto the byline next to the stars. The
// menu is built lazily on first open and lists the user's topics (names via
// textContent — never innerHTML; ids only ever as dataset/attribute values).
// SUBSCRIPTIONS ONLY (Session L): the inbox is our own surface and the chip is
// the only way to reach Save-to-topic / Archive there. On search and Peek the
// chip is gone and YouTube's native ⋮ is back.
function buildOverflowControl() {
  const wrap = document.createElement("span");
  wrap.className = "ytr-ovf";
  const btn = document.createElement("button");
  btn.className = "ytr-ovf-btn";
  btn.type = "button";
  btn.dataset.ovfBtn = "1";
  btn.textContent = "···";
  btn.setAttribute("aria-label", "Row actions");
  btn.setAttribute("aria-haspopup", "menu");
  wrap.appendChild(btn);
  return wrap;
}

// Build the dropdown menu for one Subscriptions row's overflow control: Save to
// topic (a list of the user's topics) + Archive. All strings via textContent;
// topic ids ride in dataset only. (Session L: the search / Peek variants — and
// with them the "⊘ Block channel" item — are gone. Block now rides YouTube's OWN
// ⋮ menu, so this builder has exactly one caller again: onSubsClick.)
function buildOverflowMenu() {
  const menu = document.createElement("div");
  menu.className = "ytr-ovf-menu";
  menu.setAttribute("role", "menu");

  // Save to topic — header + a row per topic.
  const saveLabel = document.createElement("div");
  saveLabel.className = "ytr-ovf-section";
  saveLabel.textContent = "Save to topic";
  menu.appendChild(saveLabel);

  if (!topicsCache.length) {
    const empty = document.createElement("div");
    empty.className = "ytr-ovf-empty";
    empty.textContent = "No topics yet";
    menu.appendChild(empty);
  } else {
    topicsCache.forEach((t) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "ytr-ovf-item";
      item.dataset.ovfSave = t.id;
      item.setAttribute("role", "menuitem");
      item.textContent = topicDisplayName(t); // user data -> textContent
      menu.appendChild(item);
    });
  }

  // Archive — clears the row from the inbox (Subscriptions only).
  const sep = document.createElement("div");
  sep.className = "ytr-ovf-sep";
  menu.appendChild(sep);
  const arch = document.createElement("button");
  arch.type = "button";
  arch.className = "ytr-ovf-item ytr-ovf-archive";
  arch.dataset.ovfArchive = "1";
  arch.setAttribute("role", "menuitem");
  arch.textContent = "Archive";
  menu.appendChild(arch);

  return menu;
}

// Close any open overflow menu and reset its control's pressed state.
function closeOverflowMenus() {
  document.querySelectorAll(".ytr-ovf.is-open").forEach((w) => {
    w.classList.remove("is-open");
    const m = w.querySelector(".ytr-ovf-menu");
    if (m) m.remove();
  });
}

// --- Step 15: VIP filter (display-only) --------------------------------------
// A transient view filter: when on, CSS section 13 shows only VIP rows — those
// whose channel rating is >= 4 (Step 20; the threshold lives entirely in CSS,
// which hides data-ytr-star absent/0/1/2/3). It is SESSION state (not persisted) — calm by
// default, you opt in per visit. Flips data-ytr-vip on <html> + pressed state on
// the header toggle. NEVER reorders the feed (pure display:none).
let vipFilterOn = false;

function setVipFilter(on) {
  vipFilterOn = !!on && reworkEnabled;
  document.documentElement.toggleAttribute("data-ytr-vip", vipFilterOn);
  const toggle = document.getElementById("ytr-vip-toggle");
  if (toggle) toggle.setAttribute("aria-pressed", vipFilterOn ? "true" : "false");
}

// --- Step 15: injected Subscriptions header ("Subscriptions" title + VIP) -----
// (Step 20 subtraction: the unread badge + refreshSubsCounts are GONE — "No
// unread counter, no badges"; the header is the title + the ★ VIP toggle.)
// CSS can't create DOM; this mounts a single header bar at the top of the
// Subscriptions content column. Idempotent (getElementById), master-gated,
// removed when leaving the page / master off.
const SUBS_HEADER_ID = "ytr-subs-header";

function subsHeaderMountTarget(browse) {
  // Mount OUTSIDE the grid, as a sibling just before it: ytd-rich-grid-renderer
  // re-stamps its #contents children whenever a continuation lands (and the VIP
  // filter's display:none collapse triggers a burst of those), so a foreign bar
  // mounted INSIDE it gets dropped — that was the disappearing-header bug. The
  // grid ELEMENT itself persists, so a sibling above it survives re-renders.
  // Fallbacks keep the old top-of-column spots for DOM drift. Fail-quiet:
  // returns { parent, before } (before may be null -> append).
  const grid = browse.querySelector("ytd-rich-grid-renderer");
  if (grid && grid.parentNode) return { parent: grid.parentNode, before: grid };
  const host =
    browse.querySelector("#primary #contents") ||
    browse.querySelector("#contents") ||
    browse;
  return { parent: host, before: host.firstChild };
}

function mountSubsHeader(browse) {
  browse = browse || subsBrowse();
  if (!browse) return;
  if (document.getElementById(SUBS_HEADER_ID)) return; // already mounted
  const target = subsHeaderMountTarget(browse);
  if (!target || !target.parent) return;

  const bar = document.createElement("div");
  bar.id = SUBS_HEADER_ID;

  const title = document.createElement("span");
  title.className = "ytr-subs-title";
  title.textContent = "Subscriptions";
  bar.appendChild(title);

  const vip = document.createElement("button");
  vip.id = "ytr-vip-toggle";
  vip.type = "button";
  vip.className = "ytr-vip-toggle";
  vip.dataset.vipToggle = "1";
  vip.textContent = "★ VIP";
  vip.setAttribute("aria-pressed", vipFilterOn ? "true" : "false");
  bar.appendChild(vip);

  target.parent.insertBefore(bar, target.before || null);
}

function removeSubsHeader() {
  const bar = document.getElementById(SUBS_HEADER_ID);
  if (bar) bar.remove();
  // Also shed the per-row injected controls (creator stars + ··· overflow). Their
  // CSS is gated on html.yt-rework, so on master-off an orphan would render as a
  // raw default control.
  // No-op once off Subscriptions (subsBrowse() null; the
  // controls left with the old page). decorateSubscriptions re-injects them
  // idempotently on the next master-on / re-visit.
  const browse = subsBrowse();
  if (browse)
    browse.querySelectorAll(".ytr-ovf, .ytr-stars").forEach((n) => n.remove());
}

// Read-modify-write the synced settings.stars map (never clobbers masterEnabled
// / topics). onChanged drives the re-fill in synced tabs; the acting tab also
// re-fills immediately via setChannelStars below.
function mutateStars(fn) {
  chrome.storage.sync.get({ [SETTINGS_KEY]: DEFAULT_SETTINGS }, (res) => {
    const settings = Object.assign({}, DEFAULT_SETTINGS, res[SETTINGS_KEY]);
    settings.stars =
      settings.stars && typeof settings.stars === "object"
        ? Object.assign({}, settings.stars)
        : {};
    fn(settings.stars);
    chrome.storage.sync.set({ [SETTINGS_KEY]: settings }, () => {
      if (chrome.runtime.lastError) {
        console.warn("[yt-rework] stars write failed:", chrome.runtime.lastError);
      }
    });
  });
}

function setChannelStars(key, val) {
  starsCache[key] = val; // optimistic mirror
  starsSelfWrite = true; // we refresh now; our own onChanged echo can skip it
  mutateStars((stars) => {
    if (val >= 1 && val <= 5) stars[key] = val;
    else delete stars[key];
  });
  refreshSubsStars(); // instant feedback here; onChanged covers other tabs
}

// Delegated click for all our injected Subscriptions controls (capture phase so
// we beat YouTube's row navigation — rating / opening the menu / saving /
// archiving must never open the video). Each branch handles its own control and
// returns; everything else (native row clicks) passes straight through.
function onSubsClick(e) {
  const t = e.target;
  if (!t || !t.closest) return;

  // 1. Star rating.
  const star = t.closest(".ytr-star");
  if (star) {
    e.preventDefault();
    e.stopPropagation();
    const row = star.closest("[data-ytr-chan]");
    const key = row && row.getAttribute("data-ytr-chan");
    if (!key) return;
    const val = parseInt(star.dataset.star, 10);
    const current = starsCache[key] || 0;
    setChannelStars(key, val === current ? 0 : val); // click current -> clear
    return;
  }

  // 2. VIP filter toggle (header).
  if (t.closest("[data-vip-toggle]")) {
    e.preventDefault();
    e.stopPropagation();
    setVipFilter(!vipFilterOn);
    // Collapsing rows to display:none makes YouTube pull continuations and
    // re-render grid internals with NO nav event — kick a fresh decorate
    // window so the header self-heals if anything drops it and the newly
    // loaded rows get stamped/starred while the filter is active.
    decorateSubscriptionsWithRetry();
    return;
  }

  // 3. Overflow button — toggle its menu open/closed.
  const ovfBtn = t.closest("[data-ovf-btn]");
  if (ovfBtn) {
    e.preventDefault();
    e.stopPropagation();
    const wrap = ovfBtn.closest(".ytr-ovf");
    const wasOpen = wrap.classList.contains("is-open");
    closeOverflowMenus();
    if (!wasOpen) {
      wrap.appendChild(buildOverflowMenu());
      wrap.classList.add("is-open");
    }
    return;
  }

  // 4. Save-to-topic menu item.
  const saveItem = t.closest("[data-ovf-save]");
  if (saveItem) {
    e.preventDefault();
    e.stopPropagation();
    const row = saveItem.closest("[data-ytr-vid]");
    const vid = row && row.getAttribute("data-ytr-vid");
    addVideoToTopic(saveItem.dataset.ovfSave, vid);
    closeOverflowMenus();
    return;
  }

  // 5. Archive menu item.
  const archItem = t.closest("[data-ovf-archive]");
  if (archItem) {
    e.preventDefault();
    e.stopPropagation();
    const row = archItem.closest("[data-ytr-vid]");
    const vid = row && row.getAttribute("data-ytr-vid");
    archiveVideo(vid);
    closeOverflowMenus();
    return;
  }

  // 6. Click anywhere else inside the browse -> close any open menu (do NOT
  // swallow the click; let native navigation proceed). No-op when none is open.
  closeOverflowMenus();
}

// Re-apply each row's rating to data-ytr-star + the control's filled glyphs.
// Stars are display-only — no sorting/reordering. No-op off Subscriptions.
function refreshSubsStars(browse) {
  browse = browse || subsBrowse();
  if (!browse) return;
  browse.querySelectorAll("[data-ytr-chan]").forEach((row) => {
    const rating = starsCache[row.getAttribute("data-ytr-chan")] || 0;
    row.setAttribute("data-ytr-star", String(rating));
    const ctrl = row.querySelector(".ytr-stars");
    if (ctrl)
      ctrl.querySelectorAll(".ytr-star").forEach((b) => {
        b.classList.toggle("is-filled", parseInt(b.dataset.star, 10) <= rating);
      });
  });
}

chrome.storage.sync.get([SETTINGS_KEY, LEGACY_KEY], (res) => {
  let settings = res[SETTINGS_KEY];
  if (!settings) {
    // First run, or upgrading from the old boolean — seed the settings object,
    // preserving any prior on/off choice, then drop the legacy key.
    const legacy = res[LEGACY_KEY];
    settings = { masterEnabled: legacy === undefined ? true : !!legacy };
    chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
    if (legacy !== undefined) chrome.storage.sync.remove(LEGACY_KEY);
  }
  apply(settings.masterEnabled);
  // Phase 1: seed the switches + stamp the data-ytr-show-* opt-out attrs.
  togglesCache = readToggles(settings);
  applyToggles();
  // Phase 2: seed the remembered Peek view (grid default) onto <html> — the list
  // restyle keys on it, but only matters once data-ytr-peek is also set.
  peekView = settings.peekView === "list" ? "list" : "grid";
  // Patch 2: seed the speed STEP (a number on settings, not a switch). The rate
  // itself is session state and always starts at 1×.
  speedStep = readSpeedStep(settings);
  // Patch 3: seed the two speed hotkeys (also plain settings fields).
  syncSpeedKeys(settings);
  // Only stamp the remembered-view attr while the rework is on — a fresh load
  // with master OFF must stay plain YouTube (no data-ytr-* on <html>). The
  // master ON transition re-stamps it (see the masterChanged branch).
  if (reworkEnabled)
    document.documentElement.setAttribute("data-ytr-peek-view", peekView);
  // Phase 3: seed the synced blocklist mirror before the first search/home stamp.
  blockedCache =
    settings.blockedCreators && typeof settings.blockedCreators === "object"
      ? settings.blockedCreators
      : {};
  // Seed the live topics cache before the first render.
  topicsCache = Array.isArray(settings.topics) ? settings.topics : [];
  topicsSeeded = true;
  // Drop progress records orphaned by a delete in a prior session (no-op if the
  // progress seed hasn't resolved yet; that callback re-runs the prune).
  pruneOrphanProgress();
  // Seed the live creator-stars cache before the first Subscriptions decorate.
  starsCache =
    settings.stars && typeof settings.stars === "object" ? settings.stars : {};
  // S7 — first-landing-only: a FRESH open of youtube.com's home route ("/", from
  // a new tab / typed address / bookmark) lands on the Subscriptions inbox. Fires
  // ONLY here (the hard-load seed), never on the SPA nav channels, so clicking the
  // logo / Home afterwards still reaches the Library, and a direct link (video /
  // search / playlist) is never redirected. replace() (like /shorts) so Back
  // never loops.
  if (
    reworkEnabled &&
    togglesCache.startOnSubscriptions === true &&
    location.pathname === "/"
  ) {
    // Session Q: flag the document so the storage.local seed's backfill (a
    // separate async callback that does NOT see this early return) doesn't kick
    // off playlist fetches for a page that is already navigating away.
    documentDoomed = true;
    location.replace(location.origin + "/feed/subscriptions");
    return; // navigating away — nothing else to seed on this doomed document
  }
  // Catch a hard load that landed directly on a /shorts/* URL.
  redirectShorts();
  // Mount the Learning shell if we hard-loaded onto the home route (retry
  // because ytd-browse may not have hydrated yet).
  mountLearningHomeWithRetry();
  // Decorate Subscriptions if we hard-loaded straight onto /feed/subscriptions
  // (no-op elsewhere; bounded retry handles late hydration + lazy rows).
  decorateSubscriptionsWithRetry();
  // (Session O/S: nothing at all runs on /results — search is native, and the
  // sweep below early-returns there.)
  // Phase 2/3: the home decorate pass — stamps blocked rows on the native feed
  // (S6 off) and drives the Peek reveal; no-op when the Library is shown + not
  // peeking.
  decorateHomeWithRetry();
  // Session L: hook YouTube's shared menu popup so its ⋮ dropdown gains our
  // "🚫 Block this channel" row (bounded retry — the container hydrates late).
  wireNativeBlockMenuWithRetry();
  // Session M: inject "＋ Add to LearnTube" if we hard-loaded straight onto a
  // /playlist?list=… page (no-op on every other route).
  mountPlaylistAddWithRetry();
  // …and stamp the surfaces with no decorate pass of their own (watch sidebar,
  // grid shelves) on a hard load.
  reapplyBlockedSweep();
  // Session Q: see the note on the storage.local seed — whichever of the two
  // lands second actually runs it.
  backfillMissingPlaylistScrapes();
});

// Seed the progress + read + archived caches (storage.local) so the first
// render reflects stored state, scrape if we hard-loaded onto a playlist URL,
// and mark a hard load that landed straight on a /watch page as read.
chrome.storage.local.get(
  { [PROGRESS_KEY]: {}, [READ_KEY]: {}, [ARCHIVED_KEY]: {} },
  (res) => {
    progressCache = res[PROGRESS_KEY] || {};
    progressSeeded = true;
    readCache = res[READ_KEY] || {};
    archivedCache = res[ARCHIVED_KEY] || {};
    pruneOrphanProgress(); // drop records orphaned by a delete in a prior session
    adoptScrapedTopicNames(); // name any unnamed pasted-playlist topics (Step 21)
    renderLearningHome(); // refresh any already-mounted panel with cached progress
    scrapePlaylistPageWithRetry(); // no-op unless on a playlist page
    refreshSubsReadState(); // apply read-row dimming if on Subscriptions
    refreshSubsArchived(); // hide archived rows if on Subscriptions
    markCurrentWatchRead(); // record a hard load straight onto /watch
    roomTickWithRetry(); // stamp the room + mount the focus strip on /watch
    // Session Q: top up playlists filed before background hydration existed.
    // Fires from whichever seed lands SECOND (the guard inside needs both), and
    // only ever once per document.
    backfillMissingPlaylistScrapes();
  }
);

// Flip instantly when the popup (or another synced tab) changes settings.
chrome.storage.onChanged.addListener((changes, area) => {
  // Progress cache lives in storage.local: refresh + re-render the home panel so
  // finishing a video on a playlist tab updates a home tab live.
  if (area === "local" && changes[PROGRESS_KEY]) {
    progressCache = changes[PROGRESS_KEY].newValue || {};
    // Step 21: a fresh scrape may carry the title an unnamed pasted-playlist
    // topic is waiting to adopt (write-guarded; converges in one write).
    adoptScrapedTopicNames();
    renderLearningHome();
    // Step 23: a fresh scrape can change the watch page's in-topic match, the
    // strip's "Lecture N of M" position, or the deterministic next — re-run
    // the room tick (stamps/clears data-ytr-room and re-renders the strip).
    // Step 25: route-gate the re-arm — a progress write fires this onChanged in
    // EVERY open tab; only a /watch tab has a room to update, so a home/search
    // tab no longer spins up a (no-op) room retry on every scrape tick.
    if (location.pathname === "/watch") roomTickWithRetry();
    return;
  }
  // Read state lives in storage.local: refresh + re-apply so reading a video in
  // one tab dims its row in another tab live (dimming is the only signal — no
  // count is derived from this).
  if (area === "local" && changes[READ_KEY]) {
    readCache = changes[READ_KEY].newValue || {};
    refreshSubsReadState();
    return;
  }
  // Step 15: archived state lives in storage.local: refresh + re-apply so
  // archiving a row in one tab removes it from another tab's inbox live.
  if (area === "local" && changes[ARCHIVED_KEY]) {
    archivedCache = changes[ARCHIVED_KEY].newValue || {};
    refreshSubsArchived();
    return;
  }
  // (Step 23: the `notes` onChanged branch is gone with the notes code path.)
  if (area === "sync" && changes[SETTINGS_KEY]) {
    const prev = changes[SETTINGS_KEY].oldValue || {};
    const next = changes[SETTINGS_KEY].newValue || DEFAULT_SETTINGS;
    // Field-diff (Step 25 churn-reduction): mutateTopics / mutateStars / the
    // popup each rewrite the WHOLE settings object, so onChanged fires for any
    // of them. Re-running the entire cross-surface fan-out on a single star
    // rating or card drag is wasted work (×every open tab). Diff the fields and
    // touch ONLY the surface whose field moved. JSON compare errs toward a
    // spurious re-decorate (a key reorder) but NEVER toward staleness (different
    // content always serializes differently), so it can't drop a real change.
    const masterChanged = !!prev.masterEnabled !== !!next.masterEnabled;
    const topicsChanged =
      JSON.stringify(prev.topics || []) !== JSON.stringify(next.topics || []);
    const starsChanged =
      JSON.stringify(prev.stars || {}) !== JSON.stringify(next.stars || {});
    // v1.1 field diffs.
    const togglesChanged =
      JSON.stringify(prev.toggles || {}) !== JSON.stringify(next.toggles || {});
    const blockedChanged =
      JSON.stringify(prev.blockedCreators || {}) !==
      JSON.stringify(next.blockedCreators || {});

    // Keep the live mirrors fresh no matter which field moved (read when master
    // flips back on, and by the lazily-built Save-to-topic menus).
    topicsCache = Array.isArray(next.topics) ? next.topics : [];
    topicsSeeded = true;
    starsCache =
      next.stars && typeof next.stars === "object" ? next.stars : {};
    // v1.1 mirrors: refresh + re-stamp the show-* attrs / remembered Peek view /
    // blocklist on every settings write (cheap, and keeps cross-tab tabs honest).
    togglesCache = readToggles(next);
    applyToggles();
    blockedCache =
      next.blockedCreators && typeof next.blockedCreators === "object"
        ? next.blockedCreators
        : {};
    // Patch 2: the speed step is a plain mirror — the next − / + press uses it.
    // Nothing on screen shows the step, so there is nothing to re-render.
    speedStep = readSpeedStep(next);
    // Patch 3: the hotkeys are mirrors too — a rebind in the popup is live on
    // the next keystroke, with nothing on screen to re-render.
    syncSpeedKeys(next);
    const nextView = next.peekView === "list" ? "list" : "grid";
    if (nextView !== peekView) {
      peekView = nextView;
      document.documentElement.setAttribute("data-ytr-peek-view", peekView);
      // Cross-tab: a view flip in another tab must re-run this tab's home pass
      // (read-dimming stamps are List-only). No-op off home. The acting tab
      // already ran this in setPeekView and skips here (its peekView is already
      // updated -> nextView === peekView).
      decorateHomeWithRetry();
    }

    if (masterChanged) {
      // Master toggled: the full cross-surface fan-out, exactly as before.
      apply(next.masterEnabled);
      // Master ON re-stamps the remembered-view attr the seed only sets while on.
      if (reworkEnabled)
        document.documentElement.setAttribute("data-ytr-peek-view", peekView);
      // Turning the rework on while sitting on a Short should bounce immediately.
      redirectShorts();
      // Master OFF: drop the injected Subscriptions header + clear the VIP filter
      // + the Peek reveal so nothing lingers / leaks once the rework is gone.
      if (!reworkEnabled) {
        removeSubsHeader();
        setVipFilter(false);
        setPeek(false);
        // Clear the remembered-view stamp too (setPeek only drops data-ytr-peek)
        // so master-off leaves no data-ytr-* on <html>. (data-ytr-route is not
        // listed here on purpose: apply() above already dropped it, and re-adds
        // it on master-on — one owner for that attribute, not two.)
        document.documentElement.removeAttribute("data-ytr-peek-view");
        // Master-off is plain YouTube: strip every remaining data-ytr-* element
        // stamp (block/chan/vid/read + the Subscriptions flags) so nothing is
        // left behind. The decorate passes early-return while off and wouldn't
        // otherwise clear these; all are re-applied on master-on. (Session O:
        // the search-only stamps are gone with the search code; Session S took
        // the last two — block + shorts-section — off /results as well.)
        const STAMPS = [
          "data-ytr-blocked", "data-ytr-chan", "data-ytr-vid", "data-ytr-read",
          "data-ytr-mailrow", "data-ytr-star", "data-ytr-archived",
        ];
        document
          .querySelectorAll(STAMPS.map((a) => "[" + a + "]").join(","))
          .forEach((el) => STAMPS.forEach((a) => el.removeAttribute(a)));
        closeOverflowMenus();
        // …and our row inside YouTube's own ⋮ menu, if one is open right now —
        // plus the popup observer itself (Session P): master off means we stop
        // watching, not just stop injecting.
        removeNativeBlockItem();
        unwireNativeBlockMenu();
        // Session M: …and the playlist header's "＋ Add to LearnTube" button
        // (+ its panel and dismiss listeners). Master off = plain YouTube.
        removePlaylistAdd();
      }
      // Master back ON: the popup observer refuses to wire while off, so ask
      // for it again here (idempotent — it no-ops once wired).
      wireNativeBlockMenuWithRetry();
      // Session M: master back ON re-injects the playlist-header button (the
      // retry no-ops off /playlist).
      mountPlaylistAddWithRetry();
      mountLearningHome();
      renderLearningHome();
      decorateSubscriptionsWithRetry();
      decorateHomeWithRetry();
      // Master back ON re-seeds the block stamps on the surfaces that have no
      // decorate pass of their own (watch sidebar, grid shelves). No-op on
      // /results by decree.
      reapplyBlockedSweep();
      roomTickWithRetry();
      refreshSubsReadState();
      refreshSubsArchived();
      refreshSubsStars();
      // Session Q: the seed-time backfill refuses to run while master is off (it
      // would burn its one shot on no-op fetches), so ask again on the way back
      // in. Idempotent — backfillRan makes every later call a no-op.
      backfillMissingPlaylistScrapes();
      return;
    }

    // Master unchanged -> refresh ONLY the surface whose field actually moved.
    if (togglesChanged) {
      // S1 (hideShorts) gates the /shorts redirect; a flip can free a Short.
      redirectShorts();
      // S6 (replaceHome) mounts or tears down the Library; S6 off resets Peek.
      // Turning the "Show feed button" (showFeed) off also closes an open Peek —
      // once the pill is gone there'd be no in-view way to dismiss the feed.
      if (peekOn && (togglesCache.replaceHome === false || togglesCache.showFeed === false))
        setPeek(false);
      mountLearningHomeWithRetry();
      renderLearningHome();
      // S2 (hideWatchSuggestions) gates the centered player — only on /watch.
      // Patch 2: the same tick mounts / tears down the speed control (and its
      // teardown puts the rate back to 1×), so speedButtons rides this line too.
      // Ungated (any page, not just /watch): a switch-off's teardown/hard-reset
      // has to run wherever the toggle was flipped from — roomTick is a cheap
      // no-op off /watch, but a still-armed speed (or a still-mounted strip)
      // needs its disarm to fire immediately rather than waiting for a /watch
      // return.
      roomTickWithRetry();
      // S6-off native feed needs its blocked stamps; the surface itself moved.
      decorateHomeWithRetry();
    }
    if (blockedChanged) {
      // Re-stamp data-ytr-blocked live wherever recommendations render (cross
      // tab + the popup's ✕ unblock). The sweep survives the single-channel
      // search reflow the same way the local block path does.
      reapplyBlockedSweep();
    }
    if (topicsChanged) {
      // A delete-topic may have orphaned a scraped record.
      pruneOrphanProgress();
      // The Library reflects the new topic set / order.
      mountLearningHome();
      renderLearningHome();
      // The Lecture's in-topic match / Back label / next can move with a topic
      // edit, but only matters on a /watch page — route-gate the re-arm so a
      // home/search tab doesn't spin the room retry on every cross-tab edit.
      if (location.pathname === "/watch") roomTickWithRetry();
      // Session M: a filing here (or in another synced tab) flips the playlist
      // header's button between "＋ Add to LearnTube" and "✓ In your Library".
      // Cheap no-op off /playlist (the wrap only exists there). An OPEN panel is
      // re-rendered too, so a topic deleted/added elsewhere can't be offered by
      // a stale row (skipped while its new-topic input is showing).
      refreshPlaylistAddButton();
      rebuildPlaylistPanel();
      // Save-to-topic menus rebuild from topicsCache on next open — no decorate.
    }
    if (starsChanged) {
      // Stars update the glyphs + data-ytr-star (VIP keys on it). The acting tab
      // already refreshed synchronously in setChannelStars, so skip its own echo;
      // other tabs (latch unset) refresh here.
      if (starsSelfWrite) starsSelfWrite = false;
      else refreshSubsStars();
    }
  }
});
