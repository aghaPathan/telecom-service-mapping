"use client";

import { useMemo, useState } from "react";
import type { DeviceRef } from "@/lib/path";
import { filterDevices } from "@/lib/downstream-filter";

export function DownstreamListFilter({ devices }: { devices: DeviceRef[] }) {
  const [role, setRole] = useState("");
  const [domain, setDomain] = useState("");

  const filtered = useMemo(
    () => filterDevices(devices, { role, domain }),
    [devices, role, domain],
  );

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2 text-sm">
        <input
          type="text"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder="Filter by role"
          data-testid="downstream-filter-role"
          className="rounded border border-slate-300 px-2 py-1"
        />
        <input
          type="text"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="Filter by domain"
          data-testid="downstream-filter-domain"
          className="rounded border border-slate-300 px-2 py-1"
        />
        <span className="self-center text-xs text-slate-500">
          {filtered.length} of {devices.length}
        </span>
      </div>
      <div className="overflow-hidden rounded-md border border-slate-200 bg-white ring-1 ring-slate-100">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-xs font-medium uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">Name</th>
              <th className="px-3 py-2 text-left">Role</th>
              <th className="px-3 py-2 text-left">Site</th>
              <th className="px-3 py-2 text-left">Domain</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map((d) => (
              <tr
                key={d.name}
                data-testid={
                  d.level === 3.5 ? "downstream-mw-row" : undefined
                }
              >
                <td className="px-3 py-1.5 font-medium text-slate-900">
                  {d.name}
                </td>
                <td className="px-3 py-1.5 text-slate-700">{d.role}</td>
                <td className="px-3 py-1.5 text-slate-700">
                  {d.site ?? "—"}
                </td>
                <td className="px-3 py-1.5 text-slate-700">
                  {d.domain ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
