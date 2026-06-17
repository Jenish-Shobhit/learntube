/// Runs at document_start on every youtube.com page.
// It only adds a class to <html>; all the actual work is in the CSS.
// <html> is never replaced during YouTube's SPA navigation, so the class
// (and therefore the rework) survives moving between pages.

// All durable state lives in a single chrome.storage.sync object under
// SETTINGS_KEY. masterEnabled is the master on/off switch. Future steps add
// more fields to this object (block toggles, topics, stars, …) without
// reshaping it. Default is master ON.
const SETTINGS_KEY = "settings";
const DEFAULT_SETTINGS = { masterEnabled: true };
// Legacy key from the old "Subscriptions — List View" build; migrated once.
const LEGACY_KEY = "listModeEnabled";

// Live copy of the master-enabled state, used by the Shorts route redirect so
// toggling the switch off also stops redirecting. apply() keeps it in sync.
let reworkEnabled = false;

function apply(enabled) {
  reworkEnabled = !!enabled;
  document.documentElement.classList.toggle("yt-rework", reworkEnabled);
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
      if (chrome.runtime.lastError) {
        console.warn("[yt-rework] topics write failed:", chrome.runtime.lastError);
      }
      // Optional completion hook (used by adoptScrapedTopicNames' in-flight
      // latch); runs on success or failure so the latch always clears.
      if (done) done();
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
// merge below never blanks a known value. No render consumes these yet; this
// capability unlocks the later Library/Course/Lecture rebuilds.

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

// Shared duration-overlay reader: playlist rows and search results use the same
// time-status overlay. Old Polymer overlay + Wiz badge-shape fallbacks (the
// exact Step-16 selector chain — resultDurationSeconds routes through here).
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
      (x.duration || "") !== (y.duration || "")
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
    const merged = [];
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

// Drop progress records for playlists no longer referenced by ANY topic. The
// delete-topic / remove-playlist paths only edit settings.topics — neither
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

// Join the progress cache against a topic's playlists: percentage = watched /
// total known, and the first unwatched video (in playlist order) for resume.
// `resuming` is true when that first-unwatched video is partially watched
// (ratio > 0) — currently unconsumed (the Step-12 hint that read it is gone);
// kept as an additive derived field. Extra keys are additive; callers ignore
// what they don't use.
function topicProgress(topic) {
  const playlists = Array.isArray(topic.playlists) ? topic.playlists : [];
  let total = 0;
  let watched = 0;
  let next = null; // { videoId, listId }
  let resuming = false;
  playlists.forEach((pl) => {
    const rec = progressCache[pl.id];
    const vids = rec && Array.isArray(rec.videos) ? rec.videos : [];
    vids.forEach((v) => {
      total += 1;
      if (v.watched) watched += 1;
      else if (!next) {
        next = { videoId: v.id, listId: pl.id };
        resuming = v.ratio > 0;
      }
    });
  });
  const pct = total > 0 ? Math.round((watched / total) * 100) : 0;
  return { pct, watched, total, next, resuming };
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

// Per-playlist watched-state from the local cache: title (if scraped), counts,
// percentage, and the first unwatched video id (for a per-playlist resume).
function playlistProgress(plId) {
  const rec = progressCache[plId];
  const vids = rec && Array.isArray(rec.videos) ? rec.videos : [];
  let watched = 0;
  let next = null;
  vids.forEach((v) => {
    if (v.watched) watched += 1;
    else if (!next) next = v.id;
  });
  const total = vids.length;
  return {
    title: (rec && rec.title) || "",
    total,
    watched,
    pct: total > 0 ? Math.round((watched / total) * 100) : 0,
    next,
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
        if (!v.watched && v.ratio > 0) return ctx(t, pls[j].id, v);
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
    return;
  }

  const head = makeEl("div", { className: "ytr-head" });
  head.append(makeEl("h1", { className: "ytr-title", text: "Library" }));
  head.append(
    makeEl("p", { className: "ytr-subtitle", text: overallSummary() })
  );
  root.append(head);

  // The quiet Continue row — hidden when nothing resolves (null).
  const cont = renderContinue();
  if (cont) root.append(cont);

  // The one card grid, always closed by the add-tile.
  const grid = makeEl("div", { className: "ytr-grid" });
  topicsCache.forEach((t) => grid.append(renderTopicCard(t)));
  grid.append(renderAddTile());
  root.append(grid);
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
function renderLecture(video, listId) {
  const row = makeEl("a", {
    className: "ytr-lec" + (video.watched ? " is-done" : ""),
  });
  row.href = resumeUrl({ videoId: video.id, listId }); // a URL only — never innerHTML

  const mark = makeEl("span", {
    className: "ytr-lec-mark",
    attrs: { "aria-hidden": "true" },
  });
  if (video.watched) {
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
    mutateTopics((s) => {
      s.topics.push({
        id: newTopicId(),
        name: "", // adopted from the scraped playlist title — never invented
        playlists: [{ id }],
        videos: [],
      });
    });
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
    mutateTopics((s) => {
      const t = s.topics.find((x) => x.id === topicId);
      if (!t) return;
      t.playlists = Array.isArray(t.playlists) ? t.playlists : [];
      if (!t.playlists.some((p) => p.id === id)) t.playlists.push({ id });
    });
    if (input) input.value = "";
    showErr(el, "");
    return;
  }

  // Currently un-triggered on the Library (the Desk's playlist rows left in
  // Step 21); kept for the Step-22 course-view module management.
  if (action === "remove-playlist") {
    const chip = el.closest("[data-pl-id]");
    const plId = chip && chip.getAttribute("data-pl-id");
    if (!plId) return;
    mutateTopics((s) => {
      const t = s.topics.find((x) => x.id === topicId);
      if (t && Array.isArray(t.playlists))
        t.playlists = t.playlists.filter((p) => p.id !== plId);
    });
    return;
  }

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

// (Step 22: onLearningFocusOut — the per-lecture note save — is gone with the
// course view's note inputs. The watch rail's own note path survives until
// step 23.)

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
// vertical midpoint (robust for both the stacked playlist list and the grid).
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
}

function mountLearningHome() {
  // Master off, or not on the home route → ensure no stray root remains.
  const browse = homeBrowse();
  if (!reworkEnabled || !browse) {
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
    return !!document.getElementById(LEARNING_ROOT_ID); // mounted -> stop early
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
      const vid = subsRowVideoId(row, null);
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

// --- Step 16: Find — clean search + learning lens ----------------------------
// Search (/results) is reshaped the same CSS-first way as Subscriptions: section
// 14 hides Shorts results/shelves/chip + collapses their reflow gaps, and (when
// the lens is ON) hides sub-threshold clips. This JS does only what CSS can't:
// (1) parse each result's on-page duration into a data-ytr-short-clip flag the
// lens CSS keys on, (2) stamp the "Shorts" filter chip so CSS can hide it,
// (3) inject the lens toggle + the per-row overflow control, (4) run the
// capture-phase delegated click. No Data API — duration comes from the overlay
// text. All master-gated; no-op off /results.
const SHORT_CLIP_MAX_SECONDS = 180; // hide clips under 3 min when the lens is on
const SEARCH_FLAG = "data-ytr-search"; // one-shot per-row idempotency flag

function searchRoot() {
  return document.querySelector("ytd-search");
}

// Parse a duration label ("12:34", "1:02:03", "0:48") to integer seconds.
// Returns null for empty / non-numeric (live, upcoming, mixes, playlists, or a
// non-time badge) — null is NEVER stamped, so those are never hidden by the lens.
function parseDurationToSeconds(text) {
  const s = (text || "").trim();
  if (!s || !/^\d{1,2}(:\d{2}){1,2}$/.test(s)) return null;
  const parts = s.split(":").map((n) => parseInt(n, 10));
  if (parts.some((n) => Number.isNaN(n))) return null;
  let secs = 0;
  for (const p of parts) secs = secs * 60 + p;
  return secs;
}

// Read a result's duration overlay text -> seconds (or null). The overlay
// selectors live in the shared durationLabelTextFor (Step 19 — playlist rows
// use the same overlay). Fail-quiet on drift (null -> not stamped).
function resultDurationSeconds(renderer) {
  return parseDurationToSeconds(durationLabelTextFor(renderer));
}

// Resolve a result's video id from its title/thumbnail link (reuses
// videoIdFromHref -> strips &list=/&t=). Fail-quiet: null -> not saved.
function searchRowVideoId(renderer) {
  const a =
    renderer.querySelector("a#video-title[href]") ||
    renderer.querySelector("a#thumbnail[href]") ||
    renderer.querySelector('a[href*="watch"]');
  return videoIdFromHref(a && a.getAttribute("href"));
}

// --- Lectures lens (display-only view filter, session state) -----------------
// Mirrors the VIP filter: OFF by default (calm), flips data-ytr-lens on <html>;
// CSS section 14c then hides [data-ytr-short-clip] results. Never reorders.
let lensFilterOn = false;

function setLensFilter(on) {
  lensFilterOn = !!on && reworkEnabled;
  document.documentElement.toggleAttribute("data-ytr-lens", lensFilterOn);
  const toggle = document.getElementById("ytr-lens-toggle");
  if (toggle)
    toggle.setAttribute("aria-pressed", lensFilterOn ? "true" : "false");
}

// --- Injected search toolbar (Lectures lens toggle) --------------------------
const SEARCH_TOOLBAR_ID = "ytr-search-toolbar";

function searchToolbarMountTarget(root) {
  return (
    root.querySelector("ytd-section-list-renderer #contents") ||
    root.querySelector("#contents") ||
    root
  );
}

function mountSearchToolbar(root) {
  root = root || searchRoot();
  if (!root) return;
  if (document.getElementById(SEARCH_TOOLBAR_ID)) return; // idempotent
  const host = searchToolbarMountTarget(root);
  if (!host) return;

  const bar = document.createElement("div");
  bar.id = SEARCH_TOOLBAR_ID;

  const lens = document.createElement("button");
  lens.id = "ytr-lens-toggle";
  lens.type = "button";
  lens.className = "ytr-lens-toggle";
  lens.dataset.lensToggle = "1";
  lens.textContent = "◎ Lectures"; // static label -> textContent (doc glyph)
  lens.title = "Courses & talks over 3 minutes · Shorts hidden";
  lens.setAttribute("aria-pressed", lensFilterOn ? "true" : "false");
  bar.appendChild(lens);

  // The quiet hint beside the pill (Step 24 — doc's .find-hint). Static text;
  // visibility is PURE CSS keyed on the data-ytr-lens html attribute that
  // setLensFilter flips (shown only while the lens is ON), so no JS show/hide
  // state can ever desync across SPA nav / tabs / master-off.
  const hint = document.createElement("span");
  hint.className = "ytr-find-hint";
  hint.textContent = "Courses & talks over 3 minutes · Shorts hidden";
  bar.appendChild(hint);

  host.insertBefore(bar, host.firstChild);
}

function removeSearchToolbar() {
  const bar = document.getElementById(SEARCH_TOOLBAR_ID);
  if (bar) bar.remove();
}

// Stamp the "Shorts" filter chip so CSS section 14a can hide it. CSS can't
// text-match, so JS marks the chip whose label trims to "Shorts". Idempotent.
function stampShortsChip(root) {
  root
    .querySelectorAll("yt-chip-cloud-chip-renderer:not([data-ytr-shorts-chip])")
    .forEach((chip) => {
      const label = (chip.textContent || "").trim().toLowerCase();
      if (label === "shorts") chip.setAttribute("data-ytr-shorts-chip", "1");
    });
}

// Returns true when settled (nothing changed + nothing pending), mirroring
// decorateSubscriptions, so the retry can stop early (#5). A result whose
// duration overlay hasn't hydrated (or is live/upcoming -> null) stays pending,
// so the lens flag is never skipped by an early exit.
function decorateSearch() {
  if (!reworkEnabled) return true; // master off -> plain YouTube (settled)
  const root = searchRoot();
  if (!root) return true; // off-page; the retry handles teardown

  stampShortsChip(root);

  let changed = false;
  let pending = false;
  const rows = root.querySelectorAll("ytd-video-renderer");
  if (rows.length === 0) pending = true; // results not hydrated yet
  rows.forEach((row) => {
    // Duration -> lens flag. Re-evaluate until a real duration is read (the
    // overlay hydrates late); only set the one-shot flag once we've parsed a
    // duration, so a too-early null read doesn't permanently skip the row.
    if (!row.getAttribute(SEARCH_FLAG)) {
      const secs = resultDurationSeconds(row);
      if (secs !== null) {
        if (secs > 0 && secs < SHORT_CLIP_MAX_SECONDS)
          row.setAttribute("data-ytr-short-clip", "1");
        row.setAttribute(SEARCH_FLAG, "1"); // parsed -> stop re-reading
        changed = true;
      } else {
        pending = true; // overlay not hydrated (or live/upcoming) -> re-read
      }
    }
    // Video id (best-effort) + overflow control — injected once.
    if (!row.getAttribute("data-ytr-vid")) {
      const vid = searchRowVideoId(row);
      if (vid) {
        row.setAttribute("data-ytr-vid", vid);
        changed = true;
      } else {
        pending = true;
      }
    }
    const meta =
      row.querySelector("#metadata-line") ||
      row.querySelector("#meta") ||
      row.querySelector("#details");
    if (!meta) {
      pending = true; // metadata line hydrates late -> overflow still to inject
    } else if (!meta.querySelector(".ytr-ovf")) {
      meta.appendChild(buildOverflowControl());
      changed = true;
    }
  });

  // Delegated capture-phase click, attached once (beat result navigation).
  if (!root.dataset.ytrSearchWired) {
    root.addEventListener("click", onSearchClick, true);
    root.dataset.ytrSearchWired = "1";
  }

  if (!document.getElementById(SEARCH_TOOLBAR_ID)) {
    mountSearchToolbar(root);
    if (document.getElementById(SEARCH_TOOLBAR_ID)) changed = true;
    else pending = true;
  }
  return !changed && !pending;
}

// Capture-phase delegated click for our injected search controls. Each branch
// handles its control and returns; native result clicks pass straight through.
function onSearchClick(e) {
  const t = e.target;
  if (!t || !t.closest) return;

  // 1. Lectures lens toggle.
  if (t.closest("[data-lens-toggle]")) {
    e.preventDefault();
    e.stopPropagation();
    setLensFilter(!lensFilterOn);
    return;
  }

  // 2. Overflow button -> toggle its menu (no Archive action on search).
  const ovfBtn = t.closest("[data-ovf-btn]");
  if (ovfBtn) {
    e.preventDefault();
    e.stopPropagation();
    const wrap = ovfBtn.closest(".ytr-ovf");
    const wasOpen = wrap.classList.contains("is-open");
    closeOverflowMenus();
    if (!wasOpen) {
      wrap.appendChild(buildOverflowMenu({ archive: false }));
      wrap.classList.add("is-open");
    }
    return;
  }

  // 3. Save-to-topic menu item -> save this result's video id (one click).
  const saveItem = t.closest("[data-ovf-save]");
  if (saveItem) {
    e.preventDefault();
    e.stopPropagation();
    const row = saveItem.closest("ytd-video-renderer");
    const vid = row && searchRowVideoId(row);
    addVideoToTopic(saveItem.dataset.ovfSave, vid);
    closeOverflowMenus();
    return;
  }

  // 4. Click elsewhere with a menu open -> close it (let native nav proceed).
  if (document.querySelector(".ytr-ovf.is-open")) closeOverflowMenus();
}

// Search hydrates late and lazy-loads more results on scroll: bounded retry on
// mount/nav (the flag makes re-runs cheap). Off search -> tear down our chrome.
const decorateSearchWithRetry = makeBoundedRetry(
  () => {
    if (!searchRoot()) {
      if (document.getElementById(SEARCH_TOOLBAR_ID) || lensFilterOn) {
        removeSearchToolbar();
        setLensFilter(false);
        closeOverflowMenus();
      }
      return true;
    }
    // "idle" once settled so the retry stops ~900ms after results stabilize;
    // false (keep ticking) while overlays/results still hydrate.
    return decorateSearch() ? "idle" : false;
  },
  300,
  4000,
  3
);

window.addEventListener("yt-rework:locationchange", decorateSearchWithRetry);
window.addEventListener("popstate", decorateSearchWithRetry);
window.addEventListener("yt-navigate-finish", decorateSearchWithRetry);

// --- Inbox read state (dim opened videos) ------------------------------------
// A video is "read" the moment it is OPENED (locked decision) — detected by
// reading the /watch route's v= id, not by intercepting clicks. Read state is a
// per-video-id map persisted in chrome.storage.LOCAL (large, device-local,
// re-derivable; the 8KB sync item cap would blow). CSS section 11e dims read
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
function subsRowVideoId(row, title) {
  const a =
    (title && title.matches && title.matches("a[href]") ? title : null) ||
    (title && title.querySelector && title.querySelector("a[href]")) ||
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
  if (location.pathname !== "/watch") return;
  let vid = null;
  try {
    vid = new URL(location.href).searchParams.get("v");
  } catch (_) {
    return;
  }
  if (!vid || readCache[vid]) return; // unknown or already read -> no write
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
// cycling the live <video>'s playbackRate, and a "Next lecture →" deep-link to
// the §4 deterministic next in this course. Nothing else: no second lecture
// rail, no notes, no Listen/Offline (killed non-goals — the Course page is the
// structured view; the watch page stays focused on the video). No Data API:
// watched-state is the Step-6 resume-bar scrape (storage.local.progress).
const FOCUS_STRIP_ID = "yt-rework-focus-strip";
const ROOM_SPEEDS = [1, 1.25, 1.5, 2];

// The <video> the player is using right now. Re-read each interaction (the
// player can swap the element across SPA nav / ad breaks). First match is the
// main player.
function roomVideoEl() {
  return document.querySelector("video");
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

// The §4 deterministic next lecture of THIS course: the first non-watched
// video in topic→playlist→video order — the very scan topicProgress(t).next
// (the Course Resume) makes — skipping only the lecture already on screen (a
// self-link is not a "next"). Document order, no time/random input, so the
// Library's Continue, the Course Resume, and this pill never disagree.
function courseNextLecture(ctx) {
  const cur = currentWatchVideoId();
  const pls = Array.isArray(ctx.topic.playlists) ? ctx.topic.playlists : [];
  for (let i = 0; i < pls.length; i++) {
    const rec = progressCache[pls[i].id];
    const vids = rec && Array.isArray(rec.videos) ? rec.videos : [];
    for (let j = 0; j < vids.length; j++) {
      const v = vids[j];
      if (!v.watched && v.id !== cur) {
        return { videoId: v.id, listId: pls[i].id };
      }
    }
  }
  return null;
}

// The current lecture's honest position across the course: 1-based index +
// total, in scrape order over the topic's playlists (the same order
// topicProgress counts in). Null when the current video isn't in the scraped
// lists (un-scraped module) — the label is then omitted, never fabricated.
function lecturePositionInCourse(ctx) {
  const cur = currentWatchVideoId();
  if (!cur) return null;
  let total = 0;
  let pos = null;
  const pls = Array.isArray(ctx.topic.playlists) ? ctx.topic.playlists : [];
  pls.forEach((pl) => {
    const rec = progressCache[pl.id];
    const vids = rec && Array.isArray(rec.videos) ? rec.videos : [];
    vids.forEach((v) => {
      total += 1;
      if (pos === null && v.id === cur) pos = total;
    });
  });
  return pos !== null ? { n: pos, total } : null;
}

// --- The room stamp (the data-ytr-vip pattern) --------------------------------
// CSS section 15a keys the #secondary collapse + player centering on
// html.yt-rework[data-ytr-room]; JS only flips the attribute. Guarded so the
// bounded retry's repeat ticks don't spam resize events: the player sizes its
// <video> in px from the column it sits in, so ONE nudge per actual change
// makes it re-measure the now-wider (or restored) column.
let roomActive = false;

function setRoomActive(on) {
  const next = !!on && reworkEnabled;
  if (next === roomActive) return;
  roomActive = next;
  document.documentElement.toggleAttribute("data-ytr-room", roomActive);
  window.dispatchEvent(new Event("resize"));
}

// Speed pill label: "1×", "1.25×", … (an off-list native rate shows as-is).
function speedLabel(rate) {
  return (rate === 1 ? "1" : String(rate)) + "×";
}

function removeFocusStrip() {
  const el = document.getElementById(FOCUS_STRIP_ID);
  if (el) el.remove();
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

// (Re)build the strip from the current context: Back · position · Speed ·
// Next. Wipes + rebuilds children (idempotent contents). Every dynamic string
// via textContent; every id only ever a link href / dataset value — never
// innerHTML.
function renderFocusStrip(ctx) {
  const strip = document.getElementById(FOCUS_STRIP_ID);
  if (!strip || !ctx) return;
  strip.dataset.topicId = ctx.topic.id; // for the Back handler — dataset only

  while (strip.firstChild) strip.removeChild(strip.firstChild);

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
  strip.append(left);

  // Right: the only two controls — Speed (the real playbackRate) and Next
  // lecture (a deep-link; simply absent when the course is complete).
  const right = makeEl("div", { className: "ytr-fs-right" });
  const v = roomVideoEl();
  right.append(
    makeEl("button", {
      className: "ytr-pill",
      text: speedLabel(v ? v.playbackRate : 1),
      attrs: {
        type: "button",
        "data-room-action": "speed",
        title: "Cycle playback speed (1× → 1.25 → 1.5 → 2×)",
      },
    })
  );
  const next = courseNextLecture(ctx);
  if (next) {
    const go = makeEl("a", {
      className: "ytr-pill ytr-pill-next",
      text: "Next lecture →",
    });
    go.href = resumeUrl(next); // a URL only — never innerHTML
    right.append(go);
  }
  strip.append(right);
}

// Delegated capture-phase click for the strip's two live pieces. Back lets
// the native <a href="/"> proceed (YouTube's router — or a hard load — does
// the navigation; we only arm the open-course hint). Speed re-reads the live
// <video> each click (the player can swap the element across SPA nav).
function onRoomClick(e) {
  const t = e.target;
  if (!t || !t.closest) return;

  const back = t.closest("[data-room-back]");
  if (back) {
    const strip = document.getElementById(FOCUS_STRIP_ID);
    armOpenCourseHint(strip && strip.dataset.topicId);
    return; // no preventDefault — the navigation IS the action
  }

  const btn = t.closest('[data-room-action="speed"]');
  if (btn) {
    e.preventDefault();
    e.stopPropagation();
    const v = roomVideoEl();
    if (!v) return;
    const idx = ROOM_SPEEDS.indexOf(v.playbackRate);
    const next = ROOM_SPEEDS[(idx + 1) % ROOM_SPEEDS.length]; // off-list → 1×
    v.playbackRate = next;
    btn.textContent = speedLabel(next);
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
    return true;
  }
  setRoomActive(location.pathname === "/watch");
  const ctx = resolveCourseContext();
  if (!ctx) {
    removeFocusStrip();
    return true; // not in a topic -> centered player, no strip
  }
  if (!mountFocusStrip()) return false; // #below not hydrated yet
  renderFocusStrip(ctx);
  return false; // keep ticking: progress / DOM may still settle
}

const roomTickWithRetry = makeBoundedRetry(roomTick, 300, 4000);

window.addEventListener("yt-rework:locationchange", roomTickWithRetry);
window.addEventListener("popstate", roomTickWithRetry);
window.addEventListener("yt-navigate-finish", roomTickWithRetry);

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
// CSS section 6j styles the glyphs; JS resolves each row's channel key, persists
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

// Build the dropdown menu for one row's overflow control. Save to topic (a list
// of the user's topics) and — on Subscriptions — Archive. All strings via
// textContent; topic ids ride in dataset only. opts.archive===false omits the
// Archive action (search results have no inbox to archive from); default keeps it
// so Subscriptions is unchanged.
function buildOverflowMenu(opts) {
  const withArchive = !(opts && opts.archive === false);
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
  if (withArchive) {
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
  }

  return menu;
}

// Close any open overflow menu and reset its control's pressed state.
function closeOverflowMenus(except) {
  document.querySelectorAll(".ytr-ovf.is-open").forEach((w) => {
    if (w === except) return;
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

  // 6. Click anywhere else inside the browse with a menu open -> close it (do
  // NOT swallow the click; let native navigation proceed).
  if (document.querySelector(".ytr-ovf.is-open")) closeOverflowMenus();
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
  // Seed the live topics cache before the first render.
  topicsCache = Array.isArray(settings.topics) ? settings.topics : [];
  topicsSeeded = true;
  // Drop progress records orphaned by a delete in a prior session (no-op if the
  // progress seed hasn't resolved yet; that callback re-runs the prune).
  pruneOrphanProgress();
  // Seed the live creator-stars cache before the first Subscriptions decorate.
  starsCache =
    settings.stars && typeof settings.stars === "object" ? settings.stars : {};
  // Catch a hard load that landed directly on a /shorts/* URL.
  redirectShorts();
  // Mount the Learning shell if we hard-loaded onto the home route (retry
  // because ytd-browse may not have hydrated yet).
  mountLearningHomeWithRetry();
  // Decorate Subscriptions if we hard-loaded straight onto /feed/subscriptions
  // (no-op elsewhere; bounded retry handles late hydration + lazy rows).
  decorateSubscriptionsWithRetry();
  // Decorate search if we hard-loaded straight onto /results (no-op elsewhere).
  decorateSearchWithRetry();
});

// Seed the progress + read + archived caches (storage.local) so the first
// render reflects stored state, scrape if we hard-loaded onto a playlist URL,
// and mark a hard load that landed straight on a /watch page as read.
chrome.storage.local.get(
  { [PROGRESS_KEY]: {}, [READ_KEY]: {}, [ARCHIVED_KEY]: {} },
  (res) => {
    progressCache = res[PROGRESS_KEY] || {};
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

    // Keep the live mirrors fresh no matter which field moved (read when master
    // flips back on, and by the lazily-built Save-to-topic menus).
    topicsCache = Array.isArray(next.topics) ? next.topics : [];
    topicsSeeded = true;
    starsCache =
      next.stars && typeof next.stars === "object" ? next.stars : {};

    if (masterChanged) {
      // Master toggled: the full cross-surface fan-out, exactly as before.
      apply(next.masterEnabled);
      // Turning the rework on while sitting on a Short should bounce immediately.
      redirectShorts();
      // Master OFF: drop the injected Subscriptions header + clear the VIP filter
      // so neither lingers / leaks once the rework is gone.
      if (!reworkEnabled) {
        removeSubsHeader();
        setVipFilter(false);
        removeSearchToolbar();
        setLensFilter(false);
        closeOverflowMenus();
      }
      mountLearningHome();
      renderLearningHome();
      decorateSubscriptionsWithRetry();
      decorateSearchWithRetry();
      roomTickWithRetry();
      refreshSubsReadState();
      refreshSubsArchived();
      refreshSubsStars();
      return;
    }

    // Master unchanged -> refresh ONLY the surface whose field actually moved.
    if (topicsChanged) {
      // A delete-topic / remove-playlist may have orphaned a scraped record.
      pruneOrphanProgress();
      // The Library reflects the new topic set / order.
      mountLearningHome();
      renderLearningHome();
      // The Lecture's in-topic match / Back label / next can move with a topic
      // edit, but only matters on a /watch page — route-gate the re-arm so a
      // home/search tab doesn't spin the room retry on every cross-tab edit.
      if (location.pathname === "/watch") roomTickWithRetry();
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
