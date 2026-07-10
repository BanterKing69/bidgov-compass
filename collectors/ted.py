"""
TED (Tenders Electronic Daily) collector — EU/EEA notices via Search API v3.

We scope to UK place-of-performance plus recent publication so the EU feed is
comparable with the UK portals (post-Brexit UK is not on TED for its own
notices, but UK-relevant / cross-border EU opportunities still appear).

Docs: https://ted.europa.eu/en/simap/webservices  (POST /v3/notices/search)
Query language: TED Expert Search fields.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Iterator

from base import HttpClient
from normalize import ted_notice_to_tender
from schema import Tender

TED_SEARCH_URL = "https://api.ted.europa.eu/v3/notices/search"

FIELDS = [
    "publication-number",
    "notice-title",
    "buyer-name",
    "deadline-receipt-tender-date-lot",
    "deadline-receipt-request-date-lot",
    "total-value",
    "place-of-performance",
    "classification-cpv",
    "publication-date",
    "links",
]


class TedCollector:
    name = "TED"

    def __init__(self, days_back: int = 30, country: str = "GBR",
                 http: HttpClient | None = None):
        self.days_back = days_back
        self.country = country
        self.http = http or HttpClient()

    def _query(self) -> str:
        since = (datetime.now(timezone.utc) - timedelta(days=self.days_back)).strftime("%Y%m%d")
        # place-of-performance restricted to the target country, recent notices
        return f"(place-of-performance={self.country}) AND (publication-date>={since})"

    truncated: bool = False
    pages_read: int = 0

    def collect(self, max_pages: int = 20, page_size: int = 100) -> Iterator[Tender]:
        self.truncated = False
        self.pages_read = 0
        cap = max_pages if max_pages and max_pages > 0 else 10**9
        token = None
        while self.pages_read < cap:
            body = {
                "query": self._query(),
                "fields": FIELDS,
                "limit": page_size,
                "paginationMode": "ITERATION",
            }
            if token:
                body["iterationNextToken"] = token
            data = self.http.post_json(TED_SEARCH_URL, body)
            notices = data.get("notices") or []
            for n in notices:
                yield ted_notice_to_tender(n, source=self.name, source_api_url=TED_SEARCH_URL)
            token = data.get("iterationNextToken")
            self.pages_read += 1
            if not notices or not token:
                break
        if token and self.pages_read >= cap:
            self.truncated = True


def ted(days_back: int = 30, http: HttpClient | None = None) -> TedCollector:
    return TedCollector(days_back=days_back, http=http)
