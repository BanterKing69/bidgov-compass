"""Shared HTTP plumbing for collectors: polite session, retry, rate-limit."""

from __future__ import annotations

import random
import time
from typing import Optional

import requests

# Some UK gov endpoints (PCS, Sell2Wales) omit the TLS intermediate cert, which
# breaks Python's certifi bundle even though curl/browsers work. `truststore`
# makes Python verify against the OS trust store instead. Optional but strongly
# recommended; we degrade to certifi if it's not installed.
try:
    import truststore
    truststore.inject_into_ssl()
except Exception:  # noqa: BLE001
    pass

USER_AGENT = (
    "GovBid-TenderAggregator/1.0 (+public-sector open-data collector; "
    "contact: procurement-research)"
)


class HttpClient:
    """Thin requests wrapper with retry/backoff and a courtesy delay.

    We only hit open government data endpoints, but we still behave: identify
    ourselves, rate-limit, and back off on 429/5xx.
    """

    def __init__(self, delay: float = 0.4, timeout: int = 60, retries: int = 6):
        self.delay = delay
        self.timeout = timeout
        self.retries = retries
        self.session = requests.Session()
        self.session.headers.update(
            {"User-Agent": USER_AGENT, "Accept": "application/json"}
        )

    def _sleep(self):
        if self.delay:
            time.sleep(self.delay)

    @staticmethod
    def _backoff(attempt: int) -> float:
        """Exponential backoff with jitter.

        Exponential base (2, 4, 8, 16, 32, 60 s max) prevents thundering-herd on
        recovery; the random 1–3 s jitter prevents our retries from lining up
        with the API gateway's own recovery interval, which is what triggers
        rate-limiters when many clients retry in lockstep.
        """
        base = min(2 ** attempt, 60)
        return base + random.uniform(1.0, 3.0)

    def request(self, method: str, url: str, **kwargs) -> requests.Response:
        last_exc: Optional[Exception] = None
        for attempt in range(self.retries):
            try:
                resp = self.session.request(
                    method, url, timeout=self.timeout, **kwargs
                )
                if resp.status_code in (429, 500, 502, 503, 504):
                    time.sleep(self._backoff(attempt))
                    continue
                resp.raise_for_status()
                self._sleep()
                return resp
            except requests.RequestException as exc:
                last_exc = exc
                time.sleep(self._backoff(attempt))
        raise RuntimeError(f"Request failed after {self.retries} attempts: {url}") from last_exc

    def get_json(self, url: str, **kwargs) -> dict:
        return self.request("GET", url, **kwargs).json()

    def post_json(self, url: str, json_body: dict, **kwargs) -> dict:
        headers = {"Content-Type": "application/json"}
        headers.update(kwargs.pop("headers", {}))
        return self.request("POST", url, json=json_body, headers=headers, **kwargs).json()

    def get_text(self, url: str, **kwargs) -> str:
        headers = {"Accept": "text/html,application/xhtml+xml"}
        headers.update(kwargs.pop("headers", {}))
        return self.request("GET", url, headers=headers, **kwargs).text
