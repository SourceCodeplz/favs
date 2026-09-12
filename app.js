/* FAVS start page. Depends on localStorage key "favs.settings.v1". */
(function () {
  'use strict';

  var STORAGE_KEY = 'favs.settings.v1';
  var CLIPS_KEY = 'favs.clips.v1';
  var MAX_FILE_BYTES = 1500000; // ~1.5MB per pasted file; localStorage quota is ~5MB total.

  var ENGINES = [
    { id: 'google', name: 'Google', template: 'https://www.google.com/search?q=%s', placeholder: 'Search Google...' },
    { id: 'bing', name: 'Bing', template: 'https://www.bing.com/search?q=%s', placeholder: 'Search Bing...' },
    { id: 'duckduckgo', name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s', placeholder: 'Search DuckDuckGo...' },
    { id: 'brave', name: 'Brave', template: 'https://search.brave.com/search?q=%s', placeholder: 'Search Brave...' },
    { id: 'yahoo', name: 'Yahoo', template: 'https://search.yahoo.com/search?p=%s', placeholder: 'Search Yahoo...' },
    { id: 'ecosia', name: 'Ecosia', template: 'https://www.ecosia.org/search?q=%s', placeholder: 'Search Ecosia...' },
    { id: 'startpage', name: 'Startpage', template: 'https://www.startpage.com/sp/search?query=%s', placeholder: 'Search Startpage...' },
    { id: 'perplexity', name: 'Perplexity', template: 'https://www.perplexity.ai/search?q=%s', placeholder: 'Ask Perplexity...' },
    { id: 'you', name: 'You.com', template: 'https://you.com/search?q=%s', placeholder: 'Search You.com...' },
    { id: 'wikipedia', name: 'Wikipedia', template: 'https://en.wikipedia.org/wiki/Special:Search?search=%s', placeholder: 'Search Wikipedia...' }
  ];

  function defaultSettings() {
    return {
      siteName: 'favs.eu.org',
      theme: 'system',
      engines: { google: true },
      defaultEngine: 'google',
      bookmarks: [],
      bookmarkIconSize: 32,
      bookmarkTextSize: 12,
      bookmarkNoReferrer: true
    };
  }

  function clampNumber(v, min, max, fallback) {
    var n = Number(v);
    if (!isFinite(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return Math.round(n);
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
        engines: parsed.engines && typeof parsed.engines === 'object' ? parsed.engines : base.engines,
        defaultEngine: typeof parsed.defaultEngine === 'string' ? parsed.defaultEngine : base.defaultEngine,
        bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks : [],
        bookmarkIconSize: clampNumber(parsed.bookmarkIconSize, 20, 64, base.bookmarkIconSize),
        bookmarkTextSize: clampNumber(parsed.bookmarkTextSize, 10, 18, base.bookmarkTextSize),
        bookmarkNoReferrer: parsed.bookmarkNoReferrer === false ? false : true
      };
    } catch (e) {
      return defaultSettings();
    }
  }

  function saveSettings(s) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (e) {}
  }

  function enabledEngines(settings) {
    return ENGINES.filter(function (e) { return !!settings.engines[e.id]; });
  }

  function engineById(id) {
    for (var i = 0; i < ENGINES.length; i++) {
      if (ENGINES[i].id === id) return ENGINES[i];
    }
    return ENGINES[0];
  }

  function applyTheme(theme) {
    var html = document.documentElement;
    if (theme === 'light' || theme === 'dark') {
      html.setAttribute('data-theme', theme);
    } else {
      html.removeAttribute('data-theme');
    }
  }

  function faviconFor(url) {
    try {
      var host = new URL(url).hostname;
      return 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(host) + '&sz=64';
    } catch (e) {
      return 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(url) + '&sz=64';
    }
  }

  function normalizeUrl(u) {
    var v = (u || '').trim();
    if (!v) return '';
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) v = 'https://' + v;
    return v;
  }

  function applyBookmarkStyle(settings) {
    var bar = document.getElementById('bookmarks');
    if (!bar) return;
    bar.style.setProperty('--bookmark-icon-size', settings.bookmarkIconSize + 'px');
    bar.style.setProperty('--bookmark-text-size', settings.bookmarkTextSize + 'px');
  }

  function linkRel(settings) {
    return settings.bookmarkNoReferrer ? 'noopener noreferrer' : 'noopener';
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

  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('read-failed')); };
      reader.readAsDataURL(file);
    });
  }

  function initClipSaver() {
    var input = document.getElementById('clipInput');
    var saveBtn = document.getElementById('clipSave');
    var statusEl = document.getElementById('clipStatus');
    var openLink = document.getElementById('clipOpen');
    if (!input || !saveBtn) return;

    var statusTimer = null;
    function status(msg, kind) {
      if (!statusEl) return;
      statusEl.textContent = msg;
      statusEl.className = 'clip-status' + (kind ? ' ' + kind : '');
      if (statusTimer) clearTimeout(statusTimer);
      if (msg) statusTimer = setTimeout(function () { status('', ''); }, 4000);
    }

    function refreshCount() {
      if (!openLink) return;
      var n = loadClips().length;
      openLink.textContent = n ? 'Vault (' + n + ') \u2192' : 'Vault \u2192';
    }

    function saveText() {
      var text = input.value;
      if (!text || !text.trim()) { status('Write or paste something first.', 'err'); input.focus(); return; }
      try {
        addClip({ id: 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36), kind: 'text', text: text, createdAt: Date.now() });
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
              addClip({ id: 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36), kind: 'file', name: f.name || 'pasted-file', mime: f.type || 'application/octet-stream', size: f.size, dataUrl: dataUrl, createdAt: Date.now() });
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

    saveBtn.addEventListener('click', saveText);
    input.addEventListener('keydown', function (ev) {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
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

  function renderBookmarks(settings, onAdd, onEdit) {
    var bar = document.getElementById('bookmarks');
    if (!bar) return;
    bar.innerHTML = '';
    applyBookmarkStyle(settings);
    var items = settings.bookmarks.filter(function (b) { return b && b.url; });
    items.forEach(function (b) {
      var wrap = document.createElement('div');
      wrap.className = 'bookmark-wrap';
      var a = document.createElement('a');
      a.className = 'bookmark';
      a.href = b.url;
      a.rel = linkRel(settings);
      if (settings.bookmarkNoReferrer) a.referrerPolicy = 'no-referrer';
      var title = b.title || b.url;
      a.title = title;
      var img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = faviconFor(b.url);
      var label = document.createElement('span');
      label.textContent = title;
      a.appendChild(img);
      a.appendChild(label);
      var menu = document.createElement('button');
      menu.type = 'button';
      menu.className = 'bookmark-menu';
      menu.title = 'Edit bookmark';
      menu.setAttribute('aria-label', 'Edit bookmark ' + title);
      menu.textContent = '\u22EE';
      menu.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (onEdit) onEdit(b);
      });
      wrap.appendChild(a);
      wrap.appendChild(menu);
      bar.appendChild(wrap);
    });

    var add = document.createElement('button');
    add.type = 'button';
    add.className = 'bookmark bookmark-add';
    add.title = 'Add bookmark';
    add.setAttribute('aria-label', 'Add bookmark');
    var plus = document.createElement('span');
    plus.className = 'bookmark-add-icon';
    plus.textContent = '+';
    var addLabel = document.createElement('span');
    addLabel.textContent = items.length ? 'Add' : 'Add bookmark';
    add.appendChild(plus);
    add.appendChild(addLabel);
    add.addEventListener('click', function () { if (onAdd) onAdd(); });
    bar.appendChild(add);
  }

  function initBookmarkModal(settings, rerender) {
    var modal = document.getElementById('bookmarkModal');
    var titleEl = document.getElementById('bookmarkModalTitle');
    var nameInput = document.getElementById('bookmarkTitle');
    var urlInput = document.getElementById('bookmarkUrl');
    var errorEl = document.getElementById('bookmarkError');
    var saveBtn = document.getElementById('bookmarkSave');
    var cancelBtn = document.getElementById('bookmarkCancel');
    var deleteBtn = document.getElementById('bookmarkDelete');
    if (!modal || !nameInput || !urlInput || !saveBtn || !cancelBtn) return null;

    var editingId = null;

    function showError(msg) {
      if (!errorEl) return;
      if (!msg) errorEl.setAttribute('hidden', '');
      else {
        errorEl.textContent = msg;
        errorEl.removeAttribute('hidden');
      }
    }

    function open(mode, bookmark) {
      editingId = mode === 'edit' && bookmark ? bookmark.id : null;
      if (titleEl) titleEl.textContent = mode === 'edit' ? 'Edit bookmark' : 'Add bookmark';
      if (saveBtn) saveBtn.textContent = mode === 'edit' ? 'Done' : 'Add';
      if (deleteBtn) deleteBtn.hidden = mode !== 'edit';
      nameInput.value = bookmark && bookmark.title ? bookmark.title : '';
      urlInput.value = bookmark && bookmark.url ? bookmark.url : '';
      showError('');
      modal.removeAttribute('hidden');
      setTimeout(function () { (mode === 'edit' ? nameInput : urlInput).focus(); }, 0);
    }

    function close() {
      modal.setAttribute('hidden', '');
      editingId = null;
      showError('');
    }

    saveBtn.addEventListener('click', function () {
      var url = normalizeUrl(urlInput.value);
      if (!url) { showError('Enter a URL'); urlInput.focus(); return; }
      try { new URL(url); } catch (e) { showError('Invalid URL'); urlInput.focus(); return; }
      var title = nameInput.value.trim() || url;
      if (editingId) {
        for (var i = 0; i < settings.bookmarks.length; i++) {
          if (settings.bookmarks[i] && settings.bookmarks[i].id === editingId) {
            settings.bookmarks[i].title = title;
            settings.bookmarks[i].url = url;
          }
        }
      } else {
        settings.bookmarks.push({ id: 'b' + Date.now(), title: title, url: url });
      }
      saveSettings(settings);
      close();
      rerender();
    });

    if (deleteBtn) {
      deleteBtn.addEventListener('click', function () {
        if (!editingId) return;
        settings.bookmarks = settings.bookmarks.filter(function (b) { return !b || b.id !== editingId; });
        saveSettings(settings);
        close();
        rerender();
      });
    }

    cancelBtn.addEventListener('click', close);
    modal.addEventListener('click', function (ev) { if (ev.target === modal) close(); });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !modal.hasAttribute('hidden')) close();
      if (ev.key === 'Enter' && !modal.hasAttribute('hidden') && document.activeElement !== saveBtn) {
        ev.preventDefault();
        saveBtn.click();
      }
    });

    return { open: open, close: close };
  }

  function init() {
    var settings = loadSettings();
    applyTheme(settings.theme);

    var titleEl = document.getElementById('siteTitle');
    var name = settings.siteName || 'favs.eu.org';
    if (titleEl) titleEl.textContent = name;
    document.title = name;

    var enabled = enabledEngines(settings);
    if (!enabled.length) enabled = [ENGINES[0]];

    var current = engineById(settings.defaultEngine);
    if (!settings.engines[current.id]) current = enabled[0];

    var select = document.getElementById('engineSelect');
    var input = document.getElementById('searchInput');
    var form = document.getElementById('searchForm');

    if (select) {
      select.innerHTML = '';
      if (enabled.length > 1) {
        select.removeAttribute('hidden');
        enabled.forEach(function (e) {
          var opt = document.createElement('option');
          opt.value = e.id;
          opt.textContent = e.name;
          select.appendChild(opt);
        });
        select.value = current.id;
        if (input) input.placeholder = engineById(select.value).placeholder;
        select.addEventListener('change', function () {
          if (input) {
            input.placeholder = engineById(select.value).placeholder;
            input.focus();
          }
        });
      } else {
        select.setAttribute('hidden', '');
      }
    }

    if (input && !input.placeholder) input.placeholder = current.placeholder;

    if (form && input) {
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var q = input.value.trim();
        if (!q) return;
        var id = select && !select.hasAttribute('hidden') ? select.value : current.id;
        var engine = engineById(id);
        var url = engine.template.replace('%s', encodeURIComponent(q));
        window.location.href = url;
      });
    }

    function rerenderBookmarks() { renderBookmarks(settings, openAdd, openEdit); }
    function openAdd() { if (modalCtl) modalCtl.open('add', null); }
    function openEdit(b) { if (modalCtl) modalCtl.open('edit', b); }
    var modalCtl = initBookmarkModal(settings, rerenderBookmarks);
    rerenderBookmarks();
    initClipSaver();
    registerServiceWorker();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
