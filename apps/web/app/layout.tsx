import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { getSession } from "@/lib/session";
import { FreshnessBadge } from "./_components/freshness-badge";
import { LogoutButton } from "./_components/logout-button";
import { MyViewsDropdown } from "./_components/my-views-dropdown";
import "./globals.css";

export const metadata: Metadata = {
  title: "Telecom Service Mapping",
  description: "LLDP-derived telecom connectivity graph",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 font-sans text-slate-900 antialiased">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
            <Link
              href="/"
              className="text-sm font-semibold tracking-tight text-slate-800 hover:text-slate-600"
            >
              Telecom Service Mapping
            </Link>
            <div className="flex items-center gap-3">
              {session?.user ? (
                <>
                  <span
                    data-testid="session-pill"
                    className="text-xs text-slate-600"
                  >
                    {session.user.email}{" "}
                    <span className="text-slate-400">
                      ({session.user.role})
                    </span>
                  </span>
                  <MyViewsDropdown currentUserId={session.user.id} />
                  <LogoutButton />
                </>
              ) : null}
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
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
