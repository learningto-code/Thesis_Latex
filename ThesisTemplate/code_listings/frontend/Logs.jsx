import { useMemo, useState } from 'react';
import { Download, Filter, RefreshCw, Archive, Clock3 } from 'lucide-react';
import { format, isValid } from 'date-fns';
import { apiFetch, normalizeLog, normalizeTruck } from '../utils/api';
import { useApi } from '../hooks/useApi';

function getDashboardUser() {
  try {
    return JSON.parse(localStorage.getItem('fleet_user')) || null;
  } catch {
    return null;
  }
}

function buildLogPath(basePath, filters) {
  const params = new URLSearchParams({ limit: '300' });
  if (filters.truckId && filters.truckId !== 'all') params.set('truck_id', filters.truckId);
  if (filters.driverSearch.trim()) params.set('driver_search', filters.driverSearch.trim());
  if (filters.tripId.trim()) params.set('trip_id', filters.tripId.trim());
  if (filters.dateFrom) params.set('date_from', filters.dateFrom);
  if (filters.dateTo) params.set('date_to', filters.dateTo);
  return `${basePath}?${params.toString()}`;
}

function statusBadge(tripStatus) {
  if (tripStatus === 'active') return 'bg-green-100 text-green-700';
  if (tripStatus === 'paused') return 'bg-amber-100 text-amber-700';
  if (tripStatus === 'ended') return 'bg-slate-200 text-slate-700';
  return 'bg-slate-100 text-slate-600';
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatDateTime(value, fallback = 'Unknown time') {
  if (!value) return fallback;
  const parsed = new Date(value);
  return isValid(parsed) ? format(parsed, 'MMM d, yyyy h:mm a') : fallback;
}

function formatDateOnly(value, fallback = '-') {
  if (!value) return fallback;
  const parsed = new Date(value);
  return isValid(parsed) ? format(parsed, 'MMM d, yyyy') : fallback;
}

function formatShortId(value, fallback = '-') {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value.length > 8 ? `${value.slice(0, 8)}...` : value;
}

function csvField(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

const CHANNEL_LABELS = {
  wifi:     'WiFi',
  cellular: 'Cellular',
  gsm:      'Cellular',   // legacy log entries - display as Cellular too
  lte:      'Cellular',   // legacy log entries - display as Cellular too
  lora:     'LoRa',
  buffered: 'Offline Replay',
};

function ChannelBadge({ channel }) {
  if (!channel) return <span className="text-slate-400">-</span>;
  const styles = {
    wifi:     'bg-blue-100 text-blue-700',
    cellular: 'bg-purple-100 text-purple-700',
    gsm:      'bg-purple-100 text-purple-700',
    lte:      'bg-purple-100 text-purple-700',
    lora:     'bg-green-100 text-green-700',
    buffered: 'bg-amber-100 text-amber-800',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${styles[channel] ?? 'bg-slate-100 text-slate-600'}`}>
      {CHANNEL_LABELS[channel] ?? channel}
    </span>
  );
}

function GpsSourceBadge({ source }) {
  if (source === 'fused_mobile_fallback') {
    return <span className="px-2 py-0.5 rounded text-xs font-medium bg-cyan-100 text-cyan-700">Mobile GPS fallback</span>;
  }
  if (source === 'mobile_gps') {
    return <span className="px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">Mobile GPS</span>;
  }
  if (source === 'embedded_gps') {
    return <span className="px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-700">Embedded GPS</span>;
  }
  return <span className="text-slate-400">-</span>;
}

export default function Logs() {
  const user = getDashboardUser();
  const [activeTab, setActiveTab] = useState('recent');
  const [filters, setFilters] = useState({
    truckId: 'all',
    driverSearch: '',
    tripId: '',
    dateFrom: '',
    dateTo: '',
  });
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveMessage, setArchiveMessage] = useState('');

  const recentPath = activeTab === 'recent' ? buildLogPath('/logs/recent', filters) : null;
  const archivedPath = activeTab === 'archived' ? buildLogPath('/logs/archived', filters) : null;

  const recentApi = useApi(recentPath, {
    transform: rows => ensureArray(rows).map(normalizeLog),
    pollInterval: activeTab === 'recent' ? 3_000 : undefined,
  });
  const archivedApi = useApi(archivedPath, {
    transform: rows => ensureArray(rows).map(normalizeLog),
  });
  const fleetApi = useApi('/fleet/status', {
    transform: d => ensureArray(d?.trucks ?? d).map(normalizeTruck),
    pollInterval: 10_000,
  });

  const currentApi = activeTab === 'recent' ? recentApi : archivedApi;
  const logs = ensureArray(currentApi.data);
  const fleet = ensureArray(fleetApi.data);
  const loading = currentApi.loading;
  const error = currentApi.error;
  const activeTruckCount = fleet.filter(truck => truck.tripStatus === 'active').length;
  const avgSpeed = logs.length
    ? Math.round(logs.reduce((sum, log) => sum + safeNumber(log.speed), 0) / logs.length)
    : 0;

  const truckOptions = useMemo(() => (
    [...fleet]
      .sort((left, right) => String(left.code ?? '').localeCompare(String(right.code ?? '')))
      .map(truck => ({ id: truck.id, label: truck.code ?? 'Unknown Truck' }))
  ), [fleet]);

  const stats = [
    { label: activeTab === 'recent' ? 'Recent Logs' : 'Archived Logs', value: loading ? '--' : logs.length, color: 'text-slate-900' },
    { label: 'Active Trucks', value: fleetApi.loading ? '--' : activeTruckCount, color: 'text-green-600' },
    { label: 'Anomalies', value: loading ? '--' : logs.filter(log => log.anomaly).length, color: 'text-red-600' },
    { label: 'Avg Speed', value: loading ? '--' : `${avgSpeed} km/h`, color: 'text-blue-600' },
  ];

  const handleRefresh = () => {
    currentApi.refetch?.();
    fleetApi.refetch?.();
  };

  const handleExport = () => {
    const header = 'Time Sent,Sync Time,Channel,Truck,Driver,Trip ID,Fuel,Lat,Lon,GPS Source,Speed,Status,Anomaly,Archived At\n';
    const rows = logs.map(log => [
      csvField(log.sentAt ?? log.timestamp),
      csvField(log.commChannel === 'buffered' ? (log.receivedAt ?? '') : ''),
      csvField(log.commChannel ?? ''),
      csvField(log.truckName),
      csvField(log.driverName),
      csvField(log.tripId),
      csvField(log.fuel),
      csvField(log.latitude),
      csvField(log.longitude),
      csvField(log.gpsSource),
      csvField(log.speed),
      csvField(log.tripStatus),
      csvField(log.anomaly),
      csvField(log.archivedAt),
    ].join(','));
    const blob = new Blob([header + rows.join('\n')], { type: 'text/csv' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `${activeTab}_telemetry_logs_${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  };

  const handleArchiveNow = async () => {
    setArchiveBusy(true);
    setArchiveMessage('');
    try {
      const result = await apiFetch('/maintenance/archive-logs', {
        method: 'POST',
        body: JSON.stringify({ retention_days: 30 }),
      });
      setArchiveMessage(`Archive completed: ${safeNumber(result.archived_logs)} logs moved from ${safeNumber(result.archived_trips)} trip(s).`);
      archivedApi.refetch?.();
      recentApi.refetch?.();
    } catch (archiveError) {
      setArchiveMessage(archiveError.message || 'Archive failed.');
    } finally {
      setArchiveBusy(false);
    }
  };

  const emptyMessage = activeTab === 'recent'
    ? 'No recent logs available yet.'
    : 'No archived logs available yet.';

  return (
    <div className="p-3 sm:p-4 lg:p-6 max-w-7xl mx-auto">
      <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-slate-900 mb-1">Telemetry Logs</h1>
          <p className="text-sm text-slate-500">Separate recent fleet monitoring from archived historical telemetry.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="p-2 rounded-lg hover:bg-slate-100 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 text-slate-500 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={handleExport}
            disabled={logs.length === 0}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <Download className="w-4 h-4" />
            <span className="hidden sm:inline">Export CSV</span>
          </button>
          {user?.role === 'head_admin' && activeTab === 'archived' && (
            <button
              onClick={handleArchiveNow}
              disabled={archiveBusy}
              className="flex items-center gap-2 px-4 py-2 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-400 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <Archive className="w-4 h-4" />
              <span>{archiveBusy ? 'Archiving...' : 'Run Archive Now'}</span>
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={() => setActiveTab('recent')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            activeTab === 'recent' ? 'bg-blue-600 text-white' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
          }`}
        >
          <Clock3 className="w-4 h-4 inline mr-2" />
          Recent Logs
        </button>
        <button
          onClick={() => setActiveTab('archived')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            activeTab === 'archived' ? 'bg-blue-600 text-white' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
          }`}
        >
          <Archive className="w-4 h-4 inline mr-2" />
          Archived Logs
        </button>
      </div>

      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {archiveMessage && (
        <div className={`mb-4 rounded-xl p-3 text-sm ${archiveMessage.toLowerCase().includes('failed') || archiveMessage.toLowerCase().includes('error') ? 'bg-red-50 border border-red-200 text-red-700' : 'bg-slate-100 border border-slate-200 text-slate-700'}`}>
          {archiveMessage}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {stats.map(stat => (
          <div key={stat.label} className="bg-white rounded-xl border border-slate-200 p-3 sm:p-4">
            <p className="text-xs text-slate-500 mb-1">{stat.label}</p>
            <p className={`text-xl sm:text-2xl font-bold ${stat.color}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-4 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Filter className="w-4 h-4 text-slate-500" />
          <span className="text-sm font-medium text-slate-900">Filters</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
          <select
            value={filters.truckId}
            onChange={event => setFilters(current => ({ ...current, truckId: event.target.value }))}
            className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All Trucks</option>
            {truckOptions.map(option => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
          <input
            type="text"
            value={filters.driverSearch}
            onChange={event => setFilters(current => ({ ...current, driverSearch: event.target.value }))}
            placeholder="Driver name"
            className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <input
            type="text"
            value={filters.tripId}
            onChange={event => setFilters(current => ({ ...current, tripId: event.target.value }))}
            placeholder="Trip ID"
            className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <input
            type="date"
            value={filters.dateFrom}
            onChange={event => setFilters(current => ({ ...current, dateFrom: event.target.value }))}
            className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <input
            type="date"
            value={filters.dateTo}
            onChange={event => setFilters(current => ({ ...current, dateTo: event.target.value }))}
            className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>


      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200">
          <span className="text-sm font-medium text-slate-900">
            {loading ? 'Loading...' : `${activeTab === 'recent' ? 'Recent Logs' : 'Archived Logs'} (${logs.length})`}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                {[
                  'Time Sent',
                  'Truck',
                  'Driver',
                  'Trip',
                  'Speed',
                  'Fuel',
                  'Status',
                  'Channel',
                  'GPS',
                  'Anomaly',
                  ...(activeTab === 'archived' ? ['Archived'] : []),
                ].map(header => (
                  <th key={header} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={activeTab === 'archived' ? 11 : 10} className="px-4 py-12 text-center text-slate-400">
                    <RefreshCw className="w-6 h-6 mx-auto mb-2 animate-spin opacity-40" />
                    Loading logs...
                  </td>
                </tr>
              ) : logs.length === 0 ? (
                <tr>
                  <td colSpan={activeTab === 'archived' ? 11 : 10} className="px-4 py-12 text-center text-slate-400">
                    {emptyMessage}
                  </td>
                </tr>
              ) : logs.map((log, index) => (
                <tr key={`${activeTab}-${log.id ?? log.timestamp ?? log.tripId ?? index}`} className={`hover:bg-slate-50 transition-colors ${log.anomaly ? 'bg-red-50' : ''}`}>
                  <td className="px-4 py-3 whitespace-nowrap text-slate-700">
                    <span>{formatDateTime(log.sentAt ?? log.timestamp)}</span>
                    {log.commChannel === 'buffered' && log.receivedAt && (
                      <p className="text-xs text-amber-600 mt-0.5">
                        Synced {formatDateTime(log.receivedAt)}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <p className="font-medium text-slate-900">{log.truckName || 'Unknown Truck'}</p>
                    <p className="text-xs text-slate-400">{formatShortId(log.truckId)}</p>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-slate-700">{log.driverName || 'Unknown Driver'}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-slate-600">{formatShortId(log.tripId)}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-slate-700">{safeNumber(log.speed)} km/h</td>
                  <td className="px-4 py-3 whitespace-nowrap text-slate-700">
                    {log.fuel != null ? (
                      <>
                        {log.fuel}%
                        {log.fuelLevelL != null && (
                          <span className="text-slate-400 ml-1">({log.fuelLevelL.toFixed(1)} L)</span>
                        )}
                      </>
                    ) : <span className="text-slate-400">-</span>}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusBadge(log.tripStatus ?? 'idle')}`}>
                      {log.tripStatus ?? 'idle'}
                    </span>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <ChannelBadge channel={log.commChannel} />
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <GpsSourceBadge source={log.gpsSource} />
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {log.anomaly
                      ? <span className="px-2 py-0.5 bg-red-100 text-red-700 rounded text-xs font-medium">Yes</span>
                      : <span className="text-slate-400">-</span>}
                  </td>
                  {activeTab === 'archived' && (
                    <td className="px-4 py-3 whitespace-nowrap text-slate-600">
                      {formatDateOnly(log.archivedAt)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
