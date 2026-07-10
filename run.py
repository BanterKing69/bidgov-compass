#!/usr/bin/env python3
"""
Orchestrator: run every collector, normalise into one schema, store in SQLite,
and export a browsable CSV of open/live opportunities.

Usage:
    python3 run.py                      # all sources, last 30 days
    python3 run.py --days-back 7
    python3 run.py --sources fts,cf,pcs
    python3 run.py --all-statuses       # keep closed/award notices too in CSV

Sources: fts (Find a Tender), cf (Contracts Finder), pcs (Public Contracts
Scotland), s2w (Sell2Wales), ted (TED / EU).
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "collectors"))

import db  # noqa: E402
from base import HttpClient  # noqa: E402
from collectors.ocds import find_a_tender, contracts_finder  # noqa: E402
from collectors.ted import ted  # noqa: E402
from collectors.devolved import PublicContractsScotland, Sell2Wales  # noqa: E402


def build_collectors(selected: set[str], days_back: int, http: HttpClient,
                     chunk_days: int, page_limit: int):
    registry = {
        "fts": lambda: find_a_tender(
            days_back=days_back, http=http,
            chunk_days=chunk_days, page_limit=page_limit,
        ),
        "cf":  lambda: contracts_finder(
            days_back=days_back, http=http,
            chunk_days=chunk_days, page_limit=page_limit,
        ),
        "pcs": lambda: PublicContractsScotland(http=http),
        "s2w": lambda: Sell2Wales(http=http),
        "ted": lambda: ted(days_back=days_back, http=http),
    }
    return [(k, registry[k]()) for k in registry if k in selected]


def main():
    ap = argparse.ArgumentParser(description="UK/EU tender aggregator")
    ap.add_argument("--days-back", type=int, default=30)
    ap.add_argument("--sources", default="fts,cf,pcs,s2w,ted",
                    help="comma list: fts,cf,pcs,s2w,ted")
    ap.add_argument("--max-pages", type=int, default=25,
                    help="max API pages per paginated source; 0 = NO CAP "
                         "(collect until the source runs out of pages)")
    ap.add_argument("--chunk-days", type=int, default=30,
                    help="split the target window into chunks of this many "
                         "days (only FTS + Contracts Finder). Smaller chunks = "
                         "more resilient to gateway timeouts.")
    ap.add_argument("--page-limit", type=int, default=50,
                    help="records per API page (FTS + CF). Smaller = more "
                         "stable on flaky upstream gateways.")
    ap.add_argument("--flush-every", type=int, default=50,
                    help="flush the in-memory batch to SQLite every N records "
                         "(matches --page-limit for per-page persistence).")
    ap.add_argument("--all-statuses", action="store_true",
                    help="export all notices, not just open/live")
    ap.add_argument("--recategorize-only", action="store_true",
                    help="skip collection; just re-apply the CPV->category map "
                         "to existing rows (used after expanding the map)")
    args = ap.parse_args()

    if args.recategorize_only:
        conn = db.connect()
        n = db.recategorize(conn)
        print(f"Recategorized {n} rows.")
        db.export_csv(conn, open_only=not args.all_statuses)
        db.export_xlsx(conn, open_only=not args.all_statuses)
        conn.close()
        return

    selected = {s.strip() for s in args.sources.split(",") if s.strip()}
    http = HttpClient()
    conn = db.connect()

    print(f"\n{'='*66}\n UK / EU Tender Aggregator — collecting {sorted(selected)}"
          f" (last {args.days_back} days)\n{'='*66}")

    grand_total = 0
    warnings: list[str] = []
    for key, collector in build_collectors(
        selected, args.days_back, http,
        chunk_days=args.chunk_days, page_limit=args.page_limit,
    ):
        label = getattr(collector, "name", key)
        print(f"\n▶ {label} ...")
        t0 = time.time()
        # Per-page persistence: flush the in-memory batch to SQLite every
        # FLUSH_EVERY records. With --page-limit 50 and --flush-every 50 this
        # effectively persists after every API page, so a mid-run failure
        # never loses more than one page's worth of records.
        flush_every = max(1, args.flush_every)
        batch, seen, saved = [], set(), 0
        failure: Exception | None = None
        try:
            for tender in collector.collect(max_pages=args.max_pages):
                if tender.uid in seen:
                    continue
                seen.add(tender.uid)
                batch.append(tender)
                if len(batch) >= flush_every:
                    saved += db.upsert(conn, batch); batch = []
        except Exception as exc:  # noqa: BLE001
            failure = exc
        # Final flush of anything under the batch threshold
        if batch:
            saved += db.upsert(conn, batch)
        grand_total += saved

        # Count open records among what we just wrote — cheap COUNT by uid
        n_open = 0
        if seen:
            uids = list(seen)
            # SQLite parameter limit is 999; chunk the IN() query
            for i in range(0, len(uids), 900):
                slice_ = uids[i:i + 900]
                marks = ",".join("?" * len(slice_))
                n_open += conn.execute(
                    f"SELECT COUNT(*) FROM tenders "
                    f"WHERE uid IN ({marks}) AND is_open=1",
                    slice_,
                ).fetchone()[0]

        pages = getattr(collector, "pages_read", None)
        chunks_done = getattr(collector, "chunks_completed", None)
        total_chunks = len(getattr(collector, "param_chunks", []) or [None])
        chunk_failures = getattr(collector, "chunk_failures", []) or []
        page_str = f" · {pages} page(s)" if pages else ""
        chunk_str = (f" · {chunks_done}/{total_chunks} chunk(s)"
                     if chunks_done is not None and total_chunks > 1 else "")

        if failure:
            print(f"  ⚠  {saved} notices SAVED before failure "
                  f"({n_open} open){page_str}{chunk_str}  in {time.time()-t0:.1f}s")
            print(f"     partial failure: {failure}")
            warnings.append(f"{label} aborted after {pages} page(s): {failure}")
        else:
            print(f"  ✓ {saved} notices  ({n_open} open){page_str}{chunk_str}"
                  f"  in {time.time()-t0:.1f}s")
            if chunk_failures:
                print(f"     {len(chunk_failures)} chunk(s) skipped:")
                for idx, err in chunk_failures[:5]:
                    print(f"       - chunk {idx}: {err[:120]}")
                if len(chunk_failures) > 5:
                    print(f"       - ... and {len(chunk_failures)-5} more.")
                warnings.append(
                    f"{label}: {len(chunk_failures)}/{total_chunks} chunks "
                    f"skipped due to upstream errors — re-run to fill gaps."
                )
            if getattr(collector, "truncated", False):
                msg = (f"⚠️  {label} was TRUNCATED at {pages} pages "
                       f"— more data available. Re-run with --max-pages 0 "
                       f"(no cap) or a larger value.")
                print(f"  {msg}")
                warnings.append(msg)

    # Export
    open_only = not args.all_statuses
    n_csv = db.export_csv(conn, open_only=open_only)
    xlsx = db.export_xlsx(conn, open_only=open_only)
    scope = "all-status" if args.all_statuses else "open/live"
    print(f"\n{'='*66}")
    print(f" Collected/updated {grand_total} notices this run.")
    print(f" CSV export ({scope}): {n_csv} rows -> {db.CSV_PATH}")
    if xlsx:
        print(f" Excel export ({scope}): {xlsx}")
    print(f" SQLite store: {db.DB_PATH}")

    s = db.stats(conn)
    print(f"\n Store totals: {s['total']} notices, {s['open']} open, "
          f"{s['categorised_open']} categorised "
          f"({100*s['categorised_open']//max(s['open'],1)}% coverage).")
    print(" By source:")
    for src, cnt in s["by_source"]:
        print(f"   {src:<28} {cnt}")
    print(" Open notices by sweet-spot category (all 30 categories):")
    for cat, cnt in s["by_category"]:
        print(f"   {cat:<28} {cnt}")
    if warnings:
        print("\n⚠️  WARNINGS:")
        for w in warnings:
            print("   - " + w)
    print("="*66)
    conn.close()


if __name__ == "__main__":
    main()
