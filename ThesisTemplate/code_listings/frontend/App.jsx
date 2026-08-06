import { BrowserRouter as Router, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { useState } from 'react';

import Layout      from './components/Layout';
import LoginSignUp from './components/LoginSignUp';
import Dashboard   from './components/Dashboard';
import MapView     from './components/MapView';
import Trucks      from './components/Trucks';
import Alerts      from './components/Alerts';
import Logs        from './components/Logs';
import Analytics   from './components/Analytics';
import Trips       from './components/Trips';
import Settings    from './components/Settings';
import DriverApp   from './components/driver/DriverApp';

// Roles that can access the admin dashboard
const DASHBOARD_ROLES = ['head_admin', 'fleet_manager', 'manager'];

// ?? Guard: must be logged in AND have a dashboard role ????????
function ProtectedLayout({ user, setUser }) {
  if (!user) return <Navigate to="/login" replace />;
  if (!DASHBOARD_ROLES.includes(user.role)) return <Navigate to="/login" replace />;
  return <Layout user={user} setUser={setUser} />;
}

// ?? Guard: Settings tab - head_admin only ?????????????????????
function HeadAdminRoute({ user }) {
  if (!user || user.role !== 'head_admin') return <Navigate to="/dashboard" replace />;
  return <Outlet />;
}

export default function App() {
  // Persist user across page refreshes via localStorage
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('fleet_user')) || null; }
    catch { return null; }
  });

  const handleSetUser = (u) => {
    if (u) localStorage.setItem('fleet_user', JSON.stringify(u));
    else    localStorage.removeItem('fleet_user');
    setUser(u);
  };

  return (
    <Router>
      <Routes>
        {}
        <Route path="/driver/*" element={<DriverApp />} />

        {}
        <Route path="/login" element={<LoginSignUp user={user} setUser={handleSetUser} />} />

        <Route element={<ProtectedLayout user={user} setUser={handleSetUser} />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/map"       element={<MapView />} />
          <Route path="/trucks"    element={<Trucks />} />
          <Route path="/alerts"    element={<Alerts />} />
          <Route path="/logs"      element={<Logs />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/trips"     element={<Trips />} />

          {}
          <Route element={<HeadAdminRoute user={user} />}>
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </Router>
  );
}
