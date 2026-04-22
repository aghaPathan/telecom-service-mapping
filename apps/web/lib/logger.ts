type Level = "info" | "warn" | "error";

/**
 * Structured JSON logger for the web app. One line per entry so log-aggregators
 * can parse without heuristics. Matches the shape emitted by the ingestor
 * (`service` is the only field that differs).
 *
 * NEVER log request bodies or query params — they may carry hostnames or
 * mobily_cid values. Log identifiers/counts only.
 */
export function log(
  level: Level,
  event: string,
  context: Record<string, unknown> = {},
): void {
  const line = {
    timestamp: new Date().toISOString(),
    level,
    service: "web",
    event,
    ...context,
  };
  const out = JSON.stringify(line);
  if (level === "error") {
    console.error(out);
  } else {
    console.log(out);
  }
}
