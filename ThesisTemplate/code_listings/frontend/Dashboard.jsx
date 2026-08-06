import { useState, useEffect, useRef } from 'react';
import { Truck, AlertTriangle, Fuel, Wrench, Activity, Clock, RefreshCw, Wifi, Loader2, Timer, Navigation, Smartphone, BrainCircuit } from 'lucide-react';
import { normalizeAlert } from '../utils/api';
import { useApi } from '../hooks/useApi';
import { useLiveFleet } from '../hooks/useLiveFleet';
import { getStatusColor, getStatusLabel } from '../utils/statusColors';
import FleetMap from './FleetMap';
import TruckDetailModal from './TruckDetailModal';
import RouteAssignModal from './RouteAssignModal';


const buildStatCards = (trucks) => [
  { label: 'Total Fleet',     value: trucks.length,                                          icon: Truck,         textColor: 'text-blue-600',   bgColor: 'bg-blue-50' },
  { label: 'Active Trips',    value: trucks.filter(t => t.tripStatus === 'active').length,   icon: Activity,      textColor: 'text-green-600',  bgColor: 'bg-green-50' },
  // Anomalies stat counts trucks with any unresolved fuel_anomaly on their
  { label: 'Anomalies',       value: trucks.filter(t => (t.unresolvedFuelAnomalyCount ?? 0) > 0).length, icon: AlertTriangle, textColor: 'text-red-600',    bgColor: 'bg-red-50' },
  { label: 'Rest Alerts',     value: trucks.filter(t => t.status === 'rest_alert').length,   icon: Clock,         textColor: 'text-amber-600',  bgColor: 'bg-amber-50' },
  { label: 'Maintenance Due', value: trucks.filter(t => t.status === 'maintenance').length,  icon: Wrench,        textColor: 'text-orange-600', bgColor: 'bg-orange-50' },
  { label: 'Low Fuel',        value: trucks.filter(t => t.status === 'low_fuel').length,     icon: Fuel,          textColor: 'text-yellow-600', bgColor: 'bg-yellow-50' },
];

// > 3m   -> Offline     (red)  only shown during an active/paused trip
function deviceConnectivity(truck) {
  // Only show device badge during an active or paused trip.
  if (truck.tripStatus !== 'active' && truck.tripStatus !== 'paused') return null;
  if (!truck.deviceLastSeen) return null;
  const ageSec = (Date.now() - new Date(truck.deviceLastSeen).getTime()) / 1000;
  if (ageSec < 60)  return 'connected';
  if (ageSec < 180) return 'unstable';
  return 'offline';
}

const CONN_UI = {
  connected: { icon: Wifi,    color: 'text-green-500',  bg: 'bg-green-50',              label: 'Connected',    spin: false, pulse: false },
  unstable:  { icon: Loader2, color: 'text-yellow-500', bg: 'bg-yellow-50',             label: 'Connecting',   spin: true,  pulse: false },
  offline:   { icon: Loader2, color: 'text-red-500',    bg: 'bg-red-50',                label: 'Reconnecting', spin: true,  pulse: false },
};

const CONN_SEVERITY    = { connected: 1, unstable: 2, offline: 3 };
const DEGRADE_DELAY_MS = 30_000; // wait 30s before showing a degraded state

function RestCountdown({ nextRestAlertAt, clockOffsetRef, connectivity }) {
  const [secLeft, setSecLeft] = useState(null);

  useEffect(() => {
    if (!nextRestAlertAt) { setSecLeft(null); return; }
    const tick = () => {
      const serverNow = Date.now() + (clockOffsetRef?.current ?? 0);
      const s = Math.round((new Date(nextRestAlertAt).getTime() - serverNow) / 1000);
      setSecLeft(s);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [nextRestAlertAt, clockOffsetRef]);

  if (secLeft === null) {
    return (
      <div className="mt-1.5 flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-50">
        <Timer className="w-3 h-3 text-slate-400 flex-shrink-0" />
        <span className="text-xs font-medium text-slate-400">Rest in ...</span>
      </div>
    );
  }

  // Suppress the "overdue" badge whenever the truck isn't actively reporting.
  const offlineish = connectivity === 'offline' || connectivity === 'unstable';
  if (secLeft <= 0) {
    if (offlineish) {
      return (
        <div className="mt-1.5 flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-50">
          <Timer className="w-3 h-3 text-slate-400 flex-shrink-0" />
          <span className="text-xs font-medium text-slate-400">Awaiting HMI sync...</span>
        </div>
      );
    }
    return (
      <div className="mt-1.5 flex items-center gap-1 px-2 py-1 rounded-lg bg-red-50">
        <AlertTriangle className="w-3 h-3 text-red-500 flex-shrink-0" />
        <span className="text-xs font-medium text-red-600">Rest overdue</span>
      </div>
    );
  }

  const h = Math.floor(secLeft / 3600);
  const m = Math.floor((secLeft % 3600) / 60);
  const s = secLeft % 60;
  const label = h > 0
    ? `${h}h ${String(m).padStart(2,'0')}m`
    : `${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`;

  const urgent = secLeft < 1800; // < 30 min -> amber

  return (
    <div className={`mt-1.5 flex items-center gap-1 px-2 py-1 rounded-lg ${urgent ? 'bg-amber-50' : 'bg-slate-50'}`}>
      <Timer className={`w-3 h-3 flex-shrink-0 ${urgent ? 'text-amber-500' : 'text-slate-400'}`} />
      <span className={`text-xs font-medium ${urgent ? 'text-amber-600' : 'text-slate-500'}`}>
        Rest in {label}
      </span>
    </div>
  );
}

export default function Dashboard() {
  const [selectedTruckId,    setSelectedTruckId]    = useState(null);
  const [routeModalTruckId,  setRouteModalTruckId]  = useState(null);
  const prevConnRef  = useRef({});
  const [syncingIds, setSyncingIds] = useState(new Set());
  const connDebounce = useRef({});

  function getDisplayedConn(truckId, actual) {
    const state      = connDebounce.current[truckId] ?? { displayed: actual, worstSince: null };
    const actualSev  = actual          != null ? (CONN_SEVERITY[actual]          ?? 0) : 0;
    const displaySev = state.displayed != null ? (CONN_SEVERITY[state.displayed] ?? 0) : 0;
    if (actual == null) {
      connDebounce.current[truckId] = { displayed: null, worstSince: null };
      return null;
    }
    if (actualSev <= displaySev) {
      // same state or improvement (reconnected) - apply immediately
      connDebounce.current[truckId] = { displayed: actual, worstSince: null };
      return actual;
    }
    // actual is worse - start or check degradation timer
    const now = Date.now();
    if (!state.worstSince) {
      connDebounce.current[truckId] = { displayed: state.displayed, worstSince: now };
      return state.displayed;
    }
    if (now - state.worstSince >= DEGRADE_DELAY_MS) {
      connDebounce.current[truckId] = { displayed: actual, worstSince: null };
      return actual;
    }
    // still within grace period - keep current displayed state
    return state.displayed;
  }

  const { trucks: rawTrucks, loading: trucksLoading, error: trucksError, refetch: refetchTrucks, serverClockOffsetRef } =
    useLiveFleet();

  const { data: rawAlerts, loading: alertsLoading, refetch: refetchAlerts } =
    useApi('/alerts?resolved=false&active_only=true&limit=5', {
      transform: arr => arr.map(normalizeAlert),
      pollInterval: 3_000,
    });

  const { data: mlStatus } = useApi('/ml/status', { pollInterval: 15_000 });

  const trucks       = rawTrucks;
  const recentAlerts = rawAlerts  ?? [];
  const selectedTruck = trucks.find(t => t.id === selectedTruckId);
  const cards         = buildStatCards(trucks);
  const loading       = trucksLoading || alertsLoading;

  const handleRefresh = () => { refetchTrucks(); refetchAlerts(); };

  // Detect connectivity transitions
  useEffect(() => {
    if (!trucks.length) return;
    const newSyncing = new Set();
    const clearIds   = new Set();
    trucks.forEach(t => {
      const prev = prevConnRef.current[t.id];
      const curr = deviceConnectivity(t);
      // Reconnect -> show "Syncing..." briefly
      if (curr === 'connected' && (prev === 'offline' || prev === 'unstable')) {
        newSyncing.add(t.id);
      }
      // Trip ended -> clear any stale "Syncing..." immediately
      if (!t.tripId) clearIds.add(t.id);
      prevConnRef.current[t.id] = curr;
    });
    if (clearIds.size > 0) {
      setSyncingIds(prev => {
        const next = new Set(prev);
        clearIds.forEach(id => next.delete(id));
        return next;
      });
    }
    if (newSyncing.size > 0) {
      setSyncingIds(prev => new Set([...prev, ...newSyncing]));
      const timer = setTimeout(() => {
        setSyncingIds(prev => {
          const next = new Set(prev);
          newSyncing.forEach(id => next.delete(id));
          return next;
        });
      }, 6000);
      return () => clearTimeout(timer);
    }
  }, [trucks]);

  return (
    <div className="flex flex-col lg:flex-row gap-4 p-3 sm:p-4 lg:p-6">

      {}
      <div className="flex-1 flex flex-col gap-4 min-w-0">

        {}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-3">
          {cards.map(card => (
            <div
              key={card.label}
              className="bg-white rounded-xl p-3 sm:p-4 border border-slate-200 hover:shadow-md transition-shadow"
            >
              <div className="flex items-start justify-between mb-2">
                <div className={`p-2 rounded-lg ${card.bgColor}`}>
                  <card.icon className={`w-4 h-4 sm:w-5 sm:h-5 ${card.textColor}`} />
                </div>
                <span className={`text-xl sm:text-2xl font-bold ${card.textColor}`}>
                  {trucksLoading ? '-' : card.value}
                </span>
              </div>
              <p className="text-xs sm:text-sm text-slate-500 truncate">{card.label}</p>
            </div>
          ))}
        </div>

        {}
        {trucksError && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800 flex items-center gap-2">
            <Loader2 className="w-4 h-4 flex-shrink-0 animate-spin" />
            <span>Backend unreachable - reconnecting automatically. Last data may be stale.</span>
          </div>
        )}

        {}
        <div className="bg-white rounded-xl border border-slate-200 p-3 sm:p-4 flex flex-col
                        h-[380px] sm:h-[460px] md:h-[520px] lg:h-[calc(100vh-280px)]">
          <div className="flex items-center justify-between mb-3 flex-shrink-0">
            <h3 className="text-base sm:text-lg font-semibold text-slate-900">Live Fleet Map</h3>
            <div className="flex items-center gap-3">
              <button onClick={handleRefresh} disabled={loading}
                className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors disabled:opacity-50">
                <RefreshCw className={`w-4 h-4 text-slate-500 ${loading ? 'animate-spin' : ''}`} />
              </button>
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                <span>Live Tracking</span>
              </div>
              {}
              {mlStatus && (() => {
                const s = mlStatus.status;
                const color = s === 'active' ? 'text-green-700 bg-green-50 border border-green-200' : s === 'offline' ? 'text-slate-400 bg-slate-100' : 'text-amber-600 bg-amber-50';
                const label = s === 'active' ? 'ML Active' : s === 'offline' ? 'ML Offline' : 'ML Error';
                return (
                  <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>
                    <BrainCircuit className="w-3 h-3" />
                    <span>{label}</span>
                  </div>
                );
              })()}
            </div>
          </div>
          <div className="flex-1 rounded-lg overflow-hidden">
            {(() => {
              const gpsTrucks = trucks.filter(t => t.hasGps);
              if (!trucksLoading && gpsTrucks.length === 0) {
                return (
                  <div className="w-full h-full flex items-center justify-center bg-slate-50 rounded-lg">
                    <p className="text-sm text-slate-400">No trucks with GPS data</p>
                  </div>
                );
              }
              return (
                <FleetMap
                  trucks={gpsTrucks}
                  selectedTruckId={selectedTruckId}
                  onTruckSelect={setSelectedTruckId}
                />
              );
            })()}
          </div>
        </div>
      </div>

      {}
      <div className="w-full lg:w-80 xl:w-96 flex flex-col gap-4">

        {}
        <div className="bg-white rounded-xl border border-slate-200 p-3 sm:p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm sm:text-base font-semibold text-slate-900">Recent Alerts</h3>
            <span className="text-xs text-slate-500">{recentAlerts.length} Active</span>
          </div>
          <div className="space-y-2 max-h-36 overflow-y-auto">
            {recentAlerts.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-4">
                {alertsLoading ? 'Loading...' : 'No active alerts'}
              </p>
            ) : recentAlerts.map(alert => (
              <div key={alert.id} className="flex items-start gap-2 p-2 bg-slate-50 rounded-lg">
                <AlertTriangle className={`w-4 h-4 flex-shrink-0 mt-0.5 ${
                  alert.severity === 'high'   ? 'text-red-500'    :
                  alert.severity === 'medium' ? 'text-orange-500' : 'text-yellow-500'
                }`} />
                <div className="min-w-0">
                  <p className="text-xs font-medium text-slate-800 truncate">{alert.truckName}</p>
                  <p className="text-xs text-slate-500 line-clamp-2">{alert.message}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {}
        <div className="bg-white rounded-xl border border-slate-200 p-3 sm:p-4 flex flex-col
                        max-h-[420px] lg:max-h-[calc(100vh-340px)]">
          <h3 className="text-sm sm:text-base font-semibold text-slate-900 mb-3 flex-shrink-0">
            Fleet Status
          </h3>
          <div className="flex-1 overflow-y-auto space-y-2">
            {trucksLoading ? (
              <p className="text-xs text-slate-400 text-center py-8">Loading fleet...</p>
            ) : trucks.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-8">No trucks in fleet</p>
            ) : trucks.map(truck => (
              <button
                key={truck.id}
                onClick={() => setSelectedTruckId(truck.id)}
                className={`w-full text-left p-3 rounded-xl border transition-all ${
                  selectedTruckId === truck.id
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${getStatusColor(truck.status)}`} />
                    <span className="text-sm font-medium text-slate-900 truncate">{truck.name}</span>
                  </div>
                  <span className="text-xs text-slate-400 ml-2 flex-shrink-0">{truck.code}</span>
                </div>
                <p className="text-xs text-slate-500 mb-1.5 truncate">{truck.driver}</p>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-500">{getStatusLabel(truck.status)}</span>
                  <div className="flex gap-2 text-slate-600">
                    <span>{truck.speed} km/h</span>
                    <span>{truck.fuel != null
                      ? (truck.tankCapacityL
                          ? `${truck.fuel}% (${(truck.fuel * truck.tankCapacityL / 100).toFixed(1)} L)`
                          : `${truck.fuel}% fuel`)
                      : '- fuel'}</span>
                  </div>
                </div>
                <div className="mt-1 flex items-center justify-between text-xs text-slate-500">
                  <span>{truck.mileage != null ? `${Number(truck.mileage).toLocaleString()} km mileage` : 'Mileage --'}</span>
                  <span>{truck.avgKmPerL != null ? `${truck.avgKmPerL} km/L avg` : 'Avg --'}</span>
                  <span>
                    {truck.maintenanceKmRemaining != null
                      ? truck.maintenanceKmRemaining === 0
                        ? 'Maintenance due'
                        : `${Number(truck.maintenanceKmRemaining).toLocaleString()} km to service`
                      : 'Service --'}
                  </span>
                </div>
                {}
                {(() => {
                  const conn = getDisplayedConn(truck.id, deviceConnectivity(truck));
                  if (!conn) return null;
                  const ui = CONN_UI[conn];
                  const syncing = syncingIds.has(truck.id);
                  return (
                    <div className={`mt-2 flex items-center gap-1.5 px-2 py-1 rounded-lg ${ui.bg}`}>
                      <ui.icon className={`w-3 h-3 flex-shrink-0 ${ui.color} ${ui.spin ? 'animate-spin' : ''}`} />
                      <span className={`text-xs font-medium ${ui.color}`}>
                        {syncing ? 'HMI Syncing' : `HMI ${ui.label}`}
                      </span>
                    </div>
                  );
                })()}
                {}
                {(truck.tripStatus === 'active' || truck.tripStatus === 'paused') && (
                  <div className={`mt-1.5 flex items-center gap-1.5 px-2 py-1 rounded-lg ${truck.mobileCompanionActive ? 'bg-blue-50' : 'bg-slate-50'}`}>
                    <Smartphone className={`w-3 h-3 flex-shrink-0 ${truck.mobileCompanionActive ? 'text-blue-500' : 'text-slate-400'}`} />
                    <span className={`text-xs font-medium ${truck.mobileCompanionActive ? 'text-blue-600' : 'text-slate-400'}`}>
                      {truck.mobileCompanionActive ? 'Mobile Active' : 'Mobile Offline'}
                    </span>
                  </div>
                )}
                {}
                {(truck.tripStatus === 'active' || truck.tripStatus === 'paused') && (
                  <div className={`mt-1.5 flex items-center gap-1.5 px-2 py-1 rounded-lg ${
                    truck.hasGps ? 'bg-emerald-50' : 'bg-slate-100'
                  }`}>
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      truck.hasGps ? 'bg-emerald-400 animate-pulse' : 'bg-slate-400'
                    }`} />
                    <span className={`text-xs font-medium ${
                      truck.hasGps ? 'text-emerald-700' : 'text-slate-500'
                    }`}>
                      {truck.hasGps ? `GPS Active - ${truck.position[0].toFixed(4)}, ${truck.position[1].toFixed(4)}` : 'GPS Searching...'}
                    </span>
                  </div>
                )}
                {


}
                {truck.tripStatus === 'active' && truck.nextRestAlertAt && (
                  <RestCountdown
                    nextRestAlertAt={truck.nextRestAlertAt}
                    clockOffsetRef={serverClockOffsetRef}
                    connectivity={getDisplayedConn(truck.id, deviceConnectivity(truck))}
                  />
                )}
                {}
                {(truck.tripStatus === 'active' || truck.tripStatus === 'paused') && truck.tripId && (
                  <div className="mt-1.5 flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
                    <Navigation className="w-3 h-3 text-blue-400 flex-shrink-0" />
                    {truck.assignedDestination ? (
                      <span className="text-xs text-blue-700 truncate flex-1" title={truck.assignedDestination}>
                        {truck.assignedDestination}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400 flex-1">No route assigned</span>
                    )}
                    <button
                      onClick={e => { e.stopPropagation(); setRouteModalTruckId(truck.id); }}
                      className="text-xs text-blue-600 hover:text-blue-800 font-medium flex-shrink-0"
                    >
                      {truck.assignedDestination ? 'Edit' : 'Assign'}
                    </button>
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {selectedTruck && (
        <TruckDetailModal truck={selectedTruck} onClose={() => setSelectedTruckId(null)} />
      )}

      {routeModalTruckId && (() => {
        const t = trucks.find(tr => tr.id === routeModalTruckId);
        return t ? (
          <RouteAssignModal
            truck={t}
            onClose={() => setRouteModalTruckId(null)}
            onAssigned={refetchTrucks}
          />
        ) : null;
      })()}
    </div>
  );
}
