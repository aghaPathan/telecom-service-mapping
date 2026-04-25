/**
 * Shared trigger types for `ingestion_triggers.flavor`.
 *
 * The Postgres column has a CHECK constraint pinning these values
 * (see migrations/1700000000050_ingestion-triggers-flavor.sql). Both the
 * web admin endpoint and the ingestor cron worker import this module so
 * the literal set has a single source of truth.
 */
export const TRIGGER_FLAVORS = ["full", "isis_cost"] as const;
export type TriggerFlavor = (typeof TRIGGER_FLAVORS)[number];

export function isTriggerFlavor(raw: unknown): raw is TriggerFlavor {
  return typeof raw === "string" && (TRIGGER_FLAVORS as readonly string[]).includes(raw);
}
