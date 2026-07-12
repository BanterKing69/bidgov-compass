"""
Phase 6 regression: the "Closing ≤ 7 days" KPI is displayed on both the
Dashboard (fed by /api/stats.totals.closing_7d) and Live bids (fed by
/api/live-stats.closing_7d). The two numbers must be identical for the same
concept — otherwise the two screens contradict each other and the whole
"is_open is stale" spec argument stops holding.

Cause of a previous mismatch: /api/stats.totals.closing_7d was computed
inside the outer WHERE clause of /api/stats, which defaults to
notice_stage='tender' AND is_open=1. Live-bids uses the definitive
deadline >= now filter (no is_open). Fixed in Phase 6 by hoisting the
closing_7d computation to a separate independent query.
"""

from __future__ import annotations


def test_closing_7d_matches_across_stats_and_live_stats(admin):
    stats = admin.get("/api/stats").get_json()
    live = admin.get("/api/live-stats").get_json()
    assert stats["totals"]["closing_7d"] == live["closing_7d"], (
        "Closing ≤7d KPI drifted between /api/stats and /api/live-stats: "
        f"{stats['totals']['closing_7d']} vs {live['closing_7d']}"
    )
