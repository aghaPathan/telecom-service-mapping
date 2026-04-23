"use client";

import { useState } from "react";
import { DeviceCard } from "@/components/DeviceCard";
import { LevelBadge, type LevelValue } from "@/components/LevelBadge";
import { SiteSelector } from "@/components/SiteSelector";
import { PathRibbon, type PathRibbonHop } from "@/components/PathRibbon";

const LEVELS: LevelValue[] = [1, 2, 3, 3.5, 4, 5, null];

const MOCK_SITES = [
  "PK-KHI-CORE-01",
  "PK-KHI-CORE-02",
  "PK-KHI-AGG-01",
  "PK-KHI-AGG-02",
  "PK-ISB-CORE-01",
  "PK-ISB-AGG-01",
  "PK-LHE-CORE-01",
  "PK-LHE-AGG-01",
  "PK-KHI-RAN-01",
  "PK-KHI-RAN-02",
];

const MOCK_DEVICES: Array<{
  hostname: string;
  role: string;
  level: LevelValue;
  site: string;
  vendor: string;
}> = [
  { hostname: "PK-KHI-CORE-01", role: "CORE", level: 1, site: "PK-KHI-CORE-01", vendor: "Cisco" },
  { hostname: "PK-KHI-UPE-02", role: "UPE", level: 2, site: "PK-KHI-AGG-01", vendor: "Huawei" },
  { hostname: "PK-ISB-CSG-07", role: "CSG", level: 3, site: "PK-ISB-AGG-01", vendor: "Nokia" },
  { hostname: "PK-LHE-MW-11", role: "MW", level: 3.5, site: "PK-LHE-AGG-01", vendor: "Ceragon" },
  { hostname: "PK-KHI-RAN-33", role: "RAN", level: 4, site: "PK-KHI-RAN-01", vendor: "Ericsson" },
  { hostname: "PK-KHI-CUST-88", role: "Customer", level: 5, site: "PK-KHI-RAN-01", vendor: "—" },
];

const MOCK_PATH: PathRibbonHop[] = [
  { hostname: "PK-KHI-CUST-88", role: "Customer", level: 5, site: "PK-KHI-RAN-01" },
  { hostname: "PK-KHI-RAN-33", role: "RAN", level: 4, site: "PK-KHI-RAN-01" },
  { hostname: "PK-KHI-MW-11", role: "MW", level: 3.5, site: "PK-KHI-AGG-02" },
  { hostname: "PK-KHI-CSG-07", role: "CSG", level: 3, site: "PK-KHI-AGG-01" },
  { hostname: "PK-KHI-UPE-02", role: "UPE", level: 2, site: "PK-KHI-AGG-01" },
  { hostname: "PK-KHI-CORE-01", role: "CORE", level: 1, site: "PK-KHI-CORE-01" },
];

function SectionHeader({ index, title, subtitle }: { index: string; title: string; subtitle?: string }) {
  return (
    <header className="mb-4 flex items-baseline justify-between border-b border-slate-900/15 pb-2 dark:border-slate-50/15">
      <div className="flex items-baseline gap-4">
        <span className="font-mono text-[11px] tabular-nums text-orange-600 dark:text-orange-400">
          [ {index} ]
        </span>
        <h2 className="font-display text-2xl italic leading-none text-slate-900 dark:text-slate-50">
          {title}
        </h2>
        {subtitle ? (
          <span className="hidden font-mono text-[10px] uppercase tracking-widest text-slate-500 sm:inline dark:text-slate-400">
            — {subtitle}
          </span>
        ) : null}
      </div>
      <span
        aria-hidden="true"
        className="ml-6 hidden h-px flex-1 translate-y-1 bg-gradient-to-r from-slate-300 to-transparent sm:block dark:from-slate-700"
      />
    </header>
  );
}

function MetaRow() {
  return (
    <div className="mb-10 flex flex-wrap items-center gap-x-6 gap-y-2 border-y border-slate-900/15 py-2 font-mono text-[10px] uppercase tracking-widest text-slate-600 dark:border-slate-50/15 dark:text-slate-400">
      <span>
        <span className="text-slate-400 dark:text-slate-600">ns /</span>{" "}
        <span className="text-slate-900 dark:text-slate-50">tsm.web</span>
      </span>
      <span>
        <span className="text-slate-400 dark:text-slate-600">phase /</span>{" "}
        <span className="text-slate-900 dark:text-slate-50">03 · primitives</span>
      </span>
      <span>
        <span className="text-slate-400 dark:text-slate-600">issue /</span>{" "}
        <span className="text-slate-900 dark:text-slate-50">#37 · S19</span>
      </span>
      <span>
        <span className="text-slate-400 dark:text-slate-600">render /</span>{" "}
        <span className="text-slate-900 dark:text-slate-50">mock only</span>
      </span>
      <span className="ml-auto inline-flex items-center gap-1.5">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
        <span className="text-slate-900 dark:text-slate-50">live</span>
      </span>
    </div>
  );
}

export default function DesignPreviewPage() {
  const [site, setSite] = useState<string | null>(null);

  return (
    <div className="relative min-h-screen bg-paper bg-grid-faint text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <main className="relative mx-auto max-w-6xl px-6 py-12 lg:py-16">
        <section className="mb-10 grid grid-cols-12 gap-4 border-b border-slate-900/15 pb-10 dark:border-slate-50/15">
          <div className="col-span-12 md:col-span-8">
            <div className="mb-4 font-mono text-[10px] uppercase tracking-widest text-slate-500 dark:text-slate-400">
              Telecom Service Mapping · Design System · v0.1
            </div>
            <h1 className="font-display text-5xl leading-[0.95] text-slate-900 dark:text-slate-50 md:text-7xl">
              <span className="italic">Primitives</span>
              <span className="text-orange-600 dark:text-orange-400">.</span>
              <br />
              <span className="font-mono text-[0.45em] font-normal uppercase not-italic tracking-[0.2em] text-slate-500 dark:text-slate-400">
                a reference surface for Phase 3
              </span>
            </h1>
          </div>
          <aside className="col-span-12 mt-6 border-l-2 border-orange-500 pl-4 font-mono text-[11px] leading-relaxed text-slate-600 dark:border-orange-400 dark:text-slate-400 md:col-span-4 md:mt-16">
            Four shared components consumed by the path-trace, impact-analysis,
            device and site pages. Every tile below is rendered from static mock
            data — no resolver, no database, no network. Legible in either
            theme.
          </aside>
        </section>

        <MetaRow />

        <section className="mb-14">
          <SectionHeader index="01" title="LevelBadge" subtitle="Hierarchy · 7 tiers" />
          <div className="flex flex-wrap items-center gap-2">
            {LEVELS.map((lvl, i) => (
              <LevelBadge key={i} level={lvl} showNumber />
            ))}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-[11px] text-slate-500 dark:text-slate-400 sm:grid-cols-4">
            <span>1 · Core</span>
            <span>2 · Aggregation</span>
            <span>3 · CustomerAgg</span>
            <span>3.5 · Transport</span>
            <span>4 · Access</span>
            <span>5 · Customer</span>
            <span>— · Unknown</span>
          </div>
        </section>

        <section className="mb-14">
          <SectionHeader index="02" title="DeviceCard" subtitle="Per-device tile" />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {MOCK_DEVICES.map((d, i) => (
              <DeviceCard key={d.hostname} index={i + 1} {...d} />
            ))}
          </div>
        </section>

        <section className="mb-14">
          <SectionHeader index="03" title="SiteSelector" subtitle="Combobox · filter / clear / keyboard" />
          <div className="grid grid-cols-12 gap-6">
            <div className="col-span-12 sm:col-span-6 md:col-span-5">
              <SiteSelector
                sites={MOCK_SITES}
                value={site}
                onChange={setSite}
                label="Origin site"
              />
            </div>
            <div className="col-span-12 flex flex-col justify-end sm:col-span-6 md:col-span-7">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-l border-slate-900/15 pl-4 font-mono text-[11px] dark:border-slate-50/15">
                <dt className="uppercase tracking-widest text-slate-500 dark:text-slate-400">
                  selected
                </dt>
                <dd className="text-slate-900 dark:text-slate-50">{site ?? "—"}</dd>
                <dt className="uppercase tracking-widest text-slate-500 dark:text-slate-400">
                  corpus
                </dt>
                <dd className="text-slate-900 dark:text-slate-50">{MOCK_SITES.length} sites</dd>
                <dt className="uppercase tracking-widest text-slate-500 dark:text-slate-400">keys</dt>
                <dd className="text-slate-900 dark:text-slate-50">↑ ↓ Home End Enter Esc</dd>
              </dl>
            </div>
          </div>
        </section>

        <section className="mb-14">
          <SectionHeader index="04" title="PathRibbon" subtitle="Customer → Core · 6 hops" />
          <PathRibbon hops={MOCK_PATH} highlightIndex={0} />
        </section>

        <section className="mb-20">
          <SectionHeader index="05" title="Empty state" subtitle="PathRibbon · no hops" />
          <PathRibbon hops={[]} />
        </section>

        <footer className="mt-16 flex items-center justify-between border-t border-slate-900/15 pt-4 font-mono text-[10px] uppercase tracking-widest text-slate-500 dark:border-slate-50/15 dark:text-slate-400">
          <span>end of surface</span>
          <span>tsm · design · 2026</span>
        </footer>
      </main>
    </div>
  );
}
