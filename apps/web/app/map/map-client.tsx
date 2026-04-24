"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { MapContainer, TileLayer, CircleMarker, Popup } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import {
  filterByLayer,
  type SiteLayer,
  type SiteWithCoords,
} from "@/lib/sites";

type Props = {
  sites: SiteWithCoords[];
};

const LAYERS: readonly { value: SiteLayer; label: string }[] = [
  { value: "all", label: "All sites" },
  { value: "ran", label: "RAN-only" },
  { value: "ip", label: "IP transport" },
] as const;

function computeCenter(sites: readonly SiteWithCoords[]): [number, number] {
  if (sites.length === 0) return [24.7, 45]; // Saudi Arabia centroid fallback
  const lat = sites.reduce((acc, s) => acc + s.lat, 0) / sites.length;
  const lng = sites.reduce((acc, s) => acc + s.lng, 0) / sites.length;
  return [lat, lng];
}

export function MapClient({ sites }: Props) {
  const [layer, setLayer] = useState<SiteLayer>("all");
  const visible = useMemo(() => filterByLayer(sites, layer), [sites, layer]);
  const center = useMemo(() => computeCenter(sites), [sites]);

  return (
    <div className="flex flex-col gap-4">
      <fieldset
        className="flex gap-2"
        aria-label="Map layer filter"
        data-testid="map-layer-toggle"
      >
        {LAYERS.map((l) => (
          <label
            key={l.value}
            className={`cursor-pointer rounded-md border px-3 py-1 text-sm ${
              layer === l.value
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            <input
              type="radio"
              name="map-layer"
              value={l.value}
              className="sr-only"
              checked={layer === l.value}
              onChange={() => setLayer(l.value)}
            />
            {l.label}
            <span className="ml-1 text-xs opacity-70">
              ({filterByLayer(sites, l.value).length})
            </span>
          </label>
        ))}
      </fieldset>

      <div
        className="h-[560px] w-full overflow-hidden rounded-lg border border-slate-200"
        data-testid="map-canvas"
      >
        <MapContainer
          center={center}
          zoom={5}
          scrollWheelZoom
          className="h-full w-full"
        >
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          />
          {visible.map((s) => (
            <CircleMarker
              key={s.name}
              center={[s.lat, s.lng]}
              radius={Math.min(6 + Math.log2(s.total + 1) * 2, 18)}
              pathOptions={{
                color: s.ran_count > s.ip_count ? "#0d9488" : "#1d4ed8",
                fillOpacity: 0.6,
              }}
            >
              <Popup>
                <div className="text-sm">
                  <Link
                    href={`/devices?site=${encodeURIComponent(s.name)}`}
                    className="font-semibold underline"
                  >
                    {s.name}
                  </Link>
                  {s.region ? (
                    <span className="ml-1 text-slate-500">
                      · {s.region}
                    </span>
                  ) : null}
                  <ul className="mt-1 text-xs text-slate-600">
                    <li>Total devices: {s.total}</li>
                    <li>RAN / access: {s.ran_count}</li>
                    <li>IP transport: {s.ip_count}</li>
                  </ul>
                  <div className="mt-2 flex gap-2 text-xs">
                    <Link
                      href={`/devices?site=${encodeURIComponent(s.name)}`}
                      className="text-blue-600 underline hover:text-blue-800"
                    >
                      Devices
                    </Link>
                    <a
                      href={`?site=${encodeURIComponent(s.name)}`}
                      className="text-indigo-600 underline hover:text-indigo-800"
                    >
                      Show topology
                    </a>
                  </div>
                </div>
              </Popup>
            </CircleMarker>
          ))}
        </MapContainer>
      </div>
    </div>
  );
}
