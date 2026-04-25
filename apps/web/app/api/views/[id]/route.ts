import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/rbac";
import { tryConsume } from "@/lib/rate-limit";
import { log } from "@/lib/logger";
import { getPool } from "@/lib/postgres";
import { UpdateBody } from "@/lib/saved-views";
import {
  deleteView,
  getView,
  updateView,
  type SavedView,
} from "@/lib/saved-views-db";
import { runPath } from "@/lib/path";
import { runDownstream } from "@/lib/downstream";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const UuidParam = z.string().uuid();

function rateLimit(userId: string): NextResponse | null {
  const rl = tryConsume(`views:${userId}`, { capacity: 30, refillPerSec: 5 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": "1" } },
    );
  }
  return null;
}

async function audit(
  userId: string,
  action: string,
  target: string | null,
  metadata: Record<string, unknown>,
) {
  try {
    await getPool().query(
      `INSERT INTO audit_log (user_id, action, target, metadata_json)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [userId, action, target, JSON.stringify(metadata)],
    );
  } catch (err) {
    log("error", "audit_write_failed", {
      action,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function executePayload(view: SavedView) {
  if (view.payload.kind === "path") {
    return {
      kind: "path" as const,
      result: await runPath({ ...view.payload.query, to: undefined }),
    };
  }
  return {
    kind: "downstream" as const,
    result: await runDownstream(view.payload.query),
  };
}

type RouteCtx = { params: { id: string } };

export async function GET(_req: NextRequest, ctx: RouteCtx) {
  const session = await requireRole("viewer");
  const limited = rateLimit(session.user.id);
  if (limited) return limited;

  const parsed = UuidParam.safeParse(ctx.params.id);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const res = await getView(
    { id: session.user.id, role: session.user.role },
    parsed.data,
  );
  if (res.kind === "not_found")
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (res.kind === "forbidden")
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (res.kind === "name_conflict")
    return NextResponse.json({ error: "name_conflict" }, { status: 409 });

  try {
    const executed = await executePayload(res.value);
    return NextResponse.json({ view: res.value, ...executed });
  } catch (err) {
    log("error", "saved_view_replay_failed", {
      id: res.value.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "replay_failed" }, { status: 503 });
  }
}

export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  const session = await requireRole("viewer");
  const limited = rateLimit(session.user.id);
  if (limited) return limited;

  const parsedId = UuidParam.safeParse(ctx.params.id);
  if (!parsedId.success)
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  let body;
  try {
    body = UpdateBody.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const res = await updateView(
    { id: session.user.id, role: session.user.role },
    parsedId.data,
    body,
  );
  switch (res.kind) {
    case "ok":
      await audit(session.user.id, "saved_view.update", res.value.id, {
        fields: Object.keys(body),
      });
      return NextResponse.json({ view: res.value });
    case "not_found":
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    case "forbidden":
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    case "name_conflict":
      return NextResponse.json({ error: "name_conflict" }, { status: 409 });
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  const session = await requireRole("viewer");
  const limited = rateLimit(session.user.id);
  if (limited) return limited;

  const parsedId = UuidParam.safeParse(ctx.params.id);
  if (!parsedId.success)
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const res = await deleteView(
    { id: session.user.id, role: session.user.role },
    parsedId.data,
  );
  switch (res.kind) {
    case "ok":
      await audit(session.user.id, "saved_view.delete", parsedId.data, {});
      return NextResponse.json({ ok: true });
    case "not_found":
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    case "forbidden":
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    case "name_conflict":
      return NextResponse.json({ error: "name_conflict" }, { status: 409 });
  }
}
