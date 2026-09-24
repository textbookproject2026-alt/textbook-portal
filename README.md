# textbook-portal

The platform portal: one static page at `confused4now.org` listing the textbooks
this platform publishes, generated from the registry.

It is a static page, not an app. No framework, no dependencies, nothing fetched in
the browser, and nothing in the reading path of any book. It has a small inline
script, and the page is complete without it (below).

```
scripts/build.mjs     fetches the registry and the books' catalogs, writes the page
scripts/catalog.mjs   reads the catalogs; derives key words, recent changes, authors
scripts/graph.mjs     lays out the key-word graph at build time
src/styles.css        the palette and type, inlined into the page at build time
src/portal.js         progressive enhancement for the graph and topic filter, inlined
static/_headers       Cloudflare Pages control file (not a URL)
test/                 what the build must not do
public/               GENERATED, git-ignored
```

## How it builds

`npm run build`:

1. Resolves `textbookproject2026-alt/textbook-registry` `main` to a commit SHA with
   `git ls-remote` — not the REST API, because build machines share IPs and the
   unauthenticated limit (60/hour) would fail builds at random. This is the same
   call, for the same reason, as `suggest-edit-function/scripts/bundle-registry.mjs`.
2. Fetches `registry.json` **at that SHA** from `raw.githubusercontent.com`.
3. Writes `public/index.html` and `public/version.txt`.

**Generated at build time, never fetched in the browser.** Same reasoning as every
other registry consumer: a reader's page load must not depend on GitHub being up,
and a registry that can't be read must fail a build rather than empty a live page.

```bash
npm run build      # latest registry main, catalogs from the books' Pages projects
npm run preview    # build from ../textbook-registry/registry.json, for local work
CATALOG_DIR=<dir> npm run preview   # and catalogs from <dir>/<slug>.json, offline
npm test
```

A local preview writes `local` to `version.txt`, so it can never be mistaken for a
real deploy.

## What it lists

`live` and `preview` books that have a `site.domain`, showing title, summary,
maintainer name, the link, and the edition-template preview where there is one.
All of it comes straight from the registry.

- **`live` books come first**, under *The books*, with no badge. That section is
  what the page is for.
- **`preview` books are in their own section**, *Not for readers*, quieter, and
  badged *Preview — a demonstration, not for readers*. A preview book must not read
  as a textbook someone should go and read.
- **`retired` books are never listed.** That is what retirement means
  (`MULTI-BOOK-HOSTING.md` §7), and de-listing is the platform's only real lever
  over a removed book.

This **diverges from `DESIGN.md` §3g**, which lists `live` books only. The
divergence is deliberate and is recorded there.

### The one hard rule

**The build must never fail because one book's entry is odd.** It skips that book,
warns in the build log, and builds the rest. One malformed entry taking down the
platform's front page is a worse failure than one book missing from a list
(`MULTI-BOOK-HOSTING.md` §6b, `PORTAL-CUTOVER.md` §5c). `test/build.test.mjs`
pins this, because the registry is well-formed today and nothing else would catch
a regression.

Two things *do* fail the build, both meaning "the whole file is wrong — keep the
previous page up rather than publish this":

- an unknown `schema_version`, and
- nothing left to list, which would publish an empty page.

A failed Pages build leaves the previous deployment live. That is the point.

## The sections

In page order, each left out when it has nothing to show:

- **The books** — the live books, with page and concept-page counts and the date of the
  latest change, from the catalog.
- **Key words** — a graph of every tag and concept page across the live books. Two words
  are joined when they appear on the same page; a word is larger the more pages it is on.
  A concept "appears" on its own page and every page linking to it; a book's home page
  doesn't count, because it links to everything. Up to 60 words, the most used.
  Coloured by topic: a concept takes its own page's topic, a tag the topic most of its
  pages share. A page's topic is its frontmatter `topic:`, else its first tag (quartz-book
  `topicOf`, in the catalog as `topic`). The eight topics with the most words take the
  eight colour slots (`--kw-topic-0` … `-7` in `styles.css`, the same values as the books'
  graph); any other topic, or none, is "Other". A legend names them.
- **Recently added and changed** — one row per book per day, newest first, up to 8. A
  commit that touches six concept pages is one row, naming three.
- **Browse by author** — each book's `authors` from its catalog (the book's `index.md`
  frontmatter, or its pages'), else the registry's maintainer.
- **Browse by topic** — every key word A–Z, with the pages it appears on. The graph's
  nodes link here.
- **Not for readers** — preview books, as before. They never feed the sections above.
- **Publish your textbook here** — the request form (id `publish`, before *Not for readers*). It
  posts to `/api/request-book` beside `platform.suggest_edit_endpoint`, which files the request in
  the private `book-requests` repo; approval there provisions the book. Needs the inline script to
  send; without it the section shows `PORTAL_CONTACT` (a Pages environment variable), if set.
  Left out if the endpoint can't be derived.

A book with registry `sandbox: true` (a throwaway test) is listed like any other, so a test goes
through the real path, but carries the badge *Test book — will be removed*.

### Where the catalogs come from

Each book on the builder (registry `site.host.builder: "quartz-book"`) publishes
`/.well-known/textbook-catalog.json` at every build (quartz-book README, *The catalog*).
The portal reads it at build time from `https://<site.host.project>.pages.dev/`, not from
`site.domain`, because a book still on Obsidian Publish has its builder output on Pages
only. For such a book the portal links pages at their Publish addresses (spaces as `+`),
so concept links don't 404 before the cutover.

**The hard rule covers catalogs too.** A catalog that is missing, slow, of another
version or another book's costs that book its extras, with a warning in the build log. It
never costs the book its place in the list, and never fails the build.

**Keeping it current.** A book's change reaches the portal at the portal's next build.
`quartz-book`'s `reconcile` fires the portal's deploy hook after a run that deployed a live
branch, when its `PORTAL_DEPLOY_HOOK` secret is set (the same hook URL as
`textbook-registry`'s).

### The script

`src/portal.js` is inlined at build time, like the stylesheet, so the portal is still two
files. Without it the graph is a finished SVG whose every node links to its entry under
*Browse by topic*. With it, hovering or focusing a word lights up its neighbours, a click
opens its pages beside the graph (Escape closes), the graph filters by kind (concepts or
tags), topic, author (a page's `authors`, else its book's, else the maintainer) and book,
all at once, and the topic index filters as you type. The legend's topics are a shortcut to
the topic filter. A filter is only offered when it has a choice to make: the author filter
needs two authors, the book filter two live books. It reads only the page's own DOM.

## `/version.txt`

The portal's equivalent of the function's `X-Registry-Version` header: the registry
SHA this build was made from. `textbook-registry/.github/workflows/portal.yml` polls
it after firing the deploy hook, and goes red on the merge commit if it doesn't
catch up within ten minutes.

`static/_headers` sets `Cache-Control: no-store` on it, or an edge-cached copy would
report the previous build and the check would fail for the wrong reason.

## The apex redirect

`confused4now.org` was book one's address until 20 September 2026. Every chapter
link, citation and bookmark made before then still points at it. With a portal at
the apex those links resolve to a page that exists and looks fine but is not what
was asked for — which is worse than a 404 (`PORTAL-CUTOVER.md` §7b.1).

So the zone carries a **Cloudflare Redirect Rule**: any path on the apex other than
the portal's own two is a 301 to the same path on
`social-research-methods.confused4now.org`. It runs at the edge, before Pages, and
costs nothing to keep.

**This is why the portal is exactly two files.** Every URL the portal serves needs an
exemption in that rule, so the build writes `/` and `/version.txt` and nothing else:
the stylesheet and script are inlined and the favicon is a `data:` URI. *If you ever add a file
to `public/`, add it to the rule*, or the deploy will 301 away and the portal will
look broken in a way the build log won't explain.

`/robots.txt` is not exempt: it 301s to the book's. That is a deliberate, small
trade for keeping the exemption list at two. Add a third if it ever matters.

## What has to be configured by hand

Nothing here creates infrastructure. These are the pieces this repo expects:

| Where | What | Why |
|---|---|---|
| Cloudflare Pages | A project built from this repo. Build command `npm run build`, output `public`, `NODE_VERSION=22` | Builds and hosts the page |
| Cloudflare Pages | A **deploy hook** on the production branch | The registry fires it on merge |
| `textbook-registry` | Repository secret `PORTAL_DEPLOY_HOOK` = that hook's URL | `portal.yml` can't deploy without it, and says so |
| `textbook-registry` | Repository variable `PORTAL_VERSION_URL` — **optional, temporary** | Point it at the `*.pages.dev` address while setting up, so `portal.yml` is green before the apex is bound. Delete it afterwards: polling the apex is what proves a reader can see the change |
| Cloudflare DNS | The apex record repointed from `publish-main.obsidian.md` to the Pages project | The apex still holds book one's old Publish record |
| Cloudflare Rules | The redirect rule above | Old chapter links |

The full ordered procedure is in `PORTAL-CUTOVER.md` §6 alongside the rest of the
cutover.

## What it does not do yet

`MULTI-BOOK-HOSTING.md` §2c and §5d also have the portal showing probe-observed
health and serving the parked page for dark books. Neither the probe nor
`health.json` exists, and no book is declared dark, so there is nothing to show.
Keep v1 to the registry alone — a listing page that exists is worth more than a
health dashboard that doesn't (`PORTAL-CUTOVER.md` §5d).
