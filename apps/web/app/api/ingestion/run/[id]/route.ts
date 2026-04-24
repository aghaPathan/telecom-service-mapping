import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getTriggerStatus } from "@/lib/ingestion-triggers";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  await requireRole("admin");
  const triggerId = Number(params.id);
  if (!Number.isFinite(triggerId) || triggerId <= 0) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const status = await getTriggerStatus(triggerId);
  if (!status) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(status);
}
