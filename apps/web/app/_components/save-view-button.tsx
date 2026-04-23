"use client";

import { useState } from "react";
import type { ViewPayload, Visibility } from "@/lib/saved-views";
import { visibilityOptions } from "@/lib/saved-views-visibility-ui";

type Role = "admin" | "operator" | "viewer";
type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

export function SaveViewButton({
  role,
  payload,
  defaultOpen = false,
}: {
  role: Role;
  payload: ViewPayload;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const options = visibilityOptions(role);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus({ kind: "saving" });
    try {
      const res = await fetch("/api/views", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, payload, visibility }),
      });
      if (res.status === 201) {
        setStatus({ kind: "saved" });
        setName("");
        return;
      }
      const err = await res.json().catch(() => ({}));
      const msg =
        err.error === "name_conflict"
          ? "Name already used"
          : err.error === "forbidden"
            ? "Not allowed at your role"
            : err.error === "rate_limited"
              ? "Try again in a moment"
              : "Save failed. Try again.";
      setStatus({ kind: "error", message: msg });
    } catch {
      setStatus({ kind: "error", message: "Save failed. Try again." });
    }
  }

  return (
    <div className="inline-block">
      <button
        type="button"
        data-testid="save-view-toggle"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm ring-1 ring-slate-100 hover:bg-slate-50"
      >
        Save view
      </button>
      {open && (
        <form
          onSubmit={onSubmit}
          data-testid="save-view-form"
          className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-white p-3 text-xs ring-1 ring-slate-100"
        >
          <label className="flex items-center gap-1">
            <span className="text-slate-600">Name</span>
            <input
              data-testid="save-view-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              required
              className="w-48 rounded border border-slate-300 px-2 py-1"
            />
          </label>
          <label className="flex items-center gap-1">
            <span className="text-slate-600">Visibility</span>
            <select
              data-testid="save-view-visibility"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as Visibility)}
              className="rounded border border-slate-300 px-2 py-1"
            >
              {options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={status.kind === "saving"}
            data-testid="save-view-submit"
            className="inline-flex items-center rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white shadow-sm hover:bg-slate-800 disabled:opacity-50"
          >
            {status.kind === "saving" ? "Saving…" : "Save"}
          </button>
          {status.kind === "saved" && (
            <span data-testid="save-view-ok" className="text-green-700">
              Saved
            </span>
          )}
          {status.kind === "error" && (
            <span data-testid="save-view-error" className="text-red-700">
              {status.message}
            </span>
          )}
        </form>
      )}
    </div>
  );
}
