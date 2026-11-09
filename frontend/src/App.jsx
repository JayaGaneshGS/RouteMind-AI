import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './AuthContext';
import Layout from './components/Layout';
import { Spinner } from './components/ui';
import Landing from './pages/Landing';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';
import Planner from './pages/Planner';
import Results from './pages/Results';
import History from './pages/History';
import Profile from './pages/Profile';

function Protected({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="grid h-screen place-items-center"><Spinner /></div>;
  return user ? <Layout>{children}</Layout> : <Navigate to="/" replace />;
}

function Public({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="grid h-screen place-items-center"><Spinner /></div>;
  return user ? <Navigate to="/dashboard" replace /> : children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Public><Landing /></Public>} />
      <Route path="/register" element={<Public><Register /></Public>} />
      <Route path="/dashboard" element={<Protected><Dashboard /></Protected>} />
      <Route path="/planner" element={<Protected><Planner /></Protected>} />
      <Route path="/results" element={<Protected><Results /></Protected>} />
      <Route path="/history" element={<Protected><History /></Protected>} />
      <Route path="/profile" element={<Protected><Profile /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
