# Dropbox setup (one-time)

SplitCraft's optional Dropbox backup needs a Dropbox "app" registered under
your own account before it will work. Nothing else in the app depends on
this — Download and Share both work with zero setup.

## 1. Create the app

1. Go to the Dropbox App Console and create a new app.
2. Choose **Scoped access**.
3. Choose **App folder** access (not "Full Dropbox") — this limits the app
   to its own folder inside your Dropbox, never the rest of your account.
4. Name it something like `SplitCraft`.

## 2. Set permissions

In the app's **Permissions** tab, enable:

- `files.content.write`

Save the change.

## 3. Add redirect URIs

In the app's **Settings** tab, under **OAuth 2 → Redirect URIs**, add every
URL this app will actually be loaded from. Dropbox checks this
byte-for-byte, so it has to match exactly what's in the address bar when
you click "Connect Dropbox…":

- `http://localhost:3000/splitcraft.html` — for local testing via
  `tools/serve.mjs`
- The eventual production URL (e.g. your GitHub Pages URL) once the app is
  actually deployed there

You can add more than one; add a new one any time the app moves or gets a
new URL.

## 4. Copy the App key

Still on the **Settings** tab, copy the **App key** shown near the top.

This is *not* a secret — Dropbox's PKCE flow is designed so this value ships
in public, client-side code (the same way a Google OAuth client ID is
visible in any browser's network tab). It's safe to commit.

## 5. Paste it into the app

Open `src/js/06-catalog-import-backup.js` and find:

```js
const DROPBOX_CLIENT_ID = 'REPLACE_WITH_YOUR_DROPBOX_APP_KEY';
```

Replace the placeholder with your real App key, then rebuild:

```
"C:\Program Files\nodejs\node.exe" tools/build.mjs
```

## 6. Test it

Run the local dev server and open the app there (service workers, and
`navigator.share`, only really behave over `http://localhost`, not
`file://`):

```
"C:\Program Files\nodejs\node.exe" tools/serve.mjs
```

Open `http://localhost:3000/splitcraft.html`, go to Settings → Backup &
restore, and click **Connect Dropbox…**. You should land on Dropbox's
consent screen, approve, and be redirected straight back with the button
now reading "Back Up to Dropbox".

## If it stops working later

A "Dropbox needs to be reconnected" message means the stored refresh token
was rejected — usually because it was revoked from Dropbox's own security
settings, or the app's permissions changed. Just click "Connect Dropbox…"
again; there's no data loss, since Download/Share/restore never depended on
this at all.
