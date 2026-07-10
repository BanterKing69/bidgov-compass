"""
Text-to-SQL chat for the tenders table.

Two backends, selected automatically:
  * `anthropic` — if `ANTHROPIC_API_KEY` is set, Claude turns the question into
    a single SELECT statement against the `tenders` table.
  * `rules`    — otherwise, a small pattern matcher covers the most common
    questions (counts, top-N by value, deadlines this week, category filters).

Both paths run the SQL through the same safety gate:
  * SELECT only, no PRAGMA / ATTACH / write ops
  * one statement, LIMIT 200 max
  * schema is pinned; no dynamic table access
"""

from __future__ import annotations

import os
import re
import sqlite3
from typing import Any

# --------------------------------------------------------------------------- #
# Schema exposed to the chat (kept in sync with schema.py)
# --------------------------------------------------------------------------- #
SCHEMA_HINT = """\
Table: tenders
Columns:
  source (TEXT)               -- 'Find a Tender' | 'Contracts Finder' | 'Public Contracts Scotland' | 'TED'
  title (TEXT)                -- opportunity title
  description (TEXT)
  category (TEXT)             -- one of 30 sweet-spot categories, may be NULL
  cpv_code, cpv_description
  buyer_name, buyer_region, country
  value_amount (REAL)         -- contract value; may be NULL
  value_currency (TEXT)       -- typically 'GBP' or 'EUR'
  published_date (TEXT)       -- ISO 8601
  deadline (TEXT)             -- ISO 8601 submission deadline, may be NULL
  status (TEXT)
  is_open (INTEGER)           -- 1 = deadline in future, 0 otherwise
  notice_url (TEXT)
Rules:
  * Prefer `is_open = 1` unless the user asks about closed / historical notices.
  * NULL value_amount rows should be excluded from value-based queries.
  * Date filters: use string comparison on ISO dates (`deadline >= date('now')`).
"""

CATEGORIES = [
    "Office Furniture", "Stationery & Supplies", "IT Hardware",
    "Software & Licensing", "PPE & Medical Consumables", "Uniforms & Workwear",
    "Catering Supplies / Food", "Vehicles & Fleet", "Signage & Print",
    "Lab / Scientific Equipment", "Cleaning Services", "Catering Services",
    "Facilities Mgmt (bundled)", "Security Services", "Grounds Maintenance",
    "Waste Management", "IT Managed Services", "Professional / Consultancy",
    "Marketing & Comms", "Training & Learning", "Translation & Interpreting",
    "Temp Staffing / Recruitment", "Legal Services", "Financial / Audit",
    "Health & Social Care", "Transport / Logistics", "Building Maintenance",
    "Construction / Refurb", "Electrical / M&E", "Highways / Civils",
    # Added as 31st sweet-spot: distinct energy/fuel/utilities procurement lane
    "Energy & Utilities",
]


# --------------------------------------------------------------------------- #
# Safety gate
# --------------------------------------------------------------------------- #
_FORBIDDEN = re.compile(
    r"\b(insert|update|delete|drop|alter|attach|detach|pragma|create|replace|"
    r"vacuum|reindex|analyze)\b",
    re.IGNORECASE,
)


def _sanitize_sql(sql: str) -> str:
    sql = sql.strip().rstrip(";").strip()
    if ";" in sql:
        raise ValueError("Only one statement is allowed.")
    if _FORBIDDEN.search(sql):
        raise ValueError("Only SELECT queries are allowed.")
    if not re.match(r"^\s*select\b", sql, re.IGNORECASE) and \
       not re.match(r"^\s*with\b", sql, re.IGNORECASE):
        raise ValueError("Query must start with SELECT (or WITH ... SELECT).")
    if not re.search(r"\blimit\b", sql, re.IGNORECASE):
        sql += " LIMIT 200"
    return sql


def run_sql(conn: sqlite3.Connection, sql: str) -> tuple[list[str], list[list[Any]]]:
    safe = _sanitize_sql(sql)
    cur = conn.execute(safe)
    cols = [d[0] for d in cur.description] if cur.description else []
    rows = cur.fetchall()
    return cols, [list(r) for r in rows]


# --------------------------------------------------------------------------- #
# Rule-based fallback (no API key needed)
# --------------------------------------------------------------------------- #
_RULES = [
    # ----- counts ---------------------------------------------------------
    (re.compile(r"^\s*how many\b.*\bopen\b", re.I),
     "SELECT COUNT(*) AS open_notices FROM tenders WHERE is_open = 1"),
    (re.compile(r"^\s*how many\b", re.I),
     "SELECT COUNT(*) AS total_notices FROM tenders"),

    # ----- biggest / smallest --------------------------------------------
    (re.compile(r"\b(biggest|largest|highest value|top .* value)\b", re.I),
     "SELECT title, buyer_name, category, value_amount, deadline, notice_url "
     "FROM tenders WHERE is_open = 1 AND value_amount IS NOT NULL "
     "ORDER BY value_amount DESC LIMIT 20"),
    (re.compile(r"\b(smallest|lowest value|cheapest)\b", re.I),
     "SELECT title, buyer_name, category, value_amount, deadline, notice_url "
     "FROM tenders WHERE is_open = 1 AND value_amount > 0 "
     "ORDER BY value_amount ASC LIMIT 20"),

    # ----- deadline windows ----------------------------------------------
    (re.compile(r"\b(closing today|due today|today'?s deadline)\b", re.I),
     "SELECT title, buyer_name, category, value_amount, deadline, notice_url "
     "FROM tenders WHERE is_open = 1 AND deadline <= date('now','+1 day') "
     "ORDER BY deadline LIMIT 30"),
    (re.compile(r"\b(closing.*(week|7 days)|deadline.*week|this week)\b", re.I),
     "SELECT title, buyer_name, category, value_amount, deadline, notice_url "
     "FROM tenders WHERE is_open = 1 AND deadline <= date('now','+7 days') "
     "ORDER BY deadline LIMIT 30"),
    (re.compile(r"\b(closing.*(month|30 days)|deadline.*month|this month)\b", re.I),
     "SELECT title, buyer_name, category, value_amount, deadline, notice_url "
     "FROM tenders WHERE is_open = 1 AND deadline <= date('now','+30 days') "
     "ORDER BY deadline LIMIT 40"),
    (re.compile(r"\bclosing\s+(soon|next)\b", re.I),
     "SELECT title, buyer_name, category, value_amount, deadline, notice_url "
     "FROM tenders WHERE is_open = 1 AND deadline <= date('now','+14 days') "
     "ORDER BY deadline LIMIT 30"),

    # ----- newest / recently published -----------------------------------
    (re.compile(r"\b(newest|latest|most recent|just published|new notices?)\b", re.I),
     "SELECT title, buyer_name, category, value_amount, published_date, notice_url "
     "FROM tenders ORDER BY published_date DESC LIMIT 30"),

    # ----- aggregates ----------------------------------------------------
    (re.compile(r"\b(avg|average|mean)\b.*\bvalue\b", re.I),
     "SELECT ROUND(AVG(value_amount),0) AS avg_value_gbp "
     "FROM tenders WHERE is_open = 1 AND value_amount IS NOT NULL"),
    (re.compile(r"\b(median)\b.*\bvalue\b", re.I),
     "WITH ranked AS (SELECT value_amount, ROW_NUMBER() OVER (ORDER BY value_amount) rn, "
     "COUNT(*) OVER () c FROM tenders WHERE is_open=1 AND value_amount IS NOT NULL) "
     "SELECT ROUND(AVG(value_amount),0) AS median_value_gbp FROM ranked "
     "WHERE rn IN ((c+1)/2, (c+2)/2)"),
    (re.compile(r"\b(total|sum)\b.*\bvalue\b", re.I),
     "SELECT ROUND(SUM(value_amount),0) AS total_value_gbp "
     "FROM tenders WHERE is_open = 1 AND value_amount IS NOT NULL"),

    # ----- group-by pivots ------------------------------------------------
    (re.compile(r"\b(by|per|breakdown|split .* by)\s+category\b", re.I),
     "SELECT COALESCE(category,'(unmapped)') AS category, COUNT(*) AS open_count, "
     "ROUND(AVG(value_amount),0) AS avg_value, "
     "ROUND(SUM(value_amount),0) AS total_value "
     "FROM tenders WHERE is_open = 1 GROUP BY category "
     "ORDER BY open_count DESC LIMIT 40"),
    (re.compile(r"\b(by|per|top)\s+buyer\b", re.I),
     "SELECT buyer_name, COUNT(*) AS open_count, "
     "ROUND(SUM(value_amount),0) AS total_value "
     "FROM tenders WHERE is_open = 1 GROUP BY buyer_name "
     "ORDER BY open_count DESC LIMIT 30"),
    (re.compile(r"\b(by|per)\s+source\b", re.I),
     "SELECT source, COUNT(*) AS notices, SUM(is_open) AS open "
     "FROM tenders GROUP BY source ORDER BY notices DESC"),
    (re.compile(r"\b(by|per)\s+(region|country|nation)\b", re.I),
     "SELECT COALESCE(country,'(?)') AS country, COUNT(*) AS open_count "
     "FROM tenders WHERE is_open = 1 GROUP BY country ORDER BY open_count DESC"),
    (re.compile(r"\b(by|per)\s+(month|deadline month)\b", re.I),
     "SELECT substr(deadline,1,7) AS month, COUNT(*) AS open_count "
     "FROM tenders WHERE is_open = 1 AND deadline IS NOT NULL "
     "GROUP BY month ORDER BY month"),

    # ----- sweet-spot ----------------------------------------------------
    (re.compile(r"\b(sweet\s*[-_]?\s*spot|£?50k[-–]£?300k|winnable)\b", re.I),
     "SELECT title, buyer_name, category, value_amount, deadline, notice_url "
     "FROM tenders WHERE is_open = 1 "
     "AND value_amount BETWEEN 50000 AND 300000 "
     "ORDER BY (deadline IS NULL), deadline LIMIT 50"),

    # ----- value-band filters --------------------------------------------
    (re.compile(r"\bunder\s*£?\s*(\d+)k\b", re.I),
     None),  # handled in _dynamic_rule below (needs value)
    (re.compile(r"\bover\s*£?\s*(\d+)k\b", re.I),
     None),
    (re.compile(r"\bbetween\s*£?\s*(\d+)k\s*(?:and|-|–|to)\s*£?\s*(\d+)k\b", re.I),
     None),

    # ----- buyer/region text search --------------------------------------
    (re.compile(r"\b(in|from|for|at)\s+(?:the\s+)?(nhs|council|university|police|"
                r"ministry|home office|hmrc|army|navy|raf|scottish|welsh|"
                r"cumbria|london|manchester|birmingham|edinburgh|glasgow|"
                r"cardiff|belfast|liverpool|leeds|bristol|sheffield)\b", re.I),
     None),  # handled in _dynamic_rule
]


# --------------------------------------------------------------------------- #
# Dynamic (parameterised) rule matches
# --------------------------------------------------------------------------- #
def _dynamic_rule(question: str) -> str | None:
    q = question.strip()

    # "under £Xk"
    m = re.search(r"\bunder\s*£?\s*(\d+)\s*k\b", q, re.I)
    if m:
        v = int(m.group(1)) * 1000
        return (
            f"SELECT title, buyer_name, category, value_amount, deadline, notice_url "
            f"FROM tenders WHERE is_open=1 AND value_amount <= {v} AND value_amount > 0 "
            f"ORDER BY (deadline IS NULL), deadline LIMIT 50"
        )
    # "over £Xk" / "above £Xk"
    m = re.search(r"\b(?:over|above|more than)\s*£?\s*(\d+)\s*k\b", q, re.I)
    if m:
        v = int(m.group(1)) * 1000
        return (
            f"SELECT title, buyer_name, category, value_amount, deadline, notice_url "
            f"FROM tenders WHERE is_open=1 AND value_amount >= {v} "
            f"ORDER BY value_amount DESC LIMIT 50"
        )
    # "between £Xk and £Yk"
    m = re.search(r"\bbetween\s*£?\s*(\d+)\s*k\s*(?:and|-|–|to)\s*£?\s*(\d+)\s*k\b",
                  q, re.I)
    if m:
        lo, hi = sorted([int(m.group(1)) * 1000, int(m.group(2)) * 1000])
        return (
            f"SELECT title, buyer_name, category, value_amount, deadline, notice_url "
            f"FROM tenders WHERE is_open=1 AND value_amount BETWEEN {lo} AND {hi} "
            f"ORDER BY (deadline IS NULL), deadline LIMIT 50"
        )
    # buyer keyword ("NHS", "council", city names, etc.)
    m = re.search(
        r"\b(?:in|from|for|at)\s+(?:the\s+)?"
        r"(nhs|council|university|police|ministry|home office|hmrc|army|navy|raf|"
        r"scottish|welsh|cumbria|london|manchester|birmingham|edinburgh|glasgow|"
        r"cardiff|belfast|liverpool|leeds|bristol|sheffield|"
        r"[a-z][a-z\s&]{3,30})\b",
        q, re.I,
    )
    if m:
        term = m.group(1).strip().lower().replace("'", "''")
        return (
            f"SELECT title, buyer_name, category, value_amount, deadline, notice_url "
            f"FROM tenders WHERE is_open=1 "
            f"AND (LOWER(buyer_name) LIKE '%{term}%' OR LOWER(buyer_region) LIKE '%{term}%') "
            f"ORDER BY (deadline IS NULL), deadline LIMIT 50"
        )
    return None


def _norm(s: str) -> str:
    """Normalise for fuzzy category matching: lowercase, collapse spaces &
    strip punctuation like '/' and '&' so 'construction/refurb', 'Construction
    Refurb', and 'Construction / Refurb' all match."""
    return re.sub(r"[\s/&\-_]+", " ", s.lower()).strip()


# Short keywords -> canonical sweet-spot category. Lets the user type "PPE"
# instead of "PPE & Medical Consumables", "M&E" instead of "Electrical / M&E".
CATEGORY_SHORTCUTS = {
    "ppe": "PPE & Medical Consumables",
    "medical": "PPE & Medical Consumables",
    "pharma": "PPE & Medical Consumables",
    "uniform": "Uniforms & Workwear",
    "workwear": "Uniforms & Workwear",
    "furniture": "Office Furniture",
    "stationery": "Stationery & Supplies",
    "hardware": "IT Hardware",
    "software": "Software & Licensing",
    "licensing": "Software & Licensing",
    "cleaning": "Cleaning Services",
    "catering food": "Catering Supplies / Food",
    "food": "Catering Supplies / Food",
    "catering": "Catering Services",
    "signage": "Signage & Print",
    "print": "Signage & Print",
    "lab": "Lab / Scientific Equipment",
    "scientific": "Lab / Scientific Equipment",
    "vehicles": "Vehicles & Fleet",
    "fleet": "Vehicles & Fleet",
    "security": "Security Services",
    "grounds": "Grounds Maintenance",
    "waste": "Waste Management",
    "recycling": "Waste Management",
    "it managed": "IT Managed Services",
    "managed services": "IT Managed Services",
    "consultancy": "Professional / Consultancy",
    "professional": "Professional / Consultancy",
    "marketing": "Marketing & Comms",
    "comms": "Marketing & Comms",
    "advertising": "Marketing & Comms",
    "pr": "Marketing & Comms",
    "training": "Training & Learning",
    "learning": "Training & Learning",
    "translation": "Translation & Interpreting",
    "interpreting": "Translation & Interpreting",
    "staffing": "Temp Staffing / Recruitment",
    "recruitment": "Temp Staffing / Recruitment",
    "temp": "Temp Staffing / Recruitment",
    "legal": "Legal Services",
    "audit": "Financial / Audit",
    "financial": "Financial / Audit",
    "accounting": "Financial / Audit",
    "healthcare": "Health & Social Care",
    "care": "Health & Social Care",
    "social care": "Health & Social Care",
    "nhs": "Health & Social Care",
    "transport": "Transport / Logistics",
    "logistics": "Transport / Logistics",
    "haulage": "Transport / Logistics",
    "maintenance": "Building Maintenance",
    "repairs": "Building Maintenance",
    "hvac": "Electrical / M&E",
    "m&e": "Electrical / M&E",
    "mechanical": "Electrical / M&E",
    "electrical": "Electrical / M&E",
    "construction": "Construction / Refurb",
    "refurb": "Construction / Refurb",
    "build": "Construction / Refurb",
    "highways": "Highways / Civils",
    "civils": "Highways / Civils",
    "roads": "Highways / Civils",
    "fm": "Facilities Mgmt (bundled)",
    "facilities": "Facilities Mgmt (bundled)",
    "energy": "Energy & Utilities",
    "utilities": "Energy & Utilities",
    "fuel": "Energy & Utilities",
    "electricity": "Energy & Utilities",
    "gas": "Energy & Utilities",
    "solar": "Energy & Utilities",
}


def _category_filter_rule(question: str) -> str | None:
    """Detect '... <category> ...' style questions.

    Two-pass matcher:
      1. Full canonical name substring (longest-first, so "Construction /
         Refurb" wins over "Refurb" alone).
      2. Short keyword shortcut (e.g. "PPE" -> PPE & Medical Consumables).
    """
    qn = _norm(question)

    # 1. full canonical category names (longest-first)
    for cat in sorted(CATEGORIES, key=len, reverse=True):
        if _norm(cat) in qn:
            return _cat_sql(cat)

    # 2. short keyword shortcuts (longest-first for multi-word keys).
    # Both sides are already normalised via _norm() so "M&E" and "m e" match.
    for kw, cat in sorted(CATEGORY_SHORTCUTS.items(), key=lambda p: -len(p[0])):
        kw_norm = _norm(kw)
        # word-boundary match to avoid false positives ("care" in "welfare")
        if re.search(rf"(?:^|\s){re.escape(kw_norm)}(?:$|\s)", qn):
            return _cat_sql(cat)
    return None


def _cat_sql(cat: str) -> str:
    return (
        f"SELECT title, buyer_name, value_amount, deadline, notice_url "
        f"FROM tenders WHERE is_open = 1 AND category = "
        f"'{cat.replace(chr(39), chr(39)+chr(39))}' "
        f"ORDER BY (deadline IS NULL), deadline LIMIT 50"
    )


def rule_based_answer(question: str) -> tuple[str, str]:
    """Return (sql, human_intro). Raises ValueError if nothing matches.

    Resolution order:
      1. Category name mentioned (most specific)
      2. Dynamic value/buyer parameterised rules
      3. Static intent patterns (counts, top-N, group-by, etc.)
    """
    cat_sql = _category_filter_rule(question)
    if cat_sql:
        return cat_sql, "Filtering by the category mentioned:"

    dyn_sql = _dynamic_rule(question)
    if dyn_sql:
        return dyn_sql, "Interpreted a value / buyer / region filter:"

    for pattern, sql in _RULES:
        if sql is not None and pattern.search(question):
            return sql, "Answering with a rule-based match:"

    raise ValueError(
        "I couldn't turn that into a query. Try things like 'how many "
        "open tenders?', 'biggest deals', 'closing this week', 'by category', "
        "'by buyer', 'under £100k', 'over £500k', 'between £50k and £300k', "
        "'in NHS', 'sweet-spot', or mention a category by name."
    )


# --------------------------------------------------------------------------- #
# Anthropic backend (if ANTHROPIC_API_KEY set)
# --------------------------------------------------------------------------- #
_SYSTEM_PROMPT = f"""You convert plain-English questions into a SINGLE SQLite
SELECT statement over the tenders table below. Return ONLY the SQL — no
explanation, no code fences.

{SCHEMA_HINT}

Rules:
- One statement, SELECT (or WITH...SELECT) only.
- Include a LIMIT (max 200).
- Prefer WHERE is_open = 1 unless the user asks about closed/historical data.
- Use SQLite date functions (date('now', ...)) for relative dates.
- If the question is vague, default to the most useful table view with title,
  buyer_name, category, value_amount, deadline, notice_url."""


def anthropic_sql(question: str) -> str:
    import anthropic
    client = anthropic.Anthropic()
    resp = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=400,
        system=_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": question}],
    )
    text = "".join(getattr(b, "text", "") for b in resp.content).strip()
    # strip accidental code fences
    text = re.sub(r"^```(?:sql)?\s*|\s*```$", "", text, flags=re.M).strip()
    return text


# --------------------------------------------------------------------------- #
# Public entry point
# --------------------------------------------------------------------------- #
def answer(conn: sqlite3.Connection, question: str) -> dict:
    """Return {sql, columns, rows, intro, engine}."""
    question = (question or "").strip()
    if not question:
        return {"error": "Empty question."}

    engine = "rules"
    intro = ""
    try:
        if os.environ.get("ANTHROPIC_API_KEY"):
            sql = anthropic_sql(question)
            engine = "claude"
            intro = "Claude turned this into SQL for you:"
        else:
            sql, intro = rule_based_answer(question)
    except Exception as exc:  # noqa: BLE001
        # If Claude misfires, try the rule fallback before giving up
        try:
            sql, intro = rule_based_answer(question)
            engine = "rules (Claude fallback)"
        except Exception as inner:  # noqa: BLE001
            return {"error": f"{exc}. Fallback: {inner}"}

    try:
        cols, rows = run_sql(conn, sql)
    except Exception as exc:  # noqa: BLE001
        return {"error": f"SQL error: {exc}", "sql": sql, "engine": engine}

    return {
        "sql": sql, "columns": cols, "rows": rows,
        "intro": intro, "engine": engine,
        "follow_ups": _suggest_follow_ups(question, cols, rows),
        "chart": _chart_hint(cols, rows),
    }


# --------------------------------------------------------------------------- #
# Follow-up suggestions + auto-chart hint
# --------------------------------------------------------------------------- #
def _suggest_follow_ups(question: str, cols: list[str], rows: list[list]) -> list[str]:
    """Small heuristic list of natural next questions the user could ask."""
    ql = question.lower()
    if not rows:
        return ["show me any open tenders", "how many open tenders?", "biggest deals"]
    # aggregate result (< ~50 rows, 2-3 cols) -> offer drill-down
    if len(cols) <= 3 and len(rows) <= 60:
        suggestions = []
        if "category" in cols:
            top = rows[0][0] if rows else None
            if top and top != "(unmapped)":
                suggestions.append(f"show me open {top} tenders")
        if "buyer_name" in cols:
            top = rows[0][0] if rows else None
            if top:
                suggestions.append(f"in {top}")
        suggestions += ["closing this week", "biggest deals", "sweet-spot"]
        return suggestions[:4]
    # detail list -> offer aggregates
    return ["by category", "by buyer", "average value", "closing this week"]


def _chart_hint(cols: list[str], rows: list[list]) -> dict | None:
    """If the result looks like an aggregate (label + count), return a hint the
    frontend can use to render an inline bar chart above the table."""
    if not rows or len(cols) < 2 or len(rows) > 30:
        return None
    label_col, value_col = cols[0], cols[1]
    # value col must be numeric
    for r in rows:
        if r[1] is None:
            continue
        if not isinstance(r[1], (int, float)):
            return None
    labels = [str(r[0]) if r[0] is not None else "(none)" for r in rows]
    values = [float(r[1]) if r[1] is not None else 0.0 for r in rows]
    return {
        "type": "bar",
        "label_col": label_col,
        "value_col": value_col,
        "labels": labels,
        "values": values,
    }
