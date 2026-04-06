# AGENTS.md

## Cursor Cloud specific instructions

This is a Hugo static site with a Cloudflare Workers API sub-project (`api/`). No databases, Docker, or background services are required.

### Services

| Service | Command | Notes |
|---|---|---|
| **Hugo dev server** | `hugo server` | Main site; serves at `http://localhost:1313/`. Default language is Dutch (`/nl/`). |
| **API worker** (optional) | `cd api && npm run dev` | Cloudflare Worker OAuth proxy. Requires `.dev.vars` with secrets—skip unless working on CMS auth. |

### Key commands

- **Build**: `hugo --minify`
- **Dev server**: `hugo server` (add `--buildDrafts` to include draft content)
- **TypeScript check** (API): `cd api && npm run check`
- **CMS debug mode**: `HUGO_LACUMBRE_CMS_DEBUG=1 hugo server --buildDrafts` then visit `/admin/index.html`

### Gotchas

- Hugo v0.157.0 extended is required. The `hugo` binary is installed system-wide from the GitHub `.deb` release.
- The site's `baseURL` in `hugo.toml` points to `https://stg.lacumbre-villa.casa/`. `hugo server` overrides this automatically for local dev.
- The default content language is Dutch (`nl`); browsing `http://localhost:1313/` redirects to `/nl/`.
- The `api/` sub-project uses `npm` (has `package-lock.json`). Do not use pnpm/yarn there.
- There are no lint or test commands beyond `tsc --noEmit` (`npm run check`) in `api/`. Hugo itself has no linting configuration.
- CMS local debug mode requires a Chromium-based browser (File System Access API).
