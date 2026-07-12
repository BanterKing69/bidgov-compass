/* BidGov Compass — History screen (awards / notice_stage='award')
   ----------------------------------------------------------------------- */
(() => {
  'use strict';

  const C = {
    gov: '#54565B', bid: '#E03C31', bidHover: '#C22F26',
    soft: '#8A8D91', line: '#E7E6E3',
    ramp: ['#E03C31', '#54565B', '#8A8D91', '#B7791F', '#2E7D5B',
           '#7A6ED8', '#C22F26', '#3D3F44', '#B0AFAB', '#D57742']
  };

  Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.color = C.gov;
  Chart.defaults.borderColor = C.line;

  const $ = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));

  // Shared formatters — mirror dashboard.js exactly
  const NF_GBP0 = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP',
                                                   maximumFractionDigits: 0, minimumFractionDigits: 0 });
  const NF_INT  = new Intl.NumberFormat('en-GB');
  const DTF_DATE = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const DTF_DATETIME = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  function fmtGBP(v) {
    if (v == null || isNaN(v)) return '–';
    const n = Number(v), abs = Math.abs(n), sign = n < 0 ? '-' : '';
    if (abs >= 1e9) return `${sign}£${(abs/1e9).toFixed(2)}bn`;
    if (abs >= 1e6) return `${sign}£${(abs/1e6).toFixed(1)}m`;
    if (abs >= 1e3) return `${sign}£${Math.round(abs/1e3)}k`;
    return NF_GBP0.format(n);
  }
  const fmtGBPFull = v => (v==null||isNaN(v)) ? '–' : NF_GBP0.format(Number(v));
  const fmtInt     = v => (v==null||isNaN(v)) ? '0'  : NF_INT.format(Number(v));
  const fmtDate    = iso => { if (!iso) return ''; const d=new Date(iso); return isNaN(d)?'':DTF_DATE.format(d); };
  const fmtDateTime= iso => { if (!iso) return ''; const d=new Date(iso); return isNaN(d)?'':DTF_DATETIME.format(d); };
  function daysUntil(iso){ if(!iso) return null; const t=new Date(iso).getTime(); if(isNaN(t))return null;
    const now=new Date(); now.setHours(0,0,0,0); const tgt=new Date(iso); tgt.setHours(0,0,0,0); return Math.round((tgt-now)/86400000); }
  function fmtRel(iso){ const d=daysUntil(iso); if(d==null) return '';
    if (d<0){ const p=-d; if(p===1) return 'yesterday'; if(p<7) return `${p} days ago`; if(p<30) return `${Math.round(p/7)} wk ago`; if(p<365) return `${Math.round(p/30)} mo ago`; return `${Math.round(p/365)} yr ago`; }
    if (d===0) return 'today'; if (d===1) return 'tomorrow';
    if (d<7) return `in ${d} days`; if (d<30) return `in ${Math.round(d/7)} wk`;
    if (d<365) return `in ${Math.round(d/30)} mo`; return `in ${Math.round(d/365)} yr`; }
  const escapeHtml = s => String(s??'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

  function showError(msg){ let el=$('#toast'); if(!el){ el=document.createElement('div'); el.id='toast'; el.className='toast'; el.setAttribute('role','alert'); document.body.appendChild(el); }
    el.textContent=String(msg||'Something went wrong.'); el.classList.add('is-open'); clearTimeout(showError._t); showError._t=setTimeout(()=>el.classList.remove('is-open'),6000); }

  async function api(url, opts){
    try { const r=await fetch(url,opts); if(r.status===401){ location='/auth/login?next='+encodeURIComponent(location.pathname); return null; }
          if(!r.ok) throw new Error(`${r.status} ${r.statusText}`); return await r.json(); }
    catch(err){ showError(`Request failed: ${err.message}`); throw err; }
  }

  // ---- filter state ⇄ query --------------------------------------------
  function buildQuery(){
    const p = new URLSearchParams();
    const q = $('#fltQ').value.trim();          if (q) p.set('q', q);
    const sup = $('#fltSupplier').value.trim(); if (sup) p.set('supplier', sup);
    const min = $('#fltAwMin').value;           if (min) p.set('awarded_min', min);
    const max = $('#fltAwMax').value;           if (max) p.set('awarded_max', max);
    const fr  = $('#fltAwFrom').value;          if (fr) p.set('awarded_from', fr);
    const to  = $('#fltAwTo').value;            if (to) p.set('awarded_to', to);
    $$('#fltCategory input:checked').forEach(el => p.append('category', el.value));
    $$('#fltSource   input:checked').forEach(el => p.append('source',   el.value));
    p.set('sort', $('#sortSel').value);
    return p;
  }
  function pushUrlState(){
    const p = buildQuery();
    if (p.get('sort')==='awarded_date') p.delete('sort');
    const qs = p.toString();
    history.replaceState(null, '', qs ? `${location.pathname}?${qs}` : location.pathname);
  }
  function loadFromUrl(){
    const p = new URLSearchParams(location.search);
    if (p.has('q'))            $('#fltQ').value = p.get('q');
    if (p.has('supplier'))     $('#fltSupplier').value = p.get('supplier');
    if (p.has('awarded_min'))  $('#fltAwMin').value = p.get('awarded_min');
    if (p.has('awarded_max'))  $('#fltAwMax').value = p.get('awarded_max');
    if (p.has('awarded_from')) $('#fltAwFrom').value = p.get('awarded_from');
    if (p.has('awarded_to'))   $('#fltAwTo').value = p.get('awarded_to');
    if (p.has('sort'))         $('#sortSel').value = p.get('sort');
    const cats = new Set(p.getAll('category'));
    $$('#fltCategory input').forEach(el => { el.checked = cats.has(el.value); });
    const srcs = new Set(p.getAll('source'));
    $$('#fltSource   input').forEach(el => { el.checked = srcs.has(el.value); });
  }

  // ---- facets ----------------------------------------------------------
  async function loadFacets(){
    const r = await api('/api/awards/facets'); if (!r) return;
    $('#fltCategory').innerHTML = r.categories.map(c =>
      `<label><input type="checkbox" value="${escapeHtml(c)}">${escapeHtml(c)}</label>`).join('');
    $('#fltSource').innerHTML = r.sources.map(s =>
      `<label><input type="checkbox" value="${escapeHtml(s)}">${escapeHtml(s)}</label>`).join('');
  }

  // ---- charts ----------------------------------------------------------
  const charts = {};
  function upsertChart(id, cfg){ if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(document.getElementById(id).getContext('2d'), cfg); }

  async function refreshStats(){
    const p = buildQuery();
    const s = await api('/api/awards/stats?' + p.toString()); if (!s) return;
    const t = s.totals;
    $('#kpiTotal').textContent      = fmtInt(t.awards);
    $('#kpiSuppliers').textContent  = fmtInt(t.unique_suppliers);
    $('#kpiMedian').textContent     = fmtGBP(t.median_value);
    $('#kpiMedian').title           = fmtGBPFull(t.median_value);
    $('#kpiTotalV').textContent     = fmtGBP(t.total_value);
    $('#kpiTotalV').title           = fmtGBPFull(t.total_value);

    // Category doughnut
    const catRows = s.by_category.slice(0, 10);
    const otherN  = s.by_category.slice(10).reduce((a,b)=>a+b.n,0);
    upsertChart('chartCategory', {
      type: 'doughnut',
      data: { labels: catRows.map(r=>r.k).concat(otherN?['Other']:[]),
              datasets: [{ data: catRows.map(r=>r.n).concat(otherN?[otherN]:[]),
                           backgroundColor: C.ramp, borderColor: '#fff', borderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '55%',
        plugins: { title: { display: true, text: 'By category', font: { family: 'Poppins', weight: '600', size: 13 } },
                   legend: { position: 'right', labels: { boxWidth: 10, padding: 8 } } } }
    });

    // By source
    upsertChart('chartSource', {
      type: 'bar',
      data: { labels: s.by_source.map(r=>r.k),
              datasets: [{ label: 'Awards', data: s.by_source.map(r=>r.n),
                           backgroundColor: C.bid, borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y',
        plugins: { title: { display: true, text: 'By source portal', font: { family: 'Poppins', weight: '600', size: 13 } },
                   legend: { display: false } },
        scales: { x: { grid: { color: C.line } }, y: { grid: { display: false } } } }
    });

    // Top 10 suppliers by win count
    const sup = (s.by_supplier || []).slice(0, 10);
    upsertChart('chartTopSuppliers', {
      type: 'bar',
      data: { labels: sup.map(r => (r.k||'—').slice(0, 32)),
              datasets: [{ label: 'Wins', data: sup.map(r=>r.n),
                           backgroundColor: C.gov, borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y',
        plugins: { title: { display: true, text: 'Top winning suppliers', font: { family: 'Poppins', weight: '600', size: 13 } },
                   legend: { display: false },
                   tooltip: { callbacks: {
                     title: ctx => sup[ctx[0].dataIndex]?.k || '',
                     label: ctx => `${fmtInt(ctx.raw)} wins  ·  ${fmtGBP(sup[ctx.dataIndex].total_v)} total`,
                   } } },
        scales: { x: { grid: { color: C.line } }, y: { grid: { display: false } } } }
    });

    // Awards by month (last 12 mo trend)
    const mo = (s.by_month || []).slice(-18);
    upsertChart('chartMonth', {
      type: 'line',
      data: { labels: mo.map(r=>r.k),
              datasets: [{ label: 'Awards', data: mo.map(r=>r.n),
                           borderColor: C.bid, backgroundColor: 'rgba(224,60,49,.12)',
                           fill: true, tension: 0.25, pointRadius: 3 }] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { title: { display: true, text: 'Awards by month', font: { family: 'Poppins', weight: '600', size: 13 } },
                   legend: { display: false } },
        scales: { x: { grid: { display: false } }, y: { grid: { color: C.line }, ticks: { precision: 0 } } } }
    });

    // Upcoming renewals (contracts ending in next 12mo)
    const ren = s.renewals || [];
    upsertChart('chartRenewals', {
      type: 'bar',
      data: { labels: ren.map(r=>r.k),
              datasets: [{ label: 'Contracts expiring', data: ren.map(r=>r.n),
                           backgroundColor: C.gov, borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { title: { display: true, text: 'Upcoming contract expiries (next 12 months) — renewal-window intelligence',
                            font: { family: 'Poppins', weight: '600', size: 13 } },
                   legend: { display: false },
                   tooltip: { callbacks: { label: ctx => `${fmtInt(ctx.raw)} contract${ctx.raw===1?'':'s'} expire in ${ctx.label}` } } },
        scales: { x: { grid: { display: false } }, y: { grid: { color: C.line }, ticks: { precision: 0 } } } }
    });
  }

  // ---- table -----------------------------------------------------------
  async function refreshTable(){
    const p = buildQuery(); p.set('limit', 500);
    const r = await api('/api/awards?' + p.toString()); if (!r) return;
    const tbody = $('#tblBody');
    if (!r.rows.length){
      tbody.innerHTML = `
        <tr><td colspan="8">
          <div class="empty">
            <div class="empty__title">No awarded contracts match your filters.</div>
            <div class="empty__body">Try widening the awarded-value range or removing category filters.</div>
            <button class="btn btn--secondary" onclick="document.getElementById('resetBtn').click()">Clear all filters</button>
          </div>
        </td></tr>`;
    } else {
      tbody.innerHTML = r.rows.map(rowHtml).join('');
    }
    const shown = fmtInt(r.returned), total = fmtInt(r.total);
    $('#tblFoot').innerHTML = r.returned < r.total
      ? `Showing <b>${shown}</b> of <b>${total}</b> awarded contracts <span class="muted">(500 row limit — refine filters to narrow)</span>`
      : `<b>${total}</b> awarded contract${r.total===1?'':'s'}`;
  }

  function rowHtml(t){
    const link = t.notice_url
      ? `<a href="${escapeHtml(t.notice_url)}" target="_blank" rel="noopener" title="Open award notice on source portal">${escapeHtml(t.title)}</a>`
      : escapeHtml(t.title);
    const supplier = t.awarded_supplier_name
      ? `<span class="pill pill--src" title="OCDS id: ${escapeHtml(t.awarded_supplier_id||'')}">${escapeHtml(t.awarded_supplier_name)}${t.awarded_supplier_count > 1 ? ` +${t.awarded_supplier_count-1}` : ''}</span>`
      : `<span class="muted">–</span>`;
    const value = t.awarded_value_amount != null
      ? `<span title="${escapeHtml(fmtGBPFull(t.awarded_value_amount))}${t.awarded_value_currency && t.awarded_value_currency !== 'GBP' ? ' (' + escapeHtml(t.awarded_value_currency) + ')' : ''}">${fmtGBP(t.awarded_value_amount)}</span>`
      : `<span class="muted">–</span>`;
    const awarded = t.awarded_date
      ? `<div class="deadline"><span class="deadline__abs">${fmtDate(t.awarded_date)}</span><span class="deadline__rel">${escapeHtml(fmtRel(t.awarded_date))}</span></div>`
      : `<span class="muted">–</span>`;
    const endDate = t.contract_end_date;
    const daysToEnd = daysUntil(endDate);
    const endCls = daysToEnd != null && daysToEnd >= 0 && daysToEnd <= 180 ? 'is-soon' : '';
    const endsCell = endDate
      ? `<div class="deadline ${endCls}"><span class="deadline__abs">${fmtDate(endDate)}</span><span class="deadline__rel">${escapeHtml(fmtRel(endDate))}</span></div>`
      : `<span class="muted">–</span>`;
    return `<tr>
      <td class="title">${link}</td>
      <td>${escapeHtml(t.buyer_name || '')}</td>
      <td>${supplier}</td>
      <td>${t.category ? `<span class="pill pill--cat">${escapeHtml(t.category)}</span>` : '<span class="muted">–</span>'}</td>
      <td class="num">${value}</td>
      <td>${awarded}</td>
      <td class="${endCls}">${endsCell}</td>
      <td><span class="pill pill--src">${escapeHtml(t.source)}</span></td>
    </tr>`;
  }

  // ---- refresh + wiring ------------------------------------------------
  let refreshTimer=null;
  function refresh(delay=0){ clearTimeout(refreshTimer); refreshTimer=setTimeout(async()=>{
      pushUrlState();
      await Promise.all([refreshStats(), refreshTable()]);
    }, delay); }

  function wire(){
    $('#applyBtn').addEventListener('click', () => refresh());
    $('#resetBtn').addEventListener('click', () => {
      ['#fltQ','#fltSupplier','#fltAwMin','#fltAwMax','#fltAwFrom','#fltAwTo'].forEach(s=>$(s).value='');
      $('#sortSel').value='awarded_date';
      $$('#fltCategory input, #fltSource input').forEach(el => el.checked = false);
      refresh();
    });
    ['input','change'].forEach(ev => {
      ['#fltQ','#fltSupplier','#fltAwMin','#fltAwMax','#fltAwFrom','#fltAwTo','#sortSel'].forEach(sel =>
        $(sel).addEventListener(ev, () => refresh(300)));
    });
    document.body.addEventListener('change', e => {
      if (e.target.matches('#fltCategory input, #fltSource input')) refresh(100);
    });
    // Quick sweet-spot chips
    document.body.addEventListener('click', e => {
      if (!e.target.matches('[data-band]')) return;
      e.preventDefault();
      const b = e.target.dataset.band;
      if (b === 'sweet') { $('#fltAwMin').value=50000; $('#fltAwMax').value=300000; }
      else if (b === 'mid') { $('#fltAwMin').value=30000; $('#fltAwMax').value=135000; }
      else { $('#fltAwMin').value=''; $('#fltAwMax').value=''; }
      refresh();
    });
    // Export buttons removed from awards.html in Phase 2 — /api/export moves
    // behind admin in Phase 3 and gains a scope picker inside Data ops. If
    // any page still exposes these ids, wire them; otherwise no-op.
    const xlsxBtn = document.getElementById('exportXlsx');
    if (xlsxBtn) {
      xlsxBtn.addEventListener('click', () => {
        const p = buildQuery(); p.set('format','xlsx'); p.set('stage','award');
        location = '/api/export?' + p.toString();
      });
    }
    const csvBtn = document.getElementById('exportCsv');
    if (csvBtn) {
      csvBtn.addEventListener('click', () => {
        const p = buildQuery(); p.set('format','csv'); p.set('stage','award');
        location = '/api/export?' + p.toString();
      });
    }
  }

  async function boot(){
    await loadFacets();
    loadFromUrl();
    wire();
    await refresh();
    window.addEventListener('popstate', () => { loadFromUrl(); refresh(); });
  }
  boot().catch(err => { console.error(err); showError('Failed to load: '+err.message); });
})();
