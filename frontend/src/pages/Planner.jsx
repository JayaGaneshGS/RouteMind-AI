import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../AuthContext';
import PlaceInput from '../components/PlaceInput';
import { ErrorBanner, Icon, PageHeader, Spinner } from '../components/ui';
import { PREFERENCES, errorMessage, nowHHMM, todayISO } from '../utils';

export const RESULT_KEY = 'routemind_last_result';

export default function Planner() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [origin, setOrigin] = useState({ text: '', place: null });
  const [destination, setDestination] = useState({ text: '', place: null });
  const [date, setDate] = useState(todayISO());
  const [time, setTime] = useState(nowHHMM());
  const [preference, setPreference] = useState(user?.preferences?.preferredMode || 'BALANCED');
  const [weather, setWeather] = useState('clear');
  const [notes, setNotes] = useState(user?.preferences?.notes || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault(); setError('');
    if (!origin.text.trim() || !destination.text.trim()) return setError('Please enter both an origin and a destination.');
    setBusy(true);
    try {
      const { data } = await api.post('/routes/search', {
        origin: origin.place || origin.text.trim(), destination: destination.place || destination.text.trim(),
        date, time, preference, weather, notes: notes.trim() || undefined,
      });
      try { sessionStorage.setItem(RESULT_KEY, JSON.stringify(data)); } catch { /* storage blocked: state still works */ }
      navigate('/results', { state: { result: data } });
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  const swap = () => { setOrigin(destination); setDestination(origin); };

  return (
    <>
      <PageHeader title="Route Planner" subtitle="Find, compare and score routes between two places." />
      <form onSubmit={submit} className="card mx-auto max-w-3xl space-y-5 p-6">
        <ErrorBanner message={error} onClose={() => setError('')} />
        <div className="grid items-end gap-3 md:grid-cols-[1fr_auto_1fr]">
          <PlaceInput id="origin" label="Origin" placeholder="e.g. Chennai" value={origin} onChange={setOrigin} />
          <button type="button" className="btn-secondary mb-0.5 hidden md:inline-flex" onClick={swap} aria-label="Swap origin and destination"><Icon name="swap" className="h-4 w-4" /></button>
          <PlaceInput id="destination" label="Destination" placeholder="e.g. Pondicherry" value={destination} onChange={setDestination} />
        </div>
        <p className="-mt-2 text-xs text-slate-500">Type a place and press Enter (or the search button) to pick an exact match — or just type a city name and we'll resolve it for you.</p>

        <div className="grid gap-4 sm:grid-cols-3">
          <div><label className="label" htmlFor="date">Date</label><input id="date" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} required /></div>
          <div><label className="label" htmlFor="time">Departure time</label><input id="time" type="time" className="input" value={time} onChange={(e) => setTime(e.target.value)} required /></div>
          <div><label className="label" htmlFor="weather">Weather</label>
            <select id="weather" className="input" value={weather} onChange={(e) => setWeather(e.target.value)}>
              <option value="clear">Clear</option><option value="cloudy">Cloudy</option><option value="rain">Rain</option><option value="fog">Fog</option>
            </select>
          </div>
        </div>

        <fieldset>
          <legend className="label">Preference</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[...PREFERENCES, { value: 'AUTO', label: 'Let AI decide', hint: 'From your notes below' }].map((p) => (
              <label key={p.value} className={`cursor-pointer rounded-lg border p-3 text-sm transition ${preference === p.value ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500' : 'border-slate-200 hover:bg-slate-50'}`}>
                <input type="radio" name="pref" className="sr-only" checked={preference === p.value} onChange={() => setPreference(p.value)} />
                <div className="font-semibold">{p.label}</div><div className="text-xs text-slate-500">{p.hint}</div>
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <label className="label" htmlFor="notes">Tell the AI about your trip (optional)</label>
          <textarea id="notes" rows={2} maxLength={300} className="input" value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder='e.g. "I am travelling with my family and want to avoid heavy traffic" or "a scenic route past beaches, but not much longer"' />
          <p className="mt-1 text-xs text-slate-500">Used by “Let AI decide”, and also to fine-tune any other choice. Road-condition and scenery requests use OpenStreetMap data, which can add a few seconds.</p>
        </div>

        <button className="btn-primary w-full py-3 text-base" disabled={busy}>{busy ? 'Analysing routes…' : 'Find Best Route'}</button>
        {busy && <Spinner label={`Looking up places, fetching routes and running the traffic model${preference === 'BETTER_ROADS' || preference === 'BETTER_SCENERY' || preference === 'AUTO' ? ', then reading road tags / nearby places from OpenStreetMap' : ''} — this can take a few seconds (public map servers are rate-limited).`} />}
      </form>
    </>
  );
}
