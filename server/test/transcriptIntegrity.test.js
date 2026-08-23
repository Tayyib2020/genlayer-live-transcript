import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { buildTranscriptIntegrity, canonicalizeTranscript, hashCanonicalTranscript } from "../src/integrity/transcriptIntegrity.js";

const fixture = "[00:00:04] Speaker: Welcome everyone.\n[00:00:10] Speaker: Today we're discussing Clarke.";
const fixtureHash = "0xbdf6db1623615b47ac9e77cfe7089f3da33561ce28b468b7ef0c5c9ca474b6e5";

test("canonicalization includes only finalized segments in deterministic sequence order", () => {
  const segments = [
    { id: 2, sequence: 2, text: "Today we're discussing Clarke.", startSeconds: 10, isFinal: true },
    { id: 3, sequence: 3, text: "interim text", startSeconds: 11, isFinal: false },
    { id: 1, sequence: 1, text: " Welcome everyone. ", startSeconds: 4, isFinal: true },
  ];
  assert.equal(canonicalizeTranscript(segments), fixture);
  assert.equal(canonicalizeTranscript([...segments].reverse()), fixture);
});

test("hash matches the TranscriptVerifier SHA-256 algorithm and required format", () => {
  const applicationHash = hashCanonicalTranscript(fixture);
  const contractEquivalentHash = `0x${crypto.createHash("sha256").update(fixture, "utf8").digest("hex")}`;
  assert.equal(applicationHash, fixtureHash);
  assert.equal(applicationHash, contractEquivalentHash);
  assert.match(applicationHash, /^0x[0-9a-f]{64}$/);
  assert.notEqual(applicationHash, hashCanonicalTranscript(fixture.replace("Clarke", "Clark")));
});

test("integrity output contains the exact canonical transcript and its hash", () => {
  const result = buildTranscriptIntegrity([
    { sequence: 1, text: "Welcome everyone.", startSeconds: 4, isFinal: true },
    { sequence: 2, text: "Today we're discussing Clarke.", startSeconds: 10, isFinal: true },
  ]);
  assert.deepEqual(result, { canonicalTranscript: fixture, transcriptHash: fixtureHash });
});
