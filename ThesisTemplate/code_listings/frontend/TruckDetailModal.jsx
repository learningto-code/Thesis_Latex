import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Fuel, Activity, Route, Clock, AlertTriangle, Navigation, RefreshCw, ShieldAlert, Play, Pause, Wifi, Loader2, Timer } from 'lucide-react';
import { format } from 'date-fns';
import FleetMap from './FleetMap';
import { normalizeAlert, normalizeLog, apiFetch } from '../utils/api';
import { useApi } from '../hooks/useApi';
import { getStatusColor, getStatusLabel } from '../utils/statusColors';

function getDashUser() {
  try { return JSON.parse(localStorage.getItem('fleet_user')); }
  catch { return null; }
}

function deviceConnectivity(truck) {
  // Only show during an active or paused trip - matches Dashboard.jsx guard.
  if (truck.tripStatus !== 'active' && truck.tripStatus !== 'paused') return null;
  if (!truck.deviceLastSeen) return null;
  const ageSec = (Date.now() - new Date(truck.deviceLastSeen).getTime()) / 1000;
  if (ageSec < 60)  return 'connected';
  if (ageSec < 180) return 'unstable';
  return 'offline';
}

const CONN_UI = {
  connected: { icon: Wifi,    color: 'text-green-600',  bg: 'bg-green-50 border-green-200',               label: 'Device Connected',    spin: false },
  unstable:  { icon: Loader2, color: 'text-yellow-600', bg: 'bg-yellow-50 border-yellow-200',             label: 'Device Connecting',   spin: true  },
  offline:   { icon: Loader2, color: 'text-red-600',    bg: 'bg-red-50 border-red-200',                   label: 'Device Reconnecting', spin: true  },
};


function fmtHM(hours) {
  if (hours == null || isNaN(hours)) return '-';
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}


function fmtMs(ms) {
  if (ms == null || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2,'0')}m ${String(sec).padStart(2,'0')}s`;
  return `${String(m).padStart(2,'0')}m ${String(sec).padStart(2,'0')}s`;
}


function drivingMs(truck, nowTs) {
  const hmiSec = Number(truck.hmiDrivingSeconds);
  if (Number.isFinite(hmiSec) && hmiSec >= 0) {
    const clockAt = truck.hmiClockAt ? new Date(truck.hmiClockAt).getTime() : NaN;
    const ageSec = Number.isFinite(clockAt) ? Math.max(0, (nowTs - clockAt) / 1000) : 0;
    const ticking = truck.tripStatus === 'active' && truck.hmiTripStatus !== 'paused';
    // authoritative trip status still stops the clock during rest or after end.
    return (hmiSec + (ticking ? ageSec : 0)) * 1000;
  }
  if (!truck.tripStartTime) return 0;
  const elapsed      = nowTs - new Date(truck.tripStartTime).getTime();
  const prevRestMs   = (truck.totalRestSeconds ?? 0) * 1000;
  const curRestMs    = (truck.tripStatus === 'paused' && truck.pausedAt)
    ? nowTs - new Date(truck.pausedAt).getTime()
    : 0;
  return Math.max(0, elapsed - prevRestMs - curRestMs);
}


function currentRestMs(truck, nowTs) {
  if (truck.tripStatus !== 'paused' || !truck.pausedAt) return null;
  return Math.max(0, nowTs - new Date(truck.pausedAt).getTime());
}

const EVENT_LABELS = {
  trip_started: { label: 'Trip Started',    color: 'bg-green-100 text-green-700',  dot: 'bg-green-500' },
  rest_started: { label: 'Rest Break',       color: 'bg-amber-100 text-amber-700',  dot: 'bg-amber-500' },
  trip_resumed: { label: 'Resumed Driving',  color: 'bg-blue-100 text-blue-700',    dot: 'bg-blue-500'  },
  rest_snoozed: { label: 'Snoozed (10 min)', color: 'bg-purple-100 text-purple-700', dot: 'bg-purple-400' },
  trip_ended:   { label: 'Trip Ended',       color: 'bg-slate-100 text-slate-700',  dot: 'bg-slate-400' },
  // Alerts surfaced into the activity stream so the timeline mirrors the
  fuel_anomaly: { label: 'Fuel Anomaly',     color: 'bg-rose-100 text-rose-700',    dot: 'bg-rose-500' },
  maintenance:  { label: 'Maintenance Due',  color: 'bg-orange-100 text-orange-700', dot: 'bg-orange-500' },
  rest_alert:   { label: 'Rest Required',    color: 'bg-yellow-100 text-yellow-700', dot: 'bg-yellow-500' },
  overspeed:    { label: 'Overspeeding',     color: 'bg-red-100 text-red-700',      dot: 'bg-red-500' },
  low_fuel:     { label: 'Low Fuel',         color: 'bg-orange-100 text-orange-700', dot: 'bg-orange-500' },
};

function ModalRestCountdown({ nextRestAlertAt }) {
  const [secLeft, setSecLeft] = useState(null);
  useEffect(() => {
    if (!nextRestAlertAt) { setSecLeft(null); return; }
    const tick = () => setSecLeft(Math.round((new Date(nextRestAlertAt).getTime() - Date.now()) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [nextRestAlertAt]);

  if (secLeft === null) return null;

  if (secLeft <= 0) {
    return (
      <p className="col-span-2 flex items-center gap-1.5 text-red-600 font-medium">
        <AlertTriangle className="w-3.5 h-3.5" />
        Rest break overdue
      </p>
    );
  }

  const h = Math.floor(secLeft / 3600);
  const m = Math.floor((secLeft % 3600) / 60);
  const s = secLeft % 60;
  const label = h > 0
    ? `${h}h ${String(m).padStart(2,'0')}m`
    : `${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`;
  const urgent = secLeft < 1800;

  return (
    <p className={`col-span-2 flex items-center gap-1.5 font-medium ${urgent ? 'text-amber-600' : 'text-slate-600'}`}>
      <Timer className={`w-3.5 h-3.5 ${urgent ? 'text-amber-500' : 'text-slate-400'}`} />
      Next rest alert in <span className="font-mono ml-1">{label}</span>
    </p>
  );
}

function Tab({ label, active, onClick, count }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm font-medium rounded-lg transition-colors whitespace-nowrap flex-shrink-0 ${
        active ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'
      }`}
    >
      {label}{count != null ? ` (${count})` : ''}
    </button>
  );
}

export default function TruckDetailModal({ truck, onClose }) {
  const [activeTab,    setActiveTab]    = useState('map');
  const [nowTs,        setNowTs]        = useState(Date.now());
  const [forceEnding,  setForceEnding]  = useState(false);
  const [forceConfirm, setForceConfirm] = useState(false);

  const dashUser    = getDashUser();
  const isHeadAdmin = dashUser?.role === 'head_admin';

  async function handleForceEnd() {
    if (!truck.tripId) return;
    setForceEnding(true);
    try {
      await apiFetch('/trip/force-end', {
        method: 'POST',
        body: JSON.stringify({ trip_id: truck.tripId }),
      });
      onClose();
    } catch (err) {
      alert(`Force end failed: ${err.message}`);
    } finally {
      setForceEnding(false);
      setForceConfirm(false);
    }
  }

  const { data: rawAlerts, loading: alertsLoading } = useApi(
    truck.tripId ? `/alerts?trip_id=${truck.tripId}` : null,
    { transform: arr => arr.map(normalizeAlert), pollInterval: 5_000 },
  );

  const { data: rawLogs, loading: logsLoading, refreshing: logsRefreshing } = useApi(
    truck.tripId ? `/trucks/${truck.id}/telemetry/history?trip_id=${truck.tripId}&limit=100` : null,
    { transform: arr => arr.map(normalizeLog), pollInterval: 3_000 },
  );

  const { data: rawEvents, loading: eventsLoading, refreshing: eventsRefreshing } = useApi(
    truck.tripId ? `/trip-events?trip_id=${truck.tripId}` : null,
    { pollInterval: 3_000 },
  );

  const truckAlerts  = rawAlerts  ?? [];
  const truckLogs    = rawLogs    ?? [];
  // events (fuel anomaly, overspeed, rest required) alongside driver actions.
  const tripEvents = useMemo(() => {
    const events = rawEvents ?? [];
    const alerts = (rawAlerts ?? []).map((a) => ({
      id:         `alert-${a.id}`,
      event_type: a.type ?? a.alert_type,
      timestamp:  a.timestamp,
      message:    a.message ?? null,
      severity:   a.severity ?? null,
      _source:    'alert',
    }));
    return [...events, ...alerts];
  }, [rawEvents, rawAlerts]);
  const liveTripActive = truck.tripStatus === 'active' || truck.tripStatus === 'paused';

  const liveOperatingHours = liveTripActive && truck.tripStartTime
    ? (nowTs - new Date(truck.tripStartTime).getTime()) / 3_600_000
    : truck.operatingHours;

  useEffect(() => {
    if (!liveTripActive || !truck.tripStartTime) return;
    setNowTs(Date.now());
    const id = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [liveTripActive, truck.tripStartTime]);

  return createPortal(
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4" style={{ zIndex: 9999 }}>
      <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full max-w-5xl max-h-[92vh] sm:max-h-[90vh] flex flex-col overflow-hidden">
        {}
        <div className="flex items-start justify-between p-3 sm:p-6 border-b border-slate-200 flex-shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-0.5 flex-wrap">
              <h2 className="text-base sm:text-2xl font-semibold text-slate-900">{truck.name}</h2>
              <span className={`px-2 py-0.5 rounded-full text-xs text-white font-medium ${getStatusColor(truck.status)}`}>
                {getStatusLabel(truck.status)}
              </span>
              {(() => {
                const conn = deviceConnectivity(truck);
                if (!conn) return null;
                const ui = CONN_UI[conn];
                return (
                  <span className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${ui.bg} ${ui.color}`}>
                    <ui.icon className={`w-3 h-3 ${ui.spin ? 'animate-spin' : ''}`} />
                    <span className="hidden sm:inline">{ui.label}</span>
                  </span>
                );
              })()}
            </div>
            <p className="text-xs sm:text-sm text-slate-500 truncate">{truck.driver} * {truck.code}</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg transition-colors ml-2 flex-shrink-0">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        {}
        <div className="flex-shrink-0 px-3 sm:px-6 pt-3 sm:pt-6">
          {}
          <div className="grid grid-cols-4 gap-1.5 sm:gap-3 mb-3 sm:mb-5">
            <div className="bg-blue-50 rounded-lg sm:rounded-xl p-2 sm:p-4">
              <div className="flex items-center gap-1 sm:gap-2 mb-1 sm:mb-2">
                <Fuel className="w-3 h-3 sm:w-4 sm:h-4 text-blue-600 flex-shrink-0" />
                <span className="text-[10px] sm:text-xs text-blue-700 font-medium truncate">Fuel</span>
              </div>
              <p className="text-base sm:text-2xl font-semibold text-blue-600">{truck.fuel != null ? `${truck.fuel}%` : '-'}</p>
              {truck.fuel != null && truck.tankCapacityL && (
                <p className="text-[10px] sm:text-xs text-blue-500 font-medium">
                  {(truck.fuel * truck.tankCapacityL / 100).toFixed(1)} L / {truck.tankCapacityL} L
                </p>
              )}
              <div className="bg-blue-200 rounded-full h-1 mt-1 sm:mt-2">
                <div className="bg-blue-600 h-1 rounded-full" style={{ width: `${truck.fuel ?? 0}%` }} />
              </div>
            </div>
            <div className="bg-green-50 rounded-lg sm:rounded-xl p-2 sm:p-4">
              <div className="flex items-center gap-1 sm:gap-2 mb-1 sm:mb-2">
                <Activity className="w-3 h-3 sm:w-4 sm:h-4 text-green-600 flex-shrink-0" />
                <span className="text-[10px] sm:text-xs text-green-700 font-medium truncate">Speed</span>
              </div>
              <p className="text-base sm:text-2xl font-semibold text-green-600">{truck.speed}</p>
              <p className="text-[10px] sm:text-xs text-green-600 mt-0.5 sm:mt-1">km/h</p>
            </div>
            <div className="bg-purple-50 rounded-lg sm:rounded-xl p-2 sm:p-4">
              <div className="flex items-center gap-1 sm:gap-2 mb-1 sm:mb-2">
                <Route className="w-3 h-3 sm:w-4 sm:h-4 text-purple-600 flex-shrink-0" />
                <span className="text-[10px] sm:text-xs text-purple-700 font-medium truncate">Dist.</span>
              </div>
              <p className="text-base sm:text-2xl font-semibold text-purple-600">{truck.distance}</p>
              <p className="text-[10px] sm:text-xs text-purple-600 mt-0.5 sm:mt-1">km</p>
            </div>
            <div className="bg-orange-50 rounded-lg sm:rounded-xl p-2 sm:p-4">
              <div className="flex items-center gap-1 sm:gap-2 mb-1 sm:mb-2">
                <Clock className="w-3 h-3 sm:w-4 sm:h-4 text-orange-600 flex-shrink-0" />
                <span className="text-[10px] sm:text-xs text-orange-700 font-medium truncate">Hours</span>
              </div>
              <p className="text-base sm:text-2xl font-semibold text-orange-600">{fmtHM(liveOperatingHours)}</p>
              <p className="text-[10px] sm:text-xs text-orange-600 mt-0.5 sm:mt-1">this trip</p>
            </div>
          </div>

          {}
          {(truck.tripStatus === 'active' || truck.tripStatus === 'paused') && truck.tripStartTime && (
            <div className={`rounded-xl p-2.5 sm:p-4 mb-2.5 sm:mb-5 text-xs sm:text-sm ${truck.tripStatus === 'paused' ? 'bg-amber-50' : 'bg-slate-50'}`}>
              <div className="flex items-center justify-between mb-2">
                <p className="font-medium text-slate-900">Current Trip</p>
                <div className="flex items-center gap-2">
                  {truck.tripStatus === 'paused' && (
                    <span className="px-2 py-0.5 bg-amber-100 text-amber-700 text-xs rounded-full font-medium">Driver Resting</span>
                  )}
                  {isHeadAdmin && (
                    forceConfirm ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-red-600 font-medium">Confirm?</span>
                        <button
                          onClick={handleForceEnd}
                          disabled={forceEnding}
                          className="px-2 py-0.5 bg-red-600 text-white text-xs rounded font-medium hover:bg-red-700 disabled:opacity-50"
                        >
                          {forceEnding ? 'Ending...' : 'Yes, Force End'}
                        </button>
                        <button
                          onClick={() => setForceConfirm(false)}
                          className="px-2 py-0.5 bg-slate-200 text-slate-700 text-xs rounded font-medium hover:bg-slate-300"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setForceConfirm(true)}
                        className="flex items-center gap-1 px-2 py-0.5 bg-red-50 text-red-600 border border-red-200 text-xs rounded-lg font-medium hover:bg-red-100 transition-colors"
                        title="Force end this trip (head admin only)"
                      >
                        <ShieldAlert className="w-3 h-3" />
                        Force End
                      </button>
                    )
                  )}
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-slate-600">
                <p>Started: <span className="text-slate-900">{format(new Date(truck.tripStartTime), 'MMM d, h:mm a')}</span></p>
                <p>
                  Driving Time:{' '}
                  <span className="text-slate-900 font-mono">{fmtMs(drivingMs(truck, nowTs))}</span>
                  {truck.tripStatus === 'active' && <Play className="ml-1 w-3 h-3 inline text-green-600" />}
                  {truck.tripStatus === 'paused' && <Pause className="ml-1 w-3 h-3 inline text-amber-500" />}
                </p>
                {truck.tripStatus === 'paused' && (
                  <p>
                    Rest Time:{' '}
                    <span className="text-amber-700 font-mono">{fmtMs(currentRestMs(truck, nowTs))}</span>
                    <Play className="ml-1 w-3 h-3 inline text-amber-500" />
                  </p>
                )}
                <p>Distance: <span className="text-slate-900">{truck.distance} km</span></p>
                <p>
                  Mileage:{' '}
                  <span className="text-slate-900">
                    {truck.mileage != null ? `${Number(truck.mileage).toLocaleString()} km` : '--'}
                  </span>
                </p>
                <p>
                  Maintenance:{' '}
                  <span className={truck.maintenanceKmRemaining === 0 ? 'text-orange-700 font-medium' : 'text-slate-900'}>
                    {truck.maintenanceKmRemaining != null
                      ? truck.maintenanceKmRemaining === 0
                        ? 'Due now'
                        : `${Number(truck.maintenanceKmRemaining).toLocaleString()} km remaining`
                      : '--'}
                  </span>
                </p>
                <p>Location: <span className={truck.hasGps ? 'text-slate-900' : 'text-slate-400 italic'}>
                  {truck.hasGps ? `${truck.position[0].toFixed(4)}, ${truck.position[1].toFixed(4)}` : 'No GPS data'}
                </span></p>
                {truck.tripStatus === 'active' && truck.nextRestAlertAt && (
                  <ModalRestCountdown nextRestAlertAt={truck.nextRestAlertAt} />
                )}
              </div>
            </div>
          )}

          {}
          <div className="flex gap-1 sm:gap-2 border-b border-slate-100 pb-2 sm:pb-3 overflow-x-auto scrollbar-none">
            <Tab label="Map"       active={activeTab === 'map'}      onClick={() => setActiveTab('map')} />
            <Tab label="Live"      active={activeTab === 'live'}     onClick={() => setActiveTab('live')} />
            <Tab label="Activity"  active={activeTab === 'activity'} onClick={() => setActiveTab('activity')}
              count={eventsLoading ? null : tripEvents.length} />
            <Tab label="Alerts"    active={activeTab === 'alerts'}   onClick={() => setActiveTab('alerts')} />
            <Tab label="Logs"      active={activeTab === 'logs'}     onClick={() => setActiveTab('logs')} />
          </div>
        </div>

        {}
        <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-3 sm:py-4">
          {activeTab === 'map' && (
            <div className="h-80 sm:h-96 rounded-xl overflow-hidden border border-slate-200">
              <FleetMap trucks={[truck]} selectedTruckId={truck.id} singleTruck />
            </div>
          )}

          {activeTab === 'live' && (
            <div className="bg-slate-50 rounded-xl p-4">
              <p className="font-medium text-slate-900 mb-3 text-sm">Real-time Telemetry</p>
              <div className="grid grid-cols-2 gap-3 text-sm">
                {[
                  ['Latitude',    truck.hasGps ? truck.position[0].toFixed(6) : '-'],
                  ['Longitude',   truck.hasGps ? truck.position[1].toFixed(6) : '-'],
                  ['Speed',       `${truck.speed} km/h`],
                  ['Fuel',        truck.fuel != null
                                    ? (truck.tankCapacityL
                                        ? `${truck.fuel}% (${(truck.fuel * truck.tankCapacityL / 100).toFixed(1)} L)`
                                        : `${truck.fuel}%`)
                                    : '-'],
                  ['Tank capacity', truck.tankCapacityL != null ? `${truck.tankCapacityL} L` : '-'],
                  ['Mileage',     truck.mileage != null ? `${Number(truck.mileage).toLocaleString()} km` : '--'],
                  ['Maint. Left',  truck.maintenanceKmRemaining != null ? `${Number(truck.maintenanceKmRemaining).toLocaleString()} km` : '--'],
                  ['Trip Status', truck.tripStatus],
                  ['Last Update', format(new Date(truck.lastUpdate), 'h:mm a')],
                ].map(([label, value]) => (
                  <div key={label}>
                    <span className="text-slate-500">{label}:</span>
                    <span className="ml-2 text-slate-900 capitalize">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'activity' && (
            <div className="space-y-4">
              {}
              {eventsRefreshing && (
                <div className="flex items-center gap-1.5 text-xs text-slate-400">
                  <RefreshCw className="w-3 h-3 animate-spin" />
                  Updating...
                </div>
              )}
              {eventsLoading ? (
                <div className="text-center py-10 text-slate-400">
                  <RefreshCw className="w-8 h-8 mx-auto mb-2 animate-spin opacity-40" />
                  <p className="text-sm">Loading activity...</p>
                </div>
              ) : tripEvents.length === 0 ? (
                <div className="text-center py-10 text-slate-400">
                  <Clock className="w-10 h-10 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">No trip events recorded yet</p>
                </div>
              ) : (() => {
                // Events come newest-first from API - reverse for chronological display
                const chronological = [...tripEvents].sort((a, b) =>
                  new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
                );

                // Build rest breaks list by pairing rest_started -> trip_resumed
                const restBreaks = [];
                chronological.forEach((ev, idx) => {
                  if (ev.event_type !== 'rest_started') return;
                  const resumeEv = chronological.slice(idx + 1).find(e => e.event_type === 'trip_resumed');
                  const startTs  = new Date(ev.timestamp);
                  if (resumeEv) {
                    const endTs = new Date(resumeEv.timestamp);
                    restBreaks.push({ start: startTs, end: endTs, duration: fmtMs(endTs - startTs), ongoing: false });
                  } else {
                    restBreaks.push({ start: startTs, end: null, duration: null, ongoing: true });
                  }
                });

                return (
                  <>
                    {}
                    {restBreaks.length > 0 && (
                      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                        <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-3">
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
                                    {rb.ongoing && <span className="ml-1 text-amber-600">-> ongoing</span>}
                                  </p>
                                  <p className="text-slate-500">{format(rb.start, 'MMM d')}</p>
                                </div>
                              </div>
                              <span className={`font-mono font-semibold flex-shrink-0 ${rb.ongoing ? 'text-amber-500' : 'text-amber-700'}`}>
                                {rb.ongoing
                                  ? fmtMs(Date.now() - rb.start.getTime())
                                  : rb.duration}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {}
                    <div className="relative">
                      <div className="absolute left-3.5 top-0 bottom-0 w-px bg-slate-200" />
                      <div className="space-y-3">
                        {chronological.map((ev, idx) => {
                          const cfg = EVENT_LABELS[ev.event_type] ?? { label: ev.event_type, color: 'bg-slate-100 text-slate-700', dot: 'bg-slate-400' };
                          let restDuration = null;
                          if (ev.event_type === 'rest_started') {
                            const resumeEv = chronological.slice(idx + 1).find(e => e.event_type === 'trip_resumed');
                            if (resumeEv) {
                              const ms = new Date(resumeEv.timestamp) - new Date(ev.timestamp);
                              restDuration = fmtMs(ms);
                            }
                          }
                          return (
                            <div key={ev.id} className="flex items-start gap-3 pl-1">
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
                                {ev.event_type === 'rest_started' && !chronological.slice(idx + 1).find(e => e.event_type === 'trip_resumed') && (
                                  <p className="text-xs text-amber-500 mt-0.5">Currently resting...</p>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>
          )}

          {activeTab === 'alerts' && (
            <div className="space-y-3">
              {alertsLoading ? (
                <div className="text-center py-10 text-slate-400">
                  <RefreshCw className="w-8 h-8 mx-auto mb-2 animate-spin opacity-40" />
                  <p className="text-sm">Loading alerts...</p>
                </div>
              ) : truckAlerts.length === 0 ? (
                <div className="text-center py-10 text-slate-400">
                  <AlertTriangle className="w-10 h-10 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">No alerts for this truck</p>
                </div>
              ) : truckAlerts.map((alert) => (
                <div
                  key={alert.id}
                  className={`border-l-4 rounded-xl p-4 ${
                    alert.severity === 'high'   ? 'bg-red-50 border-red-500' :
                    alert.severity === 'medium' ? 'bg-orange-50 border-orange-500' :
                                                  'bg-yellow-50 border-yellow-500'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
                    <span className={`text-xs font-semibold uppercase tracking-wide ${
                      alert.severity === 'high'   ? 'text-red-700' :
                      alert.severity === 'medium' ? 'text-orange-700' : 'text-yellow-700'
                    }`}>{alert.type}</span>
                    {alert.resolved && (
                      <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded-full">Resolved</span>
                    )}
                  </div>
                  <p className="text-sm text-slate-800 mb-1">{alert.message}</p>
                  <p className="text-xs text-slate-500">{format(new Date(alert.timestamp), 'MMM d, yyyy h:mm a')}</p>
                </div>
              ))}
            </div>
          )}

          {activeTab === 'logs' && (
            <div>
              {}
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-slate-500">
                  {truckLogs.length > 0 ? `${truckLogs.length} entries - newest first` : ''}
                </span>
                {logsRefreshing && (
                  <span className="flex items-center gap-1 text-xs text-slate-400">
                    <RefreshCw className="w-3 h-3 animate-spin" />
                    Updating...
                  </span>
                )}
              </div>

              {logsLoading ? (
                <div className="text-center py-10 text-slate-400">
                  <RefreshCw className="w-8 h-8 mx-auto mb-2 animate-spin opacity-40" />
                  <p className="text-sm">Loading telemetry...</p>
                </div>
              ) : truckLogs.length === 0 ? (
                <div className="text-center py-10 text-slate-400">
                  <Navigation className="w-10 h-10 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">No logs available</p>
                </div>
              ) : (
                <div className="rounded-xl border border-slate-200 overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
                      <tr>
                        <th className="px-3 py-2 text-left font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Time Sent</th>
                        <th className="px-3 py-2 text-right font-semibold text-slate-500 uppercase tracking-wider">Speed</th>
                        <th className="px-3 py-2 text-right font-semibold text-slate-500 uppercase tracking-wider">Fuel</th>
                        <th className="px-3 py-2 text-right font-semibold text-slate-500 uppercase tracking-wider hidden sm:table-cell">Lat</th>
                        <th className="px-3 py-2 text-right font-semibold text-slate-500 uppercase tracking-wider hidden sm:table-cell">Lng</th>
                        <th className="px-3 py-2 text-center font-semibold text-slate-500 uppercase tracking-wider hidden sm:table-cell">GPS</th>
                        <th className="px-3 py-2 text-center font-semibold text-slate-500 uppercase tracking-wider">Flag</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {[...truckLogs].reverse().map((log, i) => (
                        <tr
                          key={log.id}
                          className={`${log.anomaly ? 'bg-red-50' : i % 2 === 0 ? 'bg-white' : 'bg-slate-50'} hover:bg-blue-50 transition-colors`}
                        >
                          <td className="px-3 py-2 whitespace-nowrap text-slate-700 font-medium">
                            {(() => {
                              const raw = log.sentAt ?? log.timestamp ?? log.receivedAt;
                              const d = raw ? new Date(raw) : null;
                              const valid = d && !isNaN(d.getTime());
                              return valid ? (
                                <>
                                  {format(d, 'h:mm:ss a')}
                                  <span className="text-slate-400 font-normal ml-1 hidden sm:inline">
                                    {format(d, 'MMM d')}
                                  </span>
                                </>
                              ) : <span className="text-slate-400">-</span>;
                            })()}
                          </td>
                          <td className="px-3 py-2 text-right text-slate-700 whitespace-nowrap">
                            <span className={log.speed > 0 ? 'text-green-700 font-medium' : 'text-slate-400'}>
                              {log.speed} km/h
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right text-slate-700 whitespace-nowrap">
                            {log.fuel != null ? (
                              <span className={log.fuel < 20 ? 'text-red-600 font-medium' : log.fuel < 40 ? 'text-amber-600' : 'text-slate-700'}>
                                {log.fuel}%
                                {(() => {
                                  // Prefer the device-pushed absolute reading when available
                                  const tankL = log.tankCapacityL ?? truck.tankCapacityL ?? null;
                                  const litres = log.fuelLevelL != null
                                                  ? log.fuelLevelL
                                                  : (tankL != null ? (log.fuel * tankL / 100) : null);
                                  return litres != null
                                    ? <span className="text-slate-400 ml-1 font-normal">({litres.toFixed(1)} L)</span>
                                    : null;
                                })()}
                              </span>
                            ) : (
                              <span className="text-slate-400">-</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right text-slate-500 font-mono hidden sm:table-cell whitespace-nowrap">
                            {log.latitude?.toFixed(5)}
                          </td>
                          <td className="px-3 py-2 text-right text-slate-500 font-mono hidden sm:table-cell whitespace-nowrap">
                            {log.longitude?.toFixed(5)}
                          </td>
                          <td className="px-3 py-2 text-center hidden sm:table-cell whitespace-nowrap">
                            {log.gpsSource === 'fused_mobile_fallback'
                              ? <span className="px-1.5 py-0.5 bg-cyan-100 text-cyan-700 rounded font-medium">Mobile</span>
                              : log.gpsSource === 'mobile_gps'
                                ? <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded font-medium">Mobile</span>
                                : log.gpsSource === 'embedded_gps'
                                  ? <span className="px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded font-medium">HMI</span>
                                  : <span className="text-slate-400">-</span>}
                          </td>
                          <td className="px-3 py-2 text-center">
                            {log.anomaly && (
                              <span className="px-1.5 py-0.5 bg-red-100 text-red-700 rounded font-medium">Anomaly</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
