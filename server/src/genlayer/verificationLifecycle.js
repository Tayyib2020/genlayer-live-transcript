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
    await recordVerificationFailure(current.id, safeVerificationError(error));
    return getSessionVerification(sessionId, userId);
  }

  const transactionState = mapTransactionState(transaction);
  await recordTransactionStatus(current.id, { transactionStatus: transactionState.status });
  if (transactionState.kind === "pending") return getSessionVerification(sessionId, userId);
  if (transactionState.kind === "failed") {
    await recordVerificationFailure(current.id, transactionState.message);
    return getSessionVerification(sessionId, userId);
  }

  try {
    const record = normalizeContractVerification(
      await contractReader(current.verificationId),
      current.transcriptHash,
    );
    await recordContractVerification(current.id, record);
  } catch (error) {
    logLifecycleError(error, sessionId, current);
    await recordVerificationFailure(current.id, safeVerificationError(error));
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
