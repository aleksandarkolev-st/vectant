"""Render bench summary as markdown. Used by CI gates (master plan §15.3)."""

from __future__ import annotations

from typing import Any, List

# CI gates from §15.3. A regression on any of these blocks the PR.
THRESHOLDS = {
    "critic_precision":   0.70,
    "critic_recall":      0.60,
    "apply_success_rate": 0.95,
    "latency_p95_s":      14.4,  # standard tier 12s + 20%
}


def render(summary: Any, results: List[Any]) -> str:
    lines = [
        "# Synthi Genome bench report",
        "",
        f"- Fixtures: **{summary.fixtures_passed} / {summary.fixtures_total}**",
        f"- Apply success rate: **{summary.apply_success_rate:.2%}**",
        f"- Critic precision: **{summary.critic_precision:.2f}** (gate ≥ {THRESHOLDS['critic_precision']})",
        f"- Critic recall: **{summary.critic_recall:.2f}** (gate ≥ {THRESHOLDS['critic_recall']})",
        f"- Latency p50/p95: **{summary.latency_p50:.2f}s / {summary.latency_p95:.2f}s** (gate p95 ≤ {THRESHOLDS['latency_p95_s']:.1f}s)",
        f"- Avg universe score: **{summary.avg_score:.3f}**",
        "",
        "## Per-fixture detail",
        "",
        "| fixture | ok | duration (s) | universes | best score |",
        "|---|---|---|---|---|",
    ]
    for r in results:
        best = ""
        univ_count = len(getattr(r, "universes", {}) or {})
        if univ_count:
            best = f"{max(ev.get('score', 0.0) for ev in r.universes.values()):.3f}"
        lines.append(f"| {r.fixture_id} | {'✓' if r.success else '✗'} | {r.duration_s:.2f} | {univ_count} | {best} |")
    lines.append("")

    failed = [k for k, v in {
        "critic_precision":   summary.critic_precision >= THRESHOLDS["critic_precision"],
        "critic_recall":      summary.critic_recall >= THRESHOLDS["critic_recall"],
        "apply_success_rate": summary.apply_success_rate >= THRESHOLDS["apply_success_rate"],
        "latency_p95_s":      summary.latency_p95 <= THRESHOLDS["latency_p95_s"],
    }.items() if not v]

    if summary.fixtures_total == 0:
        lines.append("> **Wave 1 status:** corpus is empty. Add fixtures under `bench/corpus/<id>/`.")
    elif failed:
        lines.append(f"> **CI gates failed:** {', '.join(failed)}")
    else:
        lines.append("> All CI gates passing.")
    return "\n".join(lines) + "\n"
