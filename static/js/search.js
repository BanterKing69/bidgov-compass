/* BidGov Compass — Search page (/) entry
   -----------------------------------------------------------------------
   Replaces static/js/dashboard.js. Wires up the full explorer: sidebar
   filters + column popovers + Table/Pivot/Chat tabs. No charts, no KPIs,
   no scrape modal, no export buttons (those move to admin in Phase 3;
   dashboard/live-bids own the KPI/chart display).
   ----------------------------------------------------------------------- */

import { $, $$, escapeHtml, fmtGBP, fmtGBPFull, fmtInt, fmtDate, C } from './fmt.js';
import { api } from './api.js';
import { upsertChart } from './charts.js';
import {
  loadFacets, wireSearchFilters, wireColumnPopovers,
  loadSearchFromUrl, pushSearchUrlState, buildSearchQuery, paintFilterActive,
} from './filters.js';
import {
  renderTenderTable, renderTableFoot, wireHeaderSort, wireTrackButtons,
} from './table.js';
import { initValueSlider } from './value-slider.js';

/* ---- Refresh cycle: sync URL, refetch table (+ groupby if visible) ------ */
let refreshTimer = null;
function refresh(delay = 0) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    pushSearchUrlState();
    await refreshTable();
    if ($('#tab-pivot').classList.contains('is-active')) refreshGroupby();
  }, delay);
}

async function refreshTable() {
  const p = buildSearchQuery();
  p.set('limit', 500);
  const r = await api('/api/tenders?' + p.toString());
  if (!r) return;
  const tbody = $('#tblBody');
  renderTenderTable(tbody, r.rows, {
    colSpan: 6,
    emptyOnClearBtnId: 'resetBtn',
    emptyTitle: 'No tenders match your filters.',
    emptyBody: 'Try widening the value range or removing category filters.',
  });
  renderTableFoot($('#tblFoot'), r.returned, r.total);
}

/* ---- Group-by tab (Phase 5 — replaces jQuery drag-drop pivot) ----------- */
// One-dimension GROUP BY via /api/aggregate + Chart.js bar chart. Click any
// bar OR any table row to APPLY that value as a filter on the sidebar and
// jump back to the Table tab — pivot becomes an exploration jumping-off
// point instead of a dead-end summary.

const GROUPBY_DIM_TO_FILTER = {
  // Which sidebar filter to set when a group is clicked.
  //   'checkbox' → check the matching checklist entry inside #fltCategory/#fltSource
  //   'query'    → put the value in #fltQ (used for buyer/region since they're free-text)
  //   'noop'     → drill isn't meaningful for this dimension (e.g. value_band already IS the filter)
  category:       { kind: 'checkbox', boxSel: '#fltCategory' },
  source:         { kind: 'checkbox', boxSel: '#fltSource' },
  buyer:          { kind: 'query',    inputSel: '#fltQ' },
  region:         { kind: 'query',    inputSel: '#fltQ' },
  deadline_month: { kind: 'noop' },
  value_band:     { kind: 'noop' },
};

const GROUPBY_DIM_LABEL = {
  category: 'Category', buyer: 'Buyer', source: 'Source',
  region: 'Region', deadline_month: 'Deadline month', value_band: 'Value band',
};

async function refreshGroupby() {
  const p = buildSearchQuery();
  const dim = $('#grpDim').value;
  const metric = $('#grpMetric').value;
  p.set('group_by', dim);
  p.set('metric', metric);
  const r = await api('/api/aggregate?' + p.toString());
  if (!r) return;

  const isCount = metric === 'count';
  const fmtVal = isCount ? fmtInt : fmtGBP;

  // ---- Table ----
  $('#grpDimHead').textContent = GROUPBY_DIM_LABEL[dim];
  $('#grpValHead').textContent = r.metric_label;
  const tbody = $('#grpBody');
  if (!r.rows.length) {
    tbody.innerHTML = '<tr><td colspan="2" class="center muted">No matching rows.</td></tr>';
  } else {
    tbody.innerHTML = r.rows.map(row => `
      <tr data-group-value="${escapeHtml(String(row.k ?? ''))}" class="groupby-row" tabindex="0">
        <td>${escapeHtml(String(row.k ?? '(none)'))}</td>
        <td class="num" title="${escapeHtml(fmtGBPFull(row.v))}">${fmtVal(row.v)}</td>
      </tr>
    `).join('');
  }

  // ---- Chart (top 15) ----
  const top = r.rows.slice(0, 15);
  upsertChart('grpChart', {
    type: 'bar',
    data: {
      labels: top.map(x => String(x.k ?? '(none)')),
      datasets: [{
        label: r.metric_label,
        data: top.map(x => x.v),
        backgroundColor: C.gov,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        title: { display: true, text: `${GROUPBY_DIM_LABEL[dim]} · ${r.metric_label} (top 15)`,
                 font: { family: 'Poppins', weight: '600', size: 13 } },
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => isCount ? fmtInt(ctx.raw) : fmtGBPFull(ctx.raw),
          },
        },
      },
      scales: {
        x: { grid: { display: false },
             ticks: { autoSkip: false, maxRotation: 45, minRotation: 30, font: { size: 10 } } },
        y: { grid: { color: C.line }, ticks: { callback: v => fmtVal(v) } },
      },
      onClick(_evt, elements, chart) {
        if (!elements.length) return;
        const idx = elements[0].index;
        applyGroupbyDrill(chart.data.labels[idx]);
      },
    },
  });
}

/** Apply a Group-by value as a Search filter and jump to the Table tab. */
function applyGroupbyDrill(value) {
  const dim = $('#grpDim').value;
  const behaviour = GROUPBY_DIM_TO_FILTER[dim];
  if (!behaviour || behaviour.kind === 'noop') return;
  if (behaviour.kind === 'checkbox') {
    // Uncheck others first — a single click should filter to JUST that value.
    $$(`${behaviour.boxSel} input`).forEach(el => {
      el.checked = (el.value === value);
    });
  } else if (behaviour.kind === 'query') {
    $(behaviour.inputSel).value = value;
  }
  activateTab('table');
  refresh();
}

function wireGroupby() {
  ['#grpDim', '#grpMetric'].forEach(sel => {
    $(sel).addEventListener('change', () => refreshGroupby());
  });
  // Table-row clicks are the accessible equivalent of chart-bar clicks
  $('#grpBody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr.groupby-row');
    if (tr) applyGroupbyDrill(tr.dataset.groupValue);
  });
  $('#grpBody').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const tr = e.target.closest('tr.groupby-row');
    if (tr) applyGroupbyDrill(tr.dataset.groupValue);
  });
}

/* ---- Tabs --------------------------------------------------------------- */
function activateTab(name) {
  const tab = $(`.tab[data-tab="${name}"]`);
  if (!tab) return;
  $$('.tab').forEach(t => t.classList.remove('tab--active'));
  tab.classList.add('tab--active');
  $$('.tab-panel').forEach(pnl => pnl.classList.remove('is-active'));
  $('#tab-' + name).classList.add('is-active');
  if (name === 'pivot') refreshGroupby();
  if (history.replaceState) history.replaceState(null, '', '#' + name);
}
function wireTabs() {
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  });
  const h = (location.hash || '').replace('#', '');
  if (['table', 'pivot', 'chat'].includes(h)) activateTab(h);
  window.addEventListener('hashchange', () => {
    const h2 = (location.hash || '').replace('#', '');
    if (['table', 'pivot', 'chat'].includes(h2)) activateTab(h2);
  });
}

/* ---- Chat --------------------------------------------------------------- */
function wireChat() {
  const log = $('#chatLog'), form = $('#chatForm'), input = $('#chatInput');
  const push = (cls, html) => {
    const el = document.createElement('div');
    el.className = 'chat__msg ' + cls;
    el.innerHTML = html;
    log.appendChild(el); log.scrollTop = log.scrollHeight;
    return el;
  };
  const renderTable = (cols, rows) => {
    if (!rows || !rows.length) return '<div class="muted">No rows.</div>';
    const shown = rows.slice(0, 30);
    const head = '<tr>' + cols.map(c => `<th>${escapeHtml(c)}</th>`).join('') + '</tr>';
    const body = shown.map(r => '<tr>' + r.map((c, i) => {
      if (c == null) return '<td class="muted">–</td>';
      const col = cols[i] || '';
      if (col === 'notice_url' && typeof c === 'string' && c.startsWith('http'))
        return `<td><a href="${escapeHtml(c)}" target="_blank" rel="noopener">open ↗</a></td>`;
      if (/value|total|amount|gbp/i.test(col) && typeof c === 'number')
        return `<td class="num" title="${escapeHtml(fmtGBPFull(c))}">${fmtGBP(c)}</td>`;
      if (/count|open_count|notices?/i.test(col) && typeof c === 'number')
        return `<td class="num">${fmtInt(c)}</td>`;
      if (col === 'deadline' || col === 'published_date') {
        return `<td title="${escapeHtml(String(c))}">${fmtDate(c)}</td>`;
      }
      return `<td>${escapeHtml(String(c).slice(0, 120))}</td>`;
    }).join('') + '</tr>').join('');
    return `<div class="chat__result"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>` +
           (rows.length > shown.length ? `<div class="muted" style="margin-top:6px;font-size:11px">Showing first ${fmtInt(shown.length)} of ${fmtInt(rows.length)}.</div>` : '');
  };
  const renderFollowUps = (list) => {
    if (!list || !list.length) return '';
    return '<div class="chat__followups">Try next: ' +
      list.map(s => `<code data-follow="1">${escapeHtml(s)}</code>`).join(' ') +
      '</div>';
  };
  const renderChart = (chart, msgEl) => {
    if (!chart) return;
    const wrap = document.createElement('div');
    wrap.className = 'chat__chart';
    wrap.innerHTML = `<canvas></canvas>`;
    msgEl.appendChild(wrap);
    // Chart.js is not imported on Search (no /dashboard charts here); if the
    // user asks a chart-producing question, we still want to render it.
    // Chart.js is loaded on Dashboard/Awards pages via CDN <script>; on Search
    // we don't include it. Fall back to a simple text table if unavailable.
    if (typeof window.Chart === 'undefined') return;
    new window.Chart(wrap.querySelector('canvas').getContext('2d'), {
      type: chart.type || 'bar',
      data: {
        labels: chart.labels,
        datasets: [{
          label: chart.value_col, data: chart.values,
          backgroundColor: C.bid, borderRadius: 4,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => /value|total|amount|gbp/i.test(chart.value_col)
                ? fmtGBPFull(ctx.raw) : fmtInt(ctx.raw),
            }
          }
        },
        scales: {
          x: { grid: { display: false },
               ticks: { autoSkip: false, maxRotation: 40, minRotation: 20, font: { size: 10 } } },
          y: { grid: { color: C.line },
               ticks: { callback: v => /value|total|amount|gbp/i.test(chart.value_col) ? fmtGBP(v) : fmtInt(v) } }
        }
      }
    });
  };

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    push('chat__msg--user', escapeHtml(q));
    input.value = '';
    const thinking = push('chat__msg--bot', '<em class="muted">Thinking…</em>');
    let r;
    try {
      r = await api('/api/chat', { json: { question: q } });
    } catch (err) { thinking.remove(); return; }
    thinking.remove();
    if (!r) return;
    if (r.error) {
      push('chat__msg--err', escapeHtml(r.error) +
        (r.sql ? `<div class="chat__sql">${escapeHtml(r.sql)}</div>` : ''));
      return;
    }
    const intro = `<div>${escapeHtml(r.intro || '')} <span class="muted" style="font-size:11px">(engine: ${escapeHtml(r.engine || '?')})</span></div>`;
    const msg = push('chat__msg--bot',
      intro +
      `<div class="chat__sql">${escapeHtml(r.sql)}</div>` +
      renderTable(r.columns, r.rows) +
      renderFollowUps(r.follow_ups));
    renderChart(r.chart, msg);
    log.scrollTop = log.scrollHeight;
  });

  // Follow-up chip click -> re-ask
  log.addEventListener('click', e => {
    if (e.target.matches('code[data-follow]')) {
      input.value = e.target.textContent;
      form.dispatchEvent(new Event('submit'));
    }
  });
  // Hint chips populate the input
  document.body.addEventListener('click', e => {
    if (e.target.matches('.chat__hints code')) {
      input.value = e.target.textContent; input.focus();
    }
  });
}

/* ---- Empty-state "Clear all filters" button (delegated) ------------------ */
function wireEmptyStateClear() {
  document.body.addEventListener('click', e => {
    const btn = e.target.closest('[data-clear-filters]');
    if (!btn) return;
    const id = btn.dataset.clearFilters;
    const target = document.getElementById(id);
    if (target) target.click();
  });
}

/* ---- Boot --------------------------------------------------------------- */
async function boot() {
  await loadFacets();
  loadSearchFromUrl();               // restore filters from ?query BEFORE first refresh
  wireSearchFilters(refresh);
  wireTabs();
  wireChat();
  wireHeaderSort(refresh);
  wireColumnPopovers(refresh);
  wireEmptyStateClear();
  wireTrackButtons('#tblBody');           // admin-only Track button on rows (Phase 4)
  wireGroupby();                           // Group-by tab controls + drill-through (Phase 5)

  // Airbnb-style value slider — replaces the old #fltMin/#fltMax inputs.
  // The slider drives those (now hidden) inputs so buildSearchQuery works
  // unchanged. On every non-value filter change we ALSO refetch the histogram
  // so the distribution reshapes to reflect the current scope.
  const refetchHistogram = await initValueSlider(buildSearchQuery, refresh);
  document.body.addEventListener('change', (e) => {
    if (e.target.matches('#fltQ, #fltOpen, #fltAfter, #fltBefore, '
                       + '#fltCategory input, #fltSource input')) {
      refetchHistogram();
    }
  });

  refresh();                               // debounced; no promise to await
  paintFilterActive();
  // Back/forward-button aware
  window.addEventListener('popstate', () => {
    loadSearchFromUrl();
    refetchHistogram();
    refresh();
  });
}

boot().catch(err => {
  console.error(err);
  const b = document.body;
  const el = document.createElement('div');
  el.className = 'flash flash--error';
  el.style.margin = '16px';
  el.textContent = 'Failed to load Search: ' + err.message;
  b.prepend(el);
});
