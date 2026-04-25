import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/rbac";
import { listDwdmLinks, type DwdmRow, type ListDwdmFilter } from "@/lib/dwdm";
import { csvRow, sanitizeFilename } from "@/lib/csv";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Empty string -> undefined so `?ring=` doesn't silently match-all via
// `CONTAINS ""`. Trim then collapse blanks.
const filterField = z
  .string()
  .max(200)
  .transform((s) => s.trim())
  .transform((s) => (s.length === 0 ? undefined : s))
  .optional();

const QuerySchema = z.object({
  device_a: filterField,
  device_b: filterField,
  ring: filterField,
  span_name: filterField,
  format: z.enum(["json", "csv"]).default("json"),
});

type DwdmQuery = z.infer<typeof QuerySchema>;

function identFor(filter: ListDwdmFilter): string {
  if (filter.ring) return `ring-${filter.ring}`;
  if (filter.span_name) return `span-${filter.span_name}`;
  if (filter.device_a) return `device-${filter.device_a}`;
  if (filter.device_b) return `device-${filter.device_b}`;
  return "all";
}

const CSV_HEADER = [
  "a_name",
  "a_role",
  "a_level",
  "b_name",
  "b_role",
  "b_level",
  "ring",
  "span_name",
  "snfn_cids",
  "mobily_cids",
  "src_interface",
  "dst_interface",
] as const;

function rowToCsv(r: DwdmRow): string {
  return csvRow([
    r.a_name,
    r.a_role,
    r.a_level,
    r.b_name,
    r.b_role,
    r.b_level,
    r.ring,
    r.span_name,
    // Join arrays with `;` BEFORE csvEscape so we don't introduce CSV-comma
    // collisions. csvEscape will still wrap if any element contains a special.
    r.snfn_cids.join(";"),
    r.mobily_cids.join(";"),
    r.src_interface,
    r.dst_interface,
  ]);
}

export async function GET(req: NextRequest) {
  const session = await requireRole("viewer");

  const input = Object.fromEntries(req.nextUrl.searchParams);
  let parsed: DwdmQuery;
  try {
    parsed = QuerySchema.parse(input);
  } catch {
    return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  }

  const filter: ListDwdmFilter = {
    device_a: parsed.device_a,
    device_b: parsed.device_b,
    ring: parsed.ring,
    span_name: parsed.span_name,
  };

  let rows: DwdmRow[];
  try {
    rows = await listDwdmLinks(filter);
  } catch (err) {
    log("error", "dwdm_list_failed", {
      error: err instanceof Error ? err.message : String(err),
      user: session.user.id,
      format: parsed.format,
    });
    return NextResponse.json({ error: "dwdm_list_failed" }, { status: 503 });
  }

  if (parsed.format === "csv") {
    const header = csvRow([...CSV_HEADER]);
    const body = rows.map(rowToCsv).join("\n");
    const csv = body.length > 0 ? `${header}\n${body}\n` : `${header}\n`;
    const filename = `dwdm-${sanitizeFilename(identFor(filter))}.csv`;
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  return NextResponse.json({ rows });
}
