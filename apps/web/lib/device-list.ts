import { z } from "zod";
import { isKnownRole } from "@/lib/role-allowlist";

const CANONICAL_LEVELS = [1, 2, 3, 3.5, 4, 5, 99] as const;
const SORT_COLS = ["name", "role", "level", "site", "vendor", "fanout"] as const;

const clamp = (max: number) =>
  z.coerce.number().int().min(1).transform((n) => Math.min(n, max));

const Base = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: clamp(500).default(50),
  sort: z.enum(SORT_COLS).default("name"),
  dir: z.enum(["asc", "desc"]).default("asc"),
});

const ByRole = Base.extend({
  mode: z.literal("byRole"),
  role: z.string().min(1).refine(isKnownRole, "unknown_role"),
});

const ByLevel = Base.extend({
  mode: z.literal("byLevel"),
  level: z.coerce
    .number()
    .refine(
      (n) => CANONICAL_LEVELS.includes(n as (typeof CANONICAL_LEVELS)[number]),
      "unknown_level",
    ),
});

const ByFanout = Base.extend({
  mode: z.literal("byFanout"),
  role: z.string().min(1).refine(isKnownRole, "unknown_role").optional(),
  limit: clamp(200).default(20),
});

export const DeviceListQuery = z.discriminatedUnion("mode", [
  ByRole,
  ByLevel,
  ByFanout,
]);
export type DeviceListQuery = z.infer<typeof DeviceListQuery>;

export function parseDeviceListQuery(input: unknown): DeviceListQuery {
  return DeviceListQuery.parse(input);
}

export type DeviceListRow = {
  name: string;
  role: string;
  level: number;
  site: string | null;
  vendor: string | null;
  fanout?: number;
};

export type DeviceListResult = {
  rows: DeviceListRow[];
  total: number;
  page: number;
  pageSize: number;
};
