import { pool } from "./pool.js";

function mapSegment(row) {
  return {
    id: row.id,
    sequence: row.sequence_number,
    text: row.text,
    timestamp: row.captured_at,
    isFinal: row.is_final,
    provider: row.provider,
    dedupeKey: row.dedupe_key,
    startSeconds: row.source_start_seconds === null ? null : Number(row.source_start_seconds),
    durationSeconds: row.source_duration_seconds === null ? null : Number(row.source_duration_seconds),
  };
}

export async function listTranscriptSegments(sessionId) {
  const result = await pool.query(
    `SELECT id, sequence_number, text, captured_at, is_final, provider, dedupe_key,
            source_start_seconds, source_duration_seconds
       FROM transcript_segments
      WHERE session_id = $1
      ORDER BY sequence_number ASC`,
    [sessionId],
  );
  return result.rows.map(mapSegment);
}

export async function persistFinalTranscriptSegment({
  sessionId,
  text,
  timestamp,
  provider = "deepgram",
  dedupeKey,
  startSeconds = null,
  durationSeconds = null,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);

    const sessionState = await client.query("SELECT status FROM sessions WHERE id = $1 FOR UPDATE", [sessionId]);
    if (sessionState.rowCount === 0) {
      const error = new Error("Session no longer exists");
      error.code = "SESSION_NOT_FOUND";
      throw error;
    }
    if (!["live", "created"].includes(sessionState.rows[0].status)) {
      const error = new Error("Completed sessions are immutable");
      error.code = "SESSION_IMMUTABLE";
      throw error;
    }

    const existing = await client.query(
      `SELECT id, sequence_number, text, captured_at, is_final, provider, dedupe_key,
              source_start_seconds, source_duration_seconds
         FROM transcript_segments
        WHERE session_id = $1 AND dedupe_key = $2`,
      [sessionId, dedupeKey],
    );
    if (existing.rowCount > 0) {
      await client.query("COMMIT");
      return { inserted: false, segment: mapSegment(existing.rows[0]) };
    }

    const sequenceResult = await client.query(
      "SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_sequence FROM transcript_segments WHERE session_id = $1",
      [sessionId],
    );
    const inserted = await client.query(
      `INSERT INTO transcript_segments
        (session_id, sequence_number, text, captured_at, is_final, provider, dedupe_key,
         source_start_seconds, source_duration_seconds)
       VALUES ($1, $2, $3, COALESCE($4::timestamptz, NOW()), TRUE, $5, $6, $7, $8)
       RETURNING id, sequence_number, text, captured_at, is_final, provider, dedupe_key,
                 source_start_seconds, source_duration_seconds`,
      [
        sessionId,
        sequenceResult.rows[0].next_sequence,
        text,
        timestamp,
        provider,
        dedupeKey,
        startSeconds,
        durationSeconds,
      ],
    );
    await client.query("COMMIT");
    return { inserted: true, segment: mapSegment(inserted.rows[0]) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
