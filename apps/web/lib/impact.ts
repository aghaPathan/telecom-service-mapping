import { z } from "zod";
import { getDriver } from "@/lib/neo4j";
import { MAX_DOWNSTREAM_DEPTH } from "@/lib/downstream";

export const HARD_CAP = 10_000;

export const ImpactQuery = z.object({
  device: z.string().trim().min(1).max(200),
  max_depth: z.coerce.number().int().min(1).max(MAX_DOWNSTREAM_DEPTH).default(10),
  include_transport: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .transform((v) => v === true || v === "true")
    .default(false),
});
export type ImpactQuery = z.infer<typeof ImpactQuery>;

export function parseImpactQuery(input: unknown): ImpactQuery {
  return ImpactQuery.parse(input);
}

export const ImpactRow = z.object({
  name: z.string(),
  role: z.string(),
  level: z.number(),
  site: z.string().nullable(),
  vendor: z.string().nullable(),
  hops: z.number().int(),
});
export type ImpactRow = z.infer<typeof ImpactRow>;

export const RoleSummary = z.object({
  role: z.string(),
  level: z.number(),
  count: z.number().int(),
});
export type RoleSummary = z.infer<typeof RoleSummary>;

export const ImpactResponse = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    start: z.object({ name: z.string(), role: z.string(), level: z.number() }),
    total: z.number().int(),
    summary: z.array(RoleSummary),
    rows: z.array(ImpactRow),
  }),
  z.object({
    status: z.literal("too_large"),
    start: z.object({ name: z.string(), role: z.string(), level: z.number() }),
    total: z.number().int(),
    summary: z.array(RoleSummary),
  }),
  z.object({ status: z.literal("start_not_found") }),
]);
export type ImpactResponse = z.infer<typeof ImpactResponse>;

// runImpact stub — body lands in Task 2 driven by the integration test.
export async function runImpact(_q: ImpactQuery): Promise<ImpactResponse> {
  throw new Error("runImpact: not implemented");
}
