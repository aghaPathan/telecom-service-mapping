import { describe, it, expect } from "vitest";
import pg from "pg";

// Regression guard for the "Pool is not a constructor" crash at ingestor
// cron startup (fixed in PR #27). The failure mode was Node's ESM dynamic
// import of pg (a CJS package) yielding `{ default: … }` without `Pool`
// synthesized as a named export, so `const { Pool } = await import("pg")`
// destructured undefined. Guarantees the production import path still
// gives us a constructible Pool after any future pg/Node upgrade.

describe("pg default export", () => {
  it("exposes Pool as a constructor", () => {
    expect(typeof pg.Pool).toBe("function");
  });

  it("Pool can be instantiated without a live connection", () => {
    const p = new pg.Pool({ connectionString: "postgres://x:y@127.0.0.1:1/z" });
    expect(p).toBeDefined();
    p.end().catch(() => {
      /* no query was issued — end() may reject with "Called end on pool
         more than once" on some versions; ignored for this smoke check. */
    });
  });
});
