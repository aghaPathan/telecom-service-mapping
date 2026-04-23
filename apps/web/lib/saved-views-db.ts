import { getPool } from "@/lib/postgres";
import type { Role } from "@/lib/rbac";
import {
  canSetVisibility,
  visibleVisibilities,
} from "@/lib/saved-views-visibility";
import type {
  CreateBody,
  UpdateBody,
  ViewPayload,
  Visibility,
} from "@/lib/saved-views";

// ---------- Types ----------

export type SavedView = {
  id: string;
  owner_user_id: string;
  name: string;
  kind: "path" | "downstream";
  payload: ViewPayload;
  visibility: Visibility;
  created_at: string;
  updated_at: string;
};

export type Actor = { id: string; role: Role };

type Row = {
  id: string;
  owner_user_id: string;
  name: string;
  kind: "path" | "downstream";
  payload_json: ViewPayload;
  visibility: Visibility;
  created_at: Date;
  updated_at: Date;
};

function rowToView(r: Row): SavedView {
  return {
    id: r.id,
    owner_user_id: r.owner_user_id,
    name: r.name,
    kind: r.kind,
    payload: r.payload_json,
    visibility: r.visibility,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

// ---------- Result union ----------

export type DbResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "forbidden" }
  | { kind: "not_found" }
  | { kind: "name_conflict" };

function ok<T>(value: T): DbResult<T> {
  return { kind: "ok", value };
}

// ---------- Operations ----------

export async function createView(
  actor: Actor,
  body: CreateBody,
): Promise<DbResult<SavedView>> {
  if (!canSetVisibility(actor.role, body.visibility)) {
    return { kind: "forbidden" };
  }
  try {
    const { rows } = await getPool().query<Row>(
      `INSERT INTO saved_views (owner_user_id, name, kind, payload_json, visibility)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING id, owner_user_id, name, kind, payload_json, visibility, created_at, updated_at`,
      [
        actor.id,
        body.name,
        body.payload.kind,
        JSON.stringify(body.payload),
        body.visibility,
      ],
    );
    return ok(rowToView(rows[0]!));
  } catch (err) {
    // 23505 = unique_violation on saved_views_owner_name_uniq.
    if ((err as { code?: string }).code === "23505") {
      return { kind: "name_conflict" };
    }
    throw err;
  }
}

export async function listViews(actor: Actor): Promise<SavedView[]> {
  const shares = visibleVisibilities(actor.role);
  // Owner's views + any non-deleted row whose visibility is in the shares set.
  // `visibility::text = ANY($2)` avoids needing to ship the enum[] binding.
  const { rows } = await getPool().query<Row>(
    `SELECT id, owner_user_id, name, kind, payload_json, visibility, created_at, updated_at
       FROM saved_views
      WHERE deleted_at IS NULL
        AND (owner_user_id = $1 OR visibility::text = ANY($2::text[]))
      ORDER BY updated_at DESC`,
    [actor.id, shares],
  );
  return rows.map(rowToView);
}

export async function getView(
  actor: Actor,
  id: string,
): Promise<DbResult<SavedView>> {
  const { rows } = await getPool().query<Row>(
    `SELECT id, owner_user_id, name, kind, payload_json, visibility, created_at, updated_at
       FROM saved_views
      WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  const row = rows[0];
  if (!row) return { kind: "not_found" };
  const view = rowToView(row);
  if (view.owner_user_id === actor.id) return ok(view);
  const shares = visibleVisibilities(actor.role);
  if (view.visibility !== "private" && shares.includes(view.visibility as never)) {
    return ok(view);
  }
  return { kind: "forbidden" };
}

export async function updateView(
  actor: Actor,
  id: string,
  body: UpdateBody,
): Promise<DbResult<SavedView>> {
  // Only the owner may mutate. Fetch first to distinguish 404 from 403.
  const { rows: existing } = await getPool().query<Row>(
    `SELECT id, owner_user_id, name, kind, payload_json, visibility, created_at, updated_at
       FROM saved_views
      WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  const current = existing[0];
  if (!current) return { kind: "not_found" };
  if (current.owner_user_id !== actor.id) return { kind: "forbidden" };

  if (body.visibility && !canSetVisibility(actor.role, body.visibility)) {
    return { kind: "forbidden" };
  }

  // Build a dynamic SET clause; payload / kind must update together so the
  // persisted kind always matches the payload's kind field.
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (body.name !== undefined) {
    sets.push(`name = $${i++}`);
    params.push(body.name);
  }
  if (body.payload !== undefined) {
    sets.push(`kind = $${i++}`);
    params.push(body.payload.kind);
    sets.push(`payload_json = $${i++}::jsonb`);
    params.push(JSON.stringify(body.payload));
  }
  if (body.visibility !== undefined) {
    sets.push(`visibility = $${i++}`);
    params.push(body.visibility);
  }
  if (sets.length === 0) return ok(rowToView(current));

  params.push(id);
  try {
    const { rows } = await getPool().query<Row>(
      `UPDATE saved_views SET ${sets.join(", ")}
         WHERE id = $${i} AND deleted_at IS NULL
       RETURNING id, owner_user_id, name, kind, payload_json, visibility, created_at, updated_at`,
      params,
    );
    return ok(rowToView(rows[0]!));
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return { kind: "name_conflict" };
    }
    throw err;
  }
}

export async function deleteView(
  actor: Actor,
  id: string,
): Promise<DbResult<null>> {
  const { rows } = await getPool().query<{ owner_user_id: string }>(
    `SELECT owner_user_id FROM saved_views
      WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  const row = rows[0];
  if (!row) return { kind: "not_found" };
  if (row.owner_user_id !== actor.id) return { kind: "forbidden" };
  await getPool().query(
    `UPDATE saved_views SET deleted_at = now() WHERE id = $1`,
    [id],
  );
  return ok(null);
}
