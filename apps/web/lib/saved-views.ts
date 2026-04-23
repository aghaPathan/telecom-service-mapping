import { z } from "zod";
import { PathQuery } from "@/lib/path";
import { DownstreamQuery } from "@/lib/downstream";

export const Visibility = z.enum([
  "private",
  "role:viewer",
  "role:operator",
  "role:admin",
]);
export type Visibility = z.infer<typeof Visibility>;

// The persisted payload is a discriminated union on `kind`. The inner `query`
// reuses the canonical schemas from `lib/path.ts` and `lib/downstream.ts` so
// saved views stay in lockstep with the live endpoints they replay against.
// Strict objects prevent clients from smuggling extra fields into the JSONB
// column, which would otherwise survive PATCH round-trips unnoticed.
const PathPayload = z
  .object({ kind: z.literal("path"), query: PathQuery })
  .strict();

const DownstreamPayload = z
  .object({ kind: z.literal("downstream"), query: DownstreamQuery })
  .strict();

export const ViewPayload = z.discriminatedUnion("kind", [
  PathPayload,
  DownstreamPayload,
]);
export type ViewPayload = z.infer<typeof ViewPayload>;

export const ViewKind = z.enum(["path", "downstream"]);
export type ViewKind = z.infer<typeof ViewKind>;

const Name = z.string().trim().min(1).max(120);

export const CreateBody = z.object({
  name: Name,
  payload: ViewPayload,
  visibility: Visibility.default("private"),
});
export type CreateBody = z.infer<typeof CreateBody>;

export const UpdateBody = z
  .object({
    name: Name.optional(),
    payload: ViewPayload.optional(),
    visibility: Visibility.optional(),
  })
  .strict();
export type UpdateBody = z.infer<typeof UpdateBody>;
