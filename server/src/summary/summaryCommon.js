export const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "topics", "announcements", "questions_answers"],
  properties: {
    summary: { type: "string" },
    topics: { type: "array", items: { type: "string" } },
    announcements: { type: "array", items: { type: "string" } },
    questions_answers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "answer"],
        properties: {
          question: { type: "string" },
          answer: { type: "string" },
        },
      },
    },
  },
};

export const SUMMARY_INSTRUCTIONS = [
  "You summarize only the supplied canonical transcript.",
  "Preserve names, numbers, dates, factual claims, sequence of events, outcomes, uncertainty, and speaker intent exactly as supported by the transcript.",
  "Distinguish plans from completed actions and preserve uncertainty.",
  "Do not invent, normalize, autocorrect, translate, or silently change names, dates, numbers, announcements, speaker identities, facts, or official decisions.",
  "Do not present opinions as official decisions.",
  "Use empty arrays when the transcript does not support topics, announcements, or clearly identifiable questions and answers.",
  "Return only the requested structured object.",
].join(" ");

export class SummaryProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SummaryProviderError";
    this.code = code;
  }
}

export function sanitizeProviderMessage(message) {
  if (typeof message !== "string") return "No provider error message was supplied.";
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(?:sk|rk|pk)-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted connection string]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500) || "No provider error message was supplied.";
}

export function normalizeSummary(value) {
  if (!value || typeof value !== "object") throw new SummaryProviderError("malformed_provider_output", "The summary provider returned an invalid structured result.");
  if (typeof value.summary !== "string" || !value.summary.trim()) throw new SummaryProviderError("malformed_provider_output", "The summary provider returned no usable summary.");
  if (!Array.isArray(value.topics) || !Array.isArray(value.announcements) || !Array.isArray(value.questions_answers)) {
    throw new SummaryProviderError("malformed_provider_output", "The summary provider returned incomplete structured fields.");
  }
  const questionsAnswers = value.questions_answers.map((item) => {
    if (!item || typeof item.question !== "string" || typeof item.answer !== "string") {
      throw new SummaryProviderError("malformed_provider_output", "The summary provider returned an invalid question-and-answer item.");
    }
    return { question: item.question, answer: item.answer };
  });
  return {
    summary: value.summary.trim(),
    topics: value.topics.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()),
    announcements: value.announcements.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()),
    questionsAnswers,
  };
}

export function parseSummaryJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SummaryProviderError("malformed_provider_output", "The summary provider returned malformed structured data.");
  }
  return normalizeSummary(parsed);
}
