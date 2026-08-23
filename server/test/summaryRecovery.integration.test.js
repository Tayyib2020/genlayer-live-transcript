import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { pool } from "../src/db/pool.js";
import {
  getSessionDerivative,
  processCompletedSession,
  regenerateCompletedSession,
} from "../src/db/sessionProcessing.js";
import { getSessionVerificationHistory } from "../src/db/verificationStore.js";
import { submitSessionVerification } from "../src/genlayer/verificationLifecycle.js";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1";
const contractAddress = "0x4DEfE1bbE75C59FcD2264EaCb75096f3CD659f5B";
const network = "testnet-bradbury";

test("summary attempts preserve immutable transcript and rejected verification history", { skip: !runDatabaseTests }, async () => {
  const createdSessionIds = [];
  let submissionCount = 0;
  let activeVerificationSessionId = null;
  const contractResults = new Map();

  async function createCompletedSession(title, text = "The community discussed a possible release with no confirmed date.") {
    const id = crypto.randomUUID();
    createdSessionIds.push(id);
    const timestamp = new Date();
    await pool.query(
      `INSERT INTO sessions (id, title, status, started_at, ended_at)
       VALUES ($1, $2, 'completed', $3, $3)`,
      [id, title, timestamp],
    );
    if (text) {
      await pool.query(
        `INSERT INTO transcript_segments
          (session_id, sequence_number, text, captured_at, is_final, provider, dedupe_key,
           source_start_seconds, source_duration_seconds)
         VALUES ($1, 1, $2, $3, TRUE, 'test', $4, 1, 1)`,
        [id, text, timestamp, `${id}-segment`],
      );
    }
    return id;
  }

  const services = {
    getGenLayerConfiguration: () => ({ contractAddress, network, supportsVerificationAttempts: true }),
    submitTranscriptVerification: async ({ verificationId }) => {
      submissionCount += 1;
      const transactionHash = `0x${String(submissionCount).padStart(64, "0")}`;
      contractResults.set(verificationId, submissionCount === 1 ? "REJECTED" : "ACCEPTED");
      return { transactionHash, contractAddress, network };
    },
    getTranscriptTransaction: async () => ({ statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_RETURN" }),
    getTranscriptVerification: async (verificationId) => ({
      transcript_hash: (await getSessionDerivative(activeVerificationSessionId)).transcriptHash,
      status: contractResults.get(verificationId) ?? "REJECTED",
      reason: contractResults.get(verificationId) === "ACCEPTED" ? "The regenerated summary is faithful." : "The first summary changes the transcript's certainty.",
    }),
  };

  try {
    const legacyId = await createCompletedSession(`Legacy summary attempt ${crypto.randomUUID()}`);
    const legacyProcessed = await processCompletedSession(legacyId, async () => ({
      summary: "The community discussed a possible release with no confirmed date.",
      topics: ["Release planning"],
      announcements: [],
      questionsAnswers: [],
    }));
    assert.equal(legacyProcessed.kind, "ready");
    const legacyDuplicate = await processCompletedSession(legacyId, async () => { throw new Error("ready summaries must not regenerate"); });
    assert.equal(legacyDuplicate.derivative.summary, legacyProcessed.derivative.summary);

    const rejectedId = await createCompletedSession(`Rejected recovery ${crypto.randomUUID()}`);
    activeVerificationSessionId = rejectedId;
    const first = await processCompletedSession(rejectedId, async () => ({
      summary: "The community confirmed a release date.",
      topics: [],
      announcements: [],
      questionsAnswers: [],
    }));
    assert.equal(first.kind, "ready");
    const rejected = await submitSessionVerification(rejectedId, services);
    assert.equal(rejected.verification.verificationStatus, "rejected");
    const firstDerivative = await getSessionDerivative(rejectedId);
    const regenerated = await regenerateCompletedSession(rejectedId, async (canonicalTranscript) => {
      assert.equal(canonicalTranscript, firstDerivative.canonicalTranscript);
      return {
        summary: "The community discussed a possible release and no date was confirmed.",
        topics: [],
        announcements: [],
        questionsAnswers: [],
      };
    });
    assert.equal(regenerated.kind, "ready");
    assert.equal(regenerated.derivative.transcriptHash, firstDerivative.transcriptHash);
    assert.notEqual(regenerated.derivative.summaryHash, firstDerivative.summaryHash);
    assert.equal(regenerated.derivative.summaryAttempts.length, 2);
    assert.equal(regenerated.derivative.summaryAttempts[0].summary, firstDerivative.summary);

    const accepted = await submitSessionVerification(rejectedId, services);
    assert.equal(accepted.verification.verificationStatus, "accepted");
    assert.equal((await submitSessionVerification(rejectedId, services)).verification.verificationStatus, "accepted");
    assert.equal(submissionCount, 2);
    const history = await getSessionVerificationHistory(rejectedId);
    assert.deepEqual(history.map((item) => item.verificationStatus), ["rejected", "accepted"]);
    assert.equal(history[0].summaryAttemptNumber, 1);
    assert.equal(history[1].summaryAttemptNumber, 2);

    const emptyId = await createCompletedSession(`No transcript ${crypto.randomUUID()}`, "");
    assert.equal((await processCompletedSession(emptyId, async () => { throw new Error("must not call provider"); })).kind, "no_transcript");

    const failedId = await createCompletedSession(`Retry failed summary ${crypto.randomUUID()}`);
    assert.equal((await processCompletedSession(failedId, async () => { throw new Error("provider failure"); })).kind, "failed");
    assert.equal((await processCompletedSession(failedId, async () => ({
      summary: "The provider retry succeeded.", topics: [], announcements: [], questionsAnswers: [],
    }))).kind, "ready");

    const deleted = await pool.query("DELETE FROM sessions WHERE id = $1", [rejectedId]);
    assert.equal(deleted.rowCount, 1);
    const localEvidence = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM summary_attempts WHERE session_id = $1)::integer AS summaries,
         (SELECT COUNT(*) FROM verification_attempts WHERE session_id = $1)::integer AS verifications`,
      [rejectedId],
    );
    assert.deepEqual(localEvidence.rows[0], { summaries: 0, verifications: 0 });
  } finally {
    if (createdSessionIds.length > 0) await pool.query("DELETE FROM sessions WHERE id = ANY($1::text[])", [createdSessionIds]);
    await pool.end();
  }
});
