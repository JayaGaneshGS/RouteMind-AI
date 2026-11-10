import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import api from '../api';
import { useAuth } from '../AuthContext';
import { Icon, PageHeader, Stat, TrafficBadge } from '../components/ui';
import { PREFERENCES, formatDuration, prefLabel } from '../utils';

export default function Dashboard() {
  const { user } = useAuth();
  const [trips, setTrips] = useState([]);
  const [info, setInfo] = useState(null);
  const [mlDown, setMlDown] = useState(false);

  useEffect(() => {
    api.get('/trips').then((r) => setTrips(r.data.trips)).catch(() => setTrips([]));
    api.get('/ml/info').then((r) => setInfo(r.data)).catch(() => setMlDown(true));
  }, []);

  const km = trips.reduce((s, t) => s + t.distance, 0);
  const counts = PREFERENCES.map((p) => ({ name: p.label.replace(/^Better /, ''), trips: trips.filter((t) => t.preference === p.value).length }));
  const top = [...counts].sort((a, b) => b.trips - a.trips)[0];
  const importance = info?.feature_importances?.slice(0, 6).map((f) => ({ name: f.feature.replace(/_/g, ' '), value: Math.round(f.importance * 1000) / 10 })) || [];

  return (
    <>
      <PageHeader title={`Hello, ${user.name.split(' ')[0]}`} subtitle="Your travel assistant overview.">
        <Link to="/planner" className="btn-primary"><Icon name="route" className="h-4 w-4" />Plan a route</Link>
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Saved trips" value={trips.length} />
        <Stat label="Distance planned" value={`${Math.round(km)} km`} />
        <Stat label="Most used mode" value={trips.length ? top.name : '—'} sub={`Default: ${prefLabel(user.preferences?.preferredMode)}`} />
        <Stat label="Traffic model accuracy" value={info ? `${(info.accuracy * 100).toFixed(1)}%` : mlDown ? 'Offline' : '…'} sub="On demonstration dataset" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="font-semibold">Recent trips</h2>
          {trips.length === 0 ? <p className="mt-3 text-sm text-slate-500">No trips yet — plan your first route.</p> : (
            <ul className="mt-3 divide-y divide-slate-100">
              {trips.slice(0, 5).map((t) => (
                <li key={t._id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div><div className="font-medium">{t.origin.name.split(',')[0]} → {t.destination.name.split(',')[0]}</div><div className="text-xs text-slate-500">{t.date} · {t.distance} km · {formatDuration(t.estimatedTime)}</div></div>
                  <TrafficBadge level={t.trafficLevel} />
                </li>
              ))}
            </ul>
          )}
          {trips.length > 0 && <div className="mt-4 h-40">
            <ResponsiveContainer width="100%" height="100%"><BarChart data={counts} margin={{ left: -25 }}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="name" fontSize={11} /><YAxis allowDecimals={false} fontSize={11} /><Tooltip /><Bar dataKey="trips" fill="#4f46e5" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer>
          </div>}
        </section>

        <section className="card p-5">
          <h2 className="font-semibold">Traffic prediction model</h2>
          {mlDown && <p className="mt-3 text-sm text-amber-700">The ML service is not reachable right now. Route search falls back to a simple rule-of-thumb.</p>}
          {info && (
            <>
              <dl className="mt-3 grid grid-cols-4 gap-2 text-center text-sm">
                {[['Accuracy', info.accuracy], ['Precision', info.precision_weighted], ['Recall', info.recall_weighted], ['F1', info.f1_weighted]].map(([k, v]) => (
                  <div key={k} className="rounded-lg bg-slate-50 p-2"><dt className="text-[11px] text-slate-500">{k}</dt><dd className="font-bold">{(v * 100).toFixed(1)}%</dd></div>
                ))}
              </dl>
              <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">Feature importance (%)</h3>
              <div className="h-44">
                <ResponsiveContainer width="100%" height="100%"><BarChart data={importance} layout="vertical" margin={{ left: 40 }}><XAxis type="number" fontSize={11} /><YAxis type="category" dataKey="name" fontSize={11} width={130} /><Tooltip /><Bar dataKey="value" fill="#10b981" radius={[0, 4, 4, 0]} /></BarChart></ResponsiveContainer>
              </div>
            </>
          )}
        </section>
      </div>
    </>
  );
}
