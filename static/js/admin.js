/* BidGov Compass — Admin console page (/admin) entry
   -----------------------------------------------------------------------
   Phase 3: Users tab (list + activate/deactivate/promote/demote/delete) and
            Data-ops tab (scrape controls + export scope picker).
   Phase 4 (upcoming): Overview economics + Pipeline CRUD wiring.

   All server calls hit /api/admin/* — routes gated by @admin_required so
   this JS never has to worry about non-admin execution.
   ----------------------------------------------------------------------- */

import { $, $$, escapeHtml, fmtDate, fmtDateTime, fmtInt } from './fmt.js';
import { api } from './api.js';

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
  if (name === 'users')   refreshUsers();
  if (name === 'dataops') refreshScrapeStatus();
  if (name === 'overview' && typeof refreshOverview === 'function') refreshOverview();
  if (name === 'pipeline' && typeof refreshPipeline === 'function') refreshPipeline();
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
   Boot
   ========================================================================== */
function boot() {
  wireTabs();
  wireUserActions();
  wireDataOps();
  // Default landing on Overview; if hash was set, wireTabs already switched
  const activeHash = (location.hash || '').replace('#', '');
  if (!['overview', 'pipeline', 'users', 'dataops'].includes(activeHash)) {
    // Overview needs Phase 4 wiring; for Phase 3 the tab is visible-but-empty
    // beyond the placeholder KPIs — that's fine, Users + Data ops are usable.
  }
}

boot();
