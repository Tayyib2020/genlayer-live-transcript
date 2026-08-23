const STATUS_LABELS = {
  waiting: "Waiting for speech",
  connecting: "Connecting transcription",
  transcribing: "Transcribing",
  available: "Transcript available",
  unavailable: "Transcription unavailable",
  error: "Transcription error",
};

function formatTimestamp(timestamp) {
  if (!timestamp) return "Time unavailable";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function TranscriptPanel({ segments = [], interimText = "", status = "waiting", statusMessage = "" }) {
  const label = STATUS_LABELS[status] ?? STATUS_LABELS.waiting;
  return (
    <section className="transcript-panel" aria-label="Live transcript">
      <div className="transcript-panel-header">
        <div>
          <p className="eyebrow">Transcript</p>
          <h2>Live transcript</h2>
        </div>
        <span className={`transcript-status transcript-status-${status}`}>{label}</span>
      </div>
      {statusMessage && <div className={`transcript-message transcript-message-${status}`} role={status === "error" || status === "unavailable" ? "alert" : "status"}>{statusMessage}</div>}
      <div className="transcript-scroll" aria-live="polite">
        {segments.map((segment, index) => (
          <article className="transcript-segment" key={segment.id ?? segment.dedupeKey ?? `${segment.timestamp}-${index}`}>
            <time dateTime={segment.timestamp}>{formatTimestamp(segment.timestamp)}</time>
            <p>{segment.text}</p>
          </article>
        ))}
        {interimText && (
          <article className="transcript-segment transcript-segment-interim">
            <time>Interim</time>
            <p>{interimText}</p>
          </article>
        )}
        {!segments.length && !interimText && <p className="transcript-empty">No finalized transcript has been produced yet.</p>}
      </div>
    </section>
  );
}
