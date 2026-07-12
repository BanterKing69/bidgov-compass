/* BidGov Compass — Live bids page (/live-bids) entry
   -----------------------------------------------------------------------
   Slim filter bar + 3-KPI strip + table. Fetches /api/live-tenders (server-
   locked to deadline >= now) and /api/live-stats for the KPI numbers.
   ----------------------------------------------------------------------- */

import { $, $$, C, fmtGBP, fmtInt } from './fmt.js';
import { api } from './api.js';
import { upsertChart } from './charts.js';
import {
  loadLiveBidsFacets, loadLiveBidsFromUrl, pushLiveBidsUrlState,
  buildLiveBidsQuery, wireLiveBidsFilters,
} from './filters.js';
import { renderTenderTable, renderTableFoot, wireTrackButtons } from './table.js';

let refreshTimer = null;
function refresh(delay = 0) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    pushLiveBidsUrlState();
    await Promise.all([refreshKpis(), refreshTable()]);
  }, delay);
}

async function refreshKpis() {
  const p = buildLiveBidsQuery();
  const s = await api('/api/live-stats?' + p.toString());
  if (!s) return;
  $('#lbKpiOpen').textContent    = fmtInt(s.open_count);
  $('#lbKpiValue').textContent   = fmtGBP(s.total_open_value);
  $('#lbKpiValue').title         = s.total_open_value.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' });
  $('#lbKpiClosing').textContent = fmtInt(s.closing_7d);
  renderOverviewCharts(s);
}

/* ==========================================================================
   Cross-filter helpers — chart click TOGGLES the matching sidebar filter,
   which fires the existing refresh cycle (KPIs + all 3 charts + table).
   Clicking the same element again clears that filter (toggle behaviour).
   The visual highlight of "this filter is active" is already handled by the
   existing chip/select CSS — no chart-level state needed.
   ========================================================================== */

/** Toggle a category on/off in the #lbCategory chip list. Fires 'change'
 *  which wireLiveBidsFilters catches → refresh() runs. */
function toggleCategoryFilter(category) {
  if (category === 'Other') return;          // synthesised bucket, no matching chip
  const cb = $$('#lbCategory input[type="checkbox"]')
             .find(el => el.value === category);
  if (!cb) return;                            // category not in facet list
  cb.checked = !cb.checked;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Deadline bucket → set the #lbDeadlineWindow select to the matching window.
 *  Clicking the SAME bucket clears it (toggle). */
const DEADLINE_BUCKET_TO_WINDOW = {
  '≤7 days':   '7',
  '8–14 days': '14',
  '15–30 days': '30',
  // 1–3 months and 3+ months have no matching window value; drop these clicks
};
function toggleDeadlineFilter(bucketLabel) {
  const val = DEADLINE_BUCKET_TO_WINDOW[bucketLabel];
  if (!val) return;
  const sel = $('#lbDeadlineWindow');
  sel.value = (sel.value === val) ? '' : val;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Value band → set min/max range. Same band clicked twice = clear. */
const VALUE_BAND_RANGES = {
  '< £30k':        [0,      29999],
  '£30k–£135k':    [30000,  135000],
  '£135k–£300k':   [135000, 300000],
  '£300k–£664k':   [300000, 664000],
  '> £664k':       [664000, ''],       // no upper bound
  // 'Unknown' — no numeric range to filter by; ignore
};
function toggleValueFilter(bandLabel) {
  const range = VALUE_BAND_RANGES[bandLabel];
  if (!range) return;
  const [lo, hi] = range;
  const min = $('#lbMin'), max = $('#lbMax');
  const alreadySet = String(min.value) === String(lo) && String(max.value) === String(hi);
  if (alreadySet) {
    min.value = ''; max.value = '';
  } else {
    min.value = lo; max.value = hi;
  }
  min.dispatchEvent(new Event('input', { bubbles: true }));
  max.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Three charts above the table (Phase 5 addition):
 *   1. Category doughnut — top-10 categories in the live-tender set
 *   2. Deadline bucket bar — how many bids close in ≤7d / 8–14d / 15–30d / 1–3mo / 3+mo
 *   3. Contract-value distribution bar — the same value bands used elsewhere
 * All three redraw on every filter change so they reflect the current slice.
 * Every chart is CLICKABLE — clicking an element cross-filters the whole page
 * (toggles the matching sidebar filter and lets the standard refresh cycle
 * repaint everything). Same element clicked twice = filter cleared.
 */
function renderOverviewCharts(s) {
  if (typeof window.Chart === 'undefined') return;   // defensive; script tag is in the template

  // ---- 1. Category doughnut (top 10 + "Other") --------------------------
  const cats = s.by_category || [];
  const top = cats.slice(0, 10);
  const other = cats.slice(10).reduce((a, b) => a + b.n, 0);
  upsertChart('lbChartCategory', {
    type: 'doughnut',
    data: {
      labels: top.map(r => r.k).concat(other ? ['Other'] : []),
      datasets: [{
        data: top.map(r => r.n).concat(other ? [other] : []),
        backgroundColor: C.ramp,
        borderColor: '#fff',
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '55%',
      plugins: {
        title: { display: true, text: 'By category · click a slice to filter',
                 font: { family: 'Poppins', weight: '600', size: 13 } },
        legend: { position: 'right', labels: { boxWidth: 10, padding: 6, font: { size: 10 } } },
      },
      // Cross-filter: clicking a slice toggles that category chip and
      // repaints all 3 charts + KPIs + table via the standard refresh cycle.
      onClick(_evt, elements, chart) {
        if (!elements.length) return;
        toggleCategoryFilter(chart.data.labels[elements[0].index]);
      },
    },
  });

  // ---- 2. Deadline bucket (bar; red for ≤7d urgency) --------------------
  const dlOrder = ['≤7 days', '8–14 days', '15–30 days', '1–3 months', '3+ months'];
  const dlMap = Object.fromEntries((s.by_deadline || []).map(r => [r.k, r.n]));
  upsertChart('lbChartDeadline', {
    type: 'bar',
    data: {
      labels: dlOrder,
      datasets: [{
        label: 'Notices',
        data: dlOrder.map(k => dlMap[k] || 0),
        backgroundColor: dlOrder.map(k => k === '≤7 days' ? C.bid
                                       : k === '8–14 days' ? C.bidHover
                                       : C.gov),
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        title: { display: true, text: 'Deadline distribution · click a bar to filter',
                 font: { family: 'Poppins', weight: '600', size: 13 } },
        legend: { display: false },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 } } },
        y: { grid: { color: C.line }, ticks: { precision: 0 } },
      },
      // Cross-filter: sets #lbDeadlineWindow to 7/14/30 (or clears if same).
      // The 1–3 mo / 3+ mo / no-deadline buckets don't map to a select option,
      // so those clicks intentionally no-op (helper returns early).
      onClick(_evt, elements, chart) {
        if (!elements.length) return;
        toggleDeadlineFilter(chart.data.labels[elements[0].index]);
      },
    },
  });

  // ---- 3. Contract-value distribution -----------------------------------
  const bandOrder = ['< £30k', '£30k–£135k', '£135k–£300k', '£300k–£664k', '> £664k', 'Unknown'];
  const bandMap = Object.fromEntries((s.by_value_band || []).map(r => [r.k, r.n]));
  upsertChart('lbChartValue', {
    type: 'bar',
    data: {
      labels: bandOrder,
      datasets: [{
        label: 'Notices',
        data: bandOrder.map(k => bandMap[k] || 0),
        // Sweet-spot bands (£30k–£300k) get the red highlight
        backgroundColor: bandOrder.map(k =>
          (k === '£30k–£135k' || k === '£135k–£300k') ? C.bid : C.gov),
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        title: { display: true, text: 'Contract value distribution · click a bar to filter',
                 font: { family: 'Poppins', weight: '600', size: 13 } },
        legend: { display: false },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 } } },
        y: { grid: { color: C.line }, ticks: { precision: 0 } },
      },
      // Cross-filter: sets #lbMin / #lbMax to the band's endpoints (or clears).
      // 'Unknown' has no numeric range → no-op.
      onClick(_evt, elements, chart) {
        if (!elements.length) return;
        toggleValueFilter(chart.data.labels[elements[0].index]);
      },
    },
  });
}

async function refreshTable() {
  const p = buildLiveBidsQuery();
  p.set('limit', 500);
  const r = await api('/api/live-tenders?' + p.toString());
  if (!r) return;
  renderTenderTable($('#lbBody'), r.rows, {
    colSpan: 6,
    emptyOnClearBtnId: 'lbResetBtn',
    emptyTitle: 'No live bids match your filters.',
    emptyBody: 'Try widening the value range or clearing categories.',
  });
  renderTableFoot($('#lbTblFoot'), r.returned, r.total);
}

function wireEmptyStateClear() {
  document.body.addEventListener('click', e => {
    const btn = e.target.closest('[data-clear-filters]');
    if (!btn) return;
    const id = btn.dataset.clearFilters;
    const target = document.getElementById(id);
    if (target) target.click();
  });
}

async function boot() {
  await loadLiveBidsFacets();
  loadLiveBidsFromUrl();
  wireLiveBidsFilters(refresh);
  wireEmptyStateClear();
  wireTrackButtons('#lbBody');           // admin-only Track button on rows (Phase 4)
  refresh();                              // debounced internally; no promise to await
  window.addEventListener('popstate', () => { loadLiveBidsFromUrl(); refresh(); });
}

boot().catch(err => {
  console.error(err);
});
