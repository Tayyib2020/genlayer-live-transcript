import crypto from "node:crypto";

const TRANSACTION_STATUS_BY_NUMBER = {
  0: "UNINITIALIZED",
  1: "PENDING",
  2: "PROPOSING",
  3: "COMMITTING",
  4: "REVEALING",
  5: "ACCEPTED",
  6: "UNDETERMINED",
  7: "FINALIZED",
  8: "CANCELED",
  9: "APPEAL_REVEALING",
  10: "APPEAL_COMMITTING",
  11: "READY_TO_FINALIZE",
  12: "VALIDATORS_TIMEOUT",
  13: "LEADER_TIMEOUT",
};

const PENDING_TRANSACTION_STATES = new Set([
  "UNINITIALIZED",
  "PENDING",
  "PROPOSING",
  "COMMITTING",
  "REVEALING",
  "APPEAL_REVEALING",
  "APPEAL_COMMITTING",
  "READY_TO_FINALIZE",
]);

const TERMINAL_FAILURE_STATES = new Set([
  "UNDETERMINED",
  "CANCELED",
  "VALIDATORS_TIMEOUT",
]);

const RECOVERABLE_TRANSACTION_STATES = new Set([
  "LEADER_TIMEOUT",
]);

const PENDING_FINALIZATION_STATES = new Set([
  "PENDING",
  "WAITING",
  "IN_PROGRESS",
  "NOT_FINALIZED",
  "FINALIZING",
]);

const CONTRACT_OUTPUT_FIELDS = [
  "output",
  "returnValue",
  "return_value",
  "contractOutput",
  "contract_output",
  "executionError",
  "execution_error",
  "outputData",
  "output_data",
  "executionOutput",
  "execution_output",
  "returnData",
  "return_data",
  "consensus_data",
  "consensusData",
  "leader_receipt",
  "leaderReceipt",
  "readable",
  "result",
  "value",
];

export class VerificationError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = "VerificationError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function buildVerificationId(transcriptHash, summaryHash) {
  if (!/^0x[0-9a-f]{64}$/i.test(transcriptHash ?? "") || !/^0x[0-9a-f]{64}$/i.test(summaryHash ?? "")) {
    throw new VerificationError("verification_id_invalid", "Transcript and summary hashes are required to build a verification identity.");
  }
  return `0x${crypto.createHash("sha256").update(`${transcriptHash.toLowerCase()}:${summaryHash.toLowerCase()}`, "utf8").digest("hex")}`;
}

export function buildVerificationSubmissionArgs({ transcript, summary, transcriptHash }) {
  if (typeof transcript !== "string" || !transcript) {
    throw new VerificationError("canonical_transcript_missing", "The persisted canonical transcript is missing.");
  }
  if (typeof summary !== "string" || !summary.trim()) {
    throw new VerificationError("summary_missing", "A ready persisted summary is required before verification.");
  }
  if (!/^0x[0-9a-f]{64}$/.test(transcriptHash ?? "")) {
    throw new VerificationError("transcript_hash_invalid", "The persisted transcript hash is invalid.");
  }
  return [transcript, summary, transcriptHash];
}

export function validateVerificationReadiness({
  sessionStatus,
  finalizedTranscriptCount,
  derivative,
  computedIntegrity,
}) {
  if (sessionStatus !== "completed") {
    throw new VerificationError("session_not_completed", "Only completed sessions can be verified.");
  }
  if (Number(finalizedTranscriptCount) < 1) {
    throw new VerificationError("no_finalized_transcript", "A finalized transcript is required before verification.");
  }
  if (!derivative) {
    throw new VerificationError("derivative_missing", "Process the completed transcript before verification.");
  }
  if (derivative.summaryGenerationStatus !== "ready" || !derivative.summary?.trim()) {
    throw new VerificationError("summary_not_ready", "A ready generated summary is required before verification.");
  }
  if (!derivative.canonicalTranscript || !derivative.transcriptHash) {
    throw new VerificationError("integrity_missing", "The canonical transcript and hash are required before verification.");
  }
  if (computedIntegrity && (
    computedIntegrity.canonicalTranscript !== derivative.canonicalTranscript
    || computedIntegrity.transcriptHash !== derivative.transcriptHash
  )) {
    throw new VerificationError("integrity_mismatch", "The persisted transcript derivative does not match the finalized transcript.");
  }
  return {
    transcript: derivative.canonicalTranscript,
    summary: derivative.summary,
    transcriptHash: derivative.transcriptHash,
  };
}

export function normalizeTransactionStatus(transaction) {
  if (typeof transaction?.statusName === "string") return transaction.statusName;
  if (typeof transaction?.status === "string") return transaction.status;
  if (Number.isInteger(transaction?.status)) return TRANSACTION_STATUS_BY_NUMBER[transaction.status] ?? "UNKNOWN";
  return "UNKNOWN";
}

function transactionExecutionResult(transaction) {
  return transaction?.txExecutionResultName
    ?? (transaction?.txExecutionResult === 1 ? "FINISHED_WITH_RETURN" : transaction?.txExecutionResult === 2 ? "FINISHED_WITH_ERROR" : undefined);
}

function transactionFinalizationPending(transaction, status) {
  if (transaction?.finalized === true || transaction?.isFinalized === true || transaction?.consensus_data?.final === true) return false;
  if (transaction?.finalized === false || transaction?.isFinalized === false || transaction?.consensus_data?.final === false) return true;
  const finalizationStatus = transaction?.finalizationStatus
    ?? transaction?.finalization_status
    ?? transaction?.finalizationState;
  if (typeof finalizationStatus === "string") {
    const normalized = finalizationStatus.trim().toUpperCase();
    if (PENDING_FINALIZATION_STATES.has(normalized)) return true;
    if (["FINALIZED", "COMPLETE", "COMPLETED"].includes(normalized)) return false;
  }
  // GenLayer's ACCEPTED state means validator consensus has been reached;
  // FINALIZED is the separate state after the finalization window.
  return status === "ACCEPTED";
}

export function mapTransactionState(transaction) {
  const status = normalizeTransactionStatus(transaction);
  const execution = transactionExecutionResult(transaction);
  const finalizationPending = transactionFinalizationPending(transaction, status);

  // Bradbury can report a consensus decision separately from the execution
  // field. In particular, a valid TranscriptVerifier result may be exposed
  // alongside FINISHED_WITH_ERROR, so the semantic contract read must remain
  // authoritative when consensus has accepted/finalized the transaction.
  if (finalizationPending || PENDING_TRANSACTION_STATES.has(status)) {
    return { kind: "pending", status, execution, finalizationPending };
  }
  if (RECOVERABLE_TRANSACTION_STATES.has(status)) {
    return { kind: "pending", status, execution, finalizationPending, recoverable: true };
  }
  if (execution === "FINISHED_WITH_ERROR" && status !== "ACCEPTED") {
    return {
      kind: "failed",
      status,
      execution,
      finalizationPending,
      code: "transaction_execution_failed",
      message: "The GenLayer transaction finalized with a contract execution error.",
    };
  }
  if (status === "ACCEPTED" || status === "FINALIZED") {
    return { kind: "ready_to_read", status, execution, finalizationPending };
  }
  if (TERMINAL_FAILURE_STATES.has(status)) {
    return {
      kind: "failed",
      status,
      execution,
      finalizationPending,
      code: execution === "FINISHED_WITH_ERROR" ? "transaction_execution_failed" : "transaction_undetermined",
      message: execution === "FINISHED_WITH_ERROR"
        ? "The GenLayer transaction finalized with a contract execution error."
        : `The GenLayer transaction ended in ${status}.`,
    };
  }
  return { kind: "pending", status, execution, finalizationPending };
}

function parseDecisionOutput(value) {
  if (typeof value !== "string") return null;
  const output = value.trim();
  // The decision marker is the contract's authoritative encoding. It must be
  // the first token, so explanation text cannot accidentally become a verdict.
  const match = output.match(/^decision(ACCEPTED|REJECTED)(?:\r?\n|$)/);
  if (!match) return null;
  const reason = output.slice(match[0].length).trim();
  if (!reason) return null;
  return { status: match[1], reason };
}

function findDecisionOutput(value, depth = 0) {
  const direct = parseDecisionOutput(value);
  if (direct) return direct;
  if (!value || typeof value !== "object" || depth > 4) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = findDecisionOutput(item, depth + 1);
      if (parsed) return parsed;
    }
    return null;
  }
  for (const field of CONTRACT_OUTPUT_FIELDS) {
    if (!(field in value)) continue;
    const parsed = findDecisionOutput(value[field], depth + 1);
    if (parsed) return parsed;
  }
  return null;
}

export function normalizeContractVerification(record, expectedHash) {
  if (record === null || record === undefined || (typeof record === "object" && !Array.isArray(record) && Object.keys(record).length === 0)) {
    throw new VerificationError("contract_record_missing", "The finalized transaction has no TranscriptVerifier record yet.", { retryable: false });
  }

  const returnedHash = typeof record === "object" && !Array.isArray(record)
    ? (record.transcript_hash ?? record.transcriptHash)
    : undefined;
  if (returnedHash !== undefined && (typeof returnedHash !== "string" || returnedHash.toLowerCase() !== expectedHash.toLowerCase())) {
    throw new VerificationError("contract_hash_mismatch", "TranscriptVerifier returned a record for a different transcript hash.");
  }

  const structuredStatus = typeof record === "object" && !Array.isArray(record) ? record.status : undefined;
  const structuredReason = typeof record === "object" && !Array.isArray(record) ? record.reason : undefined;
  const parsedOutput = findDecisionOutput(record);
  const status = structuredStatus === "ACCEPTED" || structuredStatus === "REJECTED"
    ? structuredStatus
    : parsedOutput?.status;
  const reason = typeof structuredReason === "string" && structuredReason.trim()
    ? structuredReason
    : parsedOutput?.reason;

  if (status !== "ACCEPTED" && status !== "REJECTED") {
    throw new VerificationError("contract_record_malformed", "TranscriptVerifier returned an invalid verification status.");
  }
  if (typeof reason !== "string" || !reason.trim()) {
    throw new VerificationError("contract_reason_missing", "TranscriptVerifier returned no adjudication reason.");
  }
  return {
    transcriptHash: returnedHash ?? expectedHash,
    contractStatus: status,
    reason: reason.trim(),
    submittedAt: typeof record === "object" && !Array.isArray(record) ? (record.submitted_at ?? record.submittedAt ?? null) : null,
  };
}

export function safeVerificationError(error) {
  if (error instanceof VerificationError) return error.message;
  const raw = typeof error?.message === "string" ? error.message : "The GenLayer verification request failed.";
  return raw
    .replace(/0x[0-9a-f]{64}/gi, "[redacted-hash]")
    .replace(/(private[_ -]?key|authorization|database_url|api[_ -]?key)[^\s:]*/gi, "[redacted-secret]")
    .slice(0, 500) || "The GenLayer verification request failed.";
}
