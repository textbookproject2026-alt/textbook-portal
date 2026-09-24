/*
 * portal.js — inlined into index.html at build time (scripts/build.mjs), like
 * styles.css, so the portal stays two files.
 *
 * Progressive enhancement only. Without it the page is complete: the graph is
 * a finished SVG whose nodes link to the topic index, and every list is plain
 * HTML. With it: hovering or focusing a keyword lights up its neighbours, a
 * click opens the keyword's pages beside the graph, the graph filters by kind
 * (tags or concepts), topic, author and book, and the topic index filters as
 * you type.
 *
 * Reads only the page's own DOM; fetches nothing. Any error leaves the static
 * page exactly as it was.
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

  /* The request form: files are read in the browser and sent as base64 inside
     one JSON body (the endpoint's limit is 3 MB of files in total). */
  function enhanceRequest(form) {
    var MAX = 3 * 1024 * 1024;
    var nojs = document.querySelector('.rq-nojs');
    if (nojs) nojs.hidden = true;
    form.hidden = false;
    var button = form.querySelector('button[type="submit"]');
    var status = form.querySelector('.rq-status');
    var say = function (text, bad) {
      status.textContent = text;
      status.className = 'rq-status' + (bad ? ' rq-status--bad' : '');
    };

    function readFile(file) {
      return new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onload = function () { resolve({ name: file.name, data: String(r.result).split(',')[1] || '' }); };
        r.onerror = function () { reject(new Error('read')); };
        r.readAsDataURL(file);
      });
    }

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (!form.reportValidity()) return;
      var el = form.elements;
      var files = Array.prototype.slice.call(el.files.files || []);
      var total = files.reduce(function (n, f) { return n + f.size; }, 0);
      if (files.length > 5) return say('Please attach at most five files.', true);
      if (total > MAX) return say('The files come to more than 3 MB. Attach fewer, or share a link instead.', true);

      button.disabled = true;
      say('Sending…');
      Promise.all(files.map(readFile))
        .then(function (encoded) {
          return fetch(form.dataset.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: el.title.value, authors: el.authors.value, email: el.email.value,
              summary: el.summary.value, topic: el.topic.value, manuscriptLink: el.manuscriptLink.value,
              github: el.github.value, notes: el.notes.value, agreeLicence: el.agreeLicence.checked,
              website: el.website.value, files: encoded,
            }),
          });
        })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (body) { return { ok: res.ok, body: body }; });
        })
        .then(function (r) {
          if (!r.ok) {
            button.disabled = false;
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
        .catch(function () {
          button.disabled = false;
          say('Your request could not be sent. Check your connection and try again.', true);
        });
    });
  }
})();
