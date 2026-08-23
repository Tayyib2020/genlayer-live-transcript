import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import StatusPill from "../components/StatusPill.jsx";
import TranscriptPanel from "../components/TranscriptPanel.jsx";

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "Not available";
}

export default function SessionPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState(null);
  const [transcript, setTranscript] = useState([]);
  const [derivative, setDerivative] = useState(null);
  const [verification, setVerification] = useState(null);
  const [verificationHistory, setVerificationHistory] = useState([]);
  const [processingEligibility, setProcessingEligibility] = useState({ eligible: false, reason: "loading" });
  const [error, setError] = useState(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processError, setProcessError] = useState("");
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [regenerationError, setRegenerationError] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);
  const [verificationError, setVerificationError] = useState("");
  const cancelDeleteRef = useRef(null);

  useEffect(() => {
    api.getSession(id).then((data) => {
      setSession(data.session);
      setTranscript(data.transcript ?? []);
      setDerivative(data.derivative ?? null);
      setVerification(data.verification ?? null);
      setVerificationHistory(data.verificationHistory ?? (data.verification ? [data.verification] : []));
      setProcessingEligibility(data.processing ?? { eligible: false, reason: "unavailable" });
    }).catch((requestError) => setError(requestError.message));
  }, [id]);

  useEffect(() => {
    if (!deleteOpen) return undefined;
    cancelDeleteRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !isDeleting) setDeleteOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleteOpen, isDeleting]);

  const confirmDelete = async () => {
    setIsDeleting(true);
    setDeleteError("");
    try {
      await api.deleteSession(id);
      navigate("/archive", { state: { message: "Session and its local persisted evidence were deleted. Any existing GenLayer transaction remains on-chain." } });
    } catch (requestError) {
      setDeleteError(requestError.message);
      setIsDeleting(false);
    }
  };

  const processSession = async () => {
    if (!session || session.status !== "completed" || isProcessing) return;
    setIsProcessing(true);
    setProcessError("");
    try {
      const response = await api.processSession(id);
      setDerivative(response.derivative ?? null);
      setProcessingEligibility(response.status === "generating" ? { eligible: false, reason: "summary_generating" } : { eligible: false, reason: "summary_ready" });
      if (response.status === "generating") {
        for (let attempt = 0; attempt < 30; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 2_000));
          const refreshed = await api.getSession(id);
          setDerivative(refreshed.derivative ?? null);
          setProcessingEligibility(refreshed.processing ?? { eligible: false, reason: "unavailable" });
          if (refreshed.derivative?.summaryGenerationStatus !== "generating") break;
        }
      }
    } catch (requestError) {
      setProcessError(requestError.message);
      const refreshed = await api.getSession(id).catch(() => null);
      if (refreshed) {
        setDerivative(refreshed.derivative ?? null);
        setProcessingEligibility(refreshed.processing ?? { eligible: false, reason: "unavailable" });
      }
    } finally {
      setIsProcessing(false);
    }
  };

  const regenerateSummary = async () => {
    if (!session || session.status !== "completed" || isRegenerating) return;
    setIsRegenerating(true);
    setRegenerationError("");
    try {
      const response = await api.regenerateSummary(id);
      setDerivative(response.derivative ?? null);
      if (response.status === "generating") {
        for (let attempt = 0; attempt < 30; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 2_000));
          const refreshed = await api.getSession(id);
          setDerivative(refreshed.derivative ?? null);
          setVerification(refreshed.verification ?? null);
          setVerificationHistory(refreshed.verificationHistory ?? []);
          if (refreshed.derivative?.summaryGenerationStatus !== "generating") break;
        }
      }
    } catch (requestError) {
      setRegenerationError(requestError.message);
      const refreshed = await api.getSession(id).catch(() => null);
      if (refreshed) {
        setDerivative(refreshed.derivative ?? null);
        setVerification(refreshed.verification ?? null);
        setVerificationHistory(refreshed.verificationHistory ?? []);
      }
    } finally {
      setIsRegenerating(false);
    }
  };

  const refreshVerification = async () => {
    const response = await api.getVerification(id);
    setVerification(response.verification ?? null);
    setVerificationHistory(response.verificationHistory ?? (response.verification ? [response.verification] : []));
    return response.verification ?? null;
  };

  const verifySession = async () => {
    if (!session || session.status !== "completed" || !derivative || derivative.summaryGenerationStatus !== "ready" || isVerifying) return;
    setIsVerifying(true);
    setVerificationError("");
    try {
      const response = await api.verifySession(id);
      let current = response.verification ?? null;
      setVerification(current);
      setVerificationHistory(response.verificationHistory ?? (current ? [current] : []));
      for (let attempt = 0; current && ["submitting", "pending"].includes(current.verificationStatus) && attempt < 90; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 3_000));
        current = await refreshVerification();
      }
    } catch (requestError) {
      setVerificationError(requestError.message);
      await refreshVerification().catch(() => {});
    } finally {
      setIsVerifying(false);
    }
  };

  if (error) return <div className="container page-stack"><div className="state-card error-state"><span className="state-icon">!</span><div><h2>Record unavailable</h2><p>{error}</p></div><Link className="button button-secondary" to="/archive">Back to archive</Link></div></div>;
  if (!session) return <div className="container page-stack"><div className="loading-card">Loading record…</div></div>;

  const isCompleted = session.status === "completed";
  const transcriptAvailable = transcript.some((segment) => segment.isFinal);
  const transcriptStatus = transcriptAvailable ? "available" : isCompleted ? "unavailable" : "waiting";
  const transcriptMessage = isCompleted && !transcriptAvailable ? "No finalized transcript segments are available for this completed session." : "";
  const summaryStatus = derivative?.summaryGenerationStatus ?? "not_started";
  const visibleSummaryStatus = isProcessing ? "generating" : summaryStatus;
  const summaryStatusLabel = { not_started: "Not generated", generating: "Generating", ready: "Summary Ready", failed: "Failed" }[visibleSummaryStatus] ?? visibleSummaryStatus;
  const canProcess = processingEligibility.eligible && !isProcessing;
  const summaryAttempts = derivative?.summaryAttempts ?? [];
  const latestSummaryAttempt = summaryAttempts.at(-1) ?? null;
  const latestVerification = verificationHistory.at(-1) ?? verification;
  const latestAttemptVerification = latestSummaryAttempt
    ? verificationHistory.find((item) => item.summaryAttemptId === latestSummaryAttempt.id) ?? null
    : latestVerification;
  const latestVerificationIsRejected = latestAttemptVerification?.verificationStatus === "rejected";
  const canVerify = isCompleted && derivative?.summaryGenerationStatus === "ready" && Boolean(latestSummaryAttempt) && !latestAttemptVerification && !isVerifying;
  const displayedVerification = latestAttemptVerification;
  const verificationStatus = displayedVerification?.verificationStatus ?? "not_started";
  const contractExplorerUrl = displayedVerification?.contractAddress ? `https://explorer-bradbury.genlayer.com/address/${displayedVerification.contractAddress}` : null;

  return (
    <div className="container page-stack narrow-page">
      <div className="session-topline"><Link className="back-link" to="/archive">← Archive</Link><StatusPill status={session.status} /></div>
      <section className="record-header"><p className="eyebrow">Persisted session record</p><h1>{session.title}</h1><p>{session.sourceUrl || "No source URL was supplied."}</p></section>
      <div className={`notice-card ${isCompleted ? "completed-notice" : ""}`}><span className="info-icon">{isCompleted ? "✓" : "i"}</span><div><strong>{isCompleted ? "Completed session" : "Phase 5 session record"}</strong><p>{isCompleted ? "This session is complete and immutable. The transcript below is reconstructed only from finalized segments persisted in PostgreSQL." : "This record displays only transcript segments actually persisted from the speech-to-text stream. Complete the session after stopping audio to make the record immutable."}</p></div></div>
      <TranscriptPanel segments={transcript} status={transcriptStatus} statusMessage={transcriptMessage} />
      <section className="derived-panel" aria-labelledby="integrity-heading">
        <div className="derived-panel-header"><div><p className="eyebrow">Integrity</p><h2 id="integrity-heading">Canonical transcript</h2></div><span className="derived-status">{derivative ? "Persisted" : "Not generated"}</span></div>
        {derivative ? <>
          <p className="derived-copy">This SHA-256 identifies the exact canonical transcript representation submitted to TranscriptVerifier when verification is requested.</p>
          <div className="hash-value"><span>SHA-256 transcript hash</span><code>{derivative.transcriptHash}</code></div>
          <pre className="canonical-transcript">{derivative.canonicalTranscript}</pre>
        </> : <p className="derived-copy">Complete transcript processing to create the deterministic canonical transcript and SHA-256 hash.</p>}
      </section>
      <section className="derived-panel summary-panel" aria-labelledby="summary-heading">
        <div className="derived-panel-header"><div><p className="eyebrow">Off-chain summary</p><h2 id="summary-heading">Summary</h2></div><span className={`derived-status derived-status-${summaryStatus}`}>{summaryStatusLabel}</span></div>
        {processError && <div className="capture-message capture-message-error" role="alert">{processError}</div>}
        {regenerationError && <div className="capture-message capture-message-error" role="alert">{regenerationError}</div>}
        <div aria-live="polite">
        {visibleSummaryStatus === "ready" && derivative?.summary ? <>
          <p className="summary-text">{derivative.summary}</p>
          {derivative.topics?.length > 0 && <div className="summary-list"><strong>Key topics</strong><ul>{derivative.topics.map((topic) => <li key={topic}>{topic}</li>)}</ul></div>}
          {derivative.announcements?.length > 0 && <div className="summary-list"><strong>Announcements</strong><ul>{derivative.announcements.map((announcement) => <li key={announcement}>{announcement}</li>)}</ul></div>}
          {derivative.questionsAnswers?.length > 0 && <div className="summary-list"><strong>Questions and answers</strong>{derivative.questionsAnswers.map((item, index) => <div className="qa-item" key={`${item.question}-${index}`}><b>Q: {item.question}</b><p>A: {item.answer}</p></div>)}</div>}
        </> : visibleSummaryStatus === "failed" ? <p className="derived-copy">Summary generation failed: {derivative?.summaryError || "No error details were available."}</p> : visibleSummaryStatus === "generating" ? <p className="derived-copy loading-copy"><span className="loading-spinner" aria-hidden="true" />{isRegenerating ? "Generating new summary..." : "Generating summary..."} Analyzing the completed transcript.</p> : <p className="derived-copy">No summary has been generated yet. The summary will use only the canonical transcript above.</p>}
        </div>
        {isCompleted && !transcriptAvailable && <p className="derived-copy">Summary processing is unavailable because this session has no finalized transcript segments.</p>}
        {canProcess && <button className="button button-primary" type="button" onClick={() => void processSession()}>{summaryStatus === "failed" ? "Retry Summary Generation" : "Generate Summary"}</button>}
        {latestVerificationIsRejected && latestSummaryAttempt?.summaryGenerationStatus === "ready" && <button className="button button-primary" type="button" onClick={() => void regenerateSummary()} disabled={isRegenerating}>{isRegenerating ? "Generating new summary..." : "Regenerate Summary"}</button>}
        {summaryAttempts.length > 1 && <div className="summary-attempt-history" aria-label="Summary attempt history"><strong>Summary attempts</strong>{summaryAttempts.map((attempt) => <div className="summary-attempt-row" key={attempt.id}><span>Attempt {attempt.attemptNumber}</span><span>{attempt.summaryGenerationStatus === "ready" ? "Summary Ready" : attempt.summaryGenerationStatus}</span><code>{attempt.summaryHash || "No summary hash"}</code></div>)}</div>}
      </section>
      <section className="derived-panel verification-panel" aria-labelledby="verification-heading">
        <div className="derived-panel-header"><div><p className="eyebrow">GenLayer Bradbury</p><h2 id="verification-heading">Summary-fidelity verification</h2></div><span className={`derived-status derived-status-${verificationStatus}`}>{verificationStatus.replace("_", " ")}</span></div>
        {verificationError && <div className="capture-message capture-message-error" role="alert">{verificationError}</div>}
        {verificationStatus === "not_started" && <>
          <p className="derived-copy">GenLayer verification has not been submitted yet.</p>
          {canVerify && <button className="button button-primary" type="button" onClick={() => void verifySession()}>{latestSummaryAttempt?.attemptNumber > 1 ? "Verify New Summary with GenLayer" : "Verify with GenLayer"}</button>}
          {isCompleted && !derivative?.summary && <p className="derived-copy">Generate a ready summary before submitting verification.</p>}
        </>}
        {(verificationStatus === "submitting" || verificationStatus === "pending") && <p className="derived-copy loading-copy" role="status" aria-live="polite"><span className="loading-spinner" aria-hidden="true" />{verificationStatus === "submitting" ? "Submitting to GenLayer..." : "Waiting for validator consensus..."}<br />Sending the canonical transcript and generated summary to TranscriptVerifier on Bradbury.</p>}
        {verificationStatus === "accepted" && <div className="verification-result verification-result-accepted"><strong>GenLayer Verified</strong><b>ACCEPTED</b><p>GenLayer validators determined that the generated summary faithfully represents the submitted canonical transcript.</p></div>}
        {verificationStatus === "rejected" && <div className="verification-result verification-result-rejected"><strong>Summary Rejected</strong><b>REJECTED</b><p>{displayedVerification.reason || "GenLayer validators determined that the generated summary did not faithfully represent the submitted canonical transcript."}</p></div>}
        {verificationStatus === "failed" && <>
          <div className="capture-message capture-message-error" role="alert">Verification failed: {displayedVerification.error || "No safe error details were returned."}</div>
          {displayedVerification.retryable && <button className="button button-primary" type="button" onClick={() => void verifySession()} disabled={isVerifying}>Retry Verification</button>}
          {!displayedVerification.retryable && <p className="derived-copy">A transaction already exists for this attempt, so automatic resubmission is disabled. Refresh to retry reading its evidence.</p>}
        </>}
        {displayedVerification && <div className="verification-evidence">
          <div className="hash-value"><span>Transcript SHA-256</span><code>{displayedVerification.transcriptHash}</code></div>
          <dl className="metadata-list verification-metadata">
            <div><dt>Summary attempt</dt><dd>{displayedVerification.summaryAttemptNumber ?? "Legacy"}</dd></div>
            <div><dt>Contract</dt><dd>{contractExplorerUrl ? <a className="text-link" href={contractExplorerUrl} target="_blank" rel="noreferrer">{displayedVerification.contractAddress} ↗</a> : displayedVerification.contractAddress}</dd></div>
            <div><dt>Network</dt><dd>{displayedVerification.network}</dd></div>
            <div><dt>Transaction hash</dt><dd>{displayedVerification.transactionHash || "Pending submission"}</dd></div>
            {displayedVerification.reason && <div><dt>Validator reason</dt><dd>{displayedVerification.reason}</dd></div>}
            {displayedVerification.completedAt && <div><dt>Verified at</dt><dd>{formatDate(displayedVerification.completedAt)}</dd></div>}
          </dl>
        </div>}
        {verificationHistory.length > 0 && <div className="verification-history" aria-label="Verification history"><h3>Verification history</h3>{verificationHistory.map((item) => <div className={`verification-history-item verification-history-${item.verificationStatus}`} key={item.id ?? `${item.summaryAttemptNumber}-${item.verificationId}`}><div><strong>Attempt {item.summaryAttemptNumber ?? "Legacy"}</strong><span>{item.contractStatus ?? item.verificationStatus}</span></div><code>Summary hash: {item.summaryHash || "Not available"}</code>{item.transactionHash && <code>Transaction: {item.transactionHash}</code>}{item.reason && <p>{item.reason}</p>}</div>)}</div>}
      </section>
      <dl className="metadata-list">
        <div><dt>Status</dt><dd><StatusPill status={session.status} /></dd></div>
        <div><dt>Created</dt><dd>{formatDate(session.createdAt)}</dd></div>
        <div><dt>Completed</dt><dd>{formatDate(session.completedAt)}</dd></div>
        <div><dt>Transcript</dt><dd>{transcriptAvailable ? `Available — ${transcript.length} finalized segment${transcript.length === 1 ? "" : "s"}` : "Unavailable — no finalized segments"}</dd></div>
        <div><dt>Verification</dt><dd>{latestVerification?.contractStatus ?? "Not submitted"}</dd></div>
      </dl>
      <div className="record-actions">
        {!isCompleted && <Link className="button button-secondary" to={`/session/${id}/live`}>Open live workspace</Link>}
        <button className="button button-danger" type="button" onClick={() => { setDeleteError(""); setDeleteOpen(true); }}>Delete Session</button>
      </div>

      {deleteOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !isDeleting) setDeleteOpen(false); }}>
        <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-session-title" aria-describedby="delete-session-description">
          <p className="eyebrow">Permanent action</p>
          <h2 id="delete-session-title">Delete this session?</h2>
          <p id="delete-session-description">This will permanently remove the session and every persisted transcript segment. This action cannot be undone.</p>
          {deleteError && <div className="capture-message capture-message-error" role="alert">The session was not deleted: {deleteError}</div>}
          <div className="confirm-actions">
            <button ref={cancelDeleteRef} className="button button-secondary" type="button" onClick={() => setDeleteOpen(false)} disabled={isDeleting}>Cancel</button>
            <button className="button button-danger" type="button" onClick={() => void confirmDelete()} disabled={isDeleting}>{isDeleting ? "Deleting…" : "Delete permanently"}</button>
          </div>
        </div>
      </div>}
    </div>
  );
}
