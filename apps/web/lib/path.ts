import { z } from "zod";

// ---------- Input schema ----------

// `from` is a single string of the form `<kind>:<value>` where kind is one of
// "device" or "service". The value after the colon is trimmed and must be
// non-empty and <= 200 characters (same ceiling as the search query to keep
// URL + DB bounds consistent). We split on the FIRST colon so device/service
// names that themselves contain colons survive untouched.
const FROM_RE = /^(device|service):([\s\S]+)$/;

export const PathQuery = z
  .object({ from: z.string() })
  .transform((o, ctx) => {
    const m = FROM_RE.exec(o.from);
    if (!m) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "from must be 'device:<name>' or 'service:<cid>'",
      });
      return z.NEVER;
    }
    const kind = m[1] as "device" | "service";
    const value = m[2]!.trim();
    if (value.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "value must not be empty",
      });
      return z.NEVER;
    }
    if (value.length > 200) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "value exceeds 200 chars",
      });
      return z.NEVER;
    }
    return { kind, value };
  });
export type PathQuery = z.infer<typeof PathQuery>;

export function parsePathQuery(input: unknown): PathQuery {
  return PathQuery.parse(input);
}

// ---------- Response schema ----------

export const Hop = z.object({
  name: z.string(),
  role: z.string(),
  level: z.number(),
  site: z.string().nullable(),
  domain: z.string().nullable(),
  in_if: z.string().nullable(),
  out_if: z.string().nullable(),
});
export type Hop = z.infer<typeof Hop>;

const DeviceRef = z.object({
  name: z.string(),
  role: z.string(),
  level: z.number(),
});
export type DeviceRef = z.infer<typeof DeviceRef>;

const NoPathReason = z.enum([
  "island",
  "service_has_no_endpoint",
  "start_not_found",
]);

export const PathResponse = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    length: z.number(),
    hops: z.array(Hop),
  }),
  z.object({
    status: z.literal("no_path"),
    reason: NoPathReason,
    unreached_at: DeviceRef.nullable(),
  }),
]);
export type PathResponse = z.infer<typeof PathResponse>;
