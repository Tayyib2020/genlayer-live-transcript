import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../api.js";
import PageIntro from "../components/PageIntro.jsx";
import SessionCard from "../components/SessionCard.jsx";
import ErrorState from "../components/ErrorState.jsx";

export default function ArchivePage() {
  const [sessions, setSessions] = useState([]);
  const [error, setError] = useState(null);
  const location = useLocation();

  function load() {
    setError(null);
    api.listSessions().then((data) => setSessions(data.sessions)).catch((err) => setError(err.message));
  }

  useEffect(load, []);

  return (
    <div className="container page-stack">
      <PageIntro eyebrow="Private archive" title="A record of what was heard." description="Only sessions owned by your Signal Ledger account appear here." action={<Link className="button button-primary" to="/new">New session <span aria-hidden="true">↗</span></Link>} />
      {location.state?.message && <div className="archive-success" role="status">{location.state.message}</div>}
      {error ? <ErrorState message={error} retry={load} /> : sessions.length === 0 ? <div className="empty-card archive-empty"><span className="empty-mark">⌁</span><div><h2>No sessions yet.</h2><p>Your created sessions will appear here after you capture a record.</p></div></div> : <div className="session-grid">{sessions.map((session) => <SessionCard key={session.id} session={session} />)}</div>}
    </div>
  );
}
