/* BidGov Compass — Chart.js setup + renderers (shared module)
   -----------------------------------------------------------------------
   Assumes `window.Chart` is provided by the CDN <script> in the page's head.
   The five charts are exported both individually (so a page can render only
   the ones it needs) and via `renderAllDashboardCharts(stats)` as a shortcut
   used by /dashboard.
   ----------------------------------------------------------------------- */

import { C, $, fmtGBP, fmtGBPFull, fmtInt } from './fmt.js';

// Chart.js is loaded via a CDN <script> tag in the template head.
// Apply brand defaults once when this module is imported.
if (typeof window !== 'undefined' && window.Chart) {
  const Chart = window.Chart;
  Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.color = C.gov;
  Chart.defaults.borderColor = C.line;
  Chart.defaults.plugins.legend.labels.font = { family: "'Inter'", size: 11 };
}

// Per-canvas registry so upsertChart destroys the previous instance cleanly.
const _charts = {};
export function upsertChart(id, cfg) {
  const el = document.getElementById(id);
  if (!el) return null;
  if (_charts[id]) _charts[id].destroy();
  _charts[id] = new window.Chart(el.getContext('2d'), cfg);
  return _charts[id];
}

// ---- Individual chart renderers (all take one `s` = /api/stats payload)
// so page code can pick and mix. --------------------------------------------

export function renderCategoryChart(s) {
  // Show up to 14 real slices + reserved "Other" grey; palette expanded
  // from 10 → 15 colours so adjacent slices no longer share a hue.
  const catRows = s.by_category.slice(0, 14);
  const otherN  = s.by_category.slice(14).reduce((a, b) => a + b.n, 0);
  const catLabels = catRows.map(r => r.k).concat(otherN ? ['Other'] : []);
  const catData   = catRows.map(r => r.n).concat(otherN ? [otherN] : []);
  const catBg     = catRows.map((_, i) => C.ramp[i])
                           .concat(otherN ? [C.ramp[14]] : []);
  upsertChart('chartCategory', {
    type: 'doughnut',
    data: {
      labels: catLabels,
      datasets: [{ data: catData, backgroundColor: catBg, borderColor: '#fff', borderWidth: 2 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '55%',
      plugins: {
        title: { display: true, text: 'By category', font: { family: 'Poppins', weight: '600', size: 13 } },
        legend: { position: 'right', labels: { boxWidth: 10, padding: 8 } },
      }
    }
  });
}

export function renderSourceChart(s) {
  upsertChart('chartSource', {
    type: 'bar',
    data: {
      labels: s.by_source.map(r => r.k),
      datasets: [{ label: 'Notices', data: s.by_source.map(r => r.n), backgroundColor: C.bid, borderRadius: 4 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      plugins: {
        title: { display: true, text: 'By source portal', font: { family: 'Poppins', weight: '600', size: 13 } },
        legend: { display: false }
      },
      scales: { x: { grid: { color: C.line } }, y: { grid: { display: false } } }
    }
  });
}

export function renderBandsChart(s) {
  const bandOrder = ['< £30k', '£30k–£135k', '£135k–£300k', '£300k–£664k', '> £664k', 'Unknown'];
  const bandMap = Object.fromEntries(s.by_value_band.map(r => [r.k, r.n]));
  upsertChart('chartBands', {
    type: 'bar',
    data: {
      labels: bandOrder,
      datasets: [{ label: 'Notices', data: bandOrder.map(k => bandMap[k] || 0),
                   backgroundColor: bandOrder.map((k) =>
                     k === '£30k–£135k' || k === '£135k–£300k' ? C.bid : C.gov),
                   borderRadius: 4 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        title: { display: true, text: 'By contract value', font: { family: 'Poppins', weight: '600', size: 13 } },
        legend: { display: false }
      },
      scales: { x: { grid: { display: false }, ticks: { font: { size: 10 } } },
                y: { grid: { color: C.line } } }
    }
  });
}

export function renderDeadlineChart(s) {
  const dlOrder = ['This week', 'This month', '1–3 months', '3+ months', 'No deadline'];
  const dlMap = Object.fromEntries(s.by_deadline.map(r => [r.k, r.n]));
  upsertChart('chartDeadline', {
    type: 'bar',
    data: {
      labels: dlOrder,
      datasets: [{ label: 'Notices', data: dlOrder.map(k => dlMap[k] || 0),
                   backgroundColor: dlOrder.map(k =>
                     k === 'This week' ? C.bid : k === 'This month' ? C.bidHover : C.gov),
                   borderRadius: 4 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        title: { display: true, text: 'By deadline urgency', font: { family: 'Poppins', weight: '600', size: 13 } },
        legend: { display: false }
      },
      scales: { x: { grid: { display: false } }, y: { grid: { color: C.line } } }
    }
  });
}

export function renderTopCategoryValueChart(s) {
  const topByValue = [...s.by_category]
    .filter(r => r.k !== '(unmapped)')
    .sort((a, b) => (b.total_v || 0) - (a.total_v || 0))
    .slice(0, 15);
  upsertChart('chartTopCat', {
    type: 'bar',
    data: {
      labels: topByValue.map(r => r.k),
      datasets: [{ label: 'Total £', data: topByValue.map(r => r.total_v || 0),
                   backgroundColor: C.gov, borderRadius: 4 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        title: { display: true, text: 'Top categories by total contract value',
                 font: { family: 'Poppins', weight: '600', size: 13 } },
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => fmtGBPFull(ctx.raw) } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 45, minRotation: 30, font: { size: 10 } } },
        y: { grid: { color: C.line }, ticks: { callback: v => fmtGBP(v) } }
      }
    }
  });
}

/** Render all five dashboard charts from a /api/stats payload. */
export function renderAllDashboardCharts(s) {
  renderCategoryChart(s);
  renderSourceChart(s);
  renderBandsChart(s);
  renderDeadlineChart(s);
  renderTopCategoryValueChart(s);
}

/**
 * Write a KPI value + optional tooltip (full-precision) + optional sublabel.
 * Used by both the Search KPIs (before Phase 2 removal) and the Dashboard/Live-bids
 * pages that keep KPIs.
 */
export function setKpi(id, value, tooltip, sublabel) {
  const el = $('#' + id);
  if (!el) return;
  el.textContent = value;
  if (tooltip) el.title = tooltip; else el.removeAttribute('title');
  const kpi = el.closest('.kpi');
  if (kpi && sublabel) {
    const s = kpi.querySelector('.kpi__delta');
    if (s) s.textContent = sublabel;
  }
}

/**
 * Convenience: render the four KPIs used on /dashboard from a /api/stats payload.
 * `closing_7d` is a Phase-2 additive field on /api/stats.totals.
 */
export function renderDashboardKpis(s) {
  const t = s.totals;
  setKpi('kpiTotal',   fmtInt(t.notices),                        null,                        'Notices in the store');
  setKpi('kpiOpen',    fmtInt(t.open),                           null,                        'Deadline in the future');
  setKpi('kpiValue',   fmtGBP(t.median_value),                   fmtGBPFull(t.median_value),  `Median contract value · P90 ${fmtGBP(t.p90_value)}`);
  setKpi('kpiClosing', fmtInt(t.closing_7d ?? 0),                null,                        'Deadline within 7 days');
}
