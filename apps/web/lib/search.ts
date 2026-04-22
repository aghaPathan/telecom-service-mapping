import { z } from "zod";
import { getDriver } from "@/lib/neo4j";

export const SearchQuery = z.object({
  q: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(200)),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

export function parseQuery(input: unknown): SearchQuery {
  return SearchQuery.parse(input);
}

const DeviceHit = z.object({
  name: z.string(),
  role: z.string(),
  level: z.number(),
  site: z.string().nullable(),
  domain: z.string().nullable(),
});
export type DeviceHit = z.infer<typeof DeviceHit>;

const ServiceHit = z.object({
  cid: z.string(),
  mobily_cid: z.string().nullable(),
  bandwidth: z.string().nullable(),
  protection_type: z.string().nullable(),
  region: z.string().nullable(),
});
export type ServiceHit = z.infer<typeof ServiceHit>;

export const SearchResponse = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("empty") }),
  z.object({
    kind: z.literal("service"),
    service: ServiceHit,
    endpoints: z.array(DeviceHit),
  }),
  z.object({
    kind: z.literal("device"),
    devices: z.array(DeviceHit),
  }),
]);
export type SearchResponse = z.infer<typeof SearchResponse>;

// Lucene query-parser reserves these single-character tokens. Any of them
// in a raw user query must be backslash-escaped before calling
// db.index.fulltext.queryNodes; otherwise the driver throws a ParseException
// and the omnibox explodes.
const LUCENE_SINGLE = new Set([
  "+", "-", "!", "(", ")", "{", "}", "[", "]",
  "^", '"', "~", "*", "?", ":", "\\", "/",
]);

export function escapeLucene(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    // Two-char operators && and || must each have BOTH characters escaped.
    if ((ch === "&" && s[i + 1] === "&") || (ch === "|" && s[i + 1] === "|")) {
      out += "\\" + ch + "\\" + s[i + 1];
      i++;
      continue;
    }
    if (LUCENE_SINGLE.has(ch)) {
      out += "\\" + ch;
      continue;
    }
    out += ch;
  }
  return out;
}

type Nr = { toNumber: () => number };
function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof (v as Nr).toNumber === "function") return (v as Nr).toNumber();
  return Number(v);
}

function rowToDevice(row: Record<string, unknown>): DeviceHit {
  return {
    name: String(row.name),
    role: String(row.role ?? "Unknown"),
    level: toNum(row.level ?? 0),
    site: row.site == null ? null : String(row.site),
    domain: row.domain == null ? null : String(row.domain),
  };
}

function rowToService(row: Record<string, unknown>): ServiceHit {
  return {
    cid: String(row.cid),
    mobily_cid: row.mobily_cid == null ? null : String(row.mobily_cid),
    bandwidth: row.bandwidth == null ? null : String(row.bandwidth),
    protection_type: row.protection_type == null ? null : String(row.protection_type),
    region: row.region == null ? null : String(row.region),
  };
}

/** Runs the cascade resolver against Neo4j and returns the first category
 *  that matches. Cascade order: cid → mobily_cid → device.name → fulltext. */
export async function runSearch(q: string): Promise<SearchResponse> {
  const trimmed = q.trim();
  if (trimmed.length === 0) return { kind: "empty" };

  const driver = getDriver();
  const session = driver.session({ defaultAccessMode: "READ" });
  try {
    // 1. Exact Service.cid
    {
      const res = await session.run(
        `MATCH (s:Service {cid: $q})
         OPTIONAL MATCH (s)-[:TERMINATES_AT]->(d:Device)
         RETURN s {.cid, .mobily_cid, .bandwidth, .protection_type, .region} AS service,
                collect(d { .name, .role, .level, .site, .domain })           AS endpoints`,
        { q: trimmed },
      );
      const rec = res.records[0];
      if (rec && rec.get("service")) {
        const endpoints = (rec.get("endpoints") as Array<Record<string, unknown>>)
          .filter((r) => r && r.name != null)
          .map(rowToDevice);
        return {
          kind: "service",
          service: rowToService(rec.get("service")),
          endpoints,
        };
      }
    }

    // 2. Exact Service.mobily_cid
    {
      const res = await session.run(
        `MATCH (s:Service {mobily_cid: $q})
         OPTIONAL MATCH (s)-[:TERMINATES_AT]->(d:Device)
         RETURN s {.cid, .mobily_cid, .bandwidth, .protection_type, .region} AS service,
                collect(d { .name, .role, .level, .site, .domain })           AS endpoints
         LIMIT 1`,
        { q: trimmed },
      );
      const rec = res.records[0];
      if (rec && rec.get("service")) {
        const endpoints = (rec.get("endpoints") as Array<Record<string, unknown>>)
          .filter((r) => r && r.name != null)
          .map(rowToDevice);
        return {
          kind: "service",
          service: rowToService(rec.get("service")),
          endpoints,
        };
      }
    }

    // 3. Exact Device.name
    {
      const res = await session.run(
        `MATCH (d:Device {name: $q})
         RETURN d { .name, .role, .level, .site, .domain } AS device`,
        { q: trimmed },
      );
      const rec = res.records[0];
      if (rec) {
        return {
          kind: "device",
          devices: [rowToDevice(rec.get("device"))],
        };
      }
    }

    // 4. Fulltext Device.name — Lucene standard analyzer lowercases and
    //    splits on non-alphanumerics. Mirror that tokenization on the
    //    query side: split user input on the same delimiters, escape each
    //    token defensively, and add `*` per token for prefix matching.
    //    Join with AND so all tokens must match.
    {
      const tokens = trimmed
        .split(/[^A-Za-z0-9]+/)
        .filter((t) => t.length > 0)
        .map((t) => `${escapeLucene(t)}*`);
      if (tokens.length === 0) {
        return { kind: "device", devices: [] };
      }
      const lucene = tokens.join(" AND ");
      const res = await session.run(
        `CALL db.index.fulltext.queryNodes('device_name_fulltext', $lucene)
         YIELD node, score
         RETURN node { .name, .role, .level, .site, .domain } AS device
         ORDER BY score DESC
         LIMIT 20`,
        { lucene },
      );
      const devices = res.records.map((r) => rowToDevice(r.get("device")));
      return { kind: "device", devices };
    }
  } finally {
    await session.close();
  }
}
