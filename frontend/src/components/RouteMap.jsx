import { useEffect } from 'react';
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet';
import { ROUTE_COLORS } from '../utils';

function FitBounds({ points }) {
  const map = useMap();
  useEffect(() => {
    if (points.length > 1) map.fitBounds(points, { padding: [30, 30] });
    // Leaflet needs a size recalculation when its container changes layout.
    setTimeout(() => map.invalidateSize(), 50);
  }, [map, points]);
  return null;
}

/** routes: [{id,label,geometry:[[lat,lon]...]}]; selectedId highlights one; recommendedId gets a star label. */
export default function RouteMap({ routes, origin, destination, selectedId, onSelect, pois = [], height = 'h-[420px]' }) {
  const all = routes.flatMap((r) => r.geometry);
  const center = all.length ? all[Math.floor(all.length / 2)] : [20.59, 78.96];
  return (
    <div className={`${height} overflow-hidden rounded-xl border border-slate-200`}>
      <MapContainer center={center} zoom={7} scrollWheelZoom className="h-full w-full">
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
        {routes.map((r, i) => {
          const selected = r.id === selectedId;
          return (
            <Polyline
              key={r.id}
              positions={r.geometry}
              pathOptions={{ color: ROUTE_COLORS[i % ROUTE_COLORS.length], weight: selected ? 7 : 4, opacity: selected ? 0.95 : 0.55 }}
              eventHandlers={onSelect ? { click: () => onSelect(r.id) } : undefined}
            >
              <Tooltip sticky>{r.label}</Tooltip>
            </Polyline>
          );
        })}
        {pois.map((p) => (
          <CircleMarker key={p.key} center={[p.lat, p.lon]} radius={5} pathOptions={{ color: '#fff', weight: 1.5, fillColor: '#16a34a', fillOpacity: 0.9 }}>
            <Tooltip>{p.name || `Unnamed ${p.categoryLabel}`} · {p.categoryLabel}</Tooltip>
          </CircleMarker>
        ))}
        {origin && <CircleMarker center={[origin.lat, origin.lon]} radius={9} pathOptions={{ color: '#fff', weight: 3, fillColor: '#059669', fillOpacity: 1 }}><Tooltip permanent direction="top">{origin.name?.split(',')[0]}</Tooltip></CircleMarker>}
        {destination && <CircleMarker center={[destination.lat, destination.lon]} radius={9} pathOptions={{ color: '#fff', weight: 3, fillColor: '#dc2626', fillOpacity: 1 }}><Tooltip permanent direction="top">{destination.name?.split(',')[0]}</Tooltip></CircleMarker>}
        <FitBounds points={all} />
      </MapContainer>
    </div>
  );
}
