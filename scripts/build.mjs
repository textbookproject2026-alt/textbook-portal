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
 *   public/version.txt   the registry SHA it was built from
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

function renderBook(book, stats) {
  const label = book.sandbox ? SANDBOX_LABEL : STATUS_LABELS[book.status];
  const meta = [];
  if (book.maintainer) meta.push(`Maintained by ${escapeHtml(book.maintainer)}`);
  meta.push(`<a href="${escapeHtml(book.url)}">${escapeHtml(book.domain)}</a>`);
  if (book.templatePreview) {
    meta.push(`<a href="${escapeHtml(book.templatePreview)}">Department edition template</a>`);
  }

  return [
    '      <li class="book">',
    label ? `        <p class="badge">${escapeHtml(label)}</p>` : null,
    `        <h3><a href="${escapeHtml(book.url)}">${escapeHtml(book.title)}</a></h3>`,
    `        <p class="summary">${escapeHtml(book.summary)}</p>`,
    stats
      ? `        <p class="stats">${[
          plural(stats.pages, 'page'),
          stats.concepts ? plural(stats.concepts, 'concept page') : null,
          stats.updated ? `updated ${escapeHtml(formatDate(stats.updated))}` : null,
        ]
          .filter(Boolean)
          .join('<span class="sep">·</span>')}</p>`
      : null,
    `        <p class="meta">${meta.join('<span class="sep">·</span>')}</p>`,
    '      </li>',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderSection({ className, heading, books, catalogs, id }) {
  if (books.length === 0) return null;
  return [
    `    <section class="section ${className}"${id ? ` id="${id}"` : ''}>`,
    `      <h2>${escapeHtml(heading)}</h2>`,
    '      <ul class="books">',
    books.map((b) => renderBook(b, bookStats(b, catalogs))).join('\n'),
    '      </ul>',
    '    </section>',
  ].join('\n');
}

/* The keyword graph: a finished SVG, every node a link into the topic index,
   coloured by topic. src/portal.js adds highlighting, the side panel and the
   filters (kind, topic, author, book); their data is on each node. */
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
      const w = (0.6 + (1.6 * e.weight) / maxW).toFixed(2);
      return `<line class="kw-edge" data-a="${escapeHtml(e.a)}" data-b="${escapeHtml(e.b)}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke-width="${w}"/>`;
    })
    .join('\n        ');
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
    .join('\n        ');

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
    '    <section class="section section--keywords" id="keywords">',
    '      <h2>Key words</h2>',
    '      <p class="section-lead">Tags and concept pages across the books, coloured by topic. Linked words appear on the same pages; larger ones on more of them. Choose a word to see where it appears.</p>',
    '      <div class="kw-graph">',
    controls.length
      ? `        <div class="kw-filters" hidden>${controls.join('')}<button type="button" class="kw-reset" hidden>Clear filters</button></div>`
      : null,
    `        <svg viewBox="0 0 ${VIEW.width} ${VIEW.height}" aria-labelledby="kw-graph-title">`,
    `        <title id="kw-graph-title">Graph of ${plural(g.nodes.length, 'key word')} and the pages they share</title>`,
    `        <g class="kw-edges">${edges ? `\n        ${edges}\n        ` : ''}</g>`,
    `        ${nodes}`,
    '        </svg>',
    '        <p class="kw-count" aria-live="polite" hidden></p>',
    '        <div class="kw-panel" aria-live="polite" hidden></div>',
    '      </div>',
    legend.length ? `      <ul class="kw-topics" aria-label="Topics">${legend.join('')}</ul>` : null,
    '      <p class="kw-legend"><span class="kw-key kw-key--concept"></span>Concept page<span class="kw-key kw-key--tag"></span>Tag</p>',
    '    </section>',
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
      `        <li><time datetime="${escapeHtml(c.date)}">${escapeHtml(formatDate(c.date))}</time>` +
      `<span class="change change--${c.change}">${c.change === 'added' ? 'New' : 'Updated'}</span>` +
      `<span class="recent-pages">${shown.join(', ')}${more > 0 ? ` and ${plural(more, 'other page')}` : ''}</span>` +
      `<span class="recent-book">${escapeHtml(c.book)}</span></li>`
    );
  });
  return [
    '    <section class="section section--recent" id="recent">',
    '      <h2>Recently added and changed</h2>',
    '      <ul class="recent">',
    ...items,
    '      </ul>',
    '    </section>',
  ].join('\n');
}

function renderAuthors(list) {
  if (list.length === 0) return null;
  return [
    '    <section class="section section--authors" id="authors">',
    '      <h2>Browse by author</h2>',
    '      <ul class="authors">',
    ...list.map(
      (a) =>
        `        <li><span class="author">${escapeHtml(a.name)}</span>` +
        `<span class="author-books">${a.books.map((b) => `<a href="${escapeHtml(b.url)}">${escapeHtml(b.title)}</a>`).join(', ')}</span></li>`,
    ),
    '      </ul>',
    '    </section>',
  ].join('\n');
}

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
    '    <section class="section section--topics topics" id="topics">',
    '      <h2>Browse by topic</h2>',
    '      <p class="topics-filter" hidden><label>Filter topics <input type="search" autocomplete="off" spellcheck="false"></label></p>',
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
   section says how to ask by email instead.
   ------------------------------------------------------------------------- */

/** https://<fn>/api/suggest-edit -> https://<fn>/api/request-book, or null. */
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
    '    <section class="section section--request" id="publish">',
    '      <h2>Publish your textbook here</h2>',
    '      <p class="section-lead">Write an open textbook and we host it: its own address, margin comments, reader suggestions, an in-page editor, and a place on this page and in the key-word graph. Nothing technical is asked of you. Tell us about the book; once we have said yes, it is set up for you and you get an email with its address.</p>',
    `      <form class="request-form" data-endpoint="${escapeHtml(endpoint)}" hidden novalidate>`,
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
    '        <p class="rq-actions"><button type="submit">Send request</button><span class="rq-status" role="status" aria-live="polite"></span></p>',
    '      </form>',
    `      <p class="rq-nojs">${contact ? `The request form needs JavaScript. Or write to <a href="mailto:${escapeHtml(contact)}">${escapeHtml(contact)}</a>.` : 'The request form needs JavaScript.'}</p>`,
    '    </section>',
  ].join('\n');
}

/** A keyword as readers see it: a concept by its title, a tag as Obsidian writes it. */
const shownLabel = (n) => (n.kind === 'tag' ? `#${n.label}` : n.label);

export function renderPage({ books, sha, css, js = '', catalogs = new Map(), requestEndpoint = null, contact = null }) {
  const live = books.filter((b) => b.status === 'live');
  const preview = books.filter((b) => b.status === 'preview');
  const kw = keywords(books, catalogs);

  const parts = [
    ['books', renderSection({ className: 'section--live', heading: live.length === 1 ? 'The book' : 'The books', books: live, catalogs, id: 'books' })],
    ['keywords', renderGraph(kw, live)],
    ['recent', renderRecent(recentChanges(books, catalogs))],
    ['authors', renderAuthors(authors(books, catalogs))],
    ['topics', renderTopics(kw.nodes)],
    ['publish', renderRequest(requestEndpoint, contact)],
    [null, renderSection({ className: 'section--preview', heading: 'Not for readers', books: preview, catalogs })],
  ].filter(([, html]) => html);
  const sections = parts.map(([, html]) => html);

  const NAV = { books: live.length === 1 ? 'The book' : 'Books', keywords: 'Key words', recent: 'Recent', authors: 'Authors', topics: 'Topics', publish: 'Publish a book' };
  const navItems = parts.filter(([id]) => id && NAV[id]).map(([id]) => `<a href="#${id}">${NAV[id]}</a>`);
  const nav = navItems.length > 1 ? `    <nav class="jump" aria-label="On this page">${navItems.join('')}</nav>\n` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Open textbooks</title>
<meta name="description" content="Open-access textbooks published on this platform.">
<meta name="robots" content="index, follow">
<link rel="icon" href="data:,">
<!-- Generated by scripts/build.mjs from registry ${escapeHtml(sha)}. Do not edit: change the registry. -->
<style>
${css.trim()}
</style>
</head>
<body>
  <main>
    <header class="masthead">
      <h1>Open textbooks</h1>
      <p>Open-access textbooks, each written and maintained by its own author, published and kept online here.</p>
    </header>
${nav}
${sections.join('\n\n')}

    <footer class="colophon">
      <p>Each book is licensed by its maintainer; the licence is stated on the book itself. Every book&#39;s source text is in a public repository.</p>
      <p>This page is generated from the platform registry, and lists only what the registry holds.</p>
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
  const html = renderPage({ books: listed, sha, css, js, catalogs, requestEndpoint: requestEndpointOf(registry), contact });

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}index.html`, html);
  // The portal's X-Registry-Version. textbook-registry/.github/workflows/portal.yml
  // polls this until it matches the merge SHA, exactly as deploy.yml polls the
  // function's header. No trailing newline: the poller compares the whole body.
  writeFileSync(`${OUT_DIR}version.txt`, sha);
  const copied = copyStatic();

  console.log(
    `build: ${listed.length} book(s) listed, ${catalogs.size} with a catalog` +
      (skipped.length ? `, ${skipped.length} skipped` : '') +
      ` -> public/index.html, public/version.txt` +
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
