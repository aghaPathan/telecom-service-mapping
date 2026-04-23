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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="mb-3 text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100">
        {title}
      </h2>
      <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        {children}
      </div>
    </section>
  );
}

export default function DesignPreviewPage() {
  const [site, setSite] = useState<string | null>(null);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Design Preview</h1>
      <p className="mb-8 text-sm text-slate-600 dark:text-slate-400">
        Living reference for the Phase-3 shared primitives. Uses mock props only — no resolver calls.
      </p>

      <Section title="LevelBadge (every level)">
        <div className="flex flex-wrap gap-2">
          {LEVELS.map((lvl, i) => (
            <LevelBadge key={i} level={lvl} showNumber />
          ))}
        </div>
      </Section>

      <Section title="DeviceCard (one per level)">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {MOCK_DEVICES.map((d) => (
            <DeviceCard key={d.hostname} {...d} />
          ))}
        </div>
      </Section>

      <Section title="SiteSelector">
        <div className="max-w-sm">
          <SiteSelector sites={MOCK_SITES} value={site} onChange={setSite} />
          <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
            Selected: <span className="font-mono">{site ?? "—"}</span>
          </p>
        </div>
      </Section>

      <Section title="PathRibbon (Customer → Core)">
        <PathRibbon hops={MOCK_PATH} highlightIndex={0} />
      </Section>

      <Section title="PathRibbon (empty state)">
        <PathRibbon hops={[]} />
      </Section>
    </main>
  );
}
