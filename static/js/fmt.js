/* BidGov Compass — formatting + DOM helpers + brand palette (shared module)
   -----------------------------------------------------------------------
   All number/money formatting in the portal MUST go through fmtGBP/fmtInt/etc.
   here — no ad-hoc toLocaleString() calls in page code.
   ----------------------------------------------------------------------- */

// ---- Brand palette (mirrors style.css tokens) --------------------------
// `ramp` is a 15-slot qualitative palette used by categorical charts
// (pie/doughnut). Ordered so slot 0 = brand red (accent for the largest
// slice), colours after 1 are picked from an Okabe-Ito-inspired set for
// colour-blind separability, and brand tokens are interleaved so the whole
// thing still reads as GovBid. `ramp[14]` is warm grey — reserved as the
// "Other" bucket colour by convention (see chart renderers).
export const C = {
  gov: '#54565B', bid: '#E03C31', bidHover: '#C22F26',
  soft: '#8A8D91', line: '#E7E6E3',
  ramp: [
    '#E03C31',  // 0  brand red (Bid)
    '#0072B2',  // 1  deep blue
    '#009E73',  // 2  teal-green
    '#E69F00',  // 3  amber
    '#8064A2',  // 4  purple
    '#4BACC6',  // 5  aqua
    '#D55E00',  // 6  vermillion
    '#7A6ED8',  // 7  periwinkle
    '#9BBB59',  // 8  olive
    '#B7791F',  // 9  brown-amber
    '#CC79A7',  // 10 reddish purple
    '#5B9BD5',  // 11 sky blue
    '#2E7D5B',  // 12 brand success green
    '#54565B',  // 13 brand charcoal (Gov)
    '#B0AFAB',  // 14 warm grey — used for "Other" bucket
  ],
};

// ---- DOM helpers -------------------------------------------------------
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---- Intl formatters ---------------------------------------------------
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
export function fmtGBP(v) {
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
export const fmtGBPFull = v => (v == null || isNaN(v)) ? '–' : NF_GBP0.format(Number(v));

/** Locale-aware integer with thousands separators. */
export const fmtInt = v => (v == null || isNaN(v)) ? '0' : NF_INT.format(Number(v));

/** ISO -> "10 Jul 2026" (empty string on null/invalid). */
export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : DTF_DATE.format(d);
}

/** ISO -> "10 Jul 2026, 14:30". */
export function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : DTF_DATETIME.format(d);
}

// ---- Deadline utilities ------------------------------------------------
export function daysUntil(iso) {
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
export function fmtRelDeadline(iso) {
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
export function deadlineUrgency(iso) {
  const d = daysUntil(iso);
  if (d == null) return 'none';
  if (d < 0) return 'past';
  if (d === 0) return 'today';
  if (d <= 7) return 'week';
  if (d <= 30) return 'month';
  return 'later';
}

// ---- Misc --------------------------------------------------------------
export const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, m =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

/** Non-blocking inline error banner (top of page). Auto-dismisses after 6s. */
export function showError(message) {
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

/** Sets a "Last scrape: 10 Jul 2026, 14:30" stamp into an element with #lastUpdated. */
export function stampLastUpdated(iso) {
  if (!iso) return;
  const el = $('#lastUpdated');
  if (el) el.textContent = 'Last scrape: ' + fmtDateTime(iso);
}
