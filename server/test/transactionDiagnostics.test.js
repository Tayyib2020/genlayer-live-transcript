import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTransactionReadDiagnostic,
  logTransactionReadDiagnostic,
} from "../src/genlayer/transcriptVerifier.js";

const config = {
  network: "testnet-bradbury",
  contractAddress: "0x4DEfE1bbE75C59FcD2264EaCb75096f3CD659f5B",
};

const context = {
  sessionId: "session-1",
  verificationAttemptId: 7,
  verificationAttemptNumber: 2,
};

test("successful transaction reads log concise status and semantic fields", () => {
  const entries = [];
  const diagnostic = logTransactionReadDiagnostic({
    transactionHash: "0x" + "a".repeat(64),
    transaction: {
      statusName: "FINALIZED",
      storedConsensus: "undetermined",
      pendingAction: "process_consensus_outcome",
      finalizationStatus: "FINALIZED",
      outputData: "decisionREJECTED\nThe summary changes an uncertain statement.",
    },
    context,
    config,
    timestamp: "2026-08-26T00:00:00.000Z",
    logger: { info: (message, value) => entries.push({ message, value }), error: () => {} },
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].message, "GenLayer verification transaction read");
  assert.equal(diagnostic.operation, "READ_EXISTING_TRANSACTION");
  assert.equal(diagnostic.getTransactionSucceeded, true);
  assert.equal(diagnostic.transactionReadResult, "ok");
  assert.equal(diagnostic.transactionStatus, "FINALIZED");
  assert.equal(diagnostic.consensusStatus, "undetermined");
  assert.equal(diagnostic.pendingAction, "process_consensus_outcome");
  assert.equal(diagnostic.semanticOutputMarker, "REJECTED");
});

test("null, undefined, empty, and explicit not-found reads are logged distinctly", () => {
  for (const transaction of [null, undefined, {}, { status: "NOT_FOUND" }]) {
    const diagnostic = buildTransactionReadDiagnostic({
      transactionHash: "0x" + "b".repeat(64),
      transaction,
      context,
      config,
    });
    assert.equal(diagnostic.getTransactionSucceeded, true);
    assert.equal(diagnostic.transactionReadResult, "not_found");
  }

  const diagnostic = buildTransactionReadDiagnostic({
    transactionHash: "0x" + "c".repeat(64),
    error: Object.assign(new Error("Transaction not found"), { code: "NOT_FOUND" }),
    context,
    config,
  });
  assert.equal(diagnostic.getTransactionSucceeded, false);
  assert.equal(diagnostic.transactionReadResult, "not_found");
});

test("RPC diagnostics include safe error metadata without secrets", () => {
  const diagnostic = buildTransactionReadDiagnostic({
    transactionHash: "0x" + "d".repeat(64),
    error: Object.assign(new Error("Authorization: Bearer bearer-secret API_KEY=api-secret DATABASE_URL=postgres-secret"), {
      name: "RpcError",
      code: "RPC_UNAVAILABLE",
      status: 503,
      retryable: true,
    }),
    context,
    config,
  });

  assert.equal(diagnostic.operation, "READ_EXISTING_TRANSACTION");
  assert.equal(diagnostic.rpcErrorName, "RpcError");
  assert.equal(diagnostic.rpcErrorCode, "RPC_UNAVAILABLE");
  assert.equal(diagnostic.httpStatus, 503);
  assert.equal(diagnostic.retryable, true);
  assert.match(diagnostic.rpcErrorMessage, /redacted/);
  assert.doesNotMatch(diagnostic.rpcErrorMessage, /bearer-secret|api-secret|postgres-secret/);
});
