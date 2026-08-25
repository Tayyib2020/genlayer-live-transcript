CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_normalized TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_digest TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_idx
  ON auth_sessions (user_id);

CREATE INDEX IF NOT EXISTS auth_sessions_expires_at_idx
  ON auth_sessions (expires_at);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'live', 'processing', 'completed', 'failed')),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS sessions_user_created_at_idx
  ON sessions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS sessions_status_created_at_idx
  ON sessions (status, created_at DESC);

CREATE OR REPLACE FUNCTION set_sessions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sessions_set_updated_at ON sessions;

CREATE TRIGGER sessions_set_updated_at
BEFORE UPDATE ON sessions
FOR EACH ROW
EXECUTE FUNCTION set_sessions_updated_at();

CREATE TABLE IF NOT EXISTS transcript_segments (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  text TEXT NOT NULL CHECK (char_length(trim(text)) > 0),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_final BOOLEAN NOT NULL DEFAULT TRUE,
  provider TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  source_start_seconds NUMERIC,
  source_duration_seconds NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, sequence_number),
  UNIQUE (session_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS transcript_segments_session_sequence_idx
  ON transcript_segments (session_id, sequence_number);

CREATE TABLE IF NOT EXISTS session_derivatives (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  canonical_transcript TEXT NOT NULL,
  transcript_hash TEXT NOT NULL CHECK (transcript_hash ~ '^0x[0-9a-f]{64}$'),
  summary TEXT,
  topics JSONB NOT NULL DEFAULT '[]'::jsonb,
  announcements JSONB NOT NULL DEFAULT '[]'::jsonb,
  questions_answers JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary_generation_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (summary_generation_status IN ('not_started', 'generating', 'ready', 'failed')),
  summary_generated_at TIMESTAMPTZ,
  summary_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS session_derivatives_summary_status_idx
  ON session_derivatives (summary_generation_status);

CREATE TABLE IF NOT EXISTS summary_attempts (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  summary TEXT,
  summary_hash TEXT CHECK (summary_hash IS NULL OR summary_hash ~ '^0x[0-9a-f]{64}$'),
  topics JSONB NOT NULL DEFAULT '[]'::jsonb,
  announcements JSONB NOT NULL DEFAULT '[]'::jsonb,
  questions_answers JSONB NOT NULL DEFAULT '[]'::jsonb,
  generation_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (generation_status IN ('not_started', 'generating', 'ready', 'failed')),
  generated_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, attempt_number),
  UNIQUE (session_id, summary_hash)
);

CREATE INDEX IF NOT EXISTS summary_attempts_session_idx
  ON summary_attempts (session_id, attempt_number DESC);

CREATE OR REPLACE FUNCTION set_summary_attempts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS summary_attempts_set_updated_at ON summary_attempts;

CREATE TRIGGER summary_attempts_set_updated_at
BEFORE UPDATE ON summary_attempts
FOR EACH ROW
EXECUTE FUNCTION set_summary_attempts_updated_at();

CREATE TABLE IF NOT EXISTS session_verifications (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  transcript_hash TEXT NOT NULL UNIQUE CHECK (transcript_hash ~ '^0x[0-9a-f]{64}$'),
  contract_address TEXT NOT NULL,
  network TEXT NOT NULL,
  transaction_hash TEXT,
  transaction_status TEXT,
  verification_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (verification_status IN ('not_started', 'submitting', 'pending', 'accepted', 'rejected', 'failed')),
  contract_status TEXT CHECK (contract_status IS NULL OR contract_status IN ('ACCEPTED', 'REJECTED')),
  reason TEXT,
  submitted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS session_verifications_status_idx
  ON session_verifications (verification_status);

CREATE INDEX IF NOT EXISTS session_verifications_transaction_idx
  ON session_verifications (transaction_hash);

CREATE TABLE IF NOT EXISTS verification_attempts (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  summary_attempt_id BIGINT NOT NULL REFERENCES summary_attempts(id) ON DELETE CASCADE,
  transcript_hash TEXT NOT NULL CHECK (transcript_hash ~ '^0x[0-9a-f]{64}$'),
  summary_hash TEXT,
  verification_id TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  network TEXT NOT NULL,
  transaction_hash TEXT,
  transaction_status TEXT,
  verification_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (verification_status IN ('not_started', 'submitting', 'pending', 'accepted', 'rejected', 'failed')),
  contract_status TEXT CHECK (contract_status IS NULL OR contract_status IN ('ACCEPTED', 'REJECTED')),
  reason TEXT,
  submitted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (summary_attempt_id),
  UNIQUE (verification_id)
);

CREATE INDEX IF NOT EXISTS verification_attempts_session_idx
  ON verification_attempts (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS verification_attempts_transaction_idx
  ON verification_attempts (transaction_hash);

CREATE OR REPLACE FUNCTION set_verification_attempts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS verification_attempts_set_updated_at ON verification_attempts;

CREATE TRIGGER verification_attempts_set_updated_at
BEFORE UPDATE ON verification_attempts
FOR EACH ROW
EXECUTE FUNCTION set_verification_attempts_updated_at();

CREATE OR REPLACE FUNCTION set_session_verifications_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS session_verifications_set_updated_at ON session_verifications;

CREATE TRIGGER session_verifications_set_updated_at
BEFORE UPDATE ON session_verifications
FOR EACH ROW
EXECUTE FUNCTION set_session_verifications_updated_at();
