/* BidGov Compass — Live bids page (/live-bids) entry
   -----------------------------------------------------------------------
   Slim filter bar + 3-KPI strip + table. Fetches /api/live-tenders (server-
   locked to deadline >= now) and /api/live-stats for the KPI numbers.
   ----------------------------------------------------------------------- */

import { $, fmtGBP, fmtInt } from './fmt.js';
import { api } from './api.js';
import {
  loadLiveBidsFacets, loadLiveBidsFromUrl, pushLiveBidsUrlState,
  buildLiveBidsQuery, wireLiveBidsFilters,
} from './filters.js';
import { renderTenderTable, renderTableFoot } from './table.js';

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
  await refresh();
  window.addEventListener('popstate', () => { loadLiveBidsFromUrl(); refresh(); });
}

boot().catch(err => {
  console.error(err);
});
