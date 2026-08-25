import { useState } from "react";
import { Link, NavLink, Route, Routes } from "react-router-dom";
import { useNavigate } from "react-router-dom";
import { AuthProvider, ProtectedRoute, useAuth } from "./auth.jsx";
import HomePage from "./pages/HomePage.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import NewSessionPage from "./pages/NewSessionPage.jsx";
import ArchivePage from "./pages/ArchivePage.jsx";
import LiveSessionPage from "./pages/LiveSessionPage.jsx";
import RegisterPage from "./pages/RegisterPage.jsx";
import SessionPage from "./pages/SessionPage.jsx";

function Logo() {
  return (
    <Link className="brand" to="/" aria-label="Signal Ledger home">
      <span className="brand-mark" aria-hidden="true"><span /></span>
      <span>Signal Ledger</span>
    </Link>
  );
}

const THEME_STORAGE_KEY = "signal-ledger-theme";

function getInitialTheme() {
  if (typeof document !== "undefined" && document.documentElement.dataset.theme === "light") return "light";
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function AppShell() {
  const [theme, setTheme] = useState(getInitialTheme);
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);

  const toggleTheme = () => {
    const nextTheme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = nextTheme;
    setTheme(nextTheme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // Theme preference remains functional for the current session if storage is unavailable.
    }
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await logout();
      navigate("/", { replace: true });
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="container header-inner">
          <Logo />
          <nav className="main-nav" aria-label="Primary navigation">
            <NavLink to="/" end>Overview</NavLink>
            <NavLink to="/archive">Archive</NavLink>
          </nav>
          <button
            className="theme-toggle"
            type="button"
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            <span aria-hidden="true">{theme === "dark" ? "☼" : "☾"}</span>
          </button>
          {user ? <div className="account-actions"><span className="account-name">{user.username}</span><button className="text-button account-logout" type="button" onClick={() => void handleLogout()} disabled={loggingOut}>{loggingOut ? "Signing out…" : "Logout"}</button><Link className="button button-small button-primary header-cta" to="/new">Start a transcript <span aria-hidden="true">↗</span></Link></div> : <Link className="button button-small button-primary header-cta" to="/login">Sign in <span aria-hidden="true">↗</span></Link>}
        </div>
      </header>
      <main><Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/new" element={<ProtectedRoute><NewSessionPage /></ProtectedRoute>} />
        <Route path="/archive" element={<ProtectedRoute><ArchivePage /></ProtectedRoute>} />
        <Route path="/session/:id/live" element={<ProtectedRoute><LiveSessionPage /></ProtectedRoute>} />
        <Route path="/session/:id" element={<ProtectedRoute><SessionPage /></ProtectedRoute>} />
      </Routes></main>
      <footer className="site-footer">
        <div className="container footer-inner">
          <span>Signal Ledger · transcript evidence and GenLayer verification</span>
          <span>Built for evidence, not empty badges.</span>
        </div>
      </footer>
    </div>
  );
}

export default function App() {
  return <AuthProvider><AppShell /></AuthProvider>;
}
