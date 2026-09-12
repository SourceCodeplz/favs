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
- ALWAYS bump `?v=` to the next integer in the HTML reference of the changed asset (current: `styles.css?v=9`, `settings.css?v=4`, `vault.css?v=1`, `app.js?v=5`, `settings.js?v=4`, `vault.js?v=1`, `agent.js?v=6`, `chat.js?v=9`).

## Vendoring (no CDN libraries)

- NEVER load third-party libraries from CDNs — download the pinned version into `vendor/` and serve it same-origin. Third-party hosts contacted at runtime: `huggingface.co` (model weights) and `wasmer.io` (shell packages for the agent sandbox, downloaded once then cached in browser storage).
- Currently vendored: `@wllama/wllama@3.6.1` (`vendor/wllama/index.js` + `wllama.wasm`), `@wllama/wllama-compat@3.6.1` (`vendor/wllama-compat/`, Safari fallback), and `@wasmer/sdk@0.11.0` (`vendor/wasmer/dist/` + `vendor/wasmer/pkg/`, including `pkg/snippets/` — the wasm-bindgen glue statically imports it, do not omit). `chat.js`/`agent.js` reference these via relative paths.
- When upgrading a vendored file, bump the `?v=` on the `chat.js`/`agent.js` script tag in `index.html` (the vendor URLs live inside those files, so a new URL busts the whole chain).
- Cross-origin isolation (`_headers`: COOP/COEP) is required for multi-threaded WASM — do not remove it. `credentialless` (not `require-corp`) also satisfies the Wasmer SDK's SharedArrayBuffer need while keeping cross-origin favicons working.
- Keep the pre-CSS theme snippet in sync between `index.html` and `settings.html` if the storage key changes.

## Agent (local coding agent: Wasmer + WASIX + shell)

- `agent.js` (ES module, `agent.js?v=N`) owns the sandbox; `chat.js` owns the tool loop. They talk via `window.favsAgent` (`getState/isReady/pickFolder/closeFolder/runBash`) and `favs:agent` CustomEvents on `window`.
- Sandbox: `new Wasmer()` → `ready()` → `packages.load('wasmer/bash')` to resolve the real shell command (entrypoint/commands[0], never guessed) → `sandboxes.create({ packages: ['wasmer/bash'], shell: <CommandRef>, files })` (`agent.js`). Never use `sharrattj/bash` — it throws `function signature mismatch` on every run (wasmer-sdk#463). Cwd for every command is `/workspace`. Single native tool `execute_bash` (JSON schema in `chat.js`), non-streaming turns with `tool_choice: 'auto'`, max 8 tool steps per message, 30s per command.
- Console: `#agentStatus` line always shows sandbox state; `#agentTerm` terminal (visible when ready) runs bash directly via `favsAgent.runBash` with no model involved, and every model tool step is logged there too. A self-test (`echo sandbox-ok && pwd && ls /workspace`) runs automatically on first ready.
- Filesystem: the user picks a real folder (File System Access API, Chrome/Edge desktop). Text files (≤200KB, ≤500 files, ≤4MB, skips `.git`/`node_modules`/binaries) snapshot into the sandbox; after each command the sandbox is diffed and changes are written back. Nothing runs before a folder is picked.

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
- Only verify JavaScript: `node --check app.js`, `node --check settings.js`, `node --check chat.js`, and `Get-Content agent.js -Raw | node --input-type=module --check` (`agent.js` is ESM — plain `--check` misparses it), plus a quick DOM-less smoke test if changed.
