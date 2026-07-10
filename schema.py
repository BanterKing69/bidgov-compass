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

    # --- award enrichment (only populated when notice_stage='award') ----- #
    ocid: Optional[str] = None                    # OCDS contracting-process id (links tender <-> award)
    awarded_supplier_name: Optional[str] = None   # winning supplier (first if multi)
    awarded_supplier_id: Optional[str] = None     # OCDS supplier id (e.g. GB-CFS-...)
    awarded_supplier_count: Optional[int] = None  # 1 for single-supplier, N for multi-lot
    awarded_value_amount: Optional[float] = None  # final award value (often differs from tender value)
    awarded_value_currency: Optional[str] = None
    awarded_date: Optional[str] = None            # ISO — when contract was awarded
    contract_start_date: Optional[str] = None     # ISO
    contract_end_date: Optional[str] = None       # ISO — powers renewal-window intel later

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
    ocid                    TEXT,
    awarded_supplier_name   TEXT,
    awarded_supplier_id     TEXT,
    awarded_supplier_count  INTEGER,
    awarded_value_amount    REAL,
    awarded_value_currency  TEXT,
    awarded_date            TEXT,
    contract_start_date     TEXT,
    contract_end_date       TEXT,
    raw_json             TEXT,
    collected_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_tenders_source   ON tenders(source);
CREATE INDEX IF NOT EXISTS idx_tenders_category ON tenders(category);
CREATE INDEX IF NOT EXISTS idx_tenders_open     ON tenders(is_open);
CREATE INDEX IF NOT EXISTS idx_tenders_deadline ON tenders(deadline);
CREATE INDEX IF NOT EXISTS idx_tenders_value    ON tenders(value_amount);
CREATE INDEX IF NOT EXISTS idx_tenders_stage    ON tenders(notice_stage);
-- Post-v1 indexes (ocid, awarded_supplier_name, awarded_date) are created by
-- db._ensure_columns() AFTER the columns are added by the migration.
"""

# Indexes for post-v1 columns — created only once the columns exist.
POST_V1_INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_tenders_ocid     ON tenders(ocid)",
    "CREATE INDEX IF NOT EXISTS idx_tenders_supplier ON tenders(awarded_supplier_name)",
    "CREATE INDEX IF NOT EXISTS idx_tenders_award_dt ON tenders(awarded_date)",
]

# Columns added AFTER v1 — used by db.py to migrate old stores in place.
POST_V1_COLUMNS = [
    ("ocid",                    "TEXT"),
    ("awarded_supplier_name",   "TEXT"),
    ("awarded_supplier_id",     "TEXT"),
    ("awarded_supplier_count",  "INTEGER"),
    ("awarded_value_amount",    "REAL"),
    ("awarded_value_currency",  "TEXT"),
    ("awarded_date",            "TEXT"),
    ("contract_start_date",     "TEXT"),
    ("contract_end_date",       "TEXT"),
]


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
    # NB: CPV division 39 is "Furniture; furnishings; domestic appliances;
    # cleaning products" — a broad `"39"` prefix would swallow cleaning
    # products (398) and catering supplies (392) as furniture, which is wrong.
    # Use precise sub-prefixes below instead.
    "391": "Office Furniture",            # 391xxxxx = all furniture proper
    "39100000": "Office Furniture",       # furniture broad heading
    "39110000": "Office Furniture",       # seats/chairs
    "39120000": "Office Furniture",       # tables, cupboards
    "39130000": "Office Furniture",       # office furniture
    "39140000": "Office Furniture",       # domestic furniture
    "39150000": "Office Furniture",       # miscellaneous furniture
    "39160000": "Office Furniture",       # school furniture
    "39170000": "Office Furniture",       # shop furniture
    "39180000": "Office Furniture",       # laboratory furniture (mostly cabinets)
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
    "3922": "Catering Supplies / Food",   # 3922xxxx = kitchen/household/catering supplies

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
    "3918": "Lab / Scientific Equipment", # 3918xxxx = laboratory furniture (fume cupboards etc.)

    # ------------------ Cleaning Services ------------------
    "909": "Cleaning Services",           # 909xxxxx = cleaning/sanitation services
    "398": "Cleaning Services",           # 398xxxxx = cleaning products/consumables
    "39713430": "Cleaning Services",      # vacuum cleaners
    "39713431": "Cleaning Services",      # vacuum cleaner accessories
    "39714500": "Cleaning Services",      # floor-cleaning machines
    # NB: 397 broad (domestic appliances — freezers, water heaters, etc.) is
    # intentionally LEFT UNMAPPED. It doesn't cleanly fit any sweet-spot
    # category; the specific cleaning appliances above are the exception.

    # ------------------ Catering Services ------------------
    "55300000": "Catering Services",      # restaurant/food-serving
    "55400000": "Catering Services",      # beverage-serving
    "55500000": "Catering Services",      # canteen/catering
    "55510000": "Catering Services",
    "55520000": "Catering Services",      # catering
    "55521000": "Catering Services",
    "55523000": "Catering Services",
    "55524000": "Catering Services",      # school catering
    "3931": "Catering Services",          # 3931xxxx = catering equipment
    "3932": "Catering Services",          # 3932xxxx = restaurant equipment

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
    "3232": "Security Services",          # 3232xxxx = CCTV / surveillance apparatus
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
    "50334": "IT Managed Services",       # 50334xxx = telecommunications / comms system maintenance

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

    # ------------------ Energy & Utilities (31st sweet-spot category) ---
    # Distinct commercial-procurement lane: fuel supply, electricity/gas
    # contracts, solar hardware, water/electricity distribution utilities.
    # Added on top of the Tender_Analysis 30 to catch a real ~5% of
    # opportunities that were previously (unmapped).
    "09": "Energy & Utilities",           # 09xxxxxx = fuel / energy / solar
    "65": "Energy & Utilities",           # 65xxxxxx = public utilities (water/elec/gas distribution)
    "44300000": "Energy & Utilities",     # cable, wire and related products (utility scale)
    "31121000": "Energy & Utilities",     # generator sets (backup power)
    "31150000": "Energy & Utilities",     # ballasts (grid)

    # ------------------ Tactical tightening moves --------------------
    # These slot ~150 previously-unmapped rows into their correct existing
    # sweet-spot bucket. Each entry is a precise CPV prefix, not a broad one.

    # 793 broad -> Marketing & Comms (event/PR/design consulting/market research)
    "793": "Marketing & Comms",           # covers 79310 market research, 79340 advertising,
                                          # 79341 advertising, 79342 marketing, 79390 misc,
                                          # 79310000 (market and economic research)
    "79950000": "Marketing & Comms",      # exhibition/fair/congress organisation
    "79952000": "Marketing & Comms",      # event services
    "79953000": "Marketing & Comms",      # festival services
    "79961000": "Marketing & Comms",      # photographic services
    "79822000": "Marketing & Comms",      # setting services (typesetting/print prep)
    "79930000": "Marketing & Comms",      # speciality design services
    "79933000": "Marketing & Comms",      # design support services

    # 7942/3/5 -> Professional / Consultancy (surveys, statistical, evaluation)
    "79311": "Professional / Consultancy", # 79311xxx = market/social/opinion research
    "79315000": "Professional / Consultancy",  # social research services
    "79419000": "Professional / Consultancy",  # evaluation consultancy services
    "79422000": "Professional / Consultancy",  # planning services
    "79412000": "Professional / Consultancy",  # financial management consultancy
    "79413000": "Professional / Consultancy",  # marketing management consultancy
    "79415000": "Professional / Consultancy",  # production management consultancy
    "79417000": "Professional / Consultancy",  # safety consultancy
    "79418000": "Professional / Consultancy",  # procurement consultancy

    # 397 broad -> Electrical / M&E (domestic appliances: fridges, fans, heaters)
    "397": "Electrical / M&E",            # 397xxxxx = electrical/domestic appliances
    # (cleaning-specific 39713430 / 39714500 already override to Cleaning above)

    # 30xxx office / print / stationery machinery
    "3010": "Stationery & Supplies",      # 3010xxxx = office machinery except computers
    "3012": "Signage & Print",            # 3012xxxx = photocopiers / duplicators / print equip
    "3016": "Stationery & Supplies",      # 3016xxxx = postage-franking machines etc

    # 14 = mining / basic materials -> Construction / Refurb
    "14": "Construction / Refurb",        # 14xxxxxx = aggregates, tarmac, sand, stone, metals

    # 42 machinery — split by sub-family
    "42400000": "Vehicles & Fleet",       # lifting/handling equipment
    "424":      "Vehicles & Fleet",       # 424xxxxx = forklifts, cranes, hoists, elevators for goods
    "42416":    "Building Maintenance",   # 42416xxx = lifts (passenger — building infrastructure)
    "42500000": "Electrical / M&E",       # cooling/ventilation equipment
    "42510000": "Electrical / M&E",       # heat exchangers / boilers
    "42511000": "Electrical / M&E",       # heat pumps / HVAC packages
    "42520000": "Electrical / M&E",       # ventilation equipment
    "42900000": "Building Maintenance",   # misc general purpose machinery (pumps, compressors)
    "42910000": "Building Maintenance",
    "42920000": "Building Maintenance",

    # 90 top-level heading -> Waste Management (default for the broad heading)
    # NB: the 909 override for Cleaning already wins over this because longer.
    "90000000": "Waste Management",       # broad "Sewage/refuse/cleaning/environmental"

    # 983 broad -> Cleaning Services (janitorial + laundry)
    "98310000": "Cleaning Services",      # washing and dry-cleaning services
    "98311000": "Cleaning Services",      # laundry-collection
    "98312000": "Cleaning Services",      # textile-cleaning
    "98313000": "Cleaning Services",      # domestic-cleaning
    "98314000": "Cleaning Services",      # dyeing services
    "98315000": "Cleaning Services",      # pressing services
    "98341140": "Cleaning Services",      # janitorial services
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
