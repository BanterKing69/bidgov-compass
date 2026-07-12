/* BidGov Compass — table rendering (shared module)
   -----------------------------------------------------------------------
   Row markup for the tender table used on both / (Search) and /live-bids.
   Includes the sortable-header wiring used by Search (Live bids uses a plain
   <select id="lbSort">, no clickable column headers).
   ----------------------------------------------------------------------- */

import {
  $, $$, escapeHtml, fmtDate, fmtGBP, fmtGBPFull, fmtInt,
  fmtRelDeadline, deadlineUrgency,
} from './fmt.js';

/**
 * Build a `<tr>` for one tender record.
 * Columns: Title, Buyer, Category, Value, Deadline, Source
 * Deadline is styled red (`is-urgent`) when ≤7 days, amber (`is-soon`) at ≤30.
 */
export function rowHtml(t) {
  const urgency = deadlineUrgency(t.deadline);
  const dlCls = urgency === 'today' || urgency === 'week' ? 'is-urgent'
              : urgency === 'month' ? 'is-soon' : '';
  const rel = fmtRelDeadline(t.deadline);
  // "Save deal" — admin-only. Renders a bookmark-style icon inline in the
  // title cell. Was "＋ Track" but "add client name" prompt was confusing on
  // the shared tender view (client name belongs on the Pipeline tab where
  // it can be filled in later, in context). Body[data-is-admin=1] is set
  // server-side; non-admins get no button at all.
  const isAdmin = document.body.dataset.isAdmin === '1';
  const trackBtn = isAdmin
    ? `<button class="tender-track" data-track-uid="${escapeHtml(t.uid || '')}" title="Save to pipeline" aria-label="Save deal">🔖</button>`
    : '';
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
    <td class="title">${trackBtn}${link}</td>
    <td>${escapeHtml(t.buyer_name || '')}</td>
    <td>${t.category ? `<span class="pill pill--cat">${escapeHtml(t.category)}</span>` : '<span class="muted">–</span>'}</td>
    <td class="num">${value}</td>
    <td class="${dlCls}">${deadline}</td>
    <td><span class="pill pill--src">${escapeHtml(t.source)}</span></td>
  </tr>`;
}

/**
 * Wire admin-only "Save deal" buttons in a table body. One click POSTs
 * a new pipeline row with an empty client_name — the admin fills in the
 * client on the Pipeline tab where all the deal context lives. Non-admin
 * bodies contain no buttons so this is a no-op for non-admins.
 * Idempotent — safe to call after each table re-render.
 */
export function wireTrackButtons(tbodySelector, refreshOnAdd = null) {
  if (document.body.dataset.isAdmin !== '1') return;
  const tbody = document.querySelector(tbodySelector);
  if (!tbody || tbody._trackWired) return;
  tbody._trackWired = true;
  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('.tender-track');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const uid = btn.dataset.trackUid;
    btn.disabled = true;
    try {
      // Dynamic import so non-admin page bundles don't pull api.js twice.
      const { api } = await import('./api.js');
      const r = await api('/api/admin/pipeline', {
        json: { tender_uid: uid, client_name: '' },   // fill in on Pipeline tab
      });
      if (r && r.ok) {
        btn.textContent = '✓';
        btn.title = 'Saved · edit on Admin → Pipeline';
        btn.classList.add('is-tracked');
        if (typeof refreshOnAdd === 'function') refreshOnAdd();
      }
    } catch (_) { /* toast surfaced by api() */ }
    finally { btn.disabled = false; }
  });
}

/**
 * Render a filtered tender list into a <tbody>.
 * `emptyOnClearBtnId` — the id of a "clear filters" button the empty state
 * should point to (e.g. 'resetBtn' on Search, 'lbResetBtn' on Live bids).
 * `colSpan` — number of columns for the empty-state placeholder row.
 */
export function renderTenderTable(tbody, rows, {
  colSpan = 6,
  emptyOnClearBtnId = 'resetBtn',
  emptyTitle = 'No tenders match your filters.',
  emptyBody  = 'Try widening the value range or removing category filters.',
} = {}) {
  if (!rows.length) {
    tbody.innerHTML = `
      <tr><td colspan="${colSpan}">
        <div class="empty">
          <div class="empty__title">${escapeHtml(emptyTitle)}</div>
          <div class="empty__body">${escapeHtml(emptyBody)}</div>
          <button class="btn btn--secondary" type="button" data-clear-filters="${escapeHtml(emptyOnClearBtnId)}">Clear all filters</button>
        </div>
      </td></tr>`;
  } else {
    tbody.innerHTML = rows.map(rowHtml).join('');
  }
}

/** Write "Showing X of Y" into a footer element. */
export function renderTableFoot(footEl, returned, total) {
  const shown = fmtInt(returned);
  const totalS = fmtInt(total);
  footEl.innerHTML = returned < total
    ? `Showing <b>${shown}</b> of <b>${totalS}</b> matching notices <span class="muted">(500 row limit — refine filters to narrow)</span>`
    : `<b>${totalS}</b> matching notice${total === 1 ? '' : 's'}`;
}

/* ==========================================================================
   Sortable column headers (Search only) — .col-sort buttons cycle
   asc → desc → default when the same column is clicked repeatedly.
   ========================================================================== */

// Server-side sort keys (mirror app.py:_ALLOWED_SORT).
export const SORT_KEYS = {
  title:    { asc: 'title_asc',    desc: 'title_desc'    },
  buyer:    { asc: 'buyer_asc',    desc: 'buyer_desc'    },
  category: { asc: 'category_asc', desc: 'category_desc' },
  value:    { asc: 'value_asc',    desc: 'value_desc'    },
  deadline: { asc: 'deadline',     desc: 'deadline_desc' },
  source:   { asc: 'source_asc',   desc: 'source_desc'   },
};

export function paintSortArrows(sortSelector = '#sortSel') {
  const current = $(sortSelector).value;
  $$('.col-sort').forEach(btn => {
    const keys = SORT_KEYS[btn.dataset.col];
    btn.classList.remove('is-asc', 'is-desc');
    if (!keys) return;
    if (current === keys.asc)  btn.classList.add('is-asc');
    if (current === keys.desc) btn.classList.add('is-desc');
  });
}

export function wireHeaderSort(refresh, sortSelector = '#sortSel') {
  $$('.col-sort').forEach(btn => {
    btn.addEventListener('click', () => {
      const col = btn.dataset.col;
      const keys = SORT_KEYS[col]; if (!keys) return;
      const current = $(sortSelector).value;
      let next;
      if (current === keys.asc)      next = keys.desc;
      else if (current === keys.desc) next = 'deadline';  // reset to default
      else                             next = keys.asc;
      $(sortSelector).value = next;
      paintSortArrows(sortSelector);
      refresh();
    });
  });
  paintSortArrows(sortSelector);
  $(sortSelector).addEventListener('change', () => paintSortArrows(sortSelector));
}
