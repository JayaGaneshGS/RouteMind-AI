import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import RouteMap from '../components/RouteMap';
import { ErrorBanner, Icon, PageHeader, Spinner, TrafficBadge } from '../components/ui';
import { errorMessage, formatDuration, inr, prefLabel, roadLine, sceneryLine } from '../utils';

/** Road / scenery facts saved with a trip. Older trips have none. They are snapshots of OpenStreetMap data, shown as such. */
function Snapshots({ route }) {
  const road = roadLine(route?.roadQuality);
  const scenery = sceneryLine(route?.scenery);
  if (!road && !scenery) return null;
  const when = (x) => (x?.snapshotAt ? new Date(x.snapshotAt).toLocaleDateString() : 'when saved');
  const top = route?.scenery?.topPois || [];
  return (
    <div className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-2">
      {road && (
        <div className="rounded-lg border border-slate-200 p-3">
          <div className="font-semibold text-slate-700">Road surface data · snapshot {when(route.roadQuality)}</div>
          <div className={road.ok ? '' : 'text-amber-700'}>{road.headline}{road.ok ? ` — ${road.detail}` : ''}</div>
        </div>
      )}
      {scenery && (
        <div className="rounded-lg border border-slate-200 p-3">
          <div className="font-semibold text-slate-700">Nearby nature-related places · snapshot {when(route.scenery)}</div>
          <div className={scenery.ok ? '' : 'text-amber-700'}>
            {scenery.headline}{scenery.ok ? ` — ${route.scenery.totalPois} found${top.length ? `, e.g. ${top.map((p) => p.name || p.categoryLabel).join(', ')}` : ''}` : ''}
          </div>
        </div>
      )}
      <p className="text-[11px] text-slate-400 sm:col-span-2">Saved from OpenStreetMap data at that time; map data changes, and these are neither measurements of road condition nor an official scenic rating.</p>
    </div>
  );
}

export default function History() {
  const [trips, setTrips] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);

  useEffect(() => { api.get('/trips').then((r) => setTrips(r.data.trips)).catch((e) => { setError(errorMessage(e)); setTrips([]); }); }, []);

  async function remove(id) {
    if (!window.confirm('Delete this trip?')) return;
    try { await api.delete(`/trips/${id}`); setTrips((t) => t.filter((x) => x._id !== id)); }
    catch (e) { setError(errorMessage(e)); }
  }

  return (
    <>
      <PageHeader title="Trip History" subtitle="Routes you saved. Your choices also nudge future recommendations." />
      <ErrorBanner message={error} onClose={() => setError('')} />
      {trips === null && <Spinner label="Loading trips…" />}
      {trips && trips.length === 0 && (
        <div className="card p-10 text-center">
          <p className="font-semibold text-slate-800">No saved trips yet</p>
          <p className="mt-1 text-sm text-slate-500">Plan a route and press “Save” to see it here.</p>
          <Link to="/planner" className="btn-primary mt-4">Plan a route</Link>
        </div>
      )}
      <div className="space-y-4">
        {trips?.map((t) => (
          <article key={t._id} className="card p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold text-slate-900">{t.origin.name.split(',')[0]} → {t.destination.name.split(',')[0]}</h2>
                <p className="text-xs text-slate-500">{t.date}{t.time ? ` at ${t.time}` : ''} · {t.selectedRoute?.label}{t.selectedRoute?.via ? ` (via ${t.selectedRoute.via})` : ''} · {prefLabel(t.preference)} · saved {new Date(t.createdAt).toLocaleString()}</p>
              </div>
              <div className="flex gap-2">
                {t.selectedRoute?.geometry?.length > 1 && <button className="btn-secondary" onClick={() => setOpen(open === t._id ? null : t._id)}>{open === t._id ? 'Hide map' : 'View map'}</button>}
                <button className="btn-danger" onClick={() => remove(t._id)} aria-label="Delete trip"><Icon name="trash" className="h-4 w-4" /></button>
              </div>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
              <div><dt className="text-xs text-slate-500">Distance</dt><dd className="font-semibold">{t.distance} km</dd></div>
              <div><dt className="text-xs text-slate-500">Est. time</dt><dd className="font-semibold">{formatDuration(t.estimatedTime)}</dd></div>
              <div><dt className="text-xs text-slate-500">Est. cost</dt><dd className="font-semibold">{inr(t.selectedRoute?.cost || 0)}</dd></div>
              <div><dt className="text-xs text-slate-500">Score</dt><dd className="font-semibold">{t.routeScore}/100</dd></div>
              <div className="self-center"><TrafficBadge level={t.trafficLevel} /></div>
            </dl>
            {t.explanation && <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">{t.explanation}</p>}
            <Snapshots route={t.selectedRoute} />
            {open === t._id && (
              <div className="mt-4">
                <RouteMap routes={[{ id: 'saved', label: t.selectedRoute.label, geometry: t.selectedRoute.geometry }]} origin={t.origin} destination={t.destination} selectedId="saved" height="h-[320px]" />
              </div>
            )}
          </article>
        ))}
      </div>
    </>
  );
}
