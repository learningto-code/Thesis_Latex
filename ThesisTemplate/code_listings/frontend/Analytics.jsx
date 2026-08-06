import { useMemo, useState } from 'react';
import { Activity, AlertTriangle, Fuel, RefreshCw, Route, Clock3, Wrench, Calendar } from 'lucide-react';
import {
  BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { normalizeTruck, normalizeTripSummary } from '../utils/api';
import { useApi } from '../hooks/useApi';

const COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#64748b'];
const tooltipStyle = {
  contentStyle: { backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '12px' },
};

function buildSummaryPath(days, truckId) {
  const params = new URLSearchParams({ days: String(days), limit: '200' });
  if (truckId && truckId !== 'all') params.set('truck_id', truckId);
  return `/trips/summaries?${params.toString()}`;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

// ?? Maintenance Forecast ??????????????????????????????????????????????????
const STATUS_STYLES = {
  due:      { dot: 'bg-red-500',    label: 'DUE NOW',         text: 'text-red-600' },
  imminent: { dot: 'bg-orange-500', label: 'Within 2 weeks',  text: 'text-orange-600' },
  soon:     { dot: 'bg-amber-500',  label: 'Within 2 months', text: 'text-amber-600' },
  ok:       { dot: 'bg-emerald-500', label: 'On track',       text: 'text-emerald-600' },
  unknown:  { dot: 'bg-slate-300',  label: 'No mileage yet',  text: 'text-slate-400' },
};

function fmtDate(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtKm(v) { return v == null ? '-' : `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })} km`; }

function MaintenanceForecastPanel({ data, loading }) {
  const trucks = ensureArray(data?.trucks);
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5 mb-6">
      <div className="flex items-center gap-2 mb-4">
        <Wrench className="w-4 h-4 text-slate-500" />
        <h3 className="text-base font-semibold text-slate-900">Maintenance Forecast</h3>
        <span className="ml-auto text-xs text-slate-400">
          Avg km/day from last {data?.window_days ?? 30} days
        </span>
      </div>
      {loading && (
        <div className="h-24 flex items-center justify-center text-slate-400 text-sm">Loading forecast...</div>
      )}
      {!loading && trucks.length === 0 && (
        <div className="h-24 flex items-center justify-center text-slate-400 text-sm">No trucks in fleet.</div>
      )}
      {!loading && trucks.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {trucks.map(t => {
            const st = STATUS_STYLES[t.status] ?? STATUS_STYLES.unknown;
            const interval = Number(t.maintenance_interval_km ?? 5000);
            const used     = interval - Number(t.km_remaining ?? interval);
            const pct      = Math.min(100, Math.max(0, (used / interval) * 100));
            const barColor =
              t.status === 'due'      ? 'bg-red-500'    :
              t.status === 'imminent' ? 'bg-orange-500' :
              t.status === 'soon'     ? 'bg-amber-500'  : 'bg-emerald-500';
            return (
              <div key={t.truck_id} className="border border-slate-200 rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{t.truck_code ?? '-'}</p>
                    <p className="text-xs text-slate-400">{t.plate_number ?? ''}</p>
                  </div>
                  <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${st.text}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
                    {st.label}
                  </span>
                </div>
                <div className="w-full h-2 bg-slate-100 rounded mb-2 overflow-hidden">
                  <div className={`h-full ${barColor}`} style={{ width: `${pct}%` }} />
                </div>
                <dl className="text-xs text-slate-500 space-y-0.5">
                  <div className="flex justify-between"><dt>Current mileage</dt><dd className="text-slate-700">{fmtKm(t.current_odometer_km)}</dd></div>
                  <div className="flex justify-between"><dt>km to service</dt>   <dd className="text-slate-700">{fmtKm(t.km_remaining)}</dd></div>
                  <div className="flex justify-between"><dt>Avg km/day</dt>      <dd className="text-slate-700">{t.avg_km_per_day ?? '-'}</dd></div>
                  <div className="flex justify-between items-center">
                    <dt className="flex items-center gap-1"><Calendar className="w-3 h-3" />Projected</dt>
                    <dd className="text-slate-700">{fmtDate(t.projected_date)}</dd>
                  </div>
                </dl>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ?? Anomaly Heatmap ???????????????????????????????????????????????????????
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function AnomalyHeatmapPanel({ data, loading }) {
  const total   = data?.total_anomalies ?? 0;
  const maxCell = Math.max(1, data?.max_cell ?? 0);
  const cells   = ensureArray(data?.cells);
  const grid = useMemo(() => {
    const g = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const c of cells) {
      if (c && Number.isFinite(c.dow) && Number.isFinite(c.hour)) g[c.dow][c.hour] = c.count ?? 0;
    }
    return g;
  }, [cells]);

  const cellColor = (n) => {
    if (n === 0) return '#f1f5f9';
    const t = Math.sqrt(n / maxCell);                    // square-root so low counts are still visible
    const r = Math.round(254 - (254 - 153) * t);
    const g = Math.round(202 - (202 - 27)  * t);
    const b = Math.round(202 - (202 - 27)  * t);
    return `rgb(${r}, ${g}, ${b})`;
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
      <div className="flex items-center gap-2 mb-4">
        <AlertTriangle className="w-4 h-4 text-slate-500" />
        <h3 className="text-base font-semibold text-slate-900">Fuel Anomaly Heatmap</h3>
        <span className="ml-auto text-xs text-slate-400">
          {total} anomalies . last {data?.window_days ?? 90} days
        </span>
      </div>
      {loading && (
        <div className="h-24 flex items-center justify-center text-slate-400 text-sm">Loading heatmap...</div>
      )}
      {!loading && total === 0 && (
        <div className="h-24 flex items-center justify-center text-slate-400 text-sm">
          No anomalies recorded in the last {data?.window_days ?? 90} days.
        </div>
      )}
      {!loading && total > 0 && (
        <div className="overflow-x-auto">
          <div className="inline-block">
            <div className="flex text-[10px] text-slate-400 mb-1 pl-9">
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h} className="w-5 text-center">{h % 3 === 0 ? h : ''}</div>
              ))}
            </div>
            {grid.map((row, dow) => (
              <div key={dow} className="flex items-center mb-0.5">
                <div className="w-9 text-[11px] text-slate-500 pr-2 text-right">{DAY_LABELS[dow]}</div>
                {row.map((count, h) => (
                  <div
                    key={h}
                    className="w-5 h-5 mr-px rounded-sm"
                    style={{ backgroundColor: cellColor(count) }}
                    title={`${DAY_LABELS[dow]} ${h}:00 - ${count} anomaly${count === 1 ? '' : 's'}`}
                  />
                ))}
              </div>
            ))}
            <div className="flex items-center gap-2 mt-3 text-[11px] text-slate-500">
              <span>Less</span>
              {[0, 0.2, 0.4, 0.6, 0.8, 1].map(t => (
                <span key={t} className="w-4 h-3 rounded-sm" style={{ backgroundColor: cellColor(Math.round(t * maxCell)) }} />
              ))}
              <span>More</span>
              <span className="ml-3 text-slate-400">peak cell = {maxCell}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Analytics() {
  const [days, setDays] = useState(90);
  const [truckId, setTruckId] = useState('all');

  const summariesApi = useApi(buildSummaryPath(days, truckId), {
    transform: payload => {
      const safePayload = payload && typeof payload === 'object' ? payload : {};
      const items = ensureArray(safePayload.items)
        .filter(row => row?.trip_status !== 'discarded')
        .map(normalizeTripSummary);
      return {
        items,
        totals: safePayload.totals && typeof safePayload.totals === 'object' ? safePayload.totals : {},
        count: items.length,
      };
    },
    pollInterval: 30_000,
  });

  const fleetApi = useApi('/fleet/status', {
    transform: d => ensureArray(d?.trucks ?? d).map(normalizeTruck),
    pollInterval: 15_000,
  });

  const maintenanceApi = useApi('/analytics/maintenance-forecast', {
    transform: d => (d && typeof d === 'object' ? d : {}),
    pollInterval: 60_000,
  });

  const heatmapApi = useApi(`/analytics/anomaly-heatmap?days=${days}`, {
    transform: d => (d && typeof d === 'object' ? d : {}),
    pollInterval: 60_000,
  });

  // who consistently triggers overspeed should be coached regardless of truck.
  const overspeedApi = useApi(`/alerts/by-driver?type=overspeed&days=${days}`, {
    transform: d => ensureArray(d).map(r => ({
      driver:  r.driver_name ?? 'Unknown',
      events:  safeNumber(r.count),
    })),
    pollInterval: 30_000,
  });

  const loading = summariesApi.loading || fleetApi.loading;
  const summaries = ensureArray(summariesApi.data?.items);
  const totals = summariesApi.data?.totals && typeof summariesApi.data.totals === 'object'
    ? summariesApi.data.totals
    : {};
  const fleet = ensureArray(fleetApi.data);
  const activeTrips = fleet.filter(truck => truck.tripStatus === 'active').length;
  const avgFuelValue = totals.average_fuel_level;
  const avgFuel = avgFuelValue != null && Number.isFinite(Number(avgFuelValue))
    ? `${Math.round(Number(avgFuelValue))}%`
    : '--';

  const truckOptions = useMemo(() => (
    [...fleet]
      .sort((left, right) => String(left.code ?? '').localeCompare(String(right.code ?? '')))
      .map(truck => ({ id: truck.id, label: truck.code ?? 'Unknown Truck' }))
  ), [fleet]);

  const distanceByTruck = useMemo(() => {
    const grouped = {};
    for (const summary of summaries) {
      const truckCode = summary.truckCode || 'Unknown Truck';
      grouped[truckCode] = (grouped[truckCode] ?? 0) + safeNumber(summary.totalDistanceKm);
    }
    return Object.entries(grouped).map(([truck, distance]) => ({ truck, distance: +distance.toFixed(1) }));
  }, [summaries]);

  // driven by two different drivers should split into two bars.
  const overspeedByDriver = ensureArray(overspeedApi.data);

  const statusDistribution = useMemo(() => {
    const grouped = {};
    for (const truck of fleet) {
      const status = truck.status || 'unknown';
      grouped[status] = (grouped[status] ?? 0) + 1;
    }
    return Object.entries(grouped)
      .map(([name, value]) => ({ name: name.replace('_', ' '), value }))
      .filter(item => item.value > 0);
  }, [fleet]);

  const summaryCards = [
    { icon: Route, color: 'from-blue-500 to-blue-600', value: loading ? '--' : `${safeNumber(totals.total_distance_km)} km`, label: `Total Distance (${days}d)` },
    { icon: Clock3, color: 'from-emerald-500 to-emerald-600', value: loading ? '--' : `${safeNumber(totals.total_operating_hours)} h`, label: 'Operating Hours' },
    { icon: Activity, color: 'from-indigo-500 to-indigo-600', value: loading ? '--' : activeTrips, label: 'Active Trips Now' },
    { icon: AlertTriangle, color: 'from-red-500 to-red-600', value: loading ? '--' : safeNumber(totals.total_anomalies), label: 'Total Anomalies' },
    { icon: Fuel, color: 'from-amber-500 to-amber-600', value: loading ? '--' : avgFuel, label: 'Average Fuel' },
  ];

  const showAnalyticsEmptyState = !loading && summaries.length === 0;

  const handleRefresh = () => {
    summariesApi.refetch?.();
    fleetApi.refetch?.();
  };

  return (
    <div className="p-3 sm:p-4 lg:p-6 max-w-7xl mx-auto">
      <div className="mb-6 flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-slate-900 mb-1">Analytics</h1>
          <p className="text-sm text-slate-500">Aggregated fleet metrics and trend charts. For per-trip records, see the Trips tab.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={truckId}
            onChange={event => setTruckId(event.target.value)}
            className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All Trucks</option>
            {truckOptions.map(option => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
          <select
            value={days}
            onChange={event => setDays(Number(event.target.value))}
            className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last 12 months</option>
          </select>
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="p-2 rounded-lg hover:bg-slate-100 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 text-slate-500 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {summariesApi.error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {summariesApi.error}
        </div>
      )}

      {showAnalyticsEmptyState && (
        <div className="mb-4 bg-slate-50 border border-slate-200 rounded-xl p-4 text-sm text-slate-600">
          No analytics data yet because no trips have ended. Trip summaries will appear here after completed trips are recorded.
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 sm:gap-4 mb-6">
        {summaryCards.map(card => {
          const Icon = card.icon;
          return (
            <div key={card.label} className={`bg-gradient-to-br ${card.color} rounded-xl p-4 sm:p-5 text-white`}>
              <Icon className="w-6 h-6 opacity-80 mb-3" />
              <p className="text-2xl sm:text-3xl font-bold mb-1">{card.value}</p>
              <p className="text-xs opacity-90">{card.label}</p>
            </div>
          );
        })}
      </div>

      <MaintenanceForecastPanel data={maintenanceApi.data} loading={maintenanceApi.loading} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
          <h3 className="text-base font-semibold text-slate-900 mb-4">Distance by Truck</h3>
          {distanceByTruck.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-slate-400 text-sm">
              {loading ? 'Loading...' : 'No trip summaries available yet.'}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={distanceByTruck}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="truck" stroke="#94a3b8" style={{ fontSize: '11px' }} />
                <YAxis stroke="#94a3b8" style={{ fontSize: '11px' }} />
                <Tooltip {...tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: '12px' }} />
                <Bar dataKey="distance" fill="#22c55e" name="Distance (km)" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
          <h3 className="text-base font-semibold text-slate-900 mb-4">Overspeeding Events by Driver</h3>
          {overspeedByDriver.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-slate-400 text-sm">
              {overspeedApi.loading ? 'Loading...' : `No overspeeding events in the last ${days} days.`}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={overspeedByDriver}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="driver" stroke="#94a3b8" style={{ fontSize: '11px' }} />
                <YAxis stroke="#94a3b8" style={{ fontSize: '11px' }} allowDecimals={false} />
                <Tooltip {...tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: '12px' }} />
                <Bar dataKey="events" fill="#f97316" name="Overspeeding Events" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <AnomalyHeatmapPanel data={heatmapApi.data} loading={heatmapApi.loading} />

        <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
          <h3 className="text-base font-semibold text-slate-900 mb-4">
            Live Fleet Status Distribution
            <span className="ml-2 text-xs font-normal text-slate-400">{fleet.length} trucks</span>
          </h3>
          {statusDistribution.length === 0 ? (
            <div className="h-56 flex items-center justify-center text-slate-400 text-sm">
              {loading ? 'Loading...' : 'No fleet data available.'}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={statusDistribution}
                  cx="50%"
                  cy="50%"
                  outerRadius={85}
                  dataKey="value"
                  label={({ name, value, percent }) =>
                    `${name}: ${value} (${((percent ?? 0) * 100).toFixed(0)}%)`}
                  labelLine={false}
                  style={{ fontSize: '11px' }}
                >
                  {statusDistribution.map((item, index) =>
                    <Cell key={`${item.name}-${index}`} fill={COLORS[index % COLORS.length]} />)}
                </Pie>
                <Tooltip
                  contentStyle={{ fontSize: '12px', borderRadius: '8px' }}
                  formatter={(v, _n, p) => [`${v} truck${v === 1 ? '' : 's'}`, p?.payload?.name]}
                />
                <Legend wrapperStyle={{ fontSize: '11px' }} iconSize={10} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

    </div>
  );
}
