import { useState, useMemo } from 'react';
import { AlertTriangle, Filter, Search, CheckCircle, RefreshCw } from 'lucide-react';
import { format } from 'date-fns';
import { normalizeAlert, apiFetch } from '../utils/api';
import { useApi } from '../hooks/useApi';

export default function Alerts() {
  const [search,         setSearch]         = useState('');
  const [filterType,     setFilterType]     = useState('all');
  const [filterStatus,   setFilterStatus]   = useState('all');
  const [filterSeverity, setFilterSeverity] = useState('all');
  const [resolving,      setResolving]      = useState(null); // ID of alert being resolved

  const { data: rawAlerts, loading, error, refetch } =
    useApi('/alerts', { transform: arr => arr.map(normalizeAlert) });

  const alerts = rawAlerts ?? [];

  const filtered = useMemo(() => alerts.filter(a => {
    const q = search.toLowerCase();
    return (
      (a.truckName.toLowerCase().includes(q) || a.message.toLowerCase().includes(q) || a.truckId.toLowerCase().includes(q)) &&
      (filterType     === 'all' || a.type === filterType) &&
      (filterStatus   === 'all' || (filterStatus === 'active' ? !a.resolved : a.resolved)) &&
      (filterSeverity === 'all' || a.severity === filterSeverity)
    );
  }), [alerts, search, filterType, filterStatus, filterSeverity]);

  const stats = {
    total:    alerts.length,
    active:   alerts.filter(a => !a.resolved).length,
    resolved: alerts.filter(a => a.resolved).length,
    high:     alerts.filter(a => a.severity === 'high' && !a.resolved).length,
  };

  const handleResolve = async (alertId) => {
    setResolving(alertId);
    try {
      await apiFetch(`/alerts/${alertId}/resolve`, { method: 'PATCH' });
      refetch();
    } catch (err) {
      alert(`Failed to resolve: ${err.message}`);
    } finally {
      setResolving(null);
    }
  };

  const severities = ['all', 'high', 'medium', 'low'];
  const sevBtnClass = (s) => {
    if (s === filterSeverity) {
      if (s === 'all')    return 'bg-slate-900 text-white';
      if (s === 'high')   return 'bg-red-600 text-white';
      if (s === 'medium') return 'bg-orange-600 text-white';
      return 'bg-yellow-600 text-white';
    }
    if (s === 'all')    return 'bg-slate-100 text-slate-700 hover:bg-slate-200';
    if (s === 'high')   return 'bg-red-100 text-red-700 hover:bg-red-200';
    if (s === 'medium') return 'bg-orange-100 text-orange-700 hover:bg-orange-200';
    return 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200';
  };

  return (
    <div className="p-3 sm:p-4 lg:p-6 max-w-7xl mx-auto">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-slate-900 mb-1">Alerts Management</h1>
          <p className="text-sm text-slate-500">Monitor and manage fleet alerts and notifications</p>
        </div>
        <button onClick={refetch} disabled={loading}
          className="p-2 rounded-lg hover:bg-slate-100 transition-colors disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 text-slate-500 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {}
      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {[
          { label: 'Total Alerts',   value: loading ? '-' : stats.total,    color: 'text-slate-900' },
          { label: 'Active',         value: loading ? '-' : stats.active,   color: 'text-orange-600' },
          { label: 'Resolved',       value: loading ? '-' : stats.resolved, color: 'text-green-600' },
          { label: 'High Priority',  value: loading ? '-' : stats.high,     color: 'text-red-600' },
        ].map(s => (
          <div key={s.label} className="bg-white rounded-xl border border-slate-200 p-3 sm:p-4">
            <p className="text-xs text-slate-500 mb-1">{s.label}</p>
            <p className={`text-xl sm:text-2xl font-bold ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {}
      <div className="bg-white rounded-xl border border-slate-200 p-4 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Filter className="w-4 h-4 text-slate-500" />
          <span className="text-sm font-medium text-slate-900">Filters</span>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-3 mb-4">
          <div className="lg:col-span-2 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search by truck, message, or ID..."
              className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <select value={filterType} onChange={e => setFilterType(e.target.value)}
            className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
            <option value="all">All Types</option>
            <option value="fuel_anomaly">Fuel Anomaly</option>
            <option value="anomaly">Anomaly</option>
            <option value="rest_alert">Rest Alert</option>
            <option value="maintenance">Maintenance</option>
            <option value="low_fuel">Low Fuel</option>
          </select>
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
            className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="resolved">Resolved</option>
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          {severities.map(s => (
            <button key={s} onClick={() => setFilterSeverity(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors ${sevBtnClass(s)}`}>
              {s === 'all' ? 'All Severity' : s}
            </button>
          ))}
        </div>
      </div>

      {}
      <div className="bg-white rounded-xl border border-slate-200">
        <div className="px-4 py-3 border-b border-slate-200">
          <span className="text-sm font-medium text-slate-900">
            {loading ? 'Loading...' : `Alerts (${filtered.length})`}
          </span>
        </div>
        <div className="divide-y divide-slate-100">
          {loading ? (
            <div className="py-16 text-center text-slate-400">
              <RefreshCw className="w-8 h-8 mx-auto mb-3 animate-spin opacity-40" />
              <p>Loading alerts...</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center text-slate-400">
              <AlertTriangle className="w-12 h-12 mx-auto mb-3 opacity-20" />
              <p>No alerts found</p>
              <p className="text-xs mt-1">Try adjusting your filters</p>
            </div>
          ) : filtered.map(alert => (
            <div key={alert.id} className="p-4 hover:bg-slate-50 transition-colors">
              <div className="flex items-start gap-3">
                <div className={`p-2 rounded-lg flex-shrink-0 ${
                  alert.severity === 'high' ? 'bg-red-100' :
                  alert.severity === 'medium' ? 'bg-orange-100' : 'bg-yellow-100'
                }`}>
                  <AlertTriangle className={`w-4 h-4 ${
                    alert.severity === 'high' ? 'text-red-600' :
                    alert.severity === 'medium' ? 'text-orange-600' : 'text-yellow-600'
                  }`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="text-sm font-medium text-slate-900">{alert.truckName}</span>
                    <span className="text-xs text-slate-400">* {alert.truckId.slice(0, 8)}...</span>
                    <span className={`px-2 py-0.5 rounded text-xs font-medium uppercase ${
                      alert.severity === 'high' ? 'bg-red-100 text-red-800' :
                      alert.severity === 'medium' ? 'bg-orange-100 text-orange-800' : 'bg-yellow-100 text-yellow-800'
                    }`}>{alert.type}</span>
                  </div>
                  <p className="text-sm text-slate-600 mb-1.5">{alert.message}</p>
                  <p className="text-xs text-slate-400">{format(new Date(alert.timestamp), 'MMM d, yyyy * h:mm a')}</p>
                </div>
                {alert.resolved ? (
                  <div className="flex items-center gap-1.5 px-3 py-1.5 bg-green-100 text-green-800 rounded-lg text-xs font-medium flex-shrink-0">
                    <CheckCircle className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Resolved</span>
                  </div>
                ) : (
                  <button
                    onClick={() => handleResolve(alert.id)}
                    disabled={resolving === alert.id}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-xs font-medium rounded-lg transition-colors flex-shrink-0"
                  >
                    {resolving === alert.id ? '...' : 'Resolve'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
