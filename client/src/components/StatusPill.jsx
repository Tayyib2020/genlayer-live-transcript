const labels = {
  created: "Created",
  live: "Live",
  processing: "Processing",
  completed: "Completed",
  failed: "Failed",
};

export default function StatusPill({ status = "created" }) {
  return <span className={`status-pill status-${status}`}><span className="status-dot" />{labels[status] ?? status}</span>;
}
