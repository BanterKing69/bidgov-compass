/* BidGov Compass — filter state helpers (shared module)
   -----------------------------------------------------------------------
   Filter state is single-sourced from the DOM. This module reads that DOM
   into URLSearchParams (buildQuery), mirrors it to location.search
   (pushUrlState) so pages are shareable, and hydrates the DOM from the URL
   on load (loadFromUrl). It also drives the sidebar-based facet checklists
   (loadFacets) and Search's column-popover filter UI (wireColumnPopovers).

   Live bids has a slimmer filter bar; it uses buildLiveBidsQuery + wireLiveBidsFilters.

   All exports are pure functions or wire-once initialisers — no module-level
   state, so they're safe to import from multiple pages.
   ----------------------------------------------------------------------- */

import { $, $$, escapeHtml } from './fmt.js';
import { api } from './api.js';

/* ==========================================================================
   SEARCH page (dashboard.html /) — full sidebar + column popovers
   ========================================================================== */

/**
 * Serialise the Search page's sidebar DOM into URLSearchParams.
 * Matches every param name _build_where() in app.py accepts.
 */
export function buildSearchQuery() {
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

/** Mirror current filter DOM into location.search (shareable URL). */
export function pushSearchUrlState() {
  const p = buildSearchQuery();
  // Omit defaults so shared URLs stay clean.
  if (p.get('open_only') === '1') p.delete('open_only');
  if (p.get('sort') === 'deadline') p.delete('sort');
  const qs = p.toString();
  const url = qs ? `${location.pathname}?${qs}` : location.pathname;
  history.replaceState(null, '', url + location.hash);
}

/** Restore filter DOM from location.search — call before first refresh. */
export function loadSearchFromUrl() {
  const p = new URLSearchParams(location.search);
  if (p.has('open_only'))       $('#fltOpen').value  = p.get('open_only');
  if (p.has('q'))               $('#fltQ').value     = p.get('q');
  if (p.has('value_min'))       $('#fltMin').value   = p.get('value_min');
  if (p.has('value_max'))       $('#fltMax').value   = p.get('value_max');
  if (p.has('deadline_after'))  $('#fltAfter').value  = p.get('deadline_after');
  if (p.has('deadline_before')) $('#fltBefore').value = p.get('deadline_before');
  if (p.has('sort'))            $('#sortSel').value  = p.get('sort');
  const cats = new Set(p.getAll('category'));
  $$('#fltCategory input').forEach(el => { el.checked = cats.has(el.value); });
  const srcs = new Set(p.getAll('source'));
  $$('#fltSource input').forEach(el => { el.checked = srcs.has(el.value); });
}

/**
 * Populate the Category and Source sidebar checklists (and cache facets
 * for the column popovers to reuse). Returns the facets payload.
 */
let _facetCache = null;
export async function loadFacets() {
  const r = await api('/api/facets');
  if (!r) return null;
  _facetCache = r;
  const catBox = $('#fltCategory'), srcBox = $('#fltSource');
  if (catBox) {
    catBox.innerHTML = r.categories.map(c =>
      `<label><input type="checkbox" value="${escapeHtml(c)}">${escapeHtml(c)}</label>`
    ).join('');
  }
  if (srcBox) {
    srcBox.innerHTML = r.sources.map(s =>
      `<label><input type="checkbox" value="${escapeHtml(s)}">${escapeHtml(s)}</label>`
    ).join('');
  }
  return r;
}
export async function getFacets() {
  if (_facetCache) return _facetCache;
  return await loadFacets();
}

/** Update the small count-bubble next to a collapsed filter group's summary,
 *  so users can see "3 selected" without expanding. Empty string when zero. */
function paintCounts() {
  document.querySelectorAll('.filter-group__count[data-count-for]').forEach(el => {
    const boxSel = '#' + el.dataset.countFor;
    const n = document.querySelectorAll(`${boxSel} input:checked`).length;
    el.textContent = n ? String(n) : '';
  });
}

/** Highlight column-header filter icons for columns whose filter is set. */
export function paintFilterActive() {
  paintCounts();
  const q = $('#fltQ')?.value.trim() || '';
  const cats = $$('#fltCategory input:checked').length;
  const srcs = $$('#fltSource input:checked').length;
  const vmin = $('#fltMin')?.value || '', vmax = $('#fltMax')?.value || '';
  const dlA  = $('#fltAfter')?.value || '', dlB = $('#fltBefore')?.value || '';
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

/**
 * Wire the Apply/Reset buttons, the debounced input listeners, and the
 * sweet-spot quick-band links. Calls `refresh` (passed by caller) whenever
 * filters change.
 */
export function wireSearchFilters(refresh) {
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
  // sweet-spot quick links (also fired from popovers)
  document.body.addEventListener('click', e => {
    if (!e.target.matches('[data-band]')) return;
    e.preventDefault();
    const band = e.target.dataset.band;
    if (band === 'sweet') { $('#fltMin').value = 50000; $('#fltMax').value = 300000; }
    else if (band === 'mid') { $('#fltMin').value = 30000; $('#fltMax').value = 135000; }
    else { $('#fltMin').value = ''; $('#fltMax').value = ''; }
    refresh();
  });
  // repaint filter-active state whenever any linked control changes
  document.body.addEventListener('change', e => {
    if (e.target.matches('#fltCategory input, #fltSource input, #fltQ, ' +
                         '#fltMin, #fltMax, #fltAfter, #fltBefore')) {
      paintFilterActive();
    }
  });
}

/* ==========================================================================
   Search column popovers — Excel-style per-column filter/sort UI
   Reuses the SAME hidden filter inputs the sidebar drives, so opening a
   popover, ticking a box, and hitting Apply is exactly equivalent to using
   the sidebar. One source of truth.
   ========================================================================== */

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

function applyPop(refresh) {
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

function clearPop(refresh) {
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

export function wireColumnPopovers(refresh) {
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
    if (e.target.matches('[data-pop="apply"]')) applyPop(refresh);
    if (e.target.matches('[data-pop="clear"]')) clearPop(refresh);
  });
  paintFilterActive();
}

/* ==========================================================================
   LIVE BIDS page — slim filter bar (Category, Value, Deadline window, Region, Source)
   The server locks deadline >= now regardless of what we send, so the "Deadline
   window" here is a *further narrowing* (e.g. "closing ≤7 days") not a removal.
   ========================================================================== */

/**
 * Serialise the Live bids slim filter bar into URLSearchParams for /api/live-tenders.
 * Never sends `open_only` — the server already forces deadline >= now.
 *
 * Deadline: two modes coexist without conflict.
 *   1. Hidden #lbDeadlineAfter / #lbDeadlineBefore — set by chart-bar clicks
 *      to an EXACT differential range (e.g. "15–30 days" = +15d .. +30d).
 *   2. #lbDeadlineWindow select — cumulative ("Closing ≤ 7/14/30 days"),
 *      used when the hidden inputs are empty. The chart-click handler clears
 *      this select when it sets the hidden range, so the two never fight.
 */
export function buildLiveBidsQuery() {
  const p = new URLSearchParams();
  const q = $('#lbQ')?.value.trim();
  if (q) p.set('q', q);
  const min = $('#lbMin')?.value, max = $('#lbMax')?.value;
  if (min) p.set('value_min', min);
  if (max) p.set('value_max', max);
  // Prefer exact differential range from hidden inputs
  const exactAfter  = $('#lbDeadlineAfter')?.value;
  const exactBefore = $('#lbDeadlineBefore')?.value;
  if (exactAfter || exactBefore) {
    if (exactAfter)  p.set('deadline_after',  exactAfter);
    if (exactBefore) p.set('deadline_before', exactBefore);
  } else {
    // Fall back to cumulative "Closing ≤ N days" select
    const window = $('#lbDeadlineWindow')?.value || '';
    if (window) {
      const today = new Date().toISOString().slice(0, 10);
      const plus  = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
      p.set('deadline_before', plus(parseInt(window, 10)));
      p.set('deadline_after', today);
    }
  }
  $$('#lbCategory input:checked').forEach(el => p.append('category', el.value));
  $$('#lbSource input:checked').forEach(el => p.append('source', el.value));
  p.set('sort', $('#lbSort')?.value || 'deadline');
  return p;
}

export function pushLiveBidsUrlState() {
  const p = buildLiveBidsQuery();
  if (p.get('sort') === 'deadline') p.delete('sort');
  const qs = p.toString();
  const url = qs ? `${location.pathname}?${qs}` : location.pathname;
  history.replaceState(null, '', url + location.hash);
}

export function loadLiveBidsFromUrl() {
  const p = new URLSearchParams(location.search);
  if (p.has('q'))               $('#lbQ').value = p.get('q');
  if (p.has('value_min'))       $('#lbMin').value = p.get('value_min');
  if (p.has('value_max'))       $('#lbMax').value = p.get('value_max');
  if (p.has('sort'))            $('#lbSort').value = p.get('sort');
  // deadline_window is the client concept, not sent as a URL param —
  // we derive it back if only `deadline_before` is set with a today/+N shape.
  const cats = new Set(p.getAll('category'));
  $$('#lbCategory input').forEach(el => { el.checked = cats.has(el.value); });
  const srcs = new Set(p.getAll('source'));
  $$('#lbSource input').forEach(el => { el.checked = srcs.has(el.value); });
}

export async function loadLiveBidsFacets() {
  const r = await api('/api/facets');
  if (!r) return null;
  // Rendered as a standard checklist (was chip pills before Phase 6 restructure)
  // so they slot into the <details> dropdown containers in the filter bar.
  const catBox = $('#lbCategory'), srcBox = $('#lbSource');
  if (catBox) {
    catBox.innerHTML = r.categories.map(c =>
      `<label><input type="checkbox" value="${escapeHtml(c)}">${escapeHtml(c)}</label>`
    ).join('');
  }
  if (srcBox) {
    srcBox.innerHTML = r.sources.map(s =>
      `<label><input type="checkbox" value="${escapeHtml(s)}">${escapeHtml(s)}</label>`
    ).join('');
  }
  return r;
}

export function wireLiveBidsFilters(refresh) {
  // Visible controls
  ['#lbQ', '#lbMin', '#lbMax', '#lbDeadlineWindow', '#lbSort'].forEach(sel => {
    const el = $(sel); if (!el) return;
    ['input', 'change'].forEach(evt => el.addEventListener(evt, () => refresh(200)));
  });
  // Hidden differential-range inputs set by chart bar clicks
  ['#lbDeadlineAfter', '#lbDeadlineBefore'].forEach(sel => {
    const el = $(sel); if (!el) return;
    el.addEventListener('change', () => refresh(50));
  });
  // Category / Source dropdown checkboxes (delegated)
  document.body.addEventListener('change', e => {
    if (e.target.matches('#lbCategory input, #lbSource input')) refresh(100);
  });
  const resetBtn = $('#lbResetBtn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      $('#lbQ').value = '';
      $('#lbMin').value = ''; $('#lbMax').value = '';
      $('#lbDeadlineWindow').value = '';
      const after = $('#lbDeadlineAfter'), before = $('#lbDeadlineBefore');
      if (after)  after.value  = '';
      if (before) before.value = '';
      $('#lbSort').value = 'deadline';
      $$('#lbCategory input, #lbSource input').forEach(el => el.checked = false);
      refresh();
    });
  }
}
