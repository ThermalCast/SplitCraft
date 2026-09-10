# SplitCraft

A weight-training tracker. Local-first, no account, no backend. Vanilla
HTML/CSS/JS with no build step and no runtime dependencies.

## Files

| file | required? | what it is |
| --- | --- | --- |
| `splitcraft.html` | **yes** | The entire application, built from `src/`. Works on its own. |
| `manifest.webmanifest` | optional | Makes it installable on Android/Chrome. |
| `sw.js` | optional | Service worker — offline support once installed. |
| `icons/*.png` | optional | Home-screen icons. Regenerate with `node tools/make-icons.mjs`. |
| `src/` | dev only | Source for `splitcraft.html` — edit here, not the built file. |
| `tools/build.mjs` | dev only | Concatenates `src/` into `splitcraft.html`. |
| `tools/make-icons.mjs` | dev only | Draws the icons from code (no dependencies). |
| `tests/` | dev only | `node tests/run.mjs` |

**The HTML still works completely on its own.** Double-click it, open it from a
USB stick, whatever — every other file is an enhancement that is skipped by a
feature check when absent. You lose offline caching and the home-screen icon;
you lose nothing else.

`splitcraft.html` is a generated file — see [Development](#development)
below before editing it.

## Installing it on a phone (no App Store involved)

Adding a web app to your home screen has nothing to do with the App Store and
needs no developer account, no review, and no signing. Two things are needed
for a *good* result, though:

1. **It must be served over HTTPS.** Not `file://`. This isn't about the icon —
   it's that service workers (the offline part) only run on `https://` or
   `localhost`, and browsers deliberately refuse to register them otherwise.
2. **Then: Safari → Share → Add to Home Screen.**

### Getting it onto HTTPS

Any static host works, and the free tiers are more than enough — this is a few
hundred KB of static files with no server side at all:

- **GitHub Pages** — push this folder to a repo, Settings → Pages → deploy from
  branch. You get `https://<you>.github.io/<repo>/splitcraft.html`.
- **Netlify / Cloudflare Pages** — drag the folder onto their dashboard.
- **Your own domain** — copy the files to any web root.

Purely local testing over HTTP also works, because `localhost` is exempt:

```sh
npx serve .          # then open http://localhost:3000/splitcraft.html
```

### If you'd rather the URL were just the folder

Rename `splitcraft.html` to `index.html` so the address is
`https://…/` instead of `https://…/splitcraft.html`. If you do, update the
two references to the old name:

- `manifest.webmanifest` → `"start_url": "./index.html"`
- `sw.js` → the `SHELL` array, and the navigation fallback near the bottom

The tests read `splitcraft.html` by default; point them at a renamed copy
with `APP=index.html node tests/run.mjs`.

### What you get once installed

- Its own icon and name on the home screen (a barbell, not a screenshot of the
  page — that's what `apple-touch-icon` is for).
- Launches fullscreen with no browser chrome.
- Opens and works with no signal. Your data was always local; the service
  worker just means the *app itself* doesn't need the network either.
- Updates when you reopen it after a new deploy. You'll see an "Update ready"
  toast rather than having it swap out mid-set.

### iPhone caveats worth knowing

- **Only Safari can add to the home screen** on iOS. Chrome on iOS can too now,
  but Safari is the reliable path.
- **Installed web apps get their own storage.** Data logged in Safari before
  installing does not automatically appear in the installed app. Use
  **Settings → Backup & restore** to move it across: export in Safari, restore
  in the installed app.
- **Back up periodically.** iOS evicts unused site data after roughly seven days
  of non-use, and "Clear History and Website Data" wipes it immediately. The
  export exists precisely for this.

## Backup

Settings → Backup & restore → **Download Backup** writes one versioned JSON
file containing every workout, exercise, preference, plan and setting. Your
OpenRouter API key is deliberately excluded, so the file is safe to keep in
cloud storage or email to yourself.

**Share Backup** does the same thing through the OS share sheet instead of a
download, where supported. **Connect Dropbox…** is a third, optional path
that uploads each backup straight to a SplitCraft-only folder in your
Dropbox — see [`dropbox_setup.md`](dropbox_setup.md) for the one-time setup
it needs. All three are additive: none of them replaces the others, and
none is required to use the app.

Restore **replaces everything** on the device — it's for a new phone or a
recovery, not for merging two devices. To *add* history, use the Fitbod CSV
importer instead.

The same screen also has **Delete All Workout History**, for starting a fresh
training log without losing the exercise catalog, plans or settings built up
around it. It downloads a backup first by default and cannot be undone.

## Development

`splitcraft.html` is generated from `src/page.html` + `src/js/*.js` by
`tools/build.mjs`. **Edit the files under `src/`, never `splitcraft.html`
directly** — your changes will be overwritten by the next build.

```sh
node tools/build.mjs                   # regenerate splitcraft.html from src/
node tools/build.mjs --check           # exit 1 if splitcraft.html is stale
node tests/run.mjs                     # builds automatically, then runs all suites
APP=/path/to/variant.html node tests/run.mjs
node tools/make-icons.mjs              # regenerate icons
node tools/serve.mjs                   # run locally at http://localhost:3000/ — service workers need http(s)/localhost, not file://
```

See `design-summary.md` for why things are built the way they are, and
`tests/README.md` for how the test harness works and what it deliberately
covers.

## License

[PolyForm Noncommercial License 1.0.0](LICENSE.md) — free to use, modify and
share for any noncommercial purpose. No part of it may be used in a
commercial product without a separate license from the copyright holder.
