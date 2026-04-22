/**
 * Derive a site code from a device name.
 *
 * Convention (see CLAUDE.md redaction example: `PK-KHI-CORE-01` → site `PK-KHI`):
 * the site is the first two hyphen-separated tokens. Devices whose name does
 * not have at least two tokens before the role segment cannot be located
 * deterministically from the name alone — we return null and the caller omits
 * the `:LOCATED_AT` edge.
 *
 * Pure — unit-testable with no IO.
 */
export function deriveSiteFromDeviceName(name: string): string | null {
  if (!name) return null;
  const parts = name.split("-");
  if (parts.length < 3) return null;
  const [country, city] = parts;
  if (!country || !city) return null;
  return `${country}-${city}`;
}
