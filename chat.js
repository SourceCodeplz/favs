/* FAVS local AI — GGUF models running 100% in-browser.
 *
 * Engine: @wllama/wllama v3 (llama.cpp compiled to WASM + WebGPU backend),
 * vendored under vendor/ (no CDN — see AGENTS.md). If you upgrade the
 * vendored files, bump the ?v= on the chat.js script tag in index.html.
 *
 * MODELS below is the switchable catalog. Keep it in sync with settings.js.
 * Large models use split GGUF shards (llama-gguf-split pattern,
 * e.g. -00001-of-00005); wllama discovers the remaining shards from the
 * first filename automatically. Keep every single shard under ~2GB
 * (browser/WASM per-file limit).
 * Model behaviour (modelId, nCtx, maxTokens, temperature) lives in
 * localStorage "favs.settings.v1" and is edited on settings.html#model.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'favs.settings.v1';

  var WLLAMA_LIB = 'vendor/wllama/index.js';
  var WLLAMA_WASM = 'vendor/wllama/wllama.wasm';
  var WLLAMA_COMPAT_JS = 'vendor/wllama-compat/wllama.js';
  var WLLAMA_COMPAT_WASM = 'vendor/wllama-compat/wllama.wasm';

  var MODELS = [
    {
      id: 'lfm25-350m',
      name: 'LFM2.5 350M',
      repo: 'LiquidAI/LFM2.5-350M-GGUF',
      file: 'LFM2.5-350M-Q4_K_M.gguf',
      size: '~200 MB',
      desc: 'Default. Tiny, fast, tiny download.'
    },
    {
      id: 'gemma3-270m',
      name: 'Gemma 3 270M IT',
      repo: 'unsloth/gemma-3-270m-it-GGUF',
      file: 'gemma-3-270m-it-Q4_K_M.gguf',
      size: '~250 MB',
      desc: 'Google edge model. Good for short rewrites.'
    },
    {
      id: 'gemma4-e2b',
      name: 'Gemma 4 E2B IT',
      repo: 'ryanhlewis/gemma-4-E2B-it-qat-q4_0-gguf-webgpu',
      file: 'gemma-4-E2B_q4_0-it-00001-of-00005.gguf',
      size: '~3.3 GB',
      desc: 'Official Google QAT weights, split for browser. Smartest, huge download, experimental.'
    }
  ];

  var MAX_HISTORY = 24; // messages (excluding system) sent to the model
  var SYSTEM_PROMPT = 'You are a helpful assistant running locally in the user\'s browser. Keep answers concise. The user may ask you to rewrite or transform pasted text — return the rewritten text first, then a short note.';
  var CTX_OPTIONS = [2048, 4096, 8192, 16384, 32768];

  var state = 'idle'; // idle | loading | ready | generating
  var wllama = null;
  var loadedModelId = null;
  var loadedNCtx = 0;
  var history = []; // {role, content} excluding system prompt
  var aborter = null;
  var pendingPrompt = null;

  function $(id) { return document.getElementById(id); }

  function defaultSettings() {
    return { modelId: 'lfm25-350m', nCtx: 4096, maxTokens: 512, temperature: 0.7 };
  }

  function clampNumber(v, min, max, fallback) {
    var n = Number(v);
    if (!isFinite(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return Math.round(n);
  }

  function getSettings() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : {};
      var base = defaultSettings();
      var modelId = typeof parsed.modelId === 'string' ? parsed.modelId : base.modelId;
      if (!modelById(modelId)) modelId = base.modelId;
      var nCtx = Number(parsed.nCtx);
      if (CTX_OPTIONS.indexOf(nCtx) === -1) nCtx = base.nCtx;
      return {
        modelId: modelId,
        nCtx: nCtx,
        maxTokens: clampNumber(parsed.maxTokens, 64, 4096, base.maxTokens),
        temperature: (function () {
          var t = Number(parsed.temperature);
          if (!isFinite(t)) return base.temperature;
          if (t < 0) return 0;
          if (t > 2) return 2;
          return t;
        })()
      };
    } catch (e) {
      return defaultSettings();
    }
  }

  function modelById(id) {
    for (var i = 0; i < MODELS.length; i++) {
      if (MODELS[i].id === id) return MODELS[i];
    }
    return null;
  }

  function fmtMB(bytes) {
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function setStatus(msg, kind) {
    var el = $('chatStatus');
    if (!el) return;
    el.textContent = msg;
    el.className = 'chat-sub' + (kind ? ' ' + kind : '');
  }

  function setDot(mode) {
    var dot = $('chatDot');
    if (dot) dot.setAttribute('data-state', mode);
  }

  function setLabel() {
    var el = $('chatModelLabel');
    if (!el) return;
    var s = getSettings();
    var m = modelById(s.modelId) || MODELS[0];
    el.textContent = m.name + ' · ' + m.size + ' · ctx ' + s.nCtx;
    el.title = m.repo + ' / ' + m.file;
  }

  function setProgress(loaded, total) {
    var wrap = $('chatProgress');
    var bar = $('chatProgressBar');
    if (!wrap || !bar) return;
    if (loaded == null) {
      wrap.setAttribute('hidden', '');
      return;
    }
    wrap.removeAttribute('hidden');
    bar.classList.remove('indeterminate');
    if (total) {
      bar.style.width = Math.min(100, Math.round((loaded / total) * 100)) + '%';
    } else {
      bar.style.width = '100%';
      bar.classList.add('indeterminate');
    }
  }

  function addBubble(role, text) {
    var box = $('chatMessages');
    if (!box) return null;
    var div = document.createElement('div');
    div.className = 'chat-msg ' + (role === 'user' ? 'user' : role === 'error' ? 'error' : 'assistant');
    div.textContent = text;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    return div;
  }

  function addUseButton(bubble, getText) {
    if (!bubble) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-use-btn';
    btn.textContent = 'Use as text';
    btn.title = 'Move this reply back into the text box for editing or saving';
    btn.addEventListener('click', function () {
      try {
        window.dispatchEvent(new CustomEvent('favs:use-text', { detail: { text: getText() } }));
      } catch (e) {}
    });
    bubble.appendChild(document.createElement('br'));
    bubble.appendChild(btn);
  }

  function setLoadUI() {
    var loadBtn = $('chatLoad');
    var clearBtn = $('chatClear');
    if (state === 'ready') {
      if (loadBtn) loadBtn.setAttribute('hidden', '');
      if (clearBtn) clearBtn.removeAttribute('hidden');
    } else if (state === 'loading' || state === 'generating') {
      if (loadBtn) {
        loadBtn.removeAttribute('hidden');
        loadBtn.disabled = true;
        loadBtn.textContent = state === 'loading' ? 'Downloading…' : 'Thinking…';
      }
    } else {
      if (loadBtn) {
        loadBtn.removeAttribute('hidden');
        loadBtn.disabled = false;
        // If a different model was picked in settings, make that obvious.
        var s = getSettings();
        loadBtn.textContent = (loadedModelId && loadedModelId !== s.modelId) ? 'Switch model' : 'Download & start';
      }
    }
  }

  function modelMessages() {
    var msgs = [{ role: 'system', content: SYSTEM_PROMPT }];
    var tail = history.slice(-MAX_HISTORY);
    for (var i = 0; i < tail.length; i++) msgs.push(tail[i]);
    return msgs;
  }

  // Report which backend is actually active (WebGPU vs CPU, thread count).
  // On Firefox without JSPI, wllama silently falls back to slow CPU mode —
  // surfacing it here tells the user exactly what to fix.
  function backendInfo() {
    var gpu = false;
    var threads = 1;
    try { gpu = !!wllama.isSupportWebGPU(); } catch (e) {}
    try { threads = wllama.getNumThreads(); } catch (e) {}
    return { gpu: gpu, label: (gpu ? 'WebGPU' : 'CPU') + ' · ' + threads + ' thread' + (threads === 1 ? '' : 's') };
  }

  function readyMessage() {
    var s = getSettings();
    var m = modelById(s.modelId) || MODELS[0];
    var info = backendInfo();
    var msg = 'Ready — ' + m.name + ' locally (' + info.label + ', ctx ' + s.nCtx + ').';
    if (!info.gpu) {
      var ua = navigator.userAgent || '';
      if (/firefox|fxios/i.test(ua)) {
        msg += ' Firefox: update to 153+ or set javascript.options.wasm_js_promise_integration=true in about:config, then restart for GPU speed.';
      } else {
        msg += ' WebGPU unavailable — Chrome/Edge give full GPU speed.';
      }
    }
    return msg;
  }

  async function unloadModel() {
    if (wllama) {
      try { await wllama.exit(); } catch (e) {}
    }
    wllama = null;
    loadedModelId = null;
    loadedNCtx = 0;
  }

  async function loadModel() {
    if (state === 'loading' || state === 'generating') return;
    if (state === 'ready') return;
    var s = getSettings();
    var model = modelById(s.modelId) || MODELS[0];
    state = 'loading';
    setDot('loading');
    setLoadUI();
    setStatus('Loading engine…');

    try {
      var mod = await import('./' + WLLAMA_LIB);
      await unloadModel();
      wllama = new mod.Wllama({ default: WLLAMA_WASM }, { suppressNativeLog: true });
      // Keep the Safari fallback local too (default points at a CDN).
      wllama.setCompat({ worker: WLLAMA_COMPAT_JS, wasm: WLLAMA_COMPAT_WASM });

      await wllama.loadModelFromHF(
        { repo: model.repo, file: model.file },
        {
          n_ctx: s.nCtx,
          progressCallback: function (p) {
            var loaded = p && p.loaded;
            var total = p && p.total;
            if (typeof loaded === 'number') {
              var msg = total
                ? 'Downloading ' + model.name + '… ' + fmtMB(loaded) + ' / ' + fmtMB(total)
                : 'Downloading ' + model.name + '… ' + fmtMB(loaded);
              setStatus(msg);
              setProgress(loaded, total);
            }
          }
        }
      );

      loadedModelId = model.id;
      loadedNCtx = s.nCtx;
      state = 'ready';
      setDot('ready');
      setProgress(null);
      setLoadUI();
      setLabel();
      var input = $('composerInput');
      setStatus(readyMessage(), 'ok');
      if (pendingPrompt) {
        var p = pendingPrompt;
        pendingPrompt = null;
        sendMessage(p);
      } else if (input) {
        input.focus();
      }
    } catch (err) {
      state = 'idle';
      setDot('idle');
      setProgress(null);
      setLoadUI();
      var detail = err && err.message ? err.message : String(err);
      setStatus('Could not start ' + model.name + ': ' + detail, 'err');
    }
  }

  async function sendMessage(text) {
    var prompt = (text || '').trim();
    if (!prompt) return;
    if (state !== 'ready' || !wllama) {
      // Auto-start the model on first Send; the message goes out once loaded.
      pendingPrompt = prompt;
      addBubble('user', prompt);
      history.push({ role: 'user', content: prompt });
      loadModel();
      return;
    }

    history.push({ role: 'user', content: prompt });
    addBubble('user', prompt);

    var s = getSettings();
    var bubble = addBubble('assistant', '');
    state = 'generating';
    setDot('busy');
    setLoadUI();
    var sendBtn = $('sendBtn');
    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.textContent = 'Stop';
      sendBtn.classList.add('stop');
    }
    setStatus('Thinking… (local)');
    setDot('busy');

    aborter = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var started = performance.now();
    var out = '';
    try {
      var stream = await wllama.createChatCompletion({
        messages: modelMessages(),
        max_tokens: s.maxTokens,
        temperature: s.temperature,
        top_p: 0.9,
        stream: true,
        abortSignal: aborter ? aborter.signal : undefined
      });
      for await (var chunk of stream) {
        var piece = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta
          ? chunk.choices[0].delta.content
          : null;
        if (piece) {
          out += piece;
          if (bubble) {
            bubble.textContent = out;
            var box = $('chatMessages');
            if (box) box.scrollTop = box.scrollHeight;
          }
        }
      }
      if (!out) {
        if (bubble) bubble.textContent = '(empty response — try again)';
      } else {
        history.push({ role: 'assistant', content: out });
        (function (finalText, b) { addUseButton(b, function () { return finalText; }); })(out, bubble);
      }
      var secs = ((performance.now() - started) / 1000).toFixed(1);
      setStatus('Done locally in ' + secs + 's.', 'ok');
    } catch (err) {
      var aborted = !!(aborter && aborter.signal.aborted) || (err && err.name === 'AbortError');
      if (aborted) {
        if (out) {
          history.push({ role: 'assistant', content: out + ' [stopped]' });
          if (bubble) bubble.textContent = out;
        } else if (bubble) {
          bubble.textContent = '(stopped)';
        }
        setStatus('Stopped.', '');
      } else if (err && err.type === 'kv_cache_full') {
        if (bubble) bubble.textContent = 'Context is full — press Clear and start a new chat, or raise the context size in Settings → Model.';
        setStatus('Context full. Clear the chat to continue.', 'err');
      } else {
        var msg = err && err.message ? err.message : String(err);
        if (bubble) bubble.textContent = 'Error: ' + msg;
        setStatus('Generation failed: ' + msg, 'err');
      }
    } finally {
      aborter = null;
      state = 'ready';
      setDot('ready');
      setLoadUI();
      if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
        sendBtn.classList.remove('stop');
      }
    }
  }

  function stopGeneration() {
    if (aborter) {
      try { aborter.abort(); } catch (e) {}
    }
  }

  function clearChat() {
    if (state === 'generating') stopGeneration();
    history = [];
    var box = $('chatMessages');
    if (box) box.innerHTML = '';
    setStatus('Cleared. Model stays loaded.', '');
    var input = $('composerInput');
    if (input) input.focus();
  }

  function onSettingsChanged() {
    var s = getSettings();
    setLabel();
    if (state === 'ready' && (s.modelId !== loadedModelId || s.nCtx !== loadedNCtx)) {
      // Model or context changed in settings — drop the loaded model so the
      // next Send / Download loads the new configuration fresh.
      unloadModel().catch(function () {});
      state = 'idle';
      history = [];
      var box = $('chatMessages');
      if (box) box.innerHTML = '';
      setDot('idle');
      setLoadUI();
      var m = modelById(s.modelId) || MODELS[0];
      setStatus('Switched to ' + m.name + ' (ctx ' + s.nCtx + '). Press Download & start.', '');
    } else {
      setLoadUI();
    }
  }

  function init() {
    var loadBtn = $('chatLoad');
    var clearBtn = $('chatClear');
    var sendBtn = $('sendBtn');
    if (!loadBtn) return;
    setLabel();
    setLoadUI();

    loadBtn.addEventListener('click', loadModel);
    if (clearBtn) clearBtn.addEventListener('click', clearChat);

    window.addEventListener('favs:send', function (ev) {
      var text = ev && ev.detail && typeof ev.detail.text === 'string' ? ev.detail.text : '';
      if (!text.trim()) return;
      if (state === 'generating') {
        stopGeneration();
        return;
      }
      sendMessage(text);
      var input = $('composerInput');
      if (input) input.focus();
    });

    if (sendBtn) {
      // Send doubles as Stop while generating.
      sendBtn.addEventListener('click', function () {
        if (state === 'generating') stopGeneration();
      });
    }

    window.addEventListener('storage', function (ev) {
      if (ev && ev.key === STORAGE_KEY) onSettingsChanged();
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) onSettingsChanged();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
