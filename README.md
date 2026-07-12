# BidGov Compass

**UK / EU public-sector tender intelligence** — a self-contained Flask app that
scrapes the government open-data portals into one normalised schema, categorises
every notice against the GovBid *sweet-spot* strategy, and serves a branded
dashboard with filters, pivots, charts, and a natural-language chat over the
data.

Ships with a live SQLite store of **9,199 notices** (~540 currently open) so
the dashboard has real data on first launch.

## Deploy your own copy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/BanterKing69/bidgov-compass)

One click → sign in with GitHub → Render reads [`render.yaml`](render.yaml) and
spins up a live URL like `https://bidgov-compass.onrender.com` in ~3 minutes.
Free tier — no card required. The free web service sleeps after 15 min idle
and takes ~30 s to wake on the next visit.

## Members portal

Every page and API route is behind email+password login (Flask-Login,
PBKDF2 password hashing, HttpOnly signed session cookies). Signup is open —
the first account to register becomes admin.

- **/auth/signup** — create account (min 8-char password)
- **/auth/login** — sign in (with "keep me signed in" 30-day remember)
- **/auth/account** — change password, see admin status
- **/auth/logout** — end session

Users live in `data/users.db` — **separate** from the tenders store so
redeploying tender data never wipes accounts. In production, set:

```bash
SECRET_KEY=...                 # signs session cookies (Render generates one)
SESSION_COOKIE_SECURE=1        # cookies over HTTPS only
```

Both are set automatically by `render.yaml` on first deploy.

### Portal IA & roles (2026-07 refactor — feat/portal-ia)

Five icon-rail routes, split by audience:

| Rail icon | Route | Access | What it does |
|---|---|---|---|
| Live bids | `/live-bids` | any user | Open tenders only, urgency-forward (deadline ≤7d in red). Server-locked `deadline >= now` — the "is_open" flag goes stale between scrapes, so we compare deadlines at query time. |
| Won contracts | `/awards` | any user | Awarded contracts view. Real supplier data. |
| Search | `/` | any user | Full explorer: sidebar filters, Table · Pivot · Ask-the-data tabs, Excel-style column popovers, shareable filter URLs (state mirrored to `?query`). |
| Dashboard | `/dashboard` | any user | KPIs + five Chart.js charts. "Closing ≤7 days" is red. |
| Admin | `/admin` | `is_admin=1` only | Sales console. Icon is server-side conditional — non-admins never see it. |

Post-login default landing: **`/live-bids`** (highest signal per screen; explicit `?next=/foo` still honoured).

### Admin console (`/admin` — `is_admin` only)

Single page, four tabs, wired in `static/js/admin.js`:

- **Overview** — fee economics computed from the pipeline table joined against tenders.db (see next section). One bar chart, Chart.js.
- **Pipeline** — deal-tracking CRUD (inline stage/client editing, add-by-search, `Track` action on tender rows). CSV export includes fee columns; **fee data exists only under `/admin`**.
- **Users** — list + activate/deactivate/promote/demote/delete. Cannot act on your own account. Cannot demote/deactivate/delete the last active admin.
- **Data ops** — relocated Scrape modal + live log tail (`POST /api/scrape`, `GET /api/scrape/status`) and Excel/CSV bulk Export (`GET /api/export`) with a scope picker (Live tenders / All tenders / Awards). All three endpoints are `admin_required` — non-admins get JSON 403.

### Pipeline & fee model (Phase 4)

New table in **`users.db`** (never `tenders.db` — keeps fee data out of the chat-queryable connection by construction):

```sql
CREATE TABLE IF NOT EXISTS pipeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tender_uid TEXT NOT NULL UNIQUE,          -- FK by convention → tenders.uid
  client_name TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'qualified',  -- qualified|quoted|writing|submitted|won|lost
  fee_upfront REAL NOT NULL DEFAULT 1500,
  fee_success_pct REAL NOT NULL DEFAULT 5.0,
  outcome_value REAL,
  notes TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
```

Success fee = `fee_success_pct% × coalesce(outcome_value, tender.value)`. Expected £/deal = `1500 + 5% × value × win_rate(category)`. The 30-category win-rate map is embedded in [`pipeline.py`](pipeline.py) verbatim from `Tender_Analysis.xlsx` (sheet "Sweet Spot"); unmapped categories default to 0.15. Tweaking the map is a code edit — no data migration.

Two-DB join: pipeline rows are augmented at read time with tender info via a **separate short-lived connection** to `tenders.db`. Never `ATTACH` — that would expose pipeline to chat's SQL gate.

### CSRF (Phase 4)

`Flask-WTF`'s `CSRFProtect` is enabled app-wide. Every non-GET request must include an `X-CSRFToken` header (JSON APIs, via `static/js/api.js` — read from the `<meta name="csrf-token">` tag baked into `_app_base.html`) **or** a `csrf_token` form field (auth forms — hidden input rendered by `{{ csrf_token() }}`). `/health` is GET, unaffected. State-changing POST without the token → 400.

### Environment flags added by this refactor

- `ALLOW_SIGNUP` (default `"1"`) — set to `"0"` / `"false"` / `"no"` / `"off"` to close open registration. `/auth/signup` returns 403 with a friendly "invite-only" page, and the "Create an account" link disappears from `/auth/login`. Bypassed automatically when the users table is empty, so first-registrant bootstrap always works.
- `SECRET_KEY`, `SESSION_COOKIE_SECURE` — as before. `SESSION_COOKIE_SAMESITE` is set to `Lax` in code.

### Render free-tier caveat (⚠ before real client use)

Render's free instance has **no persistent disk** — the container's local filesystem is wiped on every redeploy/restart. That means `data/users.db` (which holds **user accounts *and* the pipeline table**) is **lost on redeploy**. This is fine for prototype / demo use; before onboarding paying clients, either:

1. Move to a Render paid tier with an attached persistent disk, or
2. Move `users.db` contents to a hosted DB (Neon, Supabase, PlanetScale, etc.) and swap `auth._conn()` + `pipeline._conn()` to point at it.

The tenders store (`data/tenders.db`) also lives on the ephemeral disk but ships in the repo and can be re-scraped from source at any time (Admin → Data ops → Scrape now).

### Tests

`pytest tests/` (25 tests, ~2s): access matrix (anon/user/admin × client/admin surfaces), self-action guards, last-admin guard, pipeline CRUD round-trip, fee-economics equal to hand-computed reference on real DB values, CSRF gate, chat isolation (pipeline absent from tenders.db + chat body never contains sensitive pipeline data). `pytest` is in `requirements.txt` but the app never imports it.

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
