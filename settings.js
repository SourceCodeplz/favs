/* FAVS settings page. Sections: general / appearance / engines / bookmarks. */
(function () {
  'use strict';

  var STORAGE_KEY = 'favs.settings.v1';

  var ENGINES = [
    { id: 'google', name: 'Google', template: 'https://www.google.com/search?q=%s' },
    { id: 'bing', name: 'Bing', template: 'https://www.bing.com/search?q=%s' },
    { id: 'duckduckgo', name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' },
    { id: 'brave', name: 'Brave', template: 'https://search.brave.com/search?q=%s' },
    { id: 'yahoo', name: 'Yahoo', template: 'https://search.yahoo.com/search?p=%s' },
    { id: 'ecosia', name: 'Ecosia', template: 'https://www.ecosia.org/search?q=%s' },
    { id: 'startpage', name: 'Startpage', template: 'https://www.startpage.com/sp/search?query=%s' },
    { id: 'perplexity', name: 'Perplexity', template: 'https://www.perplexity.ai/search?q=%s' },
    { id: 'you', name: 'You.com', template: 'https://you.com/search?q=%s' },
    { id: 'wikipedia', name: 'Wikipedia', template: 'https://en.wikipedia.org/wiki/Special:Search?search=%s' }
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    applyTheme(s.theme);
    toast('Saved');
  }

  function applyTheme(theme) {
    var html = document.documentElement;
    if (theme === 'light' || theme === 'dark') html.setAttribute('data-theme', theme);
    else html.removeAttribute('data-theme');
  }

  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 1500);
  }

  function normalizeUrl(u) {
    var v = (u || '').trim();
    if (!v) return '';
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) v = 'https://' + v;
    return v;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function enabledCount(settings) {
    return ENGINES.filter(function (e) { return !!settings.engines[e.id]; }).length;
  }

  function renderEngines(settings) {
    var list = document.getElementById('engineList');
    var defSel = document.getElementById('defaultEngine');
    var hint = document.getElementById('engineHint');
    if (!list || !defSel) return;
    list.innerHTML = '';
    defSel.innerHTML = '';

    ENGINES.forEach(function (e) {
      var on = !!settings.engines[e.id];

      var row = document.createElement('label');
      row.className = 'engine-item';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = on;
      cb.setAttribute('data-engine', e.id);
      cb.addEventListener('change', function () {
        if (cb.checked) {
          settings.engines[e.id] = true;
        } else {
          // Keep at least one engine enabled.
          var after = enabledCount(settings) - (settings.engines[e.id] ? 1 : 0);
          if (after < 1) {
            cb.checked = true;
            toast('Keep at least one engine enabled');
            return;
          }
          delete settings.engines[e.id];
          if (settings.defaultEngine === e.id) {
            var remaining = ENGINES.filter(function (x) { return !!settings.engines[x.id]; });
            settings.defaultEngine = remaining.length ? remaining[0].id : 'google';
          }
        }
        saveSettings(settings);
        renderEngines(settings);
      });
      var name = document.createElement('span');
      name.innerHTML = '<strong>' + escapeHtml(e.name) + '</strong><br><small style="color:var(--text-muted)">' + escapeHtml(e.template) + '</small>';
      row.appendChild(cb);
      row.appendChild(name);
      list.appendChild(row);

      if (on) {
        var opt = document.createElement('option');
        opt.value = e.id;
        opt.textContent = e.name;
        defSel.appendChild(opt);
      }
    });

    defSel.value = settings.defaultEngine;
    if (hint) {
      var n = enabledCount(settings);
      hint.textContent = n > 1
        ? n + ' engines enabled — a dropdown will appear on the start page.'
        : 'Only one engine enabled — the start page search goes straight to ' + settings.defaultEngine + '.';
    }
  }

  function renderBookmarkSettings(settings) {
    var icon = document.getElementById('bookmarkIconSize');
    var iconVal = document.getElementById('bookmarkIconSizeVal');
    var text = document.getElementById('bookmarkTextSize');
    var textVal = document.getElementById('bookmarkTextSizeVal');
    var noRef = document.getElementById('bookmarkNoReferrer');
    if (icon) {
      icon.value = settings.bookmarkIconSize;
      if (iconVal) iconVal.textContent = settings.bookmarkIconSize;
    }
    if (text) {
      text.value = settings.bookmarkTextSize;
      if (textVal) textVal.textContent = settings.bookmarkTextSize;
    }
    if (noRef) noRef.checked = settings.bookmarkNoReferrer !== false;
  }

  function switchSection(name) {
    document.querySelectorAll('.settings-nav button').forEach(function (btn) {
      btn.setAttribute('aria-selected', btn.getAttribute('data-section') === name ? 'true' : 'false');
    });
    document.querySelectorAll('.settings-section').forEach(function (sec) {
      sec.hidden = sec.getAttribute('data-section-panel') !== name;
    });
    try { window.location.hash = name; } catch (e) {}
  }

  function init() {
    var settings = loadSettings();
    applyTheme(settings.theme);

    // Nav
    document.querySelectorAll('.settings-nav button').forEach(function (btn) {
      btn.addEventListener('click', function () { switchSection(btn.getAttribute('data-section')); });
    });
    var initial = (window.location.hash || '#general').slice(1);
    if (!document.querySelector('[data-section-panel="' + initial + '"]')) initial = 'general';
    switchSection(initial);

    // General: site name
    var nameInput = document.getElementById('siteName');
    if (nameInput) {
      nameInput.value = settings.siteName;
      nameInput.addEventListener('input', function () {
        var v = nameInput.value.trim();
        settings.siteName = v || defaultSettings().siteName;
        document.title = 'Settings — ' + settings.siteName;
        saveSettings(settings);
      });
    }

    // Appearance: theme radios
    document.querySelectorAll('input[name="theme"]').forEach(function (radio) {
      radio.checked = radio.value === settings.theme;
      radio.addEventListener('change', function () {
        if (radio.checked) {
          settings.theme = radio.value;
          saveSettings(settings);
        }
      });
    });

    // Engines
    renderEngines(settings);
    var defSel = document.getElementById('defaultEngine');
    if (defSel) {
      defSel.addEventListener('change', function () {
        settings.defaultEngine = defSel.value;
        saveSettings(settings);
        renderEngines(settings);
      });
    }

    // Bookmarks: global appearance/behavior (add/edit happens on start page)
    renderBookmarkSettings(settings);
    var iconInput = document.getElementById('bookmarkIconSize');
    if (iconInput) {
      iconInput.addEventListener('input', function () {
        settings.bookmarkIconSize = clampNumber(iconInput.value, 20, 64, defaultSettings().bookmarkIconSize);
        var v = document.getElementById('bookmarkIconSizeVal');
        if (v) v.textContent = settings.bookmarkIconSize;
        saveSettings(settings);
      });
    }
    var textInput = document.getElementById('bookmarkTextSize');
    if (textInput) {
      textInput.addEventListener('input', function () {
        settings.bookmarkTextSize = clampNumber(textInput.value, 10, 18, defaultSettings().bookmarkTextSize);
        var v = document.getElementById('bookmarkTextSizeVal');
        if (v) v.textContent = settings.bookmarkTextSize;
        saveSettings(settings);
      });
    }
    var noRefInput = document.getElementById('bookmarkNoReferrer');
    if (noRefInput) {
      noRefInput.addEventListener('change', function () {
        settings.bookmarkNoReferrer = !!noRefInput.checked;
        saveSettings(settings);
      });
    }

    // Danger zone: reset
    var resetBtn = document.getElementById('resetAll');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        if (!window.confirm('Reset all settings?')) return;
        settings = defaultSettings();
        saveSettings(settings);
        if (nameInput) nameInput.value = settings.siteName;
        document.querySelectorAll('input[name="theme"]').forEach(function (r) { r.checked = r.value === settings.theme; });
        renderEngines(settings);
        renderBookmarkSettings(settings);
      });
    }

    // PWA: register the offline service worker (sw.js must stay unversioned).
    try {
      if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
          navigator.serviceWorker.register('sw.js').catch(function () {});
        });
      }
    } catch (e) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
