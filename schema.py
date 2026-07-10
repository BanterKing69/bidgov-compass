"""
Normalised, aggregated schema for UK / EU public-sector tender notices.

One `Tender` row = one procurement opportunity, regardless of which portal it
came from. Every source record is mapped into this shape by `normalize.py`.

Design goals:
  * Provenance is never lost  -> `source`, `source_type`, `source_id`,
    `notice_url`, `source_api_url`, and the full `raw_json` are all retained.
  * Cross-source comparability -> money, dates, category and status are coerced
    into common units/vocabularies.
  * Strategy-aware enrichment  -> CPV codes are mapped to the GovBid/War Dog
    "sweet-spot" categories from Tender_Analysis.xlsx so the aggregated data can
    be sliced the same way the strategy sheet is.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, asdict, field, fields
from datetime import datetime, timezone
from typing import Optional


# --------------------------------------------------------------------------- #
# The normalised record
# --------------------------------------------------------------------------- #
@dataclass
class Tender:
    # --- identity / provenance ------------------------------------------- #
    uid: str                      # deterministic PK: sha1(source + source_id)
    source: str                   # portal name, e.g. "Find a Tender"
    source_type: str              # gov-api-ocds | eu-api | html
    source_id: str                # native id (OCDS ocid, TED publication-number, URL)

    # --- what the opportunity is ----------------------------------------- #
    title: str
    description: Optional[str] = None
    notice_stage: Optional[str] = None       # tender | planning | award
    procurement_category: Optional[str] = None  # goods | services | works
    category: Optional[str] = None           # GovBid sweet-spot category (mapped from CPV)
    cpv_code: Optional[str] = None
    cpv_description: Optional[str] = None

    # --- who / where ----------------------------------------------------- #
    buyer_name: Optional[str] = None
    buyer_region: Optional[str] = None       # locality / postcode / region text
    country: Optional[str] = None            # ISO-ish country ("UK", "GBR", ...)

    # --- money ----------------------------------------------------------- #
    value_amount: Optional[float] = None
    value_currency: Optional[str] = None

    # --- timing ---------------------------------------------------------- #
    published_date: Optional[str] = None     # ISO 8601
    deadline: Optional[str] = None           # submission deadline, ISO 8601
    status: Optional[str] = None             # raw source status (active/open/...)
    is_open: Optional[int] = None            # 1 if live/open, 0 otherwise

    # --- links (retained originals) -------------------------------------- #
    notice_url: Optional[str] = None         # human-facing notice page
    documents_url: Optional[str] = None      # tender pack / documents link
    source_api_url: Optional[str] = None     # exact API/record URL it came from

    # --- audit ----------------------------------------------------------- #
    raw_json: Optional[str] = None           # full original record (provenance)
    collected_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    @staticmethod
    def make_uid(source: str, source_id: str) -> str:
        return hashlib.sha1(f"{source}::{source_id}".encode("utf-8")).hexdigest()

    def as_row(self) -> dict:
        return asdict(self)


COLUMNS = [f.name for f in fields(Tender)]


# --------------------------------------------------------------------------- #
# SQLite DDL
# --------------------------------------------------------------------------- #
CREATE_TABLE_SQL = f"""
CREATE TABLE IF NOT EXISTS tenders (
    uid                  TEXT PRIMARY KEY,
    source               TEXT NOT NULL,
    source_type          TEXT,
    source_id            TEXT,
    title                TEXT,
    description          TEXT,
    notice_stage         TEXT,
    procurement_category TEXT,
    category             TEXT,
    cpv_code             TEXT,
    cpv_description      TEXT,
    buyer_name           TEXT,
    buyer_region         TEXT,
    country              TEXT,
    value_amount         REAL,
    value_currency       TEXT,
    published_date       TEXT,
    deadline             TEXT,
    status               TEXT,
    is_open              INTEGER,
    notice_url           TEXT,
    documents_url        TEXT,
    source_api_url       TEXT,
    raw_json             TEXT,
    collected_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_tenders_source   ON tenders(source);
CREATE INDEX IF NOT EXISTS idx_tenders_category ON tenders(category);
CREATE INDEX IF NOT EXISTS idx_tenders_open     ON tenders(is_open);
CREATE INDEX IF NOT EXISTS idx_tenders_deadline ON tenders(deadline);
CREATE INDEX IF NOT EXISTS idx_tenders_value    ON tenders(value_amount);
"""


# --------------------------------------------------------------------------- #
# CPV  ->  GovBid "sweet-spot" category mapping
# --------------------------------------------------------------------------- #
# Longest-prefix match on the CPV code. Categories mirror the Matrix / Sweet
# Spot sheets in Tender_Analysis.xlsx so aggregated data slices the same way.
# CPV reference: https://simap.ted.europa.eu/cpv
# Longest-prefix wins, so broad divisions (e.g. "45") sit alongside specific
# overrides (e.g. "45310000" -> Electrical/M&E overrides "45" -> Construction).
CPV_CATEGORY_MAP = {
    # ------------------ Office Furniture ------------------
    "39": "Office Furniture",             # 39xxxxxx = furniture/furnishings broad
    "39100000": "Office Furniture",
    "39110000": "Office Furniture",       # seats/chairs
    "39120000": "Office Furniture",       # tables, cupboards
    "39130000": "Office Furniture",       # office furniture
    "39140000": "Office Furniture",       # domestic furniture
    "39150000": "Office Furniture",       # miscellaneous furniture
    "39160000": "Office Furniture",       # school furniture
    "39170000": "Office Furniture",       # shop furniture
    "39180000": "Office Furniture",
    "39200000": "Office Furniture",       # furnishings

    # ------------------ Stationery & Supplies ------------------
    "30190000": "Stationery & Supplies",
    "30192000": "Stationery & Supplies",
    "30193000": "Stationery & Supplies",
    "30194000": "Stationery & Supplies",
    "30195000": "Stationery & Supplies",
    "30197000": "Stationery & Supplies",
    "30199000": "Stationery & Supplies",  # paper stationery
    "22800000": "Stationery & Supplies",  # registers, receipt books
    "22850000": "Stationery & Supplies",
    "22900000": "Stationery & Supplies",

    # ------------------ IT Hardware ------------------
    "30200000": "IT Hardware",            # computer equipment
    "30210000": "IT Hardware",            # data-processing machines
    "30213000": "IT Hardware",            # PCs
    "30214000": "IT Hardware",            # workstations
    "30216000": "IT Hardware",            # magnetic/optical readers
    "30230000": "IT Hardware",            # computer-related equipment
    "30231000": "IT Hardware",            # displays
    "30232000": "IT Hardware",            # peripherals
    "30233000": "IT Hardware",            # storage
    "30234000": "IT Hardware",            # storage media
    "30236000": "IT Hardware",            # misc computer equipment
    "30237000": "IT Hardware",            # parts/accessories
    "32": "IT Hardware",                  # radio/TV/comms/telecom equipment
    "32320000": "IT Hardware",            # AV equipment
    "32570000": "IT Hardware",            # communications
    "32550000": "IT Hardware",            # telephone equipment
    "32250000": "IT Hardware",            # mobile telephones
    "32420000": "IT Hardware",            # network equipment
    "32360000": "IT Hardware",            # intercom

    # ------------------ Software & Licensing ------------------
    "48": "Software & Licensing",         # all 48xxxxxx

    # ------------------ PPE & Medical Consumables ------------------
    "18143000": "PPE & Medical Consumables",  # protective gear
    "33": "PPE & Medical Consumables",        # 33xxxxxx = medical/pharma/personal-care broad
    "35113400": "PPE & Medical Consumables",  # safety clothing

    # ------------------ Uniforms & Workwear ------------------
    "18000000": "Uniforms & Workwear",    # clothing broad
    "18100000": "Uniforms & Workwear",    # occupational workwear
    "18200000": "Uniforms & Workwear",    # outerwear
    "18300000": "Uniforms & Workwear",    # garments
    "18400000": "Uniforms & Workwear",    # special clothing
    "18800000": "Uniforms & Workwear",    # footwear
    "35811": "Uniforms & Workwear",       # uniforms

    # ------------------ Catering Supplies / Food ------------------
    "03": "Catering Supplies / Food",     # agricultural produce
    "15": "Catering Supplies / Food",     # food, beverages

    # ------------------ Vehicles & Fleet ------------------
    "34": "Vehicles & Fleet",             # transport equipment
    "43": "Vehicles & Fleet",             # heavy/construction machinery
    "501": "Vehicles & Fleet",            # 501xxxxx = vehicle repair (all sub-codes)

    # ------------------ Signage & Print ------------------
    "22": "Signage & Print",              # printed matter broad
    "34928470": "Signage & Print",        # signage
    "34992000": "Signage & Print",        # signs
    "44423450": "Signage & Print",        # signplates
    "79800000": "Signage & Print",        # printing services
    "79810000": "Signage & Print",        # printing
    "79820000": "Signage & Print",        # printing-related

    # ------------------ Lab / Scientific Equipment ------------------
    "38": "Lab / Scientific Equipment",   # lab/optical/precision

    # ------------------ Cleaning Services ------------------
    "909": "Cleaning Services",           # 909xxxxx = cleaning/sanitation broad

    # ------------------ Catering Services ------------------
    "55300000": "Catering Services",      # restaurant/food-serving
    "55400000": "Catering Services",      # beverage-serving
    "55500000": "Catering Services",      # canteen/catering
    "55510000": "Catering Services",
    "55520000": "Catering Services",      # catering
    "55521000": "Catering Services",
    "55523000": "Catering Services",
    "55524000": "Catering Services",      # school catering

    # ------------------ Facilities Mgmt (bundled) ------------------
    "70": "Facilities Mgmt (bundled)",        # real-estate services broad
    "70330000": "Facilities Mgmt (bundled)",  # property management on contract
    "70332000": "Facilities Mgmt (bundled)",
    "79993000": "Facilities Mgmt (bundled)",  # building/facilities management
    "79993100": "Facilities Mgmt (bundled)",

    # ------------------ Security Services ------------------
    "35120000": "Security Services",      # surveillance systems
    "35121000": "Security Services",
    "35125000": "Security Services",
    "79710000": "Security Services",
    "79711000": "Security Services",      # alarm monitoring
    "79713000": "Security Services",      # guard
    "79714000": "Security Services",      # surveillance
    "79715000": "Security Services",      # patrol
    "79716000": "Security Services",
    "79721000": "Security Services",      # investigation

    # ------------------ Grounds Maintenance ------------------
    "77": "Grounds Maintenance",          # ag/hort/forestry services
    # Note 77 broad — but forestry-only projects sometimes drift; acceptable.

    # ------------------ Waste Management ------------------
    "905": "Waste Management",            # 905xxxxx = refuse/waste
    "906": "Waste Management",            # 906xxxxx = urban/rural cleaning
    "907": "Waste Management",            # 907xxxxx = environmental services

    # ------------------ IT Managed Services ------------------
    "72": "IT Managed Services",          # all IT services
    "51600000": "IT Managed Services",    # IT installation

    # ------------------ Professional / Consultancy ------------------
    "71": "Professional / Consultancy",   # architectural/engineering broad
    "73": "Professional / Consultancy",   # R&D
    "79400000": "Professional / Consultancy",
    "79410000": "Professional / Consultancy",
    "79411000": "Professional / Consultancy",
    "79412000": "Professional / Consultancy",
    "79413000": "Professional / Consultancy",
    "79414000": "Professional / Consultancy",
    "79415000": "Professional / Consultancy",
    "79417000": "Professional / Consultancy",   # safety consultancy
    "79418000": "Professional / Consultancy",
    "79419000": "Professional / Consultancy",
    "79420000": "Professional / Consultancy",
    "79430000": "Professional / Consultancy",

    # ------------------ Marketing & Comms ------------------
    "79340000": "Marketing & Comms",      # advertising & marketing
    "79341000": "Marketing & Comms",      # advertising
    "79342000": "Marketing & Comms",      # marketing
    "79416000": "Marketing & Comms",      # PR
    "79822000": "Marketing & Comms",
    "92210000": "Marketing & Comms",      # radio/TV production
    "92220000": "Marketing & Comms",

    # ------------------ Training & Learning ------------------
    "80": "Training & Learning",          # all education services

    # ------------------ Translation & Interpreting ------------------
    "79530000": "Translation & Interpreting",
    "79540000": "Translation & Interpreting",

    # ------------------ Temp Staffing / Recruitment ------------------
    "796": "Temp Staffing / Recruitment",  # 796xxxxx = recruitment/personnel broad

    # ------------------ Legal Services ------------------
    "791": "Legal Services",              # 791xxxxx = legal services broad

    # ------------------ Financial / Audit ------------------
    "66": "Financial / Audit",            # all financial/insurance
    "792": "Financial / Audit",           # 792xxxxx = accounting/audit/fiscal (all sub-codes)

    # ------------------ Health & Social Care ------------------
    "85": "Health & Social Care",         # health & social work
    "98000000": "Health & Social Care",   # other community services
    "98100000": "Health & Social Care",
    "98200000": "Health & Social Care",
    "98300000": "Health & Social Care",
    "98500000": "Health & Social Care",   # private households w/ employees
    "98510000": "Health & Social Care",
    "98900000": "Health & Social Care",

    # ------------------ Transport / Logistics ------------------
    "60": "Transport / Logistics",        # transport services
    "63": "Transport / Logistics",        # supporting/auxiliary transport
    "64100000": "Transport / Logistics",  # post
    "64110000": "Transport / Logistics",  # postal
    "64120000": "Transport / Logistics",  # courier

    # ------------------ Building Maintenance ------------------
    "50": "Building Maintenance",         # 50xxxxxx = repair/maintenance (broad)
    "51": "Building Maintenance",         # 51xxxxxx = installation services broad
    # (specific "501" for Vehicles & Fleet above will win by longer-prefix match)
    "45450000": "Building Maintenance",   # other building completion
    "45453000": "Building Maintenance",   # overhaul/refurbishment
    "45453100": "Building Maintenance",
    "45261000": "Building Maintenance",   # roof erection/other special
    "45262000": "Building Maintenance",   # special trade work
    "50413200": "Building Maintenance",   # firefighting equipment maintenance
    "50531": "Building Maintenance",      # 50531xxx boiler/pump/compressor maint

    # ------------------ Construction / Refurb ------------------
    "44": "Construction / Refurb",        # construction materials
    "45": "Construction / Refurb",        # construction work (default)
    "45100000": "Construction / Refurb",  # site prep
    "45200000": "Construction / Refurb",  # works for complete/part construction
    "45210000": "Construction / Refurb",  # buildings
    "45211000": "Construction / Refurb",
    "45212000": "Construction / Refurb",
    "45213000": "Construction / Refurb",
    "45214000": "Construction / Refurb",
    "45215000": "Construction / Refurb",
    "45216000": "Construction / Refurb",
    "45220000": "Construction / Refurb",  # engineering works & construction works
    "45260000": "Construction / Refurb",  # roof works
    "45400000": "Construction / Refurb",  # building completion (finish)
    "45410000": "Construction / Refurb",  # plastering
    "45420000": "Construction / Refurb",  # joinery/carpentry
    "45430000": "Construction / Refurb",  # floor/wall covering
    "45440000": "Construction / Refurb",  # painting/glazing

    # ------------------ Electrical / M&E ------------------
    "31": "Electrical / M&E",             # electrical machinery/lighting broad
    "45300000": "Electrical / M&E",       # building installation
    "45310000": "Electrical / M&E",       # electrical installation
    "45311000": "Electrical / M&E",
    "45312000": "Electrical / M&E",
    "45314000": "Electrical / M&E",
    "45315000": "Electrical / M&E",
    "45316000": "Electrical / M&E",
    "45317000": "Electrical / M&E",
    "45320000": "Electrical / M&E",       # insulation
    "45330000": "Electrical / M&E",       # plumbing/sanitary
    "45331000": "Electrical / M&E",       # HVAC
    "45332000": "Electrical / M&E",       # plumbing
    "45333000": "Electrical / M&E",
    "45340000": "Electrical / M&E",       # fencing/railing/safety
    "45350000": "Electrical / M&E",       # mechanical installations

    # ------------------ Highways / Civils ------------------
    "45230000": "Highways / Civils",      # pipelines/highways/rail/airfields
    "45231000": "Highways / Civils",
    "45232000": "Highways / Civils",
    "45233000": "Highways / Civils",      # highway construction
    "45234000": "Highways / Civils",      # rail/cable
    "45235000": "Highways / Civils",      # airfields
    "45236000": "Highways / Civils",      # flatwork
    "45240000": "Highways / Civils",      # water projects
    "45250000": "Highways / Civils",      # heavy civil
}


def map_cpv_to_category(cpv_code: Optional[str]) -> Optional[str]:
    """Longest-prefix match of a CPV code to a GovBid sweet-spot category."""
    if not cpv_code:
        return None
    code = str(cpv_code).strip().replace("-", "")
    best = None
    best_len = -1
    for prefix, cat in CPV_CATEGORY_MAP.items():
        if code.startswith(prefix) and len(prefix) > best_len:
            best, best_len = cat, len(prefix)
    return best
