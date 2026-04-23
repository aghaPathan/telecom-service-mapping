"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";

/**
 * Pure filter used by the combobox. Exported for unit tests and for callers
 * that want to pre-compute filtered results (e.g. server-side render).
 *
 * - Empty / whitespace query → return the full list unchanged.
 * - Query equal to the current `selected` value → return the full list so the
 *   dropdown shows all options when the user re-opens it after selecting.
 * - Otherwise case-insensitive substring match.
 */
export function filterSites(
  sites: readonly string[],
  query: string,
  selected: string | null = null,
): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return sites.slice();
  if (q === (selected ?? "").toLowerCase()) return sites.slice();
  return sites.filter((s) => s.toLowerCase().includes(q));
}

export type SiteSelectorProps = {
  /** Full list of site codes (top-40 from empirical query, upstream). */
  sites: string[];
  value: string | null;
  onChange: (next: string | null) => void;
  placeholder?: string;
  /** Shown above the input. */
  label?: string;
  className?: string;
};

/**
 * Unstyled-logic combobox: type to filter, arrow keys to navigate, Enter to
 * select, Escape to close, clear button ("×") to reset. Uses roving tabindex
 * on the input with `aria-activedescendant` pointing at the highlighted row
 * — the WAI-ARIA 1.2 combobox pattern.
 */
export function SiteSelector({
  sites,
  value,
  onChange,
  placeholder = "Select site…",
  label = "Site",
  className = "",
}: SiteSelectorProps): ReactElement {
  const listId = useId();
  const [query, setQuery] = useState(value ?? "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep input in sync when `value` prop changes externally.
  useEffect(() => {
    setQuery(value ?? "");
  }, [value]);

  const filtered = useMemo(() => filterSites(sites, query, value), [sites, query, value]);

  useEffect(() => {
    if (active >= filtered.length) setActive(0);
  }, [filtered.length, active]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  function commit(site: string) {
    onChange(site);
    setQuery(site);
    setOpen(false);
  }

  function clear() {
    onChange(null);
    setQuery("");
    setActive(0);
    setOpen(true);
    inputRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      if (open && filtered[active]) {
        e.preventDefault();
        commit(filtered[active]);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      setQuery(value ?? "");
    } else if (e.key === "Home") {
      if (open) {
        e.preventDefault();
        setActive(0);
      }
    } else if (e.key === "End") {
      if (open) {
        e.preventDefault();
        setActive(Math.max(0, filtered.length - 1));
      }
    }
  }

  return (
    <div ref={rootRef} className={`relative ${className}`.trim()} data-testid="site-selector">
      {label ? (
        <label
          htmlFor={`${listId}-input`}
          className="mb-1.5 flex items-center gap-2 font-mono text-[10px] font-medium uppercase tracking-widest text-slate-500 dark:text-slate-400"
        >
          <span aria-hidden="true" className="h-px w-3 bg-slate-400 dark:bg-slate-600" />
          {label}
        </label>
      ) : null}
      <div className="relative">
        <input
          id={`${listId}-input`}
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${listId}-listbox`}
          aria-autocomplete="list"
          aria-activedescendant={
            open && filtered[active] ? `${listId}-opt-${active}` : undefined
          }
          value={query}
          placeholder={placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="w-full rounded-none border border-slate-400 bg-white py-2 pl-3 pr-14 font-mono text-[13px] text-slate-900 outline-none transition-colors focus:border-orange-500 focus:ring-2 focus:ring-orange-500/30 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-50 dark:focus:border-orange-400 dark:focus:ring-orange-400/30"
          autoComplete="off"
          spellCheck={false}
        />
        {query ? (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear site"
            className="absolute inset-y-0 right-7 flex w-7 items-center justify-center border-l border-slate-300 font-mono text-slate-400 transition-colors hover:text-orange-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 dark:border-slate-700 dark:hover:text-orange-400"
          >
            ×
          </button>
        ) : null}
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute inset-y-0 right-0 flex w-7 items-center justify-center border-l border-slate-300 text-slate-500 transition-transform dark:border-slate-700 dark:text-slate-400 ${
            open ? "rotate-180" : ""
          }`}
        >
          ▾
        </span>
      </div>
      {open && filtered.length > 0 ? (
        <ul
          id={`${listId}-listbox`}
          role="listbox"
          className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-none border border-slate-400 bg-white py-1 shadow-[4px_4px_0_0_rgba(0,0,0,0.08)] dark:border-slate-600 dark:bg-slate-950 dark:shadow-[4px_4px_0_0_rgba(255,255,255,0.05)]"
        >
          {filtered.map((site, i) => {
            const isActive = i === active;
            const isSelected = site === value;
            return (
              <li
                key={site}
                id={`${listId}-opt-${i}`}
                role="option"
                aria-selected={isSelected}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(site);
                }}
                onMouseEnter={() => setActive(i)}
                className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 font-mono text-[13px] ${
                  isActive
                    ? "bg-orange-500/10 text-slate-900 dark:bg-orange-400/10 dark:text-slate-50"
                    : "text-slate-700 dark:text-slate-300"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`inline-block w-3 font-mono text-orange-600 dark:text-orange-400 ${
                    isSelected || isActive ? "opacity-100" : "opacity-0"
                  }`}
                >
                  ▸
                </span>
                {site}
              </li>
            );
          })}
        </ul>
      ) : null}
      {open && filtered.length === 0 ? (
        <div
          className="absolute z-10 mt-1 w-full rounded-none border border-slate-400 bg-white px-3 py-2 font-mono text-[12px] uppercase tracking-wider text-slate-500 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-400"
          role="status"
        >
          No sites match “{query}”.
        </div>
      ) : null}
    </div>
  );
}
