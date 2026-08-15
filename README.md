# LearnTube

**Turn YouTube into a calm place to learn.** LearnTube is a tiny, open-source
Manifest V3 extension for Chromium browsers that strips the distractions out of
YouTube and reshapes it into a focused study tool — from one master on/off
switch, with a per-surface switch for any piece you want handed back.

> No build step, no dependencies, no tracking. The source files in this
> repository *are* the shipped extension.

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/jejlhdamaodimmhcomnihmepididhbde?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/jejlhdamaodimmhcomnihmepididhbde)

**[➜ Install LearnTube from the Chrome Web Store](https://chromewebstore.google.com/detail/jejlhdamaodimmhcomnihmepididhbde)**

## Features

- **One master switch.** Click the toolbar icon to toggle the entire rework on
  or off. Off means plain, untouched YouTube — instantly.
- **A switchboard of eight switches.** Under the master switch, the popup gives
  you a switch per distraction — **Hide Shorts**, **Hide watch suggestions**,
  **Hide comments**, **Hide end screens & cards**, **Simplify the top bar**,
  **Replace Home with your Library**, **Show feed button**, and **Start on
  Subscriptions**. Each hide hands that piece of YouTube back to native when you
  flip it off; **Show feed button** and **Start on Subscriptions** switch off
  LearnTube's own additions instead. The defaults are the classic LearnTube 1.0
  experience plus the feed button.
- **Shorts, gone.** Shorts shelves, tiles, and the sidebar entry are hidden
  site-wide, and any `/shorts/*` link is redirected to the normal player (Back
  won't bounce you into a Short). Flip **Hide Shorts** off and Shorts return.
- **Subscriptions as an inbox.** Your Subscriptions feed becomes a compact,
  two-line text list (channel name above, title below). Videos you've opened
  dim like read mail, you can star creators, filter to your VIPs, and save a
  video to a learning topic — all without leaving the page.
- **A Learning home — with Peek.** The recommendation-stuffed home page is
  replaced with your own library: add YouTube playlists as "topics" — either
  from the popup or with the **＋ Add to LearnTube** button LearnTube adds to
  the playlist page's own header — and LearnTube tracks how far through each
  one you are, with a quiet "Continue where you left off" row and a per-course
  lecture checklist. Adding a topic hydrates it right away with a background
  fetch of the playlist's own page, so the title, lecture count, and order show
  up immediately; that first fetch only reads the playlist's initial batch of
  lectures (typically the first ten to seventeen), so a long course fills in
  the rest — and picks up real watch progress — the first time you actually
  open it. Progress is otherwise read off YouTube's own resume bars, and you
  can tick (or un-tick) a lecture by hand when the scrape and reality disagree.
  Press **Show feed** to reveal, on request, exactly what the algorithm would
  have shown you — underneath your topics, in a calm two-line List or a Grid
  view (your choice is remembered). It's display-only; peeking never feeds the
  algorithm.
- **Block a channel for good.** Open a video's ordinary **⋮** menu — YouTube's
  own, on a home or Peek card, or the watch page's sidebar — and pick
  **🚫 Block this channel**. That creator's videos then leave everywhere
  recommendations render: both Peek views, the native home feed, the
  watch-page sidebar and grid shelves. Blocks sync across your devices;
  unblock from the popup's Blocked list. Blocking is context-aware, so it
  never hides rows inside a playlist or course, on the watch-page queue, on
  your own Subscriptions feed, or on a channel's own page — those are always
  left alone, and the search results page is left alone too (see below).
- **Fewer distractions everywhere.** Watch-page "up next" suggestions, comments,
  and end-screen cards are removed — on a lecture inside one of your topics, an
  **Up next ▾** pill brings back just the coming lectures' titles on demand,
  and a **← Previous lecture** pill sits alongside it so you can step back
  without leaving the focus strip — and the masthead is reclaimed down to
  [logo · search · account].
- **Search is left alone.** LearnTube doesn't touch the results page at
  all — no lens, no toolbar, no restyle, and no hiding — so you get YouTube's
  own search, at YouTube's own speed. Shorts shelves still show there and
  blocked channels can still appear there; blocking and Shorts-hiding apply
  everywhere else.

Everything is display-only: LearnTube **never reorders your feed or touches
YouTube's recommendation algorithm.** It only hides, restyles, and adds its own
calm UI on top.

## Install

**[Install from the Chrome Web Store →](https://chromewebstore.google.com/detail/jejlhdamaodimmhcomnihmepididhbde)** — click **Add to Chrome** and you're set.

Prefer to run it from source? Load it unpacked:

1. **Download this repository** — clone it, or download the ZIP and unzip it
   somewhere permanent (don't delete the folder later; the browser loads the
   extension from this location).
2. Open your browser's extensions page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
   - Brave: `brave://extensions`
3. Turn on **Developer mode** (toggle in the top-right on Chrome/Brave, in the
   left sidebar on Edge).
4. Click **Load unpacked** and select this project folder (the one containing
   `manifest.json`).
5. Open <https://www.youtube.com/feed/subscriptions> and you're set.

Click the LearnTube toolbar icon any time to flip the master switch.

## Privacy

LearnTube is private by design:

- **No data is collected, sold, or shared.** There are no servers, no
  analytics, and no accounts.
- **All state lives on your device** in the browser's `chrome.storage` (your
  settings — the switches, your topics, stars, and your blocked-channel list —
  sync via your own browser account if you have sync on; watched progress,
  lecture ticks, and read/archived state stay local). **Nothing is ever sent
  off-device by the extension.**
- **No remote code.** The extension runs only the JavaScript and CSS bundled in
  this folder — nothing is ever downloaded and run. The one network call it
  makes itself is a same-origin fetch of a YouTube playlist page you've just
  added, to read that playlist's own public title/lecture data; see
  [PRIVACY.md](PRIVACY.md) for details.

See [PRIVACY.md](PRIVACY.md) for the full policy.

## How it works

- `content.js` runs at `document_start` and toggles a single CSS class on the
  page's `<html>` element. Because `<html>` is never replaced during YouTube's
  single-page navigation, that class — and therefore the whole reskin —
  survives moving between pages without polling or re-injection. The script also
  handles the few jobs CSS can't: the `/shorts/*` redirect, the injected
  Learning home, the Subscriptions inbox controls, and reading your
  watched-progress off the page.
- `subscriptions-list.css` does all the visual work. Rules are either
  **page-scoped** (reshaping the layout of one page) or **site-wide** (hiding
  distractions everywhere). Switch the master off and the class disappears, so
  nothing matches and plain YouTube returns.

## Permissions

- `storage` — to save your settings and progress on your device.
- Access to `https://www.youtube.com/*` — so the content script can restyle
  YouTube. The extension runs on YouTube and nowhere else.

## If it ever breaks

YouTube periodically renames its internal page elements, which is the most
likely cause of a silent break (e.g. Subscriptions reverting to its default
layout). Open the affected page, right-click the element → **Inspect**, and
check whether the tag/id names still match those in `subscriptions-list.css`.
Update what changed, then click **reload** (↻) on the extension and refresh the
page. Issues and pull requests are welcome.

## License

[MIT](LICENSE) © 2026 Jenish Shobhit
