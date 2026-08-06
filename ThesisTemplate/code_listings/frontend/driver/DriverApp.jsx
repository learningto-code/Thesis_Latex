import { useState } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import DriverLogin from './DriverLogin';
import DriverNoTrip from './DriverNoTrip';
import DriverNav from './DriverNav';

export function getDriverSession() {
  try { return JSON.parse(sessionStorage.getItem('driver_session')); } catch { return null; }
}
export function setDriverSession(data) {
  sessionStorage.setItem('driver_session', JSON.stringify(data));
}
export function clearDriverSession() {
  sessionStorage.removeItem('driver_session');
  sessionStorage.removeItem('driver_route');
}

function DriverGuard({ children }) {
  const session = getDriverSession();
  if (!session?.user_id) return <Navigate to="/driver/login" replace />;
  return children;
}

export default function DriverApp() {
  const [session, setSession] = useState(getDriverSession());
  const navigate = useNavigate();

  function onLogin(data) {
    let session = data;
    if (data.active_trip) {
      const t = data.active_trip.trucks ?? {};
      session = {
        ...data,
        trip_id:      data.active_trip.id,
        truck_id:     data.active_trip.truck_id,
        driver_id:    data.active_trip.driver_id ?? data.user_id,
        truck_code:   t.truck_code ?? '',
        trip_channel: data.active_trip.channel_used ?? 'gsm',
        trip_status:  data.active_trip.trip_status ?? 'active',
        start_time:   data.active_trip.start_time ?? null,
        end_time:     data.active_trip.end_time ?? null,
        paused_at:    data.active_trip.paused_at ?? null,
        total_rest_seconds: data.active_trip.total_rest_seconds ?? 0,
        next_rest_alert_at: data.active_trip.next_rest_alert_at ?? null,
        snoozed_until: data.active_trip.snoozed_until ?? null,
        login_at:     new Date().toISOString(),
        truck_dims: {
          length:   t.length_m   ?? 12.0,
          width:    t.width_m    ?? 2.5,
          height:   t.height_m   ?? 4.0,
          weight:   t.weight_t   ?? 20.0,
          axleload: t.axleload_t ?? 11.5,
          hazmat:   t.hazmat     ?? false,
        },
      };
    }
    setDriverSession(session);
    setSession(session);
    if (data.active_trip) {
      navigate('/driver/trip');
    } else {
      navigate('/driver/notrip');
    }
  }

  function onLogout() {
    clearDriverSession();
    setSession(null);
    navigate('/driver/login');
  }

  return (
    <div style={styles.shell}>
      <Routes>
        <Route path="login" element={<DriverLogin onLogin={onLogin} />} />
        <Route path="notrip" element={
          <DriverGuard>
            <DriverNoTrip session={session} onLogout={onLogout} />
          </DriverGuard>
        } />
        <Route path="trip" element={
          <DriverGuard>
            <DriverNav session={session} onLogout={onLogout} />
          </DriverGuard>
        } />
        <Route path="map" element={
          <DriverGuard>
            <DriverNav session={session} onLogout={onLogout} />
          </DriverGuard>
        } />
        <Route path="*" element={<Navigate to="/driver/login" replace />} />
      </Routes>
    </div>
  );
}

const styles = {
  shell: {
    width: '100%',
    minWidth: 0,
    minHeight: '100dvh',
    background: '#001133',
    color: '#ffffff',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    position: 'relative',
    overflowX: 'hidden',
    overscrollBehavior: 'none',
  },
};
