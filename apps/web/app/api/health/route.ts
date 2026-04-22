import { NextResponse } from "next/server";
import { pingNeo4j } from "@/lib/neo4j";
import { pingPostgres } from "@/lib/postgres";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const [postgres, neo4j] = await Promise.all([pingPostgres(), pingNeo4j()]);
  const ok = postgres.ok && neo4j.ok;
  const body = {
    status: ok ? "ok" : "degraded",
    postgres,
    neo4j,
  };
  return NextResponse.json(body, { status: ok ? 200 : 503 });
}
