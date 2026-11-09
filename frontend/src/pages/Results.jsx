import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import api from '../api';
import RouteCard from '../components/RouteCard';
import RouteMap from '../components/RouteMap';
import { RoadDetails, SceneryDetails } from '../components/RouteDetails';
import { ErrorBanner, Icon, Notice, PageHeader, TrafficBadge } from '../components/ui';
import { RESULT_KEY } from './Planner';
import { errorMessage, formatDuration, inr, prefLabel, roadLine, sceneryLine, weightsText } from '../utils';

function loadResult(state) {
  if (state?.result) return state.result;
  try { return JSON.parse(sessionStorage.getItem(RESULT_KEY)); } catch { return null; }
}

function Diagnostics({ d }) {
  if (!d) return null;
  const geo = (g) => `${g.provider}${g.cached ? ' (cached)' : g.ms ? ` · ${g.ms} ms` : ''}`;
  const rows = [
    ['Geocoding – origin', geo(d.geocoding.origin)],
    ['Geocoding – destination', geo(d.geocoding.destination)],
    ['Routing', `${d.routing.provider} · ${d.routing.routesReceived} route(s) received${d.routing.cached ? ' (cached)' : ` · ${d.routing.ms} ms`}`],
    ['Traffic prediction', `${d.ml.provider} · model: ${d.ml.model} · source: ${d.ml.source} · ${d.ml.ms} ms`],
    ['Travel time', d.ml.travelTime],
    ['AI (preferences / explanation)', `${d.ai.preferenceParsing} / ${d.ai.explanation}`],
    ['Personalisation (MongoDB history)', d.database.personalisationUsed ? `used (${d.database.tripsConsidered} past choices)` : 'not applied'],
    ...(d.overpass ? [['OpenStreetMap Overpass – road tags', overpassText(d.overpass.roadTags)], ['OpenStreetMap Overpass – scenery POIs', overpassText(d.overpass.scenery)]] : []),
  ];
  return (
    <details className="mt-4 rounded-lg border border-dashed border-slate-300 bg-white p-3 text-xs text-slate-600">
      <summary className="cursor-pointer font-semibold text-slate-700">Developer diagnostics — what actually ran for this search</summary>
      <dl className="mt-3 grid gap-x-4 gap-y-1 sm:grid-cols-[220px_1fr]">
        {rows.map(([k, v]) => (<div key={k} className="contents"><dt className="font-medium text-slate-500">{k}</dt><dd className="font-mono">{v}</dd></div>))}
      </dl>
      <p className="mt-3">Cumulative per-service call counters: <code>GET /api/diagnostics</code>.</p>
    </details>
  );
}

const overpassText = (m) => (typeof m === 'string' ? m : `${m.provider}${m.requested === false ? ' · request not completed' : m.cached ? ' (cached)' : ` · ${m.ms} ms`}${m.samples ? ` · ${m.samples} sample points` : ''}${m.tiles ? ` · ${m.tiles} map tiles, ${m.candidates} candidates` : ''}${m.note ? ` · ${m.note}` : ''}`);

const PROB_COLORS = { LOW: 'bg-emerald-500', MEDIUM: 'bg-amber-400', HIGH: 'bg-red-500' };

export default function Results() {
  const { state } = useLocation();
  const navigate = useNavigate();
  const result = loadResult(state);
  const [selectedId, setSelectedId] = useState(result?.recommendedRoute?.id);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState(null);

  useEffect(() => { api.get('/ml/info').then((r) => setInfo(r.data)).catch(() => setInfo(null)); }, []);
  if (!result) return <Navigate to="/planner" replace />;

  const { routes, recommendedRoute: rec } = result;
  const selected = routes.find((r) => r.id === selectedId) || rec;
  const hasRoad = routes.some((r) => r.scoreBreakdown.road !== undefined);
  const hasScenery = routes.some((r) => r.scoreBreakdown.scenery !== undefined);
  const chart = routes.map((r) => ({ name: r.label, Time: r.scoreBreakdown.time, Traffic: r.scoreBreakdown.traffic, Cost: r.scoreBreakdown.cost, ...(hasRoad ? { 'Road data': r.scoreBreakdown.road ?? 0 } : {}), ...(hasScenery ? { Scenery: r.scoreBreakdown.scenery ?? 0 } : {}), Overall: r.score }));
  const mapPois = (selected.scenery?.available ? selected.scenery.pois.filter((p) => p.counted) : []);
  const recRoad = roadLine(rec.roadQuality); const recScenery = sceneryLine(rec.scenery);

  async function save() {
    setSaving(true); setError('');
    try {
      await api.post('/trips', {
        origin: result.origin, destination: result.destination, date: result.departure.date, time: result.departure.time,
        preference: result.preference, selectedRoute: selected, explanation: selected.id === rec.id ? result.reason : `Selected manually: ${selected.label}.`,
      });
      setSaved(true);
    } catch (e) { setError(errorMessage(e)); } finally { setSaving(false); }
  }

  const w = result.weights;
  return (
    <>
      <PageHeader title={`${result.origin.name.split(',')[0]} → ${result.destination.name.split(',')[0]}`}
        subtitle={`${result.departure.date} at ${result.departure.time} · ${prefLabel(result.preference)} preference · weather: ${result.weather}`}>
        <button className="btn-secondary" onClick={() => navigate('/planner')}>New search</button>
      </PageHeader>

      <div className="space-y-3">
        {result.warnings.map((m, i) => <Notice key={i}>{m}</Notice>)}
        {result.constraints && !result.constraints.implicit && <Notice tone="blue">Time limit from your notes: routes more than {[result.constraints.maxExtraPercent !== undefined && `${result.constraints.maxExtraPercent}%`, result.constraints.maxExtraMinutes !== undefined && `${result.constraints.maxExtraMinutes} min`].filter(Boolean).join(' or ')} slower than the fastest route cannot be recommended.</Notice>}
        <ErrorBanner message={error} onClose={() => setError('')} />
      </div>

      {/* AI recommended route */}
      <section className="mt-4 overflow-hidden rounded-2xl bg-gradient-to-r from-brand-700 to-brand-500 p-6 text-white shadow-md" aria-label="AI recommended route">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-indigo-100"><Icon name="spark" className="h-4 w-4" />AI Recommended Route</div>
        <div className="mt-1 text-3xl font-extrabold">{rec.label}</div>
        <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-5">
          <div><dt className="text-xs text-indigo-200">Distance</dt><dd className="text-lg font-bold">{rec.distanceKm} km</dd></div>
          <div><dt className="text-xs text-indigo-200">Estimated time</dt><dd className="text-lg font-bold">{rec.durationText || formatDuration(rec.durationMinutes)}</dd></div>
          <div><dt className="text-xs text-indigo-200">Predicted traffic</dt><dd className="text-lg font-bold capitalize">{rec.traffic.level.toLowerCase()}</dd></div>
          <div><dt className="text-xs text-indigo-200">Estimated cost</dt><dd className="text-lg font-bold">{inr(rec.cost)}</dd></div>
          <div><dt className="text-xs text-indigo-200">Route score</dt><dd className="text-lg font-bold">{rec.score}/100</dd></div>
        </dl>
        {(recRoad || recScenery) && (
          <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            {recRoad && <div className="rounded-lg bg-white/10 p-3"><dt className="text-xs text-indigo-200">Road surface data (OpenStreetMap)</dt><dd className="font-semibold">{recRoad.headline}</dd><dd className="text-xs text-indigo-100">{recRoad.ok ? recRoad.detail : 'The recommendation does not use road quality for this search.'}</dd></div>}
            {recScenery && <div className="rounded-lg bg-white/10 p-3"><dt className="text-xs text-indigo-200">Nature-related places nearby (OpenStreetMap)</dt><dd className="font-semibold">{recScenery.headline}</dd><dd className="text-xs text-indigo-100">{recScenery.ok ? recScenery.detail : 'The recommendation does not use scenery for this search.'}</dd></div>}
          </dl>
        )}
        <div className="mt-5 rounded-lg bg-white/10 p-4">
          <div className="text-sm font-semibold">Why this route?</div>
          <p className="mt-1 text-sm leading-relaxed text-indigo-50">“{result.reason}”</p>
          <p className="mt-2 text-[11px] text-indigo-200">Explanation by {result.reasonSource === 'llm' ? 'LLM' : 'rule-based AI'}{result.aiInterpretation ? ` · your notes interpreted by ${result.aiInterpretation.source === 'llm' ? 'LLM' : 'rule-based parser'}` : ''}</p>
        </div>
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <div className="space-y-3 lg:col-span-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Available routes ({routes.length})</h2>
          {routes.map((r, i) => <RouteCard key={r.id} route={r} index={i} selected={r.id === selected.id} recommended={r.id === rec.id} onSelect={() => setSelectedId(r.id)} />)}
          <div className="flex items-center gap-3 pt-1">
            <button className="btn-primary" onClick={save} disabled={saving || saved}><Icon name="save" className="h-4 w-4" />{saved ? 'Trip saved' : saving ? 'Saving…' : `Save ${selected.label}`}</button>
            {saved && <Link to="/history" className="text-sm font-semibold text-brand-600 hover:underline">View trip history →</Link>}
          </div>
        </div>
        <div className="lg:col-span-3">
          <RouteMap routes={routes} origin={result.origin} destination={result.destination} selectedId={selected.id} onSelect={setSelectedId} pois={mapPois} height="h-[460px]" />
          <p className="mt-2 text-xs text-slate-500">Click a line or a card to select a route. Route lines are the real road geometry returned by OSRM (road routing only — it does not know live traffic). Map data © OpenStreetMap contributors.{mapPois.length > 0 && ' Green dots are the nature-related places counted for the selected route.'}</p>
        </div>
      </div>

      {(selected.roadQuality || selected.scenery) && (
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <RoadDetails route={selected} />
          <SceneryDetails route={selected} />
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="font-semibold text-slate-900">Score breakdown</h2>
          <p className="mb-3 text-xs text-slate-500">Each factor is scaled 0–100 (higher is better). Weights for this search: {weightsText(w)}.
            {result.personalization.applied && ` Personalised from your last ${result.personalization.basedOnTrips} choices.`}</p>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart} margin={{ left: -15 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" /><YAxis domain={[0, 100]} /><Tooltip /><Legend />
                <Bar dataKey="Time" fill="#2563eb" radius={[3, 3, 0, 0]} /><Bar dataKey="Traffic" fill="#10b981" radius={[3, 3, 0, 0]} /><Bar dataKey="Cost" fill="#f59e0b" radius={[3, 3, 0, 0]} />{hasRoad && <Bar dataKey="Road data" fill="#64748b" radius={[3, 3, 0, 0]} />}{hasScenery && <Bar dataKey="Scenery" fill="#16a34a" radius={[3, 3, 0, 0]} />}<Bar dataKey="Overall" fill="#4f46e5" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="card p-5">
          <h2 className="font-semibold text-slate-900">ML prediction details</h2>
          <p className="mb-3 text-xs text-slate-500">
            {result.mlSource === 'ml-model' ? 'Class probabilities from the RandomForest traffic classifier.' : 'ML service unavailable — rule-of-thumb fallback was used.'}
          </p>
          <div className="space-y-4">
            {routes.map((r) => (
              <div key={r.id}>
                <div className="mb-1 flex items-center justify-between text-sm"><span className="font-medium">{r.label} · {r.routeType} road</span><TrafficBadge level={r.traffic.level} /></div>
                <div className="flex h-3 overflow-hidden rounded-full bg-slate-100" title="LOW / MEDIUM / HIGH probability">
                  {['LOW', 'MEDIUM', 'HIGH'].map((k) => <div key={k} className={PROB_COLORS[k]} style={{ width: `${(r.traffic.probabilities[k] || 0) * 100}%` }} />)}
                </div>
                <div className="mt-1 text-[11px] text-slate-500">Low {Math.round((r.traffic.probabilities.LOW || 0) * 100)}% · Medium {Math.round((r.traffic.probabilities.MEDIUM || 0) * 100)}% · High {Math.round((r.traffic.probabilities.HIGH || 0) * 100)}% · base {formatDuration(r.baseMinutes)} → predicted {formatDuration(r.durationMinutes)}</div>
              </div>
            ))}
          </div>
          {info && <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">Model: {info.model} · hold-out accuracy {(info.accuracy * 100).toFixed(1)}%, F1 {(info.f1_weighted * 100).toFixed(1)}% on the demonstration dataset.</p>}
        </section>
      </div>
      <Diagnostics d={result.diagnostics} />
    </>
  );
}
