# Privacy Policy — LearnTube

**Last updated: 2026**

LearnTube is a browser extension that reworks the YouTube interface locally in
your browser. It is built to be private by design.

## Data collection

**LearnTube does not collect any data.** It has no servers, no analytics, no
tracking, and no accounts. Nothing you do is reported to the developer or to
any third party.

## Data sold or shared

**None.** No data is ever sold, shared, or transferred to anyone.

## What the extension stores, and where

LearnTube keeps a small amount of state so your settings and progress persist
between visits. All of it is stored **on your device** using the browser's
standard `chrome.storage` API:

- **`chrome.storage.sync`** — your settings: the master on/off switch, the
  topics/playlists you add to the Learning home, and your per-creator star
  ratings. (If you are signed in to your browser, the browser itself may sync
  this small settings object across your own devices — this is the browser's
  built-in sync, handled entirely by the browser, never by LearnTube or any
  LearnTube server.)
- **`chrome.storage.local`** — device-local cache: which videos you have opened
  ("read" state), watched-progress for the playlists you track, and which
  Subscriptions rows you have archived.

This data never leaves the browser. It is sent to no external service and is
used only to render the extension's own UI.

## Network requests

LearnTube makes **no network requests of its own** and loads **no remote
code**. It runs only the JavaScript and CSS bundled inside the extension. The
only network activity on the page is YouTube's own — exactly as it would be
without the extension installed.

## Permissions

- **`storage`** — to save the settings and cache described above, on your
  device.
- **Host access to `https://www.youtube.com/*`** — so the extension's content
  script can restyle YouTube pages. The extension runs on YouTube and nowhere
  else.

## Removing your data

Uninstalling the extension removes its locally stored data. You can also turn
everything off at any time with the master switch in the extension popup, which
restores plain YouTube without uninstalling.

## Contact

Questions about this policy can be raised as an issue on the project's public
repository.
