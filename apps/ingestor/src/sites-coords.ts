import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const CoordSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
  region: z.string().min(1).optional(),
});

const SitesYamlSchema = z.object({
  sites: z.record(z.string().min(1), CoordSchema).default({}),
});

export type SiteCoord = z.infer<typeof CoordSchema>;
export type SiteCoords = Map<string, SiteCoord>;

export function parseSitesYaml(source: string): SiteCoords {
  const raw = parseYaml(source);
  const parsed = SitesYamlSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid sites.yaml: ${issues}`);
  }
  return new Map(Object.entries(parsed.data.sites));
}

export function loadSitesYaml(filePath: string): SiteCoords {
  let source: string;
  try {
    source = readFileSync(filePath, "utf8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // sites.yaml is optional — deployments that don't want GIS data can
      // simply omit the file. Callers see an empty map.
      return new Map();
    }
    throw err;
  }
  return parseSitesYaml(source);
}

export function defaultSitesYamlPath(configDir: string): string {
  return path.join(configDir, "sites.yaml");
}
