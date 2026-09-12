/* FAVS home page: unified text box (Send to AI / Save to vault).
 * Depends on localStorage keys "favs.settings.v1" and "favs.clips.v1".
 * Send is delegated to chat.js via a "favs:send" CustomEvent on window.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'favs.settings.v1';
  var CLIPS_KEY = 'favs.clips.v1';
  var MAX_FILE_BYTES = 1500000; // ~1.5MB per pasted file; localStorage quota is ~5MB total.

  function defaultSettings() {
    return {
      siteName: 'favs.eu.org',
      theme: 'system',
      modelId: 'lfm25-350m',
      nCtx: 4096,
      maxTokens: 512,
      temperature: 0.7
    };
  }

  function loadSettings() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultSettings();
      var parsed = JSON.parse(raw);
      var base = defaultSettings();
      return {
        siteName: typeof parsed.siteName === 'string' && parsed.siteName.trim() ? parsed.siteName : base.siteName,
        theme: parsed.theme === 'light' || parsed.theme === 'dark' ? parsed.theme : 'system',
        modelId: typeof parsed.modelId === 'string' ? parsed.modelId : base.modelId,
        nCtx: [2048, 4096, 8192, 16384, 32768].indexOf(Number(parsed.nCtx)) !== -1 ? Number(parsed.nCtx) : base.nCtx,
        maxTokens: clampNumber(parsed.maxTokens, 64, 4096, base.maxTokens),
        temperature: clampFloat(parsed.temperature, 0, 2, base.temperature)
      };
    } catch (e) {
      return defaultSettings();
    }
  }

  function clampNumber(v, min, max, fallback) {
    var n = Number(v);
    if (!isFinite(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return Math.round(n);
  }

  function clampFloat(v, min, max, fallback) {
    var n = Number(v);
    if (!isFinite(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function applyTheme(theme) {
    var html = document.documentElement;
    if (theme === 'light' || theme === 'dark') {
      html.setAttribute('data-theme', theme);
    } else {
      html.removeAttribute('data-theme');
    }
  }

  function loadClips() {
    try {
      var raw = localStorage.getItem(CLIPS_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function storeClips(clips) {
    localStorage.setItem(CLIPS_KEY, JSON.stringify(clips));
  }

  function addClip(item) {
    var clips = loadClips();
    clips.unshift(item);
    storeClips(clips);
    return clips.length;
  }

  function makeId(prefix) {
    return prefix + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }

  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('read-failed')); };
      reader.readAsDataURL(file);
    });
  }

  function initComposer() {
    var input = document.getElementById('composerInput');
    var sendBtn = document.getElementById('sendBtn');
    var saveBtn = document.getElementById('saveBtn');
    var statusEl = document.getElementById('composerStatus');
    var openLink = document.getElementById('vaultOpen');
    if (!input || !sendBtn || !saveBtn) return;

    var statusTimer = null;
    function status(msg, kind) {
      if (!statusEl) return;
      statusEl.textContent = msg;
      statusEl.className = 'composer-status' + (kind ? ' ' + kind : '');
      if (statusTimer) clearTimeout(statusTimer);
      if (msg) statusTimer = setTimeout(function () { status('', ''); }, 4000);
    }

    function refreshCount() {
      if (!openLink) return;
      var n = loadClips().length;
      openLink.textContent = n ? 'Vault (' + n + ') \u2192' : 'Vault \u2192';
    }

    function sendText() {
      var text = input.value;
      if (!text || !text.trim()) { status('Write or paste something first.', 'err'); input.focus(); return; }
      try {
        window.dispatchEvent(new CustomEvent('favs:send', { detail: { text: text } }));
      } catch (e) {
        status('Could not reach the local AI.', 'err');
      }
    }

    function saveText() {
      var text = input.value;
      if (!text || !text.trim()) { status('Write or paste something first.', 'err'); input.focus(); return; }
      try {
        addClip({ id: makeId('c'), kind: 'text', text: text, createdAt: Date.now() });
      } catch (e) {
        status('Vault is full — delete old clips to free space.', 'err');
        return;
      }
      input.value = '';
      status('Saved to your private vault.', 'ok');
      refreshCount();
      input.focus();
    }

    function saveFiles(files) {
      var list = [];
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        if (f && f.size > 0) list.push(f);
      }
      if (!list.length) return;
      var chain = Promise.resolve();
      var saved = 0;
      list.forEach(function (f) {
        chain = chain.then(function () {
          if (f.size > MAX_FILE_BYTES) {
            status('"' + (f.name || 'file') + '" is too big for the local vault (max ~1.5MB).', 'err');
            return null;
          }
          return readFileAsDataUrl(f).then(function (dataUrl) {
            try {
              addClip({ id: makeId('c'), kind: 'file', name: f.name || 'pasted-file', mime: f.type || 'application/octet-stream', size: f.size, dataUrl: dataUrl, createdAt: Date.now() });
              saved++;
            } catch (e) {
              status('Vault is full — delete old clips to free space.', 'err');
            }
          }, function () {
            status('Could not read pasted file.', 'err');
          });
        });
      });
      chain.then(function () {
        if (saved) {
          status(saved === 1 ? 'File saved to your private vault.' : saved + ' files saved to your private vault.', 'ok');
          refreshCount();
        }
      });
    }

    sendBtn.addEventListener('click', sendText);
    saveBtn.addEventListener('click', saveText);
    input.addEventListener('keydown', function (ev) {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
        ev.preventDefault();
        sendText();
      } else if ((ev.ctrlKey || ev.metaKey) && (ev.key === 's' || ev.key === 'S')) {
        ev.preventDefault();
        saveText();
      }
    });
    input.addEventListener('paste', function (ev) {
      var dt = ev.clipboardData;
      if (dt && dt.files && dt.files.length) {
        // Let text land in the box too; files are saved as vault attachments.
        saveFiles(dt.files);
      }
    });
    // AI replies can be moved back into the box for editing + saving.
    window.addEventListener('favs:use-text', function (ev) {
      var t = ev && ev.detail && typeof ev.detail.text === 'string' ? ev.detail.text : '';
      if (!t) return;
      input.value = t;
      input.focus();
      status('Moved into the text box — edit it or press Save.', 'ok');
    });
    refreshCount();
  }

  function registerServiceWorker() {
    try {
      if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
          navigator.serviceWorker.register('sw.js').catch(function () {});
        });
      }
    } catch (e) {}
  }

  function init() {
    var settings = loadSettings();
    applyTheme(settings.theme);

    var titleEl = document.getElementById('siteTitle');
    var name = settings.siteName || 'favs.eu.org';
    if (titleEl) titleEl.textContent = name;
    document.title = name;

    initComposer();
    registerServiceWorker();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
