/* BidGov Compass — Airbnb-style contract-value range slider (Phase 5)
   -----------------------------------------------------------------------
   Renders a histogram of tender values behind a dual-thumb range slider.
   Bars inside the selected range render in brand red; bars outside dim to
   charcoal. Dragging either thumb updates the readouts immediately; on
   release, the hidden #fltMin / #fltMax inputs are populated and the caller-
   supplied `onCommit` runs (the same `refresh` used by the sidebar filters).

   Design:
     * 25 log-scale bins from £1k → £5M + one overflow bin for >£5M
       (matches /api/value-histogram).
     * Thumbs snap to bin boundaries — natural for a distributional slider.
     * Fully keyboard-accessible: focus a thumb, use ←/→ (Home/End for extremes).
     * The hidden inputs preserve backward compat: existing buildSearchQuery,
       loadFromUrl, and the column-popover range mode all keep working.
   ----------------------------------------------------------------------- */

import { $ } from './fmt.js';
import { api } from './api.js';

// abbreviated £ for readouts — mirrors fmt.fmtGBP for consistency
function fmtGBPAbb(v) {
  if (v == null) return '£–';
  if (v >= 1e6) return `£${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}m`;
  if (v >= 1e3) return `£${Math.round(v / 1e3)}k`;
  return `£${Math.round(v)}`;
}

let _bins = [];               // [{lo, hi, n}]
let _minIdx = 0, _maxIdx = 0; // selected bin range (inclusive)
let _onCommit = () => {};
let _fetchAbort = null;

/** Fetch the histogram scoped to the current sidebar filter state (excluding
 *  value_min/value_max so the histogram shows the WHOLE distribution before
 *  the user narrows). If a fetch is in flight, cancel it. */
async function fetchHistogram(buildQuery) {
  if (_fetchAbort) _fetchAbort.abort();
  _fetchAbort = new AbortController();
  const p = buildQuery();
  p.delete('value_min');
  p.delete('value_max');
  try {
    const r = await api('/api/value-histogram?' + p.toString(),
                        { signal: _fetchAbort.signal });
    if (!r) return null;
    return r;
  } catch (_) { return null; }
}

function paint() {
  const histEl = $('#valHist');
  const maxN = Math.max(1, ..._bins.map(b => b.n));
  histEl.innerHTML = _bins.map((b, i) => {
    const h = Math.max(2, Math.round((b.n / maxN) * 100));
    const inside = i >= _minIdx && i <= _maxIdx;
    return `<div class="val-slider__bar${inside ? ' is-inside' : ''}"
                 style="height:${h}%"
                 title="${b.hi ? `£${b.lo.toLocaleString()}–£${b.hi.toLocaleString()}` : `>£${b.lo.toLocaleString()}`}: ${b.n} notice${b.n===1?'':'s'}"></div>`;
  }).join('');
  const range = $('#valRange');
  const bins = _bins.length;
  const leftPct  = (_minIdx / (bins - 1)) * 100;
  const rightPct = (_maxIdx / (bins - 1)) * 100;
  range.style.left  = leftPct + '%';
  range.style.right = (100 - rightPct) + '%';
  $('#valThumbMin').style.left = leftPct + '%';
  $('#valThumbMax').style.left = rightPct + '%';
  const lo = _bins[_minIdx]?.lo;
  const hi = _bins[_maxIdx]?.hi;
  $('#valReadoutMin').textContent = fmtGBPAbb(lo);
  $('#valReadoutMax').textContent = _maxIdx === bins - 1 && hi == null ? '£5m+' : fmtGBPAbb(hi);
}

function commit() {
  // Hidden inputs feed buildSearchQuery unchanged.
  const lo = _bins[_minIdx]?.lo;
  const hi = _bins[_maxIdx]?.hi;
  const bins = _bins.length;
  // Only send min if not at absolute floor; only send max if not at open-ended top.
  $('#fltMin').value = (_minIdx > 0) ? (lo ?? '') : '';
  $('#fltMax').value = (_maxIdx < bins - 1) ? (hi ?? '') : '';
  _onCommit();
}

/** Convert a pointer's clientX inside the rail to a bin index (0…bins-1). */
function xToBinIndex(clientX) {
  const rail = $('#valThumbMin').parentElement; // .val-slider__rail
  const rect = rail.getBoundingClientRect();
  const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  return Math.round(pct * (_bins.length - 1));
}

function startDrag(which) {
  let moved = false;
  function onMove(e) {
    moved = true;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const idx = xToBinIndex(clientX);
    if (which === 'min') _minIdx = Math.min(idx, _maxIdx);
    else                 _maxIdx = Math.max(idx, _minIdx);
    paint();
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend',  onUp);
    if (moved) commit();
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onUp);
  document.addEventListener('touchmove', onMove, { passive: true });
  document.addEventListener('touchend',  onUp);
}

function wireInteraction() {
  $('#valThumbMin').addEventListener('mousedown',  () => startDrag('min'));
  $('#valThumbMax').addEventListener('mousedown',  () => startDrag('max'));
  $('#valThumbMin').addEventListener('touchstart', () => startDrag('min'), { passive: true });
  $('#valThumbMax').addEventListener('touchstart', () => startDrag('max'), { passive: true });
  // Keyboard: ←/→ steps by 1 bin; Home/End jumps to extreme
  const keyHandler = (which) => (e) => {
    let handled = true;
    const bins = _bins.length;
    if (e.key === 'ArrowLeft') {
      if (which === 'min') _minIdx = Math.max(0, _minIdx - 1);
      else                 _maxIdx = Math.max(_minIdx, _maxIdx - 1);
    } else if (e.key === 'ArrowRight') {
      if (which === 'min') _minIdx = Math.min(_maxIdx, _minIdx + 1);
      else                 _maxIdx = Math.min(bins - 1, _maxIdx + 1);
    } else if (e.key === 'Home') {
      if (which === 'min') _minIdx = 0; else _maxIdx = _minIdx;
    } else if (e.key === 'End') {
      if (which === 'max') _maxIdx = bins - 1; else _minIdx = _maxIdx;
    } else { handled = false; }
    if (handled) { e.preventDefault(); paint(); commit(); }
  };
  $('#valThumbMin').addEventListener('keydown', keyHandler('min'));
  $('#valThumbMax').addEventListener('keydown', keyHandler('max'));
}

/** Sync thumbs from URL-hydrated hidden inputs (called after loadSearchFromUrl). */
function syncFromInputs() {
  if (!_bins.length) return;
  const min = parseFloat($('#fltMin').value || '') || null;
  const max = parseFloat($('#fltMax').value || '') || null;
  _minIdx = 0;
  _maxIdx = _bins.length - 1;
  if (min != null) {
    // find first bin whose lo >= min
    for (let i = 0; i < _bins.length; i++) {
      if (_bins[i].lo >= min) { _minIdx = i; break; }
    }
  }
  if (max != null) {
    for (let i = _bins.length - 1; i >= 0; i--) {
      const top = _bins[i].hi ?? Infinity;
      if (top <= max) { _maxIdx = i; break; }
    }
    if (_maxIdx < _minIdx) _maxIdx = _minIdx;
  }
  paint();
}

/**
 * Public API: initialise the slider. Call once at boot AFTER the sidebar
 * facets have been loaded.
 *   buildQuery — the shared filter-query builder (so the histogram narrows
 *                as other filters change).
 *   onCommit   — the debounced `refresh` used by the sidebar.
 * Returns a `refetch()` function callers can invoke on any filter change so
 * the histogram reshapes to the new scope.
 */
export async function initValueSlider(buildQuery, onCommit) {
  _onCommit = onCommit;
  wireInteraction();
  const data = await fetchHistogram(buildQuery);
  if (!data) return () => {};
  _bins = data.bins;
  _minIdx = 0;
  _maxIdx = _bins.length - 1;
  syncFromInputs();
  paint();
  return async function refetch() {
    const d = await fetchHistogram(buildQuery);
    if (d) { _bins = d.bins; syncFromInputs(); paint(); }
  };
}
