/* BidGov Compass — dashboard controller
   ----------------------------------------------------------------------- */
(() => {
  'use strict';

  // ---- Brand palette (mirrors style.css) --------------------------------
  const C = {
    gov: '#54565B', bid: '#E03C31', bidHover: '#C22F26',
    soft: '#8A8D91', line: '#E7E6E3',
    ramp: ['#E03C31', '#54565B', '#8A8D91', '#B7791F', '#2E7D5B',
           '#7A6ED8', '#C22F26', '#3D3F44', '#B0AFAB', '#D57742']
  };

  // ---- Chart.js defaults ------------------------------------------------
  Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.color = C.gov;
  Chart.defaults.borderColor = C.line;
  Chart.defaults.plugins.legend.labels.font = { family: "'Inter'", size: 11 };

  // ---- Utilities --------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // Locale-aware, tabular, deterministic. All money/number formatting in the
  // portal MUST go through these helpers — no ad-hoc `toLocaleString()` calls.
  const NF_GBP0 = new Intl.NumberFormat('en-GB', {
    style: 'currency', currency: 'GBP',
    maximumFractionDigits: 0, minimumFractionDigits: 0,
  });
  const NF_INT = new Intl.NumberFormat('en-GB');
  const DTF_DATE = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
  const DTF_DATETIME = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  /**
   * fmtGBP — abbreviated currency ("£120k", "£1.2m", "£1.20bn").
   * Consistent 1-decimal for m/bn, 0-decimal for k, full amount if <£1k.
   * Returns an em-dash for unknown/nully.
   */
  function fmtGBP(v) {
    if (v == null || isNaN(v)) return '–';
    const n = Number(v);
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (abs >= 1e9) return `${sign}£${(abs / 1e9).toFixed(2)}bn`;
    if (abs >= 1e6) return `${sign}£${(abs / 1e6).toFixed(1)}m`;
    if (abs >= 1e3) return `${sign}£${Math.round(abs / 1e3)}k`;
    return NF_GBP0.format(n);
  }
  /** Full-precision, comma-separated for tooltips: "£1,234,567". */
  const fmtGBPFull = v => (v == null || isNaN(v)) ? '–' : NF_GBP0.format(Number(v));

  /** Locale-aware integer with thousands separators. */
  const fmtInt = v => (v == null || isNaN(v)) ? '0' : NF_INT.format(Number(v));

  /** ISO -> "10 Jul 2026" (empty string on null/invalid). */
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? '' : DTF_DATE.format(d);
  }
  /** ISO -> "10 Jul 2026, 14:30". */
  function fmtDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? '' : DTF_DATETIME.format(d);
  }

  function daysUntil(iso) {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    if (isNaN(t)) return null;
    // whole-day rounding at midnight, not now — so "closing today at 5pm" is 0 days.
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const target = new Date(iso); target.setHours(0, 0, 0, 0);
    return Math.round((target - now) / 86400000);
  }

  /**
   * Human-relative deadline label: "today", "tomorrow", "in 3 days",
   * "in 2 weeks", "in 4 months", "3 months ago". Returns "" if no deadline.
   */
  function fmtRelDeadline(iso) {
    const d = daysUntil(iso);
    if (d == null) return '';
    if (d < 0) {
      const p = -d;
      if (p === 1) return 'yesterday';
      if (p < 7) return `${p} days ago`;
      if (p < 30) return `${Math.round(p/7)} wk ago`;
      if (p < 365) return `${Math.round(p/30)} mo ago`;
      return `${Math.round(p/365)} yr ago`;
    }
    if (d === 0) return 'today';
    if (d === 1) return 'tomorrow';
    if (d < 7) return `in ${d} days`;
    if (d < 30) return `in ${Math.round(d/7)} wk`;
    if (d < 365) return `in ${Math.round(d/30)} mo`;
    return `in ${Math.round(d/365)} yr`;
  }

  /** Urgency bucket for a deadline: today | week | month | later | past | none. */
  function deadlineUrgency(iso) {
    const d = daysUntil(iso);
    if (d == null) return 'none';
    if (d < 0) return 'past';
    if (d === 0) return 'today';
    if (d <= 7) return 'week';
    if (d <= 30) return 'month';
    return 'later';
  }

  const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

  /** Non-blocking inline error banner (top of main). Auto-dismisses after 6s. */
  function showError(message) {
    let el = $('#toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      el.setAttribute('role', 'alert');
      document.body.appendChild(el);
    }
    el.textContent = String(message || 'Something went wrong.');
    el.classList.add('is-open');
    clearTimeout(showError._t);
    showError._t = setTimeout(() => el.classList.remove('is-open'), 6000);
  }

  /** Fetch wrapper with JSON parsing + friendly error surfacing. */
  async function api(url, opts) {
    try {
      const r = await fetch(url, opts);
      if (r.status === 401) {
        // Session expired — bounce to login.
        window.location = '/auth/login?next=' + encodeURIComponent(location.pathname);
        return null;
      }
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return await r.json();
    } catch (err) {
      showError(`Request failed: ${err.message}`);
      throw err;
    }
  }

  // ---- Filter state ⇄ query string --------------------------------------
  // Single source of truth: the DOM. buildQuery() serialises DOM -> URLSearchParams.
  // pushUrlState() mirrors it into location.search so pages are shareable and
  // the browser back button restores filters. loadFromUrl() reads the URL on boot.
  function buildQuery() {
    const p = new URLSearchParams();
    p.set('open_only', $('#fltOpen').value);

    const q = $('#fltQ').value.trim();
    if (q) p.set('q', q);

    const min = $('#fltMin').value, max = $('#fltMax').value;
    if (min) p.set('value_min', min);
    if (max) p.set('value_max', max);

    const after = $('#fltAfter').value, before = $('#fltBefore').value;
    if (after) p.set('deadline_after', after);
    if (before) p.set('deadline_before', before);

    $$('#fltCategory input:checked').forEach(el => p.append('category', el.value));
    $$('#fltSource input:checked').forEach(el => p.append('source', el.value));

    p.set('sort', $('#sortSel').value);
    return p;
  }

  function pushUrlState() {
    const p = buildQuery();
    // omit the default "open_only=1" so URL stays clean when at defaults
    if (p.get('open_only') === '1') p.delete('open_only');
    // sort defaults to "deadline"
    if (p.get('sort') === 'deadline') p.delete('sort');
    const qs = p.toString();
    const url = qs ? `${location.pathname}?${qs}` : location.pathname;
    history.replaceState(null, '', url + location.hash);
  }

  function loadFromUrl() {
    const p = new URLSearchParams(location.search);
    if (p.has('open_only')) $('#fltOpen').value = p.get('open_only');
    if (p.has('q')) $('#fltQ').value = p.get('q');
    if (p.has('value_min')) $('#fltMin').value = p.get('value_min');
    if (p.has('value_max')) $('#fltMax').value = p.get('value_max');
    if (p.has('deadline_after')) $('#fltAfter').value = p.get('deadline_after');
    if (p.has('deadline_before')) $('#fltBefore').value = p.get('deadline_before');
    if (p.has('sort')) $('#sortSel').value = p.get('sort');
    const cats = new Set(p.getAll('category'));
    $$('#fltCategory input').forEach(el => { el.checked = cats.has(el.value); });
    const srcs = new Set(p.getAll('source'));
    $$('#fltSource input').forEach(el => { el.checked = srcs.has(el.value); });
  }

  // ---- Facet loader (populates checklists) ------------------------------
  async function loadFacets() {
    const r = await api('/api/facets');
    if (!r) return;
    const catBox = $('#fltCategory'), srcBox = $('#fltSource');
    catBox.innerHTML = r.categories.map(c =>
      `<label><input type="checkbox" value="${escapeHtml(c)}">${escapeHtml(c)}</label>`
    ).join('');
    srcBox.innerHTML = r.sources.map(s =>
      `<label><input type="checkbox" value="${escapeHtml(s)}">${escapeHtml(s)}</label>`
    ).join('');
  }

  // ---- KPI + stats + charts (single fetch) ------------------------------
  const charts = {};
  function upsertChart(id, cfg) {
    if (charts[id]) { charts[id].destroy(); }
    charts[id] = new Chart(document.getElementById(id).getContext('2d'), cfg);
  }

  /** Write a KPI value + optional title (tooltip on hover for full-precision). */
  function setKpi(id, value, tooltip, sublabel) {
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

  async function refreshStats() {
    const p = buildQuery();
    const s = await api('/api/stats?' + p.toString());
    if (!s) return;
    const t = s.totals;

    // KPIs — median (not mean) resists skew from megaframeworks.
    setKpi('kpiTotal', fmtInt(t.notices), null, 'Notices matching your filters');
    setKpi('kpiOpen',  fmtInt(t.open),  null, 'Deadline in the future');
    setKpi('kpiValue', fmtGBP(t.median_value), fmtGBPFull(t.median_value),
           `Median contract value · P90 ${fmtGBP(t.p90_value)}`);
    setKpi('kpiAvg',   fmtInt(t.sweet_spot_count), null,
           `£50k–£300k, mapped to a sweet-spot category · in-range total ${fmtGBP(t.in_range_total)}`);

    // -- Category pie (top 10 + Other) --
    const catRows = s.by_category.slice(0, 10);
    const otherN  = s.by_category.slice(10).reduce((a, b) => a + b.n, 0);
    const catLabels = catRows.map(r => r.k).concat(otherN ? ['Other'] : []);
    const catData   = catRows.map(r => r.n).concat(otherN ? [otherN] : []);
    upsertChart('chartCategory', {
      type: 'doughnut',
      data: {
        labels: catLabels,
        datasets: [{ data: catData, backgroundColor: C.ramp, borderColor: '#fff', borderWidth: 2 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '55%',
        plugins: {
          title: { display: true, text: 'By category', font: { family: 'Poppins', weight: '600', size: 13 } },
          legend: { position: 'right', labels: { boxWidth: 10, padding: 8 } },
        }
      }
    });

    // -- Source bar --
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

    // -- Value bands bar --
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

    // -- Deadline urgency bar --
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

    // -- Top 15 categories by total value --
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

  // ---- Table --------------------------------------------------------------
  async function refreshTable() {
    const p = buildQuery();
    p.set('limit', 500);
    const r = await api('/api/tenders?' + p.toString());
    if (!r) return;

    const tbody = $('#tblBody');
    if (!r.rows.length) {
      // Rich empty state — one primary action (clear filters)
      tbody.innerHTML = `
        <tr><td colspan="6">
          <div class="empty">
            <div class="empty__title">No tenders match your filters.</div>
            <div class="empty__body">Try widening the value range or removing category filters.</div>
            <button class="btn btn--secondary" onclick="document.getElementById('resetBtn').click()">Clear all filters</button>
          </div>
        </td></tr>`;
    } else {
      tbody.innerHTML = r.rows.map(rowHtml).join('');
    }

    // Result count — high-signal, one line
    const shown = fmtInt(r.returned);
    const total = fmtInt(r.total);
    $('#tblFoot').innerHTML = r.returned < r.total
      ? `Showing <b>${shown}</b> of <b>${total}</b> matching notices <span class="muted">(500 row limit — refine filters to narrow)</span>`
      : `<b>${total}</b> matching notice${r.total === 1 ? '' : 's'}`;
  }

  function rowHtml(t) {
    const urgency = deadlineUrgency(t.deadline);
    const dlCls = urgency === 'today' || urgency === 'week' ? 'is-urgent'
                : urgency === 'month' ? 'is-soon' : '';
    const rel = fmtRelDeadline(t.deadline);
    const link = t.notice_url
      ? `<a href="${escapeHtml(t.notice_url)}" target="_blank" rel="noopener" title="Open notice on source portal">${escapeHtml(t.title)}</a>`
      : escapeHtml(t.title);

    const value = t.value_amount != null
      ? `<span title="${escapeHtml(fmtGBPFull(t.value_amount))}${t.value_currency && t.value_currency !== 'GBP' ? ' (' + escapeHtml(t.value_currency) + ')' : ''}">${fmtGBP(t.value_amount)}</span>`
      : `<span class="muted">–</span>`;

    const deadline = t.deadline
      ? `<div class="deadline"><span class="deadline__abs">${fmtDate(t.deadline)}</span><span class="deadline__rel">${escapeHtml(rel)}</span></div>`
      : `<span class="muted">–</span>`;

    return `<tr>
      <td class="title">${link}</td>
      <td>${escapeHtml(t.buyer_name || '')}</td>
      <td>${t.category ? `<span class="pill pill--cat">${escapeHtml(t.category)}</span>` : '<span class="muted">–</span>'}</td>
      <td class="num">${value}</td>
      <td class="${dlCls}">${deadline}</td>
      <td><span class="pill pill--src">${escapeHtml(t.source)}</span></td>
    </tr>`;
  }

  // ---- Pivot --------------------------------------------------------------
  async function refreshPivot() {
    const p = buildQuery();
    const r = await api('/api/pivot?' + p.toString());
    if (!r) return;
    const records = r.rows.map(row => {
      const o = {};
      r.columns.forEach((c, i) => o[c] = row[i]);
      return o;
    });
    $('#pivotOut').innerHTML = '';
    $('#pivotOut').pivotUI(records, {
      rows: ['category'],
      cols: ['source'],
      aggregatorName: 'Count',
      rendererName: 'Table',
      unusedAttrsVertical: false,
    }, true);
  }

  // ---- Column headers: sort + filter popovers ---------------------------
  // Server-side sort keys (in app.py:_ALLOWED_SORT). null = no server sort
  // for that direction (fall back to default).
  const SORT_KEYS = {
    title:     { asc: 'title_asc',     desc: 'title_desc' },
    buyer:     { asc: 'buyer_asc',     desc: 'buyer_desc' },
    category:  { asc: 'category_asc',  desc: 'category_desc' },
    value:     { asc: 'value_asc',     desc: 'value_desc' },
    deadline:  { asc: 'deadline',      desc: 'deadline_desc' },
    source:    { asc: 'source_asc',    desc: 'source_desc' },
  };

  // Cycle asc → desc → default when the same column header is clicked.
  function wireHeaderSort() {
    $$('.col-sort').forEach(btn => {
      btn.addEventListener('click', () => {
        const col = btn.dataset.col;
        const keys = SORT_KEYS[col]; if (!keys) return;
        const current = $('#sortSel').value;
        let next;
        if (current === keys.asc)      next = keys.desc;
        else if (current === keys.desc) next = 'deadline';   // reset to default
        else                             next = keys.asc;
        $('#sortSel').value = next;
        paintSortArrows();
        refresh();
      });
    });
    paintSortArrows();
    $('#sortSel').addEventListener('change', paintSortArrows);
  }

  function paintSortArrows() {
    const current = $('#sortSel').value;
    $$('.col-sort').forEach(btn => {
      const keys = SORT_KEYS[btn.dataset.col];
      btn.classList.remove('is-asc', 'is-desc');
      if (!keys) return;
      if (current === keys.asc)  btn.classList.add('is-asc');
      if (current === keys.desc) btn.classList.add('is-desc');
    });
  }

  // ---------- Filter popover ---------------------------------------------
  // Each popover reuses the SAME hidden filter inputs the sidebar drives, so
  // opening a popover, ticking a box, and hitting Apply is exactly equivalent
  // to using the sidebar — one source of truth for filter state.
  let facetCache = null;
  async function getFacets() {
    if (!facetCache) facetCache = await fetch('/api/facets').then(r => r.json());
    return facetCache;
  }

  function positionPop(pop, anchorBtn) {
    const rect = anchorBtn.getBoundingClientRect();
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const scrollLeft = window.scrollX || document.documentElement.scrollLeft;
    pop.style.top  = (rect.bottom + scrollTop + 4) + 'px';
    pop.style.left = Math.min(
      rect.left + scrollLeft,
      window.innerWidth - pop.offsetWidth - 20 + scrollLeft
    ) + 'px';
  }

  function closePop() {
    const pop = $('#colPop');
    pop.hidden = true;
    pop._openFor = null;
  }

  function paintFilterActive() {
    // highlight the filter icon on any column whose filter is set
    const q = $('#fltQ').value.trim();
    const cats = $$('#fltCategory input:checked').length;
    const srcs = $$('#fltSource input:checked').length;
    const vmin = $('#fltMin').value, vmax = $('#fltMax').value;
    const dlA = $('#fltAfter').value, dlB = $('#fltBefore').value;
    const active = {
      title:    !!q, buyer: !!q,
      category: cats > 0,
      source:   srcs > 0,
      value:    !!(vmin || vmax),
      deadline: !!(dlA || dlB),
    };
    $$('.col-filter').forEach(btn => {
      btn.classList.toggle('is-active', !!active[btn.dataset.col]);
    });
  }

  async function openPop(anchorBtn) {
    const pop = $('#colPop');
    if (pop._openFor === anchorBtn) { closePop(); return; }

    const col  = anchorBtn.dataset.col;
    const kind = anchorBtn.dataset.kind;
    const titleEl = pop.querySelector('.col-pop__title');
    const bodyEl  = pop.querySelector('.col-pop__body');
    titleEl.textContent = 'Filter · ' + anchorBtn.previousElementSibling.textContent.trim().replace(/\s+[▲▼]?$/,'');
    bodyEl.innerHTML = '';

    if (kind === 'search') {
      bodyEl.innerHTML = `
        <input type="text" class="field" id="popSearch" placeholder="Contains…" />
        <div class="col-pop__meta">Filters title AND buyer (global search).</div>`;
      bodyEl.querySelector('#popSearch').value = $('#fltQ').value;
      setTimeout(() => bodyEl.querySelector('#popSearch').focus(), 30);
      bodyEl.querySelector('#popSearch').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); pop.querySelector('[data-pop="apply"]').click(); }
      });
    }
    else if (kind === 'checklist') {
      const facets = await getFacets();
      const items  = col === 'category' ? facets.categories : facets.sources;
      const sidebarSel = col === 'category' ? '#fltCategory' : '#fltSource';
      const checked = new Set(
        $$(`${sidebarSel} input:checked`).map(el => el.value)
      );
      bodyEl.innerHTML = `
        <input type="text" class="field" id="popFind" placeholder="Search…" />
        <div class="checklist" id="popList" style="margin-top:6px">
          ${items.map(v => `<label><input type="checkbox" value="${escapeHtml(v)}"${checked.has(v) ? ' checked' : ''}>${escapeHtml(v)}</label>`).join('')}
        </div>
        <div class="col-pop__meta">
          <a href="#" data-pop-all="1">Select all</a> ·
          <a href="#" data-pop-all="0">None</a>
        </div>`;
      const find = bodyEl.querySelector('#popFind');
      find.addEventListener('input', () => {
        const term = find.value.toLowerCase();
        $$('#popList label').forEach(lbl => {
          lbl.style.display = lbl.textContent.toLowerCase().includes(term) ? '' : 'none';
        });
      });
      bodyEl.addEventListener('click', e => {
        if (!e.target.matches('[data-pop-all]')) return;
        e.preventDefault();
        const on = e.target.dataset.popAll === '1';
        $$('#popList input:not([style*="none"])').forEach(el => { el.checked = on; });
        // consider only visible items after filter search
        $$('#popList label').forEach(lbl => {
          if (lbl.style.display === 'none') return;
          lbl.querySelector('input').checked = on;
        });
      });
    }
    else if (kind === 'range') {
      bodyEl.innerHTML = `
        <div class="range">
          <input type="number" class="field" id="popMin" placeholder="min £" min="0" step="1000" />
          <span class="muted">—</span>
          <input type="number" class="field" id="popMax" placeholder="max £" min="0" step="1000" />
        </div>
        <div class="col-pop__meta" style="margin-top:8px">
          Quick:
          <a href="#" data-pop-band="sweet">£50k–£300k</a> ·
          <a href="#" data-pop-band="mid">£30k–£135k</a>
        </div>`;
      bodyEl.querySelector('#popMin').value = $('#fltMin').value;
      bodyEl.querySelector('#popMax').value = $('#fltMax').value;
      bodyEl.addEventListener('click', e => {
        if (!e.target.matches('[data-pop-band]')) return;
        e.preventDefault();
        const b = e.target.dataset.popBand;
        bodyEl.querySelector('#popMin').value = b === 'sweet' ? 50000 : 30000;
        bodyEl.querySelector('#popMax').value = b === 'sweet' ? 300000 : 135000;
      });
    }
    else if (kind === 'daterange') {
      bodyEl.innerHTML = `
        <div class="range">
          <input type="date" class="field" id="popAfter"  title="on or after" />
          <span class="muted">—</span>
          <input type="date" class="field" id="popBefore" title="on or before" />
        </div>
        <div class="col-pop__meta" style="margin-top:8px">
          Quick:
          <a href="#" data-pop-dl="week">Closing this week</a> ·
          <a href="#" data-pop-dl="month">This month</a>
        </div>`;
      bodyEl.querySelector('#popAfter').value  = $('#fltAfter').value;
      bodyEl.querySelector('#popBefore').value = $('#fltBefore').value;
      bodyEl.addEventListener('click', e => {
        if (!e.target.matches('[data-pop-dl]')) return;
        e.preventDefault();
        const today = new Date().toISOString().slice(0,10);
        const plus  = n => new Date(Date.now() + n*86400000).toISOString().slice(0,10);
        const days  = e.target.dataset.popDl === 'week' ? 7 : 30;
        bodyEl.querySelector('#popAfter').value  = today;
        bodyEl.querySelector('#popBefore').value = plus(days);
      });
    }

    pop.dataset.col  = col;
    pop.dataset.kind = kind;
    pop.hidden = false;
    pop._openFor = anchorBtn;
    positionPop(pop, anchorBtn);
  }

  function applyPop() {
    const pop = $('#colPop');
    const col  = pop.dataset.col;
    const kind = pop.dataset.kind;

    if (kind === 'search') {
      $('#fltQ').value = pop.querySelector('#popSearch').value.trim();
    }
    else if (kind === 'checklist') {
      const wanted = new Set(
        $$('#popList input:checked').map(el => el.value)
      );
      const sidebarSel = col === 'category' ? '#fltCategory' : '#fltSource';
      $$(`${sidebarSel} input`).forEach(el => { el.checked = wanted.has(el.value); });
    }
    else if (kind === 'range') {
      $('#fltMin').value = pop.querySelector('#popMin').value;
      $('#fltMax').value = pop.querySelector('#popMax').value;
    }
    else if (kind === 'daterange') {
      $('#fltAfter').value  = pop.querySelector('#popAfter').value;
      $('#fltBefore').value = pop.querySelector('#popBefore').value;
    }
    closePop();
    paintFilterActive();
    refresh();
  }

  function clearPop() {
    const pop = $('#colPop');
    const col  = pop.dataset.col;
    const kind = pop.dataset.kind;
    if (kind === 'search')        $('#fltQ').value = '';
    else if (kind === 'checklist') {
      const sidebarSel = col === 'category' ? '#fltCategory' : '#fltSource';
      $$(`${sidebarSel} input`).forEach(el => { el.checked = false; });
    }
    else if (kind === 'range')     { $('#fltMin').value = ''; $('#fltMax').value = ''; }
    else if (kind === 'daterange') { $('#fltAfter').value = ''; $('#fltBefore').value = ''; }
    closePop();
    paintFilterActive();
    refresh();
  }

  function wireHeaderFilters() {
    $$('.col-filter').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); openPop(btn); });
    });
    document.addEventListener('click', e => {
      const pop = $('#colPop');
      if (pop.hidden) return;
      if (pop.contains(e.target)) return;
      if (e.target.closest('.col-filter')) return;
      closePop();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closePop();
    });
    $('#colPop').addEventListener('click', e => {
      if (e.target.matches('[data-pop="apply"]')) applyPop();
      if (e.target.matches('[data-pop="clear"]')) clearPop();
    });
    // sync icon-active state whenever the sidebar filters change too
    document.body.addEventListener('change', e => {
      if (e.target.matches('#fltCategory input, #fltSource input, #fltQ, ' +
                           '#fltMin, #fltMax, #fltAfter, #fltBefore')) {
        paintFilterActive();
      }
    });
    paintFilterActive();
  }

  // ---- Master refresh ---------------------------------------------------
  let refreshTimer = null;
  function refresh(delay = 0) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      pushUrlState();                         // shareable URL for the current filter state
      await Promise.all([refreshStats(), refreshTable()]);
      // pivot is heavy; only refresh when its tab is active
      if ($('#tab-pivot').classList.contains('is-active')) refreshPivot();
    }, delay);
  }

  // ---- Filter events ----------------------------------------------------
  function wireFilters() {
    $('#applyBtn').addEventListener('click', () => refresh());
    $('#resetBtn').addEventListener('click', () => {
      $('#fltQ').value = ''; $('#fltMin').value = ''; $('#fltMax').value = '';
      $('#fltAfter').value = ''; $('#fltBefore').value = '';
      $('#fltOpen').value = '1'; $('#sortSel').value = 'deadline';
      $$('#fltCategory input, #fltSource input').forEach(el => el.checked = false);
      refresh();
    });
    ['input', 'change'].forEach(evt => {
      ['#fltQ', '#fltMin', '#fltMax', '#fltAfter', '#fltBefore', '#fltOpen', '#sortSel'].forEach(sel => {
        $(sel).addEventListener(evt, () => refresh(300));
      });
    });
    document.body.addEventListener('change', e => {
      if (e.target.matches('#fltCategory input, #fltSource input')) refresh(100);
    });
    // sweet-spot quick links
    document.body.addEventListener('click', e => {
      if (!e.target.matches('[data-band]')) return;
      e.preventDefault();
      const band = e.target.dataset.band;
      if (band === 'sweet') { $('#fltMin').value = 50000; $('#fltMax').value = 300000; }
      else if (band === 'mid') { $('#fltMin').value = 30000; $('#fltMax').value = 135000; }
      else { $('#fltMin').value = ''; $('#fltMax').value = ''; }
      refresh();
    });
  }

  // ---- Tabs -------------------------------------------------------------
  function activateTab(name) {
    const tab = $(`.tab[data-tab="${name}"]`);
    if (!tab) return;
    $$('.tab').forEach(t => t.classList.remove('tab--active'));
    tab.classList.add('tab--active');
    $$('.tab-panel').forEach(p => p.classList.remove('is-active'));
    $('#tab-' + name).classList.add('is-active');
    if (name === 'pivot') refreshPivot();
    if (history.replaceState) history.replaceState(null, '', '#' + name);
  }
  function wireTabs() {
    $$('.tab').forEach(tab => {
      tab.addEventListener('click', () => activateTab(tab.dataset.tab));
    });
    // deep-link from URL hash
    const h = (location.hash || '').replace('#', '');
    if (['table', 'pivot', 'chat'].includes(h)) activateTab(h);
    window.addEventListener('hashchange', () => {
      const h2 = (location.hash || '').replace('#', '');
      if (['table', 'pivot', 'chat'].includes(h2)) activateTab(h2);
    });
  }

  // ---- Export -----------------------------------------------------------
  function wireExport() {
    $('#exportXlsx').addEventListener('click', () => {
      const p = buildQuery(); p.set('format', 'xlsx');
      window.location = '/api/export?' + p.toString();
    });
    $('#exportCsv').addEventListener('click', () => {
      const p = buildQuery(); p.set('format', 'csv');
      window.location = '/api/export?' + p.toString();
    });
  }

  // ---- Scrape -----------------------------------------------------------
  let scrapePoll = null;
  function wireScrape() {
    const modal = $('#scrapeModal');
    const open  = () => { modal.classList.add('is-open'); pollScrape(true); };
    const close = () => { modal.classList.remove('is-open'); if (scrapePoll) { clearInterval(scrapePoll); scrapePoll = null; } };
    $('#scrapeBtn').addEventListener('click', open);
    $('#scrapeClose').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });

    $('#scrapeStart').addEventListener('click', async () => {
      $('#scrapeStart').disabled = true;
      const body = { days_back: +$('#scrapeDays').value, max_pages: +$('#scrapeMax').value };
      const r = await fetch('/api/scrape', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(r => r.json());
      if (!r.ok) alert(r.error || 'Failed to start scrape.');
      $('#scrapeLog').classList.remove('hidden');
      pollScrape(true);
    });
  }

  async function pollScrape(startInterval) {
    const update = async () => {
      const s = await fetch('/api/scrape/status').then(r => r.json());
      const dot = $('#scrapeDot'), st = $('#scrapeStatus'), log = $('#scrapeLog');
      dot.className = 'status-dot ' +
        (s.running ? 'status-dot--running' :
         s.error   ? 'status-dot--err'     :
         s.finished_at ? 'status-dot--ok' : '');
      if (s.running) {
        st.textContent = `Running… ${s.log.length} lines.`;
        $('#scrapeStart').disabled = true;
      } else if (s.error) {
        st.textContent = 'Failed: ' + s.error;
        $('#scrapeStart').disabled = false;
      } else if (s.finished_at) {
        const before = s.before?.total ?? 0, after = s.after?.total ?? 0;
        st.textContent = `Done. Store: ${before} → ${after} notices ( +${after - before} ).`;
        $('#scrapeStart').disabled = false;
        stampLastUpdated(s.finished_at);
        refresh();  // pull fresh data into the dashboard
      } else {
        st.textContent = 'Idle.';
        $('#scrapeStart').disabled = false;
      }
      if (s.log && s.log.length) {
        log.classList.remove('hidden');
        log.textContent = s.log.join('\n');
        log.scrollTop = log.scrollHeight;
      }
      if (!s.running && scrapePoll) { clearInterval(scrapePoll); scrapePoll = null; }
    };
    if (scrapePoll) { clearInterval(scrapePoll); scrapePoll = null; }
    await update();
    if (startInterval) scrapePoll = setInterval(update, 1500);
  }

  // ---- Chat -------------------------------------------------------------
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
      new Chart(wrap.querySelector('canvas').getContext('2d'), {
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
      const r = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      }).then(r => r.json());
      thinking.remove();
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
      // Chart node appended imperatively so Chart.js can bind to it
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

  // ---- Last-updated stamp ------------------------------------------------
  function stampLastUpdated(iso) {
    if (!iso) return;
    $('#lastUpdated').textContent = 'Last scrape: ' + fmtDateTime(iso);
  }

  // ---- Boot -------------------------------------------------------------
  async function boot() {
    await loadFacets();
    loadFromUrl();                           // restore filters from ?query BEFORE first refresh
    wireFilters(); wireTabs(); wireExport(); wireScrape(); wireChat();
    wireHeaderSort(); wireHeaderFilters();
    await refresh();
    paintFilterActive();
    // if a scrape ran previously, surface it
    const s = await api('/api/scrape/status');
    if (s && s.finished_at) stampLastUpdated(s.finished_at);
    // Back/forward-button aware
    window.addEventListener('popstate', () => { loadFromUrl(); refresh(); });
  }

  boot().catch(err => {
    console.error(err);
    alert('Failed to load dashboard: ' + err.message);
  });
})();
