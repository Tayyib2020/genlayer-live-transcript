import "./env.js";
import cors from "cors";
import express from "express";
import http from "node:http";
import sessionsRouter from "./routes/sessions.js";
import authRouter from "./routes/auth.js";
import { requireTrustedOrigin } from "./auth/auth.js";
import { attachAudioWebSocketServer } from "./websocket/audioServer.js";

const app = express();
const port = Number.parseInt(process.env.SERVER_PORT ?? "3001", 10);
const clientOrigin = process.env.CLIENT_ORIGIN ?? "http://localhost:5173";

function safeErrorDetails(error) {
  const sanitize = (value) => typeof value === "string"
    ? value
      .replace(/0x[0-9a-f]{64}/gi, "[redacted-hash]")
      .replace(/(private[_ -]?key|authorization|database_url|api[_ -]?key)[^\s:]*/gi, "[redacted-secret]")
      .slice(0, 500)
    : value;
  return {
    name: error?.name,
    code: error?.code,
    message: sanitize(error?.message || "No error message available"),
    detail: sanitize(error?.detail),
    hint: sanitize(error?.hint),
    severity: sanitize(error?.severity),
  };
}

app.disable("x-powered-by");
app.use(cors({ origin: clientOrigin, credentials: true }));
app.use(express.json({ limit: "64kb" }));
app.use(requireTrustedOrigin);

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, service: "genlayer-live-transcript-server" });
});

app.use("/api/auth", authRouter);
app.use("/api/sessions", sessionsRouter);

app.use((error, _request, response, _next) => {
  console.error("Unhandled server error:", safeErrorDetails(error));
  response.status(500).json({ error: "The server could not complete the request" });
});

const httpServer = http.createServer(app);
attachAudioWebSocketServer(httpServer);

httpServer.listen(port, () => {
  console.log(`Transcript server listening on http://localhost:${port}`);
});
