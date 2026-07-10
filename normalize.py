"""Map source-native records into the normalised `Tender` schema."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Optional

from schema import Tender, map_cpv_to_category


# --------------------------------------------------------------------------- #
# Date / status helpers
# --------------------------------------------------------------------------- #
def parse_dt(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    s = str(value).strip().replace("Z", "+00:00")
    for candidate in (s, s[:19], s[:10]):
        try:
            dt = datetime.fromisoformat(candidate)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except ValueError:
            continue
    return None


def iso(value: Optional[str]) -> Optional[str]:
    dt = parse_dt(value)
    return dt.isoformat() if dt else None


_OPEN_STATUSES = {"active", "open", "planned", "planning", "ongoing"}
_CLOSED_STATUSES = {"complete", "cancelled", "canceled", "withdrawn", "closed",
                    "unsuccessful", "awarded"}


def compute_is_open(status: Optional[str], deadline: Optional[str]) -> int:
    """A tender is 'open/live' if its submission deadline is in the future,
    or (deadline unknown) its status is an open-type status."""
    now = datetime.now(timezone.utc)
    dl = parse_dt(deadline)
    if dl is not None:
        return 1 if dl >= now else 0
    st = (status or "").strip().lower()
    if st in _CLOSED_STATUSES:
        return 0
    if st in _OPEN_STATUSES:
        return 1
    return 0  # unknown + no deadline -> treat as not-open (conservative)


# --------------------------------------------------------------------------- #
# OCDS  (Find a Tender, Contracts Finder, and any OCDS-compliant portal)
# --------------------------------------------------------------------------- #
def _first_cpv(tender: dict) -> tuple[Optional[str], Optional[str]]:
    cls = tender.get("classification") or {}
    if cls.get("scheme", "CPV").upper().startswith("CPV") and cls.get("id"):
        return str(cls["id"]), cls.get("description")
    for item in tender.get("items") or []:
        c = item.get("classification") or {}
        if c.get("id"):
            return str(c["id"]), c.get("description")
    return None, None


def _buyer(release: dict) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """Return (buyer_name, region, country) from OCDS parties/buyer."""
    buyer = release.get("buyer") or {}
    name = buyer.get("name")
    region = country = None
    parties = release.get("parties") or []
    match = None
    for p in parties:
        if buyer.get("id") and p.get("id") == buyer.get("id"):
            match = p
            break
        if "buyer" in (p.get("roles") or []):
            match = match or p
    if match:
        name = name or match.get("name")
        addr = match.get("address") or {}
        region = addr.get("region") or addr.get("locality") or addr.get("postalCode")
        country = addr.get("countryName")
    return name, region, country


_NOTICE_DOC_TYPES = {
    "tendernotice", "contractnotice", "notice", "awardnotice",
    "planningnotice", "biddingdocuments",
}


def _notice_and_docs_url(release: dict, tender: dict) -> tuple[Optional[str], Optional[str]]:
    notice_url = docs_url = None
    first_url = None
    for doc in tender.get("documents") or []:
        dtype = (doc.get("documentType") or "").lower()
        url = doc.get("url")
        if not url:
            continue
        first_url = first_url or url
        if dtype in _NOTICE_DOC_TYPES and not notice_url:
            notice_url = url
        if "document" in dtype or "bidding" in dtype:
            docs_url = docs_url or url
    # some portals (OCDS) also expose a release-level link. `links` may be a
    # dict ({"self": url}) or a list ([{"rel": "self", "href": url}]).
    if not notice_url:
        links = release.get("links")
        if isinstance(links, dict):
            notice_url = links.get("self")
        elif isinstance(links, list):
            for l in links:
                if isinstance(l, dict) and l.get("href"):
                    notice_url = l["href"]
                    break
        notice_url = notice_url or first_url
    return notice_url, docs_url


def _award_fields(release: dict) -> dict:
    """Extract award-stage enrichment fields from an OCDS release.

    OCDS represents an award notice as a release with `tag: [award]` and an
    `awards[]` array. Each entry has suppliers, value, date, contractPeriod.
    For multi-supplier awards we surface the first supplier + a count; the
    full detail lives in `raw_json`.
    """
    awards = release.get("awards") or []
    if not awards:
        return {}
    a = awards[0]
    suppliers = a.get("suppliers") or []
    first = suppliers[0] if suppliers else {}
    value = a.get("value") or {}
    period = a.get("contractPeriod") or {}
    return {
        "awarded_supplier_name":  first.get("name"),
        "awarded_supplier_id":    first.get("id"),
        "awarded_supplier_count": len(suppliers) or None,
        "awarded_value_amount":   value.get("amount"),
        "awarded_value_currency": value.get("currency"),
        "awarded_date":           iso(a.get("date")),
        "contract_start_date":    iso(period.get("startDate")),
        "contract_end_date":      iso(period.get("endDate")),
    }


def ocds_release_to_tender(
    release: dict,
    source: str,
    source_api_url: Optional[str] = None,
    fallback_notice_url: Optional[str] = None,
) -> Tender:
    tender = release.get("tender") or {}
    ocid = release.get("ocid") or release.get("id") or tender.get("id") or ""
    cpv, cpv_desc = _first_cpv(tender)
    buyer_name, region, country = _buyer(release)
    notice_url, docs_url = _notice_and_docs_url(release, tender)

    value = tender.get("value") or {}
    deadline = (tender.get("tenderPeriod") or {}).get("endDate")
    published = (tender.get("datePublished") or release.get("date"))
    status = tender.get("status")
    tags = release.get("tag") or []
    stage = "award" if any(t in ("award", "contract") for t in tags) else \
            ("planning" if "planning" in tags else "tender")

    # For award-stage releases, extract supplier/value/date enrichment.
    aw = _award_fields(release) if stage == "award" else {}

    # UID: stage-scoped so a tender and its award notice are DIFFERENT rows
    # (they share ocid). Without this, INSERT OR REPLACE would overwrite the
    # tender with its own later-published award release.
    uid_seed = f"{ocid}::{stage}" if stage != "tender" else str(ocid)

    return Tender(
        uid=Tender.make_uid(source, uid_seed),
        source=source,
        source_type="gov-api-ocds",
        source_id=str(ocid),
        title=tender.get("title") or "(untitled)",
        description=tender.get("description"),
        notice_stage=stage,
        procurement_category=tender.get("mainProcurementCategory"),
        category=map_cpv_to_category(cpv),
        cpv_code=cpv,
        cpv_description=cpv_desc,
        buyer_name=buyer_name,
        buyer_region=region,
        country=country or "UK",
        value_amount=value.get("amount"),
        value_currency=value.get("currency"),
        published_date=iso(published),
        deadline=iso(deadline),
        status=status,
        is_open=compute_is_open(status, deadline) if stage == "tender" else 0,
        notice_url=notice_url or fallback_notice_url,
        documents_url=docs_url,
        source_api_url=source_api_url,
        ocid=str(ocid) or None,
        raw_json=json.dumps(release, ensure_ascii=False),
        **aw,
    )


# --------------------------------------------------------------------------- #
# TED  (EU Search API v3)
# --------------------------------------------------------------------------- #
def _ted_text(value) -> Optional[str]:
    """TED multilingual fields look like {'eng': ['...']} or ['...'] or '...'."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return _ted_text(value[0]) if value else None
    if isinstance(value, dict):
        for lang in ("eng", "ENG", "en"):
            if lang in value:
                return _ted_text(value[lang])
        for v in value.values():
            return _ted_text(v)
    return str(value)


def ted_notice_to_tender(notice: dict, source: str = "TED",
                         source_api_url: Optional[str] = None) -> Tender:
    pub = notice.get("publication-number")
    cpv_list = notice.get("classification-cpv") or []
    cpv = str(cpv_list[0]) if cpv_list else None
    title = _ted_text(notice.get("notice-title")) or "(untitled)"
    buyer = _ted_text(notice.get("buyer-name"))
    deadline = _ted_text(notice.get("deadline-receipt-tender-date-lot")) or \
        _ted_text(notice.get("deadline-receipt-request-date-lot"))
    published = _ted_text(notice.get("publication-date"))
    place = _ted_text(notice.get("place-of-performance"))

    value = notice.get("total-value")
    amount = None
    if isinstance(value, (int, float)):
        amount = float(value)
    elif isinstance(value, list) and value and isinstance(value[0], (int, float)):
        amount = float(value[0])

    links = notice.get("links") or {}
    html = (links.get("html") or {})
    notice_url = html.get("ENG") or (next(iter(html.values())) if html else None)

    return Tender(
        uid=Tender.make_uid(source, str(pub)),
        source=source,
        source_type="eu-api",
        source_id=str(pub),
        title=title,
        description=None,
        notice_stage="tender",
        procurement_category=None,
        category=map_cpv_to_category(cpv),
        cpv_code=cpv,
        cpv_description=None,
        buyer_name=buyer,
        buyer_region=place,
        country=place or "EU",
        value_amount=amount,
        value_currency="EUR" if amount else None,
        published_date=iso(published),
        deadline=iso(deadline),
        status=None,
        is_open=compute_is_open(None, deadline),
        notice_url=notice_url,
        documents_url=None,
        source_api_url=source_api_url,
        raw_json=json.dumps(notice, ensure_ascii=False),
    )
