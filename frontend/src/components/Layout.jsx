import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { Icon, Logo } from './ui';

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: 'home' },
  { to: '/planner', label: 'Route Planner', icon: 'route' },
  { to: '/history', label: 'Trip History', icon: 'clock' },
  { to: '/profile', label: 'Profile', icon: 'user' },
];

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const link = ({ isActive }) =>
    `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${isActive ? 'bg-brand-600 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'}`;

  return (
    <div className="min-h-screen lg:flex">
      <aside className="hidden w-64 shrink-0 flex-col bg-slate-900 p-4 lg:flex">
        <div className="px-2 py-3"><Logo light /></div>
        <nav className="mt-6 flex flex-1 flex-col gap-1" aria-label="Main">
          {NAV.map((n) => <NavLink key={n.to} to={n.to} className={link}><Icon name={n.icon} />{n.label}</NavLink>)}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
          <div className="lg:hidden"><Logo /></div>
          <div className="hidden text-sm text-slate-500 lg:block">Intelligent route planning &amp; travel recommendations</div>
          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <div className="text-sm font-semibold text-slate-800">{user.name}</div>
              <div className="text-xs text-slate-500">{user.email}</div>
            </div>
            <button className="btn-secondary" onClick={() => { logout(); navigate('/'); }}><Icon name="logout" className="h-4 w-4" />Logout</button>
          </div>
        </header>
        {/* mobile nav */}
        <nav className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-white px-3 py-2 lg:hidden" aria-label="Main mobile">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => `whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ${isActive ? 'bg-brand-600 text-white' : 'text-slate-600'}`}>{n.label}</NavLink>
          ))}
        </nav>
        <main className="mx-auto w-full max-w-7xl flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
