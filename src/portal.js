/*
 * portal.js — inlined into index.html at build time (scripts/build.mjs), like
 * styles.css, so the portal stays two files.
 *
 * Progressive enhancement only. Without it the page is complete: the graph is
 * a finished SVG whose nodes link to the topic index, and every list is plain
 * HTML. With it: hovering or focusing a keyword lights up its neighbours, a
 * click opens the keyword's pages beside the graph, the graph filters by kind
 * (tags or concepts), topic, author and book, and the topic index filters as
 * you type. Printing opens the landing page's fold-outs, then closes them again.
 *
 * Reads only the page's own DOM; the one fetch is the request form posting to
 * its endpoint. Any error leaves the static page exactly as it was.
 */
(function () {
  'use strict';
  try {
    var graph = document.querySelector('.kw-graph');
    if (graph) enhanceGraph(graph);
    var topics = document.querySelector('.topics');
    if (topics) enhanceTopics(topics);
  } catch (e) {
    /* the static page stands */
  }
  try {
    var request = document.querySelector('.request-form');
    if (request) enhanceRequest(request);
  } catch (e) {
    /* the no-JavaScript note stands */
  }
  try {
    printOpen(document.querySelectorAll('main details'));
  } catch (e) {
    /* the fold-outs print closed */
  }

  function enhanceGraph(root) {
    var svg = root.querySelector('svg');
    var panel = root.querySelector('.kw-panel');
    var nodes = Array.prototype.slice.call(svg.querySelectorAll('.kw-node'));
    var edges = Array.prototype.slice.call(svg.querySelectorAll('.kw-edge'));
    var near = {};
    nodes.forEach(function (n) { near[n.dataset.key] = {}; });
    edges.forEach(function (e) {
      if (near[e.dataset.a] && near[e.dataset.b]) {
        near[e.dataset.a][e.dataset.b] = true;
        near[e.dataset.b][e.dataset.a] = true;
      }
    });
    var selected = null;

    function light(key) {
      svg.classList.toggle('is-lit', !!key);
      nodes.forEach(function (n) {
        var k = n.dataset.key;
        n.classList.toggle('is-on', k === key || k === selected);
        n.classList.toggle('is-near', !!key && !!near[key][k]);
      });
      edges.forEach(function (e) {
        e.classList.toggle('is-near', !!key && (e.dataset.a === key || e.dataset.b === key));
      });
    }

    function select(node) {
      selected = node ? node.dataset.key : null;
      nodes.forEach(function (n) { n.setAttribute('aria-pressed', String(n === node)); });
      light(selected);
      if (!panel) return;
      if (!node) {
        panel.hidden = true;
        return;
      }
      var entry = document.getElementById(node.dataset.topic);
      panel.innerHTML = '';
      var h = document.createElement('h3');
      h.textContent = node.dataset.label;
      var kind = document.createElement('p');
      kind.className = 'kw-panel-kind';
      kind.textContent = node.dataset.kind === 'concept' ? 'Concept' : 'Tag';
      panel.append(kind, h);
      var list = entry && entry.querySelector('ul');
      if (list) panel.append(list.cloneNode(true));
      var close = document.createElement('button');
      close.type = 'button';
      close.className = 'kw-panel-close';
      close.setAttribute('aria-label', 'Close');
      close.textContent = '×';
      close.addEventListener('click', function () { select(null); node.focus(); });
      panel.append(close);
      panel.hidden = false;
    }

    nodes.forEach(function (n) {
      n.setAttribute('role', 'button');
      n.setAttribute('aria-pressed', 'false');
      n.addEventListener('mouseenter', function () { light(n.dataset.key); });
      n.addEventListener('focus', function () { light(n.dataset.key); });
      n.addEventListener('mouseleave', function () { light(selected); });
      n.addEventListener('blur', function () { light(selected); });
      n.addEventListener('click', function (ev) {
        ev.preventDefault();
        select(selected === n.dataset.key ? null : n);
      });
      n.addEventListener('keydown', function (ev) {
        if (ev.key === ' ') { ev.preventDefault(); select(selected === n.dataset.key ? null : n); }
      });
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && selected) select(null);
    });

    var filters = root.querySelector('.kw-filters');
    var legend = root.parentNode.querySelector('.kw-topics');
    var count = root.querySelector('.kw-count');
    var reset = filters && filters.querySelector('.kw-reset');
    var selects = filters ? Array.prototype.slice.call(filters.querySelectorAll('select[data-filter]')) : [];
    var legendButtons = legend ? Array.prototype.slice.call(legend.querySelectorAll('button[data-t]')) : [];
    // Every filter at once: a node shows when it matches all that are set.
    var want = { kind: 'all', topic: '', author: '', book: '' };
    var list = function (n, attr) {
      try { return JSON.parse(n.getAttribute(attr) || '[]'); } catch (e) { return []; }
    };
    var info = nodes.map(function (n) {
      return { node: n, authors: list(n, 'data-authors'), books: list(n, 'data-books') };
    });

    function apply() {
      var shown = {};
      var total = 0;
      info.forEach(function (x) {
        var d = x.node.dataset;
        var ok =
          (want.kind === 'all' || d.kind === want.kind) &&
          (!want.topic || d.t === want.topic) &&
          (!want.author || x.authors.indexOf(want.author) !== -1) &&
          (!want.book || x.books.indexOf(want.book) !== -1);
        x.node.classList.toggle('is-out', !ok);
        if (ok) { shown[d.key] = true; total++; }
      });
      edges.forEach(function (e) {
        e.classList.toggle('is-out', !(shown[e.dataset.a] && shown[e.dataset.b]));
      });
      if (selected && !shown[selected]) select(null);
      var active = want.kind !== 'all' || want.topic || want.author || want.book;
      if (reset) reset.hidden = !active;
      if (count) {
        count.hidden = !active;
        count.textContent = total === 0
          ? 'No key word matches these filters.'
          : 'Showing ' + total + ' of ' + nodes.length + ' key words.';
      }
      if (filters) {
        Array.prototype.forEach.call(filters.querySelectorAll('button[data-show]'), function (x) {
          x.setAttribute('aria-pressed', String(x.dataset.show === want.kind));
        });
      }
      selects.forEach(function (sel) { sel.value = want[sel.dataset.filter]; });
      legendButtons.forEach(function (b) {
        b.setAttribute('aria-pressed', String(want.topic === b.dataset.t));
      });
    }

    if (filters) {
      filters.hidden = false;
      filters.addEventListener('click', function (ev) {
        var b = ev.target.closest('button[data-show]');
        if (b) { want.kind = b.dataset.show; apply(); }
        if (ev.target.closest('.kw-reset')) {
          want = { kind: 'all', topic: '', author: '', book: '' };
          apply();
        }
      });
      selects.forEach(function (sel) {
        sel.addEventListener('change', function () {
          want[sel.dataset.filter] = sel.value;
          apply();
        });
      });
    }
    // The topic key is a shortcut to the topic filter: choose again to clear.
    legendButtons.forEach(function (b) {
      b.disabled = false;
      b.setAttribute('aria-pressed', 'false');
      b.title = 'Show only this topic';
      b.addEventListener('click', function () {
        want.topic = want.topic === b.dataset.t ? '' : b.dataset.t;
        apply();
      });
    });
  }

  function enhanceTopics(root) {
    var input = root.querySelector('.topics-filter input');
    if (!input) return;
    root.querySelector('.topics-filter').hidden = false;
    var items = Array.prototype.slice.call(root.querySelectorAll('.topic'));
    var letters = Array.prototype.slice.call(root.querySelectorAll('.topic-letter'));
    var empty = root.querySelector('.topics-empty');
    input.addEventListener('input', function () {
      var q = input.value.trim().toLowerCase();
      var shown = 0;
      items.forEach(function (li) {
        var hit = !q || li.dataset.label.indexOf(q) !== -1;
        li.hidden = !hit;
        if (hit) shown++;
      });
      letters.forEach(function (group) {
        group.hidden = !group.querySelector('.topic:not([hidden])');
      });
      if (empty) empty.hidden = shown !== 0;
    });
  }

  /* The request form. Chosen files are kept in a list of our own, not the file
     input's, so each can be removed (a file input can only be replaced whole).
     Files go up in 2.5 MB parts, one request each, because the endpoint's host
     refuses bodies over 4.5 MB; the request itself then names the parts. */
  function enhanceRequest(form) {
    var MAX = 20 * 1024 * 1024;
    var MAX_TEXT = '20 MB';
    var MAX_FILES = 5;
    var PART = 2.5 * 1024 * 1024;
    var nojs = document.querySelector('.rq-nojs');
    if (nojs) nojs.hidden = true;
    form.hidden = false;
    var button = form.querySelector('button[type="submit"]');
    var status = form.querySelector('.rq-status');
    var input = form.querySelector('.rq-file-input');
    var list = form.querySelector('.rq-file-list');
    var picked = [];
    var say = function (text, bad) {
      status.textContent = text;
      status.className = 'rq-status' + (bad ? ' rq-status--bad' : '');
    };
    var sizeText = function (n) {
      return n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB';
    };
    var totalOf = function () { return picked.reduce(function (n, f) { return n + f.size; }, 0); };

    /* The first thing wrong with the chosen files, or null. */
    function problem() {
      if (picked.length > MAX_FILES) return 'Please attach at most five files.';
      for (var i = 0; i < picked.length; i++) {
        if (!/\.(docx|md|markdown)$/i.test(picked[i].name)) return picked[i].name + ' is not a Word (.docx) or Markdown (.md) file.';
      }
      if (totalOf() > MAX) return 'The files come to ' + sizeText(totalOf()) + ', more than ' + MAX_TEXT + '. Remove some, or share a link instead.';
      return null;
    }

    function render() {
      list.textContent = '';
      picked.forEach(function (file, i) {
        var li = document.createElement('li');
        var name = document.createElement('span');
        name.className = 'rq-file-name';
        name.textContent = file.name;
        var size = document.createElement('span');
        size.className = 'rq-file-size';
        size.textContent = sizeText(file.size);
        var remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'rq-file-remove';
        remove.textContent = 'Remove';
        remove.setAttribute('aria-label', 'Remove ' + file.name);
        remove.addEventListener('click', function () {
          picked.splice(i, 1);
          render();
          (list.querySelector('.rq-file-remove') || input).focus();
        });
        li.appendChild(name);
        li.appendChild(size);
        li.appendChild(remove);
        list.appendChild(li);
      });
      list.hidden = !picked.length;
      var p = problem();
      say(p || '', !!p);
    }

    input.addEventListener('change', function () {
      Array.prototype.forEach.call(input.files || [], function (f) {
        var dup = picked.some(function (g) { return g.name === f.name && g.size === f.size && g.lastModified === f.lastModified; });
        if (!dup) picked.push(f);
      });
      input.value = ''; // so the same file can be chosen again after removing it
      render();
    });

    function readBase64(blob) {
      return new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
        r.onerror = function () { reject(new Error('read')); };
        r.readAsDataURL(blob);
      });
    }

    function post(body) {
      return fetch(form.dataset.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (b) { return { ok: res.ok, body: b }; });
      });
    }

    /* Uploads every part in turn; resolves to [{ name, parts: [sha, ...] }]. */
    function uploadAll() {
      var total = totalOf();
      var sent = 0;
      var out = [];
      return picked.reduce(function (chain, file) {
        var entry = { name: file.name, parts: [] };
        out.push(entry);
        for (var at = 0; at < file.size; at += PART) {
          (function (slice) {
            chain = chain.then(function () {
              return readBase64(slice).then(function (data) { return post({ part: data }); }).then(function (r) {
                if (!r.ok) {
                  var err = new Error('part');
                  err.userMessage = r.body.userMessage;
                  throw err;
                }
                entry.parts.push(r.body.sha);
                sent += slice.size;
                say('Uploading files… ' + Math.round((sent / total) * 100) + '%');
              });
            });
          })(file.slice(at, at + PART));
        }
        return chain;
      }, Promise.resolve()).then(function () { return out; });
    }

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (!form.reportValidity()) return;
      var p = problem();
      if (p) return say(p, true);
      var el = form.elements;

      button.disabled = true;
      input.disabled = true;
      say(picked.length ? 'Uploading files…' : 'Sending…');
      uploadAll()
        .then(function (files) {
          say('Sending…');
          return post({
            title: el.title.value, authors: el.authors.value, email: el.email.value,
            summary: el.summary.value, topic: el.topic.value, manuscriptLink: el.manuscriptLink.value,
            github: el.github.value, notes: el.notes.value, agreeLicence: el.agreeLicence.checked,
            website: el.website.value, files: files,
          });
        })
        .then(function (r) {
          if (!r.ok) {
            button.disabled = false;
            input.disabled = false;
            return say(r.body.userMessage || 'Something went wrong sending your request. Please try again.', true);
          }
          var done = document.createElement('div');
          done.className = 'rq-done';
          done.setAttribute('role', 'status');
          var h = document.createElement('p');
          h.className = 'rq-done-title';
          h.textContent = 'Thank you, your request has arrived.';
          var p = document.createElement('p');
          p.textContent = 'We read every request ourselves and will reply by email. Once it is approved your book is set up automatically, and you will get its address.' +
            (r.body.reference && r.body.reference !== 'received' ? ' Your reference: ' + r.body.reference + '.' : '');
          done.appendChild(h);
          done.appendChild(p);
          if (r.body.userMessage) {
            var w = document.createElement('p');
            w.textContent = r.body.userMessage;
            done.appendChild(w);
          }
          form.replaceWith(done);
        })
        .catch(function (err) {
          button.disabled = false;
          input.disabled = false;
          say((err && err.userMessage) || 'Your request could not be sent. Check your connection and try again.', true);
        });
    });
  }

  /* Open every fold-out for printing, and put each back as it was after. */
  function printOpen(list) {
    var folds = Array.prototype.slice.call(list);
    if (folds.length === 0) return;
    var was = null;
    window.addEventListener('beforeprint', function () {
      was = folds.map(function (d) { return d.open; });
      folds.forEach(function (d) { d.open = true; });
    });
    window.addEventListener('afterprint', function () {
      if (!was) return;
      folds.forEach(function (d, i) { d.open = was[i]; });
      was = null;
    });
  }
})();
