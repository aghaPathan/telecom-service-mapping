import { ALL_ROLES, iconFor } from "@/lib/icons";

export const dynamic = "force-static";

export default function GraphPreviewPage() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Graph Preview</h1>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        Visual sanity check for role icons. Renders every role defined in
        <code className="mx-1 rounded bg-slate-100 px-1 dark:bg-slate-800">
          config/hierarchy.yaml
        </code>
        at node-badge size in both light and dark surfaces.
      </p>

      <section className="mt-8">
        <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300">
          Light surface
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
          Dark surface
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
