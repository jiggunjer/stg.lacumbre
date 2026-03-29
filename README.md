# La Cumbre del Sol site

Hugo-based multilingual website for Villa La Cumbre del Sol.

## CMS Administration

The gallery is managed through Sveltia CMS at `/admin/`.

### What CMS users can edit

- Gallery assets list in `data/gallery.json`
- Item ordering via the `order` field
- Optional `alt_en` and `alt_nl` text fields

The CMS intentionally does **not** expose translatable page text/content files, to avoid desynchronizing multilingual content.

### Files added for CMS

- `content/admin/_index.md` - Hugo route for `/admin/`
- `layouts/_default/admin.html` - Hugo-rendered Sveltia CMS entry page
- `static/admin/config.yml` - Sveltia CMS config
- `api/` - Cloudflare Worker API (CMS **authentication**: Google + allowlist; **authorization**: GitHub PAT to Sveltia today, possibly more services later)

### OAuth architecture

The CMS writes to the GitHub backend, but sign-in identity comes from Google:

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

Create a fine-grained GitHub personal access token for the target repo (`jiggunjer/lacumbre`) with at least:

- Repository access: only this repository
- Permission: `Contents` read/write

Set it as Worker secret/var:

- `GITHUB_PAT`

### Allowed admin accounts (whitelist)

Set the allowed Google accounts in Worker env var:

- `ALLOWED_EMAILS=admin@example.com,backup@example.com`

Any authenticated Google account not listed is denied. Comma delimited string.
This may be redundant as on the Google oath side it is deployed as Testing, not Public, which means whitelisted emails on a per Gcloud Project basis.

### Cloudflare Worker deploy

From `api/`:

1. Install dependencies:
  - `npm install`
2. Configure secrets:
  - `wrangler secret put GOOGLE_CLIENT_SECRET`
  - `wrangler secret put GITHUB_PAT`
3. Configure non-secret vars (via dashboard or `wrangler.toml` vars):
  - `GOOGLE_CLIENT_ID`
  - `ALLOWED_EMAILS`
4. Deploy:
  - `npm run deploy`

Then update `static/admin/config.yml`:

- `backend.base_url: https://<your-worker-domain>`
### OAuth and Worker setup

The production Worker setup (Google OAuth, GitHub PAT, deploy URL, env vars) is documented in:

- `api/README.md`

Use that recipe to configure `backend.base_url` in `static/admin/config.yml`.
### OAuth and Worker setup

The production auth proxy flow (Google OAuth, GitHub PAT, Worker deploy, and security checklist) is documented in:

- `oauth-proxy/README.md`

Use that recipe to configure `backend.base_url` in `static/admin/config.yml`.

### Local debug mode

For local testing, the CMS supports a Hugo-controlled debug mode that bypasses OAuth and external media storage.

Run Hugo with:

- `HUGO_LACUMBRE_CMS_DEBUG=1 hugo server --buildDrafts`

Optional overrides:

- `HUGO_LACUMBRE_CMS_LOCAL_BRANCH=cms-local-test`
- `HUGO_LACUMBRE_CMS_LOCAL_MEDIA_FOLDER=/static/cms-media-local`
- `HUGO_LACUMBRE_CMS_LOCAL_PUBLIC_FOLDER=/cms-media-local`

What debug mode changes:

- Skips OAuth entirely
- Does not use the Cloudflare Worker
- Does not use R2
- Uses Sveltia's local repository workflow instead of remote GitHub API auth
- Labels the backend branch as a local test branch (`cms-local-test` by default)
- Writes uploaded media into the local repo folder `static/cms-media-local/`

Local workflow notes:

1. Start the site with `HUGO_LACUMBRE_CMS_DEBUG=1 hugo server --buildDrafts`
2. Open `http://localhost:1313/admin/index.html`
3. Use a Chromium-based browser
4. In Sveltia, choose `Work with Local Repository` and select the repository root
5. Edit gallery data and upload local test images
6. Preview the site locally, then commit or discard changes manually with Git

Important:

- Local mode is intended for development only
- Uploaded local test assets are ignored by git under `static/cms-media-local/`
- Sveltia local workflow currently depends on the browser File System Access API, so Firefox and Safari are not suitable for this workflow

### Cloudflare R2 setup (media uploads)

In `static/admin/config.yml`, configure `media_libraries.cloudflare_r2` with:

- `bucket`
- `account_id`
- `access_key_id`
- `public_url` (custom domain recommended)
- optional `prefix`

Also configure R2 CORS to allow your CMS origin and required methods (`GET`, `PUT`, `HEAD`).

Note: deleting a gallery item from CMS removes only its JSON reference. It does **not** delete the object from R2.

### Portability notes (avoid Cloudflare lock-in)

The setup is intentionally split so you can replace providers:

- Auth proxy can run on Cloudflare Workers, Netlify Functions, or self-hosted Node.
- Media provider can switch from R2 to S3/Cloudinary/Uploadcare by editing `static/admin/config.yml` only.
- Hugo and GitHub Actions deployment remain unchanged.

