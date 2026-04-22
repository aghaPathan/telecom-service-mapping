import type { DeviceRef } from "@/lib/path";

// Pure filter used by the client-side downstream list filter.
// Case-insensitive substring match on `role` and `domain`. An empty / undefined
// filter value means "no filter on that field". Devices whose `domain` is null
// are excluded from a non-empty domain filter (null cannot match a substring).
export function filterDevices(
  devices: DeviceRef[],
  q: { role?: string; domain?: string },
): DeviceRef[] {
  const role = q.role?.trim().toLowerCase() ?? "";
  const domain = q.domain?.trim().toLowerCase() ?? "";

  if (!role && !domain) return devices.slice();

  return devices.filter((d) => {
    if (role && !d.role.toLowerCase().includes(role)) return false;
    if (domain) {
      if (d.domain == null) return false;
      if (!d.domain.toLowerCase().includes(domain)) return false;
    }
    return true;
  });
}
