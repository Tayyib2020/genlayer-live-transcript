import { pool } from "./pool.js";

export async function completeSession(sessionId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sessionResult = await client.query("SELECT * FROM sessions WHERE id = $1 FOR UPDATE", [sessionId]);
    if (sessionResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return { kind: "not_found" };
    }

    const session = sessionResult.rows[0];
    if (session.status !== "created") {
      await client.query("ROLLBACK");
      return { kind: "invalid_state", status: session.status };
    }

    const transcriptResult = await client.query(
      `SELECT COUNT(*)::integer AS count
         FROM transcript_segments
        WHERE session_id = $1 AND is_final = TRUE`,
      [sessionId],
    );
    const transcriptCount = transcriptResult.rows[0].count;
    if (transcriptCount < 1) {
      await client.query("ROLLBACK");
      return { kind: "no_transcript" };
    }

    const completed = await client.query(
      `UPDATE sessions
          SET status = 'completed', ended_at = NOW()
        WHERE id = $1 AND status = 'created'
        RETURNING *`,
      [sessionId],
    );
    await client.query("COMMIT");
    return { kind: "completed", session: completed.rows[0], transcriptCount };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteSession(sessionId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [sessionId]);
    if (existing.rowCount === 0) {
      await client.query("ROLLBACK");
      return { kind: "not_found" };
    }

    await client.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
    await client.query("COMMIT");
    return { kind: "deleted" };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
