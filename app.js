/* FAVS start page. Depends on localStorage key "favs.settings.v1". */
(function () {
  'use strict';

  var STORAGE_KEY = 'favs.settings.v1';

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
      bookmarks: []
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
        engines: parsed.engines && typeof parsed.engines === 'object' ? parsed.engines : base.engines,
        defaultEngine: typeof parsed.defaultEngine === 'string' ? parsed.defaultEngine : base.defaultEngine,
        bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks : []
      };
    } catch (e) {
      return defaultSettings();
    }
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

  function renderBookmarks(settings) {
    var bar = document.getElementById('bookmarks');
    if (!bar) return;
    bar.innerHTML = '';
    var items = settings.bookmarks.filter(function (b) { return b && b.url; });
    if (!items.length) {
      bar.setAttribute('hidden', '');
      return;
    }
    bar.removeAttribute('hidden');
    items.forEach(function (b) {
      var a = document.createElement('a');
      a.className = 'bookmark';
      a.href = b.url;
      a.rel = 'noopener noreferrer';
      a.referrerPolicy = 'no-referrer';
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
      bar.appendChild(a);
    });
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

    renderBookmarks(settings);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
