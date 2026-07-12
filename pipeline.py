"""
BidGov Compass — pipeline (deal-tracking) storage + fee economics (Phase 4).

The `pipeline` table lives in **users.db**, NOT tenders.db. Two reasons:
  1. Redeploying tender data (scrape refresh, DB restore) never wipes pipeline rows.
  2. The chat's SELECT-only gate opens a tenders-only connection — pipeline rows
     are physically unreachable through it, no policy code needed.

Schema (from spec §5):

    CREATE TABLE IF NOT EXISTS pipeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tender_uid TEXT NOT NULL UNIQUE,          -- FK by convention → tenders.uid
      client_name TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'qualified',  -- qualified|quoted|writing|submitted|won|lost
      fee_upfront REAL NOT NULL DEFAULT 1500,
      fee_success_pct REAL NOT NULL DEFAULT 5.0,
      outcome_value REAL,                       -- actual awarded £ if it differs
      notes TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );

Two-DB join at read time: tender_uid → look up tenders.uid in tenders.db.
We NEVER `ATTACH` — that would expose pipeline to chat's SQL. Join in Python.

Win-rate map (bottom of file) embedded verbatim from Tender_Analysis.xlsx
sheet "Sweet Spot" — 30 sweet-spot categories. Unmapped categories default
to WIN_RATE_DEFAULT (0.15) as a moderate prior.

  Expected £/deal = fee_upfront + (fee_success_pct/100) × value × win_rate

Derivations are NEVER stored; they're computed on read. If you tweak the
win-rate map (say, quarterly recalibration), no data migration is needed.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import auth  # for USERS_DB_PATH + DATA_DIR
import db as tenders_db  # for tender-info lookups

VALID_STAGES = ("qualified", "quoted", "writing", "submitted", "won", "lost")

# --------------------------------------------------------------------------- #
# Schema
# --------------------------------------------------------------------------- #
CREATE_PIPELINE_SQL = """
CREATE TABLE IF NOT EXISTS pipeline (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tender_uid TEXT NOT NULL UNIQUE,
    client_name TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT 'qualified',
    fee_upfront REAL NOT NULL DEFAULT 1500,
    fee_success_pct REAL NOT NULL DEFAULT 5.0,
    outcome_value REAL,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pipeline_stage ON pipeline(stage);
"""


def _conn() -> sqlite3.Connection:
    """Short-lived connection to users.db with the pipeline schema bootstrapped.
    Mirrors auth._conn — never share a connection across threads."""
    auth.DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(auth.USERS_DB_PATH)
    conn.executescript(CREATE_PIPELINE_SQL)
    return conn


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# --------------------------------------------------------------------------- #
# Two-DB join helper
# --------------------------------------------------------------------------- #
def _fetch_tender_info(uids: list[str]) -> dict[str, dict]:
    """Look up tender info from tenders.db for the given UIDs. Returns
    {uid: {title, buyer_name, category, value_amount, deadline, notice_url}}.
    Missing UIDs are simply not in the returned dict (a pipeline row can
    outlive a tender row if the store is re-scraped; UI shows "unknown")."""
    if not uids:
        return {}
    conn = tenders_db.connect()
    try:
        placeholders = ",".join("?" for _ in uids)
        cur = conn.execute(
            f"SELECT uid, title, buyer_name, category, value_amount, "
            f"deadline, notice_url "
            f"FROM tenders WHERE uid IN ({placeholders})",
            uids,
        )
        cols = [d[0] for d in cur.description]
        return {r[0]: dict(zip(cols, r)) for r in cur.fetchall()}
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# CRUD
# --------------------------------------------------------------------------- #
def list_pipeline() -> list[dict]:
    """Return all pipeline rows, joined with tender info, plus derived economics."""
    conn = _conn()
    try:
        cur = conn.execute(
            "SELECT id, tender_uid, client_name, stage, fee_upfront, "
            "       fee_success_pct, outcome_value, notes, created_at, updated_at "
            "FROM pipeline ORDER BY updated_at DESC"
        )
        cols = [d[0] for d in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    finally:
        conn.close()
    if not rows:
        return []
    tender_info = _fetch_tender_info([r["tender_uid"] for r in rows])
    for r in rows:
        r["tender"] = tender_info.get(r["tender_uid"]) or {}
        r["success_fee"] = _success_fee(r)
        r["expected_value"] = _expected_value_per_deal(r)
    return rows


def create_pipeline_row(*, tender_uid: str, client_name: str = "",
                        stage: str = "qualified",
                        fee_upfront: float = 1500.0,
                        fee_success_pct: float = 5.0,
                        outcome_value: Optional[float] = None,
                        notes: str = "") -> tuple[Optional[int], Optional[str]]:
    if not tender_uid or not tender_uid.strip():
        return None, "tender_uid required"
    # client_name is optional at creation — the "Save deal" button on tender
    # rows saves with an empty name; the admin fills it in inline on the
    # Pipeline tab where they have the deal context to hand.
    if stage not in VALID_STAGES:
        return None, f"invalid stage; must be one of {VALID_STAGES}"
    now = _now_iso()
    conn = _conn()
    try:
        try:
            cur = conn.execute(
                "INSERT INTO pipeline (tender_uid, client_name, stage, "
                "fee_upfront, fee_success_pct, outcome_value, notes, "
                "created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (tender_uid.strip(), client_name.strip(), stage,
                 float(fee_upfront), float(fee_success_pct),
                 (float(outcome_value) if outcome_value is not None else None),
                 notes or "", now, now),
            )
            conn.commit()
            return cur.lastrowid, None
        except sqlite3.IntegrityError:
            return None, "already tracked"
    finally:
        conn.close()


ALLOWED_UPDATE_FIELDS = {
    "client_name", "stage", "fee_upfront", "fee_success_pct",
    "outcome_value", "notes",
}


def update_pipeline_row(row_id: int, patch: dict) -> tuple[bool, Optional[str]]:
    fields = {k: v for k, v in patch.items() if k in ALLOWED_UPDATE_FIELDS}
    if not fields:
        return False, "nothing to update"
    if "stage" in fields and fields["stage"] not in VALID_STAGES:
        return False, f"invalid stage; must be one of {VALID_STAGES}"
    fields["updated_at"] = _now_iso()
    sets = ", ".join(f"{k}=?" for k in fields)
    params = list(fields.values()) + [row_id]
    conn = _conn()
    try:
        cur = conn.execute(f"UPDATE pipeline SET {sets} WHERE id=?", params)
        conn.commit()
        return cur.rowcount > 0, None
    finally:
        conn.close()


def delete_pipeline_row(row_id: int) -> bool:
    conn = _conn()
    try:
        cur = conn.execute("DELETE FROM pipeline WHERE id=?", (row_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# Economics
# --------------------------------------------------------------------------- #
def _fee_value(row: dict) -> Optional[float]:
    """Best-known value to base the 5% success fee on: outcome_value if a
    deal is won and an actual awarded £ was captured; else the tender's
    published value; else None."""
    if row.get("outcome_value") is not None:
        return float(row["outcome_value"])
    v = (row.get("tender") or {}).get("value_amount")
    return float(v) if v is not None else None


def _success_fee(row: dict) -> float:
    v = _fee_value(row)
    if v is None or v <= 0:
        return 0.0
    return (float(row["fee_success_pct"]) / 100.0) * v


def _expected_value_per_deal(row: dict) -> float:
    """Expected £ = fee_upfront + fee_success_pct% × value × win_rate
    Uses the category-mapped win-rate from Tender_Analysis.xlsx.
    Falls back to WIN_RATE_DEFAULT when the tender's category isn't mapped."""
    upfront = float(row.get("fee_upfront") or 0.0)
    v = _fee_value(row)
    if v is None or v <= 0:
        return upfront
    cat = (row.get("tender") or {}).get("category")
    win_rate = win_rate_for(cat)
    return upfront + (float(row["fee_success_pct"]) / 100.0) * v * win_rate


def compute_overview() -> dict:
    """Aggregate the Overview KPIs + funnel + fees-by-category chart data.
    All numbers derived from pipeline + tender join at read time — never stored."""
    rows = list_pipeline()
    revenue_booked = 0.0
    pipeline_unweighted = 0.0
    expected_per_deal_sum = 0.0
    funnel = {s: 0 for s in VALID_STAGES}
    by_category: dict[str, float] = {}
    for r in rows:
        funnel[r["stage"]] = funnel.get(r["stage"], 0) + 1
        cat = (r.get("tender") or {}).get("category") or "(unmapped)"
        exp = _expected_value_per_deal(r)
        expected_per_deal_sum += exp
        by_category[cat] = by_category.get(cat, 0.0) + exp
        if r["stage"] == "won":
            revenue_booked += float(r.get("fee_upfront") or 0.0) + _success_fee(r)
        else:
            # "Open" = anything not won/lost — success-fee pipeline is the 5% × value
            # of all deals still in play (spec §5: labelled *unweighted*).
            if r["stage"] != "lost":
                pipeline_unweighted += _success_fee(r)
    return {
        "revenue_booked":       round(revenue_booked, 2),
        "pipeline_unweighted":  round(pipeline_unweighted, 2),
        "expected_per_deal":    (round(expected_per_deal_sum / len(rows), 2) if rows else 0.0),
        "deal_count":           len(rows),
        "funnel":               [{"stage": s, "count": funnel[s]} for s in VALID_STAGES],
        "fees_by_category":     sorted(
            [{"category": k, "expected": round(v, 2)} for k, v in by_category.items()],
            key=lambda x: -x["expected"],
        ),
    }


# --------------------------------------------------------------------------- #
# Category win-rate map (Tender_Analysis.xlsx — sheet "Sweet Spot")
# ---------------------------------------------------------------------------
# The 30 sweet-spot categories, each with an empirical win-rate that drives
# expected £/deal on the Overview tab. Values from Tender_Analysis.xlsx
# (last recalibrated: at project start). Unmapped categories fall through
# to WIN_RATE_DEFAULT.
#
# To tweak: edit inline (this is a constant, not a settings row) and add a
# short justification comment. No data migration ever needed.
# --------------------------------------------------------------------------- #
WIN_RATE_DEFAULT = 0.15   # moderate prior for unmapped categories

WIN_RATES: dict[str, float] = {
    "Cleaning Services":            0.21,
    "Professional / Consultancy":   0.18,
    "IT Hardware":                  0.18,
    "Building Maintenance":         0.18,
    "Training & Learning":          0.23,
    "Office Furniture":             0.23,
    "Grounds Maintenance":          0.23,
    "Translation & Interpreting":   0.20,
    "Waste Management":             0.18,
    "Transport / Logistics":        0.18,
    "Catering Supplies / Food":     0.18,
    "Security Services":            0.16,
    "Catering Services":            0.16,
    "Uniforms & Workwear":          0.23,
    "Software & Licensing":         0.15,
    "Marketing & Comms":            0.23,
    "Legal Services":               0.15,
    "Temp Staffing / Recruitment":  0.13,
    "IT Managed Services":          0.13,
    "Electrical / M&E":             0.13,
    "PPE & Medical Consumables":    0.18,
    "Signage & Print":              0.25,
    "Vehicles & Fleet":             0.15,
    "Stationery & Supplies":        0.23,
    "Lab / Scientific Equipment":   0.15,
    "Financial / Audit":            0.13,
    "Health & Social Care":         0.11,
    "Facilities Mgmt (bundled)":    0.08,
    "Construction / Refurb":        0.08,
    "Highways / Civils":            0.08,
}


def win_rate_for(category: Optional[str]) -> float:
    """Look up win-rate; case-insensitive fallback; default for unmapped."""
    if not category:
        return WIN_RATE_DEFAULT
    if category in WIN_RATES:
        return WIN_RATES[category]
    # case-insensitive fallback
    ck = category.strip().lower()
    for k, v in WIN_RATES.items():
        if k.lower() == ck:
            return v
    return WIN_RATE_DEFAULT
