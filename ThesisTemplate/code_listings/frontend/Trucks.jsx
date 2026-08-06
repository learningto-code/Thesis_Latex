import { useState } from 'react';
import { Search, SlidersHorizontal, RefreshCw } from 'lucide-react';
import { useLiveFleet } from '../hooks/useLiveFleet';
import { getStatusColor, getStatusLabel } from '../utils/statusColors';
import TruckDetailModal from './TruckDetailModal';
import RouteAssignModal from './RouteAssignModal';

export default function Trucks() {
  const [selectedTruckId, setSelectedTruckId] = useState(null);
  const [searchTerm,       setSearchTerm]      = useState('');
  const [filterStatus,     setFilterStatus]    = useState('all');
  const [viewMode,         setViewMode]        = useState('grid');
  const [routeTruck,       setRouteTruck]      = useState(null);

  const { trucks, loading, error, refetch } = useLiveFleet();
  const selectedTruck = trucks.find(t => t.id === selectedTruckId);

  const filtered = trucks.filter(t => {
    const q = searchTerm.toLowerCase();
    const matchSearch = t.name.toLowerCase().includes(q)
      || t.driver.toLowerCase().includes(q)
      || t.code.toLowerCase().includes(q);
    const matchStatus = filterStatus === 'all' || t.status === filterStatus;
    return matchSearch && matchStatus;
  });

  return (
    <div className="p-4 lg:p-6 max-w-7xl mx-auto">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-slate-900 mb-1">Fleet Management</h1>
          <p className="text-sm text-slate-500">Manage and monitor all trucks in your fleet</p>
        </div>
        <button onClick={refetch} disabled={loading}
          className="p-2 rounded-lg hover:bg-slate-100 transition-colors disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 text-slate-500 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">{error}</div>
      )}

      {}
      <div className="bg-white rounded-xl border border-slate-200 p-4 mb-6">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder="Search by name, driver, or code..."
              className="w-full pl-10 pr-4 py-2.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="flex gap-3">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="w-4 h-4 text-slate-500" />
              <select
                value={filterStatus}
                onChange={e => setFilterStatus(e.target.value)}
                className="px-3 py-2.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="all">All Status</option>
                <option value="active">Active</option>
                <option value="idle">Idle</option>
                <option value="anomaly">Anomaly</option>
                <option value="maintenance">Maintenance</option>
                <option value="rest_alert">Rest Alert</option>
                <option value="low_fuel">Low Fuel</option>
                <option value="offline">Offline</option>
              </select>
            </div>
            <div className="flex border border-slate-300 rounded-lg overflow-hidden">
              {['grid', 'list'].map(mode => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`px-4 py-2 text-sm capitalize transition-colors ${
                    viewMode === mode ? 'bg-blue-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'
                  } ${mode === 'list' ? 'border-l border-slate-300' : ''}`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <p className="text-xs text-slate-500 mb-4">
        {loading ? 'Loading...' : `Showing ${filtered.length} of ${trucks.length} trucks`}
      </p>

      {}
      {viewMode === 'grid' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {loading ? (
            <p className="col-span-full text-center text-slate-400 py-12">Loading trucks...</p>
          ) : filtered.length === 0 ? (
            <p className="col-span-full text-center text-slate-400 py-12">No trucks match your filters</p>
          ) : filtered.map(truck => (
            <button
              key={truck.id}
              onClick={() => setSelectedTruckId(truck.id)}
              className="bg-white rounded-xl border border-slate-200 p-5 text-left hover:shadow-md hover:border-blue-300 transition-all"
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">{truck.name}</h3>
                  <p className="text-xs text-slate-400">{truck.code}</p>
                </div>
                <div className={`w-2.5 h-2.5 rounded-full mt-1 ${getStatusColor(truck.status)}`} />
              </div>
              <p className="text-xs text-slate-500 mb-3 pb-3 border-b border-slate-100">{truck.driver}</p>
              <span className={`inline-block px-2.5 py-1 rounded-full text-xs text-white mb-3 ${getStatusColor(truck.status)}`}>
                {getStatusLabel(truck.status)}
              </span>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div><p className="text-slate-400">Speed</p><p className="text-slate-800 font-medium">{truck.speed} km/h</p></div>
                <div><p className="text-slate-400">Fuel</p><p className="text-slate-800 font-medium">{truck.fuel != null
                  ? (truck.tankCapacityL
                      ? `${truck.fuel}% (${(truck.fuel * truck.tankCapacityL / 100).toFixed(1)} L)`
                      : `${truck.fuel}%`)
                  : '-'}</p></div>
                <div><p className="text-slate-400">Distance</p><p className="text-slate-800 font-medium">{truck.distance} km</p></div>
                <div><p className="text-slate-400">Mileage</p><p className="text-slate-800 font-medium">{truck.mileage != null ? `${Number(truck.mileage).toLocaleString()} km` : '-'}</p></div>
                <div><p className="text-slate-400">Maint.</p><p className="text-slate-800 font-medium">{truck.maintenanceKmRemaining != null ? `${Number(truck.maintenanceKmRemaining).toLocaleString()} km` : '-'}</p></div>
                <div><p className="text-slate-400">Avg. Economy</p><p className="text-slate-800 font-medium">{truck.avgKmPerL != null ? `${truck.avgKmPerL} km/L` : '-'}</p></div>
              </div>
              {(truck.tripStatus === 'active' || truck.tripStatus === 'paused') && truck.tripId && (
                <div className="mt-4 pt-3 border-t border-slate-100">
                  <p className="text-xs text-slate-400 mb-2 truncate">
                    {truck.assignedDestination ? `Route: ${truck.assignedDestination}` : 'No route assigned'}
                  </p>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={e => { e.stopPropagation(); setRouteTruck(truck); }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        setRouteTruck(truck);
                      }
                    }}
                    className="inline-flex px-3 py-1.5 rounded-lg bg-blue-50 text-blue-700 text-xs font-semibold hover:bg-blue-100"
                  >
                    {truck.assignedDestination ? 'Edit Route' : 'Assign Route'}
                  </span>
                </div>
              )}
            </button>
          ))}
        </div>
      ) : (
        
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  {['Truck', 'Driver', 'Status', 'Speed', 'Fuel', 'Avg. Economy', 'Distance', 'Mileage', 'Maint.', 'Route'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading ? (
                  <tr><td colSpan={10} className="px-4 py-12 text-center text-slate-400">Loading trucks...</td></tr>
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={10} className="px-4 py-12 text-center text-slate-400">No trucks match your filters</td></tr>
                ) : filtered.map(truck => (
                  <tr
                    key={truck.id}
                    onClick={() => setSelectedTruckId(truck.id)}
                    className="hover:bg-slate-50 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${getStatusColor(truck.status)}`} />
                        <div>
                          <p className="font-medium text-slate-900">{truck.name}</p>
                          <p className="text-xs text-slate-400">{truck.code}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-700">{truck.driver}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2.5 py-1 rounded-full text-xs text-white ${getStatusColor(truck.status)}`}>
                        {getStatusLabel(truck.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-700">{truck.speed} km/h</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-16 bg-slate-200 rounded-full h-1.5">
                          <div
                            className={`h-1.5 rounded-full ${truck.fuel == null ? 'bg-slate-300' : truck.fuel > 50 ? 'bg-green-500' : truck.fuel > 20 ? 'bg-yellow-500' : 'bg-red-500'}`}
                            style={{ width: `${truck.fuel ?? 0}%` }}
                          />
                        </div>
                        <span className="text-slate-700 text-right whitespace-nowrap">{truck.fuel != null
                          ? (truck.tankCapacityL
                              ? `${truck.fuel}% (${(truck.fuel * truck.tankCapacityL / 100).toFixed(1)} L)`
                              : `${truck.fuel}%`)
                          : '-'}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-700 whitespace-nowrap">{truck.avgKmPerL != null ? `${truck.avgKmPerL} km/L` : '-'}</td>
                    <td className="px-4 py-3 text-slate-700">{truck.distance} km</td>
                    <td className="px-4 py-3 text-slate-700">{truck.mileage != null ? `${Number(truck.mileage).toLocaleString()} km` : '-'}</td>
                    <td className="px-4 py-3 text-slate-700">
                      {truck.maintenanceKmRemaining != null
                        ? truck.maintenanceKmRemaining === 0
                          ? 'Due'
                          : `${Number(truck.maintenanceKmRemaining).toLocaleString()} km`
                        : '-'}
                    </td>
                    <td className="px-4 py-3">
                      {(truck.tripStatus === 'active' || truck.tripStatus === 'paused') && truck.tripId ? (
                        <button
                          onClick={e => { e.stopPropagation(); setRouteTruck(truck); }}
                          className="text-xs font-semibold text-blue-600 hover:text-blue-800"
                        >
                          {truck.assignedDestination ? 'Edit Route' : 'Assign Route'}
                        </button>
                      ) : (
                        <span className="text-xs text-slate-400">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {selectedTruck && (
        <TruckDetailModal truck={selectedTruck} onClose={() => setSelectedTruckId(null)} />
      )}
      {routeTruck && (
        <RouteAssignModal
          truck={routeTruck}
          onClose={() => setRouteTruck(null)}
          onAssigned={refetch}
        />
      )}
    </div>
  );
}
