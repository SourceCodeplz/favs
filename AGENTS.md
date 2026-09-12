# FAVS

Private pastebin + vault + local AI at https://favs.eu.org. Static files: `index.html`, `settings.html`, `vault.html`, `styles.css`, `settings.css`, `vault.css`, `app.js`, `settings.js`, `chat.js`.

Repo: `SourceCodeplz/favs`, branch `main`. Local path: `C:\Users\danie\Documents\favs`.
Deploy: Cloudflare Pages connected to GitHub — push to `main` auto-deploys, no build step.

## Workflow

- ALWAYS commit and push to `main` by yourself after making changes — do not wait for the user to say "push".
- Page-to-page links (`index.html` ↔ `settings.html` ↔ `vault.html`) must be plain, with NO `?v=` query. `?v=` is only for CSS/JS asset references.

## Home page

- Single unified text box (`#composerInput`): **Send** dispatches a `favs:send` CustomEvent on `window` (handled by `chat.js`), **Save** stores to the vault (`localStorage "favs.clips.v1"`).
- `Ctrl+Enter` = Send, `Ctrl+S` = Save. AI replies have a "Use as text" button dispatching `favs:use-text` (handled by `app.js`) to move the reply back into the box.

## Assets & cache busting

- CSS/JS are external files, referenced with a version query: `styles.css?v=N`, `settings.css?v=N`, `app.js?v=N`, `settings.js?v=N`.
- ALWAYS bump `?v=` to the next integer in the HTML reference of the changed asset (current: `styles.css?v=7`, `settings.css?v=4`, `vault.css?v=1`, `app.js?v=5`, `settings.js?v=4`, `vault.js?v=1`, `chat.js?v=4`).

## Vendoring (no CDN libraries)

- NEVER load third-party libraries from CDNs — download the pinned version into `vendor/` and serve it same-origin. The only third-party host contacted at runtime is `huggingface.co`, for model weights.
- Currently vendored: `@wllama/wllama@3.6.1` (`vendor/wllama/index.js` + `wllama.wasm`) and `@wllama/wllama-compat@3.6.1` (`vendor/wllama-compat/`, Safari fallback). `chat.js` references these via relative paths.
- When upgrading a vendored file, bump the `?v=` on the `chat.js` script tag in `index.html` (the vendor URLs live inside `chat.js`, so its new URL busts the whole chain).
- Cross-origin isolation (`_headers`: COOP/COEP) is required for multi-threaded WASM — do not remove it.
- Keep the pre-CSS theme snippet in sync between `index.html` and `settings.html` if the storage key changes.

## Models (localStorage `favs.settings.v1`: modelId, nCtx, maxTokens, temperature)

- Catalog `MODELS` must stay in sync between `chat.js` and `settings.js`:
  - `lfm25-350m` (default, ~200MB) — `LiquidAI/LFM2.5-350M-GGUF / LFM2.5-350M-Q4_K_M.gguf`
  - `gemma3-270m` (~250MB) — `unsloth/gemma-3-270m-it-GGUF / gemma-3-270m-it-Q4_K_M.gguf`
  - `gemma4-e2b` (~3.3GB split, experimental) — official Google QAT weights via `ryanhlewis/gemma-4-E2B-it-qat-q4_0-gguf-webgpu / gemma-4-E2B_q4_0-it-00001-of-00005.gguf` (wllama auto-discovers the other shards; keep every shard <2GB)
- Context sizes offered: 2048 / 4096 / 8192 / 16384 / 32768. Changing model or ctx unloads the model; it reloads on next Send/Download.

## Settings (localStorage `favs.settings.v1`)

- Sections (left menu in `settings.html`): General (site name), Appearance (system/light/dark), Model (switcher, context size, max reply length, creativity).
- Legacy keys (`engines`, `defaultEngine`, `bookmarks`, ...) are preserved untouched on save but no longer have UI.

## Verification

- Do NOT verify visually — the user inspects visually.
- Only verify JavaScript: run `node --check app.js`, `node --check settings.js` and `node --check chat.js` (plus a quick DOM-less smoke test if changed).
