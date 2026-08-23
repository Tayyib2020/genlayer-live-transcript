import crypto from "node:crypto";
import express from "express";
import { pool } from "../db/pool.js";
import { completeSession, deleteSession } from "../db/sessionLifecycle.js";
import { getSessionDerivative, processCompletedSession, regenerateCompletedSession } from "../db/sessionProcessing.js";
import { getSessionVerification, getSessionVerificationHistory } from "../db/verificationStore.js";
import { refreshSessionVerification, submitSessionVerification } from "../genlayer/verificationLifecycle.js";
import { VerificationError, safeVerificationError } from "../genlayer/verificationLogic.js";
import { listTranscriptSegments } from "../db/transcriptStore.js";
import { createSessionSchema, parseSessionId } from "../utils/validation.js";
import { closeSessionAudioStreams } from "../websocket/audioServer.js";

const router = express.Router();

function mapSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    sourceUrl: row.source_url,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    completedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getProcessingEligibility(session, transcript, derivative) {
  if (session.status !== "completed") return { eligible: false, reason: "session_not_completed" };
  if (!transcript.some((segment) => segment.isFinal)) return { eligible: false, reason: "no_finalized_transcript" };
  if (derivative?.summaryGenerationStatus === "ready") return { eligible: false, reason: "summary_ready" };
  if (derivative?.summaryGenerationStatus === "generating") return { eligible: false, reason: "summary_generating" };
  return { eligible: true, reason: derivative?.summaryGenerationStatus === "failed" ? "retry_failed_summary" : "summary_not_generated" };
}

router.post("/", async (request, response, next) => {
  const parsed = createSessionSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({
      error: "Invalid session details",
      details: parsed.error.issues.map((issue) => issue.message),
    });
  }

  try {
    const { title, sourceUrl } = parsed.data;
    const result = await pool.query(
      `INSERT INTO sessions (id, title, source_url)
       VALUES ($1, $2, NULLIF($3, ''))
       RETURNING *`,
      [crypto.randomUUID(), title, sourceUrl ?? ""],
    );
    return response.status(201).json({ session: mapSession(result.rows[0]) });
  } catch (error) {
    return next(error);
  }
});

router.get("/", async (request, response, next) => {
  try {
    const requestedStatus = typeof request.query.status === "string" ? request.query.status : null;
    const limit = Math.min(Math.max(Number.parseInt(request.query.limit ?? "50", 10) || 50, 1), 100);
    const values = [];
    let where = "";

    if (requestedStatus) {
      values.push(requestedStatus);
      where = "WHERE status = $1";
    }

    values.push(limit);
    const result = await pool.query(
      `SELECT * FROM sessions ${where} ORDER BY created_at DESC LIMIT $${values.length}`,
      values,
    );
    return response.json({ sessions: result.rows.map(mapSession) });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id", async (request, response, next) => {
  const parsedId = parseSessionId(request.params.id);
  if (!parsedId.success) {
    return response.status(400).json({ error: "Session id must be a UUID" });
  }

  try {
    const result = await pool.query("SELECT * FROM sessions WHERE id = $1", [request.params.id]);
    if (result.rowCount === 0) return response.status(404).json({ error: "Session not found" });
    const [transcript, derivative, verification, verificationHistory] = await Promise.all([
      listTranscriptSegments(request.params.id),
      getSessionDerivative(request.params.id),
      getSessionVerification(request.params.id),
      getSessionVerificationHistory(request.params.id),
    ]);
    return response.json({
      session: mapSession(result.rows[0]),
      transcript,
      derivative,
      verification,
      verificationHistory,
      processing: getProcessingEligibility(result.rows[0], transcript, derivative),
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/:id/start", async (request, response, next) => {
  const parsedId = parseSessionId(request.params.id);
  if (!parsedId.success) return response.status(400).json({ error: "Session id must be a UUID" });

  try {
    const result = await pool.query(
      `UPDATE sessions
       SET status = 'live', started_at = COALESCE(started_at, NOW())
       WHERE id = $1 AND status = 'created'
       RETURNING *`,
      [request.params.id],
    );
    if (result.rowCount === 0) {
      return response.status(409).json({ error: "Session cannot be started from its current state" });
    }
    return response.json({ session: mapSession(result.rows[0]) });
  } catch (error) {
    return next(error);
  }
});

router.post("/:id/stop", async (request, response, next) => {
  const parsedId = parseSessionId(request.params.id);
  if (!parsedId.success) return response.status(400).json({ error: "Session id must be a UUID" });

  try {
    const result = await pool.query(
      `UPDATE sessions
       SET status = 'created', started_at = NULL, ended_at = NULL
       WHERE id = $1 AND status = 'live'
       RETURNING *`,
      [request.params.id],
    );
    if (result.rowCount > 0) {
      closeSessionAudioStreams(request.params.id);
      return response.json({ session: mapSession(result.rows[0]) });
    }

    // A browser track can emit `ended` while the application cleanup path is
    // also stopping the same session. Treat an already-created session as an
    // idempotent successful stop instead of returning a misleading conflict.
    const existing = await pool.query("SELECT * FROM sessions WHERE id = $1", [request.params.id]);
    if (existing.rowCount === 0) return response.status(404).json({ error: "Session not found" });
    if (existing.rows[0].status === "created") {
      closeSessionAudioStreams(request.params.id);
      return response.json({ session: mapSession(existing.rows[0]), idempotent: true });
    }
    return response.status(409).json({ error: "Session is not currently capturing audio" });
  } catch (error) {
    return next(error);
  }
});

router.post("/:id/complete", async (request, response, next) => {
  const parsedId = parseSessionId(request.params.id);
  if (!parsedId.success) return response.status(400).json({ error: "Session id must be a UUID" });

  try {
    const result = await completeSession(request.params.id);
    if (result.kind === "not_found") return response.status(404).json({ error: "Session not found" });
    if (result.kind === "no_transcript") {
      return response.status(409).json({ error: "Session cannot be completed until a finalized transcript segment is persisted" });
    }
    if (result.kind === "invalid_state") {
      return response.status(409).json({ error: `Session cannot be completed from its current state: ${result.status}` });
    }
    return response.json({ session: mapSession(result.session), transcriptCount: result.transcriptCount });
  } catch (error) {
    return next(error);
  }
});

router.delete("/:id", async (request, response, next) => {
  const parsedId = parseSessionId(request.params.id);
  if (!parsedId.success) return response.status(400).json({ error: "Session id must be a UUID" });

  try {
    const result = await deleteSession(request.params.id);
    if (result.kind === "not_found") return response.status(404).json({ error: "Session not found" });
    closeSessionAudioStreams(request.params.id);
    return response.json({ deleted: true, id: request.params.id });
  } catch (error) {
    return next(error);
  }
});

router.post("/:id/process", async (request, response, next) => {
  const parsedId = parseSessionId(request.params.id);
  if (!parsedId.success) return response.status(400).json({ error: "Session id must be a UUID" });

  try {
    const result = await processCompletedSession(request.params.id);
    if (result.kind === "not_found") return response.status(404).json({ error: "Session not found" });
    if (result.kind === "incomplete") return response.status(409).json({ error: `Only completed sessions can be processed; current status is ${result.status}` });
    if (result.kind === "no_transcript") return response.status(409).json({ error: "A finalized transcript is required before processing" });
    if (result.kind === "failed") return response.status(502).json({ error: result.error, derivative: result.derivative });
    if (result.kind === "generating") return response.status(202).json({ status: "generating", derivative: result.derivative });
    return response.json({ status: "ready", derivative: result.derivative });
  } catch (error) {
    return next(error);
  }
});

router.post("/:id/regenerate-summary", async (request, response, next) => {
  const parsedId = parseSessionId(request.params.id);
  if (!parsedId.success) return response.status(400).json({ error: "Session id must be a UUID" });

  try {
    const result = await regenerateCompletedSession(request.params.id);
    if (result.kind === "not_found") return response.status(404).json({ error: "Session not found" });
    if (result.kind === "incomplete") return response.status(409).json({ error: `Only completed sessions can regenerate summaries; current status is ${result.status}` });
    if (result.kind === "no_transcript") return response.status(409).json({ error: "A finalized transcript is required before regenerating a summary" });
    if (result.kind === "not_rejected") return response.status(409).json({ error: "A rejected verification is required before regenerating a summary" });
    if (result.kind === "failed") return response.status(502).json({ error: result.error, derivative: result.derivative });
    if (result.kind === "generating") return response.status(202).json({ status: "generating", derivative: result.derivative });
    return response.json({ status: "ready", derivative: result.derivative });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id/verification", async (request, response, next) => {
  const parsedId = parseSessionId(request.params.id);
  if (!parsedId.success) return response.status(400).json({ error: "Session id must be a UUID" });

  try {
    const session = await pool.query("SELECT id FROM sessions WHERE id = $1", [request.params.id]);
    if (session.rowCount === 0) return response.status(404).json({ error: "Session not found" });
    return response.json({
      verification: await refreshSessionVerification(request.params.id),
      verificationHistory: await getSessionVerificationHistory(request.params.id),
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/:id/verify", async (request, response, next) => {
  const parsedId = parseSessionId(request.params.id);
  if (!parsedId.success) return response.status(400).json({ error: "Session id must be a UUID" });

  try {
    const result = await submitSessionVerification(request.params.id);
    if (result.kind === "not_found") return response.status(404).json({ error: "Session not found" });
    if (result.kind === "duplicate") {
      return response.status(409).json({ error: "A verification already exists for this transcript hash.", verification: result.verification });
    }
    if (result.kind === "failed") {
      const status = result.verification?.retryable ? 502 : 409;
      return response.status(status).json({ error: result.verification?.error ?? "GenLayer verification failed.", verification: result.verification, verificationHistory: await getSessionVerificationHistory(request.params.id) });
    }
    if (result.verification?.verificationStatus === "accepted" || result.verification?.verificationStatus === "rejected") {
      return response.json({ verification: result.verification, verificationHistory: await getSessionVerificationHistory(request.params.id) });
    }
    return response.status(202).json({ verification: result.verification, verificationHistory: await getSessionVerificationHistory(request.params.id) });
  } catch (error) {
    if (error instanceof VerificationError) {
      return response.status(error.code === "genlayer_private_key_missing" || error.code === "genlayer_private_key_invalid" ? 503 : 409).json({
        error: error.message,
        code: error.code,
      });
    }
    console.error("Verification request failed", { message: safeVerificationError(error), code: error?.code });
    return next(error);
  }
});

export default router;
