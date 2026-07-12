/* BidGov Compass — Live bids page (/live-bids) entry
   -----------------------------------------------------------------------
   Slim filter bar + 3-KPI strip + table. Fetches /api/live-tenders (server-
   locked to deadline >= now) and /api/live-stats for the KPI numbers.
   ----------------------------------------------------------------------- */

import { $, C, escapeHtml, fmtDate, fmtGBP, fmtInt, fmtRelDeadline, deadlineUrgency } from './fmt.js';
import { api } from './api.js';
import { upsertChart } from './charts.js';
import {
  loadLiveBidsFacets, loadLiveBidsFromUrl, pushLiveBidsUrlState,
  buildLiveBidsQuery, wireLiveBidsFilters,
  wireLiveBidsColumnPopovers, paintLiveBidsFilterActive,
} from './filters.js';
import { renderTenderTable, renderTableFoot, wireTrackButtons, wireHeaderSort } from './table.js';

let refreshTimer = null;
function refresh(delay = 0) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    pushLiveBidsUrlState();
    await Promise.all([refreshKpis(), refreshFeatured(), refreshTable()]);
  }, delay);
}

/* ==========================================================================
   Featured tenders — Airbnb hero-style horizontal card row.
   Cards land ABOVE the filter bar so the page opens with "here are the top
   sweet-spot picks", the same way Airbnb's home page opens with curated rows.
   Reshapes on every filter change (same refresh cycle as KPIs + charts + table).
   ========================================================================== */
async function refreshFeatured() {
  const row = $('#lbFeaturedRow');
  if (!row) return;
  const p = buildLiveBidsQuery();
  p.set('limit', 10);
  const r = await api('/api/live-featured?' + p.toString());
  if (!r) return;
  const rows = r.rows || [];
  if (!rows.length) {
    row.innerHTML = '<div class="lb-featured__empty muted">No live bids match the current filters.</div>';
    return;
  }
  row.innerHTML = rows.map(renderFeaturedCard).join('');
}

function renderFeaturedCard(t) {
  const urgency = deadlineUrgency(t.deadline);
  const isUrgent = urgency === 'today' || urgency === 'week';
  const dlAbs = t.deadline ? fmtDate(t.deadline) : '';
  const dlRel = fmtRelDeadline(t.deadline);
  const value = t.value_amount != null ? fmtGBP(t.value_amount) : '–';
  // `is_sweet` still drives the server-side ranking (sweet-spot cards land
  // first), but we no longer render a visual "Sweet-spot" badge — the row's
  // ordering is signal enough and the badge was visual noise.
  const link = t.notice_url
    ? `<a href="${escapeHtml(t.notice_url)}" target="_blank" rel="noopener" title="Open notice on source portal">${escapeHtml(t.title || '')}</a>`
    : escapeHtml(t.title || '');
  return `<article class="lb-fcard" role="listitem">
    <h3 class="lb-fcard__title">${link}</h3>
    <p class="lb-fcard__buyer">${escapeHtml(t.buyer_name || '')}</p>
    ${t.category ? `<span class="lb-fcard__cat">${escapeHtml(t.category)}</span>` : ''}
    <div class="lb-fcard__meta">
      <div class="lb-fcard__value">${value}</div>
      <div class="lb-fcard__deadline${isUrgent ? ' is-urgent' : ''}">
        <span class="lb-fcard__dlabs">${dlAbs}</span>
        <span class="lb-fcard__dlrel">${escapeHtml(dlRel)}</span>
      </div>
    </div>
  </article>`;
}

async function refreshKpis() {
  const p = buildLiveBidsQuery();
  const s = await api('/api/live-stats?' + p.toString());
  if (!s) return;
  $('#lbKpiOpen').textContent    = fmtInt(s.open_count);
  $('#lbKpiValue').textContent   = fmtGBP(s.total_open_value);
  $('#lbKpiValue').title         = s.total_open_value.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' });
  $('#lbKpiMedian').textContent  = fmtGBP(s.median_value);
  $('#lbKpiMedian').title        = (s.median_value || 0).toLocaleString('en-GB', { style: 'currency', currency: 'GBP' });
  $('#lbKpiClosing').textContent = fmtInt(s.closing_7d);
  renderOverviewCharts(s);
  paintPillboxSummaries();          // sync Category/Size/Deadline pillbox labels
  paintLiveBidsFilterActive();      // sync column-header filter-icon active state
}

/** Update the human-readable summary strings on each pill segment so the
 *  user can see the current selection without opening the popover. */
function paintPillboxSummaries() {
  // ---- Category
  const catValue = $('#lbPillCatValue');
  if (catValue) {
    const checked = [...document.querySelectorAll('#lbCategory input:checked')];
    if (!checked.length) {
      catValue.textContent = 'Any'; catValue.classList.remove('is-set');
    } else if (checked.length === 1) {
      catValue.textContent = checked[0].value; catValue.classList.add('is-set');
    } else {
      catValue.textContent = `${checked[0].value} + ${checked.length - 1} more`;
      catValue.classList.add('is-set');
    }
  }
  // ---- Size
  const sizeValue = $('#lbPillSizeValue');
  if (sizeValue) {
    const min = $('#lbMin')?.value, max = $('#lbMax')?.value;
    if (!min && !max) { sizeValue.textContent = 'Any value'; sizeValue.classList.remove('is-set'); }
    else {
      const fmt = v => v ? '£' + (v >= 1e6 ? (v/1e6).toFixed(1)+'m' : Math.round(v/1e3)+'k') : '';
      sizeValue.textContent = min && max ? `${fmt(min)} – ${fmt(max)}` : min ? `${fmt(min)}+` : `up to ${fmt(max)}`;
      sizeValue.classList.add('is-set');
    }
  }
  // ---- Deadline (exact-range takes precedence over cumulative window)
  const dlValue = $('#lbPillDeadlineValue');
  if (dlValue) {
    const after = $('#lbDeadlineAfter')?.value, before = $('#lbDeadlineBefore')?.value;
    const win = $('#lbDeadlineWindow')?.value;
    if (after || before) {
      dlValue.textContent = 'Custom range'; dlValue.classList.add('is-set');
    } else if (win) {
      dlValue.textContent = `Closing ≤ ${win} days`; dlValue.classList.add('is-set');
    } else {
      dlValue.textContent = 'Any'; dlValue.classList.remove('is-set');
    }
  }
  // Also paint active state on the quick-preset buttons in Size + Deadline popovers
  const min = $('#lbMin')?.value || '', max = $('#lbMax')?.value || '';
  document.querySelectorAll('.lb-sizebtn').forEach(b => {
    const [pMin, pMax] = b.dataset.sizePreset.split(',');
    b.classList.toggle('is-active', pMin === min && pMax === max);
  });
  const win = $('#lbDeadlineWindow')?.value || '';
  document.querySelectorAll('.lb-dlbtn').forEach(b => {
    b.classList.toggle('is-active', b.dataset.dlWindow === win);
  });
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

/** Deadline bucket → apply the EXACT differential range to the hidden
 *  #lbDeadlineAfter / #lbDeadlineBefore inputs, matching the chart bucket
 *  the user clicked. This fixes the earlier bug where clicking "15–30 days"
 *  sent a cumulative "≤30 days" filter that kept ≤7 and 8–14 rows in view.
 *  Also clears the cumulative #lbDeadlineWindow select so the two filter
 *  modes don't conflict. Second click on the same bucket = clear. */
const DEADLINE_BUCKETS = {
  '≤7 days':    { afterDays: 0,  beforeDays: 7 },
  '8–14 days':  { afterDays: 8,  beforeDays: 14 },
  '15–30 days': { afterDays: 15, beforeDays: 30 },
  '1–3 months': { afterDays: 31, beforeDays: 90 },
  '3+ months':  { afterDays: 91, beforeDays: null },  // open-ended top
};
function toggleDeadlineFilter(bucketLabel) {
  const spec = DEADLINE_BUCKETS[bucketLabel];
  if (!spec) return;
  const plus = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const after  = $('#lbDeadlineAfter');
  const before = $('#lbDeadlineBefore');
  const wantAfter  = plus(spec.afterDays);
  const wantBefore = spec.beforeDays != null ? plus(spec.beforeDays) : '';
  const alreadySet = after.value === wantAfter && before.value === wantBefore;
  if (alreadySet) {
    after.value = '';
    before.value = '';
  } else {
    after.value = wantAfter;
    before.value = wantBefore;
    // Clear the cumulative select so it doesn't fight the exact range
    const sel = $('#lbDeadlineWindow');
    if (sel) sel.value = '';
  }
  after.dispatchEvent(new Event('change', { bubbles: true }));
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

/* ==========================================================================
   Airbnb-style category carousel — top N sweet-spot categories with live
   counts, horizontally scrollable. Clicking a pill reuses toggleCategoryFilter
   (same helper as the pie-slice click) so state and behaviour stay unified.
   Repaints on every `by_category` update so counts + active state stay live.
   ========================================================================== */

/* Category carousel removed — the Category dropdown in the filter bar +
   the pie chart + the cross-filter click cover the same job without
   duplication. escapeHtml + $$ imports may become unused in this file;
   fmt.js keeps them exported for other pages. */

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
  // Show up to 14 real slices + the reserved "Other" grey (ramp[14]).
  // Was capped at 10 → 4 more real categories visible before rolling up.
  const top = cats.slice(0, 14);
  const other = cats.slice(14).reduce((a, b) => a + b.n, 0);
  const bgs = top.map((_, i) => C.ramp[i]);
  const labels = top.map(r => r.k);
  if (other) { labels.push('Other'); bgs.push(C.ramp[14]); }
  upsertChart('lbChartCategory', {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: top.map(r => r.n).concat(other ? [other] : []),
        backgroundColor: bgs,
        borderColor: '#fff',
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '55%',
      plugins: {
        title: { display: true, text: 'By category',
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
        title: { display: true, text: 'Deadline distribution',
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
        title: { display: true, text: 'Contract value distribution',
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

/** Wire the pillbox preset buttons — Size ("£30k-£135k" etc.) and Deadline
 *  ("Closing ≤ 7 days" etc.). Toggling a preset writes to the hidden inputs
 *  that buildLiveBidsQuery reads, then fires refresh via the standard
 *  wireLiveBidsFilters listeners. Second click on the same preset clears. */
function wirePillboxPresets() {
  const pillbox = document.querySelector('.lb-pillbox');
  if (!pillbox) return;
  pillbox.addEventListener('click', (e) => {
    const size = e.target.closest('.lb-sizebtn');
    if (size) {
      const [pMin, pMax] = size.dataset.sizePreset.split(',');
      const min = $('#lbMin'), max = $('#lbMax');
      const already = (min.value === pMin) && (max.value === pMax);
      min.value = already ? '' : pMin;
      max.value = already ? '' : pMax;
      min.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const dl = e.target.closest('.lb-dlbtn');
    if (dl) {
      const sel = $('#lbDeadlineWindow');
      const already = sel.value === dl.dataset.dlWindow;
      sel.value = already ? '' : dl.dataset.dlWindow;
      // Clear exact-range hidden inputs — cumulative select owns the state now
      $('#lbDeadlineAfter').value = '';
      $('#lbDeadlineBefore').value = '';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
  });
  // The search button on the right of the pillbox is decorative (filters
  // live-update); clicking it just forces an immediate refresh and closes
  // any open popovers.
  const searchBtn = $('#lbPillSearchBtn');
  if (searchBtn) {
    searchBtn.addEventListener('click', () => {
      document.querySelectorAll('.lb-pill[open]').forEach(d => d.removeAttribute('open'));
      refresh();
    });
  }
}

async function boot() {
  await loadLiveBidsFacets();
  loadLiveBidsFromUrl();
  wireLiveBidsFilters(refresh);
  wirePillboxPresets();                   // Size + Deadline preset button wiring (Phase 6c)
  wireHeaderSort(refresh, '#lbSort');     // Column header sort cycle (asc → desc → default)
  wireLiveBidsColumnPopovers(refresh);    // Column header filter popovers (bind to #lb* inputs)
  wireEmptyStateClear();
  wireTrackButtons('#lbBody');            // admin-only Save-deal button on rows
  // Keep column-filter icon active state in sync with any surface that
  // changes the hidden inputs (pillbox click, chart click, popover apply,
  // reset button, URL hydration). The popover apply/clear paths already
  // call this; the delegated listener below covers everything else.
  document.body.addEventListener('change', e => {
    if (e.target.matches('#lbCategory input, #lbSource input, ' +
                         '#lbMin, #lbMax, #lbDeadlineAfter, #lbDeadlineBefore, ' +
                         '#lbDeadlineWindow, #lbQ')) {
      paintLiveBidsFilterActive();
    }
  });
  refresh();                              // debounced internally; no promise to await
  window.addEventListener('popstate', () => {
    loadLiveBidsFromUrl();
    paintLiveBidsFilterActive();
    refresh();
  });
}

boot().catch(err => {
  console.error(err);
});
