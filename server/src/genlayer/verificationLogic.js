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
  "LEADER_TIMEOUT",
]);

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

export function mapTransactionState(transaction) {
  const status = normalizeTransactionStatus(transaction);
  const execution = transaction?.txExecutionResultName
    ?? (transaction?.txExecutionResult === 1 ? "FINISHED_WITH_RETURN" : transaction?.txExecutionResult === 2 ? "FINISHED_WITH_ERROR" : undefined);

  if (execution === "FINISHED_WITH_ERROR") {
    return { kind: "failed", status, code: "transaction_execution_failed", message: "The GenLayer transaction finalized with a contract execution error." };
  }
  if (TERMINAL_FAILURE_STATES.has(status)) {
    return { kind: "failed", status, code: "transaction_undetermined", message: `The GenLayer transaction ended in ${status}.` };
  }
  if (status === "ACCEPTED" || status === "FINALIZED") {
    return { kind: "ready_to_read", status };
  }
  if (PENDING_TRANSACTION_STATES.has(status)) {
    return { kind: "pending", status };
  }
  return { kind: "pending", status };
}

export function normalizeContractVerification(record, expectedHash) {
  if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).length === 0) {
    throw new VerificationError("contract_record_missing", "The finalized transaction has no TranscriptVerifier record yet.", { retryable: false });
  }
  const status = record.status;
  if (status !== "ACCEPTED" && status !== "REJECTED") {
    throw new VerificationError("contract_record_malformed", "TranscriptVerifier returned an invalid verification status.");
  }
  if (typeof record.transcript_hash !== "string" || record.transcript_hash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new VerificationError("contract_hash_mismatch", "TranscriptVerifier returned a record for a different transcript hash.");
  }
  if (typeof record.reason !== "string" || !record.reason.trim()) {
    throw new VerificationError("contract_reason_missing", "TranscriptVerifier returned no adjudication reason.");
  }
  return {
    transcriptHash: record.transcript_hash,
    contractStatus: status,
    reason: record.reason,
    submittedAt: record.submitted_at ?? null,
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
