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
});

const RoleCodesSchema = z.object({
  type_map: z.record(z.string(), z.string().min(1)),
  name_prefix_map: z.record(z.string(), z.string().min(1)).default({}),
  fallback: z.string().min(1).default("Unknown"),
  resolver_priority: z
    .array(z.enum(["type_column", "name_prefix", "fallback"]))
    .default(["type_column", "name_prefix", "fallback"]),
});

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
};

export type DeviceRoleInput = {
  name: string;
  /** Raw `type_a`/`type_b` code from the source row, canonicalized to one value. */
  type_code: string | null;
};

export type ResolvedRole = {
  role: string;
  level: number;
};

export function buildResolverConfig(
  hierarchy: HierarchyConfig,
  roles: RoleCodesConfig,
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
  return { hierarchy, roles, roleToLevel, roleToLabel, prefixes };
}

/**
 * Pure resolver: input → { role, level }. Never throws on data; falls back
 * to the configured Unknown bucket when nothing matches.
 */
export function resolveRole(
  input: DeviceRoleInput,
  cfg: ResolverConfig,
): ResolvedRole {
  for (const step of cfg.roles.resolver_priority) {
    if (step === "type_column") {
      const code = input.type_code?.trim();
      if (code) {
        const mapped = cfg.roles.type_map[code];
        if (mapped) return finalize(mapped, cfg);
      }
    } else if (step === "name_prefix") {
      for (const { prefix, role } of cfg.prefixes) {
        if (input.name.startsWith(prefix)) return finalize(role, cfg);
      }
    } else if (step === "fallback") {
      return {
        role: cfg.hierarchy.unknown_label,
        level: cfg.hierarchy.unknown_level,
      };
    }
  }
  // Priority list didn't include "fallback" — still guarantee a result.
  return {
    role: cfg.hierarchy.unknown_label,
    level: cfg.hierarchy.unknown_level,
  };
}

function finalize(role: string, cfg: ResolverConfig): ResolvedRole {
  const level = cfg.roleToLevel.get(role);
  if (level === undefined) {
    // Role referenced by role_codes.yaml but not defined in hierarchy.yaml.
    // Treat as Unknown rather than throw mid-ingest — surfaces as an
    // "unresolvable role" bucket in the graph instead of killing the run.
    return {
      role: cfg.hierarchy.unknown_label,
      level: cfg.hierarchy.unknown_level,
    };
  }
  return { role, level };
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
  return buildResolverConfig(hierarchy.data, roles.data);
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
