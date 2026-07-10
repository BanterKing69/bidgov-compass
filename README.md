# BidGov Compass

**UK / EU public-sector tender intelligence** — a self-contained Flask app that
scrapes the government open-data portals into one normalised schema, categorises
every notice against the GovBid *sweet-spot* strategy, and serves a branded
dashboard with filters, pivots, charts, and a natural-language chat over the
data.

Ships with a live SQLite store of **5,287 notices** (~544 currently open) so
the dashboard has real data on first launch.

---

## 1. What it collects

| Portal | Method | Notes |
|---|---|---|
| **Find a Tender** (UK-wide) | OCDS JSON API | Above-threshold notices; 30-day date chunks |
| **Contracts Finder** (England) | OCDS JSON API | Incl. below-threshold; 30-day date chunks |
| **Public Contracts Scotland** | OCDS JSON API | Rolling window (~30 days) |
| **TED** (EU/EEA) | Search API v3 | UK place-of-performance, `iterationNextToken` paging |
| Sell2Wales | OCDS → Firecrawl → skip | OCDS often 500s upstream; Firecrawl fallback if key set |

No commercial aggregators (Tussell, Tracker, BiP, Tenders Direct) are scraped —
they re-sell the same free gov open data and their ToS forbids it.

## 2. The normalised schema

One `Tender` row per opportunity, source-agnostic, in `tenders.db`:

| Field | |
|---|---|
| `uid`, `source`, `source_id` | deterministic PK + provenance |
| `title`, `description`, `notice_stage`, `procurement_category` | what the opportunity is |
| `category` | one of **30 GovBid sweet-spot categories** (mapped from CPV) |
| `cpv_code`, `cpv_description` | Common Procurement Vocabulary |
| `buyer_name`, `buyer_region`, `country` | who / where |
| `value_amount`, `value_currency` | money |
| `published_date`, `deadline`, `status`, `is_open` | timing (is_open = deadline in future) |
| `notice_url`, `documents_url`, `source_api_url` | **retained links** to the live notice + API |
| `raw_json` | full original record (complete provenance) |

Every open notice has a `notice_url` and `raw_json` retained — 100% coverage.

## 3. Running the app

```bash
pip install -r requirements.txt
python3 app.py                       # http://127.0.0.1:5057
```

Optional environment:

```bash
export ANTHROPIC_API_KEY=sk-ant-...  # unlocks free-form NL chat via Claude
export FIRECRAWL_API_KEY=fc-...      # optional Sell2Wales HTML fallback
```

## 4. Dashboard features

- **KPI row**: notices matching / open / total & average value
- **Overview charts**: category doughnut, source bar, value-band bar, deadline urgency, top categories by total contract value — all filter-aware
- **Sidebar filters**: full-text, status, value range, deadline range, category (30), source
- **Table** with per-column controls (Excel-style):
  - Click header text: sort asc → desc → default
  - Click filter icon: search box / checkbox list / range / date range popover
  - All popovers sync bidirectionally with the sidebar (one source of truth)
- **Pivot** (jQuery PivotTable.js): drag-drop rows / cols / aggregators
- **Ask the data (chat)**: NL→SQL over the tenders table, with safety gate, auto-charts on aggregates, and follow-up chips
- **Scrape now** modal: run the collectors in the background with live log tail
- **Export**: filtered CSV or branded Excel (respects every active filter)

## 5. Re-scraping

From the browser: click **Scrape now** → set window/pages → **Start**.
From the CLI:

```bash
python3 run.py --days-back 30 --max-pages 25           # default
python3 run.py --days-back 365 --chunk-days 30 --max-pages 0  # full 12-month backfill
python3 run.py --sources fts,cf --recategorize-only    # apply latest CPV map to existing rows
```

The 12-month sweep runs in ~10-15 minutes. Every collector has:

- **Date-window chunking** (default 30-day chunks) — resilient to gateway timeouts
- **Per-page persistence** (default `--flush-every 50`, matches page size) — a mid-run failure never loses more than one page
- **Jittered exponential backoff** on transient 5xx/timeouts
- **Chunk-failure isolation** — one bad chunk doesn't kill the whole source
- **Loud truncation warnings** — never silently under-collects
- Re-runs are idempotent via `INSERT OR REPLACE ON uid`

## 6. Chat — what works without an API key

The rule engine handles ~35 canonical patterns across 9 intent families:

- **Counts**: "how many open?", "how many total?"
- **Top-N**: "biggest deals", "smallest tenders"
- **Deadlines**: "closing today", "closing this week", "closing next month"
- **Aggregates**: "average value", "median value", "total value"
- **Group-by (auto-charts)**: "by category", "by buyer", "by source", "by region", "by month"
- **Value bands**: "sweet-spot", "under £100k", "over £500k", "between £50k and £300k"
- **Buyer / region**: "in NHS", "for London"
- **Category shortcuts** (30 categories, 62 aliases): "PPE", "M&E", "hvac", "cleaning", "construction/refurb", "vehicles", "fm", …

Set `ANTHROPIC_API_KEY` for open-ended free-form questions via Claude Haiku 4.5.

Every SQL query — rule-based or Claude-generated — passes through the same
safety gate: **SELECT-only, one statement, forced LIMIT, forbidden-keyword filter**.

## 7. Architecture

```
app.py                        Flask backend (API + dashboard)
chat.py                       NL→SQL (rule engine + optional Claude) + safety gate
schema.py                     Tender dataclass, SQLite DDL, CPV→category map
normalize.py                  OCDS→Tender, TED→Tender, open/live logic, date parsing
db.py                         SQLite upsert + CSV/Excel export + recategorise + stats
run.py                        Orchestrator: chunked collection, per-page flush, warnings
collectors/
  base.py                     HTTP session (retry + jitter + macOS truststore)
  ocds.py                     Find a Tender + Contracts Finder (shared OCDS + chunking)
  ted.py                      TED Search API v3
  devolved.py                 Public Contracts Scotland + Sell2Wales
  firecrawl_client.py         optional Firecrawl REST wrapper (HTML portals)
templates/dashboard.html      single-page dashboard
static/css/style.css          branded design system (Poppins/Inter, GovBid palette)
static/js/dashboard.js        filters, table, charts, pivot, chat, scrape modal
static/img/logo.jpeg          GovBid logo
data/tenders.db               SQLite store — the collected dataset
```

## 8. Brand

- Base **`#54565B`** (charcoal — "Gov") — headings, chrome
- Accent **`#E03C31`** (red — "Bid") — CTAs, deadline highlights (hover `#C22F26`)
- Background `#F8F7F5` off-white · cards `#FFFFFF` · secondary text `#8A8D91`
- Poppins 600/700 (headlines) + Inter 400/500 (body), Google Fonts

## 9. Data licence & conduct

All collected data is UK/EU government **open data** (Open Government Licence /
TED re-use terms). Collectors identify themselves, rate-limit, and back off. No
logins, paywalls, or anti-bot protections are bypassed.
