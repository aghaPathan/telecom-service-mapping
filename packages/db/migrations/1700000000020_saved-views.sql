-- Up Migration
--
-- Saved views (issue #12): named user queries over path-trace or downstream.
-- Stores the *query* (payload_json), not cached results — opening a saved view
-- re-executes it against the current graph.
--
-- Visibility is an explicit enum of literal strings per AC:
--   'private'         — owner-only
--   'role:<role>'     — visible to anyone with RANK[user] >= RANK[role]
-- The AC calls out these four values exactly; we encode them as an enum rather
-- than a free-text column to stop clients smuggling new visibility values past
-- the zod layer and into the DB.

CREATE TYPE saved_view_kind AS ENUM ('path', 'downstream');

CREATE TYPE saved_view_visibility AS ENUM (
  'private',
  'role:viewer',
  'role:operator',
  'role:admin'
);

CREATE TABLE saved_views (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  kind           saved_view_kind NOT NULL,
  payload_json   JSONB NOT NULL,
  visibility     saved_view_visibility NOT NULL DEFAULT 'private',
  deleted_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique name per owner, ignoring soft-deleted rows so names can be reused
-- after a user deletes a saved view.
CREATE UNIQUE INDEX saved_views_owner_name_uniq
  ON saved_views (owner_user_id, name)
  WHERE deleted_at IS NULL;

-- Supports the list query's role-share filter.
CREATE INDEX saved_views_visibility_idx
  ON saved_views (visibility)
  WHERE deleted_at IS NULL;

CREATE INDEX saved_views_owner_idx
  ON saved_views (owner_user_id)
  WHERE deleted_at IS NULL;

-- Reuse set_updated_at() defined in 1700000000010_auth-core.sql.
CREATE TRIGGER saved_views_set_updated_at
  BEFORE UPDATE ON saved_views
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration
-- DROP TRIGGER IF EXISTS saved_views_set_updated_at ON saved_views;
-- DROP INDEX IF EXISTS saved_views_owner_idx;
-- DROP INDEX IF EXISTS saved_views_visibility_idx;
-- DROP INDEX IF EXISTS saved_views_owner_name_uniq;
-- DROP TABLE IF EXISTS saved_views;
-- DROP TYPE IF EXISTS saved_view_visibility;
-- DROP TYPE IF EXISTS saved_view_kind;
