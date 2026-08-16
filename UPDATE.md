# Updating LearnTube

The repeatable loop for shipping a new version to the Chrome Web Store.

## 1. Make the change
Edit the runtime files (`content.js`, `subscriptions-list.css`, `popup.*`, `manifest.json`).
Test locally: `chrome://extensions` → click **reload (↻)** on the unpacked extension → refresh YouTube.

## 2. Bump the version
In `manifest.json`, raise `"version"` — e.g. `1.1.0` → `1.1.1` for a fix, `1.2.0` for a feature.
The store **rejects** an upload whose version isn't higher than the live one.

## 3. Rebuild the ZIP
From the repo root, package **only** the runtime set (replace `<version>`):

```sh
rm -f learntube-<version>.zip
zip -rq learntube-<version>.zip manifest.json content.js subscriptions-list.css popup.html popup.js icons -x "*.DS_Store"
unzip -l learntube-<version>.zip   # sanity check: exactly the 6 runtime items, nothing else
```

## 4. Test the ZIP unpacked
Unzip to a temp folder → **Load unpacked** → walk the key flows: master toggle, every per-surface
switch (each hide off hands that piece back to native YouTube; the feed-button and start-page
switches turn off LearnTube's own additions), truly native search (zero LearnTube DOM/CSS on
`/results` — results load at YouTube's own speed, blocked channels can still appear there, and the
**⋮** menu offers no Block row there; the one exception is the Shorts switch — with it on, Shorts
shelves and Shorts results are hidden there too via pure CSS), Library home, **Show
feed** (Peek) in both List and Grid, **⊘ Block channel** from YouTube's own **⋮** menu on a home or
Peek card / watch-page sidebar (and confirm it's a no-op inside a playlist, on Subscriptions, and
on a channel's own page) plus unblock from the popup's Blocked list, adding a playlist via the popup
or the playlist page's **＋ Add to LearnTube** button and checking it hydrates title/lectures right
away, Subscriptions inbox (stars / VIP / overflow), a course view (including a manual lecture tick /
un-tick), a topic watch page (centered player + focus strip, **Up next ▾** and **← Previous lecture**),
the `/shorts/` redirect, the speed control (on a plain video AND a course lecture: **+**
to 4×, **−** to 0.25×, click the readout to reset to 1×, confirm the speed survives going
Library → another video, then flip the popup switch off and confirm the control disappears),
and **master OFF restores native YouTube**.

## 5. Upload the update
Developer Dashboard → **LearnTube** → **Package** → **Upload new package** → fill anything new in the
listing → **Submit for review**. (The manifest `description` field max is **132 characters**.)

## 6. Tag the release on GitHub
Commit the version bump, then:

```sh
git push origin main
git tag v<version>
git push origin v<version>
gh release create v<version> --title "v<version>" --notes "What changed in this version."
```

Keep `README.md` and `PRIVACY.md` in sync whenever behavior or permissions change — and add the new
surface to the dropdown in `.github/ISSUE_TEMPLATE/layout-breakage.yml` if the release adds one.

## Shipped so far

- **[v1.1.0 — The Switchboard](https://github.com/Jenish-Shobhit/learntube/releases/tag/v1.1.0)**
  (7 July 2026, live on the store) — the popup becomes a switchboard: a master switch plus a
  per-surface switch for each hide (Shorts, watch suggestions, comments, end screens & cards, the
  top bar, Home → Library) plus the **Show feed button** and **Start on Subscriptions** switches. Adds **Show feed**
  (Peek) — the real feed on request, as a List or a Grid, remembered but never reordered — and
  **⊘ Block channel**, then living on a custom search/Peek ··· menu (moved into YouTube's own **⋮**
  menu in v1.2), unblockable from the popup's Blocked list.
  Plus monotonic course progress, manual lecture ticks, overflow menus on lazily loaded rows,
  light-mode Peek fixes, and a Continue-first centered Library.
- **[v1.0.0](https://github.com/Jenish-Shobhit/learntube/releases/tag/v1.0.0)** (18 June 2026) —
  first public release: the master switch, Shorts removal and `/shorts/` redirect, the Subscriptions
  inbox, the Learning home, and the distraction-free watch page.
