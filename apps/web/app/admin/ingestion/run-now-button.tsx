"use client";
import { useState } from "react";

type State =
  | { status: "idle" }
  | { status: "triggering" }
  | { status: "pending"; triggerId: number }
  | { status: "succeeded" | "failed" | "timeout" | "error"; triggerId?: number; runId?: number | null };

export function RunNowButton() {
  const [state, setState] = useState<State>({ status: "idle" });
  async function click() {
    setState({ status: "triggering" });
    const r = await fetch("/api/ingestion/run", { method: "POST" });
    if (!r.ok) {
      setState({ status: "error" });
      return;
    }
    const { trigger_id } = (await r.json()) as { trigger_id: number };
    setState({ status: "pending", triggerId: trigger_id });
    const start = Date.now();
    while (Date.now() - start < 120_000) {
      await new Promise((res) => setTimeout(res, 2000));
      const s = await fetch(`/api/ingestion/run/${trigger_id}`);
      if (!s.ok) continue;
      const body = (await s.json()) as {
        status: "pending" | "running" | "succeeded" | "failed";
        run_id: number | null;
      };
      if (body.status !== "pending" && body.status !== "running") {
        setState({
          status: body.status,
          triggerId: trigger_id,
          runId: body.run_id,
        });
        return;
      }
    }
    setState({ status: "timeout", triggerId: trigger_id });
  }
  const busy = state.status === "triggering" || state.status === "pending";
  return (
    <div className="flex items-center gap-3">
      <button
        data-testid="run-now-button"
        onClick={click}
        disabled={busy}
        className="px-3 py-1 rounded bg-slate-900 text-white disabled:opacity-50"
      >
        Run now
      </button>
      <span className="text-sm" data-testid="run-now-status">
        {state.status}
      </span>
    </div>
  );
}
