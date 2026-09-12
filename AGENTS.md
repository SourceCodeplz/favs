# FAVS

New-tab start page at https://favs.eu.org. Static files: `index.html`, `settings.html`, `styles.css`, `settings.css`, `app.js`, `settings.js`.

Repo: `SourceCodeplz/favs`, branch `main`. Local path: `C:\Users\danie\Documents\favs`.
Deploy: Cloudflare Pages connected to GitHub — push to `main` auto-deploys, no build step.

## Assets & cache busting

- CSS/JS are external files, referenced with a version query: `styles.css?v=N`, `settings.css?v=N`, `app.js?v=N`, `settings.js?v=N`.
- ALWAYS bump `?v=` to the next integer in the HTML reference of the changed asset (current: `styles.css?v=1`, `settings.css?v=1`, `app.js?v=2`, `settings.js?v=1`).
- Bookmark links send no referrer (`rel="noopener noreferrer"` + `referrerPolicy="no-referrer"` in `app.js`).
- Keep the pre-CSS theme snippet in sync between `index.html` and `settings.html` if the storage key changes.

## Settings (localStorage `favs.settings.v1`)

- Sections (left menu in `settings.html`): General (site name), Appearance (system/light/dark), Search engines, Bookmarks.
- Keep the `ENGINES` catalog and defaults in sync between `app.js` and `settings.js`.
- Search dropdown on `index.html` appears only when >1 engine is enabled.

## Verification

- Do NOT verify visually — the user inspects visually.
- Only verify JavaScript: run `node --check app.js` and `node --check settings.js` (plus a quick DOM-less smoke test if changed).
