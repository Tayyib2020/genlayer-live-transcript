import crypto from "node:crypto";

export const CANONICAL_SPEAKER_LABEL = "Speaker";
export const CANONICAL_LINE_SEPARATOR = "\n";

function formatTimestamp(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--:--";
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const remainder = totalSeconds % 60;
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, "0")).join(":");
}

function normalizePersistedText(text) {
  // Canonicalization only trims outer whitespace and replaces embedded line
  // breaks with one space so each persisted segment occupies one line.
  return String(text ?? "").replace(/\r\n|\r|\n/g, " ").trim();
}

export function canonicalizeTranscript(segments) {
  const finalized = (segments ?? [])
    .filter((segment) => segment?.isFinal === true && normalizePersistedText(segment.text).length > 0)
    .map((segment, index) => ({ segment, index }))
    .sort((left, right) => {
      const sequenceDifference = Number(left.segment.sequence ?? 0) - Number(right.segment.sequence ?? 0);
      if (sequenceDifference !== 0) return sequenceDifference;
      return Number(left.segment.id ?? left.index) - Number(right.segment.id ?? right.index);
    });

  return finalized
    .map(({ segment }) => `[${formatTimestamp(Number(segment.startSeconds))}] ${CANONICAL_SPEAKER_LABEL}: ${normalizePersistedText(segment.text)}`)
    .join(CANONICAL_LINE_SEPARATOR);
}

export function hashCanonicalTranscript(canonicalTranscript) {
  const digest = crypto.createHash("sha256").update(canonicalTranscript, "utf8").digest("hex");
  return `0x${digest}`;
}

export function buildTranscriptIntegrity(segments) {
  const canonicalTranscript = canonicalizeTranscript(segments);
  return {
    canonicalTranscript,
    transcriptHash: hashCanonicalTranscript(canonicalTranscript),
  };
}
