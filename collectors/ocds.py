"""
OCDS collectors for the two big UK open-data portals.

Both Find a Tender and Contracts Finder publish notices as OCDS release
packages and paginate with a `links.next` cursor. Same shape, different base
URL and query params, so one collector handles both.

Docs:
  * Find a Tender:    https://www.find-tender.service.gov.uk/apidocumentation
  * Contracts Finder: https://www.contractsfinder.service.gov.uk/apidocumentation/V1

Reliability strategy — three defences against the gateway timeouts we hit on
365-day sweeps:

  1. **Date-window chunking.** A single large `updatedFrom..updatedTo` query
     forces the upstream to materialise a huge result set. We instead break the
     target window into sequential N-day chunks (default 30) — each chunk is a
     fresh query with its own cursor. If chunk 5 fails, chunks 1–4 are still
     persisted.

  2. **Smaller pages.** `limit=50` is the sweet spot: enough throughput, but
     small enough that heavy per-record payloads (which some notices have) don't
     push the gateway over its timeout.

  3. **Per-chunk failure isolation.** A cursor error in one chunk no longer
     kills the whole source — it's recorded and we move on to the next chunk.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Iterator, Optional

from base import HttpClient
from normalize import ocds_release_to_tender
from schema import Tender

DEFAULT_CHUNK_DAYS = 30
DEFAULT_PAGE_LIMIT = 50


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _chunk_windows(days_back: int, chunk_days: int) -> list[tuple[datetime, datetime]]:
    """Split [now - days_back, now] into contiguous chunks of `chunk_days`.

    Chunks are ordered NEWEST first — we want the freshest notices in the DB
    before older ones, in case the run is interrupted midway.
    """
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=days_back)
    windows: list[tuple[datetime, datetime]] = []
    cursor_end = now
    while cursor_end > start:
        cursor_start = max(cursor_end - timedelta(days=chunk_days), start)
        windows.append((cursor_start, cursor_end))
        cursor_end = cursor_start
    return windows


def _fmt(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


# --------------------------------------------------------------------------- #
# Generic OCDS collector
# --------------------------------------------------------------------------- #
class OcdsCollector:
    """Streams OCDS releases as normalised `Tender` objects.

    `param_chunks` is a list of query-string dicts (one per date-window chunk).
    Each chunk runs its own cursor loop; a failure in one chunk does NOT abort
    the others — it's recorded on `chunk_failures` for the orchestrator to log.

    The generator yields records one at a time; the orchestrator flushes them
    to SQLite in small batches, so if the process dies mid-chunk the work
    already yielded is safe.
    """

    def __init__(
        self,
        name: str,
        base_url: str,
        param_chunks: list[dict] | dict,
        notice_url_builder=None,
        http: HttpClient | None = None,
    ):
        self.name = name
        self.base_url = base_url
        # Accept a single dict (single-window, no chunking) or a list of dicts.
        self.param_chunks: list[dict] = (
            param_chunks if isinstance(param_chunks, list) else [param_chunks]
        )
        self.notice_url_builder = notice_url_builder
        self.http = http or HttpClient()

        # Public state — the orchestrator inspects these AFTER collect() to
        # detect silent truncation and report chunk failures.
        self.truncated: bool = False
        self.pages_read: int = 0
        self.chunks_completed: int = 0
        self.chunk_failures: list[tuple[int, str]] = []

    def collect(self, max_pages: int = 0) -> Iterator[Tender]:
        """Yield normalised Tender objects.

        `max_pages` is a HARD cap across ALL chunks (0 or negative = no cap).
        Callers should treat each yield as durable-once-persisted; there is no
        buffering inside the collector.
        """
        self.truncated = False
        self.pages_read = 0
        self.chunks_completed = 0
        self.chunk_failures = []

        cap = max_pages if max_pages and max_pages > 0 else 10 ** 9

        for chunk_idx, chunk_params in enumerate(self.param_chunks):
            if self.pages_read >= cap:
                self.truncated = True
                return
            try:
                yield from self._collect_chunk(chunk_idx, chunk_params, cap)
                self.chunks_completed += 1
            except Exception as exc:  # noqa: BLE001
                # ISOLATE the failure: log the chunk that broke and continue
                # with the next one. Persistence has already happened at the
                # orchestrator layer for whatever we yielded before the error.
                self.chunk_failures.append((chunk_idx, f"{type(exc).__name__}: {exc}"))
                continue

    def _collect_chunk(
        self, chunk_idx: int, chunk_params: dict, cap: int,
    ) -> Iterator[Tender]:
        url = self.base_url
        params: Optional[dict] = dict(chunk_params)
        chunk_pages = 0
        while url and self.pages_read < cap:
            data = self.http.get_json(url, params=params if chunk_pages == 0 else None)
            releases = data.get("releases") or []
            src_uri = data.get("uri") or url
            for rel in releases:
                fallback = (
                    self.notice_url_builder(rel) if self.notice_url_builder else None
                )
                yield ocds_release_to_tender(
                    rel,
                    source=self.name,
                    source_api_url=src_uri,
                    fallback_notice_url=fallback,
                )
            url = (data.get("links") or {}).get("next")
            params = None  # cursor URL already carries all the params
            self.pages_read += 1
            chunk_pages += 1
            if not releases:
                break
        if url and self.pages_read >= cap:
            # More available in THIS chunk, but we hit the global cap.
            self.truncated = True


# --------------------------------------------------------------------------- #
# Factory functions — each portal
# --------------------------------------------------------------------------- #
def find_a_tender(
    days_back: int = 30,
    http: HttpClient | None = None,
    *,
    chunk_days: int = DEFAULT_CHUNK_DAYS,
    page_limit: int = DEFAULT_PAGE_LIMIT,
) -> OcdsCollector:
    """Find a Tender (UK-wide, >£139k threshold). Uses updatedFrom/To."""
    windows = _chunk_windows(days_back, chunk_days)
    chunks = [
        {
            "stages": "tender",
            "updatedFrom": _fmt(frm),
            "updatedTo": _fmt(to),
            "limit": page_limit,
        }
        for frm, to in windows
    ]

    def build_url(release: dict) -> str | None:
        # FTS OCDS omits the notice link; the release `id` (e.g. 065141-2026)
        # is the public notice number: /Notice/{id}
        nid = release.get("id")
        return f"https://www.find-tender.service.gov.uk/Notice/{nid}" if nid else None

    return OcdsCollector(
        name="Find a Tender",
        base_url="https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages",
        param_chunks=chunks,
        notice_url_builder=build_url,
        http=http,
    )


def contracts_finder(
    days_back: int = 30,
    http: HttpClient | None = None,
    *,
    chunk_days: int = DEFAULT_CHUNK_DAYS,
    page_limit: int = DEFAULT_PAGE_LIMIT,
) -> OcdsCollector:
    """Contracts Finder (England, incl. below-threshold). Uses publishedFrom/To."""
    windows = _chunk_windows(days_back, chunk_days)
    chunks = [
        {
            "stages": "tender",
            "publishedFrom": _fmt(frm),
            "publishedTo": _fmt(to),
            "size": page_limit,
        }
        for frm, to in windows
    ]
    return OcdsCollector(
        name="Contracts Finder",
        base_url=(
            "https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search"
        ),
        param_chunks=chunks,
        http=http,
    )
