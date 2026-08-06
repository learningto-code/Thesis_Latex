import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, ArrowUp, ArrowDown,
  ArrowUpLeft, ArrowUpRight, ArrowDownLeft, ArrowDownRight,
  RotateCw, RotateCcw, MapPin, Truck, Navigation,
  Fuel, Gauge, Timer, Radio, Plug2, Battery,
  AlertTriangle, AlertOctagon, Info,
  Pause, Play, Square,
} from 'lucide-react';
import {
  fetchTripStatus, fetchLatestTelemetry,
  pauseTrip, resumeTrip, endTrip, fetchRestrictedZones,
  requestPause, requestResume, requestEndTrip,
  checkHmiSession, postMobileGps, saveRoute, pushNavStep,
} from '../../utils/driverApi';
import { getDriverSession, setDriverSession } from './DriverApp';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
});

const ORS_KEY       = import.meta.env.VITE_ORS_KEY ?? '';
const ORS_URL       = 'https://api.openrouteservice.org/v2/directions/driving-hgv/geojson';
const ORS_AUTOCOMPLETE = 'https://api.openrouteservice.org/geocode/autocomplete';
const NOM           = 'https://nominatim.openstreetmap.org/search';
const OSRM_URL      = 'https://router.project-osrm.org/route/v1/driving';
const POLL_MS  = 5000;
// settings row (settings.thresholds.overspeed_kmh, currently 100 for
const OVERSPEED_KMH = 100;
const PH_BBOX = '116.87,4.59,126.60,21.12'; // lon_min,lat_min,lon_max,lat_max

// Fallback dimensions when truck has no data in DB
const DEFAULT_DIMS = { length: 12.0, width: 2.5, height: 4.0, weight: 20.0, axleload: 11.5, hazmat: false };

const PIN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="#4f8ef7" stroke="#2055b8" stroke-width="1.5"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3" fill="white" stroke="none"/></svg>';
const TRUCK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#F7F7F7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="background:#1565C0;border-radius:6px;padding:2px"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>';

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const ?1 = lat1 * Math.PI / 180, ?2 = lat2 * Math.PI / 180;
  const ?? = (lat2 - lat1) * Math.PI / 180, ?? = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(??/2)**2 + Math.cos(?1)*Math.cos(?2)*Math.sin(??/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function fmtTimer(ms) {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s/3600), Math.floor((s%3600)/60), s%60]
    .map(n => String(n).padStart(2,'0')).join(':');
}

function fmtDist(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m/1000).toFixed(1)} km`;
}

function fmtCountdown(ms) {
  if (ms <= 0) return '00:00';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
}

function computeRestCountdownMs(trip, now = Date.now()) {
  if (!trip?.next_rest_alert_at) return null;
  const alertAt = new Date(trip.next_rest_alert_at).getTime();
  if (!Number.isFinite(alertAt)) return null;
  return alertAt - now; // negative = overdue
}

function computeSnoozeCountdownMs(trip, now = Date.now()) {
  if (!trip?.snoozed_until) return null;
  const until = new Date(trip.snoozed_until).getTime();
  if (!Number.isFinite(until)) return null;
  const remaining = until - now;
  return remaining > 0 ? remaining : null;
}

function normalizeDriverAlert(alert) {
  const raw = alert?.alert_type ?? 'notice';
  const typeMap = {
    rest_required: 'rest_alert',
    rest_overdue: 'rest_alert',
    snooze: 'snooze_alert',
    snoozed: 'snooze_alert',
    admin_ended: 'force_ended',
    force_end: 'force_ended',
    offline: 'connectivity_offline',
    syncing: 'connectivity_syncing',
    gps_lost: 'gps_unavailable',
    obd_unavailable: 'obd_unavailable',
    fuel_unavailable: 'obd_fuel_unavailable',
    speed_unavailable: 'obd_speed_unavailable',
  };
  return {
    ...alert,
    alert_type: typeMap[raw] ?? raw,
    message: alert?.message ?? raw.replaceAll('_', ' '),
    timestamp: alert?.timestamp ?? alert?.created_at ?? null,
  };
}

function computeDrivingElapsedMs(trip, now = Date.now()) {
  if (!trip?.start_time) return 0;
  const startMs = new Date(trip.start_time).getTime();
  if (!Number.isFinite(startMs)) return 0;
  const totalRestMs = Number(trip.total_rest_seconds ?? 0) * 1000;
  const currentPauseMs = trip.trip_status === 'paused' && trip.paused_at
    ? Math.max(0, now - new Date(trip.paused_at).getTime())
    : 0;
  const endMs = trip.end_time ? new Date(trip.end_time).getTime() : now;
  return Math.max(0, endMs - startMs - totalRestMs - currentPauseMs);
}

function computeOperationElapsedMs(trip, now = Date.now()) {
  if (!trip?.start_time) return 0;
  const startMs = new Date(trip.start_time).getTime();
  if (!Number.isFinite(startMs)) return 0;
  const endMs = trip.end_time ? new Date(trip.end_time).getTime() : now;
  return Math.max(0, endMs - startMs);
}

function computeRestElapsedMs(trip, now = Date.now()) {
  if (!trip) return 0;
  const totalRestMs = Number(trip.total_rest_seconds ?? 0) * 1000;
  const currentPauseMs = trip.trip_status === 'paused' && trip.paused_at
    ? Math.max(0, now - new Date(trip.paused_at).getTime())
    : 0;
  return totalRestMs + currentPauseMs;
}

function hasUsableOrsKey() {
  return ORS_KEY && !/your_ors_api_key_here/i.test(ORS_KEY);
}

async function readApiError(res, provider) {
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {  }
  const providerMsg = data?.error?.message || data?.message || text;
  if (res.status === 401 || res.status === 403) return `${provider} API key rejected (${res.status})`;
  if (res.status === 429) return `${provider} rate limit reached`;
  if (res.status >= 500) return `${provider} service unavailable (${res.status})`;
  return providerMsg || `${provider} request failed (${res.status})`;
}

function describeNetworkError(error, provider) {
  if (!navigator.onLine) return 'Browser is offline';
  if (error?.name === 'AbortError') return `${provider} request timed out`;
  return `${provider} network/CORS request failed`;
}

// 6=Straight 7=EnterRoundabout 8=ExitRoundabout 9=UTurn 10=Goal 11=Depart
// 12=KeepLeft 13=KeepRight
function departHeadingType(instruction) {
  const t = (instruction ?? '').toLowerCase();
  if (t.includes('northeast') || t.includes('north-east')) return 5;  // ?
  if (t.includes('northwest') || t.includes('north-west')) return 4;  // ?
  if (t.includes('southeast') || t.includes('south-east')) return 20; // ? custom
  if (t.includes('southwest') || t.includes('south-west')) return 21; // ? custom
  if (t.includes('north'))  return 6;   // ?
  if (t.includes('east'))   return 1;   // ->
  if (t.includes('west'))   return 0;   // <-
  if (t.includes('south'))  return 22;  // ? custom
  return 6;
}
function turnIcon(type) {
  const sz = { size: 26, strokeWidth: 2.5 };
  const icons = {
    0:  <ArrowLeft {...sz} />,
    1:  <ArrowRight {...sz} />,
    2:  <ArrowLeft {...sz} />,
    3:  <ArrowRight {...sz} />,
    4:  <ArrowUpLeft {...sz} />,
    5:  <ArrowUpRight {...sz} />,
    6:  <ArrowUp {...sz} />,
    7:  <RotateCw {...sz} />,
    8:  <RotateCw {...sz} />,
    9:  <RotateCcw {...sz} />,
    10: <MapPin {...sz} />,
    11: <Navigation {...sz} />,
    12: <ArrowUpLeft {...sz} />,
    13: <ArrowUpRight {...sz} />,
    // custom depart-heading types
    20: <ArrowDownRight {...sz} />,  // SE ?
    21: <ArrowDownLeft {...sz} />,   // SW ?
    22: <ArrowDown {...sz} />,       // S ?
  };
  return icons[type] ?? <ArrowUp {...sz} />;
}

export default function DriverNav({ session, onLogout }) {
  const navigate = useNavigate();

  // Map refs
  const mapRef       = useRef(null);
  const mapObj       = useRef(null);
  const phoneMarkRef = useRef(null);
  const phoneAccRef  = useRef(null);
  const truckMarkRef = useRef(null);
  const phoneAnimRef = useRef(null);
  const truckAnimRef = useRef(null);
  const routePolyRef = useRef(null);
  const destMarkRef  = useRef(null);
  const zoneRefs     = useRef([]);
  const routeCoordsRef    = useRef([]);  // raw [lon,lat] pairs from ORS for step lookup
  const stepEndIdxRef     = useRef([]);  // coord index of each step's endpoint
  const destCoordRef      = useRef(null); // [lon, lat] of current destination for arrival detection
  const arrivedRef        = useRef(false); // hysteresis: true once within 50m of dest
  const offRouteRef       = useRef(false); // true while driver is >80m off-route
  const lastRerouteRef    = useRef(0);     // ms timestamp of last auto-reroute
  const geoWatchRef           = useRef(null);
  const timerRef              = useRef(null);
  const pollRef               = useRef(null);
  const debounceRef           = useRef(null);
  const endedRef              = useRef(false);
  const prevPhoneLocRef       = useRef(null);  // previous GPS fix for bearing calculation
  const headingRef            = useRef(null);
  const followModeRef         = useRef(true);  // mirrors followMode state for GPS closure
  const assignedRouteKeyRef   = useRef(null);  // tracks which assigned_destination has been applied
  const lastLiveNavPushRef    = useRef({ stepIdx: -1, dist: null, at: 0 });
  const lastMobileGpsPostRef  = useRef(0);

  const sess      = getDriverSession() ?? session;
  const tripId    = sess?.trip_id;
  const truckId   = sess?.truck_id;
  const truckCode = sess?.truck_code ?? 'Truck';
  const isHmiTrip = (sess?.trip_channel ?? 'gsm') !== 'mobile_app';
  const truckDims = sess?.truck_dims ?? DEFAULT_DIMS;

  function updateTripInSession(nextTrip) {
    if (!nextTrip) return;
    const current = getDriverSession();
    if (!current?.user_id) return;
    setDriverSession({
      ...current,
      trip_id: nextTrip.id ?? current.trip_id,
      truck_id: nextTrip.truck_id ?? current.truck_id,
      driver_id: nextTrip.driver_id ?? current.driver_id ?? current.user_id,
      truck_code: nextTrip.trucks?.truck_code ?? current.truck_code,
      trip_status: nextTrip.trip_status ?? current.trip_status,
      start_time: nextTrip.start_time ?? current.start_time,
      end_time: nextTrip.end_time ?? current.end_time ?? null,
      paused_at: nextTrip.paused_at ?? null,
      total_rest_seconds: nextTrip.total_rest_seconds ?? 0,
      next_rest_alert_at: nextTrip.next_rest_alert_at ?? null,
      snoozed_until: nextTrip.snoozed_until ?? null,
      truck_dims: current.truck_dims ?? (nextTrip.trucks ? {
        length: nextTrip.trucks.length_m ?? 12.0,
        width: nextTrip.trucks.width_m ?? 2.5,
        height: nextTrip.trucks.height_m ?? 4.0,
        weight: nextTrip.trucks.weight_t ?? 20.0,
        axleload: nextTrip.trucks.axleload_t ?? 11.5,
        hazmat: nextTrip.trucks.hazmat ?? false,
      } : DEFAULT_DIMS),
    });
  }

  function buildStepEndIndices(steps, coords) {
    if (!steps.length || !coords.length) return [];
    if (steps[0]?.way_points != null) {
      return steps.map(s => s.way_points[1] ?? coords.length - 1);
    }
    // OSRM: estimate by cumulative distance proportion
    const total = steps.reduce((s, st) => s + (st.distance || 0), 0);
    let cum = 0;
    return steps.map(st => {
      cum += st.distance || 0;
      return Math.min(Math.round((total > 0 ? cum / total : 1) * (coords.length - 1)), coords.length - 1);
    });
  }

  function applyAssignedRoute(tripData) {
    const assignedDest = tripData.assigned_destination;
    const steps        = tripData.route_steps;
    if (!assignedDest || !steps?.coordinates?.length) return;
    // Don't re-apply the same route for the same trip
    const routeKey = `${tripId}:${assignedDest}`;
    if (assignedRouteKeyRef.current === routeKey) return;
    assignedRouteKeyRef.current = routeKey;

    const rawCoords  = steps.coordinates;             // [lon, lat] pairs
    const leafletPts = rawCoords.map(([lon, lat]) => [lat, lon]);
    routeCoordsRef.current = rawCoords;

    if (routePolyRef.current) routePolyRef.current.remove();
    if (mapObj.current) {
      routePolyRef.current = L.polyline(leafletPts, { color: '#1565c0', weight: 7, opacity: 0.88 })
        .addTo(mapObj.current);
      if (leafletPts.length > 1) mapObj.current.fitBounds(L.latLngBounds(leafletPts), { padding: [80, 40] });
    }

    const destLat = tripData.dest_lat, destLon = tripData.dest_lon;
    if (destMarkRef.current) destMarkRef.current.remove();
    if (mapObj.current && destLat != null && destLon != null) {
      destMarkRef.current = L.marker([destLat, destLon], {
        icon: L.divIcon({ html: PIN_SVG, className: '', iconSize: [28, 28], iconAnchor: [14, 28] }),
      }).addTo(mapObj.current);
    }

    const routeStepsArr = steps.steps ?? [];
    stepEndIdxRef.current = buildStepEndIndices(routeStepsArr, rawCoords);
    if (tripData.dest_lat != null && tripData.dest_lon != null) {
      destCoordRef.current = [tripData.dest_lon, tripData.dest_lat];
    }
    arrivedRef.current = false;
    const dist_m = tripData.route_dist_m ?? steps.distance_m ?? 0;
    const dur_s  = tripData.route_dur_s  ?? steps.duration_s  ?? 0;
    setRouteSteps(routeStepsArr);
    setStepIdx(0);
    setStepDist(null);
    setRouteInfo({
      distance_km: (dist_m / 1000).toFixed(1),
      duration_min: Math.round(dur_s / 60),
    });
    setDestination(assignedDest);

    try {
      sessionStorage.setItem('driver_route', JSON.stringify({
        trip_id: tripId,
        assignedDest,
        coordinates: rawCoords,
        steps: routeStepsArr,
        destLat: tripData.dest_lat ?? null,
        destLon: tripData.dest_lon ?? null,
        dist_m,
        dur_s,
      }));
    } catch {  }
  }

  function clearTripFromSession() {
    const current = getDriverSession();
    if (!current?.user_id) return;
    const {
      trip_id, truck_id, driver_id, truck_code, trip_channel, trip_status,
      start_time, end_time, paused_at, total_rest_seconds, next_rest_alert_at,
      snoozed_until, truck_dims, active_trip, ...driverOnly
    } = current;
    setDriverSession(driverOnly);
    try { sessionStorage.removeItem('driver_route'); } catch {}
  }

  // Phone GPS
  const [phoneLocation, setPhoneLocation] = useState(null);
  const [geoError,      setGeoError]      = useState('');
  const [geoStatus,     setGeoStatus]     = useState('checking'); // checking | locating | ready | denied | timeout | unavailable

  // Navigation
  const [routeSteps,   setRouteSteps]   = useState([]);
  const [stepIdx,      setStepIdx]      = useState(0);
  const [stepDist,     setStepDist]     = useState(null);
  const [routeInfo,    setRouteInfo]    = useState(null);
  const [routeType,    setRouteType]    = useState(null); // 'hgv' | 'fallback' | null
  const [destination,  setDestination]  = useState('');
  const [showSearch,   setShowSearch]   = useState(false);
  const [routing,      setRouting]      = useState(false);
  const [routeError,   setRouteError]   = useState('');
  const [zoneWarning,  setZoneWarning]  = useState('');
  const [suggestions,  setSuggestions]  = useState([]);   // autocomplete hits
  const [acLoading,    setAcLoading]    = useState(false); // autocomplete spinner
  const [acError,      setAcError]      = useState('');    // autocomplete fetch error

  // Trip
  const [trip,       setTrip]       = useState(() => sess?.trip_id ? {
    id: sess.trip_id,
    truck_id: sess.truck_id,
    driver_id: sess.driver_id ?? sess.user_id,
    trip_status: sess.trip_status ?? 'active',
    start_time: sess.start_time ?? null,
    end_time: sess.end_time ?? null,
    paused_at: sess.paused_at ?? null,
    total_rest_seconds: sess.total_rest_seconds ?? 0,
    next_rest_alert_at: sess.next_rest_alert_at ?? null,
    snoozed_until: sess.snoozed_until ?? null,
  } : null);
  const [telemetry,  setTelemetry]  = useState(null);
  const [alerts,     setAlerts]     = useState([]);
  const [tripStatus, setTripStatus] = useState(sess?.trip_status ?? 'active');
  const [elapsed,    setElapsed]    = useState(() => computeDrivingElapsedMs(sess));
  const [opMs,       setOpMs]       = useState(() => computeOperationElapsedMs(sess));
  const [restMs,     setRestMs]     = useState(() => computeRestElapsedMs(sess));
  const [restCountdownMs,  setRestCountdownMs]  = useState(() => computeRestCountdownMs(sess));
  const [acting,      setActing]     = useState(false);
  const [connState,   setConnState]  = useState('online');
  const connFailRef      = useRef(0);
  const backoffUntilRef  = useRef(0); // millis() - skip poll ticks until this time
  const serverOffsetRef  = useRef(0); // ms to add to Date.now() to get server time
  // After a pending-action request (rest/resume/end), the backend's trip_status
  const pendingStatusRef = useRef({ expected: null, until: 0 });
  // Last HMI-reported driving time snapshot (seconds) and when we received it,
  const hmiClockRef = useRef({ drivingSec: null, restSec: null, receivedAt: 0, status: null });
  const [dismissed,   setDismissed]  = useState(new Set());
  const [error,       setError]      = useState('');
  const [toasts,      setToasts]     = useState([]);
  const [tripEndedMsg, setTripEndedMsg] = useState('');
  const prevAlertIdsRef = useRef(new Set());
  const [hmiOnline,  setHmiOnline]  = useState(true); // assume online until first poll
  const hmiMissedRef = useRef(0);

  const [followMode,  setFollowMode]  = useState(true);   // auto-center map on driver
  const [heading,     setHeading]     = useState(null);   // degrees 0-360 from GPS movement
  const mapWrapperRef = useRef(null);                     // wrapper div for heading-up rotation

  // UI
  const [sheetOpen, setSheetOpen] = useState(false);
  const [viewportH, setViewportH] = useState(() => window.visualViewport?.height ?? window.innerHeight);
  const phoneGpsActive = phoneLocation && geoStatus === 'ready';
  const navLat = phoneGpsActive ? phoneLocation.lat : (telemetry?.lat ?? null);
  const navLon = phoneGpsActive ? phoneLocation.lon : (telemetry?.lon ?? null);
  const navSource = phoneGpsActive ? 'mobile_gps' : (telemetry?.lat != null && telemetry?.lon != null ? 'embedded_gps' : null);

  function animateMarker(marker, nextLatLng, animRef, duration = 450) {
    if (!marker) return;
    if (animRef.current) cancelAnimationFrame(animRef.current);
    const start = marker.getLatLng();
    const startedAt = performance.now();
    const [nextLat, nextLon] = nextLatLng;
    function frame(now) {
      const t = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      marker.setLatLng([
        start.lat + (nextLat - start.lat) * eased,
        start.lng + (nextLon - start.lng) * eased,
      ]);
      if (t < 1) animRef.current = requestAnimationFrame(frame);
    }
    animRef.current = requestAnimationFrame(frame);
  }

  useEffect(() => {
    function updateViewport() {
      setViewportH(window.visualViewport?.height ?? window.innerHeight);
      setTimeout(() => mapObj.current?.invalidateSize(), 80);
    }
    window.addEventListener('resize', updateViewport);
    window.visualViewport?.addEventListener('resize', updateViewport);
    return () => {
      window.removeEventListener('resize', updateViewport);
      window.visualViewport?.removeEventListener('resize', updateViewport);
    };
  }, []);

  // always reads the current follow mode without a stale capture.
  useEffect(() => { followModeRef.current = followMode; }, [followMode]);

  // ?? Heading-up map rotation ?????????????????????????????????
  // 150%x150% wrapper ensures corners are always tile-covered at any rotation angle.
  useEffect(() => {
    const el = mapWrapperRef.current;
    if (!el) return;
    if (followMode && heading !== null) {
      el.style.transform = `rotate(${-heading}deg)`;
    } else if (!followMode) {
      el.style.transform = 'rotate(0deg)';
    }
  }, [heading, followMode]);

  // ?? Map init ????????????????????????????????????????????????
  useEffect(() => {
    if (mapObj.current) return;
    mapObj.current = L.map(mapRef.current, {
      center: [14.5995, 120.9842],
      zoom: 17,
      zoomControl: false,
      attributionControl: false,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 })
      .addTo(mapObj.current);
    L.control.attribution({ position: 'bottomleft', prefix: '? OSM' }).addTo(mapObj.current);
    mapObj.current.on('dragstart', () => setFollowMode(false));
    setTimeout(() => mapObj.current?.invalidateSize({ animate: false }), 50);

    try {
      const saved = JSON.parse(sessionStorage.getItem('driver_route') ?? 'null');
      if (saved?.assignedDest && saved.coordinates?.length && saved.trip_id === tripId) {
        const leafletPts = saved.coordinates.map(([lon, lat]) => [lat, lon]);
        routeCoordsRef.current = saved.coordinates;
        stepEndIdxRef.current  = buildStepEndIndices(saved.steps ?? [], saved.coordinates);
        if (saved.destLat != null && saved.destLon != null) {
          destCoordRef.current = [saved.destLon, saved.destLat];
        }
        arrivedRef.current = false;
        routePolyRef.current = L.polyline(leafletPts, { color: '#1565c0', weight: 7, opacity: 0.88 })
          .addTo(mapObj.current);
        if (leafletPts.length > 1) mapObj.current.fitBounds(L.latLngBounds(leafletPts), { padding: [80, 40] });
        if (saved.destLat != null && saved.destLon != null) {
          destMarkRef.current = L.marker([saved.destLat, saved.destLon], {
            icon: L.divIcon({ html: PIN_SVG, className: '', iconSize: [28, 28], iconAnchor: [14, 28] }),
          }).addTo(mapObj.current);
        }
        setRouteSteps(saved.steps ?? []);
        setStepIdx(0);
        setStepDist(null);
        setRouteInfo({
          distance_km: ((saved.dist_m ?? 0) / 1000).toFixed(1),
          duration_min: Math.round((saved.dur_s ?? 0) / 60),
        });
        setDestination(saved.assignedDest);
        assignedRouteKeyRef.current = saved.assignedDest; // skip re-apply on first poll
      }
    } catch {  }

    return () => {
      if (phoneAnimRef.current) cancelAnimationFrame(phoneAnimRef.current);
      if (truckAnimRef.current) cancelAnimationFrame(truckAnimRef.current);
      mapObj.current?.remove();
      mapObj.current = null;
    };
  }, []);

  // ?? Restricted zones ????????????????????????????????????????
  useEffect(() => {
    fetchRestrictedZones().then(zones => {
      zoneRefs.current.forEach(l => l.remove());
      zoneRefs.current = [];
      zones.forEach(z => {
        const c = z.severity === 'restricted' ? '#ff4444' : '#ffaa00';
        const r = L.rectangle([[z.lat_min, z.lon_min],[z.lat_max, z.lon_max]], {
          color: c, weight: 1.5, fillColor: c, fillOpacity: 0.13, dashArray: '6 4',
        });
        r.bindTooltip(`<b>${z.name}</b><br>${z.description ?? ''}`, { sticky: true });
        r.addTo(mapObj.current);
        zoneRefs.current.push(r);
      });
    }).catch(() => {});
  }, []);

  // ?? Phone GPS ????????????????????????????????????????????????
  useEffect(() => {
    if (!window.isSecureContext) {
      setGeoStatus('unavailable');
      setGeoError('Phone GPS requires HTTPS or localhost');
      return;
    }
    if (!navigator.geolocation) {
      setGeoStatus('unavailable');
      setGeoError('Phone GPS is not supported on this browser');
      return;
    }

    let cancelled = false;
    setGeoStatus('locating');
    setGeoError('');

    navigator.permissions?.query?.({ name: 'geolocation' })
      .then((perm) => {
        if (cancelled) return;
        if (perm.state === 'denied') {
          setGeoStatus('denied');
          setGeoError('Location permission is blocked for this site');
        }
        perm.onchange = () => {
          if (perm.state !== 'denied') setGeoError('');
          setGeoStatus(perm.state === 'denied' ? 'denied' : 'locating');
        };
      })
      .catch(() => {});

    function bearingDeg(lat1, lon1, lat2, lon2) {
      const toRad = d => d * Math.PI / 180;
      const toDeg = r => r * 180 / Math.PI;
      const dLon = toRad(lon2 - lon1);
      const y = Math.sin(dLon) * Math.cos(toRad(lat2));
      const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
                Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
      return (toDeg(Math.atan2(y, x)) + 360) % 360;
    }

    function makeArrowIcon(deg) {
      // Rotating arrow div icon - shows driver heading direction
      return L.divIcon({
        className: '',
        html: `<div style="
          width:24px;height:24px;
          background:#2979ff;border:2.5px solid #fff;
          border-radius:50%;
          display:flex;align-items:center;justify-content:center;
          box-shadow:0 2px 8px rgba(0,0,0,0.5);
          transform:none;
        ">
          <div style="
            width:0;height:0;
            border-left:5px solid transparent;
            border-right:5px solid transparent;
            border-bottom:12px solid #fff;
            transform:rotate(${deg ?? 0}deg);
            transform-origin:50% 50%;
          "></div>
        </div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });
    }

    function onPos(pos) {
      const { latitude: lat, longitude: lon, accuracy } = pos.coords;

      let newHeading = headingRef.current;
      const prev = prevPhoneLocRef.current;
      if (prev) {
        const dist = haversine(prev.lat, prev.lon, lat, lon);
        if (dist > 5) {
          newHeading = bearingDeg(prev.lat, prev.lon, lat, lon);
          headingRef.current = newHeading;
          setHeading(newHeading);
        }
      }
      prevPhoneLocRef.current = { lat, lon };

      setPhoneLocation({
        lat,
        lon,
        accuracy,
        heading: pos.coords.heading ?? newHeading,
        speed: pos.coords.speed,
        source: 'mobile_gps',
        timestamp: pos.timestamp || Date.now(),
      });
      setGeoStatus('ready');
      setGeoError('');
      if (!mapObj.current) return;
      const ll = [lat, lon];

      if (!phoneMarkRef.current) {
        phoneMarkRef.current = L.marker(ll, {
          icon: makeArrowIcon(newHeading),
          zIndexOffset: 1000,
        }).bindTooltip('mobile_gps (driver)', { permanent: false }).addTo(mapObj.current);
        mapObj.current.setView(ll, 17, { animate: false });
      } else {
        animateMarker(phoneMarkRef.current, ll, phoneAnimRef);
        if (newHeading !== null) phoneMarkRef.current.setIcon(makeArrowIcon(newHeading));
        if (followModeRef.current) mapObj.current.panTo(ll, { animate: true, duration: 0.3, easeLinearity: 1 });
      }

      if (!phoneAccRef.current) {
        phoneAccRef.current = L.circle(ll, {
          radius: accuracy, color: '#2979ff', weight: 1,
          fillColor: '#2979ff', fillOpacity: 0.07,
        }).addTo(mapObj.current);
      } else {
        phoneAccRef.current.setLatLng(ll).setRadius(accuracy);
      }
    }

    function onErr(e) {
      if (e.code === e.PERMISSION_DENIED) {
        setGeoStatus('denied');
        setGeoError('Location permission denied - enable it in browser settings');
      } else if (e.code === e.POSITION_UNAVAILABLE) {
        setGeoStatus('unavailable');
        setGeoError('Phone GPS signal unavailable; embedded_gps can still update the truck');
      } else {
        setGeoStatus('timeout');
        setGeoError('Waiting for GPS fix');
      }
    }

    geoWatchRef.current = navigator.geolocation.watchPosition(onPos, onErr, {
      enableHighAccuracy: true, timeout: 10000, maximumAge: 1500,
    });
    return () => {
      cancelled = true;
      navigator.geolocation.clearWatch(geoWatchRef.current);
      if (phoneAnimRef.current) cancelAnimationFrame(phoneAnimRef.current);
      phoneMarkRef.current?.remove(); phoneMarkRef.current = null;
      phoneAccRef.current?.remove();  phoneAccRef.current  = null;
    };
  }, []);

  // ?? Route trimming + step progress ??????????????????????????
  useEffect(() => {
    if (navLat == null || navLon == null || !routeCoordsRef.current.length) return;
    const coords = routeCoordsRef.current;

    // Find nearest route coordinate to current GPS position
    let minDist = Infinity, nearestIdx = 0;
    for (let i = 0; i < coords.length; i++) {
      const [cLon, cLat] = coords[i];
      const d = haversine(navLat, navLon, cLat, cLon);
      if (d < minDist) { minDist = d; nearestIdx = i; }
    }

    // Trim polyline to show only remaining route from nearest point
    if (routePolyRef.current && nearestIdx > 0) {
      const remaining = coords.slice(nearestIdx).map(([lon, lat]) => [lat, lon]);
      if (remaining.length > 1) routePolyRef.current.setLatLngs(remaining);
    }

    // Step advancement + along-route distance to next turn
    if (!routeSteps.length || !stepEndIdxRef.current.length) return;
    const endIdx   = stepEndIdxRef.current[stepIdx] ?? coords.length - 1;
    const endCoord = coords[endIdx];
    if (endCoord) {
      // More accurate than straight-line on curves; snap distance handles GPS offset.
      let routeDist;
      if (nearestIdx < endIdx) {
        const snapDist = haversine(navLat, navLon,
                                   coords[nearestIdx][1], coords[nearestIdx][0]);
        let pathDist = 0;
        for (let i = nearestIdx; i < endIdx; i++) {
          pathDist += haversine(coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0]);
        }
        routeDist = snapDist + pathDist;
      } else {
        // Past or at endpoint - use straight-line remainder
        routeDist = haversine(navLat, navLon, endCoord[1], endCoord[0]);
      }
      setStepDist(routeDist);

      const directDist = haversine(navLat, navLon, endCoord[1], endCoord[0]);
      if ((nearestIdx >= endIdx || directDist < 30) && stepIdx < routeSteps.length - 1) {
        setStepIdx(i => i + 1);
      } else {
        const nextStep = routeSteps[stepIdx + 1];
        const livePush = lastLiveNavPushRef.current;
        const shouldPushLive = tripId && (
          livePush.stepIdx !== stepIdx ||
          livePush.dist == null ||
          Math.abs(livePush.dist - routeDist) >= 10 ||
          Date.now() - livePush.at >= 2500
        );
        if (shouldPushLive) {
          lastLiveNavPushRef.current = { stepIdx, dist: routeDist, at: Date.now() };
          if (!nextStep) {
            pushNavStep(tripId, 'Arriving at destination', Math.round(routeDist), 6, {
              nav_state: 'navigating',
              current_step_index: stepIdx,
              gps_source: navSource,
              destination,
            }).catch(() => {});
          } else {
            const rawType = nextStep.type ?? 6;
            const hmiType = rawType === 11
              ? departHeadingType(nextStep.instruction ?? nextStep.name ?? '')
              : rawType;
            pushNavStep(tripId, nextStep.instruction ?? nextStep.name ?? '',
                        Math.round(routeDist), hmiType, {
                          nav_state: 'navigating',
                          current_step_index: stepIdx,
                          next_street: nextStep.name ?? null,
                          gps_source: navSource,
                          destination,
                        }).catch(() => {});
          }
        }
        // Push countdown distance updates to HMI at key approaching thresholds.
        const THRESHOLDS = [300, 150, 80, 30];
        for (const t of THRESHOLDS) {
          if (routeDist <= t && !hmiDistThreshRef.current.has(t)) {
            hmiDistThreshRef.current.add(t);
            if (tripId) {
              if (!nextStep) {
                pushNavStep(tripId, 'Arriving at destination', Math.round(routeDist), 6, {
                  nav_state: 'navigating',
                  current_step_index: stepIdx,
                  gps_source: navSource,
                  destination,
                }).catch(() => {});
              } else {
                const rawType = nextStep.type ?? 6;
                const hmiType = rawType === 11
                  ? departHeadingType(nextStep.instruction ?? nextStep.name ?? '')
                  : rawType;
                pushNavStep(tripId, nextStep.instruction ?? nextStep.name ?? '',
                            Math.round(routeDist), hmiType, {
                              nav_state: 'navigating',
                              current_step_index: stepIdx,
                              next_street: nextStep.name ?? null,
                              gps_source: navSource,
                              destination,
                            }).catch(() => {});
              }
            }
          }
        }
      }
    }

    // Off-route detection: if driver drifts >50m from the route, recalculate.
    if (destCoordRef.current && !arrivedRef.current) {
      const now = Date.now();
      if (minDist > 50 && now - lastRerouteRef.current > 10000) {
        offRouteRef.current = true;
        lastRerouteRef.current = now;
        if (tripId) pushNavStep(tripId, 'Rerouting', Math.round(minDist), 6, {
          nav_state: 'rerouting',
          current_step_index: stepIdx,
          gps_source: navSource,
          destination,
        }).catch(() => {});
        getRoute(destCoordRef.current);
      } else if (minDist <= 30) {
        offRouteRef.current = false; // back on route
      }
    }

    // Arrival detection + reroute hysteresis
    if (destCoordRef.current) {
      const [dLon, dLat] = destCoordRef.current;
      const distToDest = haversine(navLat, navLon, dLat, dLon);
      if (!arrivedRef.current && stepIdx === routeSteps.length - 1 && distToDest < 50) {
        // Entered 50m arrival radius - mark arrived, push DEST step to HMI
        arrivedRef.current = true;
        offRouteRef.current = false;
        if (tripId) pushNavStep(tripId, 'Arrived at destination', 0, 10, {
          nav_state: 'arrived',
          current_step_index: stepIdx,
          gps_source: navSource,
          destination,
        }).catch(() => {});
      } else if (arrivedRef.current && distToDest > 120) {
        // Exited 120m exit radius - reroute back to same destination
        arrivedRef.current = false;
        if (tripId) pushNavStep(tripId, 'Rerouting', Math.round(distToDest), 6, {
          nav_state: 'rerouting',
          current_step_index: stepIdx,
          gps_source: navSource,
          destination,
        }).catch(() => {});
        getRoute(destCoordRef.current);
      }
    }
  }, [navLat, navLon, navSource, routeSteps, stepIdx, tripId, destination]);

  // "Next step" = routeSteps[stepIdx + 1]: the arrow/instruction the driver needs
  const lastPushedStepRef  = useRef(-1);
  const hmiDistThreshRef   = useRef(new Set()); // distance thresholds already pushed this step
  useEffect(() => {
    if (!tripId || !routeSteps.length) return;
    const step = routeSteps[stepIdx];
    if (!step) return;
    // Deduplicate: don't push the same stepIdx twice unless routeSteps changed
    if (lastPushedStepRef.current === stepIdx && routeSteps === lastPushedStepRef._steps) return;
    lastPushedStepRef.current = stepIdx;
    lastPushedStepRef._steps  = routeSteps;
    hmiDistThreshRef.current  = new Set(); // reset per-step distance thresholds
    const nextStep = routeSteps[stepIdx + 1];
    if (!nextStep) {
      // Last step - heading to destination
      pushNavStep(tripId, 'Arriving at destination',
                  Math.round(stepDist ?? step.distance ?? 0), 6, {
                    nav_state: 'navigating',
                    current_step_index: stepIdx,
                    gps_source: navSource,
                    destination,
                  }).catch(() => {});
    } else {
      const rawType = nextStep.type ?? 6;
      const hmiType = rawType === 11 ? departHeadingType(nextStep.instruction ?? nextStep.name ?? '') : rawType;
      pushNavStep(
        tripId,
        nextStep.instruction ?? nextStep.name ?? '',
        Math.round(stepDist ?? step.distance ?? 0),
        hmiType,
        {
          nav_state: 'navigating',
          current_step_index: stepIdx,
          next_street: nextStep.name ?? null,
          gps_source: navSource,
          destination,
        },
      ).catch(() => {});
    }
  }, [stepIdx, tripId, routeSteps, navSource, destination]); // routeSteps dep ensures step 0 is pushed on route change

  // ?? Poll trip + telemetry ????????????????????????????????????
  const pollAll = useCallback(async () => {
    // Exponential backoff: skip ticks while in backoff window after consecutive failures
    if (Date.now() < backoffUntilRef.current) return;
    try {
      const [tripData, telem] = await Promise.all([
        tripId  ? fetchTripStatus(tripId)       : Promise.resolve(null),
        truckId ? fetchLatestTelemetry(truckId) : Promise.resolve(null),
      ]);
      if (tripData) {
        if (tripData.server_now) {
          serverOffsetRef.current = new Date(tripData.server_now).getTime() - Date.now();
        }
        const nextTrip = tripData.trip;
        setTrip(nextTrip);
        setAlerts(tripData.alerts ?? []);
        // poll stays as a defense-in-depth for explicit HMI logout detection.
        if (typeof tripData.hmi_online === 'boolean') {
          setHmiOnline(tripData.hmi_online);
          if (tripData.hmi_online) hmiMissedRef.current = 0;
        }
        // Mirror HMI's live nav step instruction / next-street / current
        if (nextTrip?.nav_current_step_index != null) {
          const idx = Number(nextTrip.nav_current_step_index);
          if (Number.isFinite(idx) && idx >= 0) {
            setStepIdx(curr => (idx > curr ? idx : curr));
          }
        }
        const serverStatus = nextTrip?.trip_status ?? 'active';
        const pending = pendingStatusRef.current;
        if (pending.expected && Date.now() < pending.until) {
          if (serverStatus === pending.expected) {
            // Backend caught up to our optimistic value - clear override
            pendingStatusRef.current = { expected: null, until: 0 };
            setTripStatus(serverStatus);
          } else {
            // Backend still showing pre-action status - hold optimistic value
            setTripStatus(pending.expected);
          }
        } else {
          setTripStatus(serverStatus);
        }
        // Prefer the HMI-reported driving time from the latest telemetry when
        const telemHmiSec = telem?.hmi_driving_sec;
        const telemHmiRest = telem?.hmi_rest_sec;
        const telemHmiStatus = telem?.hmi_trip_status;
        if (typeof telemHmiSec === 'number' && telemHmiSec > 0) {
          hmiClockRef.current = {
            drivingSec: telemHmiSec,
            restSec: typeof telemHmiRest === 'number' ? telemHmiRest : null,
            receivedAt: Date.now(),
            status: telemHmiStatus ?? null,
          };
          setElapsed(telemHmiSec * 1000);
        } else {
          setElapsed(computeDrivingElapsedMs(nextTrip));
        }
        updateTripInSession(nextTrip);
        if (nextTrip) {
          if (nextTrip.assigned_destination) {
            applyAssignedRoute(nextTrip);
          } else if (assignedRouteKeyRef.current) {
            // Admin cleared the route - remove it from map and storage
            assignedRouteKeyRef.current = null;
            try { sessionStorage.removeItem('driver_route'); } catch {}
            routePolyRef.current?.remove(); routePolyRef.current = null;
            destMarkRef.current?.remove(); destMarkRef.current = null;
            routeCoordsRef.current = [];
            destCoordRef.current = null;
            arrivedRef.current = false;
            setRouteSteps([]);
            setRouteInfo(null);
            setRouteType(null);
            setDestination('');
            setStepIdx(0);
            setStepDist(null);
          }
        }
        if (nextTrip?.trip_status === 'ended' && !endedRef.current) {
          endedRef.current = true;
          clearTripFromSession();
          setTripEndedMsg('Trip Ended');
          setTimeout(() => navigate('/driver/notrip', { replace: true }), 2500);
          return;
        }
        if (tripData.latest_telemetry && !telem) {
          setTelemetry(tripData.latest_telemetry);
        }
      }
      if (telem) {
        setTelemetry(telem);
        if (telem.lat && telem.lon && mapObj.current) {
          const ll = [telem.lat, telem.lon];
          if (!truckMarkRef.current) {
            truckMarkRef.current = L.marker(ll, {
              icon: L.divIcon({ html: TRUCK_SVG, className: '', iconSize: [30,30], iconAnchor: [15,15] }),
              zIndexOffset: 500,
            }).bindTooltip(`${truckCode} embedded_gps`, { permanent: false }).addTo(mapObj.current);
          } else {
            animateMarker(truckMarkRef.current, ll, truckAnimRef, 650);
          }
        }
      }
      connFailRef.current = 0;
      backoffUntilRef.current = 0;
      setConnState('online');
    } catch {
      connFailRef.current += 1;
      if (connFailRef.current >= 2) {
        setConnState('offline');
        // Backoff: 5s -> 10s -> 20s -> 30s (cap), measured from now
        const backoffMs = Math.min(POLL_MS * Math.pow(2, connFailRef.current - 2), 30000);
        backoffUntilRef.current = Date.now() + backoffMs;
      }
    }
  }, [tripId, truckId, truckCode]);

  useEffect(() => {
    pollAll();
    pollRef.current = setInterval(pollAll, POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [pollAll]);

  useEffect(() => {
    if (!tripId || !truckId) return;
    function pushPhoneGps() {
      if (!phoneLocation) return;
      const status = tripStatus || trip?.trip_status;
      if (status !== 'active' && status !== 'paused') return;
      const now = Date.now();
      if (now - lastMobileGpsPostRef.current < 3000) return;
      lastMobileGpsPostRef.current = now;
      postMobileGps(truckId, tripId, phoneLocation.lat, phoneLocation.lon, {
        accuracy: phoneLocation.accuracy ?? null,
        heading: phoneLocation.heading ?? null,
        browser_speed: phoneLocation.speed ?? null,
        original_timestamp: phoneLocation.timestamp ? new Date(phoneLocation.timestamp).toISOString() : new Date().toISOString(),
        source: 'mobile_gps',
      }).catch(() => {});
    }
    pushPhoneGps();
    const id = setInterval(pushPhoneGps, 5000);
    return () => clearInterval(id);
  }, [tripId, truckId, phoneLocation, tripStatus, trip]);

  useEffect(() => {
    const incoming = alerts; // raw backend alerts array
    const newOnes = incoming.filter(a => !prevAlertIdsRef.current.has(a.id));
    prevAlertIdsRef.current = new Set(incoming.map(a => a.id));
    if (!newOnes.length) return;
    newOnes.forEach(a => {
      const norm = normalizeDriverAlert(a);
      const key  = `${a.id}-${Date.now()}`;
      const bg       = norm.severity === 'high' ? '#8b0000' : norm.severity === 'medium' ? '#7a4000' : '#194D84';
      const severity = norm.severity ?? 'low';
      setToasts(q => [...q, { key, msg: norm.message, bg, severity }]);
      setTimeout(() => setToasts(q => q.filter(t => t.key !== key)), 4500);
    });
  }, [alerts]);

  // ?? Timer ?????????????????????????????????????????????????????
  useEffect(() => {
    function tick() {
      const now = Date.now();
      const serverNow = now + serverOffsetRef.current;
      // Otherwise fall back to server-side computation.
      const hmi = hmiClockRef.current;
      const hmiAge = now - hmi.receivedAt;
      if (hmi.drivingSec != null && hmiAge < 30000) {
        const baseSec = hmi.drivingSec;
        const extraSec = hmi.status === 'paused' ? 0 : Math.floor(hmiAge / 1000);
        setElapsed((baseSec + extraSec) * 1000);
      } else {
        setElapsed(computeDrivingElapsedMs(trip, now));
      }
      setOpMs(computeOperationElapsedMs(trip, now));
      setRestMs(computeRestElapsedMs(trip, now));
      setRestCountdownMs(computeRestCountdownMs(trip, serverNow));
    }
    tick();
    timerRef.current = setInterval(tick, 1000);
    return () => clearInterval(timerRef.current);
  }, [trip]);

  // ?? HMI session presence poll ????????????????????????????????
  const driverId = sess?.driver_id ?? sess?.user_id ?? null;
  useEffect(() => {
    if (!driverId) return;
    let cancelled = false;
    async function pollHmi() {
      try {
        const data = await checkHmiSession(driverId);
        if (!cancelled) {
          if (data.active === true) {
            hmiMissedRef.current = 0;
            setHmiOnline(true);
          } else {
            setHmiOnline(false);
            // Only log out when the HMI explicitly ended the session (trip ended).
            if (isHmiTrip && data.session?.status === 'ended') {
              const endedAt  = data.session.ended_at ? new Date(data.session.ended_at).getTime() : 0;
              const loginAt  = sess?.login_at ? new Date(sess.login_at).getTime() : 0;
              if (endedAt > loginAt) {
                setError('Trip ended by HMI. Returning to login screen...');
                setTimeout(() => { if (!cancelled) { clearTripFromSession(); onLogout?.(); } }, 2000);
                return;
              }
            }
          }
        }
      } catch {
      }
    }
    pollHmi();
    // route's job is narrowed to detecting explicit HMI session-ended events
    const id = setInterval(pollHmi, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [driverId]);

  // ?? Autocomplete (ORS geocode/autocomplete) ?????????????????
  async function fetchSuggestions(query) {
    if (!query || query.trim().length < 2) { setSuggestions([]); setAcError(''); return; }
    if (/^-?\d+\.?\d*,\s*-?\d+\.?\d*$/.test(query.trim())) { setSuggestions([]); return; }
    setAcLoading(true);
    setAcError('');
    const focusLat = phoneLocation?.lat ?? 14.5995;
    const focusLon = phoneLocation?.lon ?? 120.9842;
    const q = query.trim();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);
    try {
      let features = [];
      let providerNote = '';

      if (hasUsableOrsKey()) {
        const url = `${ORS_AUTOCOMPLETE}?api_key=${encodeURIComponent(ORS_KEY)}`
          + `&text=${encodeURIComponent(q)}`
          + `&boundary.country=PH`
          + `&focus.point.lat=${focusLat}&focus.point.lon=${focusLon}`
          + `&size=6`;
        try {
          const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
          if (!r.ok) throw new Error(await readApiError(r, 'ORS search'));
          const d = await r.json();
          features = (d.features ?? []).map(f => ({
            label:    f.properties.label ?? f.properties.name,
            name:     f.properties.name  ?? f.properties.label,
            locality: [f.properties.locality, f.properties.region, f.properties.country].filter(Boolean).join(', '),
            lon: f.geometry.coordinates[0],
            lat: f.geometry.coordinates[1],
            provider: 'ors',
          }));
        } catch (e) {
          providerNote = e.message || describeNetworkError(e, 'ORS search');
        }
      } else {
        providerNote = 'ORS search API key is missing';
      }

      if (!features.length) {
        const url = `${NOM}?q=${encodeURIComponent(q)}&format=json&addressdetails=1&limit=8`
          + `&countrycodes=ph&bounded=1&viewbox=${PH_BBOX}`
          + `&accept-language=en`;
        try {
          const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
          if (!r.ok) throw new Error(await readApiError(r, 'Nominatim search'));
          const d = await r.json();
          features = (d ?? []).map((f) => ({
            label: f.display_name,
            name: f.name || f.display_name?.split(',')[0] || q,
            locality: [
              f.address?.city || f.address?.town || f.address?.municipality || f.address?.county,
              f.address?.state || f.address?.region,
            ].filter(Boolean).join(', '),
            lon: Number(f.lon),
            lat: Number(f.lat),
            provider: 'nominatim',
          })).filter((f) => Number.isFinite(f.lon) && Number.isFinite(f.lat)).slice(0, 6);
        } catch (e) {
          const msg = e.message || describeNetworkError(e, 'Nominatim search');
          throw new Error(providerNote ? `${providerNote}; fallback failed: ${msg}` : msg);
        }
      }

      setSuggestions(features);
      if (!features.length) setAcError('No Philippines results found');
    } catch (e) {
      setSuggestions([]);
      setAcError(e.message || describeNetworkError(e, 'Search'));
    } finally {
      clearTimeout(timeout);
      setAcLoading(false);
    }
  }

  function onSearchInput(e) {
    const val = e.target.value;
    setDestination(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchSuggestions(val), 280);
  }

  function clearSearch() {
    setDestination('');
    setSuggestions([]);
    setRouteError('');
    setAcError('');
  }

  // ?? Routing (ORS HGV / truck profile) ???????????????????????
  async function getRoute(knownDest = null) {
    if (!knownDest && !destination.trim()) return;
    setSuggestions([]);
    setRouting(true); setRouteError(''); setZoneWarning('');

    const origin = phoneLocation
      ? [phoneLocation.lon, phoneLocation.lat]
      : telemetry?.lat && telemetry?.lon
        ? [telemetry.lon, telemetry.lat]
        : [120.9842, 14.5995];

    // Use pre-resolved coords or parse/geocode the typed string
    let dest = knownDest;
    if (!dest) {
      const coordMatch = destination.trim().match(/^(-?\d+\.?\d*),\s*(-?\d+\.?\d*)$/);
      if (coordMatch) {
        dest = [parseFloat(coordMatch[2]), parseFloat(coordMatch[1])];
      } else {
        try {
          const r = await fetch(
            `${NOM}?q=${encodeURIComponent(destination + ', Philippines')}&format=json&limit=1&countrycodes=ph&bounded=1&viewbox=${PH_BBOX}`,
            { headers: { 'Accept-Language': 'en', Accept: 'application/json' } }
          );
          if (!r.ok) throw new Error(await readApiError(r, 'Nominatim geocode'));
          const d = await r.json();
          if (!d?.length) throw new Error('Place not found');
          dest = [parseFloat(d[0].lon), parseFloat(d[0].lat)];
        } catch (e) { setRouteError(e.message); setRouting(false); return; }
      }
    }

    try {
      // ORS HGV routing - avoids roads restricted for trucks by weight/height/length
      if (!hasUsableOrsKey()) throw new Error('ORS routing API key is missing');
      const res = await fetch(ORS_URL, {
        method: 'POST',
        headers: {
          'Authorization': ORS_KEY,
          'Content-Type': 'application/json',
          'Accept': 'application/json, application/geo+json',
        },
        body: JSON.stringify({
          coordinates: [origin, dest],
          options: {
            profile_params: {
              restrictions: {
                length:   truckDims.length,
                width:    truckDims.width,
                height:   truckDims.height,
                weight:   truckDims.weight,
                axleload: truckDims.axleload,
                ...(truckDims.hazmat ? { hazmat: true } : {}),
              },
            },
          },
        }),
      });
      const rawText = await res.text();
      if (!res.ok) {
        let errMsg = rawText;
        try { const j = JSON.parse(rawText); errMsg = j?.error?.message || j?.message || rawText; } catch {}
        throw new Error(`HTTP ${res.status} - ${errMsg.slice(0, 200)}`);
      }
      const d = JSON.parse(rawText);
      const feature = d.features?.[0];
      if (!feature) throw new Error(`No route in response - keys: ${Object.keys(d).join(', ')}`);

      const rawCoords  = feature.geometry.coordinates;       // [lon, lat] pairs
      const summary    = feature.properties.summary;
      const steps      = feature.properties.segments[0].steps;
      const leafletPts = rawCoords.map(([lon, lat]) => [lat, lon]);

      routeCoordsRef.current = rawCoords;
      stepEndIdxRef.current  = buildStepEndIndices(steps, rawCoords);
      destCoordRef.current   = dest;  // [lon, lat]
      arrivedRef.current     = false;
      offRouteRef.current    = false;

      if (routePolyRef.current) routePolyRef.current.remove();
      // Blue for truck HGV route
      routePolyRef.current = L.polyline(leafletPts, { color: '#1565c0', weight: 7, opacity: 0.88 })
        .addTo(mapObj.current);

      if (destMarkRef.current) destMarkRef.current.remove();
      destMarkRef.current = L.marker([dest[1], dest[0]], {
        icon: L.divIcon({ html: PIN_SVG, className: '', iconSize: [28,28], iconAnchor: [14,28] }),
      }).addTo(mapObj.current);

      mapObj.current?.fitBounds(routePolyRef.current.getBounds(), { padding: [80, 40] });

      setRouteSteps(steps);
      setStepIdx(0); setStepDist(null);
      setRouteType('hgv');
      setRouteInfo({
        distance_km: (summary.distance / 1000).toFixed(1),
        duration_min: Math.round(summary.duration / 60),
      });
      setRouteError('');
      setShowSearch(false);

      if (tripId) {
        saveRoute(tripId, {
          destination,
          dest_lat: dest[1],
          dest_lon: dest[0],
          route_steps: { coordinates: rawCoords, steps },
          route_dist_m: Math.round(summary.distance),
          route_dur_s: Math.round(summary.duration),
        }).catch(() => {});
        // Cache locally for page refresh, scoped by trip_id
        try {
          sessionStorage.setItem('driver_route', JSON.stringify({
            trip_id: tripId,
            assignedDest: destination,
            coordinates: rawCoords,
            steps,
            destLat: dest[1],
            destLon: dest[0],
            dist_m: Math.round(summary.distance),
            dur_s: Math.round(summary.duration),
          }));
        } catch {  }
        assignedRouteKeyRef.current = `${tripId}:${destination}`;
      }

      // Zone advisory on top of truck routing
      const zones = await fetchRestrictedZones().catch(() => []);
      const hour = new Date().getHours(), day = new Date().getDay();
      for (const z of zones) {
        const tOk = z.ban_start_hour == null || (hour >= z.ban_start_hour && hour < z.ban_end_hour);
        const dOk = !z.ban_days_of_week || z.ban_days_of_week.split(',').map(Number).includes(day);
        if (!tOk || !dOk) continue;
        if (leafletPts.some(([lat,lon]) => lat>=z.lat_min && lat<=z.lat_max && lon>=z.lon_min && lon<=z.lon_max)) {
          setZoneWarning(`Route enters restricted zone: ${z.name}`);
          break;
        }
      }
    } catch (e) {
      const orsError = e.message || describeNetworkError(e, 'ORS routing');
      try {
        const url = `${OSRM_URL}/${origin[0]},${origin[1]};${dest[0]},${dest[1]}?overview=full&geometries=geojson&steps=true`;
        const routeRes = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!routeRes.ok) throw new Error(await readApiError(routeRes, 'OSRM routing'));
        const routeData = await routeRes.json();
        const route = routeData.routes?.[0];
        if (!route) throw new Error('No fallback route found');
        const rawCoords = route.geometry.coordinates;
        const leafletPts = rawCoords.map(([lon, lat]) => [lat, lon]);

        routeCoordsRef.current = rawCoords;
        destCoordRef.current   = dest;
        arrivedRef.current     = false;
        offRouteRef.current    = false;
        // modifier (left/right/sharp/slight) and build a human instruction
        const osrmTypeToOrs = (mtype, modifier) => {
          const mod = (modifier ?? '').toLowerCase();
          switch (mtype) {
            case 'turn':
              if (mod.includes('sharp') && mod.includes('left'))  return 2;
              if (mod.includes('sharp') && mod.includes('right')) return 3;
              if (mod.includes('slight') && mod.includes('left'))  return 4;
              if (mod.includes('slight') && mod.includes('right')) return 5;
              if (mod.includes('left'))  return 0;
              if (mod.includes('right')) return 1;
              if (mod === 'straight') return 6;
              return 6;
            case 'new name':
            case 'continue':      return 6;
            case 'merge':
              return mod.includes('left') ? 0 : mod.includes('right') ? 1 : 6;
            case 'on ramp':
            case 'off ramp':
              return mod.includes('left') ? 4 : mod.includes('right') ? 5 : 6;
            case 'fork':
              return mod.includes('left') ? 12 : 13;
            case 'roundabout':
            case 'rotary':        return 7;
            case 'exit roundabout':
            case 'exit rotary':   return 8;
            case 'uturn':         return 9;
            case 'arrive':        return 10;
            case 'depart':        return 11;
            default:              return 6;
          }
        };
        const buildOsrmInstruction = (s) => {
          const m       = s.maneuver ?? {};
          const mtype   = (m.type ?? '').toLowerCase();
          const mod     = (m.modifier ?? '').toLowerCase();
          const street  = s.name || s.ref || '';
          const onto    = street ? ` onto ${street}` : '';
          const turnDir = mod ? mod.charAt(0).toUpperCase() + mod.slice(1) : '';
          switch (mtype) {
            case 'turn':          return `Turn ${mod || 'ahead'}${onto}`;
            case 'new name':      return street ? `Continue on ${street}` : 'Continue';
            case 'continue':      return street ? `Continue on ${street}` : 'Continue';
            case 'merge':         return `Merge${mod ? ' ' + mod : ''}${onto}`;
            case 'on ramp':       return `Take the ramp${mod ? ' ' + mod : ''}${onto}`;
            case 'off ramp':      return `Take the exit${mod ? ' ' + mod : ''}${onto}`;
            case 'fork':          return `Keep ${mod || 'straight'}${onto}`;
            case 'end of road':   return `${turnDir || 'Turn'}${onto}`;
            case 'roundabout':    return `Enter the roundabout${m.exit ? `, take exit ${m.exit}` : ''}${onto}`;
            case 'rotary':        return `Enter the rotary${m.exit ? `, take exit ${m.exit}` : ''}${onto}`;
            case 'exit roundabout':
            case 'exit rotary':   return `Exit the roundabout${onto}`;
            case 'uturn':         return `Make a U-turn${onto}`;
            case 'arrive':        return 'Arrive at destination';
            case 'depart':        return street ? `Head out on ${street}` : 'Head out';
            case 'notification':  return street ? `Continue on ${street}` : 'Continue';
            default:              return street ? `Continue on ${street}` : 'Continue';
          }
        };
        const fallbackSteps = route.legs?.[0]?.steps?.map((s) => ({
          instruction: buildOsrmInstruction(s),
          name:        s.name || '',
          distance:    s.distance,
          duration:    s.duration,
          type:        osrmTypeToOrs((s.maneuver?.type ?? '').toLowerCase(), s.maneuver?.modifier),
          way_points:  null,
        })) ?? [];
        stepEndIdxRef.current = buildStepEndIndices(fallbackSteps, rawCoords);
        if (routePolyRef.current) routePolyRef.current.remove();
        routePolyRef.current = L.polyline(leafletPts, { color: '#e07000', weight: 7, opacity: 0.88, dashArray: '10 6' })
          .addTo(mapObj.current);

        if (destMarkRef.current) destMarkRef.current.remove();
        destMarkRef.current = L.marker([dest[1], dest[0]], {
          icon: L.divIcon({ html: PIN_SVG, className: '', iconSize: [28,28], iconAnchor: [14,28] }),
        }).addTo(mapObj.current);

        mapObj.current?.fitBounds(routePolyRef.current.getBounds(), { padding: [80, 40] });
        setRouteSteps(fallbackSteps);
        setStepIdx(0);
        setStepDist(null);
        setRouteType('fallback');
        setRouteInfo({
          distance_km: (route.distance / 1000).toFixed(1),
          duration_min: Math.round(route.duration / 60),
        });
        setRouteError(`Truck routing failed (${orsError}). Showing standard road route - not optimized for trucks.`);
        setShowSearch(false);

        if (tripId) {
          saveRoute(tripId, {
            destination,
            dest_lat: dest[1],
            dest_lon: dest[0],
            route_steps: { coordinates: rawCoords },
            route_dist_m: Math.round(route.distance),
            route_dur_s: Math.round(route.duration),
          }).catch(() => {});
          try {
            sessionStorage.setItem('driver_route', JSON.stringify({
              trip_id: tripId,
              assignedDest: destination,
              coordinates: rawCoords,
              steps: fallbackSteps,
              destLat: dest[1],
              destLon: dest[0],
              dist_m: Math.round(route.distance),
              dur_s: Math.round(route.duration),
            }));
          } catch {  }
          assignedRouteKeyRef.current = `${tripId}:${destination}`;
        }
      } catch (fallbackError) {
        setRouteError(`${orsError}; fallback failed: ${fallbackError.message || 'Routing failed'}`);
      }
    }
    finally { setRouting(false); }
  }

  function selectSuggestion(s) {
    setDestination(s.label);
    setSuggestions([]);
    getRoute([s.lon, s.lat]);
  }

  // ?? Trip actions ?????????????????????????????????????????????
  async function handlePause() {
    setActing(true); setError('');
    try {
      await requestPause(tripId);
      setTripStatus('paused');
      // Hold the optimistic 'paused' for up to 30s while the LoRa downlink
      pendingStatusRef.current = { expected: 'paused', until: Date.now() + 30000 };
      pollAll();
    } catch (e) {
      if (e.code === 'HMI_PRIORITY') {
        console.log('[trip] pause rejected by HMI priority - syncing authoritative state');
        pollAll();
      } else {
        setError(e.message);
      }
    } finally { setActing(false); }
  }
  async function handleResume() {
    setActing(true); setError('');
    try {
      await requestResume(tripId);
      setTripStatus('active');
      pendingStatusRef.current = { expected: 'active', until: Date.now() + 30000 };
      pollAll();
    } catch (e) {
      if (e.code === 'HMI_PRIORITY') {
        console.log('[trip] resume rejected by HMI priority - syncing authoritative state');
        pollAll();
      } else {
        setError(e.message);
      }
    } finally { setActing(false); }
  }
  async function handleEnd() {
    if (!window.confirm('End this trip?')) return;
    setActing(true); setError('');
    setTripEndedMsg('Ending trip...');
    try {
      await requestEndTrip(tripId, phoneLocation?.lat ?? null, phoneLocation?.lon ?? null);
      clearTripFromSession();
      setTripEndedMsg('Trip Ended');
      setTimeout(() => navigate('/driver/notrip', { replace: true }), 1200);
    } catch (e) {
      setTripEndedMsg('');
      if (e.code === 'HMI_PRIORITY') {
        console.log('[trip] end rejected by HMI priority - syncing authoritative state');
        pollAll();
      } else {
        setError(e.message);
      }
    } finally { setActing(false); }
  }

  // ?? Derived ???????????????????????????????????????????????????
  const speed        = telemetry?.speed ?? null;
  const fuel         = telemetry?.fuel_level ?? null;
  const isOverspeed  = speed != null && speed > OVERSPEED_KMH;
  const chan         = (() => {
    const raw = telemetry?.channel_used ?? (isHmiTrip ? 'cellular' : 'mobile');
    return raw === 'gsm' || raw === 'lte' ? 'cellular' : raw;
  })();
  const currentStep  = routeSteps[stepIdx];
  const upcomingStep = routeSteps[stepIdx + 1] ?? currentStep;
  const hasRoute     = routeSteps.length > 0;
  const localAlerts = [
    isHmiTrip && !hmiOnline && { id: '__hmi', alert_type: 'hmi_disconnected', severity: 'high', message: 'HMI disconnected - waiting for embedded device' },
    connState !== 'online' && { id: '__conn', alert_type: 'connectivity_offline', severity: 'medium', message: 'Reconnecting - trip data may be out of date' },
    geoStatus !== 'ready' && geoStatus !== 'locating' && { id: '__gps', alert_type: 'gps_unavailable', severity: 'medium', message: geoError || 'Phone GPS unavailable' },
    telemetry && !telemetry.lat && !telemetry.lon && { id: '__embedded_gps', alert_type: 'embedded_gps_unavailable', severity: 'medium', message: 'embedded_gps unavailable' },
    telemetry && fuel == null && { id: '__fuel', alert_type: 'obd_fuel_unavailable', severity: 'low', message: 'OBD2 fuel unavailable' },
    telemetry && speed == null && { id: '__speed_missing', alert_type: 'obd_speed_unavailable', severity: 'low', message: 'OBD2 speed unavailable' },
  ].filter(Boolean);
  const backendAlerts = alerts.map(normalizeDriverAlert);
  const allAlerts = [...localAlerts, ...backendAlerts].filter(a => !dismissed.has(a.id));
  const driverAlertTypes = [
    'rest_alert', 'snooze_alert', 'maintenance', 'overspeed', 'fuel_anomaly',
    'connectivity_offline', 'connectivity_syncing', 'force_ended',
    'gps_unavailable', 'embedded_gps_unavailable', 'obd_unavailable',
    'obd_fuel_unavailable', 'obd_speed_unavailable', 'hmi_disconnected',
  ];
  const urgentAlerts = allAlerts.filter(a => a.severity === 'high' || driverAlertTypes.includes(a.alert_type));
  const SHEET_H      = sheetOpen
    ? Math.min(Math.max(240, Math.floor(viewportH * 0.52)), 400)
    : Math.min(Math.max(116, Math.floor(viewportH * 0.18)), 148);


  const topAlert = isOverspeed
    ? { id: '__speed', msg: `? OVERSPEED - ${Math.round(speed)} km/h (limit ${OVERSPEED_KMH})`, bg: '#b00020', dismissible: false }
    : urgentAlerts[0]
    ? { id: urgentAlerts[0].id, msg: urgentAlerts[0].message, bg: '#b00020', dismissible: true }
    : zoneWarning
    ? { id: '__zone', msg: zoneWarning, bg: '#7a4d00', dismissible: true }
    : geoError
    ? { id: '__geo',  msg: `mobile_gps: ${geoError}`, bg: '#444422', dismissible: false }
    : geoStatus === 'locating'
    ? { id: '__geo_loading', msg: 'mobile_gps: Locating...', bg: '#26384f', dismissible: false }
    : null;

  function dismissTop() {
    if (!topAlert) return;
    if (topAlert.id === '__zone') setZoneWarning('');
    else if (topAlert.id !== '__speed' && topAlert.id !== '__geo')
      setDismissed(s => new Set(s).add(topAlert.id));
  }

  return (
    <div style={S.root}>
      <style>{`@keyframes toastIn { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }`}</style>

      {}
      {tripEndedMsg && (
        <div style={S.tripEndedOverlay}>
          <div style={S.tripEndedCard}>
            <div style={S.tripEndedIcon}>?</div>
            <div style={S.tripEndedTitle}>Trip Ended</div>
            <div style={S.tripEndedSub}>{tripEndedMsg}</div>
            <div style={S.tripEndedNote}>Returning to truck selection...</div>
          </div>
        </div>
      )}

      {}
      {
}
      <div ref={mapWrapperRef} style={S.mapWrapper}>
        <div ref={mapRef} style={{ position: 'absolute', inset: 0 }} />
      </div>

      {}
      {followMode && heading !== null && (
        <div style={S.compass}>
          <div style={{ transform: `rotate(${heading}deg)`, lineHeight: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0 }}>
            <span style={{ color: '#e53935', fontSize: 11, fontWeight: 800, lineHeight: 1 }}>?</span>
            <span style={{ color: '#ffffff', fontSize: 8, fontWeight: 700, lineHeight: 1, marginTop: 1 }}>N</span>
          </div>
        </div>
      )}

      {}
      <div style={S.banner}>
        {hasRoute && upcomingStep ? (
          <>
            <div style={S.bannerIcon}>
              {turnIcon(upcomingStep.type === 11 ? departHeadingType(upcomingStep.instruction ?? upcomingStep.name ?? '') : upcomingStep.type)}
            </div>
            <div style={S.bannerBody}>
              <div style={S.bannerStreet}>{upcomingStep.instruction || upcomingStep.name || 'Continue'}</div>
              {stepDist != null && <div style={S.bannerSub}>{fmtDist(stepDist)} to next turn{upcomingStep.name ? ` . ${upcomingStep.name}` : ''}</div>}
            </div>
            {routeInfo && (
              <div style={S.etaBox}>
                <div style={S.etaKm}>{routeInfo.distance_km} km</div>
              </div>
            )}
          </>
        ) : (
          <>
            <div style={S.bannerIcon}>
              <span style={{ display:'inline-block', width:14, height:14, borderRadius:'50%', background: tripStatus === 'active' ? '#00e676' : '#FFB020', verticalAlign:'middle' }} />
            </div>
            <div style={S.bannerBody}>
              <div style={S.bannerStreet}>
                {trip?.assigned_destination
                  ? `-> ${trip.assigned_destination}`
                  : truckCode}
              </div>
              <div style={S.bannerSub}>{sess?.full_name ?? 'Driver'}{heading !== null ? ` . ${Math.round(heading)}deg` : ''}</div>
            </div>
            <div style={{ ...S.connDot, background: connState === 'online' ? '#00e676' : '#ff5252' }} />
          </>
        )}
      </div>

      {}
      {topAlert && (
        <div style={{ ...S.alertStrip, background: topAlert.bg }}>
          <span>{topAlert.msg}</span>
          {topAlert.dismissible && (
            <button style={S.alertX} onClick={dismissTop}>?</button>
          )}
        </div>
      )}

      {}
      {toasts.length > 0 && (
        <div style={{ ...S.toastStack, bottom: SHEET_H + 10 }}>
          {toasts.slice(-3).map(t => (
            <div key={t.key} style={{ ...S.toast, background: t.bg }}>
              <span style={S.toastIcon}>
                {t.severity === 'high' ? <AlertOctagon size={15} /> : t.severity === 'medium' ? <AlertTriangle size={15} /> : <Info size={15} />}
              </span>
              <span style={S.toastMsg}>{t.msg}</span>
            </div>
          ))}
        </div>
      )}

      {}
      {isHmiTrip && !hmiOnline && (
        <div style={S.hmiDisconnBanner}>
          Waiting for embedded telemetry...
        </div>
      )}

      {}
      {speed != null && (
        <div style={{ ...S.speedBox, background: isOverspeed ? '#b00020' : '#0044aa', bottom: SHEET_H + 14 }}>
          <div style={S.speedNum}>{Math.round(speed)}</div>
          <div style={S.speedUnit}>km/h</div>
        </div>
      )}

      {}
      {}
      <button
        style={{ ...S.fab, bottom: SHEET_H + 74, right: 14, background: followMode ? '#1565c0' : '#1a3460' }}
        onClick={() => {
          setFollowMode(true);
          if (phoneLocation) mapObj.current?.flyTo([phoneLocation.lat, phoneLocation.lon], 17, { duration: 0.6 });
        }}
        title="Re-center on driver"
      >?</button>
      <button
        style={{ ...S.fab, bottom: SHEET_H + 14, right: 14 }}
        onClick={() => setShowSearch(true)}
        title="Search destination"
      >?</button>

      {}
      {showSearch && (
        <div style={S.searchPanel}>
          <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
          {}
          <div style={S.searchBar}>
            <button style={S.searchBack} onClick={() => { setShowSearch(false); clearSearch(); }}>
              <-
            </button>
            <div style={S.searchField}>
              <span style={S.searchIcon}>?</span>
              <input
                style={S.searchInput}
                placeholder="Search destination"
                value={destination}
                onChange={onSearchInput}
                onKeyDown={e => e.key === 'Enter' && getRoute()}
                autoFocus
              />
              {destination && (
                <button style={S.searchClear} onClick={clearSearch}>?</button>
              )}
            </div>
          </div>

          {}
          {routeInfo && !routing && (
            <>
              <div style={S.routeSummaryBar}>
                <span style={{
                  ...S.routeTypeBadge,
                  background: routeType === 'hgv' ? '#0d2b5a' : '#3a1a00',
                  color:      routeType === 'hgv' ? '#82B7DC' : '#FFB020',
                  border:     routeType === 'hgv' ? '1px solid #1565c0' : '1px solid #e07000',
                }}>
                  {routeType === 'hgv' ? '? Truck Route (HGV)' : '? Fallback Route (Standard)'}
                </span>
                <span style={S.routeSummaryMain}>{routeInfo.distance_km} km</span>
              </div>
              {routeType === 'fallback' && routeError && (
                <div style={{ background: '#2a1200', borderBottom: '1px solid #e07000', padding: '6px 16px', fontSize: 11, color: '#FFB020', wordBreak: 'break-all' }}>
                  ORS reason: {routeError.replace(/^Truck routing failed \(/, '').replace(/\)\. Showing.*$/, '')}
                </div>
              )}
            </>
          )}

          {}
          {routing && (
            <div style={S.routingRow}>
              <span style={S.routingLabel}>Finding truck route...</span>
            </div>
          )}

          {routeError && <div style={S.drawerErr}>{routeError}</div>}
          {acError    && <div style={S.drawerErr}>{acError}</div>}

          {}
          {suggestions.length > 0 && !routing && (
            <div style={S.suggList}>
              {suggestions.map((s, i) => (
                <button
                  key={i}
                  style={S.suggItem}
                  onClick={() => selectSuggestion(s)}
                >
                  <span style={S.suggPin}><MapPin size={14} /></span>
                  <div style={S.suggText}>
                    <div style={S.suggName}>{s.name}</div>
                    <div style={S.suggLocality}>{s.locality}</div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {}
          {acLoading && suggestions.length === 0 && (
            <div style={S.acLoading}>Searching...</div>
          )}
          {!acLoading && !acError && !routing && suggestions.length === 0 && destination.trim().length > 1 && (
            <div style={S.acNoResults}>No results found - try a more specific name</div>
          )}

          {}
          <div style={S.dimChip}>
            <Truck size={13} style={{verticalAlign:'middle',marginRight:4}} />
            {truckDims.length}m . H {truckDims.height}m . {truckDims.weight}t . HGV route
          </div>
        </div>
      )}

      {}
      <div style={{ ...S.sheet, height: SHEET_H }}>
        {}
        <div style={S.handle} onClick={() => setSheetOpen(v => !v)}>
          <div style={S.handleBar} />
          <div style={S.handleRow}>
            <div style={S.timerBlock}>
              <span style={S.timer}>{fmtTimer(elapsed)}</span>
              <div style={S.timerSubs}>
                <span style={{ ...S.timerSubChip, color: '#9EB0C0' }}>Op {fmtTimer(opMs)}</span>
                {restMs > 0 && <span style={{ ...S.timerSubChip, color: '#FFB020' }}>Rest {fmtTimer(restMs)}</span>}
              </div>
            </div>
            <span style={{ ...S.sheetStatus, display:'inline-flex', alignItems:'center', gap:5 }}>
              <span style={{ display:'inline-block', width:8, height:8, borderRadius:'50%', background: tripStatus === 'paused' ? '#FFB020' : '#00e676' }} />
              {tripStatus === 'paused' ? 'RESTING' : 'ACTIVE'}
            </span>
            <span style={S.sheetHint}>{sheetOpen ? '?' : '?'}</span>
          </div>
        </div>

        {}
        <div style={S.chips}>
          {}
          {trip?.next_rest_alert_at && tripStatus === 'active' && (
            restCountdownMs === null ? (
              <div style={{ ...S.chip, borderColor: '#194D84', background: '#112240', flexShrink: 0, opacity: 0.6 }}>
                <span style={{ fontSize: 9, color: '#9EB0C0', letterSpacing: 0.5 }}>REST IN</span>
                <span style={{ color: '#82B7DC', fontVariantNumeric: 'tabular-nums' }}>...</span>
              </div>
            ) : restCountdownMs > 0 ? (
              <div style={{ ...S.chip, borderColor: restCountdownMs < 30 * 60 * 1000 ? '#7a3d00' : '#194D84', background: restCountdownMs < 30 * 60 * 1000 ? '#2d1600' : '#112240', flexShrink: 0 }}>
                <span style={{ fontSize: 9, color: restCountdownMs < 30 * 60 * 1000 ? '#FFB020' : '#9EB0C0', letterSpacing: 0.5 }}>REST IN</span>
                <span style={{ color: restCountdownMs < 30 * 60 * 1000 ? '#FFB020' : '#82B7DC', fontVariantNumeric: 'tabular-nums' }}>
                  {fmtCountdown(restCountdownMs)}
                </span>
              </div>
            ) : (
              <div style={{ ...S.chip, borderColor: '#cc3333', background: '#2d0000', flexShrink: 0 }}>
                <span style={{ fontSize: 9, color: '#ff6b6b', letterSpacing: 0.5 }}>REST</span>
                <span style={{ color: '#ff6b6b', fontWeight: 800 }}>NOW</span>
              </div>
            )
          )}
          {fuel != null && (
            <div style={{ ...S.chip, borderColor: fuel < 20 ? '#cc3333' : '#194D84' }}>
              <Fuel size={13} />
              <span style={{ color: fuel < 20 ? '#ff6b6b' : '#82B7DC' }}>{fuel.toFixed(0)}%</span>
            </div>
          )}
          {speed != null && (
            <div style={{ ...S.chip, borderColor: isOverspeed ? '#cc3333' : '#194D84' }}>
              <Gauge size={13} />
              <span style={{ color: isOverspeed ? '#ff6b6b' : '#82B7DC' }}>{Math.round(speed)}</span>
            </div>
          )}
          <div style={S.chip}>
            <Radio size={12} /><span style={{ fontSize: 10 }}>{chan}</span>
          </div>
          <div style={{ ...S.chip, borderColor: connState === 'online' ? '#194D84' : '#cc3333' }}>
            <span style={{ fontSize: 9, color: connState === 'online' ? '#22CC66' : '#ff6b6b' }}>
              {connState === 'online' ? '? ON' : '? OFF'}
            </span>
          </div>
        </div>

        {}
        <div style={S.btns}>
          {tripStatus === 'active'
            ? <button style={{ ...S.btn, background: '#e07000', display:'flex', alignItems:'center', justifyContent:'center', gap:6 }} disabled={acting || (isHmiTrip && !hmiOnline)} onClick={handlePause}><Pause size={15} /> Take Rest</button>
            : <button style={{ ...S.btn, background: '#009950', display:'flex', alignItems:'center', justifyContent:'center', gap:6 }} disabled={acting || (isHmiTrip && !hmiOnline)} onClick={handleResume}><Play size={15} /> Resume</button>
          }
          <button style={{ ...S.btn, background: '#cc0033', display:'flex', alignItems:'center', justifyContent:'center', gap:6 }} disabled={acting || (isHmiTrip && !hmiOnline)} onClick={handleEnd}><Square size={13} /> End Trip</button>
        </div>

        {}
        {sheetOpen && (
          <div style={S.expanded}>
            {error && <p style={S.errorTxt}>{error}</p>}

            {}
            {trip?.next_rest_alert_at && (
              <div style={S.restBlock}>
                {trip?.next_rest_alert_at && tripStatus === 'active' && (
                  <div style={S.restRow}>
                    <span style={{ color: restCountdownMs !== null && restCountdownMs <= 0 ? '#ff6b6b' : restCountdownMs !== null && restCountdownMs < 30 * 60 * 1000 ? '#FFB020' : '#9EB0C0', fontSize: 12 }}>
                      {restCountdownMs === null
                        ? <span style={{display:'flex',alignItems:'center',gap:4}}><Timer size={11}/> Next rest in</span>
                        : restCountdownMs <= 0
                          ? <span style={{display:'flex',alignItems:'center',gap:4}}><AlertOctagon size={11}/> Rest overdue!</span>
                          : <span style={{display:'flex',alignItems:'center',gap:4}}><Timer size={11}/> Next rest in</span>}
                    </span>
                    <span style={{ color: restCountdownMs !== null && restCountdownMs <= 0 ? '#ff6b6b' : '#FFB020', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                      {restCountdownMs === null ? '...' : restCountdownMs > 0 ? fmtCountdown(restCountdownMs) : 'NOW'}
                    </span>
                  </div>
                )}
              </div>
            )}

            {}
            {allAlerts.slice(0, 4).map(a => (
              <div key={a.id} style={S.minorRow}>
                <span style={S.minorIcon}>{a.severity === 'high' ? <AlertOctagon size={14} color="#ff6b6b" /> : a.severity === 'medium' ? <AlertTriangle size={14} color="#FFB020" /> : <Info size={14} color="#82B7DC" />}</span>
                <span style={S.minorMsg}>{a.message}</span>
                <button style={S.alertX} onClick={() => setDismissed(s => new Set(s).add(a.id))}>?</button>
              </div>
            ))}

            {}
            <div style={S.diagGrid}>
              <div style={S.diagCell}>
                <span style={{ ...S.diagLabel, display:'inline-flex', alignItems:'center', gap:3 }}><Fuel size={11}/> Fuel</span>
                <span style={{ ...S.diagVal, color: fuel != null && fuel < 20 ? '#ff6b6b' : '#F7F7F7' }}>
                  {fuel != null ? `${fuel.toFixed(0)}%` : '-'}
                </span>
                {fuel != null && (
                  <div style={S.fuelBar}>
                    <div style={{ ...S.fuelFill, width: `${Math.min(fuel, 100)}%`, background: fuel < 20 ? '#ff4444' : fuel < 50 ? '#ffaa00' : '#00c853' }} />
                  </div>
                )}
              </div>
              <div style={S.diagCell}>
                <span style={{ ...S.diagLabel, display:'inline-flex', alignItems:'center', gap:3 }}><Gauge size={11}/> Speed</span>
                <span style={{ ...S.diagVal, color: isOverspeed ? '#ff6b6b' : '#F7F7F7' }}>
                  {speed != null ? `${Math.round(speed)} km/h` : '-'}
                </span>
              </div>
              <div style={S.diagCell}>
                <span style={{ ...S.diagLabel, display:'inline-flex', alignItems:'center', gap:3 }}><MapPin size={11}/> Phone GPS</span>
                <span style={{ ...S.diagVal, color: phoneLocation ? '#007a30' : '#888' }}>
                  {phoneLocation ? `+/-${Math.round(phoneLocation.accuracy)}m` : geoStatus === 'locating' ? 'Locating...' : 'No fix'}
                </span>
              </div>
              <div style={S.diagCell}>
                <span style={{ ...S.diagLabel, display:'inline-flex', alignItems:'center', gap:3 }}><Radio size={11}/> Device GPS</span>
                <span style={{ ...S.diagVal, color: (telemetry?.lat && telemetry?.lon) ? '#5599cc' : '#aaa' }}>
                  {(telemetry?.lat && telemetry?.lon) ? 'Active' : 'No fix'}
                </span>
              </div>
              <div style={S.diagCell}>
                <span style={S.diagLabel}>Distance</span>
                <span style={S.diagVal}>{((trip?.distance_km ?? 0)).toFixed(1)} km</span>
              </div>
              <div style={S.diagCell}>
                <span style={{ ...S.diagLabel, display:'inline-flex', alignItems:'center', gap:3 }}><Timer size={11}/> Trip time</span>
                <span style={S.diagVal}>{fmtTimer(elapsed)}</span>
              </div>
              <div style={S.diagCell}>
                <span style={{ ...S.diagLabel, display:'inline-flex', alignItems:'center', gap:3 }}><Plug2 size={11}/> Channel</span>
                <span style={S.diagVal}>{chan}</span>
              </div>
              <div style={S.diagCell}>
                <span style={{ ...S.diagLabel, display:'inline-flex', alignItems:'center', gap:3 }}><Battery size={11}/> Engine</span>
                <span style={{ ...S.diagVal, color: telemetry?.engine_status === 'on' ? '#007a30' : '#888' }}>
                  {telemetry?.engine_status ?? '-'}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const S = {
  root: {
    position: 'relative', width: '100%', minWidth: 0, height: '100dvh',
    background: '#0a1a30', overflow: 'hidden', overflowX: 'hidden', color: '#F7F7F7',
    fontFamily: 'system-ui, -apple-system, sans-serif', userSelect: 'none',
    touchAction: 'manipulation', overscrollBehavior: 'none',
  },
  mapWrapper: {
    position: 'absolute',
    top: '-25%', left: '-25%',
    width: '150%', height: '150%',
    zIndex: 0,
    transformOrigin: 'center center',
    transition: 'transform 0.4s ease',
    willChange: 'transform',
  },
  compass: {
    position: 'absolute', zIndex: 20,
    top: 80, right: 14,
    width: 36, height: 36, borderRadius: '50%',
    background: '#0d1f3ccc', border: '1px solid #346AA8',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    pointerEvents: 'none',
  },

  // Top banner
  banner: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 20,
    background: '#194D84', color: '#F7F7F7',
    display: 'flex', alignItems: 'center', gap: 'clamp(8px, 2.8vw, 12px)',
    padding: 'clamp(9px, 2.8vw, 12px) clamp(10px, 3.6vw, 16px)',
    paddingTop: 'max(clamp(9px, 2.8vw, 12px), env(safe-area-inset-top))',
    minHeight: 'clamp(58px, 15vw, 72px)', boxShadow: '0 3px 16px rgba(0,0,0,0.6)',
  },
  bannerIcon:   { flexShrink: 0, width: 'clamp(30px, 9vw, 38px)', display:'flex', alignItems:'center', justifyContent:'center', color:'#F7F7F7' },
  bannerBody:   { flex: 1, minWidth: 0 },
  bannerStreet: { fontSize: 'clamp(15px, 4.8vw, 19px)', fontWeight: 700, lineHeight: 1.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  bannerSub:    { fontSize: 'clamp(11px, 3.5vw, 13px)', opacity: 0.8, marginTop: 2 },
  etaBox:       { textAlign: 'right', flexShrink: 0 },
  etaTime:      { fontSize: 15, fontWeight: 700 },
  etaKm:        { fontSize: 11, opacity: 0.8 },
  connDot:      { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },

  // Alert strip
  alertStrip: {
    position: 'absolute',
    top: 'calc(clamp(50px, 14vw, 64px) + env(safe-area-inset-top))',
    left: 0, right: 0, zIndex: 19,
    padding: 'clamp(7px, 2.5vw, 10px) clamp(12px, 4vw, 16px)', fontSize: 'clamp(11px, 3.4vw, 13px)', fontWeight: 700, color: '#F7F7F7',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  },
  alertX: { background: 'none', border: 'none', color: '#9EB0C0', fontSize: 18, cursor: 'pointer', padding: '0 4px' },
  hmiDisconnBanner: {
    position: 'absolute',
    top: 'calc(clamp(50px, 14vw, 64px) + env(safe-area-inset-top) + clamp(34px, 10vw, 40px))',
    left: 0, right: 0, zIndex: 18,
    background: '#1a2e4a',
    padding: 'clamp(5px, 1.8vw, 8px) clamp(12px, 4vw, 16px)',
    fontSize: 'clamp(11px, 3.2vw, 12px)', fontWeight: 500, color: '#7ba3c8',
    textAlign: 'center',
  },

  // Speed overlay
  speedBox: {
    position: 'absolute', left: 'max(10px, env(safe-area-inset-left))', zIndex: 15,
    borderRadius: 12, padding: 'clamp(6px, 2.2vw, 8px) clamp(10px, 3vw, 14px)', textAlign: 'center', minWidth: 'clamp(54px, 16vw, 66px)',
    boxShadow: '0 2px 12px rgba(0,0,0,0.7)', transition: 'bottom 0.3s ease',
  },
  speedNum:  { fontSize: 'clamp(21px, 7vw, 28px)', fontWeight: 800, color: '#F7F7F7', lineHeight: 1 },
  speedUnit: { fontSize: 9, color: '#82B7DC', letterSpacing: 1, marginTop: 2 },

  // FAB buttons
  fab: {
    position: 'absolute', zIndex: 15,
    width: 'clamp(44px, 12vw, 52px)', height: 'clamp(44px, 12vw, 52px)', borderRadius: 26,
    background: '#1a3460', border: '1px solid #346AA8', cursor: 'pointer',
    fontSize: 20, color: '#82B7DC', fontWeight: 600,
    boxShadow: '0 2px 12px rgba(0,0,0,0.6)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'bottom 0.3s ease', touchAction: 'manipulation',
  },

  // Search panel
  searchPanel: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 30,
    width: 'min(100%, 720px)', margin: '0 auto',
    maxHeight: '100dvh', overflowY: 'auto',
    background: '#0d1f3c', boxShadow: '0 4px 24px rgba(0,0,0,0.7)',
    display: 'flex', flexDirection: 'column',
    paddingTop: 'env(safe-area-inset-top)',
  },
  searchBar: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: 'clamp(8px, 2.8vw, 12px) clamp(10px, 3.5vw, 14px)',
    borderBottom: '1px solid #194D84',
  },
  searchBack: {
    width: 'clamp(38px, 11vw, 44px)', height: 'clamp(38px, 11vw, 44px)', borderRadius: 22, border: 'none',
    background: 'none', fontSize: 20, cursor: 'pointer',
    color: '#82B7DC', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    touchAction: 'manipulation',
  },
  searchField: {
    flex: 1, display: 'flex', alignItems: 'center', gap: 8,
    background: '#112240', borderRadius: 24, padding: '0 clamp(10px, 3.5vw, 14px)', height: 'clamp(42px, 12vw, 48px)',
  },
  searchIcon:  { fontSize: 15, color: '#82B7DC', flexShrink: 0 },
  searchInput: {
    flex: 1, minWidth: 0, border: 'none', background: 'none', fontSize: 'clamp(15px, 4vw, 16px)', color: '#F7F7F7',
    outline: 'none', padding: '0',
  },
  searchClear: {
    background: 'none', border: 'none', color: '#808080', fontSize: 16,
    cursor: 'pointer', flexShrink: 0, padding: '0 2px', touchAction: 'manipulation',
  },
  // Route summary bar
  routeSummaryBar: {
    display: 'flex', alignItems: 'center', gap: 'clamp(6px, 2vw, 12px)', flexWrap: 'wrap',
    padding: '8px clamp(12px, 4vw, 16px)', background: '#112240', borderBottom: '1px solid #194D84',
    fontSize: 13,
  },
  routeTypeBadge: { fontSize: 10, fontWeight: 700, borderRadius: 6, padding: '2px 7px', letterSpacing: 0.3, flexShrink: 0 },
  routeSummaryMain: { fontWeight: 700, color: '#82B7DC' },
  routeSummaryMid:  { color: '#9EB0C0' },
  routeSummaryEta:  { marginLeft: 'auto', color: '#82B7DC', fontWeight: 600 },
  // Routing spinner
  routingRow:    { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', color: '#9EB0C0' },
  routingSpinner:{ fontSize: 18, animation: 'spin 1s linear infinite' },
  routingLabel:  { fontSize: 13 },
  drawerErr: { color: '#ff6b6b', fontSize: 12, padding: '8px 16px' },
  // Suggestions list
  suggList: { maxHeight: 'min(62dvh, 520px)', overflowY: 'auto', WebkitOverflowScrolling: 'touch' },
  suggItem: {
    width: '100%', display: 'flex', alignItems: 'center', gap: 14,
    padding: 'clamp(12px, 3.8vw, 15px) clamp(14px, 4vw, 18px)', background: 'none', border: 'none',
    borderBottom: '1px solid #1a3460', cursor: 'pointer', textAlign: 'left',
    touchAction: 'manipulation',
  },
  suggPin:      { flexShrink: 0, color: '#82B7DC', display:'flex', alignItems:'center' },
  suggText:     { flex: 1, minWidth: 0 },
  suggName:     { fontSize: 14, fontWeight: 500, color: '#F7F7F7', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  suggLocality: { fontSize: 12, color: '#808080', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  acLoading:    { padding: '12px 16px', fontSize: 13, color: '#808080' },
  acNoResults:  { padding: '14px 16px', fontSize: 13, color: '#808080', textAlign: 'center' },
  // Dims chip
  dimChip: { padding: '8px 16px', fontSize: 10, color: '#808080', borderTop: '1px solid #1a3460' },

  // Bottom sheet
  sheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 20,
    width: 'min(100%, 720px)', margin: '0 auto',
    background: '#0d1f3c', borderRadius: '20px 20px 0 0',
    boxShadow: '0 -4px 32px rgba(0,0,0,0.7)',
    transition: 'height 0.3s ease', overflow: 'hidden',
    paddingBottom: 'max(8px, env(safe-area-inset-bottom))',
  },
  handle:       { padding: '8px 16px 2px', cursor: 'pointer' },
  handleBar:    { width: 40, height: 4, background: '#346AA8', borderRadius: 2, margin: '0 auto 6px' },
  handleRow:    { display: 'flex', alignItems: 'center', gap: 10 },
  timerBlock:   { display: 'flex', flexDirection: 'column', gap: 2 },
  timer:        { fontSize: 'clamp(19px, 6vw, 25px)', fontWeight: 700, fontVariantNumeric: 'tabular-nums', letterSpacing: 1, color: '#F7F7F7' },
  timerSubs:    { display: 'flex', gap: 8, alignItems: 'center' },
  timerSubChip: { fontSize: 10, fontWeight: 600, borderRadius: 6, padding: '2px 6px', background: '#112240', color: '#82B7DC' },
  sheetStatus:  { fontSize: 12, color: '#82B7DC' },
  sheetHint:    { marginLeft: 'auto', fontSize: 11, color: '#808080' },

  chips: { display: 'flex', gap: 6, padding: '4px 14px', overflowX: 'auto', WebkitOverflowScrolling: 'touch' },
  chip:  { display: 'flex', gap: 4, alignItems: 'center', flex: '0 0 auto', background: '#112240', border: '1px solid #194D84', borderRadius: 8, padding: '5px clamp(8px, 2.8vw, 10px)', fontSize: 'clamp(12px, 3.5vw, 13px)', fontWeight: 600, color: '#82B7DC' },

  btns: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 'clamp(8px, 3vw, 12px)', padding: '8px 14px 0' },
  btn:  { minWidth: 0, minHeight: 48, padding: 'clamp(12px, 3.8vw, 15px) 6px', fontSize: 'clamp(14px, 4vw, 16px)', fontWeight: 700, borderRadius: 12, border: 'none', color: '#fff', cursor: 'pointer', touchAction: 'manipulation' },

  expanded:  { padding: '4px 14px 8px', maxHeight: '200px', overflowY: 'auto', WebkitOverflowScrolling: 'touch' },
  errorTxt:  { color: '#ff6b6b', fontSize: 12, margin: '2px 0 6px' },
  restBlock: { background: '#0a1a2a', border: '1px solid #2a3a00', borderRadius: 8, padding: '8px 10px', marginBottom: 6, display: 'flex', flexDirection: 'column', gap: 6 },
  restRow:   { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  minorRow:  { display: 'flex', alignItems: 'center', background: '#1a2800', border: '1px solid #4a5a00', borderLeft: '3px solid #88a000', borderRadius: 6, padding: '6px 10px', marginBottom: 4, gap: 6 },
  minorIcon: { flexShrink: 0, display:'flex', alignItems:'center' },
  minorMsg:  { fontSize: 12, color: '#d0e080', flex: 1 },
  miniAction:{ border: '1px solid #346AA8', background: '#112240', color: '#82B7DC', borderRadius: 7, padding: '5px 8px', fontSize: 11, fontWeight: 700, flexShrink: 0 },

  // Diagnostics grid
  diagGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px 8px', marginTop: 8, padding: '8px', background: '#0a1a30', borderRadius: 10, border: '1px solid #194D84' },
  diagCell: { display: 'flex', flexDirection: 'column', gap: 2 },
  diagLabel:{ fontSize: 9, color: '#808080', textTransform: 'uppercase', letterSpacing: 0.5 },
  diagVal:  { fontSize: 'clamp(12px, 3.5vw, 13px)', fontWeight: 700, color: '#F7F7F7' },
  fuelBar:  { height: 3, background: '#1a3460', borderRadius: 2, overflow: 'hidden', marginTop: 2 },
  fuelFill: { height: '100%', borderRadius: 2, transition: 'width 0.5s ease' },

  // Toast notifications
  toastStack: { position: 'absolute', left: 12, right: 12, zIndex: 22, display: 'flex', flexDirection: 'column', gap: 6, pointerEvents: 'none' },
  toast: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 12, boxShadow: '0 4px 16px rgba(0,0,0,0.7)', animation: 'toastIn 0.25s ease' },
  toastIcon: { flexShrink: 0, display:'flex', alignItems:'center', color:'#F7F7F7' },
  toastMsg:  { fontSize: 'clamp(12px, 3.5vw, 14px)', fontWeight: 600, color: '#F7F7F7', lineHeight: 1.3 },

  // Trip ended full-screen overlay
  tripEndedOverlay: { position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 },
  tripEndedCard: { background: '#0d1f3c', border: '2px solid #cc0033', borderRadius: 20, padding: '36px 28px', textAlign: 'center', maxWidth: 340, width: '100%', boxShadow: '0 8px 40px rgba(200,0,0,0.4)' },
  tripEndedIcon: { fontSize: 48, color: '#cc0033', marginBottom: 12 },
  tripEndedTitle: { fontSize: 28, fontWeight: 800, color: '#F7F7F7', marginBottom: 8 },
  tripEndedSub: { fontSize: 15, color: '#ff6b6b', marginBottom: 16 },
  tripEndedNote: { fontSize: 13, color: '#808080' },
};
