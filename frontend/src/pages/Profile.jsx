import { useState } from 'react';
import api from '../api';
import { useAuth } from '../AuthContext';
import { ErrorBanner, Notice, PageHeader } from '../components/ui';
import { PREFERENCES, errorMessage } from '../utils';

export default function Profile() {
  const { user, setUser } = useAuth();
  const [mode, setMode] = useState(user.preferences?.preferredMode || 'BALANCED');
  const [notes, setNotes] = useState(user.preferences?.notes || '');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save(e) {
    e.preventDefault(); setError(''); setMsg(''); setBusy(true);
    try { const { data } = await api.put('/auth/preferences', { preferredMode: mode, notes }); setUser(data.user); setMsg('Preferences saved.'); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader title="Profile & Preferences" subtitle="Defaults used when you plan a route." />
      <div className="grid gap-6 lg:grid-cols-3">
        <section className="card p-6 lg:col-span-1">
          <h2 className="font-semibold">Account</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div><dt className="text-xs text-slate-500">Name</dt><dd className="font-medium">{user.name}</dd></div>
            <div><dt className="text-xs text-slate-500">Email</dt><dd className="font-medium">{user.email}</dd></div>
            <div><dt className="text-xs text-slate-500">Member since</dt><dd className="font-medium">{new Date(user.createdAt).toLocaleDateString()}</dd></div>
          </dl>
        </section>
        <form onSubmit={save} className="card space-y-4 p-6 lg:col-span-2">
          <ErrorBanner message={error} />
          {msg && <Notice tone="blue">{msg}</Notice>}
          <fieldset>
            <legend className="label">Preferred mode</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {PREFERENCES.map((p) => (
                <label key={p.value} className={`cursor-pointer rounded-lg border p-3 text-sm ${mode === p.value ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500' : 'border-slate-200 hover:bg-slate-50'}`}>
                  <input type="radio" name="mode" className="sr-only" checked={mode === p.value} onChange={() => setMode(p.value)} />
                  <div className="font-semibold">{p.label}</div><div className="text-xs text-slate-500">{p.hint}</div>
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <label className="label" htmlFor="notes">Travel notes for the AI</label>
            <textarea id="notes" rows={3} maxLength={300} className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder='e.g. "I usually travel with my family and prefer calm roads"' />
            <p className="mt-1 text-xs text-slate-500">Pre-filled in the planner. Interpreted into priorities (time, traffic, cost, comfort).</p>
          </div>
          <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600"><b>How personalisation works:</b> your preferred mode and the preferences of your last 10 saved trips are blended (15%) into the scoring weights — a deliberately simple, explainable model.</div>
          <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save preferences'}</button>
        </form>
      </div>
    </>
  );
}
