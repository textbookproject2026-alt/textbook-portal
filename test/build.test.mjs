/**
 * The rule under test, above all others (PORTAL-CUTOVER §5c): the build must
 * never fail because one book's entry is odd. That is invisible by eye — the
 * registry is well-formed today — so it is pinned here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectBooks, renderPage, escapeHtml, BuildError, STATUS_LABELS } from '../scripts/build.mjs';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

const liveBook = () => ({
  slug: 'social-research-methods',
  status: 'live',
  title: 'Education Tool Project 2026',
  summary: 'An open-access textbook on ontology and social research methods.',
  maintainer: { name: 'Brandon', github: 'textbookproject2026-alt' },
  site: { domain: 'social-research-methods.confused4now.org' },
  editions: { template_preview: 'https://textbook-edition-template.pages.dev' },
});

const previewBook = () => ({
  slug: 'platform-test-book',
  status: 'preview',
  title: 'Platform test book',
  summary: 'A throwaway book used to test the shared services with two books. Not for readers.',
  maintainer: { name: 'Platform test', github: 'dept-coordinator-test' },
  site: { domain: 'platform-test-book.pages.dev' },
  editions: null,
});

const registry = (...books) => ({ schema_version: 1, platform: {}, books });
const render = (reg) => renderPage({ books: selectBooks(reg).listed, sha: 'a'.repeat(40), css });

/* --- what gets listed --------------------------------------------------- */

test('lists live and preview books that have a domain', () => {
  const { listed, skipped } = selectBooks(registry(liveBook(), previewBook()));
  assert.deepEqual(listed.map((b) => b.slug), ['social-research-methods', 'platform-test-book']);
  assert.deepEqual(skipped, []);
});

test('live books sort before preview, whatever order the registry has them in', () => {
  const { listed } = selectBooks(registry(previewBook(), liveBook()));
  assert.deepEqual(listed.map((b) => b.status), ['live', 'preview']);
});

test('a retired book is never listed, and is not a warning', () => {
  const retired = { ...liveBook(), slug: 'gone', status: 'retired' };
  const { listed, skipped } = selectBooks(registry(liveBook(), retired));
  assert.deepEqual(listed.map((b) => b.slug), ['social-research-methods']);
  assert.deepEqual(skipped, []);
});

test('a book with a null domain is skipped, not rendered as a dead link', () => {
  const noDomain = { ...previewBook(), slug: 'unbound', site: { domain: null } };
  const { listed, skipped } = selectBooks(registry(liveBook(), noDomain));
  assert.deepEqual(listed.map((b) => b.slug), ['social-research-methods']);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /site\.domain/);
});

/* --- the hard rule ------------------------------------------------------ */

for (const [name, book] of [
  ['no slug', { ...previewBook(), slug: null }],
  ['no title', { ...previewBook(), title: '' }],
  ['no summary', { ...previewBook(), summary: '   ' }],
  ['an unknown status', { ...previewBook(), status: 'archived' }],
  ['a domain with a scheme', { ...previewBook(), site: { domain: 'https://x.example' } }],
  ['a domain with a path', { ...previewBook(), site: { domain: 'x.example/book' } }],
  ['no site object', { ...previewBook(), site: undefined }],
  ['a wholly empty object', {}],
  ['null', null],
]) {
  test(`one book with ${name} is skipped, and the rest still build`, () => {
    const { listed, skipped } = selectBooks(registry(liveBook(), book));
    assert.deepEqual(listed.map((b) => b.slug), ['social-research-methods']);
    assert.equal(skipped.length, 1, 'the odd book should be reported, not silently dropped');
    const html = renderPage({ books: listed, sha: 'a'.repeat(40), css });
    assert.match(html, /Education Tool Project 2026/);
  });
}

test('a broken optional field costs the book its extra, never its place in the list', () => {
  const odd = { ...liveBook(), maintainer: null, editions: { template_preview: 'javascript:alert(1)' } };
  const { listed, skipped } = selectBooks(registry(odd));
  assert.deepEqual(skipped, []);
  assert.equal(listed[0].maintainer, null);
  assert.equal(listed[0].templatePreview, null);
  assert.doesNotMatch(render(registry(odd)), /javascript:/);
});

/* --- when the build SHOULD fail ----------------------------------------- */

test('an unknown schema_version fails the build rather than guessing', () => {
  assert.throws(() => selectBooks({ schema_version: 2, books: [liveBook()] }), BuildError);
});

test('a registry with nothing listable fails the build rather than publishing an empty page', () => {
  assert.throws(() => selectBooks(registry({ ...liveBook(), status: 'retired' })), /would be empty/);
  assert.throws(() => selectBooks(registry()), /would be empty/);
});

test('the failure names the books it skipped, so the cause is in the build log', () => {
  assert.throws(() => selectBooks(registry({ slug: 'broken', status: 'live', site: {} })), /broken/);
});

/* --- rendering ---------------------------------------------------------- */

test('a preview book appears nowhere on the page, and a live book carries no badge', () => {
  // The page body only: the inlined stylesheet's header names platform-test-book as a source.
  const body = render(registry(liveBook(), previewBook())).split('<main>')[1];
  assert.doesNotMatch(body, /platform-test-book|Platform test book/);
  assert.doesNotMatch(body, /Not for readers|section--preview/);
  assert.doesNotMatch(body, /class="badge"/);
});

test('a live book links to its own https address', () => {
  const html = render(registry(liveBook(), previewBook()));
  assert.match(html, /href="https:\/\/social-research-methods\.confused4now\.org"/);
});

test('the page carries the registry SHA it was built from', () => {
  assert.match(render(registry(liveBook())), new RegExp('a'.repeat(40)));
});

test('registry text is escaped, not interpolated', () => {
  const nasty = { ...liveBook(), title: '<script>alert(1)</script>', summary: 'Tom & "Jerry"' };
  const html = render(registry(nasty));
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Tom &amp; &quot;Jerry&quot;/);
  assert.equal(escapeHtml(`<&>"'`), '&lt;&amp;&gt;&quot;&#39;');
});

test('the heading is singular when there is only one live book', () => {
  assert.match(render(registry(liveBook())), /The book<\/h2>/);
  assert.match(render(registry(liveBook(), { ...liveBook(), slug: 'two' })), /The books<\/h2>/);
});

test('the stylesheet is inlined, so the page is the only URL it needs', () => {
  const html = render(registry(liveBook()));
  assert.match(html, /--portal-accent/);
  assert.doesNotMatch(html, /<link[^>]+stylesheet/);
});

test('only live and preview are listable statuses', () => {
  assert.deepEqual(Object.keys(STATUS_LABELS).sort(), ['live', 'preview']);
});

/* --- catalogs: key words, recent changes, authors, topics ---------------- */

import { readCatalog, keywords, recentChanges, authors, pageUrl, catalogUrl, fetchCatalogs, topicSlots, TOPIC_SLOTS } from '../scripts/catalog.mjs';
import { layout, VIEW } from '../scripts/graph.mjs';

const builderBook = () => ({
  ...liveBook(),
  site: {
    domain: 'social-research-methods.confused4now.org',
    host: { kind: 'static', provider: 'cloudflare-pages', project: 'social-research-methods', builder: 'quartz-book' },
  },
});

const catalog = (over = {}) => ({
  version: 1,
  slug: 'social-research-methods',
  book_commit: 'c'.repeat(40),
  authors: [],
  pages: [
    { path: '/', source: 'index.md', title: 'Home', tags: [], concept: false, authors: [], links: ['/chapters/Definitions/Emergence', '/chapters/Definitions/Monism'] },
    { path: '/chapters/chapter-03', source: 'chapters/chapter-03.md', title: 'Chapter 3', tags: ['ontology'], concept: false, authors: [], links: ['/chapters/Definitions/Emergence', '/chapters/Definitions/Monism'] },
    { path: '/chapters/Definitions/Emergence', source: 'chapters/Definitions/Emergence.md', title: 'Emergence', tags: [], concept: true, authors: [], links: [] },
    { path: '/chapters/Definitions/Monism', source: 'chapters/Definitions/Monism.md', title: 'Monism', tags: ['ontology'], concept: true, authors: [], links: [] },
  ],
  recent: [
    { date: '2026-09-01T10:00:00+02:00', path: '/chapters/Definitions/Emergence', change: 'updated' },
    { date: '2026-09-01T10:00:00+02:00', path: '/chapters/Definitions/Monism', change: 'updated' },
    { date: '2026-09-20T10:00:00+02:00', path: '/chapters/chapter-03', change: 'added' },
    { date: 'not a date', path: '/chapters/chapter-03', change: 'added' },
    { date: '2026-09-21T10:00:00+02:00', path: '/nowhere', change: 'added' },
  ],
  ...over,
});

const withCatalog = (over) => {
  const { listed } = selectBooks(registry(builderBook(), previewBook()));
  return { listed, catalogs: new Map([['social-research-methods', readCatalog(catalog(over), 'social-research-methods')]]) };
};

test('the catalog is read from the Pages project, and only for builder books', () => {
  assert.equal(catalogUrl(builderBook()), 'https://social-research-methods.pages.dev/.well-known/textbook-catalog.json');
  assert.equal(catalogUrl(liveBook()), null);
  assert.equal(catalogUrl(previewBook()), null);
});

test('a catalog of the wrong version or book is refused; odd entries inside it are dropped', () => {
  assert.throws(() => readCatalog(catalog({ version: 2 }), 'social-research-methods'), /version/);
  assert.throws(() => readCatalog(catalog(), 'another-book'), /catalog, not/);
  const c = readCatalog(catalog({ pages: [...catalog().pages, { path: 'javascript:x', title: 'x' }, null] }), 'social-research-methods');
  assert.equal(c.pages.length, 4);
  assert.equal(c.recent.length, 3, 'unparseable dates and unknown pages are dropped');
});

test('a catalog that fails to load costs the book its extras, never the build', async () => {
  const { listed } = selectBooks(registry(builderBook()));
  const failing = async () => ({ ok: false, status: 404, text: async () => '' });
  const { catalogs, warnings } = await fetchCatalogs(listed, { fetchImpl: failing });
  assert.equal(catalogs.size, 0);
  assert.match(warnings[0], /404/);
  const html = renderPage({ books: listed, sha: 'a'.repeat(40), css, catalogs });
  assert.match(html, /Education Tool Project 2026/);
  assert.doesNotMatch(html, /id="keywords"/);
});

test('key words: tags and concepts, linked by the pages they share; the home page does not count', () => {
  const { listed, catalogs } = withCatalog();
  const kw = keywords(listed, catalogs);
  assert.deepEqual(kw.nodes.map((n) => [n.label, n.kind]), [['Emergence', 'concept'], ['Monism', 'concept'], ['ontology', 'tag']]);
  const emergence = kw.nodes.find((n) => n.label === 'Emergence');
  assert.deepEqual(emergence.pages.map((p) => p.title), ['Emergence', 'Chapter 3'], 'its own page first; not Home');
  const w = (a, b) => kw.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))?.weight ?? 0;
  assert.equal(w('emergence', 'monism'), 1);
  assert.equal(w('monism', 'ontology'), 2, 'chapter 3, and Monism tagged ontology');
});

test('key words carry a topic, their authors and books, for colour and the filters', () => {
  const pages = catalog().pages.map((p) => ({ ...p }));
  pages[1].topic = 'Ontology'; // Chapter 3
  pages[1].authors = ['A. Author'];
  pages[2].topic = 'Emergence studies'; // the Emergence concept page itself
  pages[3].topic = 'ontology'; // Monism, spelt differently
  const { listed, catalogs } = withCatalog({ pages, authors: ['Brandon Sommer'] });
  const kw = keywords(listed, catalogs);
  const by = (label) => kw.nodes.find((n) => n.label === label);
  assert.equal(by('Emergence').topic, 'Emergence studies', 'a concept takes its own page\'s topic');
  assert.equal(by('ontology').topic, 'Ontology', 'a tag takes the topic most of its pages share');
  assert.deepEqual(by('ontology').authors, ['A. Author', 'Brandon Sommer'], 'page authors, else the book\'s');
  assert.deepEqual(by('Monism').bookSlugs, ['social-research-methods']);
  const slots = topicSlots(kw.nodes);
  assert.deepEqual(slots.map((t) => [t.label, t.slot]), [['Ontology', 0], ['Emergence studies', 1]]);
  // An older catalog has no topics: nothing breaks, everything is "Other".
  const old = withCatalog();
  assert.ok(keywords(old.listed, old.catalogs).nodes.every((n) => n.topic === null));
});

test('topics past the last colour slot are Other, never a new colour', () => {
  const nodes = Array.from({ length: TOPIC_SLOTS + 3 }, (_, i) => ({ topic: `T${String(i).padStart(2, '0')}` }));
  assert.equal(topicSlots(nodes).length, TOPIC_SLOTS);
});

test('the graph is coloured by topic and carries its filters', () => {
  const pages = catalog().pages.map((p) => ({ ...p }));
  pages[3].topic = 'Ontology'; // Monism; Chapter 3 and Emergence have none
  pages[2].authors = ['A. Author'];
  const { listed, catalogs } = withCatalog({ pages });
  const html = renderPage({ books: listed, sha: 'a'.repeat(40), css, catalogs });
  const node = (label) => html.match(new RegExp(`<a class="kw-node[^>]*data-label="${label}"[^>]*>`))[0];
  assert.match(node('Monism'), /data-t="0"/);
  assert.match(node('Emergence'), /data-t="other"/, 'no topic of its own, and its pages have none');
  assert.match(node('Emergence'), /data-authors="\[&quot;A\. Author&quot;,&quot;Brandon&quot;\]"/);
  assert.match(html, /<select data-filter="topic">.*<option value="0">Ontology<\/option><option value="other">Other<\/option>/);
  assert.match(html, /<select data-filter="author">/);
  assert.doesNotMatch(html, /data-filter="book"/, 'one live book: no book filter');
  assert.match(html, /<ul class="kw-topics"[^>]*><li><button type="button" data-t="0" disabled>/);
});

test('recent changes: one row per book per day, newest first', () => {
  const { listed, catalogs } = withCatalog();
  const rows = recentChanges(listed, catalogs);
  assert.deepEqual(rows.map((r) => [r.date.slice(0, 10), r.change, r.pages.length]), [
    ['2026-09-20', 'added', 1],
    ['2026-09-01', 'updated', 2],
  ]);
});

test('authors: the catalog\'s, else the maintainer; preview books never feed reader sections', () => {
  const { listed, catalogs } = withCatalog();
  assert.deepEqual(authors(listed, catalogs).map((a) => a.name), ['Brandon']);
  const named = withCatalog({ authors: ['Brandon Sommer', 'A. Co-Author'] });
  assert.deepEqual(authors(named.listed, named.catalogs).map((a) => a.name), ['A. Co-Author', 'Brandon Sommer']);
  const html = renderPage({ books: listed, sha: 'a'.repeat(40), css, catalogs });
  assert.doesNotMatch(html.split('<main>')[1], /platform-test-book/);
});

test('a book still on Obsidian Publish gets Publish addresses for its pages', () => {
  const book = { url: 'https://x.example', host: 'obsidian-publish' };
  assert.equal(pageUrl(book, { path: '/chapters/Definitions/The-Three-Domains', source: 'chapters/Definitions/The Three Domains.md' }),
    'https://x.example/chapters/Definitions/The+Three+Domains');
  assert.equal(pageUrl({ ...book, host: 'static' }, { path: '/chapters/Definitions/The-Three-Domains' }),
    'https://x.example/chapters/Definitions/The-Three-Domains');
});

test('the page: all four new sections, a graph that works without script, and still two files', () => {
  const { listed, catalogs } = withCatalog();
  const js = readFileSync(new URL('../src/portal.js', import.meta.url), 'utf8');
  const html = renderPage({ books: listed, sha: 'a'.repeat(40), css, js, catalogs });
  for (const id of ['books', 'keywords', 'recent', 'authors', 'topics']) assert.match(html, new RegExp(`id="${id}"`));
  // Every node is a link into the topic index, and every target exists.
  const targets = [...html.matchAll(/class="kw-node[^"]*" href="#(topic-[a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.equal(targets.length, 3);
  for (const t of targets) assert.match(html, new RegExp(`<li class="topic" id="${t}"`));
  assert.match(html, /#ontology/);
  // Inlined: no script or stylesheet URL for the apex redirect rule to catch.
  assert.doesNotMatch(html, /<script[^>]+src=/);
  assert.doesNotMatch(html, /<link[^>]+stylesheet/);
});

test('catalog text is escaped too', () => {
  const nasty = catalog();
  nasty.pages[2].title = '<img src=x onerror=alert(1)>';
  const { listed } = selectBooks(registry(builderBook()));
  const catalogs = new Map([['social-research-methods', readCatalog(nasty, 'social-research-methods')]]);
  const html = renderPage({ books: listed, sha: 'a'.repeat(40), css, catalogs });
  assert.doesNotMatch(html, /<img src=x/);
});

test('the graph layout is deterministic and inside the view', () => {
  const { listed, catalogs } = withCatalog();
  const kw = keywords(listed, catalogs);
  const a = layout(kw);
  assert.deepEqual(a, layout(kw));
  for (const n of a) {
    assert.ok(n.x >= 0 && n.x <= VIEW.width && n.y >= 0 && n.y <= VIEW.height, `${n.label} at ${n.x},${n.y}`);
  }
});

/* --- publish your textbook here ----------------------------------------- */

import { requestEndpointOf, SANDBOX_LABEL } from '../scripts/build.mjs';

test('the request endpoint is the suggest-edit endpoint\'s sibling, or nothing', () => {
  const reg = (e) => ({ platform: { suggest_edit_endpoint: e } });
  assert.equal(requestEndpointOf(reg('https://fn.vercel.app/api/suggest-edit')), 'https://fn.vercel.app/api/request-book');
  assert.equal(requestEndpointOf(reg('https://fn.vercel.app/other')), null);
  assert.equal(requestEndpointOf(reg('http://fn.vercel.app/api/suggest-edit')), null);
  assert.equal(requestEndpointOf({}), null);
});

test('the request form is rendered with its endpoint, and left out without one', () => {
  const books = selectBooks(registry(liveBook())).listed;
  const withForm = renderPage({ books, sha: 'a'.repeat(40), css, requestEndpoint: 'https://fn.vercel.app/api/request-book', contact: 'hello@example.org' });
  assert.match(withForm, /id="publish"/);
  assert.match(withForm, /data-endpoint="https:\/\/fn\.vercel\.app\/api\/request-book"/);
  assert.match(withForm, /name="website"/); // honeypot
  assert.match(withForm, /mailto:hello@example\.org/);
  assert.match(withForm, /href="#publish"/);
  const without = renderPage({ books, sha: 'a'.repeat(40), css });
  assert.doesNotMatch(without, /id="publish"/);
});

test('a sandbox book is listed, badged as a test', () => {
  const b = liveBook();
  b.sandbox = true;
  const html = render(registry(b));
  assert.match(html, new RegExp(SANDBOX_LABEL));
  assert.doesNotMatch(render(registry(liveBook())), new RegExp(SANDBOX_LABEL));
});

/* --- analytics ----------------------------------------------------------- */

import { analyticsOf } from '../scripts/build.mjs';

test('the platform\'s Plausible site, counted only on the portal\'s own domain (D19)', () => {
  const src = 'https://plausible.io/js/pa-abc.js';
  const reg = (plausible, domain = 'portal.example') => ({
    platform: { portal: { domain }, analytics: { plausible } },
  });
  const site = { script_src: src, site: 'portal.example', dashboard_public: true };
  assert.deepEqual(analyticsOf(reg(site)), { src, domain: 'portal.example' });
  assert.equal(analyticsOf(reg(null)), null);
  assert.equal(analyticsOf({ platform: {} }), null);
  assert.equal(analyticsOf(reg({ ...site, script_src: 'https://evil.example/js/pa-abc.js' })), null);
  assert.equal(analyticsOf(reg(site, '')), null);

  const books = selectBooks(registry(liveBook())).listed;
  const html = renderPage({ books, sha: 'a'.repeat(40), css, analytics: analyticsOf(reg(site)) });
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, /location\.hostname !== "portal\.example"\) return/);
  assert.ok(head.includes(JSON.stringify(src)));
  assert.doesNotMatch(renderPage({ books, sha: 'a'.repeat(40), css }), /plausible/);
});

test('landing order: nav in the header; about, books, then the closed fold-outs', () => {
  const { listed, catalogs } = withCatalog();
  const body = renderPage({ books: listed, sha: 'a'.repeat(40), css, catalogs }).split('<main>')[1];
  const at = (s) => body.indexOf(s);
  assert.ok(at('class="jump"') > at('<h1>') && at('class="jump"') < at('</header>'), 'the section nav is in the header');
  assert.ok(at('class="section section--about"') < at('id="books"'));
  assert.ok(at('id="books"') < at('class="about-folds"'));
  assert.ok(at('class="about-folds"') < at('id="keywords"'));
  assert.deepEqual([...body.matchAll(/<details class="about-more">\s*<summary>([^<]+)</g)].map((m) => m[1]),
    ['Read more', 'How to contribute', 'Why Confused for Now?']);
  assert.ok(at('id="recent"') < at('id="authors"') && at('id="authors"') < at('id="topics"'));
  assert.equal((body.match(/<h1>/g) ?? []).length, 1);
});
