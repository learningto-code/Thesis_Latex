const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Allow only the configured frontend origin.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'http://localhost:5173')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.some(o => origin === o || origin.startsWith('http://localhost:'))) return cb(null, true);
    cb(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Key'],
  credentials: true,
}));
app.use(express.json());

// SIMCom A7670E firmware A131B02A7670M6C_M reports HTTP 200 for chunked
app.use((req, res, next) => {
  if (req.query?.a7670e !== '1') return next();

  res.json = function sendA7670eJson(body) {
    const payload = Buffer.from(JSON.stringify(body));
    this.set({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(payload.length),
      'Cache-Control': 'no-store, no-transform',
      'Content-Encoding': 'identity',
      'Connection': 'close',
      'X-A7670E-Compatible': '1',
    });
    this.removeHeader('Transfer-Encoding');
    return this.end(payload);
  };

  next();
});

const ML_BASE_URL = (process.env.ML_SERVICE_URL || 'http://localhost:5001').replace(/\/+$/, '');
const ML_HEALTH_URL = `${ML_BASE_URL}/health`;
const ML_DETECT_URL = `${ML_BASE_URL}/detect`;
const ML_AUTOSPAWN  = !process.env.ML_SERVICE_URL; // only spawn Python locally
console.log(`[ml] base URL = ${ML_BASE_URL} (autospawn=${ML_AUTOSPAWN})`);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY
);

const HMI_STALE_MS          = 120_000;  // 2 min - dashboard online/offline display
const MOBILE_LOGIN_STALE_MS = 300_000;  // 5 min - GSM-resilient mobile login gate
const GPS_FRESH_MS          = Number(process.env.GPS_FRESH_MS ?? 15_000);
const GPS_MERGE_WINDOW_MS   = Number(process.env.GPS_MERGE_WINDOW_MS ?? 5_000);
const LOG_GPS_FUSION_WINDOW_MS = Number(process.env.LOG_GPS_FUSION_WINDOW_MS ?? 15_000);

function isValidGpsPoint(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  return Number.isFinite(la) && Number.isFinite(lo) &&
    !(Math.abs(la) < 0.000001 && Math.abs(lo) < 0.000001) &&
    la >= -90 && la <= 90 && lo >= -180 && lo <= 180;
}

function gpsDistanceM(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// ?????????????????????????????????????????????????????????????
const NAV_ADVANCE_THRESHOLD_M = 30;   // within this of step end -> advance
const NAV_ARRIVAL_THRESHOLD_M = 40;   // within this of dest -> nav_state='arrived'

async function advanceNavFromHmiGps({ trip_id, lat, lon }) {
  if (!trip_id || lat == null || lon == null) return;
  if (!isValidGpsPoint(lat, lon)) return;

  try {
    const { data: trip } = await supabase
      .from('trip_sessions')
      .select('route_steps, nav_current_step_index, dest_lat, dest_lon, trip_status, nav_state')
      .eq('id', trip_id)
      .maybeSingle();

    if (!trip || !trip.route_steps) return;
    if (trip.trip_status !== 'active') return;
    if (trip.nav_state === 'arrived') return;

    const route = trip.route_steps;
    const coords = route.coordinates;
    const steps  = route.steps;
    if (!Array.isArray(coords) || coords.length === 0) return;
    if (!Array.isArray(steps)  || steps.length  === 0) return;

    // is heading toward before the next turn fires).
    const stepEndCoord = (step) => {
      const wp = step?.way_points;
      if (Array.isArray(wp) && wp.length >= 2 && coords[wp[1]]) return coords[wp[1]];
      return coords[coords.length - 1] ?? null;
    };

    let curIdx = Number.isInteger(trip.nav_current_step_index)
      ? trip.nav_current_step_index : 0;
    if (curIdx < 0) curIdx = 0;
    if (curIdx >= steps.length) curIdx = steps.length - 1;

    // Advance forward as long as the truck is already past the current
    while (curIdx < steps.length - 1) {
      const endCoord = stepEndCoord(steps[curIdx]);
      if (!endCoord) break;
      const d = gpsDistanceM({ lat, lon }, { lat: endCoord[1], lon: endCoord[0] });
      if (d <= NAV_ADVANCE_THRESHOLD_M) {
        curIdx++;
      } else {
        break;
      }
    }

    const currentStep = steps[curIdx];
    const nextEndCoord = stepEndCoord(currentStep);
    const distToNextTurn = nextEndCoord
      ? Math.round(gpsDistanceM({ lat, lon }, { lat: nextEndCoord[1], lon: nextEndCoord[0] }))
      : null;

    // Arrival: within NAV_ARRIVAL_THRESHOLD_M of the assigned destination.
    let nav_state = trip.nav_state || 'navigating';
    if (trip.dest_lat != null && trip.dest_lon != null) {
      const distToDest = gpsDistanceM(
        { lat, lon }, { lat: trip.dest_lat, lon: trip.dest_lon },
      );
      if (distToDest <= NAV_ARRIVAL_THRESHOLD_M) nav_state = 'arrived';
    }

    await supabase.from('trip_sessions')
      .update({
        nav_current_step_index: curIdx,
        nav_step_instruction:   currentStep?.instruction ?? null,
        nav_step_dist_m:        distToNextTurn,
        nav_step_type:          currentStep?.type ?? null,
        nav_next_street:        currentStep?.name ?? null,
        nav_gps_source:         'hmi',
        nav_state,
      })
      .eq('id', trip_id)
      .eq('trip_status', 'active');
  } catch (err) {
    // Non-fatal - nav sync failure must not block telemetry ingest
    console.warn('[nav] hmi-nav advance failed:', err?.message ?? err);
  }
}

// ?????????????????????????????????????????????????????????????
const PHYSICS_WINDOW_MS       = 60_000;   // 60-second lookback
const PHYSICS_EXCESS_FACTOR   = 5.0;      // drop must be >=5x physical max
const PHYSICS_MIN_DROP_PCT    = 1.5;      // absolute floor to avoid noise
const PHYSICS_DEDUP_MS        = 45_000;       // 45 s per trip - dedup same event, allow distinct events

async function checkPhysicsTripwire({
  trip_id, truck_id, driver_id,
  fuel_level, storedChannel,
}) {
  if (!trip_id || fuel_level == null || truck_id == null) return;
  if (storedChannel === 'buffered' || storedChannel === 'offline_replay') return;

  try {
    const windowStart = new Date(Date.now() - PHYSICS_WINDOW_MS).toISOString();
    const { data: recent } = await supabase
      .from('telemetry_logs')
      .select('id, fuel_level, timestamp, engine_load_pct, speed')
      .eq('trip_id', trip_id)
      .eq('comm_channel', storedChannel)
      .not('fuel_level', 'is', null)
      .gte('timestamp', windowStart)
      .order('timestamp', { ascending: true });

    if (!recent || recent.length < 2) return;

    const firstFuel = Number(recent[0].fuel_level);
    const currentFuel = Number(fuel_level);
    if (!Number.isFinite(firstFuel) || !Number.isFinite(currentFuel)) return;

    const cumulativeDrop = firstFuel - currentFuel;
    if (cumulativeDrop < PHYSICS_MIN_DROP_PCT) return;

    // by zero on a burst of same-timestamp rows.
    const durationSec = Math.max(5,
      (new Date(recent[recent.length - 1].timestamp).getTime() -
       new Date(recent[0].timestamp).getTime()) / 1000);
    const durationMin = durationSec / 60;

    // Physical envelope model for an 80 L Toyota Hilux:
    const nRows = recent.length;
    const meanSpeed = recent.reduce((s, r) => s + Number(r.speed ?? 0), 0) / nRows;
    const meanLoad  = recent.reduce((s, r) => s + Number(r.engine_load_pct ?? 0), 0) / nRows;
    const burnPctPerMin = meanSpeed < 5
      ? 0.03
      : 0.03 + (Math.min(100, Math.max(0, meanLoad)) / 100) * 0.15;
    const maxExpectedDrop = burnPctPerMin * durationMin;
    if (cumulativeDrop < maxExpectedDrop * PHYSICS_EXCESS_FACTOR) return;

    // Per-trip dedup - suppress duplicate alerts from the same event across
    const dedupSince = new Date(Date.now() - PHYSICS_DEDUP_MS).toISOString();
    const { count: recentAnomaly } = await supabase.from('alerts')
      .select('id', { count: 'exact', head: true })
      .eq('trip_id', trip_id)
      .eq('alert_type', 'fuel_anomaly')
      .gte('timestamp', dedupSince);
    if (recentAnomaly && recentAnomaly > 0) return;

    const excessFactor = maxExpectedDrop > 0 ? (cumulativeDrop / maxExpectedDrop) : Infinity;
    const scenarioLabel = meanSpeed < 5
      ? 'Physics envelope violation while stationary (possible siphon)'
      : 'Physics envelope violation while driving (possible line leak or theft)';
    const message = `${scenarioLabel} - ${cumulativeDrop.toFixed(1)}% drop over ${Math.round(durationSec)}s at ${Math.round(meanSpeed)} km/h (${excessFactor.toFixed(0)}x above physical burn envelope)`;

    await supabase.from('alerts').insert([{
      truck_id, driver_id, trip_id,
      alert_type: 'fuel_anomaly',
      severity:   'high',
      message,
    }]);

    // Back-propagate anomaly_flag=true onto the rows actually involved
    const maxFuelInWindow = Math.max(
      ...recent.map(r => Number(r.fuel_level)).filter(Number.isFinite)
    );
    const eventRows = recent.filter(r =>
      Number.isFinite(Number(r.fuel_level)) &&
      Number(r.fuel_level) <= maxFuelInWindow - PHYSICS_MIN_DROP_PCT);
    const rowIds = eventRows.map(r => r.id).filter(Boolean);
    if (rowIds.length > 0) {
      await supabase.from('telemetry_logs')
        .update({ anomaly_flag: true, model_source: 'physics_tripwire' })
        .in('id', rowIds);
    }

    await syncTruckStatus(truck_id);

    console.log(`[physics] tripwire fired truck=${truck_id} drop=${cumulativeDrop.toFixed(1)}% window=${Math.round(durationSec)}s excess=${excessFactor.toFixed(1)}x`);
  } catch (err) {
    // Non-fatal - deterministic tripwire failure must not block ingest
    console.warn('[physics] tripwire check failed:', err?.message ?? err);
  }
}

function effectiveGpsTime(row) {
  return new Date(row?.original_device_timestamp ?? row?.sent_at ?? row?.timestamp ?? 0).getTime();
}

function chooseBestGps(latest, trip, now = Date.now()) {
  const embeddedAt = effectiveGpsTime(latest);
  const mobileAt = trip?.mobile_gps_at ? new Date(trip.mobile_gps_at).getTime() : 0;
  const embeddedFresh = Number.isFinite(embeddedAt) && now - embeddedAt <= GPS_FRESH_MS;
  const mobileFresh = mobileAt > 0 && now - mobileAt <= GPS_FRESH_MS;
  const embeddedValid = latest && isValidGpsPoint(latest.lat, latest.lon);
  const mobileValid = trip && isValidGpsPoint(trip.mobile_lat, trip.mobile_lon);

  if (embeddedValid && embeddedFresh) {
    return {
      lat: latest.lat,
      lon: latest.lon,
      gps_source: latest.gps_source ?? 'embedded_gps',
      source_device: latest.source_device ?? 'hmi',
      gps_at: latest.original_device_timestamp ?? latest.sent_at ?? latest.timestamp ?? null,
    };
  }
  if (mobileValid && mobileFresh) {
    return {
      lat: trip.mobile_lat,
      lon: trip.mobile_lon,
      gps_source: 'fused_mobile_fallback',
      source_device: 'mobile',
      gps_at: trip.mobile_gps_at,
    };
  }
  if (embeddedValid) {
    return {
      lat: latest.lat,
      lon: latest.lon,
      gps_source: latest.gps_source ?? 'embedded_gps',
      source_device: latest.source_device ?? 'hmi',
      gps_at: latest.original_device_timestamp ?? latest.sent_at ?? latest.timestamp ?? null,
    };
  }
  if (mobileValid) {
    return {
      lat: trip.mobile_lat,
      lon: trip.mobile_lon,
      gps_source: 'fused_mobile_fallback',
      source_device: 'mobile',
      gps_at: trip.mobile_gps_at,
    };
  }
  return { lat: null, lon: null, gps_source: null, source_device: null, gps_at: null };
}

async function upsertTripSummary(tripId) {
  // Try the Supabase RPC first
  try {
    const { data, error } = await supabase.rpc('refresh_trip_summary', {
      p_trip_id: tripId,
    });
    if (!error) return data ?? null;
    console.warn('[trip_summary] RPC failed, using direct upsert fallback:', error.message);
  } catch (rpcErr) {
    console.warn('[trip_summary] RPC threw, using direct upsert fallback:', rpcErr.message);
  }

  const { data: trip, error: tripErr } = await supabase
    .from('trip_sessions')
    .select('*')
    .eq('id', tripId)
    .single();

  if (tripErr || !trip) throw new Error(`Trip ${tripId} not found for summary upsert`);

  const [truckRes, driverRes, alertRes, logRes] = await Promise.all([
    supabase.from('trucks').select('truck_code, plate_number').eq('id', trip.truck_id).single(),
    supabase.from('drivers').select('full_name').eq('id', trip.driver_id).single(),
    supabase.from('alerts').select('id', { count: 'exact', head: true }).eq('trip_id', tripId),
    supabase.from('telemetry_logs')
      .select('fuel_level, anomaly_flag, timestamp')
      .eq('trip_id', tripId)
      .order('timestamp', { ascending: true }),
  ]);

  const logs      = logRes.data ?? [];
  const validFuel = logs.filter(l => l.fuel_level != null);
  const avgFuel   = validFuel.length
    ? +(validFuel.reduce((s, l) => s + l.fuel_level, 0) / validFuel.length).toFixed(2)
    : null;

  const { data, error } = await supabase
    .from('trip_summaries')
    .upsert({
      trip_id:               tripId,
      truck_id:              trip.truck_id,
      driver_id:             trip.driver_id,
      trip_status:           trip.trip_status,
      start_time:            trip.start_time,
      end_time:              trip.end_time,
      total_distance_km:     trip.distance_km ?? 0,
      total_operating_hours: trip.operating_hours ?? 0,
      total_alerts:          alertRes.count ?? 0,
      total_anomalies:       logs.filter(l => l.anomaly_flag).length,
      average_fuel_level:    avgFuel,
      start_fuel_level:      validFuel[0]?.fuel_level ?? null,
      final_fuel_level:      validFuel[validFuel.length - 1]?.fuel_level ?? null,
      log_count:             logs.length,
      truck_code:            truckRes.data?.truck_code ?? null,
      plate_number:          truckRes.data?.plate_number ?? null,
      driver_name:           driverRes.data?.full_name ?? null,
      updated_at:            new Date().toISOString(),
    }, { onConflict: 'trip_id' })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function archiveEndedTripLogs(options = {}) {
  const { data, error } = await supabase.rpc('archive_ended_trip_logs', {
    p_retention_days: Number(options.retentionDays ?? 30),
    p_max_trips: Number(options.maxTrips ?? 50),
    p_dry_run: Boolean(options.dryRun),
  });
  if (error) throw error;
  return data ?? null;
}

// ?????????????????????????????????????????????????????????????
const DASHBOARD_ROLES = ['head_admin', 'fleet_manager', 'manager'];

// ?????????????????????????????????????????????????????????????
let _thresholdCache = null;
let _thresholdCachedAt = 0;
const THRESHOLD_TTL_MS = 60_000;

async function getThresholds() {
  if (_thresholdCache && Date.now() - _thresholdCachedAt < THRESHOLD_TTL_MS) {
    return _thresholdCache;
  }
  const { data } = await supabase
    .from('settings').select('value').eq('key', 'thresholds').single();
  _thresholdCache = data?.value ?? {
    rest_hours: 4, rest_distance_km: 300, maintenance_km: 5000, overspeed_kmh: 100,
  };
  _thresholdCachedAt = Date.now();
  return _thresholdCache;
}

function invalidateThresholdCache() { _thresholdCachedAt = 0; }

const ALERT_STATUS_PRIORITY = {
  fuel_anomaly: 400,
  rest_alert: 300,
  maintenance: 200,
  low_fuel: 100,
};


const ALERT_META_PATTERN = /\s*\[meta:([^\]]+)\]\s*$/;

function statusFromAlertType(alertType) {
  if (alertType === 'fuel_anomaly') return 'anomaly';
  if (alertType === 'rest_alert') return 'rest_alert';
  if (alertType === 'maintenance') return 'maintenance';
  if (alertType === 'low_fuel') return 'low_fuel';
  return null;
}

function stripAlertMeta(message = '') {
  return String(message ?? '').replace(ALERT_META_PATTERN, '').trim();
}

function parseAlertMeta(message = '') {
  const match = String(message ?? '').match(ALERT_META_PATTERN);
  if (!match) return {};

  return Object.fromEntries(
    match[1]
      .split(';')
      .map(part => part.split('=').map(value => value.trim()))
      .filter(([key, value]) => key && value)
  );
}

function withAlertMeta(message = '', meta = {}) {
  const base = stripAlertMeta(message);
  const merged = {
    ...parseAlertMeta(message),
    ...Object.fromEntries(
      Object.entries(meta).filter(([, value]) => value != null && value !== '')
    ),
  };

  const encoded = Object.entries(merged)
    .map(([key, value]) => `${key}=${String(value).replace(/[;\]]/g, '')}`)
    .join(';');

  return encoded ? `${base} [meta:${encoded}]` : base;
}

function sanitizeAlert(alert) {
  return alert ? { ...alert, message: stripAlertMeta(alert.message) } : alert;
}

// totalRestSecs: accumulated rest seconds from all previous rest breaks
function computeLiveOperatingHours(startTime, storedHours = 0) {
  if (!startTime) return +(storedHours ?? 0);
  const elapsedMs = Date.now() - new Date(startTime).getTime();
  return +(elapsedMs / 3_600_000).toFixed(4);
}

function computeHmiOperatingHours(trip, latest, isOnline) {
  const hmiDrivingSec = Number(latest?.hmi_driving_sec);
  if (Number.isFinite(hmiDrivingSec) && hmiDrivingSec >= 0) {
    // modem queue for minutes before timestamp (server receipt), so aging from
    const clockAt = latest?.sent_at ?? latest?.original_device_timestamp ?? latest?.timestamp;
    const latestTs = clockAt ? new Date(clockAt).getTime() : NaN;
    const ageSec = Number.isFinite(latestTs)
      ? Math.max(0, Math.floor((Date.now() - latestTs) / 1000))
      : 0;
    const hmiTripStatus = latest?.hmi_trip_status ?? trip?.trip_status ?? 'active';
    const liveExtraSec = trip?.trip_status === 'active' && hmiTripStatus !== 'paused'
      ? ageSec
      : 0;
    return +((hmiDrivingSec + liveExtraSec) / 3600).toFixed(4);
  }
  return computeLiveOperatingHours(trip?.start_time, trip?.operating_hours);
}

async function attachHmiClock(activeTrip) {
  if (!activeTrip?.id) return activeTrip ?? null;
  const { data, error } = await supabase
    .from('telemetry_logs')
    .select('hmi_driving_sec, hmi_rest_sec, hmi_trip_status, timestamp, sent_at, original_device_timestamp')
    .eq('trip_id', activeTrip.id)
    .eq('truck_id', activeTrip.truck_id)
    .or('source_device.is.null,source_device.eq.hmi')
    .order('timestamp', { ascending: false })
    .limit(20);

  if (error) {
    const missingClockColumn = /Could not find the 'hmi_(driving_sec|rest_sec|trip_status)' column/.test(error.message ?? '');
    if (!missingClockColumn) console.warn('[active_trip] hmi clock lookup failed:', error.message);
    return activeTrip;
  }

  const latestClock = (data ?? []).reduce((latest, row) => {
    if (!Number.isFinite(Number(row.hmi_driving_sec))) return latest;
    const rowAt = new Date(row.sent_at ?? row.original_device_timestamp ?? row.timestamp).getTime();
    const latestAt = latest
      ? new Date(latest.sent_at ?? latest.original_device_timestamp ?? latest.timestamp).getTime()
      : NaN;
    return !latest || !Number.isFinite(latestAt) || rowAt > latestAt ? row : latest;
  }, null);

  return {
    ...activeTrip,
    hmi_driving_sec: latestClock?.hmi_driving_sec ?? null,
    hmi_rest_sec: latestClock?.hmi_rest_sec ?? null,
    hmi_trip_status: latestClock?.hmi_trip_status ?? null,
    hmi_clock_at: latestClock?.sent_at ?? latestClock?.original_device_timestamp ?? latestClock?.timestamp ?? null,
  };
}

// Fire-and-forget trip event recorder - never throws.
async function logTripEvent(trip_id, truck_id, driver_id, event_type, event_time = null) {
  try {
    if (event_type === 'trip_ended') {
      const { data: existing } = await supabase
        .from('trip_events')
        .select('id')
        .eq('trip_id', trip_id)
        .eq('event_type', event_type)
        .limit(1)
        .maybeSingle();
      if (existing) {
        console.log(`[trip_event] ${event_type} trip=${trip_id} already logged - skipping duplicate`);
        return;
      }
    }
    const row = { trip_id, truck_id, driver_id, event_type };
    if (event_time) row.timestamp = event_time;
    await supabase.from('trip_events').insert([row]);
    console.log(`[trip_event] ${event_type} trip=${trip_id}${event_time ? ` at=${event_time}` : ''}`);
  } catch (e) {
    console.error('[trip_event] insert failed:', e.message);
  }
}

async function insertTelemetryLog(row) {
  const optionalColumns = new Set([
    'seq',
    'comm_channel',
    'channel_used',
    'event_id',
    'gps_accuracy_m',
    'gps_heading_deg',
    'mobile_speed_mps',
    'distance_obd_delta_km',
    'distance_fused_delta_km',
    'distance_gps_delta_km',
    'gps_valid',
    'fuel_valid',
    'fuel_source',
    'fuel_confidence',
    'engine_rpm',
    'engine_load_pct',
    'throttle_pct',
    'maf_gps',
    'coolant_temp_c',
    'engine_runtime_sec',
    'dtc_present',
    'dtc_count',
    'hmi_driving_sec',
    'hmi_rest_sec',
    'hmi_trip_status',
  ]);
  const current = { ...row };

  for (let i = 0; i < optionalColumns.size; i++) {
    const result = await supabase
      .from('telemetry_logs')
      .insert([current])
      .select()
      .single();
    if (!result.error) return result;

    const match = String(result.error.message ?? '').match(/Could not find the '([^']+)' column/);
    const missingColumn = match?.[1];
    if (!missingColumn || !optionalColumns.has(missingColumn) || !(missingColumn in current)) {
      return result;
    }

    delete current[missingColumn];
    console.warn(`[telemetry] column ${missingColumn} missing; retrying insert without it`);
  }

  return { data: null, error: new Error('telemetry insert failed after schema fallback retries') };
}

async function insertLatencyLog(row) {
  const optionalColumns = new Set([
    'comm_channel',
    'channel_used',
    'seq',
    'retry',
  ]);
  const current = { ...row };

  for (let i = 0; i <= optionalColumns.size; i++) {
    const result = await supabase
      .from('latency_logs')
      .insert([current]);
    if (!result.error) return result;

    const match = String(result.error.message ?? '').match(/Could not find the '([^']+)' column/);
    const missingColumn = match?.[1];
    if (!missingColumn || !optionalColumns.has(missingColumn) || !(missingColumn in current)) {
      return result;
    }

    delete current[missingColumn];
    console.warn(`[latency] column ${missingColumn} missing; retrying insert without it`);
  }

  return { data: null, error: new Error('latency insert failed after schema fallback retries') };
}

async function logTripStateTelemetry(trip_id, truck_id, driver_id, trip_status, options = {}) {
  try {
    const eventTime = options.event_time && !isNaN(Date.parse(options.event_time))
      ? new Date(options.event_time).toISOString()
      : new Date().toISOString();
    const channel = options.channel ?? 'lora';
    const engineStatus = trip_status === 'active' ? 'on' : 'idle';
    const eventId = options.event_id ?? `${trip_id}:${options.event_type ?? trip_status}:${eventTime}`;

    const { data: latest } = await supabase
      .from('telemetry_logs')
      .select('fuel_level, lat, lon, speed, odometer_km, gps_source, gps_accuracy_m, gps_heading_deg')
      .eq('truck_id', truck_id)
      .eq('trip_id', trip_id)
      .or('source_device.is.null,source_device.eq.hmi')
      .order('timestamp', { ascending: false })
      .limit(1)
      .maybeSingle();

    const row = {
      truck_id,
      driver_id,
      trip_id,
      timestamp: eventTime,
      sent_at: eventTime,
      original_device_timestamp: eventTime,
      fuel_level: latest?.fuel_level ?? null,
      lat: latest?.lat ?? null,
      lon: latest?.lon ?? null,
      speed: trip_status === 'active' ? (latest?.speed ?? 0) : 0,
      odometer_km: latest?.odometer_km ?? null,
      engine_status: engineStatus,
      comm_channel: channel,
      channel_used: channel,
      event_id: eventId,
      gps_source: latest?.gps_source ?? null,
      gps_accuracy_m: latest?.gps_accuracy_m ?? null,
      gps_heading_deg: latest?.gps_heading_deg ?? null,
      source_device: options.source_device ?? 'hmi',
      anomaly_flag: false,
      anomaly_score: 0,
      model_source: 'state_change',
    };

    const { error } = await insertTelemetryLog(row);
    if (error && error.code !== '23505') {
      console.error('[state_telemetry] insert failed:', error.message);
    }
  } catch (e) {
    console.error('[state_telemetry] insert threw:', e.message);
  }
}

async function attachTripStatus(rows = []) {
  const tripIds = [...new Set(rows.map(row => row.trip_id).filter(Boolean))];
  if (tripIds.length === 0) {
    return rows.map(row => ({
      ...row,
      trip_status: row.engine_status === 'on' ? 'active' : 'idle',
    }));
  }

  const { data: trips } = await supabase
    .from('trip_sessions')
    .select('id, trip_status')
    .in('id', tripIds);

  const tripMap = Object.fromEntries((trips ?? []).map(trip => [trip.id, trip.trip_status]));

  return rows.map(row => ({
    ...row,
    trip_status: tripMap[row.trip_id] ?? (row.engine_status === 'on' ? 'active' : 'idle'),
  }));
}

function parseDateStart(value) {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseDateEnd(value) {
  if (!value) return null;
  const parsed = new Date(`${value}T23:59:59.999Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function applyTimestampFilters(query, reqQuery, column = 'timestamp') {
  const dateFrom = parseDateStart(reqQuery.date_from);
  const dateTo = parseDateEnd(reqQuery.date_to);
  let nextQuery = query;

  if (reqQuery.truck_id) nextQuery = nextQuery.eq('truck_id', reqQuery.truck_id);
  if (reqQuery.driver_id) nextQuery = nextQuery.eq('driver_id', reqQuery.driver_id);
  if (reqQuery.trip_id) nextQuery = nextQuery.eq('trip_id', reqQuery.trip_id);
  if (dateFrom) nextQuery = nextQuery.gte(column, dateFrom);
  if (dateTo) nextQuery = nextQuery.lte(column, dateTo);

  return nextQuery;
}

async function buildNameMaps(rows = []) {
  const truckIds = [...new Set(rows.map(row => row.truck_id).filter(Boolean))];
  const driverIds = [...new Set(rows.map(row => row.driver_id).filter(Boolean))];

  const [truckRes, driverRes] = await Promise.all([
    truckIds.length
      ? supabase.from('trucks').select('id, truck_code').in('id', truckIds)
      : Promise.resolve({ data: [] }),
    driverIds.length
      ? supabase.from('drivers').select('id, full_name').in('id', driverIds)
      : Promise.resolve({ data: [] }),
  ]);

  return {
    truckMap: Object.fromEntries((truckRes.data ?? []).map(truck => [truck.id, truck.truck_code])),
    driverMap: Object.fromEntries((driverRes.data ?? []).map(driver => [driver.id, driver.full_name])),
  };
}

function filterLogsByDriver(rows = [], driverSearch = '') {
  if (!driverSearch) return rows;
  const query = driverSearch.toLowerCase();
  return rows.filter(row => (row.driver_name ?? '').toLowerCase().includes(query));
}

async function enrichLiveLogs(rows = []) {
  const withStatuses = await attachTripStatus(rows);
  const fused = await fuseMobileGpsIntoTelemetryLogs(withStatuses, 'telemetry_logs');
  const { truckMap, driverMap } = await buildNameMaps(withStatuses);
  return fused.map(row => ({
    ...row,
    truck_code: truckMap[row.truck_id] ?? null,
    driver_name: driverMap[row.driver_id] ?? null,
  }));
}

async function enrichArchivedLogs(rows = []) {
  const fused = await fuseMobileGpsIntoTelemetryLogs(rows, 'archived_telemetry_logs');
  const { truckMap, driverMap } = await buildNameMaps(rows);
  return fused.map(row => ({
    ...row,
    truck_code: row.truck_code ?? truckMap[row.truck_id] ?? null,
    driver_name: row.driver_name ?? driverMap[row.driver_id] ?? null,
    trip_status: row.trip_status ?? 'ended',
  }));
}

async function fuseMobileGpsIntoTelemetryLogs(rows = [], tableName = 'telemetry_logs') {
  const needsGps = rows.filter(row =>
    row.trip_id &&
    row.source_device !== 'mobile' &&
    !isValidGpsPoint(row.lat, row.lon)
  );
  if (!needsGps.length) return rows;

  const tripIds = [...new Set(needsGps.map(row => row.trip_id))];
  const times = needsGps.map(row => effectiveGpsTime(row)).filter(Number.isFinite);
  if (!times.length) return rows;

  const from = new Date(Math.min(...times) - LOG_GPS_FUSION_WINDOW_MS).toISOString();
  const to = new Date(Math.max(...times) + LOG_GPS_FUSION_WINDOW_MS).toISOString();
  const { data: mobileRows } = await supabase
    .from(tableName)
    .select('trip_id, lat, lon, timestamp, sent_at, original_device_timestamp, gps_accuracy_m, gps_heading_deg')
    .in('trip_id', tripIds)
    .eq('source_device', 'mobile')
    .gte('timestamp', from)
    .lte('timestamp', to)
    .order('timestamp', { ascending: true });

  const byTrip = {};
  for (const row of (mobileRows ?? [])) {
    if (!isValidGpsPoint(row.lat, row.lon)) continue;
    (byTrip[row.trip_id] ??= []).push(row);
  }

  return rows.map(row => {
    if (row.source_device === 'mobile' || isValidGpsPoint(row.lat, row.lon) || !row.trip_id) return row;
    const rowTime = effectiveGpsTime(row);
    const match = (byTrip[row.trip_id] ?? [])
      .map(mobile => ({ mobile, delta: Math.abs(effectiveGpsTime(mobile) - rowTime) }))
      .filter(item => item.delta <= LOG_GPS_FUSION_WINDOW_MS)
      .sort((a, b) => a.delta - b.delta)[0]?.mobile;
    if (!match) return row;
    return {
      ...row,
      lat: match.lat,
      lon: match.lon,
      gps_source: 'fused_mobile_fallback',
      gps_accuracy_m: match.gps_accuracy_m ?? row.gps_accuracy_m ?? null,
      gps_heading_deg: match.gps_heading_deg ?? row.gps_heading_deg ?? null,
    };
  });
}


async function resolveRestAlertsForTrip(trip_id, resolvedBy) {
  const { data: openAlerts } = await supabase
    .from('alerts')
    .select('id, message')
    .eq('trip_id', trip_id)
    .eq('alert_type', 'rest_alert')
    .eq('is_resolved', false);

  if (!openAlerts?.length) return;

  // Save the current trip distance as the resolution baseline so the next
  const { data: tripRow } = await supabase
    .from('trip_sessions')
    .select('distance_km')
    .eq('id', trip_id)
    .single();
  const resolvedAtKm = String((tripRow?.distance_km ?? 0).toFixed(1));

  const resolvedAt = new Date().toISOString();
  await Promise.all(openAlerts.map(alert => supabase
    .from('alerts')
    .update({
      is_resolved: true,
      message: withAlertMeta(alert.message, {
        resolved_by:    resolvedBy,
        resolved_at:    resolvedAt,
        resolved_at_km: resolvedAtKm,
      }),
    })
    .eq('id', alert.id)));
}

async function deriveTruckStatus(truck_id) {
  // Get the current active or paused trip first.
  // Alerts from ended trips must never affect the truck's live status.
  const { data: trip } = await supabase
    .from('trip_sessions')
    .select('id, trip_status')
    .eq('truck_id', truck_id)
    .in('trip_status', ['active', 'paused'])
    .order('start_time', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!trip) return 'idle';

  // Only check unresolved alerts that belong to the current trip.
  const { data: activeAlerts } = await supabase
    .from('alerts')
    .select('alert_type, timestamp')
    .eq('truck_id', truck_id)
    .eq('trip_id', trip.id)
    .eq('is_resolved', false)
    .order('timestamp', { ascending: false });

  const topAlert = (activeAlerts ?? [])
    .map(a => ({ ...a, priority: ALERT_STATUS_PRIORITY[a.alert_type] ?? 0 }))
    .sort((a, b) => b.priority - a.priority || new Date(b.timestamp) - new Date(a.timestamp))[0];

  const alertStatus = statusFromAlertType(topAlert?.alert_type);
  if (alertStatus) return alertStatus;
  return 'active';
}

async function syncTruckStatus(truck_id) {
  const nextStatus = await deriveTruckStatus(truck_id);
  await supabase.from('trucks').update({ status: nextStatus }).eq('id', truck_id);
  return nextStatus;
}

async function applyOdometerReadingIfHigher(truck_id, odometer_km) {
  // Reserved for vehicles that expose a true lifetime odometer over OBD-II.
  const odo = Number(odometer_km);
  if (!truck_id || !Number.isFinite(odo) || odo <= 0) return null;

  const { data: truck, error } = await supabase
    .from('trucks')
    .select('current_odometer_km, last_maintenance_odometer_km')
    .eq('id', truck_id)
    .maybeSingle();
  if (error || !truck) return null;

  const current = Number(truck.current_odometer_km ?? 0);
  if (Number.isFinite(current) && odo <= current) return truck;
  const nextOdo = odo;
  const updates = { current_odometer_km: +nextOdo.toFixed(1) };

  // First valid mileage reading becomes the service baseline so migrated fleets
  if (truck.last_maintenance_odometer_km == null) {
    updates.last_maintenance_odometer_km = +nextOdo.toFixed(1);
  }

  await supabase.from('trucks').update(updates).eq('id', truck_id);
  return { ...truck, ...updates };
}

async function recomputeTripDistance(trip_id) {
  if (!trip_id) return null;
  const { data: distKm, error } = await supabase
    .rpc('compute_trip_distance_km', { p_trip_id: trip_id });
  if (error) throw error;
  if (distKm == null) return null;

  const rounded = +Number(distKm).toFixed(2);
  await supabase.from('trip_sessions')
    .update({ distance_km: rounded })
    .eq('id', trip_id);
  return rounded;
}

async function finalizeTripDistanceAndMileage(trip_id) {
  const distanceKm = await recomputeTripDistance(trip_id);
  const { data, error } = await supabase
    .rpc('accumulate_trip_distance_odometer', { p_trip_id: trip_id });
  if (error) throw error;

  const row = Array.isArray(data) ? data[0] : data;
  return {
    ...(row ?? {}),
    distance_km: row?.distance_km ?? distanceKm,
  };
}

async function recordMaintenanceService(truck_id) {
  if (!truck_id) return;
  const { data: truck } = await supabase
    .from('trucks')
    .select('current_odometer_km')
    .eq('id', truck_id)
    .maybeSingle();
  const odo = Number(truck?.current_odometer_km);
  if (!Number.isFinite(odo) || odo <= 0) return;
  await supabase
    .from('trucks')
    .update({ last_maintenance_odometer_km: +odo.toFixed(1) })
    .eq('id', truck_id);
}

function touchDevice(truck_id) {
  if (!truck_id) return;
  supabase.from('trucks')
    .update({ device_last_seen: new Date().toISOString() })
    .eq('id', truck_id)
    .then(() => {})
    .catch(() => {});
}

// Also backfills truck_id if the HMI login didn't send it.
function touchHmiSession(driver_id, truck_id) {
  if (!driver_id) return;
  const now = new Date().toISOString();
  // Update last_seen always; set truck_id only if it was null
  supabase.from('hmi_sessions')
    .update({ last_seen: now, truck_id: truck_id || undefined })
    .eq('driver_id', driver_id)
    .eq('status', 'active')
    .is('truck_id', null)
    .then(() => {})
    .catch(() => {});
  supabase.from('hmi_sessions')
    .update({ last_seen: now })
    .eq('driver_id', driver_id)
    .eq('status', 'active')
    .not('truck_id', 'is', null)
    .then(() => {})
    .catch(() => {});
}


// ?????????????????????????????????????????????????????????????
async function checkOperationalAlerts(truck_id, driver_id, trip_id, speed, odometer_km, eventTime = null, fuelLevel = null) {
  try {
    const thr = await getThresholds();
    const numericSpeed = Number(speed ?? 0);
    const movingNow = numericSpeed >= 5;
    // eventTime: ISO string from device for buffered records; null = use server time
    const alertTs = eventTime ? { timestamp: new Date(eventTime).toISOString() } : {};

    if (thr.overspeed_kmh && numericSpeed > thr.overspeed_kmh) {
      const refTime = eventTime ? new Date(new Date(eventTime).getTime() - 5 * 60_000).toISOString()
                                : new Date(Date.now() - 5 * 60_000).toISOString();
      const { count } = await supabase.from('alerts')
        .select('id', { count: 'exact', head: true })
        .eq('truck_id', truck_id).eq('alert_type', 'overspeed')
        .gte('timestamp', refTime);
      if (!count) {
        await supabase.from('alerts').insert([{
          truck_id, driver_id, trip_id,
          alert_type: 'overspeed', severity: 'medium',
          message: `Overspeed: ${Math.round(numericSpeed)} km/h (limit ${thr.overspeed_kmh} km/h)`,
          ...alertTs,
        }]);
        console.log(`[alert] overspeed truck=${truck_id} speed=${numericSpeed}`);
      }
    }

    // Threshold fixed at 15 % (operational fleet target); make per-truck later
    const numericFuel = Number(fuelLevel ?? NaN);
    if (Number.isFinite(numericFuel) && numericFuel > 0 && numericFuel < 15) {
      const refTime = eventTime ? new Date(new Date(eventTime).getTime() - 5 * 60_000).toISOString()
                                : new Date(Date.now() - 5 * 60_000).toISOString();
      const { count } = await supabase.from('alerts')
        .select('id', { count: 'exact', head: true })
        .eq('truck_id', truck_id).eq('alert_type', 'low_fuel')
        .gte('timestamp', refTime);
      if (!count) {
        await supabase.from('alerts').insert([{
          truck_id, driver_id, trip_id,
          alert_type: 'low_fuel', severity: 'high',
          message: `Low fuel: ${numericFuel.toFixed(0)} % (refuel recommended below 15 %)`,
          ...alertTs,
        }]);
        console.log(`[alert] low_fuel truck=${truck_id} fuel=${numericFuel}`);
      }
    }

    if (!trip_id) return;

    const { data: trip } = await supabase.from('trip_sessions')
      .select('start_time, distance_km, trip_status, snoozed_until').eq('id', trip_id).single();

    // the last telemetry's setImmediate fires after /trip/end resolved the alerts.
    if (!trip || trip.trip_status === 'ended') return;

    {
      const distKm = trip.distance_km ?? 0;

      // Skip rest check when paused OR within active snooze window
      const snoozedUntilMs = trip.snoozed_until ? new Date(trip.snoozed_until).getTime() : 0;
      const skipRest = trip.trip_status === 'paused' || snoozedUntilMs > Date.now();

      if (!skipRest) {
        // Only act if there's no already-open rest alert
        const { count: openRest } = await supabase.from('alerts')
          .select('id', { count: 'exact', head: true })
          .eq('trip_id', trip_id)
          .eq('alert_type', 'rest_alert')
          .eq('is_resolved', false);

        if (!openRest) {
          const { data: lastAlert } = await supabase.from('alerts')
            .select('timestamp, is_resolved, message')
            .eq('trip_id', trip_id)
            .eq('alert_type', 'rest_alert')
            .order('timestamp', { ascending: false })
            .limit(1)
            .maybeSingle();

          // ?? Determine baseline for the next threshold interval ??????????
          let baselineKm   = 0;
          let baselineTime = new Date(trip.start_time);

          if (lastAlert?.is_resolved) {
            const meta = parseAlertMeta(lastAlert.message);
            const savedKm = parseFloat(meta.resolved_at_km ?? 'NaN');
            if (Number.isFinite(savedKm)) baselineKm = savedKm;
            if (meta.resolved_at) {
              const t = new Date(meta.resolved_at);
              if (!isNaN(t.getTime())) baselineTime = t;
            }
          }

          const { data: lastResume } = await supabase
            .from('trip_events')
            .select('timestamp')
            .eq('trip_id', trip_id)
            .eq('event_type', 'trip_resumed')
            .order('timestamp', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (lastResume && new Date(lastResume.timestamp) > baselineTime) {
            baselineTime = new Date(lastResume.timestamp);
          }

          const distSinceBaseline  = distKm - baselineKm;
          const hoursSinceBaseline = (Date.now() - baselineTime.getTime()) / 3_600_000;

          const needsRest =
            (thr.rest_distance_km > 0 && distSinceBaseline  >= thr.rest_distance_km) ||
            (thr.rest_hours       > 0 && hoursSinceBaseline >= thr.rest_hours);

          // 10-minute dedup guard: avoid spamming if still driving past threshold
          const tenMinAgo      = new Date(Date.now() - 10 * 60_000).toISOString();
          const recentlyAlerted = lastAlert?.timestamp && lastAlert.timestamp >= tenMinAgo;

          if (needsRest && !recentlyAlerted) {
            const reason = distSinceBaseline >= thr.rest_distance_km
              ? `${distKm.toFixed(1)} km driven (every ${thr.rest_distance_km} km)`
              : `${hoursSinceBaseline.toFixed(1)} h driving (every ${thr.rest_hours} h)`;

            await supabase.from('alerts').insert([{
              truck_id, driver_id, trip_id,
              alert_type: 'rest_alert', severity: 'medium',
              message: `Driver rest required - ${reason}`,
              ...alertTs,
            }]);
            await syncTruckStatus(truck_id);
            console.log(
              `[alert] rest_alert truck=${truck_id}`
              + ` distSince=${distSinceBaseline.toFixed(1)}km`
              + ` reason=${reason}`
            );
          }
        }
      }
    }

    if (thr.maintenance_km > 0 && trip_id) {
      const { data: truck } = await supabase.from('trucks')
        .select('current_odometer_km, last_maintenance_odometer_km, maintenance_interval_km')
        .eq('id', truck_id)
        .maybeSingle();
      const currentMileage = Number(truck?.current_odometer_km ?? odometer_km);
      const lastServiceMileage = Number(truck?.last_maintenance_odometer_km);
      const intervalKm = Number(truck?.maintenance_interval_km ?? thr.maintenance_km);
      const kmSinceService = currentMileage - lastServiceMileage;

      if (
        Number.isFinite(currentMileage) &&
        Number.isFinite(lastServiceMileage) &&
        Number.isFinite(intervalKm) &&
        intervalKm > 0 &&
        kmSinceService >= intervalKm
      ) {
        const { count } = await supabase.from('alerts')
          .select('id', { count: 'exact', head: true })
          .eq('truck_id', truck_id).eq('alert_type', 'maintenance').eq('is_resolved', false);
        if (!count) {
          await supabase.from('alerts').insert([{
            truck_id, driver_id, trip_id,
            alert_type: 'maintenance', severity: 'low',
            message: `Scheduled maintenance due - ${kmSinceService.toFixed(0)} km since last service (interval ${intervalKm.toFixed(0)} km)`,
            ...alertTs,
          }]);
          await syncTruckStatus(truck_id);
          console.log(`[alert] maintenance truck=${truck_id}`);
        }
      }
    }
  } catch (err) {
    console.error('[checkOperationalAlerts]', err.message);
  }
}

// ?????????????????????????????????????????????????????????????
// ?????????????????????????????????????????????????????????????
async function resolveUser(req) {
  const auth = req.headers['authorization'] || '';
  const userId = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!userId) return null;
  const { data } = await supabase
    .from('users')
    .select('id, full_name, username, role, is_active')
    .eq('id', userId)
    .single();
  return data && data.is_active ? data : null;
}

// ?????????????????????????????????????????????????????????????
// ?????????????????????????????????????????????????????????????
async function requireDashboard(req, res, next) {
  const user = await resolveUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized - please log in' });
  if (!DASHBOARD_ROLES.includes(user.role))
    return res.status(403).json({ error: 'Access denied - dashboard is for admin accounts only' });
  req.user = user;
  next();
}

// ?????????????????????????????????????????????????????????????
// ?????????????????????????????????????????????????????????????
const DEVICE_KEY = process.env.DEVICE_API_KEY || 'fleet-device-key-2024';

function requireDeviceKey(req, res, next) {
  const key = req.headers['x-device-key'] || req.body?.device_key || req.query?.device_key;
  if (!key || key !== DEVICE_KEY) {
    return res.status(401).json({ error: 'Invalid or missing device key' });
  }
  next();
}

// ?????????????????????????????????????????????????????????????
// ?????????????????????????????????????????????????????????????
async function requireHeadAdmin(req, res, next) {
  const user = await resolveUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized - please log in' });
  if (user.role !== 'head_admin')
    return res.status(403).json({ error: 'Access denied - Settings is restricted to Head Admin only' });
  req.user = user;
  next();
}
const PORT = process.env.PORT || 5000;

// ?????????????????????????????????????????????????????????????
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'Fleet Monitoring API v2' });
});

// ?????????????????????????????????????????????????????????????
const latencyHandler = (_req, res) =>
  res.status(200).json({ ok: true, t: Date.now() });
app.get('/test/latency',  latencyHandler);
app.post('/test/latency', latencyHandler);

// ?????????????????????????????????????????????????????????????
// ?????????????????????????????????????????????????????????????
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required.' });

  const { data: user, error } = await supabase
    .from('users')
    .select('id, full_name, username, password_hash, role, is_active')
    .eq('username', username.toLowerCase().trim())
    .single();

  // PGRST116 = no row found
  if (error?.code === 'PGRST116' || !user)
    return res.status(404).json({ error: 'No account found in the system.' });

  if (error)
    return res.status(500).json({ error: 'Authentication error.' });

  if (!user.is_active)
    return res.status(403).json({ error: 'This account has been deactivated.' });

  // Drivers are not allowed to access the admin dashboard
  if (user.role === 'driver')
    return res.status(403).json({
      error: 'This account is not authorized to access the dashboard. Use the truck device to log in.',
    });

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match)
    return res.status(401).json({ error: 'Incorrect password.' });

  res.json({
    user_id:   user.id,
    full_name: user.full_name,
    username:  user.username,
    role:      user.role,
  });
});

// ?????????????????????????????????????????????????????????????
// ?????????????????????????????????????????????????????????????
app.post('/driver/login', requireDeviceKey, async (req, res) => {
  const { pin, source } = req.body;
  if (!pin)
    return res.status(400).json({ error: 'PIN is required.' });

  if (!/^\d{4}$/.test(pin))
    return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });

  // PINs are globally unique - look up driver directly by PIN
  const { data: driver, error } = await supabase
    .from('drivers')
    .select('id, full_name, is_active')
    .eq('pin', pin)
    .single();

  if (error || !driver)
    return res.status(401).json({ error: 'Incorrect PIN. Try again.' });

  if (!driver.is_active)
    return res.status(403).json({ error: 'This account has been deactivated.' });

  const { data: activeTrip } = await supabase
    .from('trip_sessions')
    .select('id, truck_id, driver_id, trip_status, channel_used, start_time, end_time, paused_at, total_rest_seconds, next_rest_alert_at, snoozed_until, distance_km, last_action_source, last_action_at, assigned_destination, dest_lat, dest_lon, route_dist_m, route_dur_s, trucks(truck_code, plate_number, length_m, width_m, height_m, weight_t, axleload_t, hazmat, tank_capacity_l)')
    .eq('driver_id', driver.id)
    .in('trip_status', ['active', 'paused'])
    .order('start_time', { ascending: false })
    .limit(1)
    .maybeSingle();

  const activeTripWithClock = await attachHmiClock(activeTrip);

  res.json({
    user_id:     driver.id,
    full_name:   driver.full_name,
    role:        'driver',
    server_now:  new Date().toISOString(),
    active_trip: activeTripWithClock ?? null,
  });
});

// ?????????????????????????????????????????????????????????????
app.get('/driver/active-trip/:driver_id', requireDeviceKey, async (req, res) => {
  const { driver_id } = req.params;
  const { data: trip } = await supabase
    .from('trip_sessions')
    .select('id, truck_id, driver_id, trip_status, channel_used, start_time, end_time, paused_at, total_rest_seconds, next_rest_alert_at, snoozed_until, distance_km, last_action_source, last_action_at, assigned_destination, dest_lat, dest_lon, route_dist_m, route_dur_s, trucks(truck_code, plate_number, length_m, width_m, height_m, weight_t, axleload_t, hazmat, tank_capacity_l)')
    .eq('driver_id', driver_id)
    .in('trip_status', ['active', 'paused'])
    .order('start_time', { ascending: false })
    .limit(1)
    .maybeSingle();
  res.json({ server_now: new Date().toISOString(), active_trip: await attachHmiClock(trip) });
});

// ?????????????????????????????????????????????????????????????
app.get('/device/trucks', requireDeviceKey, async (_req, res) => {
  const staleThreshold = new Date(Date.now() - HMI_STALE_MS).toISOString();
  const [{ data: trucks, error }, { data: activeTrips }, { data: hmiSessions }] = await Promise.all([
    supabase
      .from('trucks')
      .select('id, truck_code, plate_number, model, status, length_m, width_m, height_m, weight_t, axleload_t, hazmat, tank_capacity_l, device_installed, device_last_seen')
      .order('truck_code'),
    supabase
      .from('trip_sessions')
      .select('truck_id')
      .in('trip_status', ['active', 'paused']),
    // Trucks with an active HMI session are connected regardless of heartbeat timing
    supabase
      .from('hmi_sessions')
      .select('truck_id')
      .eq('status', 'active')
      .gt('last_seen', staleThreshold)
      .not('truck_id', 'is', null),
  ]);
  if (error) return res.status(400).json({ error: error.message });
  const activeTruckIds = new Set((activeTrips ?? []).map(t => t.truck_id));
  const hmiConnectedTruckIds = new Set((hmiSessions ?? []).map(s => s.truck_id));
  const DEVICE_ONLINE_MS = 2 * 60 * 1000;
  const now = Date.now();
  res.json((trucks ?? []).map(t => ({
    ...t,
    is_active: activeTruckIds.has(t.id),
    // Online if HMI session is active OR device heartbeat is recent
    is_online: hmiConnectedTruckIds.has(t.id) ||
      (t.device_last_seen ? (now - new Date(t.device_last_seen).getTime()) < DEVICE_ONLINE_MS : false),
  })));
});

// ?????????????????????????????????????????????????????????????
async function getActiveHmiSession(driver_id) {
  const staleThreshold = new Date(Date.now() - HMI_STALE_MS).toISOString();
  const { data } = await supabase
    .from('hmi_sessions')
    .select('id, driver_id, truck_id, device_id, status, last_seen, active_trip_id')
    .eq('driver_id', driver_id)
    .eq('status', 'active')
    .gt('last_seen', staleThreshold)
    .order('last_seen', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

// POST /device/hmi-login - called by HMI after successful driver PIN login
app.post('/device/hmi-login', requireDeviceKey, async (req, res) => {
  const { driver_id, truck_id, device_id } = req.body;
  if (!driver_id || !device_id)
    return res.status(400).json({ error: 'driver_id and device_id required' });

  let resolvedTruckId = truck_id || null;
  if (!resolvedTruckId) {
    const { data: recentTruck } = await supabase
      .from('trucks')
      .select('id')
      .eq('device_installed', true)
      .gt('device_last_seen', new Date(Date.now() - 10 * 60 * 1000).toISOString())
      .order('device_last_seen', { ascending: false })
      .limit(1)
      .maybeSingle();
    resolvedTruckId = recentTruck?.id || null;
  }

  // End any prior active session for this driver on this device
  await supabase
    .from('hmi_sessions')
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('driver_id', driver_id)
    .eq('status', 'active');

  const { data, error } = await supabase
    .from('hmi_sessions')
    .insert([{ driver_id, truck_id: resolvedTruckId, device_id, status: 'active' }])
    .select('id')
    .single();

  if (error) return res.status(400).json({ error: error.message });
  console.log(`[hmi] session created id=${data.id} driver=${driver_id} truck=${resolvedTruckId}`);
  res.status(201).json({ session_id: data.id });
});

// POST /device/hmi-heartbeat - HMI sends every ~20 s while active
app.post('/device/hmi-heartbeat', requireDeviceKey, async (req, res) => {
  const { session_id, active_trip_id } = req.body;
  if (!session_id)
    return res.status(400).json({ error: 'session_id required' });

  const update = { last_seen: new Date().toISOString() };
  if (active_trip_id !== undefined) update.active_trip_id = active_trip_id || null;

  const { error } = await supabase
    .from('hmi_sessions')
    .update(update)
    .eq('id', session_id)
    .eq('status', 'active');

  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

// POST /device/hmi-logout - HMI calls on explicit driver logout
app.post('/device/hmi-logout', requireDeviceKey, async (req, res) => {
  const { session_id } = req.body;
  if (!session_id)
    return res.status(400).json({ error: 'session_id required' });

  await supabase
    .from('hmi_sessions')
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('id', session_id);

  console.log(`[hmi] session ended id=${session_id}`);
  res.json({ ok: true });
});

// GET /driver/hmi-session - mobile app polls to check HMI presence
app.get('/driver/hmi-session', requireDeviceKey, async (req, res) => {
  const { driver_id } = req.query;
  if (!driver_id)
    return res.status(400).json({ error: 'driver_id required' });

  const session = await getActiveHmiSession(driver_id);
  if (session) {
    supabase.from('hmi_sessions')
      .update({ mobile_last_seen: new Date().toISOString() })
      .eq('id', session.id)
      .then(() => {}).catch(() => {});
    return res.json({ active: true, session });
  }

  // This lets the mobile distinguish "HMI temporarily offline" (session: null)
  const recentEndCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: endedSession } = await supabase
    .from('hmi_sessions')
    .select('id, driver_id, truck_id, status, last_seen, ended_at')
    .eq('driver_id', driver_id)
    .eq('status', 'ended')
    .gt('ended_at', recentEndCutoff)
    .order('ended_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  res.json({ active: false, session: endedSession ?? null });
});

// No PIN required - the HMI already verified the driver's identity.
app.get('/driver/hmi-auto-login', requireDeviceKey, async (req, res) => {
  const loginStaleThreshold = new Date(Date.now() - MOBILE_LOGIN_STALE_MS).toISOString();

  const { data: hmiSession } = await supabase
    .from('hmi_sessions')
    .select('driver_id, status, last_seen')
    .eq('status', 'active')
    .gt('last_seen', loginStaleThreshold)
    .order('last_seen', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!hmiSession)
    return res.status(403).json({ error: 'No active HMI session', code: 'HMI_REQUIRED' });

  const { data: driver } = await supabase
    .from('drivers')
    .select('id, full_name, is_active')
    .eq('id', hmiSession.driver_id)
    .single();

  if (!driver || !driver.is_active)
    return res.status(403).json({ error: 'Driver account inactive', code: 'DRIVER_INACTIVE' });

  const { data: activeTrip } = await supabase
    .from('trip_sessions')
    .select('id, truck_id, driver_id, trip_status, start_time, end_time, paused_at, total_rest_seconds, next_rest_alert_at, snoozed_until, distance_km, trucks(truck_code, plate_number, length_m, width_m, height_m, weight_t, axleload_t, hazmat, tank_capacity_l)')
    .eq('driver_id', driver.id)
    .in('trip_status', ['active', 'paused'])
    .order('start_time', { ascending: false })
    .limit(1)
    .maybeSingle();

  const activeTripWithClock = await attachHmiClock(activeTrip);

  res.json({
    user_id:     driver.id,
    full_name:   driver.full_name,
    role:        'driver',
    active_trip: activeTripWithClock ?? null,
  });
});

// ?????????????????????????????????????????????????????????????
const MOBILE_COMPANION_STALE_MS = 30_000; // mobile polls every 15s; 30s gives two missed polls

app.get('/device/alerts/:trip_id', requireDeviceKey, async (req, res) => {
  const [{ data: tripRow }, thr] = await Promise.all([
    supabase.from('trip_sessions').select('trip_status, paused_at, truck_id, driver_id, next_rest_alert_at, assigned_destination, dest_lat, dest_lon, route_dist_m, route_dur_s, nav_step_instruction, nav_step_dist_m, nav_step_type, nav_state, nav_current_step_index, nav_next_street, nav_gps_source, trucks(truck_code, model, tank_capacity_l)').eq('id', req.params.trip_id).maybeSingle(),
    getThresholds(),
  ]);

  // Without this, the dashboard shows "Offline" whenever telemetry gaps > 3 minutes.
  if (tripRow?.truck_id) touchDevice(tripRow.truck_id);
  if (tripRow?.driver_id) touchHmiSession(tripRow.driver_id, tripRow.truck_id);

  if (tripRow && tripRow.trip_status === 'ended') {
    return res.json({ force_ended: true, alerts: [], rest_threshold_ms: Math.round(thr.rest_hours * 3600 * 1000), overspeed_kmh: thr.overspeed_kmh ?? 0, mobile_companion_active: false });
  }

  let mobileCompanionActive = false;
  if (tripRow?.driver_id) {
    const mobileThreshold = new Date(Date.now() - MOBILE_COMPANION_STALE_MS).toISOString();
    const { data: hmiRow } = await supabase
      .from('hmi_sessions')
      .select('mobile_last_seen')
      .eq('driver_id', tripRow.driver_id)
      .eq('status', 'active')
      .gt('mobile_last_seen', mobileThreshold)
      .limit(1)
      .maybeSingle();
    mobileCompanionActive = hmiRow !== null;
  }

  const [alertsResult, pendingResult] = await Promise.all([
    supabase
      .from('alerts')
      .select('id, alert_type, message, severity, timestamp')
      .eq('trip_id', req.params.trip_id)
      .eq('is_resolved', false)
      .order('timestamp', { ascending: false })
      .limit(5),
    // Pending LoRa downlink actions - gateway also polls /device/pending-actions/:trip_id
    supabase
      .from('device_pending_actions')
      .select('id, action, data, status, created_at')
      .eq('trip_id', req.params.trip_id)
      .in('status', ['pending', 'sent'])
      .order('created_at', { ascending: true })
      .limit(20),
  ]);
  const { data, error } = alertsResult;
  if (error) return res.status(400).json({ error: error.message });
  res.json({
    force_ended: false,
    alerts: data ?? [],
    pending_actions: pendingResult.data ?? [],
    rest_threshold_ms: Math.round(thr.rest_hours * 3600 * 1000),
    overspeed_kmh: thr.overspeed_kmh ?? 0,
    mobile_companion_active: mobileCompanionActive,
    nav_destination:      tripRow?.assigned_destination    ?? null,
    nav_dest_lat:         tripRow?.dest_lat                ?? null,
    nav_dest_lon:         tripRow?.dest_lon                ?? null,
    nav_dist_m:           tripRow?.route_dist_m            ?? null,
    nav_dur_s:            tripRow?.route_dur_s             ?? null,
    nav_step_instruction: tripRow?.nav_step_instruction    ?? null,
    nav_step_dist_m:      tripRow?.nav_step_dist_m         ?? null,
    nav_step_type:        tripRow?.nav_step_type           ?? null,
    nav_state:            tripRow?.nav_state               ?? 'navigating',
    nav_current_step_index: tripRow?.nav_current_step_index ?? null,
    nav_next_street:      tripRow?.nav_next_street         ?? null,
    nav_gps_source:       tripRow?.nav_gps_source          ?? null,
    trip_status:          tripRow?.trip_status             ?? 'active',
    paused_at:            tripRow?.paused_at               ?? null,
    next_rest_alert_at:   tripRow?.next_rest_alert_at      ?? null,
    // Truck display refresh - included so the HMI can update its cached
    truck_code:           tripRow?.trucks?.truck_code      ?? null,
    truck_model:          tripRow?.trucks?.model           ?? null,
    // mid-trip calibration update from the admin propagates to the device
    tank_capacity_l:      tripRow?.trucks?.tank_capacity_l ?? 80.0,
    server_now:           new Date().toISOString(),
  });
});

// BIDIRECTIONAL LORA - pending-action queue + ACK loop.

const PENDING_ACTION_TYPES = new Set([
  'rest', 'resume', 'end_trip', 'snooze',
  'nav_update', 'threshold_update',
  'maintenance_alert', 'restricted_zone', 'truck_restricted_zone',
]);

// Server-driven downlinks (nav/threshold/alerts/zones) don't mutate state when ACKed -
const STATE_CHANGING_ACTIONS = new Set(['rest', 'resume', 'end_trip', 'snooze']);

async function applyPendingAction(action) {
  const { trip_id, truck_id, action: type, data } = action;
  const now = new Date().toISOString();
  const actionSource = action.created_by === 'mobile'
    ? 'mobile'
    : action.created_by === 'dashboard'
      ? 'dashboard'
      : 'lora_pending';
  const telemetryChannel = actionSource === 'mobile' ? 'mobile_app' : 'lora';

  if (type === 'end_trip') {
    const { data: trip } = await supabase
      .from('trip_sessions')
      .select('id, truck_id, driver_id, start_time, end_time, trip_status, paused_at, total_rest_seconds')
      .eq('id', trip_id)
      .single();
    if (!trip) throw new Error('trip not found');
    if (trip.trip_status === 'ended') {
      try { await finalizeTripDistanceAndMileage(trip_id); } catch (e) { console.error('[applyPendingAction/end mileage]', e.message); }
      await supabase.from('trucks').update({ device_last_seen: null }).eq('id', trip.truck_id);
      return;
    }
    const endTime = new Date();
    let finalRestSecs = trip.total_rest_seconds ?? 0;
    if (trip.paused_at) finalRestSecs += Math.round((endTime - new Date(trip.paused_at)) / 1000);
    const operatingHours = +(((endTime - new Date(trip.start_time)) / 3_600_000)).toFixed(2);
    await supabase.from('trip_sessions').update({
      end_time: endTime.toISOString(),
      trip_status: 'ended',
      operating_hours: operatingHours,
      total_rest_seconds: finalRestSecs,
      paused_at: null,
      last_action_source: actionSource,
      last_action_at: now,
      nav_state: null,
      nav_step_instruction: null,
      nav_step_dist_m: null,
      nav_step_type: null,
      nav_current_step_index: null,
      nav_next_street: null,
      nav_gps_source: null,
    }).eq('id', trip_id);
    try { await finalizeTripDistanceAndMileage(trip_id); } catch (e) { console.error('[applyPendingAction/end mileage]', e.message); }
    await supabase.from('trucks').update({ device_last_seen: null }).eq('id', trip.truck_id);
    try { await syncTruckStatus(trip.truck_id); } catch (e) { console.error('[applyPendingAction/end syncTruck]', e.message); }
    setImmediate(async () => {
      try { await resolveRestAlertsForTrip(trip_id, 'trip_ended'); } catch (e) { console.error('[applyPendingAction/end resolveAlerts]', e.message); }
      try { await upsertTripSummary(trip_id); } catch (e) { console.error('[applyPendingAction/end summary]', e.message); }
    });
    logTripEvent(trip_id, trip.truck_id, trip.driver_id, 'trip_ended', endTime.toISOString());
    await logTripStateTelemetry(trip_id, trip.truck_id, trip.driver_id, 'ended', {
      event_time: endTime.toISOString(),
      event_type: 'trip_ended',
      channel: telemetryChannel,
      source_device: 'hmi',
    });
    return;
  }

  if (type === 'rest') {
    const { data: trip } = await supabase
      .from('trip_sessions')
      .select('truck_id, driver_id, paused_at')
      .eq('id', trip_id)
      .single();
    if (!trip) throw new Error('trip not found');
    if (trip.paused_at) return; // already paused - no-op
    await supabase.from('trip_sessions').update({
      paused_at: now,
      trip_status: 'paused',
      next_rest_alert_at: null,
      snoozed_until: null,
      last_action_source: actionSource,
      last_action_at: now,
    }).eq('id', trip_id);
    logTripEvent(trip_id, trip.truck_id, trip.driver_id, 'rest_started', now);
    await logTripStateTelemetry(trip_id, trip.truck_id, trip.driver_id, 'paused', {
      event_time: now,
      event_type: 'rest_started',
      channel: telemetryChannel,
      source_device: 'hmi',
    });
    return;
  }

  if (type === 'resume') {
    const { data: trip } = await supabase
      .from('trip_sessions')
      .select('truck_id, driver_id, paused_at, total_rest_seconds')
      .eq('id', trip_id)
      .single();
    if (!trip) throw new Error('trip not found');
    if (!trip.paused_at) return; // not paused - no-op
    const restSecs = Math.round((new Date(now) - new Date(trip.paused_at)) / 1000);
    const newTotal = (trip.total_rest_seconds ?? 0) + restSecs;
    const thr = await getThresholds();
    const nextAlert = new Date(Date.now() + Math.round(thr.rest_hours * 3600 * 1000)).toISOString();
    await supabase.from('trip_sessions').update({
      paused_at: null,
      trip_status: 'active',
      total_rest_seconds: newTotal,
      snoozed_until: null,
      next_rest_alert_at: nextAlert,
      last_action_source: actionSource,
      last_action_at: now,
    }).eq('id', trip_id);
    try { await resolveRestAlertsForTrip(trip_id, 'driver_resumed'); } catch (e) { console.error('[applyPendingAction/resume resolveAlerts]', e.message); }
    logTripEvent(trip_id, trip.truck_id, trip.driver_id, 'trip_resumed', now);
    await logTripStateTelemetry(trip_id, trip.truck_id, trip.driver_id, 'active', {
      event_time: now,
      event_type: 'trip_resumed',
      channel: telemetryChannel,
      source_device: 'hmi',
    });
    return;
  }

  if (type === 'snooze') {
    const { data: trip } = await supabase
      .from('trip_sessions')
      .select('truck_id, driver_id')
      .eq('id', trip_id)
      .single();
    if (!trip) throw new Error('trip not found');
    const durationMs = Math.max(60_000, Math.min(3_600_000, data?.duration_ms ?? 600_000));
    const snoozedUntil = new Date(Date.now() + durationMs).toISOString();
    await supabase.from('trip_sessions').update({
      snoozed_until: snoozedUntil,
      last_action_source: actionSource,
      last_action_at: now,
    }).eq('id', trip_id);
    logTripEvent(trip_id, trip.truck_id, trip.driver_id, 'rest_snoozed', now);
    await logTripStateTelemetry(trip_id, trip.truck_id, trip.driver_id, 'active', {
      event_time: now,
      event_type: 'rest_snoozed',
      channel: telemetryChannel,
      source_device: 'hmi',
    });
    return;
  }

  // nav_update / threshold_update / maintenance_alert / restricted_zone:
}

// ?????????????????????????????????????????????????????????????????????
app.post('/device/pending-action', async (req, res) => {
  const { trip_id, truck_id, action, data = {}, created_by = 'system' } = req.body ?? {};
  if (!trip_id) return res.status(400).json({ error: 'trip_id required' });
  if (!action || !PENDING_ACTION_TYPES.has(action)) {
    return res.status(400).json({ error: `invalid action; must be one of: ${[...PENDING_ACTION_TYPES].join(', ')}` });
  }
  const { data: row, error } = await supabase
    .from('device_pending_actions')
    .insert({ trip_id, truck_id: truck_id ?? null, action, data, created_by })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(row);
});

// ?????????????????????????????????????????????????????????????????????
app.get('/device/pending-actions/:trip_id', requireDeviceKey, async (req, res) => {
  const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 50));
  const { data, error } = await supabase
    .from('device_pending_actions')
    .select('id, trip_id, truck_id, action, data, status, retry_count, created_at, sent_at')
    .eq('trip_id', req.params.trip_id)
    .in('status', ['pending', 'sent'])
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) return res.status(400).json({ error: error.message });
  res.json(data ?? []);
});

// ?????????????????????????????????????????????????????????????????????
app.post('/device/pending-action/:id/sent', requireDeviceKey, async (req, res) => {
  const { data: existing } = await supabase
    .from('device_pending_actions')
    .select('retry_count')
    .eq('id', req.params.id)
    .single();
  const nextRetry = (existing?.retry_count ?? 0) + 1;
  const { data, error } = await supabase
    .from('device_pending_actions')
    .update({ status: 'sent', sent_at: new Date().toISOString(), retry_count: nextRetry })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ?????????????????????????????????????????????????????????????????????
app.post('/device/pending-action/:id/ack', requireDeviceKey, async (req, res) => {
  const { success = true, failure_reason = null } = req.body ?? {};
  const { data: action } = await supabase
    .from('device_pending_actions')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (!action) return res.status(404).json({ error: 'pending action not found' });

  if (!success) {
    const { data, error } = await supabase
      .from('device_pending_actions')
      .update({ status: 'failed', failed_at: new Date().toISOString(), failure_reason })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) return res.status(400).json({ error: error.message });
    return res.json(data);
  }

  await supabase
    .from('device_pending_actions')
    .update({ status: 'acked', acked_at: new Date().toISOString() })
    .eq('id', req.params.id);

  // Apply the real state change if this action mutates state.
  if (STATE_CHANGING_ACTIONS.has(action.action) && action.data?.server_applied !== true) {
    try {
      await applyPendingAction(action);
    } catch (e) {
      console.error(`[applyPendingAction/${action.action}]`, e.message);
      const { data, error } = await supabase
        .from('device_pending_actions')
        .update({ status: 'failed', failed_at: new Date().toISOString(), failure_reason: e.message })
        .eq('id', req.params.id)
        .select()
        .single();
      if (error) return res.status(400).json({ error: error.message });
      return res.json(data);
    }
  }

  const { data, error } = await supabase
    .from('device_pending_actions')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ?????????????????????????????????????????????????????????????????????
app.post('/device/pending-action/:id/fail', requireDeviceKey, async (req, res) => {
  const { failure_reason = 'retry_exhausted' } = req.body ?? {};
  const { data, error } = await supabase
    .from('device_pending_actions')
    .update({ status: 'failed', failed_at: new Date().toISOString(), failure_reason })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ?????????????????????????????????????????????????????????????
// ?????????????????????????????????????????????????????????????
app.get('/trip-events', requireDashboard, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit ?? '100'), 500);
  let query = supabase
    .from('trip_events')
    .select('id, event_type, timestamp, trip_id, truck_id, driver_id')
    .order('timestamp', { ascending: false })
    .limit(limit);

  if (req.query.trip_id)  query = query.eq('trip_id',  req.query.trip_id);
  if (req.query.truck_id) query = query.eq('truck_id', req.query.truck_id);

  const { data, error } = await query;
  if (error) return res.status(400).json({ error: error.message });

  const events = data ?? [];
  if (events.length === 0) return res.json([]);

  // Enrich with truck code and driver name in one pass
  const truckIds  = [...new Set(events.map(e => e.truck_id).filter(Boolean))];
  const driverIds = [...new Set(events.map(e => e.driver_id).filter(Boolean))];

  const [trucksRes, driversRes] = await Promise.all([
    truckIds.length  ? supabase.from('trucks').select('id, truck_code').in('id', truckIds)         : { data: [] },
    driverIds.length ? supabase.from('drivers').select('id, full_name').in('id', driverIds)        : { data: [] },
  ]);

  const truckMap  = Object.fromEntries((trucksRes.data  ?? []).map(t => [t.id, t.truck_code]));
  const driverMap = Object.fromEntries((driversRes.data ?? []).map(d => [d.id, d.full_name]));

  res.json(events.map(e => ({
    ...e,
    truck_code:  truckMap[e.truck_id]   ?? null,
    driver_name: driverMap[e.driver_id] ?? null,
  })));
});

// ?????????????????????????????????????????????????????????????
app.get('/fleet/status', requireDashboard, async (req, res) => {
  const [trucksRes, thr, telRes, tripRes, driverRes, userRes, econRes] = await Promise.all([
    supabase.from('trucks').select('*').order('truck_code'),
    getThresholds(),
    supabase.from('telemetry_logs')
      .select('truck_id, fuel_level, lat, lon, speed, odometer_km, timestamp, sent_at, anomaly_flag, gps_source, source_device, comm_channel, original_device_timestamp, hmi_driving_sec, hmi_rest_sec, hmi_trip_status')
      .order('timestamp', { ascending: false })
      .limit(150),
    // All active/paused trips
    supabase.from('trip_sessions')
      .select('id, truck_id, start_time, distance_km, operating_hours, driver_id, trip_status, paused_at, total_rest_seconds, next_rest_alert_at, assigned_destination, mobile_lat, mobile_lon, mobile_gps_at, mobile_gps_accuracy, mobile_gps_heading')
      .in('trip_status', ['active', 'paused'])
      .order('start_time', { ascending: false }),
    supabase.from('drivers').select('id, full_name'),
    supabase.from('users').select('id, full_name'),
    // Lifetime fuel-economy sample: derive per-truck avg fuel-per-km from
    supabase.from('trip_summaries')
      .select('truck_id, total_distance_km, start_fuel_level, final_fuel_level, total_anomalies')
      .not('total_distance_km', 'is', null)
      .gte('total_distance_km', 3.0)
      .not('start_fuel_level', 'is', null)
      .not('final_fuel_level', 'is', null)
      .eq('total_anomalies', 0)
      .gte('start_time', new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString())
      .limit(2000),
  ]);

  if (trucksRes.error) return res.status(400).json({ error: trucksRes.error.message });
  const trucks = trucksRes.data;
  let effectiveTelRes = telRes;
  if (telRes.error && /Could not find the 'hmi_(driving_sec|rest_sec|trip_status)' column/.test(telRes.error.message ?? '')) {
    console.warn('[fleet/status] hmi clock columns missing; using telemetry fallback');
    effectiveTelRes = await supabase.from('telemetry_logs')
      .select('truck_id, fuel_level, lat, lon, speed, odometer_km, timestamp, sent_at, anomaly_flag, gps_source, source_device, original_device_timestamp')
      .order('timestamp', { ascending: false })
      .limit(150);
  }

  // Build lookup maps from wave 1
  const latestTelByTruck = {};
  const latestHmiClockByTruck = {};
  for (const row of (effectiveTelRes.data ?? [])) {
    if (row.source_device === 'mobile') continue;
    if (!latestTelByTruck[row.truck_id]) latestTelByTruck[row.truck_id] = row;
    const hasHmiClock = Number.isFinite(Number(row.hmi_driving_sec));
    if (hasHmiClock) {
      const current = latestHmiClockByTruck[row.truck_id];
      const rowClockAt = new Date(row.sent_at ?? row.original_device_timestamp ?? row.timestamp).getTime();
      const currentClockAt = current
        ? new Date(current.sent_at ?? current.original_device_timestamp ?? current.timestamp).getTime()
        : NaN;
      if (!current || !Number.isFinite(currentClockAt) || rowClockAt > currentClockAt) {
        latestHmiClockByTruck[row.truck_id] = row;
      }
    }
  }
  // For each truck keep only the most recent active/paused trip
  const tripByTruck = {};
  for (const row of (tripRes.data ?? [])) {
    if (!tripByTruck[row.truck_id]) tripByTruck[row.truck_id] = row;
  }
  const driverNameById = {};
  for (const d of (driverRes.data ?? [])) driverNameById[d.id] = d.full_name;
  for (const u of (userRes.data ?? []))   driverNameById[u.id] ??= u.full_name;

  // Aggregate lifetime fuel economy per truck: for each trip in the sample,
  const econAggByTruck = {};
  for (const row of (econRes?.data ?? [])) {
    const id = row.truck_id;
    if (!id) continue;
    const dist    = Number(row.total_distance_km);
    const startFl = Number(row.start_fuel_level);
    const finalFl = Number(row.final_fuel_level);
    if (!Number.isFinite(dist)   || dist    < 3.0) continue;
    if (!Number.isFinite(startFl) || !Number.isFinite(finalFl)) continue;
    const used = startFl - finalFl;
    if (used <= 1.0) continue;  // trip didn't measurably burn fuel - skip
    // Reject trips with implausible per-trip ratios (< 0.05 %/km or
    const perKmRatio = used / dist;
    if (perKmRatio < 0.05 || perKmRatio > 3.0) continue;
    if (!econAggByTruck[id]) econAggByTruck[id] = { fuelSum: 0, distSum: 0, n: 0 };
    econAggByTruck[id].fuelSum += used;
    econAggByTruck[id].distSum += dist;
    econAggByTruck[id].n       += 1;
  }
  const avgFuelPerKmByTruck = {};
  for (const [id, { fuelSum, distSum, n }] of Object.entries(econAggByTruck)) {
    if (n >= 1 && distSum > 0) {
      avgFuelPerKmByTruck[id] = +(fuelSum / distSum).toFixed(4);
    }
  }

  const activeTripIds  = Object.values(tripByTruck).map(t => t.id);
  const activeDriverIds = Object.values(tripByTruck).map(t => t.driver_id).filter(Boolean);

  let resumeEventsByTrip   = {};
  let snoozeEventsByTrip   = {};
  let alertsByTrip         = {};
  let alertCountsByTrip    = {};
  let mobileActiveByDriver = {}; // driver_id -> true if mobile companion polled within 30s

  if (activeTripIds.length > 0) {
    const mobileThreshold = new Date(Date.now() - 30_000).toISOString(); // 30s stale window
    const [eventsRes, alertsRes, hmiSessRes] = await Promise.all([
      supabase.from('trip_events')
        .select('trip_id, event_type, timestamp')
        .in('trip_id', activeTripIds)
        .in('event_type', ['trip_resumed', 'rest_snoozed'])
        .order('timestamp', { ascending: false }),
      supabase.from('alerts')
        .select('trip_id, truck_id, alert_type', { count: 'exact' })
        .in('trip_id', activeTripIds)
        .eq('is_resolved', false)
        .order('timestamp', { ascending: false }),
      activeDriverIds.length
        ? supabase.from('hmi_sessions')
            .select('driver_id, mobile_last_seen')
            .eq('status', 'active')
            .in('driver_id', activeDriverIds)
            .gt('mobile_last_seen', mobileThreshold)
        : { data: [] },
    ]);

    // latest resume + snooze per trip
    for (const ev of (eventsRes.data ?? [])) {
      if (ev.event_type === 'trip_resumed' && !resumeEventsByTrip[ev.trip_id])
        resumeEventsByTrip[ev.trip_id] = ev.timestamp;
      if (ev.event_type === 'rest_snoozed' && !snoozeEventsByTrip[ev.trip_id])
        snoozeEventsByTrip[ev.trip_id] = ev.timestamp;
    }
    // rest_alert beats maintenance beats low_fuel), matching deriveTruckStatus.
    const alertPrioByTrip = {};
    for (const a of (alertsRes.data ?? [])) {
      const p = ALERT_STATUS_PRIORITY[a.alert_type] ?? 0;
      if (!(a.trip_id in alertPrioByTrip) || p > alertPrioByTrip[a.trip_id]) {
        alertPrioByTrip[a.trip_id] = p;
        alertsByTrip[a.trip_id]    = a.alert_type;
      }
    }
    // dashboard can render an unresolved-anomaly stat card independent of
    const countMap = {};
    const fuelAnomalyCountByTrip = {};
    for (const a of (alertsRes.data ?? [])) {
      countMap[a.trip_id] = (countMap[a.trip_id] ?? 0) + 1;
      if (a.alert_type === 'fuel_anomaly') {
        fuelAnomalyCountByTrip[a.trip_id] = (fuelAnomalyCountByTrip[a.trip_id] ?? 0) + 1;
      }
    }
    alertCountsByTrip = countMap;
    // Attach the per-type count so the outer scope can read it.
    alertsByTrip.__fuel_anomaly_counts = fuelAnomalyCountByTrip;
    // mobile companion active per driver
    for (const row of (hmiSessRes.data ?? [])) {
      if (row.driver_id) mobileActiveByDriver[row.driver_id] = true;
    }
  }

  // ?? Assemble response ?????????????????????????????????????????????????????
  const SNOOZE_MS = 600_000;
  const ONLINE_MS = 2 * 60 * 1000;
  const now = Date.now();

  const statuses = trucks.map((truck) => {
    const latest       = latestTelByTruck[truck.id] ?? null;
    const hmiClock     = latestHmiClockByTruck[truck.id] ?? null;
    const trip         = tripByTruck[truck.id]      ?? null;
    const driverName   = trip?.driver_id ? (driverNameById[trip.driver_id] ?? null) : null;
    const lastResumedAt = trip ? (resumeEventsByTrip[trip.id] ?? null) : null;
    const lastSnoozedAt = trip ? (snoozeEventsByTrip[trip.id] ?? null) : null;
    const topAlertType  = trip ? (alertsByTrip[trip.id]       ?? null) : null;
    const alertCount    = trip ? (alertCountsByTrip[trip.id]  ?? 0)    : 0;

    // Server-side fallback calculation was removed: it produced inaccurate values after
    const nextRestAlertAt = (trip?.trip_status === 'active' && trip?.next_rest_alert_at)
      ? trip.next_rest_alert_at
      : null;

    const isOnline = latest?.timestamp
      ? now - new Date(latest.timestamp).getTime() < ONLINE_MS
      : false;

    // mobile_companion_active = true when driver's mobile app polled within last 30s
    const mobileCompanionActive = trip?.driver_id
      ? (mobileActiveByDriver[trip.driver_id] ?? false)
      : false;

    const alertDerivedStatus = statusFromAlertType(topAlertType);
    const effectiveStatus =
      trip?.trip_status === 'paused' ? 'paused'
      : alertDerivedStatus           ? alertDerivedStatus
      : trip                         ? 'active'
      :                                'idle';
    const bestGps = chooseBestGps(latest, trip, now);
    // Live mileage: trucks.current_odometer_km is finalized only at trip-end
    const baseOdometerKm = Number(truck.current_odometer_km ?? latest?.odometer_km);
    const inProgressKm = (trip && (trip.trip_status === 'active' || trip.trip_status === 'paused'))
      ? Number(trip.distance_km ?? 0)
      : 0;
    const currentOdometerKm = Number.isFinite(baseOdometerKm)
      ? baseOdometerKm + (Number.isFinite(inProgressKm) ? inProgressKm : 0)
      : baseOdometerKm;
    const lastMaintenanceOdometerKm = Number(truck.last_maintenance_odometer_km);
    const maintenanceIntervalKm = Number(truck.maintenance_interval_km ?? thr.maintenance_km);
    const kmSinceMaintenance = (
      Number.isFinite(currentOdometerKm) &&
      Number.isFinite(lastMaintenanceOdometerKm)
    ) ? Math.max(0, currentOdometerKm - lastMaintenanceOdometerKm) : null;
    const maintenanceKmRemaining = (
      kmSinceMaintenance != null &&
      Number.isFinite(maintenanceIntervalKm) &&
      maintenanceIntervalKm > 0
    ) ? Math.max(0, maintenanceIntervalKm - kmSinceMaintenance) : null;

    return {
      id:               truck.id,
      truck_code:       truck.truck_code,
      plate_number:     truck.plate_number,
      model:            truck.model,
      status:           effectiveStatus,
      device_installed: truck.device_installed,

      lat:            bestGps.lat,
      lon:            bestGps.lon,
      gps_source:     bestGps.gps_source,
      gps_at:         bestGps.gps_at,
      source_device:  bestGps.source_device,

      fuel_level:   latest?.fuel_level  ?? null,
      speed:        latest?.speed       ?? null,
      odometer_km:  latest?.odometer_km ?? null,
      current_odometer_km: Number.isFinite(currentOdometerKm) ? +currentOdometerKm.toFixed(1) : null,
      last_maintenance_odometer_km: Number.isFinite(lastMaintenanceOdometerKm) ? +lastMaintenanceOdometerKm.toFixed(1) : null,
      maintenance_interval_km: Number.isFinite(maintenanceIntervalKm) ? +maintenanceIntervalKm.toFixed(1) : null,
      km_since_maintenance: kmSinceMaintenance != null ? +kmSinceMaintenance.toFixed(1) : null,
      maintenance_km_remaining: maintenanceKmRemaining != null ? +maintenanceKmRemaining.toFixed(1) : null,
      last_update:  latest?.timestamp   ?? null,
      is_online:    isOnline,
      anomaly_flag: latest?.anomaly_flag ?? false,

      trip_id:            trip?.id                  ?? null,
      trip_status:        trip?.trip_status         ?? 'idle',
      trip_start_time:    trip?.start_time          ?? null,
      distance_km:        trip?.distance_km         ?? 0,
      operating_hours:    trip ? computeHmiOperatingHours(trip, hmiClock, isOnline) : 0,
      hmi_driving_sec:    hmiClock?.hmi_driving_sec ?? null,
      hmi_rest_sec:       hmiClock?.hmi_rest_sec    ?? null,
      hmi_trip_status:    hmiClock?.hmi_trip_status ?? null,
      hmi_clock_at:       hmiClock?.sent_at ?? hmiClock?.original_device_timestamp ?? hmiClock?.timestamp ?? null,
      paused_at:          trip?.paused_at           ?? null,
      total_rest_seconds: trip?.total_rest_seconds  ?? 0,
      driver_id:          trip?.driver_id           ?? null,
      driver_name:        driverName,

      active_alert_count:      alertCount,
      // Count of unresolved fuel_anomaly alerts on the current trip.
      unresolved_fuel_anomaly_count:
        (trip && alertsByTrip.__fuel_anomaly_counts?.[trip.id]) || 0,
      device_last_seen:        truck.device_last_seen ?? null,
      next_rest_alert_at:      nextRestAlertAt,
      rest_threshold_hours:    thr.rest_hours,
      assigned_destination:    trip?.assigned_destination ?? null,
      mobile_companion_active: mobileCompanionActive,
      length_m:   truck.length_m   ?? null,
      width_m:    truck.width_m    ?? null,
      height_m:   truck.height_m   ?? null,
      weight_t:   truck.weight_t   ?? null,
      axleload_t: truck.axleload_t ?? null,
      hazmat:     truck.hazmat     ?? false,
      // Per-vehicle fuel-tank capacity, surfaced so the dashboard can render
      tank_capacity_l: truck.tank_capacity_l ?? 80.0,
      // Lifetime fuel economy: prefer the measured trip-summary-derived
      avg_fuel_per_km:
        avgFuelPerKmByTruck[truck.id] ??
        ((truck.spec_km_per_l != null && truck.tank_capacity_l > 0)
          ? +(100.0 / (Number(truck.spec_km_per_l) * Number(truck.tank_capacity_l))).toFixed(4)
          : null),
    };
  });

  res.json({ server_now: new Date().toISOString(), trucks: statuses });
});

// ?????????????????????????????????????????????????????????????

app.get('/trucks', requireDashboard, async (_req, res) => {
  const { data: trucks, error } = await supabase
    .from('trucks')
    .select('*')
    .order('truck_code');

  if (error) return res.status(400).json({ error: error.message });

  // Attach assigned driver to each truck
  const result = await Promise.all(trucks.map(async (truck) => {
    const { data: driver } = await supabase
      .from('users')
      .select('id, full_name, email')
      .eq('assigned_truck_id', truck.id)
      .single();
    return { ...truck, driver: driver ?? null };
  }));

  res.json(result);
});

// GET /trucks/:id - single truck with assigned driver
app.get('/trucks/:id', requireDashboard, async (req, res) => {
  const { data: truck, error } = await supabase
    .from('trucks')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(404).json({ error: 'Truck not found' });

  const { data: driver } = await supabase
    .from('users')
    .select('id, full_name, username')
    .eq('assigned_truck_id', truck.id)
    .single();

  res.json({ ...truck, driver: driver ?? null });
});

// GET /trucks/:id/telemetry/latest - most recent telemetry reading
app.get('/trucks/:id/telemetry/latest', requireDashboard, async (req, res) => {
  const { data, error } = await supabase
    .from('telemetry_logs')
    .select('*')
    .eq('truck_id', req.params.id)
    .order('timestamp', { ascending: false })
    .limit(1)
    .single();

  if (error) return res.status(404).json({ error: 'No telemetry found' });
  res.json(data);
});

app.get('/trucks/:id/telemetry/history', requireDashboard, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit ?? '50'), 500);

  // flushed late appear at their correct chronological position, not at flush time.
  let query = supabase
    .from('telemetry_logs')
    .select('id, truck_id, driver_id, trip_id, timestamp, sent_at, fuel_level, lat, lon, speed, odometer_km, engine_status, anomaly_flag, anomaly_score, model_source, gps_source, source_device, original_device_timestamp, gps_accuracy_m, gps_heading_deg')
    .eq('truck_id', req.params.id)
    .or('source_device.is.null,source_device.neq.mobile')
    .order('sent_at',   { ascending: false, nullsFirst: false })
    .order('timestamp', { ascending: false })
    .limit(limit);

  if (req.query.trip_id) query = query.eq('trip_id', req.query.trip_id);

  const { data, error } = await query;

  if (error) return res.status(400).json({ error: error.message });
  const withStatuses = await attachTripStatus(data ?? []);
  const fused = await fuseMobileGpsIntoTelemetryLogs(withStatuses, 'telemetry_logs');
  res.json(fused.reverse());
});

// GET /trucks/:id/trips - all trips for a truck
app.get('/trucks/:id/trips', requireDashboard, async (req, res) => {
  const { data, error } = await supabase
    .from('trip_sessions')
    .select('*')
    .eq('truck_id', req.params.id)
    .neq('trip_status', 'discarded')
    .order('start_time', { ascending: false });

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ?????????????????????????????????????????????????????????????

// GET /trips/summaries - MUST be defined before /trips/:id to prevent route shadowing
app.get('/trips/summaries', requireDashboard, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit ?? '200'), 1000);
  const dateFrom = req.query.days
    ? new Date(Date.now() - Math.min(parseInt(req.query.days, 10), 3650) * 86400000).toISOString()
    : parseDateStart(req.query.date_from);
  const dateTo = parseDateEnd(req.query.date_to);

  let query = supabase
    .from('trip_summaries')
    .select('*')
    .neq('trip_status', 'discarded')
    .order('end_time', { ascending: false, nullsFirst: false })
    .limit(limit);

  if (req.query.truck_id) query = query.eq('truck_id', req.query.truck_id);
  if (req.query.driver_id) query = query.eq('driver_id', req.query.driver_id);
  if (req.query.trip_id) query = query.eq('trip_id', req.query.trip_id);
  if (dateFrom) query = query.gte('start_time', dateFrom);
  if (dateTo) query = query.lte('end_time', dateTo);

  const { data, error } = await query;
  if (error) return res.status(400).json({ error: error.message });

  const rows = data ?? [];
  const totals = rows.reduce((acc, row) => {
    acc.total_distance_km += Number(row.total_distance_km ?? 0);
    acc.total_operating_hours += Number(row.total_operating_hours ?? 0);
    acc.total_alerts += Number(row.total_alerts ?? 0);
    acc.total_anomalies += Number(row.total_anomalies ?? 0);
    if (row.average_fuel_level != null) {
      acc.average_fuel_total += Number(row.average_fuel_level);
      acc.average_fuel_count += 1;
    }
    return acc;
  }, {
    total_distance_km: 0,
    total_operating_hours: 0,
    total_alerts: 0,
    total_anomalies: 0,
    average_fuel_total: 0,
    average_fuel_count: 0,
  });

  res.json({
    items: rows,
    count: rows.length,
    totals: {
      total_distance_km: +totals.total_distance_km.toFixed(1),
      total_operating_hours: +totals.total_operating_hours.toFixed(2),
      total_alerts: totals.total_alerts,
      total_anomalies: totals.total_anomalies,
      average_fuel_level: totals.average_fuel_count
        ? +(totals.average_fuel_total / totals.average_fuel_count).toFixed(2)
        : null,
    },
  });
});

// GET /trips/:id - single trip details
app.get('/trips/:id', requireDashboard, async (req, res) => {
  const { data: trip, error } = await supabase
    .from('trip_sessions')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(404).json({ error: 'Trip not found' });

  const [{ data: truck }, { data: driver }] = await Promise.all([
    supabase.from('trucks').select('truck_code, plate_number, model').eq('id', trip.truck_id).single(),
    supabase.from('drivers').select('full_name').eq('id', trip.driver_id).single(),
  ]);

  res.json({ ...trip, truck: truck ?? null, driver: driver ?? null });
});

// GET /trips/:id/route - GPS polyline for a trip
app.get('/trips/:id/route', requireDashboard, async (req, res) => {
  const [liveRes, archivedRes] = await Promise.all([
    supabase
      .from('telemetry_logs')
      .select('lat, lon, fuel_level, speed, timestamp, sent_at, engine_status, gps_source, source_device, original_device_timestamp')
      .eq('trip_id', req.params.id)
      .not('lat', 'is', null)
      .not('lon', 'is', null)
      .order('sent_at',   { ascending: true, nullsFirst: false })
      .order('timestamp', { ascending: true }),
    supabase
      .from('archived_telemetry_logs')
      .select('lat, lon, fuel_level, speed, timestamp, sent_at, engine_status, gps_source, source_device, original_device_timestamp')
      .eq('trip_id', req.params.id)
      .not('lat', 'is', null)
      .not('lon', 'is', null)
      .order('sent_at',   { ascending: true, nullsFirst: false })
      .order('timestamp', { ascending: true }),
  ]);

  if (liveRes.error) return res.status(400).json({ error: liveRes.error.message });
  const archivedRows = archivedRes.error ? [] : (archivedRes.data ?? []);

  const merged = [...(liveRes.data ?? []), ...archivedRows]
    .filter(r => isValidGpsPoint(r.lat, r.lon))
    .sort((a, b) => effectiveGpsTime(a) - effectiveGpsTime(b));

  const deduped = [];
  for (const row of merged) {
    const last = deduped[deduped.length - 1];
    const nearTime = last && Math.abs(effectiveGpsTime(row) - effectiveGpsTime(last)) <= GPS_MERGE_WINDOW_MS;
    const nearPoint = last && gpsDistanceM(row, last) <= 15;
    if (nearTime && nearPoint) {
      const rowIsEmbedded = (row.source_device ?? 'hmi') !== 'mobile';
      const lastIsMobile = last.source_device === 'mobile';
      if (rowIsEmbedded && lastIsMobile) deduped[deduped.length - 1] = row;
      continue;
    }
    deduped.push(row);
  }

  const realPoints = deduped.map(r => ({
    ...r,
    gps_source: r.gps_source ?? (r.source_device === 'mobile' ? 'mobile_gps' : 'embedded_gps'),
    source_device: r.source_device ?? 'hmi',
  }));

  // segment, so the rendered polyline follows the actual roads taken instead
  if (req.query.fill === '1' && realPoints.length >= 2) {
    try {
      const snapped = await snapRouteToRoads(realPoints);
      if (snapped && snapped.length >= 2) return res.json(snapped);
    } catch (e) {
      console.warn('[route] OSRM snap failed, returning raw fixes:', e.message);
    }
  }

  res.json(realPoints);
});

// ?? Truck-aware route prediction (start -> end) ???????????????????????????
const OSRM_HOST          = process.env.OSRM_BASE_URL
                           ?? 'https://router.project-osrm.org';
// without having to duplicate it under a different key.
const ORS_KEY            = process.env.ORS_KEY ?? process.env.VITE_ORS_KEY ?? '';
const ROUTE_TIMEOUT_MS   = 10_000;

// Gap detection thresholds - between two consecutive real GPS fixes, if the
const SNAP_GAP_DISTANCE_M = 250;
const SNAP_MAX_OSRM_CALLS = 8;

async function snapRouteToRoads(points) {
  if (points.length < 2) return points;

  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    const d = gpsDistanceM(points[i], points[i + 1]);
    if (d > SNAP_GAP_DISTANCE_M) segments.push({ idx: i, distM: d });
  }
  if (segments.length === 0) return points;

  //    GPS-loss gap on a straight road).
  segments.sort((a, b) => b.distM - a.distM);
  const gapsToFill = new Map(); // idx -> array of [lon, lat] waypoints to splice IN AFTER points[idx]
  let osrmCalls = 0;
  for (const { idx } of segments) {
    if (osrmCalls >= SNAP_MAX_OSRM_CALLS) break;
    const a = points[idx], b = points[idx + 1];
    const coords = ORS_KEY
      ? await orsTruckRoute(a, b)
      : await osrmDrivingRoute(a, b);
    osrmCalls += 1;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const inner = coords.slice(1, -1);
    if (inner.length > 0) gapsToFill.set(idx, inner);
  }

  if (gapsToFill.size === 0) return points;

  //    points so detours are still visible.
  const out = [];
  const snapSource = ORS_KEY ? 'ors_truck' : 'osrm_driving';
  for (let i = 0; i < points.length; i++) {
    out.push(points[i]);
    const bridge = gapsToFill.get(i);
    if (bridge) {
      for (const [lon, lat] of bridge) {
        out.push({
          lat, lon,
          gps_source: snapSource,
          source_device: 'snapped',
        });
      }
    }
  }
  return out;
}

async function orsTruckRoute(a, b) {
  const url = 'https://api.openrouteservice.org/v2/directions/driving-hgv/geojson';
  const body = { coordinates: [[a.lon, a.lat], [b.lon, b.lat]] };
  const data = await routingFetch(url, {
    method:  'POST',
    headers: {
      Authorization: ORS_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json, application/geo+json',
    },
    body: JSON.stringify(body),
  });
  return data?.features?.[0]?.geometry?.coordinates ?? null;
}

async function osrmDrivingRoute(a, b) {
  const url = `${OSRM_HOST}/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}`
            + `?geometries=geojson&overview=full`;
  const data = await routingFetch(url);
  return data?.routes?.[0]?.geometry?.coordinates ?? null;
}

async function routingFetch(url, init = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ROUTE_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...init, signal: ctrl.signal });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// POST /trip/start - start a new trip
app.post('/trip/start', requireDeviceKey, async (req, res) => {
  const { truck_id, driver_id, start_lat, start_lon, trip_id, start_time, source } = req.body;

  if (!truck_id || !driver_id)
    return res.status(400).json({ error: 'truck_id and driver_id required' });

  // Mobile cannot start trips independently - HMI must be present and active
  if (source === 'mobile_app') {
    const hmiSession = await getActiveHmiSession(driver_id);
    if (!hmiSession) {
      return res.status(403).json({
        error: 'Cannot start trip: the truck\'s embedded display (HMI) is not connected.',
        code:  'HMI_REQUIRED',
      });
    }
  }

  const { data: driverTrip } = await supabase
    .from('trip_sessions')
    .select('id, truck_id, driver_id, trip_status, start_time, paused_at, total_rest_seconds, next_rest_alert_at, trucks(truck_code)')
    .eq('driver_id', driver_id)
    .in('trip_status', ['active', 'paused'])
    .order('start_time', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (driverTrip) {
    if (driverTrip.truck_id === truck_id) {
      const { data: currentTrip } = await supabase
        .from('trip_sessions')
        .select('*, trucks(truck_code, plate_number, length_m, width_m, height_m, weight_t, axleload_t, hazmat, tank_capacity_l)')
        .eq('id', driverTrip.id)
        .single();
      console.log(`[trip] idempotent start - returning existing trip=${driverTrip.id}`);
      return res.status(200).json(currentTrip);
    }
    // Driver is on a DIFFERENT truck - hard block
    console.log(`[trip] blocked: driver=${driver_id} already active on truck=${driverTrip.truck_id}`);
    return res.status(409).json({
      error: 'Driver already has an active trip',
      code:  'DRIVER_ACTIVE',
      active_trip: {
        id:         driverTrip.id,
        truck_id:   driverTrip.truck_id,
        driver_id:  driverTrip.driver_id,
        truck_code: driverTrip.trucks?.truck_code ?? '',
        trip_status: driverTrip.trip_status,
        start_time: driverTrip.start_time,
        paused_at: driverTrip.paused_at,
        total_rest_seconds: driverTrip.total_rest_seconds ?? 0,
        next_rest_alert_at: driverTrip.next_rest_alert_at ?? null,
      },
    });
  }

  const { data: truckTrip } = await supabase
    .from('trip_sessions')
    .select('id, driver_id, trip_status, drivers(full_name)')
    .eq('truck_id', truck_id)
    .in('trip_status', ['active', 'paused'])
    .order('start_time', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (truckTrip) {
    // Truck is in use by a DIFFERENT driver - hard block
    console.log(`[trip] blocked: truck=${truck_id} already active with driver=${truckTrip.driver_id}`);
    return res.status(409).json({
      error: 'Truck is already in use',
      code:  'TRUCK_ACTIVE',
      active_trip: {
        id:          truckTrip.id,
        driver_name: truckTrip.drivers?.full_name ?? 'another driver',
        trip_status: truckTrip.trip_status,
      },
    });
  }

  // Clear stale trip-state alerts from the previous session so the truck
  await supabase
    .from('alerts')
    .update({ is_resolved: true })
    .eq('truck_id', truck_id)
    .eq('is_resolved', false)
    .in('alert_type', ['rest_alert', 'overspeed']);

  const insertRow = {
    truck_id,
    driver_id,
    start_lat,
    start_lon,
    trip_status:        'active',
    last_action_source: source ?? 'hmi',
    last_action_at:     new Date().toISOString(),
  };
  if (trip_id)    insertRow.id         = trip_id;    // device-generated UUID for offline sync
  if (start_time) insertRow.start_time = start_time;

  const { data, error } = await supabase
    .from('trip_sessions')
    .insert([insertRow])
    .select('id, truck_id, driver_id, trip_status, start_time, end_time, paused_at, total_rest_seconds, next_rest_alert_at, distance_km, trucks(truck_code, plate_number, length_m, width_m, height_m, weight_t, axleload_t, hazmat, tank_capacity_l)')
    .single();

  if (error) {
    if (error.code === '23505') {
      const { data: existing } = await supabase
        .from('trip_sessions')
        .select('*, trucks(truck_code, plate_number, length_m, width_m, height_m, weight_t, axleload_t, hazmat, tank_capacity_l)')
        .eq('truck_id', truck_id)
        .in('trip_status', ['active', 'paused'])
        .order('start_time', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existing) {
        console.log(`[trip] race-condition conflict resolved - returning existing trip=${existing.id}`);
        return res.status(200).json(existing);
      }
    }
    return res.status(400).json({ error: error.message });
  }

  // Respond immediately so the device transitions to TRIP_ACTIVE without waiting.
  res.status(201).json(data);
  touchDevice(truck_id);
  try { await syncTruckStatus(truck_id); } catch (e) { console.error('[syncTruck/start]', e.message); }
  // either way it is the authoritative start time for this trip row.
  logTripEvent(data.id, truck_id, driver_id, 'trip_started', data.start_time || null);
  logTripStateTelemetry(data.id, truck_id, driver_id, 'active', {
    event_time: data.start_time || null,
    event_type: 'trip_started',
    channel: source === 'mobile_app' ? 'mobile_app' : 'lora',
    source_device: 'hmi',
  });
});

// POST /trip/end - end an active trip
// Accepts optional source ('hmi' | 'mobile') for conflict resolution / audit log.
app.post('/trip/end', requireDeviceKey, async (req, res) => {
  const { trip_id, end_lat, end_lon, end_time, source = 'hmi' } = req.body;

  if (!trip_id)
    return res.status(400).json({ error: 'trip_id required' });

  // Get trip including rest-tracking fields
  const { data: trip, error: fetchErr } = await supabase
    .from('trip_sessions')
    .select('id, truck_id, driver_id, start_time, end_time, trip_status, distance_km, paused_at, total_rest_seconds')
    .eq('id', trip_id)
    .single();

  if (fetchErr || !trip)
    return res.status(404).json({ error: 'Trip not found' });

  if (trip.trip_status === 'ended') {
    try {
      const mileage = await finalizeTripDistanceAndMileage(trip_id);
      return res.json({ ...trip, distance_km: mileage.distance_km ?? trip.distance_km, already_ended: true });
    } catch (e) {
      console.error('[trip/end mileage already-ended]', e.message);
      return res.json({ ...trip, already_ended: true, mileage_warning: e.message });
    }
  }

  const endTime = (end_time && !isNaN(Date.parse(end_time))) ? new Date(end_time) : new Date();

  // Accumulate any in-progress rest break
  let finalRestSecs = trip.total_rest_seconds ?? 0;
  if (trip.paused_at) {
    finalRestSecs += Math.round((endTime - new Date(trip.paused_at)) / 1000);
  }

  const elapsedMs      = endTime - new Date(trip.start_time);
  const operatingHours = +(elapsedMs / 3_600_000).toFixed(2);

  const { data, error } = await supabase
    .from('trip_sessions')
    .update({
      end_time:           endTime.toISOString(),
      trip_status:        'ended',
      end_lat,
      end_lon,
      operating_hours:    operatingHours,
      total_rest_seconds: finalRestSecs,
      paused_at:          null,
      last_action_source: source,
      last_action_at:     new Date().toISOString(),
      // Clear nav state so dashboard doesn't show stale guidance for ended trips
      nav_state:          null,
      nav_step_instruction: null,
      nav_step_dist_m:    null,
      nav_step_type:      null,
      nav_current_step_index: null,
      nav_next_street:    null,
      nav_gps_source:     null,
    })
    .eq('id', trip_id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  let responseData = data;
  try {
    const mileage = await finalizeTripDistanceAndMileage(trip_id);
    responseData = { ...data, distance_km: mileage.distance_km ?? data.distance_km };
  } catch (e) {
    console.error('[trip/end mileage]', e.message);
    responseData = { ...data, mileage_warning: e.message };
  }

  res.json(responseData);
  supabase.from('trucks').update({ device_last_seen: null }).eq('id', trip.truck_id).then(() => {});
  try { await syncTruckStatus(trip.truck_id); } catch (e) { console.error('[syncTruck/end]', e.message); }
  setImmediate(async () => {
    try { await resolveRestAlertsForTrip(trip_id, 'trip_ended'); } catch (e) { console.error('[resolveAlerts/end]', e.message); }
  });
  logTripEvent(trip_id, trip.truck_id, trip.driver_id, 'trip_ended', endTime.toISOString());
  logTripStateTelemetry(trip_id, trip.truck_id, trip.driver_id, 'ended', {
    event_time: endTime.toISOString(),
    event_type: 'trip_ended',
    channel: source === 'mobile' ? 'mobile_app' : 'lora',
    source_device: 'hmi',
  });
  setImmediate(async () => {
    try { await upsertTripSummary(trip_id); } catch (summaryErr) {
      console.error('[trip_summary]', summaryErr.message);
    }
  });
});

// POST /trip/force-end - head_admin only: forcibly end any active/paused trip
app.post('/trip/force-end', requireHeadAdmin, async (req, res) => {
  const { trip_id } = req.body;
  if (!trip_id) return res.status(400).json({ error: 'trip_id required' });

  const { data: trip, error: fetchErr } = await supabase
    .from('trip_sessions')
    .select('id, truck_id, driver_id, start_time, trip_status, distance_km, paused_at, total_rest_seconds')
    .eq('id', trip_id)
    .single();

  if (fetchErr || !trip) return res.status(404).json({ error: 'Trip not found' });

  if (trip.trip_status === 'ended') {
    let responseData = { ...trip, already_ended: true };
    try {
      const mileage = await finalizeTripDistanceAndMileage(trip_id);
      responseData = { ...responseData, distance_km: mileage.distance_km ?? trip.distance_km };
    } catch (e) {
      console.error('[trip/force-end mileage already-ended]', e.message);
      responseData.mileage_warning = e.message;
    }
    return res.json(responseData);
  }

  const endTime = new Date();
  let finalRestSecs = trip.total_rest_seconds ?? 0;
  if (trip.paused_at) {
    finalRestSecs += Math.round((endTime - new Date(trip.paused_at)) / 1000);
  }
  // Operating hours = total elapsed (driving + rest), consistent with normal trip/end
  const elapsedMs      = endTime - new Date(trip.start_time);
  const operatingHours = +(elapsedMs / 3_600_000).toFixed(2);

  const { data, error } = await supabase
    .from('trip_sessions')
    .update({
      end_time:           endTime.toISOString(),
      trip_status:        'ended',
      operating_hours:    operatingHours,
      total_rest_seconds: finalRestSecs,
      paused_at:          null,
    })
    .eq('id', trip_id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  let responseData = data;
  try {
    const mileage = await finalizeTripDistanceAndMileage(trip_id);
    responseData = { ...data, distance_km: mileage.distance_km ?? data.distance_km };
  } catch (e) {
    console.error('[trip/force-end mileage]', e.message);
    responseData = { ...data, mileage_warning: e.message };
  }

  await supabase.from('trucks').update({ device_last_seen: null }).eq('id', trip.truck_id);

  try { await resolveRestAlertsForTrip(trip_id, 'trip_ended'); } catch (e) { console.error('[resolveAlerts/force-end]', e.message); }
  await syncTruckStatus(trip.truck_id);
  logTripEvent(trip_id, trip.truck_id, trip.driver_id, 'trip_ended');
  try { await upsertTripSummary(trip_id); } catch {}

  console.log(`[trip] force-ended trip=${trip_id} by head_admin=${req.user.id}`);
  res.json(responseData);
});

// PATCH /trip/:id/assign-route - dashboard assigns a destination to an active trip
app.patch('/trip/:id/assign-route', requireDashboard, async (req, res) => {
  const tripId = req.params.id;
  const { destination, dest_lat, dest_lon, route_steps, route_dist_m, route_dur_s } = req.body;
  if (destination !== null && destination !== undefined && typeof destination !== 'string')
    return res.status(400).json({ error: 'destination must be a string or null' });

  const updates = {
    assigned_destination: destination ?? null,
    dest_lat:     dest_lat     ?? null,
    dest_lon:     dest_lon     ?? null,
    route_steps:  route_steps  ?? null,
    route_dist_m: route_dist_m ?? null,
    route_dur_s:  route_dur_s  ?? null,
  };

  const { data, error } = await supabase
    .from('trip_sessions')
    .update(updates)
    .eq('id', tripId)
    .in('trip_status', ['active', 'paused'])
    .select('id, truck_id, assigned_destination, dest_lat, dest_lon, route_dist_m, route_dur_s')
    .single();

  if (error || !data) return res.status(404).json({ error: 'Active trip not found' });
  res.json({ ok: true, trip_id: tripId, assigned_destination: data.assigned_destination });
  console.log(`[trip] route assigned trip=${tripId} destination="${destination}" dist=${route_dist_m}m`);
});

app.patch('/device/trip/:id/route', requireDeviceKey, async (req, res) => {
  const tripId = req.params.id;
  const { destination, dest_lat, dest_lon, route_steps, route_dist_m, route_dur_s } = req.body;
  if (!destination || dest_lat == null || dest_lon == null)
    return res.status(400).json({ error: 'destination, dest_lat, dest_lon required' });

  const { data, error } = await supabase
    .from('trip_sessions')
    .update({
      assigned_destination: destination,
      dest_lat:     dest_lat,
      dest_lon:     dest_lon,
      route_steps:  route_steps  ?? null,
      route_dist_m: route_dist_m ?? null,
      route_dur_s:  route_dur_s  ?? null,
    })
    .eq('id', tripId)
    .in('trip_status', ['active', 'paused'])
    .select('id')
    .single();

  if (error || !data) return res.status(404).json({ error: 'Active trip not found' });
  console.log(`[trip] mobile route saved trip=${tripId} dest="${destination}" dist=${route_dist_m}m`);
  res.json({ ok: true });
});

app.patch('/device/trip/:id/nav-step', requireDeviceKey, async (req, res) => {
  const {
    instruction,
    dist_m,
    type,
    nav_state = 'navigating',
    current_step_index = null,
    next_street = null,
    gps_source = null,
  } = req.body;
  await supabase.from('trip_sessions')
    .update({
      nav_step_instruction: instruction ?? null,
      nav_step_dist_m: dist_m ?? null,
      nav_step_type: type ?? null,
      nav_state,
      nav_current_step_index: current_step_index,
      nav_next_street: next_street,
      nav_gps_source: gps_source,
    })
    .eq('id', req.params.id)
    .in('trip_status', ['active', 'paused']);
  res.json({ ok: true });
});

// POST /trip/snooze - driver presses SNOOZE on rest alert; logs activity
app.post('/trip/snooze', requireDeviceKey, async (req, res) => {
  const { trip_id, duration_ms = 600000 } = req.body;
  if (!trip_id) return res.status(400).json({ error: 'trip_id required' });

  const snoozeUntil = new Date(Date.now() + duration_ms).toISOString();

  const { data: trip, error } = await supabase
    .from('trip_sessions')
    .update({ snoozed_until: snoozeUntil })
    .eq('id', trip_id)
    .select('truck_id, driver_id')
    .single();

  if (error || !trip) return res.status(404).json({ error: 'Trip not found' });

  res.json({ ok: true, duration_ms, snoozed_until: snoozeUntil });
  touchDevice(trip.truck_id);
  logTripEvent(trip_id, trip.truck_id, trip.driver_id, 'rest_snoozed');
  console.log(`[trip] snoozed rest alert trip=${trip_id} until=${snoozeUntil}`);
});

// POST /trip/pause - driver presses REST button; pauses the active trip
// Accepts optional source ('hmi' | 'mobile') for conflict resolution.
app.post('/trip/pause', requireDeviceKey, async (req, res) => {
  const { trip_id, event_time, source = 'hmi' } = req.body;
  if (!trip_id) return res.status(400).json({ error: 'trip_id required' });

  // HMI-priority conflict check: reject stale mobile actions that would override a
  if (source === 'mobile') {
    const { data: current } = await supabase
      .from('trip_sessions')
      .select('trip_status, last_action_source, last_action_at')
      .eq('id', trip_id)
      .maybeSingle();

    if (current) {
      const hmiActedRecently =
        current.last_action_source === 'hmi' &&
        current.last_action_at &&
        Date.now() - new Date(current.last_action_at).getTime() < 30_000;

      if (hmiActedRecently && current.trip_status !== 'active') {
        console.log(`[trip] rejected mobile pause - HMI acted ${Math.round((Date.now() - new Date(current.last_action_at).getTime())/1000)}s ago, status=${current.trip_status}`);
        return res.status(409).json({
          error: 'Action rejected: HMI device performed a more recent state change.',
          code: 'HMI_PRIORITY',
          trip_status: current.trip_status,
        });
      }
    }
  }

  const pausedAt = event_time ?? new Date().toISOString();

  const { data, error } = await supabase
    .from('trip_sessions')
    .update({
      trip_status: 'paused', paused_at: pausedAt, next_rest_alert_at: null, snoozed_until: null,
      last_action_source: source, last_action_at: new Date().toISOString(),
    })
    .eq('id', trip_id).eq('trip_status', 'active')
    .select().single();

  if (error || !data) return res.status(400).json({ error: 'Could not pause trip - not found or not active' });

  try { await resolveRestAlertsForTrip(trip_id, 'driver_pause'); } catch {}
  res.json(data);
  // Only update device_last_seen for HMI-originated actions
  if (source !== 'mobile') touchDevice(data.truck_id);
  try { await syncTruckStatus(data.truck_id); } catch (e) { console.error('[syncTruck/pause]', e.message); }
  logTripEvent(trip_id, data.truck_id, data.driver_id, 'rest_started', event_time || null);
  logTripStateTelemetry(trip_id, data.truck_id, data.driver_id, 'paused', {
    event_time: event_time || pausedAt,
    event_type: 'rest_started',
    channel: source === 'mobile' ? 'mobile_app' : 'lora',
    source_device: 'hmi',
  });
  console.log(`[trip] paused trip=${trip_id} at=${pausedAt} source=${source}${event_time ? ' (device time)' : ' (server time)'}`);
});

// POST /trip/resume - driver resumes after rest
app.post('/trip/resume', requireDeviceKey, async (req, res) => {
  const { trip_id, event_time, source = 'hmi' } = req.body;
  if (!trip_id) return res.status(400).json({ error: 'trip_id required' });

  // HMI-priority conflict check for mobile resume attempts
  if (source === 'mobile') {
    const { data: current } = await supabase
      .from('trip_sessions')
      .select('trip_status, last_action_source, last_action_at')
      .eq('id', trip_id)
      .maybeSingle();

    if (current) {
      const hmiActedRecently =
        current.last_action_source === 'hmi' &&
        current.last_action_at &&
        Date.now() - new Date(current.last_action_at).getTime() < 30_000;

      if (hmiActedRecently && current.trip_status !== 'paused') {
        console.log(`[trip] rejected mobile resume - HMI acted recently, status=${current.trip_status}`);
        return res.status(409).json({
          error: 'Action rejected: HMI device performed a more recent state change.',
          code: 'HMI_PRIORITY',
          trip_status: current.trip_status,
        });
      }
    }
  }

  const { data: currentTrip } = await supabase
    .from('trip_sessions')
    .select('paused_at, total_rest_seconds, truck_id, driver_id')
    .eq('id', trip_id)
    .eq('trip_status', 'paused')
    .maybeSingle();

  if (!currentTrip) return res.status(400).json({ error: 'Trip not found or not paused' });

  const resumeTime      = event_time ? new Date(event_time) : new Date();
  const pausedAt        = currentTrip.paused_at ? new Date(currentTrip.paused_at) : null;
  const restDeltaSec    = pausedAt ? Math.max(0, Math.round((resumeTime.getTime() - pausedAt.getTime()) / 1000)) : 0;
  const newTotalRestSec = (currentTrip.total_rest_seconds ?? 0) + restDeltaSec;

  // Compute next rest alert time now (synchronously) so mobile/HMI see it immediately
  const thr         = await getThresholds();
  const restMs      = Math.round(thr.rest_hours * 3600 * 1000);
  const nextAlert   = new Date(resumeTime.getTime() + restMs).toISOString();
  const actionAt    = new Date().toISOString();

  const { data: row, error } = await supabase
    .from('trip_sessions')
    .update({
      trip_status:        'active',
      paused_at:          null,
      total_rest_seconds: newTotalRestSec,
      snoozed_until:      null,
      next_rest_alert_at: nextAlert,
      last_action_source: source,
      last_action_at:     actionAt,
    })
    .eq('id', trip_id)
    .eq('trip_status', 'paused')
    .select()
    .single();

  if (error || !row) return res.status(400).json({ error: 'Trip not found or not paused' });

  res.json(row);
  // Only update device_last_seen for HMI-originated actions
  if (source !== 'mobile') touchDevice(row.truck_id);
  try { await syncTruckStatus(row.truck_id); } catch (e) { console.error('[syncTruck/resume]', e.message); }
  logTripEvent(trip_id, row.truck_id, row.driver_id, 'trip_resumed', event_time || null);
  logTripStateTelemetry(trip_id, row.truck_id, row.driver_id, 'active', {
    event_time: event_time || resumeTime.toISOString(),
    event_type: 'trip_resumed',
    channel: source === 'mobile' ? 'mobile_app' : 'lora',
    source_device: 'hmi',
  });
  console.log(`[trip] resumed trip=${trip_id} at=${event_time ?? 'now'} source=${source}${event_time ? ' (device time)' : ' (server time)'}`);
});

// ?????????????????????????????????????????????????????????????
app.post('/telemetry', requireDeviceKey, async (req, res) => {
  try {
  const receivedAt = new Date().toISOString();
  const {
    truck_id,
    driver_id: rawDriverId,
    device_driver_id,
    trip_id,
    fuel_level, lat, lon, speed, odometer_km,
    engine_status = 'on',
    sent_at,
    seq,
    comm_channel = 'wifi',
    channel_used,          // 'lora' | 'gsm' | 'offline_replay' | 'mobile_app'
    event_id,              // globally unique event ID for cross-channel deduplication
    retry = false,
    next_rest_alert_at,
    next_rest_in_sec,
    hmi_driving_sec,
    hmi_rest_sec,
    hmi_trip_status,
    // Extended OBD2 fields
    engine_rpm, engine_load_pct, throttle_pct, maf_gps, coolant_temp_c,
    engine_runtime_sec, dtc_present, dtc_count,
    fuel_valid, fuel_source, fuel_confidence,
    delta_time_sec, gps_accuracy, gps_valid, distance_gps_delta,
  } = req.body;
  const driver_id = rawDriverId ?? device_driver_id ?? null;
  const resolvedChannel = channel_used ?? comm_channel;
  // builds also squashed lte/cellular/wifi into 'gsm' for backwards-compat
  const storedChannel = resolvedChannel === 'buffered' ? 'offline_replay' : resolvedChannel;
  const dbSeq = storedChannel === 'lora' ? null : seq;

  if (!truck_id) return res.status(400).json({ error: 'truck_id required' });

  touchDevice(truck_id);
  // Keep hmi_sessions.last_seen fresh for HMI-sourced telemetry - covers the
  if (driver_id && storedChannel !== 'mobile_app') {
    touchHmiSession(driver_id, truck_id);
  }
  const _sentAtMs  = sent_at ? new Date(sent_at).getTime() : NaN;
  const latencyMs  = isFinite(_sentAtMs) ? Math.max(0, Date.now() - _sentAtMs) : null;

  if (event_id) {
    const { data: dupEvt } = await supabase
      .from('telemetry_logs')
      .select('id')
      .eq('event_id', event_id)
      .maybeSingle();
    if (dupEvt) {
      console.log(`[telemetry] duplicate event_id=${event_id} channel=${resolvedChannel} - skipped`);
      return res.status(200).json({ duplicate: true, event_id });
    }
  }

  if (dbSeq != null) {
    let dupQuery = supabase
      .from('telemetry_logs')
      .select('id')
      .eq('truck_id', truck_id)
      .eq('seq', dbSeq)
      .gte('timestamp', new Date(Date.now() - 300_000).toISOString());

    const sentAtMsForDedup = sent_at ? new Date(sent_at).getTime() : NaN;
    if (resolvedChannel === 'wifi' && Number.isFinite(sentAtMsForDedup)) {
      dupQuery = dupQuery.eq('sent_at', new Date(sentAtMsForDedup).toISOString());
    }

    const { data: dup } = await dupQuery.maybeSingle();
    if (dup) {
      console.log(`[telemetry] duplicate seq=${seq} truck=${truck_id} - skipped`);
      return res.status(200).json({ duplicate: true, seq });
    }
  }

  // Resolve the canonical trip_id for this telemetry record.
  let resolvedTripId = trip_id ?? null;
  if (trip_id) {
    const { data: deviceTripRow } = await supabase
      .from('trip_sessions')
      .select('id, trip_status')
      .eq('id', trip_id)
      .maybeSingle();

    if (deviceTripRow) {
      // buffered replays from ended trips without misrouting them.
      resolvedTripId = trip_id;
    } else {
      // genuine reboot-mid-start orphans still land on the right trip.
      const { data: activeTripRow } = await supabase
        .from('trip_sessions')
        .select('id')
        .eq('truck_id', truck_id)
        .in('trip_status', ['active', 'paused'])
        .order('start_time', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (activeTripRow) {
        console.log(`[telemetry] unknown trip_id, redirecting truck=${truck_id}: device=${trip_id} -> active=${activeTripRow.id}`);
        resolvedTripId = activeTripRow.id;
      } else {
        await supabase.from('trip_sessions').upsert(
          { id: trip_id, truck_id, driver_id, trip_status: 'active' },
          { onConflict: 'id', ignoreDuplicates: true }
        );
      }
    }
  }

  // the dashboard starts from exactly the remaining duration reported by HMI.
  // Other channels retain the absolute/device-time behavior used for replay.
  let resolvedNextRestAlertAt = next_rest_alert_at;
  const hasHmiNextRest = next_rest_in_sec !== null
    && next_rest_in_sec !== undefined
    && next_rest_in_sec !== ''
    && Number.isFinite(Number(next_rest_in_sec));
  const hmiNextRestSec = hasHmiNextRest ? Number(next_rest_in_sec) : null;
  const isLiveHmiTelemetry = !['offline_replay', 'buffered'].includes(resolvedChannel);
  if (isLiveHmiTelemetry && hasHmiNextRest) {
    // queued A7670E request eventually reaches the API.
    const anchorMs = Number.isFinite(_sentAtMs) ? _sentAtMs : new Date(receivedAt).getTime();
    resolvedNextRestAlertAt = new Date(anchorMs + Math.max(0, hmiNextRestSec) * 1000).toISOString();
  } else if (!resolvedNextRestAlertAt && hasHmiNextRest) {
    const anchorMs = Number.isFinite(_sentAtMs) ? _sentAtMs : new Date(receivedAt).getTime();
    resolvedNextRestAlertAt = new Date(anchorMs + Math.max(0, hmiNextRestSec) * 1000).toISOString();
  }
  if (resolvedTripId && resolvedNextRestAlertAt) {
    await supabase.from('trip_sessions')
      .update({ next_rest_alert_at: resolvedNextRestAlertAt })
      .eq('id', resolvedTripId)
      .eq('trip_status', 'active');
  }

  const isOfflineReplay = resolvedChannel === 'offline_replay' || comm_channel === 'buffered';
  // (uninitialized CCLK default) which is rejected by Postgres timestamptz.
  const _sentAtMs2  = sent_at ? new Date(sent_at).getTime() : NaN;
  const nowMs = Date.now();
  const cleanSentAt = (isFinite(_sentAtMs2) && _sentAtMs2 > Date.UTC(2024, 0, 1) && _sentAtMs2 < nowMs + 300_000)
    ? new Date(_sentAtMs2).toISOString()
    : null;
  const bufferedTs  = (isOfflineReplay && cleanSentAt) ? new Date(cleanSentAt).toISOString() : undefined;
  const hmiGpsValid = isValidGpsPoint(lat, lon);
  const cleanLat = hmiGpsValid ? lat : null;
  const cleanLon = hmiGpsValid ? lon : null;
  const telemetryRow = {
      truck_id, driver_id, trip_id: resolvedTripId, fuel_level, lat: cleanLat, lon: cleanLon, speed, odometer_km,
      engine_status, seq: dbSeq, comm_channel: resolvedChannel, channel_used: storedChannel, event_id: event_id ?? null,
      sent_at: cleanSentAt,
      gps_source: hmiGpsValid ? 'embedded_gps' : null,
      original_device_timestamp: cleanSentAt,
      source_device: 'hmi',
      ...(gps_accuracy != null ? { gps_accuracy_m: gps_accuracy } : {}),
      ...(bufferedTs ? { timestamp: bufferedTs } : {}),
      // Extended OBD2 columns - null when ECU doesn't support the PID
      ...(engine_rpm        != null ? { engine_rpm }        : {}),
      ...(engine_load_pct   != null ? { engine_load_pct }   : {}),
      ...(throttle_pct      != null ? { throttle_pct }      : {}),
      ...(maf_gps           != null ? { maf_gps }           : {}),
      ...(coolant_temp_c    != null ? { coolant_temp_c }    : {}),
      ...(engine_runtime_sec != null ? { engine_runtime_sec } : {}),
      ...(dtc_present       != null ? { dtc_present }       : {}),
      ...(dtc_count         != null ? { dtc_count }         : {}),
      ...(fuel_valid        != null ? { fuel_valid }        : {}),
      ...(fuel_source       != null ? { fuel_source }       : {}),
      ...(fuel_confidence   != null ? { fuel_confidence }   : {}),
      ...(hmi_driving_sec   != null ? { hmi_driving_sec }   : {}),
      ...(hmi_rest_sec      != null ? { hmi_rest_sec }      : {}),
      ...(hmi_trip_status   != null ? { hmi_trip_status }   : {}),
      // Model C distance-fusion device-side fields (server-computed fields are
      // PATCHed onto the row from the ML background block below)
      ...(delta_time_sec     != null ? { delta_time_sec }                 : {}),
      ...(gps_valid          != null ? { gps_valid }                      : {}),
      ...(distance_gps_delta != null ? { distance_gps_delta_km: distance_gps_delta } : {}),
    };
  const { data, error } = await insertTelemetryLog(telemetryRow);

  if (error) return res.status(400).json({ error: error.message });
  // odometer_km is therefore often null or trip-scoped speed integration, so

  // Log latency for SO2 benchmarking
  const cleanLatencyMs = cleanSentAt
    ? Math.max(0, new Date(receivedAt).getTime() - new Date(cleanSentAt).getTime())
    : null;
  const latencyResult = await insertLatencyLog({
    truck_id,
    sent_at: cleanSentAt,
    received_at: receivedAt,
    latency_ms: cleanLatencyMs,
    comm_channel: resolvedChannel,
    channel_used: storedChannel,
    seq,
    retry: !!retry,
  });
  if (latencyResult.error) {
    console.warn('[latency] insert failed:', latencyResult.error.message);
  }

  // Update trip distance using speed x time integration (server-side RPC).
  if (resolvedTripId) {
    const { data: distKm } = await supabase
      .rpc('compute_trip_distance_km', { p_trip_id: resolvedTripId });
    if (distKm != null) {
      await supabase.from('trip_sessions')
        .update({ distance_km: +Number(distKm).toFixed(2) })
        .eq('id', resolvedTripId);
    }
  }

  if (req.query.a7670e === '1') {
    res.status(201).json({ ok: true, id: data?.id ?? null });
  } else {
    res.status(201).json({ ...data, received_at: receivedAt, latency_ms: cleanLatencyMs });
  }

  // ?? ML Anomaly Detection (background, non-blocking) ???????
  setImmediate(async () => {
    try {
      // The anomaly model evaluates fuel behavior; it does not manufacture a
      if (!Number.isFinite(Number(fuel_level)) || fuel_valid === false) return;

      // Get last 5 readings for delta + variability features.
      const { data: recent } = await supabase
        .from('telemetry_logs')
        .select('fuel_level, odometer_km, speed, timestamp, engine_load_pct, throttle_pct, engine_status')
        .eq('truck_id', truck_id)
        .eq('trip_id', resolvedTripId)
        .eq('comm_channel', storedChannel)
        .not('fuel_level', 'is', null)
        .order('timestamp', { ascending: false })
        .limit(5);

      const prev = recent?.length >= 2 ? recent[1] : null;

      // Skip ML on first reading - no delta features available yet
      if (!prev) return;

      const fuelDelta    = fuel_level - prev.fuel_level;
      const odoDelta     = Math.max(0, (odometer_km ?? 0) - (prev.odometer_km ?? 0));
      const numericSpeed = Number(speed ?? 0);

      // distance_obd_delta: prefer odometer diff; fall back to speed x time
      const dtSec = delta_time_sec ?? (
        prev.timestamp
          ? Math.min((Date.now() - new Date(prev.timestamp).getTime()) / 1000, 120)
          : 0
      );
      const distObdDelta = odoDelta > 0
        ? odoDelta
        : numericSpeed > 0 ? numericSpeed * dtSec / 3600 : 0;

      const fuelPerKm  = distObdDelta > 0 ? (-fuelDelta / distObdDelta) : 0;

      // speed_variability: stdev of last N speed readings
      const speeds = (recent ?? []).map(r => Number(r.speed ?? 0));
      const speedMean = speeds.reduce((a, b) => a + b, 0) / (speeds.length || 1);
      const speedVariability = speeds.length > 1
        ? Math.sqrt(speeds.reduce((s, v) => s + (v - speedMean) ** 2, 0) / speeds.length)
        : 0;

      // acceleration_kmph_per_sec: (current - prev) / ?t
      const prevSpeed = Number(prev.speed ?? 0);
      const accelKmphPerSec = dtSec > 0 ? (numericSpeed - prevSpeed) / dtSec : 0;

      // Cumulative-drift bypass: if the same-channel fuel level has dropped
      const oldestRecentFuel = recent.length > 0 ? recent[recent.length - 1].fuel_level : null;
      const cumulativeDrop   = (oldestRecentFuel != null && fuel_level != null)
        ? oldestRecentFuel - fuel_level
        : 0;
      const sustainedDrift = cumulativeDrop >= 2.0;

      // false positives from near-zero odometer delta producing meaningless
      if (!resolvedTripId) return;
      if (engine_status !== 'on') return;
      if (!sustainedDrift && numericSpeed < 5 && distObdDelta < 0.05 && Math.abs(fuelDelta) < 2.0) return;
      if (!sustainedDrift && distObdDelta < 0.08 && Math.abs(fuelDelta) < 0.8) return;
      // let increases through to ML; the contextual gate below distinguishes

      // Trip paused (driver rest) - normally there's no fuel activity, but
      const { data: currentTrip } = await supabase.from('trip_sessions')
        .select('trip_status').eq('id', resolvedTripId).single();
      if (currentTrip?.trip_status === 'paused'
          && numericSpeed < 5
          && Math.abs(fuelDelta) < 0.5) return;

      // Fuel series for Matrix Profile - trip-scoped when possible, padded
      const MP_MIN_HISTORY = 12;

      const { data: tripHistory } = await supabase
        .from('telemetry_logs')
        .select('fuel_level, timestamp')
        .eq('truck_id', truck_id)
        .eq('trip_id', resolvedTripId)
        .not('fuel_level', 'is', null)
        .order('timestamp', { ascending: false })
        .limit(40);

      let fuelHistory = tripHistory ?? [];

      if (fuelHistory.length < MP_MIN_HISTORY) {
        // Backfill with previous-trip healthy readings for this truck.
        const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const need   = 40 - fuelHistory.length;
        const { data: recentHistory } = await supabase
          .from('telemetry_logs')
          .select('fuel_level, timestamp')
          .eq('truck_id', truck_id)
          .neq('trip_id', resolvedTripId)
          .eq('anomaly_flag', false)
          .not('fuel_level', 'is', null)
          .gte('timestamp', dayAgo)
          .order('timestamp', { ascending: false })
          .limit(need);
        fuelHistory = [...fuelHistory, ...(recentHistory ?? [])];
      }

      // both queries were ORDER BY desc, the concatenation puts the current
      const fuelSeries = fuelHistory.map(r => r.fuel_level ?? 0).reverse();

      // Persist the server-computed distance features back onto this row so
      const distFusedDelta = (distance_gps_delta != null && distance_gps_delta > 0)
        ? distance_gps_delta
        : distObdDelta;
      try {
        await supabase.from('telemetry_logs').update({
          distance_obd_delta_km:   distObdDelta,
          distance_fused_delta_km: distFusedDelta,
        }).eq('id', data.id);
      } catch {  }

      // ?? Model D context payload ??????????????????????????????????????????
      let timeSinceRefuelSec = 99999.0;
      try {
        const fifteenMinAgo = new Date(Date.now() - 900_000).toISOString();
        const { data: trail } = await supabase
          .from('telemetry_logs')
          .select('fuel_level, timestamp')
          .eq('truck_id', truck_id)
          .eq('trip_id', resolvedTripId)
          .gte('timestamp', fifteenMinAgo)
          .order('timestamp', { ascending: true })
          .limit(60);
        if (trail && trail.length >= 2) {
          for (let i = 1; i < trail.length; i++) {
            const d = (trail[i].fuel_level ?? 0) - (trail[i - 1].fuel_level ?? 0);
            if (d >= 5.0) {
              const ageSec = (Date.now() - new Date(trail[i].timestamp).getTime()) / 1000;
              if (ageSec >= 0 && ageSec < timeSinceRefuelSec) timeSinceRefuelSec = ageSec;
            }
          }
        }
      } catch {  }

      const loadNow  = Number(engine_load_pct      ?? 0);
      const loadPrev = Number(prev.engine_load_pct ?? loadNow);
      const throttleNow  = Number(throttle_pct      ?? 0);
      const throttlePrev = Number(prev.throttle_pct ?? throttleNow);
      const deltaLoadNorm     = Math.max(-1, Math.min(1, (loadNow - loadPrev) / 100));
      const deltaThrottleNorm = Math.max(-1, Math.min(1, (throttleNow - throttlePrev) / 100));

      // ?? Model C anchor-paper features ??????????????????????????????????
      let rpmHighShare = 0, rpmRedShare = 0, rpmOrangeShare = 0, rpmYellowShare = 0;
      let speedOver90Share = 0, speedOver120Share = 0;
      let kmplDeviationPct = 0, driverKmplDeviationPct = 0;
      let routeTypeCode = 1.0;  // default = combined
      try {
        // Per-trip stats: scan the trip's history so the shares are computed
        const { data: tripHistory } = await supabase
          .from('telemetry_logs')
          .select('engine_rpm, speed, fuel_per_km')
          .eq('truck_id', truck_id)
          .eq('trip_id', resolvedTripId)
          .order('timestamp', { ascending: true })
          .limit(500);
        if (tripHistory && tripHistory.length > 0) {
          // Include the current row in the share denominator.
          const rows = [...tripHistory, { engine_rpm, speed: numericSpeed, fuel_per_km: fuelPerKm }];
          let nRpm = 0, hHigh = 0, hRed = 0, hOrange = 0, hYellow = 0;
          let nSp = 0, s90 = 0, s120 = 0;
          let nFpk = 0, sumFpk = 0;
          let sumSpeed = 0;
          for (const r of rows) {
            const rpm = Number(r.engine_rpm);
            const sp  = Number(r.speed ?? 0);
            const fpk = Number(r.fuel_per_km ?? 0);
            sumSpeed += sp; nSp++;
            if (Number.isFinite(rpm) && rpm > 0) {
              nRpm++;
              if (rpm >= 1900 && rpm < 3500)                           hHigh++;
              if (rpm >= 3500 && sp <  40)                             hRed++;
              if (rpm >= 3500 && sp >= 40 && sp < 80)                  hOrange++;
              if (rpm >= 3500 && sp >= 80)                             hYellow++;
            }
            if (sp >  90) s90++;
            if (sp > 120) s120++;
            if (fpk > 0) { nFpk++; sumFpk += fpk; }
          }
          if (nRpm > 0) {
            rpmHighShare   = hHigh   / nRpm;
            rpmRedShare    = hRed    / nRpm;
            rpmOrangeShare = hOrange / nRpm;
            rpmYellowShare = hYellow / nRpm;
          }
          if (nSp > 0) {
            speedOver90Share  = s90  / nSp;
            speedOver120Share = s120 / nSp;
            const meanSpeed = sumSpeed / nSp;
            routeTypeCode = (meanSpeed > 60) ? 2.0 : (meanSpeed < 25) ? 0.0 : 1.0;
          }
        }

        // Per-truck KMPL baseline (Habib): mean fuel_per_km across this
        const { data: truckBase } = await supabase.rpc('avg_truck_fuel_per_km', { p_truck_id: truck_id })
          .catch(() => ({ data: null }));
        let truckMeanFpk = truckBase?.[0]?.avg_fpk ?? null;
        if (truckMeanFpk == null) {
          // Fallback inline aggregate if the RPC isn't deployed yet.
          const { data: legacyBase } = await supabase
            .from('telemetry_logs')
            .select('fuel_per_km')
            .eq('truck_id', truck_id)
            .gt('fuel_per_km', 0)
            .limit(500);
          if (legacyBase && legacyBase.length > 0) {
            truckMeanFpk = legacyBase.reduce((s, r) => s + Number(r.fuel_per_km), 0) / legacyBase.length;
          }
        }
        if (truckMeanFpk && truckMeanFpk > 0 && fuelPerKm > 0) {
          kmplDeviationPct = Math.max(-2, Math.min(2, (fuelPerKm - truckMeanFpk) / Math.abs(truckMeanFpk)));
        }

        // Per-driver KMPL baseline (Habib peer-group view).
        if (driver_id) {
          const { data: drvBase } = await supabase
            .from('telemetry_logs')
            .select('fuel_per_km')
            .eq('driver_id', driver_id)
            .gt('fuel_per_km', 0)
            .limit(500);
          if (drvBase && drvBase.length > 0 && fuelPerKm > 0) {
            const driverMean = drvBase.reduce((s, r) => s + Number(r.fuel_per_km), 0) / drvBase.length;
            if (driverMean > 0) {
              driverKmplDeviationPct = Math.max(-2, Math.min(2, (fuelPerKm - driverMean) / Math.abs(driverMean)));
            }
          }
        }
      } catch {
        // All anchor-paper features default to 0 / 1.0 (combined) on lookup
      }

      const mlRes = await fetch(ML_DETECT_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fuel_level, speed_kmph: speed,
          fuel_delta:    fuelDelta,
          odometer_delta: distObdDelta,
          fuel_per_km:   fuelPerKm,
          fuel_series:   fuelSeries,
          engine_status,
          engine_rpm:         engine_rpm         ?? null,
          engine_load_pct:    engine_load_pct    ?? null,
          throttle_pct:       throttle_pct       ?? null,
          maf_gps:            maf_gps            ?? null,
          coolant_temp_c:     coolant_temp_c     ?? null,
          engine_runtime_sec: engine_runtime_sec ?? null,
          dtc_present:        dtc_present        ?? null,
          dtc_count:          dtc_count          ?? null,
          fuel_valid:         fuel_valid         ?? null,
          fuel_source:        fuel_source        ?? null,
          fuel_confidence:    fuel_confidence    ?? null,
          // Model C: GPS-OBD distance fusion features
          delta_time_sec:             dtSec,
          distance_obd_delta:         distObdDelta,
          distance_gps_delta:         distance_gps_delta ?? null,
          distance_fused_delta:       distance_gps_delta ?? distObdDelta,
          gps_accuracy:               gps_accuracy       ?? null,
          gps_valid:                  gps_valid          ?? false,
          speed_variability:          speedVariability,
          acceleration_kmph_per_sec:  accelKmphPerSec,
          time_since_refuel_sec:      timeSinceRefuelSec,
          delta_engine_load_norm:     deltaLoadNorm,
          delta_throttle_norm:        deltaThrottleNorm,
          rpm_high_share:             rpmHighShare,
          rpm_red_share:              rpmRedShare,
          rpm_orange_share:           rpmOrangeShare,
          rpm_yellow_share:           rpmYellowShare,
          speed_over_90_share:        speedOver90Share,
          speed_over_120_share:       speedOver120Share,
          kmpl_deviation_pct:         kmplDeviationPct,
          driver_kmpl_deviation_pct:  driverKmplDeviationPct,
          route_type_code:            routeTypeCode,
        }),
        signal: AbortSignal.timeout(4000),
      });

      if (mlRes.ok) {
        const { is_anomaly, model_source, combined_score, details } = await mlRes.json();
        // Driving fuel increase >=2% is suspicious - real fuel can't go up
        const drivingIncrease = fuelDelta >= 2.0 && numericSpeed >= 5;
        // Parked refuel: stationary truck + a big jump up (>=10%) is the
        const parkedRefuel    = fuelDelta >= 10.0 && numericSpeed < 5;
        // Strict `< -2.0` (not `<=`) so pure sensor quantization steps like
        const suspiciousContext =
          fuelDelta < -2.0 ||
          fuelPerKm >= 0.6 ||
          (numericSpeed < 5 && fuelDelta < -1.0 && engine_status === 'on') ||
          drivingIncrease;

        // ?? Context suppressors (research-backed false-positive filters) ?????
        let postRefuelSuppress = false;
        try {
          const fiveMinAgo = new Date(Date.now() - 300_000).toISOString();
          const { data: recentJumps } = await supabase
            .from('telemetry_logs')
            .select('fuel_level, timestamp, comm_channel')
            .eq('truck_id', truck_id)
            .eq('trip_id', resolvedTripId)
            .gte('timestamp', fiveMinAgo)
            .order('timestamp', { ascending: true })
            .limit(40);
          if (recentJumps && recentJumps.length >= 2) {
            const lastFuelByChannel = {};
            for (const row of recentJumps) {
              const ch = row.comm_channel ?? '_none';
              const prevFuel = lastFuelByChannel[ch];
              if (prevFuel != null) {
                const d = (row.fuel_level ?? 0) - prevFuel;
                if (d >= 5.0) { postRefuelSuppress = true; break; }
              }
              lastFuelByChannel[ch] = row.fuel_level;
            }
          }
        } catch {  }

        //    drop is a known acceleration-sloshing signature - fuel rushes to
        let loadSpikeSuppress = false;
        try {
          const loadNow  = Number(engine_load_pct ?? 0);
          const loadPrev = Number(prev.engine_load_pct ?? 0);
          const loadJump = loadNow - loadPrev;
          if (loadNow >= 55 && loadJump >= 25 && fuelDelta > -8.0 && fuelDelta < 0) {
            loadSpikeSuppress = true;
          }
        } catch {  }

        let coldStartSuppress = false;
        try {
          if (engine_status === 'on' && prev.engine_status && prev.engine_status !== 'on') {
            coldStartSuppress = true;
          }
        } catch {  }

        const suppressed = postRefuelSuppress || loadSpikeSuppress || coldStartSuppress;
        const flaggedByMl = Boolean(is_anomaly && suspiciousContext && !parkedRefuel && !suppressed);

        // MP high-score override: MP scores rows against the fuel time-series
        const mpScreamOverride = Boolean(
          !flaggedByMl &&
          !parkedRefuel &&
          !suppressed &&
          (
            (combined_score >= 4.0 && fuelDelta < 0)
            ||
            (combined_score >= 2.0 && fuelDelta <= -2.0)
          )
        );
        const contextualAnomaly = flaggedByMl || mpScreamOverride;
        const effectiveModelSource = flaggedByMl ? model_source
                                   : mpScreamOverride ? 'matrix_profile'
                                   : model_source;
        if (mpScreamOverride) {
          console.log(`[anomaly] mp_scream_override truck=${truck_id} score=${combined_score.toFixed(3)}`);
        }
        if (is_anomaly && suppressed) {
          const tag = postRefuelSuppress ? 'post_refuel'
                    : loadSpikeSuppress  ? 'load_spike_slosh'
                    : 'cold_start';
          console.log(`[anomaly] suppressed (${tag}) truck=${truck_id} score=${combined_score}`);
        }

        // Update the telemetry log with anomaly result.
        const mlUpdate = contextualAnomaly
          ? { anomaly_flag: true, anomaly_score: combined_score, model_source: effectiveModelSource }
          : { anomaly_score: combined_score };
        await supabase.from('telemetry_logs').update(mlUpdate).eq('id', data.id);

        if (contextualAnomaly && combined_score > 0.65) {
          // ?? Event-window classification ??????????????????????????????????
          let scenarioLabel = 'Fuel anomaly';
          let scenarioTag   = 'fuel_anomaly';
          let alertSeverity = 'high';
          let totalDropPct  = Math.max(0, -fuelDelta);
          let avgSpeedKmph  = numericSpeed;
          let eventSeconds  = dtSec;
          try {
            const windowStart = new Date(Date.now() - 90_000).toISOString();
            const { data: eventRows } = await supabase
              .from('telemetry_logs')
              .select('id, timestamp, fuel_level, speed')
              .eq('truck_id', truck_id)
              .eq('trip_id', resolvedTripId)
              .eq('comm_channel', resolvedChannel)
              .gte('timestamp', windowStart)
              .order('timestamp', { ascending: true });

            if (eventRows && eventRows.length >= 2) {
              const first = eventRows[0];
              const last  = eventRows[eventRows.length - 1];
              totalDropPct = Math.max(0, (first.fuel_level ?? 0) - (last.fuel_level ?? 0));
              eventSeconds = Math.max(1, (new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime()) / 1000);
              const nSpeed = eventRows.filter(r => r.speed != null).length;
              avgSpeedKmph = nSpeed > 0
                ? eventRows.reduce((s, r) => s + Number(r.speed ?? 0), 0) / nSpeed
                : numericSpeed;

              // Back-propagate anomaly_flag onto the rows actually
              const maxFuel = Math.max(
                ...eventRows.map(r => Number(r.fuel_level)).filter(Number.isFinite)
              );
              const dropRows = eventRows.filter(r =>
                Number.isFinite(Number(r.fuel_level)) &&
                Number(r.fuel_level) <= maxFuel - PHYSICS_MIN_DROP_PCT);
              const rowIds = dropRows.map(r => r.id).filter(Boolean);
              if (rowIds.length > 0) {
                await supabase.from('telemetry_logs')
                  .update({ anomaly_flag: true, model_source: 'matrix_profile' })
                  .in('id', rowIds);
              }
            }
          } catch (evtErr) {
            console.warn('[anomaly] event-window classification failed:', evtErr.message);
          }

          // Scenario classification from drop shape.
          const dropRatePctPerMin = eventSeconds > 0 ? (totalDropPct / eventSeconds) * 60 : 0;
          if (avgSpeedKmph < 5) {
            // Parked context - theft is possible
            if (totalDropPct >= 5 && dropRatePctPerMin >= 4) {
              scenarioLabel = 'Possible fuel theft while parked (rapid siphon)';
              scenarioTag   = 'possible_stationary_siphon';
              alertSeverity = 'high';
            } else if (totalDropPct >= 2 && dropRatePctPerMin < 1.5) {
              scenarioLabel = 'Possible fuel leak while parked (tank or seal seepage)';
              scenarioTag   = 'possible_parked_leak';
              alertSeverity = 'medium';
            } else if (eventSeconds < 15 && totalDropPct < 3) {
              scenarioLabel = 'Possible sensor glitch (transient reading)';
              scenarioTag   = 'possible_sensor_glitch';
              alertSeverity = 'low';
            } else if (totalDropPct >= 2) {
              scenarioLabel = 'Unusual parked fuel drop';
              scenarioTag   = 'unusual_fuel_drop';
              alertSeverity = 'medium';
            }
          } else {
            // Moving context - theft not physically possible; everything is a leak
            if (totalDropPct >= 5 && dropRatePctPerMin >= 3) {
              scenarioLabel = 'Possible major fuel leak while driving (line rupture or tank puncture)';
              scenarioTag   = 'possible_major_leak';
              alertSeverity = 'high';
            } else if (totalDropPct >= 2 && dropRatePctPerMin >= 0.5 && dropRatePctPerMin < 3) {
              scenarioLabel = 'Possible fuel line leak while driving';
              scenarioTag   = 'possible_moving_line_leak';
              alertSeverity = 'medium';
            } else if (totalDropPct >= 2 && dropRatePctPerMin < 0.5) {
              scenarioLabel = 'Possible slow fuel leak (steady loss)';
              scenarioTag   = 'possible_slow_leak';
              alertSeverity = 'medium';
            } else if (eventSeconds < 15 && totalDropPct < 3) {
              scenarioLabel = 'Possible sensor glitch (transient reading)';
              scenarioTag   = 'possible_sensor_glitch';
              alertSeverity = 'low';
            } else if (totalDropPct >= 2) {
              scenarioLabel = 'Unusual fuel drop while driving';
              scenarioTag   = 'unusual_fuel_drop';
              alertSeverity = 'medium';
            }
          }

          // Dedup: per-trip, 45 s window - collapses duplicate alerts from
          const dedupSince = new Date(Date.now() - 45_000).toISOString();
          const { count: recentAnomaly } = await supabase.from('alerts')
            .select('id', { count: 'exact', head: true })
            .eq('trip_id', resolvedTripId).eq('alert_type', 'fuel_anomaly')
            .gte('timestamp', dedupSince);

          if (!recentAnomaly) {
          // Admin-facing message: drop the [model] prefix and raw discord
          const alertMessage = `${scenarioLabel} - ${totalDropPct.toFixed(1)}% drop over ${Math.round(eventSeconds)}s at ${Math.round(avgSpeedKmph)} km/h`;
          await supabase.from('alerts').insert([{
            truck_id, driver_id, trip_id: resolvedTripId,
            alert_type: 'fuel_anomaly',
            severity:   alertSeverity,
            message:    alertMessage,
          }]);

          await syncTruckStatus(truck_id);

          console.log(`[anomaly] truck=${truck_id} model=${effectiveModelSource} scenario=${scenarioTag} score=${combined_score}`);
          } // end dedup check
        }
      }
    } catch {
      // ML service offline - telemetry saved, detection skipped
    }
  });

  // Operational alert checks run independently of ML
  setImmediate(() => checkOperationalAlerts(truck_id, driver_id, resolvedTripId, speed, odometer_km,
    comm_channel === 'buffered' && sent_at ? sent_at : null,
    fuel_level));

  // HMI-driven nav advancement - updates trip_sessions.nav_* based on the
  if (resolvedTripId
      && storedChannel !== 'mobile_app'
      && Number.isFinite(Number(cleanLat))
      && Number.isFinite(Number(cleanLon))) {
    setImmediate(() => advanceNavFromHmiGps({
      trip_id: resolvedTripId,
      lat:     Number(cleanLat),
      lon:     Number(cleanLon),
    }));
  }

  // the maximum physical combustion envelope for the reported engine
  if (resolvedTripId
      && Number.isFinite(Number(fuel_level))
      && fuel_valid !== false) {
    setImmediate(() => checkPhysicsTripwire({
      trip_id: resolvedTripId,
      truck_id, driver_id,
      fuel_level: Number(fuel_level),
      storedChannel,
    }));
  }
  } catch (err) {
    console.error('[telemetry] unhandled error:', err?.message ?? err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error', detail: err?.message });
  }
});

// ?????????????????????????????????????????????????????????????
app.post('/offline/alert', requireDeviceKey, async (req, res) => {
  const { truck_id, driver_id, trip_id, alert_type, severity, message, event_time } = req.body;
  if (!truck_id || !alert_type || !event_time) {
    return res.status(400).json({ error: 'truck_id, alert_type, and event_time are required' });
  }

  let ts;
  try { ts = new Date(event_time).toISOString(); } catch {
    return res.status(400).json({ error: 'invalid event_time' });
  }

  // +/-5-minute dedup window centred on the reported device time
  const windowStart = new Date(new Date(ts).getTime() - 5 * 60_000).toISOString();
  const windowEnd   = new Date(new Date(ts).getTime() + 5 * 60_000).toISOString();
  const { count } = await supabase.from('alerts')
    .select('id', { count: 'exact', head: true })
    .eq('truck_id', truck_id)
    .eq('alert_type', alert_type)
    .gte('timestamp', windowStart)
    .lte('timestamp', windowEnd);

  if (count) {
    console.log(`[offline/alert] dedup ${alert_type} truck=${truck_id} ts=${ts}`);
    return res.json({ deduplicated: true });
  }

  const { error } = await supabase.from('alerts').insert([{
    truck_id, driver_id: driver_id ?? null, trip_id: trip_id ?? null,
    alert_type, severity: severity ?? 'medium', message: message ?? alert_type,
    timestamp: ts,
  }]);
  if (error) return res.status(400).json({ error: error.message });

  console.log(`[offline/alert] inserted ${alert_type} truck=${truck_id} ts=${ts}`);
  res.status(201).json({ ok: true, timestamp: ts });
});


// ?????????????????????????????????????????????????????????????
app.get('/device/trip/:trip_id', requireDeviceKey, async (req, res) => {
  const { trip_id } = req.params;
  const [{ data: trip, error }, { data: alerts }] = await Promise.all([
    // nav_* fields added so the mobile app can mirror the HMI's live
    supabase.from('trip_sessions')
      .select('id, truck_id, driver_id, trip_status, start_time, end_time, distance_km, paused_at, total_rest_seconds, next_rest_alert_at, snoozed_until, assigned_destination, dest_lat, dest_lon, route_steps, route_dist_m, route_dur_s, nav_step_instruction, nav_step_dist_m, nav_step_type, nav_state, nav_current_step_index, nav_next_street, nav_gps_source, last_action_source, last_action_at, trucks(truck_code, plate_number, length_m, width_m, height_m, weight_t, axleload_t, hazmat, tank_capacity_l)')
      .eq('id', trip_id)
      .single(),
    supabase.from('alerts')
      .select('id, alert_type, severity, message, timestamp, is_resolved')
      .eq('trip_id', trip_id)
      .eq('is_resolved', false)
      .order('timestamp', { ascending: false })
      .limit(20),
  ]);
  if (error) return res.status(404).json({ error: 'Trip not found' });

  const { data: latestTelemetry } = trip?.truck_id
    ? await supabase
        .from('telemetry_logs')
        .select('fuel_level, lat, lon, speed, odometer_km, engine_status, timestamp, comm_channel, hmi_driving_sec, hmi_rest_sec, hmi_trip_status')
        .eq('truck_id', trip.truck_id)
        .order('timestamp', { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null };

  // /driver/hmi-session poll just to know whether the embedded device
  let hmiOnline = false;
  if (trip?.driver_id) {
    const staleThreshold = new Date(Date.now() - HMI_STALE_MS).toISOString();
    const { data: sess } = await supabase
      .from('hmi_sessions')
      .select('id, last_seen, truck_id')
      .eq('driver_id', trip.driver_id)
      .eq('status', 'active')
      .gt('last_seen', staleThreshold)
      .limit(1)
      .maybeSingle();
    hmiOnline = !!sess;
  }

  res.json({
    server_now: new Date().toISOString(),
    trip,
    alerts: alerts ?? [],
    latest_telemetry: latestTelemetry ?? null,
    hmi_online: hmiOnline,
  });
});

// ?????????????????????????????????????????????????????????????
app.get('/device/trip/active/:truck_id', requireDeviceKey, async (req, res) => {
  const truckId = req.params.truck_id;
  touchDevice(truckId);

  const now = new Date().toISOString();
  supabase.from('hmi_sessions').update({ last_seen: now, truck_id: truckId })
    .eq('status', 'active').is('truck_id', null).then(() => {}).catch(() => {});
  supabase.from('hmi_sessions').update({ last_seen: now })
    .eq('status', 'active').eq('truck_id', truckId).then(() => {}).catch(() => {});

  const { data: trip } = await supabase
    .from('trip_sessions')
    .select('id, driver_id, trip_status, start_time, paused_at, total_rest_seconds, next_rest_alert_at, snoozed_until')
    .eq('truck_id', truckId)
    .in('trip_status', ['active', 'paused'])
    .order('start_time', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!trip) return res.status(204).send();

  let driverName = '';
  if (trip.driver_id) {
    const { data: u } = await supabase
      .from('users')
      .select('full_name')
      .eq('id', trip.driver_id)
      .maybeSingle();
    driverName = u?.full_name ?? '';
    if (!driverName) {
      // Fallback: try drivers table if it exists
      const { data: d } = await supabase
        .from('drivers')
        .select('full_name')
        .eq('id', trip.driver_id)
        .maybeSingle();
      driverName = d?.full_name ?? '';
    }
  }

  res.json({
    trip_id:      trip.id,
    driver_id:    trip.driver_id,
    driver_name:  driverName,
    trip_status:  trip.trip_status,
    start_time:   trip.start_time,
    paused_at:    trip.paused_at,
    total_rest_seconds: trip.total_rest_seconds ?? 0,
    next_rest_alert_at: trip.next_rest_alert_at ?? null,
    snoozed_until: trip.snoozed_until ?? null,
    channel_used: 'gsm',
  });
});

// ?????????????????????????????????????????????????????????????
app.get('/device/latest-telemetry/:truck_id', requireDeviceKey, async (req, res) => {
  const { data, error } = await supabase
    .from('telemetry_logs')
    .select('fuel_level, lat, lon, speed, odometer_km, engine_status, timestamp, comm_channel, gps_source, source_device')
    .eq('truck_id', req.params.truck_id)
    .or('source_device.is.null,source_device.neq.mobile')
    .order('timestamp', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data ?? {});
});

// ?????????????????????????????????????????????????????????????
app.patch('/device/mobile-gps', requireDeviceKey, async (req, res) => {
  const { truck_id, trip_id, lat, lon, accuracy = null, heading = null, browser_speed = null, original_timestamp = null } = req.body;
  if (!truck_id || !trip_id || lat == null || lon == null)
    return res.status(400).json({ error: 'truck_id, trip_id, lat, lon required' });
  if (!isValidGpsPoint(lat, lon))
    return res.status(400).json({ error: 'invalid mobile GPS coordinates' });

  const capturedAtMs = original_timestamp ? new Date(original_timestamp).getTime() : NaN;
  const capturedAt = Number.isFinite(capturedAtMs) ? new Date(capturedAtMs).toISOString() : new Date().toISOString();

  const { data: tripRow } = await supabase
    .from('trip_sessions')
    .select('driver_id')
    .eq('id', trip_id)
    .eq('truck_id', truck_id)
    .maybeSingle();

  const { error } = await supabase
    .from('trip_sessions')
    .update({
      mobile_lat: lat,
      mobile_lon: lon,
      mobile_gps_at: capturedAt,
      mobile_gps_accuracy: accuracy,
      mobile_gps_heading: heading,
    })
    .eq('id', trip_id)
    .eq('truck_id', truck_id)
    .in('trip_status', ['active', 'paused']);

  if (error) return res.status(400).json({ error: error.message });

  const capturedMs = new Date(capturedAt).getTime();
  const hmiWindowStart = new Date(capturedMs - GPS_MERGE_WINDOW_MS).toISOString();
  const hmiWindowEnd = new Date(capturedMs + GPS_MERGE_WINDOW_MS).toISOString();
  const { data: nearbyHmiLogs } = await supabase
    .from('telemetry_logs')
    .select('id, lat, lon, timestamp, original_device_timestamp, source_device')
    .eq('trip_id', trip_id)
    .or('source_device.is.null,source_device.eq.hmi')
    .gte('timestamp', hmiWindowStart)
    .lte('timestamp', hmiWindowEnd)
    .order('timestamp', { ascending: false })
    .limit(5);

  const mergeTarget = (nearbyHmiLogs ?? [])
    .filter(row => !isValidGpsPoint(row.lat, row.lon))
    .sort((a, b) => Math.abs(effectiveGpsTime(a) - capturedMs) - Math.abs(effectiveGpsTime(b) - capturedMs))[0];

  if (mergeTarget) {
    await supabase
      .from('telemetry_logs')
      .update({
        lat,
        lon,
        gps_source: 'fused_mobile_fallback',
        original_device_timestamp: capturedAt,
        gps_accuracy_m: accuracy,
        gps_heading_deg: heading,
        mobile_speed_mps: browser_speed,
      })
      .eq('id', mergeTarget.id);

    return res.json({ ok: true, merged_into_log_id: mergeTarget.id, gps_source: 'fused_mobile_fallback' });
  }

  const { data: recentMobile } = await supabase
    .from('telemetry_logs')
    .select('id, lat, lon, timestamp, original_device_timestamp')
    .eq('trip_id', trip_id)
    .eq('source_device', 'mobile')
    .order('timestamp', { ascending: false })
    .limit(1)
    .maybeSingle();

  const recentAt = effectiveGpsTime(recentMobile);
  const shouldInsert = !recentMobile ||
    Math.abs(new Date(capturedAt).getTime() - recentAt) > 3_000 ||
    gpsDistanceM({ lat, lon }, recentMobile) > 8;

  if (shouldInsert) {
    await supabase.from('telemetry_logs').insert([{
      truck_id,
      driver_id: tripRow?.driver_id ?? null,
      trip_id,
      lat,
      lon,
      speed: null,
      fuel_level: null,
      odometer_km: null,
      engine_status: 'on',
      comm_channel: 'mobile_gps',
      sent_at: capturedAt,
      timestamp: capturedAt,
      gps_source: 'mobile_gps',
      source_device: 'mobile',
      original_device_timestamp: capturedAt,
      gps_accuracy_m: accuracy,
      gps_heading_deg: heading,
      mobile_speed_mps: browser_speed,
    }]).then(() => {}).catch((e) => console.warn('[mobile-gps] log insert skipped:', e.message));
  }
  res.json({ ok: true });
});

// ?????????????????????????????????????????????????????????????
app.get('/restricted-zones', requireDeviceKey, async (_req, res) => {
  const { data, error } = await supabase
    .from('truck_restricted_zones')
    .select('*')
    .eq('is_active', true)
    .order('name');
  if (error) return res.status(400).json({ error: error.message });
  res.json(data ?? []);
});

// ?????????????????????????????????????????????????????????????
async function handleRecentLogs(req, res) {
  const limit = Math.min(parseInt(req.query.limit ?? '200'), 1000);

  let query = applyTimestampFilters(
    supabase
    .from('telemetry_logs')
    .select('*')
    .or('source_device.is.null,source_device.neq.mobile')
    .order('timestamp', { ascending: false })
    .limit(limit),
    req.query
  );

  const { data, error } = await query;
  if (error) return res.status(400).json({ error: error.message });

  const enriched = await enrichLiveLogs(data ?? []);
  res.json(filterLogsByDriver(enriched, req.query.driver_search));
}

// TELEMETRY LOGS - GET /logs and /logs/recent
// ?????????????????????????????????????????????????????????????
app.get('/logs', requireDashboard, handleRecentLogs);
app.get('/logs/recent', requireDashboard, handleRecentLogs);

app.get('/logs/archived', requireDashboard, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit ?? '200'), 1000);

  let query = applyTimestampFilters(
    supabase
      .from('archived_telemetry_logs')
      .select('*')
      .or('source_device.is.null,source_device.neq.mobile')
      .order('timestamp', { ascending: false })
      .limit(limit),
    req.query
  );

  const { data, error } = await query;
  if (error) return res.status(400).json({ error: error.message });

  const enriched = await enrichArchivedLogs(data ?? []);
  res.json(filterLogsByDriver(enriched, req.query.driver_search));
});

app.post('/maintenance/archive-logs', requireHeadAdmin, async (req, res) => {
  try {
    const result = await archiveEndedTripLogs({
      retentionDays: req.body?.retention_days ?? req.query.retention_days ?? 30,
      maxTrips: req.body?.max_trips ?? req.query.max_trips ?? 50,
      dryRun: req.body?.dry_run === true || req.query.dry_run === 'true',
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ?????????????????????????????????????????????????????????????
app.get('/alerts', requireDashboard, async (req, res) => {
  let query = supabase
    .from('alerts')
    .select('*')
    .order('timestamp', { ascending: false });

  if (req.query.truck_id)   query = query.eq('truck_id', req.query.truck_id);
  if (req.query.trip_id)    query = query.eq('trip_id', req.query.trip_id);
  if (req.query.resolved === 'false') query = query.eq('is_resolved', false);
  if (req.query.severity)   query = query.eq('severity', req.query.severity);

  if (req.query.active_only === 'true') {
    const { data: activeTrips } = await supabase
      .from('trip_sessions')
      .select('id')
      .in('trip_status', ['active', 'paused']);
    const ids = (activeTrips ?? []).map(t => t.id);
    query = ids.length > 0 ? query.in('trip_id', ids) : query.in('trip_id', ['none']);
  }

  const limit = Math.min(parseInt(req.query.limit ?? '100'), 500);
  query = query.limit(limit);

  const { data, error } = await query;
  if (error) return res.status(400).json({ error: error.message });

  // Attach truck_code to each alert for display purposes
  const truckIds = [...new Set((data ?? []).map(a => a.truck_id).filter(Boolean))];
  const truckMap = {};
  await Promise.all(truckIds.map(async (tid) => {
    const { data: t } = await supabase.from('trucks').select('truck_code').eq('id', tid).single();
    if (t) truckMap[tid] = t.truck_code;
  }));

  res.json((data ?? []).map(a => ({ ...sanitizeAlert(a), truck_code: truckMap[a.truck_id] ?? null })));
});

// GET /alerts/by-truck?type=overspeed&days=30
app.get('/alerts/by-truck', requireDashboard, async (req, res) => {
  const alertType = req.query.type ?? 'overspeed';
  const days = Math.max(1, Math.min(parseInt(req.query.days ?? '30'), 365));
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('alerts')
    .select('truck_id')
    .eq('alert_type', alertType)
    .gte('timestamp', sinceIso);
  if (error) return res.status(400).json({ error: error.message });

  const counts = {};
  for (const row of data ?? []) {
    if (!row.truck_id) continue;
    counts[row.truck_id] = (counts[row.truck_id] ?? 0) + 1;
  }
  const truckIds = Object.keys(counts);
  const truckMap = {};
  await Promise.all(truckIds.map(async (tid) => {
    const { data: t } = await supabase.from('trucks').select('truck_code').eq('id', tid).single();
    if (t) truckMap[tid] = t.truck_code;
  }));

  res.json(truckIds.map(tid => ({
    truck_id:   tid,
    truck_code: truckMap[tid] ?? tid.slice(0, 8),
    count:      counts[tid],
  })).sort((a, b) => b.count - a.count));
});

// GET /alerts/by-driver?type=overspeed&days=30
// Overspeeding is a driver-behaviour signal - the operations team needs to
app.get('/alerts/by-driver', requireDashboard, async (req, res) => {
  const alertType = req.query.type ?? 'overspeed';
  const days = Math.max(1, Math.min(parseInt(req.query.days ?? '30'), 365));
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('alerts')
    .select('driver_id')
    .eq('alert_type', alertType)
    .gte('timestamp', sinceIso);
  if (error) return res.status(400).json({ error: error.message });

  const counts = {};
  for (const row of data ?? []) {
    if (!row.driver_id) continue;
    counts[row.driver_id] = (counts[row.driver_id] ?? 0) + 1;
  }
  const driverIds = Object.keys(counts);
  const driverMap = {};
  await Promise.all(driverIds.map(async (did) => {
    const { data: d } = await supabase.from('drivers').select('full_name').eq('id', did).single();
    if (d) driverMap[did] = d.full_name;
  }));

  res.json(driverIds.map(did => ({
    driver_id:   did,
    driver_name: driverMap[did] ?? did.slice(0, 8),
    count:       counts[did],
  })).sort((a, b) => b.count - a.count));
});

app.get('/alerts/summary', requireDashboard, async (_req, res) => {
  const { count: unresolved_count, error } = await supabase
    .from('alerts')
    .select('id', { count: 'exact', head: true })
    .eq('is_resolved', false);

  if (error) return res.status(400).json({ error: error.message });
  res.json({ unresolved_count: unresolved_count ?? 0 });
});

// PATCH /alerts/:id/resolve
app.patch('/alerts/:id/resolve', requireDashboard, async (req, res) => {
  const { data: existing, error: fetchErr } = await supabase
    .from('alerts')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (fetchErr || !existing) return res.status(404).json({ error: 'Alert not found' });

  const updates = { is_resolved: true };
  if (existing.alert_type === 'rest_alert') {
    let resolvedAtKm = null;
    if (existing.trip_id) {
      const { data: tripRow } = await supabase
        .from('trip_sessions')
        .select('distance_km')
        .eq('id', existing.trip_id)
        .single();
      resolvedAtKm = String((tripRow?.distance_km ?? 0).toFixed(1));
    }
    updates.message = withAlertMeta(existing.message, {
      resolved_by:    'admin',
      resolved_at:    new Date().toISOString(),
      ...(resolvedAtKm != null ? { resolved_at_km: resolvedAtKm } : {}),
    });
  }
  if (existing.alert_type === 'maintenance') {
    await recordMaintenanceService(existing.truck_id);
  }

  const { data, error } = await supabase
    .from('alerts')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  await syncTruckStatus(data.truck_id);
  res.json(sanitizeAlert(data));
});

// ?????????????????????????????????????????????????????????????
app.get('/latency/stats', requireDashboard, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit ?? '500'), 2000);
  const channel = req.query.channel; // optional filter: wifi | gsm | buffered

  let query = supabase
    .from('latency_logs')
    .select('latency_ms, received_at, comm_channel, retry')
    .order('received_at', { ascending: false })
    .limit(limit);
  if (channel) query = query.eq('comm_channel', channel);

  const { data, error } = await query;
  if (error) return res.status(400).json({ error: error.message });

  function computeStats(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const sum    = sorted.reduce((s, v) => s + v, 0);
    return {
      count:             sorted.length,
      avg_ms:            Math.round(sum / sorted.length),
      p50_ms:            sorted[Math.floor(sorted.length * 0.50)],
      p95_ms:            sorted[Math.floor(sorted.length * 0.95)],
      max_ms:            sorted[sorted.length - 1],
      within_target_pct: +(sorted.filter(v => v <= 3000).length / sorted.length * 100).toFixed(1),
    };
  }

  const rows   = data ?? [];
  const all    = rows.map(r => r.latency_ms).filter(v => v != null && v >= 0);
  const byChannel = {};
  for (const r of rows) {
    if (r.latency_ms == null || r.latency_ms < 0) continue;
    const ch = r.comm_channel ?? 'wifi';
    if (!byChannel[ch]) byChannel[ch] = [];
    byChannel[ch].push(r.latency_ms);
  }

  const channelStats = {};
  for (const [ch, vals] of Object.entries(byChannel)) channelStats[ch] = computeStats(vals);
  const retryCount = rows.filter(r => r.retry).length;

  res.json({
    target_ms:     3000,
    overall:       computeStats(all) ?? { count: 0 },
    by_channel:    channelStats,
    retry_count:   retryCount,
    retry_pct:     all.length ? +(retryCount / all.length * 100).toFixed(1) : 0,
  });
});

// SO2 detailed benchmark - returns raw rows for chart/export
app.get('/latency/benchmark', requireDashboard, async (req, res) => {
  const limit   = Math.min(parseInt(req.query.limit ?? '200'), 1000);
  const channel = req.query.channel;
  let query = supabase
    .from('latency_logs')
    .select('received_at, latency_ms, comm_channel, seq, retry, truck_id')
    .order('received_at', { ascending: false })
    .limit(limit);
  if (channel) query = query.eq('comm_channel', channel);
  const { data, error } = await query;
  if (error) return res.status(400).json({ error: error.message });
  res.json(data ?? []);
});

// ?????????????????????????????????????????????????????????????
app.get('/analytics', requireDashboard, async (req, res) => {
  const days  = Math.min(parseInt(req.query.days ?? '7'), 30);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const [{ data: trucks }, { data: telemetry }, { data: alertData }] = await Promise.all([
    supabase.from('trucks').select('id, truck_code, plate_number'),
    supabase.from('telemetry_logs')
      .select('truck_id, fuel_level, speed, timestamp, sent_at')
      .gte('timestamp', since).order('truck_id').order('timestamp'),
    supabase.from('alerts')
      .select('truck_id, alert_type, severity, timestamp')
      .gte('timestamp', since),
  ]);

  const truckMap = Object.fromEntries((trucks ?? []).map(t => [t.id, t]));
  const byTruck  = {};
  for (const row of (telemetry ?? [])) {
    if (!byTruck[row.truck_id]) byTruck[row.truck_id] = [];
    byTruck[row.truck_id].push(row);
  }

  const stats = Object.entries(byTruck).map(([tid, rows]) => {
    rows.sort((a, b) => new Date(a.sent_at ?? a.timestamp) - new Date(b.sent_at ?? b.timestamp));
    let distance = 0;
    for (let i = 0; i < rows.length - 1; i++) {
      const t1 = new Date(rows[i].sent_at ?? rows[i].timestamp).getTime();
      const t2 = new Date(rows[i + 1].sent_at ?? rows[i + 1].timestamp).getTime();
      const deltaS = (t2 - t1) / 1000;
      if (deltaS > 0 && deltaS <= 60 && (rows[i].speed ?? 0) >= 0) {
        distance += Math.min(rows[i].speed ?? 0, 200) * deltaS / 3600;
      }
    }
    let fuelConsumed  = 0;
    for (let i = 1; i < rows.length; i++) {
      const d = (rows[i].fuel_level ?? 0) - (rows[i-1].fuel_level ?? 0);
      if (d < 0) fuelConsumed += Math.abs(d);
    }
    const opHours   = rows.length >= 2
      ? (new Date(rows[rows.length-1].timestamp) - new Date(rows[0].timestamp)) / 3600000 : 0;
    const speeds    = rows.map(r => r.speed).filter(v => v != null);
    const avgSpeed  = speeds.length ? speeds.reduce((s,v) => s+v, 0) / speeds.length : 0;
    const vAlerts   = (alertData ?? []).filter(a => a.truck_id === tid);
    const anomalies = vAlerts.filter(a => a.alert_type === 'fuel_anomaly').length;
    const sample    = rows.length > 50 ? rows.filter((_,i) => i % Math.ceil(rows.length/50) === 0) : rows;

    return {
      truck_id:          tid,
      truck_code:        truckMap[tid]?.truck_code ?? tid,
      plate_number:      truckMap[tid]?.plate_number ?? '',
      readings:          rows.length,
      distance_km:       +distance.toFixed(1),
      fuel_consumed_pct: +fuelConsumed.toFixed(2),
      operating_hours:   +opHours.toFixed(2),
      avg_speed_kmph:    +avgSpeed.toFixed(1),
      alert_count:       vAlerts.length,
      anomaly_count:     anomalies,
      fuel_trend:        sample.map(r => ({ t: r.timestamp, v: r.fuel_level })),
    };
  });

  res.json({
    period_days: days,
    since,
    trucks: stats,
    totals: {
      total_distance_km:      +stats.reduce((s,v) => s + v.distance_km, 0).toFixed(1),
      total_fuel_consumed_pct: +stats.reduce((s,v) => s + v.fuel_consumed_pct, 0).toFixed(2),
      total_operating_hours:  +stats.reduce((s,v) => s + v.operating_hours, 0).toFixed(2),
      total_anomalies:        stats.reduce((s,v) => s + v.anomaly_count, 0),
    },
  });
});

// ?????????????????????????????????????????????????????????????
app.get('/analytics/maintenance-forecast', requireDashboard, async (_req, res) => {
  const DAYS = 30;
  const since = new Date(Date.now() - DAYS * 86400000).toISOString();

  // Use trip_sessions.distance_km (the canonical per-trip distance) instead of
  const [{ data: trucks, error: tErr },
         { data: trips, error: trErr }] = await Promise.all([
    supabase.from('trucks')
      .select('id, truck_code, plate_number, current_odometer_km, last_maintenance_odometer_km, maintenance_interval_km')
      .order('truck_code'),
    supabase.from('trip_sessions')
      .select('truck_id, start_time, distance_km, trip_status')
      .gte('start_time', since)
      .eq('trip_status', 'ended')
      .not('distance_km', 'is', null)
      .limit(5000),
  ]);
  if (tErr)  return res.status(400).json({ error: tErr.message  });
  if (trErr) return res.status(400).json({ error: trErr.message });

  // Group completed trips by truck and aggregate distance + active-day span.
  const byTruck = {};
  for (const t of (trips ?? [])) {
    const km = Number(t.distance_km);
    if (!Number.isFinite(km) || km <= 0) continue;
    const k = t.truck_id;
    if (!byTruck[k]) byTruck[k] = { total_km: 0, t0: t.start_time, t1: t.start_time };
    const b = byTruck[k];
    b.total_km += km;
    if (t.start_time < b.t0) b.t0 = t.start_time;
    if (t.start_time > b.t1) b.t1 = t.start_time;
  }

  const rows = (trucks ?? []).map(t => {
    const interval = Number(t.maintenance_interval_km ?? 5000);
    const cur      = t.current_odometer_km;
    const baseline = t.last_maintenance_odometer_km;
    const km_since_service = (cur != null && baseline != null) ? Math.max(0, cur - baseline) : null;
    const km_remaining     = (km_since_service != null) ? Math.max(0, interval - km_since_service) : null;

    const win = byTruck[t.id];
    let avg_km_per_day = null;
    if (win && win.total_km > 0) {
      // Active span between first and last completed trip in the window, with
      const dt_days = Math.max(1, (new Date(win.t1) - new Date(win.t0)) / 86400000);
      avg_km_per_day = +(win.total_km / dt_days).toFixed(1);
    }

    let projected_date = null;
    let days_until = null;
    if (km_remaining != null && avg_km_per_day != null && avg_km_per_day > 0) {
      days_until = Math.ceil(km_remaining / avg_km_per_day);
      projected_date = new Date(Date.now() + days_until * 86400000).toISOString();
    }

    const status =
      km_remaining == null                         ? 'unknown'   :
      km_remaining === 0                           ? 'due'       :
      avg_km_per_day != null && days_until <= 14   ? 'imminent'  :
      avg_km_per_day != null && days_until <= 60   ? 'soon'      :
      'ok';

    return {
      truck_id:                       t.id,
      truck_code:                     t.truck_code,
      plate_number:                   t.plate_number,
      current_odometer_km:            cur,
      last_maintenance_odometer_km:   baseline,
      maintenance_interval_km:        interval,
      km_since_service,
      km_remaining,
      avg_km_per_day,
      days_until,
      projected_date,
      status,
    };
  });

  res.json({ window_days: DAYS, trucks: rows });
});

// ?????????????????????????????????????????????????????????????
app.get('/analytics/anomaly-heatmap', requireDashboard, async (req, res) => {
  const days  = Math.min(Math.max(parseInt(req.query.days ?? '90'), 1), 365);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const { data, error } = await supabase
    .from('alerts')
    .select('alert_type, severity, timestamp')
    .eq('alert_type', 'fuel_anomaly')
    .gte('timestamp', since);
  if (error) return res.status(400).json({ error: error.message });

  const cells = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const a of (data ?? [])) {
    const d = new Date(a.timestamp);
    if (isNaN(d.getTime())) continue;
    cells[d.getUTCDay()][d.getUTCHours()] += 1;
  }
  const total = (data ?? []).length;
  const max_cell = Math.max(0, ...cells.flat());

  res.json({
    window_days: days,
    since,
    total_anomalies: total,
    max_cell,
    // Flat list of {dow, hour, count} for the frontend to render cleanly
    cells: cells.flatMap((row, dow) =>
      row.map((count, hour) => ({ dow, hour, count }))),
  });
});

// ?????????????????????????????????????????????????????????????

// GET /settings/thresholds
app.get('/settings/thresholds', requireHeadAdmin, async (_req, res) => {
  const { data, error } = await supabase
    .from('settings')
    .select('*')
    .eq('key', 'thresholds')
    .single();

  if (error) {
    // Return defaults if not yet saved
    return res.json({
      rest_hours: 4, rest_distance_km: 300,
      maintenance_km: 5000, overspeed_kmh: 100,
    });
  }
  res.json(data.value);
});

// PUT /settings/thresholds
app.put('/settings/thresholds', requireHeadAdmin, async (req, res) => {
  const { rest_hours, rest_distance_km, maintenance_km, overspeed_kmh } = req.body;

  const { error } = await supabase
    .from('settings')
    .upsert([{ key: 'thresholds', value: { rest_hours, rest_distance_km, maintenance_km, overspeed_kmh } }],
            { onConflict: 'key' });

  if (error) return res.status(400).json({ error: error.message });

  // maintenance_interval_km column that the dashboard reads in preference
  if (Number.isFinite(Number(maintenance_km)) && Number(maintenance_km) > 0) {
    const { error: truckErr } = await supabase
      .from('trucks')
      .update({ maintenance_interval_km: Number(maintenance_km) })
      .neq('id', '00000000-0000-0000-0000-000000000000');   // match all rows
    if (truckErr) console.warn('[settings] truck maintenance interval propagation failed:', truckErr.message);
  }

  invalidateThresholdCache();   // force re-read on next telemetry
  res.json({ saved: true });
});

app.get('/settings/users', requireHeadAdmin, async (_req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, full_name, username, role, is_active, created_at')
    .order('role')
    .order('full_name');

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.post('/settings/users', requireHeadAdmin, async (req, res) => {
  const { full_name, username, password, role } = req.body;

  if (!full_name || !username || !password || !role)
    return res.status(400).json({ error: 'full_name, username, password, and role are required.' });

  if (!['fleet_manager', 'manager'].includes(role))
    return res.status(400).json({ error: 'Invalid role. Allowed: fleet_manager, manager.' });

  const password_hash = await bcrypt.hash(password, 10);

  const { data, error } = await supabase
    .from('users')
    .insert([{ full_name, username: username.toLowerCase().trim(), password_hash, role, is_active: true }])
    .select('id, full_name, username, role, created_at')
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

app.patch('/settings/users/:id', requireHeadAdmin, async (req, res) => {
  const allowed = ['full_name', 'username', 'role', 'is_active'];
  const updates = Object.fromEntries(
    Object.entries(req.body).filter(([k]) => allowed.includes(k))
  );
  if (updates.username) updates.username = updates.username.toLowerCase().trim();

  // Password change - hash separately, never stored as plaintext
  if (req.body.password !== undefined) {
    if (!req.body.password || req.body.password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    updates.password_hash = await bcrypt.hash(req.body.password, 10);
  }

  if (Object.keys(updates).length === 0)
    return res.status(400).json({ error: 'No valid fields to update.' });

  const { data, error } = await supabase
    .from('users')
    .update(updates)
    .eq('id', req.params.id)
    .select('id, full_name, username, role, is_active')
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// DELETE /settings/users/:id
app.delete('/settings/users/:id', requireHeadAdmin, async (req, res) => {
  // Prevent deleting head admin accounts
  const { data: target } = await supabase
    .from('users').select('role').eq('id', req.params.id).single();

  if (target?.role === 'head_admin')
    return res.status(403).json({ error: 'Cannot delete head admin accounts' });

  const { error } = await supabase.from('users').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ deleted: true });
});

// ?????????????????????????????????????????????????????????????

app.get('/settings/drivers', requireHeadAdmin, async (_req, res) => {
  const { data, error } = await supabase
    .from('drivers')
    .select('id, full_name, pin, is_active, created_at')
    .order('full_name');

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.post('/settings/drivers', requireHeadAdmin, async (req, res) => {
  const { full_name, pin } = req.body;

  if (!full_name || !pin)
    return res.status(400).json({ error: 'full_name and pin are required.' });
  if (!/^\d{4}$/.test(pin))
    return res.status(400).json({ error: 'PIN must be exactly 4 numeric digits.' });

  // Enforce global PIN uniqueness
  const { data: conflict } = await supabase
    .from('drivers').select('id').eq('pin', pin).maybeSingle();
  if (conflict)
    return res.status(409).json({ error: `PIN ${pin} is already assigned to another driver. Each driver must have a unique PIN.` });

  const pin_hash = await bcrypt.hash(pin, 10);

  const { data, error } = await supabase
    .from('drivers')
    .insert([{ full_name, pin, pin_hash, is_active: true }])
    .select('id, full_name, pin, is_active, created_at')
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /settings/drivers/:id - toggle active status, reset PIN, or rename
app.patch('/settings/drivers/:id', requireHeadAdmin, async (req, res) => {
  const updates = {};

  if (req.body.is_active !== undefined)
    updates.is_active = Boolean(req.body.is_active);

  if (req.body.pin !== undefined) {
    if (!/^\d{4}$/.test(req.body.pin))
      return res.status(400).json({ error: 'PIN must be exactly 4 numeric digits.' });

    const { data: conflict } = await supabase
      .from('drivers').select('id').eq('pin', req.body.pin).neq('id', req.params.id).maybeSingle();
    if (conflict)
      return res.status(409).json({ error: `PIN ${req.body.pin} is already assigned to another driver. Each driver must have a unique PIN.` });

    updates.pin = req.body.pin;
    updates.pin_hash = await bcrypt.hash(req.body.pin, 10);
  }

  if (req.body.full_name !== undefined)
    updates.full_name = req.body.full_name.trim();

  if (Object.keys(updates).length === 0)
    return res.status(400).json({ error: 'No valid fields to update.' });

  const { data, error } = await supabase
    .from('drivers')
    .update(updates)
    .eq('id', req.params.id)
    .select('id, full_name, pin, is_active, created_at')
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// DELETE /settings/drivers/:id
app.delete('/settings/drivers/:id', requireHeadAdmin, async (req, res) => {
  // Block deletion if driver has an active trip
  const { data: activeTrip } = await supabase
    .from('trip_sessions')
    .select('id')
    .eq('driver_id', req.params.id)
    .eq('trip_status', 'active')
    .limit(1)
    .maybeSingle();

  if (activeTrip)
    return res.status(409).json({ error: 'Cannot delete a driver with an active trip.' });

  const { error } = await supabase.from('drivers').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ deleted: true });
});

app.post('/trucks', requireHeadAdmin, async (req, res) => {
  const { truck_code, plate_number, model, notes,
          length_m, width_m, height_m, weight_t, axleload_t, hazmat,
          tank_capacity_l, current_odometer_km } = req.body;
  if (!truck_code || !plate_number)
    return res.status(400).json({ error: 'truck_code and plate_number are required' });

  // When admin seeds an initial mileage for an existing truck being onboarded,
  const seedOdo = Number.isFinite(Number(current_odometer_km)) && Number(current_odometer_km) > 0
    ? +Number(current_odometer_km).toFixed(1)
    : 0;

  const { data, error } = await supabase
    .from('trucks')
    .insert([{
      truck_code, plate_number, model, notes, device_installed: false,
      length_m:        length_m        ?? 12.0,
      width_m:         width_m         ?? 2.5,
      height_m:        height_m        ?? 4.0,
      weight_t:        weight_t        ?? 20.0,
      axleload_t:      axleload_t      ?? 11.5,
      hazmat:          hazmat          ?? false,
      // the actual usable capacity measured at the pump rather than the
      tank_capacity_l: tank_capacity_l ?? 80.0,
      current_odometer_km:          seedOdo,
      last_maintenance_odometer_km: seedOdo,
    }])
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

app.put('/trucks/:id', requireHeadAdmin, async (req, res) => {
  const { truck_code, plate_number, model, notes,
          length_m, width_m, height_m, weight_t, axleload_t, hazmat,
          tank_capacity_l, current_odometer_km } = req.body;

  const updates = {};
  if (truck_code      != null) updates.truck_code      = truck_code;
  if (plate_number    != null) updates.plate_number    = plate_number;
  if (model           != null) updates.model           = model;
  if (notes           != null) updates.notes           = notes;
  if (length_m        != null) updates.length_m        = length_m;
  if (width_m         != null) updates.width_m         = width_m;
  if (height_m        != null) updates.height_m        = height_m;
  if (weight_t        != null) updates.weight_t        = weight_t;
  if (axleload_t      != null) updates.axleload_t      = axleload_t;
  if (hazmat          != null) updates.hazmat          = hazmat;
  if (tank_capacity_l != null) updates.tank_capacity_l = tank_capacity_l;
  // continues adding each completed trip's distance to whatever value sits here.
  if (current_odometer_km != null && Number.isFinite(Number(current_odometer_km))) {
    updates.current_odometer_km = +Number(current_odometer_km).toFixed(1);
  }

  const { data, error } = await supabase
    .from('trucks')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.delete('/trucks/:id', requireHeadAdmin, async (req, res) => {
  // Check for active trip first
  const { data: activeTrip } = await supabase
    .from('trip_sessions')
    .select('id')
    .eq('truck_id', req.params.id)
    .eq('trip_status', 'active')
    .limit(1)
    .single();

  if (activeTrip)
    return res.status(409).json({ error: 'Cannot delete truck with an active trip' });

  const { error } = await supabase.from('trucks').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ deleted: true });
});

// ?? ML Service Health - GET /ml/status ????????????????????????
app.get('/ml/status', async (_req, res) => {
  try {
    const r = await fetch(ML_HEALTH_URL, { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      const body = await r.json();
      // Spread body first so the Flask "status: ok" gets overwritten by
      return res.json({ ...body, status: 'active' });
    }
    return res.json({ status: 'error', reason: `ML service returned ${r.status}` });
  } catch (e) {
    return res.json({ status: 'offline', reason: e.message });
  }
});

// dyno and we never try to spawn Python here.
if (!ML_AUTOSPAWN) {
  console.log('[ml] autospawn disabled - using remote ML service at', ML_BASE_URL);
} else (function spawnMlService() {
  const { spawn } = require('child_process');
  const { join }  = require('path');
  const mlPath    = join(__dirname, '..', 'ml', 'anomaly_service.py');
  const mlCwd     = join(__dirname, '..', 'ml');

  // On Windows 'python' may not be in PATH; try candidates in order.
  const PYTHON_CANDIDATES = ['python', 'python3', 'py'];
  let pyProc       = null;
  let restartDelay = 3000;
  let restarting   = false; // guard: close + error can both fire, only restart once

  function scheduleRestart(delaySec, exeIdx = 0) {
    if (restarting) return;
    restarting = true;
    console.warn(`[ml] restarting in ${delaySec}s...`);
    setTimeout(() => start(exeIdx), delaySec * 1000);
    restartDelay = Math.min(restartDelay * 2, 15000);
  }

  function start(exeIdx = 0) {
    restarting = false;
    const exe = PYTHON_CANDIDATES[exeIdx];
    pyProc = spawn(exe, [mlPath], { cwd: mlCwd, stdio: ['ignore', 'pipe', 'pipe'] });

    pyProc.stdout.on('data', d => process.stdout.write(`[ml] ${d}`));
    pyProc.stderr.on('data', d => process.stderr.write(`[ml] ${d}`));

    pyProc.on('spawn', () => {
      console.log(`[ml] anomaly service started (pid=${pyProc.pid}, exe=${exe})`);
      restartDelay = 3000; // reset backoff on successful launch
    });

    pyProc.on('error', err => {
      if (err.code === 'ENOENT' && exeIdx < PYTHON_CANDIDATES.length - 1) {
        console.warn(`[ml] '${exe}' not found - trying '${PYTHON_CANDIDATES[exeIdx + 1]}'`);
        if (!restarting) { restarting = true; setTimeout(() => start(exeIdx + 1), 500); }
        return;
      }
      console.error(`[ml] spawn error (${exe}): ${err.message}`);
      scheduleRestart(restartDelay / 1000);
    });

    pyProc.on('close', code => {
      pyProc = null;
      if (code !== 0) console.warn(`[ml] exited (code=${code})`);
      scheduleRestart(restartDelay / 1000);
    });
  }

  start();

  // the process appears to be running (internal crash), kill and restart.
  setInterval(async () => {
    try {
      const r = await fetch(ML_HEALTH_URL, { signal: AbortSignal.timeout(3000) });
      if (r.ok) { restartDelay = 3000; return; } // healthy - reset backoff
      throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      console.warn(`[ml] watchdog: /health unreachable (${e.message}) - forcing restart`);
      if (pyProc) { try { pyProc.kill(); } catch {} pyProc = null; }
      scheduleRestart(1);
    }
  }, 30_000);
})();

// gaps when the ML service was restarting while live telemetry arrived).
const BACKFILL_PAGE = 200;   // rows per DB fetch
const BACKFILL_DELAY_MS = 150; // ms between pages - keeps DB + ML load light

async function waitForMl(maxWaitMs = 120_000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(ML_HEALTH_URL, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch {}
    await new Promise(res => setTimeout(res, 5000));
  }
  return false;
}

async function runMlOnRow(row, prevRow, fuelSeries) {
  const { id, fuel_level, speed, odometer_km, engine_status } = row;
  const numericSpeed = Number(speed ?? 0);

  if (!prevRow || fuel_level == null || prevRow.fuel_level == null) {
    return { id, anomaly_flag: false, anomaly_score: 0, model_source: 'backfill_no_prev' };
  }

  const fuelDelta  = fuel_level - prevRow.fuel_level;
  const odoDelta   = Math.max(0, (odometer_km ?? 0) - (prevRow.odometer_km ?? 0));
  const fuelPerKm  = odoDelta > 0 ? (-fuelDelta / odoDelta) : 0;

  // Skip conditions - same as live detection
  if (engine_status !== 'on' ||
      (numericSpeed < 5 && odoDelta < 0.05) ||
      (odoDelta < 0.08 && Math.abs(fuelDelta) < 0.8) ||
      fuelDelta > 1.5) {
    return { id, anomaly_flag: false, anomaly_score: 0, model_source: 'backfill_skipped' };
  }

  try {
    const mlRes = await fetch(ML_DETECT_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fuel_level, speed_kmph: speed,
        fuel_delta: fuelDelta, odometer_delta: odoDelta,
        fuel_per_km: fuelPerKm, fuel_series: [...fuelSeries],
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!mlRes.ok) return null;
    const { is_anomaly, model_source, combined_score } = await mlRes.json();
    // Matches live-path stationary clause (?Fix A, 2026-07-13): engine_status
    const suspiciousContext = fuelDelta < -2.0 || fuelPerKm >= 0.6 || (numericSpeed < 5 && fuelDelta < -1.0);
    const contextualAnomaly = Boolean(is_anomaly && combined_score > 0.55 && suspiciousContext);
    return { id, anomaly_flag: contextualAnomaly, anomaly_score: combined_score, model_source };
  } catch {
    return null; // ML timeout - leave anomaly_score NULL so next pass retries
  }
}

async function mlBackfillTable(table, sinceIso = null) {
  // 'simulation' channel becomes prev for the next real 'wifi'/'lora' row and
  const prevByTruckChan   = new Map(); // `${truck_id}|${channel}` -> { fuel_level, odometer_km }
  const fuelSeriesByTruck = new Map(); // truck_id -> float[] (last 40)
  let offset = 0, processed = 0, anomalies = 0;

  while (true) {
    let q = supabase
      .from(table)
      .select('id, truck_id, fuel_level, speed, odometer_km, engine_status, comm_channel')
      .is('anomaly_score', null)
      .or('source_device.is.null,source_device.neq.mobile')
      .order('truck_id', { ascending: true })
      .order('timestamp', { ascending: true })
      .range(offset, offset + BACKFILL_PAGE - 1);

    if (sinceIso) q = q.gte('timestamp', sinceIso);

    const { data: rows, error } = await q;
    if (error) { console.error(`[ml-backfill] ${table}: ${error.message}`); break; }
    if (!rows || rows.length === 0) break;

    const updates = [];

    for (const row of rows) {
      const { truck_id, fuel_level, odometer_km, comm_channel } = row;
      const chanKey = `${truck_id}|${comm_channel ?? '_null'}`;

      if (!fuelSeriesByTruck.has(truck_id)) fuelSeriesByTruck.set(truck_id, []);
      const fuelSeries = fuelSeriesByTruck.get(truck_id);
      if (fuel_level != null) { fuelSeries.push(fuel_level); if (fuelSeries.length > 40) fuelSeries.shift(); }

      const result = await runMlOnRow(row, prevByTruckChan.get(chanKey), fuelSeries);
      if (result) {
        updates.push(result);
        if (result.anomaly_flag) anomalies++;
        processed++;
      }

      prevByTruckChan.set(chanKey, { fuel_level, odometer_km });
    }

    // Batch update all results for this page
    if (updates.length > 0) {
      await Promise.all(updates.map(u =>
        supabase.from(table).update({
          anomaly_flag:  u.anomaly_flag,
          anomaly_score: u.anomaly_score,
          model_source:  u.model_source,
        }).eq('id', u.id)
      ));
    }

    offset += BACKFILL_PAGE;
    if (rows.length < BACKFILL_PAGE) break;
    await new Promise(res => setTimeout(res, BACKFILL_DELAY_MS));
  }

  return { processed, anomalies };
}

async function mlFullBackfill() {
  const ready = await waitForMl();
  if (!ready) { console.warn('[ml-backfill] ML never came online - skipping startup backfill'); return; }

  console.log('[ml-backfill] starting full historical scan...');
  for (const table of ['telemetry_logs', 'archived_telemetry_logs']) {
    const { processed, anomalies } = await mlBackfillTable(table, null);
    console.log(`[ml-backfill] ${table}: ${processed} rows scored, ${anomalies} anomalies`);
  }
  console.log('[ml-backfill] full scan complete');
}

async function mlIncrementalBackfill() {
  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  for (const table of ['telemetry_logs', 'archived_telemetry_logs']) {
    const { processed, anomalies } = await mlBackfillTable(table, since);
    if (processed > 0) console.log(`[ml-backfill] incremental ${table}: ${processed} rows scored, ${anomalies} anomalies`);
  }
}

mlFullBackfill().catch(e => console.error('[ml-backfill] error:', e.message));

// Incremental pass every 5 minutes to catch live rows that missed ML
setInterval(() => mlIncrementalBackfill().catch(e => console.error('[ml-backfill] incremental error:', e.message)), 5 * 60_000);

// ?????????????????????????????????????????????????????????????
app.listen(PORT, () => {
  console.log(`Fleet API running on http://localhost:${PORT}`);
});
