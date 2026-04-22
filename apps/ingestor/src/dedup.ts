/**
 * Pure dedup of `app_lldp` rows into a canonical set of devices + undirected
 * links. No IO, no side effects — purely transformational so it's trivial to
 * unit-test.
 *
 * Policy (per PRD + design doc):
 *   - Drop rows with `device_b_name === null`          → dropped.null_b
 *   - Drop self-loops (lowercase(a) === lowercase(b))  → dropped.self_loop
 *   - Canonical pair key uses lowercase min/max of names + the interface
 *     attached to each side. A symmetric "both direction" row pair collapses
 *     to a single link.
 *   - If >2 rows share the same canonical key → anomaly: keep the row with
 *     latest updated_at; emit one warning summarizing the rest.
 *   - Per device, first-seen casing wins for the `name` property; vendor /
 *     domain / ip / mac prefer the first non-null observation.
 *   - Stored link direction is canonical (lesser → greater by lowercase name).
 *     Treat as undirected downstream.
 */

export type RawLldpRow = {
  device_a_name: string | null;
  device_a_interface: string | null;
  device_a_trunk_name: string | null;
  device_a_ip: string | null;
  device_a_mac: string | null;
  device_b_name: string | null;
  device_b_interface: string | null;
  device_b_ip: string | null;
  device_b_mac: string | null;
  vendor_a: string | null;
  vendor_b: string | null;
  domain_a: string | null;
  domain_b: string | null;
  updated_at: Date;
};

export type DeviceProps = {
  name: string;
  vendor: string | null;
  domain: string | null;
  ip: string | null;
  mac: string | null;
};

export type LinkProps = {
  a: string;
  b: string;
  a_if: string | null;
  b_if: string | null;
  trunk: string | null;
  updated_at: Date;
};

export type Warning = {
  canonical_key: string;
  kept_updated_at: string;
  discarded_count: number;
};

export type DedupResult = {
  devices: DeviceProps[];
  links: LinkProps[];
  dropped: { null_b: number; self_loop: number; anomaly: number };
  warnings: Warning[];
};

type CanonicalRow = {
  key: string;
  lo: string; // preserved-casing name at canonical-min side
  hi: string; // preserved-casing name at canonical-max side
  loIf: string | null;
  hiIf: string | null;
  loIp: string | null;
  loMac: string | null;
  hiIp: string | null;
  hiMac: string | null;
  loVendor: string | null;
  loDomain: string | null;
  hiVendor: string | null;
  hiDomain: string | null;
  trunk: string | null;
  updated_at: Date;
};

function firstNonNull<T>(...vals: (T | null | undefined)[]): T | null {
  for (const v of vals) {
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

function canonicalize(row: RawLldpRow): CanonicalRow | null {
  const a = row.device_a_name;
  const b = row.device_b_name;
  if (a === null || b === null) return null;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return null;

  const aIsLo = la <= lb;
  const lo = aIsLo ? a : b;
  const hi = aIsLo ? b : a;
  const loIf = aIsLo ? row.device_a_interface : row.device_b_interface;
  const hiIf = aIsLo ? row.device_b_interface : row.device_a_interface;
  const loIp = aIsLo ? row.device_a_ip : row.device_b_ip;
  const loMac = aIsLo ? row.device_a_mac : row.device_b_mac;
  const hiIp = aIsLo ? row.device_b_ip : row.device_a_ip;
  const hiMac = aIsLo ? row.device_b_mac : row.device_a_mac;
  const loVendor = aIsLo ? row.vendor_a : row.vendor_b;
  const loDomain = aIsLo ? row.domain_a : row.domain_b;
  const hiVendor = aIsLo ? row.vendor_b : row.vendor_a;
  const hiDomain = aIsLo ? row.domain_b : row.domain_a;

  const key = `${lo.toLowerCase()}|${loIf ?? ""}‖${hi.toLowerCase()}|${hiIf ?? ""}`;

  return {
    key,
    lo,
    hi,
    loIf,
    hiIf,
    loIp,
    loMac,
    hiIp,
    hiMac,
    loVendor,
    loDomain,
    hiVendor,
    hiDomain,
    trunk: row.device_a_trunk_name,
    updated_at: row.updated_at,
  };
}

export function dedupLldpRows(rows: readonly RawLldpRow[]): DedupResult {
  const dropped = { null_b: 0, self_loop: 0, anomaly: 0 };
  const groups = new Map<string, CanonicalRow[]>();

  for (const row of rows) {
    if (row.device_b_name === null) {
      dropped.null_b += 1;
      continue;
    }
    const a = row.device_a_name;
    if (a !== null && a.toLowerCase() === row.device_b_name.toLowerCase()) {
      dropped.self_loop += 1;
      continue;
    }
    const c = canonicalize(row);
    if (c === null) {
      // device_a_name was null but device_b_name was not — treat as null_b
      // style drop since there's no observable peer. Count as null_b per
      // simplest interpretation ("row lacks the minimum two endpoints").
      dropped.null_b += 1;
      continue;
    }
    const bucket = groups.get(c.key);
    if (bucket) bucket.push(c);
    else groups.set(c.key, [c]);
  }

  const warnings: Warning[] = [];
  const links: LinkProps[] = [];
  const deviceMap = new Map<string, DeviceProps>(); // key = lowercase(name)

  const bumpDevice = (
    name: string,
    vendor: string | null,
    domain: string | null,
    ip: string | null,
    mac: string | null,
  ): void => {
    const k = name.toLowerCase();
    const prev = deviceMap.get(k);
    if (!prev) {
      deviceMap.set(k, { name, vendor, domain, ip, mac });
      return;
    }
    // First-seen casing wins; properties prefer first non-null.
    prev.vendor = firstNonNull(prev.vendor, vendor);
    prev.domain = firstNonNull(prev.domain, domain);
    prev.ip = firstNonNull(prev.ip, ip);
    prev.mac = firstNonNull(prev.mac, mac);
  };

  for (const [key, bucket] of groups) {
    let kept: CanonicalRow;
    let merged: CanonicalRow;

    if (bucket.length > 2) {
      // Anomaly — keep latest updated_at, discard the rest.
      bucket.sort((x, y) => y.updated_at.getTime() - x.updated_at.getTime());
      kept = bucket[0]!;
      dropped.anomaly += bucket.length - 1;
      warnings.push({
        canonical_key: key,
        kept_updated_at: kept.updated_at.toISOString(),
        discarded_count: bucket.length - 1,
      });
      merged = kept;
    } else if (bucket.length === 2) {
      // Symmetric pair: merge both into one, preferring non-null per field.
      const [x, y] = bucket as [CanonicalRow, CanonicalRow];
      const newer = x.updated_at >= y.updated_at ? x : y;
      merged = {
        key,
        lo: x.lo, // both rows share the same lo/hi by definition of key
        hi: x.hi,
        loIf: firstNonNull(x.loIf, y.loIf),
        hiIf: firstNonNull(x.hiIf, y.hiIf),
        loIp: firstNonNull(x.loIp, y.loIp),
        loMac: firstNonNull(x.loMac, y.loMac),
        hiIp: firstNonNull(x.hiIp, y.hiIp),
        hiMac: firstNonNull(x.hiMac, y.hiMac),
        loVendor: firstNonNull(x.loVendor, y.loVendor),
        loDomain: firstNonNull(x.loDomain, y.loDomain),
        hiVendor: firstNonNull(x.hiVendor, y.hiVendor),
        hiDomain: firstNonNull(x.hiDomain, y.hiDomain),
        trunk: firstNonNull(x.trunk, y.trunk),
        updated_at: newer.updated_at,
      };
    } else {
      merged = bucket[0]!;
    }

    bumpDevice(merged.lo, merged.loVendor, merged.loDomain, merged.loIp, merged.loMac);
    bumpDevice(merged.hi, merged.hiVendor, merged.hiDomain, merged.hiIp, merged.hiMac);

    links.push({
      a: merged.lo,
      b: merged.hi,
      a_if: merged.loIf,
      b_if: merged.hiIf,
      trunk: merged.trunk,
      updated_at: merged.updated_at,
    });
  }

  return {
    devices: [...deviceMap.values()],
    links,
    dropped,
    warnings,
  };
}
