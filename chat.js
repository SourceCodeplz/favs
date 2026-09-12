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
  // Agent mode (single native tool). Active when a folder is attached via
  // agent.js — the sandbox shell sees the folder at /workspace.
  var MAX_AGENT_ITERS = 8; // tool steps per user message
  var AGENT_SYSTEM_PROMPT = 'You are a local coding agent running in the user\'s browser. You have one tool: execute_bash, a POSIX shell (bash + coreutils: ls, cat, grep, find, sed, awk, cp, mv) inside a sandbox. The user\'s picked folder is mounted at /workspace — always work there, never invent paths outside it. Explore before editing (ls, cat, grep). Make small, verifiable changes; re-run checks (e.g. ls, grep) to confirm. Keep each command short and its output small (pipe through head). File edits persist to the user\'s real folder, so say what you changed. When done, summarize the changes and how to verify. If the task needs no shell, just answer directly.';
  var EXECUTE_BASH_TOOL = {
    type: 'function',
    function: {
      name: 'execute_bash',
      description: 'Run a POSIX shell command in the sandboxed workspace (/workspace = the user\'s picked folder). Has ls, cat, grep, find, sed, awk, cp, mv. Returns exit code, stdout and stderr. File changes persist to the user\'s folder.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run, e.g. "ls -la /workspace" or "grep -rn TODO /workspace --include=*.js | head -30"' }
        },
        required: ['command']
      }
    }
  };
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
    for (var i = 0; i < tail.length; i++) {
      var m = tail[i];
      // Agent turns leave tool_calls/tool messages behind; plain chat
      // accepts only plain user/assistant text (e.g. after detaching).
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
      msgs.push({ role: m.role, content: typeof m.content === 'string' ? m.content : '' });
    }
    return msgs;
  }

  function agentMessages() {
    var msgs = [{ role: 'system', content: AGENT_SYSTEM_PROMPT }];
    var tail = history.slice(-MAX_HISTORY);
    for (var i = 0; i < tail.length; i++) msgs.push(tail[i]);
    return msgs;
  }

  function isAgentReady() {
    try {
      return !!(window.favsAgent && window.favsAgent.isReady());
    } catch (e) {
      return false;
    }
  }

  function parseToolArgs(raw) {
    if (raw == null) return {};
    if (typeof raw === 'object') return raw;
    try {
      return JSON.parse(String(raw)) || {};
    } catch (e) {
      return {};
    }
  }

  function addToolBubble(command, result) {
    var box = $('chatMessages');
    if (!box) return null;
    var div = document.createElement('div');
    div.className = 'chat-msg tool';
    var head = document.createElement('div');
    head.className = 'chat-tool-cmd';
    head.textContent = '$ ' + command;
    var out = document.createElement('div');
    out.className = 'chat-tool-out';
    var body = '';
    if (result.stdout) body += result.stdout;
    if (result.stderr) body += (body ? '\n' : '') + '[stderr]\n' + result.stderr;
    if (!body) body = '(no output)';
    if (body.length > 3000) body = body.slice(0, 3000) + '\n…[truncated]';
    out.textContent = 'exit ' + result.exitCode + '\n' + body;
    out.setAttribute('data-ok', result.ok ? '1' : '0');
    div.appendChild(head);
    div.appendChild(out);
    if (result.written && result.written.length) {
      var files = document.createElement('div');
      files.className = 'chat-tool-files';
      files.textContent = 'wrote: ' + result.written.join(', ');
      div.appendChild(files);
    }
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    return div;
  }

  // Codex-style loop: non-streaming turns with a single native tool.
  // Each assistant tool_calls entry is executed via agent.js and fed back
  // as a {role:'tool'} message until the model answers without tools.
  async function agentLoop(prompt) {
    history.push({ role: 'user', content: prompt });
    addBubble('user', prompt);

    var s = getSettings();
    state = 'generating';
    setDot('busy');
    setLoadUI();
    var sendBtn = $('sendBtn');
    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.textContent = 'Stop';
      sendBtn.classList.add('stop');
    }
    aborter = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var started = performance.now();
    var steps = 0;
    try {
      while (true) {
        if (aborter && aborter.signal.aborted) throw { name: 'AbortError' };
        if (steps >= MAX_AGENT_ITERS) {
          setStatus('Stopped after ' + MAX_AGENT_ITERS + ' tool steps — ask me to continue.', 'err');
          break;
        }
        setStatus('Agent thinking… (step ' + (steps + 1) + '/' + MAX_AGENT_ITERS + ', local)');
        var resp = await wllama.createChatCompletion({
          messages: agentMessages(),
          tools: [EXECUTE_BASH_TOOL],
          tool_choice: 'auto',
          max_tokens: s.maxTokens,
          temperature: s.temperature,
          abortSignal: aborter ? aborter.signal : undefined
        });
        var msg = resp && resp.choices && resp.choices[0] && resp.choices[0].message
          ? resp.choices[0].message
          : null;
        if (!msg) throw new Error('empty agent response — try again');
        var calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        if (!calls.length) {
          var text = typeof msg.content === 'string' ? msg.content : '';
          if (!text) text = '(empty response — try again)';
          var bubble = addBubble('assistant', text);
          history.push({ role: 'assistant', content: text });
          (function (finalText, b) { addUseButton(b, function () { return finalText; }); })(text, bubble);
          var secs = ((performance.now() - started) / 1000).toFixed(1);
          setStatus('Done locally in ' + secs + 's' + (steps ? ' after ' + steps + ' tool step' + (steps === 1 ? '' : 's') : '') + '.', 'ok');
          break;
        }
        // Echo the assistant turn (with its tool calls) so the next
        // request keeps the tool_call ids intact.
        var normCalls = [];
        for (var i = 0; i < calls.length; i++) {
          var tc = calls[i] || {};
          var fn = tc.function || {};
          normCalls.push({
            id: tc.id || ('call_' + steps + '_' + i),
            type: 'function',
            function: {
              name: fn.name || 'execute_bash',
              arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments == null ? {} : fn.arguments)
            }
          });
        }
        history.push({ role: 'assistant', content: typeof msg.content === 'string' ? msg.content : '', tool_calls: normCalls });
        for (var j = 0; j < normCalls.length; j++) {
          var call = normCalls[j];
          var args = parseToolArgs(call.function.arguments);
          var command = args && typeof args.command === 'string' ? args.command : '';
          steps++;
          if (call.function.name !== 'execute_bash' || !command.trim()) {
            var errText = 'unknown or empty tool call (only execute_bash {command} is available)';
            addToolBubble(command || call.function.name, { exitCode: 1, ok: false, stdout: '', stderr: errText, written: [] });
            history.push({ role: 'tool', tool_call_id: call.id, content: 'error: ' + errText });
            continue;
          }
          setStatus('Agent: $ ' + (command.length > 80 ? command.slice(0, 80) + '…' : command), '');
          var result;
          try {
            result = await window.favsAgent.runBash(command);
          } catch (runErr) {
            result = {
              exitCode: 1,
              ok: false,
              stdout: '',
              stderr: runErr && runErr.message ? runErr.message : String(runErr),
              written: []
            };
          }
          addToolBubble(command, result);
          var content = 'exit code: ' + result.exitCode + '\n';
          if (result.written && result.written.length) {
            content += 'files written: ' + result.written.join(', ') + '\n';
          }
          content += 'stdout:\n' + (result.stdout || '(empty)') + '\nstderr:\n' + (result.stderr || '(empty)');
          history.push({ role: 'tool', tool_call_id: call.id, content: content });
          if (!isAgentReady()) {
            setStatus('Sandbox closed mid-run — pick the folder again to continue.', 'err');
            return;
          }
        }
      }
    } catch (err) {
      var aborted = !!(aborter && aborter.signal.aborted) || (err && err.name === 'AbortError');
      if (aborted) {
        setStatus('Stopped.', '');
      } else if (err && err.type === 'kv_cache_full') {
        addBubble('error', 'Context is full — press Clear and start a new chat, or raise the context size in Settings → Model.');
        setStatus('Context full. Clear the chat to continue.', 'err');
      } else {
        var m = err && err.message ? err.message : String(err);
        addBubble('error', 'Agent error: ' + m + ' (tip: the small default model rarely follows tools — try the larger model in Settings → Model.)');
        setStatus('Agent failed: ' + m, 'err');
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

      var loadParams = function (extra) {
        var params = {
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
        };
        if (extra) {
          for (var k in extra) {
            if (Object.prototype.hasOwnProperty.call(extra, k)) params[k] = extra[k];
          }
        }
        return params;
      };

      var onLoaded = function () {
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
      };

      await wllama.loadModelFromHF(
        { repo: model.repo, file: model.file },
        loadParams()
      );

      onLoaded();
    } catch (err) {
      var detail = err && err.message ? err.message : String(err);
      // Interrupted multi-shard downloads (e.g. navigating away mid-download)
      // leave only some shards in the wllama cache. Its cache index then
      // throws "Model file not found: ...-0000X-of-..." instead of resuming.
      // Retry once bypassing the index so missing shards re-download
      // (completed shards are kept — CacheManager skips byte-identical files).
      if (/Model file not found/.test(detail)) {
        try {
          setStatus('Interrupted download found — resuming ' + model.name + '…');
          await wllama.loadModelFromHF(
            { repo: model.repo, file: model.file },
            loadParams({ useCache: false })
          );
          onLoaded();
          return;
        } catch (retryErr) {
          err = retryErr;
          detail = retryErr && retryErr.message ? retryErr.message : String(retryErr);
        }
      }
      state = 'idle';
      setDot('idle');
      setProgress(null);
      setLoadUI();
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

    // Agent mode: a folder is attached, so run the tool loop instead of a
    // single completion. History already holds the user message in that path.
    if (isAgentReady()) {
      await agentLoop(prompt);
      var input = $('composerInput');
      if (input) input.focus();
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

  function setFolderUI(detail) {
    var btn = $('chatFolder');
    if (!btn) return;
    if (detail && detail.status === 'ready' && detail.folderName) {
      btn.textContent = 'Folder: ' + detail.folderName;
      btn.title = detail.fileCount + ' text files sandboxed — click to detach';
    } else if (detail && detail.status === 'starting') {
      btn.textContent = 'Starting…';
      btn.title = 'Sandbox is starting';
    } else {
      btn.textContent = 'Folder';
      btn.title = 'Attach a folder for the coding agent (runs bash locally in a sandbox)';
    }
  }

  function onAgentEvent(ev) {
    var d = (ev && ev.detail) || {};
    setFolderUI(d);
    if (d.status === 'ready' || d.status === 'error' || d.status === 'starting') {
      if (state !== 'generating') setStatus(d.message || '', d.status === 'error' ? 'err' : d.status === 'ready' ? 'ok' : '');
    }
  }

  function init() {
    var loadBtn = $('chatLoad');
    var clearBtn = $('chatClear');
    var sendBtn = $('sendBtn');
    var folderBtn = $('chatFolder');
    if (!loadBtn) return;
    setLabel();
    setLoadUI();
    setFolderUI(null);

    loadBtn.addEventListener('click', loadModel);
    if (clearBtn) clearBtn.addEventListener('click', clearChat);
    if (folderBtn) {
      folderBtn.addEventListener('click', function () {
        try {
          if (!window.favsAgent) {
            setStatus('Agent runtime failed to load (agent.js missing?).', 'err');
            return;
          }
          var st = window.favsAgent.getState();
          if (st.status === 'ready' || st.status === 'starting') {
            window.favsAgent.closeFolder();
          } else {
            window.favsAgent.pickFolder();
          }
        } catch (e) {
          setStatus('Could not open the folder picker.', 'err');
        }
      });
    }
    window.addEventListener('favs:agent', onAgentEvent);

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
