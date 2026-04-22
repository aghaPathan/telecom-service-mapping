type Level = "info" | "warn" | "error";

export function log(level: Level, event: string, context: Record<string, unknown> = {}): void {
  const line = {
    timestamp: new Date().toISOString(),
    level,
    service: "ingestor",
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
