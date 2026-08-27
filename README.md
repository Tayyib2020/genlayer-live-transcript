# Signal Ledger — GenLayer Live Transcript

Signal Ledger captures browser-tab audio, transcribes it through a server-side provider, persists finalized transcript segments, generates an off-chain summary, and submits that exact persisted evidence to the deployed TranscriptVerifier Intelligent Contract on GenLayer Bradbury.

The core evidence path is:

```text
Browser tab audio → Deepgram live transcription → persisted finalized segments → completed session → canonical transcript → SHA-256 hash → Gemini/OpenAI summary → TranscriptVerifier validator consensus → contract record → ACCEPTED / REJECTED evidence
```

The application does not claim that the transcript is factually true. TranscriptVerifier evaluates whether the generated summary faithfully represents the supplied canonical transcript.

## Live Demo

[https://signal-ledger-livee.netlify.app](https://signal-ledger-livee.netlify.app)

## What is implemented

| Area | Status | Evidence |
| --- | --- | --- |
| Browser tab-audio capture and WebSocket streaming | Implemented | `client/src/audioStream.js`, `server/src/websocket/audioServer.js` |
| Real-time Deepgram transcription | Implemented when configured | `server/src/transcription/deepgram.js` |
| Final transcript persistence and immutable completion | Implemented | `server/src/db/transcriptStore.js`, `server/src/db/sessionLifecycle.js` |
| Deterministic canonical transcript | Implemented | `server/src/integrity/transcriptIntegrity.js` |
| SHA-256 transcript hash | Implemented | `server/src/integrity/transcriptIntegrity.js` |
| Off-chain structured summary | Implemented when configured | `server/src/summary/summaryProvider.js`, `server/src/summary/openaiSummary.js`, `server/src/summary/geminiSummary.js` |
| Summary retry/status persistence | Implemented | `server/src/db/sessionProcessing.js` |
| Completed-session integrity and summary UI | Implemented | `client/src/pages/SessionPage.jsx` |
| GenLayer verification | Implemented when configured | `server/src/genlayer/transcriptVerifier.js`, `server/src/genlayer/verificationLifecycle.js`, `client/src/pages/SessionPage.jsx` |
| Private accounts and user-owned archives | Implemented | `server/src/auth/auth.js`, `server/src/routes/auth.js`, `server/src/routes/sessions.js`, `client/src/auth.jsx` |

The application never fabricates transcript or summary content. Missing provider configuration creates an explicit failure state.

## Responsibility boundaries

**Speech-to-text provider** determines what the captured audio was recognized as text.

**Application/backend** stores sessions, persists final transcript segments, canonicalizes and hashes the completed transcript, generates the off-chain summary, and presents the evidence.

**TranscriptVerifier on GenLayer** uses validator consensus to judge semantic fidelity between the exact canonical transcript and the generated summary. It does not prove that the transcript itself is true, complete, or correctly attributed.

```text
Browser tab audio
        ↓
Deepgram transcript events
        ↓ final events only
Persisted transcript_segments
        ↓ Complete Session
Canonical transcript
        ↓ UTF-8 SHA-256
0x-prefixed transcript hash
        ↓ Process Completed Transcript
Off-chain structured summary
        ↓ exact persisted values
TranscriptVerifier.submit_verification(transcript, proposed_summary, transcript_hash)
        ↓ validator consensus
TranscriptVerifier.get_verification(transcript_hash)
        ↓
ACCEPTED / REJECTED + reason + transaction evidence
```

## Canonical transcript format

The canonical transcript is generated only on the server from persisted `is_final = TRUE` segments. It is the exact transcript string submitted to `TranscriptVerifier`.

Example:

```text
[00:00:04] Speaker: Welcome everyone.
[00:00:10] Speaker: Today we're discussing Clarke.
```

Canonicalization rules:

1. Include finalized segments only.
2. Sort by persisted `sequence_number ASC`, then persisted database ID as a deterministic tie-breaker.
3. Use the neutral label `Speaker`; no identities are invented.
4. Use provider `source_start_seconds` for timestamps when available, formatted as fixed zero-padded `HH:MM:SS`.
5. Use `[--:--:--]` when no meaningful provider offset is available; no volatile database timestamp is substituted.
6. Preserve persisted text except for trimming outer whitespace and replacing embedded CRLF/CR/LF line breaks with one space so each segment occupies one line.
7. Use literal LF (`\n`) between lines.
8. Do not add a trailing line separator.
9. Do not include database IDs, locale-dependent formatting, random values, or unrelated timestamps.

The canonical string is passed directly to the UTF-8 hash function. The application does not hash one representation and submit another.

## SHA-256 hashing

The server computes:

```text
transcript_hash = "0x" + SHA256(canonical_transcript UTF-8 bytes).hexdigest()
```

The result is lowercase hexadecimal with exactly 64 characters after `0x`:

```text
0xbdf6db1623615b47ac9e77cfe7089f3da33561ce28b468b7ef0c5c9ca474b6e5
```

That fixture hashes this exact canonical string:

```text
[00:00:04] Speaker: Welcome everyone.
[00:00:10] Speaker: Today we're discussing Clarke.
```

The implementation matches the deployed contract’s stated algorithm: SHA-256 over `transcript.encode("utf-8")`, represented as a `0x`-prefixed lowercase hex string. The frontend cannot supply or override the hash.

## Summary generation

Summary generation is off-chain and server-side. The stable application entry point is `generateSummary(canonicalTranscript)` in `server/src/summary/summaryProvider.js`. Exactly one provider is active at a time, selected by server environment variables; the frontend does not choose a provider.

```text
Provider: OpenAI Responses API or Gemini Generate Content API
Model: SUMMARY_MODEL, default gpt-5-mini for OpenAI or gemini-3.6-flash for Gemini
Services: server/src/summary/openaiSummary.js and server/src/summary/geminiSummary.js
```

Each provider receives only the canonical transcript and must return the same validated structure:

```json
{
  "summary": "...",
  "topics": [],
  "announcements": [],
  "questions_answers": []
}
```

The instructions require the model to preserve meaning and uncertainty, distinguish confirmed statements from speculation, distinguish plans from completed actions, and avoid invented dates, names, announcements, speaker identities, or official decisions. Empty arrays are used when the transcript does not support a category.

Summary API keys remain server-only. The application does not log authorization headers, full provider responses, or secrets.

Provider failures are diagnosed server-side with only safe metadata: HTTP status, provider error type and code when available, a sanitized message, requested model, and whether request construction or structured-output validation failed before or after the provider call. A quota or credit exhaustion response is reported as an actionable retry error without exposing credentials or transcript content.

### OpenAI

```env
SUMMARY_PROVIDER=openai
SUMMARY_API_KEY=
SUMMARY_MODEL=gpt-5-mini
```

This uses the OpenAI Responses API with JSON Schema structured output.

### Gemini

```env
SUMMARY_PROVIDER=gemini
SUMMARY_API_KEY=
SUMMARY_MODEL=gemini-3.6-flash
```

This uses Gemini REST `generateContent` with JSON structured output. Fresh setups default to `gemini-3.6-flash`; existing `.env` values are not overwritten. Actual model access depends on account, region, and quota.

## Environment

The server loads the repository-root `.env`:

```text
TRANSCRIPTION_PROVIDER=deepgram
TRANSCRIPTION_API_KEY=your-deepgram-key

# Choose exactly one summary provider on the backend.
SUMMARY_PROVIDER=openai
SUMMARY_API_KEY=your-summary-provider-key
SUMMARY_MODEL=gpt-5-mini

# Or use Gemini with the same variable names:
# SUMMARY_PROVIDER=gemini
# SUMMARY_API_KEY=your-gemini-key
# SUMMARY_MODEL=gemini-3.6-flash

# GenLayer verification. Keep the private key server-side only.
GENLAYER_PRIVATE_KEY=
GENLAYER_TRANSCRIPT_VERIFIER_ADDRESS=0x4DEfE1bbE75C59FcD2264EaCb75096f3CD659f5B
GENLAYER_NETWORK=testnet-bradbury
GENLAYER_TRANSCRIPT_VERIFIER_SUPPORTS_ATTEMPTS=1

# Account sessions. The server stores only a digest of each random cookie token.
AUTH_SESSION_TTL_DAYS=7
```

If summary configuration is missing, processing still persists the canonical transcript and hash, then records `summary_generation_status = failed` with a safe configuration message. No summary placeholder is shown.

## Accounts and private archives

Signal Ledger uses username/password accounts for application privacy; users do not connect a blockchain wallet. Usernames are normalized to lowercase, must be 3–30 characters, and may contain letters, numbers, underscores, or hyphens. Passwords must be 8–128 characters and are stored only as bcrypt hashes.

Authentication uses a database-backed, cryptographically random seven-day session token. The raw token is sent only in an HTTP-only cookie; PostgreSQL stores its SHA-256 digest. Production cookies use `Secure; SameSite=None` for the Netlify frontend and Render backend, while localhost uses a non-secure `SameSite=Lax` cookie. The frontend sends authenticated API requests with `credentials: include`.

The backend scopes every session query and mutation to the authenticated user's `sessions.user_id`. Archive, transcript, summary, deletion, and GenLayer verification evidence are private. Legacy sessions created before this migration remain intact with `user_id = NULL` and are excluded from authenticated archives and direct session APIs; they are not automatically assigned to an account.

The browser audio WebSocket authenticates the same cookie before accepting a connection and checks that the authenticated user owns the requested live session. The server-side GenLayer wallet remains the single transaction signer; account ownership does not add wallet authentication.

## Summary states

```text
not_started → generating → ready
                         ↘ failed
failed → generating       (explicit retry)

ready + rejected verification → generating new summary attempt (explicit retry)
```

Repeated process requests do not regenerate a `ready` summary. Concurrent requests are serialized through the completed session row and a persisted `generating` state. A failed summary can be retried explicitly.

Processing eligibility is computed by the backend. Older completed sessions are eligible on demand when they contain finalized transcript segments even if no `session_derivatives` row exists; completed sessions without finalized segments remain ineligible. The original transcript is never rewritten, and an existing ready derivative is returned unchanged.

## Database model

Phase 6 adds an idempotent `session_derivatives` table with:

- `session_id` foreign key with `ON DELETE CASCADE`
- `canonical_transcript`
- `transcript_hash`
- `summary`
- JSONB `topics`, `announcements`, and `questions_answers`
- `summary_generation_status`
- `summary_generated_at`
- `summary_error`
- created/updated timestamps

Existing sessions, transcript segments, completed records, and Phase 1–5 tables are not destroyed or rewritten. Completed transcripts remain immutable; transcript writes are rejected after completion.

Phase 7 adds `session_verifications`, one local evidence row per session/transcript hash. The recovery architecture adds `summary_attempts` and `verification_attempts`: each generated summary has an immutable attempt number and SHA-256 summary hash, and each verification references the exact summary attempt that was submitted. Existing derivative and verification rows are copied into attempt 1 during migration without changing transcript hashes or deleting historical evidence. The foreign keys cascade on local session deletion. Deleting a session cannot delete the already-existing on-chain transaction or contract record.

## API

```text
POST   /api/auth/register
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/me
POST   /api/sessions
GET    /api/sessions
GET    /api/sessions/:id        → { session, transcript, derivative, verification, verificationHistory, processing }
POST   /api/sessions/:id/start
POST   /api/sessions/:id/stop
POST   /api/sessions/:id/complete
POST   /api/sessions/:id/process
POST   /api/sessions/:id/regenerate-summary
POST   /api/sessions/:id/verify
GET    /api/sessions/:id/verification
DELETE /api/sessions/:id
WS     /ws/audio?sessionId=...
```

`/api/auth/register` and `/api/auth/login` return only `{ user: { id, username, createdAt } }` and establish the HTTP-only session cookie. Invalid login attempts use the same generic message whether the username exists or not. State-changing requests must come from the configured `CLIENT_ORIGIN`.

`POST /api/sessions/:id/process` accepts no transcript or hash from the client. It validates that the session is completed, loads persisted final segments, derives the canonical transcript and hash, and invokes the configured summary service.

`POST /api/sessions/:id/verify` also accepts no transcript, summary, hash, verdict, or transaction data from the client. The server loads the completed session's persisted derivative, verifies that its canonical transcript/hash still match finalized segments, and submits the exact persisted values to `submit_verification`. `GET /api/sessions/:id/verification` refreshes transaction state and, after finalization, reads `get_verification(transcript_hash)` before storing the semantic verdict.

`POST /api/sessions/:id/regenerate-summary` is available only after a persisted verification for the latest summary attempt is `REJECTED`. It reuses the immutable canonical transcript, creates a new summary attempt, and never submits the regenerated summary to GenLayer automatically.

## How to run

Requirements: Node.js current LTS, npm, hosted PostgreSQL such as Neon, and a desktop Chromium-based browser for capture.

```powershell
npm install
npm install --prefix client
npm install --prefix server
npm run migrate
npm run dev
```

The client runs at `http://localhost:5173`; the API runs at `http://localhost:3001`.

Open `http://localhost:5173`, create an account at **Create an account**, and sign in. Set `CLIENT_ORIGIN` to the exact frontend origin. For production, keep `CLIENT_ORIGIN=https://signal-ledger-livee.netlify.app`, set `NODE_ENV=production`, and provide the same root `.env` variables on Render. Do not place server credentials or `AUTH_SESSION_TTL_DAYS` secrets on Netlify; Netlify only needs its existing API/WS frontend environment variables.

### Production deployment settings

On Render, configure the server environment with `NODE_ENV=production`, `CLIENT_ORIGIN=https://signal-ledger-livee.netlify.app`, `AUTH_SESSION_TTL_DAYS=7`, the hosted Neon `DATABASE_URL`, provider credentials, and the existing server-side GenLayer variables. Run `npm run migrate` once against Neon before starting the service.

On Netlify, keep the existing SPA build and set only the frontend connection variables:

```text
VITE_API_BASE_URL=https://genlayer-live-transcript.onrender.com
VITE_WS_BASE_URL=wss://genlayer-live-transcript.onrender.com
```

The Netlify site must not receive `DATABASE_URL`, provider API keys, `GENLAYER_PRIVATE_KEY`, or authentication implementation secrets. The existing `client/public/_redirects` file remains required so direct React Router URLs serve the SPA entry point.

## How to Verify This Project

1. Configure the root `.env` with Neon, Deepgram, exactly one summary-provider credential, and the Bradbury V2 variables.
2. Run `npm run migrate` and `npm run dev`.
3. Register User A, sign in, and confirm the username appears in the header.
4. Create a session and share a browser tab containing real speech.
5. Confirm real Deepgram transcript segments appear, then stop sharing.
6. Click **Complete Session**, then **Generate Summary**.
7. Inspect the canonical transcript, SHA-256 hash, summary status, summary, topics, announcements, and supported Q&A.
8. Refresh and confirm the canonical transcript, hash, and generated summary persist unchanged.
9. Click **Verify with GenLayer** and inspect the Bradbury contract, transaction hash, canonical hash, and validator reason.
10. Observe `ACCEPTED` or `REJECTED` only after the backend reads `get_verification` for the exact verification identity.
11. If the result is `REJECTED`, inspect the validator reason, click **Regenerate Summary**, and confirm the new summary uses the same canonical transcript and transcript hash.
12. Click **Verify New Summary with GenLayer** only when explicitly ready. Confirm the prior rejected attempt remains visible.
13. Log out, register User B, and confirm User B's archive does not contain User A's session.
14. Open User A's session URL while signed in as User B and confirm it shows **Record unavailable** without revealing session data.
15. Delete the session as User A and confirm local evidence is removed while the on-chain transaction remains immutable.

Older archived completed sessions can follow the same process when they contain finalized transcript segments. If no derivative exists, processing creates the canonical transcript and hash on demand; a ready summary is never regenerated automatically. They do not need to have been created after Phase 7.

## GenLayer verification

The application uses the deployed attempt-aware TranscriptVerifier V2 contract; it does not redeploy it:

- Contract: `TranscriptVerifier`
- Bradbury V2 deployment: `0x4DEfE1bbE75C59FcD2264EaCb75096f3CD659f5B`
- Network: `testnet-bradbury`
- Write methods: `submit_verification(transcript, proposed_summary, transcript_hash)` for the first attempt, and `submit_verification_attempt(transcript, proposed_summary, transcript_hash, verification_id)` for later attempts
- Read method: `get_verification(transcript_hash)`
- Optional read method: `has_successful_verification(transcript_hash)`
- Explorer contract URL: `https://explorer-bradbury.genlayer.com/address/0x4DEfE1bbE75C59FcD2264EaCb75096f3CD659f5B`

The server uses `genlayer-js` 1.1.8 with `createClient({ chain: testnetBradbury, account })`, `writeContract`, `getTransaction`, and `readContract`. Users do not connect wallets. The server-side account signs the transaction with `GENLAYER_PRIVATE_KEY`; that value is never sent to React, returned by an API, or logged.

Transaction state and semantic contract state are separate. A pending/finalized transaction does not become `ACCEPTED` or `REJECTED` in the UI by itself. The backend reads the stored TranscriptVerifier record and persists its `status` and `reason`.

Application verification states are `not_started`, `submitting`, `pending`, `accepted`, `rejected`, and `failed`. A failed submission without a transaction hash can be explicitly retried. A failed attempt with a transaction hash is not resubmitted automatically.

The deployed Bradbury V2 contract supports one verification identity per summary attempt. The first attempt uses `submit_verification`; regenerated summaries use `submit_verification_attempt`, with `verification_id` derived deterministically from the transcript hash and exact summary hash. `GENLAYER_TRANSCRIPT_VERIFIER_SUPPORTS_ATTEMPTS=1` enables this attempt-aware path. The transcript hash remains stable across attempts, while each summary attempt and its associated verification retain their own summary hash and validator evidence.

TranscriptVerifier will verify whether the generated summary faithfully represents the supplied transcript. It will not prove that the transcript itself is factually true, complete, or correctly attributed to speakers.

## Testing

Default unit/regression checks:

```powershell
npm test
npm run build
```

The hosted Neon lifecycle/integration tests can be run with:

```powershell
$env:RUN_DB_TESTS="1"
npm test
```

Tests cover account registration/login/logout/session expiry, password hashing and generic auth failures, username normalization and uniqueness, private archives, cross-user direct URL and mutation rejection, server-side ownership assignment, legacy NULL-owner isolation, authenticated owner/non-owner audio WebSockets, deterministic canonicalization, finalized-only inclusion, ordering, hash format, summary-provider diagnostics, legacy completed-session processing, summary retry and attempt history, completion/deletion lifecycle, exact GenLayer argument construction, transcript/hash integrity checks, duplicate-safe state handling, transaction-versus-contract-result mapping, malformed contract responses, and existing Phase 1–7 behavior.

Do not claim a live summary-provider request passed unless `SUMMARY_PROVIDER` and `SUMMARY_API_KEY` were actually configured and contacted.

## Limitations

- A real summary requires configured provider credentials and may incur provider cost; Gemini free-tier quota and availability are not guaranteed.
- Summary output is persisted as returned after schema validation; it is not a GenLayer consensus result until the user explicitly submits verification.
- No speaker diarization or identity attribution is performed.
- Completed transcript data is immutable. Editing is not supported in this phase.
- No raw audio is stored.
- A real Bradbury verification requires a funded server-side account and may take time for validator consensus. Transaction and validator evidence are available only after a live submission completes.
- Authentication rate limiting is process-local; a multi-instance deployment should put login/register rate limiting at the edge or use a shared limiter.
- Cookies require the exact configured `CLIENT_ORIGIN`; changing the Netlify hostname without updating Render CORS/cookie configuration will make authenticated requests fail.

## Project structure

```text
genlayer-live-transcript/
├── client/src/
│   ├── components/TranscriptPanel.jsx
│   ├── pages/LiveSessionPage.jsx
│   ├── pages/SessionPage.jsx
│   └── audioStream.js
├── server/src/
│   ├── db/schema.sql
│   ├── db/sessionLifecycle.js
│   ├── db/sessionProcessing.js
│   ├── db/transcriptStore.js
│   ├── db/verificationStore.js
│   ├── genlayer/transcriptVerifier.js
│   ├── genlayer/verificationLifecycle.js
│   ├── genlayer/verificationLogic.js
│   ├── integrity/transcriptIntegrity.js
│   ├── auth/auth.js
│   ├── routes/auth.js
│   ├── routes/sessions.js
│   ├── summary/summaryCommon.js
│   ├── summary/summaryProvider.js
│   ├── summary/geminiSummary.js
│   ├── summary/openaiSummary.js
│   ├── transcription/deepgram.js
│   └── websocket/audioServer.js
├── server/test/
│   ├── deepgram.test.js
│   ├── authOwnership.integration.test.js
│   ├── geminiSummary.test.js
│   ├── sessionLifecycle.integration.test.js
│   ├── summaryProvider.test.js
│   ├── verificationLogic.test.js
│   └── transcriptIntegrity.test.js
├── .env.example
└── README.md
```

Authentication is an application privacy layer and remains separate from the server-side GenLayer wallet. Users own private Signal Ledger data; the configured server account continues to pay for TranscriptVerifier transactions.
