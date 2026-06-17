# LearnTube

**Turn YouTube into a calm place to learn.** LearnTube is a tiny, open-source
Manifest V3 extension for Chromium browsers that strips the distractions out of
YouTube and reshapes it into a focused study tool — all with one master on/off
switch.

> No build step, no dependencies, no tracking. The source files in this
> repository *are* the shipped extension.

## Features

- **One master switch.** Click the toolbar icon to toggle the entire rework on
  or off. Off means plain, untouched YouTube — instantly.
- **Shorts, gone.** Shorts shelves, tiles, and the sidebar entry are hidden
  site-wide, and any `/shorts/*` link is redirected to the normal player (Back
  won't bounce you into a Short).
- **Subscriptions as an inbox.** Your Subscriptions feed becomes a compact,
  two-line text list (channel name above, title below). Videos you've opened
  dim like read mail, you can star creators, filter to your VIPs, and save a
  video to a learning topic — all without leaving the page.
- **A Learning home.** The recommendation-stuffed home page is replaced with
  your own library: add YouTube playlists as "topics" and LearnTube tracks how
  far through each one you are, with a quiet "Continue where you left off" row
  and a per-course lecture checklist.
- **Fewer distractions everywhere.** Watch-page "up next" suggestions, comments,
  and end-screen cards are removed, the masthead is reclaimed down to
  [logo · search · account], and search gains an optional "Lectures" lens that
  hides clips under three minutes.

Everything is display-only: LearnTube **never reorders your feed or touches
YouTube's recommendation algorithm.** It only hides, restyles, and adds its own
calm UI on top.

## Install

> A Chrome Web Store listing is in review. Once approved, the one-click link
> will go here: **[Chrome Web Store — coming soon](#)**

In the meantime (or if you'd rather run it from source), load it unpacked:

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
  settings sync via your own browser account if you have sync on; watched
  progress and read/archived state stay local). **Nothing is ever sent
  off-device by the extension.**
- **No remote code.** The extension runs only the JavaScript and CSS bundled in
  this folder — it loads nothing from the network.

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
