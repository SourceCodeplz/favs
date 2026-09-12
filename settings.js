/* FAVS settings page. Sections: general / appearance / model.
 *
 * MODELS below must stay in sync with chat.js (same id/repo/file).
 * Old keys (engines, defaultEngine, bookmarks, ...) are ignored on load
 * but preserved in storage so nothing is lost by upgrading.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'favs.settings.v1';

  var MODELS = [
    { id: 'lfm25-350m', name: 'LFM2.5 350M', repo: 'LiquidAI/LFM2.5-350M-GGUF', file: 'LFM2.5-350M-Q4_K_M.gguf', size: '~200 MB', desc: 'Default. Tiny, fast, tiny download.' },
    { id: 'gemma3-270m', name: 'Gemma 3 270M IT', repo: 'unsloth/gemma-3-270m-it-GGUF', file: 'gemma-3-270m-it-Q4_K_M.gguf', size: '~250 MB', desc: 'Google edge model. Good for short rewrites.' },
    { id: 'gemma4-e2b', name: 'Gemma 4 E2B IT', repo: 'ryanhlewis/gemma-4-E2B-it-qat-q4_0-gguf-webgpu', file: 'gemma-4-E2B_q4_0-it-00001-of-00005.gguf', size: '~3.3 GB', desc: 'Official Google QAT weights, split for browser. Smartest, huge download, experimental.' }
  ];

  var CTX_OPTIONS = [2048, 4096, 8192, 16384, 32768];

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

  function clampNumber(v, min, max, fallback) {
    var n = Number(v);
    if (!isFinite(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return Math.round(n);
  }

  function modelById(id) {
    for (var i = 0; i < MODELS.length; i++) {
      if (MODELS[i].id === id) return MODELS[i];
    }
    return null;
  }

  function loadSettings() {
    var base = defaultSettings();
    var raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { return base; }
    if (!raw) return base;
    try {
      var parsed = JSON.parse(raw);
      var modelId = typeof parsed.modelId === 'string' ? parsed.modelId : base.modelId;
      if (!modelById(modelId)) modelId = base.modelId;
      var nCtx = Number(parsed.nCtx);
      if (CTX_OPTIONS.indexOf(nCtx) === -1) nCtx = base.nCtx;
      return {
        siteName: typeof parsed.siteName === 'string' && parsed.siteName.trim() ? parsed.siteName : base.siteName,
        theme: parsed.theme === 'light' || parsed.theme === 'dark' ? parsed.theme : 'system',
        modelId: modelId,
        nCtx: nCtx,
        maxTokens: clampNumber(parsed.maxTokens, 64, 4096, base.maxTokens),
        temperature: (function () {
          var t = Number(parsed.temperature);
          if (!isFinite(t)) return base.temperature;
          if (t < 0) return 0;
          if (t > 2) return 2;
          return Math.round(t * 10) / 10;
        })(),
        // Preserve unknown/legacy keys (engines, bookmarks, ...) untouched.
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
    out.modelId = s.modelId;
    out.nCtx = s.nCtx;
    out.maxTokens = s.maxTokens;
    out.temperature = s.temperature;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderModels(settings) {
    var list = document.getElementById('modelList');
    if (!list) return;
    list.innerHTML = '';
    MODELS.forEach(function (m) {
      var row = document.createElement('label');
      row.className = 'model-item' + (settings.modelId === m.id ? ' selected' : '');
      var radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'model';
      radio.value = m.id;
      radio.checked = settings.modelId === m.id;
      radio.addEventListener('change', function () {
        if (radio.checked) {
          settings.modelId = m.id;
          saveSettings(settings);
          renderModels(settings);
        }
      });
      var body = document.createElement('span');
      body.className = 'model-body';
      body.innerHTML = '<strong>' + escapeHtml(m.name) + '</strong>' +
        '<span class="model-size">' + escapeHtml(m.size) + '</span>' +
        '<small>' + escapeHtml(m.desc) + '<br>' + escapeHtml(m.repo + ' / ' + m.file) + '</small>';
      row.appendChild(radio);
      row.appendChild(body);
      list.appendChild(row);
    });
  }

  function renderModelParams(settings) {
    var nCtx = document.getElementById('nCtx');
    var maxTokens = document.getElementById('maxTokens');
    var maxTokensVal = document.getElementById('maxTokensVal');
    var temperature = document.getElementById('temperature');
    var temperatureVal = document.getElementById('temperatureVal');
    if (nCtx) nCtx.value = String(settings.nCtx);
    if (maxTokens) {
      maxTokens.value = settings.maxTokens;
      if (maxTokensVal) maxTokensVal.textContent = settings.maxTokens;
    }
    if (temperature) {
      temperature.value = settings.temperature;
      if (temperatureVal) temperatureVal.textContent = settings.temperature;
    }
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

    // Model: switcher + params
    renderModels(settings);
    renderModelParams(settings);

    var nCtx = document.getElementById('nCtx');
    if (nCtx) {
      nCtx.addEventListener('change', function () {
        var v = Number(nCtx.value);
        if (CTX_OPTIONS.indexOf(v) !== -1) {
          settings.nCtx = v;
          saveSettings(settings);
        }
      });
    }
    var maxTokens = document.getElementById('maxTokens');
    if (maxTokens) {
      maxTokens.addEventListener('input', function () {
        settings.maxTokens = clampNumber(maxTokens.value, 64, 4096, defaultSettings().maxTokens);
        var v = document.getElementById('maxTokensVal');
        if (v) v.textContent = settings.maxTokens;
        saveSettings(settings);
      });
    }
    var temperature = document.getElementById('temperature');
    if (temperature) {
      temperature.addEventListener('input', function () {
        var t = Number(temperature.value);
        if (!isFinite(t)) return;
        if (t < 0) t = 0;
        if (t > 2) t = 2;
        settings.temperature = Math.round(t * 10) / 10;
        var v = document.getElementById('temperatureVal');
        if (v) v.textContent = settings.temperature;
        saveSettings(settings);
      });
    }

    // Danger zone: reset
    var resetBtn = document.getElementById('resetAll');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        if (!window.confirm('Reset all settings?')) return;
        var fresh = defaultSettings();
        settings.siteName = fresh.siteName;
        settings.theme = fresh.theme;
        settings.modelId = fresh.modelId;
        settings.nCtx = fresh.nCtx;
        settings.maxTokens = fresh.maxTokens;
        settings.temperature = fresh.temperature;
        saveSettings(settings);
        if (nameInput) nameInput.value = settings.siteName;
        document.querySelectorAll('input[name="theme"]').forEach(function (r) { r.checked = r.value === settings.theme; });
        renderModels(settings);
        renderModelParams(settings);
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
