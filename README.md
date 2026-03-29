# La Cumbre del Sol site

Hugo-based multilingual website for Villa La Cumbre del Sol.

## CMS Administration

The gallery and YouTube list are managed through Sveltia CMS at `/admin/`. **Image files** are uploaded via the **R2 Asset Manager** on the Cloudflare Worker (same host as `backend.base_url`), not through Sveltia’s git media folder.

### What CMS users can edit

- Gallery image list in `data/gallery.json` (paste **public R2 URLs** into each item’s image field)
- YouTube entries in `data/videos.json` (URLs and titles; videos render in a separate section on the gallery page)
- Item ordering via the `order` field
- `alt_en` and `alt_nl` on gallery images

The CMS intentionally does **not** expose translatable page text/content files, to avoid desynchronizing multilingual content.

### Files added for CMS

- `content/admin/_index.md` — Hugo route for `/admin/`
- `layouts/_default/admin.html` — Sveltia entry page (includes **Manage Assets (R2)** link when `cmsWorkerBaseURL` is set)
- `static/admin/config.yml` — Sveltia CMS config
- `data/videos.json` — YouTube list for the gallery page
- `api/` — Cloudflare Worker: Google + allowlist auth, GitHub PAT for Sveltia, **R2 asset manager + API**

### R2 Asset Manager (Worker)

1. Open `/admin/` and click **Manage Assets (R2)** (or go to `https://<worker>/assets`).
2. Sign in with Google (same allowlist as CMS).
3. Upload, list, copy public URL, or delete objects in R2. **Deleting in R2 does not change `gallery.json`** — URLs stay until you edit them in Sveltia.
4. In Sveltia, paste the copied URL into the gallery image field (`choose_url: true`).

R2 access uses a **native Worker R2 binding** (no S3 secret in the browser). Configure `R2_PUBLIC_URL`, `R2_PREFIX`, `CMS_SITE_URL`, and the bucket in [`api/wrangler.toml`](api/wrangler.toml). Set `SESSION_SECRET` for signed session cookies:

```bash
cd api && npx wrangler secret put SESSION_SECRET
```

Keep `hugo.toml` **`params.cmsWorkerBaseURL`** in sync with `static/admin/config.yml` **`backend.base_url`** (used for the asset manager link).

### OAuth architecture (Sveltia / GitHub)

The CMS uses the GitHub backend, but sign-in identity comes from Google:

1. User clicks Sign In on `/admin/`
2. CMS opens OAuth proxy (`backend.base_url`)
3. Proxy authenticates with Google OAuth
4. Proxy validates that the authenticated email is in `ALLOWED_EMAILS`
5. Proxy returns a GitHub token payload back to Sveltia
6. Sveltia commits changes to this repository

This keeps non-technical admins on Google accounts while preserving Git-backed content updates.

### Google OAuth setup

1. Create an OAuth 2.0 Web Application in Google Cloud Console.
2. Add an authorized redirect URI:
   - `https://<your-worker-domain>/callback`
3. Save the generated:
   - Client ID
   - Client secret

Set these in Worker secrets/vars:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

### GitHub token setup

Create a fine-grained GitHub personal access token for the target repo with at least:

- Repository access: only this repository
- Permission: `Contents` read/write

Set it as Worker secret:

- `GITHUB_PAT`

### Allowed admin accounts (whitelist)

Set the allowed Google accounts in Worker env var:

- `ALLOWED_EMAILS=admin@example.com,backup@example.com`

Any authenticated Google account not listed is denied. Comma delimited string.
This may be redundant if Google OAuth is in Testing mode with its own allowlist.

### Cloudflare Worker deploy

From `oauth-proxy/`:

1. Install dependencies:
   - `npm install`
2. Configure secrets:
   - `wrangler secret put GOOGLE_CLIENT_SECRET`
   - `wrangler secret put GITHUB_PAT`
   - `wrangler secret put SESSION_SECRET`
3. Configure non-secret vars (via dashboard or `wrangler.toml` `[vars]`):
   - `GOOGLE_CLIENT_ID`
   - `ALLOWED_EMAILS`
   - `R2_PUBLIC_URL`, `R2_PREFIX`, `CMS_SITE_URL` (and verify `[[r2_buckets]]` bucket name)
4. Deploy:
   - `npm run deploy`

Then align:

- `static/admin/config.yml` → `backend.base_url: https://<your-worker-domain>`
- `hugo.toml` → `params.cmsWorkerBaseURL` (same origin, no path)

Full Worker endpoint list: [`api/README.md`](api/README.md).

### Local debug mode

For local testing, the CMS supports a Hugo-controlled debug mode that bypasses OAuth and the production Worker.

Run Hugo with:

- `HUGO_LACUMBRE_CMS_DEBUG=1 hugo server --buildDrafts`

Optional overrides:

- `HUGO_LACUMBRE_CMS_LOCAL_BRANCH=cms-local-test`
- `HUGO_LACUMBRE_CMS_LOCAL_MEDIA_FOLDER=/static/cms-media-local`
- `HUGO_LACUMBRE_CMS_LOCAL_PUBLIC_FOLDER=/cms-media-local`

What debug mode changes:

- Skips OAuth entirely
- Does not use the Cloudflare Worker (no R2 asset manager on Worker; use pasted URLs or local folder)
- Uses Sveltia’s local repository workflow instead of remote GitHub API auth
- Labels the backend branch as a local test branch (`cms-local-test` by default)
- Optional local test uploads under `static/cms-media-local/` (gitignored)

Local workflow notes:

1. Start the site with `HUGO_LACUMBRE_CMS_DEBUG=1 hugo server --buildDrafts`
2. Open `http://localhost:1313/admin/index.html`
3. Use a Chromium-based browser
4. In Sveltia, choose `Work with Local Repository` and select the repository root
5. Edit gallery / videos data
6. Preview the site locally, then commit or discard changes manually with Git

Important:

- Local mode is intended for development only
- Uploaded local test assets are ignored by git under `static/cms-media-local/`
- Sveltia local workflow depends on the File System Access API; Firefox and Safari are not suitable

### Production media workflow (no R2 keys in the browser)

- Sveltia `media_folder` points at `static/cms-media-local` (gitignored) so accidental git uploads are not deployed.
- **Do not** rely on Sveltia for production image uploads; use **Manage Assets (R2)** and paste URLs.

### YouTube videos

- Edit **Videos** in Sveltia (`data/videos.json`).
- Supported URL shapes include `youtube.com/watch?v=…`, `youtu.be/…`, and `youtube.com/embed/…`.
- The gallery page shows a **Videos** section below the photo grid (youtube-nocookie embeds).

### R2 sanity-check script (CLI / S3 API)

The Worker does not need S3 credentials. To probe the bucket from your machine (list/upload/delete test object), use AWS CLI with R2 S3 API credentials:

```bash
export R2_ACCOUNT_ID=…
export R2_ACCESS_KEY_ID=…
export R2_SECRET_ACCESS_KEY=…   # prompted if omitted by some flows
./api/scripts/check-r2.sh
```

The script reads **bucket name**, **prefix**, and **public URL** from [`api/wrangler.toml`](api/wrangler.toml) (and optional legacy keys in `static/admin/config.yml`). See script header for env overrides.

### Portability notes (avoid Cloudflare lock-in)

The setup is intentionally split so you can replace providers:

- Auth proxy can run on Cloudflare Workers, Netlify Functions, or self-hosted Node.
- R2 asset API can be reimplemented against S3 or another object store if you change the Worker.
- Hugo and GitHub Actions deployment remain unchanged.
