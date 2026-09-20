#!/usr/bin/env node
/**
 * Build the platform portal: one HTML page listing the platform's books,
 * generated from the registry at BUILD time.
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

const REGISTRY_REPO = 'textbookproject2026-alt/textbook-registry';
const SCHEMA_VERSION = 1;
const FETCH_TIMEOUT_MS = 15000;

const ROOT = new URL('../', import.meta.url);
const OUT_DIR = fileURLToPath(new URL('public/', ROOT));
const STATIC_DIR = fileURLToPath(new URL('static/', ROOT));
const CSS_FILE = fileURLToPath(new URL('src/styles.css', ROOT));

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
      templatePreview: isHttpsUrl(book?.editions?.template_preview) ? book.editions.template_preview : null,
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

function renderBook(book) {
  const label = STATUS_LABELS[book.status];
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
    `        <p class="meta">${meta.join('<span class="sep">·</span>')}</p>`,
    '      </li>',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderSection({ className, heading, books }) {
  if (books.length === 0) return null;
  return [
    `    <section class="section ${className}">`,
    `      <h2>${escapeHtml(heading)}</h2>`,
    '      <ul class="books">',
    books.map(renderBook).join('\n'),
    '      </ul>',
    '    </section>',
  ].join('\n');
}

export function renderPage({ books, sha, css }) {
  const live = books.filter((b) => b.status === 'live');
  const preview = books.filter((b) => b.status === 'preview');

  const sections = [
    renderSection({ className: 'section--live', heading: live.length === 1 ? 'The book' : 'The books', books: live }),
    renderSection({ className: 'section--preview', heading: 'Not for readers', books: preview }),
  ].filter(Boolean);

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

${sections.join('\n\n')}

    <footer class="colophon">
      <p>Each book is licensed by its maintainer; the licence is stated on the book itself. Every book&#39;s source text is in a public repository.</p>
      <p>This page is generated from the platform registry, and lists only what the registry holds.</p>
    </footer>
  </main>
</body>
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

  const css = readFileSync(CSS_FILE, 'utf8');
  const html = renderPage({ books: listed, sha, css });

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}index.html`, html);
  // The portal's X-Registry-Version. textbook-registry/.github/workflows/portal.yml
  // polls this until it matches the merge SHA, exactly as deploy.yml polls the
  // function's header. No trailing newline: the poller compares the whole body.
  writeFileSync(`${OUT_DIR}version.txt`, sha);
  const copied = copyStatic();

  console.log(
    `build: ${listed.length} book(s) listed` +
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
