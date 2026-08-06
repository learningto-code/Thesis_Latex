import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchTripStatus, fetchLatestTelemetry, pauseTrip, resumeTrip, endTrip,
         requestPause, requestResume, requestEndTrip } from '../../utils/driverApi';
import { getDriverSession, setDriverSession, clearDriverSession } from './DriverApp';
import { Fuel, Gauge, MapPin, AlertTriangle, AlertOctagon, Info, Radio } from 'lucide-react';

const POLL_INTERVAL_MS = 10000;   // poll trip status + telemetry every 10s
const TOAST_DURATION_MS = 5000;   // auto-dismiss alert toasts

function fmtTimer(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export default function DriverTrip({ session, onLogout }) {
  const navigate = useNavigate();
  const [trip, setTrip] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [telemetry, setTelemetry] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState('active');  // 'active' | 'paused'
  const [acting, setActing] = useState(false);
  const [error, setError] = useState('');
  const [connState, setConnState] = useState('online');
  const [toasts, setToasts] = useState([]);
  const prevAlertIdsRef = useRef(new Set());
  const timerRef = useRef(null);
  const pollRef  = useRef(null);
  // See DriverNav.jsx - same race: pending_action takes 15-30s to round-trip
  const pendingStatusRef = useRef({ expected: null, until: 0 });

  const currentSession = getDriverSession();
  const tripId     = currentSession?.trip_id;
  const truckId    = currentSession?.truck_id;
  const truckCode  = currentSession?.truck_code ?? '';
  // 'mobile_app' = started on phone  |  'gsm'/'lora' = started on embedded HMI
  const tripChannel = currentSession?.trip_channel ?? 'gsm';

  const poll = useCallback(async () => {
    if (!tripId || !truckId) return;
    try {
      const [tripData, telem] = await Promise.all([
        fetchTripStatus(tripId),
        fetchLatestTelemetry(truckId),
      ]);
      setTrip(tripData.trip);
      setAlerts(tripData.alerts ?? []);
      setTelemetry(telem);
      const serverStatus = tripData.trip?.trip_status ?? 'active';
      const pending = pendingStatusRef.current;
      if (pending.expected && Date.now() < pending.until) {
        if (serverStatus === pending.expected) {
          pendingStatusRef.current = { expected: null, until: 0 };
          setStatus(serverStatus);
        } else {
          setStatus(pending.expected);
        }
      } else {
        setStatus(serverStatus);
      }
      setConnState('online');
    } catch {
      setConnState('offline');
    }
  }, [tripId, truckId]);

  // Timer
  useEffect(() => {
    timerRef.current = setInterval(() => {
      if (status === 'active') setElapsed((e) => e + 1000);
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, [status]);

  // Set elapsed from trip start_time on first load
  useEffect(() => {
    if (trip?.start_time) {
      setElapsed(Date.now() - new Date(trip.start_time).getTime());
    }
  }, [trip?.start_time]);

  // Polling
  useEffect(() => {
    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(pollRef.current);
  }, [poll]);

  // Alert toasts - show new backend alerts as floating popup cards
  useEffect(() => {
    const newOnes = alerts.filter(a => !prevAlertIdsRef.current.has(a.id));
    prevAlertIdsRef.current = new Set(alerts.map(a => a.id));
    if (!newOnes.length) return;
    newOnes.forEach(a => {
      const key = `${a.id}-${Date.now()}`;
      const bg  = a.severity === 'high' ? '#8b0000' : a.severity === 'medium' ? '#7a4000' : '#0d1f3c';
      setToasts(q => [...q, { key, msg: a.message, bg, severity: a.severity ?? 'low' }]);
      setTimeout(() => setToasts(q => q.filter(t => t.key !== key)), TOAST_DURATION_MS);
    });
  }, [alerts]);

  // Driver actions now go through the LoRa-mediated pending-action queue.
  async function handlePause() {
    setActing(true);
    setError('');
    try {
      await requestPause(tripId);
      setStatus('paused');
      pendingStatusRef.current = { expected: 'paused', until: Date.now() + 30000 };
      poll();
    } catch (e) {
      if (e.code === 'HMI_PRIORITY') { poll(); } // sync authoritative state silently
      else setError(e.message);
    } finally { setActing(false); }
  }

  async function handleResume() {
    setActing(true);
    setError('');
    try {
      await requestResume(tripId);
      setStatus('active');
      pendingStatusRef.current = { expected: 'active', until: Date.now() + 30000 };
      poll();
    } catch (e) {
      if (e.code === 'HMI_PRIORITY') { poll(); }
      else setError(e.message);
    } finally { setActing(false); }
  }

  async function handleEnd() {
    if (!window.confirm('End this trip?')) return;
    setActing(true);
    setError('');
    try {
      const lat = telemetry?.lat ?? null;
      const lon = telemetry?.lon ?? null;
      await requestEndTrip(tripId, lat, lon);
      clearDriverSession();
      navigate('/driver/notrip');
    } catch (e) {
      if (e.code === 'HMI_PRIORITY') { poll(); }
      else setError(e.message);
    } finally { setActing(false); }
  }

  const fuel = telemetry?.fuel_level != null ? `${telemetry.fuel_level.toFixed(1)}%` : '--';
  const speed = telemetry?.speed != null ? `${Math.round(telemetry.speed)} km/h` : '--';
  const lat = telemetry?.lat?.toFixed(5) ?? '--';
  const lon = telemetry?.lon?.toFixed(5) ?? '--';
  const chan = (() => {
    const raw = telemetry?.channel_used ?? 'cellular';
    return raw === 'gsm' || raw === 'lte' ? 'cellular' : raw;
  })();

  const connBadge = {
    online: { bg: '#003322', text: '#00cc66', label: '? Online' },
    offline: { bg: '#330000', text: '#ff6666', label: '? Offline' },
  }[connState];

  const isHmiTrip = tripChannel !== 'mobile_app';

  return (
    <div style={styles.page}>
      {}
      {isHmiTrip && (
        <div style={styles.hmiBanner}>
          <Radio size={13} style={{verticalAlign:'middle',marginRight:5}} />
          Trip started on embedded HMI . OBD2 &amp; GPS data from vehicle device
        </div>
      )}

      {}
      <div style={styles.header}>
        <div>
          <div style={styles.truckCode}>{truckCode || 'Trip Active'}</div>
          <div style={styles.driverName}>{session?.full_name}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <span style={{ ...styles.badge, background: connBadge.bg, color: connBadge.text }}>{connBadge.label}</span>
          <span style={{ ...styles.badge, background: '#001a33', color: '#7799bb', fontSize: 10 }}>
            <span style={{ display:'inline-block', width:8, height:8, borderRadius:'50%', background: status === 'active' ? '#00e676' : '#FFB020', marginRight:4, verticalAlign:'middle' }} />
            {status === 'active' ? 'ACTIVE' : 'RESTING'} . via {chan}
          </span>
        </div>
      </div>

      {}
      <div style={styles.timerBox}>
        <div style={styles.timerLabel}>{status === 'paused' ? 'RESTING' : 'TRIP TIME'}</div>
        <div style={styles.timer}>{fmtTimer(elapsed)}</div>
      </div>

      {}
      <div style={styles.cards}>
        <DataCard label="Fuel" value={fuel} icon={<Fuel size={20} />} warn={telemetry?.fuel_level < 20} />
        <DataCard label="Speed" value={speed} icon={<Gauge size={20} />} warn={telemetry?.speed > 80} />
        <DataCard label="GPS" value={`${lat}, ${lon}`} icon={<MapPin size={20} />} small />
      </div>

      {error && <p style={styles.error}>{error}</p>}

      {}
      {toasts.length > 0 && (
        <div style={styles.toastStack}>
          {toasts.slice(-3).map(t => (
            <div key={t.key} style={{ ...styles.toast, background: t.bg }}>
              <span style={styles.toastIcon}>
                {t.severity === 'high'
                  ? <AlertOctagon size={15} color="#ff8080" />
                  : t.severity === 'medium'
                    ? <AlertTriangle size={15} color="#ffb347" />
                    : <Info size={15} color="#82B7DC" />}
              </span>
              <span style={styles.toastMsg}>{t.msg}</span>
            </div>
          ))}
        </div>
      )}

      {}
      <div style={styles.actions}>
        {status === 'active' ? (
          <button style={{ ...styles.btn, background: '#aa5500' }} disabled={acting} onClick={handlePause}>
            {acting ? '...' : '?  Take Rest'}
          </button>
        ) : (
          <button style={{ ...styles.btn, background: '#005522' }} disabled={acting} onClick={handleResume}>
            {acting ? '...' : '?  Resume'}
          </button>
        )}
        <button style={{ ...styles.btn, background: '#880022' }} disabled={acting} onClick={handleEnd}>
          End Trip
        </button>
      </div>

      {}
      <button style={styles.mapBtn} onClick={() => navigate('/driver/map')}>
        ?  Open Map &amp; Navigation
      </button>

      {}
      {alerts.length > 0 && (
        <div style={styles.alertList}>
          <div style={styles.alertListTitle}>Active Alerts</div>
          {alerts.map((a) => (
            <div key={a.id} style={{ ...styles.alertRow, borderLeft: `3px solid ${a.severity === 'high' ? '#ff4444' : '#ffaa00'}` }}>
              <span style={styles.alertType}>{a.alert_type.replace('_', ' ')}</span>
              <span style={styles.alertMsg}>{a.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DataCard({ label, value, icon, warn, small }) {
  return (
    <div style={{ ...cardStyles.card, border: warn ? '1px solid #ff4444' : '1px solid #003366' }}>
      <span style={cardStyles.icon}>{icon}</span>
      <div style={cardStyles.label}>{label}</div>
      <div style={{ ...cardStyles.value, fontSize: small ? 12 : 20 }}>{value}</div>
    </div>
  );
}

const styles = {
  page: { display: 'flex', flexDirection: 'column', minHeight: '100dvh', background: '#001133', paddingBottom: 24 },
  hmiBanner: { background: '#001f44', borderBottom: '1px solid #003366', padding: '7px 16px', fontSize: 11, color: '#5599cc', textAlign: 'center', letterSpacing: 0.2 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '16px 20px', background: '#002255', borderBottom: '1px solid #003377' },
  truckCode: { fontSize: 20, fontWeight: 700, color: '#ffffff' },
  driverName: { fontSize: 12, color: '#7799bb', marginTop: 2 },
  badge: { borderRadius: 8, padding: '4px 10px', fontSize: 11, fontWeight: 600 },
  timerBox: { background: '#001a44', padding: '20px 20px 16px', textAlign: 'center', borderBottom: '1px solid #003366' },
  timerLabel: { fontSize: 10, letterSpacing: 2, color: '#7799bb', marginBottom: 4 },
  timer: { fontSize: 44, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: '#ffffff', letterSpacing: 2 },
  cards: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, padding: '16px 16px 0' },
  error: { margin: '8px 20px', color: '#ff6666', fontSize: 13, textAlign: 'center' },
  toastStack: { position: 'fixed', bottom: 100, left: 0, right: 0, zIndex: 9000, display: 'flex', flexDirection: 'column', gap: 8, padding: '0 16px', pointerEvents: 'none' },
  toast: { display: 'flex', alignItems: 'flex-start', gap: 10, borderRadius: 14, padding: '13px 16px', boxShadow: '0 4px 24px rgba(0,0,0,0.7)', border: '1px solid rgba(255,255,255,0.12)' },
  toastIcon: { flexShrink: 0, marginTop: 1 },
  toastMsg: { fontSize: 13, color: '#ffffff', fontWeight: 600, lineHeight: 1.4 },
  actions: { display: 'flex', gap: 10, padding: '16px 16px 0' },
  btn: { flex: 1, padding: '16px 0', fontSize: 16, fontWeight: 700, borderRadius: 12, border: 'none', color: '#ffffff', cursor: 'pointer', touchAction: 'manipulation' },
  mapBtn: { margin: '10px 16px 0', padding: '14px 0', fontSize: 15, fontWeight: 600, borderRadius: 12, border: '1px solid #003366', background: '#001a44', color: '#00aaff', cursor: 'pointer', touchAction: 'manipulation' },
  alertList: { margin: '16px 16px 0' },
  alertListTitle: { fontSize: 12, color: '#7799bb', letterSpacing: 1, marginBottom: 8 },
  alertRow: { background: '#0a1a2a', borderRadius: 8, padding: '10px 12px', marginBottom: 6 },
  alertType: { display: 'block', fontSize: 11, color: '#ffaa44', textTransform: 'uppercase', letterSpacing: 0.5 },
  alertMsg: { display: 'block', fontSize: 13, color: '#ccddee', marginTop: 2 },
};

const cardStyles = {
  card: { background: '#0a1a2a', borderRadius: 12, padding: '14px 12px', textAlign: 'center' },
  icon: { fontSize: 22 },
  label: { fontSize: 10, color: '#7799bb', letterSpacing: 1, marginTop: 4 },
  value: { fontSize: 20, fontWeight: 700, color: '#ffffff', marginTop: 4, wordBreak: 'break-all' },
};
