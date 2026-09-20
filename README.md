# textbook-portal

The platform portal: one static page at `confused4now.org` listing the textbooks
this platform publishes, generated from the registry.

It is a listing page, not an app. No framework, no dependencies, no JavaScript on
the page, and nothing in the reading path of any book.

```
scripts/build.mjs   fetches the registry and writes the page
src/styles.css      the palette and type, inlined into the page at build time
static/_headers     Cloudflare Pages control file (not a URL)
test/               what the build must not do
public/             GENERATED, git-ignored
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
npm run build      # latest registry main
npm run preview    # build from ../textbook-registry/registry.json, for local work
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
the stylesheet is inlined and the favicon is a `data:` URI. *If you ever add a file
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
