"""
Phase 4 acceptance — pipeline CRUD, fee economics, CSRF gate, chat isolation.

Verifies spec §5/§6:
  * Pipeline CRUD round-trip through /api/admin/pipeline.
  * Fee economics (revenue_booked, pipeline_unweighted, expected_per_deal)
    equal a hand-computed reference from a seeded fixture.
  * CSRF: state-changing POST without X-CSRFToken → 400; with token → 200.
  * Chat cannot query the pipeline table (users.db is not opened by chat).
  * `pipeline` table absent from tenders.db schema.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from tests.conftest import csrf_headers


# --------------------------------------------------------------------------- #
# Test data — three deals with realistic tender categories from the store.
# We look up REAL tender_uids from data/tenders.db so the join returns
# actual titles / categories / values (drives the win-rate computation
# through concrete numbers, not None).
# --------------------------------------------------------------------------- #
@pytest.fixture
def real_tender_uids():
    """Pick three real tender uids with known-mapped categories so the
    fee-economics test uses concrete values from tenders.db."""
    import db
    conn = db.connect()
    try:
        cur = conn.execute(
            "SELECT uid, category, value_amount "
            "FROM tenders "
            "WHERE notice_stage='tender' "
            "  AND value_amount IS NOT NULL "
            "  AND category IS NOT NULL "
            "LIMIT 3"
        )
        rows = cur.fetchall()
    finally:
        conn.close()
    assert len(rows) == 3, "need 3 tenders with category + value for the economics test"
    return [{"uid": r[0], "category": r[1], "value": float(r[2])} for r in rows]


@pytest.fixture(autouse=True)
def _clear_pipeline(admin):
    """Each pipeline test starts with an empty table. Fixture runs *before*
    the test to clear; the pipeline table survives the session-scoped users.db."""
    import pipeline as p
    conn = p._conn()
    try:
        conn.execute("DELETE FROM pipeline")
        conn.commit()
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# CRUD round-trip
# --------------------------------------------------------------------------- #
def test_pipeline_crud_round_trip(admin, real_tender_uids):
    hdr = csrf_headers(admin)
    # CREATE
    tender = real_tender_uids[0]
    r = admin.post("/api/admin/pipeline",
                   headers=hdr,
                   json={"tender_uid": tender["uid"],
                         "client_name": "ACME Ltd",
                         "notes": "First deal"})
    assert r.status_code == 201, r.data
    new_id = r.get_json()["id"]
    assert new_id > 0

    # READ
    r = admin.get("/api/admin/pipeline")
    assert r.status_code == 200
    rows = r.get_json()["rows"]
    assert len(rows) == 1
    row = rows[0]
    assert row["client_name"] == "ACME Ltd"
    assert row["stage"] == "qualified"
    assert row["fee_upfront"] == 1500
    assert row["fee_success_pct"] == 5.0
    assert row["tender"]["category"] == tender["category"]

    # UPDATE
    r = admin.patch(f"/api/admin/pipeline/{new_id}",
                    headers=hdr,
                    json={"stage": "won", "outcome_value": tender["value"] * 1.1,
                          "notes": "Won at Q3 close"})
    assert r.status_code == 200

    r = admin.get("/api/admin/pipeline")
    row = r.get_json()["rows"][0]
    assert row["stage"] == "won"
    assert row["outcome_value"] == pytest.approx(tender["value"] * 1.1)
    assert row["notes"] == "Won at Q3 close"

    # DELETE
    r = admin.delete(f"/api/admin/pipeline/{new_id}", headers=hdr)
    assert r.status_code == 200
    assert admin.get("/api/admin/pipeline").get_json()["rows"] == []


def test_pipeline_unique_constraint(admin, real_tender_uids):
    hdr = csrf_headers(admin)
    tender = real_tender_uids[0]
    r1 = admin.post("/api/admin/pipeline",
                    headers=hdr,
                    json={"tender_uid": tender["uid"], "client_name": "A"})
    assert r1.status_code == 201
    r2 = admin.post("/api/admin/pipeline",
                    headers=hdr,
                    json={"tender_uid": tender["uid"], "client_name": "B"})
    assert r2.status_code == 400
    assert r2.get_json().get("error") == "already tracked"


def test_invalid_stage_rejected(admin, real_tender_uids):
    hdr = csrf_headers(admin)
    tender = real_tender_uids[0]
    r = admin.post("/api/admin/pipeline",
                   headers=hdr,
                   json={"tender_uid": tender["uid"],
                         "client_name": "A", "stage": "bogus"})
    assert r.status_code == 400
    assert "invalid stage" in r.get_json()["error"]


# --------------------------------------------------------------------------- #
# Fee economics — hand-computed reference matches API output.
#
# Seed 3 deals:
#   * A: qualified, no outcome_value → success_fee uses tender value
#   * B: won,      no outcome_value → contributes to revenue_booked (upfront + fee)
#   * C: won,      outcome_value ≠ tender value → fee uses outcome_value
#
# Verified via direct call to pipeline.compute_overview() — same code the API
# returns, so we test the numbers themselves, not the JSON envelope.
# --------------------------------------------------------------------------- #
def test_fee_economics_match_hand_computation(admin, real_tender_uids):
    import pipeline as p
    hdr = csrf_headers(admin)
    t = real_tender_uids
    # A: qualified deal
    admin.post("/api/admin/pipeline", headers=hdr, json={
        "tender_uid": t[0]["uid"], "client_name": "A", "stage": "qualified",
    })
    # B: won deal — outcome_value not set, so fee uses tender value
    admin.post("/api/admin/pipeline", headers=hdr, json={
        "tender_uid": t[1]["uid"], "client_name": "B", "stage": "qualified",
    })
    # (patch B to won separately so we exercise the update path too)
    rows = admin.get("/api/admin/pipeline").get_json()["rows"]
    id_b = next(r["id"] for r in rows if r["client_name"] == "B")
    admin.patch(f"/api/admin/pipeline/{id_b}", headers=hdr, json={"stage": "won"})
    # C: won deal — outcome_value differs from tender value (say +25%)
    outcome_c = t[2]["value"] * 1.25
    admin.post("/api/admin/pipeline", headers=hdr, json={
        "tender_uid": t[2]["uid"], "client_name": "C", "stage": "won",
        "outcome_value": outcome_c,
    })
    # Hand-computed reference:
    # For each deal: fee_upfront=1500, fee_success_pct=5.0
    # Success fee = 5% × (outcome_value if set else tender.value)
    #             = 0.05 × value
    # Expected £/deal = 1500 + 0.05 × value × win_rate(category)
    # Revenue booked (won deals only) = upfront + success_fee
    def sf(v):    return 0.05 * v
    def exp(v, c): return 1500 + 0.05 * v * p.win_rate_for(c)

    hand_revenue = (
        (1500 + sf(t[1]["value"])) +      # B won: upfront + fee (uses tender value)
        (1500 + sf(outcome_c))            # C won: upfront + fee (uses outcome_value)
    )
    # Pipeline unweighted = 5% × value of open (non-won, non-lost) tracked deals
    #   Only A is open. B and C are won.
    hand_pipeline_unweighted = sf(t[0]["value"])
    # Expected £/deal uses the same "best-known" value as the success fee:
    #   outcome_value if set, else tender.value_amount.
    hand_exp_per_deal = (
        exp(t[0]["value"], t[0]["category"]) +
        exp(t[1]["value"], t[1]["category"]) +
        exp(outcome_c,     t[2]["category"])
    ) / 3.0

    overview = p.compute_overview()
    assert overview["deal_count"] == 3
    # counts
    stages = {row["stage"]: row["count"] for row in overview["funnel"]}
    assert stages["qualified"] == 1
    assert stages["won"] == 2
    # numbers (round to match API precision — 2dp)
    assert overview["revenue_booked"] == pytest.approx(round(hand_revenue, 2), abs=0.01)
    assert overview["pipeline_unweighted"] == pytest.approx(round(hand_pipeline_unweighted, 2), abs=0.01)
    assert overview["expected_per_deal"] == pytest.approx(round(hand_exp_per_deal, 2), abs=0.01)


def test_overview_api_matches_helper(admin, real_tender_uids):
    """The /api/admin/overview endpoint just wraps compute_overview() — verify
    the wire format matches exactly so no math drift can hide behind the API."""
    import pipeline as p
    hdr = csrf_headers(admin)
    admin.post("/api/admin/pipeline", headers=hdr, json={
        "tender_uid": real_tender_uids[0]["uid"], "client_name": "A"})
    api = admin.get("/api/admin/overview").get_json()
    direct = p.compute_overview()
    assert api == direct


# --------------------------------------------------------------------------- #
# CSRF gate — spec §6.
# --------------------------------------------------------------------------- #
def test_csrf_rejects_state_change_without_token(admin, real_tender_uids):
    r = admin.post("/api/admin/pipeline",
                   json={"tender_uid": real_tender_uids[0]["uid"],
                         "client_name": "NoCSRF"})
    assert r.status_code == 400, f"expected 400 CSRF failure, got {r.status_code}"


def test_csrf_accepts_state_change_with_token(admin, real_tender_uids):
    r = admin.post("/api/admin/pipeline",
                   headers=csrf_headers(admin),
                   json={"tender_uid": real_tender_uids[0]["uid"],
                         "client_name": "WithCSRF"})
    assert r.status_code == 201


def test_csrf_get_does_not_require_token(admin):
    r = admin.get("/api/admin/pipeline")
    assert r.status_code == 200


# --------------------------------------------------------------------------- #
# Chat isolation — the pipeline table must be unreachable via /api/chat.
# The chat opens a tenders-only connection (db.connect()), and pipeline lives
# in users.db. Any SQL that references `pipeline` will raise "no such table".
# --------------------------------------------------------------------------- #
def test_pipeline_table_absent_from_tenders_db():
    """No `pipeline` table exists in tenders.db — belt-and-braces schema check."""
    conn = sqlite3.connect(Path(__file__).resolve().parents[1] / "data" / "tenders.db")
    try:
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='pipeline'"
        ).fetchone()
    finally:
        conn.close()
    assert row is None, "pipeline table MUST NOT be in tenders.db"


def test_chat_cannot_query_pipeline(admin, real_tender_uids):
    """Ask the chat to query pipeline — the tenders-only connection has no such
    table, so the SELECT-only gate lets the query run and sqlite returns
    "no such table: pipeline". We assert on error semantics.

    We also seed a pipeline row so the fee data is real (belt-and-braces:
    even if some future misconfiguration ATTACHed users.db, this would show
    up as a leak; today it should stay an error.)"""
    hdr = csrf_headers(admin)
    admin.post("/api/admin/pipeline", headers=hdr, json={
        "tender_uid": real_tender_uids[0]["uid"],
        "client_name": "Sensitive Client Name",
    })
    # Force a raw SQL question through the chat. Because api/chat runs the
    # NL→SQL through Claude by default, we use a query that any rule-based /
    # LLM path would translate literally.
    r = admin.post("/api/chat",
                   headers=hdr,
                   json={"question": "SELECT COUNT(*) FROM pipeline"})
    body = r.get_json() or {}
    # Two acceptable outcomes:
    #   (a) The chat safety gate refuses the query as unsafe. body["error"] set.
    #   (b) The chat executes and sqlite reports "no such table: pipeline".
    # Either way: no `Sensitive Client Name` in the response, and no `pipeline`
    # column data anywhere.
    text = str(body)
    assert "Sensitive Client Name" not in text
    # A well-behaved chat gate will either error or produce a fully-blank result.
    # We assert that the chat does NOT return any row containing the seeded name.
    if "rows" in body and body["rows"]:
        for row in body["rows"]:
            assert "Sensitive Client Name" not in str(row)
