import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { pool } from "../src/db/pool.js";
import { processCompletedSession } from "../src/db/sessionProcessing.js";
import {
  getSessionVerification,
} from "../src/db/verificationStore.js";
import { submitSessionVerification } from "../src/genlayer/verificationLifecycle.js";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1";
const contractAddress = "0x4DEfE1bbE75C59FcD2264EaCb75096f3CD659f5B";
const network = "testnet-bradbury";

test("Phase 7 verification lifecycle and evidence persistence", { skip: !runDatabaseTests }, async () => {
  const createdSessionIds = [];
  const transactionHash = `0x${"b".repeat(64)}`;
  let transactionMode = "pending";
  let contractMode = "ACCEPTED";
  let submissionCount = 0;
  const submittedArgs = [];

  const services = {
    getGenLayerConfiguration: () => ({ contractAddress, network, configured: true }),
    submitTranscriptVerification: async (args) => {
      submissionCount += 1;
      submittedArgs.push(args);
      return { transactionHash, contractAddress, network };
    },
    getTranscriptTransaction: async () => {
      if (transactionMode === "pending") return { statusName: "PROPOSING" };
      if (transactionMode === "failed") return { statusName: "CANCELED" };
      return { statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_RETURN" };
    },
    getTranscriptVerification: async (transcriptHash) => {
      if (contractMode === "read_failed") throw new Error("temporary RPC read failure");
      return { transcript_hash: transcriptHash, status: contractMode, reason: contractMode === "ACCEPTED" ? "Faithful summary." : "The summary changes a confirmed claim." };
    },
  };

  async function createCompletedSession(title, text = "A finalized transcript.") {
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

  async function makeReadySession(title, text) {
    const id = await createCompletedSession(title, text);
    const processed = await processCompletedSession(id, async () => ({
      summary: "A faithful summary of the finalized transcript.",
      topics: ["Testing"],
      announcements: [],
      questionsAnswers: [],
    }));
    assert.equal(processed.kind, "ready");
    return { id, derivative: processed.derivative };
  }

  try {
    const incompleteId = await createCompletedSession(`Phase 7 incomplete ${crypto.randomUUID()}`);
    await pool.query("UPDATE sessions SET status = 'live' WHERE id = $1", [incompleteId]);
    await assert.rejects(submitSessionVerification(incompleteId, services), /Only completed sessions can be verified/);

    const noSummaryId = await createCompletedSession(`Phase 7 no summary ${crypto.randomUUID()}`);
    await assert.rejects(submitSessionVerification(noSummaryId, services), /Process the completed transcript/);

    const ready = await makeReadySession(`Phase 7 ready ${crypto.randomUUID()}`, "The team confirmed the release plan.");
    transactionMode = "pending";
    contractMode = "ACCEPTED";
    const pending = await submitSessionVerification(ready.id, services);
    assert.equal(pending.verification.verificationStatus, "pending");
    assert.equal(submissionCount, 1);
    assert.deepEqual(submittedArgs[0], {
      transcript: ready.derivative.canonicalTranscript,
      summary: ready.derivative.summary,
      transcriptHash: ready.derivative.transcriptHash,
      verificationId: ready.derivative.transcriptHash,
      useAttemptIdentity: false,
    });
    assert.equal(submittedArgs[0].transcriptHash, ready.derivative.transcriptHash);

    transactionMode = "accepted";
    const accepted = await submitSessionVerification(ready.id, services);
    assert.equal(accepted.verification.verificationStatus, "accepted");
    assert.equal(accepted.verification.contractStatus, "ACCEPTED");
    assert.equal(accepted.verification.reason, "Faithful summary.");

    const duplicate = await submitSessionVerification(ready.id, services);
    assert.equal(duplicate.verification.verificationStatus, "accepted");
    assert.equal(submissionCount, 1);

    const rejectedReady = await makeReadySession(`Phase 7 rejected ${crypto.randomUUID()}`, "The launch date is unconfirmed.");
    contractMode = "REJECTED";
    transactionMode = "accepted";
    const rejected = await submitSessionVerification(rejectedReady.id, services);
    assert.equal(rejected.verification.verificationStatus, "rejected");
    assert.equal(rejected.verification.contractStatus, "REJECTED");

    const failedReady = await makeReadySession(`Phase 7 failed ${crypto.randomUUID()}`, "The provider is available.");
    transactionMode = "failed";
    const failed = await submitSessionVerification(failedReady.id, services);
    assert.equal(failed.verification.verificationStatus, "failed");
    assert.equal(failed.verification.retryable, false);

    const readFailureReady = await makeReadySession(`Phase 7 read failure ${crypto.randomUUID()}`, "The result requires consensus.");
    transactionMode = "accepted";
    contractMode = "read_failed";
    const readFailure = await submitSessionVerification(readFailureReady.id, services);
    assert.equal(readFailure.verification.verificationStatus, "failed");
    assert.equal(readFailure.verification.retryable, false);
    const readFailureRetry = await submitSessionVerification(readFailureReady.id, { ...services, getTranscriptVerification: async (hash) => ({ transcript_hash: hash, status: "ACCEPTED", reason: "Recovered read." }) });
    assert.equal(readFailureRetry.verification.verificationStatus, "accepted");
    assert.equal(submissionCount, 4);

    const legacy = await makeReadySession(`Phase 7 archived legacy ${crypto.randomUUID()}`, "An archived session remains verifiable.");
    transactionMode = "pending";
    contractMode = "ACCEPTED";
    assert.equal((await submitSessionVerification(legacy.id, services)).verification.verificationStatus, "pending");

    const deleted = await pool.query("DELETE FROM sessions WHERE id = $1", [ready.id]);
    assert.equal(deleted.rowCount, 1);
    assert.equal(await getSessionVerification(ready.id), null);
  } finally {
    if (createdSessionIds.length > 0) await pool.query("DELETE FROM sessions WHERE id = ANY($1::text[])", [createdSessionIds]);
    await pool.end();
  }
});
