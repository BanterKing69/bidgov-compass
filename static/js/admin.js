/* BidGov Compass — Admin console page (/admin) entry
   -----------------------------------------------------------------------
   Phase 3: Users tab (list + activate/deactivate/promote/demote/delete) and
            Data-ops tab (scrape controls + export scope picker).
   Phase 4 (upcoming): Overview economics + Pipeline CRUD wiring.

   All server calls hit /api/admin/* — routes gated by @admin_required so
   this JS never has to worry about non-admin execution.
   ----------------------------------------------------------------------- */

import { $, $$, C, escapeHtml, fmtDate, fmtDateTime, fmtGBP, fmtGBPFull, fmtInt } from './fmt.js';
import { api } from './api.js';
import { upsertChart } from './charts.js';

/* ==========================================================================
   Tabs (client-side switch — single URL)
   ========================================================================== */
function activateTab(name) {
  const tab = $(`.tab[data-tab="${name}"]`);
  if (!tab) return;
  $$('.tab').forEach(t => t.classList.remove('tab--active'));
  tab.classList.add('tab--active');
  $$('.tab-panel').forEach(p => p.classList.remove('is-active'));
  $('#tab-' + name).classList.add('is-active');
  if (history.replaceState) history.replaceState(null, '', '#' + name);
  // Kick data-fetches for tabs that lazy-load
  if (name === 'users')    refreshUsers();
  if (name === 'dataops')  refreshScrapeStatus();
  if (name === 'overview') refreshOverview();
  if (name === 'pipeline') refreshPipeline();
}
function wireTabs() {
  $$('.tab').forEach(t => t.addEventListener('click', () => activateTab(t.dataset.tab)));
  const h = (location.hash || '').replace('#', '');
  if (['overview', 'pipeline', 'users', 'dataops'].includes(h)) activateTab(h);
}

/* ==========================================================================
   Users tab
   ========================================================================== */
async function refreshUsers() {
  const r = await api('/api/admin/users');
  if (!r) return;
  const tbody = $('#usersBody');
  if (!r.users.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="center muted">No users yet.</td></tr>';
    return;
  }
  tbody.innerHTML = r.users.map(rowHtmlUser).join('');
  // Signup-state text — read from a small unauthenticated introspection route
  // isn't available; instead the admin can toggle by env var. We report a static
  // hint from the ALLOW_SIGNUP env at boot via a data attr on the users tab
  // (not implemented server-side for privacy — showing "check ALLOW_SIGNUP env").
  const stateEl = $('#usersSignupState');
  if (stateEl && !stateEl.dataset.set) {
    stateEl.textContent = 'check ALLOW_SIGNUP env';
    stateEl.dataset.set = '1';
  }
}

function rowHtmlUser(u) {
  const adminPill  = u.is_admin  ? '<span class="pill pill--cat">admin</span>' : '<span class="muted">–</span>';
  const activePill = u.is_active ? '<span class="pill">active</span>'          : '<span class="muted">inactive</span>';
  const created    = u.created_at    ? fmtDate(u.created_at)     : '–';
  const login      = u.last_login_at ? fmtDateTime(u.last_login_at) : '<span class="muted">never</span>';
  return `<tr data-user-id="${u.id}">
    <td><strong>${escapeHtml(u.email)}</strong></td>
    <td>${escapeHtml(u.name || '')}</td>
    <td>${adminPill}</td>
    <td>${activePill}</td>
    <td>${created}</td>
    <td>${login}</td>
    <td class="users-actions">
      ${u.is_active
        ? `<button class="btn btn--secondary btn--sm" data-user-action="deactivate">Deactivate</button>`
        : `<button class="btn btn--secondary btn--sm" data-user-action="activate">Activate</button>`}
      ${u.is_admin
        ? `<button class="btn btn--secondary btn--sm" data-user-action="demote">Demote</button>`
        : `<button class="btn btn--secondary btn--sm" data-user-action="promote">Promote</button>`}
      <button class="btn btn--secondary btn--sm" data-user-action="delete" data-danger="1">Delete</button>
    </td>
  </tr>`;
}

// One delegated listener for every user-row button — simpler + resilient
// to the users-list re-render.
function wireUserActions() {
  $('#usersBody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-user-action]');
    if (!btn) return;
    const tr = btn.closest('tr[data-user-id]');
    if (!tr) return;
    const userId = tr.dataset.userId;
    const action = btn.dataset.userAction;
    if (action === 'delete') {
      if (!confirm(`Delete user ${tr.querySelector('td strong').textContent}? This cannot be undone.`)) return;
    }
    btn.disabled = true;
    try {
      const r = await api(`/api/admin/users/${userId}/${action}`, { method: 'POST' });
      if (r && r.ok) {
        await refreshUsers();
      }
    } catch (err) {
      // api() already surfaced a toast; nothing extra needed
    } finally {
      btn.disabled = false;
    }
  });
}

/* ==========================================================================
   Data ops — scrape + export
   ========================================================================== */
let _scrapePollId = null;

async function refreshScrapeStatus(startPolling = false) {
  const s = await api('/api/scrape/status');
  if (!s) return;
  const dot = $('#scrapeDot'), st = $('#scrapeStatus'), log = $('#scrapeLog');
  dot.className = 'status-dot ' +
    (s.running    ? 'status-dot--running' :
     s.error      ? 'status-dot--err'     :
     s.finished_at ? 'status-dot--ok'     : '');
  if (s.running) {
    st.textContent = `Running… ${s.log.length} lines.`;
    $('#scrapeStart').disabled = true;
  } else if (s.error) {
    st.textContent = 'Failed: ' + s.error;
    $('#scrapeStart').disabled = false;
  } else if (s.finished_at) {
    const before = s.before?.total ?? 0, after = s.after?.total ?? 0;
    st.textContent = `Done. Store: ${fmtInt(before)} → ${fmtInt(after)} notices ( +${fmtInt(after - before)} ).`;
    $('#scrapeStart').disabled = false;
  } else {
    st.textContent = 'Idle.';
    $('#scrapeStart').disabled = false;
  }
  if (s.log && s.log.length) {
    log.classList.remove('hidden');
    log.textContent = s.log.join('\n');
    log.scrollTop = log.scrollHeight;
  }
  if (!s.running && _scrapePollId) {
    clearInterval(_scrapePollId); _scrapePollId = null;
  }
  if (startPolling && s.running) {
    if (_scrapePollId) clearInterval(_scrapePollId);
    _scrapePollId = setInterval(() => refreshScrapeStatus(false), 1500);
  }
}

function wireDataOps() {
  $('#scrapeStart').addEventListener('click', async () => {
    $('#scrapeStart').disabled = true;
    const body = {
      days_back: parseInt($('#scrapeDays').value, 10),
      max_pages: parseInt($('#scrapeMax').value, 10),
    };
    try {
      const r = await api('/api/scrape', { json: body });
      if (r && !r.ok) alert(r.error || 'Failed to start scrape.');
    } catch (_) { /* toast surfaced by api() */ }
    $('#scrapeLog').classList.remove('hidden');
    refreshScrapeStatus(true);
  });

  $('#exportGo').addEventListener('click', () => {
    const scope = $('#exportScope').value;
    const format = $('#exportFormat').value;
    const p = new URLSearchParams();
    p.set('format', format);
    if (scope === 'live') {
      // Reuse existing /api/export by mapping to its params:
      // live = tenders with deadline >= now — approximated by open_only=1 on
      // the standard export (which uses is_open). For a strict live filter
      // include deadline_after=today explicitly.
      p.set('stage', 'tender');
      p.set('open_only', '1');
      const today = new Date().toISOString().slice(0, 10);
      p.set('deadline_after', today);
    } else if (scope === 'all-tenders') {
      p.set('stage', 'tender');
      p.set('open_only', '0');
    } else if (scope === 'awards') {
      p.set('stage', 'award');
    }
    // Direct nav — the browser handles the download stream
    window.location = '/api/export?' + p.toString();
  });
}

/* ==========================================================================
   Overview tab — fee economics (Phase 4)
   Reads /api/admin/overview (pipeline table + tender join + derived numbers).
   ========================================================================== */
async function refreshOverview() {
  const s = await api('/api/admin/overview');
  if (!s) return;
  // KPIs
  $('#admKpiRevenue').textContent  = fmtGBP(s.revenue_booked);
  $('#admKpiRevenue').title        = fmtGBPFull(s.revenue_booked);
  $('#admKpiPipeline').textContent = fmtGBP(s.pipeline_unweighted);
  $('#admKpiPipeline').title       = fmtGBPFull(s.pipeline_unweighted);
  $('#admKpiExpected').textContent = fmtGBP(s.expected_per_deal);
  $('#admKpiExpected').title       = fmtGBPFull(s.expected_per_deal);
  $('#admKpiCount').textContent    = fmtInt(s.deal_count);
  // Funnel — horizontal bars per stage, widths proportional to max count
  const max = Math.max(1, ...s.funnel.map(r => r.count));
  $('#admFunnel').innerHTML = s.funnel.map(r => {
    const w = Math.round((r.count / max) * 100);
    return `<div class="funnel__row">
      <div class="funnel__label">${escapeHtml(r.stage)}</div>
      <div class="funnel__bar"><div class="funnel__fill" style="width:${w}%"></div></div>
      <div class="funnel__count">${fmtInt(r.count)}</div>
    </div>`;
  }).join('');
  // Fees-by-category bar chart (Chart.js, charcoal — the single most important
  // number is the KPI; the chart is a supporting distribution, kept plain).
  const top = s.fees_by_category.slice(0, 15);
  upsertChart('admChartFees', {
    type: 'bar',
    data: {
      labels: top.map(r => r.category),
      datasets: [{ label: 'Expected £', data: top.map(r => r.expected),
                   backgroundColor: C.gov, borderRadius: 4 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => fmtGBPFull(ctx.raw) } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 45, minRotation: 30, font: { size: 10 } } },
        y: { grid: { color: C.line }, ticks: { callback: v => fmtGBP(v) } },
      }
    }
  });
}

/* ==========================================================================
   Pipeline tab — deal-tracking CRUD (Phase 4)
   Table with inline edit for stage/client/notes; add-by-search below the header.
   ========================================================================== */
const STAGES = ['qualified', 'quoted', 'writing', 'submitted', 'won', 'lost'];

async function refreshPipeline() {
  const r = await api('/api/admin/pipeline');
  if (!r) return;
  const tbody = $('#pipeBody');
  const rows = r.rows;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8">
      <div class="empty">
        <div class="empty__title">No tracked deals yet</div>
        <div class="empty__body">Use the search box above or the <strong>Track</strong> action on any tender row (Search / Live bids) to add one.</div>
      </div>
    </td></tr>`;
  } else {
    tbody.innerHTML = rows.map(rowHtmlPipeline).join('');
  }
  $('#pipeFoot').textContent = rows.length
    ? `${fmtInt(rows.length)} tracked deal${rows.length === 1 ? '' : 's'}`
    : '';
}

function rowHtmlPipeline(p) {
  const t = p.tender || {};
  const title = t.notice_url
    ? `<a href="${escapeHtml(t.notice_url)}" target="_blank" rel="noopener">${escapeHtml(t.title || p.tender_uid)}</a>`
    : escapeHtml(t.title || p.tender_uid);
  const value = t.value_amount != null ? fmtGBP(t.value_amount) : '<span class="muted">–</span>';
  const feesTip = `Success fee (5%): ${fmtGBPFull(p.success_fee || 0)} · Expected £: ${fmtGBPFull(p.expected_value || 0)}`;
  const fees = `<span title="${escapeHtml(feesTip)}">${fmtGBP(p.expected_value || 0)}</span>`;
  const stageSel = `<select class="field field--sm" data-pipe-field="stage">
    ${STAGES.map(s => `<option value="${s}"${s === p.stage ? ' selected' : ''}>${s}</option>`).join('')}
  </select>`;
  const clientInput = `<input class="field field--sm" type="text" data-pipe-field="client_name" value="${escapeHtml(p.client_name)}" />`;
  return `<tr data-pipe-id="${p.id}">
    <td class="title">${title}${p.notes ? `<div class="muted" style="font-size:11px">${escapeHtml(p.notes)}</div>` : ''}</td>
    <td>${escapeHtml(t.buyer_name || '')}</td>
    <td>${clientInput}</td>
    <td>${stageSel}</td>
    <td class="num">${value}</td>
    <td class="num">${fees}</td>
    <td>${p.updated_at ? fmtDate(p.updated_at) : ''}</td>
    <td class="users-actions">
      <button class="btn btn--secondary btn--sm" data-pipe-action="delete" data-danger="1">Delete</button>
    </td>
  </tr>`;
}

// Pipeline add — search /api/tenders?q= and offer to track any result.
let _addAbort = null;
async function pipeSearch(q) {
  if (_addAbort) _addAbort.abort();
  _addAbort = new AbortController();
  const list = $('#pipeAddResults');
  if (!q || q.length < 2) { list.hidden = true; list.innerHTML = ''; return; }
  let r;
  try {
    r = await api('/api/tenders?q=' + encodeURIComponent(q) + '&limit=20&open_only=1',
                  { signal: _addAbort.signal });
  } catch (_) { return; }
  if (!r) return;
  if (!r.rows.length) {
    list.hidden = false;
    list.innerHTML = '<div class="muted" style="padding:6px 4px">No matches.</div>';
    return;
  }
  list.hidden = false;
  list.innerHTML = r.rows.map(t => `
    <div class="pipe-add__row" data-tender-uid="${escapeHtml(t.uid)}">
      <div>
        <div><strong>${escapeHtml(t.title || '')}</strong></div>
        <div class="muted" style="font-size:11px">
          ${escapeHtml(t.buyer_name || '')} · ${escapeHtml(t.category || '(unmapped)')}
          · ${t.value_amount != null ? fmtGBP(t.value_amount) : 'value –'}
        </div>
      </div>
      <button class="btn btn--primary btn--sm" data-pipe-add="1">+ Track</button>
    </div>`).join('');
}

function wirePipeline() {
  // Add-by-search
  const q = $('#pipeAddQ');
  let t = null;
  q.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => pipeSearch(q.value.trim()), 250);
  });
  $('#pipeAddResults').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-pipe-add]');
    if (!btn) return;
    const row = btn.closest('[data-tender-uid]');
    const uid = row.dataset.tenderUid;
    const clientName = prompt('Client name for this deal?');
    if (!clientName) return;
    btn.disabled = true;
    try {
      const r = await api('/api/admin/pipeline', {
        json: { tender_uid: uid, client_name: clientName },
      });
      if (r && r.ok) {
        $('#pipeAddResults').hidden = true;
        $('#pipeAddResults').innerHTML = '';
        $('#pipeAddQ').value = '';
        await refreshPipeline();
        await refreshOverview();
      }
    } catch (_) { /* toast already surfaced */ }
    finally { btn.disabled = false; }
  });

  // Inline edits + delete (delegated on tbody)
  $('#pipeBody').addEventListener('change', async (e) => {
    const field = e.target.dataset.pipeField;
    if (!field) return;
    const tr = e.target.closest('tr[data-pipe-id]');
    const id = tr.dataset.pipeId;
    const patch = { [field]: e.target.value };
    await api(`/api/admin/pipeline/${id}`, { method: 'PATCH', json: patch });
    // Re-render to pick up recomputed fees, updated_at, etc.
    await refreshPipeline();
    await refreshOverview();
  });
  $('#pipeBody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-pipe-action="delete"]');
    if (!btn) return;
    const tr = btn.closest('tr[data-pipe-id]');
    if (!confirm('Delete this pipeline entry?')) return;
    btn.disabled = true;
    try {
      await api(`/api/admin/pipeline/${tr.dataset.pipeId}`, { method: 'DELETE' });
      await refreshPipeline();
      await refreshOverview();
    } finally { btn.disabled = false; }
  });

  // Export CSV
  $('#pipeExport').addEventListener('click', () => {
    window.location = '/api/admin/pipeline/export';
  });
}


/* ==========================================================================
   Boot
   ========================================================================== */
function boot() {
  wireTabs();
  wireUserActions();
  wireDataOps();
  wirePipeline();
  // Load Overview data by default (initial tab).
  refreshOverview();
}

boot();
