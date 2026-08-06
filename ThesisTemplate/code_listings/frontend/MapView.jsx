import { useState } from 'react';
import FleetMap from './FleetMap';
import TruckDetailModal from './TruckDetailModal';
import { useLiveFleet } from '../hooks/useLiveFleet';
import { getStatusColor, getStatusLabel } from '../utils/statusColors';
import { RefreshCw, AlertTriangle } from 'lucide-react';

export default function MapView() {
  const [selectedTruckId, setSelectedTruckId] = useState(null);

  const { trucks, loading, error, refetch } = useLiveFleet();
  const selectedTruck = trucks.find(t => t.id === selectedTruckId);

  return (
    <div className="flex flex-col lg:flex-row" style={{ height: 'calc(100vh - 65px)' }}>

      {}
      <div className="flex-1 min-h-[400px] lg:min-h-0 relative">
        {error ? (
          <div className="w-full h-full flex items-center justify-center bg-slate-50">
            <div className="text-center">
              <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-2" />
              <p className="text-sm text-slate-600">{error}</p>
            </div>
          </div>
        ) : trucks.length === 0 && !loading ? (
          <div className="w-full h-full flex items-center justify-center bg-slate-50">
            <p className="text-sm text-slate-400">No trucks with GPS data available</p>
          </div>
        ) : (
          <FleetMap
            trucks={trucks}
            selectedTruckId={selectedTruckId}
            onTruckSelect={setSelectedTruckId}
          />
        )}
      </div>

      {}
      <div className="w-full lg:w-72 xl:w-80 bg-white border-t lg:border-t-0 lg:border-l border-slate-200 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 flex-shrink-0 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Fleet Status</h3>
            <p className="text-xs text-slate-500">{trucks.length} trucks tracked</p>
          </div>
          <button onClick={refetch} disabled={loading}
            className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors disabled:opacity-50">
            <RefreshCw className={`w-4 h-4 text-slate-500 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
          {loading ? (
            <p className="text-xs text-slate-400 text-center py-10">Loading fleet...</p>
          ) : trucks.map(truck => (
            <button
              key={truck.id}
              onClick={() => setSelectedTruckId(truck.id)}
              className={`w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors ${
                selectedTruckId === truck.id ? 'bg-blue-50' : ''
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${getStatusColor(truck.status)}`} />
                <span className="text-sm font-medium text-slate-900 truncate">{truck.name}</span>
                <span className="text-xs text-slate-400 ml-auto flex-shrink-0">{truck.code}</span>
              </div>
              <p className="text-xs text-slate-500 mb-1">{truck.driver}</p>
              <div className="flex items-center justify-between text-xs text-slate-600">
                <span>{getStatusLabel(truck.status)}</span>
                <span>{truck.fuel != null
                  ? (truck.tankCapacityL
                      ? `${truck.fuel}% (${(truck.fuel * truck.tankCapacityL / 100).toFixed(1)} L)`
                      : `${truck.fuel}% fuel`)
                  : '- fuel'}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {selectedTruck && (
        <TruckDetailModal truck={selectedTruck} onClose={() => setSelectedTruckId(null)} />
      )}
    </div>
  );
}
