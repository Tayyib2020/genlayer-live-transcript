export const AUDIO_CHUNK_INTERVAL_MS = 1_000;
export const MAX_RECONNECT_ATTEMPTS = 2;

const RECONNECT_DELAYS_MS = [500, 1_000];
const MIME_TYPE_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
];

function webSocketUrl(sessionId) {
  const configuredBase = import.meta.env.VITE_WS_BASE_URL?.replace(/\/$/, "");
  const base = configuredBase || `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;
  return `${base}/ws/audio?sessionId=${encodeURIComponent(sessionId)}`;
}

function preferredMimeType() {
  if (typeof MediaRecorder === "undefined") return null;
  return MIME_TYPE_CANDIDATES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? null;
}

export function createAudioStreamBridge({
  sessionId,
  mediaStream,
  onState,
  onClientDiagnostics,
  onServerDiagnostics,
  onMetadata,
  onError,
  onTranscript,
  onTranscriptionStatus,
  onFatalError,
}) {
  let socket = null;
  let recorder = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let closed = false;
  let intentionalStop = false;
  let fatalErrorReported = false;
  let chunksSent = 0;
  let bytesSent = 0;
  let mimeType = null;

  function setState(state, message = "") {
    onState?.({ state, message });
  }

  function stopRecorder() {
    if (!recorder) return;
    recorder.ondataavailable = null;
    recorder.onerror = null;
    if (recorder.state !== "inactive") recorder.stop();
    recorder = null;
  }

  function reportFatal(message) {
    if (fatalErrorReported || closed) return;
    fatalErrorReported = true;
    setState("error", message);
    onFatalError?.(message);
  }

  function startRecorder() {
    if (typeof MediaRecorder === "undefined") {
      reportFatal("This browser does not provide MediaRecorder audio chunking.");
      return false;
    }

    mimeType = preferredMimeType();
    try {
      recorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
      mimeType = recorder.mimeType || mimeType || "audio/webm";
      onMetadata?.({ mimeType, chunkIntervalMs: AUDIO_CHUNK_INTERVAL_MS });
      recorder.ondataavailable = (event) => {
        if (intentionalStop || closed || !event.data || event.data.size === 0) return;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          reportFatal("The WebSocket disconnected before an audio chunk could be sent.");
          return;
        }
        socket.send(event.data);
        chunksSent += 1;
        bytesSent += event.data.size;
        onClientDiagnostics?.({ chunksSent, bytesSent });
        setState("streaming");
      };
      recorder.onerror = () => reportFatal("The browser audio recorder encountered an error.");
      recorder.start(AUDIO_CHUNK_INTERVAL_MS);
      return true;
    } catch (error) {
      reportFatal(`The browser could not start audio chunking: ${error.message}`);
      return false;
    }
  }

  function sendAudioStart() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({
      type: "audio_start",
      mimeType: mimeType || preferredMimeType() || "audio/webm",
      chunkIntervalMs: AUDIO_CHUNK_INTERVAL_MS,
    }));
    return true;
  }

  function openSocket() {
    if (closed || intentionalStop) return;
    setState(reconnectAttempts > 0 ? "reconnecting" : "connecting");

    let currentSocket;
    try {
      currentSocket = new WebSocket(webSocketUrl(sessionId));
      currentSocket.binaryType = "arraybuffer";
    } catch (error) {
      reportFatal(`The WebSocket connection could not be created: ${error.message}`);
      return;
    }

    socket = currentSocket;
    currentSocket.onopen = () => {
      if (closed || intentionalStop || socket !== currentSocket) return;
      if (!sendAudioStart() || !startRecorder()) return;
      setState("connected", "WebSocket connected; waiting for the first audio chunk.");
    };

    currentSocket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === "diagnostics") onServerDiagnostics?.(message);
        if (message.type === "stream_ready") setState("connected");
        if (message.type === "transcription_status") onTranscriptionStatus?.(message);
        if (message.type === "transcript") onTranscript?.(message);
      } catch {
        onError?.("The backend sent an invalid diagnostics message.");
      }
    };

    currentSocket.onerror = () => {
      onError?.("The WebSocket encountered a connection error; checking for a reconnect.");
    };

    currentSocket.onclose = () => {
      if (socket !== currentSocket || intentionalStop || closed) return;
      socket = null;
      stopRecorder();
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delay = RECONNECT_DELAYS_MS[reconnectAttempts] ?? RECONNECT_DELAYS_MS.at(-1);
        reconnectAttempts += 1;
        setState("reconnecting", `WebSocket disconnected; retrying in ${delay} ms.`);
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          openSocket();
        }, delay);
      } else {
        setState("disconnected", "The WebSocket connection closed.");
        reportFatal("The WebSocket connection could not be restored. Audio streaming stopped.");
      }
    };
  }

  return {
    start() {
      openSocket();
    },
    stop(reason = "capture-stopped") {
      intentionalStop = true;
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      stopRecorder();
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        socket.close(1000, reason);
      }
      socket = null;
    },
  };
}
