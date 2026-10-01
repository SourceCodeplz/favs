# FAVS

Private notepad + vault at https://favs.eu.org. Static files, no build, no libraries, no CDN — nothing leaves the browser. Push to `main` auto-deploys (Cloudflare Pages).

## Workflow

- Commit and push to `main` yourself after every change.
- Page links (`index.html` ↔ `settings.html` ↔ `vault.html`) stay plain. `?v=` only on CSS/JS asset URLs, bumped to the next integer when that asset changes (now: `styles.css?v=12`, `settings.css?v=6`, `vault.css?v=4`, `app.js?v=11`, `settings.js?v=9`, `vault.js?v=4`).
- Bump `CACHE` in `sw.js` only when the precached shell changes.

## Home (notepad)

One box (`#composerInput`, autofocused). Typing/pasting only edits the box — nothing saves per keystroke or per paste.

- Idle 3s → the whole box saves as **one** clip: created once per session, then updated in place while you keep writing. Text stays in the box.
- **Save** / `Ctrl+S` finalizes the session and clears the box (no duplicate if already auto-saved). **Clear** empties the box without touching the vault. Hiding the tab or leaving the page flushes unsent text — open, paste, close still saves.
- Pasted files save immediately as attachments (they can't live in the text box).
- Chrome: topbar `Vault` pill with count badge (`#vaultCount`); foot has hint, char count (`#composerCount`), `Clear` (`#clearBtn`, hidden when empty), `Vault` link, Save (disabled when empty).

## Vault

Keyword search over clip text + file names. Shows counts, empty vs no-match states, collapses long clips (>600 chars). Export / Delete all included.

## Settings (`favs.settings.v1`)

Sections: General (site name), Appearance (system/light/dark). Preserve unknown keys on save; keep the pre-CSS theme snippet in `index.html`/`settings.html` in sync.

## Verification

Don't verify visually. Run `node --check` on changed JS plus a quick DOM-less smoke test.
