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

test('a preview book carries its label and a live book does not', () => {
  const html = render(registry(liveBook(), previewBook()));
  assert.match(html, /Preview — a demonstration, not for readers/);
  assert.equal(html.match(/class="badge"/g).length, 1);
  assert.match(html, /Not for readers<\/h2>/);
});

test('every listed book links to its own https address', () => {
  const html = render(registry(liveBook(), previewBook()));
  assert.match(html, /href="https:\/\/social-research-methods\.confused4now\.org"/);
  assert.match(html, /href="https:\/\/platform-test-book\.pages\.dev"/);
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

import { readCatalog, keywords, recentChanges, authors, pageUrl, catalogUrl, fetchCatalogs } from '../scripts/catalog.mjs';
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
  assert.doesNotMatch(html.split('<main>')[1].split('Not for readers')[0], /platform-test-book/);
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
