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
    { id: 'lfm25-350m', name: 'LFM2.5 350M', repo: 'LiquidAI/LFM2.5-350M-GGUF', file: 'LFM2.5-350M-Q4_K_M.gguf', size: '~200 MB', desc: 'Default. Tiny, fast, tiny download.', defaults: { temperature: 0.7, topP: 0.9, repeatPenalty: 1.0 } },
    { id: 'gemma3-270m', name: 'Gemma 3 270M IT', repo: 'unsloth/gemma-3-270m-it-GGUF', file: 'gemma-3-270m-it-Q4_K_M.gguf', size: '~250 MB', desc: 'Google edge model. Good for short rewrites.', defaults: { temperature: 0.7, topP: 0.9, repeatPenalty: 1.0 } },
    { id: 'minicpm5-2b', name: 'MiniCPM5 2B', repo: 'gooseyai/MiniCPM5-2B-GGUF', file: 'minicpm_Q4_K_M.gguf', size: '~1.8 GB', desc: 'MiniCPM 2B. Strong mid-size, bigger download. Needs repeat-penalty 1.15 or it loops.', defaults: { temperature: 1.0, topP: 0.95, repeatPenalty: 1.15 } },
    { id: 'gemma4-e2b', name: 'Gemma 4 E2B IT', repo: 'ryanhlewis/gemma-4-E2B-it-qat-q4_0-gguf-webgpu', file: 'gemma-4-E2B_q4_0-it-00001-of-00005.gguf', size: '~3.3 GB', desc: 'Official Google QAT weights, split for browser. Smartest, huge download, experimental.', defaults: { temperature: 0.7, topP: 0.9, repeatPenalty: 1.0 } }
  ];

  var CTX_OPTIONS = [2048, 4096, 8192, 16384, 32768];

  function modelDefaults(id) {
    var m = modelById(id);
    if (m && m.defaults) return m.defaults;
    return { temperature: 0.7, topP: 0.9, repeatPenalty: 1.0 };
  }

  function defaultSettings() {
    return {
      siteName: 'favs.eu.org',
      theme: 'system',
      modelId: 'lfm25-350m',
      nCtx: 4096,
      maxTokens: 512,
      temperature: 0.7,
      topP: 0.9,
      repeatPenalty: 1.0
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
      var fallback = modelDefaults(modelId);
      return {
        siteName: typeof parsed.siteName === 'string' && parsed.siteName.trim() ? parsed.siteName : base.siteName,
        theme: parsed.theme === 'light' || parsed.theme === 'dark' ? parsed.theme : 'system',
        modelId: modelId,
        nCtx: nCtx,
        maxTokens: clampNumber(parsed.maxTokens, 64, 4096, base.maxTokens),
        temperature: (function () {
          var t = Number(parsed.temperature);
          if (!isFinite(t)) return fallback.temperature;
          if (t < 0) return 0;
          if (t > 2) return 2;
          return Math.round(t * 10) / 10;
        })(),
        topP: (function () {
          var t = Number(parsed.topP);
          if (!isFinite(t)) return fallback.topP;
          if (t < 0.05) return 0.05;
          if (t > 1) return 1;
          return Math.round(t * 100) / 100;
        })(),
        repeatPenalty: (function () {
          var t = Number(parsed.repeatPenalty);
          if (!isFinite(t)) return fallback.repeatPenalty;
          if (t < 1) return 1;
          if (t > 2) return 2;
          return Math.round(t * 100) / 100;
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
    out.topP = s.topP;
    out.repeatPenalty = s.repeatPenalty;
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
          // Switching models applies that model's recommended sampling.
          // MiniCPM5 ships documented settings (temp 1.0 / top-p 0.95 /
          // repeat-penalty 1.15) — without the penalty it loops mid-thought.
          var d = modelDefaults(m.id);
          settings.temperature = d.temperature;
          settings.topP = d.topP;
          settings.repeatPenalty = d.repeatPenalty;
          saveSettings(settings);
          renderModels(settings);
          renderModelParams(settings);
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
    var topP = document.getElementById('topP');
    var topPVal = document.getElementById('topPVal');
    var repeatPenalty = document.getElementById('repeatPenalty');
    var repeatPenaltyVal = document.getElementById('repeatPenaltyVal');
    if (nCtx) nCtx.value = String(settings.nCtx);
    if (maxTokens) {
      maxTokens.value = settings.maxTokens;
      if (maxTokensVal) maxTokensVal.textContent = settings.maxTokens;
    }
    if (temperature) {
      temperature.value = settings.temperature;
      if (temperatureVal) temperatureVal.textContent = settings.temperature;
    }
    if (topP) {
      topP.value = settings.topP;
      if (topPVal) topPVal.textContent = settings.topP;
    }
    if (repeatPenalty) {
      repeatPenalty.value = settings.repeatPenalty;
      if (repeatPenaltyVal) repeatPenaltyVal.textContent = settings.repeatPenalty;
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

  // Downloaded-models manager: the wllama weight cache lives in OPFS
  // (navigator.storage "cache" dir, NOT localStorage). Read it directly so
  // this page stays light — no need to boot the WASM engine just to list
  // or delete files. Each weight file has a "__metadata__" sidecar with
  // its original URL; both are removed on delete.
  var CACHE_DIR = 'cache';
  var META_PREFIX = '__metadata__';

  function fmtMB(bytes) {
    return (Number(bytes) / 1048576).toFixed(1) + ' MB';
  }

  function cacheEls() {
    return {
      list: document.getElementById('cacheList'),
      summary: document.getElementById('cacheSummary'),
      refresh: document.getElementById('cacheRefresh'),
      clear: document.getElementById('cacheClear')
    };
  }

  function getCacheDir(create) {
    return navigator.storage.getDirectory().then(function (root) {
      return root.getDirectoryHandle(CACHE_DIR, { create: !!create });
    });
  }

  function readCacheMeta(dir, name) {
    return dir.getFileHandle(META_PREFIX + name).then(function (h) {
      return h.getFile();
    }).then(function (file) {
      return file.text();
    }).then(function (text) {
      try { return JSON.parse(text); } catch (e) { return null; }
    }).catch(function () { return null; });
  }

  // True for wllama model files: metadata sidecars, weight files that have
  // a sidecar, or hash-prefixed keys (older cache entries without sidecar).
  function isModelFile(dir, name) {
    if (name.indexOf(META_PREFIX) === 0) return Promise.resolve(true);
    if (/^[0-9a-f]{40}_/i.test(name)) return Promise.resolve(true);
    return readCacheMeta(dir, name).then(function (meta) { return !!meta; });
  }

  function refreshCacheList() {
    var els = cacheEls();
    if (!els.list || !els.summary) return Promise.resolve();
    if (!navigator.storage || !navigator.storage.getDirectory) {
      els.summary.textContent = 'File cache is not supported in this browser.';
      els.list.innerHTML = '';
      return Promise.resolve();
    }
    els.summary.textContent = 'Checking downloaded files…';
    var usageLine = '';
    var persistedLine = '';
    var estimateP = Promise.resolve(null);
    try {
      estimateP = navigator.storage.estimate ? navigator.storage.estimate() : Promise.resolve(null);
    } catch (e) { estimateP = Promise.resolve(null); }
    var persistedP = Promise.resolve(null);
    try {
      persistedP = (navigator.storage.persisted) ? navigator.storage.persisted() : Promise.resolve(null);
    } catch (e) { persistedP = Promise.resolve(null); }
    return Promise.all([estimateP, persistedP]).then(function (res) {
      var est = res[0];
      var persisted = res[1];
      if (est && typeof est.usage === 'number') {
        usageLine = 'Using ' + fmtMB(est.usage);
        if (typeof est.quota === 'number' && est.quota > 0) usageLine += ' of ~' + fmtMB(est.quota);
        usageLine += '. ';
      }
      if (persisted === true) persistedLine = 'Kept on this device. ';
      else if (persisted === false) persistedLine = 'Not marked persistent — the browser may clear it under disk pressure. Open the start page once to request persistence. ';
      return getCacheDir(false).then(function (dir) {
        var files = [];
        var iter = dir.entries();
        function next() {
          return iter.next().then(function (r) {
            if (r.done) return files;
            var name = r.value[0];
            var handle = r.value[1];
            if (handle && handle.kind === 'file' && name.indexOf(META_PREFIX) !== 0) {
              return handle.getFile().then(function (f) {
                files.push({ name: name, size: f.size });
              }).catch(function () {}).then(next);
            }
            return next();
          });
        }
        return next().then(function () { return { dir: dir, files: files }; });
      }).catch(function () { return { dir: null, files: [] }; });
    }).then(function (out) {
      var dir = out.dir;
      var files = out.files;
      if (!dir) {
        els.summary.textContent = usageLine + persistedLine + 'No downloaded models yet.';
        els.list.innerHTML = '';
        return;
      }
      // Attach original URLs from metadata sidecars for readable names.
      var withMeta = files.map(function (f) {
        return readCacheMeta(dir, f.name).then(function (meta) {
          f.meta = meta;
          return f;
        });
      });
      return Promise.all(withMeta).then(function (all) {
        all.sort(function (a, b) { return b.size - a.size; });
        var total = all.reduce(function (acc, f) { return acc + f.size; }, 0);
        if (!all.length) {
          els.summary.textContent = usageLine + persistedLine + 'No downloaded models yet.';
          els.list.innerHTML = '';
          return;
        }
        els.summary.textContent = usageLine + persistedLine + all.length + ' file' + (all.length === 1 ? '' : 's') + ' · ' + fmtMB(total) + ' total. Deleting frees the space immediately.';
        els.list.innerHTML = '';
        all.forEach(function (f) {
          var url = f.meta && f.meta.originalURL ? String(f.meta.originalURL) : '';
          var base = url ? url.split('/').pop() : f.name;
          var row = document.createElement('div');
          row.className = 'cache-item';
          var body = document.createElement('div');
          body.className = 'cache-body';
          var name = document.createElement('strong');
          name.textContent = base;
          var size = document.createElement('span');
          size.className = 'cache-size';
          size.textContent = fmtMB(f.size);
          var sub = document.createElement('small');
          sub.textContent = url || f.name;
          body.appendChild(name);
          body.appendChild(size);
          body.appendChild(sub);
          var del = document.createElement('button');
          del.type = 'button';
          del.className = 'cache-del';
          del.textContent = 'Delete';
          del.addEventListener('click', function () {
            del.disabled = true;
            del.textContent = 'Deleting…';
            dir.removeEntry(f.name).catch(function () {}).then(function () {
              return dir.removeEntry(META_PREFIX + f.name).catch(function () {});
            }).then(function () {
              toast('Deleted ' + base);
              refreshCacheList();
            }).catch(function () {
              toast('Could not delete ' + base);
              refreshCacheList();
            });
          });
          row.appendChild(body);
          row.appendChild(del);
          els.list.appendChild(row);
        });
      });
    }).catch(function () {
      els.summary.textContent = 'Could not read the download cache.';
    });
  }

  function initCacheManager() {
    var els = cacheEls();
    if (!els.list) return;
    if (els.refresh) els.refresh.addEventListener('click', function () { refreshCacheList(); });
    if (els.clear) els.clear.addEventListener('click', function () {
      if (!window.confirm('Delete all downloaded models? They will download again on next use.')) return;
      if (!navigator.storage || !navigator.storage.getDirectory) return;
      // Scope deletion to wllama model files (hash-prefixed weight files
      // and their metadata sidecars) — never touch anything else in storage.
      getCacheDir(false).then(function (dir) {
        var names = [];
        var iter = dir.entries();
        function next() {
          return iter.next().then(function (r) {
            if (r.done) return names;
            if (r.value[1] && r.value[1].kind === 'file') names.push(r.value[0]);
            return next();
          });
        }
        return next().then(function () { return { dir: dir, names: names }; });
      }).then(function (out) {
        var checks = out.names.map(function (n) {
          return isModelFile(out.dir, n).then(function (yes) {
            return { name: n, keep: !yes };
          });
        });
        return Promise.all(checks).then(function (flags) { return { dir: out.dir, flags: flags }; });
      }).then(function (out) {
        var chain = Promise.resolve();
        out.flags.forEach(function (f) {
          if (f.keep) return;
          chain = chain.then(function () { return out.dir.removeEntry(f.name).catch(function () {}); });
        });
        return chain;
      }).then(function () {
        toast('Download cache cleared');
        refreshCacheList();
      }).catch(function () {
        toast('Could not clear the cache');
      });
    });
    // Refresh whenever the Model section is opened.
    document.querySelectorAll('.settings-nav button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.getAttribute('data-section') === 'model') refreshCacheList();
      });
    });
    refreshCacheList();
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
    initCacheManager();

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
    var topP = document.getElementById('topP');
    if (topP) {
      topP.addEventListener('input', function () {
        var t = Number(topP.value);
        if (!isFinite(t)) return;
        if (t < 0.05) t = 0.05;
        if (t > 1) t = 1;
        settings.topP = Math.round(t * 100) / 100;
        var v = document.getElementById('topPVal');
        if (v) v.textContent = settings.topP;
        saveSettings(settings);
      });
    }
    var repeatPenalty = document.getElementById('repeatPenalty');
    if (repeatPenalty) {
      repeatPenalty.addEventListener('input', function () {
        var t = Number(repeatPenalty.value);
        if (!isFinite(t)) return;
        if (t < 1) t = 1;
        if (t > 2) t = 2;
        settings.repeatPenalty = Math.round(t * 100) / 100;
        var v = document.getElementById('repeatPenaltyVal');
        if (v) v.textContent = settings.repeatPenalty;
        saveSettings(settings);
      });
    }
    var samplingDefaults = document.getElementById('samplingDefaults');
    if (samplingDefaults) {
      samplingDefaults.addEventListener('click', function () {
        var d = modelDefaults(settings.modelId);
        settings.temperature = d.temperature;
        settings.topP = d.topP;
        settings.repeatPenalty = d.repeatPenalty;
        saveSettings(settings);
        renderModelParams(settings);
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
        settings.topP = fresh.topP;
        settings.repeatPenalty = fresh.repeatPenalty;
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
