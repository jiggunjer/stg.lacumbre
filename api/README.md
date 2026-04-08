# La Cumbre API (Cloudflare Worker)

This folder is a **Cloudflare Worker** for the Hugo site. It handles:

1. **CMS authentication** — Google sign-in plus email allowlist (`ALLOWED_EMAILS`).
2. **CMS authorization** — After Google succeeds, the worker issues the **GitHub PAT** to Sveltia (postMessage) so the GitHub backend can commit.
3. **R2 asset manager** — Google session cookie + R2 binding: list/upload/delete objects and copy public URLs (no S3 secret in the browser).

## Endpoints

| Path | Role |
|------|------|
| `/auth` | Starts Google OAuth. Default: Sveltia flow (`provider=github`, optional `origin`). Use **`?mode=assets`** for the R2 Asset Manager (redirect + session cookie). |
| `/callback` | Finishes Google OAuth; allowlist check. **CMS:** HTML postMessage with GitHub PAT. **Assets:** sets `lacumbre_assets_session`, redirects to `/assets`. |
| `/assets` | R2 Asset Manager UI (HTML). Unauthenticated users see a sign-in link to `/auth?mode=assets`. |
| `GET /r2/list` | JSON list of objects under `R2_PREFIX` (requires session). |
| `POST /r2/upload` | Multipart field `file` (requires session). |
| `DELETE /r2/delete?key=…` | Delete one object; key must start with `R2_PREFIX` (requires session). |
| `/` | Health-style `200 OK` |

## Deployed URL

The worker name is set in [`wrangler.toml`](./wrangler.toml) (`name = "stg-api"`). The production URL must match **`static/admin/config.yml`** `backend.base_url` and **`hugo.toml`** `params.cmsWorkerBaseURL`.

Google OAuth **Authorized redirect URI**:

```text
https://<your-worker-host>/callback
```

## First-time setup

From the `api/` directory:

1. **Dependencies & login**
   ```bash
   npm install
   npx wrangler login
   ```

2. **Edit `wrangler.toml`** — `[vars]`: `GOOGLE_CLIENT_ID`, `ALLOWED_EMAILS`, `R2_PUBLIC_URL`, `R2_PREFIX`, `CMS_SITE_URL`; confirm `[[r2_buckets]]` `bucket_name`.

3. **Secrets**
   ```bash
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put GITHUB_PAT
   npx wrangler secret put SESSION_SECRET
   ```

4. **Deploy**
   ```bash
   npm run deploy
   ```

   For explicit staging environment config (same worker + bucket bindings):
   ```bash
   npm run deploy:staging
   ```

5. **Google Cloud Console** — add redirect URI `https://<worker>/callback`.

## Local development

```bash
cd api
npm run dev
```

Create **`.dev.vars`** (gitignored), e.g.:

```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GITHUB_PAT=...
ALLOWED_EMAILS=you@example.com
SESSION_SECRET=dev-only-random-string-at-least-32-chars
```

Wrangler will use the R2 bucket binding; for remote bucket access during `wrangler dev`, configure as in Cloudflare docs.

## Minimal GitHub PAT scope

Fine-grained PAT for the content repo:

- Repository access: target repo only  
- Permission: **Contents** read/write

## TypeScript check

```bash
npm run check
```

## R2 / media

- **Browser:** no R2 API keys; editors use **Manage Assets** on the worker, then paste URLs into Sveltia.
- **Worker:** uses **`R2_BUCKET`** binding (see `wrangler.toml`).
- Deleting an object in the asset manager **does not** edit `data/gallery.json`.

## Portability

The worker can be replaced with another host; keep `backend.base_url`, Google redirect URIs, and session/R2 behavior aligned with the Hugo admin page and CMS config.
