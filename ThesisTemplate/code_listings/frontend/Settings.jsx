import { useState, useEffect } from 'react';
import { Save, UserPlus, Trash2, Truck, Bell, CheckCircle, RefreshCw, AlertTriangle, Eye, EyeOff, Key, UserX, UserCheck, Pencil } from 'lucide-react';
import { apiFetch } from '../utils/api';
import { useApi } from '../hooks/useApi';

const tabs = [
  { id: 'thresholds', label: 'Alert Thresholds', icon: Bell },
  { id: 'users',      label: 'User Management',  icon: UserCheck },
  { id: 'fleet',      label: 'Fleet Settings',   icon: Truck },
];

const ROLE_LABELS = {
  head_admin:    'Head Admin',
  fleet_manager: 'Fleet Manager',
  manager:       'Manager',
  driver:        'Driver',
};

// ?? THRESHOLDS TAB ????????????????????????????????????????????
function ThresholdsTab() {
  const [saving,    setSaving]    = useState(false);
  const [savedOk,   setSavedOk]   = useState(false);
  const [saveError, setSaveError] = useState('');
  const [thresholds, setThresholds] = useState(null);

  const { data, loading, error, refetch } = useApi('/settings/thresholds');

  // Populate form once data loads
  useEffect(() => {
    if (data && !thresholds) {
      setThresholds({
        restHours:           String(data.rest_hours           ?? '6'),
        restDistance:        String(data.rest_distance_km     ?? '300'),
        maintenanceDistance: String(data.maintenance_km       ?? '5000'),
        overspeedKmh:        String(data.overspeed_kmh        ?? '100'),
      });
    }
  }, [data, thresholds]);

  const handleChange = (field) => (e) => {
    setThresholds(prev => ({ ...prev, [field]: e.target.value }));
    setSavedOk(false);
    setSaveError('');
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setSaveError('');
    try {
      await apiFetch('/settings/thresholds', {
        method: 'PUT',
        body: JSON.stringify({
          rest_hours:        Number(thresholds.restHours),
          rest_distance_km:  Number(thresholds.restDistance),
          maintenance_km:    Number(thresholds.maintenanceDistance),
          overspeed_kmh:     Number(thresholds.overspeedKmh),
        }),
      });
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 3000);
      refetch();
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading || !thresholds) return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6">
      <p className="text-sm text-slate-400">{error ?? 'Loading thresholds...'}</p>
    </div>
  );

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6">
      <div className="mb-6">
        <h2 className="text-base font-semibold text-slate-900 mb-1">Alert Thresholds</h2>
        <p className="text-sm text-slate-500">
          Fine-tune when rest alerts, maintenance reminders, and overspeed warnings trigger.
        </p>
      </div>

      <form onSubmit={handleSave} className="space-y-5">
        {[
          { field: 'restHours',           label: 'Rest Alert - Hours (h)',          min: 0.01, step: 0.01, max: 24, hint: 'Continuous driving before alert (e.g. 0.25 = 15 min, 4 = 4 hrs)' },
          { field: 'restDistance',        label: 'Rest Alert - Distance (km)',      min: 1,    step: 1,              hint: 'Alert driver after this many kilometres without rest' },
          { field: 'maintenanceDistance', label: 'Maintenance Alert - Distance (km)', min: 1,  step: 1,              hint: 'Trigger maintenance reminder after this cumulative distance' },
          { field: 'overspeedKmh',        label: 'Overspeed Alert (km/h)',          min: 1,    step: 1,              hint: 'Flag speed readings above this limit' },
        ].map(({ field, label, min, step, max, hint }) => (
          <div key={field}>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">{label}</label>
            <div className="flex items-center gap-3">
              <input
                type="number" min={min} step={step} max={max}
                value={thresholds[field]}
                onChange={handleChange(field)}
                className="w-32 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <span className="text-xs text-slate-400">{hint}</span>
            </div>
          </div>
        ))}

        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800">
          <p className="font-medium mb-1">Default thesis values</p>
          <p>Rest: <strong>6 h / 300 km</strong> . Maintenance: <strong>5,000 km</strong></p>
        </div>

        {saveError && (
          <div className="flex items-center gap-2 text-sm text-red-600">
            <AlertTriangle className="w-4 h-4" />
            {saveError}
          </div>
        )}

        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={saving}
            className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {saving ? 'Saving...' : 'Save Thresholds'}
          </button>
          {savedOk && (
            <div className="flex items-center gap-1.5 text-green-600 text-sm font-medium">
              <CheckCircle className="w-4 h-4" />
              Saved successfully
            </div>
          )}
        </div>
      </form>
    </div>
  );
}

// Role badge styling
const ROLE_BADGE = {
  head_admin:    'bg-purple-100 text-purple-700',
  fleet_manager: 'bg-blue-100 text-blue-700',
  manager:       'bg-indigo-100 text-indigo-700',
  driver:        'bg-green-100 text-green-700',
};

// ?? USERS TAB ?????????????????????????????????????????????????
function UsersTab() {
  // ?? Dashboard users state ????????????????????????????????????
  const EMPTY_USER_FORM = { full_name: '', username: '', password: '', role: 'fleet_manager' };
  const [showAddUser,  setShowAddUser]  = useState(false);
  const [userAddError, setUserAddError] = useState('');
  const [userForm,     setUserForm]     = useState(EMPTY_USER_FORM);
  const [showUserPw,   setShowUserPw]   = useState(false);
  const [deletingUser, setDeletingUser] = useState(null);
  const [togglingUser, setTogglingUser] = useState(null);
  // changePw: { id, value, show, saving, error } | null
  const [changePw, setChangePw] = useState(null);

  const { data: users, loading: usersLoading, error: usersError, refetch: refetchUsers } = useApi('/settings/users');

  // ?? Driver accounts state ????????????????????????????????????
  const EMPTY_DRV_FORM = { full_name: '', pin: '' };
  const [showAddDrv,  setShowAddDrv]  = useState(false);
  const [drvAddError, setDrvAddError] = useState('');
  const [drvForm,     setDrvForm]     = useState(EMPTY_DRV_FORM);
  const [showDrvPin,  setShowDrvPin]  = useState(false);
  const [deletingDrv, setDeletingDrv] = useState(null);
  const [togglingDrv, setTogglingDrv] = useState(null);
  // resetPin: { id, value, show, saving, error } | null
  const [resetPin, setResetPin] = useState(null);

  const { data: drivers, loading: drvsLoading, error: drvsError, refetch: refetchDrvs } = useApi('/settings/drivers');

  // ?? Dashboard user handlers ??????????????????????????????????
  const handleDeleteUser = async (id) => {
    if (!window.confirm('Remove this account? This cannot be undone.')) return;
    setDeletingUser(id);
    try {
      await apiFetch(`/settings/users/${id}`, { method: 'DELETE' });
      refetchUsers();
    } catch (err) { alert(err.message); }
    finally { setDeletingUser(null); }
  };

  const handleToggleUser = async (user) => {
    setTogglingUser(user.id);
    try {
      await apiFetch(`/settings/users/${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: !user.is_active }),
      });
      refetchUsers();
    } catch (err) { alert(err.message); }
    finally { setTogglingUser(null); }
  };

  const handleAddUser = async (e) => {
    e.preventDefault();
    setUserAddError('');
    try {
      await apiFetch('/settings/users', { method: 'POST', body: JSON.stringify(userForm) });
      setShowAddUser(false);
      setUserForm(EMPTY_USER_FORM);
      setShowUserPw(false);
      refetchUsers();
    } catch (err) { setUserAddError(err.message); }
  };

  const handleChangePw = async (id) => {
    if (!changePw?.value || changePw.value.length < 6) {
      setChangePw(r => ({ ...r, error: 'Password must be at least 6 characters.' }));
      return;
    }
    setChangePw(r => ({ ...r, saving: true, error: '' }));
    try {
      await apiFetch(`/settings/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ password: changePw.value }),
      });
      setChangePw(null);
      refetchUsers();
    } catch (err) {
      setChangePw(r => ({ ...r, saving: false, error: err.message }));
    }
  };

  // ?? Driver handlers ??????????????????????????????????????????
  const handleDeleteDrv = async (id) => {
    if (!window.confirm('Remove this driver account? This cannot be undone.')) return;
    setDeletingDrv(id);
    try {
      await apiFetch(`/settings/drivers/${id}`, { method: 'DELETE' });
      refetchDrvs();
    } catch (err) { alert(err.message); }
    finally { setDeletingDrv(null); }
  };

  const handleToggleDrv = async (drv) => {
    setTogglingDrv(drv.id);
    try {
      await apiFetch(`/settings/drivers/${drv.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: !drv.is_active }),
      });
      refetchDrvs();
    } catch (err) { alert(err.message); }
    finally { setTogglingDrv(null); }
  };

  const handleAddDrv = async (e) => {
    e.preventDefault();
    setDrvAddError('');
    try {
      await apiFetch('/settings/drivers', { method: 'POST', body: JSON.stringify(drvForm) });
      setShowAddDrv(false);
      setDrvForm(EMPTY_DRV_FORM);
      setShowDrvPin(false);
      refetchDrvs();
    } catch (err) { setDrvAddError(err.message); }
  };

  const handleResetPin = async (id) => {
    if (!resetPin?.value || !/^\d{4}$/.test(resetPin.value)) {
      setResetPin(r => ({ ...r, error: 'PIN must be exactly 4 digits.' }));
      return;
    }
    setResetPin(r => ({ ...r, saving: true, error: '' }));
    try {
      await apiFetch(`/settings/drivers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ pin: resetPin.value }),
      });
      setResetPin(null);
      refetchDrvs();
    } catch (err) {
      setResetPin(r => ({ ...r, saving: false, error: err.message }));
    }
  };

  // ?? Row components ???????????????????????????????????????????
  const AdminRow = ({ user }) => {
    const isChangingPw = changePw?.id === user.id;
    return (
      <div className={`rounded-xl border ${user.is_active ? 'bg-slate-50 border-slate-200' : 'bg-slate-100 border-slate-200 opacity-60'}`}>
        <div className="flex items-center justify-between p-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0">
              <span className="text-sm font-semibold text-blue-600">{user.full_name.charAt(0).toUpperCase()}</span>
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-medium text-slate-900">{user.full_name}</p>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${ROLE_BADGE[user.role] ?? 'bg-slate-100 text-slate-600'}`}>
                  {ROLE_LABELS[user.role] ?? user.role}
                </span>
                {!user.is_active && <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-600">Deactivated</span>}
              </div>
              <p className="text-xs text-slate-500 mt-0.5">@{user.username}</p>
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0 ml-2">
            {}
            <button
              onClick={() => setChangePw(isChangingPw ? null : { id: user.id, value: '', show: false, saving: false, error: '' })}
              title="Change Password"
              className={`p-2 rounded-lg transition-colors text-slate-400 hover:text-blue-500 hover:bg-blue-50 ${isChangingPw ? 'bg-blue-50 text-blue-500' : ''}`}>
              <Key className="w-4 h-4" />
            </button>
            {}
            <button onClick={() => handleToggleUser(user)}
              disabled={togglingUser === user.id || user.role === 'head_admin'}
              title={user.is_active ? 'Deactivate' : 'Reactivate'}
              className="p-2 text-slate-400 hover:text-amber-500 hover:bg-amber-50 rounded-lg transition-colors disabled:opacity-40">
              {togglingUser === user.id
                ? <RefreshCw className="w-4 h-4 animate-spin" />
                : user.is_active ? <UserX className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
            </button>
            {}
            <button onClick={() => handleDeleteUser(user.id)}
              disabled={deletingUser === user.id || user.role === 'head_admin'}
              title="Delete account"
              className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-40">
              {deletingUser === user.id ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            </button>
          </div>
        </div>
        {isChangingPw && (
          <div className="px-4 pb-4 border-t border-slate-200 pt-3">
            <p className="text-xs text-slate-500 mb-2">
              Passwords are hashed (bcrypt) and cannot be viewed - enter a new password to replace it.
            </p>
            {changePw.error && <p className="text-xs text-red-600 mb-2">{changePw.error}</p>}
            <div className="flex items-center gap-2">
              <div className="relative">
                <input
                  type={changePw.show ? 'text' : 'password'}
                  placeholder="New password (min 6 chars)"
                  value={changePw.value}
                  onChange={e => setChangePw(r => ({ ...r, value: e.target.value, error: '' }))}
                  className="w-52 px-3 py-1.5 pr-8 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button type="button" onClick={() => setChangePw(r => ({ ...r, show: !r.show }))}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                  {changePw.show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
              <button onClick={() => handleChangePw(user.id)}
                disabled={changePw.saving}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-xs font-medium rounded-lg transition-colors">
                {changePw.saving ? 'Saving...' : 'Save Password'}
              </button>
              <button onClick={() => setChangePw(null)}
                className="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs font-medium rounded-lg transition-colors">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  const DriverRow = ({ drv }) => {
    const isResetting = resetPin?.id === drv.id;
    return (
      <div className={`rounded-xl border ${drv.is_active ? 'bg-slate-50 border-slate-200' : 'bg-slate-100 border-slate-200 opacity-60'}`}>
        <div className="flex items-center justify-between p-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0">
              <span className="text-sm font-semibold text-green-600">{drv.full_name.charAt(0).toUpperCase()}</span>
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-medium text-slate-900">{drv.full_name}</p>
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">Driver</span>
                {!drv.is_active && <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-600">Deactivated</span>}
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                PIN login . truck device only
                {drv.pin && (
                  <span className="ml-2 font-mono bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded text-xs" title="Current PIN (visible to head admin)">
                    PIN: {drv.pin}
                  </span>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0 ml-2">
            {}
            <button onClick={() => setResetPin(isResetting ? null : { id: drv.id, value: '', show: false, saving: false, error: '' })}
              title="Reset PIN"
              className={`p-2 rounded-lg transition-colors text-slate-400 hover:text-blue-500 hover:bg-blue-50 ${isResetting ? 'bg-blue-50 text-blue-500' : ''}`}>
              <Key className="w-4 h-4" />
            </button>
            {}
            <button onClick={() => handleToggleDrv(drv)}
              disabled={togglingDrv === drv.id}
              title={drv.is_active ? 'Deactivate' : 'Reactivate'}
              className="p-2 text-slate-400 hover:text-amber-500 hover:bg-amber-50 rounded-lg transition-colors disabled:opacity-40">
              {togglingDrv === drv.id
                ? <RefreshCw className="w-4 h-4 animate-spin" />
                : drv.is_active ? <UserX className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
            </button>
            {}
            <button onClick={() => handleDeleteDrv(drv.id)}
              disabled={deletingDrv === drv.id}
              title="Delete driver"
              className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-40">
              {deletingDrv === drv.id ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            </button>
          </div>
        </div>
        {isResetting && (
          <div className="px-4 pb-4 border-t border-slate-200 pt-3">
            <p className="text-xs text-slate-500 mb-2">
              Enter a new 4-digit PIN. Must be unique across all drivers.
              {drv.pin && <span className="ml-1">Current PIN: <span className="font-mono font-semibold">{drv.pin}</span></span>}
            </p>
            {resetPin.error && <p className="text-xs text-red-600 mb-2">{resetPin.error}</p>}
            <div className="flex items-center gap-2">
              <div className="relative">
                <input
                  type={resetPin.show ? 'text' : 'password'}
                  inputMode="numeric"
                  maxLength={4}
                  placeholder="New PIN"
                  value={resetPin.value}
                  onChange={e => {
                    const v = e.target.value.replace(/\D/g, '').slice(0, 4);
                    setResetPin(r => ({ ...r, value: v, error: '' }));
                  }}
                  className="w-28 px-3 py-1.5 pr-8 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 tracking-widest"
                />
                <button type="button" onClick={() => setResetPin(r => ({ ...r, show: !r.show }))}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                  {resetPin.show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
              <button onClick={() => handleResetPin(drv.id)}
                disabled={resetPin.saving}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-xs font-medium rounded-lg transition-colors">
                {resetPin.saving ? 'Saving...' : 'Save PIN'}
              </button>
              <button onClick={() => setResetPin(null)}
                className="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs font-medium rounded-lg transition-colors">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6">
        <div className="mb-4">
          <h2 className="text-base font-semibold text-slate-900 mb-1">Dashboard Users</h2>
          <p className="text-sm text-slate-500">Accounts that can access this dashboard (fleet managers, managers).</p>
        </div>

        {usersError && <p className="text-sm text-red-600 mb-4">{usersError}</p>}

        <div className="space-y-3 mb-4">
          {usersLoading ? (
            <p className="text-sm text-slate-400">Loading users...</p>
          ) : (users ?? []).length === 0 ? (
            <p className="text-sm text-slate-400">No dashboard users found</p>
          ) : (users ?? []).map(u => <AdminRow key={u.id} user={u} />)}
        </div>

        {showAddUser ? (
          <form onSubmit={handleAddUser} className="bg-slate-50 rounded-xl p-4 space-y-3">
            <p className="text-sm font-medium text-slate-900">New Dashboard Account</p>
            {userAddError && <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{userAddError}</p>}
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Role</label>
              <select value={userForm.role} onChange={e => setUserForm(f => ({ ...f, role: e.target.value }))}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="fleet_manager">Fleet Manager</option>
                <option value="manager">Manager</option>
              </select>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Full Name</label>
                <input required placeholder="e.g. Maria Santos" value={userForm.full_name}
                  onChange={e => setUserForm(f => ({ ...f, full_name: e.target.value }))}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Username</label>
                <input required placeholder="e.g. msantos" value={userForm.username}
                  onChange={e => setUserForm(f => ({ ...f, username: e.target.value }))}
                  autoCapitalize="none"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-600 mb-1">Password</label>
                <div className="relative">
                  <input required type={showUserPw ? 'text' : 'password'} placeholder="Set a password"
                    value={userForm.password}
                    onChange={e => setUserForm(f => ({ ...f, password: e.target.value }))}
                    className="w-full px-3 py-2 pr-10 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <button type="button" onClick={() => setShowUserPw(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                    {showUserPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button type="submit" className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors">
                Add Account
              </button>
              <button type="button" onClick={() => { setShowAddUser(false); setUserAddError(''); setUserForm(EMPTY_USER_FORM); setShowUserPw(false); }}
                className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 text-sm font-medium rounded-lg transition-colors">
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button onClick={() => setShowAddUser(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors">
            <UserPlus className="w-4 h-4" />
            Add Dashboard User
          </button>
        )}
      </div>

      {}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6">
        <div className="mb-4">
          <h2 className="text-base font-semibold text-slate-900 mb-1">Driver Accounts</h2>
          <p className="text-sm text-slate-500">
            Drivers log in on the truck device using their name + 4-digit PIN.
            They cannot access this dashboard.
          </p>
        </div>

        {drvsError && <p className="text-sm text-red-600 mb-4">{drvsError}</p>}

        <div className="space-y-3 mb-4">
          {drvsLoading ? (
            <p className="text-sm text-slate-400">Loading drivers...</p>
          ) : (drivers ?? []).length === 0 ? (
            <p className="text-sm text-slate-400">No driver accounts yet</p>
          ) : (drivers ?? []).map(d => <DriverRow key={d.id} drv={d} />)}
        </div>

        {showAddDrv ? (
          <form onSubmit={handleAddDrv} className="bg-slate-50 rounded-xl p-4 space-y-3">
            <p className="text-sm font-medium text-slate-900">New Driver Account</p>
            {drvAddError && <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{drvAddError}</p>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Full Name</label>
                <input required placeholder="e.g. Juan Dela Cruz" value={drvForm.full_name}
                  onChange={e => setDrvForm(f => ({ ...f, full_name: e.target.value }))}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">4-Digit PIN</label>
                <div className="relative">
                  <input required type={showDrvPin ? 'text' : 'password'}
                    inputMode="numeric" placeholder="e.g. 1234"
                    value={drvForm.pin} maxLength={4}
                    onChange={e => {
                      const v = e.target.value.replace(/\D/g, '').slice(0, 4);
                      setDrvForm(f => ({ ...f, pin: v }));
                    }}
                    className="w-full px-3 py-2 pr-10 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 tracking-widest" />
                  <button type="button" onClick={() => setShowDrvPin(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                    {showDrvPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-xs text-slate-400 mt-1">Numeric only . exactly 4 digits</p>
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button type="submit" className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors">
                Add Driver
              </button>
              <button type="button" onClick={() => { setShowAddDrv(false); setDrvAddError(''); setDrvForm(EMPTY_DRV_FORM); setShowDrvPin(false); }}
                className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 text-sm font-medium rounded-lg transition-colors">
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button onClick={() => setShowAddDrv(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors">
            <UserPlus className="w-4 h-4" />
            Add Driver
          </button>
        )}
      </div>
    </div>
  );
}

// ?? FLEET TAB ?????????????????????????????????????????????????
const EMPTY_TRUCK_FORM = {
  truck_code: '', plate_number: '', model: '',
  length_m: '12.0', width_m: '2.5', height_m: '4.0',
  weight_t: '20.0', axleload_t: '11.5', hazmat: false,
  tank_capacity_l: '80.0',
  current_odometer_km: '0',
};

function DimFields({ form, setForm }) {
  const f = (key) => (e) => setForm(p => ({ ...p, [key]: e.target.value }));
  const inp = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide pt-1">
        Truck Dimensions - used for route planning
      </p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-slate-500 mb-1">Length (m)</label>
          <input type="number" step="0.1" min="1" max="25" value={form.length_m}
            onChange={f('length_m')} className={inp} placeholder="12.0" />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Width (m)</label>
          <input type="number" step="0.1" min="1" max="5" value={form.width_m}
            onChange={f('width_m')} className={inp} placeholder="2.5" />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Height (m)</label>
          <input type="number" step="0.1" min="1" max="6" value={form.height_m}
            onChange={f('height_m')} className={inp} placeholder="4.0" />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Gross weight (t)</label>
          <input type="number" step="0.5" min="1" max="100" value={form.weight_t}
            onChange={f('weight_t')} className={inp} placeholder="20.0" />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Axle load (t)</label>
          <input type="number" step="0.5" min="1" max="30" value={form.axleload_t}
            onChange={f('axleload_t')} className={inp} placeholder="11.5" />
        </div>
        <div className="flex items-end pb-1">
          <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input type="checkbox" checked={form.hazmat}
              onChange={e => setForm(p => ({ ...p, hazmat: e.target.checked }))}
              className="w-4 h-4 rounded text-blue-600" />
            Hazardous materials
          </label>
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-slate-500 mb-1">
            Fuel tank capacity (L) - calibrated per vehicle, used for fuel % math
          </label>
          <input type="number" step="0.5" min="20" max="500" value={form.tank_capacity_l}
            onChange={f('tank_capacity_l')} className={inp} placeholder="80.0" />
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-slate-500 mb-1">
            Current mileage (km) - lifetime odometer; each completed trip adds its distance to this value
          </label>
          <input type="number" step="1" min="0" max="9999999" value={form.current_odometer_km}
            onChange={f('current_odometer_km')} className={inp} placeholder="0" />
        </div>
      </div>
    </div>
  );
}

function FleetTab() {
  const [showAdd,   setShowAdd]   = useState(false);
  const [editId,    setEditId]    = useState(null);
  const [deleting,  setDeleting]  = useState(null);
  const [saving,    setSaving]    = useState(false);
  const [addError,  setAddError]  = useState('');
  const [editError, setEditError] = useState('');
  const [addForm,   setAddForm]   = useState(EMPTY_TRUCK_FORM);
  const [editForm,  setEditForm]  = useState(EMPTY_TRUCK_FORM);

  const { data: trucks, loading, error, refetch } = useApi('/trucks');

  function openEdit(truck) {
    setEditId(truck.id);
    setEditForm({
      truck_code:  truck.truck_code  ?? '',
      plate_number: truck.plate_number ?? '',
      model:       truck.model       ?? '',
      length_m:    String(truck.length_m   ?? 12.0),
      width_m:     String(truck.width_m    ?? 2.5),
      height_m:    String(truck.height_m   ?? 4.0),
      weight_t:    String(truck.weight_t   ?? 20.0),
      axleload_t:  String(truck.axleload_t ?? 11.5),
      hazmat:      truck.hazmat ?? false,
      tank_capacity_l: String(truck.tank_capacity_l ?? 80.0),
      current_odometer_km: String(truck.current_odometer_km ?? 0),
    });
    setEditError('');
  }

  function closeEdit() { setEditId(null); setEditError(''); }

  const handleAdd = async (e) => {
    e.preventDefault();
    setAddError('');
    try {
      await apiFetch('/trucks', {
        method: 'POST',
        body: JSON.stringify({
          ...addForm,
          length_m:   parseFloat(addForm.length_m),
          width_m:    parseFloat(addForm.width_m),
          height_m:   parseFloat(addForm.height_m),
          weight_t:   parseFloat(addForm.weight_t),
          axleload_t: parseFloat(addForm.axleload_t),
          tank_capacity_l: parseFloat(addForm.tank_capacity_l),
          current_odometer_km: parseFloat(addForm.current_odometer_km) || 0,
        }),
      });
      setShowAdd(false);
      setAddForm(EMPTY_TRUCK_FORM);
      refetch();
    } catch (err) { setAddError(err.message); }
  };

  const handleEdit = async (e) => {
    e.preventDefault();
    setEditError(''); setSaving(true);
    try {
      await apiFetch(`/trucks/${editId}`, {
        method: 'PUT',
        body: JSON.stringify({
          ...editForm,
          length_m:   parseFloat(editForm.length_m),
          width_m:    parseFloat(editForm.width_m),
          height_m:   parseFloat(editForm.height_m),
          weight_t:   parseFloat(editForm.weight_t),
          axleload_t: parseFloat(editForm.axleload_t),
          tank_capacity_l: parseFloat(editForm.tank_capacity_l),
          current_odometer_km: parseFloat(editForm.current_odometer_km) || 0,
        }),
      });
      closeEdit();
      refetch();
    } catch (err) { setEditError(err.message); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Remove this truck from the fleet?')) return;
    setDeleting(id);
    try {
      await apiFetch(`/trucks/${id}`, { method: 'DELETE' });
      refetch();
    } catch (err) { alert(err.message); }
    finally { setDeleting(null); }
  };

  const inp = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6">
      <div className="mb-6">
        <h2 className="text-base font-semibold text-slate-900 mb-1">Fleet Settings</h2>
        <p className="text-sm text-slate-500">
          Add or remove trucks and configure dimensions used for truck route planning.
        </p>
      </div>

      {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

      <div className="space-y-3 mb-6">
        {loading ? (
          <p className="text-sm text-slate-400">Loading trucks...</p>
        ) : (trucks ?? []).length === 0 ? (
          <p className="text-sm text-slate-400">No trucks in fleet</p>
        ) : (trucks ?? []).map(truck => (
          <div key={truck.id}>
            <div className="flex items-center justify-between p-4 bg-slate-50 rounded-xl">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 bg-slate-200 rounded-full flex items-center justify-center">
                  <Truck className="w-4 h-4 text-slate-600" />
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-900">
                    {truck.model ?? truck.truck_code}
                  </p>
                  <p className="text-xs text-slate-500">
                    {truck.truck_code} . {truck.plate_number}
                    {truck.driver && <span> . {truck.driver.full_name}</span>}
                  </p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {truck.length_m ?? 12}m . ?{truck.height_m ?? 4}m . ?{truck.weight_t ?? 20}t
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => editId === truck.id ? closeEdit() : openEdit(truck)}
                  className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                  title="Edit dimensions"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handleDelete(truck.id)}
                  disabled={deleting === truck.id}
                  className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-40"
                >
                  {deleting === truck.id
                    ? <RefreshCw className="w-4 h-4 animate-spin" />
                    : <Trash2 className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {}
            {editId === truck.id && (
              <form onSubmit={handleEdit}
                className="mt-1 bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
                <p className="text-sm font-semibold text-blue-900">Edit - {truck.truck_code}</p>
                {editError && <p className="text-xs text-red-600">{editError}</p>}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Truck code</label>
                    <input required value={editForm.truck_code}
                      onChange={e => setEditForm(f => ({ ...f, truck_code: e.target.value }))}
                      className={inp} />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Plate number</label>
                    <input required value={editForm.plate_number}
                      onChange={e => setEditForm(f => ({ ...f, plate_number: e.target.value }))}
                      className={inp} />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Model</label>
                  <input value={editForm.model}
                    onChange={e => setEditForm(f => ({ ...f, model: e.target.value }))}
                    className={inp} placeholder="Model (optional)" />
                </div>
                <DimFields form={editForm} setForm={setEditForm} />
                <div className="flex gap-2 pt-1">
                  <button type="submit" disabled={saving}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50">
                    {saving ? 'Saving...' : 'Save Changes'}
                  </button>
                  <button type="button" onClick={closeEdit}
                    className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 text-sm font-medium rounded-lg transition-colors">
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        ))}
      </div>

      {showAdd ? (
        <form onSubmit={handleAdd} className="bg-slate-50 rounded-xl p-4 space-y-3">
          <p className="text-sm font-semibold text-slate-900">New Truck</p>
          {addError && <p className="text-xs text-red-600">{addError}</p>}
          <input required placeholder="Truck code (e.g. TRK-005)" value={addForm.truck_code}
            onChange={e => setAddForm(f => ({ ...f, truck_code: e.target.value }))}
            className={inp} />
          <input required placeholder="Plate number" value={addForm.plate_number}
            onChange={e => setAddForm(f => ({ ...f, plate_number: e.target.value }))}
            className={inp} />
          <input placeholder="Model (optional)" value={addForm.model}
            onChange={e => setAddForm(f => ({ ...f, model: e.target.value }))}
            className={inp} />
          <DimFields form={addForm} setForm={setAddForm} />
          <div className="flex gap-2 pt-1">
            <button type="submit"
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors">
              Add Truck
            </button>
            <button type="button" onClick={() => { setShowAdd(false); setAddError(''); setAddForm(EMPTY_TRUCK_FORM); }}
              className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 text-sm font-medium rounded-lg transition-colors">
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button onClick={() => { setShowAdd(true); closeEdit(); }}
          className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors">
          <Truck className="w-4 h-4" />
          Add Truck
        </button>
      )}
    </div>
  );
}

// ?? MAIN SETTINGS ?????????????????????????????????????????????
export default function Settings() {
  const [activeTab, setActiveTab] = useState('thresholds');

  return (
    <div className="p-4 lg:p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl sm:text-2xl font-semibold text-slate-900 mb-1">Settings</h1>
        <p className="text-sm text-slate-500">Configure fleet thresholds, users, and preferences</p>
      </div>

      {}
      <div className="flex gap-1 bg-slate-100 p-1 rounded-xl mb-6 w-fit">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === tab.id
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <tab.icon className="w-4 h-4" />
            <span className="hidden sm:inline">{tab.label}</span>
          </button>
        ))}
      </div>

      {activeTab === 'thresholds' && <ThresholdsTab />}
      {activeTab === 'users'      && <UsersTab />}
      {activeTab === 'fleet'      && <FleetTab />}
    </div>
  );
}
