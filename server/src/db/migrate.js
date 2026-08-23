import "../env.js";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pool } from "./pool.js";

const currentFile = fileURLToPath(import.meta.url);
const schemaPath = path.join(path.dirname(currentFile), "schema.sql");

function safeDatabaseError(error) {
  const details = {
    name: error?.name,
    code: error?.code,
    message: error?.message || "No error message available",
  };

  if (error?.detail) details.detail = error.detail;
  if (error?.hint) details.hint = error.hint;
  if (error?.severity) details.severity = error.severity;
  if (error?.cause) details.cause = safeDatabaseError(error.cause);
  if (Array.isArray(error?.errors)) {
    details.errors = error.errors.map(safeDatabaseError);
  }

  return details;
}

function hashSummary(summary) {
  if (typeof summary !== "string" || !summary.trim()) return null;
  return `0x${crypto.createHash("sha256").update(summary, "utf8").digest("hex")}`;
}

async function backfillAttemptHistory() {
  const derivatives = await pool.query(
    `SELECT session_id, summary, topics, announcements, questions_answers,
            summary_generation_status, summary_generated_at, summary_error,
            created_at, updated_at
       FROM session_derivatives`,
  );

  for (const row of derivatives.rows) {
    await pool.query(
      `INSERT INTO summary_attempts
        (session_id, attempt_number, summary, summary_hash, topics, announcements,
         questions_answers, generation_status, generated_at, error, created_at, updated_at)
       VALUES ($1, 1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11)
       ON CONFLICT (session_id, attempt_number) DO NOTHING`,
      [
        row.session_id,
        row.summary,
        hashSummary(row.summary),
        JSON.stringify(row.topics ?? []),
        JSON.stringify(row.announcements ?? []),
        JSON.stringify(row.questions_answers ?? []),
        row.summary_generation_status,
        row.summary_generated_at,
        row.summary_error,
        row.created_at,
        row.updated_at,
      ],
    );
  }

  await pool.query(
    `INSERT INTO verification_attempts
      (session_id, summary_attempt_id, transcript_hash, summary_hash, verification_id,
       contract_address, network, transaction_hash, transaction_status,
       verification_status, contract_status, reason, submitted_at, completed_at,
       error, created_at, updated_at)
     SELECT legacy.session_id, attempt.id, legacy.transcript_hash, attempt.summary_hash,
            legacy.transcript_hash, legacy.contract_address, legacy.network,
            legacy.transaction_hash, legacy.transaction_status, legacy.verification_status,
            legacy.contract_status, legacy.reason, legacy.submitted_at, legacy.completed_at,
            legacy.error, legacy.created_at, legacy.updated_at
       FROM session_verifications AS legacy
       JOIN summary_attempts AS attempt
         ON attempt.session_id = legacy.session_id
        AND attempt.attempt_number = 1
      WHERE attempt.summary_hash IS NOT NULL
     ON CONFLICT (summary_attempt_id) DO NOTHING`,
  );
}

try {
  const schema = await readFile(schemaPath, "utf8");
  await pool.query(schema);
  await backfillAttemptHistory();
  console.log("Database schema is up to date.");
} catch (error) {
  console.error("Database migration failed:", JSON.stringify(safeDatabaseError(error), null, 2));
  process.exitCode = 1;
} finally {
  await pool.end();
}
