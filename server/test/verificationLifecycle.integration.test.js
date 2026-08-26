import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { pool } from "../src/db/pool.js";
import { processCompletedSession } from "../src/db/sessionProcessing.js";
import {
  getSessionVerification,
  getSessionVerificationHistory,
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
      if (transactionMode === "leader_timeout") return { statusName: "LEADER_TIMEOUT" };
      if (transactionMode === "failed") return { statusName: "CANCELED" };
      if (transactionMode === "accepted_consensus") return { statusName: "ACCEPTED", txExecutionResultName: "FINISHED_WITH_ERROR", executionError: "decisionACCEPTED\nFaithful summary.", finalizationStatus: "WAITING" };
      if (transactionMode === "rejected_consensus") return { statusName: "ACCEPTED", txExecutionResultName: "FINISHED_WITH_ERROR", executionError: "decisionREJECTED\nThe summary changes an uncertain statement.", finalizationStatus: "WAITING" };
      if (transactionMode === "finalized_outcome_processing") return { statusName: "FINALIZED", storedConsensus: "undetermined", pendingAction: "process_consensus_outcome" };
      if (transactionMode === "finalized_semantic_accepted") return { statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_ERROR", executionError: "decisionACCEPTED\nFaithful summary." };
      if (transactionMode === "finalized_semantic_rejected") return { statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_ERROR", executionError: "decisionREJECTED\nThe summary changes an uncertain statement." };
      if (transactionMode === "appeal_recovered") return { statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_ERROR", consensus_data: { leader_receipt: [{ result: "decisionREJECTED\nThe appeal overturned the earlier timeout; the summary changes an uncertain statement." }] } };
      return { statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_RETURN" };
    },
    getTranscriptVerification: async (transcriptHash) => {
      if (contractMode === "read_failed") throw new Error("temporary RPC read failure");
      if (contractMode === "read_empty") return {};
      if (transactionMode === "failed") return {};
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

    const outcomeProcessingReady = await makeReadySession(`Phase 7 finalized outcome processing ${crypto.randomUUID()}`, "The outcome is still being processed.");
    transactionMode = "finalized_outcome_processing";
    contractMode = "read_empty";
    const outcomeProcessing = await submitSessionVerification(outcomeProcessingReady.id, services);
    assert.equal(outcomeProcessing.verification.verificationStatus, "pending");
    assert.equal(outcomeProcessing.verification.contractStatus, null);
    assert.equal(outcomeProcessing.verification.transactionStatus, "FINALIZED_PROCESSING_OUTCOME");
    const outcomeSubmissionCount = submissionCount;
    transactionMode = "finalized_semantic_accepted";
    const outcomeRecovered = await submitSessionVerification(outcomeProcessingReady.id, services);
    assert.equal(outcomeRecovered.verification.verificationStatus, "accepted");
    assert.equal(outcomeRecovered.verification.contractStatus, "ACCEPTED");
    assert.equal(submissionCount, outcomeSubmissionCount);

    const consensusReady = await makeReadySession(`Phase 7 accepted consensus ${crypto.randomUUID()}`, "Consensus has accepted the summary.");
    transactionMode = "accepted_consensus";
    contractMode = "read_empty";
    const consensusPending = await submitSessionVerification(consensusReady.id, services);
    assert.equal(consensusPending.verification.verificationStatus, "pending");
    assert.equal(consensusPending.verification.contractStatus, "ACCEPTED");
    assert.equal(consensusPending.verification.finalizationPending, true);
    const consensusSubmissionCount = submissionCount;
    transactionMode = "finalized_semantic_accepted";
    const consensusFinalized = await submitSessionVerification(consensusReady.id, services);
    assert.equal(consensusFinalized.verification.verificationStatus, "accepted");
    assert.equal(consensusFinalized.verification.contractStatus, "ACCEPTED");
    assert.equal(consensusFinalized.verification.transactionHash, consensusPending.verification.transactionHash);
    assert.equal(submissionCount, consensusSubmissionCount);
    const consensusHistory = await getSessionVerificationHistory(consensusReady.id);
    assert.equal(consensusHistory.length, 1);
    assert.equal(consensusHistory[0].transactionHash, consensusPending.verification.transactionHash);

    const rejectedConsensusReady = await makeReadySession(`Phase 7 rejected consensus ${crypto.randomUUID()}`, "Consensus has rejected the summary.");
    transactionMode = "rejected_consensus";
    contractMode = "read_empty";
    const rejectedConsensusPending = await submitSessionVerification(rejectedConsensusReady.id, services);
    assert.equal(rejectedConsensusPending.verification.verificationStatus, "pending");
    assert.equal(rejectedConsensusPending.verification.contractStatus, "REJECTED");
    transactionMode = "finalized_semantic_rejected";
    const rejectedConsensusFinalized = await submitSessionVerification(rejectedConsensusReady.id, services);
    assert.equal(rejectedConsensusFinalized.verification.verificationStatus, "rejected");
    assert.equal(rejectedConsensusFinalized.verification.contractStatus, "REJECTED");

    const appealRecoveryReady = await makeReadySession(`Phase 7 appeal recovery ${crypto.randomUUID()}`, "The statement remains uncertain.");
    transactionMode = "leader_timeout";
    contractMode = "read_empty";
    const initialTimeout = await submitSessionVerification(appealRecoveryReady.id, services);
    assert.equal(initialTimeout.verification.verificationStatus, "pending");
    const recoveryTransactionHash = initialTimeout.verification.transactionHash;
    await pool.query(
      `UPDATE verification_attempts
          SET verification_status = 'failed', transaction_status = 'LEADER_TIMEOUT', error = 'The GenLayer transaction ended in LEADER_TIMEOUT.'
        WHERE session_id = $1`,
      [appealRecoveryReady.id],
    );
    transactionMode = "appeal_recovered";
    const recoveredAppeal = await submitSessionVerification(appealRecoveryReady.id, services);
    assert.equal(recoveredAppeal.verification.verificationStatus, "rejected");
    assert.equal(recoveredAppeal.verification.contractStatus, "REJECTED");
    assert.match(recoveredAppeal.verification.reason, /appeal overturned/i);
    assert.equal(recoveredAppeal.verification.transactionHash, recoveryTransactionHash);
    assert.equal(submissionCount, 5);
    const recoveryHistory = await getSessionVerificationHistory(appealRecoveryReady.id);
    assert.equal(recoveryHistory.length, 1);
    assert.equal(recoveryHistory[0].transactionHash, recoveryTransactionHash);

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
    assert.equal(readFailure.verification.verificationStatus, "pending");
    assert.equal(readFailure.verification.retryable, false);
    await pool.query(
      "UPDATE verification_attempts SET verification_status = 'failed', error = 'legacy misclassification' WHERE session_id = $1",
      [readFailureReady.id],
    );
    const readFailureRetry = await submitSessionVerification(readFailureReady.id, { ...services, getTranscriptVerification: async (hash) => ({ transcript_hash: hash, status: "ACCEPTED", reason: "Recovered read." }) });
    assert.equal(readFailureRetry.verification.verificationStatus, "accepted");
    assert.equal(submissionCount, 8);

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
