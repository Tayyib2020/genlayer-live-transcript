import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGeminiRequest,
  generateGeminiSummary,
  parseGeminiProviderOutput,
} from "../src/summary/geminiSummary.js";
import { SummaryProviderError } from "../src/summary/summaryCommon.js";
import { generateSummary } from "../src/summary/summaryProvider.js";

const canonicalTranscript = "[00:00:01] Speaker: The release is planned for next month.";
const validGeminiBody = {
  candidates: [{
    content: {
      parts: [{
        text: JSON.stringify({
          summary: "The release is planned for next month.",
          topics: ["Release planning"],
          announcements: [],
          questions_answers: [],
        }),
      }],
    },
  }],
};

function restoreEnvironment(previous) {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test("builds the current Gemini structured-output REST request shape", () => {
  const request = buildGeminiRequest(canonicalTranscript);
  assert.equal(request.contents[0].parts[0].text.includes(canonicalTranscript), true);
  assert.equal(request.generationConfig.responseMimeType, "application/json");
  assert.equal(request.generationConfig.responseSchema.required.includes("summary"), true);
  assert.equal(request.generationConfig.responseSchema.additionalProperties, undefined);
  assert.equal(request.generationConfig.responseSchema.properties.questions_answers.items.additionalProperties, undefined);
  assert.equal(request.generationConfig.responseFormat, undefined);
  assert.equal(request.generationConfig.responseFormat?.text?.mimeType, undefined);
  assert.equal(request.model, undefined);
});

test("maps valid Gemini structured output to the Phase 6 summary structure", () => {
  assert.deepEqual(parseGeminiProviderOutput(validGeminiBody), {
    summary: "The release is planned for next month.",
    topics: ["Release planning"],
    announcements: [],
    questionsAnswers: [],
  });
});

test("rejects malformed Gemini output safely", () => {
  assert.throws(
    () => parseGeminiProviderOutput({ candidates: [{ content: { parts: [{ text: "not-json" }] } }] }),
    (error) => error instanceof SummaryProviderError && error.code === "malformed_provider_output",
  );
});

test("routes SUMMARY_PROVIDER=gemini through the Gemini endpoint", async () => {
  const previous = {
    SUMMARY_PROVIDER: process.env.SUMMARY_PROVIDER,
    SUMMARY_API_KEY: process.env.SUMMARY_API_KEY,
    SUMMARY_MODEL: process.env.SUMMARY_MODEL,
  };
  const previousFetch = globalThis.fetch;
  let captured;
  process.env.SUMMARY_PROVIDER = "gemini";
  process.env.SUMMARY_API_KEY = "gemini-test-key";
  delete process.env.SUMMARY_MODEL;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify(validGeminiBody), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const result = await generateSummary(canonicalTranscript);
    assert.equal(result.summary, "The release is planned for next month.");
    assert.match(captured.url, /\/v1beta\/models\/gemini-3\.6-flash:generateContent$/);
    assert.equal(captured.options.headers["x-goog-api-key"], "gemini-test-key");
    assert.match(captured.options.body, /The release is planned for next month/);
  } finally {
    restoreEnvironment(previous);
    globalThis.fetch = previousFetch;
  }
});

test("missing Gemini key returns provider-not-configured", async () => {
  const previous = {
    SUMMARY_PROVIDER: process.env.SUMMARY_PROVIDER,
    SUMMARY_API_KEY: process.env.SUMMARY_API_KEY,
  };
  process.env.SUMMARY_PROVIDER = "gemini";
  delete process.env.SUMMARY_API_KEY;
  try {
    await assert.rejects(
      generateSummary(canonicalTranscript),
      (error) => error instanceof SummaryProviderError && error.code === "provider_not_configured",
    );
  } finally {
    restoreEnvironment(previous);
  }
});

test("unsupported summary providers are rejected explicitly", async () => {
  const previous = {
    SUMMARY_PROVIDER: process.env.SUMMARY_PROVIDER,
    SUMMARY_API_KEY: process.env.SUMMARY_API_KEY,
  };
  process.env.SUMMARY_PROVIDER = "local-mock";
  process.env.SUMMARY_API_KEY = "not-used";
  try {
    await assert.rejects(
      generateSummary(canonicalTranscript),
      (error) => error instanceof SummaryProviderError && error.code === "provider_unsupported",
    );
  } finally {
    restoreEnvironment(previous);
  }
});

test("sanitizes Gemini provider diagnostics", async () => {
  const previous = {
    SUMMARY_PROVIDER: process.env.SUMMARY_PROVIDER,
    SUMMARY_API_KEY: process.env.SUMMARY_API_KEY,
    SUMMARY_MODEL: process.env.SUMMARY_MODEL,
  };
  const previousFetch = globalThis.fetch;
  const previousConsoleError = console.error;
  const diagnostics = [];
  process.env.SUMMARY_PROVIDER = "gemini";
  process.env.SUMMARY_API_KEY = "AIza-test-secret";
  process.env.SUMMARY_MODEL = "gemini-2.5-flash";
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: {
      code: 400,
      status: "INVALID_ARGUMENT",
      message: "Request included key AIzaSyA123456789012345678901234567890.",
    },
  }), { status: 400, headers: { "Content-Type": "application/json" } });
  console.error = (_label, details) => diagnostics.push(details);
  try {
    await assert.rejects(generateSummary(canonicalTranscript), (error) => error.code === "provider_request_failed");
    assert.deepEqual(diagnostics[0], {
      provider: "gemini",
      phase: "after_provider_call",
      requestValidation: "passed",
      structuredOutputValidation: "not_reached",
      httpStatus: 400,
      errorType: "INVALID_ARGUMENT",
      errorCode: "400",
      errorMessage: "Request included key [redacted].",
      model: "gemini-2.5-flash",
    });
    assert.doesNotMatch(JSON.stringify(diagnostics), /AIza-test-secret|AIzaSyA123456789012345678901234567890/);
  } finally {
    restoreEnvironment(previous);
    globalThis.fetch = previousFetch;
    console.error = previousConsoleError;
  }
});
