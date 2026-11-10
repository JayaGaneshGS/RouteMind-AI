import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { ErrorBanner, Icon, Logo } from '../components/ui';
import { errorMessage } from '../utils';

const FEATURES = [
  ['ML traffic prediction', 'A scikit-learn RandomForest classifies expected traffic for each route and departure time.'],
  ['Compare real alternatives', 'Real road routes from OSRM on OpenStreetMap data, scored on time, traffic and cost.'],
  ['Explained recommendations', 'Every pick comes with a plain-language reason. Works with or without an LLM key.'],
];

export default function Landing() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault(); setError(''); setBusy(true);
    try { await login(form.email, form.password); navigate('/dashboard'); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <section className="flex flex-col justify-between bg-gradient-to-br from-slate-900 via-brand-900 to-brand-700 p-8 text-white sm:p-12">
        <Logo light />
        <div className="my-12 max-w-lg">
          <h1 className="text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl">Pick the route that fits <span className="text-emerald-300">your trip</span>, not just the shortest line.</h1>
          <p className="mt-4 text-lg text-indigo-100">Intelligent route planning, traffic prediction and personalised travel recommendations — built on MERN, Python ML and OpenStreetMap.</p>
          <ul className="mt-8 space-y-4">
            {FEATURES.map(([t, d]) => (
              <li key={t} className="flex gap-3"><span className="mt-0.5 text-emerald-300"><Icon name="spark" /></span><div><div className="font-semibold">{t}</div><div className="text-sm text-indigo-200">{d}</div></div></li>
            ))}
          </ul>
        </div>
        <div aria-hidden="true" />
      </section>

      <section className="flex items-center justify-center p-6 sm:p-12">
        <form onSubmit={submit} className="card w-full max-w-md space-y-4 p-8">
          <div><h2 className="text-2xl font-bold">Welcome back</h2><p className="text-sm text-slate-500">Log in to plan and save your trips.</p></div>
          <ErrorBanner message={error} />
          <div><label className="label" htmlFor="email">Email</label><input id="email" type="email" required className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" /></div>
          <div><label className="label" htmlFor="password">Password</label><input id="password" type="password" required className="input" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="current-password" /></div>
          <button className="btn-primary w-full" disabled={busy}>{busy ? 'Signing in…' : 'Log in'}</button>
          <p className="text-center text-sm text-slate-500">New here? <Link to="/register" className="font-semibold text-brand-600 hover:underline">Create an account</Link></p>
        </form>
      </section>
    </div>
  );
}
