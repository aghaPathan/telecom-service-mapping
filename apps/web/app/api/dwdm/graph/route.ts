import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/rbac";
import {
  getNodeDwdm,
  getRingDwdm,
  type EdgeDto,
  type NodeDto,
} from "@/lib/dwdm";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Empty string -> undefined so `?node=` doesn't slip through as a valid name.
const filterField = z
  .string()
  .max(200)
  .transform((s) => s.trim())
  .transform((s) => (s.length === 0 ? undefined : s))
  .optional();

const QuerySchema = z
  .object({
    node: filterField,
    ring: filterField,
  })
  .refine(
    (v) => (v.node !== undefined) !== (v.ring !== undefined),
    { message: "exactly_one_of_node_or_ring" },
  );

type GraphQuery = z.infer<typeof QuerySchema>;

export async function GET(req: NextRequest) {
  const session = await requireRole("viewer");

  const input = Object.fromEntries(req.nextUrl.searchParams);
  let parsed: GraphQuery;
  try {
    parsed = QuerySchema.parse(input);
  } catch {
    return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  }

  let result: { nodes: NodeDto[]; edges: EdgeDto[] };
  try {
    if (parsed.node !== undefined) {
      result = await getNodeDwdm(parsed.node);
    } else {
      // refine guarantees ring is defined here.
      result = await getRingDwdm(parsed.ring as string);
    }
  } catch (err) {
    log("error", "dwdm_graph_failed", {
      error: err instanceof Error ? err.message : String(err),
      user: session.user.id,
      mode: parsed.node !== undefined ? "node" : "ring",
    });
    return NextResponse.json({ error: "dwdm_graph_failed" }, { status: 503 });
  }

  return NextResponse.json(result);
}
