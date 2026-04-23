"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { savedViewToHref } from "@/lib/saved-views-url";
import type { ViewPayload, Visibility } from "@/lib/saved-views";

type SavedViewDTO = {
  id: string;
  name: string;
  kind: "path" | "downstream";
  visibility: Visibility;
  payload: ViewPayload;
  owner_user_id: string;
};

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; views: SavedViewDTO[] }
  | { kind: "error" };

export function MyViewsDropdown({ currentUserId }: { currentUserId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });

  useEffect(() => {
    if (!open || state.kind !== "idle") return;
    setState({ kind: "loading" });
    fetch("/api/views", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((body: { views: SavedViewDTO[] }) =>
        setState({ kind: "ok", views: body.views }),
      )
      .catch(() => setState({ kind: "error" }));
  }, [open, state.kind]);

  return (
    <div className="relative">
      <button
        type="button"
        data-testid="my-views-toggle"
        onClick={() => setOpen((v) => !v)}
        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
      >
        My views
      </button>
      {open && (
        <div
          data-testid="my-views-panel"
          className="absolute right-0 z-10 mt-1 w-72 rounded-md border border-slate-200 bg-white p-2 text-xs shadow-lg ring-1 ring-slate-100"
        >
          {state.kind === "loading" && <div>Loading…</div>}
          {state.kind === "error" && (
            <div className="text-red-700">Couldn&apos;t load views</div>
          )}
          {state.kind === "ok" && state.views.length === 0 && (
            <div data-testid="my-views-empty" className="text-slate-500">
              No saved views
            </div>
          )}
          {state.kind === "ok" && state.views.length > 0 && (
            <ul className="divide-y divide-slate-100">
              {state.views.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    data-testid="my-views-item"
                    onClick={() => {
                      router.push(savedViewToHref(v.payload));
                      setOpen(false);
                    }}
                    className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left hover:bg-slate-50"
                  >
                    <span className="truncate font-medium text-slate-800">
                      {v.name}
                    </span>
                    <span className="shrink-0 text-slate-500">
                      {v.kind} ·{" "}
                      {v.owner_user_id === currentUserId ? "yours" : "shared"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
