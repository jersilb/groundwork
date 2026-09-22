#!/usr/bin/env bash
# One-time setup: create the groundwork-transcription dead-letter queue.
#
# wrangler.toml routes a chunk that exhausts the transcription consumer's
# max_retries (5) into groundwork-transcription-dlq instead of letting
# Cloudflare discard it. Wrangler sets the consumer's dead_letter_queue but
# does not create the queue, so create it once before the first deploy that
# carries that line — otherwise the reference points at a queue that does
# not exist.
#
# NOT run by CI or any test script. Requires a real Cloudflare account and
# live network access to api.cloudflare.com, which this dev sandbox cannot
# reach (docs/capability-gaps.md, 2026-07-27). Run from an environment with
# that access, with Jeremy present (see docs/decisions.md: no live
# Cloudflare resources created without him).
set -euo pipefail

QUEUE_NAME="groundwork-transcription-dlq"

npx wrangler queues create "$QUEUE_NAME"

echo "Dead-letter queue created. Verify with: npx wrangler queues list"
