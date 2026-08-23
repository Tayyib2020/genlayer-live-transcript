import {
  SUMMARY_INSTRUCTIONS,
  SummaryProviderError,
  parseSummaryJson,
  sanitizeProviderMessage,
} from "./summaryCommon.js";

const GEMINI_GENERATE_CONTENT_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_SUMMARY_SCHEMA = {
  type: "object",
  required: ["summary", "topics", "announcements", "questions_answers"],
  properties: {
    summary: { type: "string" },
    topics: { type: "array", items: { type: "string" } },
    announcements: { type: "array", items: { type: "string" } },
    questions_answers: {
      type: "array",
      items: {
        type: "object",
        required: ["question", "answer"],
        properties: {
          question: { type: "string" },
          answer: { type: "string" },
        },
      },
    },
  },
};

function logProviderDiagnostic(details) {
  console.error("Summary provider diagnostic", {
    provider: "gemini",
    ...details,
  });
}

export function buildGeminiRequest(canonicalTranscript) {
  return {
    contents: [{
      parts: [{ text: `${SUMMARY_INSTRUCTIONS}\n\nCanonical transcript:\n\n${canonicalTranscript}` }],
    }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: GEMINI_SUMMARY_SCHEMA,
    },
  };
}

function extractOutputText(body) {
  const parts = body?.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((part) => typeof part?.text === "string")
    .map((part) => part.text)
    .join("");
}

export function parseGeminiProviderOutput(body) {
  return parseSummaryJson(extractOutputText(body));
}

export async function generateGeminiSummary(canonicalTranscript, { apiKey, model }) {
  let requestBody;
  try {
    requestBody = buildGeminiRequest(canonicalTranscript, model);
    JSON.stringify(requestBody);
  } catch {
    logProviderDiagnostic({
      phase: "before_provider_call",
      requestValidation: "failed",
      structuredOutputValidation: "failed",
      httpStatus: null,
      errorType: null,
      errorCode: "request_validation_failed",
      errorMessage: "The Gemini request could not be serialized.",
      model,
    });
    throw new SummaryProviderError("request_validation_failed", "Summary request validation failed before contacting the provider.");
  }

  let response;
  try {
    response = await fetch(`${GEMINI_GENERATE_CONTENT_URL}/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(requestBody),
    });
  } catch {
    logProviderDiagnostic({
      phase: "during_provider_request",
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
    const errorType = typeof providerError.status === "string" ? providerError.status : typeof providerError.type === "string" ? providerError.type : null;
    const errorCode = providerError.code === undefined || providerError.code === null ? null : String(providerError.code);
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
    if (response.status === 429) {
      throw new SummaryProviderError("provider_quota_exhausted", "Summary provider quota or rate limit was reached. Check the Gemini API usage and billing settings.");
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
    const summary = parseGeminiProviderOutput(body);
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
