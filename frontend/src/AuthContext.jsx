import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import api, { tokenStore } from './api';

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(!!tokenStore.get());

  useEffect(() => {
    if (!tokenStore.get()) return;
    api.get('/auth/me').then((r) => setUser(r.data.user)).catch(() => tokenStore.clear()).finally(() => setLoading(false));
  }, []);

  const authenticate = useCallback(async (path, body) => {
    const { data } = await api.post(path, body);
    tokenStore.set(data.token);
    setUser(data.user);
  }, []);

  const value = useMemo(() => ({
    user, loading, setUser,
    login: (email, password) => authenticate('/auth/login', { email, password }),
    register: (name, email, password) => authenticate('/auth/register', { name, email, password }),
    logout: () => { tokenStore.clear(); setUser(null); },
  }), [user, loading, authenticate]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
