import crypto from "node:crypto";
import { WebSocket } from "ws";

const DEEPGRAM_ENDPOINT = "wss://api.deepgram.com/v1/listen";
const MAX_PENDING_AUDIO_BYTES = 1 * 1024 * 1024;

function safeProviderErrorMessage(message) {
  if (message?.type === "Error") {
    const code = typeof message.err_code === "string" ? message.err_code : "";
    if (code.includes("AUTH") || code.includes("KEY")) {
      return "Transcription provider authentication failed. Check TRANSCRIPTION_API_KEY.";
    }
    return "The transcription provider returned an error while processing audio.";
  }
  return "The transcription provider connection failed.";
}

function makeDedupeKey({ text, startSeconds, durationSeconds }) {
  const source = [
    "deepgram",
    text,
    Number.isFinite(startSeconds) ? startSeconds.toFixed(3) : "unknown-start",
    Number.isFinite(durationSeconds) ? durationSeconds.toFixed(3) : "unknown-duration",
  ].join("|");
  return `deepgram:${crypto.createHash("sha256").update(source).digest("hex")}`;
}

export function parseDeepgramMessage(payload, timestamp = new Date().toISOString()) {
  let message;
  try {
    message = JSON.parse(payload.toString("utf8"));
  } catch {
    return { kind: "error", message: "The transcription provider returned malformed data." };
  }

  if (message?.type === "Error") {
    return { kind: "error", message: safeProviderErrorMessage(message) };
  }
  if (message?.type !== "Results") return { kind: "ignored" };

  const text = message.channel?.alternatives?.[0]?.transcript?.trim();
  if (!text) return { kind: "ignored" };

  const startSeconds = Number(message.start);
  const durationSeconds = Number(message.duration);
  const isFinal = message.is_final === true;
  return {
    kind: "transcript",
    event: {
      type: "transcript",
      text,
      isFinal,
      timestamp,
      provider: "deepgram",
      dedupeKey: makeDedupeKey({ text, startSeconds, durationSeconds }),
      startSeconds: Number.isFinite(startSeconds) ? startSeconds : null,
      durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
    },
  };
}

function currentConfig() {
  return {
    provider: (process.env.TRANSCRIPTION_PROVIDER ?? "").trim().toLowerCase(),
    apiKey: (process.env.TRANSCRIPTION_API_KEY ?? "").trim(),
  };
}

export function createDeepgramTranscriber({ onStatus, onTranscript, onError }) {
  const { provider, apiKey } = currentConfig();
  if (provider !== "deepgram") {
    onStatus?.({
      status: "unavailable",
      code: "provider_not_configured",
      message: "Transcription is unavailable until TRANSCRIPTION_PROVIDER=deepgram is configured.",
    });
    return null;
  }
  if (!apiKey) {
    onStatus?.({
      status: "unavailable",
      code: "api_key_missing",
      message: "Transcription is unavailable until TRANSCRIPTION_API_KEY is configured on the server.",
    });
    return null;
  }

  let closed = false;
  let closing = false;
  let closeTimer;
  let pendingAudio = [];
  let pendingAudioBytes = 0;
  let providerSocket;
  onStatus?.({ status: "connecting", message: "Connecting the transcription provider." });

  try {
    const query = new URLSearchParams({
      model: "nova-3",
      language: "en-US",
      interim_results: "true",
      endpointing: "300",
      smart_format: "true",
    });
    providerSocket = new WebSocket(`${DEEPGRAM_ENDPOINT}?${query.toString()}`, {
      headers: { Authorization: `Token ${apiKey}` },
    });
  } catch {
    onError?.("The transcription provider connection could not be created.");
    return null;
  }

  const flushPendingAudio = () => {
    if (!providerSocket || providerSocket.readyState !== WebSocket.OPEN) return;
    for (const chunk of pendingAudio) providerSocket.send(chunk);
    pendingAudio = [];
    pendingAudioBytes = 0;
  };

  providerSocket.on("open", () => {
    if (closed || closing) return;
    onStatus?.({ status: "transcribing", message: "Transcription provider connected; waiting for speech." });
    flushPendingAudio();
  });

  providerSocket.on("message", (payload) => {
    if (closed) return;
    const result = parseDeepgramMessage(payload);
    if (result.kind === "error") {
      onError?.(result.message);
      return;
    }
    if (result.kind === "transcript") void onTranscript?.(result.event);
  });

  providerSocket.on("error", () => {
    if (!closed) onError?.("The transcription provider connection failed.");
  });

  providerSocket.on("close", () => {
    closed = true;
    if (closeTimer) clearTimeout(closeTimer);
    if (!closing) onError?.("The transcription provider connection closed unexpectedly.");
  });

  return {
    sendAudio(chunk) {
      if (closed || closing || !Buffer.isBuffer(chunk)) return;
      if (providerSocket.readyState === WebSocket.OPEN) {
        providerSocket.send(chunk);
        return;
      }
      if (providerSocket.readyState !== WebSocket.CONNECTING) return;
      if (pendingAudioBytes + chunk.length > MAX_PENDING_AUDIO_BYTES) {
        onError?.("The transcription provider could not keep up with the audio stream.");
        return;
      }
      pendingAudio.push(chunk);
      pendingAudioBytes += chunk.length;
    },
    close() {
      if (closed || closing) return;
      closing = true;
      pendingAudio = [];
      pendingAudioBytes = 0;
      if (providerSocket.readyState === WebSocket.OPEN) {
        providerSocket.send(JSON.stringify({ type: "Finalize" }));
        closeTimer = setTimeout(() => {
          closed = true;
          providerSocket.close(1000, "Audio stream ended");
        }, 1_000);
      } else if (providerSocket.readyState === WebSocket.CONNECTING) {
        closed = true;
        providerSocket.close(1000, "Audio stream ended");
      }
    },
  };
}
