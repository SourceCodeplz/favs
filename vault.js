/* FAVS vault page — private clips in localStorage key "favs.clips.v1".
 * Search is keyword-based until the Semantic button loads EmbeddingGemma
 * (embed.js, 100% local); then clips are ranked by meaning (cosine).
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

  // ---- Semantic search state (embed.js) ----

  var semanticOn = false; // user pressed Semantic and the model is ready
  var semanticBusy = false;
  var searchSeq = 0;

  function embed() {
    return (window.favsEmbed && typeof window.favsEmbed.ensureLoaded === 'function') ? window.favsEmbed : null;
  }

  function setEmbedStatus(msg, kind) {
    var el = document.getElementById('embedStatus');
    if (!el) return;
    el.textContent = msg;
    el.className = 'embed-status' + (kind ? ' ' + kind : '');
  }

  function setEmbedProgress(done, total) {
    var wrap = document.getElementById('embedProgress');
    var bar = document.getElementById('embedProgressBar');
    if (!wrap || !bar) return;
    if (done == null || total == null) {
      wrap.setAttribute('hidden', '');
      return;
    }
    wrap.removeAttribute('hidden');
    bar.style.width = total ? Math.min(100, Math.round((done / total) * 100)) + '%' : '100%';
    if (done >= total) {
      setTimeout(function () { wrap.setAttribute('hidden', ''); }, 600);
    }
  }

  function setEmbedBtn() {
    var btn = document.getElementById('embedBtn');
    if (!btn) return;
    var st = embed() ? embed().getState() : { status: 'idle' };
    if (semanticOn && st.status === 'ready') {
      btn.textContent = 'Semantic on';
      btn.disabled = false;
      btn.title = 'Meaning search is active — press to turn it off';
    } else if (st.status === 'loading') {
      btn.textContent = 'Loading…';
      btn.disabled = true;
      btn.title = 'Downloading the embedding model';
    } else {
      btn.textContent = 'Semantic';
      btn.disabled = semanticBusy;
      btn.title = 'Enable meaning search (downloads ~320 MB once, then stays offline)';
    }
  }

  function onEmbedEvent(ev) {
    var d = (ev && ev.detail) || {};
    if (d.status === 'loading') {
      if (typeof d.loaded === 'number') setEmbedProgress(d.loaded, d.total || 0);
      setEmbedStatus(d.message || 'Loading…');
    } else if (d.status === 'ready') {
      setEmbedProgress(null);
      semanticOn = true;
      semanticBusy = false;
      setEmbedBtn();
      setEmbedStatus(d.message || 'Semantic search is on — type to search by meaning.');
      runSearch(); // re-rank the current query, if any
    } else if (d.status === 'error') {
      setEmbedProgress(null);
      semanticBusy = false;
      setEmbedBtn();
      setEmbedStatus(d.message || 'Semantic search failed.', 'err');
    }
  }

  function enableSemantic() {
    var api = embed();
    if (!api) {
      setEmbedStatus('Embedding runtime failed to load (embed.js missing?).', 'err');
      return;
    }
    if (semanticOn && api.isReady()) {
      // Toggle off — back to keyword search.
      semanticOn = false;
      setEmbedBtn();
      setEmbedStatus('Keyword search. Press Semantic for meaning search.');
      runSearch();
      return;
    }
    semanticBusy = true;
    setEmbedBtn();
    setEmbedStatus('Starting semantic search…');
    api.ensureLoaded().catch(function () {
      // Status already reported via favs:embed.
    }).then(function () {
      semanticBusy = false;
      setEmbedBtn();
    });
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
    var seq = ++searchSeq;
    var q = searchInput ? searchInput.value : '';
    var api = embed();
    if (semanticOn && api && api.isReady() && q.trim().length >= 2) {
      semanticSearch(seq, q.trim());
    } else {
      render(keywordFilter(loadClips(), q), null);
      if (!semanticOn && q.trim()) {
        setEmbedStatus('Keyword search. Press Semantic for meaning search (downloads ~320 MB once, then stays offline).');
      } else if (!q.trim() && !semanticOn) {
        setEmbedStatus('Keyword search. Press Semantic for meaning search (downloads ~320 MB once, then stays offline).');
      }
    }
  }

  function semanticSearch(seq, query) {
    var api = embed();
    var clips = loadClips();
    setEmbedStatus('Searching by meaning…');
    api.ensureIndexed(clips, function (done, total) {
      if (seq !== searchSeq) return;
      setEmbedStatus('Indexing clips… ' + done + ' / ' + total);
      setEmbedProgress(done, total);
    }).then(function (out) {
      if (seq !== searchSeq) return;
      return api.embedRaw(query).then(function (qvec) {
        if (seq !== searchSeq) return;
        var ranked = api.rankClips(qvec, clips, out.vectors);
        var scores = {};
        ranked.forEach(function (r) { scores[r.clip.id] = r.score; });
        setEmbedProgress(null);
        if (!ranked.length) {
          setEmbedStatus('Indexed ' + out.total + ' clips — nothing with text to rank.', 'err');
          render([], null);
          return;
        }
        setEmbedStatus(ranked.length + ' clips ranked by meaning' + (out.indexed ? ' (' + out.indexed + ' newly indexed).' : '.'));
        render(ranked.map(function (r) { return r.clip; }), scores);
      });
    }).catch(function (err) {
      if (seq !== searchSeq) return;
      setEmbedProgress(null);
      var msg = err && err.message ? err.message : String(err);
      setEmbedStatus('Semantic search failed: ' + msg + ' — showing keyword results.', 'err');
      render(keywordFilter(loadClips(), searchInput ? searchInput.value : ''), null);
    });
  }

  function render(shown, scores) {
    var clips = loadClips();
    var list = document.getElementById('clipList');
    var empty = document.getElementById('clipEmpty');
    var count = document.getElementById('clipCount');
    if (!list) return;

    if (count) count.textContent = clips.length ? clips.length + (clips.length === 1 ? ' clip' : ' clips') : '';
    list.innerHTML = '';
    if (empty) empty.hidden = shown.length !== 0;

    shown.forEach(function (clip) {
      var card = document.createElement('article');
      card.className = 'clip-card';

      var head = document.createElement('div');
      head.className = 'clip-head';
      var date = document.createElement('span');
      date.className = 'clip-date';
      date.textContent = clip.createdAt ? formatDate(clip.createdAt) : '';
      head.appendChild(date);

      if (scores && scores[clip.id] != null) {
        var badge = document.createElement('span');
        badge.className = 'sem-score';
        var pct = Math.max(0, Math.min(100, Math.round(scores[clip.id] * 100)));
        badge.textContent = pct + '% match';
        badge.title = 'Semantic similarity (cosine)';
        head.appendChild(badge);
      }

      var actions = document.createElement('div');
      actions.className = 'clip-actions';

      function addBtn(label, fn) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'mini-btn';
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
        var dl = document.createElement('a');
        dl.href = clip.dataUrl;
        dl.download = clip.name || 'clip';
        dl.rel = 'noopener noreferrer';
        dl.textContent = 'Download ' + (clip.name || 'file');
        fileRow.appendChild(dl);
        body.appendChild(fileRow);
        addBtn('Copy link', function () {
          copyText(clip.dataUrl, function (ok) { toast(ok ? 'Copied' : 'Copy failed'); });
        });
      } else {
        var text = document.createElement('div');
        text.className = 'clip-text';
        text.innerHTML = linkify(clip.text || '');
        body.appendChild(text);
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
        try {
          if (embed()) embed().prune([clip.id]);
        } catch (e) {}
        toast('Deleted');
        runSearch();
      });

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
    } catch (e) {
      toast('Export failed');
    }
  }

  function init() {
    searchInput = document.getElementById('clipSearch');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
      });
    }
    var semBtn = document.getElementById('embedBtn');
    if (semBtn) semBtn.addEventListener('click', enableSemantic);
    window.addEventListener('favs:embed', onEmbedEvent);
    setEmbedBtn();
    var exp = document.getElementById('clipExport');
    if (exp) exp.addEventListener('click', exportClips);
    var clear = document.getElementById('clipClear');
    if (clear) {
      clear.addEventListener('click', function () {
        var clips = loadClips();
        if (!clips.length) { toast('Vault is already empty'); return; }
        if (!window.confirm('Delete all ' + clips.length + ' clips? This cannot be undone.')) return;
        var ids = clips.map(function (c) { return c && c.id; }).filter(Boolean);
        storeClips([]);
        try {
          if (embed()) embed().prune(ids);
        } catch (e) {}
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
