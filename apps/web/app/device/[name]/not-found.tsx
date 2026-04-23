import type { ReactElement } from "react";
import Link from "next/link";

// Next.js App Router auto-renders this file (with HTTP 404) when the
// sibling page.tsx calls notFound(). Styling mirrors the NoPathPanel in
// apps/web/app/_components/path-view.tsx so the error surface feels
// consistent across the app.
export default function DeviceNotFound(): ReactElement {
  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <div
        className="rounded-lg border border-red-200 bg-red-50 p-4 ring-1 ring-red-100"
        data-testid="device-not-found"
      >
        <h1 className="text-sm font-semibold text-red-900">
          Device not found
        </h1>
        <p className="mt-1 text-sm text-red-800">
          The device name in the URL is not present in the graph. It may have
          been renamed, removed from the topology, or never ingested.
        </p>
        <p className="mt-3 text-xs text-red-700">
          <Link
            href="/"
            className="font-medium underline decoration-red-300 underline-offset-2 hover:decoration-red-600"
          >
            Back to search
          </Link>
        </p>
      </div>
    </main>
  );
}
