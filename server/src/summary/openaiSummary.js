import {
  SUMMARY_INSTRUCTIONS,
  SUMMARY_SCHEMA,
  SummaryProviderError,
  normalizeSummary,
  parseSummaryJson,
  sanitizeProviderMessage,
} from "./summaryCommon.js";

export { SUMMARY_SCHEMA, SummaryProviderError, normalizeSummary } from "./summaryCommon.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

function logProviderDiagnostic(details) {
  console.error("Summary provider diagnostic", {
    provider: "openai",
    ...details,
  });
}

function extractOutputText(body) {
  if (typeof body?.output_text === "string") return body.output_text;
  const text = body?.output
    ?.flatMap((item) => item?.content ?? [])
    ?.find((item) => item?.type === "output_text")
    ?.text;
  return typeof text === "string" ? text : "";
}

export function parseSummaryProviderOutput(body) {
  return parseSummaryJson(extractOutputText(body));
}

export function buildSummaryRequest(canonicalTranscript, model) {
  return {
    model,
    store: false,
    input: [
      { role: "developer", content: [{ type: "input_text", text: SUMMARY_INSTRUCTIONS }] },
      { role: "user", content: [{ type: "input_text", text: `Canonical transcript:\n\n${canonicalTranscript}` }] },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "transcript_summary",
        strict: true,
        schema: SUMMARY_SCHEMA,
      },
    },
  };
}

export async function generateOpenAISummary(canonicalTranscript, { apiKey, model }) {
  let requestBody;
  try {
    requestBody = buildSummaryRequest(canonicalTranscript, model);
    JSON.stringify(requestBody);
  } catch {
    logProviderDiagnostic({
      phase: "before_provider_call",
      requestValidation: "failed",
      structuredOutputValidation: "failed",
      httpStatus: null,
      errorType: null,
      errorCode: "request_validation_failed",
      errorMessage: "The Responses API request could not be serialized.",
      model,
    });
    throw new SummaryProviderError("request_validation_failed", "Summary request validation failed before contacting the provider.");
  }

  let response;
  try {
    response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(requestBody),
    });
  } catch {
    logProviderDiagnostic({
      phase: "after_provider_call",
      requestValidation: "passed",
      structuredOutputValidation: "not_reached",
      httpStatus: null,
      errorType: "network_error",
      errorCode: "provider_unavailable",
      errorMessage: "The summary provider could not be reached.",
      model,
    });
    throw new SummaryProviderError("provider_unavailable", "The summary provider could not be reached.");
  }

  if (!response.ok) {
    let providerBody = null;
    try {
      providerBody = await response.json();
    } catch {
      // Keep the diagnostic safe when the provider returns non-JSON text.
    }
    const providerError = providerBody?.error ?? {};
    const errorType = typeof providerError.type === "string" ? providerError.type : null;
    const errorCode = typeof providerError.code === "string" ? providerError.code : null;
    const errorMessage = sanitizeProviderMessage(providerError.message);
    logProviderDiagnostic({
      phase: "after_provider_call",
      requestValidation: "passed",
      structuredOutputValidation: "not_reached",
      httpStatus: response.status,
      errorType,
      errorCode,
      errorMessage,
      model,
    });
    if (response.status === 401 || response.status === 403) {
      throw new SummaryProviderError("provider_auth_failed", "Summary provider authentication failed. Check SUMMARY_API_KEY.");
    }
    if (response.status === 429 && ["insufficient_quota", "credit_balance_exhausted"].includes(errorCode)) {
      throw new SummaryProviderError("provider_quota_exhausted", "Summary provider credits or quota are exhausted. Check the OpenAI billing and usage settings.");
    }
    throw new SummaryProviderError("provider_request_failed", "The summary provider rejected the request.");
  }

  let body;
  try {
    body = await response.json();
  } catch {
    logProviderDiagnostic({
      phase: "after_provider_call",
      requestValidation: "passed",
      structuredOutputValidation: "failed",
      httpStatus: response.status,
      errorType: null,
      errorCode: "malformed_provider_output",
      errorMessage: "The summary provider returned an unreadable response.",
      model,
    });
    throw new SummaryProviderError("malformed_provider_output", "The summary provider returned an unreadable response.");
  }

  try {
    const summary = parseSummaryProviderOutput(body);
    logProviderDiagnostic({
      phase: "after_provider_call",
      requestValidation: "passed",
      structuredOutputValidation: "passed",
      httpStatus: response.status,
      errorType: null,
      errorCode: null,
      errorMessage: null,
      model,
    });
    return summary;
  } catch (error) {
    logProviderDiagnostic({
      phase: "after_provider_call",
      requestValidation: "passed",
      structuredOutputValidation: "failed",
      httpStatus: response.status,
      errorType: null,
      errorCode: error instanceof SummaryProviderError ? error.code : "malformed_provider_output",
      errorMessage: sanitizeProviderMessage(error?.message),
      model,
    });
    throw error;
  }
}
