#!/usr/bin/env node
/**
 * Build the platform portal: one HTML page listing the platform's books,
 * generated from the registry and the books' catalogs (scripts/catalog.mjs)
 * at BUILD time.
 *
 * Nothing is fetched in the browser. The reasoning is the same as every other
 * registry consumer's (DESIGN §2b, and the suggest-edit function's
 * scripts/bundle-registry.mjs, which this deliberately mirrors): a reader's
 * page load must not depend on raw.githubusercontent.com, and a registry that
 * can't be read must fail a build rather than empty a live page.
 *
 * Output (exactly two files, see README "The apex redirect"):
 *   public/index.html    the page
 *   public/version.txt   the registry SHA it was built from (not this repo's: that is
 *                        index.html's <meta name="portal-version">)
 *
 * plus whatever is in static/ (Cloudflare Pages control files, not URLs).
 *
 * Usage:
 *   npm run build                                  # latest registry main
 *   REGISTRY_REF=<40-char sha> npm run build       # pin
 *   REGISTRY_FILE=../textbook-registry/registry.json npm run build   # local
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { authors, bookStats, catalogUrl, fetchCatalogs, graphOf, keywords, readCatalog, recentChanges, topicKey, topicSlots } from './catalog.mjs';
import { VIEW, layout, radius } from './graph.mjs';

const REGISTRY_REPO = 'textbookproject2026-alt/textbook-registry';
const SCHEMA_VERSION = 1;
const FETCH_TIMEOUT_MS = 15000;

const ROOT = new URL('../', import.meta.url);
const OUT_DIR = fileURLToPath(new URL('public/', ROOT));
const STATIC_DIR = fileURLToPath(new URL('static/', ROOT));
const CSS_FILE = fileURLToPath(new URL('src/styles.css', ROOT));
const JS_FILE = fileURLToPath(new URL('src/portal.js', ROOT));
// Source of truth: quartz-edition-extras plugins/home-link/assets/logo-full.svg (copied verbatim).
const LOGO_SVG = readFileSync(fileURLToPath(new URL('src/logo-full.svg', ROOT)), 'utf8')
  .trim()
  .replace('<svg ', '<svg aria-hidden="true" focusable="false" ');

export class BuildError extends Error {}

/* -------------------------------------------------------------------------
   Reading the registry
   ------------------------------------------------------------------------- */

export function resolveSha(ref) {
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  // git ls-remote, not the REST API: build machines share IPs and the
  // unauthenticated API limit (60/hour per IP) would fail builds at random.
  // Same call, same reason, as suggest-edit-function/scripts/bundle-registry.mjs.
  let out;
  try {
    out = execFileSync('git', ['ls-remote', `https://github.com/${REGISTRY_REPO}.git`, `refs/heads/${ref}`], {
      encoding: 'utf8',
      timeout: FETCH_TIMEOUT_MS,
    });
  } catch (err) {
    throw new BuildError(`git ls-remote failed for ${REGISTRY_REPO} ${ref}: ${err.message}`);
  }
  const sha = out.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new BuildError(`branch ${ref} not found on ${REGISTRY_REPO}`);
  return sha;
}

export async function fetchRegistry(sha) {
  const url = `https://raw.githubusercontent.com/${REGISTRY_REPO}/${sha}/registry.json`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new BuildError(`could not fetch ${url}: ${err.message}`);
  }
  if (!res.ok) throw new BuildError(`${url} returned ${res.status}`);
  try {
    return JSON.parse(await res.text());
  } catch {
    throw new BuildError(`${url} is not valid JSON`);
  }
}

/* -------------------------------------------------------------------------
   Choosing what to list

   The hard rule (MULTI-BOOK-HOSTING §6b, PORTAL-CUTOVER §5c): the build must
   never fail because one book's entry is odd. Skip that book, warn, build the
   rest. One malformed entry taking down the platform's front page is a worse
   failure than one book missing from a list.

   The exceptions are deliberate, and both mean "the whole file is wrong, keep
   the previous site up rather than publish this": an unknown schema_version,
   and nothing left to list.
   ------------------------------------------------------------------------- */

const isText = (v) => typeof v === 'string' && v.trim() !== '';
// Hostname only, as registry.json stores it. Never a scheme, port or path.
const isHostname = (v) => isText(v) && /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/.test(v);
const isHttpsUrl = (v) => isText(v) && /^https:\/\/[^\s"']+$/.test(v);

export const STATUS_LABELS = {
  live: null, // a live book needs no badge; it is what the page is for
  preview: 'Preview — a demonstration, not for readers',
};

/** What kind of text (registry books[].type), and its badge. Absent or unknown: a book. */
export const TYPE_LABELS = { book: 'Book', paper: 'Paper', report: 'Report', article: 'Article' };
const typeOf = (book) => (Object.hasOwn(TYPE_LABELS, book?.type) ? book.type : 'book');

/**
 * The platform's public Plausible dashboard for the statistics links (public for good,
 * decided 9 Oct 2026), or null when it isn't public. quartz-book's statsDashboard is
 * the same rule.
 */
export function statsOf(registry) {
  const p = registry?.platform?.analytics?.plausible;
  if (!p) return null;
  return p.dashboard_public === true && isHostname(p.site) ? `https://plausible.io/${p.site}` : null;
}

/** The dashboard filtered to one hostname (a book's), as its Book statistics. */
export const statsFor = (base, host) => `${base}${base.includes('?') ? '&' : '?'}f=is,hostname,${encodeURIComponent(host)}`;

export function selectBooks(registry) {
  if (registry === null || typeof registry !== 'object') throw new BuildError('the registry is not an object');
  if (registry.schema_version !== SCHEMA_VERSION) {
    throw new BuildError(
      `registry schema_version is ${JSON.stringify(registry.schema_version)}, and this build understands ${SCHEMA_VERSION}. ` +
        `Refusing to guess at a schema it does not know; the previous portal stays up. Update scripts/build.mjs.`,
    );
  }
  if (!Array.isArray(registry.books)) throw new BuildError('registry.books is not an array');

  const listed = [];
  const skipped = [];

  registry.books.forEach((book, i) => {
    const at = `books[${i}]`;
    const slug = isText(book?.slug) ? book.slug : null;
    const where = slug ? `${at} (${slug})` : at;

    if (!slug) return skipped.push({ where, reason: 'no usable slug' });

    // Retired books are never listed. That is what retirement means
    // (MULTI-BOOK-HOSTING §7), and it is the platform's only real lever over a
    // removed book. Not a warning: it is the correct outcome.
    if (book.status === 'retired') return;
    // listed: false (the author guide): built and served like any book, but kept
    // off this page, so out of the catalogue, graph, topics, authors and recent
    // changes too, which are all drawn from what is listed here.
    if (book.listed === false) return;

    if (!Object.hasOwn(STATUS_LABELS, book.status)) {
      return skipped.push({ where, reason: `status ${JSON.stringify(book.status)} is not one this build knows` });
    }
    if (!isHostname(book?.site?.domain)) {
      return skipped.push({ where, reason: 'no usable site.domain' });
    }
    if (!isText(book.title)) return skipped.push({ where, reason: 'no usable title' });
    if (!isText(book.summary)) return skipped.push({ where, reason: 'no usable summary' });

    listed.push({
      slug,
      status: book.status,
      type: typeOf(book),
      title: book.title.trim(),
      summary: book.summary.trim(),
      domain: book.site.domain,
      url: `https://${book.site.domain}`,
      // Optional extras: present when sound, silently absent when not. A bad
      // one must not cost the book its place in the list.
      maintainer: isText(book?.maintainer?.name) ? book.maintainer.name.trim() : null,
      // A throwaway test book (registry `sandbox: true`): listed like any other,
      // so a test proves the real path, but badged so no reader mistakes it.
      sandbox: book.sandbox === true,
      templatePreview: isHttpsUrl(book?.editions?.template_preview) ? book.editions.template_preview : null,
      // Where the book's catalog is (scripts/catalog.mjs), and how its pages
      // are addressed. Neither can cost the book its place in the list.
      host: isText(book?.site?.host?.kind) ? book.site.host.kind : null,
      catalogUrl: catalogUrl(book),
    });
  });

  if (listed.length === 0) {
    throw new BuildError(
      'no book in the registry could be listed, so the page would be empty. ' +
        'Refusing to publish that; the previous portal stays up.' +
        (skipped.length ? ` Skipped: ${skipped.map((s) => `${s.where} — ${s.reason}`).join('; ')}` : ''),
    );
  }

  // live first, then preview; stable within a group, so the registry's order
  // is the editorial order.
  const rank = { live: 0, preview: 1 };
  listed.sort((a, b) => rank[a.status] - rank[b.status]);

  return { listed, skipped };
}

/* -------------------------------------------------------------------------
   Rendering
   ------------------------------------------------------------------------- */

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
export const formatDate = (iso) => DATE.format(new Date(iso));

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** An id for a keyword's entry in the topic index, safe in HTML and CSS. */
export const topicId = (key) => `topic-${key.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x'}`;

export const SANDBOX_LABEL = 'Test book — will be removed';

/** A book's title up to its subtitle, for lists where the full title would run long. */
const shortTitle = (title) => title.split(/:\s/)[0];

/** The book's authors as the catalog gives them, else the registry's maintainer. */
function bookAuthors(book, catalogs) {
  const names = catalogs.get(book.slug)?.authors ?? [];
  return names.length ? names : book.maintainer ? [book.maintainer] : [];
}

/* One book, in the shape of a search result: the title, a line in brown naming
   the authors and the address, the description, then the counts. */
function renderBook(book, catalogs, statsBase = null) {
  const stats = bookStats(book, catalogs);
  const label = book.sandbox ? SANDBOX_LABEL : STATUS_LABELS[book.status];
  const who = bookAuthors(book, catalogs).map(escapeHtml).join(', ');
  const meta = [who || null, `<a href="${escapeHtml(book.url)}">${escapeHtml(book.domain)}</a>`].filter(Boolean).join(' — ');
  const sub = [
    stats ? plural(stats.pages, 'page') : null,
    stats?.concepts ? plural(stats.concepts, 'concept page') : null,
    stats?.updated ? `Updated ${escapeHtml(formatDate(stats.updated))}` : null,
    book.templatePreview ? `<a href="${escapeHtml(book.templatePreview)}">Department edition template</a>` : null,
    // Plausible counts live books only, on their own address.
    statsBase && book.status === 'live' ? `<a href="${escapeHtml(statsFor(statsBase, book.domain))}">Book statistics</a>` : null,
  ].filter(Boolean);

  return [
    `        <li class="result" data-type="${escapeHtml(book.type ?? 'book')}">`,
    `          <p class="badges"><span class="type-badge">${escapeHtml(TYPE_LABELS[book.type] ?? 'Book')}</span>${label ? `<span class="badge">${escapeHtml(label)}</span>` : ''}</p>`,
    `          <h3><a href="${escapeHtml(book.url)}">${escapeHtml(book.title)}</a></h3>`,
    `          <div class="result-meta">${meta}</div>`,
    `          <p>${escapeHtml(book.summary)}</p>`,
    sub.length ? `          <div class="result-sub">${sub.join('<span class="sep">·</span>')}</div>` : null,
    '        </li>',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderBooks(books, catalogs, stats = null) {
  if (books.length === 0) return null;
  // The type filter: every kind the platform takes, so a reader can see there are none
  // of one yet. portal.js shows it and hides the cards of other kinds.
  const options = Object.entries(TYPE_LABELS).map(([v, l]) => `<option value="${v}">${l}s</option>`).join('');
  return [
    '    <section class="section section--live" id="books">',
    '      <div class="wrap">',
    `      <h2>${books.length === 1 ? 'The book' : 'The books'}</h2>`,
    `      <label class="type-filter" hidden>Show <select data-type-filter><option value="">Everything</option>${options}</select></label>`,
    '      <ul class="result-list">',
    books.map((b) => renderBook(b, catalogs, stats)).join('\n'),
    '      </ul>',
    '      <p class="type-empty" hidden>Nothing of this kind on the platform yet.</p>',
    '      </div>',
    '    </section>',
  ].join('\n');
}

/* The keyword graph: a finished SVG, every node a link into the topic index,
   coloured by topic. It sits in the box beside the About text. src/portal.js
   adds highlighting, the side panel and the filters (kind, topic, author,
   book); their data is on each node. */
function renderGraph(kw, books) {
  const g = graphOf(kw);
  if (g.nodes.length < 2) return null;
  const placed = layout(g);
  const at = new Map(placed.map((n) => [n.key, n]));
  const slots = topicSlots(g.nodes);
  const slotOf = new Map(slots.map((t) => [t.key, t.slot]));
  // A slot number, or "other": a topic past the last slot, or none.
  const slot = (n) => (n.topic && slotOf.has(topicKey(n.topic)) ? String(slotOf.get(topicKey(n.topic))) : 'other');
  const maxW = Math.max(...g.edges.map((e) => e.weight), 1);
  const edges = g.edges
    .map((e) => {
      const a = at.get(e.a);
      const b = at.get(e.b);
      const w = (0.8 + (1.6 * e.weight) / maxW).toFixed(2);
      return `<line class="kw-edge" data-a="${escapeHtml(e.a)}" data-b="${escapeHtml(e.b)}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke-width="${w}"/>`;
    })
    .join('\n          ');
  const nodes = placed
    .map((n) => {
      const r = radius(n.pages.length).toFixed(1);
      const right = n.x < VIEW.width - 120;
      const label = escapeHtml(shownLabel(n));
      const title = `${shownLabel(n)} — ${plural(n.pages.length, 'page')}${n.books > 1 ? `, ${n.books} books` : ''}${n.topic ? ` · ${n.topic}` : ''}`;
      return [
        `<a class="kw-node kw-node--${n.kind}" href="#${topicId(n.key)}" data-key="${escapeHtml(n.key)}" data-topic="${topicId(n.key)}" data-label="${label}" data-kind="${n.kind}"`,
        ` data-t="${slot(n)}" data-authors="${escapeHtml(JSON.stringify(n.authors))}" data-books="${escapeHtml(JSON.stringify(n.bookSlugs))}" aria-label="${escapeHtml(title)}">`,
        `<title>${escapeHtml(title)}</title>`,
        `<circle cx="${n.x}" cy="${n.y}" r="${r}"/>`,
        `<text x="${right ? n.x + Number(r) + 5 : n.x - Number(r) - 5}" y="${n.y + 4}"${right ? '' : ' text-anchor="end"'}>${label}</text>`,
        '</a>',
      ].join('');
    })
    .join('\n          ');

  const hasBoth = g.nodes.some((n) => n.kind === 'tag') && g.nodes.some((n) => n.kind === 'concept');
  const hasOther = g.nodes.some((n) => slot(n) === 'other');
  const option = (value, text) => `<option value="${escapeHtml(value)}">${escapeHtml(text)}</option>`;
  const select = (name, label, options) =>
    `<label class="kw-filter">${label} <select data-filter="${name}"><option value="">All</option>${options.join('')}</select></label>`;
  const graphAuthors = [...new Set(g.nodes.flatMap((n) => n.authors))].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  const graphBooks = books.filter((b) => g.nodes.some((n) => n.bookSlugs.includes(b.slug)));
  const controls = [
    hasBoth
      ? '<div class="kw-kinds" role="group" aria-label="Show"><button type="button" data-show="all" aria-pressed="true">All</button><button type="button" data-show="concept" aria-pressed="false">Concepts</button><button type="button" data-show="tag" aria-pressed="false">Tags</button></div>'
      : null,
    slots.length
      ? select('topic', 'Topic', [...slots.map((t) => option(String(t.slot), t.label)), ...(hasOther ? [option('other', 'Other')] : [])])
      : null,
    graphAuthors.length > 1 ? select('author', 'Author', graphAuthors.map((a) => option(a, a))) : null,
    graphBooks.length > 1 ? select('book', 'Book', graphBooks.map((b) => option(b.slug, b.title))) : null,
  ].filter(Boolean);
  // The topic key doubles as a filter once portal.js enables it.
  const legend = [
    ...slots.map((t) => `<li><button type="button" data-t="${t.slot}" disabled><span class="kw-swatch" data-t="${t.slot}"></span>${escapeHtml(t.label)}</button></li>`),
    ...(slots.length && hasOther ? ['<li><button type="button" data-t="other" disabled><span class="kw-swatch" data-t="other"></span>Other</button></li>'] : []),
  ];

  return [
    '      <div class="kw-box" id="keywords">',
    '        <h2 class="sr-only">Key words</h2>',
    '        <div class="kw-graph">',
    controls.length
      ? `          <div class="kw-filters" hidden>${controls.join('')}<button type="button" class="kw-reset" hidden>Clear filters</button></div>`
      : null,
    `          <svg viewBox="0 0 ${VIEW.width} ${VIEW.height}" aria-labelledby="kw-graph-title">`,
    `          <title id="kw-graph-title">Graph of ${plural(g.nodes.length, 'key word')} and the pages they share. Linked words appear on the same pages; larger ones on more of them.</title>`,
    `          <g class="kw-edges">${edges ? `\n          ${edges}\n          ` : ''}</g>`,
    `          ${nodes}`,
    '          </svg>',
    '          <p class="kw-count" aria-live="polite" hidden></p>',
    '          <div class="kw-panel" aria-live="polite" hidden></div>',
    '        </div>',
    legend.length ? `        <ul class="kw-topics" aria-label="Topics">${legend.join('')}</ul>` : null,
    '        <p class="kw-legend"><span><span class="kw-key kw-key--concept"></span>Concept page</span><span><span class="kw-key kw-key--tag"></span>Tag</span></p>',
    '      </div>',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

/** Up to three pages by name, then "and N more". */
const SHOW_PAGES = 3;

function renderRecent(changes) {
  if (changes.length === 0) return null;
  const items = changes.map((c) => {
    const shown = c.pages.slice(0, SHOW_PAGES).map((p) => `<a href="${escapeHtml(p.url)}">${escapeHtml(p.title)}</a>`);
    const more = c.pages.length - shown.length;
    return (
      `          <li><span class="cap"><time datetime="${escapeHtml(c.date)}">${escapeHtml(formatDate(c.date))}</time><span class="sep">·</span>` +
      `<span class="change change--${c.change}">${c.change === 'added' ? 'New' : 'Updated'}</span></span>` +
      `${shown.join(', ')}${more > 0 ? ` and ${plural(more, 'other page')}` : ''}` +
      ` — <em class="recent-book">${escapeHtml(shortTitle(c.book))}</em></li>`
    );
  });
  return [
    '      <section class="section--recent" id="recent" aria-labelledby="recent-h">',
    '        <h2 id="recent-h">Recently added and changed</h2>',
    '        <ul class="recent">',
    ...items,
    '        </ul>',
    '      </section>',
  ].join('\n');
}

/* Browse by topic and by author: two lists of names, comma-separated, as the
   draft has them. A topic goes to its entry in the index below, where its
   pages are listed; an author with one book goes to the book, an author with
   several names them. The filter box (portal.js) narrows the topics and the
   index together. */
function renderBrowse(nodes, authorList) {
  if (nodes.length === 0 && authorList.length === 0) return null;
  const topics = nodes.length
    ? [
        '        <h3 id="topics-h">Browse by topic</h3>',
        '        <input class="filter-input" type="search" id="topic-filter" placeholder="Filter topics…" aria-label="Filter topics" autocomplete="off" spellcheck="false" hidden>',
        `        <ul class="taglist" id="topic-tags" aria-labelledby="topics-h">${nodes
          .map((n) => `<li data-label="${escapeHtml(n.label.toLowerCase())}"><a href="#${topicId(n.key)}">${escapeHtml(shownLabel(n))}</a></li>`)
          .join('')}</ul>`,
        '        <p class="taglist-empty" hidden>No topic matches.</p>',
      ]
    : [];
  const authors = authorList.length
    ? [
        '        <h3 id="authors-h">Browse by author</h3>',
        `        <ul class="taglist" id="authors" aria-labelledby="authors-h">${authorList
          .map((a) =>
            a.books.length === 1
              ? `<li><a href="${escapeHtml(a.books[0].url)}">${escapeHtml(a.name)}</a></li>`
              : `<li><span class="author">${escapeHtml(a.name)}</span> <span class="author-books">(${a.books.map((b) => `<a href="${escapeHtml(b.url)}" title="${escapeHtml(b.title)}">${escapeHtml(shortTitle(b.title))}</a>`).join(', ')})</span></li>`,
          )
          .join('')}</ul>`,
      ]
    : [];
  return ['      <div class="browse" id="topics">', ...topics, ...authors, '      </div>'].join('\n');
}

/* The topic index: every key word A–Z with the pages it appears on. The graph's
   nodes and the topic list above link here. */
function renderTopics(nodes) {
  if (nodes.length === 0) return null;
  const groups = new Map();
  for (const n of nodes) {
    const first = n.label.normalize('NFKD').charAt(0).toUpperCase();
    const letter = /[A-Z]/.test(first) ? first : '#';
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter).push(n);
  }
  const topic = (n) =>
    [
      `          <li class="topic" id="${topicId(n.key)}" data-label="${escapeHtml(n.label.toLowerCase())}">`,
      `            <h4>${escapeHtml(shownLabel(n))}<span class="topic-kind">${n.kind === 'concept' ? 'concept' : 'tag'}</span></h4>`,
      '            <ul>',
      ...n.pages.map(
        (p) =>
          `              <li${p.own ? ' class="topic-own"' : ''}><a href="${escapeHtml(p.url)}">${escapeHtml(p.title)}</a><span class="topic-book">${escapeHtml(p.book)}</span></li>`,
      ),
      '            </ul>',
      '          </li>',
    ].join('\n');
  return [
    '    <section class="section section--topics topics" id="topic-index">',
    '      <div class="wrap">',
    '      <h2>Topic index</h2>',
    '      <p class="section-lead">Every key word across the books, with the pages it appears on. Concept pages are in bold.</p>',
    ...[...groups].map(([letter, list]) =>
      [
        `      <div class="topic-letter">`,
        `        <h3>${escapeHtml(letter)}</h3>`,
        '        <ul class="topic-list">',
        ...list.map(topic),
        '        </ul>',
        '      </div>',
      ].join('\n'),
    ),
    '      <p class="topics-empty" hidden>No topic matches.</p>',
    '      </div>',
    '    </section>',
  ].join('\n');
}

/* -------------------------------------------------------------------------
   Publish your textbook here

   The request form. It posts to the suggest-edit function's sibling
   /api/request-book (derived from platform.suggest_edit_endpoint, like the
   in-site editor's endpoint), which files the request privately. Nothing here
   publishes anything: the platform owner approves each request by hand, and
   approval runs book-requests' provision workflow.

   It is part of index.html because the apex serves exactly two files (README,
   "The apex redirect"). It needs the inline script to send; without it the
   section says how to ask by email instead. With it, the button opens the form.
   ------------------------------------------------------------------------- */

/** https://<fn>/api/suggest-edit -> https://<fn>/api/request-book, or null. */
/** The author guide (registry book author-guide, listed: false): linked, not listed. */
export const GUIDE_URL = 'https://guide.confused4now.org';

export function requestEndpointOf(registry) {
  const e = registry?.platform?.suggest_edit_endpoint;
  if (!isHttpsUrl(e) || !/\/api\/suggest-edit\/?$/.test(e)) return null;
  return e.replace(/\/suggest-edit\/?$/, '/request-book');
}

function renderRequest(endpoint, contact) {
  if (!endpoint) return null;
  const field = (id, label, input, hint) =>
    [
      `        <p class="rq-field">`,
      `          <label for="rq-${id}">${label}</label>`,
      hint ? `          <span class="rq-hint" id="rq-${id}-hint">${hint}</span>` : null,
      `          ${input}`,
      '        </p>',
    ]
      .filter(Boolean)
      .join('\n');
  const text = (id, name, attrs = '') =>
    `<input id="rq-${id}" name="${name}" type="text"${attrs}>`;
  return [
    '    <section class="section section--request cta" id="publish">',
    '      <div class="wrap">',
    '      <h2>Publish your textbook here</h2>',
    '      <p>Write an open textbook and we host it: its own address, margin comments, reader suggestions, an in-page editor, and a place on this page and in the key-word graph. Nothing technical is asked of you. Tell us about the book; once we have said yes, it is set up for you and you get an email with its address.</p>',
    `      <p class="rq-guide"><a href="${GUIDE_URL}">Guide for authors</a>: everything from preparing your Word files to publishing, step by step.</p>`,
    '      <button type="button" class="btn rq-open" hidden>Start the request form</button>',
    `      <form class="request-form" data-endpoint="${escapeHtml(endpoint)}" hidden novalidate>`,
    field('type', 'What kind of text is it?', `<select id="rq-type" name="type">${Object.entries(TYPE_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>`, 'A book, a paper, a report or an article. It is shown beside the title.'),
    field('title', 'Title of the book', text('title', 'title', ' required maxlength="200" autocomplete="off"')),
    field('authors', 'Author or authors', text('authors', 'authors', ' required maxlength="300" autocomplete="name"'), 'Separate several names with commas.'),
    field('email', 'Your email address', '<input id="rq-email" name="email" type="email" required maxlength="254" autocomplete="email">', 'Only we see it. It is never published.'),
    field('summary', 'What the book is about', '<textarea id="rq-summary" name="summary" rows="3" required minlength="20" maxlength="300"></textarea>', 'One or two sentences, up to 300 characters. This becomes the book&#39;s description on this page.'),
    field('topic', 'Subject area <span class="rq-optional">(optional)</span>', text('topic', 'topic', ' maxlength="60"'), 'For example: sociology, ecology, music theory.'),
    field('files', 'Manuscript <span class="rq-optional">(optional)</span>', '<input id="rq-files" class="rq-file-input" name="files" type="file" multiple accept=".docx,.md,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown"><label for="rq-files" class="rq-file-pick">Choose files…</label><ul class="rq-file-list" hidden></ul>', 'Word (.docx) or Markdown (.md), up to five files and 20 MB in total. One file per chapter works best. Or leave it empty and write in the browser once the book exists.'),
    field('link', 'Or a link to the manuscript <span class="rq-optional">(optional)</span>', '<input id="rq-link" name="manuscriptLink" type="url" maxlength="500" placeholder="https://">', 'For files over 20 MB: a shared folder or download link.'),
    field('github', 'GitHub username <span class="rq-optional">(optional)</span>', text('github', 'github', ' maxlength="39" autocomplete="off" spellcheck="false"'), 'If you have one, you get direct access to your book&#39;s source. Not needed.'),
    field('notes', 'Anything else <span class="rq-optional">(optional)</span>', '<textarea id="rq-notes" name="notes" rows="3" maxlength="3000"></textarea>'),
    '        <p class="rq-field rq-agree"><label><input name="agreeLicence" type="checkbox" required><span>The book may be published under <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a>: anyone may share and adapt it, with credit, under the same licence.</span></label></p>',
    '        <p class="rq-trap" aria-hidden="true"><label>Leave this empty <input name="website" type="text" tabindex="-1" autocomplete="off"></label></p>',
    '        <p class="rq-actions"><button type="submit" class="btn">Send request</button><span class="rq-status" role="status" aria-live="polite"></span></p>',
    '      </form>',
    `      <p class="rq-nojs">${contact ? `The request form needs JavaScript. Or write to <a href="mailto:${escapeHtml(contact)}">${escapeHtml(contact)}</a>.` : 'The request form needs JavaScript.'}</p>`,
    '      </div>',
    '    </section>',
  ].join('\n');
}

/* -------------------------------------------------------------------------
   Analytics

   The platform's one Plausible site (BOOK-ONE-TO-QUARTZ D19, §8 step 17a),
   named once in platform.analytics.plausible and shared with every live book.
   The loader is edition-integrations' analyticsLoader (quartz-edition-extras
   src/runtime.ts) with the portal's domain: the page counts only when served
   from platform.portal.domain, never from textbook-portal.pages.dev or a
   branch preview. No site, or no portal domain, means no script at all.
   ------------------------------------------------------------------------- */

/** { src, domain } for the portal's Plausible script, or null. */
export function analyticsOf(registry) {
  const src = registry?.platform?.analytics?.plausible?.script_src;
  const domain = registry?.platform?.portal?.domain;
  if (!isText(src) || !/^https:\/\/plausible\.io\/js\/[A-Za-z0-9._-]+\.js$/.test(src)) return null;
  if (!isText(domain)) return null;
  return { src, domain };
}

function renderAnalytics(analytics) {
  if (!analytics) return '';
  return `<script>
;(function () {
  if (location.hostname !== ${JSON.stringify(analytics.domain)}) return
  window.plausible = window.plausible || function () { (window.plausible.q = window.plausible.q || []).push(arguments) }
  window.plausible.init = window.plausible.init || function (o) { window.plausible.o = o || {} }
  window.plausible.init()
  var s = document.createElement("script")
  s.async = true
  s.src = ${JSON.stringify(analytics.src)}
  document.head.appendChild(s)
})()
</script>
`;
}

/** A keyword as readers see it: a concept by its title, a tag as Obsidian writes it. */
const shownLabel = (n) => (n.kind === 'tag' ? `#${n.label}` : n.label);

/* The same families the books load (quartz-edition-extras design.ts fontHref):
   Source Serif 4 with its optical-size axis for the narrative text, Source Sans
   3 for everything else. display=swap, so the system stack shows meanwhile. */
export const FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;600;700&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&display=swap';

/* Applies the reader's saved theme before first paint, so a dark page never
   flashes light. The key is `theme`, as Quartz's darkmode plugin uses on the
   books; each site remembers its own choice. */
const THEME_SCRIPT = `<script>
;(function () {
  try {
    var t = localStorage.getItem("theme")
    if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t)
  } catch (e) {}
})()
</script>`;

const ICON_SEARCH =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M20 20L16.5 16.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_THEME =
  '<svg class="moon" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>' +
  '<svg class="sun" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="2"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

/* Privacy: what is stored, by whom, and how to turn each off. The apex serves one page
   (README, "The apex redirect"), so this is a section of it, linked as /#privacy from
   every footer (quartz-book privacyUrl, the author site). */
export const PRIVACY_ID = 'privacy';
function renderPrivacy(analytics) {
  return [
    `    <section class="section section--privacy" id="${PRIVACY_ID}" aria-labelledby="privacy-h">`,
    '      <div class="wrap prose">',
    '      <h2 id="privacy-h">Privacy</h2>',
    '      <p>No tracking cookies, on this page or on any book. Here is everything that is stored, and how to turn each part off.</p>',
    '      <h3>Reader settings, in this browser</h3>',
    '      <p>Each site remembers your choices in your own browser (local storage): light or dark, text size and width, paragraph numbers, whether margin comments are on, and that you have seen the privacy note. Nothing of it is sent anywhere. To clear it, clear this site&#39;s data in your browser&#39;s settings; the book&#39;s <strong>Aa</strong> menu changes each setting.</p>',
    // Counting is only described where there is any (platform.analytics).
    ...(analytics
      ? [
          '      <h3>Visitor counts (Plausible)</h3>',
          '      <p>Pages on the live sites are counted with <a href="https://plausible.io/data-policy">Plausible Analytics</a>, which sets no cookies and stores nothing that identifies you: only counts of visits, pages, referring sites, countries and device types. Drafts and previews are never counted. The counts are public (<strong>Platform statistics</strong> below, <strong>Book statistics</strong> on each book). To stop being counted, block plausible.io with a content blocker.</p>',
        ]
      : []),
    '      <h3>Margin comments (Hypothes.is)</h3>',
    '      <p>The comments in a book&#39;s margin are provided by <a href="https://web.hypothes.is/privacy/">Hypothes.is</a>, loaded from hypothes.is, which may set its own cookies (when you sign in there to comment, for example). To turn them off on a book, choose <strong>Turn comments off</strong> on the first-visit note, or <strong>Aa</strong> › <strong>Public annotations</strong> › off: from the next page on, Hypothes.is isn&#39;t loaded at all.</p>',
    '      <h3>GitHub sign-in, for authors and editors</h3>',
    '      <p>Editing a page in the book, and the author site, ask you to sign in with GitHub. The sign-in asks GitHub for nothing but your username, and the GitHub token is thrown away at once; the site keeps a sign-in in this browser tab for at most eight hours, gone sooner when you sign out or close the tab. Proposed edits and suggestions are published on GitHub under the name you give. Reading needs no sign-in at all.</p>',
    '      </div>',
    '    </section>',
  ].join('\n');
}

/**
 * /privacy: the privacy statement as its own page, in the portal's masthead and footer.
 * Served once the apex redirect rule no longer catches every path (README, "The apex
 * redirect"); Cloudflare Pages serves privacy.html at /privacy.
 */
export function renderPrivacyPage({ css, analytics = null, stats = null, portalSha = 'local' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Privacy — Confused for Now</title>
<meta name="description" content="What Confused for Now stores, and how to turn each part off.">
<link rel="icon" href="data:,">
<meta name="portal-version" content="${escapeHtml(portalSha)}">
${THEME_SCRIPT}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS_HREF}">
<style>
${css.trim()}
</style>
${renderAnalytics(analytics)}</head>
<body>
  <main>
    <header class="masthead">
      <div class="wrap">
      <a class="home" href="/" aria-label="Confused for Now (home)">${LOGO_SVG}</a>
      </div>
    </header>

${renderPrivacy(analytics)}

    <footer class="colophon">
      <div class="wrap">
      <p><a href="/">Confused for Now</a> · <a href="${GUIDE_URL}">Guide for authors</a>${stats ? ` · <a href="${escapeHtml(stats)}">Platform statistics</a>` : ''}</p>
      </div>
    </footer>
  </main>
</body>
</html>
`;
}

export function renderPage({ books, sha, portalSha = 'local', css, js = '', catalogs = new Map(), requestEndpoint = null, contact = null, analytics = null, stats = null }) {
  const live = books.filter((b) => b.status === 'live');
  const kw = keywords(books, catalogs);

  const graph = renderGraph(kw, live);
  const recent = renderRecent(recentChanges(books, catalogs));
  const browse = renderBrowse(kw.nodes, authors(books, catalogs));
  const section = {
    books: renderBooks(live, catalogs, stats),
    index: renderTopics(kw.nodes),
    publish: renderRequest(requestEndpoint, contact),
  };

  // Recent changes beside the topic and author lists on a wide screen; stacked on a phone.
  const pair =
    recent || browse
      ? ['    <div class="pair">', '      <div class="wrap">', recent, browse, '      </div>', '    </div>'].filter(Boolean).join('\n')
      : null;

  const NAV = [
    ['books', live.length === 1 ? 'The book' : 'Books', section.books],
    ['recent', 'Recent', recent],
    ['topics', 'Topics', browse],
    ['publish', 'Publish a book', section.publish],
  ].filter(([, , html]) => html);
  const navItems = NAV.map(([id, text]) => `<a href="#${id}">${text}</a>`);
  const nav = navItems.length > 1 ? `      <nav class="jump" aria-label="On this page">${navItems.join('')}</nav>\n` : '';
  const search = kw.nodes.length
    ? `<button type="button" class="icon-btn search-btn" aria-label="Search topics" title="Search topics" hidden>${ICON_SEARCH}</button>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Confused for Now — Open Science &amp; Education</title>
<meta name="description" content="Open-access textbooks published on this platform.">
<meta name="robots" content="index, follow">
<link rel="icon" href="data:,">
<meta name="portal-version" content="${escapeHtml(portalSha)}">
<!-- Generated by scripts/build.mjs from registry ${escapeHtml(sha)}. Do not edit: change the registry. -->
${THEME_SCRIPT}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS_HREF}">
<style>
${css.trim()}
</style>
${renderAnalytics(analytics)}</head>
<body>
  <main>
    <header class="masthead">
      <div class="wrap">
      <a class="home" href="/" aria-label="Confused for Now (home)">${LOGO_SVG}</a>
      <h1 class="sr-only">Confused for Now</h1>
${nav}      <div class="masthead-tools">${search}<button type="button" class="icon-btn theme-toggle" aria-label="Switch to dark mode" aria-pressed="false" hidden>${ICON_THEME}</button></div>
      </div>
    </header>

    <section class="section section--about" id="about" aria-labelledby="about-h">
      <div class="wrap about-grid${graph ? '' : ' about-grid--alone'}">
      <div class="prose">
        <h2 id="about-h">About</h2>
        <p class="lede">Confused for Now is a platform committed to open science and open education.</p>
        <p class="serif">It is built on the belief that knowledge develops through continual discovery, and that this development is marked by starts, stops and reversals. We want to normalise the view that these are not flaws but an integral part of how science works. Scientific communication should therefore take place somewhere that makes room for the detours, mistakes and innovations through which science steadily improves its explanatory power. This site is our attempt to build such a place.</p>
        <div class="about-folds">
        <details class="about-more">
          <summary>Read more</summary>
          <p>Underlying the platform is a commitment to making the ontological assumptions inherent in all scientific work explicit and transparent, because meaningful debate depends on knowing what each position takes for granted. To this end, we embed debate directly in the writing itself. One of our central goals is to reframe scientific work from something finished on the publication date to something that keeps evolving as new information, and better ways of communicating it, emerge.</p>
          <p>In practice, every text on the platform has a clear version history documenting how it has developed, so readers can follow the field as it moves. Where disagreement cannot be resolved and further work is needed, a version can be branched into an alternative path. The platform also serves as a venue for open-access publication and peer review. For students, it offers a way to stay in touch with current thinking in their field long after their course has ended.</p>
        </details>
        <details class="about-more">
          <summary>How to contribute</summary>
          <p>Anyone is welcome to take part. As you read, you can comment on passages and propose edits directly in the text. The authors moderate contributions according to principles of transparent dialogue. Each contribution is discussed, then either incorporated as an improvement or recorded as a point of tension that may open a line of future research. Nothing is lost along the way, because every change remains visible in the version history.</p>
          <p>We are glad you are here, and we hope you will join the conversation.</p>
        </details>
        <details class="about-more">
          <summary>Why Confused for Now?</summary>
          <p>The name has a double meaning. First, worthwhile knowledge is challenging to acquire, and some confusion is part of healthy learning. It is quite alright, and often helpful, to be confused for now.</p>
          <p>Second, all knowledge is provisional. Every account of the world is incomplete, not because it is false, but because there is always more to grasp. In that sense, the whole scientific community is confused for now. The big questions of our time carry real weight. The more we can work together on a common project that integrates partial knowledge, the better our chance of reducing, or even eliminating, confusion about why we disagree, even where disagreement remains.</p>
          <p>We hope the platform serves your community well. If you have ideas on how to make open education and open science work better for you, we would love to hear from you at <a href="mailto:sommer@euc.eur.nl">sommer@euc.eur.nl</a>.</p>
        </details>
        </div>
      </div>
${graph ?? ''}
      </div>
    </section>

${[section.books, pair, section.index, section.publish].filter(Boolean).join('\n\n')}

    <footer class="colophon">
      <div class="wrap">
      <p>© ${new Date().getUTCFullYear()} Confused for Now — every book&#39;s licence is stated on the book itself, and its source text is in a public repository.</p>
      <p><a href="${GUIDE_URL}">Guide for authors</a> · <a href="/privacy">Privacy</a>${stats ? ` · <a href="${escapeHtml(stats)}">Platform statistics</a>` : ''} · ${contact ? `<a href="mailto:${escapeHtml(contact)}">${escapeHtml(contact)}</a>` : 'Generated from the platform registry.'}</p>
      </div>
    </footer>
  </main>
${js.trim() ? `<script>\n${js.trim()}\n</script>\n` : ''}</body>
</html>
`;
}

/* -------------------------------------------------------------------------
   Main
   ------------------------------------------------------------------------- */

function copyStatic() {
  let entries;
  try {
    entries = readdirSync(STATIC_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile())
    .map((e) => {
      copyFileSync(`${STATIC_DIR}${e.name}`, `${OUT_DIR}${e.name}`);
      return e.name;
    });
}

function readLocalCatalogs(books, dir) {
  const catalogs = new Map();
  const warnings = [];
  for (const book of books.filter((b) => b.catalogUrl)) {
    try {
      catalogs.set(book.slug, readCatalog(JSON.parse(readFileSync(`${dir}/${book.slug}.json`, 'utf8')), book.slug));
    } catch (err) {
      warnings.push(`${book.slug}: no local catalog used — ${err.message}`);
    }
  }
  return { catalogs, warnings };
}

async function main() {
  const local = process.env.REGISTRY_FILE;
  let registry, sha;

  if (local) {
    // Local preview only. Never used by the Pages build, and the version
    // marker says so, so a local build can't be mistaken for a real one.
    registry = JSON.parse(readFileSync(local, 'utf8'));
    sha = 'local';
    console.log(`build: reading ${local} (local preview)`);
  } else {
    const ref = process.env.REGISTRY_REF || 'main';
    sha = resolveSha(ref);
    registry = await fetchRegistry(sha);
    console.log(`build: ${REGISTRY_REPO}@${sha} (${ref})`);
  }

  const { listed, skipped } = selectBooks(registry);
  for (const s of skipped) console.warn(`build: WARNING skipped ${s.where} — ${s.reason}`);

  // Each book's catalog, for everything past the list. A local preview can
  // point CATALOG_DIR at a folder of <slug>.json files instead.
  const { catalogs, warnings } = process.env.CATALOG_DIR
    ? readLocalCatalogs(listed, process.env.CATALOG_DIR)
    : await fetchCatalogs(listed);
  for (const w of warnings) console.warn(`build: WARNING ${w}`);

  const css = readFileSync(CSS_FILE, 'utf8');
  const js = readFileSync(JS_FILE, 'utf8');
  // PORTAL_CONTACT (a Pages environment variable) is the no-JavaScript fallback's address.
  const contact = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(process.env.PORTAL_CONTACT ?? '') ? process.env.PORTAL_CONTACT : null;
  // This repo's own commit, which Cloudflare Pages sets on every build (push or
  // deploy hook). version.txt is the REGISTRY's commit, so it can't tell a stale
  // portal from a current one; .github/workflows/deployed.yml polls this instead.
  const portalSha = /^[0-9a-f]{40}$/.test(process.env.CF_PAGES_COMMIT_SHA ?? '') ? process.env.CF_PAGES_COMMIT_SHA : 'local';
  const html = renderPage({ books: listed, sha, portalSha, css, js, catalogs, requestEndpoint: requestEndpointOf(registry), contact, analytics: analyticsOf(registry), stats: statsOf(registry) });

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}index.html`, html);
  // The portal's X-Registry-Version. textbook-registry/.github/workflows/portal.yml
  // polls this until it matches the merge SHA, exactly as deploy.yml polls the
  // function's header. No trailing newline: the poller compares the whole body.
  writeFileSync(`${OUT_DIR}version.txt`, sha);
  writeFileSync(`${OUT_DIR}privacy.html`, renderPrivacyPage({ css, analytics: analyticsOf(registry), stats: statsOf(registry), portalSha }));
  const copied = copyStatic();

  console.log(
    `build: ${listed.length} book(s) listed, ${catalogs.size} with a catalog` +
      (skipped.length ? `, ${skipped.length} skipped` : '') +
      ` -> public/index.html, public/version.txt, public/privacy.html` +
      (copied.length ? `, ${copied.join(', ')}` : ''),
  );
}

// Only when run directly, so the tests can import the pure functions above.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`build: ${err instanceof BuildError ? err.message : err.stack}`);
    process.exit(1);
  });
}
