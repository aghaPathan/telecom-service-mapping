"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { SearchResponse, DeviceHit, ServiceHit } from "@/lib/search";
import { RoleBadge } from "@/app/_components/role-badge";

type Row =
  | { kind: "device"; device: DeviceHit }
  | { kind: "service"; service: ServiceHit; endpoints: DeviceHit[] };

function flatten(r: SearchResponse): Row[] {
  if (r.kind === "empty") return [];
  if (r.kind === "service")
    return [{ kind: "service", service: r.service, endpoints: r.endpoints }];
  return r.devices.map((device) => ({ kind: "device", device }));
}

function hrefFor(row: Row): string {
  if (row.kind === "device")
    return `/device/${encodeURIComponent(row.device.name)}`;
  return `/service/${encodeURIComponent(row.service.cid)}`;
}

export function Omnibox() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounce user input — criterion says 250ms.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (!debounced) {
      setRows([]);
      setError(null);
      setActive(0);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/search?q=${encodeURIComponent(debounced)}`, {
      signal: ctrl.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          if (res.status === 429) throw new Error("Too many searches. Slow down.");
          throw new Error(`Search failed (${res.status})`);
        }
        const data = (await res.json()) as SearchResponse;
        setRows(flatten(data));
        setActive(0);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
        setRows([]);
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [debounced]);

  const showDropdown = useMemo(
    () => debounced.length > 0 && (loading || rows.length > 0 || error !== null),
    [debounced, loading, rows.length, error],
  );

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!showDropdown || rows.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[active];
      if (row) router.push(hrefFor(row));
    } else if (e.key === "Escape") {
      setRows([]);
    }
  }

  return (
    <div className="relative" data-testid="omnibox">
      <label htmlFor="omnibox-input" className="sr-only">
        Search devices and services
      </label>
      <input
        id="omnibox-input"
        ref={inputRef}
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search CID, mobily_cid, or device name…"
        aria-autocomplete="list"
        aria-controls="omnibox-results"
        aria-expanded={showDropdown}
        autoComplete="off"
        data-testid="omnibox-input"
        className="w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-base shadow-sm outline-none ring-slate-300 focus:border-slate-500 focus:ring-2"
      />

      {showDropdown && (
        <div
          id="omnibox-results"
          role="listbox"
          data-testid="omnibox-results"
          className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg"
        >
          {loading && (
            <div className="px-4 py-2 text-sm text-slate-500">Searching…</div>
          )}
          {error && !loading && (
            <div
              className="px-4 py-2 text-sm text-red-600"
              data-testid="omnibox-error"
            >
              {error}
            </div>
          )}
          {!loading && !error && rows.length === 0 && (
            <div className="px-4 py-2 text-sm text-slate-500">No matches.</div>
          )}
          {!loading &&
            !error &&
            rows.map((row, i) => {
              const isActive = i === active;
              const key =
                row.kind === "device" ? `d:${row.device.name}` : `s:${row.service.cid}`;
              return (
                <a
                  key={key}
                  href={hrefFor(row)}
                  role="option"
                  aria-selected={isActive}
                  data-testid="omnibox-row"
                  data-active={isActive}
                  onMouseEnter={() => setActive(i)}
                  className={`block border-t border-slate-100 px-4 py-2 text-sm first:border-t-0 ${
                    isActive ? "bg-slate-100" : "bg-white"
                  }`}
                >
                  {row.kind === "device" ? (
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium text-slate-900">
                        {row.device.name}
                      </span>
                      <span className="flex items-center gap-2 text-xs text-slate-500">
                        <RoleBadge role={row.device.role} level={row.device.level} />
                        {row.device.site ?? "—"} · {row.device.domain ?? "—"}
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium text-slate-900">
                        {row.service.cid}
                        {row.service.mobily_cid
                          ? ` · ${row.service.mobily_cid}`
                          : ""}
                      </span>
                      <span className="text-xs text-slate-500">
                        {row.service.bandwidth ?? "—"} ·{" "}
                        {row.service.protection_type ?? "—"}
                      </span>
                    </div>
                  )}
                </a>
              );
            })}
        </div>
      )}
    </div>
  );
}
