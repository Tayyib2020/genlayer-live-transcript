import crypto from "node:crypto";
import { pool } from "./pool.js";
import { buildTranscriptIntegrity } from "../integrity/transcriptIntegrity.js";
import { SummaryProviderError } from "../summary/summaryCommon.js";
import { generateSummary } from "../summary/summaryProvider.js";

function hashSummary(summary) {
  return `0x${crypto.createHash("sha256").update(summary, "utf8").digest("hex")}`;
}

function mapSummaryAttempt(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    attemptNumber: row.attempt_number,
    summary: row.summary,
    summaryHash: row.summary_hash,
    topics: row.topics ?? [],
    announcements: row.announcements ?? [],
    questionsAnswers: row.questions_answers ?? [],
    summaryGenerationStatus: row.generation_status,
    summaryGeneratedAt: row.generated_at,
    summaryError: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDerivative(row, attempts = []) {
  if (!row) return null;
  const latestAttempt = attempts.at(-1) ?? null;
  return {
    sessionId: row.session_id,
    canonicalTranscript: row.canonical_transcript,
    transcriptHash: row.transcript_hash,
    summary: row.summary,
    topics: row.topics ?? [],
    announcements: row.announcements ?? [],
    questionsAnswers: row.questions_answers ?? [],
    summaryGenerationStatus: row.summary_generation_status,
    summaryGeneratedAt: row.summary_generated_at,
    summaryError: row.summary_error,
    summaryAttemptId: latestAttempt?.id ?? null,
    summaryAttemptNumber: latestAttempt?.attemptNumber ?? null,
    summaryHash: latestAttempt?.summaryHash ?? null,
    summaryAttempts: attempts,
    updatedAt: row.updated_at,
  };
}

const DERIVATIVE_COLUMNS = `session_id, canonical_transcript, transcript_hash, summary,
  topics, announcements, questions_answers, summary_generation_status,
  summary_generated_at, summary_error, created_at, updated_at`;

const ATTEMPT_COLUMNS = `id, session_id, attempt_number, summary, summary_hash,
  topics, announcements, questions_answers, generation_status, generated_at,
  error, created_at, updated_at`;

async function getAttempts(client, sessionId, { forUpdate = false } = {}) {
  const result = await client.query(
    `SELECT ${ATTEMPT_COLUMNS}
       FROM summary_attempts
      WHERE session_id = $1
      ORDER BY attempt_number ASC
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [sessionId],
  );
  return result.rows.map(mapSummaryAttempt);
}

export async function getSummaryAttempts(sessionId) {
  return getAttempts(pool, sessionId);
}

export async function getSessionDerivative(sessionId) {
  const result = await pool.query(`SELECT ${DERIVATIVE_COLUMNS} FROM session_derivatives WHERE session_id = $1`, [sessionId]);
  return mapDerivative(result.rows[0], await getSummaryAttempts(sessionId));
}

async function loadFinalSegments(client, sessionId) {
  const result = await client.query(
    `SELECT id, sequence_number AS sequence, text, captured_at, is_final,
            source_start_seconds AS start_seconds
       FROM transcript_segments
      WHERE session_id = $1 AND is_final = TRUE
      ORDER BY sequence_number ASC, id ASC`,
    [sessionId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    sequence: row.sequence,
    text: row.text,
    timestamp: row.captured_at,
    isFinal: row.is_final,
    startSeconds: row.start_seconds === null ? null : Number(row.start_seconds),
  }));
}

function safeSummaryError(error) {
  if (error instanceof SummaryProviderError) return error.message;
  return "Summary generation failed unexpectedly.";
}

async function loadDerivative(client, sessionId, { forUpdate = false } = {}) {
  const result = await client.query(
    `SELECT ${DERIVATIVE_COLUMNS}
       FROM session_derivatives
      WHERE session_id = $1
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [sessionId],
  );
  return result.rows[0] ?? null;
}

async function ensureDerivative(client, sessionId, integrity, existing) {
  if (!existing) {
    const inserted = await client.query(
      `INSERT INTO session_derivatives
        (session_id, canonical_transcript, transcript_hash, summary_generation_status)
       VALUES ($1, $2, $3, 'not_started')
       RETURNING ${DERIVATIVE_COLUMNS}`,
      [sessionId, integrity.canonicalTranscript, integrity.transcriptHash],
    );
    return inserted.rows[0];
  }
  if (existing.canonical_transcript !== integrity.canonicalTranscript || existing.transcript_hash !== integrity.transcriptHash) {
    throw new Error("The finalized transcript no longer matches the persisted canonical transcript.");
  }
  return existing;
}

async function ensureLegacyAttempt(client, sessionId, derivative) {
  const existing = await getAttempts(client, sessionId, { forUpdate: true });
  if (existing.length > 0) return existing;
  await client.query(
    `INSERT INTO summary_attempts
      (session_id, attempt_number, summary, summary_hash, topics, announcements,
       questions_answers, generation_status, generated_at, error)
     VALUES ($1, 1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9)
     ON CONFLICT (session_id, attempt_number) DO NOTHING`,
    [
      sessionId,
      derivative.summary,
      derivative.summary ? hashSummary(derivative.summary) : null,
      JSON.stringify(derivative.topics ?? []),
      JSON.stringify(derivative.announcements ?? []),
      JSON.stringify(derivative.questions_answers ?? []),
      derivative.summary_generation_status,
      derivative.summary_generated_at,
      derivative.summary_error,
    ],
  );
  return getAttempts(client, sessionId, { forUpdate: true });
}

async function claimExistingAttempt(client, sessionId, derivative) {
  const attempts = await ensureLegacyAttempt(client, sessionId, derivative);
  const latest = attempts.at(-1);
  if (latest.summaryGenerationStatus === "ready" || latest.summaryGenerationStatus === "generating") {
    return { attempt: latest, claimed: false, attempts };
  }
  const updated = await client.query(
    `UPDATE summary_attempts
        SET summary = NULL, summary_hash = NULL, topics = '[]'::jsonb,
            announcements = '[]'::jsonb, questions_answers = '[]'::jsonb,
            generation_status = 'generating', generated_at = NULL, error = NULL,
            updated_at = NOW()
      WHERE id = $1 AND generation_status IN ('failed', 'not_started')
      RETURNING ${ATTEMPT_COLUMNS}`,
    [latest.id],
  );
  return { attempt: mapSummaryAttempt(updated.rows[0] ?? latest), claimed: updated.rowCount > 0, attempts };
}

async function updateLegacyProjection(sessionId, attempt, canonicalTranscript, transcriptHash) {
  await pool.query(
    `UPDATE session_derivatives
        SET canonical_transcript = $2, transcript_hash = $3, summary = $4,
            topics = $5::jsonb, announcements = $6::jsonb,
            questions_answers = $7::jsonb, summary_generation_status = $8,
            summary_generated_at = $9, summary_error = $10, updated_at = NOW()
      WHERE session_id = $1`,
    [
      sessionId,
      canonicalTranscript,
      transcriptHash,
      attempt.summary,
      JSON.stringify(attempt.topics ?? []),
      JSON.stringify(attempt.announcements ?? []),
      JSON.stringify(attempt.questionsAnswers ?? []),
      attempt.summaryGenerationStatus,
      attempt.summaryGeneratedAt,
      attempt.summaryError,
    ],
  );
}

async function loadMappedDerivative(sessionId) {
  const row = await pool.query(`SELECT ${DERIVATIVE_COLUMNS} FROM session_derivatives WHERE session_id = $1`, [sessionId]);
  return mapDerivative(row.rows[0], await getSummaryAttempts(sessionId));
}

async function runSummaryGeneration(sessionId, claim, summaryGenerator) {
  let generated;
  try {
    generated = await summaryGenerator(claim.canonicalTranscript);
  } catch (error) {
    const message = safeSummaryError(error);
    await pool.query(
      `UPDATE summary_attempts
          SET generation_status = 'failed', error = $2, generated_at = NULL, updated_at = NOW()
        WHERE id = $1 AND generation_status = 'generating'`,
      [claim.attemptId, message],
    );
    const attempt = (await getSummaryAttempts(sessionId)).find((item) => item.id === claim.attemptId);
    await updateLegacyProjection(sessionId, attempt, claim.canonicalTranscript, claim.transcriptHash);
    return { kind: "failed", derivative: await loadMappedDerivative(sessionId), error: message };
  }

  const summaryHash = hashSummary(generated.summary);
  const ready = await pool.query(
    `UPDATE summary_attempts
        SET summary = $2, summary_hash = $3, topics = $4::jsonb,
            announcements = $5::jsonb, questions_answers = $6::jsonb,
            generation_status = 'ready', generated_at = NOW(), error = NULL,
            updated_at = NOW()
      WHERE id = $1 AND generation_status = 'generating'
      RETURNING ${ATTEMPT_COLUMNS}`,
    [
      claim.attemptId,
      generated.summary,
      summaryHash,
      JSON.stringify(generated.topics),
      JSON.stringify(generated.announcements),
      JSON.stringify(generated.questionsAnswers),
    ],
  );
  if (ready.rowCount === 0) return { kind: "not_found" };
  const attempt = mapSummaryAttempt(ready.rows[0]);
  await updateLegacyProjection(sessionId, attempt, claim.canonicalTranscript, claim.transcriptHash);
  return { kind: "ready", derivative: await loadMappedDerivative(sessionId) };
}

async function beginSummaryAttempt(sessionId, { regeneration = false, userId = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const session = await client.query(
      `SELECT status FROM sessions
        WHERE id = $1 AND ($2::text IS NULL OR user_id = $2)
        FOR UPDATE`,
      [sessionId, userId],
    );
    if (session.rowCount === 0) {
      await client.query("ROLLBACK");
      return { kind: "not_found" };
    }
    if (session.rows[0].status !== "completed") {
      await client.query("ROLLBACK");
      return { kind: "incomplete", status: session.rows[0].status };
    }

    const segments = await loadFinalSegments(client, sessionId);
    const integrity = buildTranscriptIntegrity(segments);
    if (!integrity.canonicalTranscript) {
      await client.query("ROLLBACK");
      return { kind: "no_transcript" };
    }

    const derivative = await ensureDerivative(client, sessionId, integrity, await loadDerivative(client, sessionId, { forUpdate: true }));
    const attempts = await ensureLegacyAttempt(client, sessionId, derivative);
    const latest = attempts.at(-1);

    if (regeneration) {
      const verification = await client.query(
        `SELECT verification_status
           FROM verification_attempts
          WHERE summary_attempt_id = $1
          ORDER BY id DESC
          LIMIT 1
          FOR UPDATE`,
        [latest.id],
      );
      if (latest.summaryGenerationStatus === "generating") {
        await client.query("COMMIT");
        return { kind: "generating", derivative: mapDerivative(derivative, attempts) };
      }
      if (latest.summaryGenerationStatus === "failed" && verification.rowCount === 0) {
        const retried = await client.query(
          `UPDATE summary_attempts
              SET generation_status = 'generating', error = NULL, updated_at = NOW()
            WHERE id = $1
            RETURNING ${ATTEMPT_COLUMNS}`,
          [latest.id],
        );
        await client.query("COMMIT");
        return { kind: "claimed", attemptId: Number(retried.rows[0].id), attemptNumber: latest.attemptNumber, ...integrity };
      }
      if (verification.rows[0]?.verification_status !== "rejected") {
        await client.query("ROLLBACK");
        return { kind: "not_rejected" };
      }
      const inserted = await client.query(
        `INSERT INTO summary_attempts (session_id, attempt_number, generation_status)
         VALUES ($1, $2, 'generating')
         RETURNING ${ATTEMPT_COLUMNS}`,
        [sessionId, latest.attemptNumber + 1],
      );
      await client.query("COMMIT");
      return { kind: "claimed", attemptId: Number(inserted.rows[0].id), attemptNumber: latest.attemptNumber + 1, ...integrity };
    }

    const claim = await claimExistingAttempt(client, sessionId, derivative);
    await client.query("COMMIT");
    if (!claim.claimed) return { kind: claim.attempt.summaryGenerationStatus, derivative: mapDerivative(derivative, claim.attempts) };
    return { kind: "claimed", attemptId: claim.attempt.id, attemptNumber: claim.attempt.attemptNumber, ...integrity };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function processCompletedSession(sessionId, summaryGenerator = generateSummary, userId = null) {
  const begin = await beginSummaryAttempt(sessionId, { userId });
  if (begin.kind !== "claimed") return { kind: begin.kind, derivative: begin.derivative, status: begin.status };
  return runSummaryGeneration(sessionId, begin, summaryGenerator);
}

export async function regenerateCompletedSession(sessionId, summaryGenerator = generateSummary, userId = null) {
  const begin = await beginSummaryAttempt(sessionId, { regeneration: true, userId });
  if (begin.kind !== "claimed") return { kind: begin.kind, derivative: begin.derivative, status: begin.status };
  return runSummaryGeneration(sessionId, begin, summaryGenerator);
}
