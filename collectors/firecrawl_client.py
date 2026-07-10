"""
Thin Firecrawl wrapper for the HTML-only portals.

Firecrawl is OPTIONAL. If FIRECRAWL_API_KEY is set we use the Firecrawl Cloud
REST API (https://api.firecrawl.dev) to render JS-heavy pages into clean
markdown / structured data. If it is not set, `available` is False and callers
fall back to their own plain-HTTP path (or skip).

No SDK dependency and nothing to self-host — just an HTTP call with your key.
Get a free key at https://www.firecrawl.dev  ->  export FIRECRAWL_API_KEY=fc-...
"""

from __future__ import annotations

import os
from typing import Optional

from base import HttpClient

FIRECRAWL_BASE = "https://api.firecrawl.dev/v1"


class FirecrawlClient:
    def __init__(self, http: HttpClient | None = None):
        self.api_key = os.environ.get("FIRECRAWL_API_KEY", "").strip()
        self.http = http or HttpClient()

    @property
    def available(self) -> bool:
        return bool(self.api_key)

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json"}

    def scrape(self, url: str, formats=("markdown",)) -> Optional[dict]:
        """Scrape one URL -> Firecrawl `data` dict (markdown/html/links)."""
        if not self.available:
            return None
        body = {"url": url, "formats": list(formats), "onlyMainContent": True}
        resp = self.http.post_json(f"{FIRECRAWL_BASE}/scrape", body,
                                   headers=self._headers())
        return resp.get("data") if resp.get("success") else None

    def extract(self, url: str, schema: dict, prompt: str = "") -> Optional[dict]:
        """LLM-structured extraction from a page using a JSON schema."""
        if not self.available:
            return None
        fmt = {"type": "json", "schema": schema}
        if prompt:
            fmt["prompt"] = prompt
        body = {"url": url, "formats": [fmt], "onlyMainContent": True}
        resp = self.http.post_json(f"{FIRECRAWL_BASE}/scrape", body,
                                   headers=self._headers())
        data = resp.get("data") or {}
        return data.get("json")
