/**
 * Hostname parser shared by ingestor + web.
 *
 * Telecom hostnames encode site, role, vendor, and a per-vendor serial number
 * as hyphen-delimited tokens, e.g. `JED-ICSG-NO01`:
 *   token[0] = site code       → "JED"
 *   token[1] = role code       → "ICSG" → maps via role_map → "CSG"
 *   token[2] = vendor + serial → "NO01" → vendor "NO" → "Nokia", serial "01"
 *
 * The indices, separator, and lookup maps all come from `config/role_codes.yaml`
 * so they stay configurable without a redeploy. The parser itself is pure and
 * never throws — unresolvable fields return `null`.
 */

export type HostnameParseConfig = {
  /** Token index carrying the site code (usually 0). */
  site_token_index: number;
  /** Token index carrying the role code (usually 1 — same as resolver `name_token.index`). */
  role_token_index: number;
  /** Token index carrying the vendor + serial (usually 2). */
  vendor_token_index: number;
  /** Delimiter used to split the hostname. */
  separator: string;
  /** Raw role-code → canonical role-name map (same shape as resolver `name_token.map`). */
  role_map: Record<string, string>;
  /** Leading vendor-prefix → canonical vendor name. */
  vendor_token_map: Record<string, string>;
};

export type ParsedHostname = {
  site: string | null;
  role: string | null;
  vendor: string | null;
  serial: string | null;
};

/**
 * Default indices + empty maps. Callers normally hydrate from
 * `config/role_codes.yaml`. Useful as a base in tests + for workspaces that
 * have not yet supplied the full config.
 */
export const DEFAULT_HOSTNAME_CONFIG: HostnameParseConfig = {
  site_token_index: 0,
  role_token_index: 1,
  vendor_token_index: 2,
  separator: "-",
  role_map: {},
  vendor_token_map: {},
};

/**
 * Split a vendor+serial token like `NO01` into its alpha prefix and numeric
 * suffix. Returns `null` components when the pattern does not match.
 */
function splitVendorSerial(
  token: string,
): { vendor_prefix: string | null; serial: string | null } {
  const m = /^([A-Za-z]+)(\d+)$/.exec(token);
  if (!m) {
    // Pure-alpha token — treat as vendor only, no serial. Pure-digit —
    // treat as serial only, no vendor. Neither — both null.
    if (/^[A-Za-z]+$/.test(token)) return { vendor_prefix: token, serial: null };
    if (/^\d+$/.test(token)) return { vendor_prefix: null, serial: token };
    return { vendor_prefix: null, serial: null };
  }
  return { vendor_prefix: m[1]!, serial: m[2]! };
}

/**
 * Parse a device hostname into its structural components. Pure — never
 * throws, returns `null` per field when the input does not carry that
 * component. Always returns a `site` when the name is non-empty (the whole
 * name falls through when there is no separator, matching the acceptance
 * criterion for `"malformed"` → `{ site: "malformed", ... }`).
 */
export function parseHostname(
  name: string,
  cfg: HostnameParseConfig = DEFAULT_HOSTNAME_CONFIG,
): ParsedHostname {
  if (!name) {
    return { site: null, role: null, vendor: null, serial: null };
  }
  const tokens = name.split(cfg.separator);
  const siteToken = tokens[cfg.site_token_index];
  const roleToken = tokens[cfg.role_token_index];
  const vendorToken = tokens[cfg.vendor_token_index];

  const site = siteToken && siteToken.length > 0 ? siteToken : null;

  let role: string | null = null;
  if (roleToken && roleToken.length > 0) {
    role = cfg.role_map[roleToken] ?? null;
  }

  let vendor: string | null = null;
  let serial: string | null = null;
  if (vendorToken && vendorToken.length > 0) {
    const { vendor_prefix, serial: ser } = splitVendorSerial(vendorToken);
    if (vendor_prefix) {
      vendor = cfg.vendor_token_map[vendor_prefix] ?? null;
    }
    serial = ser;
  }

  return { site, role, vendor, serial };
}
