/* FAVS vault page — private clips in localStorage key "favs.clips.v1".
 * Search is plain keyword matching.
 */
(function () {
  'use strict';

  var CLIPS_KEY = 'favs.clips.v1';
  var SEARCH_DEBOUNCE_MS = 250;

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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/`/g, '&#96;');
  }

  function linkify(text) {
    var parts = String(text).split(/(\bhttps?:\/\/[^\s<>"')\]]+)/g);
    var out = '';
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (i % 2 === 1) {
        var url = p.replace(/[.,;:!?]+$/, '');
        var trail = p.slice(url.length);
        out += '<a href="' + escapeAttr(url) + '" rel="noopener noreferrer" referrerpolicy="no-referrer" target="_blank">' + escapeHtml(url) + '</a>' + escapeHtml(trail);
      } else {
        out += escapeHtml(p);
      }
    }
    return out;
  }

  function formatDate(ts) {
    try {
      return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch (e) {
      return '';
    }
  }

  function formatFileSize(n) {
    if (typeof n !== 'number' || !(n >= 0)) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (Math.round(n / 102.4) / 10) + ' KB';
    return (Math.round(n / 104857.6) / 10) + ' MB';
  }

  // Long pastes collapse so the history stays scannable.
  var CLAMP_CHARS = 600;

  function isImage(clip) {
    if (clip.mime && clip.mime.indexOf('image/') === 0) return true;
    return typeof clip.dataUrl === 'string' && clip.dataUrl.indexOf('data:image/') === 0;
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

  function copyText(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      done(!!ok);
    } catch (e) {
      done(false);
    }
  }

  function keywordFilter(clips, q) {
    var query = (q || '').trim().toLowerCase();
    if (!query) return clips.slice();
    return clips.filter(function (c) {
      var hay = (((c && c.text) || '') + '\n' + ((c && c.name) || '')).toLowerCase();
      return hay.indexOf(query) !== -1;
    });
  }

  function runSearch() {
    var q = searchInput ? searchInput.value : '';
    render(keywordFilter(loadClips(), q), q);
  }

  function render(shown, query) {
    var clips = loadClips();
    var list = document.getElementById('clipList');
    var empty = document.getElementById('clipEmpty');
    var noResults = document.getElementById('clipNoResults');
    var noQuery = document.getElementById('clipNoQuery');
    var meta = document.getElementById('clipMeta');
    var count = document.getElementById('clipCount');
    if (!list) return;

    var q = (query || '').trim();
    if (count) count.textContent = clips.length ? clips.length + (clips.length === 1 ? ' clip' : ' clips') : '';
    if (meta) {
      if (q) {
        meta.hidden = false;
        meta.textContent = shown.length === clips.length
          ? clips.length + (clips.length === 1 ? ' clip' : ' clips')
          : shown.length + ' of ' + clips.length + (shown.length === 1 ? ' match' : ' matches');
      } else {
        meta.hidden = true;
        meta.textContent = '';
      }
    }
    list.innerHTML = '';
    var hasClips = clips.length !== 0;
    if (empty) empty.hidden = hasClips;
    if (noResults) noResults.hidden = !hasClips || shown.length !== 0;
    if (noQuery) noQuery.textContent = q;

    shown.forEach(function (clip) {
      var card = document.createElement('article');
      card.className = 'clip-card';

      var head = document.createElement('div');
      head.className = 'clip-head';
      var date = document.createElement('span');
      date.className = 'clip-date';
      date.textContent = clip.createdAt ? formatDate(clip.createdAt) : '';
      try {
        if (clip.createdAt) date.title = new Date(clip.createdAt).toLocaleString();
      } catch (e) {}
      head.appendChild(date);

      var actions = document.createElement('div');
      actions.className = 'clip-actions';

      function addBtn(label, fn, extraClass) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'mini-btn' + (extraClass ? ' ' + extraClass : '');
        b.textContent = label;
        b.addEventListener('click', fn);
        actions.appendChild(b);
        return b;
      }

      var body = document.createElement('div');
      body.className = 'clip-body';

      if (clip.kind === 'file' && clip.dataUrl) {
        if (isImage(clip)) {
          var img = document.createElement('img');
          img.className = 'clip-image';
          img.alt = clip.name || 'saved image';
          img.loading = 'lazy';
          img.src = clip.dataUrl;
          body.appendChild(img);
        }
        var fileRow = document.createElement('div');
        fileRow.className = 'clip-file-row';
        var nameEl = document.createElement('span');
        nameEl.className = 'clip-file-name';
        nameEl.textContent = clip.name || 'file';
        fileRow.appendChild(nameEl);
        var sizeText = formatFileSize(clip.size);
        if (sizeText) {
          var sizeEl = document.createElement('span');
          sizeEl.className = 'clip-file-size';
          sizeEl.textContent = sizeText;
          fileRow.appendChild(sizeEl);
        }
        body.appendChild(fileRow);
        var dl = document.createElement('a');
        dl.className = 'mini-btn mini-link';
        dl.href = clip.dataUrl;
        dl.download = clip.name || 'clip';
        dl.rel = 'noopener noreferrer';
        dl.textContent = 'Download';
        actions.appendChild(dl);
      } else {
        var text = document.createElement('div');
        text.className = 'clip-text';
        text.innerHTML = linkify(clip.text || '');
        body.appendChild(text);
        if ((clip.text || '').length > CLAMP_CHARS) {
          text.classList.add('clamped');
          var toggle = document.createElement('button');
          toggle.type = 'button';
          toggle.className = 'link-btn clip-toggle';
          toggle.textContent = 'Show more';
          toggle.addEventListener('click', function () {
            var collapsed = text.classList.toggle('clamped');
            toggle.textContent = collapsed ? 'Show more' : 'Show less';
          });
          body.appendChild(toggle);
        }
        var urls = String(clip.text || '').match(/https?:\/\/[^\s<>"')\]]+/g) || [];
        if (urls.length === 1) {
          var open = document.createElement('a');
          open.className = 'mini-btn mini-link';
          open.href = urls[0].replace(/[.,;:!?]+$/, '');
          open.target = '_blank';
          open.rel = 'noopener noreferrer';
          open.referrerPolicy = 'no-referrer';
          open.textContent = 'Open link';
          actions.appendChild(open);
        }
        addBtn('Copy', function () {
          copyText(clip.text || '', function (ok) { toast(ok ? 'Copied' : 'Copy failed'); });
        });
      }

      addBtn('Delete', function () {
        if (!window.confirm('Delete this clip?')) return;
        storeClips(loadClips().filter(function (c) { return !c || c.id !== clip.id; }));
        toast('Deleted');
        runSearch();
      }, 'danger');

      head.appendChild(actions);
      card.appendChild(head);
      card.appendChild(body);
      list.appendChild(card);
    });
  }

  var searchInput = null;
  var searchTimer = null;

  function exportClips() {
    var clips = loadClips();
    if (!clips.length) { toast('Nothing to export'); return; }
    try {
      var blob = new Blob([JSON.stringify(clips, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'favs-vault.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 500);
      toast('Exported ' + clips.length + (clips.length === 1 ? ' clip' : ' clips'));
    } catch (e) {
      toast('Export failed');
    }
  }

  function clearSearch() {
    if (!searchInput) return;
    if (!searchInput.value) return;
    searchInput.value = '';
    runSearch();
    searchInput.focus();
  }

  function init() {
    // One-time cleanup of the removed embedding vector cache.
    try { localStorage.removeItem('favs.embeddings.v1'); } catch (e) {}
    searchInput = document.getElementById('clipSearch');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        if (searchTimer) clearTimeout(searchTimer);
        if (!searchInput.value) { runSearch(); return; }
        searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
      });
      // Native clear (x) button fires `search` — apply it immediately.
      searchInput.addEventListener('search', runSearch);
      searchInput.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && searchInput.value) {
          ev.preventDefault();
          clearSearch();
        }
      });
      searchInput.focus();
    }
    // Press `/` anywhere to jump back to search.
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      var tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (searchInput) {
        ev.preventDefault();
        searchInput.focus();
      }
    });
    var clearSearchBtn = document.getElementById('clipClearSearch');
    if (clearSearchBtn) clearSearchBtn.addEventListener('click', clearSearch);
    var exp = document.getElementById('clipExport');
    if (exp) exp.addEventListener('click', exportClips);
    var clear = document.getElementById('clipClear');
    if (clear) {
      clear.addEventListener('click', function () {
        var clips = loadClips();
        if (!clips.length) { toast('Vault is already empty'); return; }
        if (!window.confirm('Delete all ' + clips.length + ' clips? This cannot be undone.')) return;
        storeClips([]);
        toast('Vault cleared');
        runSearch();
      });
    }
    runSearch();
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
