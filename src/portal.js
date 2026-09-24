/*
 * portal.js — inlined into index.html at build time (scripts/build.mjs), like
 * styles.css, so the portal stays two files.
 *
 * Progressive enhancement only. Without it the page is complete: the graph is
 * a finished SVG whose nodes link to the topic index, and every list is plain
 * HTML. With it: hovering or focusing a keyword lights up its neighbours, a
 * click opens the keyword's pages beside the graph, the graph filters to tags
 * or concepts, and the topic index filters as you type.
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
    if (filters) {
      filters.hidden = false;
      filters.addEventListener('click', function (ev) {
        var b = ev.target.closest('button[data-show]');
        if (!b) return;
        Array.prototype.forEach.call(filters.querySelectorAll('button'), function (x) {
          x.setAttribute('aria-pressed', String(x === b));
        });
        svg.dataset.show = b.dataset.show;
        if (selected) {
          var s = svg.querySelector('.kw-node[data-key="' + CSS.escape(selected) + '"]');
          if (s && b.dataset.show !== 'all' && s.dataset.kind !== b.dataset.show) select(null);
        }
      });
    }
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
})();
