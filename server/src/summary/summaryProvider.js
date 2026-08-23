import { generateGeminiSummary } from "./geminiSummary.js";
import { generateOpenAISummary } from "./openaiSummary.js";
import { SummaryProviderError } from "./summaryCommon.js";

const DEFAULT_MODELS = {
  openai: "gpt-5-mini",
  gemini: "gemini-3.6-flash",
};

function getConfig() {
  const provider = (process.env.SUMMARY_PROVIDER ?? "").trim().toLowerCase();
  return {
    provider,
    apiKey: (process.env.SUMMARY_API_KEY ?? "").trim(),
    model: (process.env.SUMMARY_MODEL ?? "").trim() || DEFAULT_MODELS[provider] || "",
  };
}

export async function generateSummary(canonicalTranscript) {
  const { provider, apiKey, model } = getConfig();
  if (!provider) {
    throw new SummaryProviderError("provider_not_configured", "Summary generation is unavailable until SUMMARY_PROVIDER and SUMMARY_API_KEY are configured on the server.");
  }
  if (!Object.hasOwn(DEFAULT_MODELS, provider)) {
    throw new SummaryProviderError("provider_unsupported", "Summary generation is unavailable because SUMMARY_PROVIDER is unsupported. Use openai or gemini.");
  }
  if (!apiKey) {
    throw new SummaryProviderError("provider_not_configured", "Summary generation is unavailable until SUMMARY_PROVIDER and SUMMARY_API_KEY are configured on the server.");
  }
  if (provider === "gemini") return generateGeminiSummary(canonicalTranscript, { apiKey, model });
  return generateOpenAISummary(canonicalTranscript, { apiKey, model });
}
