import { WebSocket, WebSocketServer } from "ws";
import { pool } from "../db/pool.js";
import { persistFinalTranscriptSegment } from "../db/transcriptStore.js";
import { createDeepgramTranscriber } from "../transcription/deepgram.js";
import { parseSessionId } from "../utils/validation.js";

export const AUDIO_CHUNK_INTERVAL_MS = 1_000;
export const MAX_AUDIO_CHUNK_BYTES = 200 * 1_024;

const MAX_WEBSOCKET_PAYLOAD_BYTES = 256 * 1_024;
const DIAGNOSTICS_INTERVAL_MS = 2_000;
const LOG_INTERVAL_MS = 10_000;
const MIN_DECLARED_CHUNK_INTERVAL_MS = 250;
const MAX_DECLARED_CHUNK_INTERVAL_MS = 5_000;
const ALLOWED_MIME_TYPES = new Set([
  "audio/webm",
  "audio/webm;codecs=opus",
  "audio/ogg",
  "audio/ogg;codecs=opus",
]);

const connectionsBySession = new Map();

function safeErrorDetails(error) {
  return {
    name: error?.name,
    code: error?.code,
    message: error?.message || "No error message available",
  };
}

function upgradeError(socket, statusCode, message) {
  if (socket.destroyed) return;
  const body = `${message}\n`;
  socket.write(
    `HTTP/1.1 ${statusCode} Error\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  socket.destroy();
}

function closeWithPolicyError(socket, message) {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close(1008, message);
  }
}

function addConnection(sessionId, socket) {
  const connections = connectionsBySession.get(sessionId) ?? new Set();
  connections.add(socket);
  connectionsBySession.set(sessionId, connections);
}

function removeConnection(sessionId, socket) {
  const connections = connectionsBySession.get(sessionId);
  if (!connections) return;
  connections.delete(socket);
  if (connections.size === 0) connectionsBySession.delete(sessionId);
}

function sendJson(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function validAudioStartMessage(message) {
  if (!message || message.type !== "audio_start") return false;
  if (typeof message.mimeType !== "string" || message.mimeType.length > 100) return false;
  if (!ALLOWED_MIME_TYPES.has(message.mimeType)) return false;
  return Number.isInteger(message.chunkIntervalMs)
    && message.chunkIntervalMs >= MIN_DECLARED_CHUNK_INTERVAL_MS
    && message.chunkIntervalMs <= MAX_DECLARED_CHUNK_INTERVAL_MS;
}

async function validateSession(sessionId) {
  const result = await pool.query("SELECT id, status FROM sessions WHERE id = $1", [sessionId]);
  if (result.rowCount === 0) return { valid: false, statusCode: 404, message: "Session not found" };
  if (result.rows[0].status !== "live") return { valid: false, statusCode: 409, message: "Session is not active" };
  return { valid: true };
}

export function attachAudioWebSocketServer(httpServer) {
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
  });

  httpServer.on("upgrade", async (request, socket, head) => {
    let requestUrl;
    try {
      requestUrl = new URL(request.url, "http://localhost");
    } catch {
      upgradeError(socket, 400, "Invalid WebSocket request");
      return;
    }

    if (requestUrl.pathname !== "/ws/audio") {
      upgradeError(socket, 404, "WebSocket endpoint not found");
      return;
    }

    const sessionId = requestUrl.searchParams.get("sessionId");
    if (!sessionId || !parseSessionId(sessionId).success) {
      upgradeError(socket, 400, "A valid sessionId is required");
      return;
    }

    try {
      const validation = await validateSession(sessionId);
      if (!validation.valid) {
        upgradeError(socket, validation.statusCode, validation.message);
        return;
      }
    } catch (error) {
      console.error("Audio WebSocket session validation failed:", safeErrorDetails(error));
      upgradeError(socket, 500, "WebSocket session validation failed");
      return;
    }

    request.audioSessionId = sessionId;
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit("connection", client, request);
    });
  });

  webSocketServer.on("connection", (socket, request) => {
    const sessionId = request.audioSessionId;
    let streamStarted = false;
    let chunksReceived = 0;
    let bytesReceived = 0;
    let diagnosticsTimer;
    let logTimer;
    let transcriber = null;

    addConnection(sessionId, socket);
    console.log(`Audio WebSocket connected for session ${sessionId}`);

    const sendDiagnostics = () => {
      if (!streamStarted) return;
      sendJson(socket, {
        type: "diagnostics",
        chunksReceived,
        bytesReceived,
      });
    };

    diagnosticsTimer = setInterval(sendDiagnostics, DIAGNOSTICS_INTERVAL_MS);
    logTimer = setInterval(() => {
      if (streamStarted && chunksReceived > 0) {
        console.log(`Audio WebSocket diagnostics for session ${sessionId}: ${chunksReceived} chunks, ${bytesReceived} bytes`);
      }
    }, LOG_INTERVAL_MS);

    socket.on("message", (data, isBinary) => {
      if (!isBinary) {
        let message;
        try {
          message = JSON.parse(data.toString("utf8"));
        } catch {
          closeWithPolicyError(socket, "Invalid JSON message");
          return;
        }

        if (!validAudioStartMessage(message) || streamStarted) {
          closeWithPolicyError(socket, "Invalid audio stream start message");
          return;
        }

        streamStarted = true;
        sendJson(socket, {
          type: "stream_ready",
          mimeType: message.mimeType,
          chunkIntervalMs: AUDIO_CHUNK_INTERVAL_MS,
        });
        transcriber = createDeepgramTranscriber({
          onStatus: (status) => sendJson(socket, { type: "transcription_status", ...status }),
          onError: (message) => {
            sendJson(socket, {
              type: "transcription_status",
              status: "error",
              code: "provider_error",
              message,
            });
            console.error(`Transcription provider error for session ${sessionId}:`, { message });
          },
          onTranscript: async (event) => {
            if (!event.isFinal) {
              sendJson(socket, event);
              return;
            }

            try {
              const result = await persistFinalTranscriptSegment({
                sessionId,
                text: event.text,
                timestamp: event.timestamp,
                provider: event.provider,
                dedupeKey: event.dedupeKey,
                startSeconds: event.startSeconds,
                durationSeconds: event.durationSeconds,
              });
              if (result.inserted) sendJson(socket, { ...event, segment: result.segment });
            } catch (error) {
              console.error(`Transcript persistence failed for session ${sessionId}:`, safeErrorDetails(error));
              sendJson(socket, {
                type: "transcription_status",
                status: "error",
                code: "transcript_persistence_error",
                message: "A finalized transcript segment could not be saved.",
              });
            }
          },
        });
        return;
      }

      if (!streamStarted || !Buffer.isBuffer(data) || data.length === 0 || data.length > MAX_AUDIO_CHUNK_BYTES) {
        closeWithPolicyError(socket, "Invalid audio chunk");
        return;
      }

      chunksReceived += 1;
      bytesReceived += data.length;
      transcriber?.sendAudio(data);
    });

    socket.on("close", () => {
      clearInterval(diagnosticsTimer);
      clearInterval(logTimer);
      transcriber?.close();
      transcriber = null;
      removeConnection(sessionId, socket);
      console.log(`Audio WebSocket disconnected for session ${sessionId}: ${chunksReceived} chunks, ${bytesReceived} bytes`);
    });

    socket.on("error", (error) => {
      console.error(`Audio WebSocket error for session ${sessionId}:`, safeErrorDetails(error));
    });
  });

  return webSocketServer;
}

export function closeSessionAudioStreams(sessionId) {
  const connections = connectionsBySession.get(sessionId);
  if (!connections) return;
  for (const socket of connections) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(1000, "Session stopped");
    }
  }
}
