import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { tryConsume } from "@/lib/rate-limit";
import { log } from "@/lib/logger";
import { getPool } from "@/lib/postgres";
import { CreateBody } from "@/lib/saved-views";
import { createView, listViews } from "@/lib/saved-views-db";

export const dynamic = "force-dynamic";
export const revalidate = 0;

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

export async function GET() {
  const session = await requireRole("viewer");
  const limited = rateLimit(session.user.id);
  if (limited) return limited;
  const views = await listViews({ id: session.user.id, role: session.user.role });
  return NextResponse.json({ views });
}

export async function POST(req: NextRequest) {
  const session = await requireRole("viewer");
  const limited = rateLimit(session.user.id);
  if (limited) return limited;

  let body;
  try {
    body = CreateBody.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const res = await createView(
    { id: session.user.id, role: session.user.role },
    body,
  );
  switch (res.kind) {
    case "ok":
      await audit(session.user.id, "saved_view.create", res.value.id, {
        kind: res.value.kind,
        visibility: res.value.visibility,
      });
      return NextResponse.json({ view: res.value }, { status: 201 });
    case "forbidden":
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    case "name_conflict":
      return NextResponse.json({ error: "name_conflict" }, { status: 409 });
    case "not_found":
      return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
}
