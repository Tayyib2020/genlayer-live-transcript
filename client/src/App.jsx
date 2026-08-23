import { useState } from "react";
import { Link, NavLink, Route, Routes } from "react-router-dom";
import HomePage from "./pages/HomePage.jsx";
import NewSessionPage from "./pages/NewSessionPage.jsx";
import ArchivePage from "./pages/ArchivePage.jsx";
import LiveSessionPage from "./pages/LiveSessionPage.jsx";
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
          <Link className="button button-small button-primary header-cta" to="/new">
            Start a transcript <span aria-hidden="true">↗</span>
          </Link>
        </div>
      </header>
      <main><Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/new" element={<NewSessionPage />} />
        <Route path="/archive" element={<ArchivePage />} />
        <Route path="/session/:id/live" element={<LiveSessionPage />} />
        <Route path="/session/:id" element={<SessionPage />} />
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
  return <AppShell />;
}
