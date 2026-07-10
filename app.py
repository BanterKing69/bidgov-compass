"""BidGov Compass — Flask backend for the tender aggregator dashboard."""

from __future__ import annotations

import io
import json
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from flask import (
    Flask, Response, jsonify, render_template, request, send_file, abort
)
from flask_login import login_required, current_user

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "collectors"))

import db  # noqa: E402
import chat as chat_mod  # noqa: E402
import auth  # noqa: E402

APP_ROOT = Path(__file__).resolve().parent
app = Flask(__name__, template_folder="templates", static_folder="static")
auth.init_app(app)

# --------------------------------------------------------------------------- #
# Scrape job state (in-memory; one job at a time)
# --------------------------------------------------------------------------- #
_scrape_lock = threading.Lock()
_scrape_state: dict = {
    "running": False, "started_at": None, "finished_at": None,
    "days_back": None, "log": [], "error": None,
    "before": {}, "after": {},
}


def _snapshot() -> dict:
    conn = db.connect()
    try:
        return db.stats(conn)
    finally:
        conn.close()


def _run_scrape(days_back: int, max_pages: int) -> None:
    global _scrape_state
    _scrape_state["log"] = []
    _scrape_state["error"] = None
    _scrape_state["before"] = _snapshot()
    _scrape_state["started_at"] = datetime.now(timezone.utc).isoformat()

    try:
        proc = subprocess.Popen(
            [sys.executable, str(APP_ROOT / "run.py"),
             "--days-back", str(days_back), "--max-pages", str(max_pages)],
            cwd=str(APP_ROOT), stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, bufsize=1,
        )
        assert proc.stdout is not None
        for line in proc.stdout:
            _scrape_state["log"].append(line.rstrip())
            _scrape_state["log"] = _scrape_state["log"][-500:]
        proc.wait()
        if proc.returncode != 0:
            _scrape_state["error"] = f"exit code {proc.returncode}"
    except Exception as exc:  # noqa: BLE001
        _scrape_state["error"] = str(exc)
    finally:
        _scrape_state["after"] = _snapshot()
        _scrape_state["finished_at"] = datetime.now(timezone.utc).isoformat()
        _scrape_state["running"] = False


# --------------------------------------------------------------------------- #
# Auth gate: every route except the auth blueprint, static files, and /health
# requires login. API endpoints return JSON 401; page routes redirect to login.
# --------------------------------------------------------------------------- #
_PUBLIC_PATHS = ("/auth/", "/static/", "/health")


@app.before_request
def _require_login():
    path = request.path or "/"
    if any(path == p or path.startswith(p) for p in _PUBLIC_PATHS):
        return None
    if current_user.is_authenticated:
        return None
    # JSON responses for API paths, redirect for page routes
    if path.startswith("/api/"):
        return jsonify({"error": "auth_required"}), 401
    from flask import redirect, url_for
    return redirect(url_for("auth.login", next=path))


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@app.route("/")
def home():
    return render_template("dashboard.html", user=current_user)


# --- filters + table ----------------------------------------------------- #
_ALLOWED_SORT = {
    # deadline
    "deadline":       "(deadline IS NULL), deadline ASC",
    "deadline_desc":  "(deadline IS NULL), deadline DESC",
    # value
    "value_desc":     "(value_amount IS NULL), value_amount DESC",
    "value_asc":      "(value_amount IS NULL), value_amount ASC",
    # published
    "published_desc": "(published_date IS NULL), published_date DESC",
    "published_asc":  "(published_date IS NULL), published_date ASC",
    # title / buyer / category / source
    "title_asc":      "title COLLATE NOCASE ASC",
    "title_desc":     "title COLLATE NOCASE DESC",
    "buyer_asc":      "(buyer_name IS NULL), buyer_name COLLATE NOCASE ASC",
    "buyer_desc":     "(buyer_name IS NULL), buyer_name COLLATE NOCASE DESC",
    "category_asc":   "(category IS NULL), category COLLATE NOCASE ASC",
    "category_desc":  "(category IS NULL), category COLLATE NOCASE DESC",
    "source_asc":     "source COLLATE NOCASE ASC",
    "source_desc":    "source COLLATE NOCASE DESC",
}


def _build_where(args) -> tuple[str, list]:
    clauses, params = [], []

    if args.get("open_only", "1") == "1":
        clauses.append("is_open = 1")

    cats = args.getlist("category")
    if cats:
        clauses.append(f"category IN ({','.join(['?']*len(cats))})")
        params.extend(cats)

    sources = args.getlist("source")
    if sources:
        clauses.append(f"source IN ({','.join(['?']*len(sources))})")
        params.extend(sources)

    vmin = args.get("value_min", type=float)
    vmax = args.get("value_max", type=float)
    if vmin is not None:
        clauses.append("value_amount >= ?"); params.append(vmin)
    if vmax is not None:
        clauses.append("value_amount <= ?"); params.append(vmax)

    dl_before = args.get("deadline_before")
    dl_after = args.get("deadline_after")
    if dl_after:
        clauses.append("deadline >= ?"); params.append(dl_after)
    if dl_before:
        clauses.append("deadline <= ?"); params.append(dl_before)

    q = args.get("q", "").strip()
    if q:
        clauses.append("(LOWER(title) LIKE ? OR LOWER(buyer_name) LIKE ?)")
        term = f"%{q.lower()}%"
        params.extend([term, term])

    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    return where, params


@app.route("/api/tenders")
def api_tenders():
    where, params = _build_where(request.args)
    sort = _ALLOWED_SORT.get(request.args.get("sort", "deadline"),
                             _ALLOWED_SORT["deadline"])
    limit = min(int(request.args.get("limit", 500)), 5000)
    cols = ("uid,source,title,category,cpv_code,buyer_name,buyer_region,"
            "value_amount,value_currency,published_date,deadline,status,"
            "is_open,notice_url")
    conn = db.connect()
    try:
        cur = conn.execute(
            f"SELECT {cols} FROM tenders {where} ORDER BY {sort} LIMIT ?",
            [*params, limit],
        )
        col_names = [d[0] for d in cur.description]
        rows = [dict(zip(col_names, r)) for r in cur.fetchall()]
        total_cur = conn.execute(f"SELECT COUNT(*) FROM tenders {where}", params)
        total = total_cur.fetchone()[0]
    finally:
        conn.close()
    return jsonify({"total": total, "returned": len(rows), "rows": rows})


@app.route("/api/facets")
def api_facets():
    conn = db.connect()
    try:
        cats = [r[0] for r in conn.execute(
            "SELECT DISTINCT category FROM tenders WHERE category IS NOT NULL "
            "ORDER BY category").fetchall()]
        sources = [r[0] for r in conn.execute(
            "SELECT DISTINCT source FROM tenders ORDER BY source").fetchall()]
        mx = conn.execute(
            "SELECT MIN(value_amount), MAX(value_amount) FROM tenders "
            "WHERE value_amount IS NOT NULL").fetchone()
    finally:
        conn.close()
    return jsonify({
        "categories": cats, "sources": sources,
        "value_min": mx[0] or 0, "value_max": mx[1] or 0,
    })


# --- stats for charts ---------------------------------------------------- #
@app.route("/api/stats")
def api_stats():
    where, params = _build_where(request.args)
    conn = db.connect()
    try:
        def q(sql):
            return conn.execute(sql, params).fetchall()

        by_cat = q(f"""
            SELECT COALESCE(category,'(unmapped)') AS k, COUNT(*) AS n,
                   ROUND(COALESCE(SUM(value_amount),0)) AS total_v
            FROM tenders {where}
            GROUP BY category ORDER BY n DESC""")
        by_source = q(f"""
            SELECT source AS k, COUNT(*) AS n
            FROM tenders {where}
            GROUP BY source ORDER BY n DESC""")
        by_value_band = q(f"""
            SELECT CASE
                WHEN value_amount IS NULL THEN 'Unknown'
                WHEN value_amount < 30000 THEN '< £30k'
                WHEN value_amount < 135000 THEN '£30k–£135k'
                WHEN value_amount < 300000 THEN '£135k–£300k'
                WHEN value_amount < 664000 THEN '£300k–£664k'
                ELSE '> £664k' END AS k,
                COUNT(*) AS n
            FROM tenders {where} GROUP BY k""")
        by_deadline = q(f"""
            SELECT CASE
                WHEN deadline IS NULL THEN 'No deadline'
                WHEN deadline <= date('now','+7 days') THEN 'This week'
                WHEN deadline <= date('now','+30 days') THEN 'This month'
                WHEN deadline <= date('now','+90 days') THEN '1–3 months'
                ELSE '3+ months' END AS k,
                COUNT(*) AS n
            FROM tenders {where} GROUP BY k""")
        totals = conn.execute(
            f"SELECT COUNT(*), SUM(is_open), "
            f"       ROUND(COALESCE(SUM(value_amount),0)), "
            f"       ROUND(COALESCE(AVG(value_amount),0)) "
            f"FROM tenders {where}", params).fetchone()
    finally:
        conn.close()

    def dictify(rows, keys=("k", "n")):
        return [dict(zip(keys, r)) for r in rows]

    return jsonify({
        "totals": {
            "notices": totals[0], "open": totals[1] or 0,
            "total_value": totals[2] or 0, "avg_value": totals[3] or 0,
        },
        "by_category": dictify(by_cat, ("k", "n", "total_v")),
        "by_source": dictify(by_source),
        "by_value_band": dictify(by_value_band),
        "by_deadline": dictify(by_deadline),
    })


# --- pivot data (raw denormalised rows, filtered) ------------------------ #
@app.route("/api/pivot")
def api_pivot():
    where, params = _build_where(request.args)
    conn = db.connect()
    try:
        cur = conn.execute(f"""
            SELECT source, COALESCE(category,'(unmapped)') AS category,
                   COALESCE(buyer_region,'(unspecified)') AS region,
                   COALESCE(country,'?') AS country,
                   value_amount,
                   substr(deadline,1,7) AS deadline_month,
                   CASE WHEN is_open=1 THEN 'Open' ELSE 'Closed' END AS status
            FROM tenders {where}""", params)
        cols = [d[0] for d in cur.description]
        rows = [list(r) for r in cur.fetchall()]
    finally:
        conn.close()
    return jsonify({"columns": cols, "rows": rows})


# --- scrape controls ----------------------------------------------------- #
@app.route("/api/scrape", methods=["POST"])
def api_scrape():
    global _scrape_state
    with _scrape_lock:
        if _scrape_state["running"]:
            return jsonify({"ok": False, "error": "A scrape is already running."}), 409
        payload = request.get_json(silent=True) or {}
        days_back = int(payload.get("days_back", 30))
        max_pages = int(payload.get("max_pages", 25))
        _scrape_state = {
            "running": True, "started_at": None, "finished_at": None,
            "days_back": days_back, "log": [], "error": None,
            "before": {}, "after": {},
        }
        threading.Thread(
            target=_run_scrape, args=(days_back, max_pages), daemon=True
        ).start()
    return jsonify({"ok": True, "days_back": days_back, "max_pages": max_pages})


@app.route("/api/scrape/status")
def api_scrape_status():
    return jsonify(_scrape_state)


# --- export -------------------------------------------------------------- #
@app.route("/api/export")
def api_export():
    fmt = request.args.get("format", "xlsx")
    where, params = _build_where(request.args)
    cols = ("source,title,category,cpv_code,cpv_description,buyer_name,"
            "buyer_region,country,value_amount,value_currency,"
            "published_date,deadline,status,is_open,notice_url,source_api_url")
    conn = db.connect()
    try:
        cur = conn.execute(
            f"SELECT {cols} FROM tenders {where} "
            f"ORDER BY (deadline IS NULL), deadline ASC",
            params,
        )
        col_names = [d[0] for d in cur.description]
        rows = cur.fetchall()
    finally:
        conn.close()

    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
    if fmt == "csv":
        buf = io.StringIO()
        import csv
        w = csv.writer(buf)
        w.writerow(col_names)
        w.writerows(rows)
        return Response(
            buf.getvalue(), mimetype="text/csv",
            headers={"Content-Disposition":
                     f'attachment; filename="bidgov-compass-{ts}.csv"'},
        )

    if fmt == "xlsx":
        try:
            from openpyxl import Workbook
            from openpyxl.styles import Font, PatternFill, Alignment
        except ImportError:
            abort(500, "openpyxl not installed on server.")
        wb = Workbook()
        ws = wb.active
        ws.title = "Tenders"
        ws.append(col_names)
        # header styling — GovBid palette
        header_fill = PatternFill("solid", fgColor="54565B")
        header_font = Font(name="Inter", bold=True, color="FFFFFF")
        for c in ws[1]:
            c.fill = header_fill; c.font = header_font
            c.alignment = Alignment(vertical="center")
        for r in rows:
            ws.append(list(r))
        ws.freeze_panes = "A2"
        for i, col in enumerate(col_names, 1):
            ws.column_dimensions[chr(64+i) if i < 27 else "A" + chr(64+i-26)].width = \
                max(12, min(40, len(col) + 4))
        buf = io.BytesIO()
        wb.save(buf); buf.seek(0)
        return send_file(
            buf,
            mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            as_attachment=True,
            download_name=f"bidgov-compass-{ts}.xlsx",
        )

    abort(400, f"Unknown format: {fmt}")


# --- chat --------------------------------------------------------------- #
@app.route("/api/chat", methods=["POST"])
def api_chat():
    payload = request.get_json(silent=True) or {}
    question = (payload.get("question") or "").strip()
    if not question:
        return jsonify({"error": "Empty question"}), 400
    conn = db.connect()
    try:
        result = chat_mod.answer(conn, question)
    finally:
        conn.close()
    return jsonify(result)


@app.route("/health")
def health():
    return jsonify({"ok": True, "ts": datetime.now(timezone.utc).isoformat()})


if __name__ == "__main__":
    port = int(__import__("os").environ.get("PORT", "5057"))
    print(f"\nBidGov Compass -> http://127.0.0.1:{port}\n")
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
