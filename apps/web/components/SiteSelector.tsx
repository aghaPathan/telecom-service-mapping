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
  const optionRefs = useRef<Array<HTMLLIElement | null>>([]);

  // Keep input in sync when `value` prop changes externally.
  useEffect(() => {
    setQuery(value ?? "");
  }, [value]);

  const filtered = useMemo(() => filterSites(sites, query, value), [sites, query, value]);

  useEffect(() => {
    // Clamp on both sides: filter can grow OR shrink (including to 0), and
    // Math.min(filtered.length - 1, …) can produce -1 when filtered is empty.
    if (active < 0 || active >= filtered.length) setActive(0);
  }, [filtered.length, active]);

  // Keep the highlighted row visible inside the scrolling listbox. The list
  // is `max-h-60 overflow-auto`; without this the active row can scroll out
  // of view on long paths, violating WCAG 2.4.7 (focus visible).
  useEffect(() => {
    if (!open) return;
    optionRefs.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

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
      setActive((i) => Math.max(0, Math.min(filtered.length - 1, i + 1)));
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
          className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300"
        >
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
          className="w-full rounded-md border border-slate-300 bg-white py-1.5 pl-3 pr-14 font-mono text-[13px] text-slate-900 shadow-sm outline-none transition-colors focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-50 dark:focus:border-indigo-400 dark:focus:ring-indigo-400/30"
          autoComplete="off"
          spellCheck={false}
        />
        {query ? (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear site"
            className="absolute inset-y-0 right-7 flex w-7 items-center justify-center font-mono text-slate-400 transition-colors hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:hover:text-slate-200"
          >
            ×
          </button>
        ) : null}
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute inset-y-0 right-0 flex w-7 items-center justify-center text-xs text-slate-500 transition-transform dark:text-slate-400 ${
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
          className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-950"
        >
          {filtered.map((site, i) => {
            const isActive = i === active;
            const isSelected = site === value;
            return (
              <li
                key={site}
                id={`${listId}-opt-${i}`}
                ref={(el) => {
                  optionRefs.current[i] = el;
                }}
                role="option"
                aria-selected={isSelected}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(site);
                }}
                onMouseEnter={() => setActive(i)}
                className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 font-mono text-[13px] ${
                  isActive
                    ? "bg-indigo-50 text-indigo-900 dark:bg-indigo-900/40 dark:text-indigo-100"
                    : "text-slate-700 dark:text-slate-300"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`inline-block w-2 text-indigo-600 dark:text-indigo-400 ${
                    isSelected ? "opacity-100" : "opacity-0"
                  }`}
                >
                  •
                </span>
                {site}
              </li>
            );
          })}
        </ul>
      ) : null}
      {open && filtered.length === 0 ? (
        <div
          className="absolute z-10 mt-1 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-500 shadow-lg dark:border-slate-700 dark:bg-slate-950 dark:text-slate-400"
          role="status"
        >
          No sites match “{query}”.
        </div>
      ) : null}
    </div>
  );
}
