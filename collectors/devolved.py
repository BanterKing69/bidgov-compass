"""
Devolved-nation portals built on the Proactis/Millstream platform:
  * Public Contracts Scotland  -> clean OCDS API (works)
  * Sell2Wales                 -> OCDS API present but often 500s server-side;
                                  falls back to Firecrawl, then skips gracefully.

Note on coverage: above-threshold Scottish/Welsh notices are ALSO syndicated to
Find a Tender, so those are captured even if a devolved feed is down. These
collectors add the below-threshold notices unique to each nation.
"""

from __future__ import annotations

import json
from typing import Iterator

from base import HttpClient
from firecrawl_client import FirecrawlClient
from normalize import ocds_release_to_tender, compute_is_open
from schema import Tender, map_cpv_to_category


# --------------------------------------------------------------------------- #
# Public Contracts Scotland  (OCDS)
# --------------------------------------------------------------------------- #
class PublicContractsScotland:
    name = "Public Contracts Scotland"
    API = "https://api.publiccontractsscotland.gov.uk/v1/Notices"
    # PCS returns a rolling window and ignores pagination params — this cap is
    # inherent to the source, not to our collector.
    truncated: bool = False
    pages_read: int = 0

    def __init__(self, http: HttpClient | None = None):
        self.http = http or HttpClient()

    def collect(self, max_pages: int = 1) -> Iterator[Tender]:
        self.pages_read = 1
        self.truncated = False
        data = self.http.get_json(self.API)
        src = data.get("uri") or self.API
        for rel in data.get("releases") or []:
            yield ocds_release_to_tender(rel, source=self.name, source_api_url=src)


# --------------------------------------------------------------------------- #
# Sell2Wales  (OCDS with Firecrawl fallback)
# --------------------------------------------------------------------------- #
class Sell2Wales:
    name = "Sell2Wales"
    API = "https://api.sell2wales.gov.wales/v1/Notices"
    SEARCH_PAGE = "https://www.sell2wales.gov.wales/Search/Search_MainPage.aspx"

    def __init__(self, http: HttpClient | None = None,
                 firecrawl: FirecrawlClient | None = None):
        self.http = http or HttpClient()
        # fail fast on the flaky Sell2Wales OCDS endpoint (don't burn 15s on retries)
        self.probe = HttpClient(retries=1, timeout=15)
        self.firecrawl = firecrawl or FirecrawlClient(self.http)

    def collect(self, max_pages: int = 1) -> Iterator[Tender]:
        # 1) Try the OCDS API (intermittently returns HTTP 500 server-side).
        try:
            data = self.probe.get_json(self.API)
            src = data.get("uri") or self.API
            releases = data.get("releases") or []
            if releases:
                for rel in releases:
                    yield ocds_release_to_tender(rel, source=self.name, source_api_url=src)
                return
        except Exception as exc:  # noqa: BLE001 - degrade gracefully
            print(f"    [Sell2Wales] OCDS API unavailable ({exc}); "
                  f"above-threshold Welsh notices are still captured via Find a Tender.")

        # 2) Fall back to Firecrawl if a key is configured.
        if self.firecrawl.available:
            yield from self._firecrawl_collect()
        else:
            print("    [Sell2Wales] No FIRECRAWL_API_KEY set; skipping HTML fallback. "
                  "Set the key to enable Welsh below-threshold scraping.")

    def _firecrawl_collect(self) -> Iterator[Tender]:
        schema = {
            "type": "object",
            "properties": {
                "notices": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string"},
                            "buyer": {"type": "string"},
                            "deadline": {"type": "string"},
                            "cpv": {"type": "string"},
                            "value": {"type": "number"},
                            "url": {"type": "string"},
                        },
                    },
                }
            },
        }
        result = self.firecrawl.extract(
            self.SEARCH_PAGE, schema,
            prompt="Extract all current tender notices: title, buyer, submission "
                   "deadline, CPV code, contract value, and the notice URL.",
        )
        for n in (result or {}).get("notices", []):
            cpv = n.get("cpv")
            yield Tender(
                uid=Tender.make_uid(self.name, n.get("url") or n.get("title", "")),
                source=self.name,
                source_type="html",
                source_id=n.get("url") or n.get("title", ""),
                title=n.get("title") or "(untitled)",
                category=map_cpv_to_category(cpv),
                cpv_code=cpv,
                buyer_name=n.get("buyer"),
                country="Wales",
                value_amount=n.get("value"),
                value_currency="GBP" if n.get("value") else None,
                deadline=n.get("deadline"),
                is_open=compute_is_open(None, n.get("deadline")),
                notice_url=n.get("url"),
                source_api_url=self.SEARCH_PAGE,
                raw_json=json.dumps(n, ensure_ascii=False),
            )
