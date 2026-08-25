import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { api } from "../api.js";
import SessionCard from "../components/SessionCard.jsx";
import ErrorState from "../components/ErrorState.jsx";
import { useAuth } from "../auth.jsx";

const steps = [
  { number: "01", title: "Capture", copy: "Share the browser tab where a public livestream is playing." },
  { number: "02", title: "Transcribe", copy: "Turn the shared audio into a timestamped record with clear provenance." },
  { number: "03", title: "Verify with GenLayer", copy: "Submit the persisted transcript and summary to TranscriptVerifier and inspect the validator-backed result." },
];

export default function HomePage() {
  const { user } = useAuth();
  const [sessions, setSessions] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!user) {
      setSessions([]);
      setError(null);
      return undefined;
    }
    let active = true;
    api.listSessions("?status=completed&limit=3").then((data) => { if (active) setSessions(data.sessions); }).catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [user]);

  return (
    <div className="container page-stack">
      <section className="hero-section">
        <div className="hero-copy">
          <p className="eyebrow"><span className="eyebrow-dot" /> Community record layer</p>
          <h1>Turn live conversations into <em>records you can inspect.</em></h1>
          <p className="hero-lede">Signal Ledger captures public livestream audio, preserves the transcript, and prepares the evidence trail for summary-fidelity verification on GenLayer.</p>
          <div className="hero-actions">{user ? <Link className="button button-primary" to="/new">Start Live Transcript <span aria-hidden="true">↗</span></Link> : <Link className="button button-primary" to="/login">Sign in to start <span aria-hidden="true">↗</span></Link>}<Link className="button button-quiet" to="/archive">Browse archive <span aria-hidden="true">→</span></Link></div>
          <p className="hero-note"><span className="mini-lock">◌</span> No wallet required to create a session.</p>
        </div>
        <div className="hero-visual" aria-label="Evidence trail preview">
          <div className="signal-orbit orbit-one" /><div className="signal-orbit orbit-two" />
          <div className="hero-panel">
            <div className="hero-panel-header"><span>SESSION / PREVIEW</span><span className="live-caption">● READY</span></div>
            <div className="waveform" aria-hidden="true">{Array.from({ length: 28 }, (_, index) => <i key={index} style={{ height: `${18 + ((index * 17) % 62)}%` }} />)}</div>
            <div className="hero-panel-foot"><span>Transcript capture</span><span>Not finalized</span></div>
          </div>
        </div>
      </section>

      <section className="section-block">
        <div className="section-heading"><div><p className="eyebrow">The evidence path</p><h2>From shared audio to a reviewable record.</h2></div><p>Every stage has a distinct responsibility. The application stores the evidence; the Intelligent Contract evaluates semantic fidelity.</p></div>
        <div className="step-grid">{steps.map((step) => <article className="step-card" key={step.number}><span className="step-number">{step.number}</span><h3>{step.title}</h3><p>{step.copy}</p></article>)}</div>
      </section>

      <section className="section-block archive-preview">
        <div className="section-heading"><div><p className="eyebrow">Recent archive</p><h2>Completed sessions, when they exist.</h2></div><Link className="text-link" to="/archive">View all <span aria-hidden="true">→</span></Link></div>
        {!user ? <div className="empty-card"><span className="empty-mark">⌁</span><div><h3>Your archive is private.</h3><p>Sign in to view your completed Signal Ledger sessions.</p></div><Link className="button button-secondary" to="/login">Sign in</Link></div> : error ? <ErrorState message={error} /> : sessions.length === 0 ? <div className="empty-card"><span className="empty-mark">＋</span><div><h3>No sessions yet.</h3><p>Create a session to capture real browser-tab audio, preserve finalized speech-to-text segments, generate a summary, and verify its fidelity with GenLayer.</p></div><Link className="button button-secondary" to="/new">Create session</Link></div> : <div className="session-grid">{sessions.map((session) => <SessionCard key={session.id} session={session} />)}</div>}
      </section>
    </div>
  );
}
