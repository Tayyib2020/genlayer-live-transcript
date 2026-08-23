import test from "node:test";
import assert from "node:assert/strict";
import { parseDeepgramMessage } from "../src/transcription/deepgram.js";

test("normalizes a Deepgram interim result without marking it final", () => {
  const result = parseDeepgramMessage(Buffer.from(JSON.stringify({
    type: "Results",
    start: 1.2,
    duration: 0.8,
    is_final: false,
    channel: { alternatives: [{ transcript: "hello wor" }] },
  })), "2026-08-22T12:00:00.000Z");

  assert.equal(result.kind, "transcript");
  assert.equal(result.event.text, "hello wor");
  assert.equal(result.event.isFinal, false);
  assert.equal(result.event.timestamp, "2026-08-22T12:00:00.000Z");
  assert.match(result.event.dedupeKey, /^deepgram:[a-f0-9]{64}$/);
});

test("normalizes a Deepgram final result with a stable dedupe key", () => {
  const payload = JSON.stringify({
    type: "Results",
    start: 1.2,
    duration: 0.8,
    is_final: true,
    channel: { alternatives: [{ transcript: "Hello world." }] },
  });
  const first = parseDeepgramMessage(Buffer.from(payload), "2026-08-22T12:00:01.000Z");
  const duplicate = parseDeepgramMessage(Buffer.from(payload), "2026-08-22T12:00:02.000Z");

  assert.equal(first.event.isFinal, true);
  assert.equal(first.event.dedupeKey, duplicate.event.dedupeKey);
  assert.equal(first.event.text, "Hello world.");
});

test("ignores empty provider results and handles provider errors safely", () => {
  const empty = parseDeepgramMessage(Buffer.from(JSON.stringify({
    type: "Results",
    channel: { alternatives: [{ transcript: "   " }] },
  })));
  const error = parseDeepgramMessage(Buffer.from(JSON.stringify({
    type: "Error",
    err_code: "AUTH_FAILED",
    message: "sensitive provider response should not be forwarded",
  })));

  assert.equal(empty.kind, "ignored");
  assert.equal(error.kind, "error");
  assert.equal(error.message, "Transcription provider authentication failed. Check TRANSCRIPTION_API_KEY.");
  assert.doesNotMatch(error.message, /sensitive/);
});
