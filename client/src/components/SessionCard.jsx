import { Link } from "react-router-dom";
import StatusPill from "./StatusPill.jsx";

function formatDate(value) {
  if (!value) return "Date not set";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

export default function SessionCard({ session }) {
  const dateLabel = session.status === "completed" ? `Completed ${formatDate(session.completedAt)}` : formatDate(session.createdAt);
  return (
    <Link className="session-card" to={`/session/${session.id}`}>
      <div className="session-card-top"><StatusPill status={session.status} /><span>{dateLabel}</span></div>
      <h3>{session.title}</h3>
      <p>{session.sourceUrl || "Browser-captured source"}</p>
      <span className="text-link">Open record <span aria-hidden="true">→</span></span>
    </Link>
  );
}
