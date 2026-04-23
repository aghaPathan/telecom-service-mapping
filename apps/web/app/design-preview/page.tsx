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

function Section({
  title,
  caption,
  children,
}: {
  title: string;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-10">
      <header className="mb-3 flex items-baseline justify-between border-b border-slate-200 pb-2 dark:border-slate-800">
        <div className="flex items-baseline gap-3">
          <h2 className="text-base font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            {title}
          </h2>
          <span className="text-xs text-slate-500 dark:text-slate-400">{caption}</span>
        </div>
      </header>
      {children}
    </section>
  );
}

export default function DesignPreviewPage() {
  const [site, setSite] = useState<string | null>(null);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-10">
        <div className="mb-2 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Design system · Phase 3 · issue #37
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
          Primitives
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-600 dark:text-slate-400">
          Shared building blocks consumed by the path-trace, impact-analysis,
          device and site pages. Every tile below is rendered from static mock
          data — no resolver, no database, no network.
        </p>
      </header>

      <Section title="LevelBadge" caption="Hierarchy · 7 tiers">
        <div className="flex flex-wrap items-center gap-2">
          {LEVELS.map((lvl, i) => (
            <LevelBadge key={i} level={lvl} showNumber />
          ))}
        </div>
      </Section>

      <Section title="DeviceCard" caption="One tile per device">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {MOCK_DEVICES.map((d, i) => (
            <DeviceCard key={d.hostname} index={i + 1} {...d} />
          ))}
        </div>
      </Section>

      <Section title="SiteSelector" caption="Combobox · filter / clear / keyboard">
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
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-400">
              <dt className="font-medium">Selected</dt>
              <dd className="font-mono text-slate-900 dark:text-slate-50">{site ?? "—"}</dd>
              <dt className="font-medium">Corpus</dt>
              <dd className="text-slate-900 dark:text-slate-50">{MOCK_SITES.length} sites</dd>
              <dt className="font-medium">Keys</dt>
              <dd className="font-mono">↑ ↓ Home End Enter Esc</dd>
            </dl>
          </div>
        </div>
      </Section>

      <Section title="PathRibbon" caption="Customer → Core · 6 hops">
        <PathRibbon hops={MOCK_PATH} highlightIndex={0} />
      </Section>

      <Section title="Empty state" caption="PathRibbon · no hops">
        <PathRibbon hops={[]} />
      </Section>
    </main>
  );
}
