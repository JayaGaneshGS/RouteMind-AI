import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { ErrorBanner, Logo } from '../components/ui';
import { errorMessage } from '../utils';

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault(); setError('');
    if (form.password.length < 8) return setError('Password must be at least 8 characters.');
    setBusy(true);
    try { await register(form.name, form.email, form.password); navigate('/dashboard'); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  return (
    <div className="grid min-h-screen place-items-center p-6">
      <form onSubmit={submit} className="card w-full max-w-md space-y-4 p-8">
        <Logo />
        <div><h2 className="text-2xl font-bold">Create your account</h2><p className="text-sm text-slate-500">Save trips and get recommendations that learn your preferences.</p></div>
        <ErrorBanner message={error} />
        <div><label className="label" htmlFor="name">Name</label><input id="name" required minLength={2} className="input" value={form.name} onChange={set('name')} autoComplete="name" /></div>
        <div><label className="label" htmlFor="email">Email</label><input id="email" type="email" required className="input" value={form.email} onChange={set('email')} autoComplete="email" /></div>
        <div><label className="label" htmlFor="password">Password</label><input id="password" type="password" required minLength={8} className="input" value={form.password} onChange={set('password')} autoComplete="new-password" /><p className="mt-1 text-xs text-slate-500">At least 8 characters. Stored as a bcrypt hash.</p></div>
        <button className="btn-primary w-full" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
        <p className="text-center text-sm text-slate-500">Already registered? <Link to="/" className="font-semibold text-brand-600 hover:underline">Log in</Link></p>
      </form>
    </div>
  );
}
