#!/usr/bin/env python3
"""Read ops/status.json and rewrite the live sections of DASHBOARD.md.

Only rewrites the generated blocks (between the START/END markers below).
Hand-written sections of DASHBOARD.md (Pending Decisions, Active Incidents,
Last 7 Days, Next 7 Days, Quick Links) are left untouched.
"""
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
STATUS_PATH = REPO_ROOT / "ops" / "status.json"
DASHBOARD_PATH = REPO_ROOT / "DASHBOARD.md"

STATUS_EMOJI = {"green": "🟢", "yellow": "🟡", "red": "🔴"}


def render_overall(status):
    emoji = STATUS_EMOJI.get(status["overall_status"], "🟡")
    label = {"green": "HEALTHY", "yellow": "DEGRADED", "red": "CRITICAL"}.get(
        status["overall_status"], "UNKNOWN"
    )
    return f"## Overall Status: {emoji} {label}"


def render_metrics_table(status):
    rows = [
        "| Metric | Value | Status | Last Checked |",
        "|--------|-------|--------|--------------|",
        f"| Current phase | {status['current_phase']} | 🟢 | {status['updated_at']} |",
    ]
    for name, m in status["metrics"].items():
        emoji = STATUS_EMOJI.get(m["status"], "🟡")
        rows.append(f"| {name} | {m['value']} | {emoji} | {m['checked_at']} |")
    return "\n".join(rows)


def main():
    if not STATUS_PATH.exists():
        print(f"error: {STATUS_PATH} does not exist. Run collect_metrics.py first.", file=sys.stderr)
        sys.exit(1)

    status = json.loads(STATUS_PATH.read_text())
    dashboard = DASHBOARD_PATH.read_text()

    dashboard = re.sub(
        r"## Overall Status:.*",
        render_overall(status),
        dashboard,
        count=1,
    )
    dashboard = re.sub(
        r"## Active Metrics\n\n.*?\n\nFull definitions",
        f"## Active Metrics\n\n{render_metrics_table(status)}\n\nFull definitions",
        dashboard,
        count=1,
        flags=re.DOTALL,
    )
    dashboard = re.sub(
        r"\*\*Last Updated\*\*: .*",
        f"**Last Updated**: {status['updated_at']}",
        dashboard,
        count=1,
    )

    DASHBOARD_PATH.write_text(dashboard)
    print(f"Updated {DASHBOARD_PATH.relative_to(REPO_ROOT)} from {STATUS_PATH.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
