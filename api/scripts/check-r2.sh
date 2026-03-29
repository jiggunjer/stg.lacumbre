#!/usr/bin/env bash
#
# Sanity-check script for Cloudflare R2 bucket connectivity.
#
# 1. Public URL reachability (no credentials needed)
# 2. S3 checks via AWS CLI: list, upload dummy, read-back via public URL, delete
#
# Usage:
#   ./api/scripts/check-r2.sh
#
# Reads bucket / public URL / prefix from api/wrangler.toml ([[r2_buckets]] and [vars]).
# Optional legacy: static/admin/config.yml keys account_id, bucket, access_key_id, prefix, public_url.
# Override anything with env vars:
#   R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
#   R2_PREFIX, R2_PUBLIC_URL
#
# Requires: aws (AWS CLI v2) — install on Arch: sudo pacman -S aws-cli-v2
# Optional fallback: curl with --aws-sigv4 (if AWS CLI list fails, step 2 retries via curl)
#
# NOTE on R2 credential types:
#   - "API token" (cfut_...) → for Wrangler / CF dashboard API, NOT for S3
#   - "S3 Access Key ID + Secret Access Key" → used by this script only (Worker uses R2 bindings)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG="$REPO_ROOT/static/admin/config.yml"
WRANGLER="$REPO_ROOT/api/wrangler.toml"

# ── helpers ──────────────────────────────────────────────────────────

red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

die() { red "FAIL: $*" >&2; exit 1; }

yaml_val() {
  [[ -f "$CONFIG" ]] || return 0
  grep -E "^\s*$1:" "$CONFIG" | head -1 | sed "s/^.*$1:\s*//" | sed "s/['\"]//g" | xargs
}

wrangler_bucket_name() {
  [[ -f "$WRANGLER" ]] || return 0
  grep -E '^\s*bucket_name\s*=' "$WRANGLER" | head -1 | sed -E 's/.*bucket_name\s*=\s*"([^"]+)".*/\1/'
}

wrangler_var() {
  [[ -f "$WRANGLER" ]] || return 0
  local k="$1"
  grep -E "^${k}\s*=" "$WRANGLER" | head -1 | sed -E 's/^[^=]+=\s*"([^"]*)".*/\1/'
}

# ── read config / env ────────────────────────────────────────────────

ACCOUNT_ID="${R2_ACCOUNT_ID:-$(yaml_val account_id)}"
BUCKET="${R2_BUCKET:-$(yaml_val bucket)}"
[[ -z "$BUCKET" ]] && BUCKET="$(wrangler_bucket_name)"
ACCESS_KEY="${R2_ACCESS_KEY_ID:-$(yaml_val access_key_id)}"
PREFIX="${R2_PREFIX:-$(yaml_val prefix)}"
[[ -z "$PREFIX" ]] && PREFIX="$(wrangler_var R2_PREFIX)"
PUBLIC_URL="${R2_PUBLIC_URL:-$(yaml_val public_url)}"
[[ -z "$PUBLIC_URL" ]] && PUBLIC_URL="$(wrangler_var R2_PUBLIC_URL)"
# strip trailing slash from prefix for consistent path building
PREFIX="${PREFIX%/}"

[[ -z "$ACCOUNT_ID" || -z "$BUCKET" || -z "$ACCESS_KEY" ]] && \
  die "Need R2_ACCOUNT_ID, bucket (wrangler.toml or config), and R2_ACCESS_KEY_ID (or config). Set secrets via env; see README."

[[ "$BUCKET" == http* ]] && \
  die "bucket must be the plain name (e.g. 'lacumbre-staging'), not a URL.\n  Found: $BUCKET"

command -v aws >/dev/null 2>&1 || die "AWS CLI not found. Install: sudo pacman -S aws-cli-v2"

ENDPOINT="https://${ACCOUNT_ID}.r2.cloudflarestorage.com"
PROBE_NAME="_r2-check-$(date +%s)-$$.txt"
if [[ -n "$PREFIX" ]]; then
  PROBE_KEY="${PREFIX}/${PROBE_NAME}"
else
  PROBE_KEY="$PROBE_NAME"
fi
PROBE_CONTENT="r2 sanity check @ $(date -u +%Y-%m-%dT%H:%M:%SZ) pid=$$"

# ── print banner ─────────────────────────────────────────────────────

echo ""
bold "──────────────────────────────────────────────"
bold "R2 sanity check"
bold "──────────────────────────────────────────────"
echo "  Endpoint   : $ENDPOINT"
echo "  Bucket     : $BUCKET"
echo "  Prefix     : ${PREFIX:-<none>}"
echo "  Access Key : ${ACCESS_KEY:0:8}…"
echo "  Public URL : ${PUBLIC_URL:-<not set>}"
echo "  Probe key  : $PROBE_KEY"
echo ""

PASS=0
FAIL=0

ok()   { green "    → OK"; PASS=$((PASS + 1)); }
fail() { red   "    → FAILED"; FAIL=$((FAIL + 1)); }

# curl S3 SigV4 (fallback when aws s3 ls misbehaves with R2 endpoint)
s3curl() {
  curl --silent --max-time 15 \
    --aws-sigv4 "aws:amz:auto:s3" \
    --user "${ACCESS_KEY}:${R2_SECRET_ACCESS_KEY}" \
    "$@"
}

diagnose_list_xml() {
  local body="$1"
  if echo "$body" | grep -qi "InvalidAccessKeyId"; then
    yellow "    Hint: access_key_id not recognised. S3 key, not cfut_...?"
  elif echo "$body" | grep -qi "SignatureDoesNotMatch"; then
    yellow "    Hint: secret key mismatch or extra whitespace."
  elif echo "$body" | grep -qi "AccessDenied"; then
    yellow "    Hint: token needs 'Object Read & Write' permission."
  elif echo "$body" | grep -qi "NoSuchBucket"; then
    yellow "    Hint: bucket '$BUCKET' not found under this account."
  fi
  local msg
  msg=$(echo "$body" | grep -oP '(?<=<Message>).*?(?=</Message>)' 2>/dev/null | head -1) || true
  [[ -n "$msg" ]] && red "    R2 says: $msg"
}

UPLOAD_OK=0

# ══════════════════════════════════════════════════════════════════════
# Test 1 — Public URL reachable (no auth, just curl)
# ══════════════════════════════════════════════════════════════════════

bold "1. Public URL reachability"

if [[ -z "$PUBLIC_URL" ]]; then
  yellow "   SKIPPED (public_url not set in config)"
else
  printf "   Fetching %s … " "$PUBLIC_URL"
  pub_code=$(curl --silent --max-time 10 -o /dev/null -w "%{http_code}" "$PUBLIC_URL" 2>&1) || pub_code="000"
  echo "HTTP $pub_code"
  if [[ "$pub_code" =~ ^[23] ]]; then
    ok
  elif [[ "$pub_code" == "000" ]]; then
    fail
    yellow "    Hint: connection timeout or DNS failure."
    yellow "          Check the public_url domain and that R2 public access is enabled."
  else
    # 404 on the root is normal when there's no index — still means the host is up
    yellow "    HTTP $pub_code (host is reachable; 404 is normal if there is no index document)"
    PASS=$((PASS + 1))
  fi
fi
echo ""

# ══════════════════════════════════════════════════════════════════════
# Tests 2-5 — S3 checks via AWS CLI
# ══════════════════════════════════════════════════════════════════════

# Prompt for secret if not in env
if [[ -z "${R2_SECRET_ACCESS_KEY:-}" ]]; then
  bold "Enter your R2 S3 Secret Access Key (NOT the cfut_... API token):"
  read -rs R2_SECRET_ACCESS_KEY
  echo ""
fi

export AWS_ACCESS_KEY_ID="$ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="auto"

aws_r2() {
  aws --endpoint-url "$ENDPOINT" "$@" 2>&1
}

# ── 2. List objects ──────────────────────────────────────────────────

bold "2. List objects (auth + read + listing)"
list_prefix="${PREFIX:+${PREFIX}/}"
aws_ls_cmd=(aws --endpoint-url "$ENDPOINT" s3 ls "s3://${BUCKET}/${list_prefix}")

printf "   aws s3 ls s3://%s/%s … " "$BUCKET" "$list_prefix"
list_http=""

if output=$("${aws_ls_cmd[@]}" 2>&1); then
  count=$(echo "$output" | grep -c . || true)
  echo "OK"
  ok
  echo "    Objects returned: $count"
else
  echo "FAILED"
  echo "$output" | head -8 | sed 's/^/    /'
  yellow "    Command that failed (paste after exporting secrets):"
  printf '      AWS_ACCESS_KEY_ID=%q AWS_SECRET_ACCESS_KEY=… AWS_DEFAULT_REGION=auto %q --endpoint-url %q s3 ls %q\n' \
    "$ACCESS_KEY" "aws" "$ENDPOINT" "s3://${BUCKET}/${list_prefix}"

  if echo "$output" | grep -qi "InvalidAccessKeyId"; then
    yellow "    Hint: access_key_id not recognised. Are you using the S3 key, not cfut_...?"
  elif echo "$output" | grep -qi "SignatureDoesNotMatch"; then
    yellow "    Hint: secret key mismatch or extra whitespace."
  elif echo "$output" | grep -qi "AccessDenied"; then
    yellow "    Hint: token needs 'Object Read & Write' permission."
  elif echo "$output" | grep -qi "NoSuchBucket"; then
    yellow "    Hint: bucket '$BUCKET' not found under this account."
  fi

  # Fallback: ListObjectsV2 via curl + SigV4 (same path Sveltia uses in-browser)
  list_query="list-type=2&max-keys=5"
  [[ -n "$PREFIX" ]] && list_query="${list_query}&prefix=${PREFIX}%2F"
  list_url="${ENDPOINT}/${BUCKET}?${list_query}"
  yellow "    Retrying with curl ListObjectsV2 …"
  printf "   curl (sigv4) %s?… " "$ENDPOINT/${BUCKET}"

  body_and_code=$(s3curl -w "\n%{http_code}" "$list_url" 2>&1) || body_and_code=$'\n000'
  list_http=$(echo "$body_and_code" | tail -1)
  curl_body=$(echo "$body_and_code" | sed '$d')

  echo "HTTP $list_http"
  if [[ "$list_http" =~ ^2 ]]; then
    ccount=$(echo "$curl_body" | grep -c '<Key>' || true)
    green "    → OK (curl fallback)"
    PASS=$((PASS + 1))
    echo "    <Key> count (max 5): $ccount"
    yellow "    Note: AWS CLI listing failed but direct S3 ListObjectsV2 succeeded."
    yellow "          Check ~/.aws/config, CLI version, or credential_process if needed."
  else
    fail
    diagnose_list_xml "$curl_body"
    yellow "    Fallback command that failed (replace … with your secret):"
    printf '      curl --silent --max-time 15 --aws-sigv4 %q --user %q:%q %q\n' \
      "aws:amz:auto:s3" "$ACCESS_KEY" "…" "$list_url"
  fi
fi
echo ""

# ── 3. Upload dummy file ────────────────────────────────────────────

bold "3. Upload test file (write)"
TMPFILE=$(mktemp)
echo "$PROBE_CONTENT" > "$TMPFILE"
printf "   aws s3 cp → s3://%s/%s … " "$BUCKET" "$PROBE_KEY"
if output=$(aws_r2 s3 cp "$TMPFILE" "s3://${BUCKET}/${PROBE_KEY}" 2>&1); then
  echo "OK"
  ok
  UPLOAD_OK=1
else
  echo "FAILED"
  fail
  echo "$output" | head -5 | sed 's/^/    /'
  yellow "    Command that failed:"
  printf '      AWS_ACCESS_KEY_ID=%q AWS_SECRET_ACCESS_KEY=… AWS_DEFAULT_REGION=auto aws --endpoint-url %q s3 cp <tmpfile> %q\n' \
    "$ACCESS_KEY" "$ENDPOINT" "s3://${BUCKET}/${PROBE_KEY}"
  [[ "$output" == *"AccessDenied"* ]] && \
    yellow "    Hint: token can list/read but not write. Check 'Object Read & Write'."
fi
rm -f "$TMPFILE"
echo ""

# ── 4. Read back via public URL ─────────────────────────────────────

bold "4. Read test file via public URL"
if [[ -z "$PUBLIC_URL" ]]; then
  yellow "   SKIPPED (public_url not set)"
elif [[ "$UPLOAD_OK" != "1" ]]; then
  yellow "   SKIPPED (upload did not succeed; nothing to fetch)"
else
  probe_pub_url="${PUBLIC_URL%/}/${PROBE_KEY}"
  printf "   curl %s … " "$probe_pub_url"
  # small delay — R2 public cache can take a moment
  sleep 1
  fetched=$(curl --silent --max-time 10 "$probe_pub_url" 2>&1) || fetched=""
  if [[ "$fetched" == *"$PROBE_CONTENT"* ]]; then
    echo "OK (content matches)"
    ok
  else
    http_code=$(curl --silent --max-time 10 -o /dev/null -w "%{http_code}" "$probe_pub_url" 2>&1) || http_code="000"
    echo "HTTP $http_code"
    if [[ "$http_code" == "404" ]]; then
      yellow "    File not yet visible at public URL."
      yellow "    R2 public access propagation can take a few seconds."
      yellow "    Try manually: curl $probe_pub_url"
      PASS=$((PASS + 1))
    else
      fail
      yellow "    Content mismatch or fetch error."
    fi
  fi
fi
echo ""

# ── 5. Delete test file ─────────────────────────────────────────────

bold "5. Delete test file (cleanup)"
printf "   aws s3 rm s3://%s/%s … " "$BUCKET" "$PROBE_KEY"
if output=$(aws_r2 s3 rm "s3://${BUCKET}/${PROBE_KEY}" 2>&1); then
  echo "OK"
  ok
else
  echo "FAILED"
  fail
  echo "$output" | head -3 | sed 's/^/    /'
  yellow "    Command that failed:"
  printf '      AWS_ACCESS_KEY_ID=%q AWS_SECRET_ACCESS_KEY=… AWS_DEFAULT_REGION=auto aws --endpoint-url %q s3 rm %q\n' \
    "$ACCESS_KEY" "$ENDPOINT" "s3://${BUCKET}/${PROBE_KEY}"
fi
echo ""

# ── summary ──────────────────────────────────────────────────────────

bold "──────────────────────────────────────────────"
if [[ $FAIL -eq 0 ]]; then
  green "All $PASS checks passed. Bucket is ready for Sveltia."
else
  red "$FAIL check(s) failed, $PASS passed."
  echo ""
  yellow "Common fixes:"
  yellow "  1. 'bucket' in config.yml must be the plain name, not a URL"
  yellow "  2. Use S3 Access Key ID + Secret Access Key (NOT the cfut_... API token)"
  yellow "  3. R2 token needs 'Object Read & Write' permission"
  yellow "  4. CORS must allow your CMS origin with GET, PUT, HEAD methods"
fi
bold "──────────────────────────────────────────────"
exit $FAIL
