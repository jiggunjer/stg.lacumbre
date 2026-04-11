interface Env {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GITHUB_PAT: string;
  ALLOWED_EMAILS: string;
  SESSION_SECRET: string;
  R2_BUCKET: R2Bucket;
  R2_PUBLIC_URL: string;
  R2_PREFIX: string;
  CMS_SITE_URL: string;
}

type TokenResponse = {
  access_token?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
};

type TokenInfoResponse = {
  email?: string;
  email_verified?: string;
};

type SessionPayload = {
  e: string;
  exp: number;
};

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_TOKEN_INFO_ENDPOINT = "https://oauth2.googleapis.com/tokeninfo";

const SESSION_COOKIE = "lacumbre_assets_session";
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days
const OAUTH_MODE_COOKIE = "oauth_mode";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname.replace(/\/$/, "") || "/";

      if (pathname === "/auth") {
        return handleAuth(request, env);
      }

      if (pathname === "/callback") {
        return handleCallback(request, env);
      }

      if (pathname === "/assets") {
        return handleAssetsPage(request, env);
      }

      if (pathname === "/r2/list" && request.method === "GET") {
        return handleR2List(request, env);
      }

      if (pathname === "/r2/upload" && request.method === "POST") {
        return handleR2Upload(request, env);
      }

      if (pathname === "/r2/delete" && request.method === "DELETE") {
        return handleR2Delete(request, env);
      }

      return new Response("OK", { status: 200 });
    } catch (error) {
      return new Response(`Unhandled error: ${String(error)}`, { status: 500 });
    }
  },
};

function handleAuth(request: Request, env: Env): Response {
  ensureGoogleEnv(env);

  const reqUrl = new URL(request.url);
  const mode = reqUrl.searchParams.get("mode") === "assets" ? "assets" : "cms";

  if (mode === "cms") {
    const provider = reqUrl.searchParams.get("provider") || "github";
    if (provider !== "github") {
      return new Response("Unsupported provider", { status: 400 });
    }
  }

  const state = randomHex(32);
  const cmsOrigin = mode === "cms" ? sanitizeOrigin(reqUrl.searchParams.get("origin")) : "";
  const redirectUri = `${reqUrl.origin}/callback`;

  const authUrl = new URL(GOOGLE_AUTH_ENDPOINT);
  authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("prompt", "select_account");
  authUrl.searchParams.set("state", state);

  const headers = new Headers({
    Location: authUrl.toString(),
    "Cache-Control": "no-store",
  });

  headers.append("Set-Cookie", createCookie("oauth_state", state, 600));
  headers.append("Set-Cookie", createCookie(OAUTH_MODE_COOKIE, mode, 600));
  if (cmsOrigin) {
    headers.append("Set-Cookie", createCookie("oauth_origin", cmsOrigin, 600));
  }

  return new Response(null, { status: 302, headers });
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
  ensureGoogleEnv(env);

  const reqUrl = new URL(request.url);
  const code = reqUrl.searchParams.get("code");
  const state = reqUrl.searchParams.get("state");

  const cookies = parseCookies(request.headers.get("Cookie"));
  if (!code || !state || cookies.oauth_state !== state) {
    return renderFailure("Invalid or expired OAuth session.");
  }

  const oauthMode = cookies.oauth_mode === "assets" ? "assets" : "cms";

  const tokenRes = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${reqUrl.origin}/callback`,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    return renderFailure(`Google token exchange failed (${tokenRes.status}).`);
  }

  const tokenData = (await tokenRes.json()) as TokenResponse;
  if (!tokenData.id_token) {
    return renderFailure(tokenData.error_description || "Missing Google ID token.");
  }

  const tokenInfoUrl = new URL(GOOGLE_TOKEN_INFO_ENDPOINT);
  tokenInfoUrl.searchParams.set("id_token", tokenData.id_token);

  const tokenInfoRes = await fetch(tokenInfoUrl);
  if (!tokenInfoRes.ok) {
    return renderFailure(`Unable to verify Google identity (${tokenInfoRes.status}).`);
  }

  const tokenInfo = (await tokenInfoRes.json()) as TokenInfoResponse;
  const email = (tokenInfo.email || "").trim().toLowerCase();
  const emailVerified = tokenInfo.email_verified === "true";

  if (!email || !emailVerified) {
    return renderFailure("Your Google account email is not verified.");
  }

  const allowedEmails = parseAllowedEmails(env.ALLOWED_EMAILS);
  if (!allowedEmails.has(email)) {
    return renderFailure("This Google account is not permitted to access the CMS.");
  }

  const headers = new Headers({
    "Cache-Control": "no-store",
  });
  headers.append("Set-Cookie", clearCookie("oauth_state"));
  headers.append("Set-Cookie", clearCookie(OAUTH_MODE_COOKIE));

  if (oauthMode === "assets") {
    if (!env.SESSION_SECRET || !env.SESSION_SECRET.trim()) {
      return renderFailure("Server misconfiguration: SESSION_SECRET is not set.");
    }
    const sessionToken = await createSessionToken(email, env.SESSION_SECRET, SESSION_MAX_AGE_SECONDS);
    headers.append("Set-Cookie", createCookie(SESSION_COOKIE, sessionToken, SESSION_MAX_AGE_SECONDS));
    if (cookies.oauth_origin) {
      headers.append("Set-Cookie", clearCookie("oauth_origin"));
    }
    headers.set("Location", `${reqUrl.origin}/assets`);
    headers.set("Content-Type", "text/plain");
    return new Response(null, { status: 302, headers });
  }

  if (!env.GITHUB_PAT || !env.GITHUB_PAT.trim()) {
    return renderFailure("Server misconfiguration: GITHUB_PAT is not set.");
  }

  if (env.SESSION_SECRET && env.SESSION_SECRET.trim()) {
    const sessionToken = await createSessionToken(email, env.SESSION_SECRET, SESSION_MAX_AGE_SECONDS);
    headers.append("Set-Cookie", createCookie(SESSION_COOKIE, sessionToken, SESSION_MAX_AGE_SECONDS));
  }

  const payload = {
    token: env.GITHUB_PAT,
    provider: "github",
  };

  const cmsOrigin = cookies.oauth_origin || "";
  headers.append("Set-Cookie", clearCookie("oauth_origin"));
  headers.set("Content-Type", "text/html; charset=utf-8");

  return new Response(renderSuccessHtml(payload, cmsOrigin), {
    status: 200,
    headers,
  });
}

async function handleAssetsPage(request: Request, env: Env): Promise<Response> {
  const cookies = parseCookies(request.headers.get("Cookie"));
  const token = cookies[SESSION_COOKIE];
  const email = token ? await verifySessionToken(token, env.SESSION_SECRET) : null;

  const reqUrl = new URL(request.url);
  const openedFromCms = reqUrl.searchParams.get("opener") === "cms";

  if (!email) {
    const loginUrl = `${reqUrl.origin}/auth?mode=assets`;
    return new Response(renderLoginHtml(loginUrl), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  return new Response(renderAssetManagerHtml(env, openedFromCms), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function handleR2List(request: Request, env: Env): Promise<Response> {
  const unauthorized = await requireAssetSession(request, env);
  if (unauthorized) return unauthorized;

  const prefix = normalizePrefix(env.R2_PREFIX || "cms-uploads/");
  const listed: Array<{ key: string; size: number; uploaded: string | null; publicUrl: string }> = [];
  let cursor: string | undefined;
  const publicBase = normalizePublicBase(env.R2_PUBLIC_URL);

  do {
    const page = await env.R2_BUCKET.list({ prefix, cursor });
    for (const obj of page.objects) {
      listed.push({
        key: obj.key,
        size: obj.size,
        uploaded: obj.uploaded ? obj.uploaded.toISOString() : null,
        publicUrl: publicBase ? `${publicBase}/${obj.key}` : "",
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return jsonResponse({ objects: listed });
}

async function handleR2Upload(request: Request, env: Env): Promise<Response> {
  const unauthorized = await requireAssetSession(request, env);
  if (unauthorized) return unauthorized;

  const prefix = normalizePrefix(env.R2_PREFIX || "cms-uploads/");
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse({ error: "Invalid multipart body" }, 400);
  }

  const entry = formData.get("file");
  if (
    typeof entry !== "object" ||
    entry === null ||
    !("stream" in entry) ||
    typeof (entry as { stream?: unknown }).stream !== "function"
  ) {
    return jsonResponse({ error: "Missing or empty file field" }, 400);
  }
  const file = entry as File;
  if (!file.size) {
    return jsonResponse({ error: "Missing or empty file field" }, 400);
  }

  const safeName = sanitizeFileName(file.name);
  const unique = `${Date.now()}-${randomHex(8)}-${safeName}`;
  const key = `${prefix}${unique}`;

  await env.R2_BUCKET.put(key, file.stream(), {
    httpMetadata: {
      contentType: file.type || "application/octet-stream",
    },
  });

  const publicBase = normalizePublicBase(env.R2_PUBLIC_URL);
  const publicUrl = publicBase ? `${publicBase}/${key}` : "";

  return jsonResponse({ key, publicUrl });
}

async function handleR2Delete(request: Request, env: Env): Promise<Response> {
  const unauthorized = await requireAssetSession(request, env);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!key) {
    return jsonResponse({ error: "Missing key" }, 400);
  }

  const prefix = normalizePrefix(env.R2_PREFIX || "cms-uploads/");
  if (!key.startsWith(prefix) || key.includes("..")) {
    return jsonResponse({ error: "Invalid key" }, 400);
  }

  await env.R2_BUCKET.delete(key);
  return new Response(null, { status: 204 });
}

async function requireAssetSession(request: Request, env: Env): Promise<Response | null> {
  if (!env.SESSION_SECRET || !env.SESSION_SECRET.trim()) {
    return jsonResponse({ error: "SESSION_SECRET not configured" }, 500);
  }
  const cookies = parseCookies(request.headers.get("Cookie"));
  const token = cookies[SESSION_COOKIE];
  const email = token ? await verifySessionToken(token, env.SESSION_SECRET) : null;
  if (!email) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  return null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function normalizePrefix(prefix: string): string {
  const p = prefix.trim() || "cms-uploads/";
  return p.endsWith("/") ? p : `${p}/`;
}

function normalizePublicBase(value: string | undefined): string {
  const raw = (value || "").trim();
  if (!raw) {
    return "";
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    return raw.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function sanitizeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() || "upload";
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200) || "file";
}

const encoder = new TextEncoder();

async function createSessionToken(email: string, secret: string, maxAgeSeconds: number): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + maxAgeSeconds;
  const payload: SessionPayload = { e: email, exp };
  const message = JSON.stringify(payload);
  const sig = await hmacHex(message, secret);
  const payloadB64 = base64UrlEncode(message);
  return `${payloadB64}.${sig}`;
}

async function verifySessionToken(token: string, secret: string): Promise<string | null> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let message: string;
  try {
    message = base64UrlDecode(payloadB64);
  } catch {
    return null;
  }
  const expected = await hmacHex(message, secret);
  if (!timingSafeEqualHex(sig, expected)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(message) as SessionPayload;
  } catch {
    return null;
  }
  if (!payload.e || typeof payload.exp !== "number") return null;
  if (Math.floor(Date.now() / 1000) > payload.exp) return null;
  return payload.e;
}

async function hmacHex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return bytesToHex(new Uint8Array(sig));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
}

function base64UrlEncode(str: string): string {
  const b64 = btoa(str);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(str: string): string {
  let padded = str.replace(/-/g, "+").replace(/_/g, "/");
  while (padded.length % 4) padded += "=";
  return atob(padded);
}

function renderLoginHtml(loginUrl: string): string {
  const safeUrl = escapeHtml(loginUrl);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Media Library</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
        font-family: system-ui, sans-serif; background: #0f1419; color: #e6edf3; }
      .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 2rem; max-width: 28rem; text-align: center; }
      h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
      p { color: #8b949e; font-size: 0.9rem; margin: 0 0 1.5rem; }
      a.btn { display: inline-block; background: #238636; color: #fff; text-decoration: none; padding: 0.65rem 1.25rem;
        border-radius: 8px; font-weight: 600; }
      a.btn:hover { background: #2ea043; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Media Library</h1>
      <p>Sign in with your approved Google account to upload and manage photos, videos, and documents.</p>
      <a class="btn" href="${safeUrl}">Sign in with Google</a>
    </div>
  </body>
</html>`;
}

function renderAssetManagerHtml(env: Env, openedFromCms: boolean): string {
  const cmsUrl = escapeHtml(`${(env.CMS_SITE_URL || "").replace(/\/$/, "")}/admin/`);
  const cmsOrigin = escapeHtml((env.CMS_SITE_URL || "").replace(/\/$/, ""));
  const hasOpener = openedFromCms;
  const mediaFolder = normalizePrefix(env.R2_PREFIX || "cms-uploads/");
  const safeMediaFolder = escapeHtml(mediaFolder);
  const publicBase = normalizePublicBase(env.R2_PUBLIC_URL);
  const hasPublicBase = Boolean(publicBase);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Media Library</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #0d1117; color: #e6edf3; min-height: 100vh; padding-bottom: 5rem; }
      header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.75rem;
        padding: 1rem 1.25rem; border-bottom: 1px solid #30363d; background: #161b22; position: sticky; top: 0; z-index: 10; }
      header h1 { font-size: 1.1rem; margin: 0; font-weight: 600; }
      header p { margin: 0; color: #8b949e; font-size: 0.9rem; max-width: 34rem; }
      main { padding: 1rem 1.25rem 2rem; }
      .header-right { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
      a { color: #58a6ff; text-decoration: none; }
      a:hover { text-decoration: underline; }
      .dropzone {
        margin: 0 0 1rem; padding: 2rem; border: 2px dashed #30363d; border-radius: 12px; text-align: center;
        color: #8b949e; background: #161b22; cursor: pointer; transition: border-color .2s, background .2s;
        touch-action: manipulation; scroll-margin-top: 6rem; outline: none;
      }
      .dropzone.dragover { border-color: #58a6ff; background: #0d1117; }
      .dropzone:focus-visible { border-color: #58a6ff; box-shadow: 0 0 0 3px #1f6feb33; }
      .dropzone .title { display: block; color: #e6edf3; font-weight: 600; font-size: 1rem; margin-bottom: 0.45rem; }
      .dropzone .note { display: block; margin-top: 0.65rem; color: #c9d1d9; font-size: 0.8rem; }
      .info { margin: 0 0 1rem; font-size: 0.875rem; color: #8b949e; }
      .info.warn { color: #d29922; }
      .info code, .dropzone .note code { color: #c9d1d9; background: #0d1117; padding: 0.08rem 0.38rem; border-radius: 999px; }
      #status { margin: 0 0 1rem; font-size: 0.875rem; color: #8b949e; min-height: 1.25rem; }
      #status.err { color: #f85149; }
      #status.ok { color: #3fb950; }
      .grid {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem;
        padding: 0;
      }
      .card {
        background: #161b22; border: 1px solid #30363d; border-radius: 10px; overflow: hidden;
        display: flex; flex-direction: column; position: relative;
      }
      .card.selected { border-color: #1f6feb; box-shadow: 0 0 0 2px #1f6feb44; }
      .card .check-overlay {
        position: absolute; top: 8px; right: 8px; width: 24px; height: 24px; border-radius: 50%;
        background: #1f6feb; color: #fff; display: none; align-items: center; justify-content: center;
        font-size: 14px; font-weight: 700; z-index: 2; pointer-events: none;
      }
      .card.selected .check-overlay { display: flex; }
      .thumb-wrap {
        aspect-ratio: 4/3; background: #21262d; display: flex; align-items: center; justify-content: center;
        overflow: hidden; cursor: ${hasOpener ? "pointer" : "default"};
      }
      .thumb-wrap img { max-width: 100%; max-height: 100%; object-fit: contain; }
      .thumb-wrap .placeholder { color: #8b949e; font-size: 0.75rem; padding: 0.5rem; text-align: center; word-break: break-all; }
      .meta { padding: 0.65rem; font-size: 0.75rem; color: #8b949e; flex: 1; }
      .meta .name { word-break: break-all; color: #c9d1d9; font-size: 0.82rem; margin-bottom: 0.35rem; font-weight: 600; }
      .meta .key { word-break: break-all; color: #8b949e; font-size: 0.7rem; margin-bottom: 0.35rem; }
      .meta .size { color: #8b949e; }
      .actions { display: flex; gap: 0.35rem; padding: 0 0.65rem 0.65rem; flex-wrap: wrap; }
      button {
        font: inherit; cursor: pointer; border: none; border-radius: 6px; padding: 0.35rem 0.6rem; font-size: 0.75rem;
        background: #21262d; color: #e6edf3; border: 1px solid #30363d;
      }
      button:hover { background: #30363d; }
      button:disabled { opacity: 0.45; cursor: not-allowed; }
      button:disabled:hover { background: #21262d; }
      button.danger { color: #f85149; border-color: #f8514966; }
      button.danger:hover { background: #f8514922; }
      button.primary { background: #238636; border-color: #238636; color: #fff; }
      button.primary:hover { background: #2ea043; }
      button.cms-use { background: #1f6feb; border-color: #1f6feb; color: #fff; }
      button.cms-use:hover { background: #388bfd; }
      button.cms-use:disabled { opacity: 0.4; cursor: not-allowed; }
      .empty { padding: 2rem; text-align: center; color: #8b949e; }
      #selectionBar {
        display: none; position: sticky; bottom: 0; z-index: 10; background: #161b22;
        border-top: 1px solid #30363d; padding: 0.75rem 1.25rem;
        align-items: center; justify-content: space-between; gap: 0.75rem;
      }
      #selectionBar.visible { display: flex; }
      #selectionBar .sel-info { font-size: 0.85rem; color: #8b949e; }
      #selectionBar .sel-actions { display: flex; gap: 0.5rem; }
      @media (max-width: 640px) {
        header { align-items: flex-start; }
        main { padding: 0.85rem 1rem 1.5rem; }
        .dropzone { padding: 1.35rem; }
        #selectionBar { padding: 0.75rem 1rem; flex-direction: column; align-items: stretch; }
        #selectionBar .sel-actions { width: 100%; }
        #selectionBar .sel-actions button { flex: 1; }
      }
    </style>
  </head>
  <body>
    <header>
      <div>
        <h1>Media Library</h1>
        <p>Upload files here, then paste the link into the gallery editor.</p>
      </div>
      <div class="header-right">
        <a href="${cmsUrl}" target="_blank" rel="noopener">Back to gallery editor</a>
      </div>
    </header>
    <main>
      <input type="file" id="fileInput" accept="image/*,video/*,.pdf" multiple hidden>
      <div class="dropzone" id="dropzone" role="button" tabindex="0" aria-describedby="folderNote">
        <span class="title">Add files</span>
        <span>Tap to choose photos and videos, or drag files here.</span>
        <span class="note">Showing files from <code>${safeMediaFolder}</code></span>
      </div>
      ${hasPublicBase ? "" : '<p class="info warn">Shareable links are turned off until the public file link setup is finished.</p>'}
      <p class="info" id="folderNote">Only files saved in <code>${safeMediaFolder}</code> appear here.</p>
      <p id="status"></p>
      <div id="grid" class="grid"></div>
      <div id="selectionBar">
        <span class="sel-info" id="selCount">0 selected</span>
        <div class="sel-actions">
          <button type="button" id="clearSelBtn">Clear</button>
          <button type="button" class="cms-use" id="useInCmsBtn">Use selected files</button>
        </div>
      </div>
    </main>
    <script>
(function() {
  var CMS_ORIGIN = ${JSON.stringify(cmsOrigin)};
  var HAS_OPENER = ${hasOpener ? "true" : "false"};
  var LIBRARY_FOLDER = ${JSON.stringify(mediaFolder)};
  var dropzone = document.getElementById("dropzone");
  var fileInput = document.getElementById("fileInput");
  var statusEl = document.getElementById("status");
  var grid = document.getElementById("grid");
  var selectionBar = document.getElementById("selectionBar");
  var selCount = document.getElementById("selCount");
  var clearSelBtn = document.getElementById("clearSelBtn");
  var useInCmsBtn = document.getElementById("useInCmsBtn");

  var selected = new Map();

  function isUsablePublicUrl(url) {
    return /^https?:\\/\\/\\S+$/i.test((url || "").trim());
  }

  function fileLabelFromKey(key) {
    var parts = String(key || "").split("/");
    return parts[parts.length - 1] || "File";
  }

  function clearDragState() {
    dropzone.classList.remove("dragover");
  }

  function addPlaceholder(parent, message) {
    var ph = document.createElement("div");
    ph.className = "placeholder";
    ph.textContent = message;
    parent.appendChild(ph);
  }

  function setStatus(msg, cls) {
    statusEl.textContent = msg || "";
    statusEl.className = cls || "";
  }

  function updateSelectionBar() {
    var n = selected.size;
    if (HAS_OPENER && n > 0) {
      selectionBar.classList.add("visible");
      selCount.textContent = n === 1 ? "1 file selected" : n + " files selected";
    } else {
      selectionBar.classList.remove("visible");
    }
  }

  function toggleSelect(obj, card) {
    if (!HAS_OPENER || !isUsablePublicUrl(obj.publicUrl)) return;
    if (selected.has(obj.key)) {
      selected.delete(obj.key);
      card.classList.remove("selected");
    } else {
      selected.set(obj.key, obj.publicUrl);
      card.classList.add("selected");
    }
    updateSelectionBar();
  }

  clearSelBtn.addEventListener("click", function() {
    selected.clear();
    grid.querySelectorAll(".card.selected").forEach(function(c) { c.classList.remove("selected"); });
    updateSelectionBar();
  });

  useInCmsBtn.addEventListener("click", function() {
    if (!window.opener) {
      setStatus("Gallery editor window not found. Use Copy link instead.", "err");
      return;
    }
    selected.forEach(function(url) {
      window.opener.postMessage({ type: "lacumbre:r2:use", url: url }, CMS_ORIGIN || "*");
    });
    setStatus("Sent " + selected.size + " link(s) to the gallery editor.", "ok");
    selected.clear();
    grid.querySelectorAll(".card.selected").forEach(function(c) { c.classList.remove("selected"); });
    updateSelectionBar();
  });

  async function loadList() {
    setStatus("Loading files\\u2026");
    var res = await fetch("/r2/list", { credentials: "same-origin" });
    if (res.status === 401) { window.location.reload(); return; }
    if (!res.ok) { setStatus("Could not load files", "err"); return; }
    var data = await res.json();
    setStatus("");
    renderGrid(data.objects || []);
  }

  function isImageUrl(url) {
    return /\\.(jpe?g|png|gif|webp|svg|avif|bmp)(\\?|$)/i.test(url);
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  function renderGrid(objects) {
    grid.innerHTML = "";
    selected.clear();
    updateSelectionBar();
    if (!objects.length) {
      grid.innerHTML = '<p class="empty">No files found in <code>' + LIBRARY_FOLDER + "</code> yet.</p>";
      return;
    }
    objects.sort(function(a, b) { return (b.uploaded || "").localeCompare(a.uploaded || ""); });
    objects.forEach(function(obj) {
      var publicUrl = typeof obj.publicUrl === "string" ? obj.publicUrl.trim() : "";
      var canShare = isUsablePublicUrl(publicUrl);
      var card = document.createElement("div");
      card.className = "card";

      var checkOverlay = document.createElement("div");
      checkOverlay.className = "check-overlay";
      checkOverlay.textContent = "\\u2713";
      card.appendChild(checkOverlay);

      var thumb = document.createElement("div");
      thumb.className = "thumb-wrap";
      if (HAS_OPENER && canShare) {
        thumb.addEventListener("click", function() { toggleSelect(obj, card); });
      }
      if (canShare && isImageUrl(publicUrl)) {
        var img = document.createElement("img");
        img.src = publicUrl;
        img.alt = "";
        img.loading = "lazy";
        img.onerror = function() {
          thumb.innerHTML = "";
          addPlaceholder(thumb, "Preview unavailable");
        };
        thumb.appendChild(img);
      } else {
        addPlaceholder(thumb, canShare ? "Preview unavailable" : "Shareable link unavailable");
      }

      var meta = document.createElement("div");
      meta.className = "meta";
      var nameEl = document.createElement("div");
      nameEl.className = "name";
      nameEl.textContent = fileLabelFromKey(obj.key);
      meta.appendChild(nameEl);
      var keyEl = document.createElement("div");
      keyEl.className = "key";
      keyEl.textContent = obj.key;
      meta.appendChild(keyEl);
      var sizeEl = document.createElement("span");
      sizeEl.className = "size";
      sizeEl.textContent = formatSize(obj.size || 0);
      meta.appendChild(sizeEl);

      var actions = document.createElement("div");
      actions.className = "actions";

      if (HAS_OPENER && canShare) {
        var useBtn = document.createElement("button");
        useBtn.type = "button";
        useBtn.className = "cms-use";
        useBtn.textContent = "Use in editor";
        useBtn.onclick = function() {
          if (!window.opener) {
            setStatus("Gallery editor window not found. Use Copy link instead.", "err");
            return;
          }
          window.opener.postMessage({ type: "lacumbre:r2:use", url: publicUrl }, CMS_ORIGIN || "*");
          setStatus("Link sent to the gallery editor.", "ok");
        };
        actions.appendChild(useBtn);
      }

      var copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.textContent = canShare ? "Copy link" : "Link unavailable";
      copyBtn.disabled = !canShare;
      copyBtn.onclick = function() {
        if (!canShare) { setStatus("Shareable link unavailable", "err"); return; }
        navigator.clipboard.writeText(publicUrl).then(function() {
          setStatus("Link copied", "ok");
        }).catch(function() {
          setStatus("Could not copy the link", "err");
        });
      };

      var delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "danger";
      delBtn.textContent = "Remove";
      delBtn.onclick = async function() {
        if (!confirm("Remove this file? Any gallery items already using it will keep their current link until you replace it.")) return;
        var url = "/r2/delete?key=" + encodeURIComponent(obj.key);
        var res = await fetch(url, { method: "DELETE", credentials: "same-origin" });
        if (res.status === 401) { window.location.reload(); return; }
        if (!res.ok && res.status !== 204) {
          setStatus("Could not remove the file", "err");
          return;
        }
        setStatus("File removed", "ok");
        loadList();
      };

      actions.appendChild(copyBtn);
      actions.appendChild(delBtn);
      card.appendChild(thumb);
      card.appendChild(meta);
      card.appendChild(actions);
      grid.appendChild(card);
    });
  }

  async function uploadFiles(files) {
    if (!files || !files.length) return;
    clearDragState();
    for (var i = 0; i < files.length; i++) {
      await uploadFile(files[i]);
    }
  }

  async function uploadFile(file) {
    if (!file) return;
    setStatus("Uploading " + file.name + "\\u2026");
    var fd = new FormData();
    fd.append("file", file);
    var res = await fetch("/r2/upload", { method: "POST", body: fd, credentials: "same-origin" });
    if (res.status === 401) { window.location.reload(); return; }
    var body;
    try { body = await res.json(); } catch (e) { body = {}; }
    if (!res.ok) {
      setStatus(body.error || "Upload failed", "err");
      return;
    }
    if (isUsablePublicUrl(body.publicUrl || "")) {
      setStatus("Upload complete. The file is ready to use.", "ok");
    } else {
      setStatus("Upload complete, but the shareable link is unavailable.", "ok");
    }
    loadList();
  }

  function openFilePicker() {
    clearDragState();
    fileInput.click();
  }

  dropzone.addEventListener("click", openFilePicker);
  dropzone.addEventListener("keydown", function(event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openFilePicker();
    }
  });

  fileInput.addEventListener("change", function() {
    var files = fileInput.files ? Array.prototype.slice.call(fileInput.files) : [];
    fileInput.value = "";
    uploadFiles(files);
  });
  ["dragenter", "dragover"].forEach(function(ev) {
    dropzone.addEventListener(ev, function(e) { e.preventDefault(); dropzone.classList.add("dragover"); });
  });
  ["dragleave", "drop"].forEach(function(ev) {
    dropzone.addEventListener(ev, function(e) { e.preventDefault(); clearDragState(); });
  });
  dropzone.addEventListener("drop", function(e) {
    var files = e.dataTransfer && e.dataTransfer.files ? Array.prototype.slice.call(e.dataTransfer.files) : [];
    uploadFiles(files);
  });
  window.addEventListener("blur", clearDragState);
  window.addEventListener("dragend", clearDragState);
  window.addEventListener("drop", clearDragState);

  loadList();
})();
    </script>
  </body>
</html>`;
}

function renderSuccessHtml(payload: { token: string; provider: string }, cmsOrigin: string): string {
  const serializedPayload = JSON.stringify(payload);
  const serializedOrigin = JSON.stringify(cmsOrigin || "");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Gallery Editor Sign-in</title>
  </head>
  <body>
    <script>
      (function() {
        var payload = ${serializedPayload};
        var configuredOrigin = ${serializedOrigin};
        var hasSent = false;

        function send(targetOrigin) {
          if (hasSent || !window.opener || !targetOrigin) {
            return;
          }
          hasSent = true;
          window.opener.postMessage(
            "authorization:github:success:" + JSON.stringify(payload),
            targetOrigin
          );
          window.close();
        }

        window.opener && window.opener.postMessage("authorizing:github", "*");

        window.addEventListener("message", function(event) {
          send(event.origin);
        });

        setTimeout(function() {
          if (configuredOrigin) {
            send(configuredOrigin);
          }
        }, 300);
      })();
    </script>
    <p>Sign-in complete. You can close this window.</p>
  </body>
</html>`;
}

function renderFailure(message: string): Response {
  const safeMessage = escapeHtml(message);
  return new Response(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Sign-in Failed</title>
  </head>
  <body>
    <h1>Sign-in failed</h1>
    <p>${safeMessage}</p>
  </body>
</html>`,
    {
      status: 401,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    }
  );
}

function parseAllowedEmails(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

function parseCookies(headerValue: string | null): Record<string, string> {
  if (!headerValue) {
    return {};
  }

  return headerValue.split(";").reduce<Record<string, string>>((acc, pair) => {
    const [key, ...rest] = pair.trim().split("=");
    if (!key || rest.length === 0) {
      return acc;
    }
    acc[key] = decodeURIComponent(rest.join("="));
    return acc;
  }, {});
}

function createCookie(name: string, value: string, maxAgeSeconds: number): string {
  const encoded = encodeURIComponent(value);
  return `${name}=${encoded}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie(name: string): string {
  return `${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function sanitizeOrigin(origin: string | null): string {
  if (!origin) {
    return "";
  }

  try {
    const parsed = new URL(origin);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.origin;
    }
    return "";
  } catch {
    return "";
  }
}

function randomHex(bytes: number): string {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return Array.from(array, (v) => v.toString(16).padStart(2, "0")).join("");
}

function ensureGoogleEnv(env: Env): void {
  const required = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ALLOWED_EMAILS"] as const;
  for (const key of required) {
    if (!env[key] || !String(env[key]).trim()) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
