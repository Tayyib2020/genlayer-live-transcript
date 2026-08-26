import { createAccount, createClient } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import {
  buildVerificationSubmissionArgs,
  VerificationError,
  safeVerificationError,
} from "./verificationLogic.js";

const DEFAULT_CONTRACT_ADDRESS = "0x4DEfE1bbE75C59FcD2264EaCb75096f3CD659f5B";
const SUPPORTED_NETWORK = "testnet-bradbury";
const READ_OPERATION = "READ_EXISTING_TRANSACTION";
const WRITE_OPERATION = "SUBMIT_NEW_TRANSACTION";
const DIAGNOSTIC_OUTPUT_FIELDS = [
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

function getConfig() {
  return {
    privateKey: (process.env.GENLAYER_PRIVATE_KEY ?? "").trim(),
    contractAddress: (process.env.GENLAYER_TRANSCRIPT_VERIFIER_ADDRESS ?? DEFAULT_CONTRACT_ADDRESS).trim(),
    network: (process.env.GENLAYER_NETWORK ?? SUPPORTED_NETWORK).trim().toLowerCase(),
    supportsVerificationAttempts: process.env.GENLAYER_TRANSCRIPT_VERIFIER_SUPPORTS_ATTEMPTS === "1",
  };
}

function requireConfig({ requireAccount = true } = {}) {
  const config = getConfig();
  if (config.network !== SUPPORTED_NETWORK) {
    throw new VerificationError("genlayer_network_unsupported", "GenLayer network must be testnet-bradbury.");
  }
  if (!/^0x[0-9a-f]{40}$/i.test(config.contractAddress)) {
    throw new VerificationError("genlayer_contract_invalid", "The configured TranscriptVerifier contract address is invalid.");
  }
  if (requireAccount && !config.privateKey) {
    throw new VerificationError("genlayer_private_key_missing", "GenLayer verification is unavailable until GENLAYER_PRIVATE_KEY is configured on the server.", { retryable: true });
  }
  if (requireAccount && !/^0x[0-9a-f]{64}$/i.test(config.privateKey)) {
    throw new VerificationError("genlayer_private_key_invalid", "The configured GenLayer private key is invalid.", { retryable: true });
  }
  return config;
}

function getClient({ requireAccount = true } = {}) {
  const config = requireConfig({ requireAccount });
  const account = requireAccount ? createAccount(config.privateKey) : undefined;
  return {
    config,
    client: createClient({ chain: testnetBradbury, account }),
  };
}

function normalizeTransactionHash(value) {
  const hash = typeof value === "string" ? value : value?.hash ?? value?.txId ?? value?.transactionHash;
  if (typeof hash !== "string" || !hash) {
    throw new VerificationError("transaction_hash_missing", "GenLayer returned no transaction hash.");
  }
  return hash;
}

function sanitizeDiagnosticText(value) {
  if (value === null || value === undefined) return undefined;
  return String(value)
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/(authorization|cookie|set-cookie|api[_-]?key|private[_ -]?key|database[_ -]?url|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/[?&](key|token|password|secret|api_key|access_token)=[^&\s]+/gi, "?$1=[redacted]")
    .slice(0, 500);
}

function isEmptyOrNotFound(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value !== "object") return ["NOT_FOUND", "NOTFOUND", "NOT FOUND"].includes(String(value).trim().toUpperCase());
  if (Object.keys(value).length === 0) return true;
  return [value.status, value.statusName, value.code, value.errorCode, value.result, value.error?.code, value.error?.status]
    .some((candidate) => typeof candidate === "string" && ["NOT_FOUND", "NOTFOUND", "NOT FOUND"].includes(candidate.trim().toUpperCase()));
}

function isNotFoundError(error) {
  return [
    error?.code,
    error?.error?.code,
    error?.cause?.code,
    error?.response?.data?.error?.code,
    error?.message,
  ].some((candidate) => typeof candidate === "string" && /(?:NOT[_ ]FOUND|NOTFOUND|TRANSACTION.*NOT.*FOUND)/i.test(candidate));
}

function findDiagnosticOutput(value, depth = 0) {
  if (typeof value === "string") {
    const match = value.trim().match(/^decision(ACCEPTED|REJECTED)(?:\r?\n|$)/);
    return match?.[1] ?? null;
  }
  if (!value || typeof value !== "object" || depth > 4) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const marker = findDiagnosticOutput(item, depth + 1);
      if (marker) return marker;
    }
    return null;
  }
  for (const field of DIAGNOSTIC_OUTPUT_FIELDS) {
    if (!(field in value)) continue;
    const marker = findDiagnosticOutput(value[field], depth + 1);
    if (marker) return marker;
  }
  return null;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function diagnosticScalar(value) {
  if (typeof value === "boolean" || typeof value === "number") return value;
  return typeof value === "string" ? sanitizeDiagnosticText(value) : undefined;
}

function diagnosticTransactionFields(transaction) {
  if (isEmptyOrNotFound(transaction)) {
    return {
      transactionReadResult: "not_found",
      transactionStatus: undefined,
      consensusStatus: undefined,
      pendingAction: undefined,
      finalizationState: undefined,
      semanticOutputMarker: "none",
    };
  }
  const consensusStatus = firstDefined(
    transaction?.storedConsensus,
    transaction?.stored_consensus,
    transaction?.consensusStatus,
    transaction?.consensus_status,
    transaction?.consensusState,
    transaction?.consensus_data?.status,
    transaction?.consensus_data?.resultName,
    transaction?.resultName,
  );
  const pendingAction = firstDefined(
    transaction?.pendingAction,
    transaction?.pending_action,
    transaction?.consensus_data?.pendingAction,
    transaction?.consensus_data?.pending_action,
    transaction?.data?.pendingAction,
    transaction?.data?.pending_action,
  );
  const finalizationState = firstDefined(
    transaction?.finalizationStatus,
    transaction?.finalization_status,
    transaction?.finalizationState,
    transaction?.finalized,
    transaction?.isFinalized,
    transaction?.consensus_data?.final,
  );
  return {
    transactionReadResult: "ok",
    transactionStatus: diagnosticScalar(firstDefined(transaction?.statusName, transaction?.status)),
    consensusStatus: diagnosticScalar(consensusStatus),
    pendingAction: diagnosticScalar(pendingAction),
    finalizationState: diagnosticScalar(finalizationState),
    semanticOutputMarker: findDiagnosticOutput(transaction) ?? "none",
  };
}

function nestedErrorValue(error, field) {
  return firstDefined(
    error?.[field],
    error?.error?.[field],
    error?.cause?.[field],
    error?.response?.[field],
    error?.response?.data?.[field],
    error?.response?.data?.error?.[field],
    error?.cause?.response?.data?.error?.[field],
  );
}

export function buildTransactionReadDiagnostic({ transactionHash, transaction, error, context = {}, config, timestamp = new Date().toISOString() }) {
  const transactionFields = error ? {
    transactionReadResult: isNotFoundError(error) ? "not_found" : "error",
    transactionStatus: undefined,
    consensusStatus: undefined,
    pendingAction: undefined,
    finalizationState: undefined,
    semanticOutputMarker: "none",
  } : diagnosticTransactionFields(transaction);
  const diagnostic = {
    operation: READ_OPERATION,
    sessionId: context.sessionId,
    verificationAttemptId: context.verificationAttemptId,
    verificationAttemptNumber: context.verificationAttemptNumber,
    transactionHash,
    network: config?.network ?? context.network,
    contractAddress: config?.contractAddress ?? context.contractAddress,
    timestamp,
    getTransactionSucceeded: !error,
    ...transactionFields,
  };
  if (error) {
    diagnostic.rpcErrorName = sanitizeDiagnosticText(firstDefined(error?.name, error?.error?.name, error?.cause?.name));
    diagnostic.rpcErrorCode = sanitizeDiagnosticText(nestedErrorValue(error, "code"));
    diagnostic.rpcErrorMessage = sanitizeDiagnosticText(firstDefined(
      error?.message,
      error?.error?.message,
      error?.cause?.message,
      error?.response?.data?.error?.message,
    ));
    const httpStatus = nestedErrorValue(error, "status") ?? nestedErrorValue(error, "statusCode");
    if (httpStatus !== undefined) diagnostic.httpStatus = httpStatus;
    const retryable = firstDefined(error?.retryable, error?.cause?.retryable, error?.response?.retryable);
    if (typeof retryable === "boolean") diagnostic.retryable = retryable;
  }
  return diagnostic;
}

export function logTransactionReadDiagnostic({ transactionHash, transaction, error, context = {}, config, logger = console, timestamp }) {
  const diagnostic = buildTransactionReadDiagnostic({ transactionHash, transaction, error, context, config, timestamp });
  (error ? logger.error : logger.info)("GenLayer verification transaction read", diagnostic);
  return diagnostic;
}

export async function submitTranscriptVerification({ transcript, summary, transcriptHash, verificationId = transcriptHash, useAttemptIdentity = false }) {
  const args = buildVerificationSubmissionArgs({ transcript, summary, transcriptHash });
  const { client, config } = getClient();
  if (useAttemptIdentity && !config.supportsVerificationAttempts) {
    throw new VerificationError(
      "genlayer_retry_requires_redeployment",
      "The configured TranscriptVerifier deployment supports one verification per transcript. Redeploy the attempt-aware contract and enable GENLAYER_TRANSCRIPT_VERIFIER_SUPPORTS_ATTEMPTS=1 before verifying a regenerated summary.",
      { retryable: true },
    );
  }
  try {
    const transactionHash = normalizeTransactionHash(await client.writeContract({
      account: createAccount(config.privateKey),
      address: config.contractAddress,
      functionName: useAttemptIdentity ? "submit_verification_attempt" : "submit_verification",
      args: useAttemptIdentity ? [...args, verificationId] : args,
      value: 0n,
    }));
    console.info("GenLayer verification submitted", {
      operation: WRITE_OPERATION,
      network: config.network,
      contractAddress: config.contractAddress,
      transactionHash,
      transcriptHash,
    });
    return { transactionHash, contractAddress: config.contractAddress, network: config.network };
  } catch (error) {
    console.error("GenLayer verification submission failed", {
      code: error?.code ?? "genlayer_submission_failed",
      message: safeVerificationError(error),
      contractAddress: config.contractAddress,
      network: config.network,
      transcriptHash,
    });
    if (error instanceof VerificationError) throw error;
    throw new VerificationError("genlayer_submission_failed", "GenLayer could not accept the verification transaction.", { retryable: true });
  }
}

export async function getTranscriptVerification(transcriptHash) {
  const { client, config } = getClient({ requireAccount: false });
  try {
    return await client.readContract({
      address: config.contractAddress,
      functionName: "get_verification",
      args: [transcriptHash],
      jsonSafeReturn: true,
    });
  } catch (error) {
    console.error("GenLayer verification read failed", {
      code: error?.code ?? "genlayer_read_failed",
      message: safeVerificationError(error),
      contractAddress: config.contractAddress,
      network: config.network,
      transcriptHash,
    });
    throw new VerificationError("genlayer_read_failed", "The GenLayer verification record could not be read.");
  }
}

export async function getTranscriptTransaction(transactionHash, context = {}) {
  const { client, config } = getClient({ requireAccount: false });
  try {
    const transaction = await client.getTransaction({ hash: transactionHash });
    logTransactionReadDiagnostic({ transactionHash, transaction, context, config });
    return transaction;
  } catch (error) {
    logTransactionReadDiagnostic({ transactionHash, error, context, config });
    throw new VerificationError("genlayer_transaction_read_failed", "The GenLayer transaction status could not be read.");
  }
}

export async function waitForTranscriptTransaction(transactionHash) {
  const { client, config } = getClient({ requireAccount: false });
  try {
    return await client.waitForTransactionReceipt({
      hash: transactionHash,
      status: TransactionStatus.FINALIZED,
      retries: 1,
      interval: 1_000,
    });
  } catch (error) {
    console.error("GenLayer transaction wait did not finalize", {
      code: error?.code ?? "genlayer_wait_failed",
      message: safeVerificationError(error),
      contractAddress: config.contractAddress,
      network: config.network,
      transactionHash,
    });
    throw new VerificationError("genlayer_wait_failed", "GenLayer validator consensus is still pending.");
  }
}

export function getGenLayerConfiguration() {
  const config = requireConfig({ requireAccount: false });
  return {
    contractAddress: config.contractAddress,
    network: config.network,
    configured: Boolean(config.privateKey),
    supportsVerificationAttempts: config.supportsVerificationAttempts,
  };
}
