/* FAVS settings page. Sections: general / appearance.
 *
 * Old keys (modelId, nCtx, maxTokens, temperature, ...) are ignored on load
 * but preserved in storage so nothing is lost by upgrading.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'favs.settings.v1';

  function defaultSettings() {
    return {
      siteName: 'favs.eu.org',
      theme: 'system'
    };
  }

  function loadSettings() {
    var base = defaultSettings();
    var raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { return base; }
    if (!raw) return base;
    try {
      var parsed = JSON.parse(raw);
      return {
        siteName: typeof parsed.siteName === 'string' && parsed.siteName.trim() ? parsed.siteName : base.siteName,
        theme: parsed.theme === 'light' || parsed.theme === 'dark' ? parsed.theme : 'system',
        // Preserve unknown/legacy keys (modelId, engines, bookmarks, ...) untouched.
        _extra: parsed && typeof parsed === 'object' ? parsed : {}
      };
    } catch (e) {
      return base;
    }
  }

  function saveSettings(s) {
    var out;
    if (s && s._extra && typeof s._extra === 'object') {
      out = {};
      for (var k in s._extra) {
        if (Object.prototype.hasOwnProperty.call(s._extra, k)) out[k] = s._extra[k];
      }
    } else {
      out = {};
    }
    out.siteName = s.siteName;
    out.theme = s.theme;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch (e) {}
    s._extra = out;
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

    // Danger zone: reset
    var resetBtn = document.getElementById('resetAll');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        if (!window.confirm('Reset all settings?')) return;
        var fresh = defaultSettings();
        settings.siteName = fresh.siteName;
        settings.theme = fresh.theme;
        saveSettings(settings);
        if (nameInput) nameInput.value = settings.siteName;
        document.querySelectorAll('input[name="theme"]').forEach(function (r) { r.checked = r.value === settings.theme; });
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
