import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { createAudioStreamBridge } from "../audioStream.js";
import StatusPill from "../components/StatusPill.jsx";
import TranscriptPanel from "../components/TranscriptPanel.jsx";

const SUPPORT_MESSAGE = "Live tab-audio transcription currently requires a desktop Chromium-based browser.";
const NO_AUDIO_MESSAGE = 'No audio track was shared. Select the livestream tab and enable "Share tab audio".';

function formatDuration(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function shareErrorMessage(error) {
  switch (error?.name) {
    case "NotAllowedError":
      return "The browser share picker was cancelled or permission was denied. Choose the livestream tab and enable \"Share tab audio\".";
    case "AbortError":
      return "The browser share picker was cancelled. No audio was captured.";
    case "NotSupportedError":
      return SUPPORT_MESSAGE;
    case "NotReadableError":
      return "The selected source could not be read. Close other capture tools and try again.";
    case "InvalidStateError":
      return "The share picker could not open because this page is not active. Focus the live workspace and try again.";
    default:
      return "The browser could not start tab-audio sharing. Check the selected tab and try again.";
  }
}

function stopTracks(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

function formatBytes(bytes) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function captureStateLabel(state) {
  return {
    idle: "Ready to share",
    starting: "Starting capture",
    connecting: "Connecting stream",
    connected: "Stream connected",
    streaming: "Streaming audio",
    reconnecting: "Reconnecting",
    disconnected: "Stream disconnected",
    stopping: "Saving stop state",
    stopped: "Not sharing",
    error: "Attention needed",
  }[state] ?? "Ready to share";
}

function transcriptionStatusLabel(status) {
  return {
    waiting: "Waiting for speech",
    connecting: "Connecting transcription",
    transcribing: "Transcribing",
    available: "Transcript available",
    unavailable: "Transcription unavailable",
    error: "Transcription error",
  }[status] ?? "Waiting for speech";
}

export default function LiveSessionPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState(null);
  const [error, setError] = useState(null);
  const [captureState, setCaptureState] = useState("idle");
  const [captureMessage, setCaptureMessage] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [clientDiagnostics, setClientDiagnostics] = useState({ chunksSent: 0, bytesSent: 0 });
  const [serverDiagnostics, setServerDiagnostics] = useState({ chunksReceived: 0, bytesReceived: 0 });
  const [streamMetadata, setStreamMetadata] = useState({ mimeType: null, chunkIntervalMs: null });
  const [transcriptSegments, setTranscriptSegments] = useState([]);
  const [derivative, setDerivative] = useState(null);
  const [processingEligibility, setProcessingEligibility] = useState({ eligible: false, reason: "loading" });
  const [interimTranscript, setInterimTranscript] = useState("");
  const [transcriptionState, setTranscriptionState] = useState("waiting");
  const [transcriptionMessage, setTranscriptionMessage] = useState("");
  const [isCompleting, setIsCompleting] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processError, setProcessError] = useState("");
  const streamRef = useRef(null);
  const audioTrackRef = useRef(null);
  const audioBridgeRef = useRef(null);
  const trackEndedHandlerRef = useRef(null);
  const timerRef = useRef(null);
  const captureStartedAtRef = useRef(null);
  const captureActiveRef = useRef(false);
  const sessionStartedRef = useRef(false);
  const stopRequestRef = useRef(null);
  const endedBeforeActiveRef = useRef(false);

  const supportsDisplayCapture = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getDisplayMedia);

  useEffect(() => {
    api.getSession(id).then((data) => {
      setSession(data.session);
      setTranscriptSegments(data.transcript ?? []);
      setDerivative(data.derivative ?? null);
      setProcessingEligibility(data.processing ?? { eligible: false, reason: "unavailable" });
      if (data.transcript?.length) setTranscriptionState("available");
    }).catch((err) => setError(err.message));
  }, [id]);

  const clearTimer = useCallback(() => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const cleanupStream = useCallback(() => {
    audioBridgeRef.current?.stop();
    audioBridgeRef.current = null;
    const audioTrack = audioTrackRef.current;
    if (audioTrack && trackEndedHandlerRef.current) {
      audioTrack.removeEventListener("ended", trackEndedHandlerRef.current);
    }
    stopTracks(streamRef.current);
    streamRef.current = null;
    audioTrackRef.current = null;
    trackEndedHandlerRef.current = null;
    captureActiveRef.current = false;
    captureStartedAtRef.current = null;
    endedBeforeActiveRef.current = false;
    clearTimer();
  }, [clearTimer]);

  const persistStop = useCallback(() => {
    if (stopRequestRef.current) return stopRequestRef.current;
    if (!sessionStartedRef.current) return Promise.resolve(null);

    sessionStartedRef.current = false;
    stopRequestRef.current = api.stopSession(id)
      .then((response) => {
        setSession(response.session);
        return response;
      })
      .finally(() => {
        stopRequestRef.current = null;
      });

    return stopRequestRef.current;
  }, [id]);

  const finishCapture = useCallback(async (reason) => {
    const wasActive = captureActiveRef.current;
    const shouldStopPersistedSession = wasActive && sessionStartedRef.current;
    if (!wasActive) return;

    cleanupStream();
    setInterimTranscript("");
    setCaptureState("stopping");
    setCaptureMessage(
      reason === "manual"
        ? "Audio sharing stopped locally. Saving the session state."
        : reason === "stream-error"
          ? "Audio streaming stopped. Saving the session state."
        : "The browser source stopped. Saving the session state.",
    );

    if (shouldStopPersistedSession) {
      try {
        await persistStop();
        setCaptureState("stopped");
        setCaptureMessage(reason === "stream-error"
          ? "Audio streaming stopped and the session state is saved."
          : "Audio sharing stopped. The captured stream has been cleaned up and the session state is saved.");
      } catch (stopError) {
        setCaptureState("error");
        setCaptureMessage(`Audio sharing stopped locally, but the persisted session state could not be updated: ${stopError.message}`);
      }
    }
  }, [cleanupStream, persistStop]);

  const handleShare = async () => {
    if (session?.status !== "created") {
      setCaptureState("error");
      setCaptureMessage("This session is no longer open for audio capture.");
      return;
    }
    setCaptureMessage(null);
    setCaptureState("starting");
    setElapsedSeconds(0);
    setClientDiagnostics({ chunksSent: 0, bytesSent: 0 });
    setServerDiagnostics({ chunksReceived: 0, bytesReceived: 0 });
    setStreamMetadata({ mimeType: null, chunkIntervalMs: null });
    setInterimTranscript("");
    setTranscriptionState("waiting");
    setTranscriptionMessage("");

    if (!supportsDisplayCapture) {
      setCaptureState("error");
      setCaptureMessage(SUPPORT_MESSAGE);
      return;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (shareError) {
      setCaptureState("error");
      setCaptureMessage(shareErrorMessage(shareError));
      return;
    }

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      stopTracks(stream);
      setCaptureState("error");
      setCaptureMessage(NO_AUDIO_MESSAGE);
      return;
    }

    stream.getVideoTracks().forEach((track) => track.stop());
    const audioTrack = audioTracks[0];
    const onTrackEnded = () => {
      if (captureActiveRef.current) {
        void finishCapture("source-ended");
      } else {
        endedBeforeActiveRef.current = true;
      }
    };

    streamRef.current = stream;
    audioTrackRef.current = audioTrack;
    trackEndedHandlerRef.current = onTrackEnded;
    audioTrack.addEventListener("ended", onTrackEnded);

    try {
      const response = await api.startSession(id);
      sessionStartedRef.current = true;
      setSession(response.session);

      if (endedBeforeActiveRef.current || audioTrack.readyState === "ended") {
        cleanupStream();
        await persistStop().catch(() => {});
        setCaptureState("error");
        setCaptureMessage("The selected source ended before listening could start. Choose the livestream tab and try again.");
        return;
      }

      captureActiveRef.current = true;
      captureStartedAtRef.current = Date.now();
      setCaptureState("connecting");
      setCaptureMessage("Connecting the captured audio to the session WebSocket.");
      timerRef.current = window.setInterval(() => {
        setElapsedSeconds(Math.floor((Date.now() - captureStartedAtRef.current) / 1_000));
      }, 1_000);

      const audioBridge = createAudioStreamBridge({
        sessionId: id,
        mediaStream: stream,
        onState: ({ state, message }) => {
          setCaptureState(state);
          if (message) setCaptureMessage(message);
        },
        onClientDiagnostics: setClientDiagnostics,
        onServerDiagnostics: setServerDiagnostics,
        onMetadata: setStreamMetadata,
        onError: setCaptureMessage,
        onTranscriptionStatus: ({ status, message }) => {
          setTranscriptionState(status);
          setTranscriptionMessage(message ?? "");
        },
        onTranscript: (event) => {
          if (event.isFinal) {
            const segment = event.segment ?? event;
            setTranscriptSegments((current) => current.some((item) => (item.id && item.id === segment.id) || (item.dedupeKey && item.dedupeKey === segment.dedupeKey)) ? current : [...current, segment]);
            setInterimTranscript("");
            setTranscriptionState("available");
          } else {
            setInterimTranscript(event.text ?? "");
          }
        },
        onFatalError: () => void finishCapture("stream-error"),
      });
      audioBridgeRef.current = audioBridge;
      audioBridge.start();
    } catch (startError) {
      cleanupStream();
      setCaptureState("error");
      setCaptureMessage(`Audio was shared, but the session could not be started: ${startError.message}`);
    }
  };

  const handleComplete = async () => {
    if (session?.status !== "created" || captureActiveRef.current || isCompleting) return;
    setIsCompleting(true);
    setCaptureMessage("Saving the completed session state.");
    try {
      const response = await api.completeSession(id);
      setSession(response.session);
      setCaptureState("stopped");
      setCaptureMessage("Session completed. Its finalized transcript is now immutable.");
      const refreshed = await api.getSession(id);
      setDerivative(refreshed.derivative ?? null);
      setProcessingEligibility(refreshed.processing ?? { eligible: false, reason: "unavailable" });
    } catch (completionError) {
      setCaptureState("error");
      setCaptureMessage(`The session could not be completed: ${completionError.message}`);
    } finally {
      setIsCompleting(false);
    }
  };

  const processCompletedSession = async () => {
    if (!session || session.status !== "completed" || isProcessing || !processingEligibility.eligible) return;
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

  useEffect(() => () => {
    const shouldStopPersistedSession = sessionStartedRef.current;
    cleanupStream();
    if (shouldStopPersistedSession) void persistStop().catch(() => {});
  }, [cleanupStream, finishCapture, id, persistStop]);

  if (error) return <div className="container page-stack"><div className="state-card error-state"><span className="state-icon">!</span><div><h2>Session unavailable</h2><p>{error}</p></div><Link className="button button-secondary" to="/archive">Back to archive</Link></div></div>;
  if (!session) return <div className="container page-stack"><div className="loading-card">Loading session…</div></div>;

  const activeCaptureStates = ["connecting", "connected", "streaming", "reconnecting"];
  const visibleStatus = activeCaptureStates.includes(captureState)
    ? "live"
    : ["processing", "completed", "failed"].includes(session.status)
      ? session.status
      : "created";
  const isCaptureActive = activeCaptureStates.includes(captureState);
  const isStarting = captureState === "starting";
  const captureMessageIsError = ["error", "reconnecting", "disconnected"].includes(captureState);

  return (
    <div className="container page-stack">
      <div className="session-topline"><Link className="back-link" to="/archive">← Archive</Link><StatusPill status={visibleStatus} /></div>
      <section className="workspace-card">
        <div className="workspace-header"><div><p className="eyebrow">Session workspace</p><h1>{session.title}</h1><p className="muted">Created {new Date(session.createdAt).toLocaleString()}</p></div><div className="phase-stamp">PHASE 5<br /><strong>SESSION COMPLETION</strong></div></div>
        <div className="capture-workspace">
          <div className={`capture-status capture-status-${captureState}`} role="status" aria-live="polite"><span className="capture-status-dot" />{captureStateLabel(captureState)}</div>
          <div className="capture-duration"><span>Elapsed duration</span><strong>{formatDuration(elapsedSeconds)}</strong></div>
          <h2>{session.status === "completed" ? "This session is complete." : isCaptureActive ? "Tab audio is being streamed." : "Share the livestream tab audio."}</h2>
          <p className="capture-lede">Signal Ledger sends browser-provided WebM/Opus chunks to the server, which forwards them to the configured speech-to-text provider. Stop sharing first, then complete the session to make its persisted finalized transcript immutable.</p>
          <div className="capture-instructions"><strong>Before sharing</strong><ol><li>Open the livestream or X Space in another browser tab.</li><li>Choose that tab in the native share-picker.</li><li>Enable <b>Share tab audio</b> before confirming.</li></ol></div>
          {!supportsDisplayCapture && <div className="capture-message capture-message-error" role="alert">{SUPPORT_MESSAGE}</div>}
          {captureMessage && supportsDisplayCapture && <div className={`capture-message ${captureMessageIsError ? "capture-message-error" : "capture-message-success"}`} role={captureMessageIsError ? "alert" : "status"}>{captureMessage}</div>}
          <div className="stream-diagnostics" aria-label="Audio stream diagnostics">
            <div><span>WebSocket</span><strong>{captureStateLabel(captureState)}</strong></div>
            <div><span>Chunks sent</span><strong>{clientDiagnostics.chunksSent}</strong></div>
            <div><span>Bytes sent</span><strong>{formatBytes(clientDiagnostics.bytesSent)}</strong></div>
            <div><span>Chunks received</span><strong>{serverDiagnostics.chunksReceived}</strong></div>
            <div><span>Bytes received</span><strong>{formatBytes(serverDiagnostics.bytesReceived)}</strong></div>
            <div><span>Chunk format</span><strong>{streamMetadata.mimeType || "Pending"}</strong></div>
            <div><span>Chunk interval</span><strong>{streamMetadata.chunkIntervalMs ? `${streamMetadata.chunkIntervalMs} ms` : "Pending"}</strong></div>
            <div><span>Speech-to-text</span><strong>{transcriptionStatusLabel(transcriptionState)}</strong></div>
          </div>
          <div className="capture-actions">
            {session.status === "completed" && <div className="completion-locked"><strong>Session completed</strong><span>Audio capture and transcript changes are closed for this record.</span>{processError && <span className="capture-message capture-message-error" role="alert">{processError}</span>}{derivative?.summaryGenerationStatus === "generating" || isProcessing ? <span className="loading-copy" role="status" aria-live="polite"><span className="loading-spinner" aria-hidden="true" />Generating summary...</span> : derivative?.summaryGenerationStatus === "ready" ? <><span>Summary Ready</span><Link className="button button-primary" to={`/session/${id}`}>View summary</Link></> : processingEligibility.eligible ? <button className="button button-primary" type="button" onClick={() => void processCompletedSession()} disabled={isProcessing}>{derivative?.summaryGenerationStatus === "failed" ? "Retry Summary Generation" : "Generate Summary"}</button> : <span>{processingEligibility.reason === "no_finalized_transcript" ? "Summary generation is unavailable because no finalized transcript segments were persisted." : "Summary generation is not currently available for this session."}</span>}<Link className="button button-secondary" to={`/session/${id}`}>View completed record</Link></div>}
            {session.status !== "completed" && !isCaptureActive && <button className="button button-primary" onClick={handleShare} disabled={isStarting || isCompleting || captureState === "stopping" || !supportsDisplayCapture}>Share Tab Audio <span aria-hidden="true">↗</span></button>}
            {isCaptureActive && <button className="button button-secondary" onClick={() => void finishCapture("manual")}>Stop Sharing</button>}
            {session.status === "created" && !isCaptureActive && transcriptSegments.length > 0 && <button className="button button-complete" onClick={() => void handleComplete()} disabled={isCompleting || captureState === "starting" || captureState === "stopping"}>{isCompleting ? "Completing…" : "Complete Session"}</button>}
          </div>
          {session.status === "created" && captureState === "stopped" && transcriptSegments.length === 0 && <p className="completion-hint">Complete Session becomes available after a finalized transcript segment is saved.</p>}
          <p className="capture-support">Supported target: desktop Chromium-based browsers with tab-audio sharing. Mobile browsers and non-Chromium browsers are unsupported for this phase.</p>
        </div>
        <div className="workspace-footer"><span>Source URL</span><span>{session.sourceUrl || "Not provided"}</span></div>
      </section>
      <TranscriptPanel segments={transcriptSegments} interimText={interimTranscript} status={transcriptionState} statusMessage={transcriptionMessage} />
      <button className="text-link text-button" onClick={() => navigate(`/session/${id}`)}>View persisted session record <span aria-hidden="true">→</span></button>
    </div>
  );
}
