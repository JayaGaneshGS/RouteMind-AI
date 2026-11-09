// Pure helpers (unit-tested in tests/utils.test.js).

export function formatDuration(minutes) {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

export const PREFERENCES = [
  { value: 'FASTEST', label: 'Fastest', hint: 'Shortest travel time' },
  { value: 'CHEAPEST', label: 'Cheapest', hint: 'Lowest estimated cost' },
  { value: 'LOW_TRAFFIC', label: 'Low Traffic', hint: 'Smoothest drive' },
  { value: 'BALANCED', label: 'Balanced', hint: 'Time, traffic and cost equally' },
  { value: 'BETTER_ROADS', label: 'Better Road Conditions', hint: 'Roads documented as paved or smooth' },
  { value: 'BETTER_SCENERY', label: 'Better Scenery', hint: 'More nature-related places near the route' },
];

export const prefLabel = (v) => PREFERENCES.find((p) => p.value === v)?.label || v;

export const TRAFFIC = {
  LOW: { label: 'Low', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200', dot: 'bg-emerald-500' },
  MEDIUM: { label: 'Medium', cls: 'bg-amber-50 text-amber-700 ring-amber-200', dot: 'bg-amber-500' },
  HIGH: { label: 'High', cls: 'bg-red-50 text-red-700 ring-red-200', dot: 'bg-red-500' },
};

export const pct = (x) => `${Math.round((Number(x) || 0) * 100)}%`;

export const osmWayUrl = (id) => `https://www.openstreetmap.org/way/${encodeURIComponent(id)}`;

/**
 * Short, honest text for the road-quality part of a route card. Never turns "unknown" into "good":
 * the numbers describe how much of the route has DOCUMENTED surface/smoothness tags in OpenStreetMap.
 */
export function roadLine(rq) {
  if (!rq) return null;
  if (!rq.available) return { ok: false, headline: 'Road quality data unavailable', detail: rq.reason || '' };
  return {
    ok: true,
    headline: `Road data score ${rq.score}/100`,
    detail: `Surface/smoothness documented for ${pct(rq.coverage)} of the route (${pct(rq.pavedShare)} paved, ${pct(rq.unpavedShare)} unpaved); ${pct(rq.unknownShare)} unknown.`,
  };
}

/** Short text for the scenery part of a route card ("nature-related POIs near the route", never "officially scenic"). */
export function sceneryLine(sc) {
  if (!sc) return null;
  if (!sc.available) return { ok: false, headline: 'Scenery information unavailable', detail: sc.reason || '' };
  const names = (sc.pois || []).filter((p) => p.counted).slice(0, 3).map((p) => p.name || `unnamed ${p.categoryLabel}`);
  return {
    ok: true,
    headline: `Scenery score ${sc.score}/100`,
    detail: sc.totalPois ? `${sc.totalPois} nature-related POI${sc.totalPois > 1 ? 's' : ''} near the route${names.length ? `: ${names.join(', ')}` : ''}` : 'No nature-related POIs found near the route in OpenStreetMap',
  };
}

/** "time 25% · traffic 15% · ..." listing only the factors that carried weight. */
export function weightsText(w) {
  const label = { time: 'time', traffic: 'traffic', cost: 'cost', road: 'road data', scenery: 'scenery' };
  return Object.keys(label).filter((k) => (w?.[k] || 0) > 0.0005).map((k) => `${label[k]} ${Math.round(w[k] * 100)}%`).join(' · ');
}

/** "within 300 m" / "within 1 km" from the thresholds the backend actually used. */
export function bandText(band, t = { nearM: 300, maxM: 1000 }) {
  const km = (m) => (m >= 1000 ? `${Math.round(m / 100) / 10} km` : `${m} m`);
  return `within ${km(band === 'near' ? t.nearM : t.maxM)}`;
}

export const ROUTE_COLORS = ['#2563eb', '#ea580c', '#7c3aed', '#0d9488'];

export const inr = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/** Friendly message from an axios error (server message if present, otherwise a generic one). */
export function errorMessage(err) {
  const server = err?.response?.data?.error?.message;
  if (server) return server;
  if (err?.code === 'ECONNABORTED') return 'The request took too long. Please try again.';
  if (err?.request && !err?.response) return 'Cannot reach the server. Check your connection and try again.';
  return 'Something went wrong. Please try again.';
}

export const todayISO = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
export const nowHHMM = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
