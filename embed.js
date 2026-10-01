/* FAVS semantic search — EmbeddingGemma running 100% in-browser.
 *
 * Engine: @wllama/wllama v3 (llama.cpp compiled to WASM), vendored under
 * vendor/ (no CDN — see AGENTS.md). The single model is the official
 * ggml-org EmbeddingGemma 300M Q8 GGUF (~320 MB, one file), loaded with
 * embeddings:true; vectors come from wllama.createEmbedding().
 *
 * This module owns the model and the vector cache (localStorage
 * "favs.embeddings.v1": clip id -> { h: text hash, v: [rounded floats] }).
 * Pages talk to it via `window.favsEmbed` and `favs:embed` CustomEvents:
 *   { status: 'loading'|'ready'|'error'|'indexing'|'idle',
 *     message, loaded?, total? }
 */
(function () {
  'use strict';

  var WLLAMA_LIB = 'vendor/wllama/index.js';
  var WLLAMA_WASM = 'vendor/wllama/wllama.wasm';
  var WLLAMA_COMPAT_JS = 'vendor/wllama-compat/wllama.js';
  var WLLAMA_COMPAT_WASM = 'vendor/wllama-compat/wllama.wasm';

  var MODEL = {
    name: 'EmbeddingGemma 300M',
    repo: 'ggml-org/embeddinggemma-300M-GGUF',
    file: 'embeddinggemma-300M-Q8_0.gguf',
    size: '~320 MB',
    desc: 'Google embedding model, Q8 quant. Runs locally; one download, then offline from cache.'
  };

  var CACHE_KEY = 'favs.embeddings.v1';
  var MAX_INDEX_CHARS = 1500; // chars per clip fed to the model (well under its 2048-token window)
  var CHUNK_CHARS = 1000; // fallback slice size when a text still exceeds the batch
  var MAX_CHUNKS = 4; // cap on fallback slices per clip (bounds indexing time)
  var STORE_DECIMALS = 4; // rounding keeps the localStorage cache small

  // Batch must cover the whole context window: an input longer than the
  // batch is rejected ("too large to process"), even when n_ctx allows it.
  var LOAD_PARAMS = { n_ctx: 2048, n_batch: 2048, n_ubatch: 2048, embeddings: true };

  var status = 'idle'; // idle | loading | ready | error
  var message = '';
  var wllama = null;
  var loadPromise = null;
  var memCache = {}; // id -> { h, v } fallback when localStorage is unavailable/full

  function emit(extra) {
    try {
      var detail = { status: status, message: message, model: MODEL };
      if (extra && typeof extra === 'object') {
        for (var k in extra) {
          if (Object.prototype.hasOwnProperty.call(extra, k)) detail[k] = extra[k];
        }
      }
      window.dispatchEvent(new CustomEvent('favs:embed', { detail: detail }));
    } catch (e) {}
  }

  function setStatus(next, msg, extra) {
    status = next;
    message = msg || '';
    emit(extra);
  }

  function fmtMB(bytes) {
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  // djb2 hex — detects when a clip changed so its vector is recomputed.
  function hashText(s) {
    var h1 = 5381;
    var h2 = 5381;
    s = String(s == null ? '' : s);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 = (((h1 << 5) + h1) + c) | 0;
      h2 = (((h2 << 5) + h2) + (c ^ (i & 255))) | 0;
    }
    return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
  }

  function indexTextFor(clip) {
    if (!clip) return '';
    if (clip.kind === 'file') return String(clip.name || '');
    return String(clip.text || '');
  }

  function loadCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return null; // storage blocked — caller falls back to memCache
    }
  }

  function storeCache(cache) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
      return true;
    } catch (e) {
      // Quota: drop the oldest half (insertion order) and retry once.
      try {
        var keys = Object.keys(cache);
        var drop = Math.ceil(keys.length / 2);
        for (var i = 0; i < drop; i++) delete cache[keys[i]];
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  function normalize(vec) {
    var sum = 0;
    for (var i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
    var norm = Math.sqrt(sum);
    if (!norm) return Array.prototype.slice.call(vec);
    var out = new Array(vec.length);
    for (var j = 0; j < vec.length; j++) out[j] = vec[j] / norm;
    return out;
  }

  function roundVec(vec) {
    var f = Math.pow(10, STORE_DECIMALS);
    var out = new Array(vec.length);
    for (var i = 0; i < vec.length; i++) out[i] = Math.round(vec[i] * f) / f;
    return out;
  }

  function dot(a, b) {
    var n = Math.min(a.length, b.length);
    var s = 0;
    for (var i = 0; i < n; i++) s += a[i] * b[i];
    return s;
  }

  function backendInfo() {
    var gpu = false;
    var threads = 1;
    try { gpu = !!wllama.isSupportWebGPU(); } catch (e) {}
    try { threads = wllama.getNumThreads(); } catch (e) {}
    return (gpu ? 'WebGPU' : 'CPU') + ' · ' + threads + ' thread' + (threads === 1 ? '' : 's');
  }

  function ensurePersistentStorage() {
    try {
      if (navigator.storage && typeof navigator.storage.persist === 'function') {
        navigator.storage.persist().catch(function () {});
      }
    } catch (e) {}
  }

  async function createEngine() {
    var mod = await import('./' + WLLAMA_LIB);
    if (wllama) {
      try { await wllama.exit(); } catch (e) {}
    }
    wllama = new mod.Wllama({ default: WLLAMA_WASM }, { suppressNativeLog: true });
    // Keep the Safari fallback local too (default points at a CDN).
    wllama.setCompat({ worker: WLLAMA_COMPAT_JS, wasm: WLLAMA_COMPAT_WASM });
  }

  function ensureLoaded() {
    if (status === 'ready' && wllama) return Promise.resolve();
    if (loadPromise) return loadPromise;
    ensurePersistentStorage();
    setStatus('loading', 'Loading engine…');
    loadPromise = (async function () {
      await createEngine();
      await wllama.loadModelFromHF(
        { repo: MODEL.repo, file: MODEL.file },
        {
          n_ctx: LOAD_PARAMS.n_ctx,
          n_batch: LOAD_PARAMS.n_batch,
          n_ubatch: LOAD_PARAMS.n_ubatch,
          embeddings: LOAD_PARAMS.embeddings,
          progressCallback: function (p) {
            var loaded = p && p.loaded;
            var total = p && p.total;
            if (typeof loaded === 'number') {
              var msg = total
                ? 'Downloading ' + MODEL.name + '… ' + fmtMB(loaded) + ' / ' + fmtMB(total)
                : 'Downloading ' + MODEL.name + '… ' + fmtMB(loaded);
              setStatus('loading', msg, { loaded: loaded, total: total || 0 });
            }
          }
        }
      );
      setStatus('ready', 'Ready — ' + MODEL.name + ' locally (' + backendInfo() + ').');
    })().catch(function (err) {
      var detail = err && err.message ? err.message : String(err);
      if (/Model file not found/.test(detail)) {
        // Interrupted download left only some cache entries; retry once
        // bypassing the cache index so missing bytes re-download.
        setStatus('loading', 'Interrupted download found — resuming ' + MODEL.name + '…');
        return (async function () {
          await createEngine();
          await wllama.loadModelFromHF(
            { repo: MODEL.repo, file: MODEL.file },
            { n_ctx: LOAD_PARAMS.n_ctx, n_batch: LOAD_PARAMS.n_batch, n_ubatch: LOAD_PARAMS.n_ubatch, embeddings: LOAD_PARAMS.embeddings, useCache: false }
          );
          setStatus('ready', 'Ready — ' + MODEL.name + ' locally (' + backendInfo() + ').');
        })().catch(function (retryErr) {
          var d2 = retryErr && retryErr.message ? retryErr.message : String(retryErr);
          setStatus('error', 'Could not start ' + MODEL.name + ': ' + d2);
          throw retryErr;
        });
      }
      setStatus('error', 'Could not start ' + MODEL.name + ': ' + detail);
      throw err;
    }).then(function () {
      loadPromise = null;
    }, function (err) {
      loadPromise = null;
      throw err;
    });
    return loadPromise;
  }

  async function embedOne(text) {
    var resp = await wllama.createEmbedding({ input: text });
    var vec = resp && resp.data && resp.data[0] && resp.data[0].embedding
      ? resp.data[0].embedding
      : (resp && resp.embedding ? resp.embedding : null);
    if (!vec || !vec.length) throw new Error('empty embedding — try again');
    return vec;
  }

  // Split on whitespace so chunks never cut words in half.
  function splitChunks(text) {
    var chunks = [];
    var rest = String(text == null ? '' : text);
    while (rest.length > CHUNK_CHARS && chunks.length < MAX_CHUNKS) {
      var cut = rest.lastIndexOf(' ', CHUNK_CHARS);
      if (cut < CHUNK_CHARS / 2) cut = CHUNK_CHARS; // no spaces nearby — hard cut
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut).trim();
    }
    if (rest) chunks.push(rest.slice(0, CHUNK_CHARS));
    return chunks;
  }

  function meanVec(vecs) {
    var dim = vecs[0].length;
    var out = new Array(dim);
    for (var i = 0; i < dim; i++) out[i] = 0;
    for (var j = 0; j < vecs.length; j++) {
      var n = Math.min(dim, vecs[j].length);
      for (var k = 0; k < n; k++) out[k] += vecs[j][k];
    }
    for (var m = 0; m < dim; m++) out[m] /= vecs.length;
    return out;
  }

  function isBatchError(err) {
    var msg = err && err.message ? err.message : String(err);
    return /too large to process|batch size|context|tokens/i.test(msg);
  }

  async function embedRaw(text) {
    await ensureLoaded();
    var input = String(text == null ? '' : text).slice(0, MAX_INDEX_CHARS);
    try {
      return normalize(await embedOne(input));
    } catch (err) {
      if (!isBatchError(err)) throw err;
      // Still too long (dense scripts pack many tokens per char):
      // embed slices and average them. One long clip must never
      // break the whole search.
      var chunks = splitChunks(input);
      var vecs = [];
      for (var i = 0; i < chunks.length; i++) {
        try {
          vecs.push(await embedOne(chunks[i]));
        } catch (chunkErr) {
          if (!isBatchError(chunkErr)) throw chunkErr;
          // Slice it even thinner and try once more.
          var thin = splitChunks(chunks[i]).slice(0, 1);
          if (thin.length) vecs.push(await embedOne(thin[0]));
        }
      }
      if (!vecs.length) throw err;
      return normalize(meanVec(vecs));
    }
  }

  function cachedVector(cache, id, hash) {
    var entry = cache && cache[id];
    if (entry && entry.h === hash && Array.isArray(entry.v) && entry.v.length) return entry.v;
    var mem = memCache[id];
    if (mem && mem.h === hash && mem.v && mem.v.length) return mem.v;
    return null;
  }

  function putVector(cache, storageOk, id, hash, vec) {
    var stored = roundVec(vec);
    var entry = { h: hash, v: stored };
    memCache[id] = entry;
    if (cache) {
      cache[id] = entry;
      if (!storageOk.ok) return;
      storageOk.ok = storeCache(cache);
    }
  }

  // Index every clip that has indexable text. Returns { vectors, indexed, total }.
  // Missing vectors are computed one by one (vaults are small; keeps progress honest).
  async function ensureIndexed(clips, onProgress) {
    await ensureLoaded();
    var list = Array.isArray(clips) ? clips : [];
    var cache = loadCache();
    var storageOk = { ok: !!cache };
    if (!cache) cache = {};
    var vectors = {};
    var missing = [];
    var failed = 0;
    for (var i = 0; i < list.length; i++) {
      var clip = list[i];
      if (!clip || !clip.id) continue;
      var text = indexTextFor(clip).trim();
      if (!text) continue;
      var h = hashText(text);
      var hit = cachedVector(storageOk.ok ? cache : null, clip.id, h);
      if (hit) {
        vectors[clip.id] = hit;
      } else {
        missing.push({ clip: clip, hash: h, text: text });
      }
    }
    for (var j = 0; j < missing.length; j++) {
      var m = missing[j];
      if (onProgress) {
        try { onProgress(j, missing.length); } catch (e) {}
      }
      try {
        var vec = await embedRaw(m.text);
        putVector(storageOk.ok ? cache : null, storageOk, m.clip.id, m.hash, vec);
        vectors[m.clip.id] = normalize(vec);
      } catch (clipErr) {
        // One bad clip (too long, odd bytes, …) is skipped — it must
        // never abort indexing for all the others.
        failed++;
        try { console.warn('[favs-embed] skipping clip ' + m.clip.id + ': ' + (clipErr && clipErr.message ? clipErr.message : clipErr)); } catch (warnErr) {}
      }
    }
    if (onProgress) {
      try { onProgress(missing.length, missing.length); } catch (e) {}
    }
    return { vectors: vectors, indexed: missing.length - failed, total: list.length, failed: failed };
  }

  // Cosine rank over unit vectors = dot product. Returns [{ clip, score }] desc.
  function rankClips(queryVec, clips, vectors) {
    var out = [];
    for (var i = 0; i < clips.length; i++) {
      var clip = clips[i];
      var v = clip && vectors ? vectors[clip.id] : null;
      if (!v) continue;
      out.push({ clip: clip, score: dot(queryVec, v) });
    }
    out.sort(function (a, b) { return b.score - a.score; });
    return out;
  }

  function prune(ids) {
    try {
      var cache = loadCache();
      if (!cache) return;
      var changed = false;
      for (var i = 0; i < (ids || []).length; i++) {
        if (cache[ids[i]]) { delete cache[ids[i]]; changed = true; }
        if (memCache[ids[i]]) delete memCache[ids[i]];
      }
      if (changed) storeCache(cache);
    } catch (e) {}
  }

  async function unload() {
    loadPromise = null;
    if (wllama) {
      try { await wllama.exit(); } catch (e) {}
    }
    wllama = null;
    setStatus('idle', '');
  }

  function getState() {
    return { status: status, message: message, model: MODEL };
  }

  function isReady() {
    return status === 'ready' && !!wllama;
  }

  window.favsEmbed = {
    MODEL: MODEL,
    getState: getState,
    isReady: isReady,
    ensureLoaded: ensureLoaded,
    unload: unload,
    embedRaw: embedRaw,
    ensureIndexed: ensureIndexed,
    rankClips: rankClips,
    prune: prune,
    hashText: hashText
  };
})();
