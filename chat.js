/* FAVS local chat — Liquid AI LFM2.5-350M running 100% in-browser.
 *
 * Engine: @wllama/wllama v3 (llama.cpp compiled to WASM + WebGPU backend).
 * Why not transformers.js/ONNX: the "Llamas on the Web" benchmarks (May 2026)
 * show wllama's WebGPU backend decoding 45-69% faster at 29-33% less memory
 * than transformers.js/WebLLM, it loads ~3x faster, supports the LFM2 hybrid
 * architecture natively via GGUF, and falls back to pure WASM CPU on browsers
 * without WebGPU. No COOP/COEP headers needed (single-thread fallback).
 *
 * Model: LiquidAI/LFM2.5-350M-GGUF, Q4_K_M quant (~200MB, one-time download,
 * cached by wllama in the browser). Change HF_FILE below to try another quant,
 * e.g. 'LFM2.5-350M-Q4_0.gguf' (smaller) or 'LFM2.5-350M-Q5_K_M.gguf' (better).
 */
(function () {
  'use strict';

  var WLLAMA_VERSION = '3.6.1';
  var WLLAMA_CDN = 'https://cdn.jsdelivr.net/npm/@wllama/wllama@' + WLLAMA_VERSION + '/esm';
  var HF_REPO = 'LiquidAI/LFM2.5-350M-GGUF';
  var HF_FILE = 'LFM2.5-350M-Q4_K_M.gguf';
  var N_CTX = 4096;
  var MAX_TOKENS = 512;
  var MAX_HISTORY = 24; // messages (excluding system) sent to the model
  var SYSTEM_PROMPT = 'You are a helpful assistant running locally in the user\'s browser. Keep answers concise.';

  var state = 'idle'; // idle | loading | ready | generating
  var wllama = null;
  var history = []; // {role, content} excluding system prompt
  var aborter = null;

  function $(id) { return document.getElementById(id); }

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

  function setProgress(loaded, total) {
    var wrap = $('chatProgress');
    var bar = $('chatProgressBar');
    if (!wrap || !bar) return;
    if (loaded == null) {
      wrap.setAttribute('hidden', '');
      return;
    }
    wrap.removeAttribute('hidden');
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

  function setFormEnabled(enabled, sendLabel) {
    var input = $('chatInput');
    var send = $('chatSend');
    if (input) input.disabled = !enabled;
    if (send) {
      send.disabled = !enabled;
      send.textContent = sendLabel || 'Send';
      send.classList.toggle('stop', sendLabel === 'Stop');
    }
  }

  function modelMessages() {
    var msgs = [{ role: 'system', content: SYSTEM_PROMPT }];
    var tail = history.slice(-MAX_HISTORY);
    for (var i = 0; i < tail.length; i++) msgs.push(tail[i]);
    return msgs;
  }

  async function loadModel() {
    if (state === 'loading' || state === 'generating') return;
    if (state === 'ready') return;
    state = 'loading';
    setDot('loading');
    var loadBtn = $('chatLoad');
    if (loadBtn) {
      loadBtn.disabled = true;
      loadBtn.textContent = 'Downloading…';
    }
    setStatus('Loading engine…');

    try {
      var parts = await Promise.all([
        import(WLLAMA_CDN + '/index.js'),
        import(WLLAMA_CDN + '/wasm-from-cdn.js')
      ]);
      var Wllama = parts[0].Wllama;
      var WasmFromCDN = parts[1].default;
      wllama = new Wllama(WasmFromCDN, { suppressNativeLog: true });

      await wllama.loadModelFromHF(
        { repo: HF_REPO, file: HF_FILE },
        {
          n_ctx: N_CTX,
          progressCallback: function (p) {
            var loaded = p && p.loaded;
            var total = p && p.total;
            if (typeof loaded === 'number') {
              var msg = total
                ? 'Downloading model… ' + fmtMB(loaded) + ' / ' + fmtMB(total)
                : 'Downloading model… ' + fmtMB(loaded);
              setStatus(msg);
              setProgress(loaded, total);
            }
          }
        }
      );

      state = 'ready';
      setDot('ready');
      setProgress(null);
      if (loadBtn) loadBtn.setAttribute('hidden', '');
      var clearBtn = $('chatClear');
      if (clearBtn) clearBtn.removeAttribute('hidden');
      var form = $('chatForm');
      if (form) form.removeAttribute('hidden');
      setFormEnabled(true);
      var input = $('chatInput');
      if (input) input.placeholder = 'Ask anything… (runs locally)';
      setStatus('Ready — LFM2.5-350M running locally in this tab.', 'ok');
    } catch (err) {
      state = 'idle';
      setDot('idle');
      setProgress(null);
      if (loadBtn) {
        loadBtn.disabled = false;
        loadBtn.textContent = 'Retry download';
      }
      var detail = err && err.message ? err.message : String(err);
      setStatus('Could not start the local model: ' + detail, 'err');
    }
  }

  async function sendMessage(text) {
    if (state !== 'ready' || !wllama) return;
    var prompt = (text || '').trim();
    if (!prompt) return;

    history.push({ role: 'user', content: prompt });
    addBubble('user', prompt);

    var bubble = addBubble('assistant', '');
    state = 'generating';
    setFormEnabled(true, 'Stop');
    var input = $('chatInput');
    if (input) {
      input.value = '';
      input.disabled = true;
    }
    setStatus('Thinking… (local)');
    setDot('busy');

    aborter = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var started = performance.now();
    var out = '';
    try {
      var stream = await wllama.createChatCompletion({
        messages: modelMessages(),
        max_tokens: MAX_TOKENS,
        temperature: 0.7,
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
        if (bubble) bubble.textContent = 'Context is full — press Clear and start a new chat.';
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
      setFormEnabled(true, 'Send');
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
    var input = $('chatInput');
    if (input) input.focus();
  }

  function init() {
    var loadBtn = $('chatLoad');
    var clearBtn = $('chatClear');
    var form = $('chatForm');
    var input = $('chatInput');
    if (!loadBtn || !form || !input) return;

    loadBtn.addEventListener('click', loadModel);
    if (clearBtn) clearBtn.addEventListener('click', clearChat);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (state === 'generating') {
        stopGeneration();
        return;
      }
      var text = input.value;
      input.value = '';
      sendMessage(text);
      input.focus();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
