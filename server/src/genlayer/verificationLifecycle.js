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

export async function refreshSessionVerification(sessionId, services = {}, userId = null) {
  const transactionReader = services.getTranscriptTransaction ?? getTranscriptTransaction;
  const contractReader = services.getTranscriptVerification ?? getTranscriptVerification;
  const current = await getSessionVerification(sessionId, userId);
  if (!current || !current.transactionHash) return current;
  if (["accepted", "rejected"].includes(current.verificationStatus)) return current;

  let transaction;
  try {
    transaction = await transactionReader(current.transactionHash);
  } catch (error) {
    logLifecycleError(error, sessionId, current);
    // A status/RPC read failure is not evidence of a semantic rejection or a
    // failed transaction. Keep the existing transaction and make Refresh
    // retryable; this also recovers records incorrectly marked failed earlier.
    await recordVerificationPending(current.id, { transactionStatus: current.transactionStatus ?? "PENDING" });
    return getSessionVerification(sessionId, userId);
  }

  const transactionState = mapTransactionState(transaction);
  await recordTransactionStatus(current.id, { transactionStatus: transactionState.status });
  if (transactionState.kind === "pending") {
    await recordVerificationPending(current.id, { transactionStatus: transactionState.status });
    return getSessionVerification(sessionId, userId);
  }

  try {
    let record;
    try {
      // Some Bradbury responses expose the authoritative contract return in
      // an execution-result field. Parse that exact result before falling
      // back to the persisted contract view.
      record = normalizeContractVerification(transaction, current.transcriptHash);
    } catch {
      record = normalizeContractVerification(
        await contractReader(current.verificationId),
        current.transcriptHash,
      );
    }
    await recordContractVerification(current.id, record);
  } catch (error) {
    logLifecycleError(error, sessionId, current);
    if (transactionState.finalizationPending || isTransientReadError(error)) {
      await recordVerificationPending(current.id, { transactionStatus: transactionState.status });
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
