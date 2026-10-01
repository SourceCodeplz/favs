/* FAVS home page: text box that saves to the vault.
 * Depends on localStorage keys "favs.settings.v1" and "favs.clips.v1".
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'favs.settings.v1';
  var CLIPS_KEY = 'favs.clips.v1';
  var MAX_FILE_BYTES = 1500000; // ~1.5MB per pasted file; localStorage quota is ~5MB total.

  function defaultSettings() {
    return {
      siteName: 'favs.eu.org',
      theme: 'system'
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
        theme: parsed.theme === 'light' || parsed.theme === 'dark' ? parsed.theme : 'system'
      };
    } catch (e) {
      return defaultSettings();
    }
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
    var saveBtn = document.getElementById('saveBtn');
    var clearBtn = document.getElementById('clearBtn');
    var countEl = document.getElementById('composerCount');
    var statusEl = document.getElementById('composerStatus');
    var openLink = document.getElementById('vaultOpen');
    var countBadge = document.getElementById('vaultCount');
    if (!input || !saveBtn) return;

    var statusTimer = null;
    function status(msg, kind) {
      if (!statusEl) return;
      statusEl.textContent = msg;
      statusEl.className = 'composer-status' + (kind ? ' ' + kind : '');
      if (statusTimer) clearTimeout(statusTimer);
      if (msg) statusTimer = setTimeout(function () { status('', ''); }, 4000);
    }

    function refreshCount() {
      var n = loadClips().length;
      if (countBadge) {
        countBadge.hidden = !n;
        countBadge.textContent = n ? String(n) : '';
      }
      if (openLink) openLink.setAttribute('aria-label', n ? 'Vault — ' + n + ' saved clips' : 'Vault — saved clips');
    }

    function formatCount(n) {
      if (n < 1000) return n === 1 ? '1 char' : n + ' chars';
      if (n < 10000) return (Math.round(n / 100) / 10) + 'k chars';
      return Math.round(n / 1000) + 'k chars';
    }

    function refreshComposerState() {
      var hasText = !!(input.value && input.value.trim());
      saveBtn.disabled = !hasText;
      if (clearBtn) clearBtn.hidden = !input.value;
      if (countEl) {
        var len = (input.value || '').length;
        countEl.hidden = !len;
        countEl.textContent = len ? formatCount(len) : '';
      }
    }

    // Notepad sessions: typing/pasting only edits the box. After a pause the
    // whole box saves as ONE clip (created once, then updated in place while
    // the session continues). The text stays put — Save finalizes and clears.
    var AUTOSAVE_DELAY = 3000;
    var autosaveTimer = null;
    var sessionClipId = null;
    var lastSavedText = '';

    function cancelAutosave() {
      if (autosaveTimer) clearTimeout(autosaveTimer);
      autosaveTimer = null;
    }

    function scheduleAutosave() {
      cancelAutosave();
      autosaveTimer = setTimeout(autosave, AUTOSAVE_DELAY);
    }

    function endSession() {
      cancelAutosave();
      sessionClipId = null;
      lastSavedText = '';
    }

    // Write the current box to the vault without clearing it. Creates the
    // session clip on first call, updates it after that. Returns true if saved.
    function snapshotBox() {
      var text = input.value;
      if (!text || !text.trim()) return false;
      if (text === lastSavedText) return true;
      try {
        if (sessionClipId) {
          var clips = loadClips();
          var found = false;
          for (var i = 0; i < clips.length; i++) {
            if (clips[i] && clips[i].id === sessionClipId) {
              clips[i].text = text;
              clips[i].updatedAt = Date.now();
              found = true;
              break;
            }
          }
          if (!found) {
            clips.unshift({ id: sessionClipId, kind: 'text', text: text, createdAt: Date.now(), updatedAt: Date.now() });
          }
          storeClips(clips);
        } else {
          sessionClipId = makeId('c');
          addClip({ id: sessionClipId, kind: 'text', text: text, createdAt: Date.now(), updatedAt: Date.now() });
        }
      } catch (e) {
        status('Vault is full — delete old clips to free space.', 'err');
        return false;
      }
      lastSavedText = text;
      refreshCount();
      return true;
    }

    // Idle autosave: keep writing, one clip per session, box stays intact.
    function autosave() {
      autosaveTimer = null;
      if (snapshotBox()) status('Auto-saved to your private vault.', 'ok');
    }

    function saveText() {
      cancelAutosave();
      var text = input.value;
      if (!text || !text.trim()) {
        status('Write or paste something first.', 'err');
        input.focus();
        return;
      }
      if (sessionClipId && text === lastSavedText) {
        // Already auto-saved — just finalize without duplicating.
      } else if (!snapshotBox()) {
        return;
      }
      input.value = '';
      endSession();
      status('Saved to your private vault.', 'ok');
      refreshCount();
      refreshComposerState();
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

    saveBtn.addEventListener('click', function () { saveText(); });
    if (clearBtn) clearBtn.addEventListener('click', function () {
      input.value = '';
      endSession();
      status('', '');
      refreshComposerState();
      input.focus();
    });
    input.addEventListener('input', function () {
      refreshComposerState();
      if (!input.value) {
        // Emptied by hand — the old session stays in the vault, start fresh.
        endSession();
        return;
      }
      scheduleAutosave();
    });
    input.addEventListener('keydown', function (ev) {
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === 's' || ev.key === 'S')) {
        ev.preventDefault();
        saveText();
      }
    });
    input.addEventListener('paste', function (ev) {
      var dt = ev.clipboardData;
      if (dt && dt.files && dt.files.length) {
        // Pasted files can't live in the text box — they save as attachments.
        saveFiles(dt.files);
      }
      // Pasted text just lands in the box and joins the session; the idle
      // autosave stores the whole box as one clip.
      setTimeout(function () {
        refreshComposerState();
        if (input.value && input.value.trim()) scheduleAutosave();
      }, 0);
    });
    // Fast flow: open, paste, close. Flush unsent text when the tab hides
    // or the page unloads, so a quick paste-and-close still saves.
    function flushSession() { snapshotBox(); }
    window.addEventListener('pagehide', flushSession);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) flushSession();
    });
    refreshCount();
    refreshComposerState();
    input.focus();
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
    // One-time cleanup of the removed embedding vector cache.
    try { localStorage.removeItem('favs.embeddings.v1'); } catch (e) {}
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
