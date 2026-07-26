#!/usr/bin/env python3
"""Collect build-phase health metrics and write ops/status.json.

Read-only against external services (none are live yet in Phase 0 — this
just checks local repo state). Schema matches docs/metrics.md.
"""
import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
STATUS_PATH = REPO_ROOT / "ops" / "status.json"
BUDGET_CAP_USD = 200


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def check_vocabulary_lint(verbose):
    result = subprocess.run(
        ["node", str(REPO_ROOT / "scripts" / "lint-vocabulary.mjs")],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    if verbose:
        print(result.stdout, file=sys.stderr)
        print(result.stderr, file=sys.stderr)
    return "clean" if result.returncode == 0 else "failed"


def current_phase():
    # Phase is tracked manually in docs/roadmap.md / DASHBOARD.md for now.
    # This stub reads it from ops/status.json's previous value if present,
    # defaulting to 0. Update this once program.current_lab exists in D1.
    if STATUS_PATH.exists():
        try:
            prev = json.loads(STATUS_PATH.read_text())
            return prev.get("current_phase", 0)
        except (json.JSONDecodeError, OSError):
            pass
    return 0


def build_status(verbose=False):
    lint_status = check_vocabulary_lint(verbose)
    monthly_spend = 0  # no live billing integration yet — see docs/capability-gaps.md

    metrics = {
        "vocabulary_lint": {
            "value": lint_status,
            "unit": "status",
            "status": "green" if lint_status == "clean" else "red",
            "checked_at": now_iso(),
        },
        "monthly_spend_usd": {
            "value": monthly_spend,
            "unit": "$",
            "status": "green" if monthly_spend < BUDGET_CAP_USD else "red",
            "checked_at": now_iso(),
        },
    }

    overall = "green"
    if any(m["status"] == "red" for m in metrics.values()):
        overall = "red"
    elif any(m["status"] == "yellow" for m in metrics.values()):
        overall = "yellow"

    return {
        "updated_at": now_iso(),
        "overall_status": overall,
        "current_phase": current_phase(),
        "metrics": metrics,
        "active_alerts": [],
        "pending_escalations": [],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verbose", action="store_true", help="print lint output to stderr")
    args = parser.parse_args()

    status = build_status(verbose=args.verbose)
    STATUS_PATH.write_text(json.dumps(status, indent=2) + "\n")
    print(f"Wrote {STATUS_PATH.relative_to(REPO_ROOT)} — overall_status={status['overall_status']}")


if __name__ == "__main__":
    main()
