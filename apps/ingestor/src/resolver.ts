/**
 * Role + hierarchy resolver.
 *
 * Loads `config/hierarchy.yaml` and `config/role_codes.yaml` fresh at ingest
 * start, zod-validates them (fail-fast on malformed), and exposes a pure
 * `resolveRole(device, cfg)` that returns `{ role, level }`.
 *
 * Resolution order (per role_codes.yaml `resolver_priority`):
 *   type_column → name_prefix (longest match) → fallback (Unknown).
 *
 * The SW-dynamic-leveling post-pass is NOT implemented here — it's a Cypher
 * pass run after the graph is written. See graph/writer.ts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { HostnameParseConfig } from "@tsm/db";

const HierarchySchema = z.object({
  levels: z
    .array(
      z.object({
        level: z.number(),
        label: z.string().min(1),
        roles: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
  unknown_label: z.string().min(1).default("Unknown"),
  unknown_level: z.number().default(99),
  sw_dynamic_leveling: z
    .object({ enabled: z.boolean().default(true) })
    .default({ enabled: true }),
  /**
   * Multi-label classification map keyed by RAW role code (from type_map or
   * name_token.map). A device whose resolved code appears here gets the listed
   * technology tags attached. Using the raw code (e.g. "RGUF") rather than the
   * resolved role ("RAN") lets a single raw code contribute to multiple tags
   * even when two raw codes share a resolved role.
   *
   * Example: `RGUF: [3G, 4G]` — a RGUF device counts against both 3G and 4G
   * even though it resolves to the same "RAN" role as R4GN.
   */
  tag_map: z
    .record(z.string(), z.array(z.string().min(1)).min(1))
    .optional()
    .default({}),
});

const NameTokenSchema = z.object({
  index: z.number().int().nonnegative(),
  separator: z.string().min(1),
  map: z.record(z.string(), z.string().min(1)).default({}),
});

const RoleCodesSchema = z.object({
  type_map: z.record(z.string(), z.string().min(1)),
  name_prefix_map: z.record(z.string(), z.string().min(1)).default({}),
  name_token: NameTokenSchema.optional(),
  /**
   * Vendor-prefix → canonical vendor name (consumed by `parseHostname`). The
   * third hyphen-token is typically `<VENDOR><SERIAL>` (e.g. `NO01` → Nokia).
   * Empty by default so callers that haven't seeded this in role_codes.yaml
   * keep loading cleanly — ingest just skips hostname-derived vendor.
   */
  vendor_token_map: z.record(z.string(), z.string().min(1)).default({}),
  fallback: z.string().min(1).default("Unknown"),
  resolver_priority: z
    .array(z.enum(["type_column", "name_prefix", "name_token", "fallback"]))
    .default(["type_column", "name_token", "fallback"]),
  /**
   * Vendor alias map (V1 parity): raw vendor string → canonical display name.
   * Applied during dedup so the stored vendor is already normalized.
   * Lookup is case-insensitive (raw.toLowerCase() matched against keys).
   */
  vendor_aliases: z.record(z.string(), z.string()).optional().default({}),
});

const RanCodesSchema = z.object({ codes: z.record(z.string(), z.string()) });

/**
 * Load `<configDir>/ran_service_codes.yaml`. Returns empty object when the
 * file is absent — the dictionary is optional enrichment, not a hard
 * dependency. Throws only on malformed YAML or schema violations.
 */
export function loadRanServiceCodes(configDir: string): Record<string, string> {
  const p = path.join(configDir, "ran_service_codes.yaml");
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    // File absent — not required.
    return {};
  }
  const raw = parseYaml(text);
  const result = RanCodesSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `config/ran_service_codes.yaml invalid: ${summarize(result.error.issues)}`,
    );
  }
  return result.data.codes;
}

export type HierarchyConfig = z.infer<typeof HierarchySchema>;
export type RoleCodesConfig = z.infer<typeof RoleCodesSchema>;

export type ResolverConfig = {
  hierarchy: HierarchyConfig;
  roles: RoleCodesConfig;
  /** role → level, built once from hierarchy.levels for O(1) lookup. */
  roleToLevel: Map<string, number>;
  /** role → label, same. */
  roleToLabel: Map<string, string>;
  /** Prefix entries sorted by descending prefix length (longest-match wins). */
  prefixes: { prefix: string; role: string }[];
  /**
   * Structural hostname-parse config used by `parseHostname` (S14) during
   * device enrichment. Token indices follow the `JED-ICSG-NO01` convention:
   * site at token 0, role at the same index as `name_token.index` (or 1 by
   * default), vendor+serial at the next index.
   */
  hostname: HostnameParseConfig;
  /**
   * Vendor alias map from role_codes.yaml `vendor_aliases`. Exposed here so
   * callers (e.g. `runIngest`) can pass it straight to `dedupLldpRows`.
   */
  vendor_aliases: Record<string, string>;
  /**
   * Technology tag map from hierarchy.yaml `tag_map`. Raw role code → tags[].
   * Exposed on config for O(1) lookup during `resolveRole`.
   */
  tag_map: Record<string, string[]>;
  /**
   * RAN tech-type code → human-readable description, loaded from
   * `config/ran_service_codes.yaml`. Empty object when the file is absent
   * (optional enrichment — no hard dependency).
   */
  ran_service_codes: Record<string, string>;
};

export type DeviceRoleInput = {
  name: string;
  /** Raw `type_a`/`type_b` code from the source row, canonicalized to one value. */
  type_code: string | null;
};

export type ResolvedRole = {
  role: string;
  level: number;
  /**
   * When non-null, the name-token lookup was attempted and failed to match —
   * the returned token is the raw string taken from `input.name`. Useful for
   * post-run diagnostics (top-N unresolved tokens). Null when name_token did
   * not run (earlier step resolved, or step disabled).
   */
  unresolved_name_token?: string | null;
  /**
   * Technology tags derived from `hierarchy.yaml` `tag_map`. Keyed by the raw
   * role code that resolved this device (e.g. "RGUF"), so a single raw code
   * can contribute to multiple tags even if two codes share a resolved role.
   * Empty array when the resolved code has no tag_map entry.
   */
  tags: string[];
  /**
   * Human-readable description from `config/ran_service_codes.yaml` for RAN
   * tech-type codes (e.g. "RGUF" → "2G, 3G and FDD sharing the same BB").
   * Null when the raw code has no entry in the dictionary or when resolution
   * did not go through a raw code (name_prefix branch, BusinessCustomer, etc.).
   */
  service_description?: string | null;
};

export function buildResolverConfig(
  hierarchy: HierarchyConfig,
  roles: RoleCodesConfig,
  ranServiceCodes: Record<string, string> = {},
): ResolverConfig {
  const roleToLevel = new Map<string, number>();
  const roleToLabel = new Map<string, string>();
  for (const entry of hierarchy.levels) {
    for (const role of entry.roles) {
      if (roleToLevel.has(role)) {
        throw new Error(
          `hierarchy.yaml: role "${role}" appears in multiple levels`,
        );
      }
      roleToLevel.set(role, entry.level);
      roleToLabel.set(role, entry.label);
    }
  }
  const prefixes = Object.entries(roles.name_prefix_map)
    .map(([prefix, role]) => ({ prefix, role }))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  const roleTokenIndex = roles.name_token?.index ?? 1;
  const separator = roles.name_token?.separator ?? "-";
  const hostname: HostnameParseConfig = {
    site_token_index: 0,
    role_token_index: roleTokenIndex,
    vendor_token_index: roleTokenIndex + 1,
    separator,
    role_map: roles.name_token?.map ?? {},
    vendor_token_map: roles.vendor_token_map,
  };
  return {
    hierarchy,
    roles,
    roleToLevel,
    roleToLabel,
    prefixes,
    hostname,
    vendor_aliases: roles.vendor_aliases,
    tag_map: hierarchy.tag_map ?? {},
    ran_service_codes: ranServiceCodes,
  };
}

/**
 * Pure resolver: input → { role, level }. Never throws on data; falls back
 * to the configured Unknown bucket when nothing matches.
 *
 * Priority (earliest wins):
 *   0. 8-digit numeric name  → BusinessCustomer (V2 PRD rule 9)
 *   1. type_column / name_prefix / name_token (per resolver_priority config)
 *   2. fallback → Unknown
 */
export function resolveRole(
  input: DeviceRoleInput,
  cfg: ResolverConfig,
): ResolvedRole {
  // Early check (step 0): pure-numeric names of 8+ digits are business-customer
  // jumper nodes. We short-circuit before the normal priority cascade so these
  // never accidentally resolve to a real role via a type_code coincidence.
  // Level is `unknown_level` (default 99) to avoid silent collisions with any
  // configured hierarchy level (1–5). Role name "BusinessCustomer" distinguishes
  // these devices from genuine "Unknown" nodes in downstream Cypher queries.
  if (/^\d{8,}$/.test(input.name)) {
    return {
      role: "BusinessCustomer",
      level: cfg.hierarchy.unknown_level,
      tags: ["business-customer"],
      unresolved_name_token: null,
    };
  }

  let unresolvedToken: string | null = null;
  for (const step of cfg.roles.resolver_priority) {
    if (step === "type_column") {
      const code = input.type_code?.trim();
      if (code) {
        const mapped = cfg.roles.type_map[code];
        if (mapped) return finalize(mapped, code, cfg);
      }
    } else if (step === "name_prefix") {
      for (const { prefix, role } of cfg.prefixes) {
        // name_prefix doesn't have a raw code concept — no tag_map lookup.
        if (input.name.startsWith(prefix)) return finalize(role, null, cfg);
      }
    } else if (step === "name_token") {
      const nt = cfg.roles.name_token;
      if (nt) {
        const token = input.name.split(nt.separator)[nt.index];
        if (token !== undefined && token.length > 0) {
          const mapped = nt.map[token];
          // tag_map lookup uses the name token as the raw code key.
          if (mapped) return finalize(mapped, token, cfg);
          unresolvedToken = token;
        }
      }
    } else if (step === "fallback") {
      return unknown(cfg, unresolvedToken);
    }
  }
  // Priority list didn't include "fallback" — still guarantee a result.
  return unknown(cfg, unresolvedToken);
}

function unknown(
  cfg: ResolverConfig,
  unresolvedToken: string | null,
): ResolvedRole {
  const result: ResolvedRole = {
    role: cfg.hierarchy.unknown_label,
    level: cfg.hierarchy.unknown_level,
    tags: [],
  };
  if (unresolvedToken !== null) result.unresolved_name_token = unresolvedToken;
  return result;
}

function finalize(
  role: string,
  /**
   * Raw code that resolved to this role: the type_map key (e.g. "RGUF") or the
   * name_token string. Used for `tag_map` lookup. Null for name_prefix matches
   * where there's no single raw code concept.
   */
  rawCode: string | null,
  cfg: ResolverConfig,
): ResolvedRole {
  const level = cfg.roleToLevel.get(role);
  if (level === undefined) {
    // Role referenced by role_codes.yaml but not defined in hierarchy.yaml.
    // Treat as Unknown rather than throw mid-ingest — surfaces as an
    // "unresolvable role" bucket in the graph instead of killing the run.
    return {
      role: cfg.hierarchy.unknown_label,
      level: cfg.hierarchy.unknown_level,
      tags: [],
    };
  }
  const tags = (rawCode !== null ? cfg.tag_map[rawCode] : undefined) ?? [];
  const service_description =
    rawCode !== null ? (cfg.ran_service_codes[rawCode] ?? null) : null;
  const result: ResolvedRole = { role, level, tags };
  if (service_description !== null) result.service_description = service_description;
  return result;
}

/**
 * Summarises unresolved name-token buckets for post-run data-quality reporting.
 *
 * Accepts a slice of `ResolvedRole` results, buckets by `unresolved_name_token`
 * (null/empty entries are ignored — those are resolved devices), and returns
 * the top-N sorted descending by count then ascending by token (alpha tie-break).
 *
 * Emitted into `warnings_json` by `runIngest` when at least one unresolved
 * token exists, under `{ kind: "unresolved_role_tokens", topN, entries }`.
 */
export function summarizeUnresolved(
  resolveds: ResolvedRole[],
  topN = 20,
): Array<{ token: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of resolveds) {
    const t = r.unresolved_name_token;
    if (t == null || t === "") continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([token, count]) => ({ token, count }));
}

/**
 * Read + validate both YAML files. Throws a single clear error listing all
 * schema violations — fail-fast before any DB work.
 *
 * `baseDir` should point at the repo root's `config/` directory. Callers
 * normally pass `loadResolverConfigFromRepo(repoRoot)`.
 */
export function loadResolverConfigFromDir(configDir: string): ResolverConfig {
  const hierarchyPath = path.join(configDir, "hierarchy.yaml");
  const rolePath = path.join(configDir, "role_codes.yaml");
  const hierarchyRaw = readAndParse(hierarchyPath);
  const roleRaw = readAndParse(rolePath);

  const hierarchy = HierarchySchema.safeParse(hierarchyRaw);
  if (!hierarchy.success) {
    throw new Error(
      `config/hierarchy.yaml invalid: ${summarize(hierarchy.error.issues)}`,
    );
  }
  const roles = RoleCodesSchema.safeParse(roleRaw);
  if (!roles.success) {
    throw new Error(
      `config/role_codes.yaml invalid: ${summarize(roles.error.issues)}`,
    );
  }
  const ranServiceCodes = loadRanServiceCodes(configDir);
  return buildResolverConfig(hierarchy.data, roles.data, ranServiceCodes);
}

function readAndParse(p: string): unknown {
  const text = readFileSync(p, "utf8");
  return parseYaml(text);
}

function summarize(
  issues: { path: (string | number)[]; message: string }[],
): string {
  return issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}
