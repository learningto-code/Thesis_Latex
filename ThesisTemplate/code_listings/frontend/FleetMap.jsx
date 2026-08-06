import React, { useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, CircleMarker, useMap } from 'react-leaflet';
import L from 'leaflet';
import { getStatusHex } from '../utils/statusColors';

// Fix Leaflet default icon broken path with Vite
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

function MapResizeHandler() {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    const ro = new ResizeObserver(() => {
      map.invalidateSize({ animate: false });
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [map]);
  return null;
}

function PanToSelected({ trucks, selectedTruckId }) {
  const map = useMap();
  useEffect(() => {
    if (!selectedTruckId) return;
    const truck = trucks.find(t => t.id === selectedTruckId);
    if (truck?.position) {
      map.flyTo(truck.position, 15, { animate: true, duration: 0.75 });
    }
  }, [selectedTruckId, trucks, map]);
  return null;
}

function FitBounds({ trucks, adminLocation }) {
  const map = useMap();
  useEffect(() => {
    const points = trucks.filter(t => t.position).map(t => t.position);
    if (adminLocation) points.push(adminLocation);
    if (points.length > 0) {
      map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 14 });
    }
  }, [trucks, adminLocation, map]);
  return null;
}

function createTruckIcon(color, isSelected) {
  const size = isSelected ? 44 : 36;
  return L.divIcon({
    html: `
      <div style="
        width:${size}px;height:${size}px;
        background:${color};
        border-radius:50%;
        border:3px solid white;
        box-shadow:0 2px 8px rgba(0,0,0,0.35);
        display:flex;align-items:center;justify-content:center;
        ${isSelected ? `outline:3px solid ${color};outline-offset:3px;` : ''}
      ">
        <svg width="${size * 0.48}" height="${size * 0.48}" fill="none" stroke="white" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round"
            d="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z"/>
          <path stroke-linecap="round" stroke-linejoin="round"
            d="M13 16V6h4l2 4v6h-2M9 6H5v10h2"/>
        </svg>
      </div>`,
    className: '',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -(size / 2 + 4)],
  });
}

function createAdminIcon() {
  return L.divIcon({
    html: `
      <div style="
        width:32px;height:32px;background:#7c3aed;
        border-radius:50%;border:3px solid white;
        box-shadow:0 2px 8px rgba(0,0,0,0.3);
        display:flex;align-items:center;justify-content:center;
      ">
        <svg width="14" height="14" fill="none" stroke="white" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round"
            d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
        </svg>
      </div>`,
    className: '',
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -20],
  });
}


function buildRouteSegments(routePoints) {
  if (!routePoints || routePoints.length < 2) return { segments: [], restMarkers: [] };

  const DRIVE_COLOR = '#3b82f6'; // blue-500
  const REST_COLOR  = '#f59e0b'; // amber-500

  const segments = [];
  const restMarkers = [];

  let currentColor = routePoints[0].engine_status === 'idle' ? REST_COLOR : DRIVE_COLOR;
  let currentPositions = [[routePoints[0].lat, routePoints[0].lon]];
  if (currentColor === REST_COLOR) restMarkers.push([routePoints[0].lat, routePoints[0].lon]);

  for (let i = 1; i < routePoints.length; i++) {
    const pt = routePoints[i];
    const color = pt.engine_status === 'idle' ? REST_COLOR : DRIVE_COLOR;

    if (color === currentColor) {
      currentPositions.push([pt.lat, pt.lon]);
    } else {
      // Push completed segment
      segments.push({ color: currentColor, positions: currentPositions });
      currentPositions = [currentPositions[currentPositions.length - 1], [pt.lat, pt.lon]];
      currentColor = color;
      if (color === REST_COLOR) restMarkers.push([pt.lat, pt.lon]);
    }
  }

  if (currentPositions.length > 1) {
    segments.push({ color: currentColor, positions: currentPositions });
  }

  return { segments, restMarkers };
}

export default function FleetMap({
  trucks = [],
  selectedTruckId = null,
  onTruckSelect,
  showAdminLocation = false,
  adminLocation,
  singleTruck = false,
}) {
  const firstWithGps = trucks.find(t => t.position);
  const center = firstWithGps ? firstWithGps.position : [14.5995, 121.0000];

  return (
    <MapContainer
      center={center}
      zoom={singleTruck ? 14 : 12}
      className="w-full h-full"
      style={{ minHeight: '100%' }}
    >
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution="? OpenStreetMap contributors"
        maxZoom={19}
      />

      <MapResizeHandler />
      {!singleTruck && <FitBounds trucks={trucks} adminLocation={adminLocation} />}
      <PanToSelected trucks={trucks} selectedTruckId={selectedTruckId} />

      {showAdminLocation && adminLocation && (
        <Marker position={adminLocation} icon={createAdminIcon()}>
          <Popup>
            <div className="text-sm font-semibold">Admin Location</div>
            <div className="text-xs text-slate-500">Current position</div>
          </Popup>
        </Marker>
      )}

      {trucks.filter(t => t.position).map((truck) => {
        const color      = getStatusHex(truck.status);
        const isSelected = selectedTruckId === truck.id;
        const hasRoute   = truck.route && truck.route.length > 1;

        // Build colored segments from route points
        const { segments, restMarkers } = hasRoute
          ? buildRouteSegments(truck.route)
          : { segments: [], restMarkers: [] };

        // Fallback: if no engine_status info, all points are plain [lat,lon] arrays
        const hasEngineStatus = hasRoute && truck.route[0] && typeof truck.route[0] === 'object' && !Array.isArray(truck.route[0]);

        const startPoint = hasRoute
          ? (hasEngineStatus ? [truck.route[0].lat, truck.route[0].lon] : truck.route[0])
          : null;

        // reaches the truck marker in real time.
        const lastRoutePoint = hasRoute
          ? (hasEngineStatus
              ? [truck.route[truck.route.length - 1].lat, truck.route[truck.route.length - 1].lon]
              : truck.route[truck.route.length - 1])
          : null;
        const liveGap = lastRoutePoint && truck.position &&
          (lastRoutePoint[0] !== truck.position[0] || lastRoutePoint[1] !== truck.position[1])
            ? [lastRoutePoint, truck.position]
            : null;

        return (
          <React.Fragment key={truck.id}>
            {hasRoute && (
              hasEngineStatus ? (
                <>
                  {}
                  <Polyline
                    positions={truck.route.map(p => [p.lat, p.lon])}
                    pathOptions={{ color: '#ffffff', weight: 7, opacity: 0.55 }}
                  />
                  {}
                  {segments.map((seg, i) => (
                    <Polyline
                      key={i}
                      positions={seg.positions}
                      pathOptions={{ color: seg.color, weight: 4, opacity: 0.9 }}
                    />
                  ))}
                  {}
                  {restMarkers.map((pos, i) => (
                    <CircleMarker
                      key={`rest-${i}`}
                      center={pos}
                      radius={7}
                      pathOptions={{ color: '#ffffff', weight: 2, fillColor: '#f59e0b', fillOpacity: 1 }}
                    >
                      <Popup>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#92400e' }}>Rest Break</div>
                        <div style={{ fontSize: 11, color: '#78716c' }}>Driver rested here</div>
                      </Popup>
                    </CircleMarker>
                  ))}
                </>
              ) : (
                <>
                  <Polyline
                    positions={truck.route}
                    pathOptions={{ color: '#ffffff', weight: 7, opacity: 0.55 }}
                  />
                  <Polyline
                    positions={truck.route}
                    pathOptions={{ color, weight: 4, opacity: 0.9 }}
                  />
                </>
              )
            )}

            {}
            {liveGap && (
              <Polyline
                positions={liveGap}
                pathOptions={{ color, weight: 3, opacity: 0.75, dashArray: '6 6' }}
              />
            )}

            {}
            {startPoint && (
              <CircleMarker
                center={startPoint}
                radius={6}
                pathOptions={{ color: '#ffffff', weight: 2, fillColor: '#22c55e', fillOpacity: 1 }}
              >
                <Popup>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#166534' }}>Trip Start</div>
                  <div style={{ fontSize: 11, color: '#78716c' }}>{truck.name}</div>
                </Popup>
              </CircleMarker>
            )}
            <Marker
              position={truck.position}
              icon={createTruckIcon(color, isSelected)}
              eventHandlers={{ click: () => onTruckSelect?.(truck.id) }}
            >
              <Popup>
                <div style={{ minWidth: 180 }}>
                  <p style={{ fontWeight: 600, fontSize: 13, color: '#0f172a', marginBottom: 2 }}>{truck.name}</p>
                  <p style={{ fontSize: 11, color: '#64748b', marginBottom: 8 }}>{truck.driver}</p>
                  <div style={{ fontSize: 11, color: '#334155', lineHeight: 1.8 }}>
                    <p><b>Status:</b> {truck.status}</p>
                    <p><b>Speed:</b>  {truck.speed} km/h</p>
                    <p><b>Fuel:</b>   {truck.fuel != null
                      ? (truck.tankCapacityL
                          ? `${truck.fuel}% (${(truck.fuel * truck.tankCapacityL / 100).toFixed(1)} L)`
                          : `${truck.fuel}%`)
                      : '-'}</p>
                    <p><b>Distance:</b> {truck.distance} km</p>
                    <p><b>GPS:</b> {truck.gpsSource === 'fused_mobile_fallback' ? 'Mobile GPS fallback' : 'Embedded GPS'}</p>
                  </div>
                </div>
              </Popup>
            </Marker>
          </React.Fragment>
        );
      })}
    </MapContainer>
  );
}
