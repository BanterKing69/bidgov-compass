/* BidGov Compass — fetch wrapper (shared module)
   -----------------------------------------------------------------------
   All HTTP calls from the portal go through api() so we get uniform:
     * 401 handling (bounce to /auth/login)
     * JSON parsing
     * Friendly error surfacing via showError toast
     * A single place to attach the X-CSRFToken header (added in Phase 4)
   ----------------------------------------------------------------------- */

import { showError } from './fmt.js';

/**
 * Reads the CSRF token from the <meta name="csrf-token"> tag baked into
 * _app_base.html. Empty string in Phase 2 (Flask-WTF lands in Phase 4);
 * the fetch still succeeds because the server has no CSRF gate yet.
 */
function getCsrfToken() {
  const el = document.querySelector('meta[name="csrf-token"]');
  return el ? el.getAttribute('content') || '' : '';
}

/**
 * Fetch wrapper with JSON parsing + friendly error surfacing.
 *   const data = await api('/api/tenders?open_only=1');
 *   const posted = await api('/api/pipeline', { method: 'POST', json: {...} });
 *
 * Options:
 *   - json:    convenience for JSON POST/PATCH bodies. Sets Content-Type +
 *              stringifies + attaches CSRF header on state-changing methods.
 *   - method:  HTTP method (default GET).
 *   - headers: additional headers to merge in.
 *   - signal:  AbortSignal for cancellable requests.
 *
 * Returns:
 *   - Parsed JSON on 2xx.
 *   - null on 401 (page bounces to login).
 *   - Throws on other non-2xx (message includes status + statusText).
 */
export async function api(url, opts = {}) {
  const { json, method, headers, ...rest } = opts;
  const finalHeaders = { ...(headers || {}) };
  let body = rest.body;
  const finalMethod = method || (json !== undefined ? 'POST' : 'GET');
  if (json !== undefined) {
    finalHeaders['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  // Attach CSRF token on any state-changing method (Phase 4 turns it on server-side).
  if (finalMethod !== 'GET' && finalMethod !== 'HEAD') {
    const token = getCsrfToken();
    if (token) finalHeaders['X-CSRFToken'] = token;
  }
  try {
    const r = await fetch(url, { ...rest, method: finalMethod, headers: finalHeaders, body });
    if (r.status === 401) {
      window.location = '/auth/login?next=' + encodeURIComponent(location.pathname);
      return null;
    }
    if (!r.ok) {
      // Try to surface a JSON error body when the server sends one
      let msg = `${r.status} ${r.statusText}`;
      try {
        const j = await r.json();
        if (j && j.error) msg = j.error;
      } catch (_) { /* not JSON — keep status message */ }
      throw new Error(msg);
    }
    // 204 or empty
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return null;
    return await r.json();
  } catch (err) {
    showError(`Request failed: ${err.message}`);
    throw err;
  }
}
