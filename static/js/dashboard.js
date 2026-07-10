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

  const money = v => {
    if (v == null || isNaN(v)) return '–';
    const n = Number(v);
    if (n >= 1e9) return '£' + (n / 1e9).toFixed(2) + 'bn';
    if (n >= 1e6) return '£' + (n / 1e6).toFixed(2) + 'm';
    if (n >= 1e3) return '£' + (n / 1e3).toFixed(0) + 'k';
    return '£' + n.toLocaleString();
  };
  const numFmt = v => (v ?? 0).toLocaleString();
  const fmtDate = iso => iso ? String(iso).slice(0, 10) : '';
  const daysUntil = iso => {
    if (!iso) return null;
    const ms = new Date(iso).getTime() - Date.now();
    return Math.round(ms / 86400000);
  };
  const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

  // ---- Filter state → query string --------------------------------------
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

  // ---- Facet loader (populates checklists) ------------------------------
  async function loadFacets() {
    const r = await fetch('/api/facets').then(r => r.json());
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

  async function refreshStats() {
    const p = buildQuery();
    const s = await fetch('/api/stats?' + p.toString()).then(r => r.json());

    $('#kpiTotal').textContent = numFmt(s.totals.notices);
    $('#kpiOpen').textContent  = numFmt(s.totals.open);
    $('#kpiValue').textContent = money(s.totals.total_value);
    $('#kpiAvg').textContent   = money(s.totals.avg_value);

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
          tooltip: { callbacks: { label: ctx => money(ctx.raw) } }
        },
        scales: {
          x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 45, minRotation: 30, font: { size: 10 } } },
          y: { grid: { color: C.line }, ticks: { callback: v => money(v) } }
        }
      }
    });
  }

  // ---- Table --------------------------------------------------------------
  async function refreshTable() {
    const p = buildQuery();
    p.set('limit', 500);
    const r = await fetch('/api/tenders?' + p.toString()).then(r => r.json());
    const tbody = $('#tblBody');
    if (!r.rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="center muted">No matching tenders.</td></tr>';
    } else {
      tbody.innerHTML = r.rows.map(t => {
        const d = daysUntil(t.deadline);
        const dlCls = (d != null && d <= 7 && d >= 0) ? 'deadline--soon' : '';
        const link = t.notice_url
          ? `<a href="${escapeHtml(t.notice_url)}" target="_blank" rel="noopener">${escapeHtml(t.title)}</a>`
          : escapeHtml(t.title);
        return `<tr>
          <td class="title">${link}</td>
          <td>${escapeHtml(t.buyer_name || '')}</td>
          <td>${t.category ? `<span class="pill pill--cat">${escapeHtml(t.category)}</span>` : '<span class="muted">–</span>'}</td>
          <td class="num">${t.value_amount != null ? money(t.value_amount) : '<span class="muted">–</span>'}</td>
          <td class="${dlCls}">${fmtDate(t.deadline) || '<span class="muted">–</span>'}${d != null && d <= 7 && d >= 0 ? ` <span style="font-size:11px">(${d}d)</span>` : ''}</td>
          <td><span class="pill pill--src">${escapeHtml(t.source)}</span></td>
        </tr>`;
      }).join('');
    }
    $('#tblFoot').textContent =
      `Showing ${r.returned.toLocaleString()} of ${r.total.toLocaleString()} matching notices` +
      (r.returned < r.total ? ' (limit 500 — refine filters to narrow).' : '.');
  }

  // ---- Pivot --------------------------------------------------------------
  async function refreshPivot() {
    const p = buildQuery();
    const r = await fetch('/api/pivot?' + p.toString()).then(r => r.json());
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
        if (cols[i] === 'notice_url' && typeof c === 'string' && c.startsWith('http'))
          return `<td><a href="${escapeHtml(c)}" target="_blank" rel="noopener">open ↗</a></td>`;
        if (cols[i]?.includes('value')) return `<td>${money(c)}</td>`;
        return `<td>${escapeHtml(String(c).slice(0, 90))}</td>`;
      }).join('') + '</tr>').join('');
      return `<div class="chat__result"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>` +
             (rows.length > shown.length ? `<div class="muted" style="margin-top:6px;font-size:11px">Showing first ${shown.length} of ${rows.length}.</div>` : '');
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
                label: ctx => /value/i.test(chart.value_col)
                  ? money(ctx.raw) : numFmt(ctx.raw),
              }
            }
          },
          scales: {
            x: { grid: { display: false },
                 ticks: { autoSkip: false, maxRotation: 40, minRotation: 20, font: { size: 10 } } },
            y: { grid: { color: C.line },
                 ticks: { callback: v => /value/i.test(chart.value_col) ? money(v) : v } }
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
    const d = new Date(iso);
    $('#lastUpdated').textContent = 'Last scrape: ' + d.toLocaleString();
  }

  // ---- Boot -------------------------------------------------------------
  async function boot() {
    await loadFacets();
    wireFilters(); wireTabs(); wireExport(); wireScrape(); wireChat();
    wireHeaderSort(); wireHeaderFilters();
    await refresh();
    paintFilterActive();
    // if a scrape ran previously, surface it
    const s = await fetch('/api/scrape/status').then(r => r.json());
    if (s.finished_at) stampLastUpdated(s.finished_at);
  }

  boot().catch(err => {
    console.error(err);
    alert('Failed to load dashboard: ' + err.message);
  });
})();
