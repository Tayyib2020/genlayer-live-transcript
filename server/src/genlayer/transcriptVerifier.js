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

export async function getTranscriptTransaction(transactionHash) {
  const { client, config } = getClient({ requireAccount: false });
  try {
    return await client.getTransaction({ hash: transactionHash });
  } catch (error) {
    console.error("GenLayer transaction read failed", {
      code: error?.code ?? "genlayer_transaction_read_failed",
      message: safeVerificationError(error),
      contractAddress: config.contractAddress,
      network: config.network,
      transactionHash,
    });
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
