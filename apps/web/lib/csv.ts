// CSV-cell escaper with two concerns:
//
// 1. Standard CSV rules (RFC 4180): wrap in double-quotes and double any
//    embedded double-quotes if the value contains `,`, `"`, `\r`, or `\n`.
//
// 2. Spreadsheet formula injection. Cells beginning with `=`, `+`, `-`, `@`,
//    or a tab are interpreted as formulas by Excel / Google Sheets / LibreOffice
//    when the file is opened. A malicious circuit-id or device name could run
//    code or exfiltrate data. Mitigation: prefix a single apostrophe (`'`),
//    which the spreadsheet treats as a literal-string marker and then strips
//    on display. We still wrap such cells in quotes so the apostrophe survives
//    CSV parsing round-trips cleanly.
//
// Null / undefined map to the empty string; numbers are stringified.

const FORMULA_LEADERS = new Set(["=", "+", "-", "@", "\t", "\r"]);
const CSV_SPECIAL = /[,"\r\n\t]/;

export type CsvCell = string | number | null | undefined;

export function csvEscape(value: CsvCell): string {
  if (value == null) return "";
  const s = typeof value === "number" ? String(value) : value;

  const leader = s.length > 0 ? s[0]! : "";
  const needsFormulaGuard = FORMULA_LEADERS.has(leader);

  if (needsFormulaGuard) {
    // Prepend apostrophe and always quote; also escape embedded quotes.
    const guarded = "'" + s.replace(/"/g, '""');
    return `"${guarded}"`;
  }

  if (CSV_SPECIAL.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }

  return s;
}

export function csvRow(cells: CsvCell[]): string {
  return cells.map(csvEscape).join(",");
}

// Restrict an untrusted string (e.g. a device name) to a safe filename for
// use in a `Content-Disposition: attachment; filename="..."` header.
// Keeps alphanumerics, dot, dash, underscore; collapses everything else
// (spaces, slashes, colons, CR/LF, quotes) to a single underscore; caps at
// 80 chars. Guards against header-injection (CRLF) and path-traversal
// (slashes, dots-only sequences via the 80-char cap).
export function sanitizeFilename(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9._-]+/g, "_");
  return cleaned.slice(0, 80);
}
