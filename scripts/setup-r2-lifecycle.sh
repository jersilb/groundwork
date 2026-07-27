#!/usr/bin/env bash
# One-time setup: 90-day auto-delete lifecycle rule on the real audio R2
# bucket — build plan §4 retention requirement ("raw audio in R2
# auto-deletes at 90 days via lifecycle rule").
#
# NOT run by CI or any test script. Requires a real (non-local) R2 bucket
# and live Cloudflare account access, which this dev sandbox cannot reach
# at all (docs/capability-gaps.md, 2026-07-27) — run this from an
# environment with real network access to api.cloudflare.com, after the
# real bucket is created (not the "-local" placeholder in wrangler.toml).
set -euo pipefail

BUCKET_NAME="${1:?Usage: setup-r2-lifecycle.sh <real-bucket-name>}"

npx wrangler r2 bucket lifecycle add "$BUCKET_NAME" \
  --name "audio-90-day-expiry" \
  --prefix "audio/" \
  --expire-days 90

echo "Lifecycle rule added. Verify with: npx wrangler r2 bucket lifecycle list $BUCKET_NAME"
