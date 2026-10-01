# FAVS

Private pastebin + vault + local semantic search at https://favs.eu.org. Static files: `index.html`, `settings.html`, `vault.html`, `styles.css`, `settings.css`, `vault.css`, `app.js`, `settings.js`, `vault.js`, `embed.js`.

Repo: `SourceCodeplz/favs`, branch `main`. Local path: `C:\Users\danie\Documents\favs`.
Deploy: Cloudflare Pages connected to GitHub — push to `main` auto-deploys, no build step.

## Workflow

- ALWAYS commit and push to `main` by yourself after making changes — do not wait for the user to say "push".
- Page-to-page links (`index.html` ↔ `settings.html` ↔ `vault.html`) must be plain, with NO `?v=` query. `?v=` is only for CSS/JS asset references.

## Home page

- Single text box (`#composerInput`): **Save** stores to the vault (`localStorage "favs.clips.v1"`). No Send, no chat — `Ctrl+S` = Save.

## Assets & cache busting

- CSS/JS are external files, referenced with a version query: `styles.css?v=N`, `settings.css?v=N`, `app.js?v=N`, `settings.js?v=N`.
- ALWAYS bump `?v=` to the next integer in the HTML reference of the changed asset (current: `styles.css?v=10`, `settings.css?v=5`, `vault.css?v=2`, `app.js?v=6`, `settings.js?v=8`, `vault.js?v=2`, `embed.js?v=1`).

## Vendoring (no CDN libraries)

- NEVER load third-party libraries from CDNs — download the pinned version into `vendor/` and serve it same-origin. The only third-party host contacted at runtime is `huggingface.co` (model weights).
- Currently vendored: `@wllama/wllama@3.6.1` (`vendor/wllama/index.js` + `wllama.wasm`) and `@wllama/wllama-compat@3.6.1` (`vendor/wllama-compat/`, Safari fallback). `embed.js` references these via relative paths, loaded with `import()`.
- When upgrading a vendored file, bump the `?v=` on the `embed.js` script tag (the vendor URLs live inside that file, so a new URL busts the whole chain).
- Cross-origin isolation (`_headers`: COOP/COEP) is required for multi-threaded WASM — do not remove it.
- Keep the pre-CSS theme snippet in sync between `index.html` and `settings.html` if the storage key changes.

## Semantic search (embed.js — the only model)

- `embed.js` (ES module, `embed.js?v=N`) owns the embedding engine and the vector cache; `vault.js` and `settings.js` are clients. They talk via `window.favsEmbed` (`getState/isReady/ensureLoaded/unload/embedRaw/ensureIndexed/rankClips/prune/hashText`) and `favs:embed` CustomEvents on `window` (`{ status: 'loading'|'ready'|'error'|'idle', message, loaded?, total? }`).
- Single model, no picker: EmbeddingGemma 300M Q8 (`ggml-org/embeddinggemma-300M-GGUF / embeddinggemma-300M-Q8_0.gguf`, ~320 MB, one file). Loaded with `{ n_ctx: 2048, embeddings: true }`; vectors via `wllama.createEmbedding({ input })`, L2-normalized in JS. Yes — wllama does embeddings, no new runtime needed.
- Vector cache is localStorage `"favs.embeddings.v1"` (clip id → `{ h: text hash, v: [floats rounded to 4dp] }`), plus an in-memory fallback. `ensureIndexed(clips, onProgress)` embeds only missing/changed clips; `prune(ids)` drops vectors on delete. File clips are indexed by filename.
- Ranking is cosine (dot of unit vectors) in `rankClips()`; vault shows a `% match` badge. Keyword search is the fallback whenever the model isn't loaded. Settings → Semantic search offers a pre-download button; the same section's cache manager lists/deletes OPFS weight files (shared with vault).

## Settings (localStorage `favs.settings.v1`)

- Sections (left menu in `settings.html`): General (site name), Appearance (system/light/dark), Semantic search (embedding model info + download + cached files).
- Legacy keys (`modelId`, `nCtx`, `maxTokens`, `temperature`, `topP`, `repeatPenalty`, `engines`, `defaultEngine`, `bookmarks`, ...) are preserved untouched on save but no longer have UI. Old `#model` hashes redirect to the `search` section.

## Verification

- Do NOT verify visually — the user inspects visually.
- Only verify JavaScript: `node --check app.js`, `node --check settings.js`, `node --check vault.js`, `node --check embed.js` (dynamic `import()` inside a classic IIFE passes plain `--check`), plus a quick DOM-less smoke test if changed.
