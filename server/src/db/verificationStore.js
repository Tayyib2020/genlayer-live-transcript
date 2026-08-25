import crypto from "node:crypto";
import { pool } from "./pool.js";
import { buildTranscriptIntegrity } from "../integrity/transcriptIntegrity.js";
import { validateVerificationReadiness, VerificationError, buildVerificationId } from "../genlayer/verificationLogic.js";

const VERIFICATION_COLUMNS = `id, session_id, summary_attempt_id, transcript_hash, summary_hash,
  verification_id, contract_address, network, transaction_hash, transaction_status,
  verification_status, contract_status, reason, submitted_at, completed_at, error,
  created_at, updated_at`;

const VERIFICATION_HISTORY_COLUMNS = `verifications.id, verifications.session_id,
  verifications.summary_attempt_id, verifications.transcript_hash, verifications.summary_hash,
  verifications.verification_id, verifications.contract_address, verifications.network,
  verifications.transaction_hash, verifications.transaction_status,
  verifications.verification_status, verifications.contract_status, verifications.reason,
  verifications.submitted_at, verifications.completed_at, verifications.error,
  verifications.created_at, verifications.updated_at`;

function mapVerification(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    summaryAttemptId: row.summary_attempt_id ? Number(row.summary_attempt_id) : null,
    summaryAttemptNumber: row.attempt_number ?? null,
    transcriptHash: row.transcript_hash,
    summaryHash: row.summary_hash,
    verificationId: row.verification_id ?? row.transcript_hash,
    contractAddress: row.contract_address,
    network: row.network,
    transactionHash: row.transaction_hash,
    transactionStatus: row.transaction_status,
    verificationStatus: row.verification_status,
    contractStatus: row.contract_status,
    reason: row.reason,
    submittedAt: row.submitted_at,
    completedAt: row.completed_at,
    error: row.error,
    retryable: row.verification_status === "failed" && !row.transaction_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const HISTORY_QUERY = `SELECT ${VERIFICATION_HISTORY_COLUMNS}, attempts.attempt_number
  FROM verification_attempts AS verifications
  JOIN summary_attempts AS attempts ON attempts.id = verifications.summary_attempt_id
  JOIN sessions AS session_owner ON session_owner.id = verifications.session_id
 WHERE verifications.session_id = $1
   AND ($2::text IS NULL OR session_owner.user_id = $2)
 ORDER BY attempts.attempt_number ASC`;

export async function getSessionVerificationHistory(sessionId, userId = null) {
  const result = await pool.query(HISTORY_QUERY, [sessionId, userId]);
  if (result.rowCount > 0) return result.rows.map(mapVerification);

  // A migration may not have copied a malformed legacy row that has no ready
  // derivative. Keep it visible rather than silently dropping local evidence.
  const legacy = await pool.query(
    `SELECT session_id, transcript_hash, contract_address, network,
            transaction_hash, transaction_status, verification_status, contract_status,
            reason, submitted_at, completed_at, error, created_at, updated_at
       FROM session_verifications
      WHERE session_id = $1
        AND ($2::text IS NULL OR session_id IN (SELECT id FROM sessions WHERE user_id = $2))`,
    [sessionId, userId],
  );
  return legacy.rows.map((row) => mapVerification({ ...row, verification_id: row.transcript_hash, attempt_number: 1 }));
}

export async function getSessionVerification(sessionId, userId = null) {
  const history = await getSessionVerificationHistory(sessionId, userId);
  return history.at(-1) ?? null;
}

async function getVerificationDerivative(client, sessionId) {
  const derivative = await client.query(
    `SELECT session_id, canonical_transcript, transcript_hash, summary,
            topics, announcements, questions_answers, summary_generation_status,
            summary_generated_at, summary_error, updated_at
       FROM session_derivatives
      WHERE session_id = $1
      FOR UPDATE`,
    [sessionId],
  );
  if (derivative.rowCount === 0) return null;
  return {
    sessionId: derivative.rows[0].session_id,
    canonicalTranscript: derivative.rows[0].canonical_transcript,
    transcriptHash: derivative.rows[0].transcript_hash,
    summary: derivative.rows[0].summary,
    topics: derivative.rows[0].topics ?? [],
    announcements: derivative.rows[0].announcements ?? [],
    questionsAnswers: derivative.rows[0].questions_answers ?? [],
    summaryGenerationStatus: derivative.rows[0].summary_generation_status,
    summaryGeneratedAt: derivative.rows[0].summary_generated_at,
    summaryError: derivative.rows[0].summary_error,
    updatedAt: derivative.rows[0].updated_at,
  };
}

async function buildComputedIntegrity(client, sessionId) {
  const segments = await client.query(
    `SELECT id, sequence_number AS sequence, text, source_start_seconds, is_final
       FROM transcript_segments
      WHERE session_id = $1 AND is_final = TRUE
      ORDER BY sequence_number ASC, id ASC`,
    [sessionId],
  );
  const mapped = segments.rows.map((row) => ({
    id: row.id,
    sequence: row.sequence,
    text: row.text,
    startSeconds: row.source_start_seconds === null ? null : Number(row.source_start_seconds),
    isFinal: row.is_final,
  }));
  return { count: mapped.length, integrity: buildTranscriptIntegrity(mapped) };
}

export async function prepareSessionVerification({ sessionId, contractAddress, network, userId = null }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sessionResult = await client.query(
      `SELECT status FROM sessions
        WHERE id = $1 AND ($2::text IS NULL OR user_id = $2)
        FOR UPDATE`,
      [sessionId, userId],
    );
    if (sessionResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return { kind: "not_found" };
    }

    const derivative = await getVerificationDerivative(client, sessionId);
    const { count, integrity } = await buildComputedIntegrity(client, sessionId);
    const ready = validateVerificationReadiness({
      sessionStatus: sessionResult.rows[0].status,
      finalizedTranscriptCount: count,
      derivative,
      computedIntegrity: integrity,
    });

    const attemptResult = await client.query(
      `SELECT id, session_id, attempt_number, summary, summary_hash,
              topics, announcements, questions_answers, generation_status,
              generated_at, error, created_at, updated_at
         FROM summary_attempts
        WHERE session_id = $1
        ORDER BY attempt_number DESC
        LIMIT 1
        FOR UPDATE`,
      [sessionId],
    );
    if (attemptResult.rowCount === 0 || attemptResult.rows[0].generation_status !== "ready") {
      throw new VerificationError("summary_attempt_not_ready", "A ready summary attempt is required before verification.");
    }
    const attempt = attemptResult.rows[0];
    if (attempt.summary !== derivative.summary || attempt.summary_hash !== `0x${crypto.createHash("sha256").update(attempt.summary, "utf8").digest("hex")}`) {
      throw new VerificationError("summary_attempt_integrity_mismatch", "The persisted summary attempt does not match its stored content.");
    }

    const existing = await client.query(
      `SELECT ${VERIFICATION_COLUMNS}, $2::integer AS attempt_number
         FROM verification_attempts
        WHERE summary_attempt_id = $1
        FOR UPDATE`,
      [attempt.id, attempt.attempt_number],
    );
    if (existing.rowCount > 0) {
      const current = mapVerification(existing.rows[0]);
      if (current.verificationStatus === "failed" && current.retryable) {
        const retried = await client.query(
          `UPDATE verification_attempts
              SET verification_status = 'submitting', transaction_status = NULL,
                  contract_status = NULL, reason = NULL, submitted_at = NULL,
                  completed_at = NULL, error = NULL, updated_at = NOW()
            WHERE id = $1
            RETURNING ${VERIFICATION_COLUMNS}`,
          [current.id],
        );
        await client.query("COMMIT");
        return { kind: "claimed", verification: mapVerification({ ...retried.rows[0], attempt_number: attempt.attempt_number }), ...ready, summaryAttempt: attempt };
      }
      await client.query("COMMIT");
      return { kind: "existing", verification: current, ...ready, summaryAttempt: attempt };
    }

    const summaryHash = attempt.summary_hash;
    const verificationId = attempt.attempt_number === 1
      ? ready.transcriptHash
      : buildVerificationId(ready.transcriptHash, summaryHash);
    const inserted = await client.query(
      `INSERT INTO verification_attempts
        (session_id, summary_attempt_id, transcript_hash, summary_hash,
         verification_id, contract_address, network, verification_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'submitting')
       RETURNING ${VERIFICATION_COLUMNS}`,
      [sessionId, attempt.id, ready.transcriptHash, summaryHash, verificationId, contractAddress, network],
    );
    await client.query("COMMIT");
    return { kind: "claimed", verification: mapVerification({ ...inserted.rows[0], attempt_number: attempt.attempt_number }), ...ready, summaryAttempt: attempt };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof VerificationError) throw error;
    throw error;
  } finally {
    client.release();
  }
}

function targetWhere(targetId) {
  if (/^\d+$/.test(String(targetId))) return { sql: "id = $1", values: [Number(targetId)] };
  return { sql: "id = (SELECT id FROM verification_attempts WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1)", values: [targetId] };
}

export async function recordSubmittedTransaction(targetId, { transactionHash, contractAddress, network }) {
  const target = targetWhere(targetId);
  const result = await pool.query(
    `UPDATE verification_attempts
        SET transaction_hash = $2, transaction_status = 'PENDING',
            verification_status = 'pending', contract_address = $3, network = $4,
            submitted_at = COALESCE(submitted_at, NOW()), error = NULL, updated_at = NOW()
      WHERE ${target.sql} AND verification_status = 'submitting'
      RETURNING ${VERIFICATION_COLUMNS}`,
    [target.values[0], transactionHash, contractAddress, network],
  );
  return mapVerification(result.rows[0]);
}

export async function recordTransactionStatus(targetId, { transactionStatus }) {
  const target = targetWhere(targetId);
  const result = await pool.query(
    `UPDATE verification_attempts
        SET transaction_status = $2, updated_at = NOW()
      WHERE ${target.sql} AND verification_status IN ('submitting', 'pending', 'failed')
      RETURNING ${VERIFICATION_COLUMNS}`,
    [target.values[0], transactionStatus],
  );
  return mapVerification(result.rows[0]);
}

export async function recordVerificationFailure(targetId, message) {
  const target = targetWhere(targetId);
  const result = await pool.query(
    `UPDATE verification_attempts
        SET verification_status = 'failed', error = $2, updated_at = NOW()
      WHERE ${target.sql}
      RETURNING ${VERIFICATION_COLUMNS}`,
    [target.values[0], message],
  );
  return mapVerification(result.rows[0]);
}

export async function recordContractVerification(targetId, { contractStatus, reason, submittedAt }) {
  const target = targetWhere(targetId);
  const result = await pool.query(
    `UPDATE verification_attempts
        SET verification_status = CASE WHEN $2 = 'ACCEPTED' THEN 'accepted' ELSE 'rejected' END,
            contract_status = $2, reason = $3, completed_at = NOW(),
            submitted_at = COALESCE(submitted_at, $4::timestamptz), error = NULL,
            updated_at = NOW()
      WHERE ${target.sql}
      RETURNING ${VERIFICATION_COLUMNS}`,
    [target.values[0], contractStatus, reason, submittedAt],
  );
  return mapVerification(result.rows[0]);
}
