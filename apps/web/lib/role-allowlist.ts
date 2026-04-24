/**
 * Role allowlist — derived at runtime from `config/hierarchy.yaml`.
 *
 * The ingestor applies role strings from the hierarchy verbatim as `:Device`
 * secondary labels (see `config/hierarchy.yaml` + `apps/ingestor/src/resolver.ts`),
 * so the canonical list of valid role filter values is exactly the union of
 * `levels[*].roles` plus `unknown_label`.
 *
 * Cached at module scope — refreshes on server restart (matches the ingestor's
 * "read fresh at start of run" convention). Use `__resetRoleCache()` in tests
 * that need to exercise a different `RESOLVER_CONFIG_DIR`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const Schema = z.object({
  levels: z
    .array(
      z.object({
        level: z.number(),
        label: z.string(),
        roles: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
  unknown_label: z.string().min(1).default("Unknown"),
});

function resolveConfigPath(): string {
  // Mirror ingestor: RESOLVER_CONFIG_DIR overrides; fall back to repo-root config/.
  const dir = process.env.RESOLVER_CONFIG_DIR;
  if (dir) return path.join(dir, "hierarchy.yaml");
  // pnpm --filter web test runs with cwd = apps/web, so ../../config resolves
  // to the repo-root config/ directory.
  return path.resolve(process.cwd(), "..", "..", "config", "hierarchy.yaml");
}

let cache: Set<string> | null = null;

function load(): Set<string> {
  if (cache) return cache;
  const raw = readFileSync(resolveConfigPath(), "utf8");
  const parsed = Schema.parse(parseYaml(raw));
  const roles = new Set<string>();
  for (const lvl of parsed.levels) for (const r of lvl.roles) roles.add(r);
  roles.add(parsed.unknown_label);
  cache = roles;
  return cache;
}

export function getAllRoles(): string[] {
  return [...load()].sort();
}

export function isKnownRole(role: string): boolean {
  return load().has(role);
}

/** Test-only: reset cache so subsequent load re-reads the file. */
export function __resetRoleCache(): void {
  cache = null;
}
