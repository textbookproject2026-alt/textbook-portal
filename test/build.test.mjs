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
