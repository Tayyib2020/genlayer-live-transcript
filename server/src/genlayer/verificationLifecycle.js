import {
  getGenLayerConfiguration,
  getTranscriptTransaction,
  getTranscriptVerification,
  submitTranscriptVerification,
} from "./transcriptVerifier.js";
import {
  getSessionVerification,
  prepareSessionVerification,
  recordContractVerification,
  recordSubmittedTransaction,
  recordTransactionStatus,
  recordVerificationPending,
  recordVerificationFailure,
} from "../db/verificationStore.js";
import {
  mapTransactionState,
  normalizeContractVerification,
  safeVerificationError,
} from "./verificationLogic.js";

function logLifecycleError(error, sessionId, verification) {
  console.error("GenLayer verification lifecycle error", {
    sessionId,
    code: error?.code ?? "genlayer_lifecycle_failed",
    message: safeVerificationError(error),
    network: verification?.network,
    contractAddress: verification?.contractAddress,
    transactionHash: verification?.transactionHash,
    transcriptHash: verification?.transcriptHash,
  });
}

const DETERMINISTIC_RESULT_ERRORS = new Set([
  "contract_record_missing",
  "contract_record_malformed",
  "contract_hash_mismatch",
  "contract_reason_missing",
]);

function isTransientReadError(error) {
  return !DETERMINISTIC_RESULT_ERRORS.has(error?.code);
}

function executionFailureMessage(transactionState, error) {
  if (transactionState?.execution === "FINISHED_WITH_ERROR") {
    return "The GenLayer transaction finalized with a contract execution error.";
  }
  return transactionState?.kind === "failed"
    ? transactionState.message
    : safeVerificationError(error);
}

function persistedSemanticVerdict(verification) {
  if (!verification || !["ACCEPTED", "REJECTED"].includes(verification.contractStatus)) return null;
  if (typeof verification.reason !== "string" || !verification.reason.trim()) return null;
  return {
    transcriptHash: verification.transcriptHash,
    contractStatus: verification.contractStatus,
    reason: verification.reason,
    submittedAt: verification.submittedAt ?? null,
  };
}

export async function refreshSessionVerification(sessionId, services = {}, userId = null) {
  const transactionReader = services.getTranscriptTransaction ?? getTranscriptTransaction;
  const contractReader = services.getTranscriptVerification ?? getTranscriptVerification;
  const current = await getSessionVerification(sessionId, userId);
  if (!current || !current.transactionHash) return current;

  let transaction;
  try {
    transaction = await transactionReader(current.transactionHash);
  } catch (error) {
    logLifecycleError(error, sessionId, current);
    // A status/RPC read failure is not evidence of a semantic rejection or a
    // failed transaction. Keep the existing transaction and make Refresh
    // retryable; this also recovers records incorrectly marked failed earlier.
    if (persistedSemanticVerdict(current)) return current;
    await recordVerificationPending(current.id, { transactionStatus: current.transactionStatus ?? "PENDING" });
    return getSessionVerification(sessionId, userId);
  }

  const transactionState = mapTransactionState(transaction);
  const transactionStatus = transactionState.lifecycleStatus ?? transactionState.status;
  await recordTransactionStatus(current.id, { transactionStatus });

  let transactionVerdict = null;
  try {
    // The transaction response is authoritative when it contains the
    // deterministic TranscriptVerifier decision, even before get_verification
    // is readable after the finalization window.
    transactionVerdict = normalizeContractVerification(transaction, current.transcriptHash);
  } catch {
    // The transaction may contain no semantic output. In that case the
    // secondary contract read remains the source of the persisted record.
  }

  const authoritativeVerdict = transactionVerdict ?? persistedSemanticVerdict(current);
  const finalizationPending = transactionState.finalizationPending;

  if (authoritativeVerdict) {
    await recordContractVerification(current.id, {
      ...authoritativeVerdict,
      finalizationPending,
    });
  } else if (transactionState.kind === "pending" && !transactionState.outcomeProcessingPending) {
    await recordVerificationPending(current.id, { transactionStatus });
    return getSessionVerification(sessionId, userId);
  }

  try {
    const record = normalizeContractVerification(
      await contractReader(current.verificationId),
      current.transcriptHash,
    );
    if (!transactionVerdict || record.contractStatus === transactionVerdict.contractStatus) {
      await recordContractVerification(current.id, { ...record, finalizationPending });
    }
  } catch (error) {
    if (transactionState.outcomeProcessingPending && error?.code === "contract_record_missing") {
      await recordVerificationPending(current.id, { transactionStatus });
      return getSessionVerification(sessionId, userId);
    }
    logLifecycleError(error, sessionId, current);
    if (authoritativeVerdict) {
      // Missing or temporarily unavailable get_verification evidence must not
      // erase a decision already present in the transaction response.
      return getSessionVerification(sessionId, userId);
    }
    if (finalizationPending || transactionState.outcomeProcessingPending || isTransientReadError(error)) {
      await recordVerificationPending(current.id, { transactionStatus });
    } else {
      await recordVerificationFailure(current.id, executionFailureMessage(transactionState, error));
    }
  }
  return getSessionVerification(sessionId, userId);
}

export async function submitSessionVerification(sessionId, services = {}, userId = null) {
  const configuration = (services.getGenLayerConfiguration ?? getGenLayerConfiguration)();
  const prepare = await prepareSessionVerification({
    sessionId,
    contractAddress: configuration.contractAddress,
    network: configuration.network,
    userId,
  });
  if (prepare.kind === "not_found") return { kind: "not_found" };
  if (prepare.kind === "duplicate") return { kind: "duplicate", verification: prepare.verification };
  if (prepare.kind === "existing") {
    if (prepare.verification.transactionHash) {
      return { kind: "existing", verification: await refreshSessionVerification(sessionId, services, userId) };
    }
    return { kind: "existing", verification: prepare.verification };
  }

  if (prepare.summaryAttempt.attempt_number > 1 && !configuration.supportsVerificationAttempts) {
    return {
      kind: "failed",
      verification: await recordVerificationFailure(
        prepare.verification.id,
        "The configured TranscriptVerifier deployment cannot store multiple summaries for one transcript. Redeployment is required before this summary attempt can be verified.",
      ),
    };
  }

  const submitter = services.submitTranscriptVerification ?? submitTranscriptVerification;
  let submitted;
  try {
    submitted = await submitter({
      transcript: prepare.transcript,
      summary: prepare.summary,
      transcriptHash: prepare.transcriptHash,
      verificationId: prepare.verification.verificationId,
      useAttemptIdentity: prepare.summaryAttempt.attempt_number > 1,
    });
  } catch (error) {
    logLifecycleError(error, sessionId, prepare.verification);
    return { kind: "failed", verification: await recordVerificationFailure(prepare.verification.id, safeVerificationError(error)) };
  }

  const pending = await recordSubmittedTransaction(prepare.verification.id, submitted);
  if (!pending) return { kind: "failed", verification: await recordVerificationFailure(prepare.verification.id, "The verification transaction was submitted but could not be persisted locally.") };
  return { kind: "pending", verification: await refreshSessionVerification(sessionId, services, userId) };
}
