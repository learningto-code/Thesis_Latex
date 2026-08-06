import { useState, useRef, useEffect } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { normalizeAlert } from '../utils/api';
import { format } from 'date-fns';
import {
  LayoutDashboard, Map, Truck, Bell, ScrollText,
  BarChart3, Route, Menu, X, LogOut, User, Settings, AlertTriangle,
} from 'lucide-react';

// Navigation items visible to ALL dashboard roles
const BASE_NAV = [
  { path: '/dashboard',  icon: LayoutDashboard, label: 'Dashboard' },
  { path: '/map',        icon: Map,              label: 'Live Map' },
  { path: '/trucks',     icon: Truck,            label: 'Trucks' },
  { path: '/alerts',     icon: Bell,             label: 'Alerts' },
  { path: '/logs',       icon: ScrollText,       label: 'Logs' },
  { path: '/analytics',  icon: BarChart3,        label: 'Analytics' },
  { path: '/trips',      icon: Route,            label: 'Trips' },
];

// Settings only for head_admin
const SETTINGS_NAV = { path: '/settings', icon: Settings, label: 'Settings' };

// Human-readable role labels
const ROLE_LABELS = {
  head_admin:    'Head Administrator',
  fleet_manager: 'Fleet Manager',
  manager:       'Manager',
  driver:        'Driver',
};

const SEEN_IDS_KEY = 'fleet_alerts_seen_ids';

function getSeenIds() {
  try {
    const arr = JSON.parse(localStorage.getItem(SEEN_IDS_KEY) ?? '[]');
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

export default function Layout({ user, setUser }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [bellOpen,    setBellOpen]    = useState(false);
  const [seenIds,     setSeenIds]     = useState(getSeenIds);
  const bellRef = useRef(null);
  const navigate = useNavigate();

  const { data: rawPreviewAlerts } = useApi('/alerts?resolved=false&active_only=true&limit=5', {
    transform: arr => arr.map(normalizeAlert),
    pollInterval: 15_000,
  });
  const previewAlerts = rawPreviewAlerts ?? [];

  const unseenCount = previewAlerts.filter(a => !seenIds.has(a.id)).length;

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!bellOpen) return;
    function handleClick(e) {
      if (bellRef.current && !bellRef.current.contains(e.target)) setBellOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [bellOpen]);

  function handleBellClick() {
    // Mark every visible alert as seen by recording its ID
    const updated = new Set(seenIds);
    previewAlerts.forEach(a => updated.add(a.id));
    // Cap stored IDs to the latest 200 to avoid unbounded localStorage growth
    const trimmed = new Set([...updated].slice(-200));
    setSeenIds(trimmed);
    localStorage.setItem(SEEN_IDS_KEY, JSON.stringify([...trimmed]));
    setBellOpen(v => !v);
  }

  function handleViewAll() {
    setBellOpen(false);
    navigate('/alerts');
  }

  // Build nav list - Settings only appears for head_admin
  const navItems = user?.role === 'head_admin'
    ? [...BASE_NAV, SETTINGS_NAV]
    : BASE_NAV;

  const handleLogout = () => {
    setUser(null);
    navigate('/login');
  };

  const NavList = ({ onClick }) => (
    <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
      {navItems.map((item) => (
        <NavLink
          key={item.path}
          to={item.path}
          onClick={onClick}
          className={({ isActive }) =>
            `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors text-sm ${
              isActive
                ? 'bg-blue-600 text-white'
                : 'text-slate-300 hover:bg-slate-800 hover:text-white'
            }`
          }
        >
          <item.icon className="w-5 h-5 flex-shrink-0" />
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );

  const UserFooter = () => (
    <div className="px-3 py-4 border-t border-slate-800">
      <div className="flex items-center gap-3 px-3 py-2 mb-1 min-w-0">
        <div className="flex items-center justify-center w-9 h-9 bg-slate-700 rounded-full flex-shrink-0">
          <User className="w-4 h-4 text-slate-300" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-white truncate">{user?.full_name ?? 'Admin User'}</p>
          <p className="text-xs text-slate-400 truncate">{ROLE_LABELS[user?.role] ?? user?.role}</p>
        </div>
      </div>
      <button
        onClick={handleLogout}
        className="flex items-center gap-2 w-full px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 hover:text-white rounded-lg transition-colors"
      >
        <LogOut className="w-4 h-4" />
        <span>Logout</span>
      </button>
    </div>
  );

  const Logo = () => (
    <div className="flex items-center gap-3 px-6 py-5 border-b border-slate-800">
      <div className="flex items-center justify-center w-10 h-10 bg-blue-600 rounded-lg flex-shrink-0">
        <Truck className="w-6 h-6 text-white" />
      </div>
      <div className="min-w-0">
        <h1 className="text-lg font-semibold text-white leading-tight">FleetMonitor</h1>
        <p className="text-xs text-slate-400">Admin Dashboard</p>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden">

      {}
      <aside className="hidden lg:flex lg:flex-col w-64 bg-slate-900 flex-shrink-0">
        <Logo />
        <NavList />
        <UserFooter />
      </aside>

      {}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {}
      <aside
        className={`fixed top-0 left-0 bottom-0 w-64 bg-slate-900 z-50 flex flex-col transform transition-transform duration-300 lg:hidden ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 bg-blue-600 rounded-lg">
              <Truck className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-white">FleetMonitor</h1>
              <p className="text-xs text-slate-400">Admin Dashboard</p>
            </div>
          </div>
          <button onClick={() => setSidebarOpen(false)} className="p-1 hover:bg-slate-800 rounded-lg">
            <X className="w-5 h-5 text-slate-300" />
          </button>
        </div>
        <NavList onClick={() => setSidebarOpen(false)} />
        <UserFooter />
      </aside>

      {}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {}
        <header className="bg-white border-b border-slate-200 px-4 lg:px-6 py-3 sm:py-4 flex-shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setSidebarOpen(true)}
                className="lg:hidden p-2 hover:bg-slate-100 rounded-lg"
              >
                <Menu className="w-5 h-5 text-slate-600" />
              </button>
              <h2 className="text-lg sm:text-xl font-semibold text-slate-900 truncate">
                Fleet Monitoring Dashboard
              </h2>
            </div>
            <div className="flex items-center gap-2 sm:gap-3">
              {}
              <div className="relative" ref={bellRef}>
                <button
                  onClick={handleBellClick}
                  className="relative p-2 hover:bg-slate-100 rounded-lg transition-colors"
                  title="Alerts"
                >
                  <Bell className={`w-5 h-5 ${unseenCount > 0 ? 'text-red-500' : 'text-slate-600'}`} />
                  {unseenCount > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1 animate-pulse">
                      {unseenCount > 99 ? '99+' : unseenCount}
                    </span>
                  )}
                </button>

                {}
                {bellOpen && (
                  <div className="absolute right-0 top-full mt-2 w-80 bg-white rounded-xl shadow-xl border border-slate-200 z-50 overflow-hidden">
                    <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                      <span className="text-sm font-semibold text-slate-900">Alerts</span>
                      <span className="text-xs text-slate-500">{previewAlerts.length} unresolved</span>
                    </div>

                    <div className="max-h-72 overflow-y-auto divide-y divide-slate-50">
                      {previewAlerts.length === 0 ? (
                        <p className="px-4 py-6 text-xs text-slate-400 text-center">No active alerts</p>
                      ) : previewAlerts.map(alert => (
                        <div key={alert.id} className="px-4 py-3 hover:bg-slate-50 transition-colors">
                          <div className="flex items-start gap-2.5">
                            <AlertTriangle className={`w-4 h-4 flex-shrink-0 mt-0.5 ${
                              alert.severity === 'high'   ? 'text-red-500' :
                              alert.severity === 'medium' ? 'text-orange-500' : 'text-yellow-500'
                            }`} />
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-medium text-slate-800 truncate">{alert.truckName}</p>
                              <p className="text-xs text-slate-500 line-clamp-2 mt-0.5">{alert.message}</p>
                              <p className="text-[11px] text-slate-400 mt-1">
                                {alert.timestamp ? format(new Date(alert.timestamp), 'MMM d, h:mm a') : ''}
                              </p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="px-4 py-2.5 border-t border-slate-100">
                      <button
                        onClick={handleViewAll}
                        className="w-full text-xs font-medium text-blue-600 hover:text-blue-800 transition-colors text-center py-1"
                      >
                        View all alerts ->
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <div className="hidden md:flex items-center gap-3 pl-3 border-l border-slate-200">
                <div className="flex items-center justify-center w-9 h-9 bg-slate-200 rounded-full">
                  <User className="w-5 h-5 text-slate-600" />
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-900">{user?.full_name ?? 'Admin'}</p>
                  <p className="text-xs text-slate-500">{ROLE_LABELS[user?.role] ?? user?.role}</p>
                </div>
                <button
                  onClick={handleLogout}
                  title="Logout"
                  className="ml-1 p-2 hover:bg-slate-100 rounded-lg transition-colors text-slate-500 hover:text-slate-700"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
              {}
              <button
                onClick={handleLogout}
                title="Logout"
                className="md:hidden p-2 hover:bg-slate-100 rounded-lg transition-colors text-slate-500"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-auto isolate">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
