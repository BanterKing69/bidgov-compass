/* BidGov Compass — Dashboard page (/dashboard) entry
   -----------------------------------------------------------------------
   KPI row + 5 Chart.js charts. Uses /api/stats (unfiltered store-wide view).
   ----------------------------------------------------------------------- */

import { api } from './api.js';
import { renderAllDashboardCharts, renderDashboardKpis } from './charts.js';

async function boot() {
  // /api/stats with no filter params returns store-wide aggregates.
  const s = await api('/api/stats');
  if (!s) return;
  renderDashboardKpis(s);
  renderAllDashboardCharts(s);
}

boot().catch(err => {
  console.error(err);
});
