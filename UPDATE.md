# Updating LearnTube

The repeatable loop for shipping a new version to the Chrome Web Store.

## 1. Make the change
Edit the runtime files (`content.js`, `subscriptions-list.css`, `popup.*`, `manifest.json`).
Test locally: `chrome://extensions` → click **reload (↻)** on the unpacked extension → refresh YouTube.

## 2. Bump the version
In `manifest.json`, raise `"version"` — e.g. `1.0.0` → `1.0.1` for a fix, `1.1.0` for a feature.
The store **rejects** an upload whose version isn't higher than the live one.

## 3. Rebuild the ZIP
From the repo root, package **only** the runtime set (replace `<version>`):

```sh
rm -f learntube-<version>.zip
zip -rq learntube-<version>.zip manifest.json content.js subscriptions-list.css popup.html popup.js icons -x "*.DS_Store"
unzip -l learntube-<version>.zip   # sanity check: exactly the 6 runtime items, nothing else
```

## 4. Test the ZIP unpacked
Unzip to a temp folder → **Load unpacked** → walk the key flows: master toggle, Library home,
Subscriptions inbox (stars / VIP / overflow), a course view, a topic watch page (centered player +
focus strip), the `/shorts/` redirect, and **master OFF restores native YouTube**.

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

Keep `README.md` and `PRIVACY.md` in sync whenever behavior or permissions change.
