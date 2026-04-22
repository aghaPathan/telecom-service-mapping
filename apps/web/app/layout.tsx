import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { FreshnessBadge } from "./_components/freshness-badge";
import "./globals.css";

export const metadata: Metadata = {
  title: "Telecom Service Mapping",
  description: "LLDP-derived telecom connectivity graph",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
            <Link
              href="/"
              className="text-sm font-semibold tracking-tight text-slate-800 hover:text-slate-600"
            >
              Telecom Service Mapping
            </Link>
            <Suspense
              fallback={
                <span
                  data-testid="freshness-badge"
                  className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-300"
                >
                  Loading…
                </span>
              }
            >
              {/* Server component: does its own DB fetch. */}
              <FreshnessBadge />
            </Suspense>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
