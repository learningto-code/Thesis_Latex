import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchLatestTelemetry, fetchRestrictedZones } from '../../utils/driverApi';
import { getDriverSession } from './DriverApp';
import { MapPin, Fuel, Gauge, Radio, Truck } from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const PIN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="#4f8ef7" stroke="#2055b8" stroke-width="1.5"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3" fill="white" stroke="none"/></svg>';
const TRUCK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#F7F7F7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="background:#1565C0;border-radius:6px;padding:2px"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>';

// Fix leaflet default marker icons broken by Vite bundler
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
});

const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving';

export default function DriverMap({ session }) {
  const navigate = useNavigate();
  const mapRef   = useRef(null);
  const mapObj   = useRef(null);
  const markerRef = useRef(null);
  const routeRef  = useRef(null);
  const zoneRefs  = useRef([]);

  const phoneMarkerRef    = useRef(null);
  const phoneAccCircleRef = useRef(null);
  const geoWatchRef       = useRef(null);

  const [destination, setDestination] = useState('');
  const [routeInfo, setRouteInfo] = useState(null);   // { distance_km, duration_min }
  const [zoneWarning, setZoneWarning] = useState('');
  const [routing, setRouting] = useState(false);
  const [routeError, setRouteError] = useState('');
  const [telemetry, setTelemetry] = useState(null);
  const [phoneLocation, setPhoneLocation] = useState(null);  // { lat, lon, accuracy }
  const [geoError, setGeoError] = useState('');

  const session_ = getDriverSession() ?? session;
  const truckId = session_?.truck_id ?? session_?.active_trip?.truck_id;

  // Initialize map
  useEffect(() => {
    if (mapObj.current) return;
    mapObj.current = L.map(mapRef.current, {
      center: [14.5995, 120.9842],  // Manila default
      zoom: 13,
      zoomControl: true,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '? OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(mapObj.current);

    return () => {
      mapObj.current?.remove();
      mapObj.current = null;
    };
  }, []);

  // Load restricted zones and draw bounding boxes
  useEffect(() => {
    fetchRestrictedZones().then((zones) => {
      // Clear old zone layers
      zoneRefs.current.forEach((l) => l.remove());
      zoneRefs.current = [];

      zones.forEach((z) => {
        const bounds = [[z.lat_min, z.lon_min], [z.lat_max, z.lon_max]];
        const color  = z.severity === 'restricted' ? '#ff4444' : '#ffaa00';
        const rect   = L.rectangle(bounds, {
          color, weight: 2, fillColor: color, fillOpacity: 0.15, dashArray: '6 4',
        });
        rect.bindTooltip(
          `<b>${z.name}</b><br>${z.description ?? ''}<br><i>${z.ban_start_hour != null ? `${z.ban_start_hour}:00-${z.ban_end_hour}:00` : 'All times'}</i>`,
          { permanent: false, sticky: true }
        );
        rect.addTo(mapObj.current);
        zoneRefs.current.push(rect);
      });
    }).catch(() => {});
  }, []);

  // Phone GPS via browser geolocation API
  useEffect(() => {
    if (!navigator.geolocation) {
      setGeoError('GPS not available on this device');
      return;
    }
    function onPosition(pos) {
      const { latitude: lat, longitude: lon, accuracy } = pos.coords;
      setPhoneLocation({ lat, lon, accuracy });
      setGeoError('');
      if (!mapObj.current) return;
      const latlng = [lat, lon];
      if (!phoneMarkerRef.current) {
        phoneMarkerRef.current = L.circleMarker(latlng, {
          radius: 8, color: '#ffffff', weight: 2, fillColor: '#2196f3', fillOpacity: 1,
        }).bindTooltip('Your phone', { permanent: false }).addTo(mapObj.current);
        mapObj.current.flyTo(latlng, 15, { duration: 1.5 });
      } else {
        phoneMarkerRef.current.setLatLng(latlng);
      }
      if (!phoneAccCircleRef.current) {
        phoneAccCircleRef.current = L.circle(latlng, {
          radius: accuracy, color: '#2196f3', weight: 1, fillColor: '#2196f3', fillOpacity: 0.1,
        }).addTo(mapObj.current);
      } else {
        phoneAccCircleRef.current.setLatLng(latlng).setRadius(accuracy);
      }
    }
    function onError(err) {
      if (err.code === err.PERMISSION_DENIED)      setGeoError('Location permission denied - enable in browser settings');
      else if (err.code === err.POSITION_UNAVAILABLE) setGeoError('GPS signal unavailable');
      else setGeoError('Could not get phone location');
    }
    geoWatchRef.current = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true, timeout: 15000, maximumAge: 5000,
    });
    return () => {
      navigator.geolocation.clearWatch(geoWatchRef.current);
      phoneMarkerRef.current?.remove();    phoneMarkerRef.current = null;
      phoneAccCircleRef.current?.remove(); phoneAccCircleRef.current = null;
    };
  }, []);

  // Poll telemetry and update truck marker
  useEffect(() => {
    if (!truckId) return;
    let cancelled = false;

    async function updatePosition() {
      try {
        const t = await fetchLatestTelemetry(truckId);
        if (cancelled) return;
        setTelemetry(t);
        if (t?.lat && t?.lon) {
          const latlng = [t.lat, t.lon];
          if (!markerRef.current) {
            markerRef.current = L.marker(latlng, {
              title: 'Your Truck',
              icon: L.divIcon({ html: TRUCK_SVG, className: '', iconSize: [28, 28], iconAnchor: [14, 14] }),
            }).addTo(mapObj.current);
          } else {
            markerRef.current.setLatLng(latlng);
          }
        }
      } catch {  }
    }

    updatePosition();
    const id = setInterval(updatePosition, 15000);
    return () => { cancelled = true; clearInterval(id); };
  }, [truckId]);

  // OSRM routing by destination coordinates or place name
  async function getRoute() {
    setRouting(true);
    setRouteError('');
    setZoneWarning('');
    setRouteInfo(null);

    const origin = phoneLocation?.lat && phoneLocation?.lon
      ? [phoneLocation.lon, phoneLocation.lat]
      : telemetry?.lat && telemetry?.lon
        ? [telemetry.lon, telemetry.lat]
        : [120.9842, 14.5995];

    // Resolve destination: try "lat,lon" format first, then Nominatim geocode
    let destCoord = null;
    const coordMatch = destination.trim().match(/^(-?\d+\.?\d*),\s*(-?\d+\.?\d*)$/);
    if (coordMatch) {
      destCoord = [parseFloat(coordMatch[2]), parseFloat(coordMatch[1])];  // [lon, lat] for OSRM
    } else {
      try {
        const geoRes = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(destination + ', Philippines')}&format=json&limit=1`,
          { headers: { 'Accept-Language': 'en' } }
        );
        const geoData = await geoRes.json();
        if (!geoData?.length) throw new Error('Place not found');
        destCoord = [parseFloat(geoData[0].lon), parseFloat(geoData[0].lat)];

        // Pan map to show destination
        mapObj.current?.flyTo([destCoord[1], destCoord[0]], 13, { duration: 1.5 });
      } catch (e) {
        setRouteError(`Could not geocode: ${e.message}`);
        setRouting(false);
        return;
      }
    }

    // Fetch OSRM route
    try {
      const url = `${OSRM_BASE}/${origin[0]},${origin[1]};${destCoord[0]},${destCoord[1]}?overview=full&geometries=geojson`;
      const routeRes = await fetch(url);
      const routeData = await routeRes.json();

      if (!routeData.routes?.length) throw new Error('No route found');

      const route = routeData.routes[0];
      const coords = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);

      // Draw polyline
      if (routeRef.current) routeRef.current.remove();
      routeRef.current = L.polyline(coords, { color: '#00aaff', weight: 5, opacity: 0.8 })
        .addTo(mapObj.current);
      mapObj.current?.fitBounds(routeRef.current.getBounds(), { padding: [40, 40] });

      // Destination marker
      L.marker([destCoord[1], destCoord[0]], {
        icon: L.divIcon({ html: PIN_SVG, className: '', iconSize: [24, 24], iconAnchor: [12, 24] }),
      }).addTo(mapObj.current);

      setRouteInfo({
        distance_km: (route.distance / 1000).toFixed(1),
        duration_min: Math.round(route.duration / 60),
      });

      await checkZoneWarnings(coords, destCoord);
    } catch (e) {
      setRouteError(e.message || 'Routing failed');
    } finally {
      setRouting(false);
    }
  }

  async function checkZoneWarnings(routeCoords, destCoord) {
    try {
      const zones = await fetchRestrictedZones();
      const hour = new Date().getHours();
      const day  = new Date().getDay();  // 0=Sun, 1=Mon...

      for (const z of zones) {
        // Check time-based restrictions
        const timeActive = z.ban_start_hour != null
          ? (hour >= z.ban_start_hour && hour < z.ban_end_hour)
          : true;
        if (!timeActive) continue;

        const daysActive = z.ban_days_of_week
          ? z.ban_days_of_week.split(',').map(Number).includes(day)
          : true;
        if (!daysActive) continue;

        // Check if any route point is inside zone bbox
        const routeIntersects = routeCoords.some(
          ([lat, lon]) => lat >= z.lat_min && lat <= z.lat_max && lon >= z.lon_min && lon <= z.lon_max
        );

        if (routeIntersects) {
          setZoneWarning(`Route passes through restricted zone: ${z.name} (${z.description ?? ''}). Consider alternate route.`);
          return;
        }
      }
    } catch {  }
  }

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <button style={styles.backBtn} onClick={() => navigate('/driver/trip')}><- Back</button>
        <span style={styles.headerTitle}>Map &amp; Navigation</span>
        <span />
      </div>

      {}
      <div style={styles.searchBox}>
        <input
          style={styles.destInput}
          placeholder="Destination (place name or lat,lon)"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && getRoute()}
        />
        <button style={styles.routeBtn} disabled={!destination.trim() || routing} onClick={getRoute}>
          {routing ? '...' : 'Route'}
        </button>
      </div>

      {}
      {routeInfo && (
        <div style={styles.routeInfo}>
          {routeInfo.distance_km} km . ~{routeInfo.duration_min} min
        </div>
      )}

      {}
      {zoneWarning && (
        <div style={styles.zoneWarning}>{zoneWarning}</div>
      )}

      {routeError && <div style={styles.routeError}>{routeError}</div>}

      {}
      {geoError && (
        <div style={styles.geoError}><MapPin size={13} style={{verticalAlign:'middle',marginRight:4}} />{geoError}</div>
      )}

      {}
      {phoneLocation && (
        <div style={styles.phoneBar}>
          <MapPin size={13} style={{verticalAlign:'middle',marginRight:4}} /> Phone GPS &nbsp;
          <span style={styles.accBadge}>+/-{Math.round(phoneLocation.accuracy)} m</span>
          {!geoError && <span style={{ color: '#00cc66', marginLeft: 8 }}>?</span>}
        </div>
      )}

      {}
      {telemetry && (
        <div style={styles.telemBar}>
          <span style={{display:'inline-flex',alignItems:'center',gap:3}}><Fuel size={12}/> {telemetry.fuel_level?.toFixed(1) ?? '--'}%</span>
          <span style={{display:'inline-flex',alignItems:'center',gap:3}}><Gauge size={12}/> {Math.round(telemetry.speed ?? 0)} km/h</span>
          <span style={{ fontSize: 10, color: '#557799', display:'inline-flex', alignItems:'center', gap:3 }}><Radio size={11}/> HMI GPS</span>
          <span style={styles.chanBadge}>{
            (() => {
              const c = telemetry.channel_used ?? 'cellular';
              return c === 'gsm' || c === 'lte' ? 'cellular' : c;
            })()
          }</span>
        </div>
      )}

      {}
      <div ref={mapRef} style={styles.map} />

      {}
      <div style={styles.legend}>
        <span style={{ color: '#2196f3' }}>?</span> You &nbsp;
        <Truck size={13} style={{verticalAlign:'middle'}} /> Truck &nbsp;
        <span style={{ color: '#ff4444' }}>?</span> Restricted &nbsp;
        <span style={{ color: '#ffaa00' }}>?</span> Advisory &nbsp;
        <span style={{ color: '#00aaff' }}>-</span> Route
        <span style={{ color: '#888', fontSize: 10, marginLeft: 6 }}>. Zones advisory</span>
      </div>
    </div>
  );
}

const styles = {
  page: { display: 'flex', flexDirection: 'column', height: '100dvh', background: '#001133' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', background: '#002255', borderBottom: '1px solid #003377', flexShrink: 0 },
  backBtn: { background: 'none', border: 'none', color: '#00aaff', fontSize: 15, cursor: 'pointer', padding: '4px 0' },
  headerTitle: { fontSize: 16, fontWeight: 700, color: '#ffffff' },
  searchBox: { display: 'flex', gap: 8, padding: '10px 12px', background: '#001a44', borderBottom: '1px solid #003366', flexShrink: 0 },
  destInput: { flex: 1, padding: '10px 12px', borderRadius: 10, border: '1px solid #003366', background: '#0a1a30', color: '#ffffff', fontSize: 14, outline: 'none' },
  routeBtn: { padding: '10px 16px', borderRadius: 10, border: 'none', background: '#0055aa', color: '#ffffff', fontWeight: 700, cursor: 'pointer', touchAction: 'manipulation', fontSize: 14 },
  routeInfo: { padding: '8px 16px', background: '#00234a', color: '#00ddff', fontSize: 14, fontWeight: 600, flexShrink: 0 },
  zoneWarning: { padding: '8px 16px', background: '#440000', color: '#ffaaaa', fontSize: 12, flexShrink: 0 },
  routeError: { padding: '8px 16px', background: '#220011', color: '#ff8888', fontSize: 12, flexShrink: 0 },
  geoError: { padding: '6px 16px', background: '#330011', color: '#ff8888', fontSize: 12, flexShrink: 0 },
  phoneBar: { display: 'flex', alignItems: 'center', padding: '5px 16px', background: '#001533', color: '#aaccee', fontSize: 12, flexShrink: 0, borderBottom: '1px solid #002244' },
  accBadge: { background: '#002255', padding: '1px 7px', borderRadius: 6, fontSize: 11, color: '#7799bb' },
  telemBar: { display: 'flex', gap: 16, padding: '6px 16px', background: '#001a33', color: '#aaccee', fontSize: 13, alignItems: 'center', flexShrink: 0 },
  chanBadge: { marginLeft: 'auto', background: '#002255', padding: '2px 8px', borderRadius: 6, fontSize: 11, color: '#7799bb' },
  map: { flex: 1, minHeight: 0 },
  legend: { padding: '6px 14px', background: '#001122', color: '#aabbcc', fontSize: 11, flexShrink: 0 },
};
