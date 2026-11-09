import { bandText, osmWayUrl, pct } from '../utils';

/**
 * Detail panels for the selected route. They only restate what the backend retrieved from OpenStreetMap, say where it
 * came from, and keep "documented in the map data" apart from "actual condition of the road".
 */

function Unavailable({ title, message, reason }) {
  return (
    <section className="card p-5">
      <h2 className="font-semibold text-slate-900">{title}</h2>
      <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{message}</p>
      {reason && <p className="mt-2 text-xs text-slate-500">Why: {reason}</p>}
      <p className="mt-2 text-xs text-slate-500">The recommendation for this search ignores this factor and uses only the attributes that are available.</p>
    </section>
  );
}

export function RoadDetails({ route }) {
  const q = route.roadQuality;
  if (!q) return null;
  if (!q.available) return <Unavailable title={`Road conditions · ${route.label}`} message="Road quality data unavailable" reason={q.reason} />;
  return (
    <section className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-900">Road conditions · {route.label}</h2>
          <p className="text-xs text-slate-500">Source: {q.source}. {q.method ? `Method: ${q.method}.` : ''}</p>
        </div>
        <div className="text-right"><div className="text-xl font-bold text-slate-900">{q.score}</div><div className="-mt-1 text-[10px] uppercase tracking-wide text-slate-400">road data score</div></div>
      </div>

      <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-slate-100" title="Share of the sampled route by documented surface">
        <div className="bg-emerald-500" style={{ width: pct(q.pavedShare) }} />
        <div className="bg-amber-500" style={{ width: pct(q.unpavedShare) }} />
        <div className="bg-slate-300" style={{ width: pct(q.unknownShare) }} />
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 text-[11px] text-slate-600">
        <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-500" />Documented paved {pct(q.pavedShare)}</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-amber-500" />Documented unpaved {pct(q.unpavedShare)}</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-slate-300" />Unknown {pct(q.unknownShare)}</span>
      </div>
      <p className="mt-3 text-sm text-slate-600">{q.summary}</p>

      {q.classes?.length > 0 && (
        <div className="mt-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Road classification <span className="font-normal normal-case">(function of the road — not its condition)</span></h3>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {q.classes.map((c) => <span key={c.highway} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">{c.label} · {pct(c.share)}</span>)}
          </div>
        </div>
      )}

      {q.evidence?.length > 0 && (
        <div className="mt-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Roads with documented tags (examples)</h3>
          <ul className="mt-1 space-y-1 text-xs text-slate-600">
            {q.evidence.map((e) => (
              <li key={e.wayId}>
                {e.name || 'Unnamed road'} · {e.highway}
                {e.surface ? ` · surface=${e.surface}` : ''}{e.smoothness ? ` · smoothness=${e.smoothness}` : ''}{' '}
                <a className="font-semibold text-brand-600 hover:underline" href={osmWayUrl(e.wayId)} target="_blank" rel="noreferrer">OSM way {e.wayId}</a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-3 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
        This reflects tags that mappers added to OpenStreetMap, sampled along the route. Unknown does not mean bad, and “paved” does not mean pothole-free.
        Potholes, cracks and road safety are not in this data.
      </p>
    </section>
  );
}

export function SceneryDetails({ route }) {
  const s = route.scenery;
  if (!s) return null;
  if (!s.available) return <Unavailable title={`Scenery · ${route.label}`} message="Scenery information unavailable" reason={s.reason} />;
  const counted = (s.pois || []).filter((p) => p.counted);
  const rest = (s.pois || []).filter((p) => !p.counted);
  return (
    <section className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-900">Scenery · {route.label}</h2>
          <p className="text-xs text-slate-500">Source: {s.source}. Nature-related places only (beaches, viewpoints, parks, reserves, lakes, forests, attractions).</p>
        </div>
        <div className="text-right"><div className="text-xl font-bold text-slate-900">{s.score}</div><div className="-mt-1 text-[10px] uppercase tracking-wide text-slate-400">scenery score</div></div>
      </div>
      <p className="mt-3 text-sm text-slate-600">{s.summary}</p>

      {counted.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100 text-sm">
          {counted.map((p) => (
            <li key={p.key} className="flex items-start justify-between gap-3 py-1.5">
              <div>
                <a className="font-medium text-slate-800 hover:text-brand-600 hover:underline" href={p.osmUrl} target="_blank" rel="noreferrer">{p.name || `Unnamed ${p.categoryLabel}`}</a>
                <div className="text-xs text-slate-500">{p.categoryLabel} · {bandText(p.band, s.thresholds)}{p.distanceM !== null && p.distanceM !== undefined ? ` (≈ ${p.distanceM} m)` : ''}{p.proximity === 'bounding-box' ? ' · approximate' : ''}</div>
              </div>
              <span className="whitespace-nowrap text-xs text-slate-500">+{Math.round(p.contribution * 100) / 100}</span>
            </li>
          ))}
        </ul>
      )}
      {rest.length > 0 && <p className="mt-2 text-xs text-slate-500">{rest.length} more nearby place{rest.length > 1 ? 's' : ''} not counted (at most {s.thresholds?.maxPerCategory ?? 3} per category count, so a cluster of similar places cannot dominate).</p>}
      {s.duplicatesRemoved > 0 && <p className="mt-1 text-xs text-slate-500">{s.duplicatesRemoved} duplicate map entries for the same place were merged.</p>}
      <p className="mt-3 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
        “Nature-related POIs near the route” counts mapped places within {bandText('ring', s.thresholds).replace('within ', '')} of the road (full weight within {bandText('near', s.thresholds).replace('within ', '')}). It is not an official or measured scenic rating, and missing map data lowers a route’s count.
      </p>
    </section>
  );
}
