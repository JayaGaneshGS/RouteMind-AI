import axios from 'axios';

const TOKEN_KEY = 'routemind_token';
export const tokenStore = {
  get: () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set: (t) => { try { localStorage.setItem(TOKEN_KEY, t); } catch { /* storage blocked */ } },
  clear: () => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
};

// Same-origin /api (Vite proxy in dev, nginx proxy in Docker). Override with VITE_API_URL if needed.
const api = axios.create({ baseURL: import.meta.env.VITE_API_URL || '/api', timeout: 45000 });

api.interceptors.request.use((config) => {
  const t = tokenStore.get();
  if (t) config.headers.Authorization = `Bearer ${t}`;
  return config;
});

export default api;
