import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import http from "node:http";
import authRouter from "../src/routes/auth.js";
import sessionsRouter from "../src/routes/sessions.js";
import { pool } from "../src/db/pool.js";
import { persistFinalTranscriptSegment } from "../src/db/transcriptStore.js";
import { getSessionDerivative, processCompletedSession } from "../src/db/sessionProcessing.js";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1";

test("Phase 5 session completion and deletion lifecycle", { skip: !runDatabaseTests }, async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  app.use("/api/sessions", sessionsRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  let sessionId;
  let ownerId;
  let authCookie;
  const createdSessionIds = [];

  async function createCompletedSession(title, transcriptText = []) {
    const id = crypto.randomUUID();
    createdSessionIds.push(id);
    const completedAt = new Date();
    await pool.query(
      `INSERT INTO sessions (id, user_id, title, status, started_at, ended_at)
       VALUES ($1, $2, $3, 'completed', $4, $4)`,
      [id, ownerId, title, completedAt],
    );
    for (const [index, text] of transcriptText.entries()) {
      await pool.query(
        `INSERT INTO transcript_segments
          (session_id, sequence_number, text, captured_at, is_final, provider, dedupe_key,
           source_start_seconds, source_duration_seconds)
         VALUES ($1, $2, $3, $4, TRUE, 'test', $5, $6, 1)`,
        [id, index + 1, text, completedAt, `${id}-${index}`, index],
      );
    }
    return id;
  }

  async function request(path, options) {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { "Content-Type": "application/json", ...(authCookie ? { Cookie: authCookie } : {}) },
      ...options,
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) authCookie = setCookie.split(";", 1)[0];
    return { status: response.status, body: await response.json() };
  }

  try {
    const registered = await request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username: `lifecycle-${crypto.randomUUID().slice(0, 8)}`, password: "correct horse battery staple" }),
    });
    assert.equal(registered.status, 201);
    ownerId = registered.body.user.id;
    const created = await request("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: `Phase 5 lifecycle test ${crypto.randomUUID()}` }),
    });
    assert.equal(created.status, 201);
    sessionId = created.body.session.id;
    createdSessionIds.push(sessionId);

    const live = await request(`/api/sessions/${sessionId}/start`, { method: "POST" });
    assert.equal(live.status, 200);
    const completeWhileLive = await request(`/api/sessions/${sessionId}/complete`, { method: "POST" });
    assert.equal(completeWhileLive.status, 409);
    const processWhileLive = await request(`/api/sessions/${sessionId}/process`, { method: "POST" });
    assert.equal(processWhileLive.status, 409);

    const stopped = await request(`/api/sessions/${sessionId}/stop`, { method: "POST" });
    assert.equal(stopped.status, 200);
    const completeWithoutTranscript = await request(`/api/sessions/${sessionId}/complete`, { method: "POST" });
    assert.equal(completeWithoutTranscript.status, 409);

    await persistFinalTranscriptSegment({ sessionId, text: "First finalized segment.", provider: "test", dedupeKey: "phase5-first", startSeconds: 0, durationSeconds: 1 });
    await persistFinalTranscriptSegment({ sessionId, text: "Second finalized segment.", provider: "test", dedupeKey: "phase5-second", startSeconds: 1, durationSeconds: 1 });
    const duplicate = await persistFinalTranscriptSegment({ sessionId, text: "First finalized segment.", provider: "test", dedupeKey: "phase5-first", startSeconds: 0, durationSeconds: 1 });
    assert.equal(duplicate.inserted, false);

    const completed = await request(`/api/sessions/${sessionId}/complete`, { method: "POST" });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.session.status, "completed");
    assert.ok(completed.body.session.completedAt);

    const duplicateCompletion = await request(`/api/sessions/${sessionId}/complete`, { method: "POST" });
    assert.equal(duplicateCompletion.status, 409);
    const restartCompleted = await request(`/api/sessions/${sessionId}/start`, { method: "POST" });
    assert.equal(restartCompleted.status, 409);
    await assert.rejects(
      persistFinalTranscriptSegment({ sessionId, text: "Late provider result.", provider: "test", dedupeKey: "phase5-late" }),
      /Completed sessions are immutable/,
    );

    const record = await request(`/api/sessions/${sessionId}`);
    assert.equal(record.status, 200);
    assert.deepEqual(record.body.transcript.map((segment) => segment.text), ["First finalized segment.", "Second finalized segment."]);
    assert.deepEqual(record.body.processing, { eligible: true, reason: "summary_not_generated" });

    const legacySessionId = await createCompletedSession(`Legacy session ${crypto.randomUUID()}`, ["Legacy finalized transcript."]);
    const legacyRecord = await request(`/api/sessions/${legacySessionId}`);
    assert.deepEqual(legacyRecord.body.processing, { eligible: true, reason: "summary_not_generated" });
    const legacyProcessed = await processCompletedSession(legacySessionId, async () => ({
      summary: "A summary generated for a legacy completed session.",
      topics: ["Legacy support"],
      announcements: [],
      questionsAnswers: [],
    }));
    assert.equal(legacyProcessed.kind, "ready");
    assert.match(legacyProcessed.derivative.transcriptHash, /^0x[0-9a-f]{64}$/);

    const legacyReadyDuplicate = await processCompletedSession(legacySessionId, async () => {
      throw new Error("A ready derivative must not invoke the provider again");
    });
    assert.equal(legacyReadyDuplicate.kind, "ready");
    assert.equal(legacyReadyDuplicate.derivative.summary, "A summary generated for a legacy completed session.");

    const emptyLegacySessionId = await createCompletedSession(`Empty legacy session ${crypto.randomUUID()}`);
    const emptyLegacyResult = await processCompletedSession(emptyLegacySessionId, async () => {
      throw new Error("No-transcript sessions must not invoke the provider");
    });
    assert.equal(emptyLegacyResult.kind, "no_transcript");

    const failedRetrySessionId = await createCompletedSession(`Retry session ${crypto.randomUUID()}`, ["Retryable finalized transcript."]);
    const previousRetryProvider = process.env.SUMMARY_PROVIDER;
    const previousRetryKey = process.env.SUMMARY_API_KEY;
    const previousRetryModel = process.env.SUMMARY_MODEL;
    const previousRetryFetch = globalThis.fetch;
    try {
      const failedFirstAttempt = await processCompletedSession(failedRetrySessionId, async () => {
        throw new Error("provider failure");
      });
      assert.equal(failedFirstAttempt.kind, "failed");
      process.env.SUMMARY_PROVIDER = "gemini";
      process.env.SUMMARY_API_KEY = "gemini-test-key";
      process.env.SUMMARY_MODEL = "gemini-2.5-flash";
      globalThis.fetch = async () => new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          summary: "The Gemini retry succeeded.",
          topics: [],
          announcements: [],
          questions_answers: [],
        }) }] } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      const successfulRetry = await processCompletedSession(failedRetrySessionId);
      assert.equal(successfulRetry.kind, "ready");
      assert.equal(successfulRetry.derivative.summary, "The Gemini retry succeeded.");
    } finally {
      if (previousRetryProvider === undefined) delete process.env.SUMMARY_PROVIDER;
      else process.env.SUMMARY_PROVIDER = previousRetryProvider;
      if (previousRetryKey === undefined) delete process.env.SUMMARY_API_KEY;
      else process.env.SUMMARY_API_KEY = previousRetryKey;
      if (previousRetryModel === undefined) delete process.env.SUMMARY_MODEL;
      else process.env.SUMMARY_MODEL = previousRetryModel;
      globalThis.fetch = previousRetryFetch;
    }

    const previousSummaryProvider = process.env.SUMMARY_PROVIDER;
    const previousSummaryKey = process.env.SUMMARY_API_KEY;
    delete process.env.SUMMARY_PROVIDER;
    delete process.env.SUMMARY_API_KEY;
    try {
      const failedProcessing = await processCompletedSession(sessionId);
      assert.equal(failedProcessing.kind, "failed");
      assert.equal(failedProcessing.derivative.summaryGenerationStatus, "failed");
      assert.match(failedProcessing.derivative.transcriptHash, /^0x[0-9a-f]{64}$/);
      const retryProcessing = await processCompletedSession(sessionId);
      assert.equal(retryProcessing.kind, "failed");
      const derivative = await getSessionDerivative(sessionId);
      assert.equal(derivative.summaryGenerationStatus, "failed");
      assert.equal(derivative.summary, null);
      const derivativeCount = await pool.query("SELECT COUNT(*)::integer AS count FROM session_derivatives WHERE session_id = $1", [sessionId]);
      assert.equal(derivativeCount.rows[0].count, 1);
    } finally {
      if (previousSummaryProvider === undefined) delete process.env.SUMMARY_PROVIDER;
      else process.env.SUMMARY_PROVIDER = previousSummaryProvider;
      if (previousSummaryKey === undefined) delete process.env.SUMMARY_API_KEY;
      else process.env.SUMMARY_API_KEY = previousSummaryKey;
    }

    const deleted = await request(`/api/sessions/${sessionId}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deleted, true);
    const derivedAfterDelete = await pool.query("SELECT COUNT(*)::integer AS count FROM session_derivatives WHERE session_id = $1", [sessionId]);
    assert.equal(derivedAfterDelete.rows[0].count, 0);
    const missingRecord = await request(`/api/sessions/${sessionId}`);
    assert.equal(missingRecord.status, 404);
    const missingDelete = await request(`/api/sessions/${sessionId}`, { method: "DELETE" });
    assert.equal(missingDelete.status, 404);
  } finally {
    if (createdSessionIds.length > 0) await pool.query("DELETE FROM sessions WHERE id = ANY($1::text[])", [createdSessionIds]);
    await new Promise((resolve) => server.close(resolve));
  }
});
