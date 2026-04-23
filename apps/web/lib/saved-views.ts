import { z } from "zod";
import { DownstreamQuery } from "@/lib/downstream";

export const Visibility = z.enum([
  "private",
  "role:viewer",
  "role:operator",
  "role:admin",
]);
export type Visibility = z.infer<typeof Visibility>;

// The persisted path query mirrors the *output* shape of `PathQuery` in
// `lib/path.ts` — `{kind, value}` — which is what `runPath` consumes. We
// can't reuse the PathQuery zod schema directly because its input is
// `{from: "device:<name>"}`, not the destructured form stored here.
const SavedPathQuery = z
  .object({
    kind: z.enum(["device", "service"]),
    value: z.string().trim().min(1).max(200),
  })
  .strict();

// The persisted payload is a discriminated union on `kind`. The downstream
// inner query reuses the canonical schema because its input == output; path
// uses the dedicated `SavedPathQuery` for the reason above. Strict objects
// prevent clients from smuggling extra fields into the JSONB column, which
// would otherwise survive PATCH round-trips unnoticed.
const PathPayload = z
  .object({ kind: z.literal("path"), query: SavedPathQuery })
  .strict();

const DownstreamPayload = z
  .object({ kind: z.literal("downstream"), query: DownstreamQuery.strict() })
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
