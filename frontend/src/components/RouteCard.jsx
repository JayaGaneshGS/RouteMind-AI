import { ROUTE_COLORS, formatDuration, inr, roadLine, sceneryLine } from '../utils';
import { TrafficBadge } from './ui';

function Insight({ title, line }) {
  if (!line) return null;
  return (
    <div className="mt-3 border-t border-slate-100 pt-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold uppercase tracking-wide text-slate-500">{title}</span>
        <span className={line.ok ? 'font-semibold text-slate-800' : 'font-semibold text-amber-700'}>{line.headline}</span>
      </div>
      {line.detail && <p className="mt-0.5 text-slate-500">{line.detail}</p>}
    </div>
  );
}

export default function RouteCard({ route, index, selected, recommended, onSelect }) {
  const road = roadLine(route.roadQuality);
  const scenery = sceneryLine(route.scenery);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`card w-full p-4 text-left transition hover:shadow-md ${selected ? 'ring-2 ring-brand-500' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full" style={{ background: ROUTE_COLORS[index % ROUTE_COLORS.length] }} />
          <span className="font-semibold text-slate-900">{route.label}</span>
          {recommended && <span className="rounded-full bg-brand-600 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">AI pick</span>}
        </div>
        <div className="text-right">
          <div className="text-xl font-bold text-slate-900">{route.score}</div>
          <div className="-mt-1 text-[10px] uppercase tracking-wide text-slate-400">score / 100</div>
        </div>
      </div>
      {route.via && <p className="mt-1 truncate text-xs text-slate-500" title={route.via}>via {route.via}</p>}
      <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
        <div><dt className="text-xs text-slate-500">Distance</dt><dd className="font-semibold">{route.distanceKm} km</dd></div>
        <div><dt className="text-xs text-slate-500">Est. time</dt><dd className="font-semibold">{route.durationText || formatDuration(route.durationMinutes)}</dd></div>
        <div><dt className="text-xs text-slate-500">Est. cost</dt><dd className="font-semibold">{inr(route.cost)}</dd></div>
      </dl>
      <div className="mt-3 flex items-center justify-between">
        <TrafficBadge level={route.traffic.level} />
        <span className="text-xs text-slate-500">{Math.round(route.traffic.confidence * 100)}% confidence</span>
      </div>
      <Insight title="Road surface data" line={road} />
      <Insight title="Scenery" line={scenery} />
      {route.withinTimeLimit === false && <p className="mt-2 text-xs text-amber-700">Slower than your time limit allows — not eligible as the recommendation.</p>}
    </button>
  );
}
