/* FAVS vault page — private clips in localStorage key "favs.clips.v1". */
(function () {
  'use strict';

  var CLIPS_KEY = 'favs.clips.v1';

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

  function render(filter) {
    var clips = loadClips();
    var list = document.getElementById('clipList');
    var empty = document.getElementById('clipEmpty');
    var count = document.getElementById('clipCount');
    if (!list) return;

    var q = (filter || '').trim().toLowerCase();
    var shown = clips.filter(function (c) {
      if (!q) return true;
      var hay = ((c.text || '') + '\n' + (c.name || '')).toLowerCase();
      return hay.indexOf(q) !== -1;
    });

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
        toast('Deleted');
        render(searchInput ? searchInput.value : '');
      });

      head.appendChild(actions);
      card.appendChild(head);
      card.appendChild(body);
      list.appendChild(card);
    });
  }

  var searchInput = null;

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
      searchInput.addEventListener('input', function () { render(searchInput.value); });
    }
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
        render(searchInput ? searchInput.value : '');
      });
    }
    render('');
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
