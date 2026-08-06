import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchTrucks, startTrip, checkHmiSession, hmiAutoLogin } from '../../utils/driverApi';
import { getDriverSession, setDriverSession } from './DriverApp';

export default function DriverTrucks({ session, onLogout }) {
  const [trucks, setTrucks] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [view, setView] = useState('select');
  const navigate = useNavigate();

  useEffect(() => {
    const sess = getDriverSession();
    if (sess?.trip_id) navigate('/driver/trip', { replace: true });
  }, [navigate]);

  // still showed as available because fetchTrucks ran only on mount.
  useEffect(() => {
    let cancelled = false;
    const load = () => fetchTrucks()
      .then(data => { if (!cancelled) setTrucks(data); })
      .catch(() => { if (!cancelled) setError('Could not load trucks - check connection'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    load();
    const id = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Poll HMI session: detect HMI logout or HMI-started trip.
  const hmiLogoutFiredRef = useRef(false);
  useEffect(() => {
    const driverId = session?.user_id;
    if (!driverId) return;
    let cancelled = false;
    async function pollHmi() {
      if (hmiLogoutFiredRef.current) return;
      try {
        const data = await checkHmiSession(driverId);
        if (cancelled) return;
        if (data.session?.status === 'ended') {
          hmiLogoutFiredRef.current = true;
          onLogout?.();
          return;
        }
      } catch { }
      // Separately check if HMI started a trip for this driver
      try {
        const data = await hmiAutoLogin();
        if (cancelled || !data?.active_trip) return;
        const t = data.active_trip.trucks ?? {};
        const updated = {
          ...session,
          trip_id:      data.active_trip.id,
          truck_id:     data.active_trip.truck_id,
          driver_id:    data.active_trip.driver_id ?? session.user_id,
          truck_code:   t.truck_code ?? '',
          trip_channel: data.active_trip.channel_used ?? 'gsm',
          trip_status:  data.active_trip.trip_status ?? 'active',
          start_time:   data.active_trip.start_time ?? null,
          end_time:     data.active_trip.end_time ?? null,
          paused_at:    data.active_trip.paused_at ?? null,
          total_rest_seconds: data.active_trip.total_rest_seconds ?? 0,
          next_rest_alert_at: data.active_trip.next_rest_alert_at ?? null,
          snoozed_until: data.active_trip.snoozed_until ?? null,
          truck_dims: {
            length:   t.length_m   ?? 12.0,
            width:    t.width_m    ?? 2.5,
            height:   t.height_m   ?? 4.0,
            weight:   t.weight_t   ?? 20.0,
            axleload: t.axleload_t ?? 11.5,
            hazmat:   t.hazmat     ?? false,
          },
        };
        setDriverSession(updated);
        navigate('/driver/trip', { replace: true });
      } catch { }
    }
    pollHmi();
    const id = setInterval(pollHmi, 8000);
    return () => { cancelled = true; clearInterval(id); };
  }, [session?.user_id]);

  function chooseTruck(truck) {
    if (truck.is_active) return;
    setSelected(truck);
    setError('');
    setView('ready');
  }

  function buildTruckDims(truck) {
    return {
      length: truck.length_m ?? 12.0,
      width: truck.width_m ?? 2.5,
      height: truck.height_m ?? 4.0,
      weight: truck.weight_t ?? 20.0,
      axleload: truck.axleload_t ?? 11.5,
      hazmat: truck.hazmat ?? false,
    };
  }

  async function handleStartTrip() {
    if (!selected || selected.is_active) return;
    setStarting(true);
    setError('');
    try {
      const body = {
        truck_id: selected.id,
        driver_id: session.user_id,
        start_lat: null,
        start_lon: null,
        source: 'mobile_app',
        channel_used: 'mobile_app',
      };
      const data = await startTrip(body);
      const trip = data.active_trip ?? data;
      const truck = trip.trucks ?? selected;
      const updated = {
        ...session,
        trip_id: trip.id ?? trip.trip_id,
        truck_id: trip.truck_id ?? selected.id,
        driver_id: trip.driver_id ?? session.user_id,
        truck_code: truck.truck_code ?? selected.truck_code,
        trip_channel: 'mobile_app',
        trip_status: trip.trip_status ?? 'active',
        start_time: trip.start_time ?? null,
        end_time: trip.end_time ?? null,
        paused_at: trip.paused_at ?? null,
        total_rest_seconds: trip.total_rest_seconds ?? 0,
        next_rest_alert_at: trip.next_rest_alert_at ?? null,
        snoozed_until: trip.snoozed_until ?? null,
        truck_dims: buildTruckDims(truck),
      };
      setDriverSession(updated);
      navigate('/driver/trip');
    } catch (e) {
      const info = e.active_trip;
      if ((e.status === 409 || e.code === 'DRIVER_ACTIVE') && info?.id) {
        const sess = getDriverSession();
        const updated = {
          ...sess,
          trip_id: info.id,
          truck_id: info.truck_id,
          driver_id: info.driver_id ?? sess?.user_id,
          truck_code: info.truck_code ?? '',
          trip_channel: 'mobile_app',
          trip_status: info.trip_status ?? 'active',
          start_time: info.start_time ?? null,
          paused_at: info.paused_at ?? null,
          total_rest_seconds: info.total_rest_seconds ?? 0,
          next_rest_alert_at: info.next_rest_alert_at ?? null,
        };
        setDriverSession(updated);
        navigate('/driver/trip');
        return;
      }
      setError(e.message || 'Failed to start trip');
    } finally {
      setStarting(false);
    }
  }

  const availableTrucks = trucks.filter(t => !t.is_active);
  const activeTrucks = trucks.filter(t => t.is_active);

  if (view === 'ready' && selected) {
    return (
      <div style={S.page}>
        <div style={S.header}>
          <button style={S.backBtn} onClick={() => setView('select')}>Back</button>
          <span style={S.headerTitle}>Ready</span>
          <button style={S.logoutBtn} onClick={onLogout}>Logout</button>
        </div>

        <div style={S.readyWrap}>
          <div style={S.readyCard}>
            <span style={S.readyLabel}>Selected truck</span>
            <h1 style={S.readyTruck}>{selected.truck_code}</h1>
            <p style={S.readyPlate}>{selected.plate_number}</p>
            <div style={S.readyGrid}>
              <span>{selected.length_m ?? 12.0}m length</span>
              <span>{selected.height_m ?? 4.0}m height</span>
              <span>{selected.weight_t ?? 20.0}t weight</span>
              <span>{selected.hazmat ? 'Hazmat' : 'Standard cargo'}</span>
            </div>
          </div>

          <div style={S.readyMeta}>
            <span>Driver</span>
            <strong>{session?.full_name}</strong>
          </div>

          {error && <p style={S.error}>{error}</p>}

          <button
            style={{
              ...S.startBtn,
              opacity: starting ? 0.6 : 1,
              transform: starting ? 'scale(0.98)' : 'scale(1)',
              transition: 'opacity 0.1s, transform 0.1s',
            }}
            disabled={starting}
            onClick={handleStartTrip}
          >
            {starting
              ? <span style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
                  <span style={S.btnSpinner} />
                  Starting...
                </span>
              : 'START TRIP'}
          </button>
          {}
          <button style={S.secondaryBtn} onClick={() => { if (starting) return; setView('select'); }}>
            {starting ? 'Please wait...' : 'Change Truck'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={S.page}>
      <div style={S.header}>
        <span style={S.headerTitle}>Select Truck</span>
        <button style={S.logoutBtn} onClick={onLogout}>Logout</button>
      </div>
      <p style={S.driverName}>Driver: {session?.full_name}</p>

      {loading && <p style={S.muted}>Loading trucks...</p>}
      {error && <p style={S.error}>{error}</p>}

      <div style={S.list}>
        {availableTrucks.map(t => (
          <button key={t.id} style={S.truckCard} onClick={() => chooseTruck(t)}>
            <div style={S.truckText}>
              <span style={S.truckCode}>{t.truck_code}</span>
              <span style={S.availBadge}>Available</span>
              {}
              {t.device_installed
                ? <span
                    style={{ ...S.deviceDot, background: t.is_online ? '#00e676' : '#555e6e' }}
                    title={t.is_online ? 'HMI device online' : 'HMI device offline'}
                  />
                : <span style={S.noDeviceBadge} title="No embedded HMI device">No HMI</span>
              }
            </div>
            <span style={S.plate}>{t.plate_number}</span>
          </button>
        ))}

        {activeTrucks.length > 0 && <p style={S.sectionLabel}>In Use</p>}
        {activeTrucks.map(t => (
          <div key={t.id} style={S.truckInUse}>
            <div style={S.truckText}>
              <span style={S.truckCodeDim}>{t.truck_code}</span>
              <span style={S.inUseBadge}>In Use</span>
              {t.device_installed
                ? <span style={{ ...S.deviceDot, background: '#555e6e', opacity: 0.6 }} title="HMI device" />
                : <span style={{ ...S.noDeviceBadge, opacity: 0.6 }}>No HMI</span>
              }
            </div>
            <span style={S.plateDim}>{t.plate_number}</span>
          </div>
        ))}

        {!loading && trucks.length === 0 && <p style={S.muted}>No trucks available.</p>}
      </div>
    </div>
  );
}

const S = {
  page: { display: 'flex', flexDirection: 'column', minHeight: '100dvh', background: '#0a1a30', padding: '0 0 max(28px, env(safe-area-inset-bottom))', color: '#F7F7F7', overflowX: 'hidden' },
  header: { display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 8, padding: 'max(14px, env(safe-area-inset-top)) clamp(14px, 4vw, 20px) 14px', background: '#0d1f3c', borderBottom: '1px solid #194D84', boxShadow: '0 2px 12px rgba(0,0,0,0.5)' },
  headerTitle: { gridColumn: '2', fontSize: 'clamp(17px, 5vw, 20px)', fontWeight: 800, color: '#82B7DC' },
  logoutBtn: { justifySelf: 'end', background: 'none', border: '1px solid #346AA8', borderRadius: 10, color: '#82B7DC', padding: '8px 12px', fontSize: 12, cursor: 'pointer' },
  backBtn: { justifySelf: 'start', background: '#112240', border: '1px solid #194D84', borderRadius: 10, color: '#82B7DC', padding: '8px 12px', fontSize: 13, cursor: 'pointer' },
  driverName: { margin: '16px clamp(16px, 5vw, 22px) 8px', fontSize: 14, color: '#82B7DC' },
  muted: { textAlign: 'center', color: '#808080', marginTop: 32 },
  error: { margin: '12px 0', color: '#ff6b6b', fontSize: 13, textAlign: 'center', background: '#2d0a0a', border: '1px solid #7a1515', borderRadius: 10, padding: '11px 14px' },
  list: { flex: 1, padding: '8px clamp(14px, 4vw, 20px)', display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 720, alignSelf: 'center', boxSizing: 'border-box' },
  sectionLabel: { fontSize: 10, color: '#82B7DC', letterSpacing: 1.5, textTransform: 'uppercase', margin: '6px 0 0', paddingLeft: 4 },
  truckCard: { width: '100%', background: '#112240', border: '1px solid #194D84', borderRadius: 14, padding: '15px clamp(14px, 4vw, 18px)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, cursor: 'pointer', touchAction: 'manipulation', textAlign: 'left', minHeight: 72, boxShadow: '0 2px 12px rgba(0,0,0,0.4)' },
  truckText: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' },
  truckCode: { fontSize: 'clamp(18px, 5vw, 22px)', fontWeight: 800, color: '#F7F7F7' },
  availBadge: { fontSize: 10, color: '#22CC66', background: '#062210', padding: '3px 8px', borderRadius: 999 },
  plate: { fontSize: 13, color: '#82B7DC', background: '#194D84', padding: '5px 10px', borderRadius: 8, flexShrink: 0 },
  truckInUse: { background: '#0d1830', border: '1px solid #1a2a40', borderRadius: 14, padding: '15px clamp(14px, 4vw, 18px)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, opacity: 0.65, minHeight: 68 },
  truckCodeDim: { fontSize: 'clamp(18px, 5vw, 22px)', fontWeight: 800, color: '#808080' },
  inUseBadge: { fontSize: 10, color: '#FFB020', background: '#2d1a00', padding: '3px 8px', borderRadius: 999 },
  plateDim: { fontSize: 13, color: '#5a7090', background: '#1a2a3a', padding: '5px 10px', borderRadius: 8, flexShrink: 0 },
  readyWrap: { flex: 1, width: '100%', maxWidth: 720, alignSelf: 'center', padding: 'clamp(18px, 5vw, 26px) clamp(16px, 5vw, 22px)', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 14 },
  readyCard: { background: 'linear-gradient(160deg, #194D84 0%, #0d1f3c 100%)', border: '1px solid #346AA8', borderRadius: 18, padding: 'clamp(18px, 6vw, 26px)', boxShadow: '0 8px 32px rgba(0,50,120,0.6)' },
  readyLabel: { color: '#82B7DC', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1.2 },
  readyTruck: { margin: '8px 0 0', fontSize: 'clamp(34px, 12vw, 54px)', lineHeight: 1, letterSpacing: 0, color: '#F7F7F7' },
  readyPlate: { margin: '8px 0 18px', color: '#82B7DC', fontSize: 16 },
  readyGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, color: '#9EB0C0', fontSize: 'clamp(12px, 3.8vw, 14px)' },
  readyMeta: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, background: '#0d1f3c', border: '1px solid #194D84', borderRadius: 14, padding: '14px 16px', color: '#82B7DC' },
  startBtn: { marginTop: 'auto', minHeight: 58, padding: '17px 0', fontSize: 'clamp(16px, 4.8vw, 18px)', fontWeight: 800, borderRadius: 16, border: 'none', background: '#009950', color: '#ffffff', cursor: 'pointer', touchAction: 'manipulation', letterSpacing: 0.4, userSelect: 'none', WebkitTapHighlightColor: 'transparent' },
  btnSpinner: { display: 'inline-block', width: 16, height: 16, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#ffffff', borderRadius: '50%', animation: 'spin 0.7s linear infinite', flexShrink: 0 },
  secondaryBtn: { minHeight: 48, borderRadius: 14, border: '1px solid #346AA8', background: '#112240', color: '#82B7DC', fontWeight: 700, cursor: 'pointer' },
  deviceDot: { width: 8, height: 8, borderRadius: 4, display: 'inline-block', flexShrink: 0 },
  noDeviceBadge: { fontSize: 9, color: '#555e6e', background: '#0d1a2e', padding: '2px 6px', borderRadius: 999, border: '1px solid #2a3a50', flexShrink: 0 },
};
