import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Monitor, LogOut } from 'lucide-react';
import { fetchActiveTrip } from '../../utils/driverApi';
import { setDriverSession } from './DriverApp';

const POLL_MS = 5000;

export default function DriverNoTrip({ session, onLogout }) {
  const navigate = useNavigate();
  const timerRef = useRef(null);

  useEffect(() => {
    if (!session?.user_id) return;

    async function poll() {
      try {
        const data = await fetchActiveTrip(session.user_id);
        if (data.active_trip) {
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
        }
      } catch {
        // network error - keep polling
      }
    }

    poll();
    timerRef.current = setInterval(poll, POLL_MS);
    return () => clearInterval(timerRef.current);
  }, [session?.user_id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={styles.page}>
      <div style={styles.icon}><Monitor size={72} /></div>
      <h2 style={styles.title}>No Active Trip</h2>
      <p style={styles.name}>{session?.full_name ?? 'Driver'}</p>
      <p style={styles.msg}>
        Start a trip on the truck's HMI device.{'\n'}
        This screen will update automatically.
      </p>
      <div style={styles.pulseWrap}>
        <span style={styles.pulse} />
        <span style={styles.pulseLabel}>Waiting for HMI...</span>
      </div>
      <button style={styles.logoutBtn} onClick={onLogout}>
        <LogOut size={16} style={{ marginRight: 8 }} />
        Log Out
      </button>
    </div>
  );
}

const styles = {
  page: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', padding: '48px 24px', minHeight: '100dvh',
    background: '#0d1f3c', color: '#F7F7F7',
  },
  icon: { color: '#82B7DC', marginBottom: 20 },
  title: { margin: '0 0 6px', fontSize: 24, fontWeight: 700 },
  name: { margin: '0 0 20px', fontSize: 15, color: '#82B7DC', fontWeight: 600 },
  msg: {
    margin: '0 0 32px', fontSize: 14, color: '#9EB0C0',
    textAlign: 'center', lineHeight: 1.7, whiteSpace: 'pre-line',
  },
  pulseWrap: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 48 },
  pulse: {
    display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
    background: '#4CAF50',
    animation: 'pulse 1.4s ease-in-out infinite',
  },
  pulseLabel: { fontSize: 13, color: '#6B8CAE' },
  logoutBtn: {
    display: 'flex', alignItems: 'center',
    padding: '12px 32px', fontSize: 14, fontWeight: 700,
    borderRadius: 10, border: '1px solid #346AA8',
    background: 'transparent', color: '#82B7DC',
    cursor: 'pointer', touchAction: 'manipulation',
  },
};
