#!/usr/bin/env node
/**
 * Does the page's key-word graph draw its nodes?
 *
 *   node scripts/check-graph.mjs public/index.html     # CI, after the build
 *   node scripts/check-graph.mjs https://confused4now.org/   # after a deploy
 *
 * The page says what the graph had to work with (<meta name="portal-graph"
 * content="keywords=K nodes=N">, scripts/build.mjs). Fails when:
 *   - the meta is missing (a page this check can't vouch for);
 *   - the page draws a different number of nodes than it says;
 *   - there were key words to draw (K >= 2) and no node, or no graph section, was drawn;
 *   - there were fewer than two (K < 2) and any of the graph's markup (its box,
 *     filters, legend) is on the page anyway: it would be an empty box.
 * Fewer than two key words is content, not a fault: the section is left out,
 * the check passes with a warning (a red check there would block every portal
 * change until authors add tags).
 */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function checkGraph(page) {
  const meta = page.match(/<meta name="portal-graph" content="keywords=(\d+) nodes=(\d+)">/);
  if (!meta) return { ok: false, message: 'no <meta name="portal-graph">: the page was not built by this portal, or the build changed' };
  const keywords = Number(meta[1]);
  const said = Number(meta[2]);
  const drawn = (page.match(/<a class="kw-node[ "]/g) ?? []).length;
  if (drawn !== said) return { ok: false, message: `the page says ${said} graph nodes but draws ${drawn}` };
  if (keywords >= 2 && drawn === 0) return { ok: false, message: `${keywords} key words, and the graph drew no nodes` };
  if (keywords >= 2 && !page.includes('id="keywords"')) return { ok: false, message: `${keywords} key words, and no graph section (id="keywords")` };
  if (keywords < 2) {
    const left = page.match(/id="keywords"|class="kw-[a-z-]*/);
    if (left) return { ok: false, message: `no key-word graph to draw, but its markup is on the page (${left[0]}): an empty box` };
    return { ok: true, warning: `no key-word graph: the live books have ${keywords} key word${keywords === 1 ? '' : 's'} between them (2 needed: tags, or concept pages)` };
  }
  return { ok: true, message: `the graph draws ${drawn} of ${keywords} key words` };
}

// Run as a script (CI, registry portal.yml), not imported (the tests).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const where = process.argv[2];
  if (!where) {
    console.error('usage: check-graph.mjs <index.html | https://…/>');
    process.exit(2);
  }
  const html = /^https?:\/\//.test(where)
    ? await (await fetch(where, { headers: { 'Cache-Control': 'no-cache' } })).text()
    : readFileSync(where, 'utf8');
  const r = checkGraph(html);
  if (!r.ok) {
    console.log(`::error::${where}: ${r.message}`);
    process.exit(1);
  }
  console.log(r.warning ? `::warning::${where}: ${r.warning}` : `${where}: ${r.message}`);
}
