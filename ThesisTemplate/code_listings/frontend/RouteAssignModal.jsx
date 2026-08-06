import { useEffect, useMemo, useState } from 'react';
import { MapContainer, Marker, Polyline, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import { Loader2, MapPin, Navigation, Search, X } from 'lucide-react';
import { apiFetch, normalizeTruckDims } from '../utils/api';
import 'leaflet/dist/leaflet.css';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const ORS_KEY = import.meta.env.VITE_ORS_KEY ?? '';
const ORS_AUTOCOMPLETE = 'https://api.openrouteservice.org/geocode/autocomplete';
const ORS_ROUTE = 'https://api.openrouteservice.org/v2/directions/driving-hgv/geojson';
const OSRM_ROUTE = 'https://router.project-osrm.org/route/v1/driving';
const NOM = 'https://nominatim.openstreetmap.org/search';
const PH_BBOX = '116.87,4.59,126.60,21.12';

function FitRoute({ points }) {
  const map = useMap();
  useEffect(() => {
    setTimeout(() => map.invalidateSize(), 80);
    if (points.length > 1) map.fitBounds(L.latLngBounds(points), { padding: [36, 36], maxZoom: 16 });
  }, [map, points]);
  return null;
}

function hasUsableOrsKey() {
  return ORS_KEY && !/your_ors_api_key_here/i.test(ORS_KEY);
}

async function readError(res, provider) {
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {  }
  if (res.status === 401 || res.status === 403) return `${provider} API key rejected`;
  if (res.status === 429) return `${provider} rate limit reached`;
  return data?.error?.message || data?.message || text || `${provider} request failed`;
}

function normalizeStep(step) {
  return {
    instruction: step.instruction ?? 'Continue',
    name: step.name ?? '',
    distance: Math.round(step.distance ?? 0),
    duration: Math.round(step.duration ?? 0),
    type: step.type ?? 6,
    way_points: step.way_points ?? null,
  };
}

export default function RouteAssignModal({ truck, onClose, onAssigned }) {
  const dims = useMemo(() => normalizeTruckDims(truck?.dims ?? truck), [truck]);
  const origin = truck?.position ? [truck.position[1], truck.position[0]] : null; // [lon, lat]
  const [query, setQuery] = useState(truck?.assignedDestination ?? '');
  const [suggestions, setSuggestions] = useState([]);
  const [selected, setSelected] = useState(null);
  const [route, setRoute] = useState(null);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!query.trim() || query.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    const id = setTimeout(async () => {
      setSearching(true);
      setError('');
      try {
        let hits = [];
        if (hasUsableOrsKey()) {
          const focus = truck?.position ? `&focus.point.lat=${truck.position[0]}&focus.point.lon=${truck.position[1]}` : '';
          const url = `${ORS_AUTOCOMPLETE}?api_key=${encodeURIComponent(ORS_KEY)}&text=${encodeURIComponent(query)}&boundary.country=PH${focus}&size=6`;
          const res = await fetch(url, { headers: { Accept: 'application/json' } });
          if (!res.ok) throw new Error(await readError(res, 'ORS search'));
          const data = await res.json();
          hits = (data.features ?? []).map(f => ({
            label: f.properties.label ?? f.properties.name,
            name: f.properties.name ?? f.properties.label,
            locality: [f.properties.locality, f.properties.region, f.properties.country].filter(Boolean).join(', '),
            lon: f.geometry.coordinates[0],
            lat: f.geometry.coordinates[1],
          }));
        }
        if (!hits.length) {
          const url = `${NOM}?q=${encodeURIComponent(query)}&format=json&addressdetails=1&limit=6&countrycodes=ph&bounded=1&viewbox=${PH_BBOX}`;
          const res = await fetch(url, { headers: { Accept: 'application/json' } });
          if (!res.ok) throw new Error(await readError(res, 'Nominatim search'));
          const data = await res.json();
          hits = (data ?? []).map(f => ({
            label: f.display_name,
            name: f.name || f.display_name?.split(',')[0] || query,
            locality: [f.address?.city || f.address?.town || f.address?.municipality, f.address?.state].filter(Boolean).join(', '),
            lon: Number(f.lon),
            lat: Number(f.lat),
          })).filter(h => Number.isFinite(h.lon) && Number.isFinite(h.lat));
        }
        setSuggestions(hits);
      } catch (e) {
        setSuggestions([]);
        setError(e.message || 'Search failed');
      } finally {
        setSearching(false);
      }
    }, 280);
    return () => clearTimeout(id);
  }, [query, truck?.position]);

  async function calculateRoute(dest) {
    if (!origin) {
      setError('Truck has no current GPS origin yet.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      let routeData = null;

      if (hasUsableOrsKey()) {
        try {
          const res = await fetch(ORS_ROUTE, {
            method: 'POST',
            headers: {
              Authorization: ORS_KEY,
              'Content-Type': 'application/json',
              Accept: 'application/json, application/geo+json',
            },
            body: JSON.stringify({
              coordinates: [origin, [dest.lon, dest.lat]],
              options: {
                profile_params: {
                  restrictions: {
                    length:   dims.length,
                    width:    dims.width,
                    height:   dims.height,
                    weight:   dims.weight,
                    axleload: dims.axleload,
                    ...(dims.hazmat ? { hazmat: true } : {}),
                  },
                },
              },
            }),
          });
          if (!res.ok) throw new Error(await readError(res, 'ORS routing'));
          const data = await res.json();
          const feature = data.features?.[0];
          if (!feature) throw new Error('No truck route found via ORS');
          const coordinates = feature.geometry.coordinates;
          const summary = feature.properties.summary;
          const steps = (feature.properties.segments?.[0]?.steps ?? []).map(normalizeStep);
          routeData = {
            provider: 'ors',
            coordinates,
            steps,
            distance_m: Math.round(summary.distance ?? 0),
            duration_s: Math.round(summary.duration ?? 0),
          };
        } catch (orsErr) {
          console.warn('[ORS] truck routing failed:', orsErr?.message);
          setError(`ORS truck routing failed: ${orsErr?.message ?? 'unknown error'} - falling back to standard routing`);
        }
      }

      if (!routeData) {
        const url = `${OSRM_ROUTE}/${origin[0]},${origin[1]};${dest.lon},${dest.lat}?overview=full&geometries=geojson&steps=true`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(await readError(res, 'OSRM routing'));
        const data = await res.json();
        if (!data.routes?.[0]) throw new Error('No route found');
        const r = data.routes[0];
        const steps = (r.legs?.[0]?.steps ?? []).map(s => normalizeStep({
          instruction: s.name || 'Continue',
          name: s.name ?? '',
          distance: s.distance ?? 0,
          duration: s.duration ?? 0,
          type: 6,
          way_points: null,
        }));
        routeData = {
          provider: 'osrm',
          coordinates: r.geometry.coordinates,
          steps,
          distance_m: Math.round(r.distance ?? 0),
          duration_s: Math.round(r.duration ?? 0),
        };
      }

      setSelected(dest);
      setQuery(dest.label);
      setSuggestions([]);
      setRoute(routeData);
      if (routeData.provider === 'ors') setError('');
    } catch (e) {
      setRoute(null);
      setError(e.message || 'Route calculation failed');
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!truck.tripId || !selected || !route) return;
    setSaving(true);
    setError('');
    try {
      await apiFetch(`/trip/${truck.tripId}/assign-route`, {
        method: 'PATCH',
        body: JSON.stringify({
          destination: selected.label,
          dest_lat: selected.lat,
          dest_lon: selected.lon,
          route_steps: route,
          route_dist_m: route.distance_m,
          route_dur_s: route.duration_s,
        }),
      });
      await onAssigned?.();
      onClose();
    } catch (e) {
      setError(e.message || 'Could not assign route');
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    if (!truck.tripId) return;
    setSaving(true);
    try {
      await apiFetch(`/trip/${truck.tripId}/assign-route`, {
        method: 'PATCH',
        body: JSON.stringify({ destination: null }),
      });
      await onAssigned?.();
      onClose();
    } catch (e) {
      setError(e.message || 'Could not clear route');
    } finally {
      setSaving(false);
    }
  }

  const mapPoints = route?.coordinates?.map(([lon, lat]) => [lat, lon]) ?? [];
  const center = mapPoints[0] ?? truck?.position ?? [14.5995, 120.9842];

  return (
    <div className="fixed inset-0 z-[9999] bg-slate-950/55 backdrop-blur-sm flex items-center justify-center p-3" onClick={onClose}>
      <div className="w-full max-w-5xl max-h-[92dvh] bg-white rounded-xl shadow-2xl overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-slate-900">Assign Route</h2>
            <p className="text-xs text-slate-500 truncate">{truck.name} . {truck.driver}</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-100">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        <div className="grid lg:grid-cols-[360px_minmax(0,1fr)] min-h-0 flex-1">
          <div className="p-4 border-b lg:border-b-0 lg:border-r border-slate-200 overflow-y-auto">
            <label className="text-xs font-medium text-slate-500">Destination</label>
            <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 focus-within:ring-2 focus-within:ring-blue-100 focus-within:border-blue-500">
              <Search className="w-4 h-4 text-slate-400" />
              <input
                value={query}
                onChange={e => { setQuery(e.target.value); setSelected(null); setRoute(null); }}
                placeholder="Search address or place"
                className="min-w-0 flex-1 outline-none text-sm"
              />
              {searching && <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />}
            </div>

            {suggestions.length > 0 && (
              <div className="mt-2 border border-slate-200 rounded-xl divide-y divide-slate-100 overflow-hidden">
                {suggestions.map((s, i) => (
                  <button key={`${s.label}-${i}`} onClick={() => calculateRoute(s)}
                    className="w-full text-left px-3 py-2.5 hover:bg-blue-50 flex gap-2">
                    <MapPin className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-slate-800 truncate">{s.name}</span>
                      <span className="block text-xs text-slate-500 truncate">{s.locality || s.label}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}

            <div className="mt-4 rounded-xl bg-slate-50 border border-slate-200 p-3">
              <p className="text-xs font-semibold text-slate-500 mb-2">Truck restrictions</p>
              <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
                <span>{dims.length}m length</span>
                <span>{dims.width}m width</span>
                <span>{dims.height}m height</span>
                <span>{dims.weight}t weight</span>
              </div>
            </div>

            {route && (
              <div className="mt-4 rounded-xl bg-blue-50 border border-blue-100 p-3">
                <div className="flex items-center gap-2 text-blue-700 font-semibold text-sm">
                  <Navigation className="w-4 h-4" />
                  {(route.distance_m / 1000).toFixed(1)} km . {Math.round(route.duration_s / 60)} min
                </div>
                <p className="mt-1 text-xs text-blue-600">{route.steps.length} turn-by-turn steps ready for driver app and HMI.{route.provider === 'osrm' ? ' (standard routing - truck restrictions not applied)' : ''}</p>
              </div>
            )}

            {error && <p className="mt-3 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>}

            <div className="mt-5 flex gap-2">
              <button onClick={save} disabled={!route || saving}
                className="flex-1 px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-semibold disabled:opacity-50">
                {saving ? 'Saving...' : 'Assign Route'}
              </button>
              {truck.assignedDestination && (
                <button onClick={clear} disabled={saving}
                  className="px-4 py-2.5 bg-slate-100 text-slate-700 rounded-lg text-sm font-semibold disabled:opacity-50">
                  Clear
                </button>
              )}
            </div>
          </div>

          <div className="min-h-[360px] lg:min-h-[620px]">
            <MapContainer center={center} zoom={13} className="w-full h-full" attributionControl={false}>
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="? OpenStreetMap contributors" />
              <FitRoute points={mapPoints.length ? mapPoints : [center]} />
              {truck?.position && <Marker position={truck.position} />}
              {selected && <Marker position={[selected.lat, selected.lon]} />}
              {mapPoints.length > 1 && (
                <>
                  <Polyline positions={mapPoints} pathOptions={{ color: '#ffffff', weight: 8, opacity: 0.7 }} />
                  <Polyline positions={mapPoints} pathOptions={{ color: '#2563eb', weight: 5, opacity: 0.95 }} />
                </>
              )}
              {loading && (
                <div className="leaflet-top leaflet-left mt-3 ml-3 rounded-lg bg-white shadow px-3 py-2 text-sm text-slate-600 flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
                  Calculating truck route
                </div>
              )}
            </MapContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
