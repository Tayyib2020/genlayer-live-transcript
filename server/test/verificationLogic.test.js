import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildVerificationSubmissionArgs,
  buildVerificationId,
  mapTransactionState,
  normalizeContractVerification,
  validateVerificationReadiness,
} from "../src/genlayer/verificationLogic.js";
import { submitTranscriptVerification } from "../src/genlayer/transcriptVerifier.js";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/genlayer-verification-responses.json", import.meta.url), "utf8"));

const transcript = "[00:00:01] Speaker: The launch is planned for next month.";
const transcriptHash = "0x" + "a".repeat(64);
const derivative = {
  canonicalTranscript: transcript,
  transcriptHash,
  summary: "The launch is planned for next month.",
  summaryGenerationStatus: "ready",
};

test("incomplete sessions cannot pass verification readiness", () => {
  assert.throws(
    () => validateVerificationReadiness({ sessionStatus: "live", finalizedTranscriptCount: 1, derivative }),
    /Only completed sessions can be verified/,
  );
});

test("completed sessions without a ready summary cannot verify", () => {
  assert.throws(
    () => validateVerificationReadiness({ sessionStatus: "completed", finalizedTranscriptCount: 1, derivative: { ...derivative, summaryGenerationStatus: "failed" } }),
    /ready generated summary is required/,
  );
});

test("contract arguments preserve the exact persisted transcript, summary, and hash", () => {
  assert.deepEqual(
    buildVerificationSubmissionArgs({ transcript, summary: derivative.summary, transcriptHash }),
    [transcript, derivative.summary, transcriptHash],
  );
});

test("summary attempts derive distinct deterministic verification identities without changing transcript hash", () => {
  const firstSummaryHash = "0x" + "b".repeat(64);
  const secondSummaryHash = "0x" + "c".repeat(64);
  assert.notEqual(buildVerificationId(transcriptHash, firstSummaryHash), buildVerificationId(transcriptHash, secondSummaryHash));
  assert.equal(transcriptHash, "0x" + "a".repeat(64));
});

test("readiness rejects a derivative whose canonical transcript or hash changed", () => {
  assert.throws(
    () => validateVerificationReadiness({
      sessionStatus: "completed",
      finalizedTranscriptCount: 1,
      derivative,
      computedIntegrity: { canonicalTranscript: `${transcript}\n`, transcriptHash },
    }),
    /does not match/,
  );
});

test("transaction success alone does not produce an accepted verdict", () => {
  assert.deepEqual(
    mapTransactionState({ statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_RETURN" }),
    { kind: "ready_to_read", status: "FINALIZED", execution: "FINISHED_WITH_RETURN", finalizationPending: false },
  );
});

test("contract ACCEPTED and REJECTED records map only from the contract result", () => {
  assert.equal(normalizeContractVerification({ transcript_hash: transcriptHash, status: "ACCEPTED", reason: "Faithful." }, transcriptHash).contractStatus, "ACCEPTED");
  assert.equal(normalizeContractVerification({ transcript_hash: transcriptHash, status: "REJECTED", reason: "Fabricated claim." }, transcriptHash).contractStatus, "REJECTED");
});

test("Bradbury decision output is parsed deterministically", () => {
  assert.equal(mapTransactionState(fixtures.observedProduction.transaction).kind, "ready_to_read");
  assert.equal(
    normalizeContractVerification(fixtures.observedProduction.transaction, transcriptHash).contractStatus,
    "ACCEPTED",
  );
  assert.deepEqual(
    normalizeContractVerification(
      "decisionACCEPTED\nThe summary faithfully captures the transcript.",
      transcriptHash,
    ),
    {
      transcriptHash,
      contractStatus: "ACCEPTED",
      reason: "The summary faithfully captures the transcript.",
      submittedAt: null,
    },
  );
  assert.equal(
    normalizeContractVerification(fixtures.decisionRejected, transcriptHash).contractStatus,
    "REJECTED",
  );
  assert.throws(
    () => normalizeContractVerification({ reason: "The explanation mentions decisionACCEPTED but is not a contract verdict." }, transcriptHash),
    /invalid verification status/,
  );
});

test("pending and failed transaction states remain distinct from semantic verdicts", () => {
  assert.equal(mapTransactionState({ statusName: "PROPOSING" }).kind, "pending");
  assert.equal(mapTransactionState({ statusName: "CANCELED" }).kind, "failed");
  assert.equal(mapTransactionState({ statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_ERROR" }).kind, "failed");
  assert.equal(
    mapTransactionState(fixtures.finalizationPending).kind,
    "pending",
  );
  assert.equal(mapTransactionState(fixtures.executionFailure).kind, "failed");
  assert.throws(() => normalizeContractVerification("contract execution failed", transcriptHash), /invalid verification status/);
});

test("malformed contract records are rejected safely", () => {
  assert.throws(() => normalizeContractVerification({}, transcriptHash), /no TranscriptVerifier record/);
  assert.throws(() => normalizeContractVerification({ transcript_hash: transcriptHash, status: "ACCEPTED", reason: "" }, transcriptHash), /no adjudication reason/);
});

test("missing GenLayer private key is an explicit server configuration error", async () => {
  const previous = process.env.GENLAYER_PRIVATE_KEY;
  delete process.env.GENLAYER_PRIVATE_KEY;
  try {
    await assert.rejects(
      submitTranscriptVerification({ transcript, summary: derivative.summary, transcriptHash }),
      (error) => error.code === "genlayer_private_key_missing",
    );
  } finally {
    if (previous === undefined) delete process.env.GENLAYER_PRIVATE_KEY;
    else process.env.GENLAYER_PRIVATE_KEY = previous;
  }
});
