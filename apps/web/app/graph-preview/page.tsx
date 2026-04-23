import nextDynamic from "next/dynamic";
import { ALL_ROLES, iconFor } from "@/lib/icons";

export const dynamic = "force-static";

// reactflow needs `window` at import time. Mount the canvas client-only so
// the surrounding page stays server-rendered.
const PreviewCanvas = nextDynamic(
  () => import("./preview-canvas").then((m) => m.PreviewCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[560px] items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-sm text-slate-500">
        Loading graph…
      </div>
    ),
  },
);

export default function GraphPreviewPage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Graph Preview</h1>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        Visual sanity check for the S13 reactflow adapter and the S16 role
        icons. No live data — six-node mock topology inline.
      </p>

      <section className="mt-8">
        <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300">
          Reactflow canvas (mock topology)
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Zoom / pan / drag should work; minimap and controls render bottom
          corners. DeviceNode + ClusterNode placeholders only — real styling
          lands in S17 / S19.
        </p>
        <div className="mt-3">
          <PreviewCanvas />
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300">
          Role icons — light surface
        </h2>
        <ul
          className="mt-3 grid grid-cols-2 gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-3 md:grid-cols-4"
          data-testid="icon-grid-light"
        >
          {ALL_ROLES.map((role) => (
            <li
              key={role}
              className="flex items-center gap-3 rounded-md border border-slate-100 p-3"
            >
              {iconFor(role)}
              <span className="text-sm text-slate-800">{role}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300">
          Role icons — dark surface
        </h2>
        <ul
          className="mt-3 grid grid-cols-2 gap-3 rounded-lg border border-slate-800 bg-slate-950 p-4 sm:grid-cols-3 md:grid-cols-4"
          data-testid="icon-grid-dark"
        >
          {ALL_ROLES.map((role) => (
            <li
              key={role}
              className="dark flex items-center gap-3 rounded-md border border-slate-800 p-3"
            >
              {iconFor(role)}
              <span className="text-sm text-slate-100">{role}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
