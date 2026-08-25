import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { api } from "./api.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    api.getCurrentUser()
      .then((response) => { if (active) setUser(response.user); })
      .catch((error) => { if (active && error.status !== 401) setUser(null); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const value = useMemo(() => ({
    user,
    loading,
    async login(credentials) {
      const response = await api.login(credentials);
      setUser(response.user);
      return response.user;
    },
    async register(credentials) {
      const response = await api.register(credentials);
      setUser(response.user);
      return response.user;
    },
    async logout() {
      try { await api.logout(); } finally { setUser(null); }
    },
  }), [loading, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}

export function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="app-loading" role="status">Loading Signal Ledger…</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  return children;
}
