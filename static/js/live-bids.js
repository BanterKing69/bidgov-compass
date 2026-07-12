/* BidGov Compass — Live bids page (/live-bids) entry
   -----------------------------------------------------------------------
   Slim filter bar + 3-KPI strip + table. Fetches /api/live-tenders (server-
   locked to deadline >= now) and /api/live-stats for the KPI numbers.
   ----------------------------------------------------------------------- */

import { $, C, fmtGBP, fmtInt } from './fmt.js';
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

/**
 * Three charts above the table (Phase 5 addition):
 *   1. Category doughnut — top-10 categories in the live-tender set
 *   2. Deadline bucket bar — how many bids close in ≤7d / 8–14d / 15–30d / 1–3mo / 3+mo
 *   3. Contract-value distribution bar — the same value bands used elsewhere
 * All three redraw on every filter change so they reflect the current slice.
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
        title: { display: true, text: 'By category · click a slice to drill',
                 font: { family: 'Poppins', weight: '600', size: 13 } },
        legend: { position: 'right', labels: { boxWidth: 10, padding: 6, font: { size: 10 } } },
      },
      // Drill-through: clicking a slice sends you to Search filtered by that category.
      onClick(_evt, elements, chart) {
        if (!elements.length) return;
        const cat = chart.data.labels[elements[0].index];
        if (cat === 'Other') return;   // "Other" is a bucket, not a real category
        // Search route (/) accepts ?category=... — hydrated on load by loadSearchFromUrl.
        window.location = '/?category=' + encodeURIComponent(cat);
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
        title: { display: true, text: 'Deadline distribution',
                 font: { family: 'Poppins', weight: '600', size: 13 } },
        legend: { display: false },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 } } },
        y: { grid: { color: C.line }, ticks: { precision: 0 } },
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
        title: { display: true, text: 'Contract value distribution',
                 font: { family: 'Poppins', weight: '600', size: 13 } },
        legend: { display: false },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 } } },
        y: { grid: { color: C.line }, ticks: { precision: 0 } },
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
