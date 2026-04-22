-- Up Migration
--
-- Auth core schema for Auth.js v5 + @auth/pg-adapter + RBAC.
--
-- @auth/pg-adapter column expectations (verified against
-- node_modules/@auth/pg-adapter/index.js v1.5.0):
--
--   users              : id, name, email, "emailVerified" (quoted camelCase), image
--   sessions           : id, "userId" (FK users.id), expires, "sessionToken" (unique)
--   verification_token : (singular table name) identifier, token, expires
--   accounts           : "userId", provider, type, "providerAccountId",
--                        access_token, expires_at, refresh_token, id_token,
--                        scope, session_state, token_type
--
-- The Credentials provider in this project does not exercise accounts or the
-- verification_token flow, but the tables are created so the adapter is
-- fully usable should we ever enable another provider.
--
-- Project additions on top of the adapter shape:
--   users.password_hash   TEXT       -- bcrypt, cost=12
--   users.role            user_role  -- admin | operator | viewer
--   users.is_active       BOOLEAN
--   users.created_at / updated_at
--   audit_log             -- append-only audit trail (login, role change, etc)

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('admin', 'operator', 'viewer');

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT,
  email           CITEXT UNIQUE NOT NULL,
  "emailVerified" TIMESTAMPTZ,
  image           TEXT,
  password_hash   TEXT NOT NULL,
  role            user_role NOT NULL DEFAULT 'viewer',
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sessions (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId"       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires        TIMESTAMPTZ NOT NULL,
  "sessionToken" TEXT UNIQUE NOT NULL
);

CREATE INDEX sessions_user_id_idx ON sessions ("userId");
CREATE INDEX sessions_expires_idx ON sessions (expires);

CREATE TABLE verification_token (
  identifier TEXT NOT NULL,
  token      TEXT NOT NULL,
  expires    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (identifier, token)
);

CREATE TABLE accounts (
  id                  SERIAL PRIMARY KEY,
  "userId"            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type                TEXT NOT NULL,
  provider            TEXT NOT NULL,
  "providerAccountId" TEXT NOT NULL,
  refresh_token       TEXT,
  access_token        TEXT,
  expires_at          BIGINT,
  id_token            TEXT,
  scope               TEXT,
  session_state       TEXT,
  token_type          TEXT,
  UNIQUE (provider, "providerAccountId")
);

CREATE INDEX accounts_user_id_idx ON accounts ("userId");

CREATE TABLE audit_log (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  target        TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_at_idx ON audit_log (at DESC);

-- Down Migration
-- DROP INDEX IF EXISTS audit_log_at_idx;
-- DROP TABLE IF EXISTS audit_log;
-- DROP INDEX IF EXISTS accounts_user_id_idx;
-- DROP TABLE IF EXISTS accounts;
-- DROP TABLE IF EXISTS verification_token;
-- DROP INDEX IF EXISTS sessions_expires_idx;
-- DROP INDEX IF EXISTS sessions_user_id_idx;
-- DROP TABLE IF EXISTS sessions;
-- DROP TRIGGER IF EXISTS users_set_updated_at ON users;
-- DROP TABLE IF EXISTS users;
-- DROP FUNCTION IF EXISTS set_updated_at();
-- DROP TYPE IF EXISTS user_role;
-- -- extensions (citext, pgcrypto) intentionally left in place; they may be
-- -- used by other migrations.
