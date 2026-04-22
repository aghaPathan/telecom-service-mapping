import { NextResponse } from "next/server";
import { getIngestionStatus } from "@/lib/ingestion";
import { log } from "@/lib/logger";

// Short cache keeps the badge cheap; nightly ingest freshness doesn't change
// second-to-second.
export const revalidate = 5;

export async function GET() {
  try {
    const status = await getIngestionStatus();
    return NextResponse.json(status);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", "ingestion_status_failed", { error: msg });
    return NextResponse.json(
      { latest: null, graph: null, error: msg },
      { status: 503 },
    );
  }
}
