/* BidGov Compass — Search page (/) entry
   -----------------------------------------------------------------------
   Replaces static/js/dashboard.js. Wires up the full explorer: sidebar
   filters + column popovers + Table/Pivot/Chat tabs. No charts, no KPIs,
   no scrape modal, no export buttons (those move to admin in Phase 3;
   dashboard/live-bids own the KPI/chart display).
   ----------------------------------------------------------------------- */

import { $, $$, escapeHtml, fmtGBP, fmtGBPFull, fmtInt, fmtDate, C } from './fmt.js';
import { api } from './api.js';
import {
  loadFacets, wireSearchFilters, wireColumnPopovers,
  loadSearchFromUrl, pushSearchUrlState, buildSearchQuery, paintFilterActive,
} from './filters.js';
import {
  renderTenderTable, renderTableFoot, wireHeaderSort,
} from './table.js';

/* ---- Refresh cycle: sync URL, refetch table (+ pivot if visible) --------- */
let refreshTimer = null;
function refresh(delay = 0) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    pushSearchUrlState();
    await refreshTable();
    if ($('#tab-pivot').classList.contains('is-active')) refreshPivot();
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

/* ---- Pivot -------------------------------------------------------------- */
async function refreshPivot() {
  const p = buildSearchQuery();
  const r = await api('/api/pivot?' + p.toString());
  if (!r) return;
  const records = r.rows.map(row => {
    const o = {}; r.columns.forEach((c, i) => o[c] = row[i]); return o;
  });
  $('#pivotOut').innerHTML = '';
  // eslint-disable-next-line no-undef
  $('#pivotOut')._pivotInstance = null;
  window.jQuery('#pivotOut').pivotUI(records, {
    rows: ['category'], cols: ['source'],
    aggregatorName: 'Count', rendererName: 'Table',
    unusedAttrsVertical: false,
  }, true);
}

/* ---- Tabs --------------------------------------------------------------- */
function activateTab(name) {
  const tab = $(`.tab[data-tab="${name}"]`);
  if (!tab) return;
  $$('.tab').forEach(t => t.classList.remove('tab--active'));
  tab.classList.add('tab--active');
  $$('.tab-panel').forEach(pnl => pnl.classList.remove('is-active'));
  $('#tab-' + name).classList.add('is-active');
  if (name === 'pivot') refreshPivot();
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
  await refresh();
  paintFilterActive();
  // Back/forward-button aware
  window.addEventListener('popstate', () => { loadSearchFromUrl(); refresh(); });
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
