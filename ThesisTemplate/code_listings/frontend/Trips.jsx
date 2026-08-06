import { useState, useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import {
  ArrowLeft, RefreshCw, AlertTriangle, Search,
  MapPin, ChevronRight, Route, Clock,
  Gauge, Fuel, Navigation, Cpu, AlertCircle,
} from 'lucide-react';
import { format, isValid, differenceInMinutes } from 'date-fns';
import { useApi } from '../hooks/useApi';
import { normalizeTruck, normalizeTripSummary } from '../utils/api';

if (!L.Icon.Default.__fixed) {
  delete L.Icon.Default.prototype._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
    iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
    shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  });
  L.Icon.Default.__fixed = true;
}

// ?? Helpers ???????????????????????????????????????????????????????????????????
function ensureArray(v) { return Array.isArray(v) ? v : []; }
function safeNum(v, fb = 0) { const n = Number(v); return Number.isFinite(n) ? n : fb; }

function fmtDate(v, fb = '--') {
  if (!v) return fb;
  const d = new Date(v);
  return isValid(d) ? format(d, 'MMM d, yyyy h:mm a') : fb;
}

function fmtDuration(start, end) {
  if (!start || !end) return '--';
  const s = new Date(start), e = new Date(end);
  if (!isValid(s) || !isValid(e)) return '--';
  const mins = differenceInMinutes(e, s);
  if (mins < 0) return '--';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtMs(ms) {
  if (ms == null || ms < 0) return '--';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2,'0')}m ${String(sec).padStart(2,'0')}s`;
  return `${String(m).padStart(2,'0')}m ${String(sec).padStart(2,'0')}s`;
}

const EVENT_LABELS = {
  trip_started:  { label: 'Trip Started',     color: 'bg-green-100 text-green-700',   dot: 'bg-green-500'  },
  rest_started:  { label: 'Rest Break',       color: 'bg-amber-100 text-amber-700',   dot: 'bg-amber-500'  },
  trip_resumed:  { label: 'Resumed Driving',  color: 'bg-blue-100 text-blue-700',     dot: 'bg-blue-500'   },
  trip_ended:    { label: 'Trip Ended',       color: 'bg-slate-100 text-slate-700',   dot: 'bg-slate-400'  },
  rest_snoozed:  { label: 'Snoozed (10 min)', color: 'bg-purple-100 text-purple-700', dot: 'bg-purple-400' },
  // Alerts surfaced into the activity stream so the timeline shows the full
  fuel_anomaly:  { label: 'Fuel Anomaly',     color: 'bg-rose-100 text-rose-700',     dot: 'bg-rose-500'   },
  overspeed:     { label: 'Overspeeding',     color: 'bg-orange-100 text-orange-700', dot: 'bg-orange-500' },
  rest_alert:    { label: 'Rest Required',    color: 'bg-yellow-100 text-yellow-700', dot: 'bg-yellow-500' },
  maintenance:   { label: 'Maintenance Due',  color: 'bg-blue-100 text-blue-700',     dot: 'bg-blue-500'   },
};

function buildSummaryPath(period, truckId) {
  const p = new URLSearchParams({ limit: '200' });
  if (period && period !== 'all') p.set('days', String(period));
  if (truckId && truckId !== 'all') p.set('truck_id', truckId);
  return `/trips/summaries?${p.toString()}`;
}

// ?? Leaflet custom icons ???????????????????????????????????????????????????????
function createStartIcon() {
  return L.divIcon({
    html: `<div style="
      width:34px;height:34px;background:#0891b2;
      border-radius:50%;border:3px solid white;
      box-shadow:0 2px 10px rgba(8,145,178,0.55);
      display:flex;align-items:center;justify-content:center;
      font-size:13px;font-weight:700;color:white;letter-spacing:-0.5px;
    ">S</div>`,
    className: '',
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -20],
  });
}

function createEndIcon() {
  return L.divIcon({
    html: `<div style="
      width:34px;height:34px;background:#0e7490;
      border-radius:50%;border:3px solid white;
      box-shadow:0 2px 10px rgba(14,116,144,0.55);
      display:flex;align-items:center;justify-content:center;
      font-size:13px;font-weight:700;color:white;letter-spacing:-0.5px;
    ">E</div>`,
    className: '',
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -20],
  });
}

// ?? FitRoute: auto-zoom map to polyline bounds ????????????????????????????????
function FitRoute({ route }) {
  const map = useMap();
  useEffect(() => {
    if (route.length > 1) {
      map.fitBounds(L.latLngBounds(route), { padding: [48, 48], maxZoom: 16 });
    } else if (route.length === 1) {
      map.setView(route[0], 14);
    }
  }, [route, map]);
  return null;
}

// ?? TripRouteMap ??????????????????????????????????????????????????????????????
function TripRouteMap({ route }) {
  const center = route.length > 0 ? route[0] : [14.5995, 121.0000];
  const startPt = route.length > 0 ? route[0] : null;
  const endPt   = route.length > 1 ? route[route.length - 1] : null;

  return (
    <MapContainer center={center} zoom={13} className="w-full h-full" style={{ minHeight: '100%' }}>
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution="? OpenStreetMap contributors"
        maxZoom={19}
      />
      <FitRoute route={route} />

      {route.length > 1 && (
        <>
          {}
          <Polyline positions={route} pathOptions={{ color: '#ffffff', weight: 8, opacity: 0.6 }} />
          {}
          <Polyline positions={route} pathOptions={{ color: '#06b6d4', weight: 5, opacity: 0.95 }} />
        </>
      )}

      {startPt && (
        <Marker position={startPt} icon={createStartIcon()}>
          <Popup>
            <div style={{ fontWeight: 600, fontSize: 13 }}>Trip Start</div>
            <div style={{ fontSize: 11, color: '#64748b' }}>
              {startPt[0].toFixed(5)}, {startPt[1].toFixed(5)}
            </div>
          </Popup>
        </Marker>
      )}

      {endPt && (
        <Marker position={endPt} icon={createEndIcon()}>
          <Popup>
            <div style={{ fontWeight: 600, fontSize: 13 }}>Trip End</div>
            <div style={{ fontSize: 11, color: '#64748b' }}>
              {endPt[0].toFixed(5)}, {endPt[1].toFixed(5)}
            </div>
          </Popup>
        </Marker>
      )}
    </MapContainer>
  );
}

// ?? Detail sub-components ?????????????????????????????????????????????????????
function StatCard({ label, value, colorClass }) {
  return (
    <div className={`bg-gradient-to-br ${colorClass} rounded-xl p-4 text-white`}>
      <p className="text-2xl font-bold mb-1">{value}</p>
      <p className="text-xs opacity-90">{label}</p>
    </div>
  );
}

function DetailField({ label, value }) {
  return (
    <div>
      <dt className="text-xs text-slate-500 uppercase tracking-wide">{label}</dt>
      <dd className="font-medium text-slate-900 mt-0.5 break-all">{value}</dd>
    </div>
  );
}

// ?? Trip Detail View ??????????????????????????????????????????????????????????
function TripDetail({ trip, truckAvgKmPerL, onBack }) {
  const isActive = !trip.endTime || trip.tripStatus === 'active' || trip.tripStatus === 'paused';

  const avgFuel = trip.averageFuelLevel != null && Number.isFinite(safeNum(trip.averageFuelLevel))
    ? `${Math.round(safeNum(trip.averageFuelLevel))}%`
    : '--';
  const finalFuel = trip.finalFuelLevel != null && Number.isFinite(safeNum(trip.finalFuelLevel))
    ? `${Math.round(safeNum(trip.finalFuelLevel))}%`
    : '--';

  // polyline follows actual roads instead of straight-lining between fixes.
  const { data: rawRoute, loading: routeLoading } = useApi(
    trip.tripId ? `/trips/${trip.tripId}/route?fill=1` : null,
    {
      transform: pts => ensureArray(pts)
        .filter(p => p.lat != null && p.lon != null)
        .map(p => [p.lat, p.lon]),
      pollInterval: isActive ? 10_000 : 60_000,
    },
  );
  const route = rawRoute ?? null;

  const { data: rawEvents, loading: eventsLoading, refreshing: eventsRefreshing } = useApi(
    trip.tripId ? `/trip-events?trip_id=${trip.tripId}` : null,
    { pollInterval: 10_000 },
  );
  // shows safety / ML events (anomaly, overspeeding, overtime) alongside
  // `event_type`, keeping a single render path downstream.
  const { data: rawTripAlerts } = useApi(
    trip.tripId ? `/alerts?trip_id=${trip.tripId}&limit=200` : null,
    { pollInterval: 10_000 },
  );
  const tripEvents = useMemo(() => {
    const events = rawEvents ?? [];
    const alerts = (rawTripAlerts ?? []).map((a) => ({
      id:         `alert-${a.id}`,
      event_type: a.alert_type,
      timestamp:  a.timestamp,
      message:    a.message ?? null,
      severity:   a.severity ?? null,
      _source:    'alert',
    }));
    return [...events, ...alerts];
  }, [rawEvents, rawTripAlerts]);

  const { data: rawLogs, loading: logsLoading, refreshing: logsRefreshing } = useApi(
    trip.truckId && trip.tripId
      ? `/trucks/${trip.truckId}/telemetry/history?trip_id=${trip.tripId}&limit=500`
      : null,
    { pollInterval: 10_000 },
  );
  const telemetryLogs = rawLogs ?? [];

  const syncing = eventsRefreshing || logsRefreshing;

  return (
    <div className="p-3 sm:p-4 lg:p-6 max-w-7xl mx-auto">
      {}
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800 mb-5 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Trips
      </button>

      {}
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-slate-900 mb-1">
            Trip - {trip.truckCode}
          </h1>
          <p className="text-sm text-slate-500">
            {trip.driverName} &nbsp;.&nbsp; {fmtDate(trip.startTime)} -> {fmtDate(trip.endTime, 'In progress')}
          </p>
        </div>
        {syncing && (
          <div className="flex items-center gap-1.5 text-xs text-slate-400 mt-1 shrink-0">
            <RefreshCw className="w-3 h-3 animate-spin" />
            Syncing...
          </div>
        )}
      </div>

      {}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard label="Distance" value={`${safeNum(trip.totalDistanceKm)} km`} colorClass="from-blue-500 to-blue-600" />
        <StatCard label="Duration"  value={fmtDuration(trip.startTime, trip.endTime)} colorClass="from-emerald-500 to-emerald-600" />
        <StatCard label="Alerts"    value={safeNum(trip.totalAlerts)}    colorClass="from-amber-500 to-amber-600" />
        <StatCard label="Anomalies" value={safeNum(trip.totalAnomalies)} colorClass="from-red-500 to-red-600" />
      </div>

      {}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden mb-4">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-2">
          <MapPin className="w-4 h-4 text-slate-500" />
          <span className="text-sm font-medium text-slate-900">Trip Route</span>
          <div className="ml-auto flex items-center gap-3 text-xs text-slate-500">
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-full border-2 border-white shadow" style={{ background: '#0891b2' }} />
              Start
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-full border-2 border-white shadow" style={{ background: '#0e7490' }} />
              End
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-8 h-1 rounded" style={{ background: '#06b6d4' }} />
              Route
            </span>
          </div>
        </div>
        <div className="h-96">
          {routeLoading ? (
            <div className="h-full flex items-center justify-center text-slate-400 text-sm gap-2">
              <RefreshCw className="w-5 h-5 animate-spin" />
              Loading route...
            </div>
          ) : route && route.length > 0 ? (
            <TripRouteMap route={route} />
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-slate-400 text-sm gap-2">
              <Route className="w-8 h-8 opacity-30" />
              No route data available for this trip.
            </div>
          )}
        </div>
      </div>

      {}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
      <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
          <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2">
            <Clock className="w-4 h-4 text-slate-400" />
            Trip Activity Log
          </h3>
          <div className="max-h-[480px] overflow-y-auto pr-1">
            {eventsLoading ? (
              <div className="flex items-center gap-2 text-slate-400 text-sm py-6 justify-center">
                <RefreshCw className="w-4 h-4 animate-spin" />
                Loading events...
              </div>
            ) : tripEvents.length === 0 ? (
              <div className="text-center py-6 text-slate-400">
                <Clock className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No events recorded for this trip</p>
              </div>
            ) : (() => {
              const chronological = [...tripEvents].sort((a, b) =>
                new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
              );
              const restBreaks = [];
              chronological.forEach((ev, idx) => {
                if (ev.event_type !== 'rest_started') return;
                const resumeEv = chronological.slice(idx + 1).find(e => e.event_type === 'trip_resumed');
                const startTs  = new Date(ev.timestamp);
                if (resumeEv) {
                  const endTs = new Date(resumeEv.timestamp);
                  restBreaks.push({ start: startTs, end: endTs, duration: fmtMs(endTs - startTs) });
                } else {
                  restBreaks.push({ start: startTs, end: null, duration: '--' });
                }
              });
              return (
                <div className="space-y-4">
                  {restBreaks.length > 0 && (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                      <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-2">
                        Rest Breaks - {restBreaks.length} total
                      </p>
                      <div className="space-y-2">
                        {restBreaks.map((rb, i) => (
                          <div key={i} className="flex items-start justify-between gap-4 text-xs">
                            <div className="flex items-center gap-2">
                              <span className="w-5 h-5 rounded-full bg-amber-400 text-white font-bold flex items-center justify-center text-[10px] flex-shrink-0">
                                {i + 1}
                              </span>
                              <div>
                                <p className="text-slate-700 font-medium">
                                  {format(rb.start, 'h:mm a')}
                                  {rb.end && <> -> {format(rb.end, 'h:mm a')}</>}
                                </p>
                                <p className="text-slate-500">{format(rb.start, 'MMM d, yyyy')}</p>
                              </div>
                            </div>
                            <span className="font-mono font-semibold text-amber-700 flex-shrink-0">{rb.duration}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="relative">
                    <div className="absolute left-3.5 top-0 bottom-0 w-px bg-slate-200" />
                    <div className="space-y-3">
                      {chronological.map((ev, idx) => {
                        const cfg = EVENT_LABELS[ev.event_type] ?? { label: ev.event_type, color: 'bg-slate-100 text-slate-700', dot: 'bg-slate-400' };
                        let restDuration = null;
                        if (ev.event_type === 'rest_started') {
                          const resumeEv = chronological.slice(idx + 1).find(e => e.event_type === 'trip_resumed');
                          if (resumeEv) restDuration = fmtMs(new Date(resumeEv.timestamp) - new Date(ev.timestamp));
                        }
                        return (
                          <div key={ev.id ?? idx} className="flex items-start gap-3 pl-1">
                            <div className={`w-6 h-6 rounded-full ${cfg.dot} flex-shrink-0 mt-0.5 z-10 flex items-center justify-center`}>
                              <div className="w-2 h-2 bg-white rounded-full" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cfg.color}`}>{cfg.label}</span>
                                <span className="text-xs text-slate-400">{format(new Date(ev.timestamp), 'MMM d, h:mm:ss a')}</span>
                              </div>
                              {restDuration && (
                                <p className="text-xs text-amber-600 mt-0.5 font-medium">Duration: {restDuration}</p>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })()}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
          <h3 className="text-sm font-semibold text-slate-900 mb-1 flex items-center gap-2">
            <Cpu className="w-4 h-4 text-slate-400" />
            Trip Logs
            {telemetryLogs.length > 0 && (
              <span className="ml-auto text-xs font-normal text-slate-400">{telemetryLogs.length} records</span>
            )}
          </h3>
          <p className="text-xs text-slate-400 mb-3">Fuel . Speed . GPS . Engine status . Anomalies</p>
          <div className="max-h-[480px] overflow-y-auto pr-1">
            {logsLoading ? (
              <div className="flex items-center gap-2 text-slate-400 text-sm py-6 justify-center">
                <RefreshCw className="w-4 h-4 animate-spin" />
                Loading logs...
              </div>
            ) : telemetryLogs.length === 0 ? (
              <div className="text-center py-6 text-slate-400">
                <Cpu className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No telemetry logs for this trip</p>
              </div>
            ) : (
              <div className="space-y-2">
                {telemetryLogs.map((log, idx) => {
                  const hasGps    = log.lat != null && log.lon != null;
                  const isAnomaly = log.anomaly_flag === true;
                  const isIdle    = log.engine_status === 'idle';
                  return (
                    <div
                      key={log.id ?? idx}
                      className={`rounded-lg border px-3 py-2.5 text-xs ${
                        isAnomaly
                          ? 'border-red-200 bg-red-50'
                          : isIdle
                          ? 'border-amber-100 bg-amber-50'
                          : 'border-slate-100 bg-slate-50'
                      }`}
                    >
                      {}
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <span className="text-slate-500 font-mono">
                          {format(new Date(log.timestamp), 'MMM d, h:mm:ss a')}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${
                            isIdle ? 'bg-amber-200 text-amber-800' : 'bg-green-100 text-green-700'
                          }`}>
                            {log.engine_status ?? 'on'}
                          </span>
                          {isAnomaly && (
                            <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-red-200 text-red-800 text-[10px] font-semibold uppercase">
                              <AlertCircle className="w-2.5 h-2.5" />
                              Anomaly
                            </span>
                          )}
                        </div>
                      </div>
                      {}
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-slate-600">
                        <span className="flex items-center gap-1">
                          <Fuel className="w-3 h-3 text-slate-400 flex-shrink-0" />
                          Fuel: <span className="font-medium ml-0.5">{log.fuel_level != null
                            ? (log.fuel_level_l != null
                                ? `${log.fuel_level}% (${Number(log.fuel_level_l).toFixed(1)} L)`
                                : `${log.fuel_level}%`)
                            : '-'}</span>
                        </span>
                        <span className="flex items-center gap-1">
                          <Gauge className="w-3 h-3 text-slate-400 flex-shrink-0" />
                          Speed: <span className="font-medium ml-0.5">{log.speed != null ? `${log.speed} km/h` : '-'}</span>
                        </span>
                        <span className="flex items-center gap-1">
                          <Navigation className="w-3 h-3 text-slate-400 flex-shrink-0" />
                          {hasGps
                            ? <span className="font-medium ml-0.5 font-mono">{log.lat.toFixed(4)}, {log.lon.toFixed(4)}</span>
                            : <span className="text-slate-400 ml-0.5">No GPS</span>
                          }
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
      </div>
      </div>

      {}
      <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
        <h3 className="text-sm font-semibold text-slate-900 mb-4">Trip Details</h3>
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-8 gap-y-4 text-sm">
          <DetailField label="Trip ID"      value={trip.tripId || '--'} />
          <DetailField label="Truck"        value={trip.truckCode || '--'} />
          <DetailField label="Plate"        value={trip.plateNumber || '--'} />
          <DetailField label="Driver"       value={trip.driverName || '--'} />
          <DetailField label="Start Time"   value={fmtDate(trip.startTime)} />
          <DetailField label="End Time"     value={fmtDate(trip.endTime, 'In progress')} />
          <DetailField label="Op. Hours"    value={`${safeNum(trip.totalOperatingHours)} h`} />
          <DetailField label="Avg Fuel"     value={avgFuel} />
          <DetailField label="Final Fuel"   value={finalFuel} />
          <DetailField label="Avg Economy"  value={truckAvgKmPerL != null ? `${truckAvgKmPerL} km/L` : '--'} />
          <DetailField label="Log Count"    value={safeNum(trip.logCount)} />
          <DetailField label="Status"       value={trip.tripStatus || '--'} />
        </dl>
      </div>
    </div>
  );
}

// ?? Main Trips Page ???????????????????????????????????????????????????????????
export default function Trips() {
  const [period, setPeriod]             = useState('90');
  const [truckId, setTruckId]           = useState('all');
  const [driverSearch, setDriverSearch] = useState('');
  const [selectedTrip, setSelectedTrip] = useState(null);

  const summariesApi = useApi(buildSummaryPath(period, truckId), {
    transform: payload => {
      const p = payload && typeof payload === 'object' ? payload : {};
      return ensureArray(p.items)
        .filter(row => row?.trip_status !== 'discarded')
        .map(normalizeTripSummary);
    },
    pollInterval: 30_000,
  });

  const fleetApi = useApi('/fleet/status', {
    transform: d => ensureArray(d?.trucks ?? d).map(normalizeTruck),
  });

  const summaries = ensureArray(summariesApi.data);
  const fleet     = ensureArray(fleetApi.data);
  const loading   = summariesApi.loading || fleetApi.loading;

  // truck lifetime figure is a reasonable comparable and needs no schema
  const avgKmPerLByTruckId = useMemo(() => {
    const map = {};
    for (const t of fleet) if (t?.id != null) map[t.id] = t.avgKmPerL;
    return map;
  }, [fleet]);

  const truckOptions = useMemo(() => (
    [...fleet]
      .sort((a, b) => String(a.code ?? '').localeCompare(String(b.code ?? '')))
      .map(t => ({ id: t.id, label: t.code ?? 'Unknown' }))
  ), [fleet]);

  // Client-side driver filter
  const filtered = useMemo(() => {
    if (!driverSearch.trim()) return summaries;
    const q = driverSearch.toLowerCase();
    return summaries.filter(s => (s.driverName ?? '').toLowerCase().includes(q));
  }, [summaries, driverSearch]);

  useEffect(() => {
    if (!selectedTrip || !summaries.length) return;
    const updated = summaries.find(s => s.tripId === selectedTrip.tripId);
    if (updated) setSelectedTrip(updated);
  }, [summaries]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRefresh = () => {
    summariesApi.refetch?.();
    fleetApi.refetch?.();
  };

  // ?? Detail view ??????????????????????????????????????????????????????????
  if (selectedTrip) {
    return (
      <TripDetail
        trip={selectedTrip}
        truckAvgKmPerL={avgKmPerLByTruckId[selectedTrip.truckId] ?? null}
        onBack={() => setSelectedTrip(null)}
      />
    );
  }

  // ?? List view ?????????????????????????????????????????????????????????????
  return (
    <div className="p-3 sm:p-4 lg:p-6 max-w-7xl mx-auto">

      {}
      <div className="mb-6 flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-slate-900 mb-1">Trip History</h1>
          <p className="text-sm text-slate-500">
            Browse completed trips, inspect routes, and review per-trip data.
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={loading}
          className="p-2 rounded-lg hover:bg-slate-100 transition-colors disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw className={`w-4 h-4 text-slate-500 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {}
      <div className="flex flex-wrap gap-2 mb-4">
        <select
          value={period}
          onChange={e => setPeriod(e.target.value)}
          className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={180}>Last 180 days</option>
          <option value={365}>Last 365 days</option>
          <option value="all">All history</option>
        </select>

        <select
          value={truckId}
          onChange={e => setTruckId(e.target.value)}
          className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
        >
          <option value="all">All Trucks</option>
          {truckOptions.map(opt => (
            <option key={opt.id} value={opt.id}>{opt.label}</option>
          ))}
        </select>

        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-slate-400 pointer-events-none" />
          <input
            type="text"
            placeholder="Filter by driver..."
            value={driverSearch}
            onChange={e => setDriverSearch(e.target.value)}
            className="pl-8 pr-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-48 bg-white"
          />
        </div>
      </div>

      {}
      {summariesApi.error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {summariesApi.error}
        </div>
      )}

      {}
      {!loading && (
        <p className="text-xs text-slate-500 mb-3">
          {filtered.length === 0
            ? 'No trips found'
            : `${filtered.length} trip${filtered.length !== 1 ? 's' : ''} found`}
        </p>
      )}

      {}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                {['Truck', 'Driver', 'Start', 'End', 'Duration', 'Distance', 'Avg Fuel', 'Avg Economy', 'Alerts', 'Anomalies', ''].map(h => (
                  <th
                    key={h}
                    className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={11} className="px-4 py-12 text-center text-slate-400">
                    <RefreshCw className="w-6 h-6 mx-auto mb-2 animate-spin opacity-40" />
                    Loading trips...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-4 py-12 text-center">
                    <div className="flex flex-col items-center gap-2 text-slate-400">
                      <Route className="w-8 h-8 opacity-30" />
                      <span className="text-sm">
                        {summaries.length === 0
                          ? 'No completed trips found for this history range.'
                          : 'No trips match the current driver filter.'}
                      </span>
                    </div>
                  </td>
                </tr>
              ) : (
                filtered.map(trip => {
                  const alerts    = safeNum(trip.totalAlerts);
                  const anomalies = safeNum(trip.totalAnomalies);
                  const avgFuel   = trip.averageFuelLevel != null && Number.isFinite(safeNum(trip.averageFuelLevel))
                    ? `${Math.round(safeNum(trip.averageFuelLevel))}%`
                    : '--';

                  return (
                    <tr
                      key={trip.id ?? trip.tripId}
                      className="hover:bg-blue-50 cursor-pointer transition-colors"
                      onClick={() => setSelectedTrip(trip)}
                    >
                      <td className="px-4 py-3 whitespace-nowrap font-medium text-slate-900">
                        {trip.truckCode}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-700">{trip.driverName}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-600 text-xs">
                        {fmtDate(trip.startTime, 'Unknown')}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-600 text-xs">
                        {fmtDate(trip.endTime, 'In progress')}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-700">
                        {fmtDuration(trip.startTime, trip.endTime)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-700">
                        {safeNum(trip.totalDistanceKm)} km
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-700">{avgFuel}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-700">{avgKmPerLByTruckId[trip.truckId] != null ? `${avgKmPerLByTruckId[trip.truckId]} km/L` : '--'}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                          alerts > 0 ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'
                        }`}>
                          {alerts}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                          anomalies > 0 ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-500'
                        }`}>
                          {anomalies}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-400">
                        <ChevronRight className="w-4 h-4" />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
