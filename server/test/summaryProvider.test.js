import test from "node:test";
import assert from "node:assert/strict";
import { buildSummaryRequest, parseSummaryProviderOutput, SummaryProviderError } from "../src/summary/openaiSummary.js";
import { generateSummary } from "../src/summary/summaryProvider.js";

test("parses a valid structured summary provider response", () => {
  const result = parseSummaryProviderOutput({
    output_text: JSON.stringify({
      summary: "The conversation covered a planned release.",
      topics: ["Release planning"],
      announcements: [],
      questions_answers: [{ question: "What is planned?", answer: "A future release." }],
    }),
  });
  assert.deepEqual(result, {
    summary: "The conversation covered a planned release.",
    topics: ["Release planning"],
    announcements: [],
    questionsAnswers: [{ question: "What is planned?", answer: "A future release." }],
  });
});

test("rejects malformed structured summary output", () => {
  assert.throws(
    () => parseSummaryProviderOutput({ output_text: "not-json" }),
    (error) => error instanceof SummaryProviderError && error.code === "malformed_provider_output",
  );
});

test("missing summary configuration is explicit and does not fabricate output", async () => {
  const previousProvider = process.env.SUMMARY_PROVIDER;
  const previousKey = process.env.SUMMARY_API_KEY;
  delete process.env.SUMMARY_PROVIDER;
  delete process.env.SUMMARY_API_KEY;
  try {
    await assert.rejects(
      generateSummary("[00:00:01] Speaker: Test transcript."),
      (error) => error instanceof SummaryProviderError && error.code === "provider_not_configured",
    );
  } finally {
    if (previousProvider === undefined) delete process.env.SUMMARY_PROVIDER;
    else process.env.SUMMARY_PROVIDER = previousProvider;
    if (previousKey === undefined) delete process.env.SUMMARY_API_KEY;
    else process.env.SUMMARY_API_KEY = previousKey;
  }
});

test("summary request contains the exact canonical transcript and structured output contract", () => {
  const request = buildSummaryRequest("[00:00:01] Speaker: Exact text.", "test-model");
  assert.equal(request.model, "test-model");
  assert.equal(request.store, false);
  assert.match(request.input[1].content[0].text, /Exact text\./);
  assert.equal(request.text.format.type, "json_schema");
});

test("logs safe OpenAI rejection diagnostics without logging the API key", async () => {
  const previousProvider = process.env.SUMMARY_PROVIDER;
  const previousKey = process.env.SUMMARY_API_KEY;
  const previousModel = process.env.SUMMARY_MODEL;
  const previousFetch = globalThis.fetch;
  const previousConsoleError = console.error;
  const diagnostics = [];
  process.env.SUMMARY_PROVIDER = "openai";
  process.env.SUMMARY_API_KEY = "sk-test-secret-value";
  process.env.SUMMARY_MODEL = "gpt-5-mini";
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: {
      type: "invalid_request_error",
      code: "model_not_found",
      message: "The model sk-test-secret-value is not available for this project.",
    },
  }), { status: 400, headers: { "Content-Type": "application/json" } });
  console.error = (_label, details) => diagnostics.push(details);
  try {
    await assert.rejects(generateSummary("[00:00:01] Speaker: Test transcript."), (error) => error.code === "provider_request_failed");
    assert.deepEqual(diagnostics[0], {
      provider: "openai",
      phase: "after_provider_call",
      requestValidation: "passed",
      structuredOutputValidation: "not_reached",
      httpStatus: 400,
      errorType: "invalid_request_error",
      errorCode: "model_not_found",
      errorMessage: "The model [redacted] is not available for this project.",
      model: "gpt-5-mini",
    });
    assert.doesNotMatch(JSON.stringify(diagnostics), /sk-test-secret-value/);
  } finally {
    if (previousProvider === undefined) delete process.env.SUMMARY_PROVIDER;
    else process.env.SUMMARY_PROVIDER = previousProvider;
    if (previousKey === undefined) delete process.env.SUMMARY_API_KEY;
    else process.env.SUMMARY_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.SUMMARY_MODEL;
    else process.env.SUMMARY_MODEL = previousModel;
    globalThis.fetch = previousFetch;
    console.error = previousConsoleError;
  }
});

test("maps exhausted OpenAI quota to an actionable safe error", async () => {
  const previousProvider = process.env.SUMMARY_PROVIDER;
  const previousKey = process.env.SUMMARY_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.SUMMARY_PROVIDER = "openai";
  process.env.SUMMARY_API_KEY = "sk-test-secret-value";
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { type: "insufficient_quota", code: "credit_balance_exhausted", message: "No credits remain." },
  }), { status: 429, headers: { "Content-Type": "application/json" } });
  try {
    await assert.rejects(
      generateSummary("[00:00:01] Speaker: Test transcript."),
      (error) => error instanceof SummaryProviderError
        && error.code === "provider_quota_exhausted"
        && error.message.includes("credits or quota are exhausted"),
    );
  } finally {
    if (previousProvider === undefined) delete process.env.SUMMARY_PROVIDER;
    else process.env.SUMMARY_PROVIDER = previousProvider;
    if (previousKey === undefined) delete process.env.SUMMARY_API_KEY;
    else process.env.SUMMARY_API_KEY = previousKey;
    globalThis.fetch = previousFetch;
  }
});
