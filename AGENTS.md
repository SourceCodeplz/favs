# FAVS

Private pastebin + vault at https://favs.eu.org. Static files: `index.html`, `settings.html`, `vault.html`, `styles.css`, `settings.css`, `vault.css`, `app.js`, `settings.js`, `vault.js`, `sw.js`.

Repo: `SourceCodeplz/favs`, branch `main`. Local path: `C:\Users\danie\Documents\favs`.
Deploy: Cloudflare Pages connected to GitHub — push to `main` auto-deploys, no build step.

No AI, no third-party libraries, no CDN — vault search is plain keyword matching. Nothing leaves the browser.

## Workflow

- ALWAYS commit and push to `main` by yourself after making changes — do not wait for the user to say "push".
- Page-to-page links (`index.html` ↔ `settings.html` ↔ `vault.html`) must be plain, with NO `?v=` query. `?v=` is only for CSS/JS asset references.

## Home page

- Single text box (`#composerInput`): autofocused on open; **Save** stores to the vault (`localStorage "favs.clips.v1"`). No Send, no chat — `Ctrl+S` = Save, and **pasting auto-saves** (text saves after the paste lands; pasted files save as attachments).
- `saveText({ silent: true })` is the autosave path — it returns quietly on empty input instead of showing an error.
- Home chrome: topbar `Vault` pill with live count badge (`#vaultCount`); composer foot has hint + char count (`#composerCount`) + `Clear` (`#clearBtn`, hidden when empty) + Save (disabled when empty).

## Vault

- Keyword-only text search over clip text + file names; search box is autofocused. Export / Delete all included.
- Search UX: result counts (`#clipMeta`), separate no-clips vs no-matches states (`#clipEmpty` / `#clipNoResults` + `#clipClearSearch`), `/` focuses search, `Esc` clears it. Long clips (>600 chars) start collapsed with Show more/less.
- Deleted keys from the removed embedding era (`favs.embeddings.v1`) are cleaned from localStorage on page init.

## Assets & cache busting

- CSS/JS are external files, referenced with a version query: `styles.css?v=N`, `settings.css?v=N`, `app.js?v=N`, `settings.js?v=N`.
- ALWAYS bump `?v=` to the next integer in the HTML reference of the changed asset (current: `styles.css?v=11`, `settings.css?v=6`, `vault.css?v=4`, `app.js?v=8`, `settings.js?v=9`, `vault.js?v=4`).
- Bump `CACHE` in `sw.js` when the offline shell changes.

## Settings (localStorage `favs.settings.v1`)

- Sections (left menu in `settings.html`): General (site name), Appearance (system/light/dark).
- Legacy keys (`modelId`, `nCtx`, `maxTokens`, `temperature`, `topP`, `repeatPenalty`, `engines`, `defaultEngine`, `bookmarks`, ...) are preserved untouched on save but have no UI.
- Keep the pre-CSS theme snippet in sync between `index.html` and `settings.html` if the storage key changes.

## Verification

- Do NOT verify visually — the user inspects visually.
- Only verify JavaScript: `node --check app.js`, `node --check settings.js`, `node --check vault.js`, plus a quick DOM-less smoke test if changed.
