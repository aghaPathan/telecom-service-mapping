/**
 * Formats a nullable numeric/string value for UI display. null/undefined → dash.
 * This is the null-as-null contract (see PRD §"Ingest Edge-Case Contract" — ruleFIX).
 * For CSV cells use an empty string as dash (convention: empty = missing).
 */
export function formatNullable(
  v: number | string | null | undefined,
  dash: string = "—",
): string {
  if (v === null || v === undefined) return dash;
  if (typeof v === "number") {
    return Number.isFinite(v) ? String(v) : dash;
  }
  return v;
}
