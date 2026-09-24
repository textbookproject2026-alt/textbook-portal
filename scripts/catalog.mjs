/**
 * What the portal knows about each book beyond its registry entry: the book's
 * catalog, /.well-known/textbook-catalog.json, which quartz-book writes at every
 * build (quartz-book README, "The catalog"). Read at BUILD time, like the
 * registry, never in the browser.
 *
 * The hard rule applies here too, more strictly: a catalog that is missing,
 * slow, malformed or of a version this build doesn't know costs that book its
 * pages, keywords and recent changes on the portal, never its place in the
 * list, and never the build.
 *
 * Everything except fetchCatalogs is pure, so test/ can exercise it.
 */

export const CATALOG_PATH = '.well-known/textbook-catalog.json';
export const CATALOG_VERSION = 1;
const FETCH_TIMEOUT_MS = 10000;

/** How much of each the page shows. The catalogs carry more. */
export const LIMITS = { recent: 8, graphNodes: 60 };

/**
 * Topic colours in the graph: categorical slots in a fixed order (styles.css
 * --kw-topic-1 … -8). The same count as the books' graph (quartz-edition-extras
 * textbook-graph); past it, a topic is "Other", never a new colour.
 */
export const TOPIC_SLOTS = 8;

const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isPath = (v) => isText(v) && v.startsWith('/') && !v.startsWith('//') && !/[\s"'<>]/.test(v);
const textList = (v) => (Array.isArray(v) ? v.filter(isText).map((s) => s.trim()) : []);

/* -------------------------------------------------------------------------
   Where a book's catalog is, and where its pages are
   ------------------------------------------------------------------------- */

/**
 * The catalog's URL, or null for a book the builder doesn't build. Always the
 * book's Pages project, not site.domain: a book still served by Obsidian
 * Publish (book one before its cutover) has its builder output on Pages only.
 */
export function catalogUrl(entry) {
  const host = entry?.site?.host;
  if (host?.builder !== 'quartz-book') return null;
  if (!/^[a-z0-9][a-z0-9-]{0,57}$/.test(host.project ?? '')) return null;
  return `https://${host.project}.pages.dev/${CATALOG_PATH}`;
}

/**
 * A page's address on the book's own domain. Quartz serves the catalog's
 * `path`. Obsidian Publish served the source path without `.md`, each segment
 * encoded and spaces as `+` (quartz-book builder/lib.mjs publishUrl), so a
 * book still on Publish gets that spelling, or its concept pages would 404.
 */
export function pageUrl(book, page) {
  if (book.host === 'obsidian-publish' && isText(page.source)) {
    if (page.source === 'index.md') return book.url + '/';
    const path = page.source
      .replace(/\.md$/i, '')
      .split('/')
      .map((seg) => encodeURIComponent(seg).replace(/%20/g, '+'))
      .join('/');
    return `${book.url}/${path}`;
  }
  return book.url + page.path;
}

/* -------------------------------------------------------------------------
   Reading a catalog, tolerantly
   ------------------------------------------------------------------------- */

/**
 * The catalog, reduced to what the portal uses, or throws saying why it can't
 * be used. Individual odd pages and changes are dropped, not fatal.
 */
export function readCatalog(raw, slug) {
  if (raw === null || typeof raw !== 'object') throw new Error('not an object');
  if (raw.version !== CATALOG_VERSION) throw new Error(`version ${JSON.stringify(raw.version)} is not ${CATALOG_VERSION}`);
  if (raw.slug !== slug) throw new Error(`it is ${JSON.stringify(raw.slug)}'s catalog, not ${slug}'s`);
  if (!Array.isArray(raw.pages)) throw new Error('no pages');

  const pages = raw.pages
    .filter((p) => p && isPath(p.path) && isText(p.title))
    .map((p) => ({
      path: p.path,
      source: isText(p.source) ? p.source : null,
      title: p.title.trim(),
      tags: textList(p.tags).map((t) => t.toLowerCase()),
      concept: p.concept === true,
      authors: textList(p.authors),
      // quartz-book writes it from the page's frontmatter (builder/lib.mjs
      // topicOf). Catalogs older than that have none: the page is "Other".
      topic: isText(p.topic) ? p.topic.trim() : null,
      links: textList(p.links).filter(isPath),
    }));
  const known = new Set(pages.map((p) => p.path));

  const recent = (Array.isArray(raw.recent) ? raw.recent : [])
    .filter((r) => r && known.has(r.path) && !Number.isNaN(Date.parse(r.date)))
    .map((r) => ({
      date: new Date(r.date).toISOString(),
      path: r.path,
      change: r.change === 'added' ? 'added' : 'updated',
    }));

  return { authors: textList(raw.authors), pages, recent };
}

/** Every listed book's catalog, fetched in parallel. A failure is a warning. */
export async function fetchCatalogs(books, { fetchImpl = fetch } = {}) {
  const catalogs = new Map();
  const warnings = [];
  await Promise.all(
    books.map(async (book) => {
      if (!book.catalogUrl) return;
      try {
        const res = await fetchImpl(book.catalogUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`answered ${res.status}`);
        catalogs.set(book.slug, readCatalog(JSON.parse(await res.text()), book.slug));
      } catch (err) {
        warnings.push(`${book.slug}: catalog at ${book.catalogUrl} not used — ${err.message}`);
      }
    }),
  );
  return { catalogs, warnings };
}

/* -------------------------------------------------------------------------
   What the page shows, derived from the catalogs

   Only live books feed these. A preview book is "not for readers", so its
   pages, keywords and changes stay off the reader-facing sections.
   ------------------------------------------------------------------------- */

const readerBooks = (books, catalogs) => books.filter((b) => b.status === 'live' && catalogs.has(b.slug));

/** A key that makes "Emergence" in two books one keyword, and a tag and a concept of the same name one. */
export const keywordKey = (label) =>
  label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9/]+/g, ' ')
    .trim();

/**
 * Keywords across every live book: each tag, and each concept page's title.
 * `pages` is where the keyword appears: a page carrying the tag, the concept
 * page itself, and every page linking to it. `edges` join two keywords that
 * appear on the same page, weighted by how many pages they share.
 */
export function keywords(books, catalogs) {
  const byKey = new Map();
  const pageKeys = new Map(); // "slug path" -> Set of keyword keys

  const note = (key, label, kind, book, page, authorsOf) => {
    let k = byKey.get(key);
    if (!k) byKey.set(key, (k = { key, label, kinds: new Set(), pages: new Map(), books: new Set(), authors: new Set(), topics: new Map(), ownTopic: null }));
    // A concept's own title is a better label than a tag's lower-case spelling.
    if (kind === 'concept' && !k.kinds.has('concept')) k.label = label;
    k.kinds.add(kind);
    k.books.add(book.slug);
    const id = `${book.slug} ${page.path}`;
    const own = kind === 'concept' && page.concept && keywordKey(page.title) === key;
    if (!k.pages.has(id)) {
      k.pages.set(id, { book: book.title, title: page.title, url: pageUrl(book, page), own });
      for (const a of authorsOf(page)) k.authors.add(a);
      if (page.topic) {
        const t = k.topics.get(topicKey(page.topic)) ?? { label: page.topic, count: 0 };
        t.count++;
        k.topics.set(topicKey(page.topic), t);
      }
    }
    if (own && page.topic) k.ownTopic = page.topic;
    if (!pageKeys.has(id)) pageKeys.set(id, new Set());
    pageKeys.get(id).add(key);
  };

  for (const book of readerBooks(books, catalogs)) {
    const { pages, authors: bookAuthors } = catalogs.get(book.slug);
    // A page's authors: its own, else its book's, else the book's maintainer,
    // as in authors() below.
    const fallback = bookAuthors.length ? bookAuthors : book.maintainer ? [book.maintainer] : [];
    const authorsOf = (page) => (page.authors.length ? page.authors : fallback);
    const byPath = new Map(pages.map((p) => [p.path, p]));
    for (const page of pages) {
      for (const tag of page.tags) {
        if (tag === 'concept') continue; // a marker, not a subject
        note(keywordKey(tag), tag, 'tag', book, page, authorsOf);
      }
      if (page.concept) note(keywordKey(page.title), page.title, 'concept', book, page, authorsOf);
      // A book's home page links to everything; that says nothing about topics.
      if (page.path === '/') continue;
      for (const link of page.links) {
        const target = byPath.get(link);
        if (target?.concept) note(keywordKey(target.title), target.title, 'concept', book, page, authorsOf);
      }
    }
  }

  const edges = new Map();
  for (const keys of pageKeys.values()) {
    const list = [...keys].sort();
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const id = `${list[i]}\u0000${list[j]}`;
        edges.set(id, (edges.get(id) ?? 0) + 1);
      }
  }

  const nodes = [...byKey.values()]
    .filter((k) => k.key)
    .map((k) => ({
      key: k.key,
      label: k.label,
      kind: k.kinds.has('concept') ? 'concept' : 'tag',
      books: k.books.size,
      bookSlugs: [...k.books].sort(),
      authors: [...k.authors].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
      topic: keywordTopic(k),
      // The concept page itself first, then where it is used.
      pages: [...k.pages.values()]
        .sort((a, b) => b.own - a.own || a.book.localeCompare(b.book) || a.title.localeCompare(b.title))
        .map(({ own, ...p }) => ({ ...p, own })),
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }));

  return {
    nodes,
    edges: [...edges].map(([id, weight]) => {
      const [a, b] = id.split('\u0000');
      return { a, b, weight };
    }),
  };
}

/** Two spellings of one topic are one topic. */
export const topicKey = (label) => label.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * A keyword's topic: a concept page's own topic, else the topic most of the
 * pages it appears on share (ties A–Z), else null.
 */
function keywordTopic(k) {
  if (k.ownTopic) return k.ownTopic;
  const [best] = [...k.topics.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }));
  return best?.label ?? null;
}

/**
 * Which colour slot each topic in the graph gets: the topics of the most
 * graphed keywords first (ties A–Z), up to TOPIC_SLOTS. Decided once per
 * build, so filtering never repaints a node. Returns [{ key, label, slot }].
 */
export function topicSlots(nodes) {
  const count = new Map();
  for (const n of nodes) {
    if (!n.topic) continue;
    const key = topicKey(n.topic);
    const t = count.get(key) ?? { key, count: 0, spellings: new Map() };
    t.count++;
    t.spellings.set(n.topic, (t.spellings.get(n.topic) ?? 0) + 1);
    count.set(key, t);
  }
  // Shown as most keywords spell it; on a tie, capitalised ("Ontology" over "ontology").
  const upperFirst = new Intl.Collator('en', { caseFirst: 'upper' });
  for (const t of count.values())
    t.label = [...t.spellings].sort((a, b) => b[1] - a[1] || upperFirst.compare(a[0], b[0]))[0][0];
  return [...count.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }))
    .slice(0, TOPIC_SLOTS)
    .map(({ key, label }, slot) => ({ key, label, slot }));
}

/** The graph's share of the keywords: the most-used ones, and the edges between them. */
export function graphOf({ nodes, edges }, limit = LIMITS.graphNodes) {
  const top = [...nodes]
    .sort((a, b) => b.pages.length - a.pages.length || a.label.localeCompare(b.label))
    .slice(0, limit);
  const kept = new Set(top.map((n) => n.key));
  return { nodes: top, edges: edges.filter((e) => kept.has(e.a) && kept.has(e.b)) };
}

/**
 * The newest changes across live books, one row per book per day: a commit
 * that touches six concept pages is one piece of work, not six. `pages` is
 * newest first; `change` is "added" when every page in the row is new.
 */
export function recentChanges(books, catalogs, limit = LIMITS.recent) {
  const rows = new Map();
  for (const book of readerBooks(books, catalogs)) {
    const { pages, recent } = catalogs.get(book.slug);
    const byPath = new Map(pages.map((p) => [p.path, p]));
    for (const r of recent) {
      const page = byPath.get(r.path);
      const id = `${book.slug} ${r.date.slice(0, 10)}`;
      if (!rows.has(id)) rows.set(id, { date: r.date, book: book.title, bookUrl: book.url, pages: [], changes: new Set() });
      const row = rows.get(id);
      if (r.date > row.date) row.date = r.date;
      row.changes.add(r.change);
      row.pages.push({ title: page.title, url: pageUrl(book, page), change: r.change });
    }
  }
  return [...rows.values()]
    .map(({ changes, ...row }) => ({ ...row, change: changes.size === 1 && changes.has('added') ? 'added' : 'updated' }))
    .sort((a, b) => b.date.localeCompare(a.date) || a.book.localeCompare(b.book))
    .slice(0, limit);
}

/**
 * Authors and their books. A book's authors come from its catalog; a book with
 * none, or no catalog, is under its registry maintainer.
 */
export function authors(books, catalogs) {
  const byName = new Map();
  for (const book of books.filter((b) => b.status === 'live')) {
    const names = catalogs.get(book.slug)?.authors ?? [];
    const list = names.length ? names : book.maintainer ? [book.maintainer] : [];
    for (const name of list) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push({ title: book.title, url: book.url });
    }
  }
  return [...byName]
    .map(([name, list]) => ({ name, books: list }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

/** Per-book counts for the book list. */
export function bookStats(book, catalogs) {
  const c = catalogs.get(book.slug);
  if (!c) return null;
  // The stats workflow's community/ pages aren't part of the book's text.
  const text = c.pages.filter((p) => !p.path.startsWith('/community/'));
  const concepts = text.filter((p) => p.concept).length;
  const updated = c.recent.map((r) => r.date).sort().at(-1) ?? null;
  return { pages: text.length - concepts, concepts, updated };
}
